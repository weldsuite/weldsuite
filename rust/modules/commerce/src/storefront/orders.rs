//! The shopper's orders (ADR COM-012): the account's order list and detail,
//! the guest's order link, reorder and quick order.
//!
//! An order belongs to the shopper (`orders.person_id`), and a company
//! `approver` or `admin` also sees the orders of the company they are
//! signed in for. A guest order is reached only with its access token: the
//! hash of the random token checkout returned once.

#![allow(
    clippy::result_large_err,
    clippy::option_option,
    reason = "a refusal is the response to send; a patch field is absent, null or a value"
)]

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, Condition, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{CART_CREATED, CART_UPDATED};
use weldsuite_commerce_domain::carts::{self, Attach, Filled, LineProblem, Wanted};
use weldsuite_commerce_domain::checkout::{self, order_token_hash};
use weldsuite_db::OrmConn;
use weldsuite_events::publish_entity_event;
use weldsuite_schema::tenant::{order_items, orders, parties};

use super::shopper::{self, Loaded};
use super::{Principal, body_object, data, fail, internal, refuse, validation};

/// Rows a quick order takes at most.
const MAX_ROWS: usize = 500;

fn not_found() -> Response {
    fail(StatusCode::NOT_FOUND, "NOT_FOUND", "Order not found", None)
}

/// `(product, variant, sku, quantity)` of an order item.
type ItemRow = (Option<String>, Option<String>, Option<String>, i32);

/// What a cart attached to this shopper carries: on a B2B channel the
/// company and the buyer.
pub(super) fn attach_of(loaded: &Loaded, b2b: bool) -> Attach<'_> {
    let member = loaded.active.as_ref().filter(|_| b2b);
    Attach {
        person_id: &loaded.person.id,
        email: &loaded.person.email,
        company_id: member.map(|m| m.company_id.as_str()),
        buyer_id: member.map(|m| m.buyer_id.as_str()),
    }
}

/// The orders the shopper may see: their own, and for a company approver or
/// admin the active company's. `after` is the id the page starts after.
async fn visible(
    principal: &Principal,
    loaded: &Loaded,
    only: Option<&str>,
    after: Option<&(String, String)>,
    limit: i64,
) -> Result<Vec<(Value, String)>, weldsuite_commerce_domain::Error> {
    let company = loaded
        .active
        .as_ref()
        .filter(|m| matches!(m.role.as_str(), "approver" | "admin"))
        .map(|m| m.company_id.clone());
    let mut conn = principal.db.acquire().await?;
    // The shopper's own orders, or (an approver's) the company's.
    let mut whose = Condition::any().add(orders::Column::PersonId.eq(loaded.person.id.as_str()));
    if let Some(company) = company {
        whose = whose.add(parties::Column::CompanyId.eq(company));
    }
    let mut found = orders::Entity::find()
        .select_only()
        .column(orders::Column::Id)
        // The keyset as Postgres prints it, read back with `::timestamp`.
        .column_as(
            Expr::from(Func::cast_as(
                Expr::col((orders::Entity, orders::Column::CreatedAt)),
                "text",
            )),
            "at",
        )
        .join(
            JoinType::LeftJoin,
            orders::Entity::belongs_to(parties::Entity)
                .from(orders::Column::CounterpartyId)
                .to(parties::Column::Id)
                .into(),
        )
        .filter(orders::Column::DeletedAt.is_null())
        .filter(orders::Column::ChannelId.eq(principal.channel.id.as_str()))
        .filter(whose);
    if let Some(only) = only {
        found = found.filter(orders::Column::Id.eq(only));
    }
    if let Some((at, id)) = after {
        found = found.filter(sea_orm::ExprTrait::lt(
            Expr::tuple([
                Expr::col((orders::Entity, orders::Column::CreatedAt)),
                Expr::col((orders::Entity, orders::Column::Id)),
            ]),
            Expr::tuple([
                sea_orm::ExprTrait::cast_as(Expr::val(at.as_str()), "timestamp"),
                Expr::val(id.as_str()),
            ]),
        ));
    }
    let ids: Vec<(String, String)> = found
        .order_by_desc(orders::Column::CreatedAt)
        .order_by_desc(orders::Column::Id)
        .limit(u64::try_from(limit).unwrap_or(0))
        .into_tuple()
        .all(&OrmConn::new(&mut conn))
        .await?;
    let mut views = Vec::with_capacity(ids.len());
    for (id, at) in ids {
        let view = checkout::order_view(&mut conn, &id).await?;
        if !view.is_null() {
            views.push((view, at));
        }
    }
    Ok(views)
}

/// `GET /account/orders`.
pub(crate) async fn list(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let loaded = match shopper::require(&principal, &headers).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let (cursor, limit) = match page_params(query.as_deref()) {
        Ok(page) => page,
        Err(response) => return response,
    };
    match visible(&principal, &loaded, None, cursor.as_ref(), limit + 1).await {
        Ok(mut orders) => {
            let more = i64::try_from(orders.len()).unwrap_or(0) > limit;
            orders.truncate(usize::try_from(limit).unwrap_or(25));
            let next = orders
                .last()
                .filter(|_| more)
                .and_then(|(order, at)| Some(encode_cursor(at, order["id"].as_str()?)));
            let items: Vec<Value> = orders.into_iter().map(|(order, _)| order).collect();
            axum::Json(json!({
                "data": items,
                "pagination": { "hasMore": more, "cursor": next },
            }))
            .into_response()
        }
        Err(error) => internal(&error, "The orders could not be read"),
    }
}

/// `GET /account/orders/:id`.
pub(crate) async fn read(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let loaded = match shopper::require(&principal, &headers).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    match visible(&principal, &loaded, Some(&id), None, 1).await {
        Ok(mut orders) => match orders.pop() {
            Some((order, _)) => data(order),
            None => not_found(),
        },
        Err(error) => internal(&error, "The order could not be read"),
    }
}

/// `GET /orders/:id?token=`: a guest's order link.
pub(crate) async fn guest(
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let token = query
        .as_deref()
        .into_iter()
        .flat_map(|q| url::form_urlencoded::parse(q.as_bytes()))
        .find(|(name, _)| name == "token")
        .map(|(_, value)| value.into_owned())
        .filter(|t| !t.is_empty() && t.len() <= 200);
    let Some(token) = token else {
        return not_found();
    };
    let found = async {
        let mut conn = principal.db.acquire().await?;
        let matched: Option<String> = orders::Entity::find_by_id(id.as_str())
            .select_only()
            .column(orders::Column::Id)
            .filter(orders::Column::ChannelId.eq(principal.channel.id.as_str()))
            .filter(orders::Column::GuestAccessTokenHash.eq(order_token_hash(&token)))
            .filter(orders::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&OrmConn::new(&mut conn))
            .await?;
        match matched {
            Some(id) => Ok(Some(checkout::order_view(&mut conn, &id).await?)),
            None => Ok::<_, weldsuite_commerce_domain::Error>(None),
        }
    }
    .await;
    match found {
        Ok(Some(order)) if !order.is_null() => data(order),
        Ok(_) => not_found(),
        Err(error) => internal(&error, "The order could not be read"),
    }
}

fn encode_cursor(at: &str, id: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json!({ "t": at, "i": id }).to_string())
}

fn decode_cursor(raw: &str) -> Option<(String, String)> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(raw)
        .ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let at = value.get("t")?.as_str()?.to_owned();
    let id = value.get("i")?.as_str()?.to_owned();
    // A timestamp as Postgres prints it: digits, dashes, colons, a dot, a space.
    let shaped = at.len() <= 40
        && at
            .bytes()
            .all(|b| b.is_ascii_digit() || b"-:. T".contains(&b));
    (shaped && id.len() <= 64).then_some((at, id))
}

/// `?cursor=&limit=`: the keyset to start after and the page size (default
/// 25, at most 100); 400 `INVALID_CURSOR` for a cursor that cannot be read.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
fn page_params(query: Option<&str>) -> Result<(Option<(String, String)>, i64), Response> {
    let mut cursor = None;
    let mut limit = 25;
    for (name, value) in query
        .into_iter()
        .flat_map(|q| url::form_urlencoded::parse(q.as_bytes()))
    {
        match name.as_ref() {
            "cursor" if !value.is_empty() => {
                cursor = Some(decode_cursor(&value).ok_or_else(|| {
                    fail(
                        StatusCode::BAD_REQUEST,
                        "INVALID_CURSOR",
                        "The cursor is not one this list gave out",
                        None,
                    )
                })?);
            }
            "limit" if !value.is_empty() => match value.parse::<i64>() {
                Ok(n) if (1..=100).contains(&n) => limit = n,
                _ => {
                    return Err(validation(&[(
                        "limit".to_owned(),
                        "Must be from 1 to 100".to_owned(),
                    )]));
                }
            },
            _ => {}
        }
    }
    Ok((cursor, limit))
}

fn problem_json(problem: &LineProblem) -> Value {
    json!({
        "row": problem.row,
        "sku": problem.sku,
        "productId": problem.product_id,
        "problem": problem.problem,
        "message": problem.message,
    })
}

/// `{ cart, cartToken, problems }`, after publishing the cart's event.
fn filled(principal: &Principal, done: &Filled) -> Response {
    let made = done.token.is_some();
    publish_entity_event(
        &principal.state.events,
        &principal.events,
        if made { CART_CREATED } else { CART_UPDATED },
        done.quote.cart_id.clone(),
        &json!({
            "id": done.quote.cart_id,
            "channelId": principal.channel.id,
            "currency": principal.channel.currency,
            "itemCount": done.quote.lines.len(),
        }),
    );
    data(json!({
        "cart": done.quote.json,
        "cartToken": done.token,
        "problems": done.problems.iter().map(problem_json).collect::<Vec<_>>(),
    }))
}

fn optional_cart_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-cart-token")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

/// `POST /account/orders/:id/reorder`: the order's lines into the cart of
/// `X-Cart-Token`, or a new cart.
pub(crate) async fn reorder(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let loaded = match shopper::require(&principal, &headers).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let lines = async {
        if visible(&principal, &loaded, Some(&id), None, 1)
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        let mut conn = principal.db.acquire().await?;
        let rows: Vec<ItemRow> = order_items::Entity::find()
            .select_only()
            .columns([
                order_items::Column::ProductId,
                order_items::Column::VariantId,
                order_items::Column::Sku,
                order_items::Column::Quantity,
            ])
            .filter(order_items::Column::OrderId.eq(id.as_str()))
            .order_by_asc(order_items::Column::CreatedAt)
            .order_by_asc(order_items::Column::Id)
            .into_tuple()
            .all(&OrmConn::new(&mut conn))
            .await?;
        Ok::<_, weldsuite_commerce_domain::Error>(Some(rows))
    }
    .await;
    let rows = match lines {
        Ok(Some(rows)) => rows,
        Ok(None) => return not_found(),
        Err(error) => return internal(&error, "The order could not be read"),
    };
    let wanted: Vec<Wanted> = rows
        .into_iter()
        .map(|(product_id, variant_id, sku, quantity)| Wanted {
            row: None,
            sku,
            product_id,
            variant_id,
            quantity: i64::from(quantity),
        })
        .collect();
    let who = attach_of(&loaded, principal.channel.audience == "b2b");
    let token = optional_cart_token(&headers);
    match carts::fill(
        &super::cart::ctx(&principal),
        token.as_deref(),
        &wanted,
        Some(&who),
    )
    .await
    {
        Ok(done) => filled(&principal, &done),
        Err(refusal) => refuse(refusal),
    }
}

/// The rows of a pasted CSV: `sku,quantity` per row (`;` or a tab work as
/// well), a header optional; the row number is the line's number.
fn csv_rows(csv: &str) -> Vec<(i64, String, String)> {
    let mut rows = Vec::new();
    for (index, line) in csv.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut cells = line.splitn(2, [',', ';', '\t']);
        let sku = cells
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches('"')
            .trim();
        let quantity = cells
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches('"')
            .trim();
        if index == 0 && sku.eq_ignore_ascii_case("sku") && quantity.parse::<i64>().is_err() {
            continue;
        }
        rows.push((
            i64::try_from(index + 1).unwrap_or(0),
            sku.to_owned(),
            quantity.to_owned(),
        ));
    }
    rows
}

/// `POST /cart/quick-order`: `{ lines?, csv? }` into the cart, with the lines
/// that could not be added reported.
pub(crate) async fn quick_order(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let shopper = match shopper::optional(&principal, &headers).await {
        Ok(shopper) => shopper,
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let mut wanted: Vec<Wanted> = Vec::new();
    match body.get("lines") {
        None | Some(Value::Null) => {}
        Some(Value::Array(lines)) => {
            for (index, line) in lines.iter().enumerate() {
                let sku = line.get("sku").and_then(Value::as_str).map(str::trim);
                let Some(sku) = sku.filter(|s| !s.is_empty() && s.len() <= 100) else {
                    return validation(&[(
                        format!("lines.{index}.sku"),
                        "Required, at most 100 characters".to_owned(),
                    )]);
                };
                wanted.push(Wanted {
                    row: i64::try_from(index + 1).ok(),
                    sku: Some(sku.to_owned()),
                    // Not a whole number: a problem on its row, not a 400.
                    quantity: line.get("quantity").and_then(Value::as_i64).unwrap_or(0),
                    ..Wanted::default()
                });
            }
        }
        Some(_) => {
            return validation(&[("lines".to_owned(), "Must be a list".to_owned())]);
        }
    }
    match body.get("csv") {
        None | Some(Value::Null) => {}
        Some(Value::String(csv)) if csv.len() <= 200_000 => {
            for (row, sku, quantity) in csv_rows(csv) {
                wanted.push(Wanted {
                    row: Some(row),
                    sku: Some(sku).filter(|s| !s.is_empty()),
                    quantity: quantity.parse::<i64>().unwrap_or(0),
                    ..Wanted::default()
                });
            }
        }
        Some(_) => {
            return validation(&[(
                "csv".to_owned(),
                "Must be text of at most 200000 characters".to_owned(),
            )]);
        }
    }
    if wanted.is_empty() {
        return validation(&[(
            "lines".to_owned(),
            "Send lines or a csv with rows".to_owned(),
        )]);
    }
    if wanted.len() > MAX_ROWS {
        return validation(&[("lines".to_owned(), format!("At most {MAX_ROWS} rows"))]);
    }
    // A row without a SKU can never be found.
    let (blank, wanted): (Vec<Wanted>, Vec<Wanted>) =
        wanted.into_iter().partition(|w| w.sku.is_none());
    let who = shopper
        .as_ref()
        .map(|s| attach_of(s, principal.channel.audience == "b2b"));
    let token = optional_cart_token(&headers);
    match carts::fill(
        &super::cart::ctx(&principal),
        token.as_deref(),
        &wanted,
        who.as_ref(),
    )
    .await
    {
        Ok(mut done) => {
            done.problems.extend(blank.iter().map(|w| LineProblem {
                row: w.row,
                sku: None,
                product_id: None,
                problem: "UNKNOWN_SKU",
                message: "The row has no SKU".to_owned(),
            }));
            filled(&principal, &done)
        }
        Err(refusal) => refuse(refusal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_rows_skip_a_header_and_blank_lines() {
        let rows = csv_rows("sku,quantity\nA-1,3\n\n B-2 ; 10 \n\"C-3\",x\n");
        assert_eq!(
            rows,
            vec![
                (2, "A-1".to_owned(), "3".to_owned()),
                (4, "B-2".to_owned(), "10".to_owned()),
                (5, "C-3".to_owned(), "x".to_owned()),
            ]
        );
        // A first row that is a SKU stays.
        assert_eq!(csv_rows("A-1,3").len(), 1);
        assert_eq!(csv_rows("").len(), 0);
    }
}
