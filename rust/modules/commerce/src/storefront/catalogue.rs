//! The storefront's catalogue: the channel, products and categories.
//!
//! A product is on the channel when it is `active`, not hidden, and has a
//! price in the channel's currency (the product's own, or, for a product with
//! variants, a price on at least one active variant), as
//! [`weldsuite_commerce_domain::prices`] resolves it. Nothing but the
//! storefront fields leaves here: no stock numbers, cost prices, vendors,
//! VAT categories or internal fields.
//!
//! A list is worked out in three steps: the products the filters (category,
//! search) match, their prices, then sort and page (the cursor is the last
//! product's id). The price step reads every candidate, so a channel with
//! tens of thousands of products in one category is slow to list; narrow it
//! with `category` or `search`.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use axum::Extension;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use http::StatusCode;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, QueryFilter,
    QueryOrder, QuerySelect, Select,
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use weldsuite_commerce_domain::money::{self, Cents};
use weldsuite_commerce_domain::prices::{self, Price, Target};
use weldsuite_db::{OrmConn, orm};
use weldsuite_schema::tenant::{categories, category_products, product_variants, products};

use super::{Principal, data, fail, internal, validation};
use crate::args::utc_now_sql;
use crate::rules::{rules_match, rules_param, stored_rules};

fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

pub(crate) async fn channel(Extension(principal): Extension<Principal>) -> Response {
    let c = &principal.channel;
    data(json!({
        "id": c.id,
        "name": c.name,
        "audience": c.audience,
        "currency": c.currency,
        "pricesIncludeTax": c.prices_include_tax,
        "sellingCountries": c.selling_countries,
        "guestCheckout": c.guest_checkout,
        "paymentMethods": c.payment_methods,
    }))
}

// ── categories ──────────────────────────────────────────────────────────────

/// A category the storefront shows: live, active, published.
#[derive(Debug, FromQueryResult)]
struct Visible {
    id: String,
    slug: String,
    name: String,
    description: Option<String>,
    parent_id: Option<String>,
    position: i32,
    kind: String,
    rules: Option<Value>,
    rules_match: String,
}

/// The visible categories by `position`, name and id: `{ id, slug, name,
/// description, parentId, position, type, rules, rulesMatch }`.
async fn visible_categories<C: ConnectionTrait>(db: &C) -> Result<Vec<Value>, DbErr> {
    let column = |column: categories::Column| Expr::col((categories::Entity, column));
    let or = |name: categories::Column, fallback: sea_orm::Value| {
        Expr::from(Func::coalesce([column(name), Expr::val(fallback)]))
    };
    let published = Condition::any()
        .add(categories::Column::PublishedAt.is_null())
        .add(sea_orm::ExprTrait::lte(
            column(categories::Column::PublishedAt),
            utc_now_sql(),
        ));
    let rows: Vec<Visible> = categories::Entity::find()
        .select_only()
        .columns([
            categories::Column::Id,
            categories::Column::Slug,
            categories::Column::Name,
            categories::Column::Description,
            categories::Column::ParentId,
        ])
        .column_as(or(categories::Column::Position, 0.into()), "position")
        .column_as(or(categories::Column::Type, "manual".into()), "kind")
        .column(categories::Column::Rules)
        .column_as(
            or(categories::Column::RulesMatch, "all".into()),
            "rules_match",
        )
        .filter(categories::Column::DeletedAt.is_null())
        .filter(sea_orm::ExprTrait::eq(
            or(categories::Column::IsActive, 1.into()),
            1,
        ))
        .filter(published)
        .order_by_asc(or(categories::Column::Position, 0.into()))
        .order_by_asc(categories::Column::Name)
        .order_by_asc(categories::Column::Id)
        .into_model()
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            json!({
                "id": row.id,
                "slug": row.slug,
                "name": row.name,
                "description": row.description,
                "parentId": row.parent_id,
                "position": row.position,
                "type": row.kind,
                "rules": row.rules,
                "rulesMatch": row.rules_match,
            })
        })
        .collect())
}

/// A category and its descendants as the storefront shows them.
fn node(rows: &[Value], at: usize, by_parent: &HashMap<String, Vec<usize>>, depth: u32) -> Value {
    let row = &rows[at];
    let id = text(row, "id").unwrap_or_default();
    let children: Vec<Value> = if depth >= 10 {
        Vec::new()
    } else {
        by_parent
            .get(&id)
            .map(|kids| {
                kids.iter()
                    .map(|k| node(rows, *k, by_parent, depth + 1))
                    .collect()
            })
            .unwrap_or_default()
    };
    json!({
        "id": id,
        "slug": row.get("slug"),
        "name": row.get("name"),
        "description": row.get("description").filter(|d| d.is_string()),
        "parentId": row.get("parentId").filter(|d| d.is_string()),
        "children": children,
    })
}

fn tree(rows: &[Value]) -> (Vec<usize>, HashMap<String, Vec<usize>>) {
    let ids: HashSet<String> = rows.iter().filter_map(|r| text(r, "id")).collect();
    let mut by_parent: HashMap<String, Vec<usize>> = HashMap::new();
    let mut roots = Vec::new();
    for (at, row) in rows.iter().enumerate() {
        match text(row, "parentId")
            .filter(|p| ids.contains(p) && Some(p) != text(row, "id").as_ref())
        {
            Some(parent) => by_parent.entry(parent).or_default().push(at),
            None => roots.push(at),
        }
    }
    (roots, by_parent)
}

pub(crate) async fn categories(Extension(principal): Extension<Principal>) -> Response {
    let rows = visible_categories(&orm(&principal.db)).await;
    match rows {
        Ok(rows) => {
            let (roots, by_parent) = tree(&rows);
            data(Value::Array(
                roots
                    .iter()
                    .map(|r| node(&rows, *r, &by_parent, 0))
                    .collect(),
            ))
        }
        Err(error) => internal(&error, "Failed to list categories"),
    }
}

pub(crate) async fn category(
    Extension(principal): Extension<Principal>,
    Path(id_or_slug): Path<String>,
) -> Response {
    let rows = visible_categories(&orm(&principal.db)).await;
    match rows {
        Ok(rows) => {
            let (_, by_parent) = tree(&rows);
            let found = rows
                .iter()
                .position(|r| text(r, "id").as_deref() == Some(id_or_slug.as_str()))
                .or_else(|| {
                    rows.iter()
                        .position(|r| text(r, "slug").as_deref() == Some(id_or_slug.as_str()))
                });
            match found {
                Some(at) => data(node(&rows, at, &by_parent, 0)),
                None => not_found(),
            }
        }
        Err(error) => internal(&error, "Failed to read the category"),
    }
}

fn not_found() -> Response {
    fail(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found", None)
}

// ── products ────────────────────────────────────────────────────────────────

/// The products that can be listed: `$1` the category's rules (`[]` when it
/// has none), `$2` `any` or `all`, `$3` a search pattern, `$4` a manual
/// category, `$5` whether the category is automated.
const CANDIDATES_SQL: &str = concat!(
    "select jsonb_build_object('id', t.id, 'name', t.name, \
       'createdAt', to_char(t.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.US'), \
       'hasVariants', coalesce(t.has_variants, false)) \
     from products t \
     where t.deleted_at is null and t.status = 'active' \
       and coalesce(t.visibility, 'visible') <> 'hidden' \
       and ($3::text is null or t.name ilike $3 or t.sku ilike $3 or t.brand ilike $3 \
            or t.vendor ilike $3 or t.short_description ilike $3) \
       and (case when $4::text is not null then exists ( \
              select 1 from category_products cp where cp.category_id = $4 and cp.product_id = t.id) \
            when $5::boolean then ",
    rules_match!(),
    " else true end)"
);

/// [`CANDIDATES_SQL`]: `{ id, name, createdAt, hasVariants }` of each
/// product the filters match.
#[allow(
    clippy::disallowed_methods,
    reason = "an automated category's rules are evaluated in SQL from one bound jsonb (crate::rules::rules_match!), a CASE per rule the query builder cannot express"
)]
async fn candidates(
    conn: &mut PgConnection,
    rules: &Value,
    any: bool,
    search: Option<String>,
    manual: Option<&str>,
    automated: bool,
) -> Result<Vec<Value>, DbErr> {
    sqlx::query_scalar(CANDIDATES_SQL)
        .bind(rules)
        .bind(if any { "any" } else { "all" })
        .bind(search)
        .bind(manual)
        .bind(automated)
        .fetch_all(&mut *conn)
        .await
        .map_err(weldsuite_db::orm_error)
}

/// The products a shop may show: live, `active`, not hidden.
fn listable() -> Select<products::Entity> {
    products::Entity::find()
        .filter(products::Column::DeletedAt.is_null())
        .filter(products::Column::Status.eq("active"))
        .filter(sea_orm::ExprTrait::ne(
            Func::coalesce([
                Expr::col((products::Entity, products::Column::Visibility)),
                Expr::val("visible"),
            ]),
            "hidden",
        ))
}

/// A priced product on the channel.
#[derive(Debug, Clone)]
struct Listed {
    id: String,
    name: String,
    created_at: String,
    price: Cents,
}

/// `coalesce(v.position, 0)`.
fn variant_position() -> Expr {
    Func::coalesce([
        Expr::col((product_variants::Entity, product_variants::Column::Position)),
        Expr::val(0),
    ])
    .into()
}

/// The live, active variants of the products (at least one), in their order.
fn active_variants(product_ids: &[String]) -> Select<product_variants::Entity> {
    product_variants::Entity::find()
        .filter(product_variants::Column::ProductId.is_in(product_ids.iter().map(String::as_str)))
        .filter(product_variants::Column::Status.eq("active"))
        .filter(product_variants::Column::DeletedAt.is_null())
        .order_by_asc(product_variants::Column::ProductId)
        .order_by_asc(variant_position())
        .order_by_asc(product_variants::Column::CreatedAt)
        .order_by_asc(product_variants::Column::Id)
}

async fn variant_targets(
    conn: &mut PgConnection,
    product_ids: &[String],
) -> Result<Vec<(String, String)>, DbErr> {
    active_variants(product_ids)
        .select_only()
        .columns([
            product_variants::Column::ProductId,
            product_variants::Column::Id,
        ])
        .into_tuple()
        .all(&OrmConn::new(conn))
        .await
}

/// Which of `rows` (`{ id, hasVariants }`) are sellable in `currency`, with
/// their lowest price.
async fn price_products(
    conn: &mut PgConnection,
    rows: &[Value],
    currency: &str,
) -> Result<HashMap<String, Cents>, weldsuite_commerce_domain::Error> {
    let with_variants: Vec<String> = rows
        .iter()
        .filter(|r| r["hasVariants"].as_bool().unwrap_or(false))
        .filter_map(|r| text(r, "id"))
        .collect();
    let variants = if with_variants.is_empty() {
        Vec::new()
    } else {
        variant_targets(conn, &with_variants).await?
    };
    let mut targets: Vec<Target> = rows
        .iter()
        .filter(|r| !r["hasVariants"].as_bool().unwrap_or(false))
        .filter_map(|r| {
            Some(Target {
                product_id: text(r, "id")?,
                variant_id: None,
            })
        })
        .collect();
    targets.extend(variants.iter().map(|(product, variant)| Target {
        product_id: product.clone(),
        variant_id: Some(variant.clone()),
    }));
    let priced = prices::resolve_many(conn, &targets, currency).await?;
    let mut lowest: HashMap<String, Cents> = HashMap::new();
    for (target, price) in priced {
        lowest
            .entry(target.product_id)
            .and_modify(|p| *p = (*p).min(price.price))
            .or_insert(price.price);
    }
    Ok(lowest)
}

struct ListQuery {
    category: Option<String>,
    search: Option<String>,
    sort: String,
    /// The keyset the page starts after (an opaque cursor, decoded).
    cursor: Option<PageCursor>,
    /// A cursor was sent and cannot be read: 400 `INVALID_CURSOR`.
    cursor_invalid: bool,
    limit: usize,
}

/// Where a page ends: the sort it belongs to, the sort value and the id of
/// the last product. Keyset paging: a product that is gone from the list
/// does not reset it, the next page starts after where it was.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PageCursor {
    s: String,
    k: String,
    /// The product's name, the tie-break of the price sorts.
    n: String,
    i: String,
}

fn encode_cursor(sort: &str, last: &Listed) -> String {
    use base64::Engine as _;
    let key = match sort {
        "price" | "-price" => last.price.to_string(),
        "newest" => last.created_at.clone(),
        _ => last.name.to_lowercase(),
    };
    let cursor = PageCursor {
        s: sort.to_owned(),
        k: key,
        n: last.name.to_lowercase(),
        i: last.id.clone(),
    };
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&cursor).unwrap_or_default())
}

fn decode_cursor(raw: &str, sort: &str) -> Option<PageCursor> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .ok()?;
    let cursor: PageCursor = serde_json::from_slice(&bytes).ok()?;
    (cursor.s == sort && cursor.i.len() <= 64 && cursor.k.len() <= 200 && cursor.n.len() <= 500)
        .then_some(cursor)
}

/// The listed product a cursor stands for, to compare the others with.
fn at_cursor(cursor: &PageCursor) -> Listed {
    Listed {
        id: cursor.i.clone(),
        name: cursor.n.clone(),
        created_at: cursor.k.clone(),
        price: cursor.k.parse().unwrap_or(0),
    }
}

fn read_query(query: Option<&str>) -> Result<ListQuery, Vec<(String, String)>> {
    let mut out = ListQuery {
        category: None,
        search: None,
        sort: "name".to_owned(),
        cursor: None,
        cursor_invalid: false,
        limit: 24,
    };
    let mut raw_cursor: Option<String> = None;
    let mut problems = Vec::new();
    for (key, value) in url_pairs(query.unwrap_or_default()) {
        match key.as_str() {
            "category" if !value.is_empty() => out.category = Some(value),
            "search" if !value.trim().is_empty() => {
                if value.chars().count() > 100 {
                    problems.push(("search".to_owned(), "At most 100 characters".to_owned()));
                } else {
                    out.search = Some(value.trim().to_owned());
                }
            }
            "sort" if !value.is_empty() => {
                if ["name", "-name", "price", "-price", "newest"].contains(&value.as_str()) {
                    out.sort = value;
                } else {
                    problems.push((
                        "sort".to_owned(),
                        "Must be name, -name, price, -price or newest".to_owned(),
                    ));
                }
            }
            "cursor" if !value.is_empty() => raw_cursor = Some(value),
            "limit" if !value.is_empty() => match value.parse::<usize>() {
                Ok(n) if (1..=100).contains(&n) => out.limit = n,
                _ => problems.push(("limit".to_owned(), "Must be from 1 to 100".to_owned())),
            },
            _ => {}
        }
    }
    if let Some(raw) = raw_cursor {
        out.cursor = decode_cursor(&raw, &out.sort);
        out.cursor_invalid = out.cursor.is_none();
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(problems)
    }
}

/// `a=b&c=d` with percent-decoding.
fn url_pairs(query: &str) -> Vec<(String, String)> {
    fn decode(text: &str) -> String {
        let bytes = text.replace('+', " ").into_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%'
                && i + 2 < bytes.len()
                && let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3])
                && let Ok(byte) = u8::from_str_radix(hex, 16)
            {
                out.push(byte);
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(k), decode(v))
        })
        .collect()
}

fn like(value: &str) -> String {
    format!("%{}%", crate::rules::like_literal(value))
}

fn compare(sort: &str, a: &Listed, b: &Listed) -> Ordering {
    let by_name = |a: &Listed, b: &Listed| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    };
    match sort {
        "-name" => by_name(b, a),
        "price" => a.price.cmp(&b.price).then_with(|| by_name(a, b)),
        "-price" => b.price.cmp(&a.price).then_with(|| by_name(a, b)),
        "newest" => b
            .created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id)),
        _ => by_name(a, b),
    }
}

pub(crate) async fn products(
    Extension(principal): Extension<Principal>,
    RawQuery(query): RawQuery,
) -> Response {
    let query = match read_query(query.as_deref()) {
        Ok(query) => query,
        Err(problems) => return validation(&problems),
    };
    if query.cursor_invalid {
        return fail(
            StatusCode::BAD_REQUEST,
            "INVALID_CURSOR",
            "The cursor is not one this list gave out (or is for another sort)",
            None,
        );
    }
    match list(&principal, &query).await {
        Ok(Some((items, more, cursor))) => {
            let body = json!({
                "data": items,
                "pagination": { "hasMore": more, "cursor": cursor },
            });
            axum::Json(body).into_response()
        }
        Ok(None) => not_found(),
        Err(error) => internal(&error, "Failed to list products"),
    }
}

type Page = (Vec<Value>, bool, Option<String>);

async fn list(
    principal: &Principal,
    query: &ListQuery,
) -> Result<Option<Page>, weldsuite_commerce_domain::Error> {
    let mut conn = principal.db.acquire().await?;
    let currency = &principal.channel.currency;
    // The category filter: manual members, or the rules of an automated one.
    let (mut rules, mut any, mut manual, mut automated) = (json!([]), false, None::<String>, false);
    if let Some(wanted) = &query.category {
        let rows = visible_categories(&OrmConn::new(&mut conn)).await?;
        let found = rows
            .iter()
            .find(|r| text(r, "id").as_deref() == Some(wanted.as_str()))
            .or_else(|| {
                rows.iter()
                    .find(|r| text(r, "slug").as_deref() == Some(wanted.as_str()))
            });
        let Some(category) = found else {
            return Ok(None);
        };
        if category["type"] == "automated" {
            automated = true;
            rules = rules_param(&stored_rules(category.get("rules")));
            any = category["rulesMatch"] == "any";
        } else {
            manual = text(category, "id");
        }
    }
    let candidates = candidates(
        &mut conn,
        &rules,
        any,
        query.search.as_deref().map(like),
        manual.as_deref(),
        automated,
    )
    .await?;
    let lowest = price_products(&mut conn, &candidates, currency).await?;
    let mut listed: Vec<Listed> = candidates
        .iter()
        .filter_map(|row| {
            let id = text(row, "id")?;
            Some(Listed {
                price: *lowest.get(&id)?,
                name: text(row, "name").unwrap_or_default(),
                created_at: text(row, "createdAt").unwrap_or_default(),
                id,
            })
        })
        .collect();
    listed.sort_by(|a, b| compare(&query.sort, a, b));
    let start = query.cursor.as_ref().map_or(0, |cursor| {
        let after = at_cursor(cursor);
        listed.partition_point(|l| compare(&query.sort, l, &after) != Ordering::Greater)
    });
    let page: Vec<&Listed> = listed.iter().skip(start).take(query.limit + 1).collect();
    let more = page.len() > query.limit;
    let page = &page[..page.len().min(query.limit)];
    let ids: Vec<String> = page.iter().map(|l| l.id.clone()).collect();
    let built = build(&mut conn, &principal.channel.currency, &ids).await?;
    let cursor = more
        .then(|| page.last().map(|l| encode_cursor(&query.sort, l)))
        .flatten();
    Ok(Some((built, more, cursor)))
}

pub(crate) async fn product(
    Extension(principal): Extension<Principal>,
    Path(id_or_slug): Path<String>,
) -> Response {
    let found = async {
        let mut conn = principal.db.acquire().await?;
        let id: Option<String> = listable()
            .select_only()
            .column(products::Column::Id)
            .filter(
                Condition::any()
                    .add(products::Column::Id.eq(id_or_slug.as_str()))
                    .add(products::Column::Slug.eq(id_or_slug.as_str())),
            )
            .order_by_desc(products::Column::Id.eq(id_or_slug.as_str()))
            .order_by_asc(products::Column::CreatedAt)
            .into_tuple()
            .one(&OrmConn::new(&mut conn))
            .await?;
        let Some(id) = id else {
            return Ok::<_, weldsuite_commerce_domain::Error>(None);
        };
        Ok(build(&mut conn, &principal.channel.currency, &[id])
            .await?
            .into_iter()
            .next())
    }
    .await;
    match found {
        Ok(Some(product)) => data(product),
        Ok(None) => not_found(),
        Err(error) => internal(&error, "Failed to read the product"),
    }
}

fn stock_ok(row: &Value, wanted: i64) -> bool {
    let tracked = row.get("track").and_then(Value::as_bool).unwrap_or(true);
    let backorder = row
        .get("backorder")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    !tracked || backorder || row.get("qty").and_then(Value::as_i64).unwrap_or(0) >= wanted
}

fn price_json(price: Option<&Price>) -> (Value, Value) {
    (
        price.map_or(Value::Null, |p| json!(money::format(p.price))),
        price
            .and_then(|p| p.compare_at)
            .map_or(Value::Null, |c| json!(money::format(c))),
    )
}

fn option_values(value: Option<&Value>) -> Value {
    let mut out = serde_json::Map::new();
    for entry in value.and_then(Value::as_array).into_iter().flatten() {
        if let (Some(name), Some(v)) = (text(entry, "name"), text(entry, "value")) {
            out.insert(name, json!(v));
        }
    }
    Value::Object(out)
}

/// Which of the live products `ids` an automated category's rules match.
#[allow(
    clippy::disallowed_methods,
    reason = "an automated category's rules are evaluated in SQL from one bound jsonb (crate::rules::rules_match!), a CASE per rule the query builder cannot express"
)]
async fn rule_members(
    conn: &mut PgConnection,
    rules: &Value,
    any: bool,
    ids: &[String],
) -> Result<Vec<String>, DbErr> {
    sqlx::query_scalar(concat!(
        "select t.id from products t where t.id = any($3) and t.deleted_at is null and ",
        rules_match!()
    ))
    .bind(rules)
    .bind(if any { "any" } else { "all" })
    .bind(ids)
    .fetch_all(&mut *conn)
    .await
    .map_err(weldsuite_db::orm_error)
}

/// The categories (`{ id, slug, name }`) each product is in, manual and
/// automated, visible ones only.
async fn product_categories(
    conn: &mut PgConnection,
    ids: &[String],
) -> Result<HashMap<String, Vec<Value>>, DbErr> {
    let categories = visible_categories(&OrmConn::new(&mut *conn)).await?;
    let mut members: HashMap<String, HashSet<String>> = HashMap::new();
    let manual: Vec<(String, String)> = category_products::Entity::find()
        .select_only()
        .columns([
            category_products::Column::CategoryId,
            category_products::Column::ProductId,
        ])
        .filter(category_products::Column::ProductId.is_in(ids.iter().map(String::as_str)))
        .into_tuple()
        .all(&OrmConn::new(&mut *conn))
        .await?;
    for (category, product) in manual {
        members.entry(category).or_default().insert(product);
    }
    for category in categories.iter().filter(|c| c["type"] == "automated") {
        let rules = rules_param(&stored_rules(category.get("rules")));
        let matched = rule_members(conn, &rules, category["rulesMatch"] == "any", ids).await?;
        if let Some(id) = text(category, "id") {
            members.entry(id).or_default().extend(matched);
        }
    }
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    for category in &categories {
        let Some(id) = text(category, "id") else {
            continue;
        };
        for product in members.get(&id).into_iter().flatten() {
            out.entry(product.clone()).or_default().push(json!({
                "id": id, "slug": category["slug"], "name": category["name"],
            }));
        }
    }
    for list in out.values_mut() {
        list.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    }
    Ok(out)
}

/// The live products `ids` (at least one): `{ id, slug, name, description,
/// featuredImageUrl, images, options, hasVariants, track, qty, backorder }`.
async fn product_rows(conn: &mut PgConnection, ids: &[String]) -> Result<Vec<Value>, DbErr> {
    let rows = products::Entity::find()
        .filter(products::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(products::Column::DeletedAt.is_null())
        .all(&OrmConn::new(conn))
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            json!({
                "id": row.id,
                "slug": row.slug,
                "name": row.name,
                "description": row.description,
                "featuredImageUrl": row.featured_image_url,
                "images": row.images,
                "options": row.options,
                "hasVariants": row.has_variants.unwrap_or(false),
                "track": row.track_inventory,
                "qty": row.inventory_quantity,
                "backorder": row.allow_backorder,
            })
        })
        .collect())
}

/// The active variants of the products `ids` (at least one), in their
/// order: `{ id, productId, name, sku, optionValues, track, qty, backorder }`.
async fn variant_rows(conn: &mut PgConnection, ids: &[String]) -> Result<Vec<Value>, DbErr> {
    let rows = active_variants(ids).all(&OrmConn::new(conn)).await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            json!({
                "id": row.id,
                "productId": row.product_id,
                "name": row.name,
                "sku": row.sku,
                "optionValues": row.option_values,
                "track": row.track_inventory,
                "qty": row.inventory_quantity,
                "backorder": row.allow_backorder,
            })
        })
        .collect())
}

#[allow(
    clippy::too_many_lines,
    reason = "rows, variants, prices, categories, then the JSON"
)]
/// The storefront products for `ids`, in that order; one that is not
/// sellable (no price, gone) is left out.
async fn build(
    conn: &mut PgConnection,
    currency: &str,
    ids: &[String],
) -> Result<Vec<Value>, weldsuite_commerce_domain::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = product_rows(conn, ids).await?;
    let variant_rows = variant_rows(conn, ids).await?;
    let mut targets: Vec<Target> = Vec::new();
    for row in &rows {
        let id = text(row, "id").unwrap_or_default();
        if !row["hasVariants"].as_bool().unwrap_or(false) {
            targets.push(Target {
                product_id: id,
                variant_id: None,
            });
        }
    }
    for variant in &variant_rows {
        targets.push(Target {
            product_id: text(variant, "productId").unwrap_or_default(),
            variant_id: text(variant, "id"),
        });
    }
    let priced = prices::resolve_many(conn, &targets, currency).await?;
    let categories = product_categories(conn, ids).await?;
    let mut out = Vec::new();
    for id in ids {
        let Some(row) = rows
            .iter()
            .find(|r| text(r, "id").as_deref() == Some(id.as_str()))
        else {
            continue;
        };
        let has_variants = row["hasVariants"].as_bool().unwrap_or(false);
        let mut variants: Vec<Value> = Vec::new();
        let mut headline: Option<Price> = None;
        let mut available = false;
        if has_variants {
            for variant in variant_rows
                .iter()
                .filter(|v| text(v, "productId").as_deref() == Some(id.as_str()))
            {
                let target = Target {
                    product_id: id.clone(),
                    variant_id: text(variant, "id"),
                };
                let Some(price) = priced.get(&target) else {
                    continue;
                };
                let ok = stock_ok(variant, 1);
                available |= ok;
                if headline.is_none_or(|h| price.price < h.price) {
                    headline = Some(*price);
                }
                let (amount, compare) = price_json(Some(price));
                variants.push(json!({
                    "id": variant["id"],
                    "name": variant.get("name").filter(|n| n.is_string()),
                    "sku": variant.get("sku").filter(|n| n.is_string()),
                    "optionValues": option_values(variant.get("optionValues")),
                    "price": amount,
                    "compareAtPrice": compare,
                    "available": ok,
                }));
            }
        } else {
            headline = priced
                .get(&Target {
                    product_id: id.clone(),
                    variant_id: None,
                })
                .copied();
            available = stock_ok(row, 1);
        }
        let Some(headline) = headline else {
            continue;
        };
        let (amount, compare) = price_json(Some(&headline));
        let images: Vec<Value> = row
            .get("images")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|image| {
                Some(json!({
                    "url": text(image, "url")?,
                    "altText": text(image, "altText"),
                }))
            })
            .collect();
        let options: Vec<Value> = row
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|option| {
                Some(json!({
                    "name": text(option, "name")?,
                    "values": option.get("values").cloned().unwrap_or_else(|| json!([])),
                }))
            })
            .collect();
        out.push(json!({
            "id": id,
            "slug": row["slug"],
            "name": row["name"],
            "description": row.get("description").filter(|d| d.is_string()),
            "featuredImageUrl": row.get("featuredImageUrl").filter(|d| d.is_string()),
            "images": images,
            "currency": currency,
            "price": amount,
            "compareAtPrice": compare,
            "options": options,
            "variants": variants,
            "available": available,
            "categories": categories.get(id).cloned().unwrap_or_default(),
        }));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_decode() {
        assert_eq!(
            url_pairs("search=a%20b+c&sort=-price&x"),
            vec![
                ("search".to_owned(), "a b c".to_owned()),
                ("sort".to_owned(), "-price".to_owned()),
                ("x".to_owned(), String::new()),
            ]
        );
        assert!(read_query(Some("limit=0")).is_err());
        assert!(read_query(Some("sort=cheapest")).is_err());
        assert_eq!(read_query(Some("limit=5")).expect("ok").limit, 5);
    }

    #[test]
    fn sorts() {
        let item = |id: &str, name: &str, price: Cents| Listed {
            id: id.into(),
            name: name.into(),
            created_at: id.into(),
            price,
        };
        let (a, b) = (item("1", "apple", 500), item("2", "Banana", 100));
        assert_eq!(compare("name", &a, &b), Ordering::Less);
        assert_eq!(compare("-name", &a, &b), Ordering::Greater);
        assert_eq!(compare("price", &a, &b), Ordering::Greater);
        assert_eq!(compare("newest", &a, &b), Ordering::Greater);
    }
}
