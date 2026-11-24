//! The online store (storefronts plan) through the commerce router, the
//! renderer's `/public/storefront`, the storefront edge and the hosted
//! principal of the storefront API.
//!
//! The permission refusals run without a database. The rest runs on the real
//! master and tenant schemas when `WELDSUITE_TEST_MASTER_URL` and
//! `WELDSUITE_TEST_TENANT_URL` are set (built by `scripts/rust-test-db.ts`);
//! a test returns early without them.
#![allow(
    clippy::disallowed_methods,
    reason = "test fixtures are written in SQL"
)]
// Each test is a scenario, read top to bottom.
#![allow(clippy::too_many_lines, clippy::unwrap_used)]

mod edge;
mod harness;
mod hosts;
mod permissions;
mod renderer;
mod sites;
