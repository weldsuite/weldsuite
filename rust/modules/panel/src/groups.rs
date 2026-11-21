//! `/api/panel/groups` (`routes/groups/index.ts`, `services/groups.ts`):
//! group profiles (a company, an account) from the project state
//! ([`PanelProjectState`]), and their activity from the analytics engine,
//! read through the events that carry `$group_<type>`.
//!
//!   GET    /             → ?projectId&type: one type's groups (cursor, `search`)   (`panel_people:read`)
//!   GET    /:type/:key   → profile, recent events, members, the WeldCRM company (`?projectId&days`)
//!   DELETE /:type/:key   → deletes the profile (`panel_people:delete`, `?projectId`)
//!
//! The WeldCRM company is looked up only for callers who can read companies
//! (`companies:read`, own companies unless `companies:scope:all`). Group
//! profiles are tracked visitor-side data, like people: they never go on
//! the entity bus (EVT-005).

use std::sync::{Arc, LazyLock};

use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use regex::Regex;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::{COMPANIES_READ, COMPANIES_SCOPE_ALL};
use weldsuite_kit::{ApiError, Data, List, NoContent, Pagination};
use weldsuite_panel_domain::js;
use weldsuite_panel_domain::query::scope::{ScopeOptions, events_scope};
use weldsuite_panel_domain::query::sql::lit;
use weldsuite_panel_domain::query::time::resolve_range;
use weldsuite_panel_domain::query::{PanelQueryContext, PanelSqlQuery, Runner};
use weldsuite_panel_domain::schemas::{DateRange, PanelFilter};
use weldsuite_permissions::Permissions;
use weldsuite_zod::{Hook, Keys, N, S, Z};

use crate::people::events_from;
use crate::project_state::{
    DeleteGroupInput, Group, ListGroupsInput, PanelProjectState, ProjectRef,
};
use crate::projects::live_project;
use crate::query::QueryDeps;
use crate::recordings::{Failure, iso_of, js_number, number_of, session_context, text_of, today};
use crate::schemas_gen::PANEL_GROUP_TYPE;
use crate::{Caller, PanelState, unexpected};

const RECENT_EVENTS: i64 = 25;
const TOP_MEMBERS: i64 = 50;
const CRM_CANDIDATES: i64 = 20;
const DAY_MS: i64 = 86_400_000;

/// A recent event that is worth a line in a feed: not a page leave or an identity link.
const FEED_EXCLUDED: [&str; 2] = ["$pageleave", "$identify"];

const PROJECT_ID: Z = Z::Str(&[S::Min(1, None), S::Max(30, None)]);

/// `panelGroupKeySchema`'s refinement: no control characters.
fn refine_group_key(value: Option<&Value>, hook: &mut Hook) {
    if let Some(text) = value.and_then(Value::as_str)
        && !text
            .chars()
            .all(|c| u32::from(c) >= 0x20 && u32::from(c) != 0x7f)
    {
        hook.fail("Not a valid group key");
    }
}

/// `groupParams`: `:type` is the collector's `GROUP_TYPE`, `:key` a group key.
const GROUP_PARAMS: Z = Z::Obj(
    &[
        (
            "type",
            Z::Str(&[S::Regex(
                "^[a-z][a-z0-9_]{0,31}$",
                Some("Not a valid group type"),
            )]),
        ),
        (
            "key",
            Z::Refine(
                &Z::Str(&[S::Min(1, None), S::Max(255, None)]),
                refine_group_key,
            ),
        ),
    ],
    Keys::Strip,
);

/// `panelGroupListQuerySchema`.
const LIST_QUERY: Z = Z::Obj(
    &[
        ("projectId", PROJECT_ID),
        ("type", PANEL_GROUP_TYPE),
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
    ],
    Keys::Strip,
);

/// `panelGroupProfileQuerySchema`.
const PROFILE_QUERY: Z = Z::Obj(
    &[
        ("projectId", PROJECT_ID),
        (
            "days",
            Z::Def(
                &Z::CoerceNum(&[
                    N::Int(None),
                    N::Min(7.0, true, None),
                    N::Max(365.0, true, None),
                ]),
                "90",
            ),
        ),
    ],
    Keys::Strip,
);

/// `panelGroupDeleteQuerySchema`.
const DELETE_QUERY: Z = Z::Obj(&[("projectId", PROJECT_ID)], Keys::Strip);

/// The project state, or the 503 of panel-api without `PANEL_PROJECT`.
fn require_state(
    caller: &Caller,
    state: &PanelState,
) -> Result<Arc<dyn PanelProjectState>, Failure> {
    caller
        .project_state(state)
        .ok_or_else(|| Failure::unavailable("Groups are not configured here"))
}

/// `zValidator('param', groupParams)`: the type and the key, or the 400.
fn group_params(group_type: &str, key: &str) -> Result<(String, String), Box<Response>> {
    let params = json!({ "type": group_type, "key": key });
    let parsed = weldsuite_zod::parse(&GROUP_PARAMS, &params).map_err(Box::new)?;
    Ok((
        parsed.text("type").unwrap_or_default().to_owned(),
        parsed
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    ))
}

async fn require_project(caller: &Caller, project_id: &str) -> Result<(), Box<Response>> {
    match live_project(caller, project_id).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(Box::new(
            ApiError::not_found("Project", Some(project_id)).into_response(),
        )),
        Err(error) => Err(Box::new(unexpected(&error, "get project"))),
    }
}

/// The `$name` or `name` property, if it is non-blank text.
fn display_name(properties: &Map<String, Value>) -> Option<String> {
    ["$name", "name"].iter().find_map(|key| {
        properties
            .get(*key)
            .and_then(Value::as_str)
            .filter(|value| !js::trim(value).is_empty())
            .map(str::to_owned)
    })
}

/// `toGroupDto`.
fn group_dto(group: &Group) -> Value {
    json!({
        "groupType": group.group_type,
        "groupKey": group.group_key,
        "name": display_name(&group.properties),
        "properties": group.properties,
        "firstSeen": group.first_seen,
        "lastSeen": group.last_seen,
    })
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

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
    if let Err(response) = require_project(&caller, &project_id).await {
        return *response;
    }
    let search = parsed
        .get("search")
        .and_then(Value::as_str)
        .map(js::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "Zod checked a whole number from 1 to 100"
    )]
    let limit = parsed
        .get("limit")
        .and_then(Value::as_f64)
        .map_or(50, |limit| limit as u32);
    let input = ListGroupsInput {
        group_type: parsed.text("type").unwrap_or_default().to_owned(),
        search,
        cursor: Some(
            parsed
                .get("cursor")
                .and_then(Value::as_str)
                .map(str::to_owned),
        ),
        limit,
    };
    let page = async {
        let project_state = require_state(&caller, &state)?;
        Ok::<_, Failure>(
            project_state
                .list_groups(
                    ProjectRef {
                        workspace_id: &caller.workspace_id,
                        project_id: &project_id,
                    },
                    &input,
                )
                .await?,
        )
    };
    match page.await {
        Ok(page) => {
            let has_more = page.cursor.is_some();
            List::new(
                page.groups.iter().map(group_dto).collect(),
                Pagination::new(page.total_count, has_more, page.cursor),
            )
            .into_response()
        }
        Err(failure) => failure.into_response(),
    }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/// How the caller may see WeldCRM companies: `None` without
/// `companies:read`, else only their own unless `companies:scope:all`.
struct CrmLookup {
    owner_scope: Option<String>,
}

fn crm_lookup_for(caller: &Caller, permissions: &Permissions) -> Option<CrmLookup> {
    if !permissions.has_any(&[COMPANIES_READ]) {
        return None;
    }
    if permissions.has_any(&[COMPANIES_SCOPE_ALL]) {
        return Some(CrmLookup { owner_scope: None });
    }
    (!caller.user_id.is_empty()).then(|| CrmLookup {
        owner_scope: Some(caller.user_id.clone()),
    })
}

/// The last `days` days (today included), within the plan's retention.
fn last_days(
    ctx: &PanelQueryContext,
    days: i64,
) -> Result<weldsuite_panel_domain::query::time::ResolvedRange, Failure> {
    let now = ctx.now.unwrap_or_else(js::now_millis);
    Ok(resolve_range(
        &DateRange::Custom {
            from: today(now - (days - 1) * DAY_MS),
            to: today(now),
        },
        "UTC",
        ctx,
    )?)
}

/// `groupActivityQueries`: the group's recent events, its counts (events,
/// people, first and last event) and its most recently seen people.
fn group_activity_queries(
    ctx: &PanelQueryContext,
    group_type: &str,
    group_key: &str,
    days: i64,
) -> Result<Vec<PanelSqlQuery>, Failure> {
    let range = last_days(ctx, days)?;
    let filters: Vec<PanelFilter> = vec![
        serde_json::from_value(json!({
            "source": "event",
            "key": format!("$group_{group_type}"),
            "operator": "eq",
            "value": group_key,
        }))
        .map_err(Failure::upstream)?,
    ];
    let scope = events_scope(
        ctx,
        &range,
        range.bounds(),
        ScopeOptions {
            filters: Some(&filters),
            ..ScopeOptions::default()
        },
    )?;
    let excluded = FEED_EXCLUDED
        .iter()
        .map(|name| lit(name))
        .collect::<Result<Vec<_>, _>>()?;
    let feed = format!("e.name NOT IN ({})", excluded.join(", "));
    let columns = |names: &[&str]| names.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>();
    Ok(vec![
        PanelSqlQuery {
            name: "groups.events".to_owned(),
            sql: format!(
                "SELECT e.event_id AS event_id, e.name AS name, e.ts AS ts, e.path AS path, e.url AS url, e.title AS title, e.session_id AS session_id, \
                 e.el_text AS el_text, e.error_message AS error_message, e.properties AS properties \
                 FROM {} {} ORDER BY e.ts DESC LIMIT {RECENT_EVENTS}",
                scope.from,
                scope.where_sql(&[feed])
            ),
            columns: columns(&[
                "event_id",
                "name",
                "ts",
                "path",
                "url",
                "title",
                "session_id",
                "el_text",
                "error_message",
                "properties",
            ]),
        },
        PanelSqlQuery {
            name: "groups.stats".to_owned(),
            sql: format!(
                "SELECT COUNT(*) AS n, COUNT(DISTINCT {}) AS members, MIN(e.ts) AS first_seen, MAX(e.ts) AS last_seen FROM {} {}",
                scope.person,
                scope.from,
                scope.where_base()
            ),
            columns: columns(&["n", "members", "first_seen", "last_seen"]),
        },
        PanelSqlQuery {
            name: "groups.members".to_owned(),
            sql: format!(
                "SELECT {person} AS person, MAX(e.ts) AS last_seen, COUNT(*) AS n FROM {} {} GROUP BY {person} ORDER BY MAX(e.ts) DESC LIMIT {TOP_MEMBERS}",
                scope.from,
                scope.where_base(),
                person = scope.person,
            ),
            columns: columns(&["person", "last_seen", "n"]),
        },
    ])
}

static DOMAIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
        .expect("a valid pattern")
});

/// `domainOf`: `acme.com` from `acme.com`, `https://www.acme.com/about` or
/// `ceo@acme.com`; `None` when the value is none of those.
pub(crate) fn domain_of(value: Option<&str>) -> Option<String> {
    let text = js::trim(value.unwrap_or_default()).to_lowercase();
    if text.is_empty() || text.chars().any(js::is_js_whitespace) {
        return None;
    }
    let candidate = match text.rfind('@') {
        Some(at) if !text.contains("://") => &text[at + 1..],
        _ => text.as_str(),
    };
    let has_scheme = {
        let mut chars = candidate.chars();
        chars.next().is_some_and(|c| c.is_ascii_lowercase())
            && candidate.split_once("://").is_some_and(|(scheme, _)| {
                scheme.chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-')
                })
            })
    };
    let url = if has_scheme {
        candidate.to_owned()
    } else {
        format!("https://{candidate}")
    };
    let parsed = url::Url::parse(&url).ok()?;
    let host = parsed.host_str()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    DOMAIN.is_match(host).then(|| host.to_owned())
}

/// `escapeLike`: `\`, `%` and `_` escaped with a backslash.
fn escape_like(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `(id, display_name, website, email)` of a company.
type CompanyRow = (String, String, Option<String>, Option<String>);

fn company_dto(company: &CompanyRow) -> Value {
    json!({ "id": company.0, "name": company.1, "domain": domain_of(company.2.as_deref()) })
}

/// `matchCrmCompany`: a live company whose website host or email domain is
/// the value's domain, else whose name or display name equals the value
/// (case-insensitive). Oldest first on ties.
async fn match_crm_company(
    caller: &Caller,
    value: &str,
    lookup: &CrmLookup,
) -> Result<Option<Value>, sqlx::Error> {
    let needle = js::trim(value);
    if needle.is_empty() {
        return Ok(None);
    }
    let owner = lookup.owner_scope.as_deref();
    if let Some(domain) = domain_of(Some(needle)) {
        let like = escape_like(&domain);
        let candidates: Vec<CompanyRow> = sqlx::query_as(
            "select id, display_name, website, email from companies
             where deleted_at is null and ($1::text is null or owner_id = $1)
               and (website ilike $2 or email ilike $3)
             order by created_at asc, id asc limit $4",
        )
        .bind(owner)
        .bind(format!("%{like}%"))
        .bind(format!("%@{like}"))
        .bind(CRM_CANDIDATES)
        .fetch_all(&caller.db)
        .await?;
        let hit = candidates
            .iter()
            .find(|c| domain_of(c.2.as_deref()).as_deref() == Some(domain.as_str()))
            .or_else(|| {
                candidates.iter().find(|c| {
                    c.3.is_some() && domain_of(c.3.as_deref()).as_deref() == Some(domain.as_str())
                })
            });
        if let Some(hit) = hit {
            return Ok(Some(company_dto(hit)));
        }
    }
    let lower = needle.to_lowercase();
    let by_name: Option<CompanyRow> = sqlx::query_as(
        "select id, display_name, website, email from companies
         where deleted_at is null and ($1::text is null or owner_id = $1)
           and (lower(display_name) = $2 or lower(name) = $2)
         order by created_at asc, id asc limit 1",
    )
    .bind(owner)
    .bind(&lower)
    .fetch_optional(&caller.db)
    .await?;
    Ok(by_name.as_ref().map(company_dto))
}

/// Which group's profile, over how many days.
#[derive(Clone, Copy)]
struct GroupAsked<'a> {
    project_id: &'a str,
    group_type: &'a str,
    group_key: &'a str,
    days: i64,
}

/// `loadGroupProfile`: `None` when the project state has no such group and
/// no event in the window names it.
async fn load_group_profile(
    caller: &Caller,
    panel: &PanelState,
    deps: &QueryDeps,
    asked: GroupAsked<'_>,
    crm: Option<&CrmLookup>,
) -> Result<Option<Value>, Failure> {
    let GroupAsked {
        project_id,
        group_type,
        group_key,
        days,
    } = asked;
    let project_state = require_state(caller, panel)?;
    let engine = deps.engine()?;
    let project = ProjectRef {
        workspace_id: &caller.workspace_id,
        project_id,
    };
    let type_row = async {
        sqlx::query_scalar::<_, Option<String>>(
            "select crm_match_property from panel_group_types
             where project_id = $1 and group_type = $2 limit 1",
        )
        .bind(project_id)
        .bind(group_type)
        .fetch_optional(&caller.db)
        .await
    };
    let (group, match_property, ctx) = futures_util::join!(
        project_state.get_group(project, group_type, group_key),
        type_row,
        session_context(deps, project_id, Map::new())
    );
    let group = group?;
    let match_property = match_property?.flatten();
    let ctx = ctx?;
    let rows = Runner::new(&engine)
        .run(&group_activity_queries(&ctx, group_type, group_key, days)?)
        .await?;
    let empty = Vec::new();
    let event_rows = rows.first().unwrap_or(&empty);
    let stat_row = rows.get(1).and_then(|rows| rows.first());
    let member_rows = rows.get(2).unwrap_or(&empty);

    let stat = |key: &str| stat_row.and_then(|row| row.get(key));
    let event_count = number_of(stat("n"));
    if group.is_none() && event_count == 0.0 {
        return Ok(None);
    }
    let recent_events = events_from(event_rows)?;
    let mut members = Vec::new();
    for row in member_rows {
        let distinct_id = text_of(row.get("person"));
        let last_seen = iso_of(row.get("last_seen"))?;
        if !distinct_id.is_empty() {
            members.push(json!({
                "distinctId": distinct_id,
                "lastSeen": last_seen,
                "eventCount": js_number(number_of(row.get("n"))),
            }));
        }
    }

    let match_value = match (&group, &match_property) {
        (Some(group), Some(property)) => group.properties.get(property),
        _ => None,
    };
    let crm_company = match (crm, match_value) {
        (Some(lookup), Some(Value::String(text))) => {
            match_crm_company(caller, text, lookup).await?
        }
        (Some(lookup), Some(Value::Number(number))) => {
            let text = js::number_text(number.as_f64().unwrap_or(f64::NAN));
            match_crm_company(caller, &text, lookup).await?
        }
        _ => None,
    };

    let group_json = match &group {
        Some(group) => group_dto(group),
        None => json!({
            "groupType": group_type,
            "groupKey": group_key,
            "name": null,
            "properties": {},
            "firstSeen": iso_of(stat("first_seen"))?,
            "lastSeen": iso_of(stat("last_seen"))?,
        }),
    };
    Ok(Some(json!({
        "projectId": project_id,
        "group": group_json,
        "hasProfile": group.is_some(),
        "days": days,
        "recentEvents": recent_events,
        "eventCount": js_number(event_count),
        "members": members,
        "memberCount": js_number(number_of(stat("members"))),
        "crmCompany": crm_company,
    })))
}

/// `GET /:type/:key`.
pub(crate) async fn profile(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    Path((raw_type, raw_key)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Response {
    let (group_type, group_key) = match group_params(&raw_type, &raw_key) {
        Ok(params) => params,
        Err(response) => return *response,
    };
    let parsed = match weldsuite_zod::query(&PROFILE_QUERY, raw.as_deref()) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let project_id = parsed.text("projectId").unwrap_or_default().to_owned();
    #[allow(
        clippy::cast_possible_truncation,
        reason = "Zod checked a whole number from 7 to 365"
    )]
    let days = parsed
        .get("days")
        .and_then(Value::as_f64)
        .map_or(90, |days| days as i64);
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    if let Err(response) = require_project(&caller, &project_id).await {
        return *response;
    }
    let crm = crm_lookup_for(&caller, &permissions);
    let deps = QueryDeps::new(&caller, &state);
    let asked = GroupAsked {
        project_id: &project_id,
        group_type: &group_type,
        group_key: &group_key,
        days,
    };
    match load_group_profile(&caller, &state, &deps, asked, crm.as_ref()).await {
        Ok(Some(profile)) => Data(profile).into_response(),
        Ok(None) => ApiError::not_found("Group", Some(&group_key)).into_response(),
        Err(failure) => failure.into_response(),
    }
}

/// `DELETE /:type/:key`: the project state writes the `deleted` row to
/// `groups_v1`; nothing goes on the entity bus.
pub(crate) async fn remove(
    State(state): State<PanelState>,
    caller: Caller,
    Path((raw_type, raw_key)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Response {
    let (group_type, group_key) = match group_params(&raw_type, &raw_key) {
        Ok(params) => params,
        Err(response) => return *response,
    };
    let parsed = match weldsuite_zod::query(&DELETE_QUERY, raw.as_deref()) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let project_id = parsed.text("projectId").unwrap_or_default().to_owned();
    if caller.workspace_id.is_empty() {
        return ApiError::org_required().into_response();
    }
    if let Err(response) = require_project(&caller, &project_id).await {
        return *response;
    }
    let deleted = async {
        let project_state = require_state(&caller, &state)?;
        Ok::<_, Failure>(
            project_state
                .delete_group(
                    ProjectRef {
                        workspace_id: &caller.workspace_id,
                        project_id: &project_id,
                    },
                    &DeleteGroupInput {
                        workspace_id: caller.workspace_id.clone(),
                        project_id: project_id.clone(),
                        group_type: group_type.clone(),
                        group_key: group_key.clone(),
                    },
                )
                .await?,
        )
    };
    match deleted.await {
        Ok(true) => NoContent.into_response(),
        Ok(false) => ApiError::not_found("Group", Some(&group_key)).into_response(),
        Err(failure) => failure.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_domain_from_a_host_a_url_or_an_email() {
        assert_eq!(domain_of(Some("acme.com")).as_deref(), Some("acme.com"));
        assert_eq!(
            domain_of(Some("https://www.Acme.com/about")).as_deref(),
            Some("acme.com")
        );
        assert_eq!(
            domain_of(Some("ceo@acme.co.uk")).as_deref(),
            Some("acme.co.uk")
        );
        assert_eq!(domain_of(Some("Acme Inc.")), None);
        assert_eq!(domain_of(Some("acme")), None);
        assert_eq!(domain_of(Some("")), None);
        assert_eq!(domain_of(None), None);
    }

    #[test]
    fn group_keys_refuse_control_characters() {
        assert!(group_params("company", "acme").is_ok());
        assert!(group_params("company", "o'brien/1").is_ok());
        assert!(group_params("company", "a\u{7}b").is_err());
        assert!(group_params("Bad-Type", "acme").is_err());
    }
}
