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
//!     variant_id: Option<&str>, currency: &str) -> Result<Option<Price>, DbErr>;
//! pub async fn resolve_many(conn: &mut PgConnection, targets: &[Target],
//!     currency: &str) -> Result<HashMap<Target, Price>, DbErr>;
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

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect, RelationDef};
use sqlx::PgConnection;
use weldsuite_schema::tenant::{product_prices, product_variants, products};

use crate::db;
use crate::money::{self, Cents};

/// A `numeric` amount as [`money::parse`] reads Postgres's text of it
/// (`price::text`): none below zero or past the largest amount.
pub(crate) fn parse_numeric(value: &BigDecimal) -> Option<Cents> {
    money::parse(&value.to_plain_string())
}

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

/// `product_variants.product_id` → `products.id` (the entities declare no
/// relations).
fn variant_product() -> RelationDef {
    product_variants::Entity::belongs_to(products::Entity)
        .from(product_variants::Column::ProductId)
        .to(products::Column::Id)
        .into()
}

fn base(
    price: Option<&BigDecimal>,
    compare_at: Option<&BigDecimal>,
    currency: Option<String>,
) -> Base {
    Base {
        price: price.and_then(parse_numeric),
        compare_at: compare_at.and_then(parse_numeric),
        currency,
    }
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
) -> Result<Option<Price>, DbErr> {
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
) -> Result<HashMap<Target, Price>, DbErr> {
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
    let rows = product_prices::Entity::find()
        .filter(product_prices::Column::ProductId.is_in(product_ids.iter().map(String::as_str)))
        .filter(product_prices::Column::Currency.eq(currency.as_str()))
        .filter(product_prices::Column::DeletedAt.is_null())
        .all(&db::on(conn))
        .await?;
    for row in rows {
        if let Some(price) = parse_numeric(&row.price) {
            facts.rows.insert(
                Target {
                    product_id: row.product_id,
                    variant_id: row.variant_id,
                },
                Price {
                    price,
                    compare_at: row.compare_at_price.as_ref().and_then(parse_numeric),
                },
            );
        }
    }
    let products = products::Entity::find()
        .filter(products::Column::Id.is_in(product_ids.iter().map(String::as_str)))
        .filter(products::Column::DeletedAt.is_null())
        .all(&db::on(conn))
        .await?;
    for row in products {
        facts.products.insert(
            row.id,
            base(
                Some(&row.price),
                row.compare_at_price.as_ref(),
                row.currency,
            ),
        );
    }
    if !variant_ids.is_empty() {
        type Row = (
            String,
            String,
            Option<BigDecimal>,
            Option<BigDecimal>,
            Option<String>,
        );
        // A variant's base currency is its own, else its product's.
        let variants: Vec<Row> = product_variants::Entity::find()
            .select_only()
            .column(product_variants::Column::Id)
            .column(product_variants::Column::ProductId)
            .column(product_variants::Column::Price)
            .column(product_variants::Column::CompareAtPrice)
            .column_as(
                Expr::expr(Func::coalesce([
                    Expr::col((product_variants::Entity, product_variants::Column::Currency)),
                    Expr::col((products::Entity, products::Column::Currency)),
                ])),
                "currency",
            )
            .join(JoinType::InnerJoin, variant_product())
            .filter(product_variants::Column::Id.is_in(variant_ids.iter().map(String::as_str)))
            .filter(product_variants::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&db::on(conn))
            .await?;
        for (id, owner, price, compare_at, currency) in variants {
            facts.variants.insert(
                id,
                (owner, base(price.as_ref(), compare_at.as_ref(), currency)),
            );
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
