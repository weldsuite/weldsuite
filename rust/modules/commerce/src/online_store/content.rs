//! An online store's content pages, menus and redirects. They change what
//! the next publish snapshots; the live shop keeps its version until then.
//!
//!   GET    /sites/:id/pages                 POST { title, slug?, sections? }
//!   GET    /sites/:id/pages/:pageId         PATCH { title?, slug?, seoTitle?, seoDescription?, sections?, visible?, position? }
//!   DELETE /sites/:id/pages/:pageId
//!   GET    /sites/:id/menus                 (main and footer always listed)
//!   PUT    /sites/:id/menus/:handle         { title, items }
//!   DELETE /sites/:id/menus/:handle         (not main or footer)
//!   GET    /sites/:id/redirects             POST { fromPath, toPath }
//!   DELETE /sites/:id/redirects/:redirectId

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait,
    QueryFilter, QueryOrder,
};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    STOREFRONT_MENU_DELETED, STOREFRONT_MENU_UPDATED, STOREFRONT_PAGE_CREATED,
    STOREFRONT_PAGE_DELETED, STOREFRONT_PAGE_UPDATED, STOREFRONT_REDIRECT_CREATED,
    STOREFRONT_REDIRECT_DELETED,
};
use weldsuite_catalogs::permission_keys::{
    WEBSITES_CREATE, WEBSITES_DELETE, WEBSITES_READ, WEBSITES_UPDATE,
};
use weldsuite_db::{is_unique_violation, orm, utc_now};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    storefront_menus, storefront_pages, storefront_redirects, storefront_sites,
};

use super::document::{
    Problems, check_menu_items, check_sections, is_redirect_source, is_redirect_target, is_slug,
};
use super::sites::load_site;
use super::{body_object, conflict, failed, invalid, invalid_field, iso, not_found, optional_text};
use crate::{Caller, CommerceState};

const MAX_PAGES: u64 = 200;
const MAX_REDIRECTS: u64 = 2000;
const MAX_MENUS: u64 = 20;
const REQUIRED_MENUS: [&str; 2] = ["main", "footer"];

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([WEBSITES_READ]);
    let update = || gate.require([WEBSITES_UPDATE]);
    Router::new()
        .route("/sites/{id}/pages", get(pages).route_layer(read()))
        .route(
            "/sites/{id}/pages",
            post(create_page).route_layer(gate.require([WEBSITES_CREATE])),
        )
        .route("/sites/{id}/pages/{page_id}", get(page).route_layer(read()))
        .route(
            "/sites/{id}/pages/{page_id}",
            patch(update_page).route_layer(update()),
        )
        .route(
            "/sites/{id}/pages/{page_id}",
            delete(delete_page).route_layer(gate.require([WEBSITES_DELETE])),
        )
        .route("/sites/{id}/menus", get(menus).route_layer(read()))
        .route(
            "/sites/{id}/menus/{handle}",
            put(put_menu).route_layer(update()),
        )
        .route(
            "/sites/{id}/menus/{handle}",
            delete(delete_menu).route_layer(gate.require([WEBSITES_DELETE])),
        )
        .route("/sites/{id}/redirects", get(redirects).route_layer(read()))
        .route(
            "/sites/{id}/redirects",
            post(create_redirect).route_layer(update()),
        )
        .route(
            "/sites/{id}/redirects/{redirect_id}",
            delete(delete_redirect).route_layer(gate.require([WEBSITES_DELETE])),
        )
}

/// The site, or the route's answer.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
async fn site_or_answer(
    db: &DatabaseConnection,
    id: &str,
    message: &str,
) -> Result<storefront_sites::Model, Response> {
    match load_site(db, id).await {
        Ok(Some(site)) => Ok(site),
        Ok(None) => Err(not_found("Online store", id)),
        Err(error) => Err(failed(&error, message)),
    }
}

// ── Pages ──────────────────────────────────────────────────────────────

/// `Our Story!` → `our-story`.
pub(crate) fn slugify(title: &str) -> String {
    let mut slug = String::new();
    let mut dash = false;
    for c in title.chars() {
        let c = match c {
            'à'..='å' | 'À'..='Å' => 'a',
            'è'..='ë' | 'È'..='Ë' => 'e',
            'ì'..='ï' | 'Ì'..='Ï' => 'i',
            'ò'..='ö' | 'Ò'..='Ö' => 'o',
            'ù'..='ü' | 'Ù'..='Ü' => 'u',
            'ç' | 'Ç' => 'c',
            'ñ' | 'Ñ' => 'n',
            'ß' => 's',
            other => other,
        };
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !slug.is_empty() {
            slug.push('-');
            dash = true;
        }
        if slug.len() >= 100 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-').to_owned();
    if slug.is_empty() {
        "page".to_owned()
    } else {
        slug
    }
}

fn present_page(page: &storefront_pages::Model) -> Value {
    json!({
        "id": page.id,
        "siteId": page.site_id,
        "title": page.title,
        "slug": page.slug,
        "seoTitle": page.seo_title,
        "seoDescription": page.seo_description,
        "sections": page.sections,
        "visible": page.visible,
        "position": page.position,
        "createdAt": iso(page.created_at),
        "updatedAt": iso(page.updated_at),
    })
}

async fn live_pages(
    db: &DatabaseConnection,
    site_id: &str,
) -> Result<Vec<storefront_pages::Model>, DbErr> {
    storefront_pages::Entity::find()
        .filter(storefront_pages::Column::SiteId.eq(site_id))
        .filter(storefront_pages::Column::DeletedAt.is_null())
        .order_by_asc(storefront_pages::Column::Position)
        .order_by_asc(storefront_pages::Column::CreatedAt)
        .all(db)
        .await
}

async fn pages(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch the pages";
    let db = orm(&caller.db);
    let site = match site_or_answer(&db, &id, FAILED).await {
        Ok(site) => site,
        Err(response) => return response,
    };
    match live_pages(&db, &site.id).await {
        Ok(pages) => Data(Value::Array(pages.iter().map(present_page).collect())).into_response(),
        Err(error) => failed(&error, FAILED),
    }
}

async fn page(caller: Caller, Path((id, page_id)): Path<(String, String)>) -> Response {
    const FAILED: &str = "Failed to fetch the page";
    let db = orm(&caller.db);
    match find_page(&db, &id, &page_id).await {
        Ok(Some(page)) => Data(present_page(&page)).into_response(),
        Ok(None) => not_found("Page", &page_id),
        Err(error) => failed(&error, FAILED),
    }
}

async fn find_page(
    db: &DatabaseConnection,
    site_id: &str,
    page_id: &str,
) -> Result<Option<storefront_pages::Model>, DbErr> {
    storefront_pages::Entity::find_by_id(page_id.to_owned())
        .filter(storefront_pages::Column::SiteId.eq(site_id))
        .filter(storefront_pages::Column::DeletedAt.is_null())
        .one(db)
        .await
}

async fn slug_taken(
    db: &DatabaseConnection,
    site_id: &str,
    slug: &str,
    except: Option<&str>,
) -> Result<bool, DbErr> {
    let mut query = storefront_pages::Entity::find()
        .filter(storefront_pages::Column::SiteId.eq(site_id))
        .filter(storefront_pages::Column::Slug.eq(slug))
        .filter(storefront_pages::Column::DeletedAt.is_null());
    if let Some(except) = except {
        query = query.filter(storefront_pages::Column::Id.ne(except));
    }
    Ok(query.count(db).await? > 0)
}

#[allow(clippy::too_many_lines, reason = "each field's rule in turn")]
async fn create_page(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create the page";
    let body = match body_object(&headers, &body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let mut problems = Problems::default();
    let title = match optional_text(&body, "title", 255) {
        Ok(Some(Some(title))) => title,
        Ok(_) => {
            problems.add("title", "Required");
            String::new()
        }
        Err((path, message)) => {
            problems.add(path, message);
            String::new()
        }
    };
    let requested_slug = match optional_text(&body, "slug", 120) {
        Ok(slug) => slug.flatten(),
        Err((path, message)) => {
            problems.add(path, message);
            None
        }
    };
    if let Some(slug) = &requested_slug
        && !is_slug(slug, 120)
    {
        problems.add("slug", "Lower-case letters, digits and single hyphens");
    }
    let sections = body.get("sections").cloned().unwrap_or_else(|| json!([]));
    check_sections("content", &sections, "sections", &mut problems);
    if !problems.is_empty() {
        return invalid(&problems.0);
    }
    let db = orm(&caller.db);
    let site = match site_or_answer(&db, &id, FAILED).await {
        Ok(site) => site,
        Err(response) => return response,
    };
    let existing = match live_pages(&db, &site.id).await {
        Ok(pages) => pages,
        Err(error) => return failed(&error, FAILED),
    };
    if u64::try_from(existing.len()).unwrap_or(u64::MAX) >= MAX_PAGES {
        return conflict(
            "TOO_MANY_PAGES",
            &format!("A shop has at most {MAX_PAGES} pages"),
            None,
        );
    }
    let slug = if let Some(slug) = requested_slug {
        if existing.iter().any(|p| p.slug == slug) {
            return conflict(
                "SLUG_TAKEN",
                "Another page has this address",
                Some(json!({ "slug": slug })),
            );
        }
        slug
    } else {
        let base = slugify(&title);
        let mut slug = base.clone();
        let mut n = 2;
        while existing.iter().any(|p| p.slug == slug) {
            slug = format!("{base}-{n}");
            n += 1;
        }
        slug
    };
    let now = utc_now();
    let position = existing.iter().map(|p| p.position).max().unwrap_or(-1) + 1;
    let row = storefront_pages::ActiveModel {
        id: Set(generate_id("sfp")),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: Set(None),
        site_id: Set(site.id.clone()),
        title: Set(title),
        slug: Set(slug),
        seo_title: Set(None),
        seo_description: Set(None),
        sections: Set(sections),
        visible: Set(true),
        position: Set(position),
        created_by: Set(Some(caller.user_id.clone())),
    };
    match storefront_pages::Entity::insert(row)
        .exec_with_returning(&db)
        .await
    {
        Ok(page) => {
            let value = present_page(&page);
            caller.publish(&state, STOREFRONT_PAGE_CREATED, &page.id, &value);
            Created(value).into_response()
        }
        Err(error) if is_unique_violation(&error) => {
            conflict("SLUG_TAKEN", "Another page has this address", None)
        }
        Err(error) => failed(&error, FAILED),
    }
}

#[allow(clippy::too_many_lines, reason = "each field's rule in turn")]
async fn update_page(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, page_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update the page";
    let body = match body_object(&headers, &body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let db = orm(&caller.db);
    let page = match find_page(&db, &id, &page_id).await {
        Ok(Some(page)) => page,
        Ok(None) => return not_found("Page", &page_id),
        Err(error) => return failed(&error, FAILED),
    };
    let mut problems = Problems::default();
    let mut change = storefront_pages::ActiveModel {
        id: Set(page.id.clone()),
        updated_at: Set(utc_now()),
        ..Default::default()
    };
    match optional_text(&body, "title", 255) {
        Ok(Some(Some(title))) => change.title = Set(title),
        Ok(Some(None)) => problems.add("title", "Required"),
        Ok(None) => {}
        Err((path, message)) => problems.add(path, message),
    }
    match optional_text(&body, "slug", 120) {
        Ok(Some(Some(slug))) if is_slug(&slug, 120) => {
            match slug_taken(&db, &page.site_id, &slug, Some(&page.id)).await {
                Ok(true) => {
                    return conflict(
                        "SLUG_TAKEN",
                        "Another page has this address",
                        Some(json!({ "slug": slug })),
                    );
                }
                Ok(false) => change.slug = Set(slug),
                Err(error) => return failed(&error, FAILED),
            }
        }
        Ok(Some(_)) => problems.add("slug", "Lower-case letters, digits and single hyphens"),
        Ok(None) => {}
        Err((path, message)) => problems.add(path, message),
    }
    match optional_text(&body, "seoTitle", 255) {
        Ok(Some(value)) => change.seo_title = Set(value),
        Ok(None) => {}
        Err((path, message)) => problems.add(path, message),
    }
    match optional_text(&body, "seoDescription", 500) {
        Ok(Some(value)) => change.seo_description = Set(value),
        Ok(None) => {}
        Err((path, message)) => problems.add(path, message),
    }
    if let Some(sections) = body.get("sections") {
        check_sections("content", sections, "sections", &mut problems);
        change.sections = Set(sections.clone());
    }
    match body.get("visible") {
        None => {}
        Some(Value::Bool(visible)) => change.visible = Set(*visible),
        Some(_) => problems.add("visible", "Must be true or false"),
    }
    match body.get("position") {
        None => {}
        Some(value) => match value
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .filter(|n| *n >= 0)
        {
            Some(position) => change.position = Set(position),
            None => problems.add("position", "Must be a whole number of 0 or more"),
        },
    }
    if !problems.is_empty() {
        return invalid(&problems.0);
    }
    match storefront_pages::Entity::update(change).exec(&db).await {
        Ok(page) => {
            let value = present_page(&page);
            caller.publish(&state, STOREFRONT_PAGE_UPDATED, &page.id, &value);
            Data(value).into_response()
        }
        Err(error) if is_unique_violation(&error) => {
            conflict("SLUG_TAKEN", "Another page has this address", None)
        }
        Err(error) => failed(&error, FAILED),
    }
}

async fn delete_page(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, page_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to delete the page";
    let db = orm(&caller.db);
    let page = match find_page(&db, &id, &page_id).await {
        Ok(Some(page)) => page,
        Ok(None) => return not_found("Page", &page_id),
        Err(error) => return failed(&error, FAILED),
    };
    let now = utc_now();
    let change = storefront_pages::ActiveModel {
        id: Set(page.id.clone()),
        deleted_at: Set(Some(now)),
        updated_at: Set(now),
        ..Default::default()
    };
    match storefront_pages::Entity::update(change).exec(&db).await {
        Ok(_) => {
            caller.publish(
                &state,
                STOREFRONT_PAGE_DELETED,
                &page.id,
                &json!({ "id": page.id, "siteId": page.site_id }),
            );
            NoContent.into_response()
        }
        Err(error) => failed(&error, FAILED),
    }
}

// ── Menus ──────────────────────────────────────────────────────────────

fn present_menu(menu: &storefront_menus::Model) -> Value {
    json!({
        "handle": menu.handle,
        "title": menu.title,
        "items": menu.items,
        "updatedAt": iso(menu.updated_at),
    })
}

async fn menus(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch the menus";
    let db = orm(&caller.db);
    let site = match site_or_answer(&db, &id, FAILED).await {
        Ok(site) => site,
        Err(response) => return response,
    };
    let rows = match storefront_menus::Entity::find()
        .filter(storefront_menus::Column::SiteId.eq(site.id.clone()))
        .order_by_asc(storefront_menus::Column::CreatedAt)
        .all(&db)
        .await
    {
        Ok(rows) => rows,
        Err(error) => return failed(&error, FAILED),
    };
    let mut out: Vec<Value> = Vec::new();
    for handle in REQUIRED_MENUS {
        match rows.iter().find(|m| m.handle == handle) {
            Some(menu) => out.push(present_menu(menu)),
            None => out
                .push(json!({ "handle": handle, "title": handle, "items": [], "updatedAt": null })),
        }
    }
    out.extend(
        rows.iter()
            .filter(|m| !REQUIRED_MENUS.contains(&m.handle.as_str()))
            .map(present_menu),
    );
    Data(Value::Array(out)).into_response()
}

async fn put_menu(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, handle)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to save the menu";
    if !is_slug(&handle, 40) {
        return invalid_field(
            "handle",
            "Lower-case letters, digits and single hyphens, at most 40",
        );
    }
    let body = match body_object(&headers, &body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let mut problems = Problems::default();
    let title = match optional_text(&body, "title", 120) {
        Ok(Some(Some(title))) => title,
        Ok(_) => {
            problems.add("title", "Required");
            String::new()
        }
        Err((path, message)) => {
            problems.add(path, message);
            String::new()
        }
    };
    let items = body.get("items").cloned().unwrap_or_else(|| json!([]));
    check_menu_items(&items, &mut problems);
    if !problems.is_empty() {
        return invalid(&problems.0);
    }
    let db = orm(&caller.db);
    let site = match site_or_answer(&db, &id, FAILED).await {
        Ok(site) => site,
        Err(response) => return response,
    };
    let existing = storefront_menus::Entity::find()
        .filter(storefront_menus::Column::SiteId.eq(site.id.clone()))
        .filter(storefront_menus::Column::Handle.eq(handle.clone()))
        .one(&db)
        .await;
    let now = utc_now();
    let saved = match existing {
        Ok(Some(menu)) => {
            storefront_menus::Entity::update(storefront_menus::ActiveModel {
                id: Set(menu.id),
                title: Set(title),
                items: Set(items),
                updated_at: Set(now),
                ..Default::default()
            })
            .exec(&db)
            .await
        }
        Ok(None) => {
            match storefront_menus::Entity::find()
                .filter(storefront_menus::Column::SiteId.eq(site.id.clone()))
                .count(&db)
                .await
            {
                Ok(count) if count >= MAX_MENUS => {
                    return conflict(
                        "TOO_MANY_MENUS",
                        &format!("A shop has at most {MAX_MENUS} menus"),
                        None,
                    );
                }
                Ok(_) => {}
                Err(error) => return failed(&error, FAILED),
            }
            storefront_menus::Entity::insert(storefront_menus::ActiveModel {
                id: Set(generate_id("sfm")),
                created_at: Set(now),
                updated_at: Set(now),
                site_id: Set(site.id.clone()),
                handle: Set(handle.clone()),
                title: Set(title),
                items: Set(items),
            })
            .exec_with_returning(&db)
            .await
        }
        Err(error) => return failed(&error, FAILED),
    };
    match saved {
        Ok(menu) => {
            let value = present_menu(&menu);
            caller.publish(&state, STOREFRONT_MENU_UPDATED, &menu.id, &value);
            Data(value).into_response()
        }
        Err(error) => failed(&error, FAILED),
    }
}

async fn delete_menu(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, handle)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to delete the menu";
    if REQUIRED_MENUS.contains(&handle.as_str()) {
        return conflict(
            "MENU_REQUIRED",
            "The main and footer menus can be emptied, not deleted",
            None,
        );
    }
    let db = orm(&caller.db);
    let site = match site_or_answer(&db, &id, FAILED).await {
        Ok(site) => site,
        Err(response) => return response,
    };
    let result = storefront_menus::Entity::delete_many()
        .filter(storefront_menus::Column::SiteId.eq(site.id.clone()))
        .filter(storefront_menus::Column::Handle.eq(handle.clone()))
        .exec(&db)
        .await;
    match result {
        Ok(done) if done.rows_affected > 0 => {
            caller.publish(
                &state,
                STOREFRONT_MENU_DELETED,
                &site.id,
                &json!({ "siteId": site.id, "handle": handle }),
            );
            NoContent.into_response()
        }
        Ok(_) => not_found("Menu", &handle),
        Err(error) => failed(&error, FAILED),
    }
}

// ── Redirects ──────────────────────────────────────────────────────────

fn present_redirect(redirect: &storefront_redirects::Model) -> Value {
    json!({
        "id": redirect.id,
        "fromPath": redirect.from_path,
        "toPath": redirect.to_path,
        "createdAt": iso(redirect.created_at),
    })
}

async fn redirects(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch the redirects";
    let db = orm(&caller.db);
    let site = match site_or_answer(&db, &id, FAILED).await {
        Ok(site) => site,
        Err(response) => return response,
    };
    match storefront_redirects::Entity::find()
        .filter(storefront_redirects::Column::SiteId.eq(site.id.clone()))
        .order_by_asc(storefront_redirects::Column::FromPath)
        .all(&db)
        .await
    {
        Ok(rows) => Data(Value::Array(rows.iter().map(present_redirect).collect())).into_response(),
        Err(error) => failed(&error, FAILED),
    }
}

async fn create_redirect(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create the redirect";
    let body = match body_object(&headers, &body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let from = body
        .get("fromPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    let to = body
        .get("toPath")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    let mut problems = Problems::default();
    if !is_redirect_source(&from) {
        problems.add("fromPath", "A path of the shop, starting with /");
    }
    if !is_redirect_target(&to) {
        problems.add("toPath", "A path of the shop (/…) or an https:// address");
    }
    if from == to {
        problems.add("toPath", "Must differ from fromPath");
    }
    if !problems.is_empty() {
        return invalid(&problems.0);
    }
    let db = orm(&caller.db);
    let site = match site_or_answer(&db, &id, FAILED).await {
        Ok(site) => site,
        Err(response) => return response,
    };
    match storefront_redirects::Entity::find()
        .filter(storefront_redirects::Column::SiteId.eq(site.id.clone()))
        .count(&db)
        .await
    {
        Ok(count) if count >= MAX_REDIRECTS => {
            return conflict(
                "TOO_MANY_REDIRECTS",
                &format!("A shop has at most {MAX_REDIRECTS} redirects"),
                None,
            );
        }
        Ok(_) => {}
        Err(error) => return failed(&error, FAILED),
    }
    let row = storefront_redirects::ActiveModel {
        id: Set(generate_id("sfr")),
        created_at: Set(utc_now()),
        site_id: Set(site.id.clone()),
        from_path: Set(from),
        to_path: Set(to),
    };
    match storefront_redirects::Entity::insert(row)
        .exec_with_returning(&db)
        .await
    {
        Ok(redirect) => {
            let value = present_redirect(&redirect);
            caller.publish(&state, STOREFRONT_REDIRECT_CREATED, &redirect.id, &value);
            Created(value).into_response()
        }
        Err(error) if is_unique_violation(&error) => {
            conflict("REDIRECT_EXISTS", "This path redirects already", None)
        }
        Err(error) => failed(&error, FAILED),
    }
}

async fn delete_redirect(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, redirect_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to delete the redirect";
    let db = orm(&caller.db);
    let result = storefront_redirects::Entity::delete_many()
        .filter(storefront_redirects::Column::Id.eq(redirect_id.clone()))
        .filter(storefront_redirects::Column::SiteId.eq(id.clone()))
        .exec(&db)
        .await;
    match result {
        Ok(done) if done.rows_affected > 0 => {
            caller.publish(
                &state,
                STOREFRONT_REDIRECT_DELETED,
                &redirect_id,
                &json!({ "id": redirect_id, "siteId": id }),
            );
            NoContent.into_response()
        }
        Ok(_) => not_found("Redirect", &redirect_id),
        Err(error) => failed(&error, FAILED),
    }
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn slugs_from_titles() {
        assert_eq!(slugify("Our Story!"), "our-story");
        assert_eq!(slugify("Algemene voorwaarden"), "algemene-voorwaarden");
        assert_eq!(slugify("Über uns & Café"), "uber-uns-cafe");
        assert_eq!(slugify("!!!"), "page");
    }
}
