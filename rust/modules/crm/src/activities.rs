//! `/api/activities` (`routes/activities/index.ts`): calls, emails,
//! meetings, tasks and notes on a contact, customer, lead or opportunity
//! (`crm_activities`). Without `activities:scope:all` a caller sees only
//! the activities assigned to them.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    ACTIVITY_COMPLETED, ACTIVITY_CREATED, ACTIVITY_DELETED, ACTIVITY_UPDATED,
};
use weldsuite_catalogs::permission_keys::ACTIVITIES_SCOPE_ALL;
use weldsuite_core_domain::custom_field_values::{hydrate, hydrate_one, sync_values_for_entity};
use weldsuite_crm_domain::activities::create_activity;
use weldsuite_crm_domain::tables::CRM_ACTIVITIES;
use weldsuite_crm_domain::{drizzle_row, to_iso, update_sql};
use weldsuite_kit::{ApiError, Created, Data, NoContent};

use crate::schema::{Kind, NULLISH, OPT, REQ, STRINGS, Spec, int, partial, s};
use crate::{
    Answer, Caller, CrmState, Refusal, answer, cut, js_limit, now, page, query_map, validate_specs,
};

const LOG: &str = "activities";

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

async fn live(
    caller: &Caller,
    id: &str,
    scope: Option<&str>,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from crm_activities t
         where id = $1 and deleted_at is null and ($2::text is null or assigned_to_id = $2) limit 1",
    )
    .bind(id)
    .bind(scope)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(drizzle_row))
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
    let q = query_map(query);
    let limit = js_limit(q.get("limit"), 25, 100);
    let scope = caller.scope(ACTIVITIES_SCOPE_ALL);
    let param = |key: &str| q.get(key).filter(|v| !v.is_empty()).cloned();
    // The cursor row, read before the list.
    let mut cursor: Option<(String, String)> = None;
    if let Some(id) = param("cursor") {
        cursor = sqlx::query_as(
            "select to_char(date_trunc('milliseconds', created_at), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), id
             from crm_activities where id = $1 limit 1",
        )
        .bind(id)
        .fetch_optional(&caller.db)
        .await
        .map_err(|e| Refusal::Failed(e.to_string()))?;
    }
    let limit = limit.ok_or_else(|| Refusal::Failed("limit is NaN".to_owned()))?;
    let search = param("search").map(|s| format!("%{s}%"));
    let (cursor_at, cursor_id) = cursor.unzip();
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from crm_activities t
         where deleted_at is null
           and ($1::text is null or assigned_to_id = $1)
           and ($2::text is null or type = $2)
           and ($3::text is null or status = $3)
           and ($4::text is null or assigned_to_id = $4)
           and ($5::text is null or customer_id = $5)
           and ($6::text is null or contact_id = $6)
           and ($7::text is null or lead_id = $7)
           and ($8::text is null or opportunity_id = $8)
           and ($9::text is null or person_id = $9 or contact_id = $9)
           and ($10::text is null or subject like $10 or description like $10)
           and ($11::timestamp is null
                or created_at < $11::timestamp or (created_at = $11::timestamp and id < $12))
         order by created_at desc, id desc
         limit $13",
    )
    .bind(&scope)
    .bind(param("type"))
    .bind(param("status"))
    .bind(param("assignedToId"))
    .bind(param("customerId"))
    .bind(param("contactId"))
    .bind(param("leadId"))
    .bind(param("opportunityId"))
    .bind(param("personId"))
    .bind(&search)
    .bind(&cursor_at)
    .bind(&cursor_id)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from crm_activities
         where deleted_at is null
           and ($1::text is null or assigned_to_id = $1)
           and ($2::text is null or type = $2)
           and ($3::text is null or status = $3)
           and ($4::text is null or assigned_to_id = $4)
           and ($5::text is null or customer_id = $5)
           and ($6::text is null or contact_id = $6)
           and ($7::text is null or lead_id = $7)
           and ($8::text is null or opportunity_id = $8)
           and ($9::text is null or person_id = $9 or contact_id = $9)
           and ($10::text is null or subject like $10 or description like $10)",
    )
    .bind(&scope)
    .bind(param("type"))
    .bind(param("status"))
    .bind(param("assignedToId"))
    .bind(param("customerId"))
    .bind(param("contactId"))
    .bind(param("leadId"))
    .bind(param("opportunityId"))
    .bind(param("personId"))
    .bind(&search)
    .fetch_one(&caller.db)
    .await?;
    let (data, has_more, next) = cut(rows.into_iter().map(drizzle_row).collect(), limit);
    let data = hydrate(&caller.db, "activity", data, None).await?;
    Ok(page(data, total, has_more, next))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let scope = caller.scope(ACTIVITIES_SCOPE_ALL);
        let Some(row) = live(&caller, &id, scope.as_deref()).await? else {
            return Ok(ApiError::not_found("Activity", Some(&id)).into_response());
        };
        let row = hydrate_one(&caller.db, "activity", Some(row)).await?;
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
    sqlx::query(update_sql!(
        crm_activities,
        "where t.id = $1 and t.deleted_at is null"
    ))
    .bind(id)
    .bind(CRM_ACTIVITIES.set(&update))
    .execute(&caller.db)
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
        sqlx::query(
            "update crm_activities set deleted_at = $2::timestamp, updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
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
