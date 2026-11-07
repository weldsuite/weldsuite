//! Chat subscriptions (`services/chat/subscriptions.ts`, routes
//! `chat-subscriptions`): which WeldChat channel hears about which events of
//! a team or repository (`merge_chat_subscriptions`).
//!
//! ```text
//!   GET    /chat-subscriptions      → list (channelId, teamId)                     merge_teams:read
//!   POST   /chat-subscriptions      → subscribe a channel to events                 merge_teams:manage
//!   PATCH  /chat-subscriptions/:id  → change team, repository, events, digest hour  merge_teams:manage
//!   DELETE /chat-subscriptions/:id  → unsubscribe (soft delete)                     merge_teams:manage
//! ```
//!
//! A subscription with no team and no repository covers everything. A team
//! covers the team's issues and its repositories' pull requests; a
//! repository covers its pull requests and releases (issues belong to no
//! repository, so a repository subscription never hears about issues).
//!
//! The member must be able to open the channel they subscribe (an unknown or
//! private channel is a 404). A subscription with `daily_digest` marks the
//! workspace due in the `merge_digest` index at its next digest hour (the
//! master `workspace_due_index`, where Global keeps the schedule-index D1).
//!
//! Events: `merge_chat_subscription` created | updated | deleted.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::db::{Row, col, int, rows_of, text};
use crate::issues::diff_fields;
use crate::schemas::nothing_to_update;
use crate::{
    Answer, Caller, MergeState, PendingEvent, Refusal, all, now, publish, validate, validate_query,
};

/// The due index kind of the daily digest.
pub(crate) const DIGEST_KIND: &str = "merge_digest";

/// `MERGE_CHAT_EVENTS`.
pub(crate) const CHAT_EVENTS: [&str; 7] = [
    "review_requested",
    "checks_failed",
    "pull_request_merged",
    "issue_created",
    "issue_done",
    "release_shipped",
    "daily_digest",
];

/// `SUBSCRIPTION_CHANGE_FIELDS`.
const SUBSCRIPTION_CHANGE_FIELDS: [&str; 4] = ["teamId", "repositoryId", "events", "digestHour"];

/// `row.events ?? []`.
fn events_of(row: &Row) -> Value {
    match row.get("events") {
        None | Some(Value::Null) => json!([]),
        Some(events) => events.clone(),
    }
}

/// Whether a subscription asks for `event`.
fn has_event(row: &Row, event: &str) -> bool {
    row.get("events")
        .and_then(Value::as_array)
        .is_some_and(|events| events.iter().any(|e| e.as_str() == Some(event)))
}

/// `subscriptionDto(row)`.
pub(crate) fn subscription_dto(row: &Row) -> Value {
    json!({
        "id": col(row, "id"),
        "channelId": col(row, "channelId"),
        "teamId": col(row, "teamId"),
        "repositoryId": col(row, "repositoryId"),
        "events": events_of(row),
        "digestHour": col(row, "digestHour"),
        "createdByUserId": col(row, "createdByUserId"),
        "createdAt": col(row, "createdAt"),
        "updatedAt": col(row, "updatedAt"),
    })
}

/// `subscriptionEventData(row)`.
fn subscription_event_data(row: &Row) -> Value {
    json!({
        "id": col(row, "id"),
        "channelId": col(row, "channelId"),
        "teamId": col(row, "teamId"),
        "repositoryId": col(row, "repositoryId"),
        "events": events_of(row),
    })
}

fn subscription_event(row: &Row, action: &'static str) -> PendingEvent {
    PendingEvent::new(
        "merge_chat_subscription",
        action,
        text(row, "id"),
        subscription_event_data(row),
    )
}

/// `[...new Set(events)]`.
fn unique_events(events: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(events.len());
    for event in events {
        if !out.contains(&event) {
            out.push(event);
        }
    }
    out
}

// ── Reading ─────────────────────────────────────────────────────────────────

async fn find_subscription(db: &PgPool, id: &str) -> Result<Option<Row>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from merge_chat_subscriptions s where s.id = $1 and s.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// What an event is about, to match subscriptions against (`EventScope`).
#[derive(Debug, Clone, Default)]
pub(crate) struct EventScope {
    pub(crate) team_id: Option<String>,
    pub(crate) repository_id: Option<String>,
}

/// `subscribedChannels(rows, scope)`: the subscriptions whose team and
/// repository filters fit the scope, as distinct channel ids.
pub(crate) fn subscribed_channels(rows: &[Row], scope: &EventScope) -> Vec<String> {
    let mut channels: Vec<String> = Vec::new();
    for row in rows {
        let team = row
            .get("teamId")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty());
        if let Some(team) = team
            && Some(team) != scope.team_id.as_deref()
        {
            continue;
        }
        let repository = row
            .get("repositoryId")
            .and_then(Value::as_str)
            .filter(|r| !r.is_empty());
        if let Some(repository) = repository
            && Some(repository) != scope.repository_id.as_deref()
        {
            continue;
        }
        let channel = text(row, "channelId").to_owned();
        if !channels.contains(&channel) {
            channels.push(channel);
        }
    }
    channels
}

/// The live subscriptions to `event`, oldest first.
async fn subscriptions_to(db: &PgPool, event: &str) -> Result<Vec<Row>, sqlx::Error> {
    Ok(rows_of(
        sqlx::query_scalar(
            "select to_jsonb(s) from merge_chat_subscriptions s \
             where s.deleted_at is null and s.events @> $1::jsonb \
             order by s.created_at asc, s.id asc",
        )
        .bind(json!([event]))
        .fetch_all(db)
        .await?,
    ))
}

/// `channelsFor(db, event, scope)`: the channels subscribed to `event` for
/// this scope, each once.
pub(crate) async fn channels_for(
    db: &PgPool,
    event: &str,
    scope: &EventScope,
) -> Result<Vec<String>, sqlx::Error> {
    Ok(subscribed_channels(
        &subscriptions_to(db, event).await?,
        scope,
    ))
}

/// `digestSubscriptions(db)`: the subscriptions that post a daily digest.
pub(crate) async fn digest_subscriptions(db: &PgPool) -> Result<Vec<Row>, sqlx::Error> {
    subscriptions_to(db, "daily_digest").await
}

/// `nextDigestAt(hour, from)`: the next UTC `hour`:00 strictly after `from`.
pub(crate) fn next_digest_at(hour: i64, from: OffsetDateTime) -> OffsetDateTime {
    let midnight = from
        .to_offset(time::UtcOffset::UTC)
        .date()
        .midnight()
        .assume_utc();
    // `Date.UTC(y, m, d, hour)`: an hour outside 0–23 rolls over the day.
    let next = midnight + time::Duration::hours(hour);
    if next <= from {
        next + time::Duration::days(1)
    } else {
        next
    }
}

// ── Routes ──────────────────────────────────────────────────────────────────

/// `GET /chat-subscriptions`.
pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Answer {
    let (channel_id, team_id) = validate_query(query.as_deref(), |issues, fields| {
        (
            issues
                .text(fields, "channelId", Presence::Optional, None, None)
                .into_option(),
            issues
                .text(fields, "teamId", Presence::Optional, None, None)
                .into_option(),
        )
    })?;
    let truthy = |value: Option<String>| value.filter(|v| !v.is_empty());
    let rows = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(s) from merge_chat_subscriptions s where s.deleted_at is null \
             and ($1::text is null or s.channel_id = $1) \
             and ($2::text is null or s.team_id = $2) \
             order by s.created_at asc, s.id asc",
        )
        .bind(truthy(channel_id))
        .bind(truthy(team_id))
        .fetch_all(&caller.db)
        .await?,
    );
    Ok(all(rows.iter().map(subscription_dto).collect()))
}

/// `createMergeChatSubscriptionSchema` / `updateMergeChatSubscriptionSchema`.
struct SubscriptionInput {
    channel_id: String,
    team_id: Field<String>,
    repository_id: Field<String>,
    events: Field<Vec<String>>,
    digest_hour: Field<i64>,
}

fn read_input(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    partial: bool,
) -> SubscriptionInput {
    let start = issues.count();
    let channel_id = if partial {
        String::new()
    } else {
        issues
            .text(fields, "channelId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    };
    let team_id = issues.text(fields, "teamId", Presence::Nullish, None, None);
    let repository_id = issues.text(fields, "repositoryId", Presence::Nullish, None, None);
    let events = issues.list(
        fields,
        "events",
        if partial {
            Presence::Optional
        } else {
            Presence::Required
        },
        Some(1),
        None,
        |issues, item| issues.item_choice(item, &CHAT_EVENTS),
    );
    let digest_hour = issues.whole_number(
        fields,
        "digestHour",
        Presence::Optional,
        Number {
            min: Some(0.0),
            max: Some(23.0),
            ..Number::default()
        },
    );
    if partial {
        nothing_to_update(
            issues,
            start,
            fields,
            &["teamId", "repositoryId", "events", "digestHour"],
        );
    }
    SubscriptionInput {
        channel_id,
        team_id,
        repository_id,
        events,
        digest_hour,
    }
}

/// Why a reference was refused (`SubscriptionRefFailure`).
async fn check_refs(
    db: &PgPool,
    team_id: Option<&str>,
    repository_id: Option<&str>,
) -> Result<Option<Refusal>, sqlx::Error> {
    if let Some(team) = team_id.filter(|t| !t.is_empty()) {
        let found: Option<String> = sqlx::query_scalar(
            "select id from merge_teams where id = $1 and deleted_at is null limit 1",
        )
        .bind(team)
        .fetch_optional(db)
        .await?;
        if found.is_none() {
            return Ok(Some(Refusal::not_found("Team", None)));
        }
    }
    if let Some(repository) = repository_id.filter(|r| !r.is_empty()) {
        let found: Option<String> = sqlx::query_scalar(
            "select id from merge_repositories where id = $1 and deleted_at is null limit 1",
        )
        .bind(repository)
        .fetch_optional(db)
        .await?;
        if found.is_none() {
            return Ok(Some(Refusal::not_found("Repository", None)));
        }
    }
    Ok(None)
}

/// `armDigest(c, row)`: a subscription with a daily digest makes the sweep
/// look at this workspace at the digest hour.
async fn arm_digest(state: &MergeState, caller: &Caller, row: &Row) {
    if !has_event(row, "daily_digest") {
        return;
    }
    let Some(master) = caller.overrides.master(state) else {
        return;
    };
    let at = next_digest_at(int(row, "digestHour"), OffsetDateTime::now_utc());
    weldsuite_db::due_index::mark_due(&master, DIGEST_KIND, &caller.workspace_id, at).await;
}

/// `POST /chat-subscriptions`.
pub(crate) async fn create(
    State(state): State<MergeState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = validate(&headers, &body, |issues, fields| {
        read_input(issues, fields, false)
    })?;
    let db = &caller.db;
    if !weldsuite_chat_domain::can_access_channel(db, &input.channel_id, &caller.user_id, None)
        .await?
    {
        return Err(Refusal::not_found("Channel", Some(&input.channel_id)));
    }
    let team_id = input.team_id.into_option();
    let repository_id = input.repository_id.into_option();
    if let Some(refusal) = check_refs(db, team_id.as_deref(), repository_id.as_deref()).await? {
        return Err(refusal);
    }
    let now = now();
    let row: Value = sqlx::query_scalar(
        "insert into merge_chat_subscriptions \
           (id, channel_id, team_id, repository_id, events, digest_hour, created_by_user_id, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz) \
         returning to_jsonb(merge_chat_subscriptions.*)",
    )
    .bind(generate_id("mcs"))
    .bind(&input.channel_id)
    .bind(team_id)
    .bind(repository_id)
    .bind(json!(unique_events(
        input.events.into_option().unwrap_or_default()
    )))
    .bind(input.digest_hour.into_option().unwrap_or(9))
    .bind(&caller.user_id)
    .bind(&now)
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    publish(
        &state,
        &caller.events,
        vec![subscription_event(&row, "created")],
    );
    arm_digest(&state, &caller, &row).await;
    Ok(Created(subscription_dto(&row)).into_response())
}

/// A nullable field of a patch: `(set, value)`.
fn patch<T: Clone>(field: &Field<T>) -> (bool, Option<T>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.clone())),
    }
}

/// `PATCH /chat-subscriptions/:id`.
pub(crate) async fn update(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = validate(&headers, &body, |issues, fields| {
        read_input(issues, fields, true)
    })?;
    let db = &caller.db;
    let Some(before) = find_subscription(db, &id).await? else {
        return Err(Refusal::not_found("Chat subscription", Some(&id)));
    };
    if let Some(refusal) = check_refs(
        db,
        input.team_id.as_set().map(String::as_str),
        input.repository_id.as_set().map(String::as_str),
    )
    .await?
    {
        return Err(refusal);
    }
    let (set_team, team) = patch(&input.team_id);
    let (set_repository, repository) = patch(&input.repository_id);
    let events = input
        .events
        .as_set()
        .map(|events| json!(unique_events(events.clone())));
    let row: Value = sqlx::query_scalar(
        "update merge_chat_subscriptions set updated_at = $2::timestamptz, \
           team_id = case when $3 then $4 else team_id end, \
           repository_id = case when $5 then $6 else repository_id end, \
           events = case when $7::jsonb is null then events else $7 end, \
           digest_hour = case when $8::int is null then digest_hour else $8 end \
         where id = $1 returning to_jsonb(merge_chat_subscriptions.*)",
    )
    .bind(&id)
    .bind(now())
    .bind(set_team)
    .bind(team)
    .bind(set_repository)
    .bind(repository)
    .bind(events)
    .bind(input.digest_hour.as_set().copied())
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    let changes = diff_fields(&before, &row, &SUBSCRIPTION_CHANGE_FIELDS);
    publish(
        &state,
        &caller.events,
        vec![subscription_event(&row, "updated").with_changes(changes)],
    );
    arm_digest(&state, &caller, &row).await;
    Ok(Data(subscription_dto(&row)).into_response())
}

/// `DELETE /chat-subscriptions/:id`.
pub(crate) async fn remove(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let now = now();
    let row: Option<Value> = sqlx::query_scalar(
        "update merge_chat_subscriptions set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1 and deleted_at is null returning to_jsonb(merge_chat_subscriptions.*)",
    )
    .bind(&id)
    .bind(&now)
    .fetch_optional(&caller.db)
    .await?;
    let Some(row) = row.map(js_row) else {
        return Err(Refusal::not_found("Chat subscription", Some(&id)));
    };
    publish(
        &state,
        &caller.events,
        vec![subscription_event(&row, "deleted")],
    );
    Ok(NoContent.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(channel: &str, team: Option<&str>, repository: Option<&str>) -> Row {
        json!({ "channelId": channel, "teamId": team, "repositoryId": repository })
    }

    #[test]
    fn matches_team_and_repository_filters_each_channel_once() {
        let rows = [
            row("a", None, None),
            row("b", Some("t1"), None),
            row("c", Some("t2"), None),
            row("d", None, Some("r1")),
            row("a", Some("t1"), None),
        ];
        let scope = |team: Option<&str>, repository: Option<&str>| EventScope {
            team_id: team.map(str::to_owned),
            repository_id: repository.map(str::to_owned),
        };
        assert_eq!(
            subscribed_channels(&rows, &scope(Some("t1"), Some("r1"))),
            ["a", "b", "d"]
        );
        assert_eq!(
            subscribed_channels(&rows, &scope(Some("t1"), None)),
            ["a", "b"]
        );
        assert_eq!(subscribed_channels(&rows, &scope(None, None)), ["a"]);
    }

    fn at(iso: &str) -> OffsetDateTime {
        OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339)
            .unwrap_or(OffsetDateTime::UNIX_EPOCH)
    }

    #[test]
    fn the_next_digest_is_strictly_after() {
        let iso = |t: OffsetDateTime| weldsuite_events::iso_timestamp(t);
        assert_eq!(
            iso(next_digest_at(9, at("2026-11-05T08:30:00Z"))),
            "2026-11-05T09:00:00.000Z"
        );
        assert_eq!(
            iso(next_digest_at(9, at("2026-11-05T09:00:00Z"))),
            "2026-11-06T09:00:00.000Z"
        );
        assert_eq!(
            iso(next_digest_at(0, at("2026-12-31T23:59:59Z"))),
            "2027-01-01T00:00:00.000Z"
        );
    }
}
