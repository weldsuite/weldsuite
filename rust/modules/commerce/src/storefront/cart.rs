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

use super::{
    Principal, body_object, cart_token, created, data, fail, internal, payments, refuse, shopper,
    validation,
};
use crate::{decide, mail};

type Problems = Vec<(String, String)>;

pub(super) fn ctx(principal: &Principal) -> Ctx<'_> {
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

/// A cart write's answer, after publishing `cart:updated` (the same data as
/// `cart:created`): every change to a cart is an event.
fn updated(principal: &Principal, quote: Quote) -> Response {
    publish_entity_event(
        &principal.state.events,
        &principal.events,
        CART_UPDATED,
        quote.cart_id.clone(),
        &json!({
            "id": quote.cart_id,
            "channelId": principal.channel.id,
            "currency": principal.channel.currency,
            "itemCount": quote.lines.len(),
        }),
    );
    finish(quote)
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
    let token = match cart_token(&principal, &headers).await {
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
    let token = match cart_token(&principal, &headers).await {
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
        Ok(quote) => updated(&principal, quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn set_quantity(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(line_id): Path<String>,
    body: Bytes,
) -> Response {
    let token = match cart_token(&principal, &headers).await {
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
        Ok(quote) => updated(&principal, quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn remove_item(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(line_id): Path<String>,
) -> Response {
    let token = match cart_token(&principal, &headers).await {
        Ok(token) => token,
        Err(response) => return response,
    };
    match carts::set_quantity(&ctx(&principal), &token, &line_id, 0).await {
        Ok(quote) => updated(&principal, quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn patch(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let token = match cart_token(&principal, &headers).await {
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
        Ok(quote) => updated(&principal, quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn shipping_rates(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Response {
    let token = match cart_token(&principal, &headers).await {
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
    let token = match cart_token(&principal, &headers).await {
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
        Ok(quote) => updated(&principal, quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn apply_discount(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let token = match cart_token(&principal, &headers).await {
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
        Ok(quote) => updated(&principal, quote),
        Err(refusal) => refuse(refusal),
    }
}

pub(crate) async fn remove_discount(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Response {
    let token = match cart_token(&principal, &headers).await {
        Ok(token) => token,
        Err(response) => return response,
    };
    match carts::set_discount(&ctx(&principal), &token, None).await {
        Ok(quote) => updated(&principal, quote),
        Err(refusal) => refuse(refusal),
    }
}

/// The `order:created` data, as the staff routes publish it.
fn order_event(order: &Value, person: Option<&str>, company: Option<&str>) -> Value {
    json!({
        "id": order["id"],
        "orderNumber": order["orderNumber"],
        "status": order["status"],
        "paymentStatus": order["paymentStatus"],
        "total": order["total"],
        "currency": order["currency"],
        "customerName": order["customerName"],
        "customerEmail": order["customerEmail"],
        "personId": person,
        "companyId": company,
        "source": "storefront",
    })
}

/// `orderUrl`: an `https://` template with `{orderId}` and `{token}`; for a
/// publishable key its origin must be one of the key's allowed origins.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
fn read_order_url(
    principal: &Principal,
    body: &Map<String, Value>,
) -> Result<Option<String>, Response> {
    let text = match body.get("orderUrl") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(text)) => text.trim(),
        Some(_) => {
            return Err(validation(&[(
                "orderUrl".to_owned(),
                "Must be an https URL".to_owned(),
            )]));
        }
    };
    // The template as a URL: the placeholders stand in for ids and tokens.
    let probe = text
        .replace("{orderId}", "ord_x")
        .replace("{token}", "tok_x");
    let valid = text.len() <= 2000
        && text.starts_with("https://")
        && !text.contains(char::is_whitespace)
        && url::Url::parse(&probe).is_ok();
    if !valid {
        return Err(validation(&[(
            "orderUrl".to_owned(),
            "Must be an https URL, with {orderId} and {token} where they belong".to_owned(),
        )]));
    }
    if !payments::redirect_allowed(principal, &probe) {
        return Err(fail(
            http::StatusCode::BAD_REQUEST,
            "ORDER_URL_NOT_ALLOWED",
            "The order URL is not on one of the key's allowed origins",
            None,
        ));
    }
    Ok(Some(text.to_owned()))
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
    let token = match cart_token(&principal, &headers).await {
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
    let redirect = body
        .get("redirectUrl")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if !problems.is_empty() {
        return validation(&problems);
    }
    let order_url = match read_order_url(&principal, &body) {
        Ok(url) => url,
        Err(response) => return response,
    };
    if method == "mollie" {
        // The shop's own state first (nothing connected), then the request.
        if let Err(response) = payments::connected(&principal).await {
            return response;
        }
        match redirect.as_deref() {
            None => problem(&mut problems, "redirectUrl", "Required to pay with mollie"),
            Some(url) if !url.starts_with("https://") => {
                problem(&mut problems, "redirectUrl", "Must be an https URL");
            }
            Some(_) => {}
        }
        if !problems.is_empty() {
            return validation(&problems);
        }
        if let Some(url) = redirect.as_deref()
            && !payments::redirect_allowed(&principal, url)
        {
            return fail(
                http::StatusCode::BAD_REQUEST,
                "REDIRECT_NOT_ALLOWED",
                "The redirect URL is not on one of the key's allowed origins",
                None,
            );
        }
        if let Err(response) = payments::reachable(&principal) {
            return response;
        }
    }
    let shopper = match shopper::optional(&principal, &headers).await {
        Ok(shopper) => shopper,
        Err(response) => return response,
    };
    let mollie = method == "mollie";
    let on_invoice = method == "invoice";
    let input = checkout::Input {
        payment_method: method,
        expected_total: expected,
        idempotency_key: key,
        shopper: shopper.as_ref().map(|s| checkout::Shopper {
            person_id: s.person.id.clone(),
            company_id: s.active.as_ref().map(|m| m.company_id.clone()),
        }),
        redirect_url: redirect.clone().filter(|_| mollie),
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
        Ok::<_, Refusal>((view, raw))
    }
    .await;
    let (view, raw) = match view {
        Ok(found) => found,
        Err(error) => return refuse(error),
    };
    let customer_email = raw
        .as_ref()
        .and_then(|r| r.order["customerEmail"].as_str().map(str::to_owned));
    if !placed.replayed {
        if let Some(raw) = raw {
            publish_entity_event(
                &principal.state.events,
                &principal.events,
                ORDER_CREATED,
                placed.order_id.clone(),
                &order_event(
                    &raw.order,
                    placed.person_id.as_deref(),
                    placed.company_id.as_deref(),
                ),
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
    if on_invoice && !placed.replayed && placed.approval_reason.is_none() {
        payments::invoice_on_placement(&principal, &placed.order_id).await;
    }
    // A Mollie order waits for its approval before it is paid.
    let payment = if mollie && placed.approval_reason.is_none() {
        let redirect = redirect.as_deref().unwrap_or_default();
        match payments::create(&principal, &placed.order_id, redirect).await {
            Ok(payment) => payment,
            Err(response) => return response,
        }
    } else {
        Value::Null
    };
    if !placed.replayed {
        // The emails go out now: nothing is held, the order is committed.
        let locale = mail::locale(None, Some(&headers));
        let link = mail::fill_order_url(
            order_url.as_deref(),
            &placed.order_id,
            placed.order_token.as_deref().unwrap_or_default(),
        );
        if let Some(to) =
            customer_email.or_else(|| shopper.as_ref().map(|s| s.person.email.clone()))
        {
            mail::confirmation(
                &principal.state.mail,
                &principal.channel.name,
                &to,
                &view,
                link,
                locale,
            )
            .await;
        }
        if let (Some(reason), Some(company)) =
            (placed.approval_reason, placed.company_id.as_deref())
        {
            decide::notify_approvers(
                &principal.db,
                &principal.state.mail,
                &principal.channel.name,
                company,
                placed.person_id.as_deref(),
                &view,
                reason,
                locale,
            )
            .await;
        }
    }
    created(json!({ "order": view, "payment": payment, "orderToken": placed.order_token }))
}
