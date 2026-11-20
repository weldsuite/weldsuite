//! Purchase orders Odoo is the master of (phase 6 of
//! `weldsuite-documentation/plans/weldstash-replenishment.md`): once a purchase order has been
//! sent to Odoo as an RFQ, its `metadata.odoo` holds the Odoo id and name,
//! and the `odoo-purchase-orders` sync keeps it current. Nothing in
//! WeldStash may then change its status or receive against it.

use serde_json::Value;

use crate::Refusal;

/// The refusal's message (400).
pub(crate) const ODOO_MANAGED_MESSAGE: &str = "This purchase order is managed in Odoo";

/// Whether `order` (a purchase order row as Drizzle returns it, `metadata`
/// a JSON object or null) was sent to Odoo: `metadata.odoo` is there and
/// not null.
pub(crate) fn is_odoo_managed(order: &Value) -> bool {
    order
        .get("metadata")
        .and_then(|metadata| metadata.get("odoo"))
        .is_some_and(|odoo| !odoo.is_null())
}

/// The 400 for an action on a purchase order sent to Odoo; `Ok` for every
/// other purchase order.
pub(crate) fn refuse_odoo_managed(order: &Value) -> Result<(), Refusal> {
    if is_odoo_managed(order) {
        return Err(Refusal::bad_request(ODOO_MANAGED_MESSAGE));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn only_a_set_odoo_key_marks_the_order() {
        assert!(is_odoo_managed(
            &json!({ "metadata": { "odoo": { "id": 7, "name": "P00007" } } })
        ));
        assert!(!is_odoo_managed(&json!({ "metadata": { "odoo": null } })));
        assert!(!is_odoo_managed(&json!({ "metadata": { "other": 1 } })));
        assert!(!is_odoo_managed(&json!({ "metadata": null })));
        assert!(!is_odoo_managed(&json!({})));
    }

    #[test]
    fn the_refusal_is_a_400_with_the_message() {
        let order = json!({ "metadata": { "odoo": { "id": 1 } } });
        let Err(Refusal::Response(response)) = refuse_odoo_managed(&order) else {
            panic!("expected a refusal");
        };
        assert_eq!(response.status(), http::StatusCode::BAD_REQUEST);
        assert!(refuse_odoo_managed(&json!({ "metadata": {} })).is_ok());
    }
}
