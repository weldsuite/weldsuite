//! The Odoo connector (`provider: 'odoo'`, ADR INT-012): WeldStash
//! replenishment's link to an Odoo database, on the Rust backend only (the
//! catalog entry is `editions: ['kubernetes']`). Plan:
//! `weldsuite-documentation/plans/weldstash-replenishment.md`, phases 5
//! and 6.
//!
//! Odoo stays the master. Its warehouses arrive as WeldStash warehouses
//! managed by the connection (`warehouses.managed_by_connection_id`), whose
//! stock only the stock sync writes; products, vendors, vendor prices,
//! purchase orders and confirmed sales lines come along so the planner can
//! work, and a draft purchase order goes back as an RFQ (the stash push,
//! `send-to-odoo`, on [`client::Odoo::create`]).
//!
//! - [`client`]: the API client (JSON-2 on Odoo 19+, JSON-RPC on 16–18),
//!   version detection, error kinds, field discovery;
//! - [`mappers`]: Odoo records as WeldStash values (pure);
//! - `sync`: the seven syncs, run by [`crate::sync::sync_connection`], and
//!   the catch-up probe;
//! - `ingest`: their writes.
//!
//! Connecting, the credential test, the catch-up and the run history are
//! the connector framework's, unchanged ([`crate::provider::ProviderClient`]).

pub mod client;
#[cfg(test)]
mod db_tests;
#[cfg(any(test, feature = "testing"))]
pub mod fake;
mod ingest;
pub mod mappers;
pub(crate) mod sync;

pub use client::{Odoo, install_transport};

/// The mapping types the push reads and writes
/// (`integration_entity_mappings.external_entity_type`).
pub mod mapping_types {
    pub const WAREHOUSE: &str = super::ingest::WAREHOUSE;
    pub const PRODUCT: &str = super::ingest::PRODUCT;
    pub const SUPPLIER: &str = super::ingest::SUPPLIER;
    pub const PURCHASE_ORDER: &str = super::ingest::PURCHASE_ORDER;
}
