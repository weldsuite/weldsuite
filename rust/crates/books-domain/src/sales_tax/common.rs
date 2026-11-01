//! Pieces every sales tax engine shares (`sales-tax/common.ts`): the
//! registration rule, untaxed results, hand-set tax overrides, the
//! certificate of a sale and generated jurisdiction codes.

use serde_json::Value;

use super::dates::{in_range, iso_day};
use super::exemptions::{CertificateResolution, resolve_exemption_certificate};
use super::rounding::{allocate_cents, from_cents, snap6, to_cents};
use super::types::{
    CertificateRef, Detail, LineResult, Registration, RequestLine, SalesTaxRequest,
    SalesTaxResult,
};
use crate::jurisdictions::{js_trim, us};

/// `isRegistrationActive(reg, date)`.
pub fn is_registration_active(reg: &Registration, date: &str) -> bool {
    reg.status == "registered"
        && in_range(
            &iso_day(date),
            reg.registered_from.as_deref(),
            reg.registered_until.as_deref(),
        )
}

/// `activeRegistrations(registrations, stateCode, date)`: the registrations
/// in force for a state on a date; tax is charged only under these.
pub fn active_registrations<'a>(
    registrations: &'a [Registration],
    state_code: &str,
    date: &str,
) -> Vec<&'a Registration> {
    let state = js_trim(state_code).to_uppercase();
    registrations
        .iter()
        .filter(|r| js_trim(&r.state_code).to_uppercase() == state && is_registration_active(r, date))
        .collect()
}

/// `stateHasNoSalesTax(stateCode)`: DE, MT, NH, OR.
pub fn state_has_no_sales_tax(state_code: &str) -> bool {
    us::state(Some(state_code)).is_some_and(|info| {
        info["hasStateSalesTax"].as_bool() != Some(true)
            && info["hasLocalSalesTax"].as_bool() != Some(true)
    })
}

/// `isUsCountry(address)`: no country, or the US.
pub fn is_us_country(address: Option<&Value>) -> bool {
    let country = address
        .and_then(|a| a.get("country"))
        .and_then(Value::as_str)
        .map(|c| js_trim(c).to_uppercase());
    match country.as_deref() {
        None | Some("" | "US" | "USA" | "UNITED STATES") => true,
        Some(_) => false,
    }
}

/// `untaxedLine(line)`: nothing charged, but still a sale.
pub fn untaxed_line(line: &RequestLine) -> LineResult {
    let gross = from_cents(to_cents(line.amount));
    LineResult {
        line_id: line.line_id.clone(),
        gross_amount: gross,
        taxable_amount: 0.0,
        exempt_amount: 0.0,
        non_taxable_amount: gross,
        tax: 0.0,
        overridden: false,
        override_reason: None,
        details: Vec::new(),
    }
}

/// The fields of `buildResult`.
pub struct ResultFields {
    pub sourcing: &'static str,
    pub lines: Vec<LineResult>,
    pub warnings: Vec<String>,
    pub engine_ref: Option<String>,
    pub ship_to_state: Option<String>,
    pub calculated_at: String,
}

/// `[...new Set(warnings)]`.
pub fn unique(warnings: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for warning in warnings {
        if !out.contains(&warning) {
            out.push(warning);
        }
    }
    out
}

/// `buildResult(engine, req, fields)`.
pub fn build_result(engine: &str, req: &SalesTaxRequest, fields: ResultFields) -> SalesTaxResult {
    let total_cents: i64 = fields.lines.iter().map(|l| to_cents(l.tax)).sum();
    let postal_code = req
        .ship_to
        .as_ref()
        .and_then(|a| a.get("postalCode"))
        .and_then(Value::as_str)
        .map(|p| js_trim(p).to_owned())
        .filter(|p| !p.is_empty());
    SalesTaxResult {
        engine: engine.to_owned(),
        engine_ref: fields.engine_ref.filter(|r| !r.is_empty()),
        calculated_at: fields.calculated_at,
        sourcing: fields.sourcing,
        ship_to_state: fields.ship_to_state.filter(|s| !s.is_empty()),
        ship_to_postal_code: postal_code,
        lines: fields.lines,
        total_tax: from_cents(total_cents),
        warnings: unique(fields.warnings),
    }
}

/// `untaxedResult(engine, req, warnings, calculatedAt, shipToState)`.
pub fn untaxed_result(
    engine: &str,
    req: &SalesTaxRequest,
    warnings: &[&str],
    calculated_at: String,
    ship_to_state: Option<String>,
) -> SalesTaxResult {
    build_result(
        engine,
        req,
        ResultFields {
            sourcing: "none",
            lines: req.lines.iter().map(untaxed_line).collect(),
            warnings: warnings.iter().map(|w| (*w).to_owned()).collect(),
            engine_ref: None,
            ship_to_state,
            calculated_at,
        },
    )
}

/// `spreadTax(totalCents, unrounded, rates)`: a whole-cent total over the
/// unrounded tax per jurisdiction, or the rates when nothing was computed.
pub fn spread_tax(total_cents: i64, unrounded: &[f64], rates: &[f64]) -> Vec<i64> {
    let by_tax = unrounded.iter().fold(0.0, |s, x| s + x.abs());
    allocate_cents(total_cents, if by_tax > 0.0 { unrounded } else { rates })
}

/// `applyOverride(line, override)`: the user's tax on a line, spread pro rata
/// over its jurisdictions; `None` when there is no jurisdiction to carry it.
pub fn apply_override(line: &LineResult, amount: f64, reason: &str) -> Option<LineResult> {
    if line.details.is_empty() {
        return None;
    }
    let total = to_cents(amount);
    let unrounded: Vec<f64> = line.details.iter().map(|d| d.unrounded_tax).collect();
    let rates: Vec<f64> = line.details.iter().map(|d| d.rate).collect();
    let parts = spread_tax(total, &unrounded, &rates);
    let details = line
        .details
        .iter()
        .zip(parts)
        .map(|(d, part)| Detail {
            tax: from_cents(part),
            unrounded_tax: snap6(from_cents(part)),
            ..d.clone()
        })
        .collect();
    Some(LineResult {
        details,
        tax: from_cents(total),
        overridden: true,
        override_reason: Some(reason.to_owned()),
        ..line.clone()
    })
}

/// `certificateForSale(req, stateCode, date)`: the certificate that exempts
/// this sale, or the warning explaining why none does.
pub fn certificate_for_sale(
    req: &SalesTaxRequest,
    state_code: &str,
    date: &str,
) -> (Option<CertificateRef>, Option<&'static str>) {
    if req.customer.certificates.is_empty() {
        return (None, None);
    }
    match resolve_exemption_certificate(
        &req.customer.certificates,
        state_code,
        date,
        req.document_id.as_deref(),
    ) {
        CertificateResolution::Valid { certificate, .. } => (Some(certificate), None),
        CertificateResolution::Invalid {
            reason,
            candidate: Some(_),
        } => (None, Some(reason)),
        CertificateResolution::Invalid { .. } => (None, None),
    }
}

fn level_abbr(level: &str) -> String {
    match level {
        "state" => "ST".to_owned(),
        "county" => "CTY".to_owned(),
        "city" => "CIT".to_owned(),
        "district" => "DIS".to_owned(),
        other => other.to_uppercase(),
    }
}

/// `hash36(value)`: djb2 over UTF-16 units, base 36, padded to seven.
fn hash36(value: &str) -> String {
    let mut h: u32 = 5381;
    for unit in value.encode_utf16() {
        h = (h << 5).wrapping_add(h).wrapping_add(u32::from(unit));
    }
    let mut digits = Vec::new();
    let mut n = h;
    loop {
        let d = u8::try_from(n % 36).unwrap_or(0);
        digits.push(if d < 10 { b'0' + d } else { b'a' + d - 10 });
        n /= 36;
        if n == 0 {
            break;
        }
    }
    digits.reverse();
    format!("{:0>7}", String::from_utf8_lossy(&digits))
}

/// `jurisdictionCodeFor(stateCode, level, name, discriminator)`: a stable
/// code for engines that don't send one (Stripe), at most 30 characters.
pub fn jurisdiction_code_for(
    state_code: &str,
    level: &str,
    name: &str,
    discriminator: Option<&str>,
) -> String {
    let raw = match discriminator.filter(|d| !d.is_empty()) {
        Some(d) => format!("{name}-{d}"),
        None => name.to_owned(),
    }
    .to_lowercase();
    // `.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')`
    let mut slug = String::new();
    let mut dash = false;
    for c in raw.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash {
                slug.push('-');
                dash = false;
            }
            slug.push(c);
        } else if !slug.is_empty() {
            dash = true;
        }
    }
    let code = format!("{}-{}-{slug}", state_code.to_uppercase(), level_abbr(level));
    let units: Vec<u16> = code.encode_utf16().collect();
    if units.len() <= 30 {
        code
    } else {
        format!(
            "{}-{}",
            String::from_utf16_lossy(&units[..21]),
            hash36(&code)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_codes_match_javascript() {
        assert_eq!(
            jurisdiction_code_for("ca", "county", "Los Angeles County", None),
            "CA-CTY-los-angeles-county"
        );
        assert_eq!(
            jurisdiction_code_for("TX", "city", "--Austin!!", Some("8.25")),
            "TX-CIT-austin-8-25"
        );
        let long = jurisdiction_code_for("CA", "district", "Los Angeles County Metro Transit", None);
        assert_eq!(long.encode_utf16().count(), 29);
        assert!(long.starts_with("CA-DIS-los-angeles-co-"));
    }

    #[test]
    fn countries_and_states() {
        assert!(is_us_country(None));
        assert!(is_us_country(Some(&serde_json::json!({ "country": " usa " }))));
        assert!(!is_us_country(Some(&serde_json::json!({ "country": "NL" }))));
        assert!(state_has_no_sales_tax("OR"));
        assert!(!state_has_no_sales_tax("TX"));
        assert!(!state_has_no_sales_tax("ZZ"));
    }
}
