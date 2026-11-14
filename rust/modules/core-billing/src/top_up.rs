//! Credit top-ups while plans are billed through Mollie (ADR BILL-014,
//! amended): a `credit_packages` price is before VAT, as plan prices are.
//! The payment is BILL-013's (`weldsuite-core-platform`'s `topup`: the
//! checkout, the grant and the clawback on a full refund); this module
//! prices it and invoices it.
//!
//! 1. [`quote_top_up`] decides the VAT on the buyer's billing details (VIES
//!    for a VAT number, as for a plan) and writes a `credits` charge row
//!    before Mollie is called. The top-up charges the row's gross and names
//!    the row in the payment's metadata (`billingChargeId`).
//! 2. [`crate::settle_payment`] settles that payment against the row like
//!    any other charge: it records the Mollie state and, once paid, issues
//!    the WeldBooks invoice, which shows on the billing page next to the
//!    plan's. The renewal job retries an invoice the issuer refused.
//!
//! A top-up never touches the plan, the mandate or past due: a failed one is
//! only recorded, and a chargeback reopens nothing (the top-up takes the
//! credits back).

use weldsuite_kit::ApiError;

use crate::buyer;
use crate::engine::refuse_partner;
use crate::lines::{Charge, Line, LineKind};
use crate::store::{ChargeMeta, ChargeRow, Purpose};
use crate::workspace::Workspace;
use crate::{BillingError, BillingResult, BillingState};

/// What a top-up checkout asks to price.
#[derive(Debug, Clone, Copy)]
pub struct TopUpRequest<'a> {
    /// The top-up's checkout (`ctp_…`): one charge row per checkout.
    pub checkout_id: &'a str,
    pub workspace_id: &'a str,
    pub user_id: &'a str,
    pub package_id: &'a str,
    pub package_name: &'a str,
    pub credits: i64,
    /// The package's price in cents, before VAT.
    pub net: i64,
    pub currency: &'a str,
}

/// The priced top-up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotedTopUp {
    /// The charge row (`billing_payments.id`) the payment names.
    pub charge_id: String,
    /// What Mollie charges: the price plus VAT, in cents.
    pub gross: i64,
}

/// The invoice line: `Starter: 1000 credits`.
pub fn credits_description(package_name: &str, credits: i64) -> String {
    format!("{package_name}: {credits} credits")
}

/// Prices a package for the buyer's workspace and writes the charge its
/// invoice comes from. 400 `BILLING_DETAILS_REQUIRED` until the billing
/// details are complete, as for a plan: the VAT, and the invoice, need them.
pub async fn quote_top_up(
    state: &BillingState,
    request: &TopUpRequest<'_>,
) -> BillingResult<QuotedTopUp> {
    if request.net <= 0 || request.credits <= 0 {
        return Err(ApiError::bad_request("Credit package is not purchasable").into());
    }
    let master = &state.master;
    let Some(workspace) = Workspace::load(master, request.workspace_id).await? else {
        return Err(ApiError::not_found("Workspace", None).into());
    };
    refuse_partner(&workspace)?;
    let Some(tenants) = &state.tenants else {
        return Err(BillingError::internal(
            "Failed to start credit checkout",
            "no tenant databases",
        ));
    };
    let tenant = tenants(workspace.id.clone())
        .await
        .map_err(|error| BillingError::internal("Failed to start credit checkout", error))?;
    let details = match buyer::load(&tenant, &workspace.name).await? {
        Ok(details) => details,
        Err(missing) => return Err(buyer::details_required(&missing).into()),
    };
    let vat = buyer::vat_for(
        state.http.as_ref(),
        &state.settings.seller_country,
        &details,
    )
    .await;
    let language = details.language();
    let charge = Charge::new(
        request.currency,
        vec![Line {
            kind: LineKind::Credits,
            description: credits_description(request.package_name, request.credits),
            quantity: 1,
            unit_amount: request.net,
            amount: request.net,
            period_start: None,
            period_end: None,
            plan_id: None,
            addon: None,
        }],
        vat,
    );
    let meta = ChargeMeta {
        purpose: Purpose::Credits,
        charge,
        plan_id: None,
        seats: None,
        cycle: None,
        unit_amount: None,
        period_start: None,
        period_end: None,
        settles: None,
        user_id: Some(request.user_id.to_owned()),
        language: Some(language.as_str().to_owned()),
        customer: Some(details),
        applied: None,
        charged_back: None,
        credits: Some(request.credits),
        package_id: Some(request.package_id.to_owned()),
    };
    let row = ChargeRow::create(
        master,
        &workspace.id,
        &format!("credits:{}", request.checkout_id),
        &meta,
    )
    .await?;
    Ok(QuotedTopUp {
        charge_id: row.id,
        gross: i64::from(row.amount),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vat::{Treatment, VatCheck, decide};

    fn credits_charge(net: i64, vat: crate::vat::VatDecision) -> Charge {
        Charge::new(
            "EUR",
            vec![Line {
                kind: LineKind::Credits,
                description: credits_description("Starter", 1000),
                quantity: 1,
                unit_amount: net,
                amount: net,
                period_start: None,
                period_end: None,
                plan_id: None,
                addon: None,
            }],
            vat,
        )
    }

    #[test]
    fn a_package_price_gets_vat_on_top() {
        // €10.00 excl. VAT to a Dutch customer: €12.10.
        let domestic = credits_charge(1000, decide("NL", "NL", VatCheck::None));
        assert_eq!(
            (domestic.net, domestic.tax, domestic.gross),
            (1000, 210, 1210)
        );
        assert_eq!(domestic.lines[0].description, "Starter: 1000 credits");
        // A Belgian company with a valid VAT number: reverse charge, €10.00.
        let reverse = credits_charge(1000, decide("NL", "BE", VatCheck::Valid));
        assert_eq!(reverse.vat.treatment, Treatment::ReverseCharge);
        assert_eq!(reverse.gross, 1000);
        // A German consumer: German VAT through OSS, 19%.
        let oss = credits_charge(1000, decide("NL", "DE", VatCheck::None));
        assert_eq!(oss.vat.treatment, Treatment::Oss);
        assert_eq!(oss.gross, 1190);
        // Outside the EU: no VAT.
        assert_eq!(
            credits_charge(1000, decide("NL", "US", VatCheck::None)).gross,
            1000
        );
        let json = serde_json::to_value(&domestic).expect("json");
        assert_eq!(json["lines"][0]["kind"], "credits");
    }
}
