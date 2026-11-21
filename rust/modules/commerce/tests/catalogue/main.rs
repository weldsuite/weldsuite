//! The catalogue through the commerce router: `/api/products` (moved from
//! WeldStash; the "stash: products" conformance suite is its parity check,
//! these tests the smoke), its variants, `/api/categories` and a product's
//! categories.
//!
//! The permission refusals run without a database. The rest runs on the real
//! tenant schema when `WELDSUITE_TEST_TENANT_URL` is set (built by
//! `scripts/rust-test-db.ts`) and returns early otherwise.

// Each test is a scenario, read top to bottom.
#![allow(clippy::too_many_lines)]

mod categories;
mod harness;
mod permissions;
mod products;
mod variants;
