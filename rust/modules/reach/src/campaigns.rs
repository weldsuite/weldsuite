//! `/api/reach/campaigns` (`routes/campaigns`): the campaign operations of
//! `weldsuite_reach_domain::campaigns`, wired to the request's entity events
//! and the send sweep's due index.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_reach_domain::DuePort;
use weldsuite_reach_domain::campaigns::{self, CampaignInput, PreviewInput, StepInput};
use weldsuite_reach_domain::lists::PageQuery;

use crate::account::{is_hhmm, weekdays};
use crate::prospects::page_response;
use crate::{Caller, ReachState, limits_of, respond, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(gate: &Arc<PermissionGate<Q>>) -> Router<ReachState> {
    let read = || gate.require([perm::REACH_CAMPAIGNS_READ]);
    let update = || gate.require([perm::REACH_CAMPAIGNS_UPDATE]);
    Router::new()
        .route(
            "/",
            get(list)
                .route_layer(read())
                .merge(post(create).route_layer(gate.require([perm::REACH_CAMPAIGNS_CREATE]))),
        )
        .route(
            "/{id}",
            get(read_one)
                .route_layer(read())
                .merge(axum::routing::patch(update_one).route_layer(update()))
                .merge(delete(delete_one).route_layer(gate.require([perm::REACH_CAMPAIGNS_DELETE]))),
        )
        .route("/{id}/steps", put(steps).route_layer(update()))
        .route("/{id}/mailboxes", put(mailboxes).route_layer(update()))
        .route("/{id}/prospects", post(prospects).route_layer(update()))
        .route("/{id}/enrollments", get(enrollments).route_layer(read()))
        .route("/{id}/enrollments/{enrollment_id}", delete(remove_enrollment).route_layer(update()))
        .route("/{id}/launch", post(launch).route_layer(update()))
        .route("/{id}/pause", post(pause).route_layer(update()))
        .route("/{id}/resume", post(resume).route_layer(update()))
        .route("/{id}/preview", post(preview).route_layer(read()))
        .route("/{id}/stats", get(stats).route_layer(read()))
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    respond(
        campaigns::list(&caller.db, &PageQuery::from_query(query.as_deref()))
            .await
            .map(page_response),
    )
}

async fn read_one(caller: Caller, Path(id): Path<String>) -> Response {
    respond(campaigns::get_detail(&caller.db, &id).await.map(|d| Data(d).into_response()))
}

/// `campaignScheduleSchema` with `presence` on every field, then `name`
/// (and `ownerId` for an update), in the schema's order.
fn campaign_input(issues: &mut Issues, body: &Map<String, Value>, name: Presence, owner: bool) -> CampaignInput {
    let opt = Presence::Optional;
    let timezone = issues.text_with(body, "timezone", opt, Text::length(Some(1), Some(64))).into_option();
    let send_days = weekdays(issues, body, "sendDays", opt);
    let window_start = issues.pattern(body, "windowStart", opt, None, None, is_hhmm, "Use HH:MM").into_option();
    let window_end = issues.pattern(body, "windowEnd", opt, None, None, is_hhmm, "Use HH:MM").into_option();
    let daily_limit = issues
        .whole_number(body, "dailyLimit", opt, Number { coerce: false, int: true, min: Some(1.0), max: Some(10_000.0) })
        .into_option();
    let min_gap = issues
        .whole_number(body, "minGapMinutes", opt, Number { coerce: false, int: true, min: Some(1.0), max: Some(240.0) })
        .into_option();
    let stop = issues.boolean(body, "stopOnAutoReply", opt).into_option();
    let name = issues.text_with(body, "name", name, Text::trimmed(Some(1), Some(200))).into_option();
    let owner_id = if owner {
        match issues.text_with(body, "ownerId", Presence::Nullish, Text::length(None, Some(255))) {
            Field::Set(id) => Some(Some(id)),
            Field::Null => Some(None),
            Field::Absent => None,
        }
    } else {
        None
    };
    CampaignInput {
        name,
        timezone,
        send_days,
        window_start,
        window_end,
        daily_limit,
        min_gap_minutes: min_gap,
        stop_on_auto_reply: stop,
        owner_id,
    }
}

async fn create(State(state): State<ReachState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, body| campaign_input(issues, body, Presence::Required, false)) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let sink = caller.sink(&state);
    respond(
        campaigns::create(&caller.db, &sink, &caller.user_id, input)
            .await
            .map(|d| (StatusCode::CREATED, Data(d)).into_response()),
    )
}

async fn update_one(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, body| campaign_input(issues, body, Presence::Optional, true)) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let sink = caller.sink(&state);
    respond(
        campaigns::update(&caller.db, &sink, &id, input)
            .await
            .map(|d| Data(d).into_response()),
    )
}

async fn delete_one(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>) -> Response {
    let sink = caller.sink(&state);
    respond(
        campaigns::delete(&caller.db, &sink, &id)
            .await
            .map(|()| NoContent.into_response()),
    )
}

async fn steps(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        issues
            .list(body, "steps", Presence::Required, Some(1), Some(10), |issues, item| {
                let fields = issues.object(item)?.clone();
                let int = |issues: &mut Issues, key: &str, max: f64| {
                    issues
                        .whole_number(&fields, key, Presence::Required, Number { coerce: false, int: true, min: Some(0.0), max: Some(max) })
                        .into_option()
                };
                let delay_days = int(issues, "delayDays", 90.0);
                let delay_hours = int(issues, "delayHours", 23.0);
                let subject = issues.text_with(&fields, "subject", Presence::Required, Text::trimmed(Some(1), Some(300))).into_option();
                let body = issues.text_with(&fields, "body", Presence::Required, Text::trimmed(Some(1), Some(20_000))).into_option();
                let reply = issues.boolean(&fields, "replyInThread", Presence::Required).into_option();
                Some(StepInput {
                    delay_days: delay_days?,
                    delay_hours: delay_hours?,
                    subject: subject?,
                    body: body?,
                    reply_in_thread: reply?,
                })
            })
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let sink = caller.sink(&state);
    respond(
        campaigns::replace_steps(&caller.db, &sink, &id, input)
            .await
            .map(|d| Data(d).into_response()),
    )
}

/// `z.array(z.string().min(1).max(30))`.
fn ids(issues: &mut Issues, body: &Map<String, Value>, key: &str, presence: Presence, max: usize) -> Option<Vec<String>> {
    issues
        .list(body, key, presence, None, Some(max), |issues, item| {
            issues.item_text(item, Text::length(Some(1), Some(30)))
        })
        .into_option()
}

async fn mailboxes(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, body| ids(issues, body, "mailboxIds", Presence::Required, 500).unwrap_or_default()) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let sink = caller.sink(&state);
    respond(
        campaigns::set_mailboxes(&caller.db, &sink, &id, &input)
            .await
            .map(|d| Data(d).into_response()),
    )
}

async fn prospects(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        let prospect_ids = ids(issues, body, "prospectIds", Presence::Optional, 10_000);
        let list_id = issues.text_with(body, "listId", Presence::Optional, Text::length(Some(1), Some(30))).into_option();
        if issues.is_empty() && prospect_ids.as_ref().is_none_or(Vec::is_empty) && list_id.is_none() {
            issues.custom_root("prospectIds or listId is required");
        }
        (prospect_ids.unwrap_or_default(), list_id)
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let sink = caller.sink(&state);
    let due = caller.due(&state);
    let limits = limits_of(&caller);
    respond(
        campaigns::enroll(
            &caller.db,
            &sink,
            due.as_ref().map(|d| d as &dyn DuePort),
            limits.allow_consumer_recipients,
            &id,
            &input.0,
            input.1.as_deref(),
        )
        .await
        .map(|r| Data(r).into_response()),
    )
}

async fn enrollments(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    respond(
        campaigns::list_enrollments(&caller.db, &id, &PageQuery::from_query(query.as_deref()))
            .await
            .map(page_response),
    )
}

async fn remove_enrollment(State(state): State<ReachState>, caller: Caller, Path((id, enrollment_id)): Path<(String, String)>) -> Response {
    let sink = caller.sink(&state);
    respond(
        campaigns::remove_campaign_enrollment(&caller.db, &sink, &id, &enrollment_id)
            .await
            .map(|()| NoContent.into_response()),
    )
}

async fn launch(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>) -> Response {
    let sink = caller.sink(&state);
    let due = caller.due(&state);
    respond(
        campaigns::launch(&caller.db, &sink, due.as_ref().map(|d| d as &dyn DuePort), &id)
            .await
            .map(|d| Data(d).into_response()),
    )
}

async fn pause(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>) -> Response {
    let sink = caller.sink(&state);
    respond(campaigns::pause(&caller.db, &sink, &id).await.map(|d| Data(d).into_response()))
}

async fn resume(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>) -> Response {
    let sink = caller.sink(&state);
    let due = caller.due(&state);
    respond(
        campaigns::resume(&caller.db, &sink, due.as_ref().map(|d| d as &dyn DuePort), &id)
            .await
            .map(|d| Data(d).into_response()),
    )
}

async fn preview(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, body| PreviewInput {
        step_id: issues.text_with(body, "stepId", Presence::Optional, Text::length(Some(1), Some(30))).into_option(),
        prospect_id: issues.text_with(body, "prospectId", Presence::Optional, Text::length(Some(1), Some(30))).into_option(),
        subject: issues.text_with(body, "subject", Presence::Optional, Text::length(None, Some(300))).into_option(),
        body: issues.text_with(body, "body", Presence::Optional, Text::length(None, Some(20_000))).into_option(),
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    respond(
        campaigns::preview(&caller.db, &id, &input)
            .await
            .map(|p| Data(p).into_response()),
    )
}

async fn stats(caller: Caller, Path(id): Path<String>) -> Response {
    respond(campaigns::stats(&caller.db, &id).await.map(|s| Data(s).into_response()))
}
