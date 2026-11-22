//! `/api/panel/projects` (`routes/projects/index.ts`, `services/projects.ts`):
//! list, create, read, rename, settings and pausing, soft delete, token
//! rotation and the install check. Every change also updates the master
//! registry row and the cache record the collector reads ([`Registry`]).

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use regex::Regex;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
    UpdateMany,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    PANEL_PROJECT_CREATED, PANEL_PROJECT_DELETED, PANEL_PROJECT_UPDATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Field, Issues, Presence, Text, js_date_iso};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_ports::{Cache, DynCache};
use weldsuite_schema::tenant::panel_projects::{self as projects, Column};

use crate::domain::{
    DEFAULT_HOST, default_settings, generate_project_token, install_snippet, seen_key,
    trim_trailing_slashes, with_setting_defaults,
};
use crate::registry::Registry;
use crate::saved::{instant, js_row, js_rows};
use crate::{Caller, PanelState, unexpected, validate};

/// A project with an event this recent shows as `receiving`.
const RECEIVING_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

const KINDS: &[&str] = &["website", "app"];
const STATUSES: &[&str] = &["active", "paused"];
const MASKING_LEVELS: &[&str] = &["strict", "balanced", "relaxed"];
const CONSENT_MODES: &[&str] = &["required", "none"];

static DOMAIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$|^localhost$").expect("a valid pattern")
});

/// `toProjectDto(project)`.
fn dto(row: &Value) -> Value {
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "name": field("name"),
        "kind": field("kind"),
        "status": field("status"),
        "token": field("token"),
        "allowedDomains": field("allowedDomains"),
        "settings": with_setting_defaults(row.get("settings")),
        "createdByUserId": field("createdByUserId"),
        "createdAt": field("createdAt"),
        "updatedAt": field("updatedAt"),
    })
}

/// `projectEventData(project)`: no token, no settings.
fn event_data(row: &Value) -> Value {
    let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    json!({ "id": field("id"), "name": field("name"), "kind": field("kind"), "status": field("status") })
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `registryFor(c)`: null without a workspace (`error.orgRequired`).
pub(crate) fn registry_for(caller: &Caller, state: &PanelState) -> Result<Registry, Box<Response>> {
    if caller.workspace_id.is_empty() {
        return Err(Box::new(ApiError::org_required().into_response()));
    }
    let (Some(master), Some(cache)) = (caller.master(state), caller.cache(state)) else {
        return Err(Box::new(unexpected(
            &"no master database or cache",
            "project registry",
        )));
    };
    Ok(Registry {
        master,
        cache,
        workspace_id: caller.workspace_id.clone(),
    })
}

/// The `{ ...new Set(values) }` of a list, in first-seen order.
fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

pub(crate) async fn live_project(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    projects::Entity::find_by_id(id)
        .filter(Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(js_row)
        .transpose()
}

/// `id` and `name` of the projects that are not deleted, oldest first.
pub(crate) async fn live_project_names(db: &PgPool) -> Result<Vec<(String, String)>, DbErr> {
    projects::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Name])
        .filter(Column::DeletedAt.is_null())
        .order_by_asc(Column::CreatedAt)
        .order_by_asc(Column::Id)
        .into_tuple()
        .all(&orm(db))
        .await
}

/// An update of a live project, `updatedAt` moved on (`touch`).
fn live_update(id: &str) -> UpdateMany<projects::Entity> {
    projects::Entity::update_many()
        .col_expr(Column::UpdatedAt, bumped_updated_at())
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
}

/// `greatest(now(), updated_at + interval '1 millisecond')`: every change
/// is later than the one before, which the registry orders changes by.
fn bumped_updated_at() -> Expr {
    Func::greatest([
        Expr::current_timestamp(),
        sea_orm::ExprTrait::add(
            Expr::col(Column::UpdatedAt),
            sea_orm::ExprTrait::cast_as(Expr::val("1 millisecond"), "interval"),
        ),
    ])
    .into()
}

/// The row an update returned (`returning`), as Drizzle reads it.
async fn updated(update: UpdateMany<projects::Entity>, db: &PgPool) -> Result<Option<Value>, DbErr> {
    update
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next()
        .map(js_row)
        .transpose()
}

/// `GET /`: the projects that are not deleted, oldest first.
pub(crate) async fn list(caller: Caller) -> Response {
    let rows = projects::Entity::find()
        .filter(Column::DeletedAt.is_null())
        .order_by_asc(Column::CreatedAt)
        .order_by_asc(Column::Id)
        .all(&orm(&caller.db))
        .await
        .and_then(js_rows);
    match rows {
        Ok(rows) => {
            let projects: Vec<Value> = rows.iter().map(dto).collect();
            let count = projects.len() as u64;
            List::new(projects, Pagination::new(count, false, None)).into_response()
        }
        Err(error) => unexpected(&error, "list projects"),
    }
}

/// `z.array(panelDomainSchema)`: each host trimmed and lower-cased, then
/// checked; the list at most `max` long.
fn domains(
    issues: &mut Issues,
    body: &Map<String, Value>,
    presence: Presence,
) -> Field<Vec<String>> {
    issues.list(
        body,
        "allowedDomains",
        presence,
        None,
        Some(20),
        |issues, item| {
            let rules = Text {
                trim: true,
                lowercase: true,
                ..Text::default()
            };
            let host = issues.item_text(item, rules)?;
            if DOMAIN.is_match(&host) {
                Some(host)
            } else {
                issues.issue_here(json!({
                    "validation": "regex",
                    "code": "invalid_string",
                    "message": "Enter a host like example.com",
                }));
                None
            }
        },
    )
}

struct NewProject {
    name: String,
    kind: String,
    allowed_domains: Vec<String>,
}

/// `POST /`: a new project, its token issued and registered with the
/// collector. A project the collector could not be told about is taken back
/// out of both.
pub(crate) async fn create(
    State(state): State<PanelState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        let name = issues.text_with(
            body,
            "name",
            Presence::Required,
            Text::trimmed(Some(1), Some(255)),
        );
        let kind = issues.choice(body, "kind", Presence::Optional, KINDS);
        let allowed = domains(issues, body, Presence::Optional);
        NewProject {
            name: name.into_option().unwrap_or_default(),
            kind: kind.into_option().unwrap_or_else(|| "website".to_owned()),
            allowed_domains: allowed.into_option().unwrap_or_default(),
        }
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    if caller.user_id.is_empty() {
        return ApiError::unauthorized().into_response();
    }
    let registry = match registry_for(&caller, &state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };

    let settings = Value::Object(
        default_settings()
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    );
    let inserted = projects::Entity::insert(projects::ActiveModel {
        id: Set(weldsuite_kit::generate_id("pnp")),
        name: Set(input.name),
        kind: Set(input.kind),
        status: Set("active".to_owned()),
        token: Set(generate_project_token()),
        allowed_domains: Set(json!(unique(input.allowed_domains))),
        settings: Set(settings),
        created_by_user_id: Set(caller.user_id.clone()),
        ..Default::default()
    })
    .exec_with_returning(&orm(&caller.db))
    .await
    .and_then(js_row);
    let project = match inserted {
        Ok(row) => row,
        Err(error) => return unexpected(&error, "create project"),
    };

    if let Err(error) = registry.sync(&project, None).await {
        // Nobody has its token yet, so take it back out of both.
        let tenant = orm(&caller.db);
        let (removed, deleted) = futures_util::join!(
            registry.remove(&project),
            projects::Entity::delete_by_id(text(&project, "id")).exec(&tenant),
        );
        if let Err(cleanup) = removed {
            tracing::error!(error = %cleanup, "[panel-api] cleanup after a failed project registration");
        }
        if let Err(cleanup) = deleted {
            tracing::error!(error = %cleanup, "[panel-api] cleanup after a failed project registration");
        }
        return unexpected(&error, "register project");
    }
    caller.publish(
        &state,
        PANEL_PROJECT_CREATED,
        text(&project, "id"),
        &event_data(&project),
    );
    Created(dto(&project)).into_response()
}

/// `GET /:id`.
pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    match live_project(&caller, &id).await {
        Ok(Some(project)) => Data(dto(&project)).into_response(),
        Ok(None) => ApiError::not_found("Project", Some(&id)).into_response(),
        Err(error) => unexpected(&error, "get project"),
    }
}

/// `.partial().refine((v) => Object.keys(v).length > 0, 'Nothing to update')`:
/// the refinement runs on what parsed, so only a body without any of the
/// schema's keys fails it.
fn nothing_to_update(issues: &mut Issues, body: &Map<String, Value>, keys: &[&str]) {
    if !keys.iter().any(|key| body.contains_key(*key)) {
        issues.custom_root("Nothing to update");
    }
}

/// Run `sync` after a write that returned `project`; the route's answer.
async fn synced(
    state: &PanelState,
    caller: &Caller,
    registry: &Registry,
    project: Value,
    previous_token: Option<&str>,
    what: &str,
) -> Response {
    if let Err(error) = registry.sync(&project, previous_token).await {
        return unexpected(&error, what);
    }
    caller.publish(
        state,
        PANEL_PROJECT_UPDATED,
        text(&project, "id"),
        &event_data(&project),
    );
    Data(dto(&project)).into_response()
}

/// `PATCH /:id`: name, kind and allowed domains.
pub(crate) async fn update(
    State(state): State<PanelState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let patch = match validate(&headers, &body, |issues, body| {
        let name = issues.text_with(
            body,
            "name",
            Presence::Optional,
            Text::trimmed(Some(1), Some(255)),
        );
        let kind = issues.choice(body, "kind", Presence::Optional, KINDS);
        let allowed = domains(issues, body, Presence::Optional);
        nothing_to_update(issues, body, &["name", "kind", "allowedDomains"]);
        (
            name.into_option(),
            kind.into_option(),
            allowed.into_option(),
        )
    }) {
        Ok(patch) => patch,
        Err(response) => return *response,
    };
    let registry = match registry_for(&caller, &state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let (name, kind, allowed) = patch;
    let mut update = live_update(&id);
    if let Some(name) = name {
        update = update.col_expr(Column::Name, Expr::value(name));
    }
    if let Some(kind) = kind {
        update = update.col_expr(Column::Kind, Expr::value(kind));
    }
    if let Some(domains) = allowed {
        update = update.col_expr(Column::AllowedDomains, Expr::value(json!(unique(domains))));
    }
    match updated(update, &caller.db).await {
        Ok(Some(project)) => {
            synced(&state, &caller, &registry, project, None, "update project").await
        }
        Ok(None) => ApiError::not_found("Project", Some(&id)).into_response(),
        Err(error) => unexpected(&error, "update project"),
    }
}

/// A whole float as an integer, as `JSON.stringify` writes a number.
fn js_number(value: f64) -> Value {
    crate::js::number_value(value)
}

/// `panelSettingsSchema.partial()`, in its field order: the parsed object,
/// with only the fields sent (strings trimmed).
fn settings_patch(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Field::Set(flag) = issues.boolean(body, "autocapture", Presence::Optional) {
        out.insert("autocapture".to_owned(), json!(flag));
    }
    if let Field::Set(level) =
        issues.choice(body, "maskingLevel", Presence::Optional, MASKING_LEVELS)
    {
        out.insert("maskingLevel".to_owned(), json!(level));
    }
    if let Field::Set(mode) = issues.choice(body, "consentMode", Presence::Optional, CONSENT_MODES)
    {
        out.insert("consentMode".to_owned(), json!(mode));
    }
    let rate = weldsuite_kit::validation::Number {
        min: Some(0.0),
        max: Some(1.0),
        ..weldsuite_kit::validation::Number::default()
    };
    if let Field::Set(rate) = issues.number(body, "recordingSampleRate", Presence::Optional, rate) {
        out.insert("recordingSampleRate".to_owned(), js_number(rate));
    }
    let excluded = issues.list(
        body,
        "excludedUrls",
        Presence::Optional,
        None,
        Some(50),
        |issues, item| {
            let pattern = issues.item_text(item, Text::trimmed(Some(1), Some(200)));
            let trimmed = item.as_str().map(weldsuite_kit::validation::js_trim);
            if let Some(trimmed) = trimmed
                && !trimmed.starts_with('/')
            {
                issues.issue_here(json!({
                    "validation": "regex",
                    "code": "invalid_string",
                    "message": "Start with /",
                }));
                return None;
            }
            pattern
        },
    );
    if let Field::Set(patterns) = excluded {
        out.insert("excludedUrls".to_owned(), json!(patterns));
    }
    let filters = issues.list(
        body,
        "ipFilters",
        Presence::Optional,
        None,
        Some(50),
        |issues, item| issues.item_text(item, Text::trimmed(Some(1), Some(64))),
    );
    if let Field::Set(filters) = filters {
        out.insert("ipFilters".to_owned(), json!(filters));
    }
    if let Field::Set(flag) = issues.boolean(body, "aiEnabled", Presence::Optional) {
        out.insert("aiEnabled".to_owned(), json!(flag));
    }
    out
}

/// `PATCH /:id/settings`: pausing and the collector and privacy settings,
/// merged in the database so two admins changing different settings at once
/// do not overwrite each other.
pub(crate) async fn update_settings(
    State(state): State<PanelState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let patch = match validate(&headers, &body, |issues, body| {
        let status = issues.choice(body, "status", Presence::Optional, STATUSES);
        let settings = issues.nested(body, "settings", Presence::Optional, settings_patch);
        nothing_to_update(issues, body, &["status", "settings"]);
        (status.into_option(), settings.into_option())
    }) {
        Ok(patch) => patch,
        Err(response) => return *response,
    };
    let registry = match registry_for(&caller, &state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let (status, settings) = patch;
    let status_changes = status.is_some();
    let mut update = live_update(&id);
    if let Some(status) = status {
        update = update.col_expr(Column::Status, Expr::value(status));
    }
    if let Some(settings) = settings {
        // Merged in the database: `settings || $patch`.
        update = update.col_expr(
            Column::Settings,
            sea_orm::sea_query::extension::postgres::PgExpr::concat(
                Expr::col(Column::Settings),
                Expr::value(Value::Object(settings)),
            ),
        );
    }
    match updated(update, &caller.db).await {
        Ok(Some(project)) => {
            if let Err(error) = registry.sync(&project, None).await {
                return unexpected(&error, "update project settings");
            }
            // Secret keys follow the project's status: a paused project stops /v1/* too.
            if status_changes
                && let Err(error) = crate::keys::sync_key_records(&registry, &project, false).await
            {
                return unexpected(&error, "update project settings");
            }
            caller.publish(
                &state,
                PANEL_PROJECT_UPDATED,
                text(&project, "id"),
                &event_data(&project),
            );
            Data(dto(&project)).into_response()
        }
        Ok(None) => ApiError::not_found("Project", Some(&id)).into_response(),
        Err(error) => unexpected(&error, "update project settings"),
    }
}

/// `DELETE /:id`: soft delete; the collector refuses the token at once. A
/// project already deleted is taken out of the registry again, in case that
/// failed the first time, and answers 404.
pub(crate) async fn remove(
    State(state): State<PanelState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let registry = match registry_for(&caller, &state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let deleted = live_update(&id).col_expr(
        Column::DeletedAt,
        Expr::value(instant(weldsuite_panel_domain::js::now_millis())),
    );
    let project = match updated(deleted, &caller.db).await {
        Ok(Some(row)) => row,
        Ok(None) => {
            let earlier = projects::Entity::find_by_id(&id)
                .filter(Column::DeletedAt.is_not_null())
                .one(&orm(&caller.db))
                .await
                .and_then(|row| row.map(js_row).transpose());
            return match earlier {
                Ok(Some(earlier)) => {
                    let removed = match registry.remove(&earlier).await {
                        Ok(()) => crate::keys::sync_key_records(&registry, &earlier, true).await,
                        Err(error) => Err(error),
                    };
                    match removed {
                        Ok(()) => ApiError::not_found("Project", Some(&id)).into_response(),
                        Err(error) => unexpected(&error, "delete project"),
                    }
                }
                Ok(None) => ApiError::not_found("Project", Some(&id)).into_response(),
                Err(error) => unexpected(&error, "delete project"),
            };
        }
        Err(error) => return unexpected(&error, "delete project"),
    };
    if let Err(error) = registry.remove(&project).await {
        return unexpected(&error, "delete project");
    }
    if let Err(error) = crate::keys::sync_key_records(&registry, &project, true).await {
        return unexpected(&error, "delete project");
    }
    caller.publish(
        &state,
        PANEL_PROJECT_DELETED,
        text(&project, "id"),
        &event_data(&project),
    );
    NoContent.into_response()
}

/// `POST /:id/rotate-token`: a new token; the update only applies while the
/// row still carries the token that was read, so two rotations racing leave
/// one live token (the loser gets 409).
pub(crate) async fn rotate_token(
    State(state): State<PanelState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let registry = match registry_for(&caller, &state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let current = match live_project(&caller, &id).await {
        Ok(Some(current)) => current,
        Ok(None) => return ApiError::not_found("Project", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "rotate token"),
    };
    let current_token = text(&current, "token").to_owned();
    let rotate = live_update(&id)
        .col_expr(Column::Token, Expr::value(generate_project_token()))
        .filter(Column::Token.eq(&current_token));
    match updated(rotate, &caller.db).await {
        Ok(Some(project)) => {
            synced(
                &state,
                &caller,
                &registry,
                project,
                Some(&current_token),
                "rotate token",
            )
            .await
        }
        Ok(None) => match live_project(&caller, &id).await {
            Ok(Some(_)) => ApiError::conflict(
                "The token was just changed by someone else. Reload and try again.",
            )
            .into_response(),
            Ok(None) => ApiError::not_found("Project", Some(&id)).into_response(),
            Err(error) => unexpected(&error, "rotate token"),
        },
        Err(error) => unexpected(&error, "rotate token"),
    }
}

/// `GET /:id/install`: the snippets, and whether the collector has accepted
/// an event in the last 24 hours (`panel:seen:<id>` in the cache).
pub(crate) async fn install(
    State(state): State<PanelState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let project = match live_project(&caller, &id).await {
        Ok(Some(project)) => project,
        Ok(None) => return ApiError::not_found("Project", Some(&id)).into_response(),
        Err(error) => return unexpected(&error, "install info"),
    };
    let Some(collector) = caller.collector_url(&state) else {
        return unexpected(&"PANEL_COLLECTOR_URL is not set", "install info");
    };
    let cache: Option<Arc<dyn DynCache>> = caller.cache(&state);
    let seen = match &cache {
        Some(cache) => match cache.get(&seen_key(text(&project, "id"))).await {
            Ok(seen) => seen,
            Err(error) => return unexpected(&error, "install info"),
        },
        None => None,
    };
    let last_event_at = seen
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(js_date_iso);
    let now_ms = now_millis();
    let receiving = last_event_at
        .as_deref()
        .and_then(|iso| {
            OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339).ok()
        })
        .is_some_and(|at| now_ms - millis(at) <= RECEIVING_WINDOW_MS);

    let origin = trim_trailing_slashes(&collector).to_owned();
    let token = text(&project, "token");
    let init = if origin == DEFAULT_HOST {
        format!("init({{ token: '{token}' }});")
    } else {
        format!("init({{ token: '{token}', host: '{origin}' }});")
    };
    let npm = ["import { init } from '@weldsuite/panel-sdk';", "", &init].join("\n");
    Data(json!({
        "projectId": text(&project, "id"),
        "token": token,
        "collectorUrl": origin,
        "scriptSnippet": install_snippet(token, &origin),
        "npmSnippet": npm,
        "lastEventAt": last_event_at,
        "status": if receiving { "receiving" } else { "waiting" },
    }))
    .into_response()
}

/// Now, in milliseconds since the epoch.
fn now_millis() -> i64 {
    millis(OffsetDateTime::now_utc())
}

fn millis(at: OffsetDateTime) -> i64 {
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}
