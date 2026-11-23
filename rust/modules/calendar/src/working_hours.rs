//! `/api/working-hours` (`routes/working-hours/index.ts`): per-user working
//! hours on `user_preferences.working_hours`, for oneself and, for team
//! admins, for any member. No entity events: `working_hours` is not in the
//! catalog.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_schema::tenant::{user_preferences as prefs, workspace_members as members};

use crate::js::truthy;
use crate::{CalendarState, Caller, Outcome, Refusal, now, validate};

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
async fn upsert(db: &PgPool, user_id: &str, hours: &Value) -> Result<(), DbErr> {
    let existing: Option<String> = prefs::Entity::find()
        .select_only()
        .column(prefs::Column::Id)
        .filter(prefs::Column::UserId.eq(user_id))
        .filter(prefs::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    // `user_preferences` keeps `timestamptz`: the same instant.
    let now = now().assume_utc();
    if let Some(id) = existing {
        prefs::Entity::update_many()
            .col_expr(prefs::Column::WorkingHours, Expr::value(hours.clone()))
            .col_expr(prefs::Column::UpdatedAt, Expr::value(now))
            .filter(prefs::Column::Id.eq(id))
            .exec(&orm(db))
            .await?;
    } else {
        prefs::Entity::insert(prefs::ActiveModel {
            id: Set(generate_id("upref")),
            user_id: Set(user_id.to_owned()),
            working_hours: Set(Some(hours.clone())),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(&orm(db))
        .await?;
    }
    Ok(())
}

/// `prefs?.workingHours || null`.
async fn hours_of(db: &PgPool, user_id: &str) -> Result<Value, DbErr> {
    let hours: Option<Option<Value>> = prefs::Entity::find()
        .select_only()
        .column(prefs::Column::WorkingHours)
        .filter(prefs::Column::UserId.eq(user_id))
        .filter(prefs::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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

pub(crate) async fn team(State(state): State<CalendarState>, caller: Caller) -> Response {
    if let Err(refused) = org_required(&caller) {
        return refused.respond("Failed to fetch team working hours");
    }
    let rows = team_rows(&caller.db).await;
    match rows {
        Ok(mut rows) => {
            // Avatars are account pictures, not the member row's copy.
            let master = caller.master(&state);
            weldsuite_db::overlay_account_pictures(master.as_ref(), &mut rows, "userId", "picture")
                .await;
            Data(rows).into_response()
        }
        Err(error) => Refusal::from(error).respond("Failed to fetch team working hours"),
    }
}

/// `left join user_preferences p on m.user_id = p.user_id and p.deleted_at is null`.
fn live_preferences() -> RelationDef {
    use sea_orm::ExprTrait as _;
    members::Entity::belongs_to(prefs::Entity)
        .from(members::Column::UserId)
        .to(prefs::Column::UserId)
        .on_condition(|_, right| {
            Expr::col((right, prefs::Column::DeletedAt))
                .is_null()
                .into()
        })
        .into()
}

/// The active members, by name, each with their working hours (a live
/// preferences row's) and no picture yet.
async fn team_rows(db: &PgPool) -> Result<Vec<Value>, DbErr> {
    // id, user id, name, email, working hours.
    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<Value>,
    );
    let rows: Vec<Row> = members::Entity::find()
        .select_only()
        .columns([
            members::Column::Id,
            members::Column::UserId,
            members::Column::Name,
            members::Column::Email,
        ])
        .column(prefs::Column::WorkingHours)
        .join(JoinType::LeftJoin, live_preferences())
        .filter(members::Column::Status.eq("ACTIVE"))
        .filter(members::Column::DeletedAt.is_null())
        .order_by_asc(members::Column::Name)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, user_id, name, email, working_hours)| {
            json!({
                "id": id,
                "name": name,
                "email": email,
                "userId": user_id,
                "picture": null,
                "workingHours": working_hours,
            })
        })
        .collect())
}

/// The member's user id and name: 404 when missing.
async fn member(caller: &Caller, member_id: &str) -> Outcome<(String, Value)> {
    let row: Option<(String, Option<String>)> = members::Entity::find()
        .select_only()
        .columns([members::Column::UserId, members::Column::Name])
        .filter(members::Column::Id.eq(member_id))
        .filter(members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
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
