//! `/api/panel/people` (`routes/people/index.ts`, `services/people.ts`):
//! profiles from the project state ([`PanelProjectState`], the
//! `PanelProject` Durable Object on Global), with what the analytics engine
//! knows about them (recent events, sessions, event counts).
//!
//!   GET    /               → list and search (cursor); `?cohortId` narrows to a cohort (`panel_people:read`)
//!   GET    /by-email       → profiles with that email in any project, for the WeldCRM card
//!   GET    /:distinctId    → profile, recent events, recordings (`?projectId`)
//!   DELETE /:distinctId    → GDPR erasure (`panel_people:delete`, `?projectId`)
//!
//! `by-email` also opens for `people:read` (the WeldCRM person card asks it
//! for someone the caller can already see in the CRM); recordings stay
//! behind `panel_recordings:read` there. Visitor data never goes on the
//! entity bus (EVT-005), so erasure publishes no event.

use std::sync::Arc;

use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::PANEL_RECORDINGS_READ;
use weldsuite_kit::{ApiError, Data, List, Pagination};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::activity::{
    ActivityOptions, activity_count_query, activity_event_from, activity_query,
};
use weldsuite_panel_domain::query::scope::{ScopeOptions, events_scope};
use weldsuite_panel_domain::query::time::resolve_range;
use weldsuite_panel_domain::query::{PanelQueryContext, PanelSqlQuery, Row, Runner};
use weldsuite_panel_domain::schemas::PanelFilter;
use weldsuite_permissions::Permissions;
use weldsuite_zod::{Keys, N, S, Z};

use crate::engine::Engine;
use crate::erasure::{EraseDeps, EraseFailure, erase_person, incomplete};
use crate::project_state::{ListPeopleInput, PanelProjectState, Person, ProjectRef};
use crate::projects::live_project;
use crate::query::QueryDeps;
use crate::recordings::{
    Bindings, Failure, full_date_range, mark_favorites, number_of, overrides, session_context,
    sessions_rows, sessions_spec, text_of,
};
use crate::{Caller, PanelState, unexpected};

const RECENT_EVENTS: i64 = 25;
const PROFILE_SESSIONS: i64 = 10;
const CARD_EVENTS: i64 = 10;
const CARD_SESSIONS: i64 = 5;
const MAX_CARD_PROJECTS: usize = 25;
const MAX_COHORT_REACH: usize = 500;

/// A recent event that is worth a line in a feed: not a page leave or an identity link.
const FEED_EXCLUDED: [&str; 2] = ["$pageleave", "$identify"];

const PROJECT_ID: Z = Z::Str(&[S::Min(1, None), S::Max(30, None)]);

/// `listQuery`.
const LIST_QUERY: Z = Z::Obj(
    &[
        ("projectId", PROJECT_ID),
        ("search", Z::Opt(&Z::Str(&[S::Trim, S::Max(200, None)]))),
        ("cursor", Z::Opt(&Z::Nul(&Z::Str(&[S::Max(500, None)])))),
        (
            "limit",
            Z::Def(
                &Z::CoerceNum(&[
                    N::Int(None),
                    N::Min(1.0, true, None),
                    N::Max(100.0, true, None),
                ]),
                "50",
            ),
        ),
        (
            "cohortId",
            Z::Opt(&Z::Str(&[S::Min(1, None), S::Max(30, None)])),
        ),
    ],
    Keys::Strip,
);

/// `byEmailQuery`.
const BY_EMAIL_QUERY: Z = Z::Obj(
    &[(
        "email",
        Z::Str(&[S::Trim, S::Min(3, None), S::Max(320, None)]),
    )],
    Keys::Strip,
);

/// `projectQuery`.
pub(crate) const PROJECT_QUERY: Z = Z::Obj(&[("projectId", PROJECT_ID)], Keys::Strip);

/// `z.string().min(1).max(255)` of the path's person id; `None` when it is not one.
fn distinct(raw: &str) -> Option<String> {
    let length = js::utf16_len(raw);
    (1..=255).contains(&length).then(|| raw.to_owned())
}

/// The project state, or the 503 of panel-api without `PANEL_PROJECT`.
fn require_state(
    caller: &Caller,
    state: &PanelState,
) -> Result<Arc<dyn PanelProjectState>, Failure> {
    caller
        .project_state(state)
        .ok_or_else(|| Failure::unavailable("People are not configured here"))
}

fn person_json(person: &Person) -> Value {
    serde_json::to_value(person).unwrap_or(Value::Null)
}

/// `activityEventFrom` of each row; an error where JavaScript throws.
pub(crate) fn events_from(rows: &[Row]) -> Result<Vec<Value>, Failure> {
    rows.iter()
        .map(|row| {
            activity_event_from(row)
                .map(|event| js::json_numbers(serde_json::to_value(event).unwrap_or(Value::Null)))
                .ok_or_else(|| Failure::Upstream("Invalid time value".to_owned()))
        })
        .collect()
}

fn feed_options(distinct_id: &str, limit: i64) -> ActivityOptions {
    ActivityOptions {
        distinct_id: Some(distinct_id.to_owned()),
        limit,
        days: Some(90),
        exclude_names: Some(FEED_EXCLUDED.map(str::to_owned).to_vec()),
        ..ActivityOptions::default()
    }
}

/// `sessionsOf`: the person's recordings, newest first, with favourites.
async fn sessions_of(
    caller: &Caller,
    engine: &Engine,
    ctx: &PanelQueryContext,
    distinct_id: &str,
    limit: i64,
) -> Result<Vec<Value>, Failure> {
    let spec = sessions_spec(
        &ctx.project_id,
        overrides([("distinctId", json!(distinct_id)), ("limit", json!(limit))]),
    )?;
    let sessions = sessions_rows(&spec, ctx, engine).await?;
    Ok(mark_favorites(caller, &ctx.project_id, sessions).await?)
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

struct PeopleInput {
    search: Option<String>,
    cursor: Option<String>,
    limit: u32,
    cohort_id: Option<String>,
}

struct PeoplePage {
    people: Vec<Value>,
    cursor: Option<String>,
    has_more: bool,
    total_count: u64,
}

fn matches_search(person: &Person, search: &str) -> bool {
    let needle = search.to_lowercase();
    [
        Some(person.user_id.as_str()),
        person.email.as_deref(),
        person.name.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| value.to_lowercase().contains(&needle))
}

/// `parseOffset`: `o<n>` of a cohort page.
fn parse_offset(cursor: Option<&str>) -> Result<usize, Failure> {
    let Some(cursor) = cursor.filter(|c| !c.is_empty()) else {
        return Ok(0);
    };
    let digits = cursor
        .strip_prefix('o')
        .filter(|d| (1..=4).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_digit()));
    digits
        .and_then(|d| d.parse().ok())
        .ok_or_else(|| Failure::Query("Invalid cursor".to_owned()))
}

/// `cohortPeople`: the people of a cohort, most recently seen first: the ids
/// the engine finds, read as profiles from the project state.
async fn cohort_people(
    caller: &Caller,
    panel: &PanelState,
    deps: &QueryDeps,
    project_id: &str,
    input: &PeopleInput,
    cohort_id: &str,
) -> Result<PeoplePage, Failure> {
    let state = require_state(caller, panel)?;
    let offset = parse_offset(input.cursor.as_deref())?;
    let limit = input.limit as usize;
    if offset + limit > MAX_COHORT_REACH {
        return Err(Failure::Query(
            "Narrow the search to see further".to_owned(),
        ));
    }

    // A sessions spec names the cohort, so the context loads its definition.
    let ctx = session_context(
        deps,
        project_id,
        overrides([("cohortId", json!(cohort_id))]),
    )
    .await?;
    let range = resolve_range(&full_date_range(ctx.now), "UTC", &ctx)?;
    let filters: Vec<PanelFilter> = vec![
        serde_json::from_value(json!({ "source": "cohort", "cohortId": cohort_id }))
            .map_err(Failure::upstream)?,
    ];
    let scope = events_scope(
        &ctx,
        &range,
        range.bounds(),
        ScopeOptions {
            filters: Some(&filters),
            ..ScopeOptions::default()
        },
    )?;
    let engine = deps.engine()?;
    let rows = Runner::new(&engine)
        .run_one(PanelSqlQuery {
            name: "people.cohort".to_owned(),
            sql: format!(
                "SELECT {person} AS person, MAX(e.ts) AS last_seen FROM {} {} GROUP BY {person} ORDER BY MAX(e.ts) DESC LIMIT {}",
                scope.from,
                scope.where_base(),
                MAX_COHORT_REACH + 1,
                person = scope.person,
            ),
            columns: vec!["person".to_owned(), "last_seen".to_owned()],
        })
        .await?;

    let ids: Vec<String> = rows
        .iter()
        .map(|row| text_of(row.get("person")))
        .filter(|id| !id.is_empty())
        .collect();
    let project = ProjectRef {
        workspace_id: &caller.workspace_id,
        project_id,
    };
    let found = futures_util::future::try_join_all(
        ids.iter().map(|id| state.get_person(project, id.as_str())),
    )
    .await?;
    // `new Map(profiles.map(p => [p.userId, p]))`: first position, last value.
    let mut unique: Vec<Person> = Vec::new();
    for person in found.into_iter().flatten() {
        match unique.iter_mut().find(|p| p.user_id == person.user_id) {
            Some(slot) => *slot = person,
            None => unique.push(person),
        }
    }
    let matching: Vec<Person> = match input.search.as_deref().map(js::trim) {
        Some(search) if !search.is_empty() => unique
            .into_iter()
            .filter(|p| matches_search(p, input.search.as_deref().unwrap_or_default()))
            .collect(),
        _ => unique,
    };
    let has_more = matching.len() > offset + limit;
    let people = matching
        .iter()
        .skip(offset)
        .take(limit)
        .map(person_json)
        .collect();
    Ok(PeoplePage {
        people,
        cursor: has_more.then(|| format!("o{}", offset + limit)),
        has_more,
        total_count: matching.len() as u64,
    })
}

/// `listPeople`.
async fn list_people(
    caller: &Caller,
    panel: &PanelState,
    deps: &QueryDeps,
    project_id: &str,
    input: &PeopleInput,
) -> Result<PeoplePage, Failure> {
    if let Some(cohort_id) = &input.cohort_id {
        return cohort_people(caller, panel, deps, project_id, input, cohort_id).await;
    }
    let state = require_state(caller, panel)?;
    let search = input
        .search
        .as_deref()
        .map(js::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let page = state
        .list_people(
            ProjectRef {
                workspace_id: &caller.workspace_id,
                project_id,
            },
            &ListPeopleInput {
                search,
                cursor: Some(input.cursor.clone()),
                limit: input.limit,
            },
        )
        .await?;
    Ok(PeoplePage {
        people: page.people.iter().map(person_json).collect(),
        has_more: page.cursor.is_some(),
        cursor: page.cursor,
        total_count: page.total_count,
    })
}

/// `GET /`.
pub(crate) async fn list(
    State(state): State<PanelState>,
    caller: Caller,
    RawQuery(raw): RawQuery,
) -> Response {
    let parsed = match weldsuite_zod::query(&LIST_QUERY, raw.as_deref()) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let project_id = parsed.text("projectId").unwrap_or_default().to_owned();
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    match live_project(&caller, &project_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "get project"),
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "Zod checked a whole number from 1 to 100"
    )]
    let input = PeopleInput {
        search: parsed
            .get("search")
            .and_then(Value::as_str)
            .map(str::to_owned),
        cursor: parsed
            .get("cursor")
            .and_then(Value::as_str)
            .map(str::to_owned),
        limit: parsed
            .get("limit")
            .and_then(Value::as_f64)
            .map_or(50, |limit| limit as u32),
        cohort_id: parsed
            .get("cohortId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    let deps = QueryDeps::new(&caller, &state);
    match list_people(&caller, &state, &deps, &project_id, &input).await {
        Ok(page) => List::new(
            page.people,
            Pagination::new(page.total_count, page.has_more, page.cursor),
        )
        .into_response(),
        Err(failure) => failure.into_response(),
    }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/// `loadProfile`: `None` when the project state has no such person (never
/// seen, or erased).
async fn load_profile(
    caller: &Caller,
    panel: &PanelState,
    deps: &QueryDeps,
    project_id: &str,
    distinct_id: &str,
    include_sessions: bool,
) -> Result<Option<Value>, Failure> {
    let state = require_state(caller, panel)?;
    let project = ProjectRef {
        workspace_id: &caller.workspace_id,
        project_id,
    };
    let Some(person) = state.get_person(project, distinct_id).await? else {
        return Ok(None);
    };
    let ctx = session_context(deps, project_id, Map::new()).await?;
    let engine = deps.engine()?;
    let queries = [
        activity_query(&ctx, &feed_options(&person.user_id, RECENT_EVENTS))?,
        activity_count_query(&ctx, &person.user_id, 90)?,
    ];
    let runner = Runner::new(&engine);
    let (activity, sessions) = futures_util::join!(runner.run(&queries), async {
        if include_sessions {
            sessions_of(caller, &engine, &ctx, &person.user_id, PROFILE_SESSIONS).await
        } else {
            Ok(Vec::new())
        }
    });
    let activity = activity?;
    let sessions = sessions?;
    let recent_events = events_from(activity.first().map_or(&[][..], Vec::as_slice))?;
    let count = activity
        .get(1)
        .and_then(|rows| rows.first())
        .and_then(|row| row.get("n"));
    Ok(Some(json!({
        "projectId": project_id,
        "person": person_json(&person),
        "recentEvents": recent_events,
        "sessions": sessions,
        "eventCount90d": crate::recordings::js_number(number_of(count)),
    })))
}

/// `GET /:distinctId`.
pub(crate) async fn detail(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path(raw_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let parsed = match weldsuite_zod::query(&PROJECT_QUERY, raw.as_deref()) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let project_id = parsed.text("projectId").unwrap_or_default().to_owned();
    let Some(id) = distinct(&raw_id) else {
        return ApiError::bad_request("Invalid person id").into_response();
    };
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    match live_project(&caller, &project_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "get project"),
    }
    let include_sessions = permissions.has_any(&[PANEL_RECORDINGS_READ]);
    let deps = QueryDeps::new(&caller, &state);
    match load_profile(&caller, &state, &deps, &project_id, &id, include_sessions).await {
        Ok(Some(profile)) => Data(profile).into_response(),
        Ok(None) => ApiError::not_found("Person", Some(&id)).into_response(),
        Err(failure) => failure.into_response(),
    }
}

// ---------------------------------------------------------------------------
// By email (the WeldCRM person card)
// ---------------------------------------------------------------------------

/// One profile's recent events and (when allowed) recordings in one
/// project; a failure leaves both empty rather than breaking the card.
async fn card_activity(
    caller: &Caller,
    deps: &QueryDeps,
    project_id: &str,
    person: &Person,
    include_sessions: bool,
) -> Result<(Vec<Value>, Vec<Value>), Failure> {
    let ctx = session_context(deps, project_id, Map::new()).await?;
    let engine = deps.engine()?;
    let query = activity_query(&ctx, &feed_options(&person.user_id, CARD_EVENTS))?;
    let runner = Runner::new(&engine);
    let (rows, sessions) = futures_util::join!(runner.run_one(query), async {
        if include_sessions {
            sessions_of(caller, &engine, &ctx, &person.user_id, CARD_SESSIONS).await
        } else {
            Ok(Vec::new())
        }
    });
    let rows = rows?;
    let sessions = sessions?;
    Ok((events_from(&rows)?, sessions))
}

/// `peopleByEmail`: profiles in any of the workspace's projects whose
/// `$email` matches, each with its recent events (and recordings when
/// allowed).
async fn people_by_email(
    caller: &Caller,
    panel: &PanelState,
    deps: &QueryDeps,
    email: &str,
    include_sessions: bool,
) -> Result<Value, Failure> {
    let state = require_state(caller, panel)?;
    let needle = js::trim(email).to_lowercase();
    let projects: Vec<(String, String)> = sqlx::query_as(
        "select id, name from panel_projects where deleted_at is null
         order by created_at asc, id asc",
    )
    .fetch_all(&caller.db)
    .await?;
    let projects = &projects[..projects.len().min(MAX_CARD_PROJECTS)];

    let per_project =
        futures_util::future::try_join_all(projects.iter().map(|(project_id, project_name)| {
            let state = Arc::clone(&state);
            let needle = needle.clone();
            async move {
                let found = state
                    .find_by_email(
                        ProjectRef {
                            workspace_id: &caller.workspace_id,
                            project_id,
                        },
                        &needle,
                    )
                    .await?;
                let cards = futures_util::future::join_all(found.iter().map(|person| async move {
                    let (recent_events, sessions) =
                        match card_activity(caller, deps, project_id, person, include_sessions)
                            .await
                        {
                            Ok(activity) => activity,
                            Err(error) => {
                                tracing::warn!(
                                    project = project_id.as_str(),
                                    ?error,
                                    "[panel-api] website activity for the CRM card failed"
                                );
                                (Vec::new(), Vec::new())
                            }
                        };
                    json!({
                        "projectId": project_id,
                        "projectName": project_name,
                        "person": person_json(person),
                        "recentEvents": recent_events,
                        "sessions": sessions,
                    })
                }))
                .await;
                Ok::<_, Failure>(cards)
            }
        }))
        .await?;
    Ok(json!({ "people": per_project.into_iter().flatten().collect::<Vec<_>>() }))
}

/// `GET /by-email`.
pub(crate) async fn by_email(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    RawQuery(raw): RawQuery,
) -> Response {
    let parsed = match weldsuite_zod::query(&BY_EMAIL_QUERY, raw.as_deref()) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let email = parsed
        .get("email")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    let include_sessions = permissions.has_any(&[PANEL_RECORDINGS_READ]);
    let deps = QueryDeps::new(&caller, &state);
    match people_by_email(&caller, &state, &deps, &email, include_sessions).await {
        Ok(body) => Data(body).into_response(),
        Err(failure) => failure.into_response(),
    }
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/// `DELETE /:distinctId`.
pub(crate) async fn erase(
    State(state): State<PanelState>,
    caller: Caller,
    bindings: Bindings,
    Path(raw_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let parsed = match weldsuite_zod::query(&PROJECT_QUERY, raw.as_deref()) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let project_id = parsed.text("projectId").unwrap_or_default().to_owned();
    let Some(id) = distinct(&raw_id) else {
        return ApiError::bad_request("Invalid person id").into_response();
    };
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    match live_project(&caller, &project_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "get project"),
    }
    let deps = QueryDeps::new(&caller, &state);
    let erase = EraseDeps {
        caller: &caller,
        deps: &deps,
        state: caller.project_state(&state),
        replays: bindings.replays(&state),
        queue: bindings.erasure(&caller, &state),
    };
    match erase_person(erase, &project_id, &id).await {
        Ok(result) => Data(result).into_response(),
        Err(EraseFailure::Before(failure)) => failure.into_response(),
        Err(EraseFailure::Incomplete(result)) => {
            (StatusCode::BAD_GATEWAY, axum::Json(incomplete(&result))).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cohort_cursors_are_offsets() {
        assert_eq!(parse_offset(None).ok(), Some(0));
        assert_eq!(parse_offset(Some("o50")).ok(), Some(50));
        assert!(parse_offset(Some("50")).is_err());
        assert!(parse_offset(Some("o12345")).is_err());
        assert_eq!(distinct("anon_1").as_deref(), Some("anon_1"));
        assert!(distinct(&"x".repeat(256)).is_none());
    }
}
