//! India GST: where a supply is made, so CGST + SGST or IGST
//! (`services/accounting-gst.ts`). The buyer's state is, in order, the place
//! of supply the user chose, the state in the buyer's GSTIN, the state of the
//! shipping address, else the billing address. Nothing is guessed beyond
//! that; a buyer abroad is an export (96).

use serde_json::Value;
use weldsuite_db::PgPool;

use crate::address::normalize_postal_address;
use crate::compliance::get_contact_vat_number;
use crate::jurisdictions::india::{
    GST_FOREIGN_COUNTRY_CODE, extract_state_code_from_gstin, gst_state_code_from_text,
    is_valid_gst_state_code,
};
use crate::jurisdictions::js_trim;

/// `GstSupply`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GstSupply {
    /// The two-digit code (96 abroad) the invoice is stored with.
    pub place_of_supply: Option<String>,
    /// The state the calculation compares with the supplier's.
    pub buyer_state_code: Option<String>,
    /// `IN` at home, the buyer's country abroad; none when no address says.
    pub buyer_country: Option<String>,
    /// The counterparty's GSTIN as its company record has it now.
    pub buyer_gstin: Option<String>,
}

/// `isGstEntity(db, entityId)`.
pub async fn is_gst_entity(db: &PgPool, entity_id: &str) -> Result<bool, sqlx::Error> {
    let code: Option<String> = sqlx::query_scalar(
        "select jurisdiction_code from entities where id = $1 and deleted_at is null limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    Ok(code.is_some_and(|c| c.to_uppercase() == "IN"))
}

/// `countryOf(address)`: India's spellings as `IN`.
fn country_of(address: Option<&Value>) -> Option<String> {
    let normalized = normalize_postal_address(address)?;
    let raw = normalized.get("country")?.as_str()?;
    let upper = js_trim(raw).to_uppercase();
    Some(if matches!(upper.as_str(), "IN" | "IND" | "INDIA") {
        "IN".into()
    } else {
        upper
    })
}

/// `normalizePostalAddress(address)?.state`.
fn state_of(address: Option<&Value>) -> Option<String> {
    normalize_postal_address(address)?
        .get("state")?
        .as_str()
        .map(str::to_owned)
}

/// `explicitPlaceOfSupply(value)`: a valid state code or 96.
fn explicit_place_of_supply(value: Option<&str>) -> Option<String> {
    let trimmed = js_trim(value?);
    if trimmed.is_empty() {
        return None;
    }
    (trimmed == GST_FOREIGN_COUNTRY_CODE || is_valid_gst_state_code(trimmed))
        .then(|| trimmed.to_owned())
}

/// `stateOfGstin(gstin)`: its state, when real.
fn state_of_gstin(gstin: Option<&str>) -> Option<String> {
    let code = extract_state_code_from_gstin(gstin.filter(|g| !g.is_empty())?)?;
    is_valid_gst_state_code(&code).then_some(code)
}

/// What [`resolve_gst_supply`] is given.
#[derive(Debug, Clone, Copy, Default)]
pub struct SupplyArgs<'a> {
    pub entity_id: &'a str,
    pub contact_id: Option<&'a str>,
    /// What the user chose (none: derive).
    pub place_of_supply: Option<&'a str>,
    pub shipping_address: Option<&'a Value>,
    pub billing_address: Option<&'a Value>,
}

/// `resolveGstSupply(db, args)`: the place of supply of an invoice or credit
/// note; `None` outside India.
pub async fn resolve_gst_supply(
    db: &PgPool,
    args: SupplyArgs<'_>,
) -> Result<Option<GstSupply>, sqlx::Error> {
    if !is_gst_entity(db, args.entity_id).await? {
        return Ok(None);
    }
    let buyer_gstin = get_contact_vat_number(db, args.contact_id).await?;
    // An invoice without addresses (an API client) falls back to the contact's own.
    let mut shipping = args.shipping_address.cloned();
    let mut billing = args.billing_address.cloned();
    if normalize_postal_address(shipping.as_ref()).is_none()
        && normalize_postal_address(billing.as_ref()).is_none()
        && let Some(contact_id) = args.contact_id.filter(|id| !id.is_empty())
    {
        let party: Option<(Option<Value>, Option<Value>)> = sqlx::query_as(
            "select billing_address, shipping_address from parties where id = $1 limit 1",
        )
        .bind(contact_id)
        .fetch_optional(db)
        .await?;
        let (party_billing, party_shipping) = party.unwrap_or((None, None));
        shipping = party_shipping;
        billing = party_billing;
    }
    let shipping_country = country_of(shipping.as_ref());
    let buyer_country = shipping_country.or_else(|| country_of(billing.as_ref()));
    let explicit = explicit_place_of_supply(args.place_of_supply);
    let foreign_buyer = buyer_country.as_deref().filter(|c| *c != "IN");

    // A buyer abroad is an export whatever else is on file; so is a chosen 96.
    let abroad = explicit.as_deref() == Some(GST_FOREIGN_COUNTRY_CODE)
        || (explicit.is_none() && foreign_buyer.is_some());
    if abroad {
        return Ok(Some(GstSupply {
            place_of_supply: Some(GST_FOREIGN_COUNTRY_CODE.into()),
            buyer_state_code: Some(GST_FOREIGN_COUNTRY_CODE.into()),
            buyer_country: foreign_buyer.map(str::to_owned),
            buyer_gstin,
        }));
    }

    let state = explicit
        .or_else(|| state_of_gstin(buyer_gstin.as_deref()))
        .or_else(|| gst_state_code_from_text(state_of(shipping.as_ref()).as_deref()))
        .or_else(|| gst_state_code_from_text(state_of(billing.as_ref()).as_deref()));
    Ok(Some(GstSupply {
        place_of_supply: state.clone(),
        buyer_state_code: state,
        buyer_country: Some("IN".into()),
        buyer_gstin,
    }))
}

/// `resolveGstBillSupply(db, args)`: the supplier's state of a bill (its
/// GSTIN, else the vendor address); `None` outside India. An import is never
/// split.
pub async fn resolve_gst_bill_supply(
    db: &PgPool,
    entity_id: &str,
    contact_id: Option<&str>,
    vendor_address: Option<&Value>,
) -> Result<Option<GstSupply>, sqlx::Error> {
    if !is_gst_entity(db, entity_id).await? {
        return Ok(None);
    }
    let supplier_gstin = get_contact_vat_number(db, contact_id).await?;
    if country_of(vendor_address).is_some_and(|c| c != "IN") {
        return Ok(Some(GstSupply {
            place_of_supply: None,
            buyer_state_code: None,
            buyer_country: Some("IN".into()),
            buyer_gstin: supplier_gstin,
        }));
    }
    let state = state_of_gstin(supplier_gstin.as_deref())
        .or_else(|| gst_state_code_from_text(state_of(vendor_address).as_deref()));
    Ok(Some(GstSupply {
        place_of_supply: None,
        buyer_state_code: state,
        buyer_country: Some("IN".into()),
        buyer_gstin: supplier_gstin,
    }))
}
