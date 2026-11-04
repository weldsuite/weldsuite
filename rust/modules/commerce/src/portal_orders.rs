//! A buyer's order from the B2B portal (`services/commerce-portal-orders.ts`):
//! every line priced from the catalogue (client prices are ignored), the
//! order and its items written together. Stock reservation and tax are
//! not part of it yet.

use http::StatusCode;
use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Issues, Presence, Text};

use crate::js::{math_round, to_fixed};
use crate::portal_public::positive_int;
use crate::tables;

/// `commercePortalPlaceOrderSchema`.
pub(crate) struct PlaceInput {
    items: Vec<Line>,
    customer_note: Option<String>,
    purchase_order_number: Option<String>,
    shipping_address: Option<Value>,
}

struct Line {
    product_id: String,
    variant_id: Option<String>,
    quantity: f64,
}

const ADDRESS_FIELDS: [&str; 8] = [
    "line1",
    "line2",
    "city",
    "state",
    "postalCode",
    "country",
    "name",
    "phone",
];

pub(crate) fn read_order(issues: &mut Issues, fields: &Map<String, Value>) -> PlaceInput {
    let items = issues.list(
        fields,
        "items",
        Presence::Required,
        Some(1),
        Some(200),
        |issues, item| {
            let line = issues.object(item)?;
            let before = issues.count();
            let product_id = issues.text_with(
                line,
                "productId",
                Presence::Required,
                Text::length(Some(1), None),
            );
            let variant_id = issues.text_with(
                line,
                "variantId",
                Presence::Optional,
                Text::length(Some(1), None),
            );
            let quantity = positive_int(issues, line, "quantity", Some(10_000.0));
            if issues.count() > before {
                return None;
            }
            Some(Line {
                product_id: product_id.into_option()?,
                variant_id: variant_id.into_option(),
                quantity: quantity?,
            })
        },
    );
    let customer_note = issues.text_with(
        fields,
        "customerNote",
        Presence::Optional,
        Text::length(None, Some(4000)),
    );
    let po = issues.text_with(
        fields,
        "purchaseOrderNumber",
        Presence::Optional,
        Text::length(None, Some(100)),
    );
    let shipping_address = issues
        .nested(
            fields,
            "shippingAddress",
            Presence::Optional,
            |issues, address| {
                let mut kept = Map::new();
                for key in ADDRESS_FIELDS {
                    issues.text_with(address, key, Presence::Optional, Text::default());
                    if let Some(value) = address.get(key) {
                        kept.insert(key.to_owned(), value.clone());
                    }
                }
                Value::Object(kept)
            },
        )
        .into_option();
    PlaceInput {
        items: items.into_option().unwrap_or_default(),
        customer_note: customer_note.into_option(),
        purchase_order_number: po.into_option(),
        shipping_address,
    }
}

/// `PortalOrderError` (its status and message), or a failure the route
/// answers with its 500.
#[derive(Debug)]
pub(crate) enum PlaceError {
    Refused(StatusCode, String),
    Failed(String),
}

impl From<sqlx::Error> for PlaceError {
    fn from(error: sqlx::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

fn refused(message: &str) -> PlaceError {
    PlaceError::Refused(StatusCode::BAD_REQUEST, message.to_owned())
}

/// Who places the order.
pub(crate) struct Buyer<'a> {
    pub(crate) person_id: &'a str,
    pub(crate) party_id: &'a str,
    /// `person?.email ?? session email`.
    pub(crate) email: Option<String>,
    pub(crate) name: Option<String>,
}

/// `money(n)`: `(Math.round(n * 100) / 100).toFixed(2)`.
fn money(n: f64) -> String {
    to_fixed(math_round(n * 100.0) / 100.0, 2)
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `toOrderAddress(addr)`: the order's address shape of an address in
/// either shape; none for nothing. `'line1' in addr` on a string or a
/// number throws, which the route answers with its 500.
fn to_order_address(addr: Option<&Value>) -> Result<Option<Value>, PlaceError> {
    let Some(addr) = addr.filter(|a| truthy(a)) else {
        return Ok(None);
    };
    let fields = match addr {
        Value::Object(map) => map.clone(),
        Value::Array(_) => Map::new(),
        _ => {
            return Err(PlaceError::Failed(
                "Cannot use 'in' operator to search for 'line1'".to_owned(),
            ));
        }
    };
    let mut out = Map::new();
    // `line1 || street`
    let line1 = fields
        .get("line1")
        .filter(|v| truthy(v))
        .or_else(|| fields.get("street"));
    if let Some(line1) = line1 {
        out.insert("line1".to_owned(), line1.clone());
    }
    for key in [
        "line2",
        "city",
        "state",
        "postalCode",
        "country",
        "name",
        "phone",
    ] {
        if let Some(value) = fields.get(key) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    Ok(Some(Value::Object(out)))
}

/// A line priced from the catalogue (`PricedOrderLine`).
struct Priced {
    product_id: String,
    variant_id: Option<String>,
    sku: Option<String>,
    name: String,
    image_url: Value,
    quantity: f64,
    unit_price: String,
    total: String,
    requires_shipping: i32,
    total_num: f64,
    currency: Option<String>,
}

type ProductRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<Value>,
    Option<bool>,
    Option<String>,
);

/// `priceOrderLine(db, line)`.
async fn price_line(db: &PgPool, line: &Line) -> Result<Priced, PlaceError> {
    let product: Option<ProductRow> = sqlx::query_as(
        "select id, status, visibility, price::text, sku, name, featured_image_url, images, requires_shipping, currency \
         from products where id = $1 and deleted_at is null limit 1",
    )
    .bind(&line.product_id)
    .fetch_optional(db)
    .await?;
    let Some((
        id,
        status,
        visibility,
        price,
        sku,
        name,
        featured,
        images,
        requires_shipping,
        currency,
    )) = product
    else {
        return Err(refused("One or more products are unavailable"));
    };
    if status != "active"
        || visibility
            .as_deref()
            .is_some_and(|v| !v.is_empty() && v != "visible")
    {
        return Err(refused("One or more products are unavailable"));
    }
    let mut unit_price = price
        .as_deref()
        .map_or(0.0, weldsuite_kit::validation::js_number);
    let mut sku = sku;
    let mut name = name;
    let mut image_url = match featured {
        Some(url) => Value::String(url),
        None => images
            .as_ref()
            .and_then(|i| i.get(0))
            .and_then(|first| first.get("url"))
            .cloned()
            .unwrap_or(Value::Null),
    };
    let mut ships = i32::from(requires_shipping != Some(false));

    if let Some(variant_id) = &line.variant_id {
        #[allow(clippy::type_complexity)] // the variant's columns
        let variant: Option<(String, Option<String>, Option<String>, String, Option<String>, Option<bool>)> =
            sqlx::query_as(
                "select status, price::text, sku, name, image_url, requires_shipping from product_variants \
                 where id = $1 and product_id = $2 and deleted_at is null limit 1",
            )
            .bind(variant_id)
            .bind(&id)
            .fetch_optional(db)
            .await?;
        let Some((v_status, v_price, v_sku, v_name, v_image, v_ships)) = variant else {
            return Err(refused("One or more products are unavailable"));
        };
        if v_status != "active" {
            return Err(refused("One or more products are unavailable"));
        }
        if let Some(v_price) = v_price {
            unit_price = weldsuite_kit::validation::js_number(&v_price);
        }
        sku = v_sku.or(sku);
        if !v_name.is_empty() {
            name = v_name;
        }
        if let Some(v_image) = v_image {
            image_url = Value::String(v_image);
        }
        if v_ships == Some(false) {
            ships = 0;
        }
    }
    if !unit_price.is_finite() || unit_price < 0.0 {
        return Err(refused("One or more products have no price"));
    }
    let total_num = unit_price * line.quantity;
    Ok(Priced {
        product_id: id,
        variant_id: line.variant_id.clone(),
        sku,
        name,
        image_url,
        quantity: line.quantity,
        unit_price: money(unit_price),
        total: money(total_num),
        requires_shipping: ships,
        total_num,
        currency,
    })
}

/// `ORD-<Date.now() base 36>-<4 random base-36 characters>`.
fn order_number() -> String {
    crate::orders::numbered("ORD")
}

type PartyRow = (
    Option<String>,
    Option<String>,
    Option<bool>,
    Option<Value>,
    Option<Value>,
);

/// `placePortalOrder(db, params)`: the order row and its items, as Drizzle
/// returns them.
#[allow(clippy::too_many_lines)] // the TypeScript function, step by step
pub(crate) async fn place(
    db: &PgPool,
    buyer: &Buyer<'_>,
    input: &PlaceInput,
) -> Result<(Map<String, Value>, Vec<Value>), PlaceError> {
    if input.items.is_empty() {
        return Err(refused("At least one line item is required"));
    }
    let party: Option<PartyRow> = sqlx::query_as(
        "select currency, display_name, tax_exempt, shipping_address, billing_address from parties \
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(buyer.party_id)
    .fetch_optional(db)
    .await?;
    let Some((party_currency, party_name, tax_exempt, party_shipping, party_billing)) = party
    else {
        return Err(refused("Company has no commercial party record"));
    };

    let mut lines = Vec::with_capacity(input.items.len());
    let mut subtotal_num = 0.0;
    let mut currency = party_currency
        .clone()
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "EUR".to_owned());
    for line in &input.items {
        let priced = price_line(db, line).await?;
        if party_currency.as_deref().is_none_or(str::is_empty)
            && let Some(product_currency) = priced.currency.clone()
        {
            currency = product_currency;
        }
        subtotal_num += priced.total_num;
        lines.push(priced);
    }

    let now = crate::now();
    let order_id = generate_id("ord");
    let number = order_number();
    let subtotal = money(subtotal_num);
    let shipping = match to_order_address(input.shipping_address.as_ref())? {
        Some(address) => Some(address),
        None => match to_order_address(party_shipping.as_ref())? {
            Some(address) => Some(address),
            None => to_order_address(party_billing.as_ref())?,
        },
    };
    let billing = to_order_address(party_billing.as_ref())?.or_else(|| shipping.clone());
    #[allow(clippy::cast_possible_truncation)] // whole quantities of at most 10 000
    let total_quantity: i64 = lines.iter().map(|l| l.quantity as i64).sum();

    let mut tx = db.begin().await?;
    sqlx::query(
        "insert into orders (id, created_at, updated_at, order_number, customer_email, customer_name, counterparty_id, \
         person_id, status, payment_status, fulfillment_status, currency, subtotal, discount_total, shipping_total, \
         tax_total, total, tax_exempt, billing_address, shipping_address, payment_method, payment_reference, \
         customer_note, item_count, total_quantity, source) \
         values ($1, $2::timestamp, $2::timestamp, $3, $4, $5, $6, $7, 'pending', 'pending', 'unfulfilled', $8, \
         $9::numeric, 0, 0, 0, $9::numeric, $10, $11, $12, 'account', $13, $14, $15, $16, 'b2b_portal')",
    )
    .bind(&order_id)
    .bind(&now)
    .bind(&number)
    .bind(buyer.email.as_deref())
    .bind(buyer.name.clone().or(party_name))
    .bind(buyer.party_id)
    .bind(buyer.person_id)
    .bind(&currency)
    .bind(&subtotal)
    .bind(i32::from(tax_exempt == Some(true)))
    .bind(billing)
    .bind(shipping)
    .bind(input.purchase_order_number.as_deref().filter(|p| !p.is_empty()))
    .bind(input.customer_note.as_deref())
    .bind(i32::try_from(lines.len()).unwrap_or(i32::MAX))
    .bind(total_quantity)
    .execute(&mut *tx)
    .await?;
    for line in &lines {
        let image = match &line.image_url {
            Value::Null => None,
            Value::String(url) => Some(url.clone()),
            other => Some(other.to_string()),
        };
        sqlx::query(
            "insert into order_items (id, order_id, created_at, product_id, variant_id, sku, name, image_url, quantity, \
             unit_price, discount_amount, tax_amount, total, requires_shipping) \
             values ($1, $2, $3::timestamp, $4, $5, $6, $7, $8, $9, $10::numeric, 0, 0, $11::numeric, $12)",
        )
        .bind(generate_id("oi"))
        .bind(&order_id)
        .bind(&now)
        .bind(&line.product_id)
        .bind(line.variant_id.as_deref())
        .bind(line.sku.as_deref())
        .bind(&line.name)
        .bind(image)
        .bind({
            #[allow(clippy::cast_possible_truncation)]
            let quantity = line.quantity as i64;
            quantity
        })
        .bind(&line.unit_price)
        .bind(&line.total)
        .bind(line.requires_shipping)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    let order: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(orders),
        " from orders t where t.id = $1 limit 1"
    ))
    .bind(&order_id)
    .fetch_optional(db)
    .await?;
    let Some(Value::Object(order)) = order.map(|o| tables::ORDERS.js(o)) else {
        return Err(PlaceError::Failed("the order was not stored".to_owned()));
    };
    let items: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(order_items),
        " from order_items t where t.order_id = $1"
    ))
    .bind(&order_id)
    .fetch_all(db)
    .await?;
    Ok((
        order,
        items
            .into_iter()
            .map(|r| tables::ORDER_ITEMS.js(r))
            .collect(),
    ))
}
