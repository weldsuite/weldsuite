//! Storefront checkout (ADR COM-011): the cart becomes an order.
//!
//! Everything is worked out again at the moment of checkout, never taken
//! from what the shopper saw: prices, stock, the discount code, the shipping
//! rate and the VAT ([`carts::quote`]). The order is placed through
//! [`orders::write::create`] (source `storefront`, the channel's id, the
//! cart's lines at their current prices, the cart's addresses and VAT
//! number), the cart is marked `completed` with the order, and the whole
//! thing commits as one transaction, under a lock on the cart row, so two
//! checkouts of one cart place one order.
//!
//! Stock is checked, not reserved (STASH-003): a line is out of stock when it
//! is tracked, backorders are off and fewer than the quantity are on hand.
//!
//! A `mollie` order is placed `pending`; the caller creates its Mollie payment
//! after this transaction commits (`payments::service::create_for_order`),
//! never inside it: no HTTP call runs while a transaction is open.
//!
//! Safe to retry: the order carries `storefront:<cart id>` as its idempotency
//! key, and a retry with the cart's own `Idempotency-Key` header returns the
//! order the first call placed.

use serde_json::{Value, json};
use sqlx::PgConnection;

use crate::carts::{self, Ctx, Refusal};
use crate::money::{self, Cents};
use crate::orders::lines::LineInput;
use crate::orders::write::{self, NewOrder};

/// What a checkout asks for.
#[derive(Debug, Clone, Default)]
pub struct Input {
    /// `mollie` or `invoice`.
    pub payment_method: String,
    /// The total the shopper saw: a different total refuses with
    /// [`Refusal::PriceChanged`].
    pub expected_total: Option<Cents>,
    /// The `Idempotency-Key` header.
    pub idempotency_key: Option<String>,
}

/// The order that was placed.
#[derive(Debug, Clone)]
pub struct Placed {
    pub cart_id: String,
    pub order_id: String,
    pub order_number: String,
    /// A retry: the order existed already, nothing was written.
    pub replayed: bool,
}

fn first_text(address: Option<&Value>, key: &str) -> Option<String> {
    address
        .and_then(|a| a.get(key))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Place the cart's order.
///
/// # Errors
/// The refusals of the contract: guest checkout off, a payment method the
/// channel does not offer or whose provider is not connected, a cart that is
/// not ready, stock, a changed price, a discount code that no longer
/// applies, the VAT refusals.
#[allow(
    clippy::too_many_lines,
    reason = "the checks in the contract's order, then the write"
)]
pub async fn checkout(ctx: &Ctx<'_>, token: &str, input: &Input) -> Result<Placed, Refusal> {
    let channel = ctx.channel;
    if !channel.guest_checkout {
        // Shopper sessions arrive with phase 6.
        return Err(Refusal::GuestCheckoutDisabled);
    }
    let offered = channel.payment_methods.contains(&input.payment_method);
    let allowed = match input.payment_method.as_str() {
        "mollie" => offered,
        "invoice" => offered && channel.audience == "b2b",
        _ => false,
    };
    if !allowed {
        return Err(Refusal::PaymentMethodNotEnabled);
    }
    let mut tx = ctx.db.begin().await?;
    let cart = carts::find(&mut tx, &channel.id, token, true)
        .await?
        .ok_or(Refusal::CartNotFound)?;
    let cart_id = cart["id"].as_str().unwrap_or_default().to_owned();
    let status = cart["status"].as_str().unwrap_or("open");
    if status == "completed" {
        let same_key = input.idempotency_key.is_some()
            && cart["idempotencyKey"].as_str() == input.idempotency_key.as_deref();
        if same_key && let Some(order_id) = cart["orderId"].as_str() {
            let number: Option<String> =
                sqlx::query_scalar("select order_number from orders where id = $1")
                    .bind(order_id)
                    .fetch_optional(&mut *tx)
                    .await?;
            return Ok(Placed {
                cart_id,
                order_id: order_id.to_owned(),
                order_number: number.unwrap_or_default(),
                replayed: true,
            });
        }
        return Err(Refusal::CartNotOpen("completed".to_owned()));
    }
    if !matches!(status, "open" | "checkout") || cart["expired"].as_bool().unwrap_or(false) {
        return Err(Refusal::CartNotOpen(
            if status == "open" { "expired" } else { status }.to_owned(),
        ));
    }

    let items: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', i.id, 'productId', i.product_id, 'variantId', i.variant_id, \
           'sku', i.sku, 'name', i.name, 'quantity', i.quantity) \
         from cart_items i where i.cart_id = $1 order by i.created_at asc, i.id asc",
    )
    .bind(&cart_id)
    .fetch_all(&mut *tx)
    .await?;
    let quote = carts::quote(&mut tx, ctx, &cart, &items).await?;

    let broken: Vec<(String, &'static str)> = quote
        .lines
        .iter()
        .filter(|l| !l.priced())
        .filter_map(|l| l.problem.map(|p| (l.id.clone(), p)))
        .collect();
    if !quote.missing.is_empty() || !broken.is_empty() {
        return Err(Refusal::NotReady {
            missing: quote.missing.clone(),
            lines: broken,
        });
    }
    let short: Vec<(String, i64)> = quote
        .lines
        .iter()
        .filter(|l| l.problem == Some("OUT_OF_STOCK"))
        .map(|l| (l.id.clone(), l.available_stock.unwrap_or(0)))
        .collect();
    if !short.is_empty() {
        return Err(Refusal::OutOfStock(short));
    }
    if cart["discountCode"].as_str().is_some()
        && let Some(problem) = quote.discount_problem
    {
        return Err(Refusal::DiscountNotApplicable(problem));
    }
    if let Some(expected) = input.expected_total
        && expected != quote.total
    {
        return Err(Refusal::PriceChanged(quote.total));
    }

    let shipping = cart.get("shippingAddress").filter(|a| a.is_object());
    let billing = cart
        .get("billingAddress")
        .filter(|a| a.is_object())
        .or(shipping);
    let new = NewOrder {
        source: "storefront".to_owned(),
        channel_id: Some(channel.id.clone()),
        currency: channel.currency.clone(),
        company_id: None,
        person_id: None,
        customer_name: first_text(billing, "name").or_else(|| first_text(shipping, "name")),
        customer_email: cart["email"].as_str().map(str::to_owned),
        customer_phone: first_text(billing, "phone").or_else(|| first_text(shipping, "phone")),
        lines: quote
            .lines
            .iter()
            .map(|line| LineInput {
                id: None,
                product_id: Some(line.product_id.clone()),
                variant_id: line.variant_id.clone(),
                name: None,
                quantity: line.quantity,
                unit_price: Some(line.unit_price),
            })
            .collect(),
        discount_code: cart["discountCode"].as_str().map(str::to_owned),
        shipping: quote.shipping_requested,
        billing_address: billing.cloned(),
        shipping_address: shipping.cloned(),
        customer_reference: cart["customerReference"].as_str().map(str::to_owned),
        customer_note: cart["note"].as_str().map(str::to_owned),
        internal_note: None,
        prices_include_tax: channel.prices_include_tax,
        buyer_vat_number: cart["buyerVatNumber"].as_str().map(str::to_owned),
        status: "pending".to_owned(),
        tags: Vec::new(),
        created_by: "storefront".to_owned(),
        idempotency_key: Some(format!("storefront:{cart_id}")),
    };
    let tax = vat_taxation(ctx);
    let created = write::create(&mut tx, &tax, &new).await?;
    if input.payment_method == "invoice" {
        write::place_on_invoice(&mut tx, &created.id).await?;
    }
    carts::complete_cart(
        &mut tx,
        &cart_id,
        &created.id,
        input.idempotency_key.as_deref(),
        &quote,
    )
    .await?;
    tx.commit().await?;
    Ok(Placed {
        cart_id,
        order_id: created.id,
        order_number: created.order_number,
        replayed: created.replayed,
    })
}

fn vat_taxation<'a>(ctx: &'a Ctx<'a>) -> crate::vat::Taxation<'a> {
    crate::vat::Taxation { http: ctx.http }
}

fn amount(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .and_then(money::parse)
        .map_or_else(|| "0.00".to_owned(), money::format)
}

fn address(value: Option<&Value>) -> Value {
    value
        .filter(|a| a.as_object().is_some_and(|o| !o.is_empty()))
        .cloned()
        .unwrap_or(Value::Null)
}

/// The order as the storefront shows it (`StorefrontOrder`): no internal
/// notes, tags, ids of other records or customer links.
///
/// # Errors
/// A failed statement.
pub async fn order_view(conn: &mut PgConnection, order_id: &str) -> Result<Value, sqlx::Error> {
    let Some(stored) = crate::orders::load(conn, order_id, false).await? else {
        return Ok(Value::Null);
    };
    let order = &stored.order;
    let state = |key: &str, default: &str| {
        order
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or(default)
            .to_owned()
    };
    let items: Vec<Value> = stored
        .items
        .iter()
        .map(|item| {
            json!({
                "id": item["id"],
                "name": item["name"],
                "variantName": item.pointer("/properties/variantName")
                    .and_then(Value::as_str),
                "sku": item.get("sku").and_then(Value::as_str),
                "quantity": item.get("quantity").and_then(Value::as_i64).unwrap_or(0),
                "unitPrice": amount(item.get("unitPrice")),
                "total": amount(item.get("total")),
                "taxRate": item.get("taxRate").and_then(Value::as_str).and_then(money::parse).map(money::format),
            })
        })
        .collect();
    Ok(json!({
        "id": order["id"],
        "orderNumber": order["orderNumber"],
        "status": state("status", "pending"),
        "paymentStatus": state("paymentStatus", "pending"),
        "fulfillmentStatus": state("fulfillmentStatus", "unfulfilled"),
        "currency": order["currency"],
        "pricesIncludeTax": order.get("pricesIncludeTax").and_then(Value::as_bool).unwrap_or(false),
        "items": items,
        "subtotal": amount(order.get("subtotal")),
        "discountTotal": amount(order.get("discountTotal")),
        "shippingTotal": amount(order.get("shippingTotal")),
        "taxTotal": amount(order.get("taxTotal")),
        "total": amount(order.get("total")),
        "vatTreatment": order.get("vatTreatment").and_then(Value::as_str),
        "shippingAddress": address(order.get("shippingAddress")),
        "billingAddress": address(order.get("billingAddress")),
        "placedAt": order.get("createdAt").cloned().unwrap_or(Value::Null),
    }))
}
