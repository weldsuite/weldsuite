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
//!   behind a bank account; [`bank_matching`]: bank lines matched to
//!   invoices, bills, payments and deposits; [`bank_feeds`]: bank connections
//!   through an aggregator (Plaid, Stripe Financial Connections, Ponto,
//!   Enable Banking) and their sync.
//! - [`contacts`]: the contact person of a company contact, the name and email
//!   a document keeps of its contact.
//! - [`vendor_tax`]: W-9 facts, the sealed TIN and ACH details of a vendor, the
//!   online W-9 request tokens.
//! - [`vies`]: EU VAT numbers against VIES (outbound), cached per tenant.
//! - [`nacha`], [`checks`], [`positive_pay`], [`backup_withholding`]: vendor
//!   payment runs: NACHA files, check printing and MICR, Positive Pay files,
//!   24% backup withholding.
//! - [`currency`], [`fx`]: exchange rates.
//! - [`reports_basis`]: the ledger the reports read (accrual or cash) and their periods.
//! - [`depreciation`]: fixed asset depreciation (book methods, MACRS, section 179,
//!   bonus, the mid-quarter test, gain on disposal).
//! - [`jurisdictions`], [`sales_tax`], [`address`], [`identifiers`], [`roles`]: the
//!   per-country rules and data.

pub mod address;
pub mod attachments;
pub mod backup_withholding;
pub mod bad_debt;
pub mod bank_accounts;
pub mod bank_feeds;
pub mod bank_matching;
pub mod catch_up;
pub mod checks;
pub mod compliance;
pub mod contacts;
pub mod currency;
pub mod dates;
pub mod depreciation;
pub mod document_posting;
pub mod entity_context;
pub mod fiscal_year;
pub mod form_1099;
pub mod fx;
pub mod guards;
pub mod http;
pub mod identifiers;
pub mod invoice_html;
pub mod js;
pub mod jurisdictions;
pub mod nacha;
pub mod nexus;
pub mod payments;
pub mod payroll;
pub mod positive_pay;
pub mod posting;
pub mod reports_basis;
pub mod roles;
pub mod sales_tax;
pub mod table;
pub mod tables;
pub mod tax;
pub mod tax_calendar;
pub mod vendor_tax;
pub mod vies;
