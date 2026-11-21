//! Price resolution (ADR COM-011): the one place that says what a product or
//! a variant costs in a currency. Staff quotes, carts and the storefront's
//! listings all call it.
//!
//! STABLE SIGNATURES (the storefront builds on these):
//!
//! ```ignore
//! pub struct Price { pub price: Cents, pub compare_at: Option<Cents> }
//! pub struct Target { pub product_id: String, pub variant_id: Option<String> }
//! pub async fn resolve(conn: &mut PgConnection, product_id: &str,
//!     variant_id: Option<&str>, currency: &str) -> Result<Option<Price>, sqlx::Error>;
//! pub async fn resolve_many(conn: &mut PgConnection, targets: &[Target],
//!     currency: &str) -> Result<HashMap<Target, Price>, sqlx::Error>;
//! ```
//!
//! For currency `C`, a variant's price is, in this order:
//!
//! 1. its `product_prices` row for `C`,
//! 2. its own `price`, when `C` is its base currency,
//! 3. the product's `product_prices` row for `C` (no variant),
//! 4. the product's `price`, when `C` is the product's base currency.
//!
//! A product on its own (no variant) skips the variant steps. No price at all
//! is `None`: the product is not sellable in `C`. A variant's base currency is
//! its own `currency`, else its product's. Whether the number includes VAT is
//! the channel's `prices_include_tax`, not the price's. A deleted product (or
//! a variant that is deleted or belongs to another product) resolves to
//! `None`; whether the product is active is the caller's check.

use std::collections::HashMap;

use serde_json::Value;
use sqlx::PgConnection;

use crate::money::{self, Cents};

/// A resolved price, with the "was" price when one is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Price {
    pub price: Cents,
    pub compare_at: Option<Cents>,
}

/// What a price is asked for: a product, or one of its variants.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Target {
    pub product_id: String,
    pub variant_id: Option<String>,
}

/// The base price of a product or a variant, as stored.
#[derive(Debug, Clone, Default)]
struct Base {
    price: Option<Cents>,
    compare_at: Option<Cents>,
    currency: Option<String>,
}

impl Base {
    fn in_currency(&self, currency: &str) -> Option<Price> {
        let price = self.price?;
        self.currency
            .as_deref()
            .is_some_and(|own| own.eq_ignore_ascii_case(currency))
            .then_some(Price {
                price,
                compare_at: self.compare_at,
            })
    }
}

/// The facts the rules read: the price rows for the currency, and the base
/// prices of the products and variants.
#[derive(Debug, Default)]
struct Facts {
    rows: HashMap<Target, Price>,
    products: HashMap<String, Base>,
    /// variant id → (product id, base)
    variants: HashMap<String, (String, Base)>,
}

fn rule(facts: &Facts, target: &Target, currency: &str) -> Option<Price> {
    let product = facts.products.get(&target.product_id)?;
    if let Some(variant_id) = &target.variant_id {
        let (owner, base) = facts.variants.get(variant_id)?;
        if *owner != target.product_id {
            return None;
        }
        if let Some(price) = facts.rows.get(target) {
            return Some(*price);
        }
        if let Some(price) = base.in_currency(currency) {
            return Some(price);
        }
    }
    let product_target = Target {
        product_id: target.product_id.clone(),
        variant_id: None,
    };
    facts
        .rows
        .get(&product_target)
        .copied()
        .or_else(|| product.in_currency(currency))
}

fn cents(value: &Value, key: &str) -> Option<Cents> {
    value
        .get(key)
        .and_then(Value::as_str)
        .and_then(money::parse)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// The price of `product_id` (or its variant `variant_id`) in `currency`.
///
/// # Errors
/// A failed statement.
pub async fn resolve(
    conn: &mut PgConnection,
    product_id: &str,
    variant_id: Option<&str>,
    currency: &str,
) -> Result<Option<Price>, sqlx::Error> {
    let target = Target {
        product_id: product_id.to_owned(),
        variant_id: variant_id.map(str::to_owned),
    };
    let mut found = resolve_many(conn, std::slice::from_ref(&target), currency).await?;
    Ok(found.remove(&target))
}

/// [`resolve`] for many targets at once (a product list, a cart): three
/// statements however many there are. Targets with no price are left out.
///
/// # Errors
/// A failed statement.
pub async fn resolve_many(
    conn: &mut PgConnection,
    targets: &[Target],
    currency: &str,
) -> Result<HashMap<Target, Price>, sqlx::Error> {
    if targets.is_empty() {
        return Ok(HashMap::new());
    }
    let currency = currency.trim().to_ascii_uppercase();
    let mut product_ids: Vec<String> = targets.iter().map(|t| t.product_id.clone()).collect();
    product_ids.sort();
    product_ids.dedup();
    let variant_ids: Vec<String> = targets
        .iter()
        .filter_map(|t| t.variant_id.clone())
        .collect();

    let mut facts = Facts::default();
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('productId', p.product_id, 'variantId', p.variant_id, \
           'price', p.price::text, 'compareAt', p.compare_at_price::text) \
         from product_prices p \
         where p.product_id = any($1) and p.currency = $2 and p.deleted_at is null",
    )
    .bind(&product_ids)
    .bind(&currency)
    .fetch_all(&mut *conn)
    .await?;
    for row in &rows {
        if let (Some(product_id), Some(price)) = (text(row, "productId"), cents(row, "price")) {
            facts.rows.insert(
                Target {
                    product_id,
                    variant_id: text(row, "variantId"),
                },
                Price {
                    price,
                    compare_at: cents(row, "compareAt"),
                },
            );
        }
    }
    let products: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', p.id, 'price', p.price::text, \
           'compareAt', p.compare_at_price::text, 'currency', p.currency) \
         from products p where p.id = any($1) and p.deleted_at is null",
    )
    .bind(&product_ids)
    .fetch_all(&mut *conn)
    .await?;
    for row in &products {
        if let Some(id) = text(row, "id") {
            facts.products.insert(
                id,
                Base {
                    price: cents(row, "price"),
                    compare_at: cents(row, "compareAt"),
                    currency: text(row, "currency"),
                },
            );
        }
    }
    if !variant_ids.is_empty() {
        let variants: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object('id', v.id, 'productId', v.product_id, \
               'price', v.price::text, 'compareAt', v.compare_at_price::text, \
               'currency', coalesce(v.currency, p.currency)) \
             from product_variants v join products p on p.id = v.product_id \
             where v.id = any($1) and v.deleted_at is null",
        )
        .bind(&variant_ids)
        .fetch_all(&mut *conn)
        .await?;
        for row in &variants {
            if let (Some(id), Some(owner)) = (text(row, "id"), text(row, "productId")) {
                facts.variants.insert(
                    id,
                    (
                        owner,
                        Base {
                            price: cents(row, "price"),
                            compare_at: cents(row, "compareAt"),
                            currency: text(row, "currency"),
                        },
                    ),
                );
            }
        }
    }

    Ok(targets
        .iter()
        .filter_map(|target| rule(&facts, target, &currency).map(|price| (target.clone(), price)))
        .collect())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn target(variant: Option<&str>) -> Target {
        Target {
            product_id: "prod".into(),
            variant_id: variant.map(str::to_owned),
        }
    }

    fn base(price: Option<Cents>, currency: &str) -> Base {
        Base {
            price,
            compare_at: None,
            currency: Some(currency.into()),
        }
    }

    fn facts() -> Facts {
        let mut facts = Facts::default();
        facts
            .products
            .insert("prod".into(), base(Some(1000), "EUR"));
        facts
            .variants
            .insert("var".into(), ("prod".into(), base(Some(1500), "EUR")));
        facts
            .variants
            .insert("bare".into(), ("prod".into(), base(None, "EUR")));
        facts
    }

    #[test]
    fn variant_row_beats_its_base_price() {
        let mut facts = facts();
        facts.rows.insert(
            target(Some("var")),
            Price {
                price: 1400,
                compare_at: Some(1800),
            },
        );
        let price = rule(&facts, &target(Some("var")), "EUR").unwrap();
        assert_eq!((price.price, price.compare_at), (1400, Some(1800)));
    }

    #[test]
    fn base_currency_falls_back_to_the_variant_then_the_product() {
        let facts = facts();
        assert_eq!(
            rule(&facts, &target(Some("var")), "eur").unwrap().price,
            1500
        );
        assert_eq!(
            rule(&facts, &target(Some("bare")), "EUR").unwrap().price,
            1000
        );
        assert_eq!(rule(&facts, &target(None), "EUR").unwrap().price, 1000);
    }

    #[test]
    fn another_currency_needs_a_row() {
        let mut facts = facts();
        assert!(rule(&facts, &target(Some("var")), "USD").is_none());
        facts.rows.insert(
            target(None),
            Price {
                price: 1100,
                compare_at: None,
            },
        );
        // The product's row serves its variants that have none of their own.
        assert_eq!(
            rule(&facts, &target(Some("var")), "USD").unwrap().price,
            1100
        );
        assert_eq!(rule(&facts, &target(None), "USD").unwrap().price, 1100);
    }

    #[test]
    fn a_variant_of_another_product_has_no_price() {
        let mut facts = facts();
        facts
            .variants
            .insert("alien".into(), ("other".into(), base(Some(1), "EUR")));
        assert!(rule(&facts, &target(Some("alien")), "EUR").is_none());
        assert!(rule(&facts, &target(Some("missing")), "EUR").is_none());
    }
}
