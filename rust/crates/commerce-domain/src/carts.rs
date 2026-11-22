//! Storefront carts (ADR COM-011): what a shopper has picked, priced from the
//! catalogue in the channel's currency, with the discount code, shipping rate
//! and EU VAT of the destination, recomputed on every read and write.
//!
//! A cart belongs to one channel and is reached by an opaque token (`wct_…`)
//! handed out once; only its SHA-256 is stored. Prices, availability, the
//! code's effect, shipping and VAT are never trusted from the stored
//! snapshot: [`quote`] works them out again from the catalogue, through
//! [`crate::prices`], [`crate::orders::plan`] and [`crate::vat`], the same
//! code that prices an order, so a cart and the order it becomes agree.
//!
//! Money is a decimal string with two decimals in the JSON, cents inside.
//! A cart line's `total` is `quantity * unitPrice`, in the channel's price
//! mode (gross for a B2C channel, net for B2B), before the cart's discount.
//! Until the cart has a destination country no VAT is calculated: `taxTotal`
//! is zero and `vatTreatment` null (a gross price is then the total; a net
//! price has VAT added once the destination is known).
//!
//! The statements are the SeaORM entities' (ADR DATA-019), on the caller's
//! connection or transaction through [`db::on`].

use std::collections::HashMap;

use sea_orm::ActiveValue::Set;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, JoinType, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};
use time::Duration;
use weldsuite_kit::{generate_id, id::ALPHANUMERIC, id::random_string};
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::tenant::{
    cart_items, carts, commerce_channels, commerce_shipping_rates, product_variants, products,
};

use crate::db;
use crate::discount::Problem;
use crate::error::Error;
use crate::money::{self, Cents};
use crate::orders::lines::Line;
use crate::orders::plan::{self, Input};
use crate::prices::{self, Target};
use crate::vat::{self, Buyer, Taxation};

/// A cart expires this long after its last change.
const EXPIRY: Duration = Duration::days(30);
/// Lines in one cart.
pub const MAX_LINES: i64 = 100;
/// Quantity of one line.
pub const MAX_QUANTITY: i64 = 100_000;

/// Why a storefront cart or checkout call was refused. The module maps each
/// to its `{ error: { code, message, details? } }` response.
#[derive(Debug)]
pub enum Refusal {
    /// A failed statement (ORM or SQL).
    Database(DbErr),
    /// 404 `CART_NOT_FOUND`.
    CartNotFound,
    /// 409 `CART_NOT_OPEN`: completed, expired or abandoned.
    CartNotOpen(String),
    /// 400 `VALIDATION_ERROR`: path and message.
    Validation(Vec<(String, String)>),
    /// 409 `NOT_SELLABLE`.
    NotSellable(String),
    /// 409 `COUNTRY_NOT_SOLD`.
    CountryNotSold(String),
    /// 409 `RATE_NOT_AVAILABLE`.
    RateNotAvailable,
    /// 409 `DISCOUNT_NOT_APPLICABLE`.
    DiscountNotApplicable(Problem),
    /// 409 `CART_TOO_LARGE`.
    TooLarge,
    /// The order rules' refusals: VAT, seller, a bad destination.
    Domain(Error),
    /// 409 `CART_NOT_READY`: what is missing and the lines with a problem
    /// (`{ id, problem }`).
    NotReady {
        missing: Vec<&'static str>,
        lines: Vec<(String, &'static str)>,
    },
    /// 409 `OUT_OF_STOCK`: the lines (`{ id, available }`).
    OutOfStock(Vec<(String, i64)>),
    /// 409 `PRICE_CHANGED` with the cart's current total.
    PriceChanged(Cents),
    /// 409 `PAYMENT_METHOD_NOT_ENABLED`.
    PaymentMethodNotEnabled,
    /// 409 `GUEST_CHECKOUT_DISABLED`.
    GuestCheckoutDisabled,
    /// 409 `PAYMENT_PROVIDER_NOT_CONNECTED`.
    PaymentProviderNotConnected,
    /// 409 `IDEMPOTENCY_KEY_REUSED`: the key belongs to another cart.
    IdempotencyKeyReused,
}

impl From<DbErr> for Refusal {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

impl From<sqlx::Error> for Refusal {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(crate::db::from_sqlx(error))
    }
}

impl From<Error> for Refusal {
    fn from(error: Error) -> Self {
        match error {
            Error::Database(error) => Self::Database(error),
            Error::Discount(problem) => Self::DiscountNotApplicable(problem),
            other => Self::Domain(other),
        }
    }
}

fn invalid(path: &str, message: &str) -> Refusal {
    Refusal::Validation(vec![(path.to_owned(), message.to_owned())])
}

/// A sales channel as the storefront needs it.
#[derive(Debug, Clone)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub audience: String,
    pub status: String,
    pub currency: String,
    pub prices_include_tax: bool,
    pub selling_countries: Vec<String>,
    pub guest_checkout: bool,
    pub payment_methods: Vec<String>,
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `value`, or `fallback` when it is empty.
fn or_default(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_owned()
    } else {
        value
    }
}

/// The live channel `id`, whatever its status.
///
/// # Errors
/// A failed statement.
pub async fn load_channel(conn: &mut PgConnection, id: &str) -> Result<Option<Channel>, DbErr> {
    let row = commerce_channels::Entity::find_by_id(id)
        .filter(commerce_channels::Column::DeletedAt.is_null())
        .one(&db::on(conn))
        .await?;
    Ok(row.map(|row| Channel {
        audience: or_default(row.audience, "b2c"),
        currency: or_default(row.currency, "EUR").to_ascii_uppercase(),
        prices_include_tax: row.prices_include_tax,
        selling_countries: strings(Some(&row.selling_countries))
            .into_iter()
            .map(|c| c.to_ascii_uppercase())
            .collect(),
        guest_checkout: row.guest_checkout,
        payment_methods: strings(Some(&row.payment_methods)),
        id: row.id,
        name: row.name,
        status: row.status,
    }))
}

/// What a cart call needs besides the cart.
#[derive(Clone, Copy)]
pub struct Ctx<'a> {
    pub db: &'a PgPool,
    pub http: Option<&'a OutboundHttp>,
    pub channel: &'a Channel,
}

impl Ctx<'_> {
    fn taxation(&self) -> Taxation<'_> {
        Taxation { http: self.http }
    }
}

/// SHA-256 (hex) of a cart token.
#[must_use]
pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn new_token() -> String {
    format!("wct_{}", random_string(40, ALPHANUMERIC))
}

// ── reading a cart ──────────────────────────────────────────────────────────

/// The fields of a cart row the code below reads, as the entity serialises
/// them (timestamps as `toISOString()`).
const CART_FIELDS: [&str; 15] = [
    "id",
    "status",
    "email",
    "billingAddress",
    "shippingAddress",
    "shippingRateId",
    "discountCode",
    "buyerVatNumber",
    "customerReference",
    "note",
    "orderId",
    "idempotencyKey",
    "expiresAt",
    "createdAt",
    "updatedAt",
];

/// A cart row as JSON: [`CART_FIELDS`] and whether it has `expired`.
fn cart_json(cart: &carts::Model) -> Value {
    let row = serde_json::to_value(cart).unwrap_or_default();
    let mut out: Map<String, Value> = CART_FIELDS
        .iter()
        .map(|key| {
            (
                (*key).to_owned(),
                row.get(*key).cloned().unwrap_or(Value::Null),
            )
        })
        .collect();
    let expired = cart.expires_at.is_some_and(|at| at < db::now());
    out.insert("expired".to_owned(), Value::Bool(expired));
    Value::Object(out)
}

/// The cart of `token` on the channel, as a JSON row; `lock` holds it until
/// the transaction ends.
///
/// # Errors
/// A failed statement.
pub async fn find(
    conn: &mut PgConnection,
    channel_id: &str,
    token: &str,
    lock: bool,
) -> Result<Option<Value>, DbErr> {
    let mut query = carts::Entity::find()
        .filter(carts::Column::TokenHash.eq(token_hash(token)))
        .filter(carts::Column::ChannelId.eq(channel_id));
    if lock {
        query = query.lock_exclusive();
    }
    let cart = query.one(&db::on(conn)).await?;
    Ok(cart.as_ref().map(cart_json))
}

/// The cart `id` on the channel, as [`find`] gives it; an error when it is
/// gone.
async fn find_by_id(conn: &mut PgConnection, channel_id: &str, id: &str) -> Result<Value, DbErr> {
    let cart = carts::Entity::find_by_id(id)
        .filter(carts::Column::ChannelId.eq(channel_id))
        .require_one(&db::on(conn))
        .await?;
    Ok(cart_json(&cart))
}

async fn items_of(conn: &mut PgConnection, cart_id: &str) -> Result<Vec<Value>, DbErr> {
    let items = cart_items::Entity::find()
        .filter(cart_items::Column::CartId.eq(cart_id))
        .order_by_asc(cart_items::Column::CreatedAt)
        .order_by_asc(cart_items::Column::Id)
        .all(&db::on(conn))
        .await?;
    Ok(items
        .into_iter()
        .map(|item| {
            json!({
                "id": item.id,
                "productId": item.product_id,
                "variantId": item.variant_id,
                "sku": item.sku,
                "name": item.name,
                "quantity": item.quantity,
            })
        })
        .collect())
}

/// A cart that can still change: open (or in checkout) and not expired.
fn ensure_open(cart: &Value) -> Result<(), Refusal> {
    let status = cart.get("status").and_then(Value::as_str).unwrap_or("open");
    let expired = cart
        .get("expired")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if matches!(status, "open" | "checkout") && !expired {
        Ok(())
    } else {
        Err(Refusal::CartNotOpen(
            if expired && matches!(status, "open" | "checkout") {
                "expired"
            } else {
                status
            }
            .to_owned(),
        ))
    }
}

// ── pricing a cart ──────────────────────────────────────────────────────────

/// A cart line settled against the catalogue.
#[derive(Debug, Clone)]
pub struct QLine {
    pub id: String,
    pub product_id: String,
    pub variant_id: Option<String>,
    pub sku: Option<String>,
    pub name: String,
    pub variant_name: Option<String>,
    pub image_url: Option<String>,
    pub quantity: i64,
    pub unit_price: Cents,
    pub vat_category: String,
    pub requires_shipping: bool,
    /// Stock that can be sold (`None`: not tracked or backorder allowed).
    pub available_stock: Option<i64>,
    /// `INACTIVE`, `NO_PRICE` or `OUT_OF_STOCK`.
    pub problem: Option<&'static str>,
}

impl QLine {
    /// Priced and sellable (a stock shortfall does not unprice a line).
    #[must_use]
    pub fn priced(&self) -> bool {
        !matches!(self.problem, Some("INACTIVE" | "NO_PRICE"))
    }
}

/// What a quote persists on the cart row.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub subtotal: Cents,
    pub discount_total: Cents,
    pub shipping_total: Cents,
    pub tax_total: Cents,
    pub total: Cents,
    pub vat_treatment: Option<String>,
    pub vat_quote: Value,
    pub discount_id: Option<String>,
    pub destination: Option<String>,
    pub shipping_rate_id: Option<String>,
}

/// A cart worked out.
#[derive(Debug, Clone)]
pub struct Quote {
    /// The `Cart` of the API.
    pub json: Value,
    pub cart_id: String,
    pub lines: Vec<QLine>,
    pub total: Cents,
    pub ready: bool,
    pub missing: Vec<&'static str>,
    pub discount_problem: Option<Problem>,
    pub shipping_requested: Cents,
    pub needs_shipping: bool,
    pub snapshot: Snapshot,
}

fn stock_of(row: &Value) -> Option<i64> {
    let tracked = row.get("track").and_then(Value::as_bool).unwrap_or(true);
    let backorder = row
        .get("backorder")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !tracked || backorder {
        return None;
    }
    Some(row.get("qty").and_then(Value::as_i64).unwrap_or(0).max(0))
}

/// The address's country, upper-cased.
fn country(address: Option<&Value>) -> Option<String> {
    vat::country_of(address.filter(|a| !a.is_null()))
}

/// An address a parcel can be sent to.
fn complete(address: Option<&Value>) -> bool {
    let Some(address) = address.filter(|a| a.is_object()) else {
        return false;
    };
    ["country", "line1", "city", "postalCode"]
        .iter()
        .all(|key| text(address, key).is_some())
}

fn present_address(address: Option<&Value>) -> Value {
    address
        .filter(|a| a.as_object().is_some_and(|o| !o.is_empty()))
        .cloned()
        .unwrap_or(Value::Null)
}

/// A shipping rate row.
#[derive(Debug, Clone)]
struct Rate {
    id: String,
    name: String,
    price: Cents,
    threshold: Option<Cents>,
    countries: Vec<String>,
}

impl Rate {
    fn covers(&self, country: &str) -> bool {
        self.countries
            .iter()
            .any(|c| c.eq_ignore_ascii_case(country))
    }

    fn free(&self, subtotal: Cents) -> bool {
        self.threshold.is_some_and(|t| subtotal >= t)
    }

    fn charged(&self, subtotal: Cents) -> Cents {
        if self.free(subtotal) { 0 } else { self.price }
    }
}

/// A `numeric` amount as `money::parse` reads Postgres's text of it: none
/// below zero.
fn amount(value: &BigDecimal) -> Option<Cents> {
    Some(db::cents(value)).filter(|cents| *cents >= 0)
}

/// `lower(column) = lower($value)`.
fn lower_eq(column: impl ColumnTrait, value: &str) -> Expr {
    // The trait by path: in scope it would shadow `Ord::min` and `max`.
    sea_orm::sea_query::ExprTrait::eq(Func::lower(column.into_expr()), Func::lower(value))
}

/// `upper(column) = upper($value)`.
fn upper_eq(column: impl ColumnTrait, value: &str) -> Expr {
    sea_orm::sea_query::ExprTrait::eq(Func::upper(column.into_expr()), Func::upper(value))
}

async fn rates(conn: &mut PgConnection, channel: &Channel) -> Result<Vec<Rate>, DbErr> {
    let rows = commerce_shipping_rates::Entity::find()
        .filter(commerce_shipping_rates::Column::ChannelId.eq(channel.id.as_str()))
        .filter(commerce_shipping_rates::Column::DeletedAt.is_null())
        .filter(commerce_shipping_rates::Column::Active.eq(true))
        .filter(upper_eq(
            commerce_shipping_rates::Column::Currency,
            &channel.currency,
        ))
        .order_by_asc(commerce_shipping_rates::Column::Position)
        .order_by_asc(commerce_shipping_rates::Column::Id)
        .all(&db::on(conn))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            Some(Rate {
                price: amount(&row.price)?,
                threshold: row.free_shipping_threshold.as_ref().and_then(amount),
                countries: strings(Some(&row.countries))
                    .into_iter()
                    .map(|c| c.to_ascii_uppercase())
                    .collect(),
                id: Some(row.id).filter(|id| !id.is_empty())?,
                name: row.name,
            })
        })
        .collect())
}

/// `id, name, sku, status, visibility, featured_image_url, vat_category,
/// track_inventory, inventory_quantity, allow_backorder, requires_shipping`.
type ProductRow = (
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<bool>,
    Option<i32>,
    Option<bool>,
    Option<bool>,
);

/// `id, product_id, name, sku, status, image_url, vat_category,
/// track_inventory, inventory_quantity, allow_backorder, requires_shipping`.
type VariantRow = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
    Option<bool>,
    Option<i32>,
    Option<bool>,
    Option<bool>,
);

/// The live products of `ids` as the JSON rows [`settle`] reads.
async fn product_rows(conn: &mut PgConnection, ids: &[String]) -> Result<Vec<Value>, DbErr> {
    let rows: Vec<ProductRow> = products::Entity::find()
        .select_only()
        .columns([
            products::Column::Id,
            products::Column::Name,
            products::Column::Sku,
            products::Column::Status,
            products::Column::Visibility,
            products::Column::FeaturedImageUrl,
            products::Column::VatCategory,
            products::Column::TrackInventory,
            products::Column::InventoryQuantity,
            products::Column::AllowBackorder,
            products::Column::RequiresShipping,
        ])
        .filter(products::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(products::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db::on(conn))
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, name, sku, status, visibility, image, vat, track, qty, backorder, shipping)| {
                json!({
                    "id": id, "name": name, "sku": sku, "status": status,
                    "visibility": visibility, "imageUrl": image, "vatCategory": vat,
                    "track": track, "qty": qty, "backorder": backorder,
                    "requiresShipping": shipping,
                })
            },
        )
        .collect())
}

/// The live variants of `ids` as the JSON rows [`settle`] reads.
async fn variant_rows(conn: &mut PgConnection, ids: &[String]) -> Result<Vec<Value>, DbErr> {
    let rows: Vec<VariantRow> = product_variants::Entity::find()
        .select_only()
        .columns([
            product_variants::Column::Id,
            product_variants::Column::ProductId,
            product_variants::Column::Name,
            product_variants::Column::Sku,
            product_variants::Column::Status,
            product_variants::Column::ImageUrl,
            product_variants::Column::VatCategory,
            product_variants::Column::TrackInventory,
            product_variants::Column::InventoryQuantity,
            product_variants::Column::AllowBackorder,
            product_variants::Column::RequiresShipping,
        ])
        .filter(product_variants::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(product_variants::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db::on(conn))
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, product, name, sku, status, image, vat, track, qty, backorder, shipping)| {
                json!({
                    "id": id, "productId": product, "name": name, "sku": sku,
                    "status": status, "imageUrl": image, "vatCategory": vat,
                    "track": track, "qty": qty, "backorder": backorder,
                    "requiresShipping": shipping,
                })
            },
        )
        .collect())
}

fn by_id(rows: &[Value]) -> HashMap<String, &Value> {
    rows.iter()
        .filter_map(|row| Some((text(row, "id")?, row)))
        .collect()
}

/// Settle the cart's items against the catalogue.
async fn settle(
    conn: &mut PgConnection,
    channel: &Channel,
    items: &[Value],
) -> Result<Vec<QLine>, Refusal> {
    let product_ids: Vec<String> = items.iter().filter_map(|i| text(i, "productId")).collect();
    let variant_ids: Vec<String> = items.iter().filter_map(|i| text(i, "variantId")).collect();
    let products = product_rows(conn, &product_ids).await?;
    let variants = if variant_ids.is_empty() {
        Vec::new()
    } else {
        variant_rows(conn, &variant_ids).await?
    };
    let (products, variants) = (by_id(&products), by_id(&variants));
    let targets: Vec<Target> = items
        .iter()
        .filter_map(|i| {
            Some(Target {
                product_id: text(i, "productId")?,
                variant_id: text(i, "variantId"),
            })
        })
        .collect();
    let priced = prices::resolve_many(conn, &targets, &channel.currency).await?;
    Ok(items
        .iter()
        .map(|item| {
            let product_id = text(item, "productId").unwrap_or_default();
            let variant_id = text(item, "variantId");
            let quantity = item.get("quantity").and_then(Value::as_i64).unwrap_or(1);
            let product = products.get(&product_id).copied();
            let variant = variant_id.as_ref().and_then(|id| variants.get(id)).copied();
            let live = product.is_some_and(|p| {
                text(p, "status").as_deref() == Some("active")
                    && text(p, "visibility").as_deref() != Some("hidden")
            }) && variant_id.as_ref().is_none_or(|_| {
                variant.is_some_and(|v| {
                    text(v, "status").as_deref() == Some("active")
                        && text(v, "productId").as_deref() == Some(product_id.as_str())
                })
            });
            let price = if live {
                priced.get(&Target {
                    product_id: product_id.clone(),
                    variant_id: variant_id.clone(),
                })
            } else {
                None
            };
            let stock = if variant_id.is_some() {
                variant.and_then(stock_of)
            } else {
                product.and_then(stock_of)
            };
            let problem = if !live {
                Some("INACTIVE")
            } else if price.is_none() {
                Some("NO_PRICE")
            } else if stock.is_some_and(|s| s < quantity) {
                Some("OUT_OF_STOCK")
            } else {
                None
            };
            let vat_category = variant
                .and_then(|v| text(v, "vatCategory"))
                .or_else(|| product.and_then(|p| text(p, "vatCategory")))
                .unwrap_or_else(|| "standard".to_owned());
            QLine {
                id: text(item, "id").unwrap_or_default(),
                product_id,
                variant_id,
                sku: variant
                    .and_then(|v| text(v, "sku"))
                    .or_else(|| product.and_then(|p| text(p, "sku")))
                    .or_else(|| text(item, "sku")),
                name: product
                    .and_then(|p| text(p, "name"))
                    .or_else(|| text(item, "name"))
                    .unwrap_or_default(),
                variant_name: variant.and_then(|v| text(v, "name")),
                image_url: variant
                    .and_then(|v| text(v, "imageUrl"))
                    .or_else(|| product.and_then(|p| text(p, "imageUrl"))),
                quantity,
                unit_price: price.map_or(0, |p| p.price),
                vat_category,
                requires_shipping: variant
                    .and_then(|v| v.get("requiresShipping").and_then(Value::as_bool))
                    .or_else(|| {
                        product.and_then(|p| p.get("requiresShipping").and_then(Value::as_bool))
                    })
                    .unwrap_or(true),
                available_stock: stock,
                problem,
            }
        })
        .collect())
}

fn order_line(line: &QLine) -> Line {
    Line {
        id: None,
        product_id: Some(line.product_id.clone()),
        variant_id: line.variant_id.clone(),
        sku: line.sku.clone(),
        name: line.name.clone(),
        variant_name: line.variant_name.clone(),
        image_url: line.image_url.clone(),
        quantity: line.quantity,
        unit_price: line.unit_price,
        vat_category: line.vat_category.clone(),
        problem: None,
    }
}

fn percent(bps: u32) -> String {
    vat::rate_percent(bps)
}

/// Work the cart out from the catalogue, the code, the rate and the VAT.
///
/// # Errors
/// A failed statement, and the VAT refusals ([`Error::SellerEntityRequired`],
/// [`Error::TaxEngineUnavailable`], …).
#[allow(
    clippy::too_many_lines,
    reason = "one pass from lines to the Cart JSON"
)]
pub async fn quote(
    conn: &mut PgConnection,
    ctx: &Ctx<'_>,
    cart: &Value,
    items: &[Value],
) -> Result<Quote, Refusal> {
    let channel = ctx.channel;
    let cart_id = text(cart, "id").unwrap_or_default();
    let lines = settle(conn, channel, items).await?;
    let sellable: Vec<usize> = (0..lines.len()).filter(|i| lines[*i].priced()).collect();
    let order_lines: Vec<Line> = sellable.iter().map(|i| order_line(&lines[*i])).collect();
    let subtotal: Cents = order_lines
        .iter()
        .map(|l| Cents::from(l.quantity) * l.unit_price)
        .sum();

    let shipping_address = cart.get("shippingAddress").filter(|a| a.is_object());
    let billing_address = cart.get("billingAddress").filter(|a| a.is_object());
    let needs_shipping =
        sellable.is_empty() || sellable.iter().any(|i| lines[*i].requires_shipping);
    let ship_country = country(shipping_address);
    let destination = ship_country.clone().or_else(|| country(billing_address));

    // The chosen rate, while it still serves the destination.
    let mut rate: Option<Rate> = None;
    if needs_shipping
        && let (Some(id), Some(dest)) = (text(cart, "shippingRateId"), ship_country.as_deref())
    {
        rate = rates(conn, channel)
            .await?
            .into_iter()
            .find(|r| r.id == id && r.covers(dest));
    }
    let shipping_requested = rate.as_ref().map_or(0, |r| r.charged(subtotal));

    let code = text(cart, "discountCode");
    let email = text(cart, "email");
    let input = Input {
        currency: &channel.currency,
        lines: &order_lines,
        discount_code: code.as_deref(),
        keep_discount_id: None,
        shipping: shipping_requested,
        person_id: None,
        counterparty_id: None,
        email: email.as_deref(),
        order_id: None,
        lock: false,
    };
    let vat_number = text(cart, "buyerVatNumber");
    let billing_country = country(billing_address);
    let planned = if let Some(dest) = destination.as_deref() {
        let tax = ctx.taxation();
        plan::price(
            conn,
            &tax,
            &input,
            &Buyer {
                prices_include_tax: channel.prices_include_tax,
                shipping_country: Some(dest),
                billing_country: billing_country.as_deref(),
                vat_number: vat_number.as_deref(),
            },
        )
        .await?
    } else {
        plan::plan(conn, &input).await?
    };
    let vat = planned.vat.as_ref();

    let json_lines: Vec<Value> = lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let at = sellable.iter().position(|i| *i == index);
            let tax_rate = at
                .and_then(|j| vat.and_then(|v| v.lines.get(j)))
                .map(|l| percent(l.rate_bps));
            json!({
                "id": line.id,
                "productId": line.product_id,
                "variantId": line.variant_id,
                "sku": line.sku,
                "name": line.name,
                "variantName": line.variant_name,
                "imageUrl": line.image_url,
                "quantity": line.quantity,
                "unitPrice": money::format(line.unit_price),
                "total": money::format(Cents::from(line.quantity) * line.unit_price),
                "taxRate": tax_rate,
                "available": line.problem.is_none(),
                "problem": line.problem,
            })
        })
        .collect();

    let effective_billing = billing_address.or(shipping_address);
    let mut missing: Vec<&'static str> = Vec::new();
    if sellable.is_empty() {
        missing.push("items");
    }
    if text(cart, "email").is_none() {
        missing.push("email");
    }
    if needs_shipping && !complete(shipping_address) {
        missing.push("shippingAddress");
    }
    if needs_shipping && rate.is_none() {
        missing.push("shippingRate");
    }
    if !complete(effective_billing) {
        missing.push("billingAddress");
    }
    let ready = missing.is_empty() && lines.iter().all(|l| l.problem.is_none());

    let totals = planned.totals;
    let tax_lines: Vec<Value> = vat
        .map(|v| {
            v.tax_lines
                .iter()
                .map(|t| {
                    json!({
                        "rate": percent(t.rate_bps),
                        "base": money::format(t.base),
                        "amount": money::format(t.amount),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let status = {
        let status = text(cart, "status").unwrap_or_else(|| "open".to_owned());
        if cart
            .get("expired")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && matches!(status.as_str(), "open" | "checkout")
        {
            "expired".to_owned()
        } else {
            status
        }
    };
    let item_count: i64 = lines.iter().map(|l| l.quantity).sum();
    let discount_json = planned
        .discount
        .as_ref()
        .map(|d| json!({ "code": d.code, "type": d.kind, "value": d.value }));
    let json = json!({
        "id": cart_id,
        "status": status,
        "currency": channel.currency,
        "pricesIncludeTax": channel.prices_include_tax,
        "email": cart.get("email").cloned().unwrap_or(Value::Null),
        "items": json_lines,
        "itemCount": item_count,
        "subtotal": money::format(totals.subtotal),
        "discountTotal": money::format(totals.discount_total),
        "shippingTotal": money::format(totals.shipping_total),
        "taxTotal": money::format(totals.tax_total),
        "total": money::format(totals.total),
        "taxLines": tax_lines,
        "vatTreatment": vat.map(|v| v.treatment),
        "viesUnavailable": vat.is_some_and(|v| v.vies_unavailable),
        "discount": discount_json,
        "discountProblem": planned.discount_problem.map(Problem::as_str),
        "shippingAddress": present_address(shipping_address),
        "billingAddress": present_address(billing_address),
        "shippingRate": rate.as_ref().map(|r| json!({
            "id": r.id, "name": r.name, "price": money::format(r.charged(subtotal)),
        })),
        "buyerVatNumber": cart.get("buyerVatNumber").cloned().unwrap_or(Value::Null),
        "customerReference": cart.get("customerReference").cloned().unwrap_or(Value::Null),
        "note": cart.get("note").cloned().unwrap_or(Value::Null),
        "ready": ready,
        "missing": missing,
        "orderId": cart.get("orderId").cloned().unwrap_or(Value::Null),
        "expiresAt": cart.get("expiresAt").cloned().unwrap_or(Value::Null),
        "createdAt": cart.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": cart.get("updatedAt").cloned().unwrap_or(Value::Null),
    });
    let snapshot = Snapshot {
        subtotal: totals.subtotal,
        discount_total: totals.discount_total,
        shipping_total: totals.shipping_total,
        tax_total: totals.tax_total,
        total: totals.total,
        vat_treatment: vat.map(|v| v.treatment.to_owned()),
        vat_quote: json!({ "taxLines": tax_lines, "viesUnavailable": vat.is_some_and(|v| v.vies_unavailable) }),
        discount_id: planned.discount.as_ref().map(|d| d.id.clone()),
        destination,
        shipping_rate_id: rate.as_ref().map(|r| r.id.clone()),
    };
    Ok(Quote {
        json,
        cart_id,
        lines,
        total: totals.total,
        ready,
        missing,
        discount_problem: planned.discount_problem,
        shipping_requested,
        needs_shipping,
        snapshot,
    })
}

/// The snapshot's columns of a cart row, as [`persist`] and
/// [`complete_cart`] write them.
fn snapshot_row(s: &Snapshot) -> carts::ActiveModel {
    carts::ActiveModel {
        subtotal: Set(db::decimal(s.subtotal)),
        discount_total: Set(db::decimal(s.discount_total)),
        shipping_total: Set(db::decimal(s.shipping_total)),
        tax_total: Set(db::decimal(s.tax_total)),
        total: Set(db::decimal(s.total)),
        vat_treatment: Set(s.vat_treatment.clone()),
        vat_quote: Set(Some(s.vat_quote.clone())),
        discount_id: Set(s.discount_id.clone()),
        destination_country: Set(s.destination.clone()),
        shipping_rate_id: Set(s.shipping_rate_id.clone()),
        ..Default::default()
    }
}

/// Write the quote's snapshot to the cart and push its expiry out.
async fn persist(conn: &mut PgConnection, ctx: &Ctx<'_>, quote: &Quote) -> Result<(), DbErr> {
    let now = db::now();
    let mut row = snapshot_row(&quote.snapshot);
    row.currency = Set(ctx.channel.currency.clone());
    row.prices_include_tax = Set(ctx.channel.prices_include_tax);
    row.updated_at = Set(now);
    row.expires_at = Set(Some(now + EXPIRY));
    carts::Entity::update_many()
        .set(row)
        .filter(carts::Column::Id.eq(quote.cart_id.as_str()))
        .exec(&db::on(conn))
        .await?;
    Ok(())
}

/// Reload the cart after a change, price it, store the snapshot.
async fn settle_and_save(
    conn: &mut PgConnection,
    ctx: &Ctx<'_>,
    cart_id: &str,
) -> Result<Quote, Refusal> {
    let row = find_by_id(conn, &ctx.channel.id, cart_id).await?;
    let items = items_of(conn, cart_id).await?;
    let quote = quote(conn, ctx, &row, &items).await?;
    persist(conn, ctx, &quote).await?;
    // The persisted row carries the new expiry and update time.
    let row = find_by_id(conn, &ctx.channel.id, cart_id).await?;
    let mut quote = quote;
    for key in ["expiresAt", "updatedAt"] {
        quote.json[key] = row.get(key).cloned().unwrap_or(Value::Null);
    }
    Ok(quote)
}

/// The cart of `token`, priced now.
///
/// # Errors
/// [`Refusal::CartNotFound`] and the refusals of [`quote`].
pub async fn read(ctx: &Ctx<'_>, token: &str) -> Result<Quote, Refusal> {
    let mut conn = ctx.db.acquire().await?;
    let cart = find(&mut conn, &ctx.channel.id, token, false)
        .await?
        .ok_or(Refusal::CartNotFound)?;
    let id = text(&cart, "id").unwrap_or_default();
    let items = items_of(&mut conn, &id).await?;
    quote(&mut conn, ctx, &cart, &items).await
}

// ── writing a cart ──────────────────────────────────────────────────────────

/// A line asked for.
#[derive(Debug, Clone, Default)]
pub struct ItemInput {
    pub product_id: Option<String>,
    pub variant_id: Option<String>,
    pub quantity: i64,
}

/// Check an item input's shape.
///
/// # Errors
/// [`Refusal::Validation`].
pub fn check_item(input: &ItemInput, path: &str, allow_zero: bool) -> Result<(), Refusal> {
    let min = i64::from(!allow_zero);
    if !(min..=MAX_QUANTITY).contains(&input.quantity) {
        return Err(invalid(
            &format!("{path}quantity"),
            &format!("Must be a whole number from {min} to {MAX_QUANTITY}"),
        ));
    }
    if input.product_id.is_none() && input.variant_id.is_none() {
        return Err(invalid(
            &format!("{path}variantId"),
            "Give a variantId or a productId",
        ));
    }
    Ok(())
}

/// Add a line, or raise the quantity of the one the cart has.
#[allow(clippy::too_many_lines, reason = "check, look up, upsert")]
async fn add_line(
    conn: &mut PgConnection,
    ctx: &Ctx<'_>,
    cart_id: &str,
    input: &ItemInput,
    path: &str,
) -> Result<(), Refusal> {
    check_item(input, path, false)?;
    let mut product_id = input.product_id.clone();
    let mut variant_id = input.variant_id.clone();
    if let Some(variant) = &variant_id {
        let owner: Option<String> = product_variants::Entity::find_by_id(variant.as_str())
            .filter(product_variants::Column::DeletedAt.is_null())
            .select_only()
            .column(product_variants::Column::ProductId)
            .into_tuple()
            .one(&db::on(conn))
            .await?;
        let owner = owner.ok_or_else(|| Refusal::NotSellable("Variant not found".to_owned()))?;
        if product_id.as_ref().is_some_and(|p| *p != owner) {
            return Err(invalid(
                &format!("{path}variantId"),
                "The variant does not belong to the product",
            ));
        }
        product_id = Some(owner);
    }
    let product_id = product_id.unwrap_or_default();
    let has_variants: Option<Option<bool>> = products::Entity::find_by_id(product_id.as_str())
        .filter(products::Column::DeletedAt.is_null())
        .select_only()
        .column(products::Column::HasVariants)
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    // `coalesce(has_variants, false)`
    let has_variants = has_variants
        .ok_or_else(|| Refusal::NotSellable("Product not found".to_owned()))?
        .unwrap_or(false);
    if has_variants && variant_id.is_none() {
        return Err(invalid(
            &format!("{path}variantId"),
            "This product has variants: choose one",
        ));
    }
    if !has_variants {
        variant_id = None;
    }
    // Sellable here: active, visible, with a price in the channel's currency.
    let probe = ItemRow {
        id: String::new(),
        product_id: product_id.clone(),
        variant_id: variant_id.clone(),
        quantity: input.quantity,
    };
    let settled = settle(conn, ctx.channel, &[probe.json()]).await?;
    let line = settled
        .first()
        .ok_or_else(|| Refusal::NotSellable("Not found".to_owned()))?;
    match line.problem {
        Some("INACTIVE") => {
            return Err(Refusal::NotSellable(
                "This product is not for sale".to_owned(),
            ));
        }
        Some("NO_PRICE") => {
            return Err(Refusal::NotSellable(
                "This product has no price in the channel's currency".to_owned(),
            ));
        }
        _ => {}
    }
    let existing: Option<(String, i32)> = cart_items::Entity::find()
        .select_only()
        .columns([cart_items::Column::Id, cart_items::Column::Quantity])
        .filter(cart_items::Column::CartId.eq(cart_id))
        .filter(cart_items::Column::ProductId.eq(product_id.as_str()))
        // `variant_id is not distinct from $3`
        .filter(match &variant_id {
            Some(variant) => cart_items::Column::VariantId.eq(variant.as_str()),
            None => cart_items::Column::VariantId.is_null(),
        })
        .limit(1)
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    if let Some((id, quantity)) = existing {
        let raised = (i64::from(quantity) + input.quantity).min(MAX_QUANTITY);
        cart_items::Entity::update_many()
            .set(cart_items::ActiveModel {
                quantity: Set(i32::try_from(raised).unwrap_or(i32::MAX)),
                unit_price: Set(Some(db::decimal(line.unit_price))),
                updated_at: Set(db::now()),
                ..Default::default()
            })
            .filter(cart_items::Column::Id.eq(id))
            .exec(&db::on(conn))
            .await?;
        return Ok(());
    }
    let lines = cart_items::Entity::find()
        .filter(cart_items::Column::CartId.eq(cart_id))
        .count(&db::on(conn))
        .await?;
    if lines >= MAX_LINES.unsigned_abs() {
        return Err(Refusal::TooLarge);
    }
    cart_items::Entity::insert(cart_items::ActiveModel {
        id: Set(generate_id("citm")),
        cart_id: Set(cart_id.to_owned()),
        product_id: Set(product_id),
        variant_id: Set(variant_id),
        sku: Set(line.sku.as_deref().map(|s| s.chars().take(100).collect())),
        name: Set(Some(line.name.chars().take(255).collect())),
        quantity: Set(i32::try_from(input.quantity).unwrap_or(i32::MAX)),
        unit_price: Set(Some(db::decimal(line.unit_price))),
        ..Default::default()
    })
    .exec_without_returning(&db::on(conn))
    .await?;
    Ok(())
}

struct ItemRow {
    id: String,
    product_id: String,
    variant_id: Option<String>,
    quantity: i64,
}

impl ItemRow {
    fn json(&self) -> Value {
        json!({
            "id": self.id, "productId": self.product_id,
            "variantId": self.variant_id, "quantity": self.quantity,
        })
    }
}

/// Make an open cart of `token` on the channel; it expires [`EXPIRY`] from
/// now.
async fn insert_cart(
    conn: &mut PgConnection,
    ctx: &Ctx<'_>,
    id: &str,
    token: &str,
    email: Option<&str>,
) -> Result<(), DbErr> {
    carts::Entity::insert(carts::ActiveModel {
        id: Set(id.to_owned()),
        token_hash: Set(token_hash(token)),
        channel_id: Set(ctx.channel.id.clone()),
        status: Set("open".to_owned()),
        currency: Set(ctx.channel.currency.clone()),
        prices_include_tax: Set(ctx.channel.prices_include_tax),
        email: Set(email.map(str::to_owned)),
        expires_at: Set(Some(db::now() + EXPIRY)),
        ..Default::default()
    })
    .exec_without_returning(&db::on(conn))
    .await?;
    Ok(())
}

/// A new cart, with its first lines. Returns the cart and its token.
///
/// # Errors
/// Validation, [`Refusal::NotSellable`] and the refusals of [`quote`].
pub async fn create(
    ctx: &Ctx<'_>,
    items: &[ItemInput],
    email: Option<&str>,
) -> Result<(Quote, String), Refusal> {
    let token = new_token();
    let id = generate_id("cart");
    let mut tx = ctx.db.begin().await?;
    insert_cart(&mut tx, ctx, &id, &token, email).await?;
    for (index, item) in items.iter().enumerate() {
        add_line(&mut tx, ctx, &id, item, &format!("items.{index}.")).await?;
    }
    let quote = settle_and_save(&mut tx, ctx, &id).await?;
    tx.commit().await?;
    Ok((quote, token))
}

/// A shopper a cart is attached to (a session sent with the cart token).
#[derive(Debug, Clone, Copy)]
pub struct Attach<'a> {
    pub person_id: &'a str,
    pub email: &'a str,
    /// B2B channel: the company the shopper buys for, and their buyer row.
    pub company_id: Option<&'a str>,
    pub buyer_id: Option<&'a str>,
}

/// The shopper's columns of a cart row.
fn shopper_row(who: &Attach<'_>) -> carts::ActiveModel {
    carts::ActiveModel {
        person_id: Set(Some(who.person_id.to_owned())),
        company_id: Set(who.company_id.map(str::to_owned)),
        buyer_id: Set(who.buyer_id.map(str::to_owned)),
        ..Default::default()
    }
}

/// `coalesce(nullif(email, ''), $email)`: a cart keeps the email it has.
fn email_or(email: &str) -> Expr {
    Func::coalesce([
        Expr::from(
            Func::cust("nullif")
                .arg(Expr::col(carts::Column::Email))
                .arg(""),
        ),
        Expr::val(email),
    ])
    .into()
}

/// Attach the open cart of `token` to the shopper. `false` when there is
/// no such open cart (a guest cart stays a guest cart).
///
/// # Errors
/// A failed statement.
pub async fn attach(ctx: &Ctx<'_>, token: &str, who: &Attach<'_>) -> Result<bool, DbErr> {
    let mut row = shopper_row(who);
    row.updated_at = Set(db::now());
    let changed = carts::Entity::update_many()
        .set(row)
        .col_expr(carts::Column::Email, email_or(who.email))
        .filter(carts::Column::TokenHash.eq(token_hash(token)))
        .filter(carts::Column::ChannelId.eq(ctx.channel.id.as_str()))
        .filter(carts::Column::Status.is_in(["open", "checkout"]))
        .exec(&weldsuite_db::orm(ctx.db))
        .await?
        .rows_affected;
    Ok(changed > 0)
}

/// A line asked for by SKU or by product and variant.
#[derive(Debug, Clone, Default)]
pub struct Wanted {
    /// The row of the quick order (or null), echoed back in a problem.
    pub row: Option<i64>,
    pub sku: Option<String>,
    pub product_id: Option<String>,
    pub variant_id: Option<String>,
    pub quantity: i64,
}

/// A line that could not be added as asked.
#[derive(Debug, Clone)]
pub struct LineProblem {
    pub row: Option<i64>,
    pub sku: Option<String>,
    pub product_id: Option<String>,
    /// `UNKNOWN_SKU`, `NOT_SELLABLE`, `NO_PRICE`, `INVALID_QUANTITY` or
    /// `OUT_OF_STOCK` (the line is in the cart, with fewer on hand).
    pub problem: &'static str,
    pub message: String,
}

/// What [`fill`] did.
#[derive(Debug, Clone)]
pub struct Filled {
    pub quote: Quote,
    /// The token of a cart that was made.
    pub token: Option<String>,
    pub problems: Vec<LineProblem>,
}

/// `product_variants.product_id = products.id` (the entities declare no
/// relations).
fn variant_product() -> RelationDef {
    product_variants::Entity::belongs_to(products::Entity)
        .from(product_variants::Column::ProductId)
        .to(products::Column::Id)
        .into()
}

async fn resolve_sku(
    conn: &mut PgConnection,
    sku: &str,
) -> Result<Option<(String, Option<String>)>, DbErr> {
    let variant: Option<(String, String)> = product_variants::Entity::find()
        .join(JoinType::InnerJoin, variant_product())
        .select_only()
        .columns([
            product_variants::Column::ProductId,
            product_variants::Column::Id,
        ])
        // `lower(v.sku) = lower($1)`
        .filter(lower_eq(product_variants::Column::Sku, sku))
        .filter(product_variants::Column::DeletedAt.is_null())
        .filter(products::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    if let Some((product, variant)) = variant {
        return Ok(Some((product, Some(variant))));
    }
    let product: Option<String> = products::Entity::find()
        .select_only()
        .column(products::Column::Id)
        .filter(lower_eq(products::Column::Sku, sku))
        .filter(products::Column::DeletedAt.is_null())
        .limit(1)
        .into_tuple()
        .one(&db::on(conn))
        .await?;
    Ok(product.map(|id| (id, None)))
}

/// Add many lines at once (quick order, reorder): into the cart of `token`,
/// or a new cart. A line that cannot be added is reported, never silently
/// dropped, and the others are added. One transaction.
///
/// # Errors
/// A cart that is not found or not open, and the refusals of [`quote`].
#[allow(clippy::too_many_lines, reason = "resolve, add, report, price")]
pub async fn fill(
    ctx: &Ctx<'_>,
    token: Option<&str>,
    wanted: &[Wanted],
    who: Option<&Attach<'_>>,
) -> Result<Filled, Refusal> {
    let mut tx = ctx.db.begin().await?;
    let (cart_id, made) = if let Some(token) = token {
        (lock_open(&mut tx, ctx, token).await?, None)
    } else {
        let token = new_token();
        let id = generate_id("cart");
        insert_cart(&mut tx, ctx, &id, &token, who.map(|w| w.email)).await?;
        (id, Some(token))
    };
    if let Some(who) = who {
        carts::Entity::update_many()
            .set(shopper_row(who))
            .col_expr(carts::Column::Email, email_or(who.email))
            .filter(carts::Column::Id.eq(cart_id.as_str()))
            .exec(&db::on(&mut tx))
            .await?;
    }
    let mut problems: Vec<LineProblem> = Vec::new();
    let mut added: Vec<(Wanted, String, Option<String>)> = Vec::new();
    for line in wanted {
        let problem = |problem: &'static str, message: &str| LineProblem {
            row: line.row,
            sku: line.sku.clone(),
            product_id: line.product_id.clone(),
            problem,
            message: message.to_owned(),
        };
        if !(1..=MAX_QUANTITY).contains(&line.quantity) {
            problems.push(problem(
                "INVALID_QUANTITY",
                &format!("The quantity must be a whole number from 1 to {MAX_QUANTITY}"),
            ));
            continue;
        }
        let (product_id, variant_id) = if let Some(sku) = &line.sku {
            let Some(found) = resolve_sku(&mut tx, sku).await? else {
                problems.push(problem("UNKNOWN_SKU", "No product has that SKU"));
                continue;
            };
            found
        } else {
            (
                line.product_id.clone().unwrap_or_default(),
                line.variant_id.clone(),
            )
        };
        let input = ItemInput {
            product_id: Some(product_id.clone()),
            variant_id: variant_id.clone(),
            quantity: line.quantity,
        };
        match add_line(&mut tx, ctx, &cart_id, &input, "").await {
            Ok(()) => added.push((line.clone(), product_id, variant_id)),
            Err(Refusal::NotSellable(why)) => {
                let kind = if why.contains("no price") {
                    "NO_PRICE"
                } else {
                    "NOT_SELLABLE"
                };
                problems.push(problem(kind, &why));
            }
            Err(Refusal::Validation(issues)) => {
                let why = issues
                    .first()
                    .map_or("The line cannot be added", |(_, message)| message.as_str());
                problems.push(problem("NOT_SELLABLE", why));
            }
            Err(Refusal::TooLarge) => {
                problems.push(problem("NOT_SELLABLE", "The cart has too many lines"));
            }
            Err(other) => return Err(other),
        }
    }
    let quote = settle_and_save(&mut tx, ctx, &cart_id).await?;
    tx.commit().await?;
    for line in quote
        .lines
        .iter()
        .filter(|l| l.problem == Some("OUT_OF_STOCK"))
    {
        let at = added.iter().find(|(_, product, variant)| {
            *product == line.product_id && *variant == line.variant_id
        });
        problems.push(LineProblem {
            row: at.and_then(|(w, _, _)| w.row),
            sku: at
                .and_then(|(w, _, _)| w.sku.clone())
                .or_else(|| line.sku.clone()),
            product_id: Some(line.product_id.clone()),
            problem: "OUT_OF_STOCK",
            message: format!("Only {} on hand", line.available_stock.unwrap_or(0)),
        });
    }
    Ok(Filled {
        quote,
        token: made,
        problems,
    })
}

/// Lock the open cart of `token` inside `tx`.
async fn lock_open(tx: &mut PgConnection, ctx: &Ctx<'_>, token: &str) -> Result<String, Refusal> {
    let cart = find(tx, &ctx.channel.id, token, true)
        .await?
        .ok_or(Refusal::CartNotFound)?;
    ensure_open(&cart)?;
    Ok(text(&cart, "id").unwrap_or_default())
}

/// Add a line to the cart.
///
/// # Errors
/// Validation, [`Refusal::NotSellable`], [`Refusal::TooLarge`], not found or
/// not open, and the refusals of [`quote`].
pub async fn add_item(ctx: &Ctx<'_>, token: &str, input: &ItemInput) -> Result<Quote, Refusal> {
    let mut tx = ctx.db.begin().await?;
    let id = lock_open(&mut tx, ctx, token).await?;
    add_line(&mut tx, ctx, &id, input, "").await?;
    let quote = settle_and_save(&mut tx, ctx, &id).await?;
    tx.commit().await?;
    Ok(quote)
}

/// Set a line's quantity (0 removes it).
///
/// # Errors
/// As [`add_item`]; [`Refusal::Validation`] for an unknown line.
pub async fn set_quantity(
    ctx: &Ctx<'_>,
    token: &str,
    line_id: &str,
    quantity: i64,
) -> Result<Quote, Refusal> {
    if !(0..=MAX_QUANTITY).contains(&quantity) {
        return Err(invalid(
            "quantity",
            &format!("Must be a whole number from 0 to {MAX_QUANTITY}"),
        ));
    }
    let mut tx = ctx.db.begin().await?;
    let id = lock_open(&mut tx, ctx, token).await?;
    let changed = if quantity == 0 {
        cart_items::Entity::delete_many()
            .filter(cart_items::Column::Id.eq(line_id))
            .filter(cart_items::Column::CartId.eq(id.as_str()))
            .exec(&db::on(&mut tx))
            .await?
            .rows_affected
    } else {
        cart_items::Entity::update_many()
            .set(cart_items::ActiveModel {
                quantity: Set(i32::try_from(quantity).unwrap_or(i32::MAX)),
                updated_at: Set(db::now()),
                ..Default::default()
            })
            .filter(cart_items::Column::Id.eq(line_id))
            .filter(cart_items::Column::CartId.eq(id.as_str()))
            .exec(&db::on(&mut tx))
            .await?
            .rows_affected
    };
    if changed == 0 {
        return Err(Refusal::Validation(vec![(
            "lineId".to_owned(),
            "The cart has no such line".to_owned(),
        )]));
    }
    let quote = settle_and_save(&mut tx, ctx, &id).await?;
    tx.commit().await?;
    Ok(quote)
}

/// What a cart patch may change; a field left out stays, `Some(None)` clears.
#[derive(Debug, Clone, Default)]
pub struct Patch {
    pub email: Option<Option<String>>,
    pub shipping_address: Option<Option<Value>>,
    pub billing_address: Option<Option<Value>>,
    pub buyer_vat_number: Option<Option<String>>,
    pub customer_reference: Option<Option<String>>,
    pub note: Option<Option<String>>,
}

/// Change the cart's contact, addresses and notes.
///
/// # Errors
/// [`Refusal::CountryNotSold`] and the refusals of [`quote`].
pub async fn patch(ctx: &Ctx<'_>, token: &str, patch: &Patch) -> Result<Quote, Refusal> {
    let mut tx = ctx.db.begin().await?;
    let id = lock_open(&mut tx, ctx, token).await?;
    // The fields sent, in one statement (none: no statement).
    let mut row = carts::ActiveModel::default();
    if let Some(value) = &patch.email {
        row.email = Set(value.clone());
    }
    if let Some(value) = &patch.buyer_vat_number {
        row.buyer_vat_number = Set(value.clone());
    }
    if let Some(value) = &patch.customer_reference {
        row.customer_reference = Set(value.clone());
    }
    if let Some(value) = &patch.note {
        row.note = Set(value.clone());
    }
    if let Some(value) = &patch.shipping_address {
        row.shipping_address = Set(value.clone());
    }
    if let Some(value) = &patch.billing_address {
        row.billing_address = Set(value.clone());
    }
    carts::Entity::update_many()
        .set(row)
        .filter(carts::Column::Id.eq(id.as_str()))
        .exec(&db::on(&mut tx))
        .await?;
    // Only countries the channel sells to: the shipping address, or the
    // billing address when the cart has no shipping address.
    let addresses: (Option<Value>, Option<Value>) = carts::Entity::find_by_id(id.as_str())
        .select_only()
        .columns([
            carts::Column::ShippingAddress,
            carts::Column::BillingAddress,
        ])
        .into_tuple()
        .require_one(&db::on(&mut tx))
        .await?;
    let destination = country(addresses.0.as_ref()).or_else(|| country(addresses.1.as_ref()));
    if let Some(dest) = destination
        && !ctx.channel.selling_countries.contains(&dest)
    {
        return Err(Refusal::CountryNotSold(dest));
    }
    let quote = settle_and_save(&mut tx, ctx, &id).await?;
    tx.commit().await?;
    Ok(quote)
}

/// A shipping rate on offer for the cart's destination.
#[derive(Debug, Clone)]
pub struct Offer {
    pub id: String,
    pub name: String,
    pub price: Cents,
    pub free: bool,
}

/// The rates for the cart's shipping country (none until it has one).
///
/// # Errors
/// [`Refusal::CartNotFound`] and the refusals of [`quote`].
pub async fn shipping_rates(ctx: &Ctx<'_>, token: &str) -> Result<Vec<Offer>, Refusal> {
    let mut conn = ctx.db.acquire().await?;
    let cart = find(&mut conn, &ctx.channel.id, token, false)
        .await?
        .ok_or(Refusal::CartNotFound)?;
    let Some(dest) = country(cart.get("shippingAddress")) else {
        return Ok(Vec::new());
    };
    let id = text(&cart, "id").unwrap_or_default();
    let items = items_of(&mut conn, &id).await?;
    let lines = settle(&mut conn, ctx.channel, &items).await?;
    let subtotal: Cents = lines
        .iter()
        .filter(|l| l.priced())
        .map(|l| Cents::from(l.quantity) * l.unit_price)
        .sum();
    Ok(rates(&mut conn, ctx.channel)
        .await?
        .into_iter()
        .filter(|r| r.covers(&dest))
        .map(|r| Offer {
            free: r.free(subtotal),
            price: r.price,
            id: r.id,
            name: r.name,
        })
        .collect())
}

/// Choose the shipping rate.
///
/// # Errors
/// [`Refusal::RateNotAvailable`] when the rate is not one on offer.
pub async fn set_rate(ctx: &Ctx<'_>, token: &str, rate_id: &str) -> Result<Quote, Refusal> {
    let mut tx = ctx.db.begin().await?;
    let id = lock_open(&mut tx, ctx, token).await?;
    let address: Option<Value> = carts::Entity::find_by_id(id.as_str())
        .select_only()
        .column(carts::Column::ShippingAddress)
        .into_tuple()
        .require_one(&db::on(&mut tx))
        .await?;
    let dest = country(address.as_ref()).ok_or(Refusal::RateNotAvailable)?;
    let offered = rates(&mut tx, ctx.channel)
        .await?
        .into_iter()
        .any(|r| r.id == rate_id && r.covers(&dest));
    if !offered {
        return Err(Refusal::RateNotAvailable);
    }
    carts::Entity::update_many()
        .set(carts::ActiveModel {
            shipping_rate_id: Set(Some(rate_id.to_owned())),
            ..Default::default()
        })
        .filter(carts::Column::Id.eq(id.as_str()))
        .exec(&db::on(&mut tx))
        .await?;
    let quote = settle_and_save(&mut tx, ctx, &id).await?;
    tx.commit().await?;
    Ok(quote)
}

/// Apply a discount code, or (`None`) remove it.
///
/// # Errors
/// [`Refusal::DiscountNotApplicable`] when the code does not apply; nothing
/// is changed then.
pub async fn set_discount(
    ctx: &Ctx<'_>,
    token: &str,
    code: Option<&str>,
) -> Result<Quote, Refusal> {
    let mut tx = ctx.db.begin().await?;
    let id = lock_open(&mut tx, ctx, token).await?;
    carts::Entity::update_many()
        .set(carts::ActiveModel {
            discount_code: Set(code.map(str::to_owned)),
            discount_id: Set(None),
            ..Default::default()
        })
        .filter(carts::Column::Id.eq(id.as_str()))
        .exec(&db::on(&mut tx))
        .await?;
    let quote = settle_and_save(&mut tx, ctx, &id).await?;
    if code.is_some()
        && let Some(problem) = quote.discount_problem
    {
        return Err(Refusal::DiscountNotApplicable(problem));
    }
    tx.commit().await?;
    Ok(quote)
}

/// Mark the cart finished with its order (inside the checkout's transaction).
pub(crate) async fn complete_cart(
    conn: &mut PgConnection,
    cart_id: &str,
    order_id: &str,
    idempotency_key: Option<&str>,
    quote: &Quote,
) -> Result<(), Refusal> {
    let now = db::now();
    let mut row = snapshot_row(&quote.snapshot);
    row.status = Set("completed".to_owned());
    row.order_id = Set(Some(order_id.to_owned()));
    row.idempotency_key = Set(idempotency_key.map(str::to_owned));
    row.completed_at = Set(Some(now));
    row.updated_at = Set(now);
    let done = carts::Entity::update_many()
        .set(row)
        .filter(carts::Column::Id.eq(cart_id))
        .exec(&db::on(conn))
        .await;
    match done {
        Ok(_) => Ok(()),
        Err(error) if db::is_unique_violation(&error) => Err(Refusal::IdempotencyKeyReused),
        Err(error) => Err(error.into()),
    }
}

/// Clean an address from a request body: known fields only, trimmed, blanks
/// dropped, the country upper-cased. Problems are added to `problems` under
/// `path`.
#[must_use]
pub fn clean_address(
    value: &Value,
    path: &str,
    problems: &mut Vec<(String, String)>,
) -> Option<Value> {
    let Some(object) = value.as_object() else {
        problems.push((path.to_owned(), "Must be an address object".to_owned()));
        return None;
    };
    let mut out = Map::new();
    for (key, max) in [
        ("name", 255),
        ("company", 255),
        ("line1", 255),
        ("line2", 255),
        ("postalCode", 30),
        ("city", 120),
        ("region", 120),
        ("country", 2),
        ("phone", 50),
    ] {
        match object.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) => {
                let s = s.trim();
                if s.chars().count() > max {
                    problems.push((format!("{path}.{key}"), format!("At most {max} characters")));
                } else if !s.is_empty() {
                    out.insert(key.to_owned(), json!(s));
                }
            }
            Some(_) => problems.push((format!("{path}.{key}"), "Must be text".to_owned())),
        }
    }
    if let Some(Value::String(c)) = out.get("country") {
        if c.len() == 2 && c.chars().all(|c| c.is_ascii_alphabetic()) {
            let upper = c.to_ascii_uppercase();
            out.insert("country".to_owned(), json!(upper));
        } else {
            problems.push((
                format!("{path}.country"),
                "Must be a 2-letter country code".to_owned(),
            ));
        }
    }
    Some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_hashed_and_prefixed() {
        let token = new_token();
        assert!(token.starts_with("wct_") && token.len() == 44);
        assert_eq!(token_hash(&token).len(), 64);
        assert_ne!(token, new_token());
    }

    #[test]
    fn an_address_needs_its_parcel_fields() {
        assert!(!complete(None));
        let mut address = json!({ "country": "NL", "line1": "Straat 1", "city": "Stad" });
        assert!(!complete(Some(&address)));
        address["postalCode"] = json!("1234 AB");
        assert!(complete(Some(&address)));
    }

    #[test]
    fn addresses_are_cleaned() {
        let mut problems = Vec::new();
        let clean = clean_address(
            &json!({ "country": "nl", "line1": " Straat 1 ", "city": "", "evil": "x" }),
            "shippingAddress",
            &mut problems,
        )
        .expect("clean");
        assert_eq!(problems.len(), 0);
        assert_eq!(clean, json!({ "country": "NL", "line1": "Straat 1" }));
        let _ = clean_address(&json!({ "country": "Nederland" }), "a", &mut problems);
        assert_eq!(problems.len(), 1); // too long for a country code
    }

    #[test]
    fn stock_counts_only_when_tracked_without_backorder() {
        assert_eq!(
            stock_of(&json!({ "track": true, "qty": 3, "backorder": false })),
            Some(3)
        );
        assert_eq!(stock_of(&json!({ "track": false, "qty": 0 })), None);
        assert_eq!(
            stock_of(&json!({ "track": true, "qty": 0, "backorder": true })),
            None
        );
        assert_eq!(stock_of(&json!({})), Some(0));
    }

    #[test]
    fn only_open_unexpired_carts_change() {
        assert!(ensure_open(&json!({ "status": "open", "expired": false })).is_ok());
        assert!(ensure_open(&json!({ "status": "checkout" })).is_ok());
        assert!(matches!(
            ensure_open(&json!({ "status": "completed" })),
            Err(Refusal::CartNotOpen(status)) if status == "completed"
        ));
        assert!(matches!(
            ensure_open(&json!({ "status": "open", "expired": true })),
            Err(Refusal::CartNotOpen(status)) if status == "expired"
        ));
    }

    #[test]
    fn item_inputs_are_checked() {
        let item = |q| ItemInput {
            product_id: Some("p".into()),
            variant_id: None,
            quantity: q,
        };
        assert!(check_item(&item(1), "", false).is_ok());
        assert!(check_item(&item(0), "", false).is_err());
        assert!(check_item(&item(0), "", true).is_ok());
        assert!(check_item(&item(MAX_QUANTITY + 1), "", true).is_err());
        assert!(
            check_item(
                &ItemInput {
                    quantity: 1,
                    ..ItemInput::default()
                },
                "",
                false
            )
            .is_err()
        );
    }

    #[test]
    fn a_rate_is_free_at_its_threshold() {
        let rate = Rate {
            id: "r".into(),
            name: "Post".into(),
            price: 495,
            threshold: Some(5000),
            countries: vec!["NL".into()],
        };
        assert_eq!(rate.charged(4999), 495);
        assert_eq!(rate.charged(5000), 0);
        assert!(rate.covers("nl") && !rate.covers("BE"));
    }
}
