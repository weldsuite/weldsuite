//! `/api/desk/assignment` (`routes/desk-assignment/index.ts`): the WeldDesk
//! inbox's auto-assignment rules, kept in `helpdesk_settings.automation
//! .deskAssignment` (`@weldsuite/db/lib/desk-assignment`), and each
//! teammate's away flag.
//!
//!   GET  /       the rules and where the caller stands  (conversations:read)
//!   PUT  /       mode, roster, cap                      (settings:update)
//!   POST /away   the caller away or back                (conversations:update)

use std::collections::HashSet;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Number, Presence, Text};
use weldsuite_kit::{Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, DeskState, Refusal, now, validate};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(read).route_layer(need(perm::CONVERSATIONS_READ)))
        .route("/", put(save).route_layer(need("settings:update")))
        .route(
            "/away",
            post(away).route_layer(need(perm::CONVERSATIONS_UPDATE)),
        )
}

const MODES: [&str; 3] = ["off", "round_robin", "balanced"];

/// `DeskAssignmentSettings`, normalised (`normalizeDeskAssignment`).
struct Assignment {
    mode: String,
    member_ids: Vec<String>,
    away_member_ids: Vec<String>,
    max_open_per_member: Option<Value>,
}

impl Assignment {
    fn json(&self) -> Value {
        json!({
            "mode": self.mode,
            "memberIds": self.member_ids,
            "awayMemberIds": self.away_member_ids,
            "maxOpenPerMember": self.max_open_per_member,
        })
    }

    /// `withMe(settings, userId)`.
    fn with_me(&self, user_id: &str) -> Value {
        let mut out = self.json();
        out["me"] = json!({
            "inRotation": self.member_ids.iter().any(|id| id == user_id),
            "away": self.away_member_ids.iter().any(|id| id == user_id),
        });
        out
    }
}

/// `idList(value)`: the non-empty strings, first occurrence kept.
fn id_list(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    items
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| !id.is_empty() && seen.insert(*id))
        .map(str::to_owned)
        .collect()
}

/// `normalizeDeskAssignment(raw)`.
fn normalize(raw: Option<&Value>) -> Assignment {
    let empty = Map::new();
    let value = match raw {
        Some(Value::Object(fields)) => fields,
        _ => &empty,
    };
    let mode = value
        .get("mode")
        .and_then(Value::as_str)
        .filter(|mode| MODES.contains(mode))
        .unwrap_or("off")
        .to_owned();
    let max = value.get("maxOpenPerMember").filter(|max| {
        max.as_f64()
            .is_some_and(|n| n.is_finite() && n.fract() == 0.0 && n > 0.0)
    });
    Assignment {
        mode,
        member_ids: id_list(value.get("memberIds")),
        away_member_ids: id_list(value.get("awayMemberIds")),
        max_open_per_member: max.cloned(),
    }
}

/// `getDeskAssignmentSettings(db)`: the settings row's id and the rules.
async fn current(db: &PgPool) -> Result<(Option<String>, Assignment), sqlx::Error> {
    let row: Option<(String, Option<Value>)> = sqlx::query_as(
        "select id, automation from helpdesk_settings where deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(match row {
        Some((id, automation)) => {
            let raw = automation.as_ref().and_then(|a| a.get("deskAssignment"));
            (Some(id), normalize(raw))
        }
        None => (None, normalize(None)),
    })
}

fn default_assignment() -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("mode".to_owned(), json!("off"));
    out.insert("memberIds".to_owned(), json!([]));
    out.insert("awayMemberIds".to_owned(), json!([]));
    out.insert("maxOpenPerMember".to_owned(), Value::Null);
    out
}

async fn read(caller: Caller) -> Response {
    match current(&caller.db).await {
        Ok((_, settings)) => Data(settings.with_me(&caller.user_id)).into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to load assignment settings"),
    }
}

/// `saveDeskAssignmentSettings(db, generateId, patch)`.
async fn save_rules(db: &PgPool, patch: &Map<String, Value>) -> Result<Assignment, sqlx::Error> {
    let (settings_id, _) = current(db).await?;
    if let Some(id) = settings_id {
        sqlx::query(
            "update helpdesk_settings set
               automation = coalesce(automation, '{}'::jsonb) || jsonb_build_object('deskAssignment', coalesce(automation->'deskAssignment', '{}'::jsonb) || $2::jsonb),
               updated_at = $3::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(Value::Object(patch.clone()))
        .bind(now())
        .execute(db)
        .await?;
    } else {
        let mut assignment = default_assignment();
        for (key, value) in patch {
            assignment.insert(key.clone(), value.clone());
        }
        let now = now();
        sqlx::query(
            "insert into helpdesk_settings (id, automation, created_at, updated_at)
             values ($1, $2::jsonb, $3::timestamp, $3::timestamp)",
        )
        .bind(generate_id("hds"))
        .bind(json!({ "enabled": false, "deskAssignment": assignment }))
        .bind(&now)
        .execute(db)
        .await?;
    }
    Ok(current(db).await?.1)
}

async fn save(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to save assignment settings";
    let data = match validate(&headers, &body, |issues, fields| {
        let mode = issues
            .choice(fields, "mode", Presence::Required, &MODES)
            .into_option();
        let member_ids = issues
            .list(
                fields,
                "memberIds",
                Presence::Required,
                None,
                Some(500),
                |issues, item| issues.item_text(item, Text::length(Some(1), Some(255))),
            )
            .into_option();
        let max = issues.number(
            fields,
            "maxOpenPerMember",
            Presence::Nullable,
            Number {
                int: true,
                min: Some(1.0),
                max: Some(1000.0),
                ..Number::default()
            },
        );
        let max = match max {
            weldsuite_kit::validation::Field::Set(_) => fields.get("maxOpenPerMember").cloned(),
            _ => Some(Value::Null),
        };
        (mode, member_ids, max)
    }) {
        Ok((Some(mode), Some(member_ids), Some(max))) => (mode, member_ids, max),
        Ok(_) => {
            return weldsuite_kit::ApiError::internal()
                .with_message(message)
                .into_response();
        }
        Err(refusal) => return refusal.respond(message),
    };
    let (mode, member_ids, max) = data;
    // `Array.from(new Set(data.memberIds))`
    let mut seen = HashSet::new();
    let member_ids: Vec<String> = member_ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    let mut patch = Map::new();
    patch.insert("mode".to_owned(), json!(mode));
    patch.insert("memberIds".to_owned(), json!(member_ids));
    patch.insert("maxOpenPerMember".to_owned(), max);
    let settings = match save_rules(&caller.db, &patch).await {
        Ok(settings) => settings,
        Err(error) => return Refusal::Database(error).respond(message),
    };
    match current(&caller.db).await {
        Ok((Some(id), _)) => caller.publish(
            &state,
            ev::HELPDESK_SETTINGS_UPDATED,
            &id,
            &json!({ "deskAssignment": settings.json() }),
        ),
        Ok((None, _)) => {}
        Err(error) => return Refusal::Database(error).respond(message),
    }
    Data(settings.with_me(&caller.user_id)).into_response()
}

/// `setDeskMemberAway(db, generateId, userId, away)`.
async fn set_away(db: &PgPool, user_id: &str, away: bool) -> Result<Assignment, sqlx::Error> {
    let (settings_id, _) = current(db).await?;
    let Some(id) = settings_id else {
        if !away {
            return Ok(normalize(None));
        }
        let mut assignment = default_assignment();
        assignment.insert("awayMemberIds".to_owned(), json!([user_id]));
        let now = now();
        sqlx::query(
            "insert into helpdesk_settings (id, automation, created_at, updated_at)
             values ($1, $2::jsonb, $3::timestamp, $3::timestamp)",
        )
        .bind(generate_id("hds"))
        .bind(json!({ "enabled": false, "deskAssignment": assignment }))
        .bind(&now)
        .execute(db)
        .await?;
        return Ok(current(db).await?.1);
    };
    let sql = if away {
        "update helpdesk_settings set
           automation = coalesce(automation, '{}'::jsonb) || jsonb_build_object('deskAssignment', coalesce(automation->'deskAssignment', '{}'::jsonb) || jsonb_build_object('awayMemberIds',
             (SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements_text(coalesce(automation#>'{deskAssignment,awayMemberIds}', '[]'::jsonb) || to_jsonb($2::text)) AS x))),
           updated_at = $3::timestamp
         where id = $1"
    } else {
        "update helpdesk_settings set
           automation = coalesce(automation, '{}'::jsonb) || jsonb_build_object('deskAssignment', coalesce(automation->'deskAssignment', '{}'::jsonb) || jsonb_build_object('awayMemberIds',
             (SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements_text(coalesce(automation#>'{deskAssignment,awayMemberIds}', '[]'::jsonb)) AS x WHERE x <> $2::text))),
           updated_at = $3::timestamp
         where id = $1"
    };
    sqlx::query(sql)
        .bind(&id)
        .bind(user_id)
        .bind(now())
        .execute(db)
        .await?;
    Ok(current(db).await?.1)
}

async fn away(
    State(state): State<DeskState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let message = "Failed to update away status";
    let away = match validate(&headers, &body, |issues, fields| {
        issues
            .boolean(fields, "away", Presence::Required)
            .into_option()
    }) {
        Ok(Some(away)) => away,
        Ok(None) => {
            return weldsuite_kit::ApiError::internal()
                .with_message(message)
                .into_response();
        }
        Err(refusal) => return refusal.respond(message),
    };
    let settings = match set_away(&caller.db, &caller.user_id, away).await {
        Ok(settings) => settings,
        Err(error) => return Refusal::Database(error).respond(message),
    };
    match current(&caller.db).await {
        Ok((Some(id), _)) => caller.publish(
            &state,
            ev::HELPDESK_SETTINGS_UPDATED,
            &id,
            &json!({ "deskAssignment": { "awayMemberIds": settings.away_member_ids } }),
        ),
        Ok((None, _)) => {}
        Err(error) => return Refusal::Database(error).respond(message),
    }
    Data(settings.with_me(&caller.user_id)).into_response()
}
