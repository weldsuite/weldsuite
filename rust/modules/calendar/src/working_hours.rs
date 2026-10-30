//! `/api/working-hours` (`routes/working-hours/index.ts`): per-user working
//! hours on `user_preferences.working_hours`, for oneself and, for team
//! admins, for any member. No entity events: `working_hours` is not in the
//! catalog.

use axum::body::Bytes;
use axum::extract::Path;
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Data, generate_id};

use crate::js::truthy;
use crate::{Caller, Outcome, Refusal, now, validate};

const DAYS: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

/// `dayHoursSchema`.
fn day_hours(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    if let Some(open) = issues
        .boolean(fields, "isOpen", Presence::Required)
        .into_option()
    {
        out.insert("isOpen".to_owned(), Value::Bool(open));
    }
    for key in ["openTime", "closeTime"] {
        if let Some(time) = issues
            .text(fields, key, Presence::Optional, None, None)
            .into_option()
        {
            out.insert(key.to_owned(), Value::String(time));
        }
    }
    let breaks = issues.list(
        fields,
        "breaks",
        Presence::Optional,
        None,
        None,
        |issues, item| {
            let fields = issues.object(item)?;
            let start = issues
                .text(fields, "start", Presence::Required, None, None)
                .into_option();
            let end = issues
                .text(fields, "end", Presence::Required, None, None)
                .into_option();
            Some(json!({ "start": start?, "end": end? }))
        },
    );
    if let Some(breaks) = breaks.into_option() {
        out.insert("breaks".to_owned(), Value::Array(breaks));
    }
    Value::Object(out)
}

/// `updateWorkingHoursSchema`: `{ workingHours }`, unknown keys dropped.
fn working_hours_body(issues: &mut Issues, fields: &Map<String, Value>) -> Value {
    issues
        .nested(
            fields,
            "workingHours",
            Presence::Required,
            |issues, days| {
                let mut out = Map::new();
                for day in DAYS {
                    if let Some(hours) = issues
                        .nested(days, day, Presence::Optional, day_hours)
                        .into_option()
                    {
                        out.insert(day.to_owned(), hours);
                    }
                }
                Value::Object(out)
            },
        )
        .into_option()
        .unwrap_or(Value::Null)
}

/// Upsert the working hours on a user's preferences row (`upsertWorkingHours`).
async fn upsert(db: &PgPool, user_id: &str, hours: &Value) -> Result<(), sqlx::Error> {
    let existing: Option<String> = sqlx::query_scalar(
        "select id from user_preferences where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let now = now();
    if let Some(id) = existing {
        sqlx::query(
            "update user_preferences set working_hours = $2::jsonb, updated_at = $3::timestamp where id = $1",
        )
        .bind(&id)
        .bind(hours)
        .bind(&now)
        .execute(db)
        .await?;
    } else {
        sqlx::query(
            "insert into user_preferences (id, user_id, working_hours, created_at, updated_at)
             values ($1, $2, $3::jsonb, $4::timestamp, $4::timestamp)",
        )
        .bind(generate_id("upref"))
        .bind(user_id)
        .bind(hours)
        .bind(&now)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// `prefs?.workingHours || null`.
async fn hours_of(db: &PgPool, user_id: &str) -> Result<Value, sqlx::Error> {
    let hours: Option<Option<Value>> = sqlx::query_scalar(
        "select working_hours from user_preferences where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(hours.flatten().filter(truthy).unwrap_or(Value::Null))
}

// ── GET / and PUT / ─────────────────────────────────────────────────────────

pub(crate) async fn mine(caller: Caller) -> Response {
    match hours_of(&caller.db, &caller.user_id).await {
        Ok(hours) => Data(json!({ "workingHours": hours })).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch working hours"),
    }
}

pub(crate) async fn update_mine(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let hours = match validate(&headers, &body, working_hours_body) {
        Ok(hours) => hours,
        Err(refused) => return refused.respond("Failed to update working hours"),
    };
    match upsert(&caller.db, &caller.user_id, &hours).await {
        Ok(()) => Data(json!({ "workingHours": hours })).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to update working hours"),
    }
}

// ── Team ────────────────────────────────────────────────────────────────────

fn org_required(caller: &Caller) -> Outcome<()> {
    if caller.org_id.as_deref().is_some_and(|org| !org.is_empty()) {
        Ok(())
    } else {
        Err(ApiError::org_required().into())
    }
}

pub(crate) async fn team(caller: Caller) -> Response {
    if let Err(refused) = org_required(&caller) {
        return refused.respond("Failed to fetch team working hours");
    }
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select jsonb_build_object(
             'id', m.id, 'userId', m.user_id, 'name', m.name, 'email', m.email,
             'picture', m.picture, 'workingHours', p.working_hours)
         from workspace_members m
         left join user_preferences p on m.user_id = p.user_id and p.deleted_at is null
         where m.status = 'ACTIVE' and m.deleted_at is null
         order by m.name",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => Refusal::from(error).respond("Failed to fetch team working hours"),
    }
}

/// The member's user id and name: 404 when missing.
async fn member(caller: &Caller, member_id: &str) -> Outcome<(String, Value)> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "select user_id, name from workspace_members where id = $1 and deleted_at is null limit 1",
    )
    .bind(member_id)
    .fetch_optional(&caller.db)
    .await?;
    row.map(|(user_id, name)| (user_id, name.map_or(Value::Null, Value::String)))
        .ok_or_else(|| Refusal::not_found("Member", member_id))
}

pub(crate) async fn member_hours(caller: Caller, Path(member_id): Path<String>) -> Response {
    if let Err(refused) = org_required(&caller) {
        return refused.respond("Failed to fetch member working hours");
    }
    let result = async {
        let (user_id, name) = member(&caller, &member_id).await?;
        let hours = hours_of(&caller.db, &user_id).await?;
        Ok::<_, Refusal>(
            json!({ "memberId": member_id, "memberName": name, "workingHours": hours }),
        )
    }
    .await;
    match result {
        Ok(answer) => Data(answer).into_response(),
        Err(refused) => refused.respond("Failed to fetch member working hours"),
    }
}

pub(crate) async fn update_member(
    caller: Caller,
    Path(member_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let hours = match validate(&headers, &body, working_hours_body) {
        Ok(hours) => hours,
        Err(refused) => return refused.respond("Failed to update member working hours"),
    };
    if let Err(refused) = org_required(&caller) {
        return refused.respond("Failed to update member working hours");
    }
    let result = async {
        let (user_id, _) = member(&caller, &member_id).await?;
        upsert(&caller.db, &user_id, &hours).await?;
        Ok::<_, Refusal>(json!({ "memberId": member_id, "workingHours": hours }))
    }
    .await;
    match result {
        Ok(answer) => Data(answer).into_response(),
        Err(refused) => refused.respond("Failed to update member working hours"),
    }
}
