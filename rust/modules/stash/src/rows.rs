//! A row as Drizzle's `select()` returns it, for the literal statements:
//! `to_jsonb(t)`, with `numeric` columns as text (Drizzle reads them as
//! strings). The same expressions as the generated [`crate::tables`]' `row`;
//! [`crate::table::Table::js`] then names the properties and formats the
//! timestamps.

/// `purchase_orders`.
macro_rules! purchase_order_row {
    () => {
        "(to_jsonb(t) || jsonb_build_object('subtotal', t.\"subtotal\"::text, 'tax_total', t.\"tax_total\"::text, 'shipping_total', t.\"shipping_total\"::text, 'discount_total', t.\"discount_total\"::text, 'total', t.\"total\"::text))"
    };
}

/// `purchase_order_items`.
macro_rules! purchase_order_item_row {
    () => {
        "(to_jsonb(t) || jsonb_build_object('unit_price', t.\"unit_price\"::text, 'discount_percent', t.\"discount_percent\"::text, 'discount_amount', t.\"discount_amount\"::text, 'tax_percent', t.\"tax_percent\"::text, 'tax_amount', t.\"tax_amount\"::text, 'total', t.\"total\"::text))"
    };
}

pub(crate) use {purchase_order_item_row, purchase_order_row};
