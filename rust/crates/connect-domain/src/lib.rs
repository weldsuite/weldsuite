//! WeldConnect's store and accounting connectors: `@weldsuite/connect-domain`
//! (`packages/domains/connect`) with what it needs of `@weldsuite/connectors`
//! (`packages/core/connectors`), shared by connect-api's
//! `/api/connectors` routes (`weldsuite-connect`) and commerce-api's product
//! sales channels (`weldsuite-commerce`).
//!
//! - [`catalog`]: the connector catalog and default field mappings
//!   (`rust/catalogs/connectors.json`, exported by `pnpm rust:catalogs`);
//! - [`connections`]: `connector_connections`, stored credentials, the
//!   client's view of a connection, sync runs and imported records;
//! - [`clients`]: the WooCommerce, Shopify and Picqer clients (product
//!   writes, the credential test) with their retries and error kinds;
//! - [`crypto`]: field encryption as connectors read it.
//!
//! Not yet here (they stay on Global until ported): the sync engine
//! (`connectors/sync.ts`, `ingest.ts`, the mappers), the Stripe and
//! Moneybird clients and OAuth flows, WooCommerce's app authorisation,
//! provider webhook registration and ingest, and the Moneybird push.

pub mod catalog;
pub mod clients;
pub mod connections;
pub mod crypto;
pub mod js;
