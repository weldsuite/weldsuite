//! Sales channels through the commerce router: `/api/commerce-channels` with
//! their keys and shipping rates, a product's prices per currency, and the
//! connector channel the ingest makes.
//!
//! The permission refusals run without a database. The rest runs on the real
//! tenant schema when `WELDSUITE_TEST_TENANT_URL` is set (built by
//! `scripts/rust-test-db.ts`) and, for the keys, the master registry at
//! `WELDSUITE_TEST_MASTER_URL`; a test returns early without them.

// Each test is a scenario, read top to bottom.
#![allow(clippy::too_many_lines, clippy::unwrap_used)]

mod channels;
mod harness;
mod keys;
mod permissions;
mod prices;
mod shipping;
