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
fn slugify(value: &str) -> String {
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
        /// Stripe lines: the invoice a charge paid.
        invoice_external_id: Option<String>,
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

const INVOICE_STATUS: [(&str, &str); 5] = [
    ("draft", "draft"),
    ("open", "sent"),
    ("late", "overdue"),
    ("paid", "paid"),
    ("uncollectible", "uncollectible"),
];

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

fn map_document_lines(record: &Value) -> Vec<DocumentLine> {
    first_array(&[record.get("details"), record.get("line_items")])
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let quantity = quantity_string(ps(item, &["amount", "quantity"]).as_deref());
            let unit_price = decimal_string(ps(item, &["price", "unit_price"]).as_deref(), "0");
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
            let line_incl = decimal_string(
                ps(
                    item,
                    &["total_price_incl_tax_with_discount", "total_price_incl_tax"],
                )
                .as_deref(),
                &line_excl,
            );
            DocumentLine {
                external_product_id: nonzero(ps(item, &["product_id"])),
                description: psm(item, &["description", "name"], 2000)
                    .unwrap_or_else(|| "Item".to_owned()),
                quantity,
                unit_price,
                tax_rate: ps(item, &["tax_rate", "tax"]),
                tax_amount: ps(item, &["tax_amount", "tax"]),
                line_total: Some(line_excl),
                line_total_with_tax: Some(line_incl),
                sort_order: index,
                period: None,
            }
        })
        .collect()
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
    let tax_total = decimal_string(ps(record, &["total_tax", "tax_total"]).as_deref(), "0");
    let status = if invoice {
        lookup(&INVOICE_STATUS, &state).unwrap_or("draft")
    } else {
        lookup(&BILL_STATUS, &state).unwrap_or("draft")
    };
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
            if state == "draft" {
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
        ("subtotal", json!(subtotal)),
        ("taxTotal", json!(tax_total)),
        ("total", json!(total)),
        (
            "amountPaid",
            json!(if paid_at.is_some() {
                total.clone()
            } else {
                "0".to_owned()
            }),
        ),
        (
            "balanceDue",
            json!(if paid_at.is_some() {
                "0".to_owned()
            } else {
                total.clone()
            }),
        ),
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

/// `looksLikeIban(value)`.
fn looks_like_iban(value: Option<&str>) -> Option<String> {
    let compact: String = value?
        .chars()
        .filter(|c| !js_space(*c))
        .collect::<String>()
        .to_uppercase();
    let len = compact.encode_utf16().count();
    if !(15..=34).contains(&len) {
        return None;
    }
    let bytes = compact.as_bytes();
    let valid = bytes.len() >= 3
        && bytes[..2].iter().all(u8::is_ascii_uppercase)
        && bytes[2..]
            .iter()
            .all(|b| b.is_ascii_digit() || b.is_ascii_uppercase());
    valid.then(|| slice_units(&compact, 34))
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
    let status = if state == "processed" || state == "auto_booked" {
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
    Some(Mapped::BankTransaction {
        external_id: external_id.to_owned(),
        financial_account_external_id: ps(record, &["financial_account_id"]),
        invoice_external_id: None,
        values,
    })
}

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
        apply_inbound_field_mappings(record, mapped.values_mut(), mappings);
    }
    Some(mapped)
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
}
