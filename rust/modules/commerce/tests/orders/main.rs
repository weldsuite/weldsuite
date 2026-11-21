//! The order book through the commerce router: `/api/orders`,
//! `/api/discounts` and `/api/commerce-settings`.
//!
//! The permission refusals run without a database. The rest runs on the real
//! tenant schema when `WELDSUITE_TEST_TENANT_URL` is set (built by
//! `scripts/rust-test-db.ts`) and returns early otherwise.

// Each test is a scenario, read top to bottom.
#![allow(clippy::too_many_lines)]

mod discounts;
mod harness;
mod orders;
mod permissions;
mod settings;
