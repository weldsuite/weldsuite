//! Carts and checkout: the handlers read and validate the request, the
//! domain's `carts` and `checkout` do the work, and a placed order is
//! published like the staff routes publish theirs.

use axum::Extension;
use axum::body::Bytes;
use axum::extract::Path;
use axum::response::Response;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{CART_CREATED, CART_UPDATED, ORDER_CREATED};
use weldsuite_commerce_domain::carts::{self, Ctx, ItemInput, Patch, Quote, Refusal};
use weldsuite_commerce_domain::checkout;
use weldsuite_commerce_domain::money;
use weldsuite_events::publish_entity_event;

use super::{Principal, body_object, cart_token, created, data, internal, refuse, validation};

type Problems = Vec<(String, String)>;

fn ctx(principal: &Principal) -> Ctx<'_> {
    Ctx {
        db: &principal.db,
        http: principal.state.http.as_ref(),
        channel: &principal.channel,
    }
}

fn problem(problems: &mut Problems, path: &str, message: &str) {
    problems.push((path.to_owned(), message.to_owned()));
}

#[allow(
    clippy::option_option,
    reason = "a patch field: absent, null or a value"
)]
/// A string field: absent, `null` (clears) or text of at most `max`.
fn text_field(
    body: &Map<String, Value>,
    key: &str,
    max: usize,
    problems: &mut Problems,
) -> Option<Option<String>> {
    match body.get(key)? {
        Value::Null => Some(None),
        Value::String(s) => {
            let s = s.trim();
            if s.chars().count() > max {
                problem(problems, key, &format!("At most {max} characters"));
                None
            } else {
                Some(Some(s.to_owned()).filter(|s| !s.is_empty()))
            }
        }
        _ => {
            problem(problems, key, "Must be text");
            None
        }
    }
}

#[allow(
    clippy::option_option,
    reason = "a patch field: absent, null or a value"
)]
fn email_field(body: &Map<String, Value>, problems: &mut Problems) -> Option<Option<String>> {
    let value = text_field(body, "email", 255, problems)?;
    if let Some(email) = &value {
        let ok = email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !email.contains(char::is_whitespace)
        });
        if !ok {
            problem(problems, "email", "Must be an email address");
            return None;
        }
    }
    Some(value)
}

fn item_input(value: &Value, path: &str, problems: &mut Problems) -> ItemInput {
    let mut input = ItemInput::default();
    let Some(object) = value.as_object() else {
        problem(problems, path, "Must be an object");
        return input;
    };
    for (key, slot) in [
        ("productId", &mut input.product_id),
        ("variantId", &mut input.variant_id),
    ] {
        match object.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if !s.is_empty() && s.len() <= 64 => *slot = Some(s.clone()),
            Some(_) => problem(problems, &format!("{path}{key}"), "Must be an id"),
        }
    }
    match object.get("quantity").and_then(Value::as_i64) {
        Some(q) => input.quantity = q,
        None => problem(
            problems,
            &format!("{path}quantity"),
            "Must be a whole number",
        ),
    }
    input
}

fn finish(quote: Quote) -> Response {
    data(quote.json)
}

pub(crate) async fn create(Extension(principal): Extension<Principal>, body: Bytes) -> Response {
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let mut problems = Problems::new();
    let mut items = Vec::new();
    match body.get("items") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) if list.len() <= 100 => {
            for (index, item) in list.iter().enumerate() {
                items.push(item_input(item, &format!("items.{index}."), &mut problems));
            }
        }
        Some(_) => problem(
            &mut problems,
            "items",
            "Must be a list of at most 100 items",
        ),
    }
    let email = email_field(&body, &mut problems).flatten();
    if !problems.is_empty() {
        return validation(&problems);
    }
    match carts::create(&ctx(&principal), &items, email.as_deref()).await {
        Ok((quote, token)) => {
            publish_entity_event(
                &principal.state.events,
                &principal.events,
                CART_CREATED,
                quote.cart_id.clone(),
                &json!({
                    "id": quote.cart_id,
                    "channelId": principal.channel.id,
                    "currency": principal.channel.currency,
                    "itemCount": quote.lines.len(),
                }),
            );
            created(json!({ "cart": quote.json, "cartToken": token }))
        }
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn read(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Response {
    let token = match cart_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match carts::read(&ctx(&principal), &token).await {
        Ok(quote) => finish(quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn add_item(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let token = match cart_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let mut problems = Problems::new();
    let input = item_input(&Value::Object(body), "", &mut problems);
    if !problems.is_empty() {
        return validation(&problems);
    }
    match carts::add_item(&ctx(&principal), &token, &input).await {
        Ok(quote) => finish(quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn set_quantity(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(line_id): Path<String>,
    body: Bytes,
) -> Response {
    let token = match cart_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(quantity) = body.get("quantity").and_then(Value::as_i64) else {
        return validation(&[("quantity".to_owned(), "Must be a whole number".to_owned())]);
    };
    match carts::set_quantity(&ctx(&principal), &token, &line_id, quantity).await {
        Ok(quote) => finish(quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn remove_item(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(line_id): Path<String>,
) -> Response {
    let token = match cart_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match carts::set_quantity(&ctx(&principal), &token, &line_id, 0).await {
        Ok(quote) => finish(quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn patch(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let token = match cart_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let mut problems = Problems::new();
    let mut patch = Patch {
        email: email_field(&body, &mut problems),
        buyer_vat_number: text_field(&body, "buyerVatNumber", 50, &mut problems),
        customer_reference: text_field(&body, "customerReference", 100, &mut problems),
        note: text_field(&body, "note", 1000, &mut problems),
        ..Patch::default()
    };
    for (key, slot) in [
        ("shippingAddress", &mut patch.shipping_address),
        ("billingAddress", &mut patch.billing_address),
    ] {
        match body.get(key) {
            None => {}
            Some(Value::Null) => *slot = Some(None),
            Some(value) => {
                if let Some(address) = carts::clean_address(value, key, &mut problems) {
                    *slot = Some(Some(address));
                }
            }
        }
    }
    if !problems.is_empty() {
        return validation(&problems);
    }
    match carts::patch(&ctx(&principal), &token, &patch).await {
        Ok(quote) => finish(quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn shipping_rates(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Response {
    let token = match cart_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match carts::shipping_rates(&ctx(&principal), &token).await {
        Ok(offers) => data(Value::Array(
            offers
                .iter()
                .map(|o| {
                    json!({
                        "id": o.id, "name": o.name,
                        "price": money::format(o.price), "free": o.free,
                    })
                })
                .collect(),
        )),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn set_rate(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let token = match cart_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(rate) = body
        .get("shippingRateId")
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty() && r.len() <= 64)
    else {
        return validation(&[("shippingRateId".to_owned(), "Required".to_owned())]);
    };
    match carts::set_rate(&ctx(&principal), &token, rate).await {
        Ok(quote) => finish(quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn apply_discount(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let token = match cart_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(code) = body
        .get("code")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| !c.is_empty() && c.chars().count() <= 100)
    else {
        return validation(&[(
            "code".to_owned(),
            "Required, at most 100 characters".to_owned(),
        )]);
    };
    match carts::set_discount(&ctx(&principal), &token, Some(code)).await {
        Ok(quote) => finish(quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn remove_discount(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Response {
    let token = match cart_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    match carts::set_discount(&ctx(&principal), &token, None).await {
        Ok(quote) => finish(quote),
        Err(refusal) => refuse(refusal),
    }
}

/// The `order:created` data, as the staff routes publish it.
fn order_event(order: &Value) -> Value {
    json!({
        "id": order["id"],
        "orderNumber": order["orderNumber"],
        "status": order["status"],
        "paymentStatus": order["paymentStatus"],
        "total": order["total"],
        "currency": order["currency"],
        "customerName": order["customerName"],
        "customerEmail": order["customerEmail"],
        "personId": Value::Null,
        "companyId": Value::Null,
        "source": "storefront",
    })
}

#[allow(
    clippy::too_many_lines,
    reason = "read and check the body, place the order, publish"
)]
pub(crate) async fn checkout(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let token = match cart_token(&headers) {
        Ok(token) => token,
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let mut problems = Problems::new();
    let method = if let Some(m @ ("mollie" | "invoice")) =
        body.get("paymentMethod").and_then(Value::as_str)
    {
        m.to_owned()
    } else {
        problem(&mut problems, "paymentMethod", "Must be mollie or invoice");
        String::new()
    };
    let expected = match body.get("expectedTotal") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let parsed = money::parse(s);
            if parsed.is_none() {
                problem(
                    &mut problems,
                    "expectedTotal",
                    "Must be an amount like 19.99",
                );
            }
            parsed
        }
        Some(_) => {
            problem(
                &mut problems,
                "expectedTotal",
                "Must be an amount like 19.99",
            );
            None
        }
    };
    match body.get("redirectUrl") {
        None | Some(Value::Null) => {}
        Some(Value::String(s))
            if s.len() <= 2000 && (s.starts_with("https://") || s.starts_with("http://")) => {}
        Some(_) => problem(&mut problems, "redirectUrl", "Must be an http(s) URL"),
    }
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_owned);
    if key.as_ref().is_some_and(|k| k.chars().count() > 100) {
        problem(&mut problems, "Idempotency-Key", "At most 100 characters");
    }
    if !problems.is_empty() {
        return validation(&problems);
    }
    let input = checkout::Input {
        payment_method: method,
        expected_total: expected,
        idempotency_key: key,
    };
    let placed = match checkout::checkout(&ctx(&principal), &token, &input).await {
        Ok(placed) => placed,
        Err(refusal) => return refuse(refusal),
    };
    let view = async {
        let mut conn = principal.db.acquire().await?;
        let view = checkout::order_view(&mut conn, &placed.order_id).await?;
        let raw =
            weldsuite_commerce_domain::orders::load(&mut conn, &placed.order_id, false).await?;
        Ok::<_, sqlx::Error>((view, raw))
    }
    .await;
    let (view, raw) = match view {
        Ok(found) => found,
        Err(error) => return refuse(Refusal::Database(error)),
    };
    if !placed.replayed {
        if let Some(raw) = raw {
            publish_entity_event(
                &principal.state.events,
                &principal.events,
                ORDER_CREATED,
                placed.order_id.clone(),
                &order_event(&raw.order),
            );
        }
        publish_entity_event(
            &principal.state.events,
            &principal.events,
            CART_UPDATED,
            placed.cart_id.clone(),
            &json!({
                "id": placed.cart_id,
                "channelId": principal.channel.id,
                "status": "completed",
                "orderId": placed.order_id,
            }),
        );
    }
    if view.is_null() {
        return internal(&"order not found after checkout", "Checkout failed");
    }
    created(json!({ "order": view, "payment": Value::Null, "orderToken": Value::Null }))
}
