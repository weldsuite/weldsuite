//! The VAT of an order (ADR COM-014): the WeldBooks engine's EU destination
//! rules (`weldsuite_books_domain::tax::eu_vat`) applied to an order's lines
//! and shipping, for the workspace's seller entity.
//!
//! - **Seller**: `commerce_settings.default_entity_id`, else the workspace's
//!   default legal entity (`entities.is_default`), else WeldBooks' own
//!   `settings.default_entity_id`. None of them: [`Error::SellerEntityRequired`].
//!   A seller outside the EU: [`Error::SellerNotEu`] (milestone 1 sells from
//!   an EU entity; the rate-table path of `calculate_document_tax` does not
//!   know a destination country).
//! - **Destination**: the shipping address's country, else the billing
//!   address's, else the seller's own country (a sale with no address is a
//!   domestic one). The buyer's VAT number is the order's.
//! - **Lines**: each line's [`Line::vat_category`] (the variant's, else the
//!   product's), and shipping as one more `standard` line, so it carries the
//!   rate of the goods it travels with and is zero-rated with them.
//! - **Gross prices** (`prices_include_tax`): the price shown is the price
//!   paid in every country; a zero-rated sale (reverse charge, a buyer
//!   outside the EU) strips the seller's VAT from it ([`ZeroRatedGross::StripSellerVat`]),
//!   and [`Vat::vat_relief`] is what came off.
//! - **Failure** is never zero tax: the engine's errors answer
//!   [`Error::TaxEngineUnavailable`], and the write stops. VIES being down is
//!   not an error: the buyer is charged as a consumer and
//!   [`Vat::vies_unavailable`] says so.
//!
//! [`assemble`] is the pure part (unit tested); [`compute`] reads the seller
//! and runs the engine.

use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect, RelationDef,
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use weldsuite_books_domain::tax::eu_vat::{
    DestinationLine, EuTaxArgs, EuVatError, EuVatLine, EuVatResult, RateError, SupplyKind,
    VatCategory, ZeroRatedGross, calculate_eu_destination_tax_on, is_eu_member,
};
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::tenant::{commerce_settings, entities, settings};

use crate::db;
use crate::error::Error;
use crate::money::{self, Cents};
use crate::orders::lines::Line;

/// What the engine needs besides the caller's connection: the outbound HTTP
/// port (VIES). Without it VIES reads as unavailable. There is deliberately no
/// pool here: the engine reads the seller, the OSS registration and the VIES
/// cache on the connection of the order's transaction, because a tenant pool
/// may hold a single connection.
#[derive(Clone, Copy)]
pub struct Taxation<'a> {
    pub http: Option<&'a OutboundHttp>,
}

/// Who buys, as far as VAT cares.
#[derive(Debug, Clone, Copy, Default)]
pub struct Buyer<'a> {
    /// The prices on the order include VAT (catalogue prices do).
    pub prices_include_tax: bool,
    pub shipping_country: Option<&'a str>,
    pub billing_country: Option<&'a str>,
    /// As typed; VIES checks it when the sale crosses a border in the EU.
    pub vat_number: Option<&'a str>,
}

/// One line's VAT.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VatLine {
    pub category: &'static str,
    /// Hundredths of a percent: `2100` is 21%.
    pub rate_bps: u32,
    pub net: Cents,
    pub tax: Cents,
    /// What the line costs the buyer: its `total`.
    pub gross: Cents,
}

/// VAT per rate, for the order's `tax_lines`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaxLine {
    pub title: String,
    pub rate_bps: u32,
    /// The net amount the rate applied to.
    pub base: Cents,
    pub amount: Cents,
}

/// An order's VAT.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vat {
    /// `domestic`, `oss`, `reverse_charge`, `seller_rate_cross_border` or
    /// `outside_eu` (`EuTreatment::as_str`).
    pub treatment: &'static str,
    pub destination_country: String,
    pub buyer_vat_number: Option<String>,
    pub prices_include_tax: bool,
    /// VIES could not be asked; the buyer was charged as a consumer.
    pub vies_unavailable: bool,
    /// The order's lines, in order.
    pub lines: Vec<VatLine>,
    /// Shipping as a line of its own (none when there is none).
    pub shipping: Option<VatLine>,
    pub tax_total: Cents,
    /// The order's `total`: what the buyer pays.
    pub total: Cents,
    /// VAT-inclusive prices of a zero-rated sale lose the seller's VAT; this
    /// is how much (zero otherwise).
    pub vat_relief: Cents,
    pub tax_lines: Vec<TaxLine>,
}

/// `2100` as `21`, `550` as `5.5`, `2550` as `25.5`.
#[must_use]
pub fn rate_text(rate_bps: u32) -> String {
    let (whole, part) = (rate_bps / 100, rate_bps % 100);
    match part {
        0 => whole.to_string(),
        p if p % 10 == 0 => format!("{whole}.{}", p / 10),
        p => format!("{whole}.{p:02}"),
    }
}

/// `2100` as `"21.00"`: a rate as `order_items.tax_rate` and the API write it.
#[must_use]
pub fn rate_percent(rate_bps: u32) -> String {
    format!("{}.{:02}", rate_bps / 100, rate_bps % 100)
}

/// The country of an address (`{ country: "NL", … }`), upper-cased.
#[must_use]
pub fn country_of(address: Option<&Value>) -> Option<String> {
    address
        .and_then(|a| a.get("country"))
        .and_then(Value::as_str)
        .map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| !c.is_empty())
}

fn line_of(line: &EuVatLine) -> VatLine {
    VatLine {
        category: line.category.as_str(),
        rate_bps: line.rate_bps,
        net: Cents::from(line.net_minor),
        tax: Cents::from(line.tax_minor),
        gross: Cents::from(line.gross_minor),
    }
}

/// The engine's result as an order's VAT. `items` is the number of order
/// lines (a shipping line follows them), `pre_tax_total` what the order costs
/// before VAT is looked at: items minus discounts plus shipping.
#[must_use]
pub fn assemble(
    result: &EuVatResult,
    items: usize,
    buyer_vat_number: Option<String>,
    pre_tax_total: Cents,
) -> Vat {
    let mut lines: Vec<VatLine> = result.lines.iter().map(line_of).collect();
    let shipping = lines.split_off(items.min(lines.len())).pop();
    let mut tax_lines: Vec<TaxLine> = Vec::new();
    for line in &result.lines {
        let (net, tax) = (Cents::from(line.net_minor), Cents::from(line.tax_minor));
        if let Some(found) = tax_lines.iter_mut().find(|t| t.rate_bps == line.rate_bps) {
            found.base += net;
            found.amount += tax;
        } else {
            let title = match &result.rate_country {
                Some(country) => format!("VAT {}% {country}", rate_text(line.rate_bps)),
                None => format!("VAT {}%", rate_text(line.rate_bps)),
            };
            tax_lines.push(TaxLine {
                title,
                rate_bps: line.rate_bps,
                base: net,
                amount: tax,
            });
        }
    }
    let total = Cents::from(result.gross_total_minor);
    Vat {
        treatment: result.treatment.as_str(),
        destination_country: result.buyer_country.clone(),
        buyer_vat_number,
        prices_include_tax: result.prices_include_vat,
        vies_unavailable: result.vies_unavailable,
        lines,
        shipping,
        tax_total: Cents::from(result.tax_total_minor),
        total,
        vat_relief: if result.prices_include_vat {
            (pre_tax_total - total).max(0)
        } else {
            0
        },
        tax_lines,
    }
}

impl Vat {
    /// The order's `tax_lines` column: one entry per rate. `price` is the
    /// VAT amount (the column's older shape), `base` the net it applied to.
    #[must_use]
    pub fn tax_lines_json(&self) -> Value {
        Value::Array(
            self.tax_lines
                .iter()
                .map(|line| {
                    json!({
                        "title": line.title,
                        "rate": f64::from(line.rate_bps) / 100.0,
                        "base": money::format(line.base),
                        "price": money::format(line.amount),
                    })
                })
                .collect(),
        )
    }
}

/// The seller's id and country: `commerce_settings.default_entity_id`, else
/// the workspace's default legal entity, else WeldBooks' default entity; the
/// first that is a live, active entity.
async fn seller(conn: &mut PgConnection) -> Result<Option<(String, Option<String>)>, DbErr> {
    // Live and active (`coalesce(is_active, true)`): id and country.
    let usable = || {
        entities::Entity::find()
            .select_only()
            .column(entities::Column::Id)
            .column(entities::Column::JurisdictionCode)
            .filter(entities::Column::DeletedAt.is_null())
            .filter(
                Condition::any()
                    .add(entities::Column::IsActive.is_null())
                    .add(entities::Column::IsActive.eq(true)),
            )
    };
    let commerce_default: RelationDef = entities::Entity::belongs_to(commerce_settings::Entity)
        .from(entities::Column::Id)
        .to(commerce_settings::Column::DefaultEntityId)
        .into();
    let books_default: RelationDef = entities::Entity::belongs_to(settings::Entity)
        .from(entities::Column::Id)
        .to(settings::Column::DefaultEntityId)
        .into();
    let in_order = [
        usable().join(JoinType::InnerJoin, commerce_default),
        usable().filter(entities::Column::IsDefault.eq(true)),
        usable().join(JoinType::InnerJoin, books_default),
    ];
    for candidates in in_order {
        let found: Option<(String, String)> = candidates.into_tuple().one(&db::on(conn)).await?;
        if let Some((id, country)) = found {
            return Ok(Some((id, Some(country))));
        }
    }
    Ok(None)
}

/// The id of the seller entity (see `seller`): who invoices the orders.
///
/// # Errors
/// A failed statement.
pub async fn seller_entity_id(conn: &mut PgConnection) -> Result<Option<String>, DbErr> {
    Ok(seller(conn).await?.map(|(id, _)| id))
}

/// The most a line may come to, in cents: far above any real order, and
/// small enough that nothing overflows the engine's `i64` arithmetic.
const LIMIT: Cents = 1_000_000_000_000_000;

fn minor(value: Cents) -> Result<i64, Error> {
    i64::try_from(value)
        .ok()
        .filter(|v| i128::from(*v) <= LIMIT)
        .ok_or_else(|| Error::invalid("items", "The amounts are too large to calculate VAT on"))
}

/// What the engine is given about the order's lines.
#[derive(Debug, Clone, Copy)]
pub struct Basis<'a> {
    pub lines: &'a [Line],
    /// The discount on each line, aligned with `lines`.
    pub discounts: &'a [Cents],
    /// The shipping to charge (after a free-shipping code).
    pub shipping: Cents,
    /// Items minus discounts plus shipping, before VAT.
    pub pre_tax_total: Cents,
}

fn engine_lines(basis: &Basis<'_>) -> Result<Vec<DestinationLine>, Error> {
    let mut out = Vec::with_capacity(basis.lines.len() + 1);
    for (line, discount) in basis.lines.iter().zip(basis.discounts) {
        if Cents::from(line.quantity) * line.unit_price > LIMIT {
            return Err(Error::invalid(
                "items",
                "The amounts are too large to calculate VAT on",
            ));
        }
        out.push(DestinationLine {
            quantity: line.quantity,
            unit_price_minor: minor(line.unit_price)?,
            discount_minor: minor(*discount)?,
            // An unknown category is the standard rate: never undercharged.
            category: VatCategory::parse(&line.vat_category).unwrap_or(VatCategory::Standard),
        });
    }
    if basis.shipping > 0 {
        out.push(DestinationLine {
            quantity: 1,
            unit_price_minor: minor(basis.shipping)?,
            discount_minor: 0,
            category: VatCategory::Standard,
        });
    }
    Ok(out)
}

/// The VAT of an order.
///
/// # Errors
/// [`Error::SellerEntityRequired`], [`Error::SellerNotEu`],
/// [`Error::Invalid`] for a destination that is not a country code or amounts
/// too large, and [`Error::TaxEngineUnavailable`] for anything the engine
/// could not do (its database reads, a missing rate).
pub async fn compute(
    conn: &mut PgConnection,
    tax: &Taxation<'_>,
    buyer: &Buyer<'_>,
    basis: &Basis<'_>,
) -> Result<Vat, Error> {
    let (entity_id, jurisdiction) = seller(conn).await?.ok_or(Error::SellerEntityRequired)?;
    let seller_country = jurisdiction.unwrap_or_default().to_ascii_uppercase();
    if !is_eu_member(&seller_country) {
        return Err(Error::SellerNotEu {
            country: seller_country,
        });
    }
    let shipping_country = buyer.shipping_country.filter(|c| !c.trim().is_empty());
    let billing_country = buyer.billing_country.filter(|c| !c.trim().is_empty());
    let destination = shipping_country
        .or(billing_country)
        .unwrap_or(seller_country.as_str())
        .trim()
        .to_owned();
    let vat_number = buyer
        .vat_number
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    let lines = engine_lines(basis)?;
    let result = calculate_eu_destination_tax_on(
        conn,
        tax.http,
        &EuTaxArgs {
            entity_id: &entity_id,
            buyer_country: &destination,
            buyer_vat_number: vat_number.as_deref(),
            prices_include_vat: buyer.prices_include_tax,
            supply: SupplyKind::Goods,
            zero_rated_gross: ZeroRatedGross::StripSellerVat,
            date: None,
            lines: &lines,
        },
    )
    .await
    .map_err(|error| match error {
        EuVatError::InvalidBuyerCountry(country) => Error::invalid(
            if shipping_country.is_some() {
                "shippingAddress.country"
            } else {
                "billingAddress.country"
            },
            format!("{country:?} is not a country code"),
        ),
        EuVatError::SellerNotEu(country) => Error::SellerNotEu { country },
        EuVatError::Rate(RateError::UnsupportedDestination(country)) => {
            Error::DestinationNotSupported { country }
        }
        other => {
            tracing::error!(error = %other, "[commerce] the VAT engine failed");
            Error::TaxEngineUnavailable(other.to_string())
        }
    })?;
    Ok(assemble(
        &result,
        basis.lines.len(),
        vat_number,
        basis.pre_tax_total,
    ))
}

#[cfg(test)]
mod tests {
    use weldsuite_books_domain::tax::eu_vat::{
        BuyerVat, DestinationInput, calculate as engine_calculate,
    };

    use super::*;

    fn line(quantity: i64, unit_price_minor: i64, discount_minor: i64) -> DestinationLine {
        DestinationLine {
            quantity,
            unit_price_minor,
            discount_minor,
            category: VatCategory::Standard,
        }
    }

    fn run(
        buyer_country: &str,
        buyer_vat: BuyerVat,
        oss: bool,
        gross: bool,
        lines: &[DestinationLine],
    ) -> (EuVatResult, Cents) {
        let result = engine_calculate(&DestinationInput {
            seller_country: "NL",
            buyer_country,
            buyer_vat,
            oss_registered: oss,
            date: "2026-11-21",
            prices_include_vat: gross,
            supply: SupplyKind::Goods,
            zero_rated_gross: ZeroRatedGross::StripSellerVat,
            lines,
        })
        .expect("calculation");
        let pre: Cents = lines
            .iter()
            .map(|l| Cents::from(l.amount_minor()))
            .sum::<Cents>();
        (result, pre)
    }

    #[test]
    fn domestic_gross_keeps_the_prices_and_splits_out_the_vat() {
        // 2 x 12.10 gross at 21%, plus 6.05 shipping.
        let lines = [line(2, 1210, 0), line(1, 605, 0)];
        let (result, pre) = run("NL", BuyerVat::None, false, true, &lines);
        let vat = assemble(&result, 1, None, pre);
        assert_eq!(vat.treatment, "domestic");
        assert_eq!(vat.destination_country, "NL");
        assert_eq!(vat.lines.len(), 1);
        assert_eq!(vat.lines[0].gross, 2420);
        assert_eq!(vat.lines[0].tax, 420);
        assert_eq!(vat.lines[0].net, 2000);
        assert_eq!(vat.lines[0].rate_bps, 2100);
        let shipping = vat.shipping.as_ref().expect("shipping line");
        assert_eq!((shipping.gross, shipping.tax), (605, 105));
        assert_eq!((vat.total, vat.tax_total, vat.vat_relief), (3025, 525, 0));
        assert_eq!(vat.tax_lines.len(), 1);
        assert_eq!(vat.tax_lines[0].title, "VAT 21% NL");
        assert_eq!(
            (vat.tax_lines[0].base, vat.tax_lines[0].amount),
            (2500, 525)
        );
    }

    #[test]
    fn domestic_net_puts_the_vat_on_top() {
        let lines = [line(1, 1000, 100)];
        let (result, pre) = run("NL", BuyerVat::None, false, false, &lines);
        let vat = assemble(&result, 1, None, pre);
        assert_eq!(vat.lines[0].tax, 189);
        assert_eq!(vat.lines[0].gross, 1089);
        assert_eq!((vat.total, vat.tax_total, vat.vat_relief), (1089, 189, 0));
        assert!(vat.shipping.is_none());
    }

    #[test]
    fn oss_charges_the_destination_rate_on_the_same_gross_price() {
        // Belgium is 21% too; Germany 19%: the shopper still pays 11.90.
        let lines = [line(1, 1190, 0)];
        let (result, pre) = run("DE", BuyerVat::None, true, true, &lines);
        let vat = assemble(&result, 1, None, pre);
        assert_eq!(vat.treatment, "oss");
        assert_eq!(vat.lines[0].rate_bps, 1900);
        assert_eq!((vat.total, vat.tax_total), (1190, 190));
        assert_eq!(vat.tax_lines[0].title, "VAT 19% DE");
    }

    #[test]
    fn reverse_charge_strips_the_sellers_vat_from_a_gross_price() {
        let lines = [line(1, 1210, 0), line(1, 605, 0)];
        let (result, pre) = run("DE", BuyerVat::Valid, true, true, &lines);
        let vat = assemble(&result, 1, Some("DE123456789".into()), pre);
        assert_eq!(vat.treatment, "reverse_charge");
        assert_eq!(vat.tax_total, 0);
        assert_eq!(vat.lines[0].gross, 1000);
        assert_eq!(vat.shipping.as_ref().map(|s| s.gross), Some(500));
        // 12.10 + 6.05 shown, 10.00 + 5.00 charged.
        assert_eq!(vat.total, 1500);
        assert_eq!(vat.vat_relief, 315);
        assert_eq!(vat.tax_lines[0].title, "VAT 0%");
        assert_eq!(vat.buyer_vat_number.as_deref(), Some("DE123456789"));
    }

    #[test]
    fn reverse_charge_on_net_prices_changes_nothing() {
        let lines = [line(1, 1000, 0)];
        let (result, pre) = run("DE", BuyerVat::Valid, false, false, &lines);
        let vat = assemble(&result, 1, None, pre);
        assert_eq!((vat.total, vat.tax_total, vat.vat_relief), (1000, 0, 0));
    }

    #[test]
    fn a_buyer_outside_the_eu_pays_the_net_price() {
        let lines = [line(1, 1210, 0)];
        let (result, pre) = run("US", BuyerVat::None, true, true, &lines);
        let vat = assemble(&result, 1, None, pre);
        assert_eq!(vat.treatment, "outside_eu");
        assert_eq!((vat.total, vat.vat_relief), (1000, 210));
    }

    #[test]
    fn vies_down_charges_as_a_consumer_and_says_so() {
        let lines = [line(1, 1210, 0)];
        let (result, pre) = run("DE", BuyerVat::Unavailable, false, true, &lines);
        let vat = assemble(&result, 1, Some("DE123456789".into()), pre);
        assert!(vat.vies_unavailable);
        // Not reverse charged: the seller's rate on a cross-border consumer
        // sale without OSS.
        assert_eq!(vat.treatment, "seller_rate_cross_border");
        assert_eq!(vat.tax_total, 210);
    }

    #[test]
    fn mixed_categories_make_one_tax_line_per_rate() {
        let mut reduced = line(1, 109, 0);
        reduced.category = VatCategory::Reduced;
        let lines = [line(1, 121, 0), reduced];
        let (result, pre) = run("NL", BuyerVat::None, false, true, &lines);
        let vat = assemble(&result, 2, None, pre);
        let rates: Vec<u32> = vat.tax_lines.iter().map(|t| t.rate_bps).collect();
        assert_eq!(rates, vec![2100, 900]);
        assert_eq!(vat.lines[1].category, "reduced");
        assert_eq!(
            vat.tax_total,
            vat.tax_lines.iter().map(|t| t.amount).sum::<Cents>()
        );
    }

    #[test]
    fn rates_read_as_the_columns_and_titles_write_them() {
        assert_eq!(rate_text(2100), "21");
        assert_eq!(rate_text(550), "5.5");
        assert_eq!(rate_text(2550), "25.5");
        assert_eq!(rate_percent(2100), "21.00");
        assert_eq!(rate_percent(550), "5.50");
        assert_eq!(
            country_of(Some(&json!({ "country": " nl " }))).as_deref(),
            Some("NL")
        );
        assert_eq!(country_of(Some(&json!({ "country": "" }))), None);
        assert_eq!(country_of(None), None);
    }

    #[test]
    fn tax_lines_are_stored_with_their_base() {
        let lines = [line(1, 1210, 0)];
        let (result, pre) = run("NL", BuyerVat::None, false, true, &lines);
        let vat = assemble(&result, 1, None, pre);
        let stored = vat.tax_lines_json();
        assert_eq!(stored[0]["title"], "VAT 21% NL");
        assert_eq!(stored[0]["rate"], 21.0);
        assert_eq!(stored[0]["base"], "10.00");
        assert_eq!(stored[0]["price"], "2.10");
    }
}
