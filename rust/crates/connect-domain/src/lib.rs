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
//! The Picqer push (`publish-picqer.ts`) is connect-api's own and lives in
//! `weldsuite-connect` on [`clients::Picqer::send`].
//!
//! Not yet here (they stay on Global until ported): the sync engine
//! (`connectors/sync.ts`, `ingest.ts`, the mappers), the Stripe and
//! Moneybird clients and OAuth flows, WooCommerce's app authorisation,
//! provider webhook registration and ingest, and the Moneybird push.

// The sync engine and mappers mirror long TypeScript functions one for one,
// and read JSON numbers as JavaScript does.
#![allow(
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::single_match_else,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]

pub mod auth;
pub mod catalog;
pub mod clients;
pub mod connections;
pub mod crypto;
pub mod ingest;
pub mod js;
pub mod lists;
pub mod mappers;
pub mod moneybird;
pub mod moneybird_push;
pub mod provider;
pub mod stripe;
pub mod stripe_mappers;
pub mod sync;
pub mod tables;
pub mod webhooks;
