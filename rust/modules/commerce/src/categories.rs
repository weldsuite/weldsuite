//! `/api/categories`: hierarchical product categories (ADR COM-010,
//! re-adopting COM-001 and COM-002). A category is `manual` (its members are
//! rows in `category_products`, curated through `POST|DELETE
//! /api/categories/:id/products`, the junction's only writer) or `automated`
//! (its members are the products its rules match, evaluated on every read;
//! [`crate::rules`]). Also `GET /api/products/:id/categories`, the manual
//! categories a product is in.
//!
//! The tree is maintained here, under a transaction-scoped advisory lock so
//! two writes cannot interleave their checks:
//!
//! - `path` is the ancestor chain of ids (`/cat_a/cat_b`), `depth` the
//!   distance from the root; a move re-paths the whole subtree.
//! - A category cannot sit under itself or its own descendant, and the tree
//!   is at most [`MAX_CATEGORY_DEPTH`] levels deep, subtree included.
//! - A slug is derived from the name when none is given, and unique among
//!   its siblings: a taken one gets `-2`, `-3`, … (there is no index for it).
//! - A category with children cannot be deleted (409).
//!
//! Ported from the removed commerce-api (`routes/categories/index.ts`,
//! `services/product-categories.ts`) and its Rust twin, with these changes:
//! slugs are unique per parent instead of per workspace, the depth limit
//! counts the subtree a move carries, a rule must fit its column when it is
//! written, the member writes of an automated category are a 409, and rows
//! carry `isActive` as a boolean.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Alias, Expr, Func, IntoIden, Query, SelectStatement};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, JoinType,
    PaginatorTrait, QueryFilter, QueryOrder, QueryResult, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;
use weldsuite_catalogs::entity_events::{CATEGORY_CREATED, CATEGORY_DELETED, CATEGORY_UPDATED};
use weldsuite_catalogs::permission_keys::{
    CATEGORIES_CREATE, CATEGORIES_DELETE, CATEGORIES_READ, CATEGORIES_UPDATE,
};
use weldsuite_db::{OrmConn, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{categories, category_products, products};

use crate::args::{advisory_lock, after_cursor, now_stamped};
use crate::rules::{read_rules, rules_match, rules_param, stored_rules};
use crate::tables::{CATEGORIES, PRODUCTS};
use crate::{Caller, CommerceState, Refusal, internal, now, validate, validate_query};

/// Categories nest at most this many levels (depth 0 to 9).
pub(crate) const MAX_CATEGORY_DEPTH: i64 = 10;

/// How a category's members are listed.
const SORT_ORDERS: &[&str] = &[
    "manual",
    "best-selling",
    "alpha-asc",
    "alpha-desc",
    "price-asc",
    "price-desc",
    "created-desc",
    "created-asc",
];

/// Taken by every write that checks the tree (slugs, placement).
const TREE_LOCK: &str = "weldcommerce:categories";

/// How many products a preview shows.
const PREVIEW_LIMIT: i64 = 20;

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([CATEGORIES_READ]);
    let update = || gate.require([CATEGORIES_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route(
            "/",
            post(create).route_layer(gate.require([CATEGORIES_CREATE])),
        )
        .route("/tree", get(tree).route_layer(read()))
        .route("/preview-members", post(preview).route_layer(read()))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", patch(update_category).route_layer(update()))
        .route(
            "/{id}",
            delete(remove).route_layer(gate.require([CATEGORIES_DELETE])),
        )
        .route("/{id}/products", get(members).route_layer(read()))
        .route("/{id}/products", post(add_products).route_layer(update()))
        .route(
            "/{id}/products/{product_id}",
            delete(remove_product).route_layer(update()),
        )
}

/// `GET /api/products/:id/categories`, nested under `/products`.
pub(crate) fn product_routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route(
        "/{id}/categories",
        get(product_categories).route_layer(gate.require([CATEGORIES_READ])),
    )
}

// ── rows ────────────────────────────────────────────────────────────────────

/// A category as the API answers it: Drizzle's row, `isActive` a boolean,
/// the defaults of the membership columns filled in, and without the
/// unmaintained `productCount` (counts come from the members' `totalCount`).
fn present(mut row: Value) -> Value {
    if let Value::Object(fields) = &mut row {
        let active = fields.get("isActive").and_then(Value::as_i64).unwrap_or(1) == 1;
        fields.insert("isActive".to_owned(), json!(active));
        for (key, default) in [
            ("type", "manual"),
            ("rulesMatch", "all"),
            ("sortOrder", "manual"),
        ] {
            if fields.get(key).is_none_or(Value::is_null) {
                fields.insert(key.to_owned(), json!(default));
            }
        }
        fields.remove("productCount");
    }
    row
}

fn is_automated(category: &Value) -> bool {
    category.get("type").and_then(Value::as_str) == Some("automated")
}

fn category_event(category: &Value) -> Value {
    json!({
        "id": category["id"],
        "name": category.get("name").cloned().unwrap_or(Value::Null),
        "slug": category.get("slug").cloned().unwrap_or(Value::Null),
        "parentId": category.get("parentId").cloned().unwrap_or(Value::Null),
    })
}

/// A refusal with a machine-readable `details.code`.
fn refused(error: ApiError, code: &str) -> Refusal {
    error.with_details(json!({ "code": code })).into()
}

fn not_manual() -> Refusal {
    refused(
        ApiError::conflict(
            "Members of an automated category come from its rules \u{2014} edit the rules instead",
        ),
        "NOT_MANUAL",
    )
}

async fn live_category<C: ConnectionTrait>(db: &C, id: &str) -> Result<Option<Value>, DbErr> {
    Ok(CATEGORIES.find_live_on(db, id).await?.map(present))
}

/// The categories as Drizzle returns them, presented.
fn presented(rows: &[categories::Model]) -> Result<Vec<Value>, DbErr> {
    rows.iter()
        .map(|row| CATEGORIES.model(row).map(present))
        .collect()
}

/// Whether the live product `id` is there.
async fn product_exists(db: &weldsuite_db::PgPool, id: &str) -> Result<bool, DbErr> {
    let found: Option<String> = products::Entity::find_by_id(id)
        .filter(products::Column::DeletedAt.is_null())
        .select_only()
        .column(products::Column::Id)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

// ── slug and placement ──────────────────────────────────────────────────────

/// `slugify(input, fallback)`: lower case ASCII letters and digits joined by
/// single dashes, accents folded (`Schürzen` → `schurzen`), at most 255
/// characters; `fallback` when nothing is left.
pub(crate) fn slugify(input: &str, fallback: &str) -> String {
    let mut slug = String::new();
    let mut dash = false;
    let mut push = |c: char, slug: &mut String| {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash {
            slug.push('-');
            dash = true;
        }
    };
    for c in input.nfd().filter(|c| !is_combining_mark(*c)) {
        match c {
            'ß' => "ss".chars().for_each(|c| push(c, &mut slug)),
            'æ' | 'Æ' => "ae".chars().for_each(|c| push(c, &mut slug)),
            'œ' | 'Œ' => "oe".chars().for_each(|c| push(c, &mut slug)),
            'ø' | 'Ø' => push('o', &mut slug),
            'đ' | 'Đ' => push('d', &mut slug),
            'ł' | 'Ł' => push('l', &mut slug),
            c => push(c, &mut slug),
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(255).collect();
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        fallback.to_owned()
    } else {
        slug.to_owned()
    }
}

/// A slug free among the children of `parent` (roots when `None`): `desired`,
/// else `desired-2`, `desired-3`, … `exclude` lets a category keep its own.
async fn sibling_slug<C: ConnectionTrait>(
    db: &C,
    desired: &str,
    parent: Option<&str>,
    exclude: Option<&str>,
) -> Result<String, Refusal> {
    for attempt in 1..=50_u32 {
        let candidate = if attempt == 1 {
            desired.to_owned()
        } else {
            let suffix = format!("-{attempt}");
            let room = 255 - suffix.len();
            let stem: String = desired.chars().take(room).collect();
            format!("{}{suffix}", stem.trim_end_matches('-'))
        };
        // `parent_id is not distinct from parent`.
        let sibling = match parent {
            Some(parent) => categories::Column::ParentId.eq(parent),
            None => categories::Column::ParentId.is_null(),
        };
        let taken: Option<String> = categories::Entity::find()
            .select_only()
            .column(categories::Column::Id)
            .filter(categories::Column::Slug.eq(candidate.as_str()))
            .filter(categories::Column::DeletedAt.is_null())
            .filter(sibling)
            .filter(categories::Column::Id.ne(exclude.unwrap_or_default()))
            .into_tuple()
            .one(db)
            .await?;
        if taken.is_none() {
            return Ok(candidate);
        }
    }
    Err(refused(
        ApiError::conflict(format!("Could not find a free slug based on \"{desired}\"")),
        "SLUG_TAKEN",
    ))
}

/// `resolvePlacement`: where category `id` sits under `parent` (`path`,
/// `depth`). `height` is how many levels the category's subtree adds below
/// it (0 for a new category).
async fn placement<C: ConnectionTrait>(
    db: &C,
    id: &str,
    parent: Option<&str>,
    height: i64,
) -> Result<(String, i64), Refusal> {
    let Some(parent_id) = parent else {
        if height >= MAX_CATEGORY_DEPTH {
            return Err(too_deep());
        }
        return Ok((format!("/{id}"), 0));
    };
    if parent_id == id {
        return Err(refused(
            ApiError::bad_request("A category cannot be its own parent"),
            "CYCLE",
        ));
    }
    let row: Option<(String, Option<String>, Option<i32>)> =
        categories::Entity::find_by_id(parent_id)
            .select_only()
            .columns([
                categories::Column::Id,
                categories::Column::Path,
                categories::Column::Depth,
            ])
            .filter(categories::Column::DeletedAt.is_null())
            .into_tuple()
            .one(db)
            .await?;
    let Some((parent, path, depth)) = row else {
        return Err(refused(
            ApiError::not_found("Parent category", Some(parent_id)),
            "PARENT_NOT_FOUND",
        ));
    };
    // A parent whose own path holds this category would make the tree a ring.
    let parent_path = path.unwrap_or_else(|| format!("/{parent}"));
    if parent_path.split('/').any(|segment| segment == id) {
        return Err(refused(
            ApiError::bad_request("A category cannot be moved beneath its own descendant"),
            "CYCLE",
        ));
    }
    let depth = i64::from(depth.unwrap_or(0)) + 1;
    if depth + height >= MAX_CATEGORY_DEPTH {
        return Err(too_deep());
    }
    Ok((format!("{parent_path}/{id}"), depth))
}

fn too_deep() -> Refusal {
    refused(
        ApiError::bad_request(format!(
            "Categories may not nest deeper than {MAX_CATEGORY_DEPTH} levels"
        )),
        "TOO_DEEP",
    )
}

/// How many levels the subtree under the category at `path` (depth `depth`)
/// adds.
async fn subtree_height<C: ConnectionTrait>(db: &C, path: &str, depth: i64) -> Result<i64, DbErr> {
    let deepest: Option<Option<i32>> = categories::Entity::find()
        .select_only()
        .column_as(categories::Column::Depth.max(), "max")
        .filter(categories::Column::Path.like(format!("{}/%", like_escape(path))))
        .filter(categories::Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await?;
    Ok(deepest
        .flatten()
        .map_or(0, |deepest| (i64::from(deepest) - depth).max(0)))
}

fn like_escape(value: &str) -> String {
    crate::rules::like_literal(value)
}

/// `reparentDescendants`: the subtree under `old` moves under `new`.
async fn reparent_descendants<C: ConnectionTrait>(
    db: &C,
    id: &str,
    old: &str,
    new: &str,
    now: PrimitiveDateTime,
) -> Result<(), DbErr> {
    if old == new {
        return Ok(());
    }
    let segments = |path: &str| i64::try_from(path.split('/').count()).unwrap_or(0);
    let shift = segments(new) - segments(old);
    let from = i64::try_from(old.chars().count()).unwrap_or(0) + 1;
    // `$1::text || substr(path, $2)`: the integer start is load-bearing,
    // `substring(x from $n)` with an untyped parameter picks the regex
    // overload and blanks every path.
    let path = sea_orm::sea_query::extension::postgres::PgExpr::concat(
        Expr::val(new),
        Func::cust("substr")
            .arg(Expr::col((categories::Entity, categories::Column::Path)))
            .arg(i32::try_from(from).unwrap_or(i32::MAX)),
    );
    let depth = sea_orm::ExprTrait::add(
        Func::coalesce([
            Expr::col((categories::Entity, categories::Column::Depth)),
            Expr::val(0),
        ]),
        i32::try_from(shift).unwrap_or(0),
    );
    categories::Entity::update_many()
        .col_expr(categories::Column::Path, path)
        .col_expr(categories::Column::Depth, depth)
        .col_expr(categories::Column::UpdatedAt, Expr::val(now))
        .filter(categories::Column::Path.like(format!("{}/%", like_escape(old))))
        .filter(categories::Column::Id.ne(id))
        .filter(categories::Column::DeletedAt.is_null())
        .exec(db)
        .await?;
    Ok(())
}

// ── list, tree, one ─────────────────────────────────────────────────────────

/// The list's filters: live, roots only (`parentId=null`), a parent,
/// `type` (`manual` when unset), `search` on name and slug.
fn list_filters(
    roots: bool,
    parent: Option<String>,
    kind: Option<String>,
    search: Option<&str>,
) -> Condition {
    let mut all = Condition::all().add(categories::Column::DeletedAt.is_null());
    if roots {
        all = all.add(categories::Column::ParentId.is_null());
    }
    if let Some(parent) = parent {
        all = all.add(categories::Column::ParentId.eq(parent));
    }
    if let Some(kind) = kind {
        all = all.add(sea_orm::ExprTrait::eq(
            Func::coalesce([
                Expr::col((categories::Entity, categories::Column::Type)),
                Expr::val("manual"),
            ]),
            kind,
        ));
    }
    if let Some(search) = search {
        all = all.add(
            Condition::any()
                .add(categories::Column::Name.ilike(search))
                .add(categories::Column::Slug.ilike(search)),
        );
    }
    all
}

/// `GET /`: newest first. `parentId=null` asks for roots (an absent
/// `parentId` is any parent), `type`, `search` on name and slug.
async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list categories";
    let query = query.as_deref();
    let param = |name: &str| crate::js::query_set(query, name);
    let limit = weldsuite_kit::parse_limit(param("limit").as_deref(), 25, 100);
    let parent = param("parentId");
    let roots = parent.as_deref() == Some("null");
    let parent = parent.filter(|p| p != "null");
    let kind = param("type");
    let search = param("search").map(|s| format!("%{}%", like_escape(&s)));
    let cursor = param("cursor");
    let filters = list_filters(roots, parent, kind, search.as_deref());
    let mut page = categories::Entity::find().filter(filters.clone());
    if let Some(cursor) = &cursor {
        page = page.filter(after_cursor::<categories::Entity>(
            categories::Column::CreatedAt,
            categories::Column::Id,
            cursor,
            true,
        ));
    }
    let db = orm(&caller.db);
    let rows = page
        .order_by_desc(categories::Column::CreatedAt)
        .order_by_desc(categories::Column::Id)
        .limit(u64::from(limit) + 1)
        .all(&db)
        .await
        .and_then(|rows| presented(&rows));
    let total = categories::Entity::find().filter(filters).count(&db).await;
    match (rows, total) {
        (Ok(rows), Ok(total)) => {
            let page = weldsuite_kit::Page::of(
                rows,
                usize::try_from(limit).unwrap_or(25),
                |row: &Value| row["id"].as_str().unwrap_or_default(),
            );
            page.into_list(total).into_response()
        }
        (Err(error), _) | (_, Err(error)) => internal(&error, FAILED),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch category";
    match live_category(&orm(&caller.db), &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Category", &id).respond(FAILED),
        Err(error) => internal(&error, FAILED),
    }
}

/// A tree node with its children's indexes.
struct Node {
    value: Map<String, Value>,
    position: i64,
    name: String,
    parent: Option<String>,
    children: Vec<usize>,
}

fn sort_nodes(nodes: &[Node], list: &mut [usize]) {
    list.sort_by(|a, b| {
        let (a, b) = (&nodes[*a], &nodes[*b]);
        a.position
            .cmp(&b.position)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

fn render(nodes: &[Node], index: usize) -> Value {
    let node = &nodes[index];
    let mut value = node.value.clone();
    value.insert(
        "children".to_owned(),
        Value::Array(
            node.children
                .iter()
                .map(|child| render(nodes, *child))
                .collect(),
        ),
    );
    Value::Object(value)
}

/// `buildTree(rows, rootId)`: the hierarchy, children by `position` then
/// name. A row whose parent is missing (deleted, or left out by
/// `activeOnly`) is a root: an orphaned branch stays reachable.
pub(crate) fn build_tree(rows: &[Value], root: Option<&str>) -> Value {
    let mut nodes: Vec<Node> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let id = row["id"].as_str().unwrap_or_default().to_owned();
        let parent = row
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let position = row.get("position").and_then(Value::as_i64).unwrap_or(0);
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        // The whole category, as `GET /:id` answers it: the back office edits
        // a category straight from its tree row.
        let mut value = row.as_object().cloned().unwrap_or_default();
        value.insert(
            "depth".to_owned(),
            json!(row["depth"].as_i64().unwrap_or(0)),
        );
        value.insert("position".to_owned(), json!(position));
        index.insert(id, nodes.len());
        nodes.push(Node {
            value,
            position,
            name,
            parent,
            children: Vec::new(),
        });
    }
    let mut roots = Vec::new();
    for at in 0..nodes.len() {
        let parent = nodes[at]
            .parent
            .as_ref()
            .and_then(|p| index.get(p))
            .copied()
            .filter(|parent| *parent != at);
        match parent {
            Some(parent) => nodes[parent].children.push(at),
            None => roots.push(at),
        }
    }
    for at in 0..nodes.len() {
        let mut children = std::mem::take(&mut nodes[at].children);
        sort_nodes(&nodes, &mut children);
        nodes[at].children = children;
    }
    sort_nodes(&nodes, &mut roots);
    if let Some(root) = root.filter(|r| !r.is_empty()) {
        return Value::Array(
            index
                .get(root)
                .map(|at| render(&nodes, *at))
                .into_iter()
                .collect(),
        );
    }
    Value::Array(roots.into_iter().map(|at| render(&nodes, at)).collect())
}

/// `GET /tree`: every live category nested under its parent (`children`).
/// `?rootId=` answers that subtree only; `?activeOnly=true` leaves out the
/// inactive ones.
async fn tree(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to build category tree";
    let read = validate_query(query.as_deref(), |issues, fields| {
        let root = issues
            .text_with(
                fields,
                "rootId",
                Presence::Optional,
                Text::length(None, Some(30)),
            )
            .into_option();
        let active_only = issues
            .choice(
                fields,
                "activeOnly",
                Presence::Optional,
                &["true", "false", "1", "0"],
            )
            .into_option()
            .is_some_and(|v| v == "true" || v == "1");
        (root, active_only)
    });
    let (root, active_only) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let mut rows = categories::Entity::find().filter(categories::Column::DeletedAt.is_null());
    if active_only {
        rows = rows.filter(sea_orm::ExprTrait::eq(
            Func::coalesce([
                Expr::col((categories::Entity, categories::Column::IsActive)),
                Expr::val(1),
            ]),
            1,
        ));
    }
    let rows = rows
        .order_by_asc(categories::Column::Depth)
        .order_by_asc(categories::Column::Position)
        .order_by_asc(categories::Column::Id)
        .all(&orm(&caller.db))
        .await
        .and_then(|rows| presented(&rows));
    match rows {
        Ok(rows) => Data(build_tree(&rows, root.as_deref())).into_response(),
        Err(error) => internal(&error, FAILED),
    }
}

// ── members ─────────────────────────────────────────────────────────────────

/// `coalesce(cp.position, 0)` of `table` (`category_products`, or its alias).
fn member_position(table: impl IntoIden) -> Expr {
    Func::coalesce([
        Expr::col((table.into_iden(), category_products::Column::Position)),
        Expr::val(0),
    ])
    .into()
}

/// A manual category in its curated order (`category_products.position`),
/// after the cursor product (none, or not a member: the first page), at
/// most `limit`; and how many members there are.
async fn manual_members(
    db: &weldsuite_db::PgPool,
    category: &str,
    cursor: Option<&str>,
    limit: i64,
) -> Result<(Vec<Value>, i64), DbErr> {
    let db = orm(db);
    let members = || {
        products::Entity::find()
            .join_rev(
                JoinType::InnerJoin,
                category_products::Entity::belongs_to(products::Entity)
                    .from(category_products::Column::ProductId)
                    .to(products::Column::Id)
                    .into(),
            )
            .filter(category_products::Column::CategoryId.eq(category))
            .filter(products::Column::DeletedAt.is_null())
    };
    let mut page = members();
    if let Some(cursor) = cursor {
        // `(coalesce(cp.position, 0), cp.id) > (… of the cursor's member)`,
        // unless the cursor is not a member.
        let row = Alias::new("c");
        let of_cursor = |select: &mut SelectStatement| {
            select
                .from_as(category_products::Entity, row.clone())
                .and_where(sea_orm::ExprTrait::eq(
                    Expr::col((row.clone(), category_products::Column::CategoryId)),
                    category,
                ))
                .and_where(sea_orm::ExprTrait::eq(
                    Expr::col((row.clone(), category_products::Column::ProductId)),
                    cursor,
                ))
                .to_owned()
        };
        let gone = of_cursor(Query::select().expr(Expr::val(1)));
        let at = of_cursor(
            Query::select()
                .expr(member_position(row.clone()))
                .column((row.clone(), category_products::Column::Id)),
        );
        let here = Expr::tuple([
            member_position(category_products::Entity),
            Expr::col((category_products::Entity, category_products::Column::Id)),
        ]);
        page = page.filter(
            Condition::any()
                .add(Expr::not_exists(gone))
                .add(sea_orm::ExprTrait::gt(here, at)),
        );
    }
    let rows = page
        .order_by_asc(member_position(category_products::Entity))
        .order_by_asc(category_products::Column::Id)
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(&db)
        .await?
        .iter()
        .map(|row| PRODUCTS.model(row))
        .collect::<Result<Vec<Value>, DbErr>>()?;
    let total = members().count(&db).await?;
    Ok((rows, i64::try_from(total).unwrap_or(i64::MAX)))
}

/// Membership of product `t`: the manual category `$<n>` when set, else the
/// rules `$1` matched by `$2`.
macro_rules! member {
    ($category:literal) => {
        concat!(
            "(case when $",
            $category,
            "::text is not null then exists (select 1 from category_products cp \
             where cp.category_id = $",
            $category,
            "::text and cp.product_id = t.id) else ",
            rules_match!(),
            " end)"
        )
    };
}

/// Members by a sort (`$3`), after the cursor product `$4` (none, or gone:
/// the first page), at most `$5`, of the manual category `$6` or the rules.
/// The keyset compares the columns the order uses, `id` breaking ties.
const SORTED_MEMBERS_SQL: &str = concat!(
    "select t.* from products t where t.deleted_at is null and ",
    member!(6),
    " and ($4::text is null or not exists (select 1 from products c where c.id = $4) or (case $3::text \
       when 'best-selling' then (coalesce(t.sales_count, 0), t.id) < (select coalesce(c.sales_count, 0), c.id from products c where c.id = $4) \
       when 'alpha-asc' then (t.name, t.id) > (select c.name, c.id from products c where c.id = $4) \
       when 'alpha-desc' then (t.name, t.id) < (select c.name, c.id from products c where c.id = $4) \
       when 'price-asc' then (t.price, t.id) > (select c.price, c.id from products c where c.id = $4) \
       when 'price-desc' then (t.price, t.id) < (select c.price, c.id from products c where c.id = $4) \
       when 'created-asc' then (t.created_at, t.id) > (select c.created_at, c.id from products c where c.id = $4) \
       else (t.created_at, t.id) < (select c.created_at, c.id from products c where c.id = $4) end)) \
     order by \
       case when $3::text = 'best-selling' then coalesce(t.sales_count, 0) end desc, \
       case when $3::text = 'alpha-asc' then t.name end asc, \
       case when $3::text = 'alpha-desc' then t.name end desc, \
       case when $3::text = 'price-asc' then t.price end asc, \
       case when $3::text = 'price-desc' then t.price end desc, \
       case when $3::text = 'created-asc' then t.created_at end asc, \
       case when $3::text not in ('best-selling', 'alpha-asc', 'alpha-desc', 'price-asc', 'price-desc', 'created-asc') then t.created_at end desc, \
       case when $3::text in ('alpha-asc', 'price-asc', 'created-asc') then t.id end asc, \
       case when $3::text not in ('alpha-asc', 'price-asc', 'created-asc') then t.id end desc \
     limit $5"
);

const SORTED_COUNT_SQL: &str = concat!(
    "select count(*) from products t where t.deleted_at is null and ",
    member!(3)
);

/// Where a listing's members come from.
enum Members<'a> {
    /// `category_products` of this category.
    Manual(&'a str),
    /// The rules (from [`rules_param`]), all or any of them.
    Rules { rules: Value, any: bool },
}

/// One page of members, `limit + 1` fetched to tell whether there is more.
async fn member_page(
    caller: &Caller,
    members: &Members<'_>,
    sort: &str,
    cursor: Option<&str>,
    limit: i64,
) -> Result<(Vec<Value>, i64), DbErr> {
    if let Members::Manual(category) = members
        && sort == "manual"
    {
        return manual_members(&caller.db, category, cursor, limit).await;
    }
    let (rules, any, category) = match members {
        Members::Manual(category) => (json!([]), false, Some(*category)),
        Members::Rules { rules, any } => (rules.clone(), *any, None),
    };
    let matching = if any { "any" } else { "all" };
    // `manual` means nothing without curation: newest first.
    let sort = if sort == "manual" {
        "created-desc"
    } else {
        sort
    };
    let (rows, total) = sorted_members(
        &caller.db,
        &Sorted {
            rules: &rules,
            matching,
            sort,
            cursor,
            limit,
            category,
        },
    )
    .await?;
    let rows = rows
        .iter()
        .map(|row| PRODUCTS.model(row))
        .collect::<Result<Vec<Value>, DbErr>>()?;
    Ok((rows, total))
}

/// A sorted page of members: the rules, `any` or `all`, the sort, the
/// cursor product, the limit and the manual category.
struct Sorted<'a> {
    rules: &'a Value,
    matching: &'a str,
    sort: &'a str,
    cursor: Option<&'a str>,
    limit: i64,
    category: Option<&'a str>,
}

/// The page and the count of [`SORTED_MEMBERS_SQL`], the rows as the
/// products' entity reads them.
#[allow(
    clippy::disallowed_methods,
    reason = "an automated category's rules are evaluated in SQL from one bound jsonb (crate::rules::rules_match!), a CASE per rule the query builder cannot express"
)]
async fn sorted_members(
    db: &weldsuite_db::PgPool,
    page: &Sorted<'_>,
) -> Result<(Vec<products::Model>, i64), DbErr> {
    let rows = sqlx::query(SORTED_MEMBERS_SQL)
        .bind(page.rules)
        .bind(page.matching)
        .bind(page.sort)
        .bind(page.cursor)
        .bind(page.limit)
        .bind(page.category)
        .fetch_all(db)
        .await
        .map_err(weldsuite_db::orm_error)?;
    let rows = rows
        .into_iter()
        .map(|row| products::Model::from_query_result(&QueryResult::from(row), ""))
        .collect::<Result<Vec<_>, DbErr>>()?;
    let total: i64 = sqlx::query_scalar(SORTED_COUNT_SQL)
        .bind(page.rules)
        .bind(page.matching)
        .bind(page.category)
        .fetch_one(db)
        .await
        .map_err(weldsuite_db::orm_error)?;
    Ok((rows, total))
}

/// The members of a category however it gets them. Its own `sortOrder`
/// unless the query names one.
fn members_of(category: &Value) -> Members<'_> {
    if is_automated(category) {
        Members::Rules {
            rules: rules_param(&stored_rules(category.get("rules"))),
            any: category.get("rulesMatch").and_then(Value::as_str) == Some("any"),
        }
    } else {
        Members::Manual(category["id"].as_str().unwrap_or_default())
    }
}

/// `GET /:id/products`: cursor-paged product rows.
async fn members(caller: Caller, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list category products";
    let read = validate_query(query.as_deref(), |issues, fields| {
        let cursor = issues
            .text_with(fields, "cursor", Presence::Optional, Text::default())
            .into_option()
            .filter(|c| !c.is_empty());
        let limit = issues
            .whole_number(
                fields,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    min: Some(1.0),
                    max: Some(100.0),
                    ..Number::default()
                },
            )
            .into_option();
        let sort = issues
            .choice(fields, "sortOrder", Presence::Optional, SORT_ORDERS)
            .into_option();
        (cursor, limit, sort)
    });
    let (cursor, limit, sort) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let category = match live_category(&orm(&caller.db), &id).await {
        Ok(Some(category)) => category,
        Ok(None) => return Refusal::not_found("Category", &id).respond(FAILED),
        Err(error) => return internal(&error, FAILED),
    };
    let limit = limit.unwrap_or(25);
    let sort = sort.unwrap_or_else(|| {
        category["sortOrder"]
            .as_str()
            .filter(|s| SORT_ORDERS.contains(s))
            .unwrap_or("manual")
            .to_owned()
    });
    match member_page(
        &caller,
        &members_of(&category),
        &sort,
        cursor.as_deref(),
        limit + 1,
    )
    .await
    {
        Ok((rows, total)) => {
            let page = weldsuite_kit::Page::of(
                rows,
                usize::try_from(limit).unwrap_or(25),
                |row: &Value| row["id"].as_str().unwrap_or_default(),
            );
            page.into_list(u64::try_from(total).unwrap_or(0))
                .into_response()
        }
        Err(error) => internal(&error, FAILED),
    }
}

/// `POST /preview-members`: what an unsaved rule set matches, the first
/// [`PREVIEW_LIMIT`] (or `limit`) products and how many there are.
async fn preview(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to preview category members";
    let read = validate(&headers, &body, |issues, fields| {
        let rules = read_rules(issues, fields, Presence::Required, Some(1))
            .into_option()
            .unwrap_or_default();
        let matching = issues
            .choice(fields, "rulesMatch", Presence::Optional, &["all", "any"])
            .into_option();
        let sort = issues
            .choice(fields, "sortOrder", Presence::Optional, SORT_ORDERS)
            .into_option();
        let limit = issues
            .whole_number(
                fields,
                "limit",
                Presence::Optional,
                Number {
                    min: Some(1.0),
                    max: Some(100.0),
                    ..Number::default()
                },
            )
            .into_option();
        (rules, matching, sort, limit)
    });
    let (rules, matching, sort, limit) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let members = Members::Rules {
        rules: rules_param(&rules),
        any: matching.as_deref() == Some("any"),
    };
    let sort = sort.unwrap_or_else(|| "created-desc".to_owned());
    match member_page(
        &caller,
        &members,
        &sort,
        None,
        limit.unwrap_or(PREVIEW_LIMIT),
    )
    .await
    {
        Ok((rows, total)) => Data(json!({ "products": rows, "totalCount": total })).into_response(),
        Err(error) => internal(&error, FAILED),
    }
}

/// `GET /api/products/:id/categories`: the manual categories the product is
/// in, by name.
async fn product_categories(caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to list product categories";
    match product_exists(&caller.db, &id).await {
        Ok(true) => {}
        Ok(false) => return Refusal::not_found("Product", &id).respond(FAILED),
        Err(error) => return internal(&error, FAILED),
    }
    let rows = categories::Entity::find()
        .join_rev(
            JoinType::InnerJoin,
            category_products::Entity::belongs_to(categories::Entity)
                .from(category_products::Column::CategoryId)
                .to(categories::Column::Id)
                .into(),
        )
        .filter(category_products::Column::ProductId.eq(id.as_str()))
        .filter(categories::Column::DeletedAt.is_null())
        .filter(sea_orm::ExprTrait::ne(
            Func::coalesce([
                Expr::col((categories::Entity, categories::Column::Type)),
                Expr::val("manual"),
            ]),
            "automated",
        ))
        .order_by_asc(categories::Column::Name)
        .order_by_asc(categories::Column::Id)
        .all(&orm(&caller.db))
        .await
        .and_then(|rows| presented(&rows));
    match rows {
        Ok(rows) => Data(rows).into_response(),
        Err(error) => internal(&error, FAILED),
    }
}

// ── writes ──────────────────────────────────────────────────────────────────

/// The category body (`categoryBase`; every field optional for a PATCH):
/// the values by property.
#[allow(clippy::too_many_lines)] // one read per field, in the schema's order
fn read_category(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    let mut text = |issues: &mut Issues, key: &str, presence: Presence, rules: Text| match issues
        .text_with(fields, key, presence, rules)
    {
        Field::Set(text) => {
            out.insert(key.to_owned(), json!(text));
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    };
    text(issues, "name", required, Text::trimmed(Some(1), Some(255)));
    text(
        issues,
        "slug",
        Presence::Optional,
        Text::trimmed(None, Some(255)),
    );
    text(
        issues,
        "description",
        Presence::Nullish,
        Text::length(None, Some(5000)),
    );
    text(
        issues,
        "parentId",
        Presence::Nullish,
        Text::length(None, Some(30)),
    );
    text(
        issues,
        "image",
        Presence::Nullish,
        Text::length(None, Some(500)),
    );
    text(
        issues,
        "icon",
        Presence::Nullish,
        Text::length(None, Some(100)),
    );
    text(
        issues,
        "color",
        Presence::Nullish,
        Text::length(None, Some(20)),
    );
    text(
        issues,
        "metaTitle",
        Presence::Nullish,
        Text::length(None, Some(255)),
    );
    text(
        issues,
        "metaDescription",
        Presence::Nullish,
        Text::length(None, Some(500)),
    );
    if let Some(position) = issues
        .integer(fields, "position", Presence::Optional, None)
        .into_option()
    {
        out.insert("position".to_owned(), json!(position));
    }
    if let Some(active) = issues
        .boolean(fields, "isActive", Presence::Optional)
        .into_option()
    {
        out.insert("isActive".to_owned(), json!(active));
    }
    // `.nullish()` answers null before the coercion runs.
    let published = if fields.get("publishedAt").is_some_and(Value::is_null) {
        Field::Null
    } else {
        issues.coerce_date(fields, "publishedAt", Presence::Optional)
    };
    match published {
        Field::Set(date) => {
            out.insert("publishedAt".to_owned(), json!(date));
        }
        Field::Null => {
            out.insert("publishedAt".to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
    if let Some(kind) = issues
        .choice(fields, "type", Presence::Optional, &["manual", "automated"])
        .into_option()
    {
        out.insert("type".to_owned(), json!(kind));
    }
    if let Some(rules) = read_rules(issues, fields, Presence::Optional, None).into_option() {
        out.insert("rules".to_owned(), Value::Array(rules));
    }
    if let Some(matching) = issues
        .choice(fields, "rulesMatch", Presence::Optional, &["all", "any"])
        .into_option()
    {
        out.insert("rulesMatch".to_owned(), json!(matching));
    }
    if let Some(sort) = issues
        .choice(fields, "sortOrder", Presence::Optional, SORT_ORDERS)
        .into_option()
    {
        out.insert("sortOrder".to_owned(), json!(sort));
    }
    if let Some(custom) = issues
        .nested(fields, "customFields", Presence::Optional, |_, inner| {
            inner.clone()
        })
        .into_option()
    {
        out.insert("customFields".to_owned(), Value::Object(custom));
    }
    if !partial && issues.count() == 0 && automated_without_rules(out.get("type"), out.get("rules"))
    {
        issues.custom("rules", "An automated category needs at least one rule");
    }
    out
}

/// `automatedWithoutRules(type, rules)`.
fn automated_without_rules(kind: Option<&Value>, rules: Option<&Value>) -> bool {
    kind.and_then(Value::as_str) == Some("automated")
        && rules.and_then(Value::as_array).is_none_or(Vec::is_empty)
}

fn value_or_null(data: &Map<String, Value>, key: &str) -> Value {
    data.get(key).cloned().unwrap_or(Value::Null)
}

/// `POST /`: 201 `{ id, slug }`.
async fn create(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create category";
    let data = match validate(&headers, &body, |issues, fields| {
        read_category(issues, fields, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match create_category(&caller, &data).await {
        Ok(category) => {
            caller.publish(
                &state,
                CATEGORY_CREATED,
                category["id"].as_str().unwrap_or_default(),
                &category_event(&category),
            );
            Created(json!({ "id": category["id"], "slug": category["slug"] })).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn create_category(caller: &Caller, data: &Map<String, Value>) -> Result<Value, Refusal> {
    let id = generate_id("cat");
    let now = now();
    let name = data.get("name").and_then(Value::as_str).unwrap_or_default();
    let parent = data
        .get("parentId")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty());
    let desired = match data
        .get("slug")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        Some(slug) => slugify(slug, &id),
        None => slugify(name, &id),
    };
    let mut tx = caller.db.begin().await?;
    let db = OrmConn::new(&mut tx);
    advisory_lock(&db, TREE_LOCK).await?;
    let (path, depth) = placement(&db, &id, parent, 0).await?;
    let slug = sibling_slug(&db, &desired, parent, None).await?;
    let t = &CATEGORIES;
    let mut values = Map::new();
    let mut set = |prop: &str, value: Value| t.set(&mut values, prop, value);
    set("id", json!(id));
    set("name", json!(name));
    set("slug", json!(slug));
    set("description", value_or_null(data, "description"));
    set("parentId", json!(parent));
    set("path", json!(path));
    set("depth", json!(depth));
    set(
        "position",
        data.get("position").cloned().unwrap_or_else(|| json!(0)),
    );
    for key in [
        "image",
        "icon",
        "color",
        "metaTitle",
        "metaDescription",
        "publishedAt",
    ] {
        set(key, value_or_null(data, key));
    }
    set(
        "isActive",
        json!(i32::from(data.get("isActive") != Some(&json!(false)))),
    );
    set(
        "type",
        data.get("type").cloned().unwrap_or_else(|| json!("manual")),
    );
    set("rules", value_or_null(data, "rules"));
    set(
        "rulesMatch",
        data.get("rulesMatch")
            .cloned()
            .unwrap_or_else(|| json!("all")),
    );
    set(
        "sortOrder",
        data.get("sortOrder")
            .cloned()
            .unwrap_or_else(|| json!("manual")),
    );
    if let Some(custom) = data.get("customFields") {
        set("customFields", custom.clone());
    }
    set("createdAt", json!(now));
    set("updatedAt", json!(now));
    let row = t
        .insert_on(&db, values, &["createdAt", "updatedAt", "publishedAt"])
        .await?;
    tx.commit().await?;
    Ok(present(row))
}

/// Body fields written to the row as they come.
const PASS_THROUGH: &[&str] = &[
    "name",
    "description",
    "position",
    "image",
    "icon",
    "color",
    "metaTitle",
    "metaDescription",
    "publishedAt",
    "type",
    "rules",
    "rulesMatch",
    "sortOrder",
    "customFields",
];

/// `PATCH /:id`: `{ id, slug }`.
async fn update_category(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update category";
    let data = match validate(&headers, &body, |issues, fields| {
        read_category(issues, fields, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match patch_category(&caller, &id, &data).await {
        Ok(category) => {
            caller.publish(&state, CATEGORY_UPDATED, &id, &category_event(&category));
            Data(json!({ "id": id, "slug": category["slug"] })).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn patch_category(
    caller: &Caller,
    id: &str,
    data: &Map<String, Value>,
) -> Result<Value, Refusal> {
    let mut tx = caller.db.begin().await?;
    let db = OrmConn::new(&mut tx);
    advisory_lock(&db, TREE_LOCK).await?;
    let Some(existing) = live_category(&db, id).await? else {
        return Err(Refusal::not_found("Category", id));
    };
    // The invariant is about the state this PATCH leaves behind.
    let merged_type = data
        .get("type")
        .filter(|v| !v.is_null())
        .or_else(|| existing.get("type"));
    let merged_rules = if data.contains_key("rules") {
        data.get("rules")
    } else {
        existing.get("rules")
    };
    if automated_without_rules(merged_type, merged_rules) {
        return Err(refused(
            ApiError::bad_request("An automated category needs at least one rule"),
            "RULES_REQUIRED",
        ));
    }
    let t = &CATEGORIES;
    let (now, stamp) = now_stamped();
    let mut update: Map<String, Value> = Map::new();
    t.set(&mut update, "updatedAt", json!(now));
    for key in PASS_THROUGH {
        if let Some(value) = data.get(*key) {
            t.set(&mut update, key, value.clone());
        }
    }
    if let Some(active) = data.get("isActive").and_then(Value::as_bool) {
        t.set(&mut update, "isActive", json!(i32::from(active)));
    }
    let current_parent = existing.get("parentId").and_then(Value::as_str);
    let wanted_parent = if data.contains_key("parentId") {
        data.get("parentId")
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
    } else {
        current_parent
    };
    let moving = wanted_parent != current_parent;
    let current_slug = existing
        .get("slug")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut reparent: Option<(String, String)> = None;
    if moving {
        let old_path = existing
            .get("path")
            .and_then(Value::as_str)
            .map_or_else(|| format!("/{id}"), str::to_owned);
        let depth = existing.get("depth").and_then(Value::as_i64).unwrap_or(0);
        let height = subtree_height(&db, &old_path, depth).await?;
        let (path, depth) = placement(&db, id, wanted_parent, height).await?;
        t.set(&mut update, "parentId", json!(wanted_parent));
        t.set(&mut update, "path", json!(path));
        t.set(&mut update, "depth", json!(depth));
        reparent = Some((old_path, path));
    }
    // A new slug, or the current one among new siblings.
    let wanted_slug = data
        .get("slug")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && *s != current_slug)
        .map(|s| slugify(s, id));
    if let Some(desired) = wanted_slug.or_else(|| moving.then(|| current_slug.to_owned())) {
        let slug = sibling_slug(&db, &desired, wanted_parent, Some(id)).await?;
        t.set(&mut update, "slug", json!(slug));
    }
    let row = t
        .patch_on(&db, id, update, true, &["updatedAt", "publishedAt"])
        .await?;
    if let Some((old, new)) = reparent {
        reparent_descendants(&db, id, &old, &new, stamp).await?;
    }
    tx.commit().await?;
    Ok(row.map_or(existing, present))
}

/// `DELETE /:id`: a soft delete, refused while it has children. Its manual
/// members go with it.
async fn remove(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to delete category";
    match delete_category(&caller, &id).await {
        Ok(category) => {
            caller.publish(&state, CATEGORY_DELETED, &id, &category_event(&category));
            NoContent.into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn delete_category(caller: &Caller, id: &str) -> Result<Value, Refusal> {
    let mut tx = caller.db.begin().await?;
    let db = OrmConn::new(&mut tx);
    advisory_lock(&db, TREE_LOCK).await?;
    let Some(existing) = live_category(&db, id).await? else {
        return Err(Refusal::not_found("Category", id));
    };
    let children = categories::Entity::find()
        .filter(categories::Column::ParentId.eq(id))
        .filter(categories::Column::DeletedAt.is_null())
        .count(&db)
        .await?;
    if children > 0 {
        let noun = if children == 1 {
            "category"
        } else {
            "categories"
        };
        return Err(ApiError::conflict(format!(
            "Category still has {children} child {noun} \u{2014} move or delete them first"
        ))
        .with_details(json!({ "code": "HAS_CHILDREN", "childCount": children }))
        .into());
    }
    let now = utc_now();
    categories::Entity::update_many()
        .col_expr(categories::Column::DeletedAt, Expr::val(now))
        .col_expr(categories::Column::UpdatedAt, Expr::val(now))
        .filter(categories::Column::Id.eq(id))
        .exec(&db)
        .await?;
    category_products::Entity::delete_many()
        .filter(category_products::Column::CategoryId.eq(id))
        .exec(&db)
        .await?;
    tx.commit().await?;
    Ok(existing)
}

/// `POST /:id/products`: `{ productIds }` join a manual category (those
/// already in it are skipped). `{ added, skipped }`.
async fn add_products(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to add products to category";
    let ids = validate(&headers, &body, |issues, fields| {
        issues
            .list(
                fields,
                "productIds",
                Presence::Required,
                Some(1),
                Some(200),
                |issues, item| issues.item_text(item, Text::length(Some(1), Some(30))),
            )
            .into_option()
            .unwrap_or_default()
    });
    let ids = match ids {
        Ok(ids) => ids,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match add_members(&caller, &id, ids).await {
        Ok((category, added, skipped)) => {
            caller.publish(&state, CATEGORY_UPDATED, &id, &category_event(&category));
            Data(json!({ "added": added, "skipped": skipped })).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn add_members(
    caller: &Caller,
    id: &str,
    ids: Vec<String>,
) -> Result<(Value, usize, usize), Refusal> {
    let db = orm(&caller.db);
    let Some(category) = live_category(&db, id).await? else {
        return Err(Refusal::not_found("Category", id));
    };
    if is_automated(&category) {
        return Err(not_manual());
    }
    let mut unique: Vec<String> = Vec::new();
    for product in ids {
        if !unique.contains(&product) {
            unique.push(product);
        }
    }
    // `productIds` has at least one id.
    let found: Vec<String> = products::Entity::find()
        .select_only()
        .column(products::Column::Id)
        .filter(products::Column::Id.is_in(unique.iter().map(String::as_str)))
        .filter(products::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db)
        .await?;
    if found.len() != unique.len() {
        let missing: Vec<&str> = unique
            .iter()
            .filter(|id| !found.contains(id))
            .map(String::as_str)
            .collect();
        return Err(
            ApiError::bad_request(format!("Unknown product ids: {}", missing.join(", ")))
                .with_details(json!({ "code": "PRODUCTS_NOT_FOUND", "productIds": missing }))
                .into(),
        );
    }
    let added = insert_members(&caller.db, id, &unique).await?;
    Ok((category, added, unique.len() - added))
}

/// The products join the category after its last member, in the order
/// given; `category_products_unique` decides what is already a member, so a
/// double submit is a no-op rather than a 500. How many joined.
#[allow(
    clippy::disallowed_methods,
    reason = "one insert … select from unnest with ordinality: each position follows the members' maximum read in the same statement, and on conflict skips the members already there"
)]
async fn insert_members(
    db: &weldsuite_db::PgPool,
    category_id: &str,
    product_ids: &[String],
) -> Result<usize, DbErr> {
    let member_ids: Vec<String> = product_ids.iter().map(|_| generate_id("cprod")).collect();
    let inserted: Vec<String> = sqlx::query_scalar(
        "insert into category_products (id, category_id, product_id, position, created_at) \
         select x.i, $2, x.p, \
                (select coalesce(max(position), -1) from category_products where category_id = $2) + x.n, \
                $4::timestamp \
         from unnest($1::varchar[], $3::varchar[]) with ordinality as x(i, p, n) \
         on conflict (category_id, product_id) do nothing returning product_id",
    )
    .bind(&member_ids)
    .bind(category_id)
    .bind(product_ids)
    .bind(now())
    .fetch_all(db)
    .await
    .map_err(weldsuite_db::orm_error)?;
    Ok(inserted.len())
}

/// `DELETE /:id/products/:productId`: 204, or 404 when it is not a member.
async fn remove_product(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, product_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to remove product from category";
    let category = match live_category(&orm(&caller.db), &id).await {
        Ok(Some(category)) => category,
        Ok(None) => return Refusal::not_found("Category", &id).respond(FAILED),
        Err(error) => return internal(&error, FAILED),
    };
    if is_automated(&category) {
        return not_manual().respond(FAILED);
    }
    let removed = category_products::Entity::delete_many()
        .filter(category_products::Column::CategoryId.eq(id.as_str()))
        .filter(category_products::Column::ProductId.eq(product_id.as_str()))
        .exec(&orm(&caller.db))
        .await;
    match removed {
        Ok(done) if done.rows_affected == 0 => {
            Refusal::not_found("Category product", &product_id).respond(FAILED)
        }
        Ok(_) => {
            caller.publish(&state, CATEGORY_UPDATED, &id, &category_event(&category));
            NoContent.into_response()
        }
        Err(error) => internal(&error, FAILED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_fold_accents_and_punctuation() {
        assert_eq!(slugify("Summer  Sale!", "cat_1"), "summer-sale");
        assert_eq!(slugify("Schürzen & Hüte", "cat_1"), "schurzen-hute");
        assert_eq!(slugify("Straße", "cat_1"), "strasse");
        assert_eq!(slugify("--Crème brûlée--", "cat_1"), "creme-brulee");
        assert_eq!(slugify("!!!", "cat_1"), "cat_1");
        assert_eq!(slugify(&"a".repeat(300), "cat_1").len(), 255);
    }

    #[test]
    fn the_tree_nests_sorts_and_keeps_orphans() {
        let row = |id: &str, parent: Option<&str>, position: i64, name: &str| {
            json!({ "id": id, "parentId": parent, "position": position, "name": name,
                    "depth": 0, "type": "manual", "isActive": true })
        };
        let rows = vec![
            row("a", None, 1, "Apparel"),
            row("b", None, 0, "Books"),
            row("c", Some("a"), 0, "shirts"),
            row("d", Some("a"), 0, "Hats"),
            row("e", Some("gone"), 0, "Orphan"),
        ];
        let tree = build_tree(&rows, None);
        let names: Vec<&str> = tree
            .as_array()
            .expect("roots")
            .iter()
            .map(|n| n["name"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(names, ["Books", "Orphan", "Apparel"]);
        let apparel = &tree[2];
        // A node is the whole row plus its children.
        assert_eq!(apparel["type"], "manual");
        assert_eq!(apparel["isActive"], true);
        assert_eq!(apparel["children"][0]["name"], "Hats");
        assert_eq!(apparel["children"][1]["name"], "shirts");
        let sub = build_tree(&rows, Some("a"));
        assert_eq!(sub.as_array().map(Vec::len), Some(1));
        assert_eq!(build_tree(&rows, Some("nope")), json!([]));
    }

    #[test]
    fn category_bodies() {
        let read = |value: Value, partial: bool| {
            let Value::Object(fields) = value else {
                panic!("an object");
            };
            let mut issues = Issues::default();
            let out = read_category(&mut issues, &fields, partial);
            (out, issues.count())
        };
        let (out, issues) = read(json!({ "name": " Shoes ", "isActive": false }), false);
        assert_eq!(issues, 0);
        assert_eq!(out["name"], "Shoes");
        assert_eq!(
            read(json!({ "name": "Sale", "type": "automated" }), false).1,
            1
        );
        assert_eq!(read(json!({ "type": "automated" }), true).1, 0);
        assert!(read(json!({}), false).1 >= 1);
        assert!(read(json!({ "name": "x", "type": "smart" }), false).1 >= 1);
    }
}
