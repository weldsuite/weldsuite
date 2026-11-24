//! Provider record → WeldSuite entity mappers (`connectors/mappers.ts`,
//! `stripe-mappers.ts`, `field-mapper.ts`). Pure: no database, no fetch.
//!
//! `values` are the Drizzle properties an ingest writes. A JavaScript `Date`
//! is its ISO string; an invalid one ([`INVALID_DATE`]) makes the write
//! throw, as Drizzle's `toISOString()` does.

use serde_json::{Map, Value, json};
use unicode_normalization::UnicodeNormalization;

use crate::clients::as_text;
use crate::js::{number_text, number_value, to_fixed};

/// An invalid `Date` in mapped values: writing it fails the record with
/// `Invalid time value`.
pub const INVALID_DATE: &str = "\u{1}Invalid Date";

/// `new Date(text)` as a value: its ISO string, or [`INVALID_DATE`].
pub fn date_value(text: &str) -> Value {
    match js_date_loose(text) {
        Some(ms) => json!(weldsuite_kit::validation::js_iso_from_millis(ms).unwrap_or_default()),
        None => json!(INVALID_DATE),
    }
}

/// `new Date().toISOString()`.
pub fn now_value() -> Value {
    json!(crate::js::now_iso())
}

/// `new Date(text)` (`Date.parse`) for the forms providers send: ISO dates
/// and date-times with or without a zone (no zone: local time, which is UTC
/// where these run), and `YYYY-MM-DD HH:MM[:SS]`.
pub fn js_date_loose(text: &str) -> Option<f64> {
    let text = weldsuite_kit::validation::js_trim(text);
    if let Some(ms) = weldsuite_kit::validation::js_date_parse(text) {
        return Some(ms);
    }
    let bytes = text.as_bytes();
    if bytes.len() < 16 || !(bytes[10] == b'T' || bytes[10] == b' ') {
        return None;
    }
    let (date, rest) = text.split_at(10);
    let rest = &rest[1..];
    // Split off a zone: `Z`, `±HH:MM` or `±HHMM`.
    let (time, zone) = if let Some(stripped) = rest.strip_suffix('Z') {
        (stripped, "Z".to_owned())
    } else if let Some(at) = rest.rfind(['+', '-']).filter(|at| *at >= 5) {
        let zone = &rest[at..];
        let zone = if zone.len() == 5 && !zone.contains(':') {
            format!("{}:{}", &zone[..3], &zone[3..])
        } else {
            zone.to_owned()
        };
        (&rest[..at], zone)
    } else {
        (rest, "Z".to_owned())
    };
    weldsuite_kit::validation::js_date_parse(&format!("{date}T{time}{zone}"))
}

// ── reading records ─────────────────────────────────────────────────────────

/// `readPath(source, 'a.b.0')`.
pub fn read_path<'a>(source: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = source;
    for segment in path.split('.') {
        current = match current {
            Value::Object(map) => map.get(segment)?,
            Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

/// `str.slice(0, max)` in UTF-16 units.
pub fn slice_units(text: &str, max: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return text.to_owned();
    }
    String::from_utf16_lossy(&units[..max])
}

/// `pickString(source, paths, maxLength)`.
pub fn pick_string(source: &Value, paths: &[&str], max: Option<usize>) -> Option<String> {
    for path in paths {
        let Some(value) = read_path(source, path) else {
            continue;
        };
        if value.is_null() || value.is_object() || value.is_array() {
            continue;
        }
        let text = as_text(value);
        let trimmed = weldsuite_kit::validation::js_trim(&text);
        if trimmed.is_empty() || trimmed == "null" || trimmed == "undefined" {
            continue;
        }
        return Some(match max {
            Some(max) => slice_units(trimmed, max),
            None => trimmed.to_owned(),
        });
    }
    None
}

fn ps(source: &Value, paths: &[&str]) -> Option<String> {
    pick_string(source, paths, None)
}

fn psm(source: &Value, paths: &[&str], max: usize) -> Option<String> {
    pick_string(source, paths, Some(max))
}

/// `pickNumber(source, paths)`: the string with everything but digits,
/// `.` and `-` removed, as a finite number.
pub fn pick_number(source: &Value, paths: &[&str]) -> Option<f64> {
    let raw = ps(source, paths)?;
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    let parsed = weldsuite_kit::validation::js_number(&cleaned);
    parsed.is_finite().then_some(parsed)
}

fn opt(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

fn num(value: Option<f64>) -> Value {
    value.map_or(Value::Null, number_value)
}

/// `compact({...})`: the pairs whose value is not null.
fn compact(pairs: Vec<(&str, Value)>) -> Map<String, Value> {
    pairs
        .into_iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| (k.to_owned(), v))
        .collect()
}

fn records(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// `firstRecordArray(...candidates)`.
fn first_array(candidates: &[Option<&Value>]) -> Vec<Value> {
    candidates
        .iter()
        .find_map(|c| c.and_then(Value::as_array))
        .cloned()
        .unwrap_or_default()
}

/// `[a, b].filter(Boolean).join(' ')`.
fn join_names(parts: &[Option<String>]) -> String {
    parts
        .iter()
        .filter_map(|p| p.as_deref().filter(|p| !p.is_empty()))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `slugify(value)`.
pub(crate) fn slugify(value: &str) -> String {
    let lowered: String = value.to_lowercase().nfkd().collect();
    let kept: String = lowered
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || js_space(*c) || *c == '-')
        .collect();
    let trimmed = weldsuite_kit::validation::js_trim(&kept);
    let mut out = String::new();
    let mut in_run = false;
    for c in trimmed.chars() {
        if js_space(c) || c == '_' {
            if !in_run {
                out.push('-');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    let mut collapsed = String::new();
    for c in out.chars() {
        if c == '-' && collapsed.ends_with('-') {
            continue;
        }
        collapsed.push(c);
    }
    let sliced = slice_units(&collapsed, 255);
    if sliced.is_empty() {
        "item".to_owned()
    } else {
        sliced
    }
}

fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

// ── mapped records ──────────────────────────────────────────────────────────

/// `MappedProductVariant`.
#[derive(Debug, Clone)]
pub struct ProductVariant {
    pub external_id: String,
    pub sku: Option<String>,
    pub name: Option<String>,
    pub price: Option<String>,
    pub inventory_quantity: Option<f64>,
    pub track_inventory: bool,
    /// `{ name: value }` in the order they were read.
    pub option_values: Option<Vec<(String, String)>>,
    pub status: String,
    pub position: f64,
}

/// An order line (`MappedOrder.lineItems[]`).
#[derive(Debug, Clone)]
pub struct OrderLine {
    /// The provider's own id for the line (WooCommerce and Shopify `id`,
    /// Picqer `idorder_product`). Ingest keeps it in
    /// `order_items.external_line_id`, so a re-import updates the
    /// same item instead of replacing it.
    pub external_line_id: Option<String>,
    pub external_product_id: Option<String>,
    pub sku: Option<String>,
    pub name: String,
    pub quantity: f64,
    pub unit_price: String,
    pub total: String,
    pub image_url: Option<String>,
}

/// `MappedDocumentLine`.
#[derive(Debug, Clone)]
pub struct DocumentLine {
    pub external_product_id: Option<String>,
    pub description: String,
    pub quantity: String,
    pub unit_price: String,
    pub tax_rate: Option<String>,
    pub tax_amount: Option<String>,
    pub line_total: Option<String>,
    pub line_total_with_tax: Option<String>,
    pub sort_order: usize,
    pub period: Option<(String, String)>,
}

/// `MappedWmsEntity.links`.
#[derive(Debug, Clone, Default)]
pub struct Links {
    pub product: Option<String>,
    pub warehouse: Option<String>,
    pub location: Option<String>,
    pub order: Option<String>,
    pub supplier: Option<String>,
    pub picklist: Option<String>,
}

/// `MappedRecord`.
#[derive(Debug, Clone)]
pub enum Mapped {
    Product {
        external_id: String,
        external_url: Option<String>,
        values: Map<String, Value>,
        variants: Option<Vec<ProductVariant>>,
    },
    Order {
        external_id: String,
        values: Map<String, Value>,
        line_items: Vec<OrderLine>,
        customer_external_id: Option<String>,
    },
    Person {
        external_id: String,
        values: Map<String, Value>,
    },
    Party {
        external_id: String,
        /// `company` | `person`.
        kind: &'static str,
        identity: Map<String, Value>,
        values: Map<String, Value>,
    },
    Document {
        /// `invoice` | `bill`.
        entity: &'static str,
        external_id: String,
        contact_external_id: Option<String>,
        nested_contact: Option<Value>,
        values: Map<String, Value>,
        line_items: Vec<DocumentLine>,
    },
    BankAccount {
        external_id: String,
        values: Map<String, Value>,
    },
    BankTransaction {
        external_id: String,
        financial_account_external_id: Option<String>,
        /// Stripe lines: the invoice a charge paid. Moneybird mutations: the
        /// sales invoice their first `SalesInvoice` payment settles.
        invoice_external_id: Option<String>,
        /// Moneybird mutations: the purchase invoice or receipt their first
        /// `Document` payment settles.
        bill_external_id: Option<String>,
        values: Map<String, Value>,
    },
    Wms {
        entity: &'static str,
        external_id: String,
        values: Map<String, Value>,
        links: Links,
    },
}

impl Mapped {
    /// `mapped.entity`.
    pub fn entity(&self) -> &'static str {
        match self {
            Self::Product { .. } => "product",
            Self::Order { .. } => "order",
            Self::Person { .. } => "person",
            Self::Party { .. } => "party",
            Self::Document { entity, .. } | Self::Wms { entity, .. } => entity,
            Self::BankAccount { .. } => "bank_account",
            Self::BankTransaction { .. } => "bank_transaction",
        }
    }

    pub fn values_mut(&mut self) -> &mut Map<String, Value> {
        match self {
            Self::Product { values, .. }
            | Self::Order { values, .. }
            | Self::Person { values, .. }
            | Self::Party { values, .. }
            | Self::Document { values, .. }
            | Self::BankAccount { values, .. }
            | Self::BankTransaction { values, .. }
            | Self::Wms { values, .. } => values,
        }
    }

    pub fn external_id(&self) -> &str {
        match self {
            Self::Product { external_id, .. }
            | Self::Order { external_id, .. }
            | Self::Person { external_id, .. }
            | Self::Party { external_id, .. }
            | Self::Document { external_id, .. }
            | Self::BankAccount { external_id, .. }
            | Self::BankTransaction { external_id, .. }
            | Self::Wms { external_id, .. } => external_id,
        }
    }
}

const PRODUCT_STATUS: [(&str, &str); 7] = [
    ("publish", "active"),
    ("published", "active"),
    ("active", "active"),
    ("draft", "draft"),
    ("pending", "draft"),
    ("private", "inactive"),
    ("archived", "inactive"),
];

const ORDER_STATUS: [(&str, &str); 8] = [
    ("pending", "pending"),
    ("processing", "processing"),
    ("on-hold", "on_hold"),
    ("completed", "completed"),
    ("cancelled", "cancelled"),
    ("canceled", "cancelled"),
    ("refunded", "refunded"),
    ("failed", "failed"),
];

const PICQER_ORDER_STATUS: [(&str, &str); 7] = [
    ("concept", "pending"),
    ("expected", "processing"),
    ("processing", "processing"),
    ("paused", "on_hold"),
    ("completed", "completed"),
    ("cancelled", "cancelled"),
    ("canceled", "cancelled"),
];

fn lookup(table: &[(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

fn image_url(img: &Value) -> String {
    img.get("src")
        .and_then(Value::as_str)
        .or_else(|| img.get("url").and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

fn shopify_images(record: &Value) -> Vec<Value> {
    records(record.get("images"))
        .iter()
        .filter_map(|img| {
            let url = image_url(img);
            if url.is_empty() {
                return None;
            }
            let mut out = Map::new();
            out.insert("url".to_owned(), json!(url));
            if let Some(alt) = img.get("alt").and_then(Value::as_str) {
                out.insert("altText".to_owned(), json!(alt));
            }
            if let Some(id) = img.get("id") {
                out.insert("id".to_owned(), json!(as_text(id)));
            }
            Some(Value::Object(out))
        })
        .collect()
}

fn option_values(record: &Value, options: &[String]) -> Option<Vec<(String, String)>> {
    let attrs = records(record.get("attributes"));
    let mut values: Vec<(String, String)> = Vec::new();
    let mut set = |name: String, value: String| match values.iter_mut().find(|(n, _)| *n == name) {
        Some(entry) => entry.1 = value,
        None => values.push((name, value)),
    };
    if attrs.is_empty() {
        for i in 0..3 {
            let name = options.get(i).filter(|n| !n.is_empty());
            let value = ps(record, &[&format!("option{}", i + 1)]);
            if let (Some(name), Some(value)) = (name, value) {
                set(name.clone(), value);
            }
        }
    } else {
        for attr in &attrs {
            if let (Some(name), Some(option)) = (ps(attr, &["name"]), ps(attr, &["option"])) {
                set(name, option);
            }
        }
    }
    (!values.is_empty()).then_some(values)
}

fn raw_variants(record: &Value) -> Vec<Value> {
    if let Some(items) = record.get("_variations").and_then(Value::as_array) {
        return items.clone();
    }
    if let Some(items) = record.get("variations").and_then(Value::as_array)
        && items.iter().any(|v| v.is_object() || v.is_array())
    {
        return items.clone();
    }
    records(record.get("variants"))
}

fn map_variants(record: &Value) -> Vec<ProductVariant> {
    let raw = raw_variants(record);
    if raw.is_empty() {
        return Vec::new();
    }
    let options: Vec<String> = records(record.get("options"))
        .iter()
        .map(|opt| ps(opt, &["name"]).unwrap_or_default())
        .filter(|n| !n.is_empty())
        .collect();
    let mut out = Vec::new();
    for (i, variant) in raw.iter().enumerate() {
        let Some(external_id) = variant
            .get("id")
            .filter(|v| !v.is_null())
            .map(as_text)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let option_values = option_values(variant, &options);
        let status = lookup(
            &PRODUCT_STATUS,
            ps(variant, &["status"]).as_deref().unwrap_or_default(),
        )
        .unwrap_or("active");
        let track = variant.get("manage_stock") == Some(&Value::Bool(true))
            || ps(variant, &["inventory_management"]).as_deref() == Some("shopify");
        #[allow(clippy::cast_precision_loss)]
        let position = pick_number(variant, &["menu_order", "position"]).unwrap_or(i as f64);
        out.push(ProductVariant {
            external_id,
            sku: psm(variant, &["sku"], 100),
            name: psm(variant, &["name", "title"], 255).or_else(|| {
                option_values.as_ref().map(|values| {
                    values
                        .iter()
                        .map(|(_, v)| v.as_str())
                        .collect::<Vec<_>>()
                        .join(" / ")
                })
            }),
            price: ps(variant, &["price", "regular_price"]),
            inventory_quantity: pick_number(variant, &["stock_quantity", "inventory_quantity"]),
            track_inventory: track,
            option_values,
            status: status.to_owned(),
            position,
        });
    }
    out
}

fn picqer_free_stock(record: &Value) -> Option<f64> {
    let stock = records(record.get("stock"));
    if stock.is_empty() {
        return pick_number(record, &["freestock", "stock"]);
    }
    Some(
        stock
            .iter()
            .map(|row| pick_number(row, &["freestock", "stock"]).unwrap_or(0.0))
            .sum(),
    )
}

fn map_product(record: &Value, external_id: &str) -> Option<Mapped> {
    let name = psm(record, &["name", "title"], 255)?;
    let slug = psm(record, &["slug", "handle"], 255).unwrap_or_else(|| slugify(&name));
    let images = shopify_images(record);
    let status = match record.get("active") {
        Some(Value::Bool(true)) => "active",
        Some(Value::Bool(false)) => "inactive",
        _ => lookup(
            &PRODUCT_STATUS,
            ps(record, &["status"]).as_deref().unwrap_or_default(),
        )
        .unwrap_or("draft"),
    };
    let price = ps(record, &["price", "regular_price", "variants.0.price"])
        .unwrap_or_else(|| "0".to_owned());
    let sku = psm(
        record,
        &["sku", "productcode", "identifier", "variants.0.sku"],
        100,
    );
    let compare_at = ps(record, &["regular_price", "variants.0.compare_at_price"]);
    let shopify_variant_count = record
        .get("variants")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let has_variants =
        record.get("type").and_then(Value::as_str) == Some("variable") || shopify_variant_count > 1;
    let variants = map_variants(record);
    let inventory = picqer_free_stock(record)
        .or_else(|| pick_number(record, &["stock_quantity", "variants.0.inventory_quantity"]));
    let track_inventory = if record.get("unlimitedstock") == Some(&Value::Bool(true)) {
        false
    } else {
        record.get("manage_stock") == Some(&Value::Bool(true))
            || ps(record, &["variants.0.inventory_management"]).as_deref() == Some("shopify")
            || record.get("stock").is_some_and(Value::is_array)
    };
    let created = ps(record, &["date_created_gmt", "date_created", "created_at"]);
    let featured = images
        .first()
        .and_then(|i| i.get("url").and_then(Value::as_str).map(str::to_owned))
        .or_else(|| psm(record, &["image.src", "images.0.src"], 500));
    let values = compact(vec![
        ("name", json!(name)),
        ("slug", json!(slug)),
        ("sku", opt(sku)),
        ("barcode", opt(psm(record, &["barcode"], 100))),
        (
            "description",
            opt(ps(record, &["description", "body_html"])),
        ),
        (
            "shortDescription",
            opt(psm(record, &["short_description"], 500)),
        ),
        ("price", json!(price)),
        ("compareAtPrice", opt(compare_at.filter(|c| *c != price))),
        (
            "currency",
            json!(psm(record, &["currency"], 3).unwrap_or_else(|| "EUR".to_owned())),
        ),
        ("status", json!(status)),
        ("featuredImageUrl", opt(featured)),
        (
            "images",
            if images.is_empty() {
                Value::Null
            } else {
                Value::Array(images)
            },
        ),
        ("weight", opt(ps(record, &["weight", "variants.0.weight"]))),
        ("length", opt(ps(record, &["dimensions.length"]))),
        ("width", opt(ps(record, &["dimensions.width"]))),
        ("height", opt(ps(record, &["dimensions.height"]))),
        ("trackInventory", json!(track_inventory)),
        ("inventoryQuantity", num(inventory)),
        ("hasVariants", json!(has_variants)),
        (
            "variantCount",
            json!(if has_variants { variants.len() } else { 0 }),
        ),
        (
            "productType",
            opt(psm(record, &["type", "product_type"], 100)),
        ),
        ("vendor", opt(psm(record, &["vendor"], 255))),
        (
            "publishedAt",
            created.map_or(Value::Null, |c| date_value(&c)),
        ),
    ]);
    Some(Mapped::Product {
        external_id: external_id.to_owned(),
        external_url: psm(record, &["permalink", "url"], 500),
        values,
        variants: (has_variants && !variants.is_empty()).then_some(variants),
    })
}

/// `mapAddress(source)`.
fn map_address(source: Option<&Value>) -> Value {
    let Some(source) = source.filter(|s| !s.is_null()) else {
        return Value::Null;
    };
    let name = join_names(&[
        ps(source, &["first_name", "firstname"]),
        ps(source, &["last_name", "lastname"]),
    ]);
    let pairs = vec![
        (
            "line1",
            ps(source, &["address_1", "address1", "line1", "street"]),
        ),
        ("line2", ps(source, &["address_2", "address2", "line2"])),
        ("city", ps(source, &["city"])),
        ("state", ps(source, &["state", "province"])),
        (
            "postalCode",
            ps(source, &["postcode", "postal_code", "zip", "zipcode"]),
        ),
        ("country", ps(source, &["country"])),
        ("name", (!name.is_empty()).then_some(name)),
        ("phone", ps(source, &["phone"])),
    ];
    let map: Map<String, Value> = pairs
        .into_iter()
        .filter_map(|(k, v)| {
            v.filter(|v| !v.is_empty())
                .map(|v| (k.to_owned(), json!(v)))
        })
        .collect();
    if map.is_empty() {
        Value::Null
    } else {
        Value::Object(map)
    }
}

/// `pickString(...) && pickString(...) !== '0' ? pickString(...) : null`.
fn nonzero(value: Option<String>) -> Option<String> {
    value.filter(|v| v != "0")
}

fn map_order(record: &Value, external_id: &str, provider: &str) -> Option<Mapped> {
    let order_number = psm(
        record,
        &[
            "number",
            "name",
            "orderid",
            "order_number",
            "reference",
            "id",
        ],
        50,
    )?;
    let wc_status =
        ps(record, &["status", "financial_status"]).unwrap_or_else(|| "pending".to_owned());
    // `record.billing ?? record.billing_address ?? undefined`: any present value.
    let present = |key: &str| record.get(key).filter(|v| !v.is_null()).cloned();
    let billing = present("billing").or_else(|| present("billing_address"));
    let shipping = present("shipping")
        .or_else(|| present("shipping_address"))
        .or_else(|| {
            (provider == "picqer").then(|| {
                let mut m = Map::new();
                let mut put = |k: &str, v: Option<String>| {
                    if let Some(v) = v {
                        m.insert(k.to_owned(), json!(v));
                    }
                };
                put("address_1", ps(record, &["deliveryname", "address"]));
                put("address1", ps(record, &["address"]));
                put("address_2", ps(record, &["address2"]));
                put("city", ps(record, &["city"]));
                put("zip", ps(record, &["zipcode"]));
                put("country", ps(record, &["country"]));
                put("phone", ps(record, &["telephone"]));
                Value::Object(m)
            })
        });
    let customer = present("customer");
    let empty = json!({});
    let billing_ref = billing.as_ref().unwrap_or(&empty);
    let customer_ref = customer.as_ref().unwrap_or(&empty);
    let customer_name = {
        let from_billing = join_names(&[
            ps(billing_ref, &["first_name"]),
            ps(billing_ref, &["last_name"]),
        ]);
        let from_customer = join_names(&[
            ps(customer_ref, &["first_name"]),
            ps(customer_ref, &["last_name"]),
        ]);
        if !from_billing.is_empty() {
            Some(from_billing)
        } else if !from_customer.is_empty() {
            Some(from_customer)
        } else {
            ps(record, &["customer_name", "deliveryname", "name"])
        }
    };
    let lines_raw = first_array(&[record.get("line_items"), record.get("products")]);
    let paid_at = ps(record, &["date_paid_gmt", "date_paid", "processed_at"]);
    let financial = ps(record, &["financial_status"]);
    let paid = paid_at.is_some()
        || matches!(wc_status.as_str(), "completed" | "processing")
        || financial.as_deref() == Some("paid");
    let mapped_status = lookup(&PICQER_ORDER_STATUS, &wc_status)
        .or_else(|| lookup(&ORDER_STATUS, &wc_status))
        .unwrap_or(if wc_status == "paid" {
            "processing"
        } else {
            "pending"
        });
    let contact_source = billing.as_ref().unwrap_or(record);
    let total_quantity: f64 = lines_raw
        .iter()
        .map(|item| pick_number(item, &["quantity", "amount"]).unwrap_or(0.0))
        .sum();
    let completed = if mapped_status == "completed" {
        ps(
            record,
            &[
                "date_completed_gmt",
                "date_modified_gmt",
                "updated_at",
                "completed_at",
            ],
        )
    } else {
        None
    };
    let values = compact(vec![
        (
            "orderNumber",
            json!(order_number.strip_prefix('#').unwrap_or(&order_number)),
        ),
        (
            "externalOrderId",
            json!(ps(record, &["reference"]).unwrap_or_else(|| external_id.to_owned())),
        ),
        ("sourceOrderId", json!(external_id)),
        ("source", json!(provider)),
        (
            "customerEmail",
            opt(psm(
                contact_source,
                &["email", "emailaddress", "billing.email", "contact_email"],
                255,
            )),
        ),
        (
            "customerName",
            opt(customer_name.map(|n| slice_units(&n, 255))),
        ),
        (
            "customerPhone",
            opt(psm(contact_source, &["phone", "telephone"], 50)),
        ),
        ("status", json!(mapped_status)),
        (
            "paymentStatus",
            json!(if paid { "paid" } else { "pending" }),
        ),
        (
            "currency",
            json!(psm(record, &["currency"], 3).unwrap_or_else(|| "EUR".to_owned())),
        ),
        (
            "subtotal",
            json!(ps(record, &["subtotal", "subtotal_price"]).unwrap_or_else(|| "0".to_owned())),
        ),
        (
            "discountTotal",
            json!(
                ps(record, &["discount_total", "total_discounts"])
                    .unwrap_or_else(|| "0".to_owned())
            ),
        ),
        (
            "shippingTotal",
            json!(
                ps(
                    record,
                    &[
                        "shipping_total",
                        "total_shipping_price_set.shop_money.amount"
                    ]
                )
                .unwrap_or_else(|| "0".to_owned())
            ),
        ),
        (
            "taxTotal",
            json!(ps(record, &["total_tax"]).unwrap_or_else(|| "0".to_owned())),
        ),
        (
            "total",
            json!(ps(record, &["total", "total_price"]).unwrap_or_else(|| "0".to_owned())),
        ),
        ("billingAddress", map_address(billing.as_ref())),
        ("shippingAddress", map_address(shipping.as_ref())),
        (
            "paymentMethod",
            opt(psm(
                record,
                &["payment_method_title", "payment_method", "gateway"],
                100,
            )),
        ),
        ("paidAt", paid_at.as_deref().map_or(Value::Null, date_value)),
        (
            "customerNote",
            opt(ps(record, &["customer_note", "note", "remarks"])),
        ),
        ("itemCount", json!(lines_raw.len())),
        ("totalQuantity", number_value(total_quantity)),
        (
            "fulfillmentStatus",
            if mapped_status == "completed" {
                json!("fulfilled")
            } else {
                Value::Null
            },
        ),
        (
            "completedAt",
            completed.as_deref().map_or(Value::Null, date_value),
        ),
    ]);
    let customer_external_id = nonzero(ps(record, &["customer_id", "idcustomer"]))
        .or_else(|| ps(customer_ref, &["id", "idcustomer"]));
    let line_items = lines_raw
        .iter()
        .map(|item| OrderLine {
            external_line_id: ps(item, &["idorder_product", "id"]),
            external_product_id: nonzero(ps(item, &["product_id", "idproduct"])),
            sku: psm(item, &["sku", "productcode"], 100),
            name: psm(item, &["name", "title"], 255).unwrap_or_else(|| "Item".to_owned()),
            quantity: pick_number(item, &["quantity", "amount"]).unwrap_or(1.0),
            unit_price: ps(item, &["price", "subtotal"]).unwrap_or_else(|| "0".to_owned()),
            total: ps(item, &["total", "price"]).unwrap_or_else(|| "0".to_owned()),
            image_url: psm(item, &["image.src"], 500),
        })
        .collect();
    Some(Mapped::Order {
        external_id: external_id.to_owned(),
        values,
        line_items,
        customer_external_id,
    })
}

fn map_person(record: &Value, external_id: &str, provider: &str) -> Option<Mapped> {
    let email = psm(record, &["email", "emailaddress", "billing.email"], 255);
    let first = psm(
        record,
        &[
            "first_name",
            "firstname",
            "billing.first_name",
            "contactname",
        ],
        100,
    );
    let last = psm(record, &["last_name", "lastname", "billing.last_name"], 100);
    let company_or_name = psm(record, &["name", "company_name"], 255);
    let joined = join_names(&[first.clone(), last.clone()]);
    let full = if joined.is_empty() {
        company_or_name.clone().or_else(|| email.clone())?
    } else {
        joined
    };
    let billing = record
        .get("billing")
        .filter(|v| !v.is_null())
        .or_else(|| record.get("default_address").filter(|v| !v.is_null()))
        .unwrap_or(record);
    let mut address_source = billing.as_object().cloned().unwrap_or_default();
    address_source.insert(
        "address_1".to_owned(),
        opt(ps(billing, &["address_1", "address", "address1"])),
    );
    address_source.insert(
        "postcode".to_owned(),
        opt(ps(billing, &["postcode", "zipcode", "zip"])),
    );
    let first_name = first.or_else(|| company_or_name.filter(|_| last.is_none()));
    let values = compact(vec![
        ("firstName", opt(first_name)),
        ("lastName", opt(last)),
        ("fullName", json!(full)),
        ("displayName", json!(slice_units(&full, 255))),
        ("email", opt(email)),
        (
            "directPhone",
            opt(psm(billing, &["phone", "telephone"], 50)),
        ),
        ("avatarUrl", opt(psm(record, &["avatar_url"], 1000))),
        (
            "primaryAddress",
            map_address(Some(&Value::Object(address_source))),
        ),
        ("source", json!(provider)),
        ("inCrm", json!(true)),
        ("status", json!("active")),
    ]);
    Some(Mapped::Person {
        external_id: external_id.to_owned(),
        values,
    })
}

/// `isDeletedRecord(record, forceDeleted)`.
pub fn is_deleted_record(record: &Value, force_deleted: bool) -> bool {
    if force_deleted {
        return true;
    }
    matches!(
        ps(record, &["status"]).as_deref(),
        Some("trash" | "deleted")
    )
}

/// `externalIdOf(record)`.
pub fn external_id_of(record: &Value) -> Option<String> {
    psm(
        record,
        &[
            "id",
            "external_id",
            "entity_id",
            "idproduct",
            "idorder",
            "idcustomer",
            "idwarehouse",
            "idlocation",
            "idpicklist",
            "idshipment",
            "idsupplier",
            "idpurchaseorder",
            "idreturn",
            "idmovement",
            "idlocation_stock_count",
        ],
        255,
    )
}

/// `modifiedAtOf(record)`.
pub fn modified_at_of(record: &Value) -> Option<String> {
    ps(
        record,
        &[
            "date_modified_gmt",
            "date_modified",
            "updated_at",
            "updated_at_formatted",
            "date_created_gmt",
            "created_at",
            "created",
        ],
    )
}

/// Moneybird sales invoice `state` → WeldBooks invoice status.
const INVOICE_STATUS: [(&str, &str); 8] = [
    ("draft", "draft"),
    // Sends itself on a later date: not sent yet.
    ("scheduled", "draft"),
    ("open", "sent"),
    // Sent, waiting for the direct debit to be collected.
    ("pending_payment", "sent"),
    // Moneybird sends reminders once an invoice is past due.
    ("reminded", "overdue"),
    ("late", "overdue"),
    ("paid", "paid"),
    ("uncollectible", "uncollectible"),
];

/// Invoice statuses WeldBooks knows (books-api `invoiceStatusSchema`).
const KNOWN_INVOICE_STATUSES: [&str; 8] = [
    "draft",
    "sent",
    "paid",
    "overdue",
    "partial",
    "cancelled",
    "uncollectible",
    "finalized",
];

/// Bill statuses WeldBooks knows.
const KNOWN_BILL_STATUSES: [&str; 6] = [
    "draft",
    "approved",
    "partial",
    "overdue",
    "paid",
    "cancelled",
];

/// Moneybird purchase invoice / receipt `state` → WeldBooks bill status.
const BILL_STATUS: [(&str, &str); 6] = [
    ("new", "draft"),
    ("saved", "draft"),
    ("open", "approved"),
    ("pending_payment", "approved"),
    ("late", "overdue"),
    ("paid", "paid"),
];

/// `parseDate(value)`: the ISO string, `None` for a missing or invalid date.
fn parse_date(value: Option<String>) -> Option<String> {
    js_date_loose(&value?).and_then(weldsuite_kit::validation::js_iso_from_millis)
}

/// `value.replace(',', '.')`: the first comma only.
fn first_comma_to_dot(value: &str) -> String {
    value.replacen(',', ".", 1)
}

/// `decimalString(value, fallback)`.
fn decimal_string(value: Option<&str>, fallback: &str) -> String {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return fallback.to_owned();
    };
    let cleaned: String = first_comma_to_dot(value)
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    let parsed = weldsuite_kit::validation::js_number(&cleaned);
    if parsed.is_finite() {
        to_fixed(parsed, 2)
    } else {
        fallback.to_owned()
    }
}

/// `quantityString(value)`.
fn quantity_string(value: Option<&str>) -> String {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return "1".to_owned();
    };
    let text = first_comma_to_dot(value);
    let bytes = text.as_bytes();
    let mut found: Option<String> = None;
    for start in 0..bytes.len() {
        let mut i = start;
        if bytes[i] == b'-' {
            i += 1;
        }
        let digits_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == digits_start {
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'.' && bytes[i + 1].is_ascii_digit() {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
        }
        found = Some(text[start..i].to_owned());
        break;
    }
    let Some(found) = found else {
        return "1".to_owned();
    };
    let parsed = weldsuite_kit::validation::js_number(&found);
    if parsed.is_finite() && parsed != 0.0 {
        number_text(parsed)
    } else {
        "1".to_owned()
    }
}

/// `decimalNumber(source, paths)`: `decimalString`'s parsing as a number.
fn decimal_number(source: &Value, paths: &[&str]) -> Option<f64> {
    let raw = ps(source, paths)?;
    let cleaned: String = first_comma_to_dot(&raw)
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    let parsed = weldsuite_kit::validation::js_number(&cleaned);
    parsed.is_finite().then_some(parsed)
}

/// `taxRatesFromTotals(record)`: the VAT percentage per Moneybird tax rate
/// id. Lines name their rate by `tax_rate_id` only; the invoice's
/// `tax_totals` give the tax and the taxable amount per rate.
fn tax_rates_from_totals(record: &Value) -> Vec<(String, f64)> {
    let mut rates: Vec<(String, f64)> = Vec::new();
    for row in records(record.get("tax_totals")) {
        let Some(id) = ps(&row, &["tax_rate_id"]) else {
            continue;
        };
        let (Some(taxable), Some(tax)) = (
            decimal_number(&row, &["taxable_amount"]),
            decimal_number(&row, &["tax_amount"]),
        ) else {
            continue;
        };
        if taxable == 0.0 {
            continue;
        }
        let rate = weldsuite_kit::validation::js_number(&to_fixed(tax / taxable * 100.0, 2));
        match rates.iter_mut().find(|(known, _)| *known == id) {
            Some(entry) => entry.1 = rate,
            None => rates.push((id, rate)),
        }
    }
    rates
}

/// `pricesIncludeTax(record)`: Moneybird's `prices_are_incl_tax`.
fn prices_include_tax(record: &Value) -> bool {
    match record.get("prices_are_incl_tax") {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::String(text)) => text == "true",
        _ => false,
    }
}

pub(crate) fn map_document_lines(record: &Value) -> Vec<DocumentLine> {
    let rates = tax_rates_from_totals(record);
    let inclusive = prices_include_tax(record);
    first_array(&[record.get("details"), record.get("line_items")])
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let quantity = quantity_string(ps(item, &["amount", "quantity"]).as_deref());
            let derived_rate = ps(item, &["tax_rate_id"]).and_then(|id| {
                rates
                    .iter()
                    .find(|(known, _)| *known == id)
                    .map(|(_, rate)| *rate)
            });
            let price = decimal_string(ps(item, &["price", "unit_price"]).as_deref(), "0");
            // WeldBooks unit prices exclude VAT; back it out of an incl-VAT price.
            let unit_price = match derived_rate {
                Some(rate) if inclusive => to_fixed(
                    weldsuite_kit::validation::js_number(&price) / (1.0 + rate / 100.0),
                    4,
                ),
                _ => price,
            };
            let n = |t: &str| {
                let v = weldsuite_kit::validation::js_number(t);
                if v.is_nan() || v == 0.0 {
                    None
                } else {
                    Some(v)
                }
            };
            let fallback = number_text(n(&quantity).unwrap_or(1.0) * n(&unit_price).unwrap_or(0.0));
            let line_excl = decimal_string(
                ps(
                    item,
                    &[
                        "total_price_excl_tax_with_discount",
                        "total_price_excl_tax",
                        "total",
                    ],
                )
                .as_deref(),
                &fallback,
            );
            let derived_tax = derived_rate.map(|rate| {
                to_fixed(
                    weldsuite_kit::validation::js_number(&line_excl) * rate / 100.0,
                    2,
                )
            });
            let incl_fallback = match &derived_tax {
                Some(tax) => to_fixed(
                    weldsuite_kit::validation::js_number(&line_excl)
                        + weldsuite_kit::validation::js_number(tax),
                    2,
                ),
                None => line_excl.clone(),
            };
            let line_incl = decimal_string(
                ps(
                    item,
                    &["total_price_incl_tax_with_discount", "total_price_incl_tax"],
                )
                .as_deref(),
                &incl_fallback,
            );
            DocumentLine {
                external_product_id: nonzero(ps(item, &["product_id"])),
                description: psm(item, &["description", "name"], 2000)
                    .unwrap_or_else(|| "Item".to_owned()),
                quantity,
                unit_price,
                tax_rate: ps(item, &["tax_rate", "tax"])
                    .or_else(|| derived_rate.map(|rate| to_fixed(rate, 2))),
                tax_amount: ps(item, &["tax_amount", "tax"]).or(derived_tax),
                line_total: Some(line_excl),
                line_total_with_tax: Some(line_incl),
                sort_order: index,
                period: None,
            }
        })
        .collect()
}

/// `documentTaxTotal(record, subtotal, total)`: the sum of Moneybird's
/// `tax_totals`, else a total the record carries itself, else the difference
/// between the totals incl. and excl. VAT.
fn document_tax_total(record: &Value, subtotal: &str, total: &str) -> String {
    let totals = records(record.get("tax_totals"));
    if !totals.is_empty() {
        let sum = totals.iter().fold(0.0, |sum, row| {
            sum + decimal_number(row, &["tax_amount"]).unwrap_or(0.0)
        });
        return to_fixed(sum, 2);
    }
    if let Some(explicit) = ps(record, &["total_tax", "tax_total"]) {
        return decimal_string(Some(&explicit), "0");
    }
    let has_both = ps(record, &["total_price_incl_tax", "total"]).is_some()
        && ps(record, &["total_price_excl_tax", "subtotal"]).is_some();
    if has_both {
        to_fixed(
            weldsuite_kit::validation::js_number(total)
                - weldsuite_kit::validation::js_number(subtotal),
            2,
        )
    } else {
        "0".to_owned()
    }
}

/// `paidAmounts(record, total, paid)`: (paid so far, still due). Sales
/// invoices carry `total_paid` / `total_unpaid`; purchase invoices and
/// receipts only their `payments`. A paid document is paid in full.
fn paid_amounts(record: &Value, total: &str, paid: bool) -> (String, String) {
    if paid {
        return (total.to_owned(), "0".to_owned());
    }
    if let Some(total_paid) = decimal_number(record, &["total_paid"]) {
        let due = decimal_number(record, &["total_unpaid"])
            .unwrap_or_else(|| weldsuite_kit::validation::js_number(total) - total_paid);
        return (to_fixed(total_paid, 2), to_fixed(due, 2));
    }
    let payments = records(record.get("payments"));
    if !payments.is_empty() {
        let sum = payments.iter().fold(0.0, |sum, payment| {
            sum + decimal_number(payment, &["price"]).unwrap_or(0.0)
        });
        return (
            to_fixed(sum, 2),
            to_fixed(weldsuite_kit::validation::js_number(total) - sum, 2),
        );
    }
    ("0".to_owned(), total.to_owned())
}

/// `withPartialPayment(status, amounts)`: an open document with part of it
/// paid is `partial`.
fn with_partial_payment(status: &'static str, paid: &str, due: &str) -> &'static str {
    if !matches!(status, "sent" | "overdue" | "approved") {
        return status;
    }
    let part = |text: &str| weldsuite_kit::validation::js_number(text) != 0.0;
    if part(paid) && part(due) {
        "partial"
    } else {
        status
    }
}

fn nested_contact(record: &Value) -> Option<Value> {
    record.get("contact").filter(|c| c.is_object()).cloned()
}

fn map_party(record: &Value, external_id: &str, provider: &str) -> Option<Mapped> {
    let company = psm(record, &["company_name", "companyName"], 255);
    let first = psm(record, &["firstname", "first_name"], 100);
    let last = psm(record, &["lastname", "last_name"], 100);
    let email = psm(record, &["email", "send_invoices_to_email"], 255);
    let joined = join_names(&[first.clone(), last.clone()]);
    let person_name = if joined.is_empty() {
        email.clone()
    } else {
        Some(joined)
    };
    let kind = if company.is_some() {
        "company"
    } else {
        "person"
    };
    let display = if kind == "company" {
        company.clone()
    } else {
        person_name.clone()
    }
    .filter(|d| !d.is_empty())
    .or_else(|| email.clone())?;
    let address = map_address(Some(record));
    let phone = psm(record, &["phone"], 50);
    let identity = if kind == "company" {
        compact(vec![
            ("name", opt(company)),
            ("displayName", json!(slice_units(&display, 255))),
            ("email", opt(email)),
            ("phone", opt(phone)),
            (
                "vatNumber",
                opt(psm(record, &["tax_number", "vat_number"], 50)),
            ),
            (
                "registrationNumber",
                opt(psm(record, &["chamber_of_commerce"], 100)),
            ),
            ("primaryAddress", address.clone()),
            ("source", json!(provider)),
            ("status", json!("active")),
            ("ownerId", Value::Null),
        ])
    } else {
        compact(vec![
            ("firstName", opt(first)),
            ("lastName", opt(last)),
            ("fullName", opt(person_name)),
            ("displayName", json!(slice_units(&display, 255))),
            ("email", opt(email)),
            ("directPhone", opt(phone)),
            ("primaryAddress", address.clone()),
            ("source", json!(provider)),
            ("status", json!("active")),
            ("inCrm", json!(false)),
        ])
    };
    let values = compact(vec![
        ("kind", json!(kind)),
        ("displayName", json!(slice_units(&display, 255))),
        ("billingAddress", address),
        ("iban", opt(psm(record, &["sepa_iban", "iban"], 34))),
        ("bic", opt(psm(record, &["sepa_bic", "bic"], 11))),
        ("partyCode", opt(psm(record, &["customer_id"], 50))),
        ("status", json!("active")),
        ("role", json!("none")),
    ]);
    Some(Mapped::Party {
        external_id: external_id.to_owned(),
        kind,
        identity,
        values,
    })
}

fn map_document(record: &Value, external_id: &str, entity: &'static str) -> Option<Mapped> {
    let invoice = entity == "invoice";
    let number = if invoice {
        psm(
            record,
            &["invoice_id", "invoice_number", "reference", "id"],
            50,
        )?
    } else {
        psm(record, &["reference", "invoice_id", "id"], 50)?
    };
    let state = ps(record, &["state", "status"])
        .unwrap_or_else(|| if invoice { "draft" } else { "new" }.to_owned())
        .to_lowercase();
    let issue = parse_date(ps(
        record,
        if invoice {
            &["invoice_date", "date", "created_at"]
        } else {
            &["date", "invoice_date", "created_at"]
        },
    ))
    .unwrap_or_else(crate::js::now_iso);
    let due = parse_date(ps(record, &["due_date"])).unwrap_or_else(|| issue.clone());
    let paid_at = parse_date(ps(record, &["paid_at"]));
    let nested = nested_contact(record);
    let empty = json!({});
    let nested_ref = nested.as_ref().unwrap_or(&empty);
    let contact_name = ps(nested_ref, &["company_name", "firstname"])
        .or_else(|| ps(record, &["contact.company_name", "contact_name"]));
    let subtotal = decimal_string(
        ps(record, &["total_price_excl_tax", "subtotal"]).as_deref(),
        "0",
    );
    let total = decimal_string(
        ps(record, &["total_price_incl_tax", "total"]).as_deref(),
        "0",
    );
    let tax_total = document_tax_total(record, &subtotal, &total);
    let (amount_paid, balance_due) =
        paid_amounts(record, &total, paid_at.is_some() || state == "paid");
    let status = with_partial_payment(
        if invoice {
            lookup(&INVOICE_STATUS, &state).unwrap_or("draft")
        } else {
            lookup(&BILL_STATUS, &state).unwrap_or("draft")
        },
        &amount_paid,
        &balance_due,
    );
    let mut pairs = vec![
        (
            if invoice {
                "invoiceNumber"
            } else {
                "billNumber"
            },
            json!(number),
        ),
        ("type", json!("standard")),
        ("status", json!(status)),
        (
            "contactName",
            opt(contact_name.map(|n| slice_units(&n, 255))),
        ),
    ];
    if invoice {
        let source = nested.as_ref().unwrap_or(record);
        pairs.push((
            "contactEmail",
            opt(psm(source, &["email", "send_invoices_to_email"], 255)),
        ));
    }
    pairs.push(("issueDate", json!(issue)));
    pairs.push(("dueDate", json!(due)));
    pairs.push(("paidAt", opt(paid_at.clone())));
    if invoice {
        pairs.push((
            "sentAt",
            if status == "draft" {
                Value::Null
            } else {
                json!(issue)
            },
        ));
    }
    pairs.extend([
        (
            "currency",
            json!(psm(record, &["currency"], 3).unwrap_or_else(|| "EUR".to_owned())),
        ),
        ("exchangeRate", opt(document_exchange_rate(record))),
        ("subtotal", json!(subtotal)),
        ("taxTotal", json!(tax_total)),
        ("total", json!(total)),
        ("amountPaid", json!(amount_paid)),
        ("balanceDue", json!(balance_due)),
        ("reference", opt(psm(record, &["reference"], 255))),
        ("notes", opt(ps(record, &["notes"]))),
        ("journalEntryId", Value::Null),
    ]);
    Some(Mapped::Document {
        entity,
        external_id: external_id.to_owned(),
        contact_external_id: nonzero(ps(record, &["contact_id"]))
            .or_else(|| ps(nested_ref, &["id"])),
        nested_contact: nested,
        values: compact(pairs),
        line_items: map_document_lines(record),
    })
}

/// `documentExchangeRate(record)`: units of the document's currency per unit
/// of the administration's base currency (WeldBooks converts with
/// `amount / exchangeRate`), from Moneybird's totals and their `_base`
/// twins: incl. tax first, else excl. tax. `None` when neither pair gives a
/// positive ratio (a zero total, or no `_base` totals).
fn document_exchange_rate(record: &Value) -> Option<String> {
    [
        ("total_price_incl_tax", "total_price_incl_tax_base"),
        ("total_price_excl_tax", "total_price_excl_tax_base"),
    ]
    .into_iter()
    .find_map(|(amount, base)| {
        let amount = pick_number(record, &[amount])?;
        let base = pick_number(record, &[base])?;
        let rate = amount / base;
        (amount != 0.0 && base != 0.0 && rate.is_finite() && rate > 0.0)
            .then(|| format!("{rate:.6}"))
    })
}

/// `IBAN_LENGTHS`: each IBAN country's IBAN length (the ISO 13616 registry).
const IBAN_LENGTHS: [(&str, usize); 87] = [
    ("AD", 24),
    ("AE", 23),
    ("AL", 28),
    ("AT", 20),
    ("AZ", 28),
    ("BA", 20),
    ("BE", 16),
    ("BG", 22),
    ("BH", 22),
    ("BI", 27),
    ("BR", 29),
    ("BY", 28),
    ("CH", 21),
    ("CR", 22),
    ("CY", 28),
    ("CZ", 24),
    ("DE", 22),
    ("DJ", 27),
    ("DK", 18),
    ("DO", 28),
    ("EE", 20),
    ("EG", 29),
    ("ES", 24),
    ("FI", 18),
    ("FK", 18),
    ("FO", 18),
    ("FR", 27),
    ("GB", 22),
    ("GE", 22),
    ("GI", 23),
    ("GL", 18),
    ("GR", 27),
    ("GT", 28),
    ("HR", 21),
    ("HU", 28),
    ("IE", 22),
    ("IL", 23),
    ("IQ", 23),
    ("IS", 26),
    ("IT", 27),
    ("JO", 30),
    ("KW", 30),
    ("KZ", 20),
    ("LB", 28),
    ("LC", 32),
    ("LI", 21),
    ("LT", 20),
    ("LU", 20),
    ("LV", 21),
    ("LY", 25),
    ("MC", 27),
    ("MD", 24),
    ("ME", 22),
    ("MK", 19),
    ("MN", 20),
    ("MR", 27),
    ("MT", 31),
    ("MU", 30),
    ("NI", 28),
    ("NL", 18),
    ("NO", 15),
    ("OM", 23),
    ("PK", 24),
    ("PL", 28),
    ("PS", 29),
    ("PT", 25),
    ("QA", 29),
    ("RO", 24),
    ("RS", 22),
    ("RU", 33),
    ("SA", 24),
    ("SC", 31),
    ("SD", 18),
    ("SE", 24),
    ("SI", 19),
    ("SK", 24),
    ("SM", 27),
    ("SO", 23),
    ("ST", 25),
    ("SV", 28),
    ("TL", 23),
    ("TN", 24),
    ("TR", 26),
    ("UA", 29),
    ("VA", 22),
    ("VG", 24),
    ("XK", 20),
];

/// `looksLikeIban(value)`: the value without whitespace, upper-cased, when it
/// is an IBAN: two letters, two check digits and letters or digits, as long
/// as its country's IBAN, with an ISO 7064 mod-97 remainder of 1. A
/// Moneybird account identifier that only looks like one (a payment
/// provider's account id) is not.
pub(crate) fn looks_like_iban(value: Option<&str>) -> Option<String> {
    let compact: String = value?
        .chars()
        .filter(|c| !js_space(*c))
        .collect::<String>()
        .to_uppercase();
    let bytes = compact.as_bytes();
    if bytes.len() < 5
        || !bytes[..2].iter().all(u8::is_ascii_uppercase)
        || !bytes[2..4].iter().all(u8::is_ascii_digit)
        || !bytes[4..]
            .iter()
            .all(|b| b.is_ascii_digit() || b.is_ascii_uppercase())
    {
        return None;
    }
    let (_, length) = IBAN_LENGTHS
        .iter()
        .find(|(country, _)| country.as_bytes() == &bytes[..2])?;
    if bytes.len() != *length {
        return None;
    }
    // The first four characters move to the end; letters count as 10..35.
    let remainder = bytes[4..]
        .iter()
        .chain(&bytes[..4])
        .fold(0u32, |acc, b| match b {
            b'0'..=b'9' => (acc * 10 + u32::from(b - b'0')) % 97,
            _ => (acc * 100 + u32::from(b - b'A') + 10) % 97,
        });
    (remainder == 1).then_some(compact)
}

fn map_bank_account(record: &Value, external_id: &str) -> Mapped {
    let identifier = psm(record, &["identifier"], 100);
    let name = psm(record, &["name"], 255)
        .or_else(|| identifier.clone())
        .or_else(|| psm(record, &["provider"], 255))
        .unwrap_or_else(|| format!("Moneybird account {external_id}"));
    let iban = looks_like_iban(identifier.as_deref());
    let active = match record.get("active") {
        None => true,
        Some(v) => crate::js::truthy(v),
    };
    let values = compact(vec![
        ("name", json!(slice_units(&name, 255))),
        ("iban", opt(iban)),
        (
            "currency",
            json!(psm(record, &["currency"], 3).unwrap_or_else(|| "EUR".to_owned())),
        ),
        ("bankName", opt(psm(record, &["provider", "type"], 255))),
        ("isActive", json!(active)),
        (
            "metadata",
            json!({
                "moneybirdType": ps(record, &["type"]),
                "moneybirdIdentifier": identifier,
                "moneybirdAccount": record.get("moneybird_account") == Some(&Value::Bool(true)),
            }),
        ),
    ]);
    Mapped::BankAccount {
        external_id: external_id.to_owned(),
        values,
    }
}

fn map_bank_transaction(record: &Value, external_id: &str) -> Option<Mapped> {
    let raw = ps(record, &["amount", "original_amount"])?;
    let amount = decimal_string(Some(&raw), "");
    if amount.is_empty() || !weldsuite_kit::validation::js_number(&amount).is_finite() {
        return None;
    }
    let date = parse_date(ps(record, &["date", "created_at", "processed_at"]))?;
    let state = ps(record, &["state"])
        .unwrap_or_else(|| "unprocessed".to_owned())
        .to_lowercase();
    let settlement = ps(record, &["settlement_state"])
        .unwrap_or_default()
        .to_lowercase();
    // A payment that never went through (a refused direct debit, a cancelled
    // or expired card authorisation) stays visible, out of balances.
    let void = VOID_SETTLEMENT_STATES.contains(&settlement.as_str());
    let status = if void {
        "excluded"
    } else if state == "processed" || state == "auto_booked" {
        "reconciled"
    } else {
        "unreconciled"
    };
    let contra = psm(record, &["contra_account_number"], 50);
    let description = ps(record, &["message"])
        .or_else(|| ps(record, &["batch_reference"]))
        .or_else(|| ps(record, &["code"]));
    let counterparty_iban = looks_like_iban(contra.as_deref()).or_else(|| {
        let compact: Option<String> = contra
            .as_ref()
            .map(|c| c.chars().filter(|ch| !js_space(*ch)).collect());
        compact
            .filter(|c| {
                !contra.as_deref().unwrap_or_default().is_empty() && c.encode_utf16().count() <= 34
            })
            .map(|c| slice_units(&c, 34))
    });
    let values = compact(vec![
        ("date", json!(date)),
        ("valueDate", json!(date)),
        ("amount", json!(amount)),
        ("description", opt(description)),
        (
            "counterpartyName",
            opt(psm(record, &["contra_account_name"], 255)),
        ),
        ("counterpartyIban", opt(counterparty_iban)),
        (
            "reference",
            opt(psm(
                record,
                &["batch_reference", "code", "account_servicer_transaction_id"],
                255,
            )),
        ),
        ("externalId", json!(external_id)),
        ("status", json!(status)),
        ("rawData", record.clone()),
    ]);
    // The first payment of a type names what the mutation settles.
    let paid = |invoice_type: &str| -> Option<String> {
        if void {
            return None;
        }
        records(record.get("payments"))
            .iter()
            .find(|p| p.get("invoice_type").and_then(Value::as_str) == Some(invoice_type))
            .and_then(|p| nonzero(ps(p, &["invoice_id"])))
    };
    Some(Mapped::BankTransaction {
        external_id: external_id.to_owned(),
        financial_account_external_id: ps(record, &["financial_account_id"]),
        invoice_external_id: paid("SalesInvoice"),
        bill_external_id: paid("Document"),
        values,
    })
}

/// Moneybird's `settlement_state`s of a mutation that never settled: only
/// `settled`, `authorised` and `pending` ones can be booked.
const VOID_SETTLEMENT_STATES: [&str; 4] = ["cancelled", "expired", "refused", "error"];

// ── WMS (Picqer) ────────────────────────────────────────────────────────────

const PICKLIST_STATUS: [(&str, &str); 8] = [
    ("new", "pending"),
    ("open", "pending"),
    ("processing", "in_progress"),
    ("paused", "assigned"),
    ("closed", "completed"),
    ("snoozed", "pending"),
    ("cancelled", "cancelled"),
    ("canceled", "cancelled"),
];

const PO_STATUS: [(&str, &str); 5] = [
    ("concept", "draft"),
    ("purchased", "ordered"),
    ("received", "received"),
    ("cancelled", "cancelled"),
    ("canceled", "cancelled"),
];

const RETURN_STATUS: [(&str, &str); 6] = [
    ("concept", "requested"),
    ("expected", "approved"),
    ("received", "received"),
    ("cancelled", "cancelled"),
    ("canceled", "cancelled"),
    ("completed", "processed"),
];

fn wms(
    entity: &'static str,
    external_id: &str,
    links: Links,
    values: Map<String, Value>,
) -> Mapped {
    Mapped::Wms {
        entity,
        external_id: external_id.to_owned(),
        values,
        links,
    }
}

fn first_50(external_id: &str) -> String {
    slice_units(external_id, 50)
}

fn product_quantities(record: &Value, keys: &[&str]) -> (usize, f64) {
    let items = records(record.get("products"));
    let total = items
        .iter()
        .filter(|i| i.is_object() || i.is_array())
        .map(|i| pick_number(i, keys).unwrap_or(0.0))
        .sum();
    (items.len(), total)
}

#[allow(clippy::too_many_lines)]
fn map_wms(entity: &str, record: &Value, external_id: &str) -> Option<Mapped> {
    let source = json!({ "source": "picqer" });
    Some(match entity {
        "inventory" => {
            let on_hand = pick_number(record, &["stock", "quantityOnHand"]).unwrap_or(0.0);
            let available =
                pick_number(record, &["freestock", "quantityAvailable"]).unwrap_or(on_hand);
            let allocated = pick_number(record, &["reserved", "quantityAllocated"])
                .unwrap_or_else(|| (on_hand - available).max(0.0));
            wms(
                "inventory",
                external_id,
                Links {
                    product: ps(record, &["idproduct"]),
                    warehouse: ps(record, &["idwarehouse"]),
                    location: ps(record, &["idlocation"]),
                    ..Links::default()
                },
                compact(vec![
                    ("quantityOnHand", number_value(on_hand)),
                    ("quantityAvailable", number_value(available)),
                    ("quantityAllocated", number_value(allocated)),
                    ("status", json!("available")),
                    (
                        "metadata",
                        json!({ "picqerProductCode": ps(record, &["productcode"]), "source": "picqer" }),
                    ),
                ]),
            )
        }
        "warehouse" => {
            let name = psm(record, &["name"], 255)?;
            wms(
                "warehouse",
                external_id,
                Links::default(),
                compact(vec![
                    ("name", json!(name)),
                    (
                        "code",
                        json!(
                            psm(record, &["code", "idwarehouse"], 50)
                                .unwrap_or_else(|| first_50(external_id))
                        ),
                    ),
                    (
                        "isActive",
                        json!(
                            record.get("accepts_orders") != Some(&Value::Bool(false))
                                && record.get("active") != Some(&Value::Bool(false))
                        ),
                    ),
                    (
                        "isDefault",
                        json!(
                            record.get("priority").and_then(Value::as_f64) == Some(1.0)
                                || record.get("default") == Some(&Value::Bool(true))
                        ),
                    ),
                    (
                        "priority",
                        number_value(pick_number(record, &["priority"]).unwrap_or(0.0)),
                    ),
                    ("metadata", source),
                ]),
            )
        }
        "location" => wms(
            "location",
            external_id,
            Links {
                warehouse: ps(record, &["idwarehouse"]),
                ..Links::default()
            },
            compact(vec![
                (
                    "name",
                    json!(
                        psm(record, &["name", "remark"], 255)
                            .unwrap_or_else(|| format!("Location {external_id}"))
                    ),
                ),
                (
                    "code",
                    json!(
                        psm(record, &["name", "remark", "code"], 50)
                            .unwrap_or_else(|| first_50(external_id))
                    ),
                ),
                ("barcode", opt(psm(record, &["barcode"], 100))),
                (
                    "locationType",
                    json!(
                        if record.get("type").and_then(Value::as_str) == Some("bulk") {
                            "bulk"
                        } else {
                            "storage"
                        }
                    ),
                ),
                (
                    "isActive",
                    json!(record.get("active") != Some(&Value::Bool(false))),
                ),
                ("metadata", source),
            ]),
        ),
        "picklist" => {
            let number =
                psm(record, &["picklistid", "id"], 50).unwrap_or_else(|| external_id.to_owned());
            let status = lookup(
                &PICKLIST_STATUS,
                ps(record, &["status"]).as_deref().unwrap_or_default(),
            )
            .unwrap_or("pending");
            let (count, quantity) = product_quantities(record, &["amount", "quantity"]);
            let idorder = ps(record, &["idorder"]);
            let done = status == "completed";
            wms(
                "picklist",
                external_id,
                Links {
                    warehouse: ps(record, &["idwarehouse"]),
                    order: idorder.clone(),
                    ..Links::default()
                },
                compact(vec![
                    ("pickListNumber", json!(number)),
                    ("status", json!(status)),
                    (
                        "priority",
                        json!(if record.get("urgent") == Some(&Value::Bool(true)) {
                            "urgent"
                        } else {
                            "normal"
                        }),
                    ),
                    (
                        "assignedToName",
                        opt(psm(record, &["assigned_to_name", "picker"], 255)),
                    ),
                    ("totalItems", json!(count)),
                    ("totalQuantity", number_value(quantity)),
                    ("orderIds", json!([])),
                    ("orderCount", json!(i32::from(idorder.is_some()))),
                    ("pickType", json!("order")),
                    ("completedAt", if done { now_value() } else { Value::Null }),
                    ("shippedAt", if done { now_value() } else { Value::Null }),
                    ("notes", opt(ps(record, &["remarks"]))),
                    (
                        "metadata",
                        json!({ "source": "picqer", "idorder": idorder }),
                    ),
                ]),
            )
        }
        "shipment" => {
            let number = psm(record, &["trackingcode", "shipmentid", "id"], 50)
                .unwrap_or_else(|| format!("PICQER-{external_id}"));
            let created = ps(record, &["created", "created_at"]);
            wms(
                "shipment",
                external_id,
                Links {
                    picklist: ps(record, &["idpicklist"]),
                    ..Links::default()
                },
                compact(vec![
                    ("shipmentNumber", json!(number)),
                    (
                        "status",
                        json!(if record.get("cancelled") == Some(&Value::Bool(true)) {
                            "cancelled"
                        } else {
                            "shipped"
                        }),
                    ),
                    ("type", json!("outbound")),
                    (
                        "carrierName",
                        opt(psm(record, &["provider", "providername"], 255)),
                    ),
                    (
                        "shippedAt",
                        created.as_deref().map_or_else(now_value, date_value),
                    ),
                    ("internalNotes", opt(ps(record, &["trackingurl"]))),
                    (
                        "metadata",
                        json!({
                            "source": "picqer",
                            "trackingcode": ps(record, &["trackingcode"]),
                            "trackingurl": ps(record, &["trackingurl"]),
                        }),
                    ),
                ]),
            )
        }
        "supplier" => {
            let name = psm(record, &["name"], 255)?;
            wms(
                "supplier",
                external_id,
                Links::default(),
                compact(vec![
                    ("name", json!(name)),
                    (
                        "code",
                        json!(
                            psm(record, &["idsupplier"], 50)
                                .unwrap_or_else(|| first_50(external_id))
                        ),
                    ),
                    ("contactName", opt(psm(record, &["contactname"], 255))),
                    ("email", opt(psm(record, &["emailaddress", "email"], 255))),
                    ("phone", opt(psm(record, &["telephone", "phone"], 50))),
                    ("addressLine1", opt(psm(record, &["address"], 255))),
                    ("city", opt(psm(record, &["city"], 100))),
                    ("postalCode", opt(psm(record, &["zipcode"], 20))),
                    ("country", opt(psm(record, &["country"], 100))),
                    ("isActive", json!(true)),
                    ("status", json!("active")),
                    ("notes", opt(ps(record, &["remarks"]))),
                    ("metadata", source),
                ]),
            )
        }
        "purchase_order" => {
            let number = psm(record, &["purchaseorderid", "id"], 50)
                .unwrap_or_else(|| external_id.to_owned());
            let status = lookup(
                &PO_STATUS,
                ps(record, &["status"]).as_deref().unwrap_or_default(),
            )
            .unwrap_or("draft");
            let (count, quantity) = product_quantities(record, &["amount"]);
            let expected = ps(record, &["delivery_date"]);
            wms(
                "purchase_order",
                external_id,
                Links {
                    supplier: ps(record, &["idsupplier"]),
                    warehouse: ps(record, &["idwarehouse"]),
                    ..Links::default()
                },
                compact(vec![
                    ("poNumber", json!(number)),
                    (
                        "supplierName",
                        opt(psm(record, &["supplier_name", "supplier"], 255)),
                    ),
                    ("status", json!(status)),
                    (
                        "expectedDate",
                        expected.as_deref().map_or(Value::Null, date_value),
                    ),
                    ("itemCount", json!(count)),
                    ("totalQuantityOrdered", number_value(quantity)),
                    ("supplierNotes", opt(ps(record, &["remarks"]))),
                    ("metadata", source),
                ]),
            )
        }
        "return" => {
            let number =
                psm(record, &["returnid", "id"], 50).unwrap_or_else(|| external_id.to_owned());
            let status = lookup(
                &RETURN_STATUS,
                ps(record, &["status"]).as_deref().unwrap_or_default(),
            )
            .unwrap_or("requested");
            let items: Vec<Value> = records(record.get("products"))
                .iter()
                .map(|p| {
                    let mut item = Map::new();
                    item.insert(
                        "productName".to_owned(),
                        json!(ps(p, &["name"]).unwrap_or_else(|| "Item".to_owned())),
                    );
                    if let Some(sku) = ps(p, &["productcode"]) {
                        item.insert("sku".to_owned(), json!(sku));
                    }
                    item.insert(
                        "quantity".to_owned(),
                        number_value(pick_number(p, &["amount", "quantity"]).unwrap_or(1.0)),
                    );
                    Value::Object(item)
                })
                .collect();
            wms(
                "return",
                external_id,
                Links {
                    order: ps(record, &["idorder"]),
                    ..Links::default()
                },
                compact(vec![
                    ("returnNumber", json!(number)),
                    ("status", json!(status)),
                    (
                        "customerName",
                        opt(psm(record, &["name", "customer_name"], 255)),
                    ),
                    (
                        "customerEmail",
                        opt(psm(record, &["emailaddress", "email"], 255)),
                    ),
                    ("reason", opt(psm(record, &["reason"], 100))),
                    ("reasonDetails", opt(ps(record, &["remarks"]))),
                    ("items", Value::Array(items)),
                    ("metadata", source),
                ]),
            )
        }
        "stock_count" => {
            let completed = ps(record, &["completed_at", "updated_at"]);
            let location = ps(record, &["idlocation"]);
            wms(
                "stock_count",
                external_id,
                Links {
                    warehouse: ps(record, &["idwarehouse"]),
                    location: location.clone(),
                    ..Links::default()
                },
                compact(vec![
                    (
                        "countNumber",
                        json!(
                            psm(record, &["idlocation_stock_count", "id"], 50)
                                .unwrap_or_else(|| external_id.to_owned())
                        ),
                    ),
                    (
                        "status",
                        json!(if ps(record, &["status"]).as_deref() == Some("completed") {
                            "completed"
                        } else {
                            "in_progress"
                        }),
                    ),
                    (
                        "completedAt",
                        completed.as_deref().map_or(Value::Null, date_value),
                    ),
                    (
                        "locationIds",
                        json!(location.into_iter().collect::<Vec<_>>()),
                    ),
                    ("metadata", source),
                ]),
            )
        }
        "inventory_movement" => {
            let amount = pick_number(record, &["amount", "quantity"]).unwrap_or(0.0);
            let created = ps(record, &["created", "created_at"]);
            let quantity = if amount.abs() == 0.0 {
                1.0
            } else {
                amount.abs()
            };
            wms(
                "inventory_movement",
                external_id,
                Links {
                    product: ps(record, &["idproduct"]),
                    warehouse: ps(record, &["idwarehouse", "idwarehouse_from"]),
                    ..Links::default()
                },
                compact(vec![
                    (
                        "movementNumber",
                        json!(
                            psm(record, &["idmovement", "id"], 50)
                                .unwrap_or_else(|| external_id.to_owned())
                        ),
                    ),
                    ("movementType", json!("transfer")),
                    ("status", json!("completed")),
                    ("quantity", number_value(quantity)),
                    ("sku", opt(psm(record, &["productcode"], 100))),
                    ("name", opt(psm(record, &["name"], 255))),
                    (
                        "completedAt",
                        created.as_deref().map_or_else(now_value, date_value),
                    ),
                    ("notes", opt(ps(record, &["reason", "remarks"]))),
                    (
                        "metadata",
                        json!({
                            "source": "picqer",
                            "idwarehouse_from": ps(record, &["idwarehouse_from"]),
                            "idwarehouse_to": ps(record, &["idwarehouse_to", "idwarehouse"]),
                        }),
                    ),
                ]),
            )
        }
        _ => return None,
    })
}

/// `mapConnectorRecord(entity, record, provider)`.
pub fn map_connector_record(entity: &str, record: &Value, provider: &str) -> Option<Mapped> {
    let external_id = external_id_of(record)?;
    if provider == "stripe" {
        return crate::stripe_mappers::map_stripe_record(entity, record, &external_id);
    }
    match entity {
        "product" => map_product(record, &external_id),
        "order" => map_order(record, &external_id, provider),
        "person" => map_person(record, &external_id, provider),
        "party" => map_party(record, &external_id, provider),
        "invoice" => map_document(record, &external_id, "invoice"),
        "bill" => map_document(record, &external_id, "bill"),
        "bank_account" => Some(map_bank_account(record, &external_id)),
        "bank_transaction" => map_bank_transaction(record, &external_id),
        // Only Odoo syncs these, through its own ingest (`crate::odoo`).
        "product_supplier" | "sales_history" => None,
        other => map_wms(other, record, &external_id),
    }
}

// ── custom field mappings (`field-mapper.ts`) ───────────────────────────────

/// A row of `integration_field_mappings` as ingest reads it.
#[derive(Debug, Clone)]
pub struct FieldMapping {
    pub external_field_path: String,
    pub internal_field_path: String,
    pub direction: String,
    pub transform_type: String,
    pub transform_config: Option<Value>,
}

fn apply_transform(value: &Value, kind: &str, config: Option<&Value>) -> Value {
    match kind {
        "lookup" => {
            let Some(table) = config
                .and_then(|c| c.get("lookupTable"))
                .and_then(Value::as_object)
            else {
                return value.clone();
            };
            table
                .get(&as_text(value))
                .cloned()
                .unwrap_or_else(|| value.clone())
        }
        "format_date" => {
            if !crate::js::truthy(value) {
                return value.clone();
            }
            js_date_loose(&as_text(value))
                .and_then(weldsuite_kit::validation::js_iso_from_millis)
                .map_or_else(|| value.clone(), Value::String)
        }
        _ => value.clone(),
    }
}

fn set_nested(target: &mut Map<String, Value>, path: &str, value: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = target;
    for part in &parts[..parts.len() - 1] {
        let entry = current
            .entry((*part).to_owned())
            .or_insert_with(|| json!({}));
        if !entry.is_object() {
            *entry = json!({});
        }
        current = entry.as_object_mut().expect("just made an object");
    }
    current.insert(parts[parts.len() - 1].to_owned(), value);
}

/// `applyInboundFieldMappings(record, values, mappings)`.
pub fn apply_inbound_field_mappings(
    record: &Value,
    values: &mut Map<String, Value>,
    mappings: &[FieldMapping],
) {
    for mapping in mappings
        .iter()
        .filter(|m| m.direction == "inbound" || m.direction == "bidirectional")
    {
        let Some(value) = read_path_objects(record, &mapping.external_field_path) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let transformed = apply_transform(
            value,
            &mapping.transform_type,
            mapping.transform_config.as_ref(),
        );
        if transformed.is_null() || transformed == json!("") {
            continue;
        }
        set_nested(values, &mapping.internal_field_path, transformed);
    }
}

/// `getNestedValue(obj, path)` (arrays index by their keys too).
fn read_path_objects<'a>(source: &'a Value, path: &str) -> Option<&'a Value> {
    read_path(source, path)
}

/// `mapWithFieldMappings`: the mapped record with custom mappings overlaid.
pub fn map_with_field_mappings(
    entity: &str,
    record: &Value,
    provider: &str,
    mappings: &[FieldMapping],
) -> Option<Mapped> {
    let mut mapped = map_connector_record(entity, record, provider)?;
    if !mappings.is_empty() {
        let mapper_status = mapped.values_mut().get("status").cloned();
        apply_inbound_field_mappings(record, mapped.values_mut(), mappings);
        keep_known_document_status(&mut mapped, mapper_status);
        keep_valid_iban(&mut mapped);
    }
    Some(mapped)
}

/// `keepValidIban(mapped)`: a bank account's IBAN after field mappings is an
/// IBAN or nothing. Moneybird connections are seeded with `identifier →
/// iban`, and an identifier is often no IBAN (a private account's name, a
/// payment provider's account id).
fn keep_valid_iban(mapped: &mut Mapped) {
    if mapped.entity() != "bank_account" {
        return;
    }
    let values = mapped.values_mut();
    let Some(iban) = values.get("iban").filter(|v| !v.is_null()) else {
        return;
    };
    let valid = looks_like_iban(iban.as_str());
    values.insert("iban".to_owned(), opt(valid));
}

/// `keepKnownDocumentStatus(mapped, values)`: field mappings may not give an
/// invoice or bill a status WeldBooks doesn't know. Moneybird connections are
/// seeded with `state → status` as-is, which would write Moneybird's own
/// states (`open`, `late`, `reminded`, …); the mapper's status stands then.
fn keep_known_document_status(mapped: &mut Mapped, mapper_status: Option<Value>) {
    let known: &[&str] = match mapped.entity() {
        "invoice" => &KNOWN_INVOICE_STATUSES,
        "bill" => &KNOWN_BILL_STATUSES,
        _ => return,
    };
    let values = mapped.values_mut();
    let status = values.get("status").and_then(Value::as_str);
    if status.is_some_and(|status| known.contains(&status)) {
        return;
    }
    match mapper_status {
        Some(status) => values.insert("status".to_owned(), status),
        None => values.remove("status"),
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_like_javascript() {
        let record =
            json!({ "a": { "b": [ { "c": 12.0 } ] }, "s": "  x  ", "n": null, "z": "null" });
        assert_eq!(
            pick_string(&record, &["a.b.0.c"], None).as_deref(),
            Some("12")
        );
        assert_eq!(
            pick_string(&record, &["n", "z", "s"], None).as_deref(),
            Some("x")
        );
        assert_eq!(pick_number(&json!({ "p": "€ 1.234" }), &["p"]), Some(1.234));
        assert_eq!(decimal_string(Some("12,5"), "0"), "12.50");
        assert_eq!(quantity_string(Some("x 2,50 st")), "2.5");
        assert_eq!(quantity_string(Some("0")), "1");
        assert_eq!(slugify("Héllo  World_ok!"), "hello-world-ok");
        assert_eq!(
            looks_like_iban(Some("nl91 abna 0417 1643 00")).as_deref(),
            Some("NL91ABNA0417164300")
        );
        assert_eq!(
            js_date_loose("2026-01-02 10:00:00").map(|m| m as i64),
            Some(1_767_348_000_000)
        );
        assert_eq!(
            js_date_loose("2026-01-02T10:00:00").map(|m| m as i64),
            Some(1_767_348_000_000)
        );
        assert_eq!(
            js_date_loose("2026-01-02T12:00:00+0200").map(|m| m as i64),
            Some(1_767_348_000_000)
        );
        assert!(js_date_loose("garbage").is_none());
    }

    /// A Moneybird sales invoice as the API sends it, with `overrides` on top.
    fn moneybird_invoice(overrides: &Value) -> Mapped {
        let mut record = json!({
            "id": "inv2",
            "invoice_id": "2024-0002",
            "contact_id": "c1",
            "invoice_date": "2024-03-01",
            "due_date": "2024-03-15",
            "currency": "EUR",
            "prices_are_incl_tax": false,
            "total_price_excl_tax": "150.0",
            "total_price_incl_tax": "172.0",
            "total_paid": "0.0",
            "total_unpaid": "172.0",
            "details": [
                { "description": "Hours", "amount": "1", "price": "100.0", "tax_rate_id": "tr_21", "total_price_excl_tax_with_discount": "100.0" },
                { "description": "Book", "amount": "1", "price": "50.0", "tax_rate_id": "tr_9", "total_price_excl_tax_with_discount": "50.0" },
            ],
            "tax_totals": [
                { "tax_rate_id": "tr_21", "taxable_amount": "100.0", "tax_amount": "21.0" },
                { "tax_rate_id": "tr_9", "taxable_amount": "50.0", "tax_amount": "4.5" },
            ],
        });
        for (key, value) in overrides.as_object().expect("overrides object") {
            record[key] = value.clone();
        }
        map_connector_record("invoice", &record, "moneybird").expect("an invoice")
    }

    fn document(mapped: &Mapped) -> (&Map<String, Value>, &Vec<DocumentLine>) {
        match mapped {
            Mapped::Document {
                values, line_items, ..
            } => (values, line_items),
            _ => panic!("not a document"),
        }
    }

    #[test]
    fn moneybird_invoice_vat_comes_from_tax_totals() {
        let mapped = moneybird_invoice(&json!({ "state": "open" }));
        let (values, lines) = document(&mapped);
        assert_eq!(values["subtotal"], json!("150.00"));
        assert_eq!(values["taxTotal"], json!("25.50"));
        let read: Vec<_> = lines
            .iter()
            .map(|l| {
                (
                    l.tax_rate.clone(),
                    l.tax_amount.clone(),
                    l.line_total.clone(),
                    l.line_total_with_tax.clone(),
                )
            })
            .collect();
        let some = |text: &str| Some(text.to_owned());
        assert_eq!(
            read,
            vec![
                (some("21.00"), some("21.00"), some("100.00"), some("121.00")),
                (some("9.00"), some("4.50"), some("50.00"), some("54.50")),
            ]
        );

        let without = moneybird_invoice(&json!({ "state": "open", "tax_totals": null }));
        assert_eq!(document(&without).0["taxTotal"], json!("22.00"));
    }

    #[test]
    fn moneybird_incl_vat_prices_come_in_without_the_vat() {
        let mapped = moneybird_invoice(&json!({
            "state": "open",
            "prices_are_incl_tax": true,
            "details": [{ "description": "Hours", "amount": "2", "price": "121.0", "tax_rate_id": "tr_21", "total_price_excl_tax_with_discount": "200.0" }],
            "tax_totals": [{ "tax_rate_id": "tr_21", "taxable_amount": "200.0", "tax_amount": "42.0" }],
        }));
        let line = &document(&mapped).1[0];
        assert_eq!(line.unit_price, "100.0000");
        assert_eq!(line.tax_amount.as_deref(), Some("42.00"));
        assert_eq!(line.line_total_with_tax.as_deref(), Some("242.00"));
    }

    #[test]
    fn moneybird_invoice_states_and_part_payments() {
        for (state, status) in [
            ("draft", "draft"),
            ("scheduled", "draft"),
            ("open", "sent"),
            ("pending_payment", "sent"),
            ("reminded", "overdue"),
            ("late", "overdue"),
            ("uncollectible", "uncollectible"),
        ] {
            let mapped = moneybird_invoice(&json!({ "state": state }));
            assert_eq!(document(&mapped).0["status"], json!(status), "{state}");
        }
        let scheduled = moneybird_invoice(&json!({ "state": "scheduled" }));
        assert!(!document(&scheduled).0.contains_key("sentAt"));

        let part = moneybird_invoice(
            &json!({ "state": "late", "total_paid": "72.0", "total_unpaid": "100.0" }),
        );
        let (values, _) = document(&part);
        assert_eq!(values["status"], json!("partial"));
        assert_eq!(values["amountPaid"], json!("72.00"));
        assert_eq!(values["balanceDue"], json!("100.00"));

        let paid = moneybird_invoice(&json!({ "state": "paid", "paid_at": "2024-03-10" }));
        let (values, _) = document(&paid);
        assert_eq!(values["status"], json!("paid"));
        assert_eq!(values["amountPaid"], json!("172.00"));
        assert_eq!(values["balanceDue"], json!("0"));
    }

    #[test]
    fn moneybird_purchase_invoice_payments_make_a_partial_bill() {
        let record = json!({
            "id": "bil2",
            "reference": "PIN-10",
            "state": "open",
            "contact_id": "c2",
            "date": "2024-02-01",
            "due_date": "2024-02-15",
            "total_price_excl_tax": "100.0",
            "total_price_incl_tax": "121.0",
            "payments": [{ "id": "pay1", "price": "50.0", "payment_date": "2024-02-03" }],
        });
        let mapped = map_connector_record("bill", &record, "moneybird").expect("a bill");
        let (values, _) = document(&mapped);
        assert_eq!(values["status"], json!("partial"));
        assert_eq!(values["taxTotal"], json!("21.00"));
        assert_eq!(values["amountPaid"], json!("50.00"));
        assert_eq!(values["balanceDue"], json!("71.00"));
    }

    #[test]
    fn field_mappings_cannot_write_an_unknown_document_status() {
        let record = json!({ "id": "inv3", "invoice_id": "2024-0003", "state": "reminded", "contact_id": "c1" });
        let raw_state = FieldMapping {
            external_field_path: "state".to_owned(),
            internal_field_path: "status".to_owned(),
            direction: "inbound".to_owned(),
            transform_type: "direct".to_owned(),
            transform_config: None,
        };
        let mapped = map_with_field_mappings(
            "invoice",
            &record,
            "moneybird",
            std::slice::from_ref(&raw_state),
        )
        .expect("an invoice");
        assert_eq!(document(&mapped).0["status"], json!("overdue"));

        let cancelled = json!({ "id": "inv4", "invoice_id": "2024-0004", "state": "open", "contact_id": "c1", "custom": "cancelled" });
        let custom = FieldMapping {
            external_field_path: "custom".to_owned(),
            ..raw_state
        };
        let mapped = map_with_field_mappings("invoice", &cancelled, "moneybird", &[custom])
            .expect("an invoice");
        assert_eq!(document(&mapped).0["status"], json!("cancelled"));
    }

    #[test]
    fn moneybird_bills_carry_the_rate_of_their_base_totals() {
        let bill = |totals: Value| {
            let mut record =
                json!({ "id": "bil9", "reference": "F-1", "state": "paid", "contact_id": "c1" });
            if let (Some(record), Some(totals)) = (record.as_object_mut(), totals.as_object()) {
                record.extend(totals.clone());
            }
            map_connector_record("bill", &record, "moneybird").expect("a bill")
        };
        let usd = bill(json!({
            "currency": "USD",
            "total_price_excl_tax": "120.0",
            "total_price_excl_tax_base": "110.5",
            "total_price_incl_tax": "120.0",
            "total_price_incl_tax_base": "110.5",
        }));
        assert_eq!(document(&usd).0["exchangeRate"], json!("1.085973"));
        let eur = bill(
            json!({ "currency": "EUR", "total_price_incl_tax": "25.41", "total_price_incl_tax_base": "25.41" }),
        );
        assert_eq!(document(&eur).0["exchangeRate"], json!("1.000000"));
        // A zero total says nothing about the rate; the excl. pair may.
        let zero = bill(
            json!({ "currency": "USD", "total_price_incl_tax": "0.0", "total_price_incl_tax_base": "0.0" }),
        );
        assert!(document(&zero).0.get("exchangeRate").is_none());
        let excl = bill(json!({
            "currency": "USD",
            "total_price_incl_tax": "0",
            "total_price_excl_tax": "10.0",
            "total_price_excl_tax_base": "8.0",
        }));
        assert_eq!(document(&excl).0["exchangeRate"], json!("1.250000"));
    }

    fn bank_transaction(record: &Value) -> (Map<String, Value>, Option<String>, Option<String>) {
        match map_connector_record("bank_transaction", record, "moneybird") {
            Some(Mapped::BankTransaction {
                values,
                invoice_external_id,
                bill_external_id,
                ..
            }) => (values, invoice_external_id, bill_external_id),
            other => panic!("not a bank transaction: {other:?}"),
        }
    }

    #[test]
    fn moneybird_mutations_name_what_their_payments_settle() {
        let (values, invoice, bill) = bank_transaction(&json!({
            "id": "fm1",
            "amount": "-25.41",
            "date": "2026-10-21",
            "state": "processed",
            "settlement_state": "settled",
            "financial_account_id": "fa1",
            "payments": [
                { "invoice_type": "Document", "invoice_id": "501" },
                { "invoice_type": "SalesInvoice", "invoice_id": "601" },
                { "invoice_type": "Document", "invoice_id": "502" },
            ],
        }));
        assert_eq!(values["status"], json!("reconciled"));
        assert_eq!(bill.as_deref(), Some("501"));
        assert_eq!(invoice.as_deref(), Some("601"));
    }

    #[test]
    fn moneybird_mutations_that_never_settled_are_excluded() {
        for settlement in ["refused", "cancelled", "expired", "error", "Cancelled"] {
            let (values, invoice, bill) = bank_transaction(&json!({
                "id": "fm2",
                "amount": "-4.84",
                "date": "2026-01-06",
                "state": "processed",
                "settlement_state": settlement,
                "financial_account_id": "fa1",
                "payments": [{ "invoice_type": "Document", "invoice_id": "501" }],
            }));
            assert_eq!(values["status"], json!("excluded"), "{settlement}");
            assert_eq!((invoice, bill), (None, None), "{settlement}");
        }
        for settlement in ["settled", "authorised", "pending", ""] {
            let (values, ..) = bank_transaction(&json!({
                "id": "fm3",
                "amount": "1",
                "date": "2026-01-06",
                "state": "unprocessed",
                "settlement_state": settlement,
                "financial_account_id": "fa1",
            }));
            assert_eq!(values["status"], json!("unreconciled"), "{settlement}");
        }
    }

    #[test]
    fn ibans_are_checked_by_country_length_and_checksum() {
        for valid in [
            "NL91ABNA0417164300",
            "nl91 abna 0417 1643 00",
            "DE89370400440532013000",
            "GB82WEST12345698765432",
            "BE68539007547034",
        ] {
            assert!(looks_like_iban(Some(valid)).is_some(), "{valid}");
        }
        assert_eq!(
            looks_like_iban(Some("nl91 abna 0417 1643 00")).as_deref(),
            Some("NL91ABNA0417164300")
        );
        for invalid in [
            "NL91ABNA0417164301",        // wrong check digits
            "NL91ABNA041716430",         // too short for NL
            "BA32ABCDEFGHIJKLMNOPQRSTU", // looks like one, wrong length for BA
            "ZZ12345678901234",          // no IBAN country
            "G.L. van den Berg",
            "0001",
            "",
        ] {
            assert!(looks_like_iban(Some(invalid)).is_none(), "{invalid}");
        }
        assert!(looks_like_iban(None).is_none());
    }

    #[test]
    fn a_bank_account_identifier_that_is_no_iban_does_not_become_one() {
        let identifier = FieldMapping {
            external_field_path: "identifier".to_owned(),
            internal_field_path: "iban".to_owned(),
            direction: "inbound".to_owned(),
            transform_type: "direct".to_owned(),
            transform_config: None,
        };
        let account = |record: Value| {
            let mapped = map_with_field_mappings(
                "bank_account",
                &record,
                "moneybird",
                std::slice::from_ref(&identifier),
            )
            .expect("a bank account");
            match mapped {
                Mapped::BankAccount { values, .. } => values,
                other => panic!("not a bank account: {other:?}"),
            }
        };
        let private = account(json!({
            "id": "fa1",
            "type": "PrivateWithdrawalAccount",
            "name": "Rekening courant",
            "identifier": "G.L. van den Berg",
        }));
        assert!(private.get("iban").is_none_or(Value::is_null));
        let bank = account(json!({
            "id": "fa2",
            "type": "BankAccount",
            "name": "Main",
            "identifier": "NL91 ABNA 0417 1643 00",
        }));
        assert_eq!(bank["iban"], json!("NL91ABNA0417164300"));
    }

    #[test]
    fn order_lines_keep_their_own_id() {
        let lines = |mapped: Option<Mapped>| match mapped {
            Some(Mapped::Order { line_items, .. }) => line_items,
            other => panic!("not an order: {other:?}"),
        };
        let woo = lines(map_order(
            &json!({ "id": 88, "number": "88", "line_items": [
                { "id": 501, "name": "Helmet", "quantity": 1, "price": "50" },
                { "name": "Gift wrap" }
            ] }),
            "88",
            "woocommerce",
        ));
        assert_eq!(
            woo.iter()
                .map(|l| l.external_line_id.as_deref())
                .collect::<Vec<_>>(),
            [Some("501"), None]
        );
        let picqer = lines(map_order(
            &json!({ "idorder": 9, "orderid": "O-9", "products": [
                { "idorder_product": 77, "idproduct": 5, "productcode": "PQ-5", "name": "Box", "amount": 2 }
            ] }),
            "9",
            "picqer",
        ));
        assert_eq!(picqer[0].external_line_id.as_deref(), Some("77"));
        assert_eq!(picqer[0].external_product_id.as_deref(), Some("5"));
        assert!((picqer[0].quantity - 2.0).abs() < f64::EPSILON);
    }
}
