//! WeldCommerce payments (phase 5, ADR COM-013): the Mollie connection, the
//! payments and refunds of an order, Mollie's webhook, Mollie at storefront
//! checkout, and what reaches WeldBooks.
//!
//! Mollie and WeldBooks are faked (`harness`); the databases are real
//! (`WELDSUITE_TEST_MASTER_URL`, `WELDSUITE_TEST_TENANT_URL`, built by
//! `scripts/rust-test-db.ts`) and every pool has one connection, as in
//! production. Returns early without them.

// Each test is a scenario, read top to bottom.
#![allow(clippy::too_many_lines)]

mod accounts;
mod b2b;
mod books;
mod checkout;
mod connection;
mod harness;
mod orders;
