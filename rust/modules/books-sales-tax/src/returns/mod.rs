//! `/api/tax-returns` (`routes/tax-returns/index.ts`): the Sales Tax Center's
//! per-agency returns, on `services/sales-tax-returns/*`.
//!
//! Periods with due dates, the overview, the returns (open, calculate,
//! review, adjust, delete), the documents behind a return, the pre-file and
//! liability checks, exceptions to a filed period, the CSV export, filing,
//! the payment, amendments and carrying exceptions forward.

pub(crate) mod calculate;
pub(crate) mod checks;
pub(crate) mod common;
pub(crate) mod documents;
pub(crate) mod filing;
pub(crate) mod lifecycle;
pub(crate) mod payment;
pub(crate) mod periods;
pub(crate) mod rows;

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::{HeaderMap, HeaderValue, header};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, no_content, ok, paged, reply, validate,
};
use weldsuite_books_domain::js::parse_int;
use weldsuite_catalogs::entity_events::{
    EventName, TAX_RETURN_CREATED, TAX_RETURN_DELETED, TAX_RETURN_FILED, TAX_RETURN_PAID,
    TAX_RETURN_UPDATED,
};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use self::calculate::{CalculationInput, calculate_return};
use self::common::{
    ADJUSTMENT_TYPES, ReturnContext, bad, entity_id_of, is_filed, load_agency, load_us_entity, n,
    now_iso, num_at, return_context, s, serialize, serialize_with,
};
use self::documents::{load_certificate_refs, return_documents};
use self::payment::{PaymentFailure, PaymentInput, record_return_payment};
use crate::common::{is_iso_date_text, text, today_in};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/periods", get(periods).route_layer(need("taxes:read")))
        .route("/overview", get(overview).route_layer(need("taxes:read")))
        .route(
            "/",
            get(list)
                .route_layer(need("taxes:read"))
                .merge(post(create).route_layer(need("taxes:create"))),
        )
        .route(
            "/{id}",
            get(fetch)
                .route_layer(need("taxes:read"))
                .merge(axum::routing::patch(update).route_layer(need("taxes:update")))
                .merge(axum::routing::delete(remove).route_layer(need("taxes:delete"))),
        )
        .route(
            "/{id}/calculate",
            post(calculate).route_layer(need("taxes:update")),
        )
        .route(
            "/{id}/review",
            post(review).route_layer(need("taxes:update")),
        )
        .route(
            "/{id}/documents",
            get(documents).route_layer(need("taxes:read")),
        )
        .route(
            "/{id}/pre-file-check",
            get(pre_file).route_layer(need("taxes:read")),
        )
        .route(
            "/{id}/liability-check",
            get(liability).route_layer(need("taxes:read")),
        )
        .route(
            "/{id}/exceptions",
            get(exceptions).route_layer(need("taxes:read")),
        )
        .route("/{id}/export", get(export).route_layer(need("taxes:read")))
        .route("/{id}/file", post(file).route_layer(need("taxes:file")))
        .route(
            "/{id}/payment",
            post(payment).route_layer(need("taxes:file")),
        )
        .route("/{id}/amend", post(amend).route_layer(need("taxes:create")))
        .route(
            "/{id}/carry-forward",
            post(carry_forward).route_layer(need("taxes:update")),
        )
        .with_state(state)
}

/// `eventData(ret)`: no amounts per customer, nothing personal.
fn event_data(ret: &Value) -> Value {
    json!({
        "id": ret["id"],
        "agencyId": ret["agencyId"],
        "stateCode": ret["stateCode"],
        "periodStart": ret["periodStart"],
        "periodEnd": ret["periodEnd"],
        "status": ret["status"],
        "totalDue": n(num_at(ret, "totalDue")),
        "amendsReturnId": ret["amendsReturnId"],
    })
}

fn publish(caller: &Caller, state: &BooksState, ret: &Value, event: EventName) {
    caller.publish(state, event, s(ret, "id"), event_data(ret));
}

async fn audit(caller: &Caller, ret: &Value, action: &str, changes: Option<Map<String, Value>>) {
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: text(ret, "entityId"),
            entity_type: "tax_return",
            entity_id: s(ret, "id"),
            action,
            changes,
        },
    )
    .await;
}

fn changes(entries: Vec<(&str, Value, Value)>) -> Map<String, Value> {
    entries
        .into_iter()
        .map(|(key, old, new)| (key.to_owned(), change(old, new)))
        .collect()
}

/// The request's day in the entity's time zone.
fn today_of(caller: &Caller, state: &BooksState, entity: &Value) -> String {
    today_in(caller, state, text(entity, "timezone"))
}

// ── GET /periods ────────────────────────────────────────────────────────────

async fn periods(
    caller: Caller,
    State(state): State<BooksState>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            for key in ["from", "to"] {
                if let Some(value) = q.present(key)
                    && !is_iso_date_text(value)
                {
                    return Err(bad(format!("{key} must be a YYYY-MM-DD date")));
                }
            }
            let entity = load_us_entity(&caller.db, &entity_id_of(&caller).await?).await?;
            let today = today_of(&caller, &state, &entity);
            Ok(ok(lifecycle::list_periods(
                &caller.db,
                &entity,
                q.get("agencyId"),
                q.get("from"),
                q.get("to"),
                &today,
            )
            .await?))
        }
        .await,
        "Failed to fetch periods",
    )
}

// ── GET /overview ───────────────────────────────────────────────────────────

async fn overview(caller: Caller, State(state): State<BooksState>) -> Response {
    reply(
        async {
            let entity = load_us_entity(&caller.db, &entity_id_of(&caller).await?).await?;
            let today = today_of(&caller, &state, &entity);
            let now = now_iso(&caller, &state);
            Ok(ok(lifecycle::sales_tax_overview(
                &caller.db, &entity, &now, &today,
            )
            .await?))
        }
        .await,
        "Failed to fetch the sales tax overview",
    )
}

/// `Math.min(Math.max(Number.parseInt(raw || fallback, 10) || fallback, 1), max)`.
fn clamp_limit(raw: Option<&str>, fallback: i64, max: i64) -> i64 {
    let parsed = raw
        .filter(|r| !r.is_empty())
        .and_then(parse_int)
        .filter(|v| *v != 0)
        .unwrap_or(fallback);
    parsed.max(1).min(max)
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Ok(paged(Vec::new(), 0, false, None));
            };
            let limit = clamp_limit(q.get("limit"), 25, 100);
            let (rows, total, has_more, cursor) = lifecycle::list_returns(
                &caller.db,
                &entity_id,
                &lifecycle::ListFilter {
                    agency_id: q.present("agencyId"),
                    status: q.present("status"),
                    from: q.present("from"),
                    to: q.present("to"),
                    limit,
                    cursor: q.present("cursor"),
                },
            )
            .await?;
            Ok(paged(
                rows.iter().map(serialize).collect(),
                total,
                has_more,
                cursor,
            ))
        }
        .await,
        "Failed to fetch tax returns",
    )
}

// ── POST / ──────────────────────────────────────────────────────────────────

fn day_field(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<String> {
    issues.pattern(
        body,
        key,
        presence,
        None,
        None,
        is_iso_date_text,
        "Use a YYYY-MM-DD date",
    )
}

fn id30(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<String> {
    issues.text(body, key, presence, Some(1), Some(30))
}

struct CreateBody {
    agency_id: String,
    period_start: Option<String>,
    period_end: Option<String>,
}

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAIL: &str = "Failed to create the tax return";
    let data = match validate(&headers, &body, |issues, body| CreateBody {
        agency_id: id30(issues, body, "agencyId", Presence::Required)
            .into_option()
            .unwrap_or_default(),
        period_start: day_field(issues, body, "periodStart", Presence::Optional).into_option(),
        period_end: day_field(issues, body, "periodEnd", Presence::Optional).into_option(),
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAIL),
    };
    reply(
        async {
            let entity = load_us_entity(&caller.db, &entity_id_of(&caller).await?).await?;
            let agency = load_agency(&caller.db, s(&entity, "id"), &data.agency_id).await?;
            let now = now_iso(&caller, &state);
            let today = today_of(&caller, &state, &entity);
            let ret = lifecycle::create_return(
                &caller.db,
                &entity,
                &agency,
                data.period_start.as_deref(),
                data.period_end.as_deref(),
                &now,
                &today,
            )
            .await?;
            audit(&caller, &ret, "created", None).await;
            publish(&caller, &state, &ret, TAX_RETURN_CREATED);
            Ok(created(serialize(&ret)))
        }
        .await,
        FAIL,
    )
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn fetch(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let ReturnContext {
                entity,
                ret,
                agency,
            } = return_context(&caller, &id).await?;
            let amendments: Vec<Value> = sqlx::query_scalar(
                "select jsonb_build_object('id', id, 'status', status, 'filedAt', \
                 case when filed_at is null then null else to_char(filed_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') end) \
                 from tax_returns where amends_return_id = $1 and deleted_at is null",
            )
            .bind(s(&ret, "id"))
            .fetch_all(&caller.db)
            .await?;
            let today = today_of(&caller, &state, &entity);
            let due = text(&ret, "dueDate").filter(|d| !d.is_empty());
            let overdue = !is_filed(&ret)
                && due.is_some_and(|d| s(&ret, "periodEnd") < today.as_str() && d < today.as_str());
            let mut extra = Map::new();
            extra.insert(
                "agency".into(),
                json!({
                    "id": agency["id"],
                    "name": agency["name"],
                    "stateCode": agency["stateCode"],
                    "filingFrequency": agency["filingFrequency"],
                    "dueDay": agency["dueDay"],
                    "reportingBasis": agency["reportingBasis"],
                    "registrationNumber": agency["registrationNumber"],
                    "portalUrl": agency["portalUrl"],
                }),
            );
            extra.insert("amendments".into(), Value::Array(amendments));
            extra.insert("overdue".into(), json!(overdue));
            Ok(ok(serialize_with(&ret, extra)))
        }
        .await,
        "Failed to fetch the tax return",
    )
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

struct PatchBody {
    adjustments: Option<Vec<Value>>,
    notes: Option<Value>,
}

fn read_adjustment(issues: &mut Issues, item: &Value) -> Option<Value> {
    let fields = issues.object(item)?;
    let before = issues.count();
    let kind = issues.choice(fields, "type", Presence::Required, &ADJUSTMENT_TYPES);
    let amount = issues.number(fields, "amount", Presence::Required, Number::default());
    let note = issues.text(fields, "note", Presence::Optional, None, Some(255));
    let account = id30(issues, fields, "accountId", Presence::Optional);
    let auto = issues.boolean(fields, "auto", Presence::Optional);
    if issues.count() > before {
        return None;
    }
    let mut out = Map::new();
    out.insert("type".into(), json!(kind.into_option()));
    out.insert("amount".into(), n(amount.into_option().unwrap_or(0.0)));
    if let Some(note) = note.into_option() {
        out.insert("note".into(), json!(note));
    }
    if let Some(account) = account.into_option() {
        out.insert("accountId".into(), json!(account));
    }
    if let Some(auto) = auto.into_option() {
        out.insert("auto".into(), json!(auto));
    }
    Some(Value::Object(out))
}

fn read_patch(issues: &mut Issues, body: &Map<String, Value>) -> PatchBody {
    let adjustments = issues
        .list(
            body,
            "adjustments",
            Presence::Optional,
            None,
            Some(50),
            read_adjustment,
        )
        .into_option();
    let notes = match issues.text(body, "notes", Presence::Nullish, None, Some(2000)) {
        Field::Set(text) => Some(json!(text)),
        Field::Null => Some(Value::Null),
        Field::Absent => None,
    };
    if issues.is_empty() && !body.contains_key("adjustments") && !body.contains_key("notes") {
        issues.custom_root("Nothing to update");
    }
    PatchBody { adjustments, notes }
}

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAIL: &str = "Failed to update the tax return";
    let data = match validate(&headers, &body, read_patch) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAIL),
    };
    reply(
        async {
            let ReturnContext { ret, .. } = return_context(&caller, &id).await?;
            let now = now_iso(&caller, &state);
            let updated = lifecycle::patch_return(
                &caller.db,
                &ret,
                data.adjustments.as_ref(),
                data.notes.as_ref(),
                &now,
            )
            .await?;
            let mut entries: Vec<(&str, Value, Value)> = Vec::new();
            if let Some(adjustments) = &data.adjustments {
                entries.push((
                    "adjustments",
                    ret["adjustments"].clone(),
                    Value::Array(adjustments.clone()),
                ));
            }
            if let Some(notes) = &data.notes {
                entries.push(("notes", ret["notes"].clone(), notes.clone()));
            }
            audit(&caller, &updated, "updated", Some(changes(entries))).await;
            publish(&caller, &state, &updated, TAX_RETURN_UPDATED);
            Ok(ok(serialize(&updated)))
        }
        .await,
        FAIL,
    )
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let ReturnContext { ret, .. } = return_context(&caller, &id).await?;
            let now = now_iso(&caller, &state);
            lifecycle::delete_return(&caller.db, &ret, &now).await?;
            audit(&caller, &ret, "deleted", None).await;
            let mut deleted = ret.clone();
            deleted["status"] = json!("deleted");
            publish(&caller, &state, &deleted, TAX_RETURN_DELETED);
            Ok(no_content())
        }
        .await,
        "Failed to delete the tax return",
    )
}

// ── POST /:id/calculate, /:id/review ────────────────────────────────────────

async fn calculate(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let ReturnContext {
                entity,
                ret,
                agency,
            } = return_context(&caller, &id).await?;
            let now = now_iso(&caller, &state);
            let today = today_of(&caller, &state, &entity);
            let updated =
                lifecycle::calculate_and_store(&caller.db, &entity, &agency, &ret, &now, &today)
                    .await?;
            audit(
                &caller,
                &updated,
                "calculated",
                Some(changes(vec![(
                    "totalDue",
                    n(num_at(&ret, "totalDue")),
                    n(num_at(&updated, "totalDue")),
                )])),
            )
            .await;
            publish(&caller, &state, &updated, TAX_RETURN_UPDATED);
            Ok(ok(serialize(&updated)))
        }
        .await,
        "Failed to calculate the tax return",
    )
}

async fn review(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let ReturnContext { ret, .. } = return_context(&caller, &id).await?;
            let now = now_iso(&caller, &state);
            let updated = lifecycle::review_return(&caller.db, &ret, &now).await?;
            audit(
                &caller,
                &updated,
                "reviewed",
                Some(changes(vec![(
                    "status",
                    ret["status"].clone(),
                    updated["status"].clone(),
                )])),
            )
            .await;
            publish(&caller, &state, &updated, TAX_RETURN_UPDATED);
            Ok(ok(serialize(&updated)))
        }
        .await,
        "Failed to review the tax return",
    )
}

// ── GET /:id/documents ──────────────────────────────────────────────────────

async fn documents(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let ReturnContext {
                entity,
                ret,
                agency,
            } = return_context(&caller, &id).await?;
            let rows = if is_filed(&ret) {
                rows::load_filed_rows(&caller.db, s(&entity, "id"), &agency, &ret).await?
            } else {
                let now = now_iso(&caller, &state);
                let today = today_of(&caller, &state, &entity);
                calculate_return(
                    &caller.db,
                    &CalculationInput {
                        entity: &entity,
                        agency: &agency,
                        ret: &ret,
                        now: &now,
                        today: &today,
                        created_not_after: None,
                    },
                )
                .await?
                .rows
            };
            let documents = return_documents(&caller.db, s(&entity, "id"), &rows.entries).await?;
            let limit = clamp_limit(q.get("limit"), 100, 500);
            let offset = q
                .get("cursor")
                .filter(|c| !c.is_empty())
                .and_then(parse_int)
                .unwrap_or(0)
                .max(0);
            let total = i64::try_from(documents.len()).unwrap_or(i64::MAX);
            let page: Vec<Value> = documents
                .into_iter()
                .skip(usize::try_from(offset).unwrap_or(usize::MAX))
                .take(usize::try_from(limit).unwrap_or(0))
                .collect();
            let ids: Vec<String> = page
                .iter()
                .flat_map(|d| {
                    d["certificateIds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                })
                .collect();
            let certificates = load_certificate_refs(&caller.db, s(&entity, "id"), &ids).await?;
            let has_more = offset + limit < total;
            let page: Vec<Value> = page
                .into_iter()
                .map(|mut d| {
                    let linked: Vec<Value> = d["certificateIds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|id| {
                            certificates.iter().rev().find(|c| c["id"] == *id).cloned()
                        })
                        .collect();
                    d["certificates"] = Value::Array(linked);
                    d
                })
                .collect();
            Ok(paged(
                page,
                total,
                has_more,
                has_more.then(|| (offset + limit).to_string()),
            ))
        }
        .await,
        "Failed to fetch the return documents",
    )
}

// ── GET /:id/pre-file-check, /:id/liability-check, /:id/exceptions ──────────

async fn pre_file(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let ReturnContext {
                entity,
                ret,
                agency,
            } = return_context(&caller, &id).await?;
            let now = now_iso(&caller, &state);
            let today = today_of(&caller, &state, &entity);
            Ok(ok(checks::pre_file_check(
                &caller.db, &entity, &agency, &ret, &now, &today,
            )
            .await?))
        }
        .await,
        "Failed to run the pre-file check",
    )
}

async fn liability(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let ReturnContext {
                entity,
                ret,
                agency,
            } = return_context(&caller, &id).await?;
            let today = today_of(&caller, &state, &entity);
            let returns =
                common::load_agency_returns(&caller.db, s(&entity, "id"), s(&agency, "id")).await?;
            let liability = checks::agency_liability(
                &caller.db,
                s(&entity, "id"),
                &agency,
                &today,
                true,
                &returns,
            )
            .await?;
            let mut out = Map::new();
            out.insert("returnId".into(), ret["id"].clone());
            out.extend(liability.json);
            Ok(ok(Value::Object(out)))
        }
        .await,
        "Failed to run the liability check",
    )
}

async fn exceptions(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let ReturnContext { ret, agency, .. } = return_context(&caller, &id).await?;
            let result = filing::list_exceptions(&caller.db, &agency, &ret).await?;
            Ok(ok(result.to_json(s(&ret, "id"))))
        }
        .await,
        "Failed to fetch the return exceptions",
    )
}

// ── GET /:id/export ─────────────────────────────────────────────────────────

async fn export(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        async {
            let format = q.get("format").unwrap_or("csv");
            if format != "csv" && format != "json" {
                return Err(bad("format must be csv or json"));
            }
            let ReturnContext {
                entity,
                ret,
                agency,
            } = return_context(&caller, &id).await?;
            let now = now_iso(&caller, &state);
            let today = today_of(&caller, &state, &entity);
            let artifact =
                lifecycle::export_return(&caller.db, &entity, &agency, &ret, &now, &today).await?;
            if format == "json" {
                return Ok(ok(artifact));
            }
            let mut response = Response::new(Body::from(s(&artifact, "content").to_owned()));
            let headers = response.headers_mut();
            if let Ok(value) =
                HeaderValue::from_str(&format!("{}; charset=utf-8", s(&artifact, "mimeType")))
            {
                headers.insert(header::CONTENT_TYPE, value);
            }
            if let Ok(value) = HeaderValue::from_str(&format!(
                "attachment; filename=\"{}\"",
                s(&artifact, "filename")
            )) {
                headers.insert(header::CONTENT_DISPOSITION, value);
            }
            Ok(response)
        }
        .await,
        "Failed to export the tax return",
    )
}

// ── POST /:id/file ──────────────────────────────────────────────────────────

struct FileBody {
    confirmation_number: String,
    filed_at: Option<String>,
}

fn is_datetime_offset(text: &str) -> bool {
    let mut probe = Issues::default();
    let mut body = Map::new();
    body.insert("v".into(), json!(text));
    probe.text_with(
        &body,
        "v",
        Presence::Required,
        Text {
            format: Some(Format::DatetimeOffset),
            ..Text::length(None, None)
        },
    );
    probe.is_empty()
}

fn read_file(issues: &mut Issues, body: &Map<String, Value>) -> FileBody {
    let confirmation = issues.text_with(
        body,
        "confirmationNumber",
        Presence::Required,
        Text::trimmed(Some(1), Some(255)),
    );
    let filed_at = match body.get("filedAt") {
        None => None,
        Some(Value::String(t)) if is_iso_date_text(t) || is_datetime_offset(t) => Some(t.clone()),
        Some(value) => {
            let path = issues.path_of("filedAt");
            let branch = |issue: Value| json!({ "issues": [issue], "name": "ZodError" });
            let (first, second) = if let Value::String(_) = value {
                (
                    json!({ "validation": "regex", "code": "invalid_string", "message": "Use a YYYY-MM-DD date", "path": path }),
                    json!({ "code": "invalid_string", "validation": "datetime", "message": "Invalid datetime", "path": path }),
                )
            } else {
                let received = match value {
                    Value::Null => "null",
                    Value::Bool(_) => "boolean",
                    Value::Number(_) => "number",
                    Value::Array(_) => "array",
                    _ => "object",
                };
                let issue = json!({
                    "code": "invalid_type",
                    "expected": "string",
                    "received": received,
                    "path": path,
                    "message": format!("Expected string, received {received}"),
                });
                (issue.clone(), issue)
            };
            issues.issue_at(
                "filedAt",
                json!({
                    "code": "invalid_union",
                    "unionErrors": [branch(first), branch(second)],
                    "message": "Invalid input",
                }),
            );
            None
        }
    };
    FileBody {
        confirmation_number: confirmation.into_option().unwrap_or_default(),
        filed_at,
    }
}

async fn file(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAIL: &str = "Failed to file the tax return";
    let data = match validate(&headers, &body, read_file) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAIL),
    };
    reply(
        async {
            let ReturnContext {
                entity,
                ret,
                agency,
            } = return_context(&caller, &id).await?;
            let filed_at = match data.filed_at.as_deref() {
                Some(day) if is_iso_date_text(day) => Some(format!("{day}T12:00:00.000Z")),
                Some(at) => Some(
                    weldsuite_kit::validation::js_date_iso(at)
                        .ok_or_else(|| Refusal::Internal(format!("invalid filedAt {at}")))?,
                ),
                None => None,
            };
            let now = now_iso(&caller, &state);
            let today = today_of(&caller, &state, &entity);
            let (updated, warnings) = filing::file_return(
                &caller.db,
                filing::FileInput {
                    entity: &entity,
                    agency: &agency,
                    ret: &ret,
                    confirmation_number: &data.confirmation_number,
                    filed_at,
                    user_id: caller.user(),
                    now: &now,
                    today: &today,
                },
            )
            .await?;
            audit(
                &caller,
                &updated,
                "filed",
                Some(changes(vec![
                    ("status", ret["status"].clone(), json!("filed")),
                    (
                        "confirmationNumber",
                        Value::Null,
                        json!(data.confirmation_number),
                    ),
                ])),
            )
            .await;
            publish(&caller, &state, &updated, TAX_RETURN_FILED);
            let mut extra = Map::new();
            extra.insert("warnings".into(), Value::Array(warnings));
            Ok(ok(serialize_with(&updated, extra)))
        }
        .await,
        FAIL,
    )
}

// ── POST /:id/payment ───────────────────────────────────────────────────────

struct PaymentBody {
    bank_account_id: String,
    amount: f64,
    date: String,
    reference: Option<String>,
    difference_reason: Option<String>,
}

fn read_payment(issues: &mut Issues, body: &Map<String, Value>) -> PaymentBody {
    PaymentBody {
        bank_account_id: id30(issues, body, "bankAccountId", Presence::Required)
            .into_option()
            .unwrap_or_default(),
        amount: issues
            .number(body, "amount", Presence::Required, Number::default())
            .into_option()
            .unwrap_or(0.0),
        date: day_field(issues, body, "date", Presence::Required)
            .into_option()
            .unwrap_or_default(),
        reference: issues
            .text(body, "reference", Presence::Optional, None, Some(255))
            .into_option(),
        difference_reason: issues
            .text(
                body,
                "differenceReason",
                Presence::Optional,
                None,
                Some(500),
            )
            .into_option(),
    }
}

async fn payment(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAIL: &str = "Failed to record the tax payment";
    let data = match validate(&headers, &body, read_payment) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAIL),
    };
    let result: Reply = async {
        let ReturnContext {
            entity,
            ret,
            agency,
        } = return_context(&caller, &id).await?;
        let now = now_iso(&caller, &state);
        let result = match record_return_payment(
            &caller.db,
            PaymentInput {
                entity: &entity,
                agency: &agency,
                ret: &ret,
                bank_account_id: &data.bank_account_id,
                amount: data.amount,
                date: &data.date,
                reference: data.reference.as_deref(),
                difference_reason: data.difference_reason.as_deref(),
                user_id: caller.user(),
                now: &now,
            },
        )
        .await
        {
            Ok(result) => result,
            Err(PaymentFailure::Refused(refusal)) => return Err(refusal),
            Err(PaymentFailure::Post(error)) => {
                return Err(match error.user_message() {
                    Some(message) => Refusal::bad_request(message),
                    None => Refusal::Internal(error.to_string()),
                });
            }
        };
        audit(
            &caller,
            &result.ret,
            "paid",
            Some(changes(vec![
                ("status", ret["status"].clone(), json!("paid")),
                ("paymentAmount", Value::Null, n(data.amount)),
                (
                    "journalEntryId",
                    Value::Null,
                    json!(result.journal_entry_id),
                ),
            ])),
        )
        .await;
        publish(&caller, &state, &result.ret, TAX_RETURN_PAID);
        let mut extra = Map::new();
        extra.insert(
            "payment".into(),
            json!({
                "journalEntryId": result.journal_entry_id,
                "totalDue": n(result.total_due),
                "difference": n(result.difference),
                "lines": result.lines,
            }),
        );
        Ok(ok(serialize_with(&result.ret, extra)))
    }
    .await;
    reply(result, FAIL)
}

// ── POST /:id/amend ─────────────────────────────────────────────────────────

async fn amend(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let ReturnContext {
                entity,
                ret,
                agency,
            } = return_context(&caller, &id).await?;
            let now = now_iso(&caller, &state);
            let today = today_of(&caller, &state, &entity);
            let (amendment, taken) = filing::amend_return(
                &caller.db,
                &entity,
                &agency,
                &ret,
                caller.user(),
                &now,
                &today,
            )
            .await?;
            audit(
                &caller,
                &amendment,
                "amended",
                Some(changes(vec![(
                    "amendsReturnId",
                    Value::Null,
                    ret["id"].clone(),
                )])),
            )
            .await;
            publish(&caller, &state, &amendment, TAX_RETURN_CREATED);
            let mut extra = Map::new();
            extra.insert("exceptionRows".into(), json!(taken));
            Ok(created(serialize_with(&amendment, extra)))
        }
        .await,
        "Failed to amend the tax return",
    )
}

// ── POST /:id/carry-forward ─────────────────────────────────────────────────

async fn carry_forward(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAIL: &str = "Failed to carry the exceptions forward";
    let data = match validate(&headers, &body, |issues, body| {
        issues
            .list(
                body,
                "taxLineIds",
                Presence::Optional,
                None,
                Some(5000),
                |issues, item| issues.item_text(item, Text::length(Some(1), Some(30))),
            )
            .into_option()
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAIL),
    };
    reply(
        async {
            let ReturnContext { ret, agency, .. } = return_context(&caller, &id).await?;
            let now = now_iso(&caller, &state);
            let (updated, carried, tax_amount, recalculate) =
                filing::carry_forward(&caller.db, &agency, &ret, data, caller.user(), &now).await?;
            audit(
                &caller,
                &updated,
                "carried_forward",
                Some(changes(vec![("rows", json!(0), json!(carried))])),
            )
            .await;
            publish(&caller, &state, &updated, TAX_RETURN_UPDATED);
            let mut extra = Map::new();
            extra.insert("carriedRows".into(), json!(carried));
            extra.insert("taxAmount".into(), n(tax_amount));
            extra.insert("recalculate".into(), Value::Array(recalculate));
            Ok(ok(serialize_with(&updated, extra)))
        }
        .await,
        FAIL,
    )
}
