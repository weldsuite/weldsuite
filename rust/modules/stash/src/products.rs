//! `/api/products` (`routes/products/index.ts`): the product catalogue,
//! cursor-paged CRUD with the sales tax fields `taxable` / `taxClass`
//! (`routes/products/tax-schemas.ts`). WeldStash serves it while WeldCommerce
//! is rebuilt; the plain route-file machinery is [`crate::crud`]'s.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::sales_tax::tax_codes::{is_stripe_tax_code, is_weld_tax_code};
use weldsuite_catalogs::entity_events::{PRODUCT_CREATED, PRODUCT_DELETED, PRODUCT_UPDATED};
use weldsuite_kit::validation::{Field, Issues, Presence, Text, js_trim};

use crate::args::{Arg, cursor_sql};
use crate::crud::{
    Crud, Cursor, Gates, Messages, eq_slot, put_from, search_slot, spread_create, spread_update,
    update_or_existing,
};
use crate::rows::product_row;

type Body = Map<String, Value>;

/// `/^[A-Z]{1,2}\d{6,7}$/`: an Avalara product tax code.
fn is_product_avalara_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    let letters = bytes.iter().take_while(|b| b.is_ascii_uppercase()).count();
    let digits = bytes.len() - letters;
    (1..=2).contains(&letters)
        && (6..=7).contains(&digits)
        && bytes[letters..].iter().all(u8::is_ascii_digit)
}

/// `isAcceptedProductTaxClass(value)`: a WeldBooks tax code, a Stripe Tax
/// code or an Avalara product code
/// ([`weldsuite_books_domain::sales_tax::tax_codes`]).
fn is_accepted_product_tax_class(value: &str) -> bool {
    is_weld_tax_code(value) || is_stripe_tax_code(value) || is_product_avalara_code(value)
}

const TAX_CLASS_MESSAGE: &str =
    "Unknown tax code: use a WeldBooks code, a Stripe txcd_ code or an Avalara code";

/// `createProductBodySchema` (`updateProductBodySchema`, its `.partial()`,
/// for the PATCH): the body as Zod passes it on (passthrough), with
/// `taxClass` trimmed and blank as null.
fn product_schema(issues: &mut Issues, fields: &Body, partial: bool) -> Body {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let text = |issues: &mut Issues,
                key: &str,
                presence: Presence,
                min: Option<usize>,
                max: Option<usize>| {
        issues.text_with(fields, key, presence, Text::length(min, max));
    };
    text(issues, "name", required, Some(1), Some(255));
    text(issues, "slug", Presence::Optional, Some(1), Some(255));
    text(issues, "description", Presence::Optional, None, None);
    text(issues, "sku", Presence::Optional, None, Some(100));
    text(issues, "type", Presence::Optional, None, Some(30));
    text(issues, "status", Presence::Optional, None, Some(30));
    issues.string_or_number(fields, "price", Presence::Optional);
    text(issues, "currency", Presence::Optional, None, Some(10));
    text(issues, "categoryId", Presence::Nullish, None, None);
    text(issues, "imageUrl", Presence::Optional, None, None);
    issues.boolean(fields, "taxable", Presence::Optional);
    let mut data = fields.clone();
    // `productTaxClassSchema`: `.max(50).nullish()`, trimmed, `''` as null,
    // then refined (a refinement settles after every other check).
    let before = issues.count();
    let class = issues.text_with(
        fields,
        "taxClass",
        Presence::Nullish,
        Text::length(None, Some(50)),
    );
    let refused = match class {
        Field::Set(raw) => {
            let trimmed = js_trim(&raw);
            if trimmed.is_empty() {
                data.insert("taxClass".to_owned(), Value::Null);
                false
            } else {
                data.insert("taxClass".to_owned(), json!(trimmed));
                !is_accepted_product_tax_class(trimmed)
            }
        }
        Field::Null => {
            data.insert("taxClass".to_owned(), Value::Null);
            false
        }
        // A string past its `.max()` is still refined, untrimmed.
        Field::Absent => {
            issues.count() > before
                && fields
                    .get("taxClass")
                    .and_then(Value::as_str)
                    .is_some_and(|raw| !is_accepted_product_tax_class(raw))
        }
    };
    if refused {
        issues.custom("taxClass", TAX_CLASS_MESSAGE);
    }
    data
}

/// `eq(t.status, q.status)` when set, then `like` on name, slug, SKU and
/// barcode.
fn product_filters(query: Option<&str>) -> Vec<(bool, Vec<Arg>)> {
    vec![eq_slot(query, "status"), search_slot(query)]
}

/// `name ?? ''`.
fn name_or_empty(name: Value) -> Value {
    match name {
        Value::Null => json!(""),
        name => name,
    }
}

pub(crate) static PRODUCTS: Crud = Crud {
    table: &crate::tables::PRODUCTS,
    resource: "Product",
    id_prefix: "prod",
    gates: Gates {
        read: "products:read",
        create: "products:create",
        update: "products:update",
        delete: "products:delete",
    },
    messages: Messages {
        list: "Failed to list products",
        fetch: "Failed to fetch product",
        create: "Failed to create product",
        update: "Failed to update product",
        delete: "Failed to delete product",
    },
    schema: product_schema,
    filters: product_filters,
    live: true,
    cursor: Cursor::Created(cursor_sql!("products")),
    list_sql: concat!(
        "select ",
        product_row!(),
        " from \"products\" t where (not $1::boolean or t.deleted_at is null)",
        " and (not $2::boolean or t.status = $3)",
        " and (not $4::boolean or (t.name like $5 or t.slug like $5 or t.sku like $5 or t.barcode like $5))",
        " and (not $6::boolean or (t.created_at < $7::timestamp or (t.created_at = $7::timestamp and t.id < $8)))",
        " order by t.created_at desc, t.id desc limit $9"
    ),
    count_sql: concat!(
        "select count(*) from \"products\" t where (not $1::boolean or t.deleted_at is null)",
        " and (not $2::boolean or t.status = $3)",
        " and (not $4::boolean or (t.name like $5 or t.slug like $5 or t.sku like $5 or t.barcode like $5))",
        " and (not $6::boolean or (t.created_at < $7::timestamp or (t.created_at = $7::timestamp and t.id < $8)))"
    ),
    create: spread_create,
    update: spread_update,
    // `{ id, name: data.name ?? '', sku, status, price, currency }`.
    created: (PRODUCT_CREATED, |id, data| {
        let mut event = Map::new();
        event.insert("id".to_owned(), json!(id));
        event.insert(
            "name".to_owned(),
            name_or_empty(data.get("name").cloned().unwrap_or(Value::Null)),
        );
        for key in ["sku", "status", "price", "currency"] {
            put_from(&mut event, data, key);
        }
        Value::Object(event)
    }),
    // `(update.x ?? existing.x)`, the name `?? ''`.
    updated: (PRODUCT_UPDATED, |id, data, existing| {
        json!({
            "id": id,
            "name": name_or_empty(update_or_existing(data, existing, "name")),
            "sku": update_or_existing(data, existing, "sku"),
            "status": update_or_existing(data, existing, "status"),
            "price": update_or_existing(data, existing, "price"),
            "currency": update_or_existing(data, existing, "currency"),
        })
    }),
    // `{ id, name: existing.name ?? '' }`.
    deleted: (PRODUCT_DELETED, |id, existing| {
        json!({
            "id": id,
            "name": name_or_empty(existing.get("name").cloned().unwrap_or(Value::Null)),
        })
    }),
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_product_tax_classes() {
        assert!(is_accepted_product_tax_class("saas"));
        assert!(is_accepted_product_tax_class("txcd_20030000"));
        assert!(is_accepted_product_tax_class("P0000000"));
        assert!(is_accepted_product_tax_class("SW054000"));
        assert!(!is_accepted_product_tax_class("txcd_123"));
        assert!(!is_accepted_product_tax_class("luxury"));
        assert!(!is_accepted_product_tax_class("ABC123456"));
    }

    fn read(body: Value, partial: bool) -> (Body, usize) {
        let Value::Object(fields) = body else {
            panic!("an object");
        };
        let mut issues = Issues::default();
        let data = product_schema(&mut issues, &fields, partial);
        (data, issues.count())
    }

    #[test]
    fn tax_class_is_trimmed_cleared_and_refined() {
        let (data, issues) = read(
            json!({ "name": "Tee", "slug": "tee", "taxClass": " clothing " }),
            false,
        );
        assert_eq!(issues, 0);
        assert_eq!(data["taxClass"], json!("clothing"));
        let (data, issues) = read(json!({ "taxClass": "  " }), true);
        assert_eq!(issues, 0);
        assert_eq!(data["taxClass"], Value::Null);
        let (data, issues) = read(json!({ "name": "Tee" }), true);
        assert_eq!(issues, 0);
        assert!(!data.contains_key("taxClass"));
        let (_, issues) = read(json!({ "taxClass": "reduced" }), true);
        assert_eq!(issues, 1);
        let (_, issues) = read(json!({ "taxClass": "x".repeat(51) }), true);
        assert!(issues >= 1);
        let (_, issues) = read(json!({}), false);
        assert!(issues >= 1);
    }

    #[test]
    fn events_carry_the_name_or_an_empty_one() {
        let data = Map::new();
        assert_eq!(
            (PRODUCTS.created.1)("prod_1", &data),
            json!({ "id": "prod_1", "name": "" })
        );
        let existing = json!({ "name": null, "sku": "S1", "status": "active", "price": "9.99", "currency": "EUR" });
        let mut change = Map::new();
        change.insert("sku".to_owned(), Value::Null);
        change.insert("price".to_owned(), json!(12));
        assert_eq!(
            (PRODUCTS.updated.1)("prod_1", &change, &existing),
            json!({ "id": "prod_1", "name": "", "sku": "S1", "status": "active", "price": 12, "currency": "EUR" })
        );
        assert_eq!(
            (PRODUCTS.deleted.1)("prod_1", &json!({ "name": "Widget" })),
            json!({ "id": "prod_1", "name": "Widget" })
        );
    }
}
