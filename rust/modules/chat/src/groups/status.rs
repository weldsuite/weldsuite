//! `/api/chat-status` (`routes/chat-status/index.ts`): a member's chosen
//! status (stored here) combined with their live presence (the realtime
//! hub's, never stored) into what everyone sees
//! (`@weldsuite/realtime/presence`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::HeaderMap;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, Set};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Format, Presence, Text, js_date_iso};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::chat_user_status as statuses;

use crate::ChatState;
use crate::access::{Caller, answer, validate};
use crate::util::{now, now_ms};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<ChatState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/", get(list).route_layer(gate.require(["settings:read"])))
        .route(
            "/",
            axum::routing::put(set_status)
                .delete(clear_status)
                .route_layer(gate.require(["channels:read"])),
        )
}

const PRESENCE_TOPIC: &str = "presence";
const CHOICES: [&str; 5] = ["online", "busy", "away", "dnd", "offline"];

/// Milliseconds of an ISO time (`new Date(text).getTime()`).
fn millis_of(iso: &str) -> Option<i64> {
    let parsed =
        time::OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339).ok()?;
    i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok()
}

/// A `timestamp` as Drizzle hands it back (`toISOString()`).
fn iso(at: PrimitiveDateTime) -> String {
    weldsuite_events::iso_timestamp(at.assume_utc())
}

/// `toISOString()` text as `$n::timestamp` reads it.
fn timestamp_of(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    time::OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339)
        .map(utc_timestamp)
        .map_err(|error| DbErr::Custom(format!("invalid timestamp {iso:?}: {error}")))
}

/// `isStatusExpired(expiresAt, now)`.
fn is_expired(expires_at: Option<&str>, now: i64) -> bool {
    expires_at.and_then(millis_of).is_some_and(|at| at <= now)
}

/// `chosenStatusFromStored(stored, expiresAt, now)`.
fn chosen_from_stored(stored: Option<&str>, expires_at: Option<&str>, now: i64) -> &'static str {
    if is_expired(expires_at, now) {
        return "online";
    }
    match stored {
        Some("busy") => "busy",
        Some("dnd") => "dnd",
        Some("away_manual") => "away",
        Some("invisible") => "offline",
        _ => "online",
    }
}

/// `storedStatusFor(chosen)`.
fn stored_for(chosen: &str) -> &'static str {
    match chosen {
        "busy" => "busy",
        "dnd" => "dnd",
        "away" => "away_manual",
        "offline" => "invisible",
        _ => "online",
    }
}

/// `effectivePresence(chosen, live)`.
fn effective(chosen: &str, live: Option<&str>) -> Value {
    match live {
        None => Value::from("offline"),
        Some(_) if matches!(chosen, "offline" | "dnd" | "busy" | "away") => Value::from(chosen),
        Some(live) => Value::from(live),
    }
}

async fn list(State(state): State<ChatState>, caller: Caller) -> Response {
    let result = async {
        let rows = statuses::Entity::find().all(&orm(&caller.db)).await?;
        let live: Vec<(String, String)> = match (caller.org_id.as_deref(), caller.presence(&state)) {
            (Some(org), Some(presence)) if !org.is_empty() => {
                match presence.0.presence(org, &[]).await {
                    Ok(users) => users,
                    Err(error) => {
                        tracing::error!(%error, "[chat-api/chat-status] reading live presence failed");
                        Vec::new()
                    }
                }
            }
            _ => Vec::new(),
        };
        let live_of = |user: &str| {
            live.iter()
                .find(|(id, _)| id == user)
                .map(|(_, presence)| presence.as_str())
        };
        let now = now_ms();
        let mut statuses: Vec<Value> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        for row in rows {
            let user_id = row.user_id;
            let expires_at = row.status_expires_at.map(iso);
            let expired = is_expired(expires_at.as_deref(), now);
            let manual = chosen_from_stored(Some(&row.status), expires_at.as_deref(), now);
            let member_live = live_of(&user_id);
            let entry = json!({
                "userId": user_id,
                "status": effective(manual, member_live),
                "manualStatus": manual,
                "live": member_live,
                "statusText": if expired { None } else { row.status_text },
                "statusEmoji": if expired { None } else { row.status_emoji },
                "statusExpiresAt": if expired { None } else { expires_at },
                "updatedAt": iso(row.updated_at),
            });
            if let Some(at) = seen.iter().position(|s| *s == user_id) {
                statuses[at] = entry;
            } else {
                seen.push(user_id);
                statuses.push(entry);
            }
        }
        for (user_id, member_live) in &live {
            if seen.contains(user_id) {
                continue;
            }
            seen.push(user_id.clone());
            statuses.push(json!({
                "userId": user_id,
                "status": member_live,
                "manualStatus": "online",
                "live": member_live,
                "statusText": null,
                "statusEmoji": null,
                "statusExpiresAt": null,
                "updatedAt": null,
            }));
        }
        Ok(Data(statuses).into_response())
    }
    .await;
    answer(result, "Failed to fetch statuses")
}

struct StatusBody {
    status: String,
    text: Option<String>,
    emoji: Option<String>,
    expires_at: Option<String>,
}

fn read_status(
    issues: &mut weldsuite_kit::validation::Issues,
    body: &Map<String, Value>,
) -> StatusBody {
    let status = issues.one_of(body, "status", &CHOICES).unwrap_or_default();
    let text = issues.string(body, "statusText", false, None, Some(255));
    let emoji = issues.string(body, "statusEmoji", false, None, Some(50));
    let expires_at = issues
        .text_with(
            body,
            "expiresAt",
            Presence::Optional,
            Text {
                format: Some(Format::Datetime),
                ..Text::default()
            },
        )
        .into_option();
    StatusBody {
        status,
        text,
        emoji,
        expires_at,
    }
}

async fn set_status(
    State(state): State<ChatState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_status) {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let result = async {
        let stamp = utc_now();
        let at = iso(stamp);
        let expires_at = input.expires_at.as_deref().and_then(js_date_iso);
        statuses::Entity::insert(statuses::ActiveModel {
            id: Set(generate_id("cus")),
            user_id: Set(caller.user_id.clone()),
            status: Set(stored_for(&input.status).to_owned()),
            status_text: Set(input.text.clone()),
            status_emoji: Set(input.emoji.clone()),
            status_expires_at: Set(expires_at.as_deref().map(timestamp_of).transpose()?),
            updated_at: Set(stamp),
        })
        .on_conflict(
            OnConflict::column(statuses::Column::UserId)
                .update_columns([
                    statuses::Column::Status,
                    statuses::Column::StatusText,
                    statuses::Column::StatusEmoji,
                    statuses::Column::StatusExpiresAt,
                    statuses::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec_without_returning(&orm(&caller.db))
        .await?;
        let change = json!({
            "userId": caller.user_id,
            "status": input.status,
            "statusText": input.text,
            "statusEmoji": input.emoji,
            "expiresAt": expires_at,
            "updatedAt": at,
        });
        Caller::realtime(&state)
            .workspace(
                &org,
                PRESENCE_TOPIC,
                "status_changed",
                change.clone(),
                &caller.user_id,
            )
            .await;
        let mut answer_body = change;
        answer_body["manualStatus"] = Value::from(input.status);
        Ok(Data(answer_body).into_response())
    }
    .await;
    answer(result, "Failed to set status")
}

async fn clear_status(State(state): State<ChatState>, caller: Caller) -> Response {
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.respond(""),
    };
    let result = async {
        statuses::Entity::delete_many()
            .filter(statuses::Column::UserId.eq(&caller.user_id))
            .exec(&orm(&caller.db))
            .await?;
        Caller::realtime(&state)
            .workspace(
                &org,
                PRESENCE_TOPIC,
                "status_cleared",
                json!({ "userId": caller.user_id, "updatedAt": now() }),
                &caller.user_id,
            )
            .await;
        Ok(Data(json!({ "userId": caller.user_id, "cleared": true })).into_response())
    }
    .await;
    answer(result, "Failed to clear status")
}
