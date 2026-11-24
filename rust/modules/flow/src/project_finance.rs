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
use std::str::FromStr;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func, OnConflict, Query as SubQuery};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder,
    QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::PROJECT_UPDATED;
use weldsuite_db::due_index::{SweepResult, run_sweep};
use weldsuite_db::{orm, orm_error};
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
use weldsuite_schema::tenant::{
    accounts, bill_items, bills, entities, hr_declarations, journal_entries, journal_lines,
    project_baselines, project_deliverables, project_finance_snapshots, projects,
    purchase_order_items, purchase_orders, tasks, time_entries,
};

use crate::import_tasks::TenantDatabases;
use crate::project_schedule::merge_settings;
use crate::projects::analytics_payload;
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

/// A `numeric` read back as JavaScript's `Number(text)`.
fn decimal_num(value: Option<&BigDecimal>) -> f64 {
    num(value.map(BigDecimal::to_plain_string).as_deref())
}

/// A `numeric` column's value from its text (`$n::numeric`).
fn decimal(text: &str) -> Result<BigDecimal, DbErr> {
    BigDecimal::from_str(text)
        .map_err(|_| DbErr::Custom(format!("invalid input syntax for type numeric: \"{text}\"")))
}

/// `new Date(millis)`, as a `timestamptz` column stores it.
fn instant(millis: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// An instant as `new Date(row.x).getTime()` reads it (milliseconds).
fn millis(at: OffsetDateTime) -> Option<i64> {
    i64::try_from(at.unix_timestamp_nanos().div_euclid(1_000_000)).ok()
}

fn ms_of(row: &Value, key: &str) -> Option<i64> {
    row[key].as_str().and_then(millis_of)
}

/// The live project row (`findProject`).
async fn find_project(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    projects::Entity::find_by_id(id)
        .filter(projects::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(crate::row_json)
        .transpose()
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
async fn may_decide_amounts(caller: &Caller, project_id: &str) -> Result<bool, DbErr> {
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

            let at = OffsetDateTime::now_utc();
            let now_text = weldsuite_events::iso_timestamp(at);
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
            projects::Entity::update_many()
                .col_expr(
                    projects::Column::Settings,
                    merge_settings(json!({ "finance": finance })),
                )
                .col_expr(
                    projects::Column::UpdatedAt,
                    Expr::value(weldsuite_db::utc_timestamp(at)),
                )
                .filter(projects::Column::Id.eq(project_id.as_str()))
                .filter(projects::Column::DeletedAt.is_null())
                .exec(&orm(&caller.db))
                .await?;

            let mut merged: Map<String, Value> = project.as_object().cloned().unwrap_or_default();
            merged.insert("id".to_owned(), json!(project_id));
            caller.publish(
                &state,
                PROJECT_UPDATED,
                &project_id,
                &analytics_payload(&merged),
            );
            let manual = if entry.amount.is_some() {
                Some(&entry)
            } else {
                None
            };
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

/// `upper(coalesce(currency, '')) = $currency`: the line is in the project's
/// currency; `None` when the project has none (every line counts).
fn currency_is(currency: Expr, project_currency: Option<&str>) -> Option<Expr> {
    use sea_orm::ExprTrait as _;
    project_currency.map(|wanted| {
        Expr::expr(Func::upper(Func::coalesce([currency, Expr::value("")]))).eq(wanted)
    })
}

/// `coalesce(sum(value) filter (where counted), 0)`, as
/// `sum(case when counted then value end)` (`None`: every row counts).
fn sum_where(value: Expr, counted: Option<Expr>) -> Expr {
    match counted {
        Some(counted) => Expr::expr(Func::sum(Expr::expr(Expr::case(counted, value)))),
        None => Expr::expr(Func::sum(value)),
    }
}

/// `count(*) filter (where not counted)`: the lines left out (none without a
/// currency).
fn count_unless(counted: Option<Expr>) -> Expr {
    use sea_orm::ExprTrait as _;
    match counted {
        Some(counted) => Expr::expr(Func::count(Expr::expr(Expr::case(counted.not(), 1)))),
        None => Expr::value(0_i64),
    }
}

/// `coalesce(col, 0)`.
fn or_zero(col: impl Into<Expr>) -> Expr {
    Expr::expr(Func::coalesce([col.into(), Expr::value(0)]))
}

/// `left join tasks t on t.id = te.task_id and t.deleted_at is null`.
fn live_task_of_entry() -> RelationDef {
    use sea_orm::ExprTrait as _;
    time_entries::Entity::belongs_to(tasks::Entity)
        .from(time_entries::Column::TaskId)
        .to(tasks::Column::Id)
        .on_condition(|_, task| Expr::col((task, tasks::Column::DeletedAt)).is_null().into())
        .into()
}

/// `time_entries`: the counted cost per deliverable of its task.
async fn labour_totals(
    db: &sea_orm::DatabaseConnection,
    project_id: &str,
) -> Result<Vec<(Option<String>, Option<BigDecimal>)>, DbErr> {
    time_entries::Entity::find()
        .select_only()
        .column(tasks::Column::DeliverableId)
        .column_as(
            Expr::expr(Func::sum(Expr::col(time_entries::Column::Cost))),
            "cost",
        )
        .join(JoinType::LeftJoin, live_task_of_entry())
        .filter(time_entries::Column::ProjectId.eq(project_id))
        .filter(time_entries::Column::DeletedAt.is_null())
        .filter(time_entries::Column::Status.is_in(COUNTED_TIME_STATUSES))
        .group_by(tasks::Column::DeliverableId)
        .into_tuple()
        .all(db)
        .await
}

/// `bill_items` of counted bills: the net (credit notes negative) in the
/// project's currency, and the lines in another.
async fn bill_totals(
    db: &sea_orm::DatabaseConnection,
    project_id: &str,
    currency: Option<&str>,
) -> Result<(Option<BigDecimal>, i64), DbErr> {
    use sea_orm::ExprTrait as _;
    let counted = currency_is(
        Expr::col((bills::Entity, bills::Column::Currency)),
        currency,
    );
    let line = || {
        or_zero(Expr::col((
            bill_items::Entity,
            bill_items::Column::LineTotal,
        )))
    };
    let signed: Expr = Expr::case(
        Expr::col((bills::Entity, bills::Column::Type)).eq("credit_note"),
        Expr::value(0).sub(line()),
    )
    .finally(line())
    .into();
    let row: Option<(Option<BigDecimal>, i64)> = bill_items::Entity::find()
        .select_only()
        .column_as(sum_where(signed, counted.clone()), "total")
        .column_as(count_unless(counted), "excluded")
        .join(
            JoinType::InnerJoin,
            bill_items::Entity::belongs_to(bills::Entity)
                .from(bill_items::Column::BillId)
                .to(bills::Column::Id)
                .into(),
        )
        .filter(bill_items::Column::ProjectId.eq(project_id))
        .filter(bill_items::Column::DeletedAt.is_null())
        .filter(bills::Column::DeletedAt.is_null())
        .filter(bills::Column::Status.is_in(COUNTED_BILL_STATUSES))
        .into_tuple()
        .one(db)
        .await?;
    Ok(row.unwrap_or((None, 0)))
}

/// Expense `journal_lines` of counted entries: debit minus credit in the
/// project's currency (the entity's base currency), and the lines in another.
async fn journal_totals(
    db: &sea_orm::DatabaseConnection,
    project_id: &str,
    currency: Option<&str>,
) -> Result<(Option<BigDecimal>, i64), DbErr> {
    use sea_orm::ExprTrait as _;
    let counted = currency_is(
        or_text(Expr::col((
            entities::Entity,
            entities::Column::BaseCurrency,
        ))),
        currency,
    );
    let net = or_zero(Expr::col((
        journal_lines::Entity,
        journal_lines::Column::Debit,
    )))
    .sub(or_zero(Expr::col((
        journal_lines::Entity,
        journal_lines::Column::Credit,
    ))));
    let row: Option<(Option<BigDecimal>, i64)> = journal_lines::Entity::find()
        .select_only()
        .column_as(sum_where(net, counted.clone()), "total")
        .column_as(count_unless(counted), "excluded")
        .join(
            JoinType::InnerJoin,
            journal_lines::Entity::belongs_to(journal_entries::Entity)
                .from(journal_lines::Column::JournalEntryId)
                .to(journal_entries::Column::Id)
                .into(),
        )
        .join(
            JoinType::InnerJoin,
            journal_lines::Entity::belongs_to(accounts::Entity)
                .from(journal_lines::Column::AccountId)
                .to(accounts::Column::Id)
                .into(),
        )
        .join(
            JoinType::LeftJoin,
            journal_lines::Entity::belongs_to(entities::Entity)
                .from(journal_lines::Column::EntityId)
                .to(entities::Column::Id)
                .into(),
        )
        .filter(journal_lines::Column::ProjectId.eq(project_id))
        .filter(journal_lines::Column::DeletedAt.is_null())
        .filter(journal_entries::Column::DeletedAt.is_null())
        .filter(journal_entries::Column::Status.is_in(COUNTED_JOURNAL_STATUSES))
        .filter(accounts::Column::Type.eq("expense"))
        .into_tuple()
        .one(db)
        .await?;
    Ok(row.unwrap_or((None, 0)))
}

/// `coalesce(col, '')`.
fn or_text(col: Expr) -> Expr {
    Expr::expr(Func::coalesce([col, Expr::value("")]))
}

/// `purchase_order_items` with an ordered quantity: the received part (not
/// cancelled) and the open part (committed orders) of their net value in the
/// project's currency, and the lines in another.
async fn purchase_totals(
    db: &sea_orm::DatabaseConnection,
    project_id: &str,
    currency: Option<&str>,
) -> Result<(Option<BigDecimal>, Option<BigDecimal>, i64), DbErr> {
    use sea_orm::ExprTrait as _;
    let item =
        |column: purchase_order_items::Column| Expr::col((purchase_order_items::Entity, column));
    let ordered = || item(purchase_order_items::Column::QuantityOrdered);
    let received_qty = || or_zero(item(purchase_order_items::Column::QuantityReceived));
    // `(poi.total - coalesce(poi.tax_amount, 0)) * qty::numeric / poi.quantity_ordered`.
    let net_of = |qty: Expr| {
        item(purchase_order_items::Column::Total)
            .sub(or_zero(item(purchase_order_items::Column::TaxAmount)))
            .mul(qty.cast_as("numeric"))
            .div(ordered())
    };
    let received = net_of(Expr::expr(Func::least([received_qty(), ordered()])));
    let open = net_of(Expr::expr(Func::greatest([
        ordered().sub(received_qty()),
        Expr::value(0),
    ])));
    let status = || Expr::col((purchase_orders::Entity, purchase_orders::Column::Status));
    let counted = currency_is(
        Expr::col((purchase_orders::Entity, purchase_orders::Column::Currency)),
        currency,
    );
    let both = |extra: Expr| match &counted {
        Some(counted) => counted.clone().and(extra),
        None => extra,
    };
    let row: Option<(Option<BigDecimal>, Option<BigDecimal>, i64)> =
        purchase_order_items::Entity::find()
            .select_only()
            .column_as(
                sum_where(received, Some(both(status().ne("cancelled")))),
                "received",
            )
            .column_as(
                sum_where(open, Some(both(status().is_in(COMMITTED_PO_STATUSES)))),
                "committed",
            )
            .column_as(count_unless(counted.clone()), "excluded")
            .join(
                JoinType::InnerJoin,
                purchase_order_items::Entity::belongs_to(purchase_orders::Entity)
                    .from(purchase_order_items::Column::PurchaseOrderId)
                    .to(purchase_orders::Column::Id)
                    .into(),
            )
            .filter(purchase_order_items::Column::ProjectId.eq(project_id))
            .filter(purchase_orders::Column::DeletedAt.is_null())
            .filter(purchase_order_items::Column::QuantityOrdered.gt(0))
            .into_tuple()
            .one(db)
            .await?;
    Ok(row.unwrap_or((None, None, 0)))
}

/// Counted `hr_declarations`: their amount in the project's currency, and the
/// ones in another.
async fn declaration_totals(
    db: &sea_orm::DatabaseConnection,
    project_id: &str,
    currency: Option<&str>,
) -> Result<(Option<BigDecimal>, i64), DbErr> {
    let counted = currency_is(Expr::col(hr_declarations::Column::Currency), currency);
    let row: Option<(Option<BigDecimal>, i64)> = hr_declarations::Entity::find()
        .select_only()
        .column_as(
            sum_where(Expr::col(hr_declarations::Column::Amount), counted.clone()),
            "total",
        )
        .column_as(count_unless(counted), "excluded")
        .filter(hr_declarations::Column::ProjectId.eq(project_id))
        .filter(hr_declarations::Column::Status.is_in(COUNTED_DECLARATION_STATUSES))
        .into_tuple()
        .one(db)
        .await?;
    Ok(row.unwrap_or((None, 0)))
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

/// The counted costs of a project, source by source: labour per deliverable,
/// bills, journal lines, purchase orders (received and committed) and
/// declarations, in the project's currency, and how many lines another
/// currency left out. A source without lines counts 0.
async fn source_totals(
    db: &PgPool,
    project_id: &str,
    currency: Option<&str>,
) -> Result<SourceTotals, DbErr> {
    let db = &orm(db);
    let labour_rows = labour_totals(db, project_id).await?;
    let bill = bill_totals(db, project_id, currency).await?;
    let journal = journal_totals(db, project_id, currency).await?;
    let po = purchase_totals(db, project_id, currency).await?;
    let declaration = declaration_totals(db, project_id, currency).await?;

    let mut labour: HashMap<Option<String>, f64> = HashMap::new();
    for (deliverable, cost) in labour_rows {
        *labour.entry(deliverable).or_insert(0.0) += decimal_num(cost.as_ref());
    }
    Ok(SourceTotals {
        labour,
        bills: decimal_num(bill.0.as_ref()),
        journal: decimal_num(journal.0.as_ref()),
        purchase_received: decimal_num(po.0.as_ref()),
        committed: decimal_num(po.1.as_ref()),
        declarations: decimal_num(declaration.0.as_ref()),
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

type DeliverableRow = (
    String,
    i32,
    String,
    String,
    Option<OffsetDateTime>,
    Option<OffsetDateTime>,
);

/// `computeFinance`: everything the finance figures of one project are built from, at `now_ms`.
#[allow(clippy::too_many_lines)]
async fn compute_finance(db: &PgPool, project: &Value, now_ms: i64) -> Result<FinanceModel, DbErr> {
    use project_deliverables::Column as Deliverable;

    let project_id = project["id"].as_str().unwrap_or_default();
    let currency = project_currency(project);
    let budget = project["budgetedAmount"]
        .as_str()
        .map(|text| num(Some(text)));

    let orm = &orm(db);
    let baseline = project_baselines::Entity::find()
        .filter(project_baselines::Column::ProjectId.eq(project_id))
        .order_by_desc(project_baselines::Column::Version)
        .one(orm)
        .await?;
    let deliverables: Vec<DeliverableRow> = project_deliverables::Entity::find()
        .select_only()
        .columns([
            Deliverable::Id,
            Deliverable::Number,
            Deliverable::Title,
            Deliverable::Status,
            Deliverable::PlannedStart,
            Deliverable::PlannedEnd,
        ])
        .filter(Deliverable::ProjectId.eq(project_id))
        .filter(Deliverable::DeletedAt.is_null())
        .order_by_asc(Deliverable::Position)
        .order_by_asc(Deliverable::Number)
        .into_tuple()
        .all(orm)
        .await?;
    let task_rows: Vec<(Option<String>, String, Option<BigDecimal>)> = tasks::Entity::find()
        .select_only()
        .columns([
            tasks::Column::DeliverableId,
            tasks::Column::Status,
            tasks::Column::EstimatedHours,
        ])
        .filter(tasks::Column::ProjectId.eq(project_id))
        .filter(tasks::Column::DeletedAt.is_null())
        .filter(tasks::Column::Status.ne("cancelled"))
        .order_by_asc(tasks::Column::Id)
        .into_tuple()
        .all(orm)
        .await?;
    let totals = source_totals(db, project_id, currency.as_deref()).await?;

    let frozen: HashMap<String, (Option<i64>, Option<i64>)> = baseline
        .as_ref()
        .and_then(|b| b.snapshot["deliverables"].as_array())
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
            hours: hours.as_ref().map(|h| decimal_num(Some(h))),
        });
    }
    let hours_of = |key: &Option<String>| -> f64 {
        by_deliverable.get(key).map_or(0.0, |tasks| {
            tasks.iter().map(|t| t.hours.unwrap_or(0.0)).sum()
        })
    };

    let to_ms = |at: &Option<OffsetDateTime>| -> Option<i64> { at.and_then(millis) };
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
        .and_then(|b| b.snapshot["goLive"].as_str())
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
            id: b.id,
            version: i64::from(b.version),
            created_at: weldsuite_events::iso_timestamp(b.created_at),
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
    let found: Result<Option<String>, DbErr> = project_finance_snapshots::Entity::find()
        .select_only()
        .column(project_finance_snapshots::Column::Id)
        .filter(project_finance_snapshots::Column::ProjectId.eq(project_id))
        .filter(project_finance_snapshots::Column::Week.eq(week.as_str()))
        .into_tuple()
        .one(&orm(&caller.db))
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
async fn list_cost_lines(
    db: &PgPool,
    project_id: &str,
    currency: Option<&str>,
    q: &CostsQuery,
    limit: i64,
) -> Result<(Vec<Line>, i64, bool, Option<String>), DbErr> {
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
        total += match source {
            "time" => list_time(db, &w, &mut merged).await?,
            _ => list_other(db, source, &w, &mut merged).await?,
        };
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

/// The weeks of approved time and their count.
#[allow(
    clippy::disallowed_methods,
    reason = "a report over ISO weeks, paged by day and id in byte order (`collate \"C\"`), which the ORM cannot express"
)]
async fn list_time(db: &PgPool, w: &Window<'_>, merged: &mut Vec<Line>) -> Result<i64, DbErr> {
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
    .await
    .map_err(orm_error)?;
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
                weldsuite_flow_domain::js::math_round(num(minutes.as_deref()) / 60.0 * 100.0)
                    / 100.0,
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
    .await
    .map_err(orm_error)?;
    Ok(count)
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

#[allow(
    clippy::disallowed_methods,
    reason = "other modules' ledger lines paged by day and id in byte order (`collate \"C\"`), which the ORM cannot express"
)]
async fn list_other(
    db: &PgPool,
    source: &str,
    w: &Window<'_>,
    merged: &mut Vec<Line>,
) -> Result<i64, DbErr> {
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
        .await
        .map_err(orm_error)?;
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
            .await
            .map_err(orm_error)?;
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
            let rows = project_finance_snapshots::Entity::find()
                .filter(project_finance_snapshots::Column::ProjectId.eq(project_id.as_str()))
                .order_by_asc(project_finance_snapshots::Column::Week)
                .limit(520)
                .all(&orm(&caller.db))
                .await?;
            let list: Vec<Value> = rows
                .into_iter()
                .map(|row| {
                    let budget = row.budget.as_ref().map(|t| decimal_num(Some(t)));
                    let planned = decimal_num(Some(&row.planned_value));
                    let earned = decimal_num(Some(&row.earned_value));
                    let actual = decimal_num(Some(&row.actual_cost));
                    let committed = decimal_num(Some(&row.committed));
                    let forecast = row.forecast.as_ref().map(|t| decimal_num(Some(t)));
                    json!({
                        "week": row.week,
                        "budget": amount(budget, visible),
                        "plannedValue": amount(Some(planned), visible),
                        "earnedValue": amount(Some(earned), visible),
                        "actualCost": amount(Some(actual), visible),
                        "committed": amount(Some(committed), visible),
                        "forecast": amount(forecast, visible),
                        "percent": percentages(budget, actual, committed, planned, earned, forecast),
                        "createdAt": weldsuite_events::iso_timestamp(row.created_at),
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
) -> Result<String, DbErr> {
    use project_finance_snapshots::Column as Snapshot;

    let week = iso_week_key(now_ms);
    // The amounts as their two-decimal text, as the column stores it.
    let money = |value: f64| decimal(&money_string(value));
    project_finance_snapshots::Entity::insert(project_finance_snapshots::ActiveModel {
        id: Set(generate_id("pfs")),
        project_id: Set(project_id.to_owned()),
        week: Set(week.clone()),
        budget: Set(model.budget.map(money).transpose()?),
        planned_value: Set(money(model.planned_value)?),
        earned_value: Set(money(model.earned_value)?),
        actual_cost: Set(money(model.actual)?),
        committed: Set(money(model.committed)?),
        forecast: Set(model.forecast.map(money).transpose()?),
        created_at: Set(instant(now_ms)),
    })
    .on_conflict(
        OnConflict::columns([Snapshot::ProjectId, Snapshot::Week])
            .update_columns([
                Snapshot::Budget,
                Snapshot::PlannedValue,
                Snapshot::EarnedValue,
                Snapshot::ActualCost,
                Snapshot::Committed,
                Snapshot::Forecast,
                Snapshot::CreatedAt,
            ])
            .to_owned(),
    )
    .exec_without_returning(&orm(db))
    .await?;
    Ok(week)
}

/// `snapshotWorkspace`: every live, open project with a baseline of one workspace;
/// the number written and when the workspace is next due (`None`: no project qualifies).
pub async fn snapshot_workspace(
    db: &PgPool,
    now_ms: i64,
) -> Result<(usize, Option<OffsetDateTime>), DbErr> {
    // `exists (select 1 from project_baselines b where b.project_id = p.id)`.
    let baselined = SubQuery::select()
        .column(project_baselines::Column::ProjectId)
        .from(project_baselines::Entity)
        .to_owned();
    let ids: Vec<String> = projects::Entity::find()
        .select_only()
        .column(projects::Column::Id)
        .filter(projects::Column::DeletedAt.is_null())
        .filter(projects::Column::Status.is_not_in(["Closed", "Cancelled"]))
        .filter(projects::Column::Id.in_subquery(baselined))
        .order_by_asc(projects::Column::Id)
        .into_tuple()
        .all(&orm(db))
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
