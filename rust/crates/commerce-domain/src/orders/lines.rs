//! Order lines: what a request asks for, resolved against the catalogue and
//! the order's own stored items.
//!
//! A line is a variant, a product, or a free line with a name and a price. A
//! line that names an existing item of the order (`id`) and does not change
//! what it sells keeps the item's stored product, name and price (the
//! catalogue may have moved on); everything else is priced from the
//! catalogue: the variant's price, else the product's.

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Value, json};
use sqlx::PgConnection;
use weldsuite_books_domain::tax::eu_vat::{VatCategory, effective_category};
use weldsuite_schema::tenant::{product_variants, products};

use crate::db;
use crate::money::{self, Cents};
use crate::prices;

/// A line as the request wrote it.
#[derive(Debug, Clone, Default)]
pub struct LineInput {
    /// An existing item of the order (updates it in place).
    pub id: Option<String>,
    pub product_id: Option<String>,
    pub variant_id: Option<String>,
    pub name: Option<String>,
    pub quantity: i64,
    pub unit_price: Option<Cents>,
}

/// A line with its product, name and price settled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub id: Option<String>,
    pub product_id: Option<String>,
    pub variant_id: Option<String>,
    pub sku: Option<String>,
    pub name: String,
    pub variant_name: Option<String>,
    pub image_url: Option<String>,
    pub quantity: i64,
    pub unit_price: Cents,
    /// How the line is taxed (`products.vat_category`, the variant's when it
    /// has one): `standard`, `reduced`, `super_reduced`, `zero` or `exempt`.
    /// A free line, or an item stored before VAT was computed, is `standard`.
    pub vat_category: String,
    /// `PRODUCT_NOT_FOUND`, `INACTIVE`, `CURRENCY_MISMATCH` or `NO_PRICE`.
    pub problem: Option<&'static str>,
}

/// A catalogue row a line is priced from.
#[derive(Debug, Clone, Default)]
pub struct Catalogue {
    pub id: String,
    /// The variant's product.
    pub product_id: Option<String>,
    pub name: String,
    pub sku: Option<String>,
    pub price: Option<Cents>,
    pub currency: Option<String>,
    pub status: String,
    pub image_url: Option<String>,
    /// The product's or variant's `vat_category` (a variant's is null when it
    /// inherits the product's).
    pub vat_category: Option<String>,
}

fn text(row: &Value, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// A text column, an empty string read as none.
fn filled(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.is_empty())
}

impl Catalogue {
    fn of_variant(row: product_variants::Model) -> Option<Self> {
        Some(Self {
            id: filled(Some(row.id))?,
            product_id: filled(Some(row.product_id)),
            name: row.name,
            sku: filled(row.sku),
            price: row.price.as_ref().and_then(prices::parse_numeric),
            currency: filled(row.currency),
            status: row.status,
            image_url: filled(row.image_url),
            vat_category: filled(row.vat_category),
        })
    }

    fn of_product(row: products::Model) -> Option<Self> {
        Some(Self {
            id: filled(Some(row.id))?,
            product_id: None,
            name: row.name,
            sku: filled(row.sku),
            price: prices::parse_numeric(&row.price),
            currency: filled(row.currency),
            status: row.status,
            image_url: filled(row.featured_image_url),
            vat_category: filled(Some(row.vat_category)),
        })
    }
}

/// The line's VAT category: the variant's when it has one, else the
/// product's, else `standard` (never a lower rate by default).
fn category_of(product: Option<&Catalogue>, variant: Option<&Catalogue>) -> String {
    let product_category = product
        .and_then(|p| p.vat_category.as_deref())
        .unwrap_or("standard");
    effective_category(
        product_category,
        variant.and_then(|v| v.vat_category.as_deref()),
    )
    .unwrap_or(VatCategory::Standard)
    .as_str()
    .to_owned()
}

/// The item an input keeps: its stored values.
fn kept(stored: &Value) -> Line {
    Line {
        id: text(stored, "id"),
        product_id: text(stored, "productId"),
        variant_id: text(stored, "variantId"),
        sku: text(stored, "sku"),
        name: text(stored, "name").unwrap_or_default(),
        variant_name: stored
            .pointer("/properties/variantName")
            .and_then(Value::as_str)
            .map(str::to_owned),
        image_url: text(stored, "imageUrl"),
        quantity: 0,
        unit_price: stored
            .get("unitPrice")
            .and_then(Value::as_str)
            .and_then(money::parse)
            .unwrap_or(0),
        vat_category: text(stored, "vatCategory").unwrap_or_else(|| "standard".to_owned()),
        problem: None,
    }
}

/// A stored item as a line, its quantity included.
#[must_use]
pub fn stored_line(item: &Value) -> Line {
    let mut line = kept(item);
    line.quantity = item.get("quantity").and_then(Value::as_i64).unwrap_or(0);
    line
}

/// Whether `input` still sells what `stored` is.
fn same_target(input: &LineInput, stored: &Value) -> bool {
    let matches = |given: Option<&String>, key: &str| {
        given.is_none_or(|given| stored.get(key).and_then(Value::as_str) == Some(given.as_str()))
    };
    matches(input.variant_id.as_ref(), "variantId")
        && matches(input.product_id.as_ref(), "productId")
}

/// Price `input` from the catalogue rows it names (`variant`, `product`).
#[must_use]
pub fn build(
    input: &LineInput,
    variant: Option<&Catalogue>,
    product: Option<&Catalogue>,
    currency: &str,
) -> Line {
    let mut line = Line {
        id: input.id.clone(),
        product_id: input.product_id.clone(),
        variant_id: input.variant_id.clone(),
        sku: None,
        name: input.name.clone().unwrap_or_default(),
        variant_name: None,
        image_url: None,
        quantity: input.quantity,
        unit_price: input.unit_price.unwrap_or(0),
        vat_category: "standard".to_owned(),
        problem: None,
    };
    let named = input.variant_id.is_some() || input.product_id.is_some();
    if named {
        let found = match (input.variant_id.as_ref(), variant, product) {
            // The variant must belong to the product the line names, if any.
            (Some(_), Some(variant), Some(product)) => {
                input.product_id.as_ref().is_none_or(|id| *id == product.id)
                    && variant.product_id.as_deref() == Some(product.id.as_str())
            }
            (None, _, Some(_)) => true,
            _ => false,
        };
        if !found {
            line.problem = Some("PRODUCT_NOT_FOUND");
            return line;
        }
    }
    let product = product.filter(|_| named);
    if let Some(product) = product {
        line.product_id = Some(product.id.clone());
        line.sku = variant
            .and_then(|v| v.sku.clone())
            .or_else(|| product.sku.clone());
        line.image_url = variant
            .and_then(|v| v.image_url.clone())
            .or_else(|| product.image_url.clone());
        if input.name.is_none() {
            line.name.clone_from(&product.name);
        }
        line.variant_name = variant.map(|v| v.name.clone());
        line.vat_category = category_of(Some(product), variant);
        let inactive =
            product.status == "archived" || variant.is_some_and(|v| v.status != "active");
        if inactive {
            line.problem = Some("INACTIVE");
        }
    }
    if input.unit_price.is_none() {
        let source = variant
            .filter(|v| v.price.is_some())
            .or(product)
            .filter(|c| c.price.is_some());
        match source {
            Some(source) => {
                line.unit_price = source.price.unwrap_or(0);
                if line.problem.is_none()
                    && source
                        .currency
                        .as_deref()
                        .is_some_and(|c| !c.eq_ignore_ascii_case(currency))
                {
                    line.problem = Some("CURRENCY_MISMATCH");
                }
            }
            None if line.problem.is_none() => line.problem = Some("NO_PRICE"),
            None => {}
        }
    }
    line
}

/// The live variants among `ids`.
async fn variants(conn: &mut PgConnection, ids: &[String]) -> Result<Vec<Catalogue>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = product_variants::Entity::find()
        .filter(product_variants::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(product_variants::Column::DeletedAt.is_null())
        .all(&db::on(conn))
        .await?;
    Ok(rows.into_iter().filter_map(Catalogue::of_variant).collect())
}

/// The live products among `ids`.
async fn products(conn: &mut PgConnection, ids: &[String]) -> Result<Vec<Catalogue>, DbErr> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows = products::Entity::find()
        .filter(products::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(products::Column::DeletedAt.is_null())
        .all(&db::on(conn))
        .await?;
    Ok(rows.into_iter().filter_map(Catalogue::of_product).collect())
}

/// Settle every input of a request. `stored` are the order's current items
/// (rows as [`crate::tables::ORDER_ITEMS`] reads them; none for a new order).
///
/// # Errors
/// A failed statement.
pub async fn resolve(
    conn: &mut PgConnection,
    currency: &str,
    inputs: &[LineInput],
    stored: &[Value],
) -> Result<Vec<Line>, DbErr> {
    let keep_of = |input: &LineInput| {
        input.id.as_ref().and_then(|id| {
            stored
                .iter()
                .find(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
                .filter(|item| same_target(input, item))
        })
    };
    let fresh: Vec<&LineInput> = inputs.iter().filter(|i| keep_of(i).is_none()).collect();
    let variant_ids: Vec<String> = fresh.iter().filter_map(|i| i.variant_id.clone()).collect();
    let variants = variants(conn, &variant_ids).await?;
    let mut product_ids: Vec<String> = fresh.iter().filter_map(|i| i.product_id.clone()).collect();
    product_ids.extend(variants.iter().filter_map(|v| v.product_id.clone()));
    let products = products(conn, &product_ids).await?;
    // What the catalogue sells for in the order's currency (`product_prices`
    // first, the base price when the currency is the base one).
    let targets: Vec<prices::Target> = fresh
        .iter()
        .filter(|input| input.unit_price.is_none())
        .filter_map(|input| {
            let product_id = input.product_id.clone().or_else(|| {
                input.variant_id.as_ref().and_then(|id| {
                    variants
                        .iter()
                        .find(|v| v.id == *id)
                        .and_then(|v| v.product_id.clone())
                })
            })?;
            Some(prices::Target {
                product_id,
                variant_id: input.variant_id.clone(),
            })
        })
        .collect();
    let resolved = prices::resolve_many(conn, &targets, currency).await?;

    Ok(inputs
        .iter()
        .map(|input| {
            if let Some(item) = keep_of(input) {
                let mut line = kept(item);
                line.quantity = input.quantity;
                if let Some(name) = &input.name {
                    line.name.clone_from(name);
                }
                if let Some(price) = input.unit_price {
                    line.unit_price = price;
                }
                return line;
            }
            let variant = input
                .variant_id
                .as_ref()
                .and_then(|id| variants.iter().find(|v| v.id == *id));
            let product_id = input
                .product_id
                .as_ref()
                .or_else(|| variant.and_then(|v| v.product_id.as_ref()));
            let product = product_id.and_then(|id| products.iter().find(|p| p.id == *id));
            let mut line = build(input, variant, product, currency);
            if input.unit_price.is_none()
                && !matches!(line.problem, Some("PRODUCT_NOT_FOUND" | "INACTIVE"))
                && let Some(product) = product
                && let Some(price) = resolved.get(&prices::Target {
                    product_id: product.id.clone(),
                    variant_id: input.variant_id.clone(),
                })
            {
                line.unit_price = price.price;
                line.problem = None;
            }
            line
        })
        .collect())
}

/// The item's `properties` with the variant's name stamped.
#[must_use]
pub fn properties(existing: Option<&Value>, variant_name: Option<&str>) -> Value {
    let mut properties = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    match variant_name {
        Some(name) => properties.insert("variantName".to_owned(), json!(name)),
        None => properties.remove("variantName"),
    };
    Value::Object(properties)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, price: Option<Cents>, status: &str) -> Catalogue {
        Catalogue {
            id: id.into(),
            product_id: None,
            name: format!("name {id}"),
            sku: Some(format!("sku-{id}")),
            price,
            currency: Some("EUR".into()),
            status: status.into(),
            image_url: None,
            vat_category: None,
        }
    }

    fn input(product: Option<&str>, variant: Option<&str>) -> LineInput {
        LineInput {
            product_id: product.map(str::to_owned),
            variant_id: variant.map(str::to_owned),
            quantity: 2,
            ..LineInput::default()
        }
    }

    #[test]
    fn a_product_line_takes_the_product_price_and_name() {
        let product = row("p1", Some(1999), "active");
        let line = build(&input(Some("p1"), None), None, Some(&product), "EUR");
        assert_eq!(line.problem, None);
        assert_eq!(line.unit_price, 1999);
        assert_eq!(line.name, "name p1");
        assert_eq!(line.sku.as_deref(), Some("sku-p1"));
    }

    #[test]
    fn a_variant_line_prefers_the_variant() {
        let product = row("p1", Some(1999), "active");
        let mut variant = row("v1", Some(2499), "active");
        variant.product_id = Some("p1".into());
        let line = build(
            &input(None, Some("v1")),
            Some(&variant),
            Some(&product),
            "EUR",
        );
        assert_eq!(line.problem, None);
        assert_eq!(line.unit_price, 2499);
        assert_eq!(line.product_id.as_deref(), Some("p1"));
        assert_eq!(line.variant_name.as_deref(), Some("name v1"));
        // A variant without a price sells at the product's.
        variant.price = None;
        let line = build(
            &input(None, Some("v1")),
            Some(&variant),
            Some(&product),
            "EUR",
        );
        assert_eq!(line.unit_price, 1999);
    }

    #[test]
    fn the_vat_category_is_the_variants_else_the_products_else_standard() {
        let mut product = row("p1", Some(1999), "active");
        product.vat_category = Some("reduced".into());
        let mut variant = row("v1", Some(2499), "active");
        variant.product_id = Some("p1".into());
        let of = |product: &Catalogue, variant: Option<&Catalogue>| {
            build(
                &input(Some("p1"), variant.map(|_| "v1")),
                variant,
                Some(product),
                "EUR",
            )
            .vat_category
        };
        assert_eq!(of(&product, None), "reduced");
        // A variant without a category inherits the product's.
        assert_eq!(of(&product, Some(&variant)), "reduced");
        variant.vat_category = Some("zero".into());
        assert_eq!(of(&product, Some(&variant)), "zero");
        // Unknown text is never a lower rate.
        product.vat_category = Some("cheap".into());
        variant.vat_category = None;
        assert_eq!(of(&product, Some(&variant)), "standard");
        // A free line is standard, a stored item keeps its own.
        let mut free = input(None, None);
        free.name = Some("Custom".into());
        free.unit_price = Some(100);
        assert_eq!(build(&free, None, None, "EUR").vat_category, "standard");
        let item = json!({ "id": "oitm_1", "vatCategory": "super_reduced", "quantity": 1 });
        assert_eq!(stored_line(&item).vat_category, "super_reduced");
        assert_eq!(
            stored_line(&json!({ "id": "oitm_2" })).vat_category,
            "standard"
        );
    }

    #[test]
    fn an_explicit_price_and_name_win() {
        let product = row("p1", Some(1999), "active");
        let mut asked = input(Some("p1"), None);
        asked.unit_price = Some(100);
        asked.name = Some("Custom".into());
        let line = build(&asked, None, Some(&product), "USD");
        assert_eq!(
            (line.unit_price, line.name.as_str(), line.problem),
            (100, "Custom", None)
        );
    }

    #[test]
    fn problems_name_what_is_wrong() {
        let product = row("p1", Some(1999), "archived");
        assert_eq!(
            build(&input(Some("p1"), None), None, Some(&product), "EUR").problem,
            Some("INACTIVE")
        );
        assert_eq!(
            build(&input(Some("gone"), None), None, None, "EUR").problem,
            Some("PRODUCT_NOT_FOUND")
        );
        let active = row("p1", Some(1999), "active");
        assert_eq!(
            build(&input(Some("p1"), None), None, Some(&active), "USD").problem,
            Some("CURRENCY_MISMATCH")
        );
        // A free line with no price.
        let mut free = input(None, None);
        free.name = Some("Custom work".into());
        assert_eq!(build(&free, None, None, "EUR").problem, Some("NO_PRICE"));
        free.unit_price = Some(5000);
        assert_eq!(build(&free, None, None, "EUR").problem, None);
        // A variant of another product.
        let mut variant = row("v1", Some(1), "active");
        variant.product_id = Some("other".into());
        assert_eq!(
            build(
                &input(Some("p1"), Some("v1")),
                Some(&variant),
                Some(&active),
                "EUR"
            )
            .problem,
            Some("PRODUCT_NOT_FOUND")
        );
        // An inactive variant.
        variant.product_id = Some("p1".into());
        variant.status = "archived".into();
        assert_eq!(
            build(
                &input(None, Some("v1")),
                Some(&variant),
                Some(&active),
                "EUR"
            )
            .problem,
            Some("INACTIVE")
        );
    }

    #[test]
    fn stored_items_keep_their_values() {
        let item = json!({
            "id": "oitm_1", "productId": "p1", "variantId": null, "sku": "S1",
            "name": "Old name", "unitPrice": "12.50", "imageUrl": null,
            "properties": { "variantName": "Red", "externalLineId": "7" }
        });
        assert!(same_target(&input(Some("p1"), None), &item));
        assert!(same_target(&input(None, None), &item));
        assert!(!same_target(&input(Some("p2"), None), &item));
        let line = kept(&item);
        assert_eq!(line.unit_price, 1250);
        assert_eq!(line.variant_name.as_deref(), Some("Red"));
        let props = properties(item.get("properties"), Some("Blue"));
        assert_eq!(props["variantName"], "Blue");
        assert_eq!(props["externalLineId"], "7");
        assert!(
            properties(item.get("properties"), None)
                .get("variantName")
                .is_none()
        );
    }
}
