//! `/api/user-apps` routes keyed by app id, and the store
//! (`routes/user-apps/index.ts`): the developer's apps and their versions,
//! review, installs and consent, OAuth clients.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, RawQuery, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    USER_APP_CREATED, USER_APP_DELETED, USER_APP_INSTALLED, USER_APP_PUBLISHED,
    USER_APP_UNINSTALLED, USER_APP_UPDATED,
};
use weldsuite_kit::id::generate_id;
use weldsuite_kit::validation::{Field, query_values};
use weldsuite_kit::{ApiError, Created, Data, List, NoContent, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::PutOptions;

use crate::CoreAppsState;
use crate::access::{AppsError, Caller, OrInternal, answer, now, validate};
use crate::bundle_access::invalidate_bundle_access;
use crate::publish::{
    adopt_official_system_installs, dispatch_lifecycle_webhook, invalidate_asset_cache,
    is_official_publisher_workspace, mint_app_token, publish_app_version, row, store_listing,
    string_list, sweep_adopt_system_installs, text,
};
use crate::schemas;
use crate::scopes::{
    content_type_for, diff_scopes, is_reserved, is_safe_bundle_path, is_scope_superset,
    random_hex, sha256_hex, union_scopes,
};

const MAX_BUNDLE_FILES: usize = 500;
const MAX_BUNDLE_BYTES: usize = 50 * 1024 * 1024;
/// A Worker's request limit: a bundle past 50 MB still gets the route's 400.
const MAX_UPLOAD_BODY: usize = 100 * 1024 * 1024;

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreAppsState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require(["weldapps:read"]);
    let develop = || gate.require(["weldapps:develop"]);
    let publish = || gate.require(["weldapps:publish"]);
    let manage = || gate.require(["weldapps:manage"]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(develop()))
        .route("/store", get(store).route_layer(read()))
        .route("/store/{code}", get(store_detail).route_layer(read()))
        .route("/installed", get(installed).route_layer(read()))
        .route(
            "/developer-account",
            get(developer_account).route_layer(develop()),
        )
        .route("/{id}", get(detail).route_layer(read()))
        .route(
            "/{id}",
            axum::routing::patch(update)
                .delete(remove)
                .route_layer(develop()),
        )
        .route("/{id}/versions", get(versions).route_layer(read()))
        .route(
            "/{id}/versions",
            post(upload_version)
                .route_layer(develop())
                .layer(DefaultBodyLimit::max(MAX_UPLOAD_BODY)),
        )
        .route("/{id}/submit", post(submit).route_layer(publish()))
        // Platform staff only, checked in the handler (master `admin_users`).
        .route("/{id}/review", post(review))
        .route(
            "/{id}/install",
            post(install).delete(uninstall).route_layer(manage()),
        )
        .route("/{id}/consent", post(consent).route_layer(manage()))
        .route(
            "/{id}/oauth-client",
            post(create_oauth_client)
                .get(oauth_client)
                .route_layer(develop()),
        )
}

// ── shared reads ─────────────────────────────────────────────────────────────

/// An app the workspace owns (soft-deleted excluded).
async fn owned_app(master: &PgPool, id: &str, workspace_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let found: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        app_json!(),
        " from user_apps a
         where a.id = $1 and a.owner_workspace_id = $2 and a.deleted_at is null limit 1"
    ))
    .bind(id)
    .bind(workspace_id)
    .fetch_optional(master)
    .await?;
    Ok(found.map(row))
}

fn app_not_found(id: &str) -> AppsError {
    AppsError::api(ApiError::not_found("App", Some(id)))
}

/// Own apps always, foreign apps only when live in the public store.
fn is_installable_here(app: &Value, workspace_id: &str) -> bool {
    if !app["deletedAt"].is_null() {
        return false;
    }
    if text(app, "ownerWorkspaceId") == workspace_id {
        return true;
    }
    text(app, "visibility") == "public"
        && text(app, "reviewStatus") == "approved"
        && app["isActive"] == Value::Bool(true)
}

/// `invalidateAssetCache`: never fails the route.
async fn drop_asset_cache(caller: &Caller, state: &CoreAppsState, code: &str) {
    match caller.overrides.cache(state) {
        Ok(cache) => invalidate_asset_cache(cache.as_ref(), code).await,
        Err(_) => tracing::error!("core-apps: asset cache invalidation failed: no cache"),
    }
}

async fn drop_bundle_access(caller: &Caller, state: &CoreAppsState, app_id: &str) {
    match caller.overrides.cache(state) {
        Ok(cache) => invalidate_bundle_access(cache.as_ref(), app_id, &caller.workspace_id).await,
        Err(_) => tracing::error!("core-apps: bundle access invalidation failed: no cache"),
    }
}

/// `Number.parseInt(text, 10)`: leading whitespace, a sign, then digits.
fn js_parse_int(text: &str) -> Option<i64> {
    let trimmed = weldsuite_kit::validation::js_trim(text);
    let (sign, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (-1, &trimmed[1..]),
        Some(b'+') => (1, &trimmed[1..]),
        _ => (1, trimmed),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    Some(sign * digits[..end].parse::<i64>().unwrap_or(i64::MAX))
}

/// `c.req.query()`: the first value of a key.
fn first_query(values: &Map<String, Value>, key: &str) -> Option<String> {
    match values.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(items)) => items.first().and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

// ── GET / ────────────────────────────────────────────────────────────────────

async fn list(State(state): State<CoreAppsState>, caller: Caller, RawQuery(query): RawQuery) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            let q = query_values(query.as_deref());
            let limit = first_query(&q, "limit")
                .filter(|text| !text.is_empty())
                .map_or(Some(25), |text| js_parse_int(&text))
                .map_or(25, |n| n.clamp(1, 100));
            // Workspace-scoped: a cursor at another workspace's app is ignored.
            let mut cursor: Option<(String, String)> = None;
            if let Some(id) = first_query(&q, "cursor").filter(|c| !c.is_empty()) {
                let found: Option<(Option<String>, String)> = sqlx::query_as(
                    "select to_jsonb(created_at) #>> '{}', id from user_apps
                     where id = $1 and owner_workspace_id = $2 limit 1",
                )
                .bind(&id)
                .bind(&caller.workspace_id)
                .fetch_optional(&master)
                .await
                .or_internal("Failed to list apps")?;
                cursor = found.and_then(|(created, id)| {
                    created
                        .as_deref()
                        .and_then(weldsuite_db::js_timestamp)
                        .map(|stamp| (stamp, id))
                });
            }
            let rows: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                app_json!(),
                " from user_apps a
                 where a.owner_workspace_id = $1 and a.deleted_at is null
                   and ($2::timestamptz is null or a.created_at < $2::timestamptz
                        or (a.created_at = $2::timestamptz and a.id < $3))
                 order by a.created_at desc, a.id desc
                 limit $4"
            ))
            .bind(&caller.workspace_id)
            .bind(cursor.as_ref().map(|(stamp, _)| stamp.as_str()))
            .bind(cursor.as_ref().map(|(_, id)| id.as_str()))
            .bind(limit + 1)
            .fetch_all(&master)
            .await
            .or_internal("Failed to list apps")?;
            let total: i64 = sqlx::query_scalar(
                "select count(*) from user_apps where owner_workspace_id = $1 and deleted_at is null",
            )
            .bind(&caller.workspace_id)
            .fetch_one(&master)
            .await
            .or_internal("Failed to list apps")?;
            let has_more = rows.len() > usize::try_from(limit).unwrap_or(25);
            let mut data: Vec<Value> = rows.into_iter().map(row).collect();
            data.truncate(usize::try_from(limit).unwrap_or(25));
            let next = if has_more {
                data.last().map(|app| text(app, "id").to_owned())
            } else {
                None
            };
            Ok(List::new(
                data,
                Pagination::new(u64::try_from(total).unwrap_or(0), has_more, next),
            )
            .into_response())
        }
        .await,
    )
}

// ── POST / ───────────────────────────────────────────────────────────────────

async fn create(
    State(state): State<CoreAppsState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let data = validate(&headers, &body, schemas::create_app)?;
            let official = is_official_publisher_workspace(
                caller.overrides.env(&state, "WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS"),
                &caller.workspace_id,
            );
            if is_reserved(&data.code) && !official {
                return Err(ApiError::conflict(format!("App code '{}' is reserved", data.code)).into());
            }
            let master = caller.master(&state);
            let taken: Option<String> =
                sqlx::query_scalar("select id from user_apps where code = $1 limit 1")
                    .bind(&data.code)
                    .fetch_optional(&master)
                    .await
                    .or_internal("Failed to create app")?;
            if taken.is_some() {
                return Err(
                    ApiError::conflict(format!("App code '{}' is already taken", data.code)).into(),
                );
            }
            let now = now();
            let created: Value = sqlx::query_scalar(concat!(
                "insert into user_apps as a
                   (id, code, name, description, icon, category, website_url, privacy_url,
                    screenshots, webhook_url, owner_workspace_id, created_by, publisher_type,
                    created_at, updated_at)
                 values ($1, $2, $3, $4, coalesce($5, 'Puzzle'), coalesce($6, 'Productivity'),
                         $7, $8, coalesce($9::jsonb, '[]'::jsonb), $10, $11, $12, $13,
                         $14::timestamptz, $14::timestamptz)
                 returning ",
                app_json!()
            ))
            .bind(generate_id("uapp"))
            .bind(&data.code)
            .bind(&data.name)
            .bind(&data.description)
            .bind(data.icon.as_deref().filter(|v| !v.is_empty()))
            .bind(data.category.as_deref().filter(|v| !v.is_empty()))
            .bind(data.website_url.as_deref().filter(|v| !v.is_empty()))
            .bind(data.privacy_url.as_deref().filter(|v| !v.is_empty()))
            .bind(data.screenshots.as_ref().map(|s| json!(s)))
            .bind(data.webhook_url.as_deref().filter(|v| !v.is_empty()))
            .bind(&caller.workspace_id)
            .bind(&caller.user_id)
            .bind(if official { "weldsuite" } else { "community" })
            .bind(&now)
            .fetch_one(&master)
            .await
            .or_internal("Failed to create app")?;
            let created = row(created);
            caller.publish(&state, USER_APP_CREATED, text(&created, "id"), &created);
            Ok(Created(created).into_response())
        }
        .await,
    )
}

// ── the store ────────────────────────────────────────────────────────────────

/// Install state of `apps` in the caller's workspace: `(isInstalled, pendingScopes)`.
async fn install_states(
    caller: &Caller,
    master: &PgPool,
    apps: &[Value],
) -> Result<Vec<(bool, Value)>, sqlx::Error> {
    let tenant_rows: Vec<(Option<String>, bool)> = sqlx::query_as(
        "select user_app_id, is_active from workspace_installed_apps
         where app_type = 'user' and deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await?;
    let ids: Vec<String> = apps.iter().map(|a| text(a, "id").to_owned()).collect();
    let installs: Vec<(String, String, Option<Value>)> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "select app_id, status, pending_scopes from user_app_installs
             where workspace_id = $1 and app_id = any($2)",
        )
        .bind(&caller.workspace_id)
        .bind(&ids)
        .fetch_all(master)
        .await?
    };
    Ok(apps
        .iter()
        .map(|app| {
            let id = text(app, "id");
            // Later rows win, as a Map filled in order.
            let tenant_active = tenant_rows
                .iter()
                .rev()
                .find(|(app_id, _)| app_id.as_deref() == Some(id))
                .is_some_and(|(_, active)| *active);
            let install = installs.iter().rev().find(|(app_id, ..)| app_id == id);
            let active = install.is_some_and(|(_, status, _)| status == "active");
            let pending = match install {
                Some((_, _, Some(pending))) if active => pending.clone(),
                _ => Value::Null,
            };
            (tenant_active && active, pending)
        })
        .collect())
}

fn with_install_state(app: Value, (installed, pending): (bool, Value)) -> Value {
    let mut listing = store_listing(app);
    if let Value::Object(fields) = &mut listing {
        fields.insert("isInstalled".to_owned(), Value::Bool(installed));
        fields.insert("pendingScopes".to_owned(), pending);
    }
    listing
}

async fn store(State(state): State<CoreAppsState>, caller: Caller) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            adopt_official_system_installs(&master, &caller.db, &caller.workspace_id, Some(&caller.user_id))
                .await
                .or_internal("Failed to list app store")?;
            let apps: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                app_json!(),
                " from user_apps a
                 where (a.visibility = 'public' and a.review_status = 'approved' and a.is_active = true
                        and a.deleted_at is null)
                    or (a.owner_workspace_id = $1 and a.deleted_at is null)
                 order by a.created_at desc, a.id desc"
            ))
            .bind(&caller.workspace_id)
            .fetch_all(&master)
            .await
            .or_internal("Failed to list app store")?;
            let apps: Vec<Value> = apps.into_iter().map(row).collect();
            let states = install_states(&caller, &master, &apps)
                .await
                .or_internal("Failed to list app store")?;
            let data: Vec<Value> = apps
                .into_iter()
                .zip(states)
                .map(|(app, state)| with_install_state(app, state))
                .collect();
            let total = u64::try_from(data.len()).unwrap_or(0);
            Ok(List::new(data, Pagination::new(total, false, None)).into_response())
        }
        .await,
    )
}

async fn store_detail(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(code): Path<String>,
) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            let app: Option<Value> = sqlx::query_scalar(concat!(
                "select ",
                app_json!(),
                " from user_apps a
                 where a.code = $1
                   and ((a.visibility = 'public' and a.review_status = 'approved' and a.is_active = true
                         and a.deleted_at is null)
                        or (a.owner_workspace_id = $2 and a.deleted_at is null))
                 limit 1"
            ))
            .bind(&code)
            .bind(&caller.workspace_id)
            .fetch_optional(&master)
            .await
            .or_internal("Failed to fetch app")?;
            let Some(app) = app.map(row) else {
                return Err(app_not_found(&code));
            };
            let tenant_active: Option<bool> = sqlx::query_scalar(
                "select is_active from workspace_installed_apps
                 where user_app_id = $1 and deleted_at is null limit 1",
            )
            .bind(text(&app, "id"))
            .fetch_optional(&caller.db)
            .await
            .or_internal("Failed to fetch app")?;
            let install: Option<(String, Option<Value>)> = sqlx::query_as(
                "select status, pending_scopes from user_app_installs
                 where app_id = $1 and workspace_id = $2 limit 1",
            )
            .bind(text(&app, "id"))
            .bind(&caller.workspace_id)
            .fetch_optional(&master)
            .await
            .or_internal("Failed to fetch app")?;
            let active = install.as_ref().is_some_and(|(status, _)| status == "active");
            let pending = match install {
                Some((_, Some(pending))) if active => pending,
                _ => Value::Null,
            };
            let data = with_install_state(app, (tenant_active == Some(true) && active, pending));
            Ok(Data(data).into_response())
        }
        .await,
    )
}

async fn installed(State(state): State<CoreAppsState>, caller: Caller) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            // First-party installs become hosted apps once an official app
            // owns their sidenav code.
            adopt_official_system_installs(&master, &caller.db, &caller.workspace_id, Some(&caller.user_id))
                .await
                .or_internal("Failed to list installed apps")?;
            let rows: Vec<Value> = sqlx::query_scalar(
                "select to_jsonb(w) from workspace_installed_apps w
                 where w.app_type = 'user' and w.is_active = true and w.deleted_at is null",
            )
            .fetch_all(&caller.db)
            .await
            .or_internal("Failed to list installed apps")?;
            let rows: Vec<Value> = rows.into_iter().map(row).collect();
            let ids: Vec<String> = rows
                .iter()
                .filter_map(|r| r["userAppId"].as_str().filter(|id| !id.is_empty()))
                .map(str::to_owned)
                .collect();
            let apps: Vec<Value> = if ids.is_empty() {
                Vec::new()
            } else {
                sqlx::query_scalar(concat!(
                    "select ",
                    app_json!(),
                    " from user_apps a where a.id = any($1)"
                ))
                .bind(&ids)
                .fetch_all(&master)
                .await
                .or_internal("Failed to list installed apps")?
                .into_iter()
                .map(row)
                .collect()
            };
            let data: Vec<Value> = rows
                .into_iter()
                .filter_map(|mut tenant_row| {
                    let app_id = tenant_row["userAppId"].as_str()?.to_owned();
                    let app = apps.iter().find(|a| text(a, "id") == app_id)?;
                    if !app["deletedAt"].is_null() || app["isActive"] != Value::Bool(true) {
                        return None;
                    }
                    let mut summary = Map::new();
                    for key in [
                        "id",
                        "code",
                        "name",
                        "description",
                        "icon",
                        "category",
                        "manifest",
                        "currentVersionId",
                        "publisherType",
                    ] {
                        summary.insert(key.to_owned(), app[key].clone());
                    }
                    tenant_row["app"] = Value::Object(summary);
                    Some(tenant_row)
                })
                .collect();
            let total = u64::try_from(data.len()).unwrap_or(0);
            Ok(List::new(data, Pagination::new(total, false, None)).into_response())
        }
        .await,
    )
}

async fn developer_account(State(state): State<CoreAppsState>, caller: Caller) -> Response {
    answer(
        async {
            let account: Option<Value> = sqlx::query_scalar(
                "select to_jsonb(d) from app_developer_accounts d where d.workspace_id = $1 limit 1",
            )
            .bind(&caller.workspace_id)
            .fetch_optional(&caller.master(&state))
            .await
            .or_internal("Failed to fetch developer account")?;
            Ok(Data(account.map(row).unwrap_or(Value::Null)).into_response())
        }
        .await,
    )
}

// ── one app ──────────────────────────────────────────────────────────────────

async fn detail(State(state): State<CoreAppsState>, caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let app = owned_app(&caller.master(&state), &id, &caller.workspace_id)
                .await
                .or_internal("Failed to fetch app")?
                .ok_or_else(|| app_not_found(&id))?;
            Ok(Data(app).into_response())
        }
        .await,
    )
}

/// `(set?, value)` for a `case when` update: `undefined` keeps the column.
fn field_text(field: &Field<String>) -> (bool, Option<&str>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.as_str())),
    }
}

async fn update(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let data = validate(&headers, &body, schemas::update_app)?;
            let master = caller.master(&state);
            let app = owned_app(&master, &id, &caller.workspace_id)
                .await
                .or_internal("Failed to update app")?
                .ok_or_else(|| app_not_found(&id))?;
            let (name_set, name) = field_text(&data.name);
            let (description_set, description) = field_text(&data.description);
            let (icon_set, icon) = field_text(&data.icon);
            let (category_set, category) = field_text(&data.category);
            let (website_set, website) = field_text(&data.website_url);
            let (privacy_set, privacy) = field_text(&data.privacy_url);
            let (webhook_set, webhook) = field_text(&data.webhook_url);
            let updated: Value = sqlx::query_scalar(concat!(
                "update user_apps as a set
                   updated_at = $2::timestamptz,
                   name = case when $3 then $4 else a.name end,
                   description = case when $5 then $6 else a.description end,
                   icon = case when $7 then $8 else a.icon end,
                   category = case when $9 then $10 else a.category end,
                   is_active = case when $11 then $12 else a.is_active end,
                   website_url = case when $13 then $14 else a.website_url end,
                   privacy_url = case when $15 then $16 else a.privacy_url end,
                   screenshots = case when $17 then $18::jsonb else a.screenshots end,
                   webhook_url = case when $19 then $20 else a.webhook_url end
                 where a.id = $1
                 returning ",
                app_json!()
            ))
            .bind(&id)
            .bind(now())
            .bind(name_set)
            .bind(name)
            .bind(description_set)
            .bind(description)
            .bind(icon_set)
            .bind(icon)
            .bind(category_set)
            .bind(category)
            .bind(!data.is_active.is_absent())
            .bind(data.is_active.as_set().copied())
            .bind(website_set)
            .bind(website)
            .bind(privacy_set)
            .bind(privacy)
            .bind(!data.screenshots.is_absent())
            .bind(data.screenshots.as_set().map(|s| json!(s)))
            .bind(webhook_set)
            .bind(webhook)
            .fetch_one(&master)
            .await
            .or_internal("Failed to update app")?;
            let updated = row(updated);
            caller.publish(&state, USER_APP_UPDATED, &id, &updated);
            if !data.is_active.is_absent() {
                drop_asset_cache(&caller, &state, text(&app, "code")).await;
            }
            Ok(Data(updated).into_response())
        }
        .await,
    )
}

async fn remove(State(state): State<CoreAppsState>, caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to delete app";
            let master = caller.master(&state);
            let app = owned_app(&master, &id, &caller.workspace_id)
                .await
                .or_internal(FAILED)?
                .ok_or_else(|| app_not_found(&id))?;
            let foreign: i64 = sqlx::query_scalar(
                "select count(*) from user_app_installs
                 where app_id = $1 and status = 'active' and workspace_id <> $2",
            )
            .bind(&id)
            .bind(&caller.workspace_id)
            .fetch_one(&master)
            .await
            .or_internal(FAILED)?;
            if foreign > 0 {
                return Err(ApiError::conflict("App is still installed in other workspaces").into());
            }
            let now = now();
            sqlx::query(
                "update user_apps set deleted_at = $2::timestamptz, is_active = false,
                   updated_at = $2::timestamptz where id = $1",
            )
            .bind(&id)
            .bind(&now)
            .execute(&master)
            .await
            .or_internal(FAILED)?;
            sqlx::query(
                "update user_app_installs set status = 'revoked', revoked_at = $2::timestamptz,
                   updated_at = $2::timestamptz where app_id = $1 and status = 'active'",
            )
            .bind(&id)
            .bind(&now)
            .execute(&master)
            .await
            .or_internal(FAILED)?;
            sqlx::query(
                "update user_app_tokens set revoked_at = $2::timestamptz
                 where app_id = $1 and revoked_at is null",
            )
            .bind(&id)
            .bind(&now)
            .execute(&master)
            .await
            .or_internal(FAILED)?;
            sqlx::query(
                "update workspace_installed_apps set deleted_at = $2::timestamptz, is_active = false,
                   updated_at = $2::timestamptz where user_app_id = $1 and deleted_at is null",
            )
            .bind(&id)
            .bind(&now)
            .execute(&caller.db)
            .await
            .or_internal(FAILED)?;
            caller.publish(
                &state,
                USER_APP_DELETED,
                &id,
                &json!({ "id": id, "code": app["code"], "name": app["name"] }),
            );
            drop_asset_cache(&caller, &state, text(&app, "code")).await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── versions ─────────────────────────────────────────────────────────────────

async fn versions(State(state): State<CoreAppsState>, caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let master = caller.master(&state);
            owned_app(&master, &id, &caller.workspace_id)
                .await
                .or_internal("Failed to list versions")?
                .ok_or_else(|| app_not_found(&id))?;
            let rows: Vec<Value> = sqlx::query_scalar(
                "select to_jsonb(v) from user_app_versions v
                 where v.app_id = $1 order by v.created_at desc, v.id desc",
            )
            .bind(&id)
            .fetch_all(&master)
            .await
            .or_internal("Failed to list versions")?;
            let data: Vec<Value> = rows.into_iter().map(row).collect();
            let total = u64::try_from(data.len()).unwrap_or(0);
            Ok(List::new(data, Pagination::new(total, false, None)).into_response())
        }
        .await,
    )
}

/// One `FormData` entry: a string, or a file (name, type, bytes).
enum FormValue {
    Text(String),
    File {
        name: String,
        content_type: Option<String>,
        bytes: Vec<u8>,
    },
}

/// `c.req.formData()`: the entries in order, or `None` when the body is not
/// a form.
async fn form_data(request: Request) -> Option<Vec<(String, FormValue)>> {
    let content_type = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if content_type.starts_with("application/x-www-form-urlencoded") {
        let body = axum::body::to_bytes(request.into_body(), MAX_UPLOAD_BODY).await.ok()?;
        return Some(
            form_urlencoded::parse(&body)
                .map(|(k, v)| (k.into_owned(), FormValue::Text(v.into_owned())))
                .collect(),
        );
    }
    let mut multipart = Multipart::from_request(request, &()).await.ok()?;
    let mut entries = Vec::new();
    loop {
        let field = multipart.next_field().await.ok()?;
        let Some(field) = field else { break };
        let name = field.name().unwrap_or_default().to_owned();
        let file_name = field.file_name().map(str::to_owned);
        let content_type = field.content_type().map(str::to_owned);
        let bytes = field.bytes().await.ok()?.to_vec();
        let value = match file_name {
            Some(file_name) => FormValue::File {
                name: file_name,
                content_type,
                bytes,
            },
            None => FormValue::Text(String::from_utf8_lossy(&bytes).into_owned()),
        };
        entries.push((name, value));
    }
    Some(entries)
}

/// A parsed upload: the manifest, the changelog and the files.
struct Upload {
    manifest: Value,
    changelog: Option<String>,
    files: Vec<(String, Option<String>, Vec<u8>)>,
    bundle_size: usize,
}

fn validate_bundle_files(files: &[(String, Option<String>, Vec<u8>)], bundle_size: usize) -> Option<String> {
    if files.is_empty() {
        return Some("At least one bundle file is required".to_owned());
    }
    if files.len() > MAX_BUNDLE_FILES {
        return Some(format!("Bundle exceeds the {MAX_BUNDLE_FILES}-file limit"));
    }
    if bundle_size > MAX_BUNDLE_BYTES {
        return Some(format!(
            "Bundle exceeds the {}MB size limit",
            MAX_BUNDLE_BYTES / (1024 * 1024)
        ));
    }
    let mut seen: Vec<&str> = Vec::new();
    for (name, ..) in files {
        if !is_safe_bundle_path(name) {
            return Some(format!("Invalid bundle file path: '{name}'"));
        }
        if seen.contains(&name.as_str()) {
            return Some(format!("Duplicate bundle file path: '{name}'"));
        }
        seen.push(name);
    }
    None
}

/// `parseVersionUpload`: the upload, or the 400.
async fn parse_upload(request: Request, app_code: &str) -> Result<Upload, ApiError> {
    let Some(entries) = form_data(request).await else {
        return Err(ApiError::bad_request("Expected multipart/form-data"));
    };
    let first = |key: &str| entries.iter().find(|(name, _)| name == key).map(|(_, v)| v);
    let Some(FormValue::Text(raw)) = first("manifest") else {
        return Err(ApiError::bad_request("Missing 'manifest' field (JSON string)"));
    };
    let Ok(json) = serde_json::from_str::<Value>(raw) else {
        return Err(ApiError::bad_request("Field 'manifest' is not valid JSON"));
    };
    let manifest = schemas::manifest(&json)
        .map_err(|details| ApiError::bad_request("Invalid manifest").with_details(details))?;
    let manifest_code = text(&manifest, "code");
    if manifest_code != app_code {
        return Err(ApiError::bad_request(format!(
            "Manifest code '{manifest_code}' does not match app code '{app_code}'"
        )));
    }
    let changelog = match first("changelog") {
        Some(FormValue::Text(text)) if !text.is_empty() => Some(text.clone()),
        _ => None,
    };
    let files: Vec<(String, Option<String>, Vec<u8>)> = entries
        .into_iter()
        .filter_map(|(name, value)| match value {
            FormValue::File {
                name: file_name,
                content_type,
                bytes,
            } if name == "files" => Some((file_name, content_type, bytes)),
            _ => None,
        })
        .collect();
    let bundle_size = files.iter().map(|(.., bytes)| bytes.len()).sum();
    if let Some(message) = validate_bundle_files(&files, bundle_size) {
        return Err(ApiError::bad_request(message));
    }
    Ok(Upload {
        manifest,
        changelog,
        files,
        bundle_size,
    })
}

/// The owner workspace's tenant row follows its master grant (other tenants
/// sync lazily).
async fn mirror_owner_install_scopes(
    master: &PgPool,
    tenant: &PgPool,
    app_id: &str,
    workspace_id: &str,
    needing: &[crate::publish::InstallNeedingConsent],
) -> Result<(), sqlx::Error> {
    let Some(owner) = needing.iter().find(|i| i.workspace_id == workspace_id) else {
        return Ok(());
    };
    let granted: Option<Option<Value>> =
        sqlx::query_scalar("select granted_scopes from user_app_installs where id = $1 limit 1")
            .bind(&owner.install_id)
            .fetch_optional(master)
            .await?;
    let granted = granted.flatten().unwrap_or_else(|| json!([]));
    sqlx::query(
        "update workspace_installed_apps set granted_scopes = $2::jsonb, updated_at = $3::timestamptz
         where user_app_id = $1 and deleted_at is null",
    )
    .bind(app_id)
    .bind(granted)
    .bind(now())
    .execute(tenant)
    .await?;
    Ok(())
}

async fn upload_version(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to upload version";
            let master = caller.master(&state);
            let app = owned_app(&master, &id, &caller.workspace_id)
                .await
                .or_internal(FAILED)?
                .ok_or_else(|| app_not_found(&id))?;
            let Some(storage) = caller.overrides.storage(&state) else {
                return Err(ApiError::internal().with_message("Storage is not configured").into());
            };
            let app_code = text(&app, "code").to_owned();
            let upload = parse_upload(request, &app_code).await?;
            let version = text(&upload.manifest, "version").to_owned();
            let dupe: Option<String> = sqlx::query_scalar(
                "select id from user_app_versions where app_id = $1 and version = $2 limit 1",
            )
            .bind(&id)
            .bind(&version)
            .fetch_optional(&master)
            .await
            .or_internal(FAILED)?;
            if dupe.is_some() {
                return Err(ApiError::conflict(format!("Version {version} already exists")).into());
            }

            let version_id = generate_id("uav");
            let app_id = text(&app, "id").to_owned();
            let bundle_key = format!("user-apps/{app_id}/{version_id}");
            let file_count = upload.files.len();
            for (name, content_type, bytes) in upload.files {
                let content_type = content_type_for(&name).map_or_else(
                    || {
                        content_type
                            .filter(|t| !t.is_empty())
                            .unwrap_or_else(|| "application/octet-stream".to_owned())
                    },
                    str::to_owned,
                );
                storage
                    .put_boxed(&format!("{bundle_key}/{name}"), bytes, &PutOptions::content_type(content_type))
                    .await
                    .or_internal(FAILED)?;
            }
            let entrypoint = upload.manifest["entrypoint"]
                .as_str()
                .filter(|e| !e.is_empty())
                .unwrap_or("index.html")
                .to_owned();
            let created: Value = sqlx::query_scalar(
                "insert into user_app_versions as v
                   (id, app_id, version, manifest, requested_scopes, bundle_key, entrypoint,
                    bundle_size, file_count, status, changelog, created_by)
                 values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, 'draft', $10, $11)
                 returning to_jsonb(v)",
            )
            .bind(&version_id)
            .bind(&app_id)
            .bind(&version)
            .bind(&upload.manifest)
            .bind(upload.manifest.get("scopes").filter(|s| !s.is_null()).cloned().unwrap_or_else(|| json!([])))
            .bind(&bundle_key)
            .bind(&entrypoint)
            .bind(i32::try_from(upload.bundle_size).unwrap_or(i32::MAX))
            .bind(i32::try_from(file_count).unwrap_or(i32::MAX))
            .bind(&upload.changelog)
            .bind(&caller.user_id)
            .fetch_one(&master)
            .await
            .or_internal(FAILED)?;
            let created = row(created);

            // A reviewed public community app goes back to review; anything
            // else is published at once.
            let review_gate = text(&app, "visibility") == "public"
                && text(&app, "reviewStatus") == "approved"
                && text(&app, "publisherType") != "weldsuite";
            if review_gate {
                sqlx::query(
                    "update user_apps set review_status = 'submitted', updated_at = $2::timestamptz
                     where id = $1",
                )
                .bind(&app_id)
                .bind(now())
                .execute(&master)
                .await
                .or_internal(FAILED)?;
                caller.publish(
                    &state,
                    USER_APP_UPDATED,
                    &app_id,
                    &json!({ "id": app_id, "code": app_code, "versionId": version_id, "reviewStatus": "submitted" }),
                );
            } else {
                let needing = publish_app_version(&master, &app_id, &version_id, Some(&upload.manifest))
                    .await
                    .or_internal(FAILED)?;
                mirror_owner_install_scopes(&master, &caller.db, &app_id, &caller.workspace_id, &needing)
                    .await
                    .or_internal(FAILED)?;
                caller.publish(
                    &state,
                    USER_APP_PUBLISHED,
                    &app_id,
                    &json!({ "id": app_id, "code": app_code, "versionId": version_id, "version": version }),
                );
            }
            drop_asset_cache(&caller, &state, &app_code).await;
            Ok(Created(created).into_response())
        }
        .await,
    )
}

// ── review ───────────────────────────────────────────────────────────────────

async fn submit(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to submit app for review";
            let notes = validate(&headers, &body, schemas::submit)?;
            let master = caller.master(&state);
            let app = owned_app(&master, &id, &caller.workspace_id)
                .await
                .or_internal(FAILED)?
                .ok_or_else(|| app_not_found(&id))?;
            let version: Option<String> =
                sqlx::query_scalar("select id from user_app_versions where app_id = $1 limit 1")
                    .bind(&id)
                    .fetch_optional(&master)
                    .await
                    .or_internal(FAILED)?;
            if version.is_none() {
                return Err(ApiError::bad_request("Upload a version before submitting for review").into());
            }
            let official = text(&app, "publisherType") == "weldsuite";
            let updated: Value = sqlx::query_scalar(concat!(
                "update user_apps as a set
                   visibility = 'public',
                   review_status = case when $2 then 'approved' else 'submitted' end,
                   reviewed_by = case when $2 then $3 else a.reviewed_by end,
                   reviewed_at = case when $2 then $4::timestamptz else a.reviewed_at end,
                   review_notes = case
                     when $2 then coalesce($5::text, a.review_notes)
                     when $5::text <> '' then $5::text
                     else a.review_notes end,
                   updated_at = $4::timestamptz
                 where a.id = $1
                 returning ",
                app_json!()
            ))
            .bind(&id)
            .bind(official)
            .bind(&caller.user_id)
            .bind(now())
            .bind(&notes)
            .fetch_one(&master)
            .await
            .or_internal(FAILED)?;
            let updated = row(updated);
            // An official app goes public (and so plain-URL) right here.
            drop_asset_cache(&caller, &state, text(&app, "code")).await;
            caller.publish(&state, USER_APP_UPDATED, &id, &updated);
            if official {
                state.events.tracker().spawn(sweep_adopt_system_installs(
                    master.clone(),
                    Arc::clone(&state.workspaces),
                    updated.clone(),
                    caller.user_id.clone(),
                ));
            }
            Ok(Data(updated).into_response())
        }
        .await,
    )
}

async fn review(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to review app";
            let (decision, notes) = validate(&headers, &body, schemas::review)?;
            let master = caller.master(&state);
            let admin: Option<String> = sqlx::query_scalar(
                "select id from admin_users where user_id = $1 and is_active = true limit 1",
            )
            .bind(&caller.user_id)
            .fetch_optional(&master)
            .await
            .or_internal(FAILED)?;
            if admin.is_none() {
                return Err(ApiError::forbidden().with_message("Platform staff only").into());
            }
            let app: Option<Value> = sqlx::query_scalar(concat!(
                "select ",
                app_json!(),
                " from user_apps a where a.id = $1 and a.deleted_at is null limit 1"
            ))
            .bind(&id)
            .fetch_optional(&master)
            .await
            .or_internal(FAILED)?;
            let Some(app) = app.map(row) else {
                return Err(app_not_found(&id));
            };
            let approved = decision == "approved";
            sqlx::query(
                "update user_apps set review_status = $2, review_notes = $3, reviewed_by = $4,
                   reviewed_at = $5::timestamptz, updated_at = $5::timestamptz
                 where id = $1",
            )
            .bind(&id)
            .bind(if approved { "approved" } else { "rejected" })
            .bind(&notes)
            .bind(&caller.user_id)
            .bind(now())
            .execute(&master)
            .await
            .or_internal(FAILED)?;
            if approved {
                let candidate: Option<Value> = sqlx::query_scalar(
                    "select to_jsonb(v) from user_app_versions v
                     where v.app_id = $1 and v.status in ('draft', 'submitted')
                     order by v.created_at desc, v.id desc limit 1",
                )
                .bind(&id)
                .fetch_optional(&master)
                .await
                .or_internal(FAILED)?;
                if let Some(candidate) = candidate {
                    publish_app_version(&master, &id, text(&candidate, "id"), candidate.get("manifest"))
                        .await
                        .or_internal(FAILED)?;
                }
            }
            // Approved: the bundle may now be public; rejected: it needs a
            // signed link again.
            drop_asset_cache(&caller, &state, text(&app, "code")).await;
            let updated: Option<Value> = sqlx::query_scalar(concat!(
                "select ",
                app_json!(),
                " from user_apps a where a.id = $1 limit 1"
            ))
            .bind(&id)
            .fetch_optional(&master)
            .await
            .or_internal(FAILED)?;
            let updated = updated.map(row).unwrap_or(Value::Null);
            caller.publish(&state, USER_APP_UPDATED, &id, &updated);
            if approved && text(&updated, "publisherType") == "weldsuite" {
                state.events.tracker().spawn(sweep_adopt_system_installs(
                    master.clone(),
                    Arc::clone(&state.workspaces),
                    updated.clone(),
                    caller.user_id.clone(),
                ));
            }
            Ok(Data(updated).into_response())
        }
        .await,
    )
}

// ── installs ─────────────────────────────────────────────────────────────────

fn lifecycle_payload(event: &str, app_id: &str, app_code: &str, workspace_id: &str, occurred_at: &str) -> Value {
    json!({
        "event": event,
        "appId": app_id,
        "appCode": app_code,
        "workspaceId": workspace_id,
        "occurredAt": occurred_at,
    })
}

async fn install(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to install app";
            let granted = validate(&headers, &body, schemas::install)?;
            let master = caller.master(&state);
            let app: Option<Value> = sqlx::query_scalar(concat!(
                "select ",
                app_json!(),
                " from user_apps a where a.id = $1 and a.deleted_at is null limit 1"
            ))
            .bind(&id)
            .fetch_optional(&master)
            .await
            .or_internal(FAILED)?;
            let Some(app) = app
                .map(row)
                .filter(|app| is_installable_here(app, &caller.workspace_id))
            else {
                return Err(app_not_found(&id));
            };
            let requested = string_list(app.get("requestedScopes"));
            if !is_scope_superset(&granted, &requested) {
                return Err(ApiError::conflict(
                    "grantedScopes must cover all scopes requested by the app",
                )
                .into());
            }
            let existing: Option<Value> = sqlx::query_scalar(
                "select to_jsonb(i) from user_app_installs i
                 where i.app_id = $1 and i.workspace_id = $2 limit 1",
            )
            .bind(&id)
            .bind(&caller.workspace_id)
            .fetch_optional(&master)
            .await
            .or_internal(FAILED)?;
            let existing = existing.map(row);

            // A foreign subscription app needs an active or trialing subscription.
            if text(&app, "pricingType") == "subscription"
                && text(&app, "ownerWorkspaceId") != caller.workspace_id
            {
                let subscription = existing
                    .as_ref()
                    .and_then(|i| i["subscriptionStatus"].as_str())
                    .unwrap_or_default();
                if !matches!(subscription, "active" | "trialing") {
                    return Err(ApiError::payment_required(
                        "SUBSCRIPTION_REQUIRED",
                        "This app requires an active subscription",
                    )
                    .with_details(json!({
                        "appId": id,
                        "priceMonthly": app["priceMonthly"],
                        "currency": app["currency"],
                    }))
                    .into());
                }
            }

            let now = now();
            let install: Value = match &existing {
                Some(existing) => sqlx::query_scalar(
                    "update user_app_installs as i set
                       status = 'active', granted_scopes = $2::jsonb, pending_scopes = null,
                       installed_by = $3, installed_at = $4::timestamptz, revoked_at = null,
                       updated_at = $4::timestamptz
                     where i.id = $1 returning to_jsonb(i)",
                )
                .bind(text(existing, "id"))
                .bind(json!(granted))
                .bind(&caller.user_id)
                .bind(&now)
                .fetch_one(&master)
                .await
                .or_internal(FAILED)?,
                None => sqlx::query_scalar(
                    "insert into user_app_installs as i
                       (id, app_id, workspace_id, status, granted_scopes, installed_by, installed_at,
                        created_at, updated_at)
                     values ($1, $2, $3, 'active', $4::jsonb, $5, $6::timestamptz, $6::timestamptz,
                             $6::timestamptz)
                     returning to_jsonb(i)",
                )
                .bind(generate_id("uai"))
                .bind(&id)
                .bind(&caller.workspace_id)
                .bind(json!(granted))
                .bind(&caller.user_id)
                .bind(&now)
                .fetch_one(&master)
                .await
                .or_internal(FAILED)?,
            };
            let install = row(install);
            let install_id = text(&install, "id").to_owned();
            let minted = mint_app_token(&master, &install_id, &id, &caller.workspace_id, "install", &granted)
                .await
                .or_internal(FAILED)?;

            let code = text(&app, "code").to_owned();
            let tenant_row: Option<String> =
                sqlx::query_scalar("select id from workspace_installed_apps where app_code = $1 limit 1")
                    .bind(&code)
                    .fetch_optional(&caller.db)
                    .await
                    .or_internal(FAILED)?;
            match tenant_row {
                Some(row_id) => sqlx::query(
                    "update workspace_installed_apps set
                       app_type = 'user', user_app_id = $2, granted_scopes = $3::jsonb, is_active = true,
                       installed_by = $4, installed_at = $5::timestamptz, deleted_at = null,
                       updated_at = $5::timestamptz
                     where id = $1",
                )
                .bind(row_id)
                .bind(&id)
                .bind(json!(granted))
                .bind(&caller.user_id)
                .bind(&now)
                .execute(&caller.db)
                .await
                .or_internal(FAILED)?,
                None => sqlx::query(
                    "insert into workspace_installed_apps
                       (id, app_code, app_type, user_app_id, granted_scopes, is_active, installed_by,
                        installed_at, created_at, updated_at)
                     values ($1, $2, 'user', $3, $4::jsonb, true, $5, $6::timestamptz, $6::timestamptz,
                             $6::timestamptz)",
                )
                .bind(generate_id("wsapp"))
                .bind(&code)
                .bind(&id)
                .bind(json!(granted))
                .bind(&caller.user_id)
                .bind(&now)
                .execute(&caller.db)
                .await
                .or_internal(FAILED)?,
            };
            // Fresh installs and revived (previously revoked) ones count.
            let counts = existing
                .as_ref()
                .is_none_or(|e| text(e, "status") == "revoked");
            if counts {
                sqlx::query(
                    "update user_apps set install_count = install_count + 1, updated_at = $2::timestamptz
                     where id = $1",
                )
                .bind(&id)
                .bind(&now)
                .execute(&master)
                .await
                .or_internal(FAILED)?;
            }
            drop_bundle_access(&caller, &state, &id).await;
            caller.publish(
                &state,
                USER_APP_INSTALLED,
                &id,
                &json!({
                    "id": id,
                    "code": code,
                    "name": app["name"],
                    "installId": install_id,
                    "grantedScopes": granted,
                }),
            );
            state.events.tracker().spawn(dispatch_lifecycle_webhook(
                caller.overrides.http(&state),
                app["webhookUrl"].as_str().map(str::to_owned),
                lifecycle_payload("app.installed", &id, &code, &caller.workspace_id, &now),
            ));
            Ok(Created(json!({ "install": install, "token": minted.token })).into_response())
        }
        .await,
    )
}

async fn uninstall(State(state): State<CoreAppsState>, caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to uninstall app";
            let master = caller.master(&state);
            let install: Option<String> = sqlx::query_scalar(
                "select id from user_app_installs
                 where app_id = $1 and workspace_id = $2 and status = 'active' limit 1",
            )
            .bind(&id)
            .bind(&caller.workspace_id)
            .fetch_optional(&master)
            .await
            .or_internal(FAILED)?;
            let Some(install_id) = install else {
                return Err(ApiError::not_found("App install", Some(&id)).into());
            };
            let app: Option<(String, Option<String>)> =
                sqlx::query_as("select code, webhook_url from user_apps where id = $1 limit 1")
                    .bind(&id)
                    .fetch_optional(&master)
                    .await
                    .or_internal(FAILED)?;
            let now = now();
            sqlx::query(
                "update user_app_installs set status = 'revoked', revoked_at = $2::timestamptz,
                   updated_at = $2::timestamptz where id = $1",
            )
            .bind(&install_id)
            .bind(&now)
            .execute(&master)
            .await
            .or_internal(FAILED)?;
            sqlx::query(
                "update user_app_tokens set revoked_at = $2::timestamptz
                 where install_id = $1 and revoked_at is null",
            )
            .bind(&install_id)
            .bind(&now)
            .execute(&master)
            .await
            .or_internal(FAILED)?;
            sqlx::query(
                "update workspace_installed_apps set is_active = false, deleted_at = $2::timestamptz,
                   updated_at = $2::timestamptz where user_app_id = $1 and deleted_at is null",
            )
            .bind(&id)
            .bind(&now)
            .execute(&caller.db)
            .await
            .or_internal(FAILED)?;
            sqlx::query(
                "update user_apps set install_count = greatest(install_count - 1, 0),
                   updated_at = $2::timestamptz where id = $1",
            )
            .bind(&id)
            .bind(&now)
            .execute(&master)
            .await
            .or_internal(FAILED)?;
            drop_bundle_access(&caller, &state, &id).await;
            caller.publish(
                &state,
                USER_APP_UNINSTALLED,
                &id,
                &json!({ "id": id, "installId": install_id }),
            );
            let (code, webhook) = app.unwrap_or_default();
            state.events.tracker().spawn(dispatch_lifecycle_webhook(
                caller.overrides.http(&state),
                webhook,
                lifecycle_payload("app.uninstalled", &id, &code, &caller.workspace_id, &now),
            ));
            Ok(NoContent.into_response())
        }
        .await,
    )
}

async fn consent(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to record consent";
            let approved = validate(&headers, &body, schemas::consent)?;
            let master = caller.master(&state);
            let install: Option<Value> = sqlx::query_scalar(
                "select to_jsonb(i) from user_app_installs i
                 where i.app_id = $1 and i.workspace_id = $2 and i.status = 'active' limit 1",
            )
            .bind(&id)
            .bind(&caller.workspace_id)
            .fetch_optional(&master)
            .await
            .or_internal(FAILED)?;
            let Some(install) = install.map(row) else {
                return Err(ApiError::not_found("App install", Some(&id)).into());
            };
            let pending = string_list(install.get("pendingScopes"));
            if !approved.iter().all(|s| pending.contains(s)) {
                return Err(ApiError::bad_request("approvedScopes must be a subset of the pending scopes").into());
            }
            let granted = union_scopes(&string_list(install.get("grantedScopes")), &approved);
            let remainder = diff_scopes(&pending, &approved);
            let install_id = text(&install, "id").to_owned();
            let now = now();
            let updated: Value = sqlx::query_scalar(
                "update user_app_installs as i set
                   granted_scopes = $2::jsonb, pending_scopes = $3::jsonb, updated_at = $4::timestamptz
                 where i.id = $1 returning to_jsonb(i)",
            )
            .bind(&install_id)
            .bind(json!(granted))
            .bind((!remainder.is_empty()).then(|| json!(remainder)))
            .bind(&now)
            .fetch_one(&master)
            .await
            .or_internal(FAILED)?;
            let updated = row(updated);
            sqlx::query(
                "update user_app_tokens set scopes = $2::jsonb where install_id = $1 and revoked_at is null",
            )
            .bind(&install_id)
            .bind(json!(granted))
            .execute(&master)
            .await
            .or_internal(FAILED)?;
            sqlx::query(
                "update workspace_installed_apps set granted_scopes = $2::jsonb, updated_at = $3::timestamptz
                 where user_app_id = $1 and deleted_at is null",
            )
            .bind(&id)
            .bind(json!(granted))
            .bind(&now)
            .execute(&caller.db)
            .await
            .or_internal(FAILED)?;
            caller.publish(
                &state,
                USER_APP_UPDATED,
                &id,
                &json!({
                    "id": id,
                    "installId": install_id,
                    "grantedScopes": granted,
                    "pendingScopes": updated["pendingScopes"],
                }),
            );
            Ok(Data(updated).into_response())
        }
        .await,
    )
}

// ── OAuth client ─────────────────────────────────────────────────────────────

async fn create_oauth_client(
    State(state): State<CoreAppsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to create OAuth client";
            let master = caller.master(&state);
            let app = owned_app(&master, &id, &caller.workspace_id)
                .await
                .or_internal(FAILED)?
                .ok_or_else(|| app_not_found(&id))?;
            let app_id = text(&app, "id").to_owned();
            let secret = format!("wacs_{}", random_hex(20));
            let secret_hash = sha256_hex(&secret);
            let now = now();
            let existing: Option<(String, String)> = sqlx::query_as(
                "select id, client_id from user_app_oauth_clients where app_id = $1 limit 1",
            )
            .bind(&id)
            .fetch_optional(&master)
            .await
            .or_internal(FAILED)?;
            if let Some((client_row, client_id)) = existing {
                // Rotate: keep the client id, replace the secret.
                sqlx::query(
                    "update user_app_oauth_clients set client_secret_hash = $2, updated_at = $3::timestamptz
                     where id = $1",
                )
                .bind(&client_row)
                .bind(&secret_hash)
                .bind(&now)
                .execute(&master)
                .await
                .or_internal(FAILED)?;
                caller.publish(
                    &state,
                    USER_APP_UPDATED,
                    &app_id,
                    &json!({ "event": "oauth_client_rotated", "clientId": client_id }),
                );
                return Ok(Data(json!({ "clientId": client_id, "clientSecret": secret })).into_response());
            }
            let client_id = format!("wac_{}", random_hex(12));
            sqlx::query(
                "insert into user_app_oauth_clients
                   (id, app_id, client_id, client_secret_hash, created_at, updated_at)
                 values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz)",
            )
            .bind(generate_id("uaoc"))
            .bind(&id)
            .bind(&client_id)
            .bind(&secret_hash)
            .bind(&now)
            .execute(&master)
            .await
            .or_internal(FAILED)?;
            caller.publish(
                &state,
                USER_APP_UPDATED,
                &app_id,
                &json!({ "event": "oauth_client_created", "clientId": client_id }),
            );
            Ok(Created(json!({ "clientId": client_id, "clientSecret": secret })).into_response())
        }
        .await,
    )
}

async fn oauth_client(State(state): State<CoreAppsState>, caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            const FAILED: &str = "Failed to fetch OAuth client";
            let master = caller.master(&state);
            owned_app(&master, &id, &caller.workspace_id)
                .await
                .or_internal(FAILED)?
                .ok_or_else(|| app_not_found(&id))?;
            let client: Option<Value> = sqlx::query_scalar(
                "select jsonb_build_object('client_id', c.client_id, 'created_at', c.created_at)
                 from user_app_oauth_clients c where c.app_id = $1 limit 1",
            )
            .bind(&id)
            .fetch_optional(&master)
            .await
            .or_internal(FAILED)?;
            let Some(client) = client.map(row) else {
                return Err(ApiError::not_found("OAuth client", Some(&id)).into());
            };
            Ok(Data(client).into_response())
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_int_like_javascript() {
        assert_eq!(js_parse_int("10"), Some(10));
        assert_eq!(js_parse_int(" 7abc"), Some(7));
        assert_eq!(js_parse_int("-5"), Some(-5));
        assert_eq!(js_parse_int("1.9"), Some(1));
        assert_eq!(js_parse_int("nope"), None);
        assert_eq!(js_parse_int(""), None);
    }
}
