//! The plain CRUD route files ([`crate::crud`]): carriers, return reasons,
//! return rules, pickups, returns, shipments, shipping rules, shipping prices
//! and parcels. Schemas from `@weldsuite/core-api-client/schemas/*` (all
//! `.passthrough()`).

use serde_json::{Map, Value};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};

use crate::crud::{Changed, Crud, Filter, Gates, Messages, Partial};
use crate::tables;

const CARRIERS_GATES: Gates = Gates {
    read: perm::CARRIERS_READ,
    create: perm::CARRIERS_CREATE,
    update: perm::CARRIERS_UPDATE,
    delete: perm::CARRIERS_DELETE,
};

const RETURNS_GATES: Gates = Gates {
    read: perm::RETURNS_READ,
    create: perm::RETURNS_CREATE,
    update: perm::RETURNS_UPDATE,
    delete: perm::RETURNS_DELETE,
};

const PICKUPS_GATES: Gates = Gates {
    read: perm::PICKUPS_READ,
    create: perm::PICKUPS_CREATE,
    update: perm::PICKUPS_UPDATE,
    delete: perm::PICKUPS_DELETE,
};

const PARCELS_GATES: Gates = Gates {
    read: perm::PARCELS_READ,
    create: perm::PARCELS_CREATE,
    update: perm::PARCELS_UPDATE,
    delete: perm::PARCELS_DELETE,
};

const CARRIER_LIST: (&str, &str) = listing_as!(row_of!(carriers); "carriers";
    "($2::boolean or t.name like $3::text or t.code like $3::text)";
    4, 5, 6; "$7");
const RETURN_REASON_LIST: (&str, &str) = listing_as!(row_of!(return_reasons); "return_reasons";
    "($2::boolean or t.group_id = $3::text)";
    4, 5, 6; "$7");
const RETURN_RULE_LIST: (&str, &str) = listing_as!(row_of!(return_rules); "return_rules";
    "($2::boolean or t.name like $3::text)";
    4, 5, 6; "$7");
const PICKUP_LIST: (&str, &str) = listing_as!(row_of!(pickups); "pickups";
    "($2::boolean or t.carrier_id = $3::text)", "($4::boolean or t.status = $5::text)";
    6, 7, 8; "$9");
const RETURN_LIST: (&str, &str) = listing_as!(row_of!(returns); "returns";
    "($2::boolean or t.customer_id = $3::text)", "($4::boolean or t.status = $5::text)";
    6, 7, 8; "$9");
const SHIPMENT_LIST: (&str, &str) = listing_as!(row_of!(shipments); "shipments";
    "($2::boolean or t.carrier_id = $3::text)", "($4::boolean or t.status = $5::text)";
    6, 7, 8; "$9");
const SHIPPING_RULE_LIST: (&str, &str) = listing_as!(row_of!(shipping_rules); "shipping_rules";
    "($2::boolean or t.name like $3::text)";
    4, 5, 6; "$7");
const SHIPPING_PRICE_LIST: (&str, &str) = listing_as!(row_of!(shipping_prices); "shipping_prices";
    "($2::boolean or t.carrier_id = $3::text)", "($4::boolean or t.name like $5::text)";
    6, 7, 8; "$9");
const PARCEL_LIST: (&str, &str) = listing_as!(row_of!(parcels); "parcels";
    "($2::boolean or t.carrier_id = $3::text)", "($4::boolean or t.shipment_id = $5::text)",
    "($6::boolean or t.status = $7::text)",
    "($8::boolean or t.tracking_number like $9::text or t.reference_number like $9::text)";
    10, 11, 12; "$13");

const fn messages(
    list: &'static str,
    fetch: &'static str,
    create: &'static str,
    update: &'static str,
    delete: &'static str,
) -> Messages {
    Messages {
        list,
        fetch,
        create,
        update,
        delete,
    }
}

const OPT: Presence = Presence::Optional;
const NULLISH: Presence = Presence::Nullish;

/// `z.string()` with `.min()` / `.max()` and `presence`.
fn string(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    min: Option<usize>,
    max: Option<usize>,
) {
    issues.text_with(body, key, presence, Text::length(min, max));
}

/// `z.number().int()` with `presence`.
fn integer(issues: &mut Issues, body: &Map<String, Value>, key: &str, presence: Presence) {
    issues.whole_number(
        body,
        key,
        presence,
        Number {
            int: true,
            ..Number::default()
        },
    );
}

/// `z.union([z.string(), z.number()])` with `presence`.
fn amount(issues: &mut Issues, body: &Map<String, Value>, key: &str, presence: Presence) {
    issues.string_or_number(body, key, presence);
}

fn carrier_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "name", partial.required(), Some(1), Some(255));
    string(issues, body, "code", partial.required(), Some(1), Some(50));
    string(issues, body, "trackingUrlTemplate", OPT, None, Some(500));
    issues.boolean(body, "isActive", OPT);
}

fn return_reason_schema(issues: &mut Issues, body: &Map<String, Value>, _partial: Partial) {
    string(issues, body, "name", OPT, None, None);
    string(issues, body, "description", OPT, None, None);
    string(issues, body, "groupId", NULLISH, None, None);
    issues.boolean(body, "isActive", OPT);
}

fn return_rule_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "name", partial.required(), Some(1), Some(255));
    integer(issues, body, "priority", OPT);
    issues.boolean(body, "isActive", OPT);
}

fn pickup_schema(issues: &mut Issues, body: &Map<String, Value>, _partial: Partial) {
    string(issues, body, "carrierId", NULLISH, None, None);
    string(issues, body, "warehouseId", NULLISH, None, None);
    string(issues, body, "scheduledAt", OPT, None, None);
    string(issues, body, "status", OPT, None, Some(30));
    string(issues, body, "notes", OPT, None, None);
}

fn return_schema(issues: &mut Issues, body: &Map<String, Value>, _partial: Partial) {
    string(issues, body, "orderId", NULLISH, None, None);
    string(issues, body, "customerId", NULLISH, None, None);
    string(issues, body, "status", OPT, None, Some(30));
    string(issues, body, "reasonId", NULLISH, None, None);
    string(issues, body, "reasonText", OPT, None, None);
    amount(issues, body, "refundAmount", OPT);
}

fn shipment_schema(issues: &mut Issues, body: &Map<String, Value>, _partial: Partial) {
    string(issues, body, "reference", OPT, None, Some(255));
    string(issues, body, "orderId", NULLISH, None, None);
    string(issues, body, "carrierId", NULLISH, None, None);
    string(issues, body, "status", OPT, None, Some(30));
    string(issues, body, "trackingNumber", OPT, None, Some(255));
    amount(issues, body, "cost", OPT);
    string(issues, body, "currency", OPT, None, Some(10));
}

fn shipping_rule_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "name", partial.required(), Some(1), Some(255));
    string(issues, body, "carrierId", NULLISH, None, None);
    integer(issues, body, "priority", OPT);
    issues.boolean(body, "isActive", OPT);
}

fn shipping_price_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "name", partial.required(), Some(1), Some(255));
    string(issues, body, "carrierId", NULLISH, None, None);
    amount(issues, body, "price", OPT);
    string(issues, body, "currency", OPT, None, Some(10));
    issues.boolean(body, "isActive", OPT);
}

fn parcel_schema(issues: &mut Issues, body: &Map<String, Value>, _partial: Partial) {
    string(issues, body, "trackingNumber", OPT, None, Some(100));
    string(issues, body, "referenceNumber", OPT, None, Some(100));
    string(issues, body, "carrierId", NULLISH, None, None);
    string(issues, body, "shipmentId", NULLISH, None, None);
    string(issues, body, "status", OPT, None, Some(30));
    amount(issues, body, "weight", OPT);
    string(issues, body, "weightUnit", OPT, None, Some(10));
}

pub(crate) static CARRIERS: Crud = Crud {
    table: &tables::CARRIERS,
    resource: "Carrier",
    id_prefix: "crr",
    gates: CARRIERS_GATES,
    messages: messages(
        "Failed to list carriers",
        "Failed to fetch carrier",
        "Failed to create carrier",
        "Failed to update carrier",
        "Failed to delete carrier",
    ),
    schema: carrier_schema,
    filters: &[Filter::like("search")],
    list_sql: CARRIER_LIST.0,
    count_sql: CARRIER_LIST.1,
    slice_count: true,
    created: ev::PARCEL_CARRIER_CREATED,
    created_fields: &["name", "code"],
    updated: ev::PARCEL_CARRIER_UPDATED,
    updated_fields: &[
        Changed::UpdateOrExisting("name"),
        Changed::UpdateOrExisting("code"),
    ],
    deleted: ev::PARCEL_CARRIER_DELETED,
};

pub(crate) static RETURN_REASONS: Crud = Crud {
    table: &tables::RETURN_REASONS,
    resource: "Return reason",
    id_prefix: "rsn",
    gates: RETURNS_GATES,
    messages: messages(
        "Failed to list return reasons",
        "Failed to fetch return reason",
        "Failed to create return reason",
        "Failed to update return reason",
        "Failed to delete return reason",
    ),
    schema: return_reason_schema,
    filters: &[Filter::eq("groupId")],
    list_sql: RETURN_REASON_LIST.0,
    count_sql: RETURN_REASON_LIST.1,
    slice_count: true,
    created: ev::RETURN_REASON_CREATED,
    created_fields: &["label", "code", "groupId"],
    updated: ev::RETURN_REASON_UPDATED,
    updated_fields: &[
        Changed::UpdateOrExisting("label"),
        Changed::Existing("code"),
        Changed::UpdateOrExisting("groupId"),
    ],
    deleted: ev::RETURN_REASON_DELETED,
};

pub(crate) static RETURN_RULES: Crud = Crud {
    table: &tables::RETURN_RULES,
    resource: "Return rule",
    id_prefix: "rrul",
    gates: RETURNS_GATES,
    messages: messages(
        "Failed to list return rules",
        "Failed to fetch return rule",
        "Failed to create return rule",
        "Failed to update return rule",
        "Failed to delete return rule",
    ),
    schema: return_rule_schema,
    filters: &[Filter::like("search")],
    list_sql: RETURN_RULE_LIST.0,
    count_sql: RETURN_RULE_LIST.1,
    slice_count: true,
    created: ev::RETURN_RULE_CREATED,
    created_fields: &["name"],
    updated: ev::RETURN_RULE_UPDATED,
    updated_fields: &[Changed::UpdateOrExisting("name")],
    deleted: ev::RETURN_RULE_DELETED,
};

pub(crate) static PICKUPS: Crud = Crud {
    table: &tables::PICKUPS,
    resource: "Pickup",
    id_prefix: "pup",
    gates: PICKUPS_GATES,
    messages: messages(
        "Failed to list pickups",
        "Failed to fetch pickup",
        "Failed to create pickup",
        "Failed to update pickup",
        "Failed to delete pickup",
    ),
    schema: pickup_schema,
    filters: &[Filter::eq("carrierId"), Filter::eq("status")],
    list_sql: PICKUP_LIST.0,
    count_sql: PICKUP_LIST.1,
    slice_count: true,
    created: ev::PARCEL_PICKUP_CREATED,
    created_fields: &["carrierId", "status"],
    updated: ev::PARCEL_PICKUP_UPDATED,
    updated_fields: &[
        Changed::UpdateOrExisting("carrierId"),
        Changed::UpdateOrExisting("status"),
    ],
    deleted: ev::PARCEL_PICKUP_DELETED,
};

pub(crate) static RETURNS: Crud = Crud {
    table: &tables::RETURNS,
    resource: "Return",
    id_prefix: "ret",
    gates: RETURNS_GATES,
    messages: messages(
        "Failed to list returns",
        "Failed to fetch return",
        "Failed to create return",
        "Failed to update return",
        "Failed to delete return",
    ),
    schema: return_schema,
    filters: &[Filter::eq("customerId"), Filter::eq("status")],
    list_sql: RETURN_LIST.0,
    count_sql: RETURN_LIST.1,
    slice_count: true,
    created: ev::RETURN_CREATED,
    created_fields: &["customerId", "status"],
    updated: ev::RETURN_UPDATED,
    updated_fields: &[
        Changed::UpdateOrExisting("customerId"),
        Changed::UpdateOrExisting("status"),
    ],
    deleted: ev::RETURN_DELETED,
};

pub(crate) static SHIPMENTS: Crud = Crud {
    table: &tables::SHIPMENTS,
    resource: "Shipment",
    id_prefix: "shp",
    gates: PARCELS_GATES,
    messages: messages(
        "Failed to list shipments",
        "Failed to fetch shipment",
        "Failed to create shipment",
        "Failed to update shipment",
        "Failed to delete shipment",
    ),
    schema: shipment_schema,
    filters: &[Filter::eq("carrierId"), Filter::eq("status")],
    list_sql: SHIPMENT_LIST.0,
    count_sql: SHIPMENT_LIST.1,
    slice_count: true,
    created: ev::SHIPMENT_CREATED,
    created_fields: &["carrierId", "status"],
    updated: ev::SHIPMENT_UPDATED,
    updated_fields: &[
        Changed::UpdateOrExisting("carrierId"),
        Changed::UpdateOrExisting("status"),
    ],
    deleted: ev::SHIPMENT_DELETED,
};

pub(crate) static SHIPPING_RULES: Crud = Crud {
    table: &tables::SHIPPING_RULES,
    resource: "Shipping rule",
    id_prefix: "srul",
    gates: PARCELS_GATES,
    messages: messages(
        "Failed to list shipping rules",
        "Failed to fetch shipping rule",
        "Failed to create shipping rule",
        "Failed to update shipping rule",
        "Failed to delete shipping rule",
    ),
    schema: shipping_rule_schema,
    filters: &[Filter::like("search")],
    list_sql: SHIPPING_RULE_LIST.0,
    count_sql: SHIPPING_RULE_LIST.1,
    slice_count: true,
    created: ev::SHIPPING_RULE_CREATED,
    created_fields: &["name"],
    updated: ev::SHIPPING_RULE_UPDATED,
    updated_fields: &[Changed::UpdateOrExisting("name")],
    deleted: ev::SHIPPING_RULE_DELETED,
};

pub(crate) static SHIPPING_PRICES: Crud = Crud {
    table: &tables::SHIPPING_PRICES,
    resource: "Shipping price",
    id_prefix: "spr",
    gates: PARCELS_GATES,
    messages: messages(
        "Failed to list shipping prices",
        "Failed to fetch shipping price",
        "Failed to create shipping price",
        "Failed to update shipping price",
        "Failed to delete shipping price",
    ),
    schema: shipping_price_schema,
    filters: &[Filter::eq("carrierId"), Filter::like("search")],
    list_sql: SHIPPING_PRICE_LIST.0,
    count_sql: SHIPPING_PRICE_LIST.1,
    slice_count: true,
    created: ev::SHIPPING_PRICE_CREATED,
    created_fields: &["name", "carrierId"],
    updated: ev::SHIPPING_PRICE_UPDATED,
    updated_fields: &[
        Changed::UpdateOrExisting("name"),
        Changed::UpdateOrExisting("carrierId"),
    ],
    deleted: ev::SHIPPING_PRICE_DELETED,
};

pub(crate) static PARCELS: Crud = Crud {
    table: &tables::PARCELS,
    resource: "Parcel",
    id_prefix: "par",
    gates: PARCELS_GATES,
    messages: messages(
        "Failed to list parcels",
        "Failed to fetch parcel",
        "Failed to create parcel",
        "Failed to update parcel",
        "Failed to delete parcel",
    ),
    schema: parcel_schema,
    filters: &[
        Filter::eq("carrierId"),
        Filter::eq("shipmentId"),
        Filter::eq("status"),
        Filter::like("search"),
    ],
    list_sql: PARCEL_LIST.0,
    count_sql: PARCEL_LIST.1,
    // `buildListFilters` + a separate cursor condition: the count is the
    // filters only.
    slice_count: false,
    created: ev::PARCEL_CREATED,
    created_fields: &["trackingNumber", "referenceNumber", "status", "carrierId"],
    updated: ev::PARCEL_UPDATED,
    updated_fields: &[
        Changed::UpdateOrExisting("trackingNumber"),
        Changed::UpdateOrExisting("status"),
        Changed::UpdateOrExisting("carrierId"),
    ],
    deleted: ev::PARCEL_DELETED,
};
