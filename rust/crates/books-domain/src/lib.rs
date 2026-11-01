//! WeldBooks rules every books area crate (`weldsuite-books`,
//! `weldsuite-books-*`) and the modules that use books (commerce, hr,
//! connect) share: `@weldsuite/books-domain` and books-api's shared services.
//!
//! The porting plan, with which module of this crate comes from where and
//! who owns it, is `rust/modules/books/PORTING.md`.
//!
//! - [`http`]: the request glue of the books routes (state, caller,
//!   refusals, validation, list envelopes).
//! - [`table`], [`tables`]: rows as Drizzle returns them, passthrough writes.
//! - [`entity_context`]: which accounting entity a request is about, numbering.
//! - [`guards`]: closed periods, lock dates, the audit trail.
//! - [`posting`]: the ledger's one way in.
//! - [`document_posting`], [`payments`], [`bad_debt`], [`catch_up`]: what
//!   invoices, bills, payments and write-offs post, and the ledger catch-up.
//! - [`payroll`]: imported payrolls, the WeldHR pay run hr posts in process.
//! - [`bank_accounts`]: account numbers (sealed, revealed), the ledger account
//!   behind a bank account.
//! - [`currency`], [`fx`]: exchange rates.
//! - [`jurisdictions`], [`sales_tax`], [`address`], [`identifiers`], [`roles`]: the
//!   per-country rules and data.

pub mod address;
pub mod bad_debt;
pub mod bank_accounts;
pub mod catch_up;
pub mod currency;
pub mod dates;
pub mod document_posting;
pub mod entity_context;
pub mod fiscal_year;
pub mod fx;
pub mod guards;
pub mod http;
pub mod identifiers;
pub mod js;
pub mod jurisdictions;
pub mod payments;
pub mod payroll;
pub mod posting;
pub mod roles;
pub mod sales_tax;
pub mod table;
pub mod tables;
