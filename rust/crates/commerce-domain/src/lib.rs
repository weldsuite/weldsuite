//! WeldCommerce's order rules (`weldsuite-commerce-domain`, ADR COM-010).
//!
//! [`orders::write`] is the only way an order and its items are created or
//! changed. The commerce module's routes (`/api/orders`) and the connector
//! ingest (`weldsuite-connect-domain`, store orders) both call it, so
//! numbering ([`numbering`]), totals ([`totals`], [`money`]), discount codes
//! ([`discount`]) and the edit rules ([`status`]) have one implementation.
//! The pure parts have unit tests; the writes run on the caller's connection,
//! inside the caller's transaction.
//!
//! It never writes `fulfilled_quantity` or `fulfillment_status` (WeldStash
//! owns them, STASH-001/006), and it reserves no stock.

pub mod accounts;
pub mod approvals;
pub mod carts;
pub mod channels;
pub mod checkout;
pub mod db;
pub mod discount;
pub mod error;
pub mod money;
pub mod numbering;
pub mod orders;
pub mod payments;
pub mod prices;
pub mod status;
#[rustfmt::skip]
pub mod tables;
pub mod totals;
pub mod vat;

pub use error::{Error, LineProblem};
pub use sea_orm::DbErr;

/// `new Date().toISOString()`: UTC, milliseconds. Bound as text and cast
/// with `::timestamp`, or written through [`weldsuite_books_domain::table`].
pub(crate) fn now() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    #[allow(clippy::cast_precision_loss)]
    weldsuite_kit::validation::js_iso_from_millis(millis as f64).unwrap_or_default()
}
