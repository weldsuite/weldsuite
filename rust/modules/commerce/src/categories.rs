//! `/api/categories`: hierarchical product categories, manual (rows in
//! `category_products`) or automated (a rule set over `products`, evaluated
//! live), with `services/product-categories.ts` (slugs, placement, the rule
//! engine, member paging, the tree).
//!
//! The rule engine runs in SQL as the worker's does, but over one bound
//! `jsonb` of rules rather than a statement built per rule set: sqlx takes
//! literal SQL only. Each rule carries its column, relation, condition, the
//! escaped LIKE literal and the JavaScript `Number(condition)` (null when
//! not finite, which matches nothing), and a `CASE` picks the predicate.

use std::sync::{Arc, LazyLock};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use http::HeaderMap;
use icu_collator::options::CollatorOptions;
use icu_collator::{CollatorBorrowed, CollatorPreferences};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::cursor_row;
use crate::js::{js_number_value, js_parse_int, number_text, query_param};
use crate::tables;
use crate::{Caller, CommerceState, Refusal, now, validate, validate_query};

pub(crate) const MAX_CATEGORY_DEPTH: i64 = 10;

const RULE_COLUMNS: &[&str] = &[
    "name",
    "productType",
    "vendor",
    "brand",
    "sku",
    "status",
    "tag",
    "price",
    "compareAtPrice",
    "weight",
    "inventoryQuantity",
];
const RELATIONS: &[&str] = &[
    "equals",
    "not_equals",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "greater_than",
    "less_than",
];
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

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::CATEGORIES_READ]);
    let update = || gate.require([perm::CATEGORIES_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(gate.require([perm::CATEGORIES_CREATE])))
        .route("/tree", get(tree).route_layer(read()))
        .route("/preview-members", post(preview).route_layer(read()))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", axum::routing::patch(update_category).route_layer(update()))
        .route(
            "/{id}",
            delete(remove).route_layer(gate.require([perm::CATEGORIES_DELETE])),
        )
        .route("/{id}/products", get(members).route_layer(read()))
        .route("/{id}/products", post(add_products).route_layer(update()))
        .route(
            "/{id}/products/{product_id}",
            delete(remove_product).route_layer(update()),
        )
}

// ── errors ──────────────────────────────────────────────────────────────────

/// `CategoryError` and the route's mapping of it (`categoryError`).
enum Failure {
    Category(&'static str, String),
    Refusal(Refusal),
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Refusal(Refusal::Database(error))
    }
}

impl From<Refusal> for Failure {
    fn from(refusal: Refusal) -> Self {
        Self::Refusal(refusal)
    }
}

impl Failure {
    fn respond(self, fallback: &str) -> Response {
        match self {
            Self::Category("PARENT_NOT_FOUND", _) => {
                ApiError::not_found("Parent category", None).into_response()
            }
            Self::Category(code @ ("HAS_CHILDREN" | "SLUG_TAKEN"), message) => {
                ApiError::conflict(message)
                    .with_details(json!({ "code": code }))
                    .into_response()
            }
            Self::Category(code, message) => ApiError::bad_request(message)
                .with_details(json!({ "code": code }))
                .into_response(),
            Self::Refusal(refusal) => refusal.respond(fallback),
        }
    }
}

// ── slug and placement ──────────────────────────────────────────────────────

/// `slugify(input, fallback)`.
fn slugify(input: &str, fallback: &str) -> String {
    let lower = input.to_lowercase();
    let mut slug = String::new();
    let mut dash = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
            dash = false;
        } else if !dash {
            slug.push('-');
            dash = true;
        }
    }
    // `.replace(/^-|-$/g, '')`: one dash at each end.
    let slug = slug.strip_prefix('-').unwrap_or(&slug);
    let slug = slug.strip_suffix('-').unwrap_or(slug);
    let slug: String = slug.chars().take(255).collect();
    if slug.is_empty() { fallback.to_owned() } else { slug }
}

/// `uniqueSlug(db, desired, excludeId)`.
async fn unique_slug(caller: &Caller, desired: &str, exclude: Option<&str>) -> Result<String, Failure> {
    for attempt in 0..50 {
        let candidate = if attempt == 0 {
            desired.to_owned()
        } else {
            format!("{desired}-{}", attempt + 1).chars().take(255).collect()
        };
        let clash: Option<String> =
            sqlx::query_scalar("select id from categories where slug = $1 and deleted_at is null limit 1")
                .bind(&candidate)
                .fetch_optional(&caller.db)
                .await?;
        match clash {
            None => return Ok(candidate),
            Some(id) if Some(id.as_str()) == exclude => return Ok(candidate),
            Some(_) => {}
        }
    }
    Err(Failure::Category(
        "SLUG_TAKEN",
        format!("Could not find a free slug based on \"{desired}\""),
    ))
}

/// `resolvePlacement(db, categoryId, parentId)`: `(path, depth)`.
async fn placement(caller: &Caller, id: &str, parent_id: Option<&str>) -> Result<(String, i64), Failure> {
    let Some(parent_id) = parent_id.filter(|p| !p.is_empty()) else {
        return Ok((format!("/{id}"), 0));
    };
    let parent: Option<(String, Option<String>, Option<i32>)> = sqlx::query_as(
        "select id, path, depth from categories where id = $1 and deleted_at is null limit 1",
    )
    .bind(parent_id)
    .fetch_optional(&caller.db)
    .await?;
    let Some((parent, path, depth)) = parent else {
        return Err(Failure::Category(
            "PARENT_NOT_FOUND",
            format!("Parent category {parent_id} not found"),
        ));
    };
    let parent_path = path.unwrap_or_else(|| format!("/{parent}"));
    if parent_path.split('/').any(|segment| segment == id) {
        return Err(Failure::Category(
            "CYCLE",
            "A category cannot be moved beneath its own descendant".to_owned(),
        ));
    }
    if parent_id == id {
        return Err(Failure::Category("CYCLE", "A category cannot be its own parent".to_owned()));
    }
    let depth = i64::from(depth.unwrap_or(0)) + 1;
    if depth >= MAX_CATEGORY_DEPTH {
        return Err(Failure::Category(
            "TOO_DEEP",
            format!("Categories may not nest deeper than {MAX_CATEGORY_DEPTH}"),
        ));
    }
    Ok((format!("{parent_path}/{id}"), depth))
}

// ── rules ───────────────────────────────────────────────────────────────────

/// Escape the LIKE wildcards so a condition containing `%` matches literally.
fn like_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A stored or posted rule set as the statements read it: per rule its
/// column, relation, condition, LIKE literal and finite number.
fn rules_param(rules: &[Value]) -> Value {
    Value::Array(
        rules
            .iter()
            .map(|rule| {
                let text = |key: &str| match rule.get(key) {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Null) | None => "undefined".to_owned(),
                    Some(other) => other.to_string(),
                };
                let condition = text("condition");
                let number = js_number_value(Some(&json!(condition)));
                json!({
                    "column": rule.get("column").and_then(Value::as_str),
                    "relation": rule.get("relation").and_then(Value::as_str),
                    "condition": condition,
                    "esc": like_literal(&condition),
                    "num": number.is_finite().then(|| number_text(number)),
                })
            })
            .collect(),
    )
}

/// One rule against product `p` (`ruleToPredicate`).
macro_rules! rule_predicate {
    () => {
        "(case \
          when r->>'column' = 'tag' then (case r->>'relation' \
            when 'equals' then exists (select 1 from jsonb_array_elements_text(coalesce(p.tags, '[]'::jsonb)) as tag_value where tag_value = r->>'condition') \
            when 'not_equals' then not exists (select 1 from jsonb_array_elements_text(coalesce(p.tags, '[]'::jsonb)) as tag_value where tag_value = r->>'condition') \
            when 'not_contains' then not exists (select 1 from jsonb_array_elements_text(coalesce(p.tags, '[]'::jsonb)) as tag_value where tag_value ilike '%' || (r->>'esc') || '%') \
            when 'contains' then exists (select 1 from jsonb_array_elements_text(coalesce(p.tags, '[]'::jsonb)) as tag_value where tag_value ilike '%' || (r->>'esc') || '%') \
            when 'starts_with' then exists (select 1 from jsonb_array_elements_text(coalesce(p.tags, '[]'::jsonb)) as tag_value where tag_value ilike (r->>'esc') || '%') \
            when 'ends_with' then exists (select 1 from jsonb_array_elements_text(coalesce(p.tags, '[]'::jsonb)) as tag_value where tag_value ilike '%' || (r->>'esc')) \
            else false end) \
          when r->>'column' in ('price', 'compareAtPrice', 'weight') then (case when r->>'num' is null then false else (case r->>'relation' \
            when 'equals' then (case r->>'column' when 'price' then p.price when 'compareAtPrice' then p.compare_at_price else p.weight end) = (r->>'num')::numeric \
            when 'not_equals' then (case r->>'column' when 'price' then p.price when 'compareAtPrice' then p.compare_at_price else p.weight end) is distinct from (r->>'num')::numeric \
            when 'greater_than' then (case r->>'column' when 'price' then p.price when 'compareAtPrice' then p.compare_at_price else p.weight end) > (r->>'num')::numeric \
            when 'less_than' then (case r->>'column' when 'price' then p.price when 'compareAtPrice' then p.compare_at_price else p.weight end) < (r->>'num')::numeric \
            else false end) end) \
          when r->>'column' = 'inventoryQuantity' then (case when r->>'num' is null then false else (case r->>'relation' \
            when 'equals' then p.inventory_quantity = (r->>'num')::integer \
            when 'not_equals' then p.inventory_quantity is distinct from (r->>'num')::integer \
            when 'greater_than' then p.inventory_quantity > (r->>'num')::integer \
            when 'less_than' then p.inventory_quantity < (r->>'num')::integer \
            else false end) end) \
          when r->>'column' in ('name', 'productType', 'vendor', 'brand', 'sku', 'status') then (case r->>'relation' \
            when 'equals' then (case r->>'column' when 'name' then p.name when 'productType' then p.product_type when 'vendor' then p.vendor when 'brand' then p.brand when 'sku' then p.sku else p.status end) = r->>'condition' \
            when 'not_equals' then ((case r->>'column' when 'name' then p.name when 'productType' then p.product_type when 'vendor' then p.vendor when 'brand' then p.brand when 'sku' then p.sku else p.status end) is distinct from r->>'condition') \
            when 'contains' then (case r->>'column' when 'name' then p.name when 'productType' then p.product_type when 'vendor' then p.vendor when 'brand' then p.brand when 'sku' then p.sku else p.status end) ilike '%' || (r->>'esc') || '%' \
            when 'not_contains' then ((case r->>'column' when 'name' then p.name when 'productType' then p.product_type when 'vendor' then p.vendor when 'brand' then p.brand when 'sku' then p.sku else p.status end) is null or (case r->>'column' when 'name' then p.name when 'productType' then p.product_type when 'vendor' then p.vendor when 'brand' then p.brand when 'sku' then p.sku else p.status end) not ilike '%' || (r->>'esc') || '%') \
            when 'starts_with' then (case r->>'column' when 'name' then p.name when 'productType' then p.product_type when 'vendor' then p.vendor when 'brand' then p.brand when 'sku' then p.sku else p.status end) ilike (r->>'esc') || '%' \
            when 'ends_with' then (case r->>'column' when 'name' then p.name when 'productType' then p.product_type when 'vendor' then p.vendor when 'brand' then p.brand when 'sku' then p.sku else p.status end) ilike '%' || (r->>'esc') \
            else false end) \
          else false end)"
    };
}

/// `$1` the rules, `$2` 'any' or 'all'.
macro_rules! rules_match {
    () => {
        concat!(
            "(case when $2::text = 'any' then exists (select 1 from jsonb_array_elements($1::jsonb) r where ",
            rule_predicate!(),
            ") else not exists (select 1 from jsonb_array_elements($1::jsonb) r where (",
            rule_predicate!(),
            ") is not true) end)"
        )
    };
}

/// `orderFor(sortOrder)` with `$3` the sort.
macro_rules! member_order {
    () => {
        " order by \
          case when $3::text = 'best-selling' then coalesce(p.sales_count, 0) end desc, \
          case when $3::text = 'alpha-asc' then p.name end asc, \
          case when $3::text = 'alpha-desc' then p.name end desc, \
          case when $3::text = 'price-asc' then p.price end asc, \
          case when $3::text = 'price-desc' then p.price end desc, \
          case when $3::text = 'created-asc' then p.created_at end asc, \
          case when $3::text not in ('best-selling', 'alpha-asc', 'alpha-desc', 'price-asc', 'price-desc', 'created-asc') then p.created_at end desc, \
          case when $3::text in ('alpha-asc', 'price-asc', 'created-asc') then p.id end asc, \
          case when $3::text not in ('alpha-asc', 'price-asc', 'created-asc') then p.id end desc"
    };
}

/// `cursorPredicate(sort, cur)`: `$4` skips, `$5` id, `$6` sales count,
/// `$7` name, `$8` price, `$9` createdAt.
macro_rules! member_cursor {
    () => {
        "($4::boolean or (case $3::text \
          when 'best-selling' then (coalesce(p.sales_count, 0) < $6::integer or (coalesce(p.sales_count, 0) = $6::integer and p.id < $5::text)) \
          when 'alpha-asc' then (p.name > $7::text or (p.name = $7::text and p.id > $5::text)) \
          when 'alpha-desc' then (p.name < $7::text or (p.name = $7::text and p.id < $5::text)) \
          when 'price-asc' then (p.price > $8::numeric or (p.price = $8::numeric and p.id > $5::text)) \
          when 'price-desc' then (p.price < $8::numeric or (p.price = $8::numeric and p.id < $5::text)) \
          when 'created-asc' then (p.created_at > $9::timestamp or (p.created_at = $9::timestamp and p.id > $5::text)) \
          else (p.created_at < $9::timestamp or (p.created_at = $9::timestamp and p.id < $5::text)) end))"
    };
}

/// Products matching rules (`$1`, `$2`), sorted by `$3`, after a cursor
/// (`$4`–`$9`), limited to `$10`; `$11` restricts to member ids (manual
/// categories) when not null and skips the rules.
const MEMBERS_SQL: &str = concat!(
    "select ",
    row_of!(products),
    " from products p, lateral (select p.*) t where p.deleted_at is null and \
     (case when $11::text[] is not null then p.id = any($11::text[]) else ",
    rules_match!(),
    " end) and ",
    member_cursor!(),
    member_order!(),
    " limit $10"
);

const MEMBERS_COUNT_SQL: &str = concat!(
    "select count(*)::int from products p where p.deleted_at is null and \
     (case when $11::text[] is not null then p.id = any($11::text[]) else ",
    rules_match!(),
    " end) and $3::text is not null and $4::boolean is not null and $5::text is null and $6::integer is null \
     and $7::text is null and $8::numeric is null and $9::timestamp is null and $10::bigint is null"
);

/// The cursor row's sort keys.
struct CursorKeys {
    id: String,
    sales: Option<i32>,
    name: String,
    price: Option<String>,
    created_at: String,
}

async fn cursor_keys(caller: &Caller, cursor: &str) -> Result<Option<CursorKeys>, sqlx::Error> {
    let row: Option<(String, Option<i32>, String, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, sales_count, name, price::text, to_jsonb(created_at)#>>'{}' from products where id = $1 limit 1",
    )
    .bind(cursor)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|(id, sales, name, price, created)| CursorKeys {
        id,
        sales,
        name,
        price,
        created_at: created
            .and_then(|stamp| weldsuite_db::js_timestamp(&stamp))
            .unwrap_or_default(),
    }))
}

/// A page of products and the count, by rules or member ids.
#[allow(clippy::too_many_arguments)]
async fn product_page(
    caller: &Caller,
    rules: &Value,
    any: bool,
    member_ids: Option<&[String]>,
    sort: &str,
    cursor: Option<&CursorKeys>,
    limit: i64,
) -> Result<(Vec<Value>, i64), sqlx::Error> {
    let matching = if any { "any" } else { "all" };
    let rows: Vec<Value> = sqlx::query_scalar(MEMBERS_SQL)
        .bind(rules)
        .bind(matching)
        .bind(sort)
        .bind(cursor.is_none())
        .bind(cursor.map(|c| c.id.as_str()))
        .bind(cursor.map(|c| c.sales.unwrap_or(0)))
        .bind(cursor.map(|c| c.name.as_str()))
        .bind(cursor.and_then(|c| c.price.as_deref()))
        .bind(cursor.map(|c| c.created_at.as_str()))
        .bind(limit)
        .bind(member_ids)
        .fetch_all(&caller.db)
        .await?;
    let total: i32 = sqlx::query_scalar(MEMBERS_COUNT_SQL)
        .bind(rules)
        .bind(matching)
        .bind(sort)
        .bind(true)
        .bind(None::<String>)
        .bind(None::<i32>)
        .bind(None::<String>)
        .bind(None::<String>)
        .bind(None::<String>)
        .bind(None::<i64>)
        .bind(member_ids)
        .fetch_one(&caller.db)
        .await?;
    Ok((
        rows.into_iter().map(|row| tables::PRODUCTS.js(row)).collect(),
        i64::from(total),
    ))
}

/// What a member listing answers.
struct MemberPage {
    rows: Vec<Value>,
    total: i64,
    has_more: bool,
    next: Option<String>,
}

const EMPTY: MemberPage = MemberPage {
    rows: Vec::new(),
    total: 0,
    has_more: false,
    next: None,
};

/// `listCategoryMembers(db, category, { limit, cursor, sortOrder })`.
async fn list_members(
    caller: &Caller,
    category: &Value,
    limit: i64,
    cursor: Option<&str>,
    sort: Option<&str>,
) -> Result<MemberPage, sqlx::Error> {
    let sort = sort
        .or_else(|| category.get("sortOrder").and_then(Value::as_str))
        .unwrap_or("manual");
    let manual = category.get("type").and_then(Value::as_str).unwrap_or("manual") != "automated";
    let mut member_ids: Option<Vec<String>> = None;
    let mut rules = json!([]);
    let mut any = false;
    if manual {
        let members: Vec<(String, Option<i32>)> =
            sqlx::query_as("select product_id, position from category_products where category_id = $1")
                .bind(category["id"].as_str())
                .fetch_all(&caller.db)
                .await?;
        if members.is_empty() {
            return Ok(EMPTY);
        }
        if sort == "manual" {
            return page_manual(caller, members, cursor, limit).await;
        }
        member_ids = Some(members.into_iter().map(|(id, _)| id).collect());
    } else {
        let stored = category.get("rules").and_then(Value::as_array);
        let Some(stored) = stored.filter(|r| !r.is_empty()) else {
            return Ok(EMPTY);
        };
        rules = rules_param(stored);
        any = category.get("rulesMatch").and_then(Value::as_str) == Some("any");
    }
    let effective = if sort == "manual" { "created-desc" } else { sort };
    let keys = match cursor.filter(|c| !c.is_empty()) {
        Some(cursor) => cursor_keys(caller, cursor).await?,
        None => None,
    };
    let (rows, total) = product_page(
        caller,
        &rules,
        any,
        member_ids.as_deref(),
        effective,
        keys.as_ref(),
        limit + 1,
    )
    .await?;
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    let rows: Vec<Value> = rows
        .into_iter()
        .take(usize::try_from(limit).unwrap_or(0))
        .collect();
    let next = if has_more {
        rows.last().and_then(|r| r["id"].as_str()).map(str::to_owned)
    } else {
        None
    };
    Ok(MemberPage {
        rows,
        total,
        has_more,
        next,
    })
}

/// `pageManualMembers`: curated order from the junction, paged in memory.
async fn page_manual(
    caller: &Caller,
    mut members: Vec<(String, Option<i32>)>,
    cursor: Option<&str>,
    limit: i64,
) -> Result<MemberPage, sqlx::Error> {
    members.sort_by_key(|(_, position)| position.unwrap_or(0));
    let start = match cursor.filter(|c| !c.is_empty()) {
        Some(cursor) => members
            .iter()
            .position(|(id, _)| id == cursor)
            .map_or(0, |at| at + 1),
        None => 0,
    };
    let limit = usize::try_from(limit).unwrap_or(0);
    let page: Vec<String> = members
        .iter()
        .skip(start)
        .take(limit)
        .map(|(id, _)| id.clone())
        .collect();
    let rows: Vec<Value> = if page.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(concat!(
            "select ",
            row_of!(products),
            " from products t where t.id = any($1) and t.deleted_at is null"
        ))
        .bind(&page)
        .fetch_all(&caller.db)
        .await?
    };
    let rows: Vec<Value> = rows.into_iter().map(|row| tables::PRODUCTS.js(row)).collect();
    let ordered: Vec<Value> = page
        .iter()
        .filter_map(|id| rows.iter().find(|r| r["id"].as_str() == Some(id)).cloned())
        .collect();
    let has_more = start + limit < members.len();
    Ok(MemberPage {
        rows: ordered,
        total: i64::try_from(members.len()).unwrap_or(i64::MAX),
        has_more,
        next: if has_more { page.last().cloned() } else { None },
    })
}

// ── reads ───────────────────────────────────────────────────────────────────

const LIST_SQL: (&str, &str) = (
    concat!(
        "select ",
        row_of!(categories),
        " from categories t where t.deleted_at is null",
        " and ($1::boolean is not true or t.parent_id is null)",
        " and ($2::text is null or t.parent_id = $2)",
        " and ($3::text is null or t.type = $3)",
        " and ($4::text is null or t.name like $4 or t.slug like $4)",
        " and ",
        cursor!(5, 6, 7),
        " order by t.created_at desc, t.id desc limit $8"
    ),
    "select count(*) from categories t where t.deleted_at is null \
     and ($1::boolean is not true or t.parent_id is null) \
     and ($2::text is null or t.parent_id = $2) \
     and ($3::text is null or t.type = $3) \
     and ($4::text is null or t.name like $4 or t.slug like $4)",
);

async fn list(State(_state): State<CommerceState>, caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list categories";
    let query = query.as_deref();
    // `?limit=abc` and `?limit=-5` are clamped, unlike the other lists.
    let limit = match query_param(query, "limit").filter(|l| !l.is_empty()) {
        None => 25.0,
        Some(raw) => js_parse_int(&raw).map_or(25.0, |n| n.clamp(1.0, 100.0)),
    };
    #[allow(clippy::cast_possible_truncation)]
    let limit = limit as i64;
    let parent = query_param(query, "parentId");
    let roots = parent.as_deref() == Some("null");
    let parent = parent.filter(|p| !p.is_empty() && p != "null");
    let kind = query_param(query, "type").filter(|t| !t.is_empty());
    let search = query_param(query, "search")
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let cursor = match query_param(query, "cursor").filter(|c| !c.is_empty()) {
        Some(cursor) => match cursor_row(&caller.db, "categories", &cursor).await {
            Ok(row) => row,
            Err(error) => {
                tracing::error!(%error, "commerce: cursor lookup failed");
                return ApiError::internal().into_response();
            }
        },
        None => None,
    };
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(LIST_SQL.0)
        .bind(roots)
        .bind(parent.as_deref())
        .bind(kind.as_deref())
        .bind(search.as_deref())
        .bind(cursor.is_none())
        .bind(cursor.as_ref().map(|(c, _)| c.as_str()))
        .bind(cursor.as_ref().map(|(_, id)| id.as_str()))
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await;
    let total: Result<i64, sqlx::Error> = sqlx::query_scalar(LIST_SQL.1)
        .bind(roots)
        .bind(parent.as_deref())
        .bind(kind.as_deref())
        .bind(search.as_deref())
        .fetch_one(&caller.db)
        .await;
    let (rows, total) = match (rows, total) {
        (Ok(rows), Ok(total)) => (rows, total),
        (Err(error), _) | (_, Err(error)) => return Refusal::Database(error).respond(FAILED),
    };
    let rows: Vec<Value> = rows.into_iter().map(|row| tables::CATEGORIES.js(row)).collect();
    #[allow(clippy::cast_precision_loss)]
    crate::crud::page_list(rows, limit as f64, total)
}

async fn live_category(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    tables::CATEGORIES.find_live(&caller.db, id).await
}

async fn detail(State(_state): State<CommerceState>, caller: Caller, Path(id): Path<String>) -> Response {
    match live_category(&caller, &id).await {
        Ok(Some(row)) => Data(row).into_response(),
        Ok(None) => Refusal::not_found("Category", &id).respond("Failed to fetch category"),
        Err(error) => Refusal::Database(error).respond("Failed to fetch category"),
    }
}

static COLLATOR: LazyLock<Option<CollatorBorrowed<'static>>> = LazyLock::new(|| {
    CollatorBorrowed::try_new(CollatorPreferences::default(), CollatorOptions::default()).ok()
});

/// A tree node (`TreeNode`) with its children's indexes.
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
        a.position.cmp(&b.position).then_with(|| {
            COLLATOR
                .as_ref()
                .map_or_else(|| a.name.cmp(&b.name), |c| c.compare(&a.name, &b.name))
        })
    });
}

fn render(nodes: &[Node], index: usize) -> Value {
    let node = &nodes[index];
    let mut value = node.value.clone();
    value.insert(
        "children".to_owned(),
        Value::Array(node.children.iter().map(|child| render(nodes, *child)).collect()),
    );
    Value::Object(value)
}

/// `buildTree(rows, rootId)`.
fn build_tree(rows: &[Value], root: Option<&str>) -> Value {
    let mut nodes: Vec<Node> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for row in rows {
        let id = row["id"].as_str().unwrap_or_default().to_owned();
        let parent = row.get("parentId").and_then(Value::as_str).map(str::to_owned);
        let depth = row.get("depth").and_then(Value::as_i64).unwrap_or(0);
        let position = row.get("position").and_then(Value::as_i64).unwrap_or(0);
        let name = row.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
        let mut value = Map::new();
        value.insert("id".to_owned(), json!(id));
        value.insert("name".to_owned(), json!(name));
        value.insert("slug".to_owned(), row.get("slug").cloned().unwrap_or(Value::Null));
        value.insert("parentId".to_owned(), json!(parent));
        value.insert("path".to_owned(), row.get("path").cloned().unwrap_or(Value::Null));
        value.insert("depth".to_owned(), json!(depth));
        value.insert("position".to_owned(), json!(position));
        value.insert(
            "type".to_owned(),
            json!(row.get("type").and_then(Value::as_str).unwrap_or("manual")),
        );
        value.insert(
            "isActive".to_owned(),
            json!(row.get("isActive").and_then(Value::as_i64).unwrap_or(1) == 1),
        );
        // `nodes.set(row.id, …)`: a later duplicate replaces the node in
        // its first slot.
        let node = Node {
            value,
            position,
            name,
            parent,
            children: Vec::new(),
        };
        match index.get(&id) {
            Some(at) => nodes[*at] = node,
            None => {
                index.insert(id, nodes.len());
                nodes.push(node);
            }
        }
    }
    let mut roots = Vec::new();
    for at in 0..nodes.len() {
        let parent = nodes[at].parent.as_ref().and_then(|p| index.get(p)).copied();
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
        return Value::Array(index.get(root).map(|at| render(&nodes, *at)).into_iter().collect());
    }
    Value::Array(roots.into_iter().map(|at| render(&nodes, at)).collect())
}

async fn tree(State(_state): State<CommerceState>, caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to build category tree";
    let read = validate_query(query.as_deref(), |issues, fields| {
        let root = issues
            .text_with(fields, "rootId", Presence::Optional, Text::length(None, Some(30)))
            .into_option();
        let inactive = issues
            .choice(fields, "includeInactive", Presence::Optional, &["true", "false", "1", "0"])
            .into_option()
            .is_some_and(|v| v == "true" || v == "1");
        (root, inactive)
    });
    let (root, inactive) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(categories),
        " from categories t where t.deleted_at is null and ($1::boolean or t.is_active = 1) \
         order by t.depth asc, t.position asc"
    ))
    .bind(inactive)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => {
            let rows: Vec<Value> = rows.into_iter().map(|row| tables::CATEGORIES.js(row)).collect();
            Data(build_tree(&rows, root.as_deref())).into_response()
        }
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

/// `categoryRuleSchema` items: `{ column, relation, condition }`, stripped.
fn read_rules(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    presence: Presence,
    min: Option<usize>,
) -> Field<Vec<Value>> {
    issues.list(fields, "rules", presence, min, Some(50), |issues, item| {
        let rule = issues.object(item)?;
        let before = issues.count();
        let column = issues.choice(rule, "column", Presence::Required, RULE_COLUMNS).into_option();
        let relation = issues.choice(rule, "relation", Presence::Required, RELATIONS).into_option();
        let condition = issues
            .text_with(rule, "condition", Presence::Required, Text::length(Some(1), Some(255)))
            .into_option();
        (issues.count() == before)
            .then(|| json!({ "column": column, "relation": relation, "condition": condition }))
    })
}

async fn preview(State(_state): State<CommerceState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to preview category members";
    let read = validate(&headers, &body, |issues, fields| {
        let rules = read_rules(issues, fields, Presence::Required, Some(1)).into_option().unwrap_or_default();
        let matching = issues
            .choice(fields, "rulesMatch", Presence::Optional, &["all", "any"])
            .into_option();
        let sort = issues.choice(fields, "sortOrder", Presence::Optional, SORT_ORDERS).into_option();
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
    if rules.is_empty() {
        return Data(json!({ "products": [], "totalCount": 0 })).into_response();
    }
    let any = matching.as_deref() == Some("any");
    let sort = sort.unwrap_or_else(|| "created-desc".to_owned());
    // `orderFor('manual')` is newest first.
    let sort = if sort == "manual" { "created-desc".to_owned() } else { sort };
    match product_page(&caller, &rules_param(&rules), any, None, &sort, None, limit.unwrap_or(25)).await {
        Ok((rows, total)) => Data(json!({ "products": rows, "totalCount": total })).into_response(),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

async fn members(
    State(_state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    const FAILED: &str = "Failed to list category products";
    let read = validate_query(query.as_deref(), |issues, fields| {
        let cursor = issues
            .text_with(fields, "cursor", Presence::Optional, Text::default())
            .into_option();
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
        let sort = issues.choice(fields, "sortOrder", Presence::Optional, SORT_ORDERS).into_option();
        (cursor, limit, sort)
    });
    let (cursor, limit, sort) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let category = match live_category(&caller, &id).await {
        Ok(Some(category)) => category,
        Ok(None) => return Refusal::not_found("Category", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    match list_members(&caller, &category, limit.unwrap_or(25), cursor.as_deref(), sort.as_deref()).await {
        Ok(page) => weldsuite_kit::List::new(
            page.rows,
            weldsuite_kit::Pagination::new(u64::try_from(page.total).unwrap_or(0), page.has_more, page.next),
        )
        .into_response(),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

// ── writes ──────────────────────────────────────────────────────────────────

/// The category schema (`categoryBase`), read in its order; the parsed
/// values by property.
fn read_category(issues: &mut Issues, fields: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let required = if partial { Presence::Optional } else { Presence::Required };
    let mut out = Map::new();
    let mut text = |issues: &mut Issues, key: &str, presence: Presence, min: Option<usize>, max: usize| {
        match issues.text_with(fields, key, presence, Text::length(min, Some(max))) {
            Field::Set(text) => {
                out.insert(key.to_owned(), json!(text));
            }
            Field::Null => {
                out.insert(key.to_owned(), Value::Null);
            }
            Field::Absent => {}
        }
    };
    text(issues, "name", required, Some(1), 255);
    text(issues, "slug", Presence::Optional, None, 255);
    text(issues, "description", Presence::Nullish, None, 5000);
    text(issues, "parentId", Presence::Nullish, None, 30);
    let position = issues.integer(fields, "position", Presence::Optional, None).into_option();
    text(issues, "image", Presence::Nullish, None, 500);
    text(issues, "icon", Presence::Nullish, None, 100);
    text(issues, "color", Presence::Nullish, None, 20);
    text(issues, "metaTitle", Presence::Nullish, None, 255);
    text(issues, "metaDescription", Presence::Nullish, None, 500);
    if let Some(position) = position {
        out.insert("position".to_owned(), json!(position));
    }
    if let Some(active) = issues.boolean(fields, "isActive", Presence::Optional).into_option() {
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
    if let Some(sort) = issues.choice(fields, "sortOrder", Presence::Optional, SORT_ORDERS).into_option() {
        out.insert("sortOrder".to_owned(), json!(sort));
    }
    if let Some(custom) = issues
        .nested(fields, "customFields", Presence::Optional, |_, inner| inner.clone())
        .into_option()
    {
        out.insert("customFields".to_owned(), Value::Object(custom));
    }
    if !partial && issues.count() == 0 {
        // `requireRulesWhenAutomated` (superRefine).
        let automated = out.get("type").and_then(Value::as_str) == Some("automated");
        let empty = out.get("rules").and_then(Value::as_array).is_none_or(Vec::is_empty);
        if automated && empty {
            issues.custom("rules", "An automated category needs at least one rule");
        }
    }
    out
}

fn value_or_null(data: &Map<String, Value>, key: &str) -> Value {
    data.get(key).cloned().unwrap_or(Value::Null)
}

async fn create(State(state): State<CommerceState>, caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    const FAILED: &str = "Failed to create category";
    let data = match validate(&headers, &body, |issues, fields| read_category(issues, fields, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match create_category(&state, &caller, &data).await {
        Ok(response) => response,
        Err(failure) => failure.respond(FAILED),
    }
}

async fn create_category(state: &CommerceState, caller: &Caller, data: &Map<String, Value>) -> Result<Response, Failure> {
    let id = generate_id("cat");
    let now = now();
    let name = data.get("name").and_then(Value::as_str).unwrap_or_default();
    let desired = match data.get("slug").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(slug) => slugify(slug, &id),
        None => slugify(name, &id),
    };
    let slug = unique_slug(caller, &desired, None).await?;
    let parent = data.get("parentId").and_then(Value::as_str);
    let (path, depth) = placement(caller, &id, parent).await?;
    let t = &tables::CATEGORIES;
    let mut values = Map::new();
    let mut set = |prop: &str, value: Value| t.set(&mut values, prop, value);
    set("id", json!(id));
    set("name", json!(name));
    set("slug", json!(slug));
    set("description", value_or_null(data, "description"));
    set("parentId", value_or_null(data, "parentId"));
    set("path", json!(path));
    set("depth", json!(depth));
    set("position", data.get("position").cloned().unwrap_or_else(|| json!(0)));
    for key in ["image", "icon", "color", "metaTitle", "metaDescription", "publishedAt"] {
        set(key, value_or_null(data, key));
    }
    set(
        "isActive",
        json!(i32::from(data.get("isActive") != Some(&json!(false)))),
    );
    set("type", data.get("type").cloned().unwrap_or_else(|| json!("manual")));
    set("rules", value_or_null(data, "rules"));
    set("rulesMatch", data.get("rulesMatch").cloned().unwrap_or_else(|| json!("all")));
    set("sortOrder", data.get("sortOrder").cloned().unwrap_or_else(|| json!("manual")));
    if let Some(custom) = data.get("customFields") {
        set("customFields", custom.clone());
    }
    set("createdAt", json!(now));
    set("updatedAt", json!(now));
    t.insert(&caller.db, values, &["createdAt", "updatedAt", "publishedAt"])
        .await
        .map_err(write_error)?;
    let mut event = Map::new();
    event.insert("id".to_owned(), json!(id));
    event.insert("name".to_owned(), json!(name));
    event.insert("slug".to_owned(), json!(slug));
    if let Some(parent) = parent {
        event.insert("parentId".to_owned(), json!(parent));
    }
    caller.publish(state, ev::CATEGORY_CREATED, &id, &Value::Object(event));
    Ok(Created(json!({ "id": id, "slug": slug })).into_response())
}

fn write_error(error: crate::table::WriteError) -> Failure {
    match error {
        crate::table::WriteError::Database(error) => Failure::Refusal(Refusal::Database(error)),
        other => {
            tracing::error!(error = %other, "[commerce-api/categories] write refused");
            Failure::Refusal(Refusal::Response(Box::new(
                ApiError::internal().into_response(),
            )))
        }
    }
}

/// `automatedWithoutRules(type, rules)`.
fn automated_without_rules(kind: Option<&Value>, rules: Option<&Value>) -> bool {
    kind.and_then(Value::as_str) == Some("automated")
        && rules.and_then(Value::as_array).is_none_or(Vec::is_empty)
}

async fn update_category(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update category";
    let data = match validate(&headers, &body, |issues, fields| read_category(issues, fields, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match patch_category(&state, &caller, &id, &data).await {
        Ok(response) => response,
        Err(failure) => failure.respond(FAILED),
    }
}

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

async fn patch_category(
    state: &CommerceState,
    caller: &Caller,
    id: &str,
    data: &Map<String, Value>,
) -> Result<Response, Failure> {
    let Some(existing) = live_category(caller, id).await? else {
        return Err(Refusal::not_found("Category", id).into());
    };
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
        return Err(Refusal::Response(Box::new(
            ApiError::bad_request("An automated category needs at least one rule")
                .with_details(json!({ "code": "RULES_REQUIRED" }))
                .into_response(),
        ))
        .into());
    }
    let t = &tables::CATEGORIES;
    let mut update: Map<String, Value> = Map::new();
    t.set(&mut update, "updatedAt", json!(now()));
    for key in PASS_THROUGH {
        if let Some(value) = data.get(*key) {
            t.set(&mut update, key, value.clone());
        }
    }
    if let Some(active) = data.get("isActive").and_then(Value::as_bool) {
        t.set(&mut update, "isActive", json!(i32::from(active)));
    }
    let mut new_slug: Option<String> = None;
    if let Some(slug) = data.get("slug").and_then(Value::as_str)
        && Some(slug) != existing.get("slug").and_then(Value::as_str)
    {
        let slug = unique_slug(caller, &slugify(slug, id), Some(id)).await?;
        t.set(&mut update, "slug", json!(slug));
        new_slug = Some(slug);
    }
    let mut reparent: Option<(String, String)> = None;
    let mut new_parent: Option<Value> = None;
    if data.contains_key("parentId") {
        let wanted = data.get("parentId").and_then(Value::as_str);
        let current = existing.get("parentId").and_then(Value::as_str);
        if wanted != current {
            let (path, depth) = placement(caller, id, wanted).await?;
            t.set(&mut update, "parentId", json!(wanted));
            t.set(&mut update, "path", json!(path));
            t.set(&mut update, "depth", json!(depth));
            new_parent = Some(json!(wanted));
            let old = existing
                .get("path")
                .and_then(Value::as_str)
                .map_or_else(|| format!("/{id}"), str::to_owned);
            reparent = Some((old, path));
        }
    }
    t.patch(&caller.db, id, update, true, &["updatedAt", "publishedAt"])
        .await
        .map_err(write_error)?;
    if let Some((old, new)) = reparent {
        reparent_descendants(caller, id, &old, &new).await?;
    }
    let pick = |value: Option<Value>, key: &str| {
        value
            .filter(|v| !v.is_null())
            .unwrap_or_else(|| existing.get(key).cloned().unwrap_or(Value::Null))
    };
    caller.publish(
        state,
        ev::CATEGORY_UPDATED,
        id,
        &json!({
            "id": id,
            "name": pick(data.get("name").cloned(), "name"),
            "slug": pick(new_slug.map(Value::String), "slug"),
            "parentId": pick(new_parent, "parentId"),
        }),
    );
    Ok(Data(json!({ "id": id })).into_response())
}

/// `reparentDescendants(db, id, oldPath, newPath)`.
async fn reparent_descendants(caller: &Caller, id: &str, old: &str, new: &str) -> Result<(), sqlx::Error> {
    if old == new {
        return Ok(());
    }
    let segments = |path: &str| i64::try_from(path.split('/').count()).unwrap_or(0);
    let shift = segments(new) - segments(old);
    let from = i64::try_from(old.encode_utf16().count()).unwrap_or(0) + 1;
    sqlx::query(
        "update categories set path = $1::text || substring(path from $2::int), depth = depth + $3::int, \
         updated_at = $4::timestamp where path like $5 and id <> $6 and deleted_at is null",
    )
    .bind(new)
    .bind(i32::try_from(from).unwrap_or(i32::MAX))
    .bind(i32::try_from(shift).unwrap_or(0))
    .bind(now())
    .bind(format!("{old}/%"))
    .bind(id)
    .execute(&caller.db)
    .await?;
    Ok(())
}

async fn remove(State(state): State<CommerceState>, caller: Caller, Path(id): Path<String>) -> Response {
    const FAILED: &str = "Failed to delete category";
    match delete_category(&caller, &id).await {
        Ok(None) => {
            caller.publish(&state, ev::CATEGORY_DELETED, &id, &json!({ "id": id }));
            NoContent.into_response()
        }
        Ok(Some(response)) => response,
        Err(failure) => failure.respond(FAILED),
    }
}

async fn delete_category(caller: &Caller, id: &str) -> Result<Option<Response>, Failure> {
    if live_category(caller, id).await?.is_none() {
        return Err(Refusal::not_found("Category", id).into());
    }
    let children: i64 = sqlx::query_scalar(
        "select count(*) from categories where parent_id = $1 and deleted_at is null",
    )
    .bind(id)
    .fetch_one(&caller.db)
    .await?;
    if children > 0 {
        let noun = if children == 1 { "category" } else { "categories" };
        return Ok(Some(
            ApiError::conflict(format!(
                "Category still has {children} child {noun} \u{2014} move or delete them first"
            ))
            .with_details(json!({ "code": "HAS_CHILDREN", "childCount": children }))
            .into_response(),
        ));
    }
    let now = now();
    let mut tx = caller.db.begin().await?;
    sqlx::query("update categories set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2")
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("delete from category_products where category_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(None)
}

fn category_event(category: &Value) -> Value {
    json!({
        "id": category["id"],
        "name": category.get("name").cloned().unwrap_or(Value::Null),
        "slug": category.get("slug").cloned().unwrap_or(Value::Null),
        "parentId": category.get("parentId").cloned().unwrap_or(Value::Null),
    })
}

fn not_manual() -> Failure {
    Failure::Category(
        "NOT_MANUAL",
        "Members of an automated category come from its rules \u{2014} edit the rules instead".to_owned(),
    )
}

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
            .list(fields, "productIds", Presence::Required, Some(1), Some(200), |issues, item| {
                issues.item_text(item, Text::length(Some(1), Some(30)))
            })
            .into_option()
            .unwrap_or_default()
    });
    let ids = match ids {
        Ok(ids) => ids,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match add_members(&state, &caller, &id, ids).await {
        Ok(response) => response,
        Err(failure) => failure.respond(FAILED),
    }
}

async fn add_members(state: &CommerceState, caller: &Caller, id: &str, ids: Vec<String>) -> Result<Response, Failure> {
    let Some(category) = live_category(caller, id).await? else {
        return Err(Refusal::not_found("Category", id).into());
    };
    if category.get("type").and_then(Value::as_str) == Some("automated") {
        return Err(not_manual());
    }
    let mut unique: Vec<String> = Vec::new();
    for product in ids {
        if !unique.contains(&product) {
            unique.push(product);
        }
    }
    let found: Vec<String> =
        sqlx::query_scalar("select id from products where id = any($1) and deleted_at is null")
            .bind(&unique)
            .fetch_all(&caller.db)
            .await?;
    if found.len() != unique.len() {
        let missing: Vec<&str> = unique
            .iter()
            .filter(|id| !found.contains(id))
            .map(String::as_str)
            .collect();
        return Err(Failure::Category(
            "PRODUCTS_NOT_FOUND",
            format!("Unknown product ids: {}", missing.join(", ")),
        ));
    }
    let max: i32 = sqlx::query_scalar(
        "select coalesce(max(position), -1)::int from category_products where category_id = $1",
    )
    .bind(id)
    .fetch_one(&caller.db)
    .await?;
    let ids: Vec<String> = unique.iter().map(|_| generate_id("cprod")).collect();
    let positions: Vec<i32> = (1..=i32::try_from(unique.len()).unwrap_or(0)).map(|n| max + n).collect();
    let inserted: Vec<String> = sqlx::query_scalar(
        "insert into category_products (id, category_id, product_id, position, created_at) \
         select i, $2, p, n, $5::timestamp from unnest($1::varchar[], $3::varchar[], $4::int[]) as x(i, p, n) \
         on conflict (category_id, product_id) do nothing returning product_id",
    )
    .bind(&ids)
    .bind(id)
    .bind(&unique)
    .bind(&positions)
    .bind(now())
    .fetch_all(&caller.db)
    .await?;
    caller.publish(state, ev::CATEGORY_UPDATED, id, &category_event(&category));
    Ok(Data(json!({ "added": inserted.len(), "skipped": unique.len() - inserted.len() })).into_response())
}

async fn remove_product(
    State(state): State<CommerceState>,
    caller: Caller,
    Path((id, product_id)): Path<(String, String)>,
) -> Response {
    const FAILED: &str = "Failed to remove product from category";
    let category = match live_category(&caller, &id).await {
        Ok(Some(category)) => category,
        Ok(None) => return Refusal::not_found("Category", &id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    if category.get("type").and_then(Value::as_str).unwrap_or("manual") == "automated" {
        return not_manual().respond(FAILED);
    }
    let removed: Result<Vec<String>, sqlx::Error> = sqlx::query_scalar(
        "delete from category_products where category_id = $1 and product_id = $2 returning id",
    )
    .bind(&id)
    .bind(&product_id)
    .fetch_all(&caller.db)
    .await;
    match removed {
        Ok(rows) if rows.is_empty() => Refusal::not_found("Category product", &product_id).respond(FAILED),
        Ok(_) => {
            caller.publish(&state, ev::CATEGORY_UPDATED, &id, &category_event(&category));
            NoContent.into_response()
        }
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_like_the_worker() {
        assert_eq!(slugify("Summer  Sale!", "cat_1"), "summer-sale");
        assert_eq!(slugify("--Ünïcode--", "cat_1"), "n-code");
        assert_eq!(slugify("!!!", "cat_1"), "cat_1");
        assert_eq!(like_literal("50%_off\\"), "50\\%\\_off\\\\");
    }
}
