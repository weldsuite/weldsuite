//! A row as Drizzle's `select()` returns it, for the literal statements:
//! `to_jsonb(t)`, with `numeric` columns as text (Drizzle reads them as
//! strings). The same expressions as the generated [`crate::tables`]' `row`;
//! [`crate::table::Table::js`] then names the properties and formats the
//! timestamps.

/// `boxes`.
macro_rules! box_row {
    () => {
        "(to_jsonb(t) || jsonb_build_object('length', t.\"length\"::text, 'width', t.\"width\"::text, 'height', t.\"height\"::text, 'tare_weight', t.\"tare_weight\"::text, 'max_weight', t.\"max_weight\"::text))"
    };
}

/// `purchase_orders`.
macro_rules! purchase_order_row {
    () => {
        "(to_jsonb(t) || jsonb_build_object('subtotal', t.\"subtotal\"::text, 'tax_total', t.\"tax_total\"::text, 'shipping_total', t.\"shipping_total\"::text, 'discount_total', t.\"discount_total\"::text, 'total', t.\"total\"::text))"
    };
}

/// `warehouse_locations`.
macro_rules! location_row {
    () => {
        "(to_jsonb(t) || jsonb_build_object('length', t.\"length\"::text, 'width', t.\"width\"::text, 'height', t.\"height\"::text, 'max_weight', t.\"max_weight\"::text))"
    };
}

/// `suppliers`.
macro_rules! supplier_row {
    () => {
        "(to_jsonb(t) || jsonb_build_object('credit_limit', t.\"credit_limit\"::text, 'minimum_order_value', t.\"minimum_order_value\"::text))"
    };
}

/// `inventory`.
macro_rules! inventory_row {
    () => {
        "(to_jsonb(t) || jsonb_build_object('unit_cost', t.\"unit_cost\"::text, 'total_value', t.\"total_value\"::text))"
    };
}

pub(crate) use {box_row, inventory_row, location_row, purchase_order_row, supplier_row};
