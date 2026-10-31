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
//! - [`currency`], [`fx`]: exchange rates.

pub mod currency;
pub mod dates;
pub mod entity_context;
pub mod fiscal_year;
pub mod fx;
pub mod guards;
pub mod http;
pub mod js;
pub mod posting;
pub mod table;
pub mod tables;
