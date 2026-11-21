//! WeldPanel's usage settlement, one test binary:
//!
//! - `sweep`: `weldsuite cron panel-usage` against the collector's counters,
//!   the `PanelUsage` Durable Object's tests (`panel-usage-settlement.test.ts`,
//!   `panel-usage.test.ts`) with panel-api faked as there;
//! - `settlement`: `services/usage-settlement.test.ts` on the real master
//!   schema (`WELDSUITE_TEST_MASTER_URL`, built by `scripts/rust-test-db.ts`;
//!   without it those tests return early);
//! - `mail`: `services/usage-mail.test.ts`, the owners read from the real
//!   tenant schema where `WELDSUITE_TEST_TENANT_URL` is set.

#[path = "usage/mail.rs"]
mod mail;
#[path = "usage/settlement.rs"]
mod settlement;
#[path = "usage/sweep.rs"]
mod sweep;
