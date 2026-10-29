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
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Format, Presence, Text, js_date_iso};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

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
        let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>, String)> =
            sqlx::query_as(
                "select user_id, status, status_text, status_emoji,
                        to_jsonb(status_expires_at) #>> '{}', to_jsonb(updated_at) #>> '{}'
                 from chat_user_status",
            )
            .fetch_all(&caller.db)
            .await?;
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
        for (user_id, status, text, emoji, expires_at, updated_at) in rows {
            let expires_at = expires_at.map(|at| crate::util::ms_timestamp(&at));
            let expired = is_expired(expires_at.as_deref(), now);
            let manual = chosen_from_stored(Some(&status), expires_at.as_deref(), now);
            let member_live = live_of(&user_id);
            let entry = json!({
                "userId": user_id,
                "status": effective(manual, member_live),
                "manualStatus": manual,
                "live": member_live,
                "statusText": if expired { None } else { text },
                "statusEmoji": if expired { None } else { emoji },
                "statusExpiresAt": if expired { None } else { expires_at },
                "updatedAt": crate::util::ms_timestamp(&updated_at),
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
        let at = now();
        let expires_at = input.expires_at.as_deref().and_then(js_date_iso);
        sqlx::query(
            "insert into chat_user_status
                (id, user_id, status, status_text, status_emoji, status_expires_at, updated_at)
             values ($1, $2, $3, $4, $5, $6::timestamp, $7::timestamp)
             on conflict (user_id) do update set status = excluded.status,
                status_text = excluded.status_text, status_emoji = excluded.status_emoji,
                status_expires_at = excluded.status_expires_at, updated_at = excluded.updated_at",
        )
        .bind(generate_id("cus"))
        .bind(&caller.user_id)
        .bind(stored_for(&input.status))
        .bind(&input.text)
        .bind(&input.emoji)
        .bind(&expires_at)
        .bind(&at)
        .execute(&caller.db)
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
        sqlx::query("delete from chat_user_status where user_id = $1")
            .bind(&caller.user_id)
            .execute(&caller.db)
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
