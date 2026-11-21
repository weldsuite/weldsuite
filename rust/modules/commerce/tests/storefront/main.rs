//! The storefront API (`/storefront/v1`): key authentication, CORS and rate
//! limits, the catalogue, carts and checkout.
//!
//! Runs on the real master and tenant schema when
//! `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are set (built
//! by `scripts/rust-test-db.ts`), and returns early otherwise.
#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]

// Each test is a scenario, read top to bottom.
#![allow(clippy::too_many_lines)]

mod auth;
mod carts;
mod catalogue;
mod checkout;
mod harness;
mod staff_keys;
