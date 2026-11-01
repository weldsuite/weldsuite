//! `/api/reach/prospects` (`routes/prospects`): the prospect store and its
//! imports (rows, CRM lists, WeldData lists).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Format, Issues, Presence, Text};
use weldsuite_kit::{ApiError, Data, List, NoContent, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_reach_domain::lists::{Page, PageQuery};
use weldsuite_reach_domain::prospects::{self, ImportRow, ProspectDeps, ProspectUpdate};

use crate::{Caller, ReachState, limits_of, respond, validate};

pub(crate) fn routes<Q: PermissionQueries + 'static>(gate: &Arc<PermissionGate<Q>>) -> Router<ReachState> {
    let read = || gate.require([perm::REACH_PROSPECTS_READ]);
    let create = || gate.require([perm::REACH_PROSPECTS_CREATE]);
    Router::new()
        .route("/", get(list).route_layer(read()).merge(post(create_one).route_layer(create())))
        .route(
            "/{id}",
            get(read_one)
                .route_layer(read())
                .merge(axum::routing::patch(update_one).route_layer(gate.require([perm::REACH_PROSPECTS_UPDATE])))
                .merge(axum::routing::delete(delete_one).route_layer(gate.require([perm::REACH_PROSPECTS_DELETE]))),
        )
        .route("/import", post(import).route_layer(create()))
        .route("/import-crm-list", post(import_crm_list).route_layer(create()))
        .route("/import-welddata", post(import_welddata).route_layer(create()))
}

/// A page as the list envelope.
pub(crate) fn page_response(page: Page) -> Response {
    List::new(
        page.data,
        Pagination::new(u64::try_from(page.total_count).unwrap_or_default(), page.has_more, page.cursor),
    )
    .into_response()
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    respond(
        prospects::list(&caller.db, &PageQuery::from_query(query.as_deref()))
            .await
            .map(page_response),
    )
}

async fn read_one(caller: Caller, Path(id): Path<String>) -> Response {
    respond(prospects::get(&caller.db, &id).await.map(|p| Data(p).into_response()))
}

/// `customFields`: `z.record(z.string().max(64), z.string().max(2000))`
/// refined to at most 50 keys. The refinement's issue is kept for last, as
/// `safeParseAsync` settles it after the synchronous checks.
fn custom_fields(issues: &mut Issues, body: &Map<String, Value>, refine: &mut Vec<String>) -> Option<Map<String, Value>> {
    issues
        .nested(body, "customFields", Presence::Optional, |issues, fields| {
            let mut out = Map::new();
            for key in fields.keys() {
                if weldsuite_reach_domain::js_len(key) > 64 {
                    issues.string_too_big(key, 64, "String must contain at most 64 character(s)");
                }
                if let Some(text) = issues.text_with(fields, key, Presence::Required, Text::length(None, Some(2000))).into_option() {
                    out.insert(key.clone(), Value::String(text));
                }
            }
            if fields.len() > 50 {
                refine.push("customFields".to_owned());
            }
            out
        })
        .into_option()
}

/// The shape of a prospect row (`reachProspectInputSchema`); `email_rules`
/// differ for import rows.
fn prospect_row(issues: &mut Issues, body: &Map<String, Value>, email_rules: Text, refine: &mut Vec<String>) -> ImportRow {
    let email = issues.text_with(body, "email", Presence::Required, email_rules).into_option();
    let opt = |issues: &mut Issues, key: &str, rules: Text| issues.text_with(body, key, Presence::Optional, rules).into_option();
    let first_name = opt(issues, "firstName", Text::trimmed(None, Some(100)));
    let last_name = opt(issues, "lastName", Text::trimmed(None, Some(100)));
    let company_name = opt(issues, "companyName", Text::trimmed(None, Some(200)));
    let title = opt(issues, "title", Text::trimmed(None, Some(200)));
    let timezone = opt(issues, "timezone", Text::length(None, Some(64)));
    let custom = custom_fields(issues, body, refine);
    ImportRow {
        person_id: None,
        email,
        first_name,
        last_name,
        company_name,
        title,
        timezone,
        custom_fields: custom,
    }
}

const EMAIL_RULES: Text = Text {
    trim: true,
    lowercase: true,
    format: Some(Format::Email),
    min: None,
    max: Some(320),
};

fn finish_refinements(issues: &mut Issues, refine: &[String]) {
    for key in refine {
        issues.custom(key, "At most 50 custom fields");
    }
}

async fn create_one(State(state): State<ReachState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        let mut refine = Vec::new();
        let row = prospect_row(issues, body, EMAIL_RULES, &mut refine);
        let list_id = issues.text_with(body, "listId", Presence::Optional, Text::length(Some(1), Some(30))).into_option();
        finish_refinements(issues, &refine);
        (row, list_id)
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let http = caller.http(&state);
    let limits = limits_of(&caller);
    let sink = caller.sink(&state);
    let deps = ProspectDeps {
        db: &caller.db,
        emit: &sink,
        user_id: &caller.user_id,
        allow_consumer: limits.allow_consumer_recipients,
        http: Some(&http),
    };
    respond(
        prospects::create(&deps, input.0, input.1.as_deref())
            .await
            .map(|p| (StatusCode::CREATED, Data(p)).into_response()),
    )
}

async fn update_one(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        let mut refine = Vec::new();
        let opt = |issues: &mut Issues, key: &str, rules: Text| issues.text_with(body, key, Presence::Optional, rules).into_option();
        let update = ProspectUpdate {
            first_name: opt(issues, "firstName", Text::trimmed(None, Some(100))),
            last_name: opt(issues, "lastName", Text::trimmed(None, Some(100))),
            company_name: opt(issues, "companyName", Text::trimmed(None, Some(200))),
            title: opt(issues, "title", Text::trimmed(None, Some(200))),
            timezone: opt(issues, "timezone", Text::length(None, Some(64))),
            custom_fields: custom_fields(issues, body, &mut refine),
        };
        finish_refinements(issues, &refine);
        update
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let sink = caller.sink(&state);
    respond(
        prospects::update(&caller.db, &sink, &id, input)
            .await
            .map(|p| Data(p).into_response()),
    )
}

async fn delete_one(State(state): State<ReachState>, caller: Caller, Path(id): Path<String>) -> Response {
    let sink = caller.sink(&state);
    respond(
        prospects::delete(&caller.db, &sink, &id)
            .await
            .map(|()| NoContent.into_response()),
    )
}

async fn import(State(state): State<ReachState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        let mut refine: Vec<String> = Vec::new();
        let rows = issues
            .list(body, "rows", Presence::Required, Some(1), Some(5000), |issues, item| {
                let fields = issues.object(item)?.clone();
                let mut item_refine = Vec::new();
                let row = prospect_row(
                    issues,
                    &fields,
                    Text { trim: true, lowercase: true, format: None, min: None, max: Some(320) },
                    &mut item_refine,
                );
                for key in item_refine {
                    issues.custom(&key, "At most 50 custom fields");
                }
                Some(row)
            })
            .into_option();
        let list_id = issues.text_with(body, "listId", Presence::Optional, Text::length(None, Some(30))).into_option();
        let list_name = issues.text_with(body, "listName", Presence::Optional, Text::trimmed(Some(1), Some(200))).into_option();
        let source_ref = issues.text_with(body, "sourceRef", Presence::Optional, Text::length(None, Some(255))).into_option();
        refine.clear();
        (rows.unwrap_or_default(), list_id, list_name, source_ref)
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    let http = caller.http(&state);
    let limits = limits_of(&caller);
    let sink = caller.sink(&state);
    let deps = ProspectDeps {
        db: &caller.db,
        emit: &sink,
        user_id: &caller.user_id,
        allow_consumer: limits.allow_consumer_recipients,
        http: Some(&http),
    };
    respond(
        prospects::import_rows(&deps, &input.0, input.1.as_deref(), input.2.as_deref(), input.3.as_deref())
            .await
            .map(|r| Data(r).into_response()),
    )
}

/// `import-crm-list` and `import-welddata`.
async fn import_source(
    state: &ReachState,
    caller: &Caller,
    headers: &HeaderMap,
    body: &Bytes,
    source: &str,
    id_key: &str,
) -> Response {
    let input = match validate(headers, body, |issues, body| {
        let id = issues.text_with(body, id_key, Presence::Required, Text::length(Some(1), Some(30))).into_option();
        let name = issues.text_with(body, "listName", Presence::Optional, Text::trimmed(Some(1), Some(200))).into_option();
        (id, name)
    }) {
        Ok((Some(id), name)) => (id, name),
        Ok(_) => return ApiError::internal().into_response(),
        Err(response) => return response,
    };
    let allowed = if source == "crm_list" {
        caller.permissions.has_any(&[perm::LISTS_READ]) && caller.permissions.has_any(&[perm::PEOPLE_READ])
    } else {
        caller.permissions.has_any(&[perm::LISTS_READ])
    };
    if !allowed {
        let message = if source == "crm_list" {
            "Importing a CRM list needs read access to CRM lists and people"
        } else {
            "Importing a WeldData list needs read access to its lists"
        };
        return ApiError::forbidden().with_message(message).into_response();
    }
    let http = caller.http(state);
    let limits = limits_of(caller);
    let sink = caller.sink(state);
    let deps = ProspectDeps {
        db: &caller.db,
        emit: &sink,
        user_id: &caller.user_id,
        allow_consumer: limits.allow_consumer_recipients,
        http: Some(&http),
    };
    respond(
        prospects::import_source_list(&deps, source, &input.0, input.1.as_deref())
            .await
            .map(|r| Data(r).into_response()),
    )
}

async fn import_crm_list(State(state): State<ReachState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    import_source(&state, &caller, &headers, &body, "crm_list", "crmListId").await
}

async fn import_welddata(State(state): State<ReachState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    import_source(&state, &caller, &headers, &body, "welddata", "welddataListId").await
}
