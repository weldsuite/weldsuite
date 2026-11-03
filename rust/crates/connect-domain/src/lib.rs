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
//! - [`crypto`]: field encryption as connectors read it;
//! - [`stripe`], [`moneybird`], [`lists`], [`provider`]: the provider
//!   clients' reads, behind one [`provider::ProviderClient`];
//! - [`sync`], [`ingest`], [`mappers`], [`stripe_mappers`], [`tables`]:
//!   the sync engine (`connectors/sync.ts`, `ingest.ts`, the mappers);
//! - [`auth`]: WooCommerce's app authorisation and the Moneybird and Stripe
//!   OAuth flows;
//! - [`webhooks`]: provider webhook registration and ingest;
//! - [`moneybird_push`]: the WeldBooks to Moneybird push;
//! - [`catchup`]: the connector catch-up's due times and probe.
//!
//! The Picqer push (`publish-picqer.ts`) is connect-api's own and lives in
//! `weldsuite-connect` on [`clients::Picqer::send`].

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
pub mod catchup;
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
