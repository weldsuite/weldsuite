//! `/api/tax-calendar` (`routes/tax-calendar/index.ts`,
//! `services/tax-calendar.ts`): a US entity's deadlines of a calendar year
//! (income tax, estimated tax, 1099s, payroll, sales tax per agency) with
//! their completion: marked done by a user, or (sales tax) the return filed.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::{delete, get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::fiscal_year::fiscal_year_config_of;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, no_content, ok, reply, validate,
};
use weldsuite_books_domain::jurisdictions::us;
use weldsuite_books_domain::tables::{ENTITIES, TAX_CALENDAR_COMPLETIONS};
use weldsuite_books_domain::tax_calendar::{AgencyInput, CalendarEntity, tax_calendar};
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::common::{is_iso_date_text, text, today_in};
use crate::returns::common::{FILED_STATUSES, agency_to_input, load_agencies};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(calendar).route_layer(need("taxes:read")))
        .route(
            "/complete",
            post(complete).route_layer(need("taxes:update")),
        )
        .route(
            "/complete/{key}",
            delete(reopen).route_layer(need("taxes:update")),
        )
        .with_state(state)
}

/// The entity of the request (any jurisdiction), or `None`.
async fn entity_of(caller: &Caller) -> Result<Option<Value>, sqlx::Error> {
    let Some(id) = resolve_entity_id(caller).await? else {
        return Ok(None);
    };
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(entities),
        " from entities t where t.id = $1 limit 1"
    ))
    .bind(&id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|r| ENTITIES.js(r)))
}

const PAYROLL_ROLES: [&str; 3] = [
    "payroll_wages_expense",
    "payroll_tax_expense",
    "payroll_liabilities",
];

/// `hasPayroll(db, entityId)`: a posted payroll import, or activity on the
/// payroll accounts.
pub(crate) async fn has_payroll(db: &PgPool, entity_id: &str) -> Result<bool, sqlx::Error> {
    let imported: Option<String> = sqlx::query_scalar(
        "select id from payroll_imports where entity_id = $1 and status = 'posted' limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    if imported.is_some() {
        return Ok(true);
    }
    let accounts: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, metadata->>'systemRole', current_balance::text from accounts \
         where entity_id = $1 and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let payroll: Vec<&(String, Option<String>, Option<String>)> = accounts
        .iter()
        .filter(|(_, role, _)| role.as_deref().is_some_and(|r| PAYROLL_ROLES.contains(&r)))
        .collect();
    if payroll.iter().any(|(_, _, balance)| {
        weldsuite_kit::validation::js_number(balance.as_deref().unwrap_or("0")) != 0.0
    }) {
        return Ok(true);
    }
    if payroll.is_empty() {
        return Ok(false);
    }
    let ids: Vec<String> = payroll.iter().map(|(id, _, _)| id.clone()).collect();
    let line: Option<String> = sqlx::query_scalar(
        "select id from journal_lines where account_id = any($1) and deleted_at is null limit 1",
    )
    .bind(&ids)
    .fetch_optional(db)
    .await?;
    Ok(line.is_some())
}

async fn files_1099(db: &PgPool) -> Result<bool, sqlx::Error> {
    let vendor: Option<String> = sqlx::query_scalar(
        "select id from parties where is_1099_vendor = true and deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(vendor.is_some())
}

async fn has_backup_withholding(
    db: &PgPool,
    entity_id: &str,
    year: i64,
) -> Result<bool, sqlx::Error> {
    let payment: Option<String> = sqlx::query_scalar(
        "select id from payments where entity_id = $1 and deleted_at is null \
         and coalesce(backup_withholding_amount, 0) > 0 \
         and date >= $2::timestamp and date <= $3::timestamp limit 1",
    )
    .bind(entity_id)
    .bind(format!("{}-01-01T00:00:00.000Z", year - 1))
    .bind(format!("{year}-12-31T23:59:59.000Z"))
    .fetch_optional(db)
    .await?;
    Ok(payment.is_some())
}

/// `entityCalendar(db, entity, year)`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors tax-calendar.ts's entityCalendar()"
)]
async fn entity_calendar(
    caller: &Caller,
    state: &BooksState,
    entity: &Value,
    year: i64,
) -> Result<Value, sqlx::Error> {
    let db = &caller.db;
    let today = today_in(caller, state, text(entity, "timezone"));
    if text(entity, "jurisdictionCode") != Some("US") {
        return Ok(json!({
            "supported": false,
            "year": year,
            "today": today,
            "form": null,
            "facts": null,
            "items": [],
            "message": "The tax calendar covers US filings only; this accounting entity is outside the US.",
        }));
    }
    let entity_id = text(entity, "id").unwrap_or_default();
    let payroll = has_payroll(db, entity_id).await?;
    let vendors = files_1099(db).await?;
    let backup = has_backup_withholding(db, entity_id, year).await?;
    let agencies = load_agencies(db, entity_id).await?;
    let form = us::tax_form_for_entity(
        text(entity, "entityType"),
        text(entity, "taxClassification"),
    );
    let fiscal = fiscal_year_config_of(
        entity["fiscalYearStart"].as_f64(),
        entity.get("fiscalYearConfig"),
    );
    let calendar_entity = CalendarEntity {
        form: form.to_owned(),
        fiscal_year: Some(fiscal),
        has_payroll: payroll,
        files_1099: vendors,
        has_backup_withholding: backup,
    };
    let inputs: Vec<AgencyInput> = agencies
        .iter()
        .map(|a| AgencyInput {
            status: text(a, "status").map(str::to_owned),
            ..agency_to_input(a)
        })
        .collect();
    let deadlines = tax_calendar(&calendar_entity, year, Some(&inputs));
    let completions: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(tax_calendar_completions),
        " from tax_calendar_completions t where t.entity_id = $1"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let completions = TAX_CALENDAR_COMPLETIONS.js_rows(completions);
    let agency_ids: Vec<String> = {
        let mut ids: Vec<String> = Vec::new();
        for d in deadlines.iter().filter(|d| d.kind == "sales_tax") {
            let id = d.agency_id.clone().unwrap_or_default();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids
    };
    let returns: Vec<Value> = if agency_ids.is_empty() {
        Vec::new()
    } else {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(tax_returns),
            " from tax_returns t where t.entity_id = $1 and t.deleted_at is null \
             and t.amends_return_id is null and t.agency_id = any($2)"
        ))
        .bind(entity_id)
        .bind(&agency_ids)
        .fetch_all(db)
        .await?;
        weldsuite_books_domain::tables::TAX_RETURNS.js_rows(rows)
    };
    let items: Vec<Value> = deadlines
        .iter()
        .map(|d| {
            // `new Map(...)`: the last one of a key wins.
            let manual = completions
                .iter()
                .rev()
                .find(|c| text(c, "deadlineKey") == Some(d.key.as_str()));
            let ret = returns.iter().rev().find(|r| {
                format!(
                    "sales_tax:{}:{}",
                    text(r, "agencyId").unwrap_or(""),
                    text(r, "periodEnd").unwrap_or("")
                ) == d.key
            });
            let filed =
                ret.is_some_and(|r| FILED_STATUSES.contains(&text(r, "status").unwrap_or("")));
            let completed = manual.is_some() || filed;
            let completed_at = match manual {
                Some(m) => m["createdAt"].clone(),
                None if filed => ret
                    .and_then(|r| r.get("filedAt"))
                    .filter(|f| !f.is_null())
                    .cloned()
                    .unwrap_or(Value::Null),
                None => Value::Null,
            };
            let completed_by = match manual {
                Some(m) => m["completedBy"].clone(),
                None if filed => ret
                    .and_then(|r| r.get("filedBy"))
                    .cloned()
                    .unwrap_or(Value::Null),
                None => Value::Null,
            };
            let mut out = d.to_json();
            out.insert("completed".into(), json!(completed));
            out.insert("completedAt".into(), completed_at);
            out.insert("completedBy".into(), completed_by);
            out.insert(
                "completionNotes".into(),
                manual.map_or(Value::Null, |m| m["notes"].clone()),
            );
            out.insert(
                "completionSource".into(),
                if manual.is_some() {
                    json!("manual")
                } else if filed {
                    json!("return")
                } else {
                    Value::Null
                },
            );
            out.insert(
                "returnId".into(),
                ret.map_or(Value::Null, |r| r["id"].clone()),
            );
            out.insert(
                "returnStatus".into(),
                ret.map_or(Value::Null, |r| r["status"].clone()),
            );
            out.insert(
                "daysUntilDue".into(),
                json!(weldsuite_books_domain::dates::diff_days(
                    &today,
                    &d.due_date
                )),
            );
            out.insert(
                "overdue".into(),
                json!(!completed && !d.informational && d.due_date < today),
            );
            Value::Object(out)
        })
        .collect();
    Ok(json!({
        "supported": true,
        "year": year,
        "today": today,
        "form": form,
        "facts": {
            "hasPayroll": payroll,
            "files1099": vendors,
            "hasBackupWithholding": backup,
            "agencies": agencies.len(),
        },
        "items": items,
    }))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn calendar(
    caller: Caller,
    State(state): State<BooksState>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let Some(entity) = entity_of(&caller).await? else {
                return Err(Refusal::bad_request("No accounting entity resolved"));
            };
            let year = match q.get("year").filter(|y| !y.is_empty()) {
                Some(raw) => weldsuite_books_domain::js::parse_int(raw),
                None => today_in(&caller, &state, text(&entity, "timezone"))
                    .get(..4)
                    .and_then(|y| y.parse().ok()),
            };
            let Some(year) = year.filter(|y| (2000..=2100).contains(y)) else {
                return Err(Refusal::bad_request("year must be between 2000 and 2100"));
            };
            Ok(ok(entity_calendar(&caller, &state, &entity, year).await?))
        }
        .await,
        "Failed to fetch the tax calendar",
    )
}

// ── POST /complete ──────────────────────────────────────────────────────────

struct CompleteBody {
    key: String,
    due_date: String,
    notes: Option<String>,
}

fn is_key(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 120
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'.' | b'-'))
}

fn read_complete(issues: &mut Issues, body: &Map<String, Value>) -> CompleteBody {
    let key = issues.pattern(
        body,
        "deadlineKey",
        Presence::Required,
        None,
        None,
        is_key,
        "Use the key of a calendar deadline",
    );
    let due = issues.pattern(
        body,
        "dueDate",
        Presence::Required,
        None,
        None,
        is_iso_date_text,
        "Use a YYYY-MM-DD date",
    );
    let notes = issues.text(body, "notes", Presence::Optional, None, Some(2000));
    CompleteBody {
        key: key.into_option().unwrap_or_default(),
        due_date: due.into_option().unwrap_or_default(),
        notes: notes.into_option(),
    }
}

async fn complete(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, read_complete) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to mark the deadline done"),
    };
    reply(
        mark_done(&caller, data).await,
        "Failed to mark the deadline done",
    )
}

async fn mark_done(caller: &Caller, data: CompleteBody) -> Reply {
    let Some(entity) = entity_of(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    if text(&entity, "jurisdictionCode") != Some("US") {
        return Err(Refusal::bad_request(
            "The tax calendar covers US entities only",
        ));
    }
    let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
    let user = caller.user().map(str::to_owned);
    sqlx::query(
        "insert into tax_calendar_completions (id, entity_id, deadline_key, due_date, completed_by, notes) \
         values ($1, $2, $3, $4::date, $5, $6) \
         on conflict (entity_id, deadline_key) do update set due_date = excluded.due_date, \
         completed_by = excluded.completed_by, notes = excluded.notes",
    )
    .bind(generate_id("tcc"))
    .bind(&entity_id)
    .bind(&data.key)
    .bind(&data.due_date)
    .bind(&user)
    .bind(&data.notes)
    .execute(&caller.db)
    .await?;
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(tax_calendar_completions),
        " from tax_calendar_completions t where t.entity_id = $1 and t.deadline_key = $2 limit 1"
    ))
    .bind(&entity_id)
    .bind(&data.key)
    .fetch_optional(&caller.db)
    .await?;
    let row = TAX_CALENDAR_COMPLETIONS.js(row.unwrap_or(Value::Null));
    let mut changes = Map::new();
    changes.insert("deadlineKey".into(), change(Value::Null, json!(data.key)));
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "tax_calendar_completion",
            entity_id: text(&row, "id").unwrap_or_default(),
            action: "completed",
            changes: Some(changes),
        },
    )
    .await;
    Ok(created(json!({
        "id": row["id"],
        "deadlineKey": row["deadlineKey"],
        "dueDate": row["dueDate"],
        "completedBy": row["completedBy"],
        "completedAt": row["createdAt"],
        "notes": row["notes"],
    })))
}

// ── DELETE /complete/:deadlineKey ───────────────────────────────────────────

async fn reopen(caller: Caller, Path(key): Path<String>) -> Response {
    reply(
        async {
            let Some(entity) = entity_of(&caller).await? else {
                return Err(Refusal::bad_request("No accounting entity resolved"));
            };
            let entity_id = text(&entity, "id").unwrap_or_default().to_owned();
            let removed: Vec<String> = sqlx::query_scalar(
                "delete from tax_calendar_completions where entity_id = $1 and deadline_key = $2 returning id",
            )
            .bind(&entity_id)
            .bind(&key)
            .fetch_all(&caller.db)
            .await?;
            if removed.is_empty() {
                return Err(Refusal::not_found("Completion", &key));
            }
            let mut changes = Map::new();
            changes.insert("deadlineKey".into(), change(json!(key), Value::Null));
            write_accounting_audit(
                &caller,
                &caller.db,
                AuditInput {
                    accounting_entity_id: Some(&entity_id),
                    entity_type: "tax_calendar_completion",
                    entity_id: &key,
                    action: "reopened",
                    changes: Some(changes),
                },
            )
            .await;
            Ok(no_content())
        }
        .await,
        "Failed to reopen the deadline",
    )
}
