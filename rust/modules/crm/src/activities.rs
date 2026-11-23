//! `/api/activities` (`routes/activities/index.ts`): calls, emails,
//! meetings, tasks and notes on a contact, customer, lead or opportunity
//! (`crm_activities`). Without `activities:scope:all` a caller sees only
//! the activities assigned to them.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    ACTIVITY_COMPLETED, ACTIVITY_CREATED, ACTIVITY_DELETED, ACTIVITY_UPDATED,
};
use weldsuite_catalogs::permission_keys::ACTIVITIES_SCOPE_ALL;
use weldsuite_core_domain::custom_field_values::{hydrate, hydrate_one, sync_values_for_entity};
use weldsuite_crm_domain::activities::create_activity;
use weldsuite_crm_domain::tables::CRM_ACTIVITIES;
use weldsuite_crm_domain::to_iso;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{orm, orm_error, utc_now};
use weldsuite_kit::{ApiError, Created, Data, NoContent};
use weldsuite_schema::tenant::crm_activities;

use crate::orm_rows::{before, cursor_row, json, probe_limit, set_values};
use crate::schema::{Kind, NULLISH, OPT, REQ, STRINGS, Spec, int, partial, s};
use crate::{
    Answer, Caller, CrmState, Refusal, answer, cut, js_limit, now, page, query_map, validate_specs,
};

const LOG: &str = "activities";

/// `crm_activities`, written from a body as Drizzle wrote it.
const ACTIVITIES: JsonTable = JsonTable::of::<crm_activities::Entity>();

const ACTIVITY_TYPES: &[&str] = &[
    "call",
    "email",
    "meeting",
    "task",
    "note",
    "sms",
    "linkedin",
    "demo",
    "presentation",
];

/// `createActivitySchema`.
pub(crate) const CREATE: [Spec; 40] = [
    Spec::new("type", Kind::Enum(ACTIVITY_TYPES), REQ),
    Spec::new("subject", s(Some(1), Some(255)), REQ),
    Spec::new("description", s(None, None), OPT),
    Spec::new("relatedTo", s(None, Some(20)), OPT),
    Spec::new("relatedToId", s(None, None), NULLISH),
    Spec::new("relatedToName", s(None, Some(255)), OPT),
    Spec::new("customerId", s(None, None), NULLISH),
    Spec::new("contactId", s(None, None), NULLISH),
    Spec::new("personId", s(None, None), NULLISH),
    Spec::new("leadId", s(None, None), NULLISH),
    Spec::new("opportunityId", s(None, None), NULLISH),
    Spec::new("assignedToId", s(None, None), OPT),
    Spec::new("dueDate", s(None, None), OPT),
    Spec::new("startTime", s(None, None), OPT),
    Spec::new("endTime", s(None, None), OPT),
    Spec::new("duration", int(None, None), OPT),
    Spec::new(
        "status",
        Kind::Enum(&[
            "planned",
            "in_progress",
            "completed",
            "cancelled",
            "deferred",
        ]),
        OPT,
    ),
    Spec::new("priority", Kind::Enum(&["high", "medium", "low"]), OPT),
    Spec::new("location", s(None, Some(500)), OPT),
    Spec::new("isVirtual", Kind::Bool, OPT),
    Spec::new("meetingUrl", s(None, Some(1000)), OPT),
    Spec::new("callDirection", Kind::Enum(&["inbound", "outbound"]), OPT),
    Spec::new("callDuration", int(None, None), OPT),
    Spec::new("callRecordingUrl", s(None, Some(1000)), OPT),
    Spec::new("emailMessageId", s(None, Some(255)), NULLISH),
    Spec::new("emailSubject", s(None, Some(500)), OPT),
    Spec::new("emailFrom", s(None, Some(255)), OPT),
    Spec::new("emailTo", STRINGS, OPT),
    Spec::new("emailCc", STRINGS, OPT),
    Spec::new("attendees", STRINGS, OPT),
    Spec::new("meetingAgenda", s(None, None), OPT),
    Spec::new("meetingNotes", s(None, None), OPT),
    Spec::new("outcome", s(None, Some(500)), OPT),
    Spec::new("nextAction", s(None, Some(500)), OPT),
    Spec::new("followUpDate", s(None, None), OPT),
    Spec::new("attachments", STRINGS, OPT),
    Spec::new("calendarEventId", s(None, None), NULLISH),
    Spec::new("isFavorite", Kind::Bool, OPT),
    Spec::new("tags", STRINGS, OPT),
    Spec::new("customFields", Kind::Unknown, OPT),
];

fn create_schema() -> &'static [Spec] {
    &CREATE
}

/// The date fields a PATCH turns into timestamps (`DATE_FIELDS`).
const DATE_FIELDS: [&str; 4] = ["dueDate", "startTime", "endTime", "followUpDate"];

/// The live activity, within the assignee scope.
async fn live(caller: &Caller, id: &str, scope: Option<&str>) -> Result<Option<Value>, DbErr> {
    use crm_activities::Column;
    let mut find =
        crm_activities::Entity::find_by_id(id.to_owned()).filter(Column::DeletedAt.is_null());
    if let Some(scope) = scope {
        find = find.filter(Column::AssignedToId.eq(scope));
    }
    let row = find.one(&orm(&caller.db)).await?;
    row.map(|row| json(serde_json::to_value(row))).transpose()
}

/// The list's filters (its count's conditions), in TypeScript's order.
fn list_filters(scope: Option<&String>, param: &dyn Fn(&str) -> Option<String>) -> Condition {
    use crm_activities::Column;
    let mut filters = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(scope) = scope {
        filters = filters.add(Column::AssignedToId.eq(scope.as_str()));
    }
    for (key, column) in [
        ("type", Column::Type),
        ("status", Column::Status),
        ("assignedToId", Column::AssignedToId),
        ("customerId", Column::CustomerId),
        ("contactId", Column::ContactId),
        ("leadId", Column::LeadId),
        ("opportunityId", Column::OpportunityId),
    ] {
        if let Some(value) = param(key) {
            filters = filters.add(column.eq(value));
        }
    }
    if let Some(person) = param("personId") {
        filters = filters.add(
            Condition::any()
                .add(Column::PersonId.eq(person.as_str()))
                .add(Column::ContactId.eq(person)),
        );
    }
    if let Some(search) = param("search") {
        let term = format!("%{search}%");
        filters = filters.add(
            Condition::any()
                .add(Column::Subject.like(term.as_str()))
                .add(Column::Description.like(term)),
        );
    }
    filters
}

// ── GET / ───────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    answer(
        run_list(&caller, query.as_deref()).await,
        LOG,
        "Failed to list activities",
    )
}

async fn run_list(caller: &Caller, query: Option<&str>) -> Answer {
    use crm_activities::{Column, Entity};
    let q = query_map(query);
    let limit = js_limit(q.get("limit"), 25, 100);
    let scope = caller.scope(ACTIVITIES_SCOPE_ALL);
    let param = |key: &str| q.get(key).filter(|v| !v.is_empty()).cloned();
    // The cursor row, read before the list.
    let mut cursor = None;
    if let Some(id) = param("cursor") {
        cursor = cursor_row::<Entity>(&caller.db, Column::CreatedAt, Column::Id, &id).await?;
    }
    let limit = limit.ok_or_else(|| Refusal::Failed("limit is NaN".to_owned()))?;
    let filters = list_filters(scope.as_ref(), &param);
    let mut rows = Entity::find().filter(filters.clone());
    if let Some(cursor) = &cursor {
        rows = rows.filter(before(Column::CreatedAt, Column::Id, cursor));
    }
    let db = orm(&caller.db);
    let rows = rows
        .order_by_desc(Column::CreatedAt)
        .order_by_desc(Column::Id)
        .limit(probe_limit(limit)?)
        .all(&db)
        .await?;
    let total = Entity::find().filter(filters).count(&db).await?;
    let rows = rows
        .into_iter()
        .map(|row| json(serde_json::to_value(row)))
        .collect::<Result<Vec<_>, DbErr>>()?;
    let (data, has_more, next) = cut(rows, limit);
    let data = hydrate(&caller.db, "activity", data, None)
        .await
        .map_err(orm_error)?;
    Ok(page(
        data,
        i64::try_from(total).unwrap_or(i64::MAX),
        has_more,
        next,
    ))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let scope = caller.scope(ACTIVITIES_SCOPE_ALL);
        let Some(row) = live(&caller, &id, scope.as_deref()).await? else {
            return Ok(ApiError::not_found("Activity", Some(&id)).into_response());
        };
        let row = hydrate_one(&caller.db, "activity", Some(row))
            .await
            .map_err(orm_error)?;
        Ok(Data(row.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, LOG, "Failed to fetch activity")
}

// ── POST / ──────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    State(state): State<CrmState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_specs(&headers, &body, create_schema()) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    let result = async {
        let created = match create_activity(&caller.db, &data, Some(&caller.user_id)).await {
            Ok(created) => created,
            Err(error) if error.message() == "assignedToId required" => {
                return Ok(ApiError::bad_request(error.message()).into_response());
            }
            Err(error) => return Err(error.into()),
        };
        sync_values_for_entity(
            &caller.db,
            "activity",
            &created.id,
            data.get("customFields"),
        )
        .await;
        caller.publish(&state, ACTIVITY_CREATED, &created.id, &created.event_data);
        Ok(Created(json!({ "id": created.id })).into_response())
    }
    .await;
    answer(result, LOG, "Failed to create activity")
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn update(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate_specs(&headers, &body, &partial(create_schema())) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(LOG, "Invalid request body"),
    };
    answer(
        run_update(&state, &caller, &id, &data).await,
        LOG,
        "Failed to update activity",
    )
}

async fn run_update(
    state: &CrmState,
    caller: &Caller,
    id: &str,
    data: &Map<String, Value>,
) -> Answer {
    let scope = caller.scope(ACTIVITIES_SCOPE_ALL);
    let Some(existing) = live(caller, id, scope.as_deref()).await? else {
        return Ok(ApiError::not_found("Activity", Some(id)).into_response());
    };
    let mut update = Map::new();
    update.insert("updatedAt".into(), json!(now()));
    for (key, value) in data {
        let value = match value {
            Value::String(text) if DATE_FIELDS.contains(&key.as_str()) => {
                Value::String(to_iso(text)?)
            }
            other => other.clone(),
        };
        update.insert(key.clone(), value);
    }
    ACTIVITIES
        .update(
            &orm(&caller.db),
            id,
            set_values(&CRM_ACTIVITIES, &update),
            true,
        )
        .await?;
    sync_values_for_entity(&caller.db, "activity", id, data.get("customFields")).await;
    // `(update.x as T | undefined) ?? existing.x`
    let pick = |key: &str, from: &str| -> Value {
        match update.get(key) {
            Some(value) if !value.is_null() => value.clone(),
            _ => existing.get(from).cloned().unwrap_or(Value::Null),
        }
    };
    caller.publish(
        state,
        ACTIVITY_UPDATED,
        id,
        &json!({
            "id": id,
            "type": existing.get("type"),
            "subject": pick("subject", "subject"),
            "status": pick("status", "status"),
            "customerId": pick("customerId", "customerId"),
            "contactId": pick("contactId", "contactId"),
            "assigneeId": pick("assignedToId", "assignedToId"),
        }),
    );
    if update.get("status") == Some(&json!("completed"))
        && existing.get("status") != Some(&json!("completed"))
    {
        caller.publish(
            state,
            ACTIVITY_COMPLETED,
            id,
            &json!({ "id": id, "type": existing.get("type") }),
        );
    }
    Ok(Data(json!({ "id": id })).into_response())
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

pub(crate) async fn remove(
    State(state): State<CrmState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let scope = caller.scope(ACTIVITIES_SCOPE_ALL);
        let Some(existing) = live(&caller, &id, scope.as_deref()).await? else {
            return Ok(ApiError::not_found("Activity", Some(&id)).into_response());
        };
        let at = utc_now();
        crm_activities::Entity::update_many()
            .col_expr(crm_activities::Column::DeletedAt, Expr::value(at))
            .col_expr(crm_activities::Column::UpdatedAt, Expr::value(at))
            .filter(crm_activities::Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(
            &state,
            ACTIVITY_DELETED,
            &id,
            &json!({
                "id": id,
                "type": existing.get("type"),
                "customerId": existing.get("customerId"),
                "contactId": existing.get("contactId"),
            }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, LOG, "Failed to delete activity")
}
