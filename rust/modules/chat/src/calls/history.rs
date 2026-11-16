//! `GET /api/chat-calls/history` (`services/chat/call-history.ts`): a
//! member's phone-style recents, newest first.
//!
//! Which calls are theirs: every call in a DM or group DM they belong to
//! (those ring every member, so one they never joined is missed), and calls
//! in other channels they started or joined. Direction and outcome are per
//! viewer ([`call_outcome_for`]).

use std::collections::HashMap;

use axum::extract::RawQuery;
use axum::response::Response;
use serde_json::{Value, json};
use weldsuite_chat_domain::calls::{text, truthy, was_answered};
use weldsuite_kit::validation::{Number, Presence};

use crate::access::{Caller, ChatResult, answer, validate_query};
use crate::util::list_response;

const DEFAULT_LIMIT: i64 = 30;
const MAX_LIMIT: i64 = 100;

/// `a.localeCompare(b)`: ICU's root collation, as Node's default locale sorts.
fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use icu_collator::options::CollatorOptions;
    use icu_collator::{CollatorBorrowed, CollatorPreferences};
    static COLLATOR: std::sync::LazyLock<Option<CollatorBorrowed<'static>>> =
        std::sync::LazyLock::new(|| {
            CollatorBorrowed::try_new(CollatorPreferences::default(), CollatorOptions::default())
                .ok()
        });
    COLLATOR
        .as_ref()
        .map_or_else(|| a.cmp(b), |collator| collator.compare(a, b))
}

/// `callOutcomeFor(call, viewerId)`.
pub(crate) fn call_outcome_for(call: &Value, viewer: &str) -> &'static str {
    let status = text(call, "status").unwrap_or_default();
    if matches!(status, "ringing" | "active") {
        return "ongoing";
    }
    if text(call, "initiatorId") == Some(viewer) {
        if status == "declined" {
            return "declined";
        }
        // The list, not the status: a call ended twice can read `ended`
        // although nobody picked up.
        return if was_answered(call) {
            "answered"
        } else {
            "missed"
        };
    }
    let joined = call
        .get("participants")
        .and_then(Value::as_array)
        .is_some_and(|all| {
            all.iter()
                .any(|p| text(p, "userId") == Some(viewer) && truthy(p.get("joinedAt")))
        });
    if joined {
        return "answered";
    }
    if status == "declined" {
        // Another member of a group DM declined: for this viewer it stopped ringing.
        let by = call
            .pointer("/metadata/declinedBy")
            .and_then(Value::as_str)
            .filter(|by| !by.is_empty());
        return if by.is_some_and(|by| by != viewer) {
            "missed"
        } else {
            "declined"
        };
    }
    "missed"
}

/// A person on a history row (`CallPerson`).
#[derive(Debug, Clone)]
struct Person {
    user_id: String,
    name: Option<String>,
    avatar: Option<String>,
}

impl Person {
    fn json(&self) -> Value {
        json!({ "userId": self.user_id, "name": self.name, "avatar": self.avatar })
    }
}

/// `callCounterpart`: whoever called (incoming), or the first other member
/// (outgoing); `None` for a channel call.
fn counterpart(
    call: &Value,
    viewer: &str,
    channel_type: Option<&str>,
    others: &[Person],
    people: &HashMap<String, (Option<String>, Option<String>)>,
) -> Value {
    if channel_type != Some("dm") {
        return Value::Null;
    }
    let initiator = text(call, "initiatorId").unwrap_or_default();
    if initiator != viewer {
        let info = people.get(initiator);
        let name = info
            .and_then(|(name, _)| name.clone())
            .or_else(|| text(call, "initiatorName").map(str::to_owned));
        let avatar = info.and_then(|(_, picture)| picture.clone());
        return json!({ "userId": initiator, "name": name, "avatar": avatar });
    }
    others.first().map_or(Value::Null, Person::json)
}

/// The rows of the viewer's history (see the module docs), `$1` the viewer
/// and `$2` their participant needle.
macro_rules! visible {
    () => {
        "ch.deleted_at is null and (
       (ch.type = 'dm' and c.channel_id in (select m.channel_id from chat_channel_members m where m.user_id = $1))
       or c.initiator_id = $1
       or c.participants @> $2::jsonb)"
    };
}

/// `listCallHistory(db, viewerId, { limit, cursor })` behind `GET /history`.
pub(crate) async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = validate_query(raw.as_deref(), |issues, values| {
        let limit = issues
            .number(
                values,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    int: true,
                    min: Some(1.0),
                    ..Number::default()
                },
            )
            .into_option();
        let cursor = issues.string(values, "cursor", false, Some(1), None);
        (limit, cursor)
    });
    let (limit, cursor) = match query {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    if let Err(error) = caller.org() {
        return error.respond("");
    }
    answer(
        history(&caller, limit, cursor).await,
        "Failed to list call history",
    )
}

#[allow(clippy::cast_possible_truncation)]
async fn history(
    caller: &Caller,
    limit: Option<f64>,
    cursor: Option<String>,
) -> ChatResult<Response> {
    let limit = limit
        .map_or(DEFAULT_LIMIT, |limit| limit as i64)
        .clamp(1, MAX_LIMIT);
    let viewer = caller.user_id.as_str();
    let needle = json!([{ "userId": viewer }]).to_string();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select to_jsonb(r) from (
           select c.id, c.channel_id, c.call_type, c.status, c.initiator_id, c.initiator_name,
                  c.participants, c.metadata, c.started_at, c.ended_at, c.duration, c.created_at,
                  ch.type as channel_type, ch.name as channel_name
           from chat_calls c inner join chat_channels ch on ch.id = c.channel_id
           where ",
        visible!(),
        " and ($3::text is null
                  or (c.created_at, c.id) < (select cur.created_at, cur.id from chat_calls cur where cur.id = $3))
           order by c.created_at desc, c.id desc
           limit $4
         ) r"
    ))
    .bind(viewer)
    .bind(&needle)
    .bind(&cursor)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*) from chat_calls c inner join chat_channels ch on ch.id = c.channel_id
         where ",
        visible!()
    ))
    .bind(viewer)
    .bind(&needle)
    .fetch_one(&caller.db)
    .await?;

    let mut rows: Vec<Value> = rows.into_iter().map(weldsuite_db::js_row).collect();
    let page_size = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > page_size;
    rows.truncate(page_size);

    let dm_rows: Vec<&Value> = rows
        .iter()
        .filter(|r| text(r, "channelType") == Some("dm"))
        .collect();
    let mut dm_channels: Vec<String> = Vec::new();
    for row in &dm_rows {
        let channel = text(row, "channelId").unwrap_or_default().to_owned();
        if !dm_channels.contains(&channel) {
            dm_channels.push(channel);
        }
    }
    let initiators: Vec<String> = dm_rows
        .iter()
        .filter_map(|r| text(r, "initiatorId").map(str::to_owned))
        .collect();
    let (members_by_channel, people) =
        load_dm_people(caller, viewer, &dm_channels, &initiators).await?;

    let items: Vec<Value> = rows
        .iter()
        .map(|row| {
            let channel_type = text(row, "channelType");
            let others: &[Person] = if channel_type == Some("dm") {
                members_by_channel
                    .get(text(row, "channelId").unwrap_or_default())
                    .map_or(&[], Vec::as_slice)
            } else {
                &[]
            };
            let direction = if text(row, "initiatorId") == Some(viewer) {
                "outgoing"
            } else {
                "incoming"
            };
            json!({
                "id": row["id"],
                "channelId": row["channelId"],
                "channelType": row.get("channelType").cloned().unwrap_or(Value::Null),
                "channelName": row.get("channelName").cloned().unwrap_or(Value::Null),
                "callType": row["callType"],
                "status": row["status"],
                "direction": direction,
                "outcome": call_outcome_for(row, viewer),
                "initiatorId": row["initiatorId"],
                "initiatorName": row["initiatorName"],
                "counterpart": counterpart(row, viewer, channel_type, others, &people),
                "otherMembers": others.iter().map(Person::json).collect::<Vec<_>>(),
                "startedAt": row.get("startedAt").cloned().unwrap_or(Value::Null),
                "endedAt": row.get("endedAt").cloned().unwrap_or(Value::Null),
                "duration": row.get("duration").cloned().unwrap_or(Value::Null),
                "createdAt": row["createdAt"],
            })
        })
        .collect();
    let next = if has_more {
        rows.last().and_then(|r| text(r, "id")).map(str::to_owned)
    } else {
        None
    };
    Ok(list_response(items, total, has_more, next))
}

/// `loadDmPeople`: each DM's other members (sorted by name, then id) and a
/// name/avatar lookup by user, callers who left the DM included.
async fn load_dm_people(
    caller: &Caller,
    viewer: &str,
    dm_channels: &[String],
    initiators: &[String],
) -> Result<
    (
        HashMap<String, Vec<Person>>,
        HashMap<String, (Option<String>, Option<String>)>,
    ),
    sqlx::Error,
> {
    let mut by_channel: HashMap<String, Vec<Person>> = HashMap::new();
    let mut people: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    if dm_channels.is_empty() {
        return Ok((by_channel, people));
    }
    let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "select m.channel_id, m.user_id, wm.name, wm.picture
         from chat_channel_members m
         left join workspace_members wm on wm.user_id = m.user_id
         where m.channel_id = any($1) and m.user_id <> $2",
    )
    .bind(dm_channels)
    .bind(viewer)
    .fetch_all(&caller.db)
    .await?;
    for (channel, user, name, picture) in rows {
        people.insert(user.clone(), (name.clone(), picture.clone()));
        let list = by_channel.entry(channel).or_default();
        if !list.iter().any(|m| m.user_id == user) {
            list.push(Person {
                user_id: user,
                name,
                avatar: picture,
            });
        }
    }
    for list in by_channel.values_mut() {
        list.sort_by(|a, b| {
            locale_compare(
                a.name.as_deref().unwrap_or_default(),
                b.name.as_deref().unwrap_or_default(),
            )
            .then_with(|| locale_compare(&a.user_id, &b.user_id))
        });
    }
    let mut missing: Vec<String> = Vec::new();
    for id in initiators {
        if id != viewer && !people.contains_key(id) && !missing.contains(id) {
            missing.push(id.clone());
        }
    }
    if !missing.is_empty() {
        let extra: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "select user_id, name, picture from workspace_members where user_id = any($1)",
        )
        .bind(&missing)
        .fetch_all(&caller.db)
        .await?;
        for (user, name, picture) in extra {
            people.insert(user, (name, picture));
        }
    }
    Ok((by_channel, people))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcomes_are_per_viewer() {
        let call = |status: &str, joined: &[&str], declined_by: Option<&str>| {
            let participants: Vec<Value> = joined
                .iter()
                .map(|user| json!({ "userId": user, "joinedAt": "2026-01-01T10:00:00.000Z" }))
                .collect();
            json!({
                "status": status,
                "initiatorId": "a",
                "participants": participants,
                "metadata": declined_by.map(|by| json!({ "declinedBy": by })),
            })
        };
        assert_eq!(
            call_outcome_for(&call("active", &["a"], None), "b"),
            "ongoing"
        );
        assert_eq!(
            call_outcome_for(&call("ended", &["a", "b"], None), "a"),
            "answered"
        );
        assert_eq!(
            call_outcome_for(&call("missed", &["a"], None), "a"),
            "missed"
        );
        assert_eq!(
            call_outcome_for(&call("declined", &["a"], Some("b")), "a"),
            "declined"
        );
        assert_eq!(
            call_outcome_for(&call("ended", &["a", "b"], None), "b"),
            "answered"
        );
        // In a group DM someone else answered: missed for this viewer.
        assert_eq!(
            call_outcome_for(&call("ended", &["a", "b"], None), "c"),
            "missed"
        );
        assert_eq!(
            call_outcome_for(&call("declined", &["a"], Some("b")), "c"),
            "missed"
        );
        assert_eq!(
            call_outcome_for(&call("declined", &["a"], Some("c")), "c"),
            "declined"
        );
        assert_eq!(
            call_outcome_for(&call("declined", &["a"], None), "c"),
            "declined"
        );
        assert_eq!(locale_compare("alice", "Bob"), std::cmp::Ordering::Less);
    }
}
