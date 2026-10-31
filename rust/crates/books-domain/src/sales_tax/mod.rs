//! US sales tax (`@weldsuite/books-domain/sales-tax`), as far as the posting
//! engine needs it: cent rounding, the ship-to of a document, a breakdown
//! row's tax-ledger fields. The sales-tax area adds the engines, zones,
//! exemptions and returns next to these.

mod rounding;
mod sourcing;
mod to_tax_lines;

pub use rounding::{allocate_cents, from_cents, round_half_up, to_cents};
pub use sourcing::{pick_ship_to, state_code_of, zip5_of};
pub use to_tax_lines::{TaxLineFieldsContext, breakdown_to_tax_line_fields};
