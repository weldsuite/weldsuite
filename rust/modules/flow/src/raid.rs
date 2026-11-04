//! `/api/project-raid` (`routes/project-raid/index.ts`): the RAID log, its
//! risks, assumptions, issues and dependencies in `project_raid_items`, with
//! the risks' trend in `project_raid_assessments` (design:
//! weldflow-project-control.md; ADRs FLOW-010 and FLOW-011).
//!
//! ```text
//! GET    /                list (projectId optional, filters, cursor)
//! GET    /matrix          5x5 counts of open risks
//! GET    /:id             item, assessments (newest first), links, task progress
//! POST   /                create (kind picks the fields)
//! PATCH  /:id             edit
//! DELETE /:id             soft delete, with the item's links
//! POST   /:id/assess      reassess a risk
//! POST   /:id/convert     assumption -> risk, risk -> issue
//! POST   /:id/tasks       create a mitigation (risk) or resolution (issue) task
//! POST   /:id/request-acceptance  ask the sponsor to accept a risk (strategy accept, score 9 or more)
//! ```
//!
//! The checks run in TypeScript's order: permission, then the item (404),
//! then project access (403), then the body (400), then the business rules.
//! A body that fails its schema answers `Invalid request body` with Zod's
//! issues as `details` (`{ path, message }`), a query `Invalid query
//! parameters`.

mod acceptance;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EventName, PROJECT_CONTROL_LINK_CREATED, PROJECT_CONTROL_LINK_DELETED,
    PROJECT_RAID_ITEM_CLOSED, PROJECT_RAID_ITEM_CONVERTED, PROJECT_RAID_ITEM_CREATED,
    PROJECT_RAID_ITEM_DELETED, PROJECT_RAID_ITEM_ESCALATED, PROJECT_RAID_ITEM_UPDATED,
    PROJECT_TASK_CREATED,
};
use weldsuite_db::js_row;
use weldsuite_flow_domain::analytics::task_analytics_payload;
use weldsuite_flow_domain::approvals::cancel_pending_approvals;
use weldsuite_flow_domain::js::{contains_pattern, iso_from_millis, js_date, parse_int, to_fixed};
use weldsuite_flow_domain::numbering::allocate_number;
use weldsuite_flow_domain::raid::{
    RaidFields, RaidKind, closed_at_for, control_link_event_data, conversion_error,
    conversion_input_error, initial_raid_status, present_control_link, present_raid_assessment,
    present_raid_item, raid_code, raid_event_data, raid_fields_error, raid_sequence, row_kind,
    row_score, severity_for_band, source_status_after_conversion,
};
use weldsuite_flow_domain::risk::{
    MatrixCell, RiskBand, build_risk_matrix, moved_into_critical, next_review_at_ms,
    residual_pair_error, risk_band, risk_score,
};
use weldsuite_flow_domain::tasks::create_task;
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::approvals::announce::announce_approvals_cancelled;
use crate::raid_body::{
    Body, ListQuery, matrix_query, parse_body, raid_list_query, read_assess, read_convert,
    read_create, read_task, read_update,
};
use crate::raid_store::{
    Direction, find_raid_item, links_of_raid_item, live_project_exists, present_linked_objects,
    progress_of, task_progress_for,
};
use crate::{
    Caller, FlowState, Refusal, Reply, access_scope, keyset_cursor, outside, page, paged, reply,
};

pub(crate) use acceptance::register as register_subject;

pub(crate) const PROJECT_DENIED: &str = "You are not a member of this project";
pub(crate) const PROJECT_WRITE_DENIED: &str = "You do not have write access to this project";
const ITEM_LABEL: &str = "RAID item";

pub(crate) fn router<S, Q>(state: FlowState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("projects:read")))
        .route("/", post(create).route_layer(need("projects:create")))
        .route("/matrix", get(matrix).route_layer(need("projects:read")))
        .route("/{id}", get(detail).route_layer(need("projects:read")))
        .route("/{id}", patch(update).route_layer(need("projects:update")))
        .route("/{id}", delete(remove).route_layer(need("projects:delete")))
        .route(
            "/{id}/assess",
            post(assess).route_layer(need("projects:update")),
        )
        .route(
            "/{id}/convert",
            post(convert).route_layer(need("projects:update")),
        )
        .route(
            "/{id}/request-acceptance",
            post(acceptance::request_acceptance).route_layer(need("projects:update")),
        )
        // `requirePermission('projects:update'), requirePermission('tasks:create')`:
        // the last layer added runs first.
        .route(
            "/{id}/tasks",
            post(create_mitigation_task)
                .route_layer(need("tasks:create"))
                .route_layer(need("projects:update")),
        )
        .with_state(state)
}

// ── Reading rows and bodies ─────────────────────────────────────────────────

fn text<'a>(body: &'a Body, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

/// A whole number of a row.
fn int(row: &Value, key: &str) -> Option<i64> {
    row.get(key).and_then(Value::as_i64)
}

/// A whole number of a body.
fn num(body: &Body, key: &str) -> Option<i64> {
    body.get(key).and_then(Value::as_i64)
}

// ── Values ──────────────────────────────────────────────────────────────────

/// `toDate(value)`: an ISO timestamp from a body as `new Date(value)`
/// stores it, or null.
pub(crate) fn to_date(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(raw)) if !raw.is_empty() => {
            Value::String(js_date(raw).unwrap_or_else(|| raw.clone()))
        }
        _ => Value::Null,
    }
}

/// `money(value)`: two decimals, as the numeric column stores it.
fn money(value: Option<&Value>) -> Value {
    match value.and_then(Value::as_f64) {
        Some(amount) => Value::String(to_fixed(amount, 2)),
        None => Value::Null,
    }
}

/// `jsonb` as JavaScript writes it: whole numbers without a fraction.
fn js_json(value: Value) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => {
            weldsuite_flow_domain::js::number_value(number.as_f64().unwrap_or(f64::NAN))
        }
        Value::Array(items) => Value::Array(items.into_iter().map(js_json).collect()),
        Value::Object(map) => {
            Value::Object(map.into_iter().map(|(k, v)| (k, js_json(v))).collect())
        }
        other => other,
    }
}

/// `value ?? null`.
pub(crate) fn or_null(body: &Body, key: &str) -> Value {
    body.get(key).cloned().unwrap_or(Value::Null)
}

pub(crate) fn iso_ms(millis: i64) -> String {
    iso_from_millis(millis).unwrap_or_default()
}

/// `camelCase` → `snake_case`, for a column.
fn column(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for c in key.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

pub(crate) fn columns_of(values: &Body) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(key, value)| (column(key), value.clone()))
            .collect(),
    )
}

/// What an insert needs besides the body (`ctx` in TypeScript).
struct NewItem<'a> {
    id: &'a str,
    number: i64,
    user_id: &'a str,
    now_ms: i64,
}

/// `newRaidItemValues(input, ctx)`: the shared columns, the columns of the
/// kind, and nothing else. The status defaults to the kind's first; a
/// risk's review date defaults from its band.
fn new_item_values(kind: RaidKind, input: &Body, ctx: &NewItem<'_>) -> Body {
    let now = iso_ms(ctx.now_ms);
    let status = text(input, "status")
        .unwrap_or_else(|| initial_raid_status(kind))
        .to_owned();
    let closed_at = closed_at_for(kind, &status, None, now.clone());
    let mut values = Body::new();
    values.insert("id".to_owned(), json!(ctx.id));
    values.insert("projectId".to_owned(), or_null(input, "projectId"));
    values.insert("kind".to_owned(), json!(kind.as_str()));
    values.insert("number".to_owned(), json!(ctx.number));
    values.insert("title".to_owned(), or_null(input, "title"));
    values.insert("description".to_owned(), or_null(input, "description"));
    values.insert("status".to_owned(), json!(status));
    values.insert("category".to_owned(), or_null(input, "category"));
    values.insert("ownerId".to_owned(), or_null(input, "ownerId"));
    values.insert("closedAt".to_owned(), json!(closed_at));
    values.insert(
        "customFields".to_owned(),
        js_json(or_null(input, "customFields")),
    );
    values.insert("createdBy".to_owned(), json!(ctx.user_id));
    values.insert("createdAt".to_owned(), json!(now));
    values.insert("updatedAt".to_owned(), json!(now));
    let due_at = to_date(input.get("dueAt"));
    match kind {
        RaidKind::Risk => {
            let due_at = if due_at.is_null() {
                let band = risk_score(
                    num(input, "probability").unwrap_or(0),
                    num(input, "impact").unwrap_or(0),
                )
                .and_then(risk_band)
                .unwrap_or(RiskBand::Low);
                let own = input.get("reviewIntervalDays").and_then(Value::as_i64);
                json!(iso_ms(next_review_at_ms(ctx.now_ms, band, own)))
            } else {
                due_at
            };
            values.insert("dueAt".to_owned(), due_at);
            for key in [
                "probability",
                "impact",
                "residualProbability",
                "residualImpact",
                "strategy",
                "trigger",
                "scheduleImpactDays",
                "reviewIntervalDays",
            ] {
                values.insert(key.to_owned(), or_null(input, key));
            }
            values.insert("costImpact".to_owned(), money(input.get("costImpact")));
        }
        RaidKind::Assumption => {
            values.insert("dueAt".to_owned(), due_at);
            values.insert("confidence".to_owned(), or_null(input, "confidence"));
            values.insert("ifWrong".to_owned(), or_null(input, "ifWrong"));
        }
        RaidKind::Issue => {
            values.insert("dueAt".to_owned(), due_at);
            values.insert(
                "severity".to_owned(),
                input
                    .get("severity")
                    .cloned()
                    .unwrap_or_else(|| json!("medium")),
            );
            values.insert("escalatedAt".to_owned(), to_date(input.get("escalatedAt")));
        }
        RaidKind::Dependency => {
            values.insert("dueAt".to_owned(), due_at);
            for key in ["direction", "partyType", "partyProjectId", "partyName"] {
                values.insert(key.to_owned(), or_null(input, key));
            }
        }
    }
    values
}

/// The columns an insert or update writes (`score` is generated).
macro_rules! raid_columns {
    ($p:literal) => {
        concat!(
            $p,
            "id, ",
            $p,
            "project_id, ",
            $p,
            "kind, ",
            $p,
            "number, ",
            $p,
            "title, ",
            $p,
            "description, ",
            $p,
            "status, ",
            $p,
            "category, ",
            $p,
            "owner_id, ",
            $p,
            "due_at, ",
            $p,
            "closed_at, ",
            $p,
            "custom_fields, ",
            $p,
            "probability, ",
            $p,
            "impact, ",
            $p,
            "residual_probability, ",
            $p,
            "residual_impact, ",
            $p,
            "strategy, ",
            $p,
            "\"trigger\", ",
            $p,
            "cost_impact, ",
            $p,
            "schedule_impact_days, ",
            $p,
            "review_interval_days, ",
            $p,
            "confidence, ",
            $p,
            "if_wrong, ",
            $p,
            "severity, ",
            $p,
            "escalated_at, ",
            $p,
            "direction, ",
            $p,
            "party_type, ",
            $p,
            "party_project_id, ",
            $p,
            "party_name, ",
            $p,
            "created_by, ",
            $p,
            "created_at, ",
            $p,
            "updated_at"
        )
    };
}

/// Insert an item from its values (camelCase keys, as the row reads).
fn insert_item(
    values: &Body,
) -> sqlx::query::Query<'static, sqlx::Postgres, sqlx::postgres::PgArguments> {
    sqlx::query(concat!(
        "insert into project_raid_items (",
        raid_columns!(""),
        ") select ",
        raid_columns!("p."),
        " from jsonb_populate_record(null::project_raid_items, $1) p"
    ))
    .bind(columns_of(values))
}

/// Update the live item with the columns in `set` (camelCase keys); the
/// others keep their values.
fn update_item(
    id: &str,
    set: &Body,
) -> sqlx::query::Query<'static, sqlx::Postgres, sqlx::postgres::PgArguments> {
    sqlx::query(concat!(
        "update project_raid_items r set (",
        raid_columns!(""),
        ") = (select ",
        raid_columns!("p."),
        " from jsonb_populate_record(r, $1) p) where r.id = $2 and r.deleted_at is null"
    ))
    .bind(columns_of(set))
    .bind(id.to_owned())
}

/// An assessment of a risk.
pub(super) struct Assessment<'a> {
    id: String,
    item_id: &'a str,
    project_id: &'a str,
    probability: i64,
    impact: i64,
    residual_probability: Option<i64>,
    residual_impact: Option<i64>,
    note: Option<String>,
    assessed_by: &'a str,
    assessed_at: String,
}

pub(super) fn insert_assessment(
    row: &Assessment<'_>,
) -> sqlx::query::Query<'static, sqlx::Postgres, sqlx::postgres::PgArguments> {
    sqlx::query(
        "insert into project_raid_assessments (id, item_id, project_id, probability, impact,
             residual_probability, residual_impact, note, assessed_by, assessed_at)
         values ($1, $2, $3, $4::int, $5::int, $6::int, $7::int, $8, $9, $10::timestamptz)",
    )
    .bind(row.id.clone())
    .bind(row.item_id.to_owned())
    .bind(row.project_id.to_owned())
    .bind(row.probability)
    .bind(row.impact)
    .bind(row.residual_probability)
    .bind(row.residual_impact)
    .bind(row.note.clone())
    .bind(row.assessed_by.to_owned())
    .bind(row.assessed_at.clone())
}

/// A new link row (camelCase), as `presentControlLink` reads it.
pub(crate) fn link_values(
    id: &str,
    project_id: &str,
    from: (&str, &str),
    to: (&str, &str),
    relation: &str,
    created_by: &str,
    created_at: &str,
) -> Value {
    json!({
        "id": id,
        "projectId": project_id,
        "fromType": from.0,
        "fromId": from.1,
        "toType": to.0,
        "toId": to.1,
        "relation": relation,
        "createdBy": created_by,
        "createdAt": created_at,
    })
}

pub(crate) fn insert_link(
    link: &Value,
) -> sqlx::query::Query<'static, sqlx::Postgres, sqlx::postgres::PgArguments> {
    let field = |key: &str| link[key].as_str().unwrap_or_default().to_owned();
    sqlx::query(
        "insert into project_control_links (id, project_id, from_type, from_id, to_type, to_id,
             relation, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)",
    )
    .bind(field("id"))
    .bind(field("projectId"))
    .bind(field("fromType"))
    .bind(field("fromId"))
    .bind(field("toType"))
    .bind(field("toId"))
    .bind(field("relation"))
    .bind(field("createdBy"))
    .bind(field("createdAt"))
}

// ── Events ──────────────────────────────────────────────────────────────────

pub(super) fn publish_raid(
    state: &FlowState,
    caller: &Caller,
    event: EventName,
    row: &Value,
    extra: Value,
) {
    let mut data = raid_event_data(row);
    if let (Value::Object(data), Value::Object(extra)) = (&mut data, extra) {
        data.extend(extra);
    }
    let id = row["id"].as_str().unwrap_or_default();
    caller.publish(state, event, id, &data);
}

pub(crate) fn publish_link(state: &FlowState, caller: &Caller, event: EventName, row: &Value) {
    let id = row["id"].as_str().unwrap_or_default();
    caller.publish(state, event, id, &control_link_event_data(row));
}

/// `partyProjectError(c, partyProjectId)`: a project another project's
/// dependency points at must exist and be one the caller is in.
async fn party_project_error(
    caller: &Caller,
    party_project_id: Option<&str>,
) -> Result<(), Refusal> {
    let Some(party) = party_project_id.filter(|p| !p.is_empty()) else {
        return Ok(());
    };
    if !live_project_exists(&caller.db, party).await? {
        return Err(Refusal::bad_request("Party project not found"));
    }
    if !caller.can_access(party).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    Ok(())
}

/// `presentOne(c, row)`: the item with its task progress.
pub(super) async fn present_one(caller: &Caller, row: &Value) -> Result<Value, sqlx::Error> {
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    let progress = task_progress_for(&caller.db, std::slice::from_ref(&id)).await?;
    let (done, total) = progress_of(&progress, &id);
    Ok(present_raid_item(row, done, total))
}

/// The live item and its kind, or the 404.
async fn item_or_404(caller: &Caller, id: &str) -> Result<(Value, RaidKind), Refusal> {
    let Some(row) = find_raid_item(&caller.db, id).await? else {
        return Err(Refusal::not_found(ITEM_LABEL, id));
    };
    let kind = row_kind(&row).ok_or_else(|| Refusal::Internal("unknown RAID kind".to_owned()))?;
    Ok((row, kind))
}

/// The item, writable by the caller: the 404 and 403 checks every write
/// runs before its body.
pub(super) async fn writable_item(caller: &Caller, id: &str) -> Result<(Value, RaidKind), Refusal> {
    let (row, kind) = item_or_404(caller, id).await?;
    let project = row["projectId"].as_str().unwrap_or_default();
    if !caller.can_write(project).await? {
        return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
    }
    Ok((row, kind))
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// `parseLimit(raw, fallback, max)`: a missing, non-numeric or non-positive
/// value is the fallback.
pub(crate) fn parse_limit(raw: Option<&str>, fallback: i64, max: i64) -> i64 {
    match raw.and_then(parse_int) {
        Some(parsed) if parsed >= 1 => parsed.min(max),
        _ => fallback,
    }
}

/// The list's `where`, without the cursor: the project scope (`$1` the
/// project, else `$2`/`$3` the accessible ones), then the filters.
macro_rules! raid_filters {
    () => {
        concat!(
            "t.deleted_at is null",
            " and ($1::text is null or t.project_id = $1)",
            " and ($1::text is not null or ",
            in_accessible!("t.project_id", "$2", "$3"),
            ")",
            " and ($4::text is null or t.kind = $4)",
            " and ($5::text is null or t.status = $5)",
            " and ($6::text is null or t.owner_id = $6)",
            " and ($7::int is null or (t.score is not null and t.score >= $7 and t.score <= $8))",
            " and ($9::bool is not true or t.closed_at is null)",
            " and ($10::text is null or t.title ilike $10 or t.description ilike $10)"
        )
    };
}

/// `projectScope(c, projectId)`: the one project when the caller is in it,
/// else every accessible project (`(all, ids)` for [`in_accessible!`]).
async fn project_scope(
    caller: &Caller,
    project_id: Option<&str>,
) -> Result<(bool, Vec<String>), Refusal> {
    if let Some(project_id) = project_id {
        if !caller.can_access(project_id).await? {
            return Err(Refusal::forbidden(PROJECT_DENIED));
        }
        return Ok((true, Vec::new()));
    }
    Ok(access_scope(caller).await?)
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = match raid_list_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let limit = parse_limit(q.limit.as_deref(), 25, 100);
    let scope = project_scope(&caller, q.project_id.as_deref()).await;
    let (all, ids) = match scope {
        Ok(scope) => scope,
        Err(refused) => return outside(Err(refused)),
    };
    let cursor = match &q.cursor {
        Some(cursor) => match keyset_cursor(
            &caller.db,
            "select id, to_jsonb(created_at) #>> '{}' from project_raid_items where id = $1 limit 1",
            cursor,
        )
        .await
        {
            Ok(found) => found,
            Err(error) => return outside(Err(error.into())),
        },
        None => None,
    };
    reply(
        list_items(&caller, &q, limit, (all, &ids), cursor).await,
        "Failed to list RAID items",
    )
}

async fn list_items(
    caller: &Caller,
    q: &ListQuery,
    limit: i64,
    (all, ids): (bool, &[String]),
    cursor: Option<(String, String)>,
) -> Reply {
    let db = &caller.db;
    let range = q
        .band
        .as_deref()
        .and_then(RiskBand::parse)
        .map(RiskBand::range);
    let min = range.map(|(min, _)| i32::try_from(min).unwrap_or(i32::MAX));
    let max = range.map(|(_, max)| i32::try_from(max).unwrap_or(i32::MAX));
    let search = q.search.as_deref().map(contains_pattern);
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        raid_json!("t"),
        " from project_raid_items t where ",
        raid_filters!(),
        " and ($11::timestamptz is null or t.created_at < $11::timestamptz",
        " or (t.created_at = $11::timestamptz and t.id < $12))",
        " order by t.created_at desc, t.id desc limit $13"
    ))
    .bind(q.project_id.as_deref())
    .bind(all)
    .bind(ids)
    .bind(q.kind.as_deref())
    .bind(q.status.as_deref())
    .bind(q.owner_id.as_deref())
    .bind(min)
    .bind(max)
    .bind(q.open)
    .bind(search.as_deref())
    .bind(cursor.as_ref().map(|c| c.0.as_str()))
    .bind(cursor.as_ref().map(|c| c.1.as_str()))
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*) from project_raid_items t where ",
        raid_filters!()
    ))
    .bind(q.project_id.as_deref())
    .bind(all)
    .bind(ids)
    .bind(q.kind.as_deref())
    .bind(q.status.as_deref())
    .bind(q.owner_id.as_deref())
    .bind(min)
    .bind(max)
    .bind(q.open)
    .bind(search.as_deref())
    .fetch_one(db)
    .await?;
    let (rows, has_more, next) = page(rows.into_iter().map(js_row).collect(), limit);
    let page_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    let progress = task_progress_for(db, &page_ids).await?;
    let items = rows
        .iter()
        .map(|row| {
            let (done, total) = progress_of(&progress, row["id"].as_str().unwrap_or_default());
            present_raid_item(row, done, total)
        })
        .collect();
    Ok(paged(items, total, has_more, next))
}

// ── GET /matrix ─────────────────────────────────────────────────────────────

async fn matrix(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let (project_id, residual) = match matrix_query(raw.as_deref()) {
        Ok(q) => q,
        Err(refused) => return outside(Err(refused)),
    };
    let (all, ids) = match project_scope(&caller, project_id.as_deref()).await {
        Ok(scope) => scope,
        Err(refused) => return outside(Err(refused)),
    };
    let result = async {
        // After mitigation, a risk with no residual assessment stays in its current cell.
        let counts: Vec<(i32, i32, i64)> = sqlx::query_as(concat!(
            "select (case when $4::bool then coalesce(t.residual_probability, t.probability)",
            " else t.probability end)::int,",
            " (case when $4::bool then coalesce(t.residual_impact, t.impact)",
            " else t.impact end)::int,",
            " count(*)::int8",
            " from project_raid_items t where t.deleted_at is null",
            " and ($1::text is null or t.project_id = $1)",
            " and ($1::text is not null or ",
            in_accessible!("t.project_id", "$2", "$3"),
            ") and t.kind = 'risk' and t.closed_at is null group by 1, 2"
        ))
        .bind(project_id.as_deref())
        .bind(all)
        .bind(&ids)
        .bind(residual)
        .fetch_all(&caller.db)
        .await?;
        let counts: Vec<MatrixCell> = counts
            .into_iter()
            .map(|(probability, impact, count)| MatrixCell {
                probability: i64::from(probability),
                impact: i64::from(impact),
                count,
            })
            .collect();
        let total: i64 = counts.iter().map(|cell| cell.count).sum();
        let cells: Vec<Value> = build_risk_matrix(&counts)
            .into_iter()
            .map(|cell| {
                json!({ "probability": cell.probability, "impact": cell.impact, "count": cell.count })
            })
            .collect();
        Ok(Data(json!({ "residual": residual, "total": total, "cells": cells })).into_response())
    }
    .await;
    reply(result, "Failed to load the risk matrix")
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        fetch_detail(&caller, &id).await,
        "Failed to fetch RAID item",
    )
}

async fn fetch_detail(caller: &Caller, id: &str) -> Reply {
    let (row, _) = item_or_404(caller, id).await?;
    let project = row["projectId"].as_str().unwrap_or_default();
    if !caller.can_access(project).await? {
        return Err(Refusal::forbidden(PROJECT_DENIED));
    }
    let assessments: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from project_raid_assessments a where a.item_id = $1
         order by a.assessed_at desc, a.id desc",
    )
    .bind(id)
    .fetch_all(&caller.db)
    .await?;
    let link_rows = links_of_raid_item(&caller.db, id).await?;
    let progress = task_progress_for(&caller.db, &[id.to_owned()]).await?;
    let links = present_linked_objects(caller, link_rows, |link| {
        if link["fromType"] == "raid_item" && link["fromId"] == id {
            Direction::Outgoing
        } else {
            Direction::Incoming
        }
    })
    .await?;
    let (done, total) = progress_of(&progress, id);
    let mut item = present_raid_item(&row, done, total);
    if let Value::Object(fields) = &mut item {
        fields.insert(
            "assessments".to_owned(),
            Value::Array(
                assessments
                    .into_iter()
                    .map(|row| present_raid_assessment(&js_row(row)))
                    .collect(),
            ),
        );
        fields.insert("links".to_owned(), Value::Array(links));
    }
    Ok(Data(item).into_response())
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(State(state): State<FlowState>, caller: Caller, body: Bytes) -> Response {
    let checked = async {
        let (kind, input) = parse_body(&body, read_create)?;
        let project_id = text(&input, "projectId").unwrap_or_default().to_owned();
        if !caller.can_write(&project_id).await? {
            return Err(Refusal::forbidden(PROJECT_WRITE_DENIED));
        }
        if !live_project_exists(&caller.db, &project_id).await? {
            return Err(Refusal::not_found("Project", &project_id));
        }
        let fields = if kind == RaidKind::Risk || kind == RaidKind::Dependency {
            RaidFields {
                residual_probability: input.get("residualProbability").and_then(Value::as_i64),
                residual_impact: input.get("residualImpact").and_then(Value::as_i64),
                party_type: text(&input, "partyType"),
                party_project_id: text(&input, "partyProjectId"),
            }
        } else {
            RaidFields::default()
        };
        if let Some(message) = raid_fields_error(kind, &project_id, &fields) {
            return Err(Refusal::bad_request(message));
        }
        if kind == RaidKind::Dependency {
            party_project_error(&caller, text(&input, "partyProjectId")).await?;
        }
        Ok((kind, project_id, input))
    }
    .await;
    let (kind, project_id, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        create_item(&state, &caller, kind, &project_id, &input).await,
        "Failed to create RAID item",
    )
}

async fn create_item(
    state: &FlowState,
    caller: &Caller,
    kind: RaidKind,
    project_id: &str,
    input: &Body,
) -> Reply {
    let db = &caller.db;
    let now_ms = crate::now_ms();
    let id = generate_id("raid");
    let number = allocate_number(db, &raid_sequence(kind, project_id)).await?;
    let values = new_item_values(
        kind,
        input,
        &NewItem {
            id: &id,
            number,
            user_id: &caller.user_id,
            now_ms,
        },
    );
    let mut statements = vec![insert_item(&values)];
    // A risk's first assessment is its creation: the start of the trend.
    if kind == RaidKind::Risk {
        statements.push(insert_assessment(&Assessment {
            id: generate_id("rasm"),
            item_id: &id,
            project_id,
            probability: num(input, "probability").unwrap_or(0),
            impact: num(input, "impact").unwrap_or(0),
            residual_probability: num(input, "residualProbability"),
            residual_impact: num(input, "residualImpact"),
            note: None,
            assessed_by: &caller.user_id,
            assessed_at: iso_ms(now_ms),
        }));
    }
    weldsuite_db::atomically(db, statements).await?;
    let Some(row) = find_raid_item(db, &id).await? else {
        return Err(Refusal::Internal("the new item is missing".to_owned()));
    };
    publish_raid(state, caller, PROJECT_RAID_ITEM_CREATED, &row, json!({}));
    if !row["closedAt"].is_null() {
        publish_raid(state, caller, PROJECT_RAID_ITEM_CLOSED, &row, json!({}));
    }
    Ok(Created(present_raid_item(&row, 0, 0)).into_response())
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

/// `COMMON_UPDATE_FIELDS` and `KIND_UPDATE_FIELDS[kind]`: copied as they are.
fn copied_fields(kind: RaidKind) -> Vec<&'static str> {
    let mut fields = vec![
        "title",
        "description",
        "category",
        "ownerId",
        "customFields",
    ];
    fields.extend_from_slice(match kind {
        RaidKind::Risk => &[
            "probability",
            "impact",
            "residualProbability",
            "residualImpact",
            "strategy",
            "trigger",
            "scheduleImpactDays",
            "reviewIntervalDays",
        ],
        RaidKind::Assumption => &["confidence", "ifWrong"],
        RaidKind::Issue => &["severity"],
        RaidKind::Dependency => &["direction", "partyType", "partyProjectId", "partyName"],
    });
    fields
}

/// `updateValues(existing, data, now)`: the columns an edit writes.
fn update_values(existing: &Value, kind: RaidKind, data: &Body, now: &str) -> Body {
    let mut set = Body::new();
    set.insert("updatedAt".to_owned(), json!(now));
    for key in copied_fields(kind) {
        if let Some(value) = data.get(key) {
            let value = if key == "customFields" {
                js_json(value.clone())
            } else {
                value.clone()
            };
            set.insert(key.to_owned(), value);
        }
    }
    if data.contains_key("dueAt") {
        set.insert("dueAt".to_owned(), to_date(data.get("dueAt")));
    }
    if let Some(status) = text(data, "status") {
        let current = existing["closedAt"].as_str().map(str::to_owned);
        set.insert("status".to_owned(), json!(status));
        set.insert(
            "closedAt".to_owned(),
            json!(closed_at_for(kind, status, current, now.to_owned())),
        );
    }
    if kind == RaidKind::Risk && data.contains_key("costImpact") {
        set.insert("costImpact".to_owned(), money(data.get("costImpact")));
    }
    if kind == RaidKind::Issue && data.contains_key("escalatedAt") {
        set.insert("escalatedAt".to_owned(), to_date(data.get("escalatedAt")));
    }
    set
}

async fn update(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let (existing, kind) = writable_item(&caller, &id).await?;
        let data = parse_body(&body, |issues, value| read_update(issues, value, kind))?;
        Ok((existing, kind, data))
    }
    .await;
    let (existing, kind, data) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        update_raid(&state, &caller, &id, &existing, kind, &data).await,
        "Failed to update RAID item",
    )
}

async fn update_raid(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    existing: &Value,
    kind: RaidKind,
    data: &Body,
) -> Reply {
    let db = &caller.db;
    let now = iso_ms(crate::now_ms());
    let set = update_values(existing, kind, data, &now);
    let mut next = existing.clone();
    if let Value::Object(fields) = &mut next {
        fields.extend(set.clone());
    }
    let project_id = existing["projectId"].as_str().unwrap_or_default();
    let fields = RaidFields {
        residual_probability: int(&next, "residualProbability"),
        residual_impact: int(&next, "residualImpact"),
        party_type: next["partyType"].as_str(),
        party_project_id: next["partyProjectId"].as_str(),
    };
    if let Some(message) = raid_fields_error(kind, project_id, &fields) {
        return Err(Refusal::bad_request(message));
    }
    if kind == RaidKind::Dependency && next["partyProjectId"] != existing["partyProjectId"] {
        party_project_error(caller, next["partyProjectId"].as_str()).await?;
    }

    // Changing probability or impact is a reassessment: it enters the trend.
    let previous_score = row_score(existing);
    let next_score = row_score(&next);
    let rated = previous_score.is_some()
        && next_score.is_some()
        && (next["probability"] != existing["probability"] || next["impact"] != existing["impact"]);
    let mut statements = vec![update_item(id, &set)];
    if rated
        && let (Some(probability), Some(impact)) = (int(&next, "probability"), int(&next, "impact"))
    {
        statements.push(insert_assessment(&Assessment {
            id: generate_id("rasm"),
            item_id: id,
            project_id,
            probability,
            impact,
            residual_probability: int(&next, "residualProbability"),
            residual_impact: int(&next, "residualImpact"),
            note: None,
            assessed_by: &caller.user_id,
            assessed_at: now.clone(),
        }));
    }
    weldsuite_db::atomically(db, statements).await?;
    let Some(row) = find_raid_item(db, id).await? else {
        return Err(Refusal::not_found(ITEM_LABEL, id));
    };

    publish_raid(state, caller, PROJECT_RAID_ITEM_UPDATED, &row, json!({}));
    if rated
        && let (Some(previous), Some(score)) = (previous_score, next_score)
        && moved_into_critical(previous, score)
    {
        publish_raid(
            state,
            caller,
            PROJECT_RAID_ITEM_ESCALATED,
            &row,
            escalation(previous),
        );
    }
    if existing["closedAt"].is_null() && !row["closedAt"].is_null() {
        publish_raid(state, caller, PROJECT_RAID_ITEM_CLOSED, &row, json!({}));
    }
    Ok(Data(present_one(caller, &row).await?).into_response())
}

/// `{ previousScore, previousBand }` of an `escalated` event.
fn escalation(previous_score: i64) -> Value {
    json!({
        "previousScore": previous_score,
        "previousBand": risk_band(previous_score).map(RiskBand::as_str),
    })
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    reply(
        remove_item(&state, &caller, &id).await,
        "Failed to delete RAID item",
    )
}

/// `announceApprovalsCancelled(c, await cancelPendingApprovals(db, { subjectType: 'risk_acceptance', subjectId: id, includeDecided: true }))`.
async fn close_acceptance_request(
    state: &FlowState,
    caller: &Caller,
    id: &str,
) -> Result<(), sqlx::Error> {
    let cleared =
        cancel_pending_approvals(&caller.db, "risk_acceptance", id, true, crate::now_ms()).await?;
    announce_approvals_cancelled(state, caller, &cleared);
    Ok(())
}

async fn remove_item(state: &FlowState, caller: &Caller, id: &str) -> Reply {
    let (existing, kind) = writable_item(caller, id).await?;
    // The item's links go with it, in the same batch.
    let links = links_of_raid_item(&caller.db, id).await?;
    let now = iso_ms(crate::now_ms());
    weldsuite_db::atomically(
        &caller.db,
        [
            sqlx::query(
                "update project_raid_items set deleted_at = $2::timestamptz, updated_at = $2::timestamptz
                 where id = $1 and deleted_at is null",
            )
            .bind(id.to_owned())
            .bind(now),
            sqlx::query(
                "delete from project_control_links
                 where (from_type = 'raid_item' and from_id = $1)
                    or (to_type = 'raid_item' and to_id = $1)",
            )
            .bind(id.to_owned()),
        ],
    )
    .await?;
    // A risk that is gone has nothing left to accept: close the open acceptance request.
    if kind == RaidKind::Risk {
        close_acceptance_request(state, caller, id).await?;
    }
    let number = existing["number"].as_i64().unwrap_or_default();
    caller.publish(
        state,
        PROJECT_RAID_ITEM_DELETED,
        id,
        &json!({
            "id": id,
            "projectId": existing["projectId"],
            "kind": kind.as_str(),
            "code": raid_code(kind, number),
        }),
    );
    for link in &links {
        publish_link(state, caller, PROJECT_CONTROL_LINK_DELETED, link);
    }
    Ok(NoContent.into_response())
}

// ── POST /:id/assess ────────────────────────────────────────────────────────

async fn assess(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let (existing, kind) = writable_item(&caller, &id).await?;
        let input = parse_body(&body, read_assess)?;
        if kind != RaidKind::Risk {
            return Err(Refusal::bad_request("Only risks can be assessed"));
        }
        // Residual values left out stay as they are; null clears them.
        let residual = |key: &str| match input.get(key) {
            Some(value) => value.as_i64(),
            None => existing[key].as_i64(),
        };
        let residual_probability = residual("residualProbability");
        let residual_impact = residual("residualImpact");
        if let Some(message) = residual_pair_error(residual_probability, residual_impact) {
            return Err(Refusal::bad_request(message));
        }
        Ok((existing, input, residual_probability, residual_impact))
    }
    .await;
    let (existing, input, residual_probability, residual_impact) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        assess_risk(
            &state,
            &caller,
            &id,
            &existing,
            &input,
            (residual_probability, residual_impact),
        )
        .await,
        "Failed to assess risk",
    )
}

async fn assess_risk(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    existing: &Value,
    input: &Body,
    (residual_probability, residual_impact): (Option<i64>, Option<i64>),
) -> Reply {
    let db = &caller.db;
    let now_ms = crate::now_ms();
    let now = iso_ms(now_ms);
    let probability = num(input, "probability").unwrap_or(0);
    let impact = num(input, "impact").unwrap_or(0);
    let previous_score = row_score(existing);
    let score = risk_score(probability, impact)
        .ok_or_else(|| Refusal::Internal("a rating off the scale".to_owned()))?;
    // The next review: the one given, else now plus the interval of the new band.
    let due_at = match to_date(input.get("nextReviewAt")) {
        Value::Null => {
            let band = risk_band(score).unwrap_or(RiskBand::Low);
            json!(iso_ms(next_review_at_ms(
                now_ms,
                band,
                existing["reviewIntervalDays"].as_i64()
            )))
        }
        given => given,
    };
    let assessment_id = generate_id("rasm");
    let mut set = Body::new();
    set.insert("probability".to_owned(), json!(probability));
    set.insert("impact".to_owned(), json!(impact));
    set.insert(
        "residualProbability".to_owned(),
        json!(residual_probability),
    );
    set.insert("residualImpact".to_owned(), json!(residual_impact));
    set.insert("dueAt".to_owned(), due_at);
    set.insert("updatedAt".to_owned(), json!(now));
    let project_id = existing["projectId"].as_str().unwrap_or_default();
    weldsuite_db::atomically(
        db,
        [
            update_item(id, &set),
            insert_assessment(&Assessment {
                id: assessment_id.clone(),
                item_id: id,
                project_id,
                probability,
                impact,
                residual_probability,
                residual_impact,
                note: text(input, "note").map(str::to_owned),
                assessed_by: &caller.user_id,
                assessed_at: now,
            }),
        ],
    )
    .await?;
    let row = find_raid_item(db, id).await?;
    let assessment: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(a) from project_raid_assessments a where a.id = $1 limit 1",
    )
    .bind(&assessment_id)
    .fetch_optional(db)
    .await?;
    let (Some(row), Some(assessment)) = (row, assessment.map(js_row)) else {
        return Err(Refusal::Internal("the assessment is missing".to_owned()));
    };

    publish_raid(state, caller, PROJECT_RAID_ITEM_UPDATED, &row, json!({}));
    if let Some(previous) = previous_score
        && moved_into_critical(previous, score)
    {
        publish_raid(
            state,
            caller,
            PROJECT_RAID_ITEM_ESCALATED,
            &row,
            escalation(previous),
        );
    }
    Ok(Data(json!({
        "item": present_one(caller, &row).await?,
        "assessment": present_raid_assessment(&assessment),
    }))
    .into_response())
}

// ── POST /:id/convert ───────────────────────────────────────────────────────

async fn convert(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let (source, kind) = writable_item(&caller, &id).await?;
        let input = parse_body(&body, read_convert)?;
        let to = text(&input, "to")
            .and_then(RaidKind::parse)
            .ok_or_else(|| Refusal::Internal("no conversion target".to_owned()))?;
        if let Some(message) = conversion_error(kind, to) {
            return Err(Refusal::bad_request(message));
        }
        if !source["closedAt"].is_null() {
            return Err(Refusal::conflict("This item is already closed"));
        }
        if let Some(message) = conversion_input_error(
            to,
            num(&input, "probability"),
            num(&input, "impact"),
            text(&input, "severity"),
        ) {
            return Err(Refusal::bad_request(message));
        }
        Ok((source, kind, to, input))
    }
    .await;
    let (source, kind, to, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    reply(
        convert_item(&state, &caller, &id, &source, kind, to, &input).await,
        "Failed to convert RAID item",
    )
}

/// `convertedItemValues(source, input, ctx)`: the new item starts from the
/// source's title, description, category and owner unless the body
/// overrides them, and has no custom fields.
fn converted_values(source: &Value, to: RaidKind, input: &Body, ctx: &NewItem<'_>) -> Body {
    let now = iso_ms(ctx.now_ms);
    let from_source = |key: &str| match input.get(key) {
        Some(value) => value.clone(),
        None => source[key].clone(),
    };
    let mut values = Body::new();
    values.insert("id".to_owned(), json!(ctx.id));
    values.insert("projectId".to_owned(), source["projectId"].clone());
    values.insert("number".to_owned(), json!(ctx.number));
    values.insert(
        "title".to_owned(),
        input
            .get("title")
            .cloned()
            .unwrap_or_else(|| source["title"].clone()),
    );
    values.insert("description".to_owned(), from_source("description"));
    values.insert("category".to_owned(), from_source("category"));
    values.insert("ownerId".to_owned(), from_source("ownerId"));
    values.insert("customFields".to_owned(), Value::Null);
    values.insert("closedAt".to_owned(), Value::Null);
    values.insert("createdBy".to_owned(), json!(ctx.user_id));
    values.insert("createdAt".to_owned(), json!(now));
    values.insert("updatedAt".to_owned(), json!(now));
    let due_at = to_date(input.get("dueAt"));
    let ratings = (num(input, "probability"), num(input, "impact"));
    if let (RaidKind::Risk, (Some(probability), Some(impact))) = (to, ratings) {
        let band = risk_score(probability, impact)
            .and_then(risk_band)
            .unwrap_or(RiskBand::Low);
        values.insert("kind".to_owned(), json!("risk"));
        values.insert(
            "status".to_owned(),
            json!(initial_raid_status(RaidKind::Risk)),
        );
        values.insert("probability".to_owned(), json!(probability));
        values.insert("impact".to_owned(), json!(impact));
        let due_at = if due_at.is_null() {
            json!(iso_ms(next_review_at_ms(ctx.now_ms, band, None)))
        } else {
            due_at
        };
        values.insert("dueAt".to_owned(), due_at);
        return values;
    }
    let source_band = match (int(source, "probability"), int(source, "impact")) {
        (Some(p), Some(i)) => risk_score(p, i).and_then(risk_band),
        _ => None,
    }
    .unwrap_or(RiskBand::Medium);
    values.insert("kind".to_owned(), json!("issue"));
    values.insert(
        "status".to_owned(),
        json!(initial_raid_status(RaidKind::Issue)),
    );
    values.insert(
        "severity".to_owned(),
        input
            .get("severity")
            .cloned()
            .unwrap_or_else(|| json!(severity_for_band(source_band))),
    );
    values.insert("dueAt".to_owned(), due_at);
    values
}

async fn convert_item(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    source: &Value,
    kind: RaidKind,
    to: RaidKind,
    input: &Body,
) -> Reply {
    let db = &caller.db;
    let project_id = source["projectId"].as_str().unwrap_or_default();
    let now_ms = crate::now_ms();
    let now = iso_ms(now_ms);
    let new_id = generate_id("raid");
    let number = allocate_number(db, &raid_sequence(to, project_id)).await?;
    let created = converted_values(
        source,
        to,
        input,
        &NewItem {
            id: &new_id,
            number,
            user_id: &caller.user_id,
            now_ms,
        },
    );
    let created_value = Value::Object(created.clone());
    let rating = (created_value["kind"] == "risk")
        .then(|| int(&created_value, "probability").zip(int(&created_value, "impact")))
        .flatten();
    let link_id = generate_id("pcl");
    let link = link_values(
        &link_id,
        project_id,
        ("raid_item", &new_id),
        ("raid_item", id),
        "raised_from",
        &caller.user_id,
        &now,
    );
    let source_status = source_status_after_conversion(kind)
        .ok_or_else(|| Refusal::Internal("not convertible".to_owned()))?;
    let mut closing = Body::new();
    closing.insert("status".to_owned(), json!(source_status));
    closing.insert("closedAt".to_owned(), json!(now));
    closing.insert("updatedAt".to_owned(), json!(now));

    let mut statements = vec![insert_item(&created)];
    if let Some((probability, impact)) = rating {
        statements.push(insert_assessment(&Assessment {
            id: generate_id("rasm"),
            item_id: &new_id,
            project_id,
            probability,
            impact,
            residual_probability: None,
            residual_impact: None,
            note: None,
            assessed_by: &caller.user_id,
            assessed_at: now.clone(),
        }));
    }
    statements.push(insert_link(&link));
    statements.push(update_item(id, &closing));
    weldsuite_db::atomically(db, statements).await?;
    // The source is closed now: a risk converted to an issue is no longer accepted or refused as a risk.
    if kind == RaidKind::Risk {
        close_acceptance_request(state, caller, id).await?;
    }

    let new_row = find_raid_item(db, &new_id).await?;
    let source_row = find_raid_item(db, id).await?;
    let link_row = crate::raid_store::link_row(db, &link_id).await?;
    let (Some(new_row), Some(source_row), Some(link_row)) = (new_row, source_row, link_row) else {
        return Err(Refusal::Internal("a converted row is missing".to_owned()));
    };

    publish_raid(
        state,
        caller,
        PROJECT_RAID_ITEM_CREATED,
        &new_row,
        json!({}),
    );
    let new_code = row_kind(&new_row)
        .zip(new_row["number"].as_i64())
        .map(|(kind, number)| raid_code(kind, number));
    publish_raid(
        state,
        caller,
        PROJECT_RAID_ITEM_CONVERTED,
        &source_row,
        json!({ "to": to.as_str(), "newItemId": new_row["id"], "newCode": new_code }),
    );
    publish_raid(
        state,
        caller,
        PROJECT_RAID_ITEM_CLOSED,
        &source_row,
        json!({}),
    );
    publish_link(state, caller, PROJECT_CONTROL_LINK_CREATED, &link_row);
    Ok(Created(json!({
        "item": present_one(caller, &new_row).await?,
        "source": present_one(caller, &source_row).await?,
        "link": present_control_link(&link_row),
    }))
    .into_response())
}

// ── POST /:id/tasks ─────────────────────────────────────────────────────────

async fn create_mitigation_task(
    State(state): State<FlowState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let checked = async {
        let (item, kind) = writable_item(&caller, &id).await?;
        let input = parse_body(&body, read_task)?;
        if !matches!(kind, RaidKind::Risk | RaidKind::Issue) {
            return Err(Refusal::bad_request(
                "Only risks and issues can have mitigation or resolution tasks",
            ));
        }
        Ok((item, kind, input))
    }
    .await;
    let (item, kind, input) = match checked {
        Ok(checked) => checked,
        Err(refused) => return outside(Err(refused)),
    };
    let mut task_id: Option<String> = None;
    let result = mitigation_task(&state, &caller, &id, &item, kind, &input, &mut task_id).await;
    if result.is_err()
        && let Some(task_id) = task_id
    {
        // The task cannot share a batch with its link: take it back out.
        let taken = iso_ms(crate::now_ms());
        if let Err(error) = sqlx::query(
            "update tasks set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&task_id)
        .bind(&taken)
        .execute(&caller.db)
        .await
        {
            tracing::error!(%error, "[flow-api/project-raid] task rollback failed");
        }
    }
    reply(result, "Failed to create task")
}

async fn mitigation_task(
    state: &FlowState,
    caller: &Caller,
    id: &str,
    item: &Value,
    kind: RaidKind,
    input: &Body,
    task_id: &mut Option<String>,
) -> Reply {
    let db = &caller.db;
    let project_id = item["projectId"].as_str().unwrap_or_default().to_owned();
    // The ordinary task path: number, position and stage rules are the task routes'.
    let mut data = Map::new();
    data.insert("title".to_owned(), or_null(input, "title"));
    for key in ["description", "assigneeId", "dueDate", "priority"] {
        if let Some(value) = input.get(key).filter(|value| !value.is_null()) {
            data.insert(key.to_owned(), value.clone());
        }
    }
    let created = create_task(db, &data, Some(&project_id), &caller.user_id)
        .await
        .map_err(|error| Refusal::Internal(error.to_string()))?;
    let row = created.row;
    let new_task_id = row["id"].as_str().unwrap_or_default().to_owned();
    *task_id = Some(new_task_id.clone());

    let now = iso_ms(crate::now_ms());
    let relation = if kind == RaidKind::Risk {
        "mitigates"
    } else {
        "resolves"
    };
    let link = link_values(
        &generate_id("pcl"),
        &project_id,
        ("task", &new_task_id),
        ("raid_item", id),
        relation,
        &caller.user_id,
        &now,
    );
    weldsuite_db::atomically(db, [insert_link(&link)]).await?;

    caller.publish(
        state,
        PROJECT_TASK_CREATED,
        &new_task_id,
        &task_analytics_payload(&row, &json!({ "projectId": project_id }), crate::now_ms()),
    );
    publish_link(state, caller, PROJECT_CONTROL_LINK_CREATED, &link);
    crate::notify::assignment(
        state,
        caller,
        crate::notify::Assignment {
            assignee_ids: created.assignee_ids,
            task_id: new_task_id.clone(),
            task_title: row["title"].as_str().unwrap_or_default().to_owned(),
            project_id: Some(project_id),
        },
    );

    let progress = task_progress_for(db, &[id.to_owned()]).await?;
    let (done, total) = progress_of(&progress, id);
    let due_date = row["dueDate"]
        .as_str()
        .filter(|due| !due.is_empty())
        .and_then(js_date);
    Ok(Created(json!({
        "task": {
            "id": new_task_id,
            "number": row["number"],
            "projectId": row["projectId"],
            "title": row["title"],
            "status": row["status"],
            "priority": row["priority"],
            "assigneeId": row["assigneeId"],
            "dueDate": due_date,
        },
        "link": present_control_link(&link),
        "taskProgress": { "done": done, "total": total },
    }))
    .into_response())
}
