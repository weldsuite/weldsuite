//! `/api/online-store/sites`: an online store per storefront channel, its
//! draft document (saved with an optimistic revision), publishing into
//! immutable versions, restoring one, and preview links for the editor.
//!
//!   GET    /sites                                  → every site
//!   POST   /sites                                  { channelId, mode?, locale? }
//!   GET    /sites/:id                              → the site with its draft
//!   PATCH  /sites/:id                              { locale?, mode?, visibility?, password? }
//!   DELETE /sites/:id                              → 204; its hosts go too
//!   PUT    /sites/:id/draft                        { document, revision }
//!   POST   /sites/:id/publish                      { note? } → 201 the version
//!   GET    /sites/:id/versions                     → newest first
//!   POST   /sites/:id/versions/:versionId/restore  → the live version switched
//!   POST   /sites/:id/versions/:versionId/copy-to-draft
//!   POST   /sites/:id/preview                      → { url, expiresAt }

use std::sync::{Arc, LazyLock};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, TransactionTrait,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    STOREFRONT_SITE_CREATED, STOREFRONT_SITE_DELETED, STOREFRONT_SITE_PUBLISHED,
    STOREFRONT_SITE_RESTORED, STOREFRONT_SITE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    WEBSITES_CREATE, WEBSITES_DELETE, WEBSITES_MANAGE, WEBSITES_READ, WEBSITES_UPDATE,
};
use weldsuite_db::{is_unique_violation, orm, utc_now};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    commerce_channels, storefront_menus, storefront_pages, storefront_redirects,
    storefront_site_versions, storefront_sites,
};

use super::document::{LOCALES, Problems, check_document};
use super::registry::{self, SiteMirror};
use super::{
    body_object, conflict, failed, invalid, invalid_field, iso, not_found, optional_text, tokens,
    unavailable,
};
use crate::{Caller, CommerceState};

/// The document a new online store starts from, as the theme exports it.
pub(crate) static DEFAULT_SITE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../catalogs/storefront-default-site.json"
    ))
    .unwrap_or(Value::Null)
});

/// Versions listed at most.
const VERSION_LIST: u64 = 50;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([WEBSITES_READ]);
    Router::new()
        .route("/sites", get(list).route_layer(read()))
        .route(
            "/sites",
            post(create).route_layer(gate.require([WEBSITES_CREATE])),
        )
        .route("/sites/{id}", get(detail).route_layer(read()))
        .route(
            "/sites/{id}",
            patch(update).route_layer(gate.require([WEBSITES_UPDATE])),
        )
        .route(
            "/sites/{id}",
            delete(remove).route_layer(gate.require([WEBSITES_DELETE])),
        )
        .route(
            "/sites/{id}/draft",
            put(save_draft).route_layer(gate.require([WEBSITES_UPDATE])),
        )
        .route(
            "/sites/{id}/publish",
            post(publish).route_layer(gate.require([WEBSITES_MANAGE])),
        )
        .route("/sites/{id}/versions", get(versions).route_layer(read()))
        .route(
            "/sites/{id}/versions/{version_id}/restore",
            post(restore).route_layer(gate.require([WEBSITES_MANAGE])),
        )
        .route(
            "/sites/{id}/versions/{version_id}/copy-to-draft",
            post(copy_to_draft).route_layer(gate.require([WEBSITES_UPDATE])),
        )
        .route("/sites/{id}/preview", post(preview).route_layer(read()))
}

// ── Loading and presenting ─────────────────────────────────────────────

pub(crate) async fn load_site(
    db: &DatabaseConnection,
    id: &str,
) -> Result<Option<storefront_sites::Model>, DbErr> {
    storefront_sites::Entity::find_by_id(id.to_owned())
        .filter(storefront_sites::Column::DeletedAt.is_null())
        .one(db)
        .await
}

/// A native storefront channel (not deleted, not a connected store).
async fn storefront_channel(
    db: &DatabaseConnection,
    id: &str,
) -> Result<Option<commerce_channels::Model>, DbErr> {
    Ok(commerce_channels::Entity::find_by_id(id.to_owned())
        .filter(commerce_channels::Column::DeletedAt.is_null())
        .one(db)
        .await?
        .filter(|channel| channel.type_ == "storefront" && channel.connection_id.is_none()))
}

/// The site's hosts as the API shows them: the primary and the preview
/// host (its free address, else the primary).
#[derive(Debug, Default)]
pub(crate) struct SiteHosts {
    pub(crate) primary: Option<String>,
    pub(crate) preview: Option<String>,
}

pub(crate) async fn site_hosts(caller: &Caller, site_id: &str) -> SiteHosts {
    let Some(master) = &caller.registry else {
        return SiteHosts::default();
    };
    match registry::site_hosts(master, &caller.workspace_id, site_id).await {
        Ok(rows) => {
            let active: Vec<_> = rows.iter().filter(|h| h.status == "active").collect();
            let primary = active.first().map(|h| h.hostname.clone());
            let preview = active
                .iter()
                .find(|h| h.kind == "subdomain")
                .map(|h| h.hostname.clone())
                .or_else(|| primary.clone());
            SiteHosts { primary, preview }
        }
        Err(error) => {
            tracing::warn!(%error, "[online-store] the site's hosts could not be read");
            SiteHosts::default()
        }
    }
}

async fn version_number(db: &DatabaseConnection, id: Option<&str>) -> Result<Option<i32>, DbErr> {
    let Some(id) = id else {
        return Ok(None);
    };
    Ok(storefront_site_versions::Entity::find_by_id(id.to_owned())
        .one(db)
        .await?
        .map(|version| version.number))
}

pub(crate) fn present(
    site: &storefront_sites::Model,
    channel: Option<&commerce_channels::Model>,
    hosts: &SiteHosts,
    version_number: Option<i32>,
    with_draft: bool,
) -> Value {
    let unpublished = match (site.published_at, site.draft_updated_at) {
        (None, _) => true,
        (Some(published), Some(changed)) => changed > published,
        (Some(_), None) => false,
    };
    let mut value = json!({
        "id": site.id,
        "channelId": site.channel_id,
        "channelName": channel.map(|c| c.name.clone()),
        "channelStatus": channel.map(|c| c.status.clone()),
        "mode": site.mode,
        "locale": site.locale,
        "theme": site.theme,
        "visibility": site.visibility,
        "hasPassword": site.password_hash.is_some(),
        "draftRevision": site.draft_revision,
        "draftUpdatedAt": site.draft_updated_at.map(iso),
        "publishedVersionId": site.published_version_id,
        "publishedVersionNumber": version_number,
        "publishedAt": site.published_at.map(iso),
        "hasUnpublishedChanges": unpublished,
        "activeDeploymentId": site.active_deployment_id,
        "primaryHost": hosts.primary,
        "previewHost": hosts.preview,
        "createdAt": iso(site.created_at),
        "updatedAt": iso(site.updated_at),
    });
    if with_draft {
        value["draft"] = site.draft.clone();
    }
    value
}

async fn present_full(
    caller: &Caller,
    db: &DatabaseConnection,
    site: &storefront_sites::Model,
    with_draft: bool,
) -> Result<Value, DbErr> {
    let channel = commerce_channels::Entity::find_by_id(site.channel_id.clone())
        .one(db)
        .await?;
    let number = version_number(db, site.published_version_id.as_deref()).await?;
    let hosts = site_hosts(caller, &site.id).await;
    Ok(present(site, channel.as_ref(), &hosts, number, with_draft))
}

/// Mirrors the site onto its host rows (the edge's view); a failure is
/// logged, not answered: the next change or the sweep catches up.
pub(crate) async fn mirror(state: &CommerceState, caller: &Caller, site: &storefront_sites::Model) {
    let Some(master) = &caller.registry else {
        return;
    };
    let mirror = SiteMirror {
        mode: site.mode.clone(),
        published_version_id: site.published_version_id.clone(),
        deployment_id: site.active_deployment_id.clone(),
        visibility: site.visibility.clone(),
        password_hash: site.password_hash.clone(),
    };
    if let Err(error) = registry::sync_site(
        master,
        state.online_store.cache.as_ref(),
        &caller.workspace_id,
        &site.id,
        &mirror,
    )
    .await
    {
        tracing::error!(%error, site = %site.id, "[online-store] the hosts could not be updated");
    }
}

// ── Routes ─────────────────────────────────────────────────────────────

async fn list(caller: Caller) -> Response {
    const FAILED: &str = "Failed to fetch online stores";
    let db = orm(&caller.db);
    let result = async {
        let sites = storefront_sites::Entity::find()
            .filter(storefront_sites::Column::DeletedAt.is_null())
            .order_by_asc(storefront_sites::Column::CreatedAt)
            .all(&db)
            .await?;
        let mut out = Vec::with_capacity(sites.len());
        for site in &sites {
            out.push(present_full(&caller, &db, site, false).await?);
        }
        Ok::<_, DbErr>(out)
    }
    .await;
    match result {
        Ok(sites) => Data(Value::Array(sites)).into_response(),
        Err(error) => failed(&error, FAILED),
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "the channel, the uniqueness, the row and its menus in turn"
)]
async fn create(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create the online store";
    let body = match body_object(&headers, &body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let mut problems = Problems::default();
    let channel_id = body
        .get("channelId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    if channel_id.is_none() {
        problems.add("channelId", "Required");
    }
    let mode = read_choice(
        &body,
        "mode",
        &["builder", "static"],
        "builder",
        &mut problems,
    );
    let locale = read_choice(&body, "locale", &LOCALES, "en", &mut problems);
    if !problems.is_empty() {
        return invalid(&problems.0);
    }
    let channel_id = channel_id.unwrap_or_default();
    if DEFAULT_SITE.is_null() {
        return failed(&"no default site document", FAILED);
    }
    let db = orm(&caller.db);
    match storefront_channel(&db, &channel_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            return invalid_field(
                "channelId",
                "Must be one of your own storefront channels (not a connected store)",
            );
        }
        Err(error) => return failed(&error, FAILED),
    }
    let existing = storefront_sites::Entity::find()
        .filter(storefront_sites::Column::ChannelId.eq(channel_id.clone()))
        .filter(storefront_sites::Column::DeletedAt.is_null())
        .one(&db)
        .await;
    match existing {
        Ok(Some(site)) => {
            return conflict(
                "SITE_EXISTS",
                "This channel has an online store already",
                Some(json!({ "siteId": site.id })),
            );
        }
        Ok(None) => {}
        Err(error) => return failed(&error, FAILED),
    }
    let now = utc_now();
    let row = storefront_sites::ActiveModel {
        id: Set(generate_id("sfs")),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
        channel_id: Set(channel_id),
        mode: Set(mode),
        locale: Set(locale),
        theme: Set("atelier".to_owned()),
        draft: Set(DEFAULT_SITE.clone()),
        draft_revision: Set(0),
        draft_updated_at: Set(Some(now)),
        published_version_id: Set(None),
        published_at: Set(None),
        active_deployment_id: Set(None),
        visibility: Set("live".to_owned()),
        password_hash: Set(None),
        created_by: Set(Some(caller.user_id.clone())),
    };
    let site = match storefront_sites::Entity::insert(row)
        .exec_with_returning(&db)
        .await
    {
        Ok(site) => site,
        Err(error) if is_unique_violation(&error) => {
            return conflict(
                "SITE_EXISTS",
                "This channel has an online store already",
                None,
            );
        }
        Err(error) => return failed(&error, FAILED),
    };
    // The main and footer menus exist from the start.
    for (handle, title) in [("main", "Main menu"), ("footer", "Footer menu")] {
        let menu = storefront_menus::ActiveModel {
            id: Set(generate_id("sfm")),
            created_at: Set(now),
            updated_at: Set(now),
            site_id: Set(site.id.clone()),
            handle: Set(handle.to_owned()),
            title: Set(title.to_owned()),
            items: Set(default_menu(handle)),
        };
        if let Err(error) = storefront_menus::Entity::insert(menu)
            .exec_without_returning(&db)
            .await
        {
            tracing::warn!(%error, "[online-store] a default menu was not created");
        }
    }
    match present_full(&caller, &db, &site, true).await {
        Ok(value) => {
            let mut event = value.clone();
            event.as_object_mut().map(|o| o.remove("draft"));
            caller.publish(&state, STOREFRONT_SITE_CREATED, &site.id, &event);
            Created(value).into_response()
        }
        Err(error) => failed(&error, FAILED),
    }
}

fn default_menu(handle: &str) -> Value {
    if handle == "main" {
        json!([
            { "id": "home", "label": "Home", "link": { "type": "home" } },
            { "id": "shop", "label": "Shop", "link": { "type": "catalog" } }
        ])
    } else {
        json!([{ "id": "search", "label": "Search", "link": { "type": "search" } }])
    }
}

fn read_choice(
    body: &Map<String, Value>,
    key: &str,
    choices: &[&str],
    fallback: &str,
    problems: &mut Problems,
) -> String {
    match body.get(key) {
        None | Some(Value::Null) => fallback.to_owned(),
        Some(Value::String(value)) if choices.contains(&value.as_str()) => value.clone(),
        Some(_) => {
            problems.add(key, format!("Must be one of: {}", choices.join(", ")));
            fallback.to_owned()
        }
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch the online store";
    let db = orm(&caller.db);
    match load_site(&db, &id).await {
        Ok(Some(site)) => match present_full(&caller, &db, &site, true).await {
            Ok(value) => Data(value).into_response(),
            Err(error) => failed(&error, FAILED),
        },
        Ok(None) => not_found("Online store", &id),
        Err(error) => failed(&error, FAILED),
    }
}

#[allow(clippy::too_many_lines, reason = "each field's rule in turn")]
async fn update(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update the online store";
    let body = match body_object(&headers, &body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let db = orm(&caller.db);
    let site = match load_site(&db, &id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &id),
        Err(error) => return failed(&error, FAILED),
    };
    let manages = caller.permissions.has_any(&[WEBSITES_MANAGE]);
    let mut problems = Problems::default();
    let mut change = storefront_sites::ActiveModel {
        id: Set(site.id.clone()),
        updated_at: Set(utc_now()),
        ..Default::default()
    };
    if body.contains_key("locale") {
        change.locale = Set(read_choice(
            &body,
            "locale",
            &LOCALES,
            &site.locale,
            &mut problems,
        ));
    }
    if body.contains_key("mode") {
        change.mode = Set(read_choice(
            &body,
            "mode",
            &["builder", "static"],
            &site.mode,
            &mut problems,
        ));
    }
    let mut password_hash = site.password_hash.clone();
    if body.contains_key("password") {
        if !manages {
            return forbidden_manage();
        }
        match optional_text(&body, "password", 200) {
            Ok(Some(Some(password))) if password.chars().count() >= 4 => {
                let Some(secret) = &state.online_store.secret else {
                    return unavailable(
                        "Shop passwords need STOREFRONT_RENDERER_SECRET on this install",
                    );
                };
                password_hash = tokens::hash_password(secret, &password);
            }
            Ok(Some(Some(_))) => problems.add("password", "At least 4 characters"),
            Ok(Some(None)) => password_hash = None,
            Ok(None) => {}
            Err((path, message)) => problems.add(path, message),
        }
        change.password_hash = Set(password_hash.clone());
    }
    if body.contains_key("visibility") {
        if !manages {
            return forbidden_manage();
        }
        let visibility = read_choice(
            &body,
            "visibility",
            &["live", "password", "coming_soon"],
            &site.visibility,
            &mut problems,
        );
        if visibility == "password" && password_hash.is_none() {
            problems.add("password", "Set a password to protect the shop with");
        }
        change.visibility = Set(visibility);
    } else if site.visibility == "password" && password_hash.is_none() {
        problems.add(
            "password",
            "The shop is protected by its password; set it live first",
        );
    }
    if !problems.is_empty() {
        return invalid(&problems.0);
    }
    let site = match storefront_sites::Entity::update(change).exec(&db).await {
        Ok(site) => site,
        Err(error) => return failed(&error, FAILED),
    };
    mirror(&state, &caller, &site).await;
    match present_full(&caller, &db, &site, false).await {
        Ok(value) => {
            caller.publish(&state, STOREFRONT_SITE_UPDATED, &site.id, &value);
            Data(value).into_response()
        }
        Err(error) => failed(&error, FAILED),
    }
}

fn forbidden_manage() -> Response {
    weldsuite_kit::ApiError::new(
        http::StatusCode::FORBIDDEN,
        "FORBIDDEN",
        "Changing the shop's visibility or password needs websites:manage",
    )
    .into_response()
}

async fn remove(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to delete the online store";
    let db = orm(&caller.db);
    let site = match load_site(&db, &id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &id),
        Err(error) => return failed(&error, FAILED),
    };
    if let Some(master) = &caller.registry {
        match registry::remove_site(
            master,
            state.online_store.cache.as_ref(),
            &caller.workspace_id,
            &site.id,
        )
        .await
        {
            Ok(rows) => {
                if let Some(domains) = &state.online_store.domains {
                    for row in rows.iter().filter(|h| h.kind == "custom") {
                        if let Err(error) = domains.remove(&row.hostname).await {
                            tracing::warn!(%error, host = %row.hostname, "[online-store] the host's certificate and route were not removed");
                        }
                    }
                }
            }
            Err(error) => return failed(&error, FAILED),
        }
    }
    let now = utc_now();
    let change = storefront_sites::ActiveModel {
        id: Set(site.id.clone()),
        deleted_at: Set(Some(now)),
        updated_at: Set(now),
        ..Default::default()
    };
    if let Err(error) = storefront_sites::Entity::update(change).exec(&db).await {
        return failed(&error, FAILED);
    }
    caller.publish(
        &state,
        STOREFRONT_SITE_DELETED,
        &site.id,
        &json!({ "id": site.id, "channelId": site.channel_id }),
    );
    NoContent.into_response()
}

async fn save_draft(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to save the draft";
    let body = match body_object(&headers, &body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(revision) = body.get("revision").and_then(Value::as_i64) else {
        return invalid_field(
            "revision",
            "Required: the draftRevision this edit is based on",
        );
    };
    let Some(document) = body.get("document") else {
        return invalid_field("document", "Required");
    };
    let problems = check_document(document);
    if !problems.is_empty() {
        let fields: Vec<(String, String)> = problems
            .0
            .into_iter()
            .map(|(path, message)| (format!("document.{path}"), message))
            .collect();
        return invalid(&fields);
    }
    let db = orm(&caller.db);
    let now = utc_now();
    let result = storefront_sites::Entity::update_many()
        .col_expr(
            storefront_sites::Column::Draft,
            Expr::value(document.clone()),
        )
        .col_expr(
            storefront_sites::Column::DraftRevision,
            sea_orm::ExprTrait::add(Expr::col(storefront_sites::Column::DraftRevision), 1),
        )
        .col_expr(storefront_sites::Column::DraftUpdatedAt, Expr::value(now))
        .col_expr(storefront_sites::Column::UpdatedAt, Expr::value(now))
        .filter(storefront_sites::Column::Id.eq(id.clone()))
        .filter(storefront_sites::Column::DeletedAt.is_null())
        .filter(storefront_sites::Column::DraftRevision.eq(revision))
        .exec(&db)
        .await;
    match result {
        Ok(done) if done.rows_affected == 1 => {}
        Ok(_) => {
            return match load_site(&db, &id).await {
                Ok(Some(site)) => conflict(
                    "REVISION_CONFLICT",
                    "The draft was changed elsewhere; reload it",
                    Some(json!({ "currentRevision": site.draft_revision })),
                ),
                Ok(None) => not_found("Online store", &id),
                Err(error) => failed(&error, FAILED),
            };
        }
        Err(error) => return failed(&error, FAILED),
    }
    let revision = i32::try_from(revision + 1).unwrap_or(i32::MAX);
    caller.publish(
        &state,
        STOREFRONT_SITE_UPDATED,
        &id,
        &json!({ "id": id, "draftRevision": revision }),
    );
    Data(json!({ "draftRevision": revision, "draftUpdatedAt": iso(now) })).into_response()
}

/// The published document: the draft with the visible pages, the menus
/// and the redirects.
pub(crate) async fn snapshot(
    db: &impl sea_orm::ConnectionTrait,
    site: &storefront_sites::Model,
) -> Result<Value, DbErr> {
    let pages = storefront_pages::Entity::find()
        .filter(storefront_pages::Column::SiteId.eq(site.id.clone()))
        .filter(storefront_pages::Column::DeletedAt.is_null())
        .filter(storefront_pages::Column::Visible.eq(true))
        .order_by_asc(storefront_pages::Column::Position)
        .order_by_asc(storefront_pages::Column::CreatedAt)
        .all(db)
        .await?;
    let menus = storefront_menus::Entity::find()
        .filter(storefront_menus::Column::SiteId.eq(site.id.clone()))
        .all(db)
        .await?;
    let redirects = storefront_redirects::Entity::find()
        .filter(storefront_redirects::Column::SiteId.eq(site.id.clone()))
        .order_by_asc(storefront_redirects::Column::FromPath)
        .all(db)
        .await?;
    let mut document = site.draft.clone();
    let Some(object) = document.as_object_mut() else {
        return Ok(document);
    };
    object.insert(
        "pages".to_owned(),
        Value::Array(
            pages
                .iter()
                .map(|page| {
                    json!({
                        "id": page.id,
                        "title": page.title,
                        "slug": page.slug,
                        "seoTitle": page.seo_title,
                        "seoDescription": page.seo_description,
                        "sections": page.sections,
                    })
                })
                .collect(),
        ),
    );
    let mut menu_map = Map::new();
    for handle in ["main", "footer"] {
        menu_map.insert(handle.to_owned(), json!({ "title": handle, "items": [] }));
    }
    for menu in &menus {
        menu_map.insert(
            menu.handle.clone(),
            json!({ "title": menu.title, "items": menu.items }),
        );
    }
    object.insert("menus".to_owned(), Value::Object(menu_map));
    object.insert(
        "redirects".to_owned(),
        Value::Array(
            redirects
                .iter()
                .map(|r| json!({ "fromPath": r.from_path, "toPath": r.to_path }))
                .collect(),
        ),
    );
    Ok(document)
}

fn present_version(version: &storefront_site_versions::Model, live: Option<&str>) -> Value {
    json!({
        "id": version.id,
        "number": version.number,
        "note": version.note,
        "publishedByUserId": version.published_by,
        "createdAt": iso(version.created_at),
        "isLive": live == Some(version.id.as_str()),
    })
}

async fn publish(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to publish the online store";
    let body = match body_object(&headers, &body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let note = match optional_text(&body, "note", 500) {
        Ok(note) => note.flatten(),
        Err((path, message)) => return invalid_field(&path, &message),
    };
    let db = orm(&caller.db);
    let site = match load_site(&db, &id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &id),
        Err(error) => return failed(&error, FAILED),
    };
    if site.mode != "builder" {
        return conflict(
            "NOT_A_BUILDER_SITE",
            "This shop is hosted from your own deployments; promote a deployment instead",
            None,
        );
    }
    let problems = check_document(&site.draft);
    if !problems.is_empty() {
        let fields: Vec<(String, String)> = problems
            .0
            .into_iter()
            .map(|(path, message)| (format!("draft.{path}"), message))
            .collect();
        return invalid(&fields);
    }
    let result = async {
        let tx = db.begin().await?;
        // Serialise publishes of one site on its row.
        let locked = storefront_sites::Entity::find_by_id(site.id.clone())
            .lock_exclusive()
            .one(&tx)
            .await?
            .ok_or_else(|| DbErr::RecordNotFound(site.id.clone()))?;
        let document = snapshot(&tx, &locked).await?;
        let last: Option<i32> = storefront_site_versions::Entity::find()
            .select_only()
            .column_as(storefront_site_versions::Column::Number.max(), "max")
            .filter(storefront_site_versions::Column::SiteId.eq(site.id.clone()))
            .into_tuple::<Option<i32>>()
            .one(&tx)
            .await?
            .flatten();
        let now = utc_now();
        let version =
            storefront_site_versions::Entity::insert(storefront_site_versions::ActiveModel {
                id: Set(generate_id("sfv")),
                created_at: Set(now),
                site_id: Set(site.id.clone()),
                number: Set(last.unwrap_or(0) + 1),
                document: Set(document),
                note: Set(note.clone()),
                published_by: Set(Some(caller.user_id.clone())),
            })
            .exec_with_returning(&tx)
            .await?;
        let site = storefront_sites::Entity::update(storefront_sites::ActiveModel {
            id: Set(site.id.clone()),
            published_version_id: Set(Some(version.id.clone())),
            published_at: Set(Some(now)),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec(&tx)
        .await?;
        tx.commit().await?;
        Ok::<_, DbErr>((version, site))
    }
    .await;
    let (version, site) = match result {
        Ok(done) => done,
        Err(error) => return failed(&error, FAILED),
    };
    mirror(&state, &caller, &site).await;
    let presented = present_version(&version, Some(&version.id));
    caller.publish(&state, STOREFRONT_SITE_PUBLISHED, &site.id, &presented);
    match present_full(&caller, &db, &site, false).await {
        Ok(site) => {
            let mut answer = presented;
            answer["site"] = site;
            Created(answer).into_response()
        }
        Err(error) => failed(&error, FAILED),
    }
}

async fn versions(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch the versions";
    let db = orm(&caller.db);
    let site = match load_site(&db, &id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &id),
        Err(error) => return failed(&error, FAILED),
    };
    let versions = storefront_site_versions::Entity::find()
        .filter(storefront_site_versions::Column::SiteId.eq(site.id.clone()))
        .order_by_desc(storefront_site_versions::Column::Number)
        .limit(VERSION_LIST)
        .all(&db)
        .await;
    match versions {
        Ok(versions) => Data(Value::Array(
            versions
                .iter()
                .map(|v| present_version(v, site.published_version_id.as_deref()))
                .collect(),
        ))
        .into_response(),
        Err(error) => failed(&error, FAILED),
    }
}

async fn find_version(
    db: &DatabaseConnection,
    site_id: &str,
    version_id: &str,
) -> Result<Option<storefront_site_versions::Model>, DbErr> {
    storefront_site_versions::Entity::find_by_id(version_id.to_owned())
        .filter(storefront_site_versions::Column::SiteId.eq(site_id))
        .one(db)
        .await
}

async fn restore(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, version_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to restore the version";
    let db = orm(&caller.db);
    let site = match load_site(&db, &id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &id),
        Err(error) => return failed(&error, FAILED),
    };
    match find_version(&db, &site.id, &version_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return not_found("Version", &version_id),
        Err(error) => return failed(&error, FAILED),
    }
    let now = utc_now();
    let site = match storefront_sites::Entity::update(storefront_sites::ActiveModel {
        id: Set(site.id.clone()),
        published_version_id: Set(Some(version_id.clone())),
        published_at: Set(Some(now)),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec(&db)
    .await
    {
        Ok(site) => site,
        Err(error) => return failed(&error, FAILED),
    };
    mirror(&state, &caller, &site).await;
    match present_full(&caller, &db, &site, false).await {
        Ok(value) => {
            caller.publish(&state, STOREFRONT_SITE_RESTORED, &site.id, &value);
            Data(value).into_response()
        }
        Err(error) => failed(&error, FAILED),
    }
}

async fn copy_to_draft(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, version_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to copy the version into the draft";
    let db = orm(&caller.db);
    let site = match load_site(&db, &id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &id),
        Err(error) => return failed(&error, FAILED),
    };
    let version = match find_version(&db, &site.id, &version_id).await {
        Ok(Some(version)) => version,
        Ok(None) => return not_found("Version", &version_id),
        Err(error) => return failed(&error, FAILED),
    };
    // The site document only: pages, menus and redirects are edited where
    // they live.
    let mut draft = version.document.clone();
    if let Some(object) = draft.as_object_mut() {
        for key in ["pages", "menus", "redirects"] {
            object.remove(key);
        }
    }
    let now = utc_now();
    let site = match storefront_sites::Entity::update(storefront_sites::ActiveModel {
        id: Set(site.id.clone()),
        draft: Set(draft),
        draft_revision: Set(site.draft_revision.saturating_add(1)),
        draft_updated_at: Set(Some(now)),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec(&db)
    .await
    {
        Ok(site) => site,
        Err(error) => return failed(&error, FAILED),
    };
    match present_full(&caller, &db, &site, true).await {
        Ok(value) => {
            caller.publish(
                &state,
                STOREFRONT_SITE_UPDATED,
                &site.id,
                &json!({ "id": site.id, "draftRevision": site.draft_revision }),
            );
            Data(value).into_response()
        }
        Err(error) => failed(&error, FAILED),
    }
}

async fn preview(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to make a preview link";
    let Some(secret) = &state.online_store.secret else {
        return unavailable(
            "Previews need the storefront renderer on this install (STOREFRONT_RENDERER_SECRET)",
        );
    };
    let db = orm(&caller.db);
    let site = match load_site(&db, &id).await {
        Ok(Some(site)) => site,
        Ok(None) => return not_found("Online store", &id),
        Err(error) => return failed(&error, FAILED),
    };
    let hosts = site_hosts(&caller, &site.id).await;
    let Some(host) = hosts.preview else {
        return conflict(
            "NO_HOST",
            "Give the shop an address first (Settings → Apps → WeldCommerce → Online store)",
            None,
        );
    };
    let Some((token, expires)) = tokens::preview_token(secret, &site.id, &caller.workspace_id)
    else {
        return failed(&"the preview token could not be signed", FAILED);
    };
    let expires_at = time::OffsetDateTime::from_unix_timestamp(expires)
        .map(weldsuite_events::iso_timestamp)
        .unwrap_or_default();
    Data(json!({
        "url": format!("{}/__preview?token={token}", state.online_store.origin(&host)),
        "expiresAt": expires_at,
    }))
    .into_response()
}
