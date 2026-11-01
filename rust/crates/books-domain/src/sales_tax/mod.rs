//! US sales tax (`@weldsuite/books-domain/sales-tax` and books-api's
//! `services/sales-tax/{document-tax,errors,runtime,route-helpers}`): the
//! engines and what a document stores from them. Sales, purchases and
//! commerce call it for US documents and orders; the `books-sales-tax` area
//! crate serves its setup, reports and returns.
//!
//! - [`engine`]: `createSalesTaxEngine`: the [`manual`] engine (rates, zones
//!   and rules the user keeps), [`stripe`] (Stripe Tax) and [`avalara`]
//!   (Avalara `AvaTax`), the provider engines calling out through the
//!   `OutboundHttp` port ([`provider`]).
//! - [`load`]: the entity's engine, registrations and manual data from the
//!   tenant database; a customer's exemption certificates.
//! - [`sourcing`], [`zones`], [`exemptions`], [`rounding`], [`dates`],
//!   [`common`]: the rules every engine shares.
//! - [`to_tax_lines`]: a result as `tax_breakdown` rows and `tax_lines`
//!   columns; a credit memo's rows from its invoice's.
//! - [`document_tax`]: one document's tax (invoices, estimates, credit memos,
//!   bills' use tax), the boundary [`crate::tax`] calls.
//! - [`errors`], [`route_helpers`]: the refusals and the setup routes' shared
//!   pieces.
//! - [`tax_codes`]: WeldBooks product tax codes and the providers' codes.

pub mod avalara;
pub mod common;
pub mod dates;
pub mod document_tax;
pub mod engine;
pub mod errors;
pub mod exemptions;
pub mod load;
pub mod manual;
pub mod provider;
pub mod rounding;
pub mod route_helpers;
pub mod sourcing;
pub mod stripe;
pub mod tax_codes;
pub mod to_tax_lines;
pub mod types;
pub mod zones;

pub use engine::{Engine, EngineConfig, create_engine};
pub use rounding::{
    DEFAULT_ROUNDING, Rounding, TaxCell, allocate_cents, from_cents, round_half_up,
    round_tax_cells, rounding_for, snap6, to_cents,
};
pub use sourcing::{SourcingDecision, decide_sourcing, pick_ship_to, state_code_of, zip5_of};
pub use to_tax_lines::{
    TaxLineContext, TaxLineFieldsContext, breakdown_tax_total, breakdown_to_tax_line_fields,
    reverse_result_for_credit_memo, sales_tax_result_to_breakdown, sales_tax_result_to_tax_lines,
};
pub use types::*;
