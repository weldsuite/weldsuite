//! `/api/project-finance` (`routes/project-finance/index.ts`, `services/project-finance.ts`):
//! project figures, weekly snapshots and cost lines by source (design:
//! weldflow-delivery-and-portfolio.md "Finance and earned value"; ADR FLOW-019).
//!
//! ```text
//! GET /{projectId}            budget, actual, committed, PV, EV, CPI, SPI, forecast, variance, rows
//! GET /{projectId}/costs      cost lines by source, newest first, cursor paginated
//! GET /{projectId}/snapshots  the weekly points of the S-curve
//! GET /settings/{projectId}   the manual forecast and its history
//! PUT /settings/{projectId}   set or clear the manual forecast (merge write of `finance`)
//! ```
//!
//! WeldFlow keeps no ledger: the figures are read from `time_entries`,
//! `bill_items`, `journal_lines`, `purchase_order_items` and `hr_declarations`
//! (see the TypeScript service for which statuses count). The check order is
//! TypeScript's: permission, project (404), access (403), rights (403), then
//! the body or query (400). The rules are `weldsuite_flow_domain::finance`.
//! The weekly sweep (`weldsuite cron flow-finance-snapshot`) is
//! [`run_finance_snapshots`].

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::PROJECT_UPDATED;
use weldsuite_db::due_index::{SweepResult, run_sweep};
use weldsuite_db::js_timestamp;
use weldsuite_flow_domain::finance::{
    COMMITTED_PO_STATUSES, COUNTED_BILL_STATUSES, COUNTED_DECLARATION_STATUSES,
    COUNTED_JOURNAL_STATUSES, COUNTED_TIME_STATUSES, DoneTask, EvmItem, compute_evm,
    forecast_at_completion, iso_week_key, next_week_start_ms, percent_done, percent_of, ratio,
    round_money, round_ratio,
};
use weldsuite_flow_domain::js::{millis_of, number_value, parse_int, to_fixed};
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::import_tasks::TenantDatabases;
use crate::projects::{analytics_payload, project_row};
use crate::{Caller, FlowState, Query, Refusal, paged, reply};

/// The due index kind of the weekly snapshot.
pub const FINANCE_SNAPSHOT_KIND: &str = "finance_snapshot";
const PROJECT_DENIED: &str = "You are not a member of this project";
const AMOUNTS_DENIED: &str = "You do not have access to the amounts of this project";
const MANAGE_DENIED: &str = "Only a project manager can change the forecast";
/// The history keeps this many changes.
const HISTORY_LIMIT: usize = 25;
/// A workspace that failed is retried after six hours.
const RETRY_AFTER_HOURS: i64 = 6;
const SWEEP_LIMIT: i64 = 500;
const SOURCES: [&str; 5] = ["time", "bill", "journal", "purchase_order", "declaration"];

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/settings/{project_id}",
            get(read_settings).route_layer(need("projects:read")),
        )
        .route(
            "/settings/{project_id}",
            put(write_settings).route_layer(need("projects:update")),
        )
        .route(
            "/{project_id}",
            get(figures).route_layer(need("projects:read")),
        )
        .route(
            "/{project_id}/costs",
            get(costs).route_layer(need("projects:read")),
        )
        .route(
            "/{project_id}/snapshots",
            get(snapshots).route_layer(need("projects:read")),
        )
        .with_state(state)
}

// ── Small readers ───────────────────────────────────────────────────────────

fn num(value: Option<&str>) -> f64 {
    value
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

/// `moneyString`.
fn money_string(value: f64) -> String {
    to_fixed(round_money(value), 2)
}

fn amount(value: Option<f64>, visible: bool) -> Value {
    match value {
        Some(v) if visible => json!(money_string(v)),
        _ => Value::Null,
    }
}

fn ms_of(row: &Value, key: &str) -> Option<i64> {
    row[key].as_str().and_then(millis_of)
}

/// The live project row (`findProject`).
async fn find_project(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    project_row(db, id, true).await
}

/// `projectCurrency`: the project's `budget_currency`, upper case.
fn project_currency(project: &Value) -> Option<String> {
    project["budgetCurrency"]
        .as_str()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_uppercase)
}

/// `mayDecideAmounts`: `projects:finance` or managing the project.
async fn may_decide_amounts(caller: &Caller, project_id: &str) -> Result<bool, sqlx::Error> {
    Ok(caller.can("projects:finance") || caller.can_manage(project_id).await?)
}

// ── Settings ────────────────────────────────────────────────────────────────

/// A stored forecast entry.
#[derive(Debug, Clone)]
struct StoredForecast {
    amount: Option<f64>,
    reason: Option<String>,
    set_by: String,
    set_at: String,
}

impl StoredForecast {
    fn read(value: &Value) -> Self {
        Self {
            amount: value["amount"].as_f64(),
            reason: value["reason"].as_str().map(str::to_owned),
            set_by: value["setBy"].as_str().unwrap_or_default().to_owned(),
            set_at: value["setAt"].as_str().unwrap_or_default().to_owned(),
        }
    }

    fn stored(&self) -> Value {
        json!({
            "amount": self.amount.map_or(Value::Null, number_value),
            "reason": self.reason,
            "setBy": self.set_by,
            "setAt": self.set_at,
        })
    }

    /// `presentManualForecast`.
    fn present(&self, visible: bool) -> Value {
        json!({
            "amount": amount(self.amount, visible),
            "reason": if visible { json!(self.reason) } else { Value::Null },
            "setBy": self.set_by,
            "setAt": self.set_at,
        })
    }
}

/// `financeSettingsOf`: the manual forecast and the history.
fn finance_settings_of(project: &Value) -> (Option<StoredForecast>, Vec<StoredForecast>) {
    let finance = &project["settings"]["finance"];
    let manual = finance
        .get("manualForecast")
        .filter(|v| !v.is_null())
        .map(StoredForecast::read);
    let history = finance["history"]
        .as_array()
        .map(|items| items.iter().map(StoredForecast::read).collect())
        .unwrap_or_default();
    (manual, history)
}

/// `presentFinanceSettings`.
fn present_settings(
    manual: Option<&StoredForecast>,
    history: &[StoredForecast],
    visible: bool,
) -> Value {
    json!({
        "manualForecast": manual.map_or(Value::Null, |m| m.present(visible)),
        "history": history.iter().map(|h| h.present(visible)).collect::<Vec<_>>(),
    })
}

async fn read_settings(caller: Caller, Path(project_id): Path<String>) -> Response {
    reply(
        async {
            let Some(project) = find_project(&caller.db, &project_id).await? else {
                return Err(Refusal::not_found("Project", &project_id));
            };
            if !caller.can_access(&project_id).await? {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            let visible = may_decide_amounts(&caller, &project_id).await?;
            let (manual, history) = finance_settings_of(&project);
            Ok(Data(present_settings(manual.as_ref(), &history, visible)).into_response())
        }
        .await,
        "Failed to load the finance settings",
    )
}

/// `manualForecastBodySchema`: the forecast (or null to clear) and why.
fn read_forecast(issues: &mut Issues, body: &Value) -> Option<(Option<f64>, Option<String>)> {
    let fields = issues.object(body)?;
    let forecast = issues.number(
        fields,
        "forecast",
        Presence::Nullable,
        Number {
            coerce: false,
            int: false,
            min: Some(0.0),
            max: Some(1_000_000_000.0),
        },
    );
    let reason = issues.text_with(
        fields,
        "reason",
        Presence::Nullish,
        Text::trimmed(None, Some(1000)),
    );
    // `.superRefine`: a manual forecast needs a reason.
    let is_number = fields.get("forecast").is_some_and(Value::is_number);
    if is_number && reason.as_set().is_none_or(String::is_empty) {
        issues.custom("reason", "A reason is required for a manual forecast");
    }
    Some((forecast.into_option(), reason.into_option()))
}

async fn write_settings(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
    body: Bytes,
) -> Response {
    reply(
        async {
            let Some(project) = find_project(&caller.db, &project_id).await? else {
                return Err(Refusal::not_found("Project", &project_id));
            };
            if !caller.can_access(&project_id).await? {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            if !caller.can_manage(&project_id).await? {
                return Err(Refusal::forbidden(MANAGE_DENIED));
            }
            let (forecast, reason) = crate::raid_body::parse_body(&body, read_forecast)?;

            let now_text = crate::now();
            let (_, history) = finance_settings_of(&project);
            let entry = StoredForecast {
                amount: forecast.map(round_money),
                reason: reason.filter(|r| !r.is_empty()),
                set_by: caller.user_id.clone(),
                set_at: now_text.clone(),
            };
            let mut next_history = vec![entry.clone()];
            next_history.extend(history);
            next_history.truncate(HISTORY_LIMIT);
            let finance = json!({
                "manualForecast": if entry.amount.is_some() { entry.stored() } else { Value::Null },
                "history": next_history.iter().map(StoredForecast::stored).collect::<Vec<_>>(),
            });
            // A merge: only the `finance` key is written.
            sqlx::query(
                "update projects set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('finance', $2::jsonb),
                        updated_at = $3::timestamp
                 where id = $1 and deleted_at is null",
            )
            .bind(&project_id)
            .bind(&finance)
            .bind(&now_text)
            .execute(&caller.db)
            .await?;

            let mut merged: Map<String, Value> = project.as_object().cloned().unwrap_or_default();
            merged.insert("id".to_owned(), json!(project_id));
            caller.publish(&state, PROJECT_UPDATED, &project_id, &analytics_payload(&merged));
            let manual = if entry.amount.is_some() { Some(&entry) } else { None };
            Ok(Data(present_settings(manual, &next_history, true)).into_response())
        }
        .await,
        "Failed to save the forecast",
    )
}

// ── Source totals ───────────────────────────────────────────────────────────

#[derive(Debug, Default)]
struct SourceTotals {
    labour: HashMap<Option<String>, f64>,
    bills: f64,
    journal: f64,
    purchase_received: f64,
    committed: f64,
    declarations: f64,
    excluded: i64,
}

/// The net value of a purchase order line, without tax.
macro_rules! po_net {
    () => {
        "(poi.total - coalesce(poi.tax_amount, 0))"
    };
}
macro_rules! po_received_qty {
    () => {
        "least(coalesce(poi.quantity_received, 0), poi.quantity_ordered)"
    };
}
macro_rules! po_open_qty {
    () => {
        "greatest(poi.quantity_ordered - coalesce(poi.quantity_received, 0), 0)"
    };
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

async fn source_totals(
    db: &PgPool,
    project_id: &str,
    currency: Option<&str>,
) -> Result<SourceTotals, sqlx::Error> {
    let labour_rows: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "select t.deliverable_id, coalesce(sum(coalesce(te.cost, 0)), 0)::text
         from time_entries te
         left join tasks t on t.id = te.task_id and t.deleted_at is null
         where te.project_id = $1 and te.deleted_at is null and te.status = any($2)
         group by t.deliverable_id",
    )
    .bind(project_id)
    .bind(strings(&COUNTED_TIME_STATUSES))
    .fetch_all(db)
    .await?;
    let bill: (Option<String>, i64) = sqlx::query_as(concat!(
        "select coalesce(sum(case when b.type = 'credit_note' then -coalesce(bi.line_total, 0) else coalesce(bi.line_total, 0) end)",
        " filter (where ($3::text is null or upper(coalesce(b.currency, '')) = $3)), 0)::text,",
        " count(*) filter (where not ($3::text is null or upper(coalesce(b.currency, '')) = $3))",
        " from bill_items bi inner join bills b on b.id = bi.bill_id",
        " where bi.project_id = $1 and bi.deleted_at is null and b.deleted_at is null and b.status = any($2)"
    ))
    .bind(project_id)
    .bind(strings(&COUNTED_BILL_STATUSES))
    .bind(currency)
    .fetch_one(db)
    .await?;
    let journal: (Option<String>, i64) = sqlx::query_as(concat!(
        "select coalesce(sum(coalesce(jl.debit, 0) - coalesce(jl.credit, 0))",
        " filter (where ($3::text is null or upper(coalesce(coalesce(e.base_currency, ''), '')) = $3)), 0)::text,",
        " count(*) filter (where not ($3::text is null or upper(coalesce(coalesce(e.base_currency, ''), '')) = $3))",
        " from journal_lines jl",
        " inner join journal_entries je on je.id = jl.journal_entry_id",
        " inner join accounts a on a.id = jl.account_id",
        " left join entities e on e.id = jl.entity_id",
        " where jl.project_id = $1 and jl.deleted_at is null and je.deleted_at is null",
        " and je.status = any($2) and a.type = 'expense'"
    ))
    .bind(project_id)
    .bind(strings(&COUNTED_JOURNAL_STATUSES))
    .bind(currency)
    .fetch_one(db)
    .await?;
    let po: (Option<String>, Option<String>, i64) = sqlx::query_as(concat!(
        "select coalesce(sum(",
        po_net!(),
        " * ",
        po_received_qty!(),
        "::numeric / poi.quantity_ordered)",
        " filter (where ($3::text is null or upper(coalesce(po.currency, '')) = $3) and po.status <> 'cancelled'), 0)::text,",
        " coalesce(sum(",
        po_net!(),
        " * ",
        po_open_qty!(),
        "::numeric / poi.quantity_ordered)",
        " filter (where ($3::text is null or upper(coalesce(po.currency, '')) = $3) and po.status = any($2)), 0)::text,",
        " count(*) filter (where not ($3::text is null or upper(coalesce(po.currency, '')) = $3))",
        " from purchase_order_items poi inner join purchase_orders po on po.id = poi.purchase_order_id",
        " where poi.project_id = $1 and po.deleted_at is null and poi.quantity_ordered > 0"
    ))
    .bind(project_id)
    .bind(strings(&COMMITTED_PO_STATUSES))
    .bind(currency)
    .fetch_one(db)
    .await?;
    let declaration: (Option<String>, i64) = sqlx::query_as(concat!(
        "select coalesce(sum(d.amount) filter (where ($3::text is null or upper(coalesce(d.currency, '')) = $3)), 0)::text,",
        " count(*) filter (where not ($3::text is null or upper(coalesce(d.currency, '')) = $3))",
        " from hr_declarations d where d.project_id = $1 and d.status = any($2)"
    ))
    .bind(project_id)
    .bind(strings(&COUNTED_DECLARATION_STATUSES))
    .bind(currency)
    .fetch_one(db)
    .await?;

    let mut labour: HashMap<Option<String>, f64> = HashMap::new();
    for (deliverable, cost) in labour_rows {
        *labour.entry(deliverable).or_insert(0.0) += num(cost.as_deref());
    }
    Ok(SourceTotals {
        labour,
        bills: num(bill.0.as_deref()),
        journal: num(journal.0.as_deref()),
        purchase_received: num(po.0.as_deref()),
        committed: num(po.1.as_deref()),
        declarations: num(declaration.0.as_deref()),
        excluded: bill.1 + journal.1 + po.2 + declaration.1,
    })
}

// ── The model ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct RowModel {
    id: Option<String>,
    code: Option<String>,
    title: Option<String>,
    planned_hours: f64,
    percent_done: f64,
    budget: f64,
    labour: f64,
    expenses: f64,
    purchases: f64,
    committed: f64,
    earned_value: f64,
}

#[derive(Debug)]
struct Baseline {
    id: String,
    version: i64,
    created_at: String,
}

#[derive(Debug)]
struct FinanceModel {
    currency: Option<String>,
    budget: Option<f64>,
    actual: f64,
    committed: f64,
    planned_value: f64,
    earned_value: f64,
    cpi: Option<f64>,
    spi: Option<f64>,
    forecast: Option<f64>,
    forecast_source: Option<&'static str>,
    manual: Option<StoredForecast>,
    by_source: [f64; 5],
    excluded: i64,
    baseline: Option<Baseline>,
    rows: Vec<RowModel>,
}

type DeliverableRow = (String, i32, String, String, Option<String>, Option<String>);

/// `computeFinance`: everything the finance figures of one project are built from, at `now_ms`.
#[allow(clippy::too_many_lines)]
async fn compute_finance(
    db: &PgPool,
    project: &Value,
    now_ms: i64,
) -> Result<FinanceModel, sqlx::Error> {
    let project_id = project["id"].as_str().unwrap_or_default();
    let currency = project_currency(project);
    let budget = project["budgetedAmount"]
        .as_str()
        .map(|text| num(Some(text)));

    let baseline: Option<(String, i32, Option<String>, Value)> = sqlx::query_as(
        "select id, version, to_jsonb(created_at) #>> '{}', snapshot from project_baselines
         where project_id = $1 order by version desc limit 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    let deliverables: Vec<DeliverableRow> = sqlx::query_as(
        "select id, number, title, status,
                to_jsonb(planned_start) #>> '{}', to_jsonb(planned_end) #>> '{}'
         from project_deliverables where project_id = $1 and deleted_at is null
         order by position, number",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let task_rows: Vec<(Option<String>, String, Option<String>)> = sqlx::query_as(
        "select deliverable_id, status, estimated_hours::text from tasks
         where project_id = $1 and deleted_at is null and status <> 'cancelled' order by id",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let totals = source_totals(db, project_id, currency.as_deref()).await?;

    let frozen: HashMap<String, (Option<i64>, Option<i64>)> = baseline
        .as_ref()
        .and_then(|b| b.3["deliverables"].as_array())
        .map(|list| {
            list.iter()
                .filter_map(|d| {
                    Some((
                        d["id"].as_str()?.to_owned(),
                        (
                            d["plannedStart"].as_str().and_then(millis_of),
                            d["plannedEnd"].as_str().and_then(millis_of),
                        ),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();

    let live: Vec<&str> = deliverables.iter().map(|d| d.0.as_str()).collect();
    let mut by_deliverable: HashMap<Option<String>, Vec<DoneTask>> = HashMap::new();
    for (deliverable, status, hours) in &task_rows {
        let key = deliverable
            .as_ref()
            .filter(|id| live.contains(&id.as_str()))
            .cloned();
        by_deliverable.entry(key).or_default().push(DoneTask {
            done: status == "done",
            hours: hours.as_deref().map(|h| num(Some(h))),
        });
    }
    let hours_of = |key: &Option<String>| -> f64 {
        by_deliverable.get(key).map_or(0.0, |tasks| {
            tasks.iter().map(|t| t.hours.unwrap_or(0.0)).sum()
        })
    };

    let to_ms = |text: &Option<String>| -> Option<i64> {
        text.as_deref()
            .and_then(js_timestamp)
            .as_deref()
            .and_then(millis_of)
    };
    let mut items: Vec<EvmItem> = deliverables
        .iter()
        .map(|d| {
            let key = Some(d.0.clone());
            let (start, end) = match frozen.get(&d.0) {
                Some(dates) => *dates,
                None => (to_ms(&d.4), to_ms(&d.5)),
            };
            let done = if d.3 == "accepted" {
                1.0
            } else {
                by_deliverable
                    .get(&key)
                    .map_or(0.0, |tasks| percent_done(tasks))
            };
            EvmItem {
                id: Some(d.0.clone()),
                planned_hours: hours_of(&key),
                planned_start: start,
                planned_end: end,
                percent_done: done,
            }
        })
        .collect();
    // The work that belongs to no deliverable is an item of its own, or the whole project.
    let has_other = by_deliverable.contains_key(&None) || deliverables.is_empty();
    if has_other {
        items.push(EvmItem {
            id: None,
            planned_hours: hours_of(&None),
            planned_start: None,
            planned_end: None,
            percent_done: by_deliverable
                .get(&None)
                .map_or(0.0, |tasks| percent_done(tasks)),
        });
    }

    let go_live = baseline
        .as_ref()
        .and_then(|b| b.3["goLive"].as_str())
        .and_then(millis_of);
    let span_end = go_live.or_else(|| ms_of(project, "endDate"));
    let evm = compute_evm(
        budget,
        &items,
        ms_of(project, "startDate"),
        span_end,
        now_ms,
    );

    let unassigned_expenses = totals.journal + totals.declarations;
    let unassigned_purchases = totals.bills + totals.purchase_received;
    let labour_total: f64 = totals.labour.values().sum();
    let actual = labour_total + unassigned_expenses + unassigned_purchases;
    let cpi = ratio(evm.earned_value, actual);
    let spi = ratio(evm.earned_value, evm.planned_value);
    let (manual_setting, _) = finance_settings_of(project);
    let forecast = forecast_at_completion(
        budget,
        actual,
        totals.committed,
        cpi,
        manual_setting.as_ref().and_then(|m| m.amount),
    );

    let row_for = |id: Option<String>, evm_index: Option<usize>| -> RowModel {
        let d = id
            .as_ref()
            .and_then(|id| deliverables.iter().find(|d| &d.0 == id));
        let result = evm_index.map(|i| &evm.items[i]);
        let other = id.is_none();
        RowModel {
            code: d.map(|d| format!("D{}", d.1)),
            title: d.map(|d| d.2.clone()),
            planned_hours: hours_of(&id),
            percent_done: evm_index.map_or(0.0, |i| {
                weldsuite_flow_domain::js::math_round(items[i].percent_done * 1000.0) / 10.0
            }),
            budget: result.map_or(0.0, |r| r.budget),
            labour: totals.labour.get(&id).copied().unwrap_or(0.0),
            expenses: if other { unassigned_expenses } else { 0.0 },
            purchases: if other { unassigned_purchases } else { 0.0 },
            committed: if other { totals.committed } else { 0.0 },
            earned_value: result.map_or(0.0, |r| r.earned_value),
            id,
        }
    };
    let mut rows: Vec<RowModel> = items
        .iter()
        .enumerate()
        .map(|(index, item)| row_for(item.id.clone(), Some(index)))
        .collect();
    let other_costs = totals.labour.get(&None).copied().unwrap_or(0.0)
        + unassigned_expenses
        + unassigned_purchases
        + totals.committed;
    if !has_other && other_costs > 0.0 {
        rows.push(row_for(None, None));
    }

    Ok(FinanceModel {
        currency,
        budget,
        actual,
        committed: totals.committed,
        planned_value: evm.planned_value,
        earned_value: evm.earned_value,
        cpi,
        spi,
        forecast: forecast.map(|f| f.0),
        forecast_source: forecast.map(|f| f.1.as_str()),
        manual: manual_setting,
        by_source: [
            labour_total,
            totals.bills,
            totals.journal,
            totals.purchase_received,
            totals.declarations,
        ],
        excluded: totals.excluded,
        baseline: baseline.map(|b| Baseline {
            id: b.0,
            version: i64::from(b.1),
            created_at: b.2.as_deref().and_then(js_timestamp).unwrap_or_default(),
        }),
        rows,
    })
}

// ── Presenting ──────────────────────────────────────────────────────────────

fn percentages(
    budget: Option<f64>,
    actual: f64,
    committed: f64,
    planned: f64,
    earned: f64,
    forecast: Option<f64>,
) -> Value {
    let pct = |v: Option<f64>| v.map_or(Value::Null, number_value);
    json!({
        "spent": pct(percent_of(actual, budget)),
        "committed": pct(percent_of(committed, budget)),
        "planned": pct(percent_of(planned, budget)),
        "earned": pct(percent_of(earned, budget)),
        "forecast": pct(forecast.and_then(|f| percent_of(f, budget))),
    })
}

fn present_finance(project: &Value, model: &FinanceModel, now_ms: i64, visible: bool) -> Value {
    let variance = match (model.forecast, model.budget) {
        (Some(f), Some(b)) => Some(f - b),
        _ => None,
    };
    let ratio_value = |v: Option<f64>| round_ratio(v).map_or(Value::Null, number_value);
    let rows: Vec<Value> = model
        .rows
        .iter()
        .map(|row| {
            let row_actual = row.labour + row.expenses + row.purchases;
            let row_forecast = forecast_at_completion(
                Some(row.budget),
                row_actual,
                row.committed,
                ratio(row.earned_value, row_actual),
                None,
            )
            .map(|f| f.0);
            json!({
                "id": row.id,
                "code": row.code,
                "title": row.title,
                "plannedHours": number_value(
                    weldsuite_flow_domain::js::math_round(row.planned_hours * 100.0) / 100.0
                ),
                "percentDone": number_value(row.percent_done),
                "budget": amount(Some(row.budget), visible),
                "labour": amount(Some(row.labour), visible),
                "expenses": amount(Some(row.expenses), visible),
                "purchases": amount(Some(row.purchases), visible),
                "actual": amount(Some(row_actual), visible),
                "committed": amount(Some(row.committed), visible),
                "forecast": amount(row_forecast, visible),
                "variance": amount(row_forecast.map(|f| f - row.budget), visible),
            })
        })
        .collect();
    let [time, bill, journal, purchase_order, declaration] = model.by_source;
    json!({
        "projectId": project["id"],
        "currency": model.currency,
        "canSeeAmounts": visible,
        "asOf": weldsuite_events::iso_timestamp(
            OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
                .unwrap_or(OffsetDateTime::UNIX_EPOCH)
        ),
        "baseline": model.baseline.as_ref().map(|b| json!({
            "id": b.id, "version": b.version, "createdAt": b.created_at
        })),
        "figures": {
            "budget": amount(model.budget, visible),
            "actual": amount(Some(model.actual), visible),
            "committed": amount(Some(model.committed), visible),
            "plannedValue": amount(Some(model.planned_value), visible),
            "earnedValue": amount(Some(model.earned_value), visible),
            "forecast": amount(model.forecast, visible),
            "variance": amount(variance, visible),
            "cpi": ratio_value(model.cpi),
            "spi": ratio_value(model.spi),
            "forecastSource": model.forecast_source,
        },
        "percent": percentages(
            model.budget, model.actual, model.committed,
            model.planned_value, model.earned_value, model.forecast
        ),
        "manualForecast": model.manual.as_ref().map_or(Value::Null, |m| m.present(visible)),
        "bySource": {
            "time": amount(Some(time), visible),
            "bill": amount(Some(bill), visible),
            "journal": amount(Some(journal), visible),
            "purchase_order": amount(Some(purchase_order), visible),
            "declaration": amount(Some(declaration), visible),
        },
        "excludedLines": model.excluded,
        "rows": rows,
    })
}

// ── GET /{projectId} ────────────────────────────────────────────────────────

async fn figures(
    State(state): State<FlowState>,
    caller: Caller,
    Path(project_id): Path<String>,
) -> Response {
    reply(
        async {
            let Some(project) = find_project(&caller.db, &project_id).await? else {
                return Err(Refusal::not_found("Project", &project_id));
            };
            if !caller.can_access(&project_id).await? {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            let visible = may_decide_amounts(&caller, &project_id).await?;
            let now_ms = crate::now_ms();
            let model = compute_finance(&caller.db, &project, now_ms).await?;
            if model.baseline.is_some() {
                schedule_if_missing(&state, &caller, &project_id, now_ms).await;
            }
            Ok(Data(present_finance(&project, &model, now_ms, visible)).into_response())
        }
        .await,
        "Failed to load the project finance",
    )
}

/// A project with a baseline but no snapshot yet this week brings the sweep to its workspace.
async fn schedule_if_missing(state: &FlowState, caller: &Caller, project_id: &str, now_ms: i64) {
    let Some(master) = caller.master(state) else {
        return;
    };
    let week = iso_week_key(now_ms);
    let found: Result<Option<i32>, sqlx::Error> = sqlx::query_scalar(
        "select 1 from project_finance_snapshots where project_id = $1 and week = $2 limit 1",
    )
    .bind(project_id)
    .bind(&week)
    .fetch_optional(&caller.db)
    .await;
    if matches!(found, Ok(None)) {
        mark_finance_snapshot_due(&master, &caller.workspace_id).await;
    }
}

/// Bring the sweep to this workspace (a baseline was set, or a finance page was opened).
pub(crate) async fn mark_finance_snapshot_due(master: &PgPool, workspace_id: &str) {
    weldsuite_db::due_index::mark_due(
        master,
        FINANCE_SNAPSHOT_KIND,
        workspace_id,
        OffsetDateTime::now_utc(),
    )
    .await;
}

// ── GET /{projectId}/costs ──────────────────────────────────────────────────

/// `costsQuerySchema`.
struct CostsQuery {
    source: Option<String>,
    from: Option<String>,
    to: Option<String>,
    cursor: Option<String>,
    limit: Option<String>,
}

fn is_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
}

fn costs_query(raw: Option<&str>) -> Result<CostsQuery, Refusal> {
    let parsed = Query::parse(raw);
    let mut fields = Map::new();
    for (key, value) in parsed.values() {
        let first = match value {
            Value::Array(values) => values.first().cloned(),
            other => Some(other.clone()),
        };
        if let Some(Value::String(text)) = first
            && !text.is_empty()
        {
            fields.insert(key.clone(), Value::String(text));
        }
    }
    let mut issues = Issues::default();
    let f = &fields;
    let query = CostsQuery {
        source: issues
            .choice(f, "source", Presence::Optional, &SOURCES)
            .into_option(),
        from: issues
            .pattern(
                f,
                "from",
                Presence::Optional,
                None,
                None,
                is_date,
                "Invalid",
            )
            .into_option(),
        to: issues
            .pattern(f, "to", Presence::Optional, None, None, is_date, "Invalid")
            .into_option(),
        cursor: issues
            .text_with(f, "cursor", Presence::Optional, Text::default())
            .into_option(),
        limit: issues
            .text_with(f, "limit", Presence::Optional, Text::default())
            .into_option(),
    };
    issues.finish().map_err(|failed| {
        let details: Vec<Value> = failed
            .issues()
            .iter()
            .map(|issue| {
                let path = issue["path"]
                    .as_array()
                    .map(|parts| {
                        parts
                            .iter()
                            .map(|p| p.as_str().map_or_else(|| p.to_string(), str::to_owned))
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                json!({ "path": path, "message": issue["message"] })
            })
            .collect();
        Refusal::from(ApiError::bad_request("Invalid query parameters").with_details(details))
    })?;
    Ok(query)
}

/// `parseLimit(raw, 25, 100)`.
fn parse_limit(raw: Option<&str>) -> i64 {
    match raw.and_then(parse_int) {
        Some(n) if n >= 1 => n.min(100),
        _ => 25,
    }
}

/// One cost line, as listed.
#[derive(Debug, Clone)]
struct Line {
    id: String,
    source: &'static str,
    date: String,
    title: Option<String>,
    reference: Option<String>,
    status: Option<String>,
    amount: f64,
    committed: f64,
    hours: Option<f64>,
    people: Option<i64>,
}

impl Line {
    fn json(&self) -> Value {
        json!({
            "id": self.id,
            "source": self.source,
            "date": self.date,
            "title": self.title,
            "reference": self.reference,
            "status": self.status,
            "amount": money_string(self.amount),
            "committed": money_string(self.committed),
            "hours": self.hours.map_or(Value::Null, number_value),
            "people": self.people,
        })
    }
}

/// The window and keyset binds every source query shares: `$3` from, `$4` to,
/// `$5` the cursor's day, `$6` its id, `$7` the page size.
struct Window<'a> {
    project_id: &'a str,
    currency: Option<&'a str>,
    from: Option<&'a str>,
    to: Option<&'a str>,
    cursor_day: Option<&'a str>,
    cursor_id: Option<&'a str>,
    fetch: i64,
}

/// The keyset condition after the cursor, over a day expression and a uid expression.
macro_rules! after_cursor {
    ($date:expr, $uid:expr) => {
        concat!(
            "($5::text is null or (",
            $date,
            " < $5 or (",
            $date,
            " = $5 and ",
            $uid,
            " collate \"C\" < $6::text collate \"C\")))"
        )
    };
}

macro_rules! in_window {
    ($date:expr) => {
        concat!(
            "($3::text is null or ",
            $date,
            " >= $3) and ($4::text is null or ",
            $date,
            " <= $4)"
        )
    };
}

/// A week of time: week, last day, cost, minutes, people.
type TimeLineRow = (String, String, Option<String>, Option<String>, i64);

type LineRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn bind_window<'q>(
    query: sqlx::query::QueryAs<'q, sqlx::Postgres, LineRow, sqlx::postgres::PgArguments>,
    w: &'q Window<'q>,
) -> sqlx::query::QueryAs<'q, sqlx::Postgres, LineRow, sqlx::postgres::PgArguments> {
    query
        .bind(w.project_id)
        .bind(w.currency)
        .bind(w.from)
        .bind(w.to)
        .bind(w.cursor_day)
        .bind(w.cursor_id)
        .bind(w.fetch)
}

/// `listCostLines`: every source (or one), newest first.
#[allow(clippy::too_many_lines)]
async fn list_cost_lines(
    db: &PgPool,
    project_id: &str,
    currency: Option<&str>,
    q: &CostsQuery,
    limit: i64,
) -> Result<(Vec<Line>, i64, bool, Option<String>), sqlx::Error> {
    let (cursor_day, cursor_id) = match q.cursor.as_deref().and_then(|c| c.split_once('~')) {
        Some((day, id)) => (Some(day), Some(id)),
        None => (None, None),
    };
    let w = Window {
        project_id,
        currency,
        from: q.from.as_deref(),
        to: q.to.as_deref(),
        cursor_day,
        cursor_id,
        fetch: limit + 1,
    };
    let wanted: Vec<&str> = match q.source.as_deref() {
        Some(source) => SOURCES.iter().copied().filter(|s| *s == source).collect(),
        None => SOURCES.to_vec(),
    };
    let mut merged: Vec<Line> = Vec::new();
    let mut total = 0_i64;

    for source in wanted {
        match source {
            "time" => {
                let rows: Vec<TimeLineRow> = sqlx::query_as(concat!(
                    "select to_char(te.date, 'IYYY\"-W\"IW'), to_char(max(te.date), 'YYYY-MM-DD'),",
                    " coalesce(sum(coalesce(te.cost, 0)), 0)::text, coalesce(sum(te.duration), 0)::text,",
                    " count(distinct te.user_id)",
                    " from time_entries te",
                    " where te.project_id = $1 and te.deleted_at is null and te.status = any($8)",
                    " and ($2::text is null or $2::text is not null)",
                    " group by to_char(te.date, 'IYYY\"-W\"IW')",
                    " having ($3::text is null or to_char(max(te.date), 'YYYY-MM-DD') >= $3)",
                    " and ($4::text is null or to_char(max(te.date), 'YYYY-MM-DD') <= $4)",
                    " and ",
                    after_cursor!(
                        "to_char(max(te.date), 'YYYY-MM-DD')",
                        "'time:' || to_char(te.date, 'IYYY\"-W\"IW')"
                    ),
                    " order by to_char(max(te.date), 'YYYY-MM-DD') desc,",
                    " 'time:' || to_char(te.date, 'IYYY\"-W\"IW') collate \"C\" desc limit $7"
                ))
                .bind(w.project_id)
                .bind(w.currency)
                .bind(w.from)
                .bind(w.to)
                .bind(w.cursor_day)
                .bind(w.cursor_id)
                .bind(w.fetch)
                .bind(strings(&COUNTED_TIME_STATUSES))
                .fetch_all(db)
                .await?;
                for (week, date, cost, minutes, people) in rows {
                    merged.push(Line {
                        id: format!("time:{week}"),
                        source: "time",
                        date,
                        title: Some(week),
                        reference: None,
                        status: Some("approved".to_owned()),
                        amount: num(cost.as_deref()),
                        committed: 0.0,
                        hours: Some(
                            weldsuite_flow_domain::js::math_round(
                                num(minutes.as_deref()) / 60.0 * 100.0,
                            ) / 100.0,
                        ),
                        people: Some(people),
                    });
                }
                let count: i64 = sqlx::query_scalar(concat!(
                    "select count(distinct to_char(te.date, 'IYYY-IW')) from time_entries te",
                    " where te.project_id = $1 and te.deleted_at is null and te.status = any($4)",
                    " and ($2::text is null or te.date >= $2::text::date)",
                    " and ($3::text is null or te.date <= $3::text::date)"
                ))
                .bind(w.project_id)
                .bind(w.from)
                .bind(w.to)
                .bind(strings(&COUNTED_TIME_STATUSES))
                .fetch_one(db)
                .await?;
                total += count;
            }
            _ => {
                total += list_other(db, source, &w, &mut merged).await?;
            }
        }
    }

    merged.sort_by(|a, b| {
        if a.date == b.date {
            b.id.cmp(&a.id)
        } else {
            b.date.cmp(&a.date)
        }
    });
    let has_more = i64::try_from(merged.len()).unwrap_or(i64::MAX) > limit;
    if has_more {
        merged.truncate(usize::try_from(limit).unwrap_or(0));
    }
    let cursor = if has_more {
        merged.last().map(|l| format!("{}~{}", l.date, l.id))
    } else {
        None
    };
    Ok((merged, total, has_more, cursor))
}

/// The bill, journal, purchase order and declaration lines of one source and its count.
/// The list query (without its tail), the keyset and order tail, and the count query of one source.
#[allow(clippy::too_many_lines)]
fn other_sql(source: &str) -> (String, &'static str, String) {
    match source {
        "bill" => {
            let date = "to_char((b.issue_date)::date, 'YYYY-MM-DD')";
            let filter = concat!(
                " from bill_items bi inner join bills b on b.id = bi.bill_id",
                " where bi.project_id = $1 and bi.deleted_at is null and b.deleted_at is null",
                " and b.status = any($8)",
                " and ($2::text is null or upper(coalesce(b.currency, '')) = $2)",
                " and ",
                in_window!("to_char((b.issue_date)::date, 'YYYY-MM-DD')")
            );
            (
                format!(
                    "select 'bill:' || bi.id, {date}, bi.description, b.bill_number, b.status, \
                     case when b.type = 'credit_note' then (-coalesce(bi.line_total, 0))::text else coalesce(bi.line_total, 0)::text end, \
                     '0'{filter}"
                ),
                concat!(
                    " and ",
                    after_cursor!(
                        "to_char((b.issue_date)::date, 'YYYY-MM-DD')",
                        "'bill:' || bi.id"
                    ),
                    " order by to_char((b.issue_date)::date, 'YYYY-MM-DD') desc, 'bill:' || bi.id collate \"C\" desc limit $7"
                ),
                format!("select count(*){filter}"),
            )
        }
        "journal" => {
            let filter = concat!(
                " from journal_lines jl",
                " inner join journal_entries je on je.id = jl.journal_entry_id",
                " inner join accounts a on a.id = jl.account_id",
                " left join entities e on e.id = jl.entity_id",
                " where jl.project_id = $1 and jl.deleted_at is null and je.deleted_at is null",
                " and je.status = any($8) and a.type = 'expense'",
                " and ($2::text is null or upper(coalesce(coalesce(e.base_currency, ''), '')) = $2)",
                " and ",
                in_window!("to_char((je.date)::date, 'YYYY-MM-DD')")
            );
            (
                format!(
                    "select 'journal:' || jl.id, to_char((je.date)::date, 'YYYY-MM-DD'), \
                     coalesce(jl.description, je.description), je.entry_number, je.status, \
                     (coalesce(jl.debit, 0) - coalesce(jl.credit, 0))::text, '0'{filter}"
                ),
                concat!(
                    " and ",
                    after_cursor!(
                        "to_char((je.date)::date, 'YYYY-MM-DD')",
                        "'journal:' || jl.id"
                    ),
                    " order by to_char((je.date)::date, 'YYYY-MM-DD') desc, 'journal:' || jl.id collate \"C\" desc limit $7"
                ),
                format!("select count(*){filter}"),
            )
        }
        "purchase_order" => {
            let date = "to_char((coalesce(poi.last_received_date, po.order_date, poi.created_at))::date, 'YYYY-MM-DD')";
            let filter = concat!(
                " from purchase_order_items poi inner join purchase_orders po on po.id = poi.purchase_order_id",
                " where poi.project_id = $1 and po.deleted_at is null and poi.quantity_ordered > 0",
                " and ($2::text is null or upper(coalesce(po.currency, '')) = $2)",
                " and (po.status <> 'cancelled' or po.status = any($8))",
                " and ",
                in_window!(
                    "to_char((coalesce(poi.last_received_date, po.order_date, poi.created_at))::date, 'YYYY-MM-DD')"
                )
            );
            (
                format!(
                    "select 'purchase_order:' || poi.id, {date}, poi.name, po.po_number, po.status, \
                     ({net} * {recv}::numeric / poi.quantity_ordered)::text, \
                     (case when po.status = any($8) then {net} * {open}::numeric / poi.quantity_ordered else 0 end)::text{filter}",
                    net = po_net!(),
                    recv = po_received_qty!(),
                    open = po_open_qty!(),
                ),
                concat!(
                    " and ",
                    after_cursor!(
                        "to_char((coalesce(poi.last_received_date, po.order_date, poi.created_at))::date, 'YYYY-MM-DD')",
                        "'purchase_order:' || poi.id"
                    ),
                    " order by to_char((coalesce(poi.last_received_date, po.order_date, poi.created_at))::date, 'YYYY-MM-DD') desc,",
                    " 'purchase_order:' || poi.id collate \"C\" desc limit $7"
                ),
                format!("select count(*){filter}"),
            )
        }
        _ => {
            let filter = concat!(
                " from hr_declarations d where d.project_id = $1 and d.status = any($8)",
                " and ($2::text is null or upper(coalesce(d.currency, '')) = $2)",
                " and ",
                in_window!("to_char((d.expense_date)::date, 'YYYY-MM-DD')")
            );
            (
                format!(
                    "select 'declaration:' || d.id, to_char((d.expense_date)::date, 'YYYY-MM-DD'), \
                     d.description, d.category, d.status, d.amount::text, '0'{filter}"
                ),
                concat!(
                    " and ",
                    after_cursor!(
                        "to_char((d.expense_date)::date, 'YYYY-MM-DD')",
                        "'declaration:' || d.id"
                    ),
                    " order by to_char((d.expense_date)::date, 'YYYY-MM-DD') desc, 'declaration:' || d.id collate \"C\" desc limit $7"
                ),
                format!("select count(*){filter}"),
            )
        }
    }
}

#[allow(clippy::too_many_lines)]
async fn list_other(
    db: &PgPool,
    source: &str,
    w: &Window<'_>,
    merged: &mut Vec<Line>,
) -> Result<i64, sqlx::Error> {
    let (select, tail, count_sql) = other_sql(source);
    let statuses = match source {
        "bill" => strings(&COUNTED_BILL_STATUSES),
        "journal" => strings(&COUNTED_JOURNAL_STATUSES),
        "purchase_order" => strings(&COMMITTED_PO_STATUSES),
        _ => strings(&COUNTED_DECLARATION_STATUSES),
    };
    let sql = format!("{select}{tail}");
    let rows: Vec<LineRow> = bind_window(sqlx::query_as::<_, LineRow>(sqlx::AssertSqlSafe(sql)), w)
        .bind(statuses.clone())
        .fetch_all(db)
        .await?;
    let source_name: &'static str = SOURCES
        .iter()
        .copied()
        .find(|s| *s == source)
        .unwrap_or("declaration");
    for (id, date, title, reference, status, amount_text, committed_text) in rows {
        merged.push(Line {
            id,
            source: source_name,
            date,
            title,
            reference,
            status,
            amount: num(amount_text.as_deref()),
            committed: num(committed_text.as_deref()),
            hours: None,
            people: None,
        });
    }
    // The count has the filter's own binds: project, currency, from, to, then the statuses.
    let count: i64 =
        sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(count_sql.replace("$8", "$5")))
            .bind(w.project_id)
            .bind(w.currency)
            .bind(w.from)
            .bind(w.to)
            .bind(statuses)
            .fetch_one(db)
            .await?;
    Ok(count)
}

async fn costs(
    caller: Caller,
    Path(project_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    reply(
        async {
            let Some(project) = find_project(&caller.db, &project_id).await? else {
                return Err(Refusal::not_found("Project", &project_id));
            };
            if !caller.can_access(&project_id).await? {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            if !may_decide_amounts(&caller, &project_id).await? {
                return Err(Refusal::forbidden(AMOUNTS_DENIED));
            }
            let q = costs_query(raw.as_deref())?;
            let limit = parse_limit(q.limit.as_deref());
            let currency = project_currency(&project);
            let (lines, total, has_more, cursor) =
                list_cost_lines(&caller.db, &project_id, currency.as_deref(), &q, limit).await?;
            Ok(paged(
                lines.iter().map(Line::json).collect(),
                total,
                has_more,
                cursor,
            ))
        }
        .await,
        "Failed to list the project costs",
    )
}

// ── GET /{projectId}/snapshots ──────────────────────────────────────────────

/// A snapshot: week, budget, PV, EV, AC, committed, forecast, created.
type SnapshotRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

async fn snapshots(caller: Caller, Path(project_id): Path<String>) -> Response {
    reply(
        async {
            if find_project(&caller.db, &project_id).await?.is_none() {
                return Err(Refusal::not_found("Project", &project_id));
            }
            if !caller.can_access(&project_id).await? {
                return Err(Refusal::forbidden(PROJECT_DENIED));
            }
            let visible = may_decide_amounts(&caller, &project_id).await?;
            let rows: Vec<(String, [Option<String>; 6], Option<String>)> = {
                let raw: Vec<SnapshotRow> = sqlx::query_as(
                    "select week, budget::text, planned_value::text, earned_value::text, actual_cost::text,
                            committed::text, forecast::text, to_jsonb(created_at) #>> '{}'
                     from project_finance_snapshots where project_id = $1 order by week limit 520",
                )
                .bind(&project_id)
                .fetch_all(&caller.db)
                .await?;
                raw.into_iter()
                    .map(|r| (r.0, [r.1, r.2, r.3, r.4, r.5, r.6], r.7))
                    .collect()
            };
            let list: Vec<Value> = rows
                .into_iter()
                .map(|(week, v, created)| {
                    let budget = v[0].as_deref().map(|t| num(Some(t)));
                    let planned = num(v[1].as_deref());
                    let earned = num(v[2].as_deref());
                    let actual = num(v[3].as_deref());
                    let committed = num(v[4].as_deref());
                    let forecast = v[5].as_deref().map(|t| num(Some(t)));
                    json!({
                        "week": week,
                        "budget": amount(budget, visible),
                        "plannedValue": amount(Some(planned), visible),
                        "earnedValue": amount(Some(earned), visible),
                        "actualCost": amount(Some(actual), visible),
                        "committed": amount(Some(committed), visible),
                        "forecast": amount(forecast, visible),
                        "percent": percentages(budget, actual, committed, planned, earned, forecast),
                        "createdAt": created.as_deref().and_then(js_timestamp),
                    })
                })
                .collect();
            let total = i64::try_from(list.len()).unwrap_or(i64::MAX);
            Ok(paged(list, total, false, None))
        }
        .await,
        "Failed to load the finance snapshots",
    )
}

// ── The weekly sweep ────────────────────────────────────────────────────────

/// `upsertSnapshot`: one row per project per ISO week.
async fn upsert_snapshot(
    db: &PgPool,
    project_id: &str,
    model: &FinanceModel,
    now_ms: i64,
) -> Result<String, sqlx::Error> {
    let week = iso_week_key(now_ms);
    let created = weldsuite_events::iso_timestamp(
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
            .unwrap_or(OffsetDateTime::UNIX_EPOCH),
    );
    let budget = model.budget.map(money_string);
    let forecast = model.forecast.map(money_string);
    sqlx::query(
        "insert into project_finance_snapshots
           (id, project_id, week, budget, planned_value, earned_value, actual_cost, committed, forecast, created_at)
         values ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10::timestamptz)
         on conflict (project_id, week) do update set
           budget = excluded.budget, planned_value = excluded.planned_value,
           earned_value = excluded.earned_value, actual_cost = excluded.actual_cost,
           committed = excluded.committed, forecast = excluded.forecast,
           created_at = excluded.created_at",
    )
    .bind(generate_id("pfs"))
    .bind(project_id)
    .bind(&week)
    .bind(budget)
    .bind(money_string(model.planned_value))
    .bind(money_string(model.earned_value))
    .bind(money_string(model.actual))
    .bind(money_string(model.committed))
    .bind(forecast)
    .bind(created)
    .execute(db)
    .await?;
    Ok(week)
}

/// `snapshotWorkspace`: every live, open project with a baseline of one workspace;
/// the number written and when the workspace is next due (`None`: no project qualifies).
pub async fn snapshot_workspace(
    db: &PgPool,
    now_ms: i64,
) -> Result<(usize, Option<OffsetDateTime>), sqlx::Error> {
    let ids: Vec<String> = sqlx::query_scalar(
        "select p.id from projects p
         where p.deleted_at is null and p.status not in ('Closed', 'Cancelled')
           and exists (select 1 from project_baselines b where b.project_id = p.id)
         order by p.id",
    )
    .fetch_all(db)
    .await?;
    let mut written = 0;
    for id in &ids {
        let Some(project) = find_project(db, id).await? else {
            continue;
        };
        let result = async {
            let model = compute_finance(db, &project, now_ms).await?;
            upsert_snapshot(db, id, &model, now_ms).await
        }
        .await;
        match result {
            Ok(_) => written += 1,
            Err(error) => {
                // One broken project must not stop the others.
                tracing::error!(%error, project = %id, "[FinanceSnapshot] project failed");
            }
        }
    }
    let next = (!ids.is_empty())
        .then(|| {
            OffsetDateTime::from_unix_timestamp_nanos(
                i128::from(next_week_start_ms(now_ms)) * 1_000_000,
            )
            .ok()
        })
        .flatten();
    Ok((written, next))
}

/// One tick: the due workspaces of the master database's index, each snapshotted and re-scheduled.
pub async fn run_finance_snapshots(
    master: &PgPool,
    tenants: &TenantDatabases,
    now: OffsetDateTime,
) -> (SweepResult, usize) {
    let total = std::sync::Mutex::new(0_usize);
    let now_ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(0);
    let sweep = run_sweep(
        master,
        FINANCE_SNAPSHOT_KIND,
        now,
        SWEEP_LIMIT,
        Some(time::Duration::hours(RETRY_AFTER_HOURS)),
        |workspace_id, _now| {
            let tenants = Arc::clone(tenants);
            let total = &total;
            async move {
                let db = tenants(workspace_id).await?;
                let (written, next) = snapshot_workspace(&db, now_ms)
                    .await
                    .map_err(|e| e.to_string())?;
                if let Ok(mut total) = total.lock() {
                    *total += written;
                }
                Ok::<_, String>(next)
            }
        },
    )
    .await;
    let written = total.lock().map_or(0, |t| *t);
    if sweep.due > 0 || sweep.failed > 0 {
        tracing::info!(
            due = sweep.due,
            processed = sweep.processed,
            failed = sweep.failed,
            snapshots = written,
            "[FinanceSnapshot] tick"
        );
    }
    (sweep, written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_iso_days() {
        assert!(is_date("2026-11-03"));
        assert!(!is_date("2026-1-03"));
        assert!(!is_date("2026/11/03"));
        assert!(!is_date("2026-11-03T00:00"));
    }

    #[test]
    fn the_limit_falls_back_and_caps() {
        assert_eq!(parse_limit(None), 25);
        assert_eq!(parse_limit(Some("0")), 25);
        assert_eq!(parse_limit(Some("abc")), 25);
        assert_eq!(parse_limit(Some("7")), 7);
        assert_eq!(parse_limit(Some("500")), 100);
    }

    #[test]
    fn money_is_text_with_two_decimals() {
        assert_eq!(money_string(12.5), "12.50");
        assert_eq!(money_string(-0.001), "0.00");
        assert_eq!(money_string(1234.567), "1234.57");
    }

    #[test]
    fn a_manual_forecast_needs_a_reason() {
        let read = |body: Value| {
            let mut issues = Issues::default();
            let read = read_forecast(&mut issues, &body);
            (read, issues.finish().is_ok())
        };
        let (value, ok) = read(json!({ "forecast": 1200, "reason": "  Extra licence " }));
        assert!(ok);
        assert_eq!(
            value,
            Some((Some(1200.0), Some("Extra licence".to_owned())))
        );
        assert!(!read(json!({ "forecast": 5 })).1);
        assert!(!read(json!({ "forecast": 5, "reason": "   " })).1);
        assert!(read(json!({ "forecast": null })).1);
        assert!(!read(json!({ "forecast": -1, "reason": "x" })).1);
    }

    #[test]
    fn the_stored_forecast_round_trips() {
        let stored = StoredForecast {
            amount: Some(1200.0),
            reason: Some("why".to_owned()),
            set_by: "user_1".to_owned(),
            set_at: "2026-11-03T10:00:00.000Z".to_owned(),
        };
        let back = StoredForecast::read(&stored.stored());
        assert_eq!(back.amount, Some(1200.0));
        assert_eq!(stored.present(false)["amount"], Value::Null);
        assert_eq!(stored.present(true)["amount"], json!("1200.00"));
    }
}
