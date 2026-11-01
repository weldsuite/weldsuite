//! WeldBooks' sales tax (`@weldsuite/books-domain/sales-tax`), the part the
//! order sales tax reaches: the request and result shapes, the sourcing,
//! zone, registration and exemption certificate rules, the manual engine
//! ([`manual`]) and the loader that builds an entity's engine from the
//! tenant DB.
//!
//! Ported privately into commerce (there is no books-domain crate yet), with
//! only what an order sends: sales (never use tax), no hand-set overrides.
//! The Stripe Tax and Avalara engines are not ported: an entity configured
//! for one is refused as the engine being unavailable (see [`load_context`]).

pub(crate) mod manual;
pub(crate) mod rounding;
mod states;
pub(crate) mod tax_codes;

use serde_json::{Map, Value, json};
use sqlx::PgPool;

use states::{CertificateRule, Expiry, US_STATES, us_state};

// ---------------------------------------------------------------------------
// Addresses (`@weldsuite/books-domain/accounting-address`)
// ---------------------------------------------------------------------------

/// `PostalAddress`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Address {
    pub(crate) line1: Option<String>,
    pub(crate) line2: Option<String>,
    pub(crate) city: Option<String>,
    pub(crate) state: Option<String>,
    pub(crate) postal_code: Option<String>,
    pub(crate) country: Option<String>,
    pub(crate) county: Option<String>,
}

fn clean(value: Option<&Value>) -> Option<String> {
    let Some(Value::String(text)) = value else {
        return None;
    };
    let trimmed = weldsuite_kit::validation::js_trim(text);
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// `normalizePostalAddress(input)`: the shared address of a value in either
/// shape (legacy `street` + `houseNumber`, `province`), or `None` when it
/// holds nothing.
pub(crate) fn normalize_postal_address(input: Option<&Value>) -> Option<Address> {
    // An array is an object to `typeof`; it has none of the fields.
    let Some(Value::Object(raw)) = input else {
        return None;
    };
    let street = clean(raw.get("street"));
    let house_number = clean(raw.get("houseNumber"));
    let legacy_line1 = [street, house_number]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let address = Address {
        line1: clean(raw.get("line1"))
            .or_else(|| (!legacy_line1.is_empty()).then_some(legacy_line1)),
        line2: clean(raw.get("line2")),
        city: clean(raw.get("city")),
        state: clean(raw.get("state")).or_else(|| clean(raw.get("province"))),
        postal_code: clean(raw.get("postalCode")),
        country: clean(raw.get("country")).map(|c| c.to_uppercase()),
        county: clean(raw.get("county")),
    };
    (address != Address::default()).then_some(address)
}

// ---------------------------------------------------------------------------
// Request and result (`types.ts`)
// ---------------------------------------------------------------------------

/// `TaxUse`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaxUse {
    Business,
    Personal,
}

impl TaxUse {
    pub(crate) fn parse(text: &str) -> Option<Self> {
        match text {
            "business" => Some(Self::Business),
            "personal" => Some(Self::Personal),
            _ => None,
        }
    }
}

/// `ExemptionCertificateRef`.
#[derive(Debug, Clone)]
pub(crate) struct Certificate {
    pub(crate) id: String,
    pub(crate) states: Vec<String>,
    pub(crate) reason: String,
    pub(crate) form: Option<String>,
    pub(crate) issued_on: Option<String>,
    pub(crate) expires_on: Option<String>,
    pub(crate) blanket: bool,
    pub(crate) invoice_id: Option<String>,
    pub(crate) status: String,
    pub(crate) last_used_on: Option<String>,
}

/// `SalesTaxRegistration`.
#[derive(Debug, Clone)]
pub(crate) struct Registration {
    pub(crate) agency_id: String,
    pub(crate) state_code: String,
    pub(crate) local: bool,
    pub(crate) status: String,
    pub(crate) registered_from: Option<String>,
    pub(crate) registered_until: Option<String>,
}

/// `SalesTaxRequestLine` (no override: orders never send one).
#[derive(Debug, Clone)]
pub(crate) struct RequestLine {
    pub(crate) line_id: String,
    pub(crate) amount: f64,
    pub(crate) tax_code: String,
    pub(crate) tax_use: TaxUse,
    pub(crate) tax_included: bool,
}

/// `SalesTaxRequest` for a sale (`direction: 'sales'`).
#[derive(Debug, Clone)]
pub(crate) struct TaxRequest {
    pub(crate) document_id: Option<String>,
    pub(crate) document_date: String,
    pub(crate) ship_from: Option<Address>,
    pub(crate) ship_to: Option<Address>,
    pub(crate) certificates: Vec<Certificate>,
    pub(crate) registrations: Vec<Registration>,
    pub(crate) lines: Vec<RequestLine>,
    pub(crate) marketplace_facilitated: bool,
}

/// `SalesTaxDetail` (the fields orders read).
#[derive(Debug, Clone)]
pub(crate) struct Detail {
    pub(crate) jurisdiction_code: String,
    pub(crate) jurisdiction_name: String,
    pub(crate) level: &'static str,
    pub(crate) state_code: String,
    pub(crate) agency_id: Option<String>,
    pub(crate) rate: f64,
    pub(crate) taxable_amount: f64,
    pub(crate) tax: f64,
    pub(crate) exempt_reason: Option<String>,
    pub(crate) certificate_id: Option<String>,
}

/// `SalesTaxLineResult`.
#[derive(Debug, Clone)]
pub(crate) struct LineResult {
    pub(crate) line_id: String,
    pub(crate) taxable_amount: f64,
    pub(crate) exempt_amount: f64,
    pub(crate) non_taxable_amount: f64,
    pub(crate) tax: f64,
    pub(crate) details: Vec<Detail>,
}

/// `SalesTaxResult`.
#[derive(Debug, Clone)]
pub(crate) struct TaxResult {
    pub(crate) engine: &'static str,
    pub(crate) calculated_at: String,
    pub(crate) sourcing: &'static str,
    pub(crate) ship_to_state: Option<String>,
    pub(crate) ship_to_postal_code: Option<String>,
    pub(crate) lines: Vec<LineResult>,
    pub(crate) warnings: Vec<String>,
}

/// `SalesTaxEngineError`.
#[derive(Debug, Clone)]
pub(crate) struct EngineError {
    pub(crate) message: String,
    /// `unreachable` | `auth` | `invalid_request` | `not_configured` | `rate_limited`.
    pub(crate) code: &'static str,
    pub(crate) retryable: bool,
}

impl EngineError {
    fn not_configured(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: "not_configured",
            retryable: false,
        }
    }

    /// `{ reason, retryable }`, the details of the route's 503.
    pub(crate) fn details(&self) -> Value {
        json!({
            "reason": self.code,
            "retryable": self.retryable || self.code == "unreachable" || self.code == "rate_limited",
        })
    }
}

/// Why a calculation could not run: the engine (an [`EngineError`]) or a
/// statement (the route's 500).
#[derive(Debug)]
pub(crate) enum LoadError {
    Engine(EngineError),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for LoadError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

// ---------------------------------------------------------------------------
// Dates (`dates.ts`)
// ---------------------------------------------------------------------------

/// `isoDay(value)` of a string: trimmed, its first ten characters.
pub(crate) fn iso_day(value: &str) -> String {
    weldsuite_kit::validation::js_trim(value)
        .chars()
        .take(10)
        .collect()
}

/// `/^(\d{4})-(\d{2})-(\d{2})/`.
fn iso_prefix(text: &str) -> Option<(i64, i64, i64)> {
    let b = text.as_bytes();
    if b.len() < 10
        || b[4] != b'-'
        || b[7] != b'-'
        || ![0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|i| b[*i].is_ascii_digit())
    {
        return None;
    }
    let number =
        |range: std::ops::Range<usize>| text.get(range).and_then(|s| s.parse::<i64>().ok());
    Some((number(0..4)?, number(5..7)?, number(8..10)?))
}

/// `isIsoDay(value)`.
fn is_iso_day(value: Option<&str>) -> bool {
    value.is_some_and(|v| iso_prefix(v).is_some())
}

fn format_day(y: i64, m: i64, d: i64) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// `addMonths(value, months)` of an ISO day.
fn add_months(value: &str, months: i64) -> Option<String> {
    let (y, m, d) = iso_prefix(weldsuite_kit::validation::js_trim(value))?;
    let index = y * 12 + (m - 1) + months;
    let year = index.div_euclid(12);
    let month = index.rem_euclid(12) + 1;
    Some(format_day(year, month, d.min(days_in_month(year, month))))
}

/// `endOfYear(value)` of an ISO day.
fn end_of_year(value: &str) -> Option<String> {
    let (y, _, _) = iso_prefix(weldsuite_kit::validation::js_trim(value))?;
    Some(format_day(y, 12, 31))
}

/// `inRange(date, from, to)`.
pub(crate) fn in_range(date: &str, from: Option<&str>, to: Option<&str>) -> bool {
    let day = iso_day(date);
    if let Some(from) = from.filter(|f| !f.is_empty())
        && day < iso_day(from)
    {
        return false;
    }
    if let Some(to) = to.filter(|t| !t.is_empty())
        && day > iso_day(to)
    {
        return false;
    }
    true
}

// ---------------------------------------------------------------------------
// Sourcing (`sourcing.ts`) and zones (`zones.ts`)
// ---------------------------------------------------------------------------

/// `stateCodeOf(address)`.
pub(crate) fn state_code_of(address: Option<&Address>) -> Option<String> {
    let raw = weldsuite_kit::validation::js_trim(address?.state.as_deref()?);
    if raw.is_empty() {
        return None;
    }
    if raw.encode_utf16().count() == 2 {
        return Some(raw.to_uppercase());
    }
    let lower = raw.to_lowercase();
    Some(
        US_STATES
            .iter()
            .find(|s| s.name.to_lowercase() == lower)
            .map_or_else(|| raw.to_uppercase(), |s| s.code.to_owned()),
    )
}

fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `zip5Of(address)`: `/^(\d{5})(?:[-\s]?\d{4})?$/` on the trimmed code.
pub(crate) fn zip5_of(address: Option<&Address>) -> Option<String> {
    let raw = weldsuite_kit::validation::js_trim(address?.postal_code.as_deref()?);
    let chars: Vec<char> = raw.chars().collect();
    let digits = |s: &[char]| s.iter().all(char::is_ascii_digit);
    let ok = match chars.len() {
        5 | 9 => digits(&chars),
        10 => {
            digits(&chars[..5]) && (chars[5] == '-' || is_js_space(chars[5])) && digits(&chars[6..])
        }
        _ => false,
    };
    ok.then(|| chars[..5].iter().collect())
}

/// Where a level's jurisdictions come from (`AddressSide`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Side {
    Origin,
    Destination,
}

/// `SourcingDecision`.
#[derive(Debug, Clone)]
#[allow(clippy::struct_field_names)] // `sourcing`, as the result names it
pub(crate) struct Sourcing {
    pub(crate) sourcing: &'static str,
    pub(crate) taxing_state: String,
    /// Per level (`state`, `county`, `city`, `district`).
    pub(crate) level_source: [Side; 4],
}

/// `decideSourcing({ shipFrom, shipTo })` for a sale.
pub(crate) fn decide_sourcing(
    ship_from: Option<&Address>,
    ship_to: Option<&Address>,
) -> Option<Sourcing> {
    let taxing_state = state_code_of(ship_to)?;
    let interstate = state_code_of(ship_from).as_deref() != Some(taxing_state.as_str());
    let (sourcing, level_source) = if interstate {
        ("destination", [Side::Destination; 4])
    } else {
        match us_state(Some(&taxing_state)).map(|s| s.sourcing) {
            Some("origin") => ("origin", [Side::Origin; 4]),
            Some("modified_origin") => (
                "modified_origin",
                [Side::Origin, Side::Origin, Side::Origin, Side::Destination],
            ),
            _ => ("destination", [Side::Destination; 4]),
        }
    };
    Some(Sourcing {
        sourcing,
        taxing_state,
        level_source,
    })
}

/// A zone's postal code entry: a code, or a `{ from, to }` range.
#[derive(Debug, Clone)]
pub(crate) enum PostalEntry {
    Code(String),
    Range(Option<String>, Option<String>),
}

/// `ManualZone`.
#[derive(Debug, Clone)]
pub(crate) struct Zone {
    pub(crate) agency_id: String,
    pub(crate) jurisdiction_ids: Vec<String>,
    pub(crate) postal_codes: Vec<PostalEntry>,
    pub(crate) is_origin: bool,
    pub(crate) priority: i64,
}

/// `zip5(value)`: `/^(\d{5})/` on the trimmed value.
fn zip5_prefix(value: &str) -> Option<String> {
    let head: String = weldsuite_kit::validation::js_trim(value)
        .chars()
        .take(5)
        .collect();
    (head.chars().count() == 5 && head.chars().all(|c| c.is_ascii_digit())).then_some(head)
}

/// `zoneCoversZip(zone, zip)`.
fn zone_covers_zip(zone: &Zone, zip: Option<&str>) -> bool {
    let Some(zip) = zip else {
        return false;
    };
    zone.postal_codes.iter().any(|entry| match entry {
        PostalEntry::Code(code) => zip5_prefix(code).as_deref() == Some(zip),
        PostalEntry::Range(from, to) => {
            match (
                from.as_deref().and_then(zip5_prefix),
                to.as_deref().and_then(zip5_prefix),
            ) {
                (Some(from), Some(to)) => zip >= from.as_str() && zip <= to.as_str(),
                _ => false,
            }
        }
    })
}

fn by_priority(mut zones: Vec<&Zone>) -> Vec<&Zone> {
    zones.sort_by_key(|z| z.priority);
    zones
}

/// `pickDestinationZone(zones, zip)`.
pub(crate) fn pick_destination_zone<'a>(zones: &[&'a Zone], zip: Option<&str>) -> Option<&'a Zone> {
    by_priority(
        zones
            .iter()
            .copied()
            .filter(|z| zone_covers_zip(z, zip))
            .collect(),
    )
    .first()
    .copied()
}

/// `pickOriginZone(zones, shipFromZip)`.
pub(crate) fn pick_origin_zone<'a>(zones: &[&'a Zone], zip: Option<&str>) -> Option<&'a Zone> {
    let origins = by_priority(zones.iter().copied().filter(|z| z.is_origin).collect());
    origins
        .iter()
        .copied()
        .find(|z| zone_covers_zip(z, zip))
        .or_else(|| origins.first().copied())
        .or_else(|| pick_destination_zone(zones, zip))
}

// ---------------------------------------------------------------------------
// Registrations and untaxed results (`common.ts`)
// ---------------------------------------------------------------------------

/// `activeRegistrations(registrations, stateCode, date)`.
pub(crate) fn active_registrations<'a>(
    registrations: &'a [Registration],
    state_code: &str,
    date: &str,
) -> Vec<&'a Registration> {
    let state = weldsuite_kit::validation::js_trim(state_code).to_uppercase();
    registrations
        .iter()
        .filter(|r| {
            weldsuite_kit::validation::js_trim(&r.state_code).to_uppercase() == state
                && r.status == "registered"
                && in_range(
                    &iso_day(date),
                    r.registered_from.as_deref(),
                    r.registered_until.as_deref(),
                )
        })
        .collect()
}

/// `stateHasNoSalesTax(stateCode)`.
pub(crate) fn state_has_no_sales_tax(state_code: &str) -> bool {
    us_state(Some(state_code)).is_some_and(|s| !s.state_tax && !s.local_tax)
}

/// `isUsCountry(address)`.
pub(crate) fn is_us_country(address: Option<&Address>) -> bool {
    let country = address
        .and_then(|a| a.country.as_deref())
        .map(|c| weldsuite_kit::validation::js_trim(c).to_uppercase());
    match country.as_deref() {
        None | Some("") => true,
        Some(c) => c == "US" || c == "USA" || c == "UNITED STATES",
    }
}

/// `untaxedLine(line)`.
pub(crate) fn untaxed_line(line: &RequestLine) -> LineResult {
    let gross = rounding::from_cents(rounding::to_cents(line.amount));
    LineResult {
        line_id: line.line_id.clone(),
        taxable_amount: 0.0,
        exempt_amount: 0.0,
        non_taxable_amount: gross,
        tax: 0.0,
        details: Vec::new(),
    }
}

/// `buildResult(engine, req, fields)`.
pub(crate) fn build_result(
    req: &TaxRequest,
    sourcing: &'static str,
    lines: Vec<LineResult>,
    warnings: &[String],
    ship_to_state: Option<String>,
    calculated_at: String,
) -> TaxResult {
    let postal_code = req
        .ship_to
        .as_ref()
        .and_then(|a| a.postal_code.as_deref())
        .map(|p| weldsuite_kit::validation::js_trim(p).to_owned())
        .filter(|p| !p.is_empty());
    let mut unique: Vec<String> = Vec::new();
    for warning in warnings {
        if !unique.contains(warning) {
            unique.push(warning.clone());
        }
    }
    TaxResult {
        engine: "manual",
        calculated_at,
        sourcing,
        ship_to_state: ship_to_state.filter(|s| !s.is_empty()),
        ship_to_postal_code: postal_code,
        lines,
        warnings: unique,
    }
}

/// `untaxedResult(engine, req, warnings, calculatedAt, shipToState)`.
pub(crate) fn untaxed_result(
    req: &TaxRequest,
    warnings: &[&str],
    calculated_at: String,
    ship_to_state: Option<String>,
) -> TaxResult {
    let warnings: Vec<String> = warnings.iter().map(|w| (*w).to_owned()).collect();
    build_result(
        req,
        "none",
        req.lines.iter().map(untaxed_line).collect(),
        &warnings,
        ship_to_state,
        calculated_at,
    )
}

/// `spreadTax(totalCents, unrounded, rates)`.
pub(crate) fn spread_tax(total_cents: i64, unrounded: &[f64], rates: &[f64]) -> Vec<i64> {
    let by_tax = unrounded.iter().fold(0.0, |s, x| s + x.abs());
    rounding::allocate_cents(total_cents, if by_tax > 0.0 { unrounded } else { rates })
}

// ---------------------------------------------------------------------------
// Exemption certificates (`exemptions.ts`)
// ---------------------------------------------------------------------------

fn rule_applies(rule: &CertificateRule, cert: &Certificate) -> bool {
    if let Some(reasons) = rule.reasons
        && !reasons.contains(&cert.reason.as_str())
    {
        return false;
    }
    if let Some(forms) = rule.forms
        && !forms.contains(&cert.form.as_deref().unwrap_or("state_form"))
    {
        return false;
    }
    !rule.blanket_only || cert.blanket
}

/// `certificateExpiry(cert, stateCode)`.
fn certificate_expiry(cert: &Certificate, state_code: &str) -> Option<String> {
    if is_iso_day(cert.expires_on.as_deref()) {
        return cert.expires_on.as_deref().map(iso_day);
    }
    let rules = us_state(Some(state_code)).map_or(&[][..], |s| s.certificates);
    let issued = cert.issued_on.as_deref().filter(|d| is_iso_day(Some(d)));
    for rule in rules {
        if !rule_applies(rule, cert) {
            continue;
        }
        match rule.expiry {
            Expiry::CalendarYearEnd => {
                if let Some(issued) = issued {
                    return end_of_year(issued);
                }
            }
            Expiry::MonthsFromIssue(months) => {
                if let Some(issued) = issued {
                    return add_months(issued, months);
                }
            }
            Expiry::MonthsFromLastPurchase(months) => {
                let base = if is_iso_day(cert.last_used_on.as_deref()) {
                    cert.last_used_on.as_deref()
                } else {
                    cert.issued_on.as_deref()
                };
                if let Some(base) = base.filter(|b| is_iso_day(Some(b))) {
                    return add_months(base, months);
                }
            }
        }
    }
    None
}

#[derive(PartialEq, Eq)]
enum Standing {
    Valid,
    Expired,
    Unusable,
}

fn standing(
    cert: &Certificate,
    state_code: &str,
    date: &str,
    invoice_id: Option<&str>,
) -> (Standing, Option<String>) {
    if cert.status == "revoked" || cert.status == "pending" {
        return (Standing::Unusable, None);
    }
    if let Some(issued) = cert.issued_on.as_deref().filter(|d| is_iso_day(Some(d)))
        && iso_day(issued).as_str() > date
    {
        return (Standing::Unusable, None);
    }
    if !cert.blanket
        && (cert.invoice_id.as_deref().is_none_or(str::is_empty)
            || cert.invoice_id.as_deref() != invoice_id)
    {
        return (Standing::Unusable, None);
    }
    let expires_on = certificate_expiry(cert, state_code);
    if cert.status == "expired" || expires_on.as_deref().is_some_and(|e| date > e) {
        return (Standing::Expired, expires_on);
    }
    (Standing::Valid, expires_on)
}

/// `certificateForSale(req, stateCode, date)` (`resolveExemptionCertificate`):
/// the certificate that exempts the sale, or the warning saying why none
/// does.
pub(crate) fn certificate_for_sale<'a>(
    req: &'a TaxRequest,
    state_code: &str,
    date: &str,
) -> (Option<&'a Certificate>, Option<&'static str>) {
    if req.certificates.is_empty() {
        return (None, None);
    }
    let date = iso_day(date);
    let state = weldsuite_kit::validation::js_trim(state_code).to_uppercase();
    let covering: Vec<&Certificate> = req
        .certificates
        .iter()
        .filter(|c| {
            c.states
                .iter()
                .any(|s| weldsuite_kit::validation::js_trim(s).to_uppercase() == state)
        })
        .collect();
    let mut valid: Vec<(&Certificate, Option<String>, bool)> = Vec::new();
    let mut expired = false;
    for cert in &covering {
        match standing(cert, state_code, &date, req.document_id.as_deref()) {
            (Standing::Valid, expires_on) => valid.push((cert, expires_on, !cert.blanket)),
            (Standing::Expired, _) => expired = true,
            (Standing::Unusable, _) => {}
        }
    }
    if !valid.is_empty() {
        // The certificate made for this invoice first, then the one that lasts longest.
        valid.sort_by(|a, b| {
            b.2.cmp(&a.2).then_with(|| {
                let ea = a.1.as_deref().unwrap_or("9999-12-31");
                let eb = b.1.as_deref().unwrap_or("9999-12-31");
                eb.cmp(ea)
            })
        });
        return (Some(valid[0].0), None);
    }
    if expired {
        return (None, Some("certificate_expired"));
    }
    if covering.is_empty() {
        return (None, None);
    }
    (None, Some("certificate_missing"))
}

// ---------------------------------------------------------------------------
// Loading (`load.ts`)
// ---------------------------------------------------------------------------

/// `LoadedSalesTaxContext` with the manual engine's data.
pub(crate) struct Context {
    pub(crate) engine: manual::Engine,
    pub(crate) registrations: Vec<Registration>,
}

/// `readCredentials(blob, decrypt, engine)`.
fn read_credentials(
    blob: Option<&str>,
    keyring: &weldsuite_db::Keyring,
    engine: &str,
) -> Result<Map<String, Value>, EngineError> {
    let Some(blob) = blob.filter(|b| !b.is_empty()) else {
        return Err(EngineError::not_configured(format!(
            "The {engine} engine has no credentials; add them in the sales tax settings"
        )));
    };
    let unreadable = || {
        EngineError::not_configured(format!(
            "The {engine} credentials could not be read; enter them again"
        ))
    };
    let plain = crate::crypto::decrypt_field(blob, keyring).map_err(|_| unreadable())?;
    match serde_json::from_str::<Value>(&plain).map_err(|_| unreadable())? {
        Value::Object(map) => Ok(map),
        // An array is an object to `typeof`: it holds no credentials.
        Value::Array(_) => Ok(Map::new()),
        _ => Err(EngineError::not_configured(format!(
            "The {engine} credentials are not valid"
        ))),
    }
}

/// An engine this edition does not run: refused as unavailable, never as
/// zero tax.
fn not_ported(engine: &str) -> EngineError {
    EngineError {
        message: format!("The {engine} engine is not available on this edition"),
        code: "unreachable",
        retryable: false,
    }
}

fn level(value: &str) -> &'static str {
    match value {
        "state" => "state",
        "county" => "county",
        "city" => "city",
        _ => "district",
    }
}

/// `num(value, fallback)` of a numeric column's text.
fn num(value: Option<&str>, fallback: f64) -> f64 {
    match value {
        None | Some("") => fallback,
        Some(text) => {
            let parsed = weldsuite_kit::validation::js_number(text);
            if parsed.is_finite() { parsed } else { fallback }
        }
    }
}

type AgencyRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);
type JurisdictionRow = (String, String, String, String, Option<String>, String);
type RuleRow = (
    String,
    String,
    bool,
    Option<String>,
    String,
    Option<String>,
    String,
    Option<String>,
);

/// The manual engine's rows of an entity (`buildManualEngineData`).
#[allow(clippy::too_many_lines)] // four tables into the engine's data
async fn load_manual(db: &PgPool, entity_id: &str) -> Result<manual::Data, sqlx::Error> {
    let jurisdictions: Vec<JurisdictionRow> = sqlx::query_as(
        "select id, agency_id, state_code, level, code, name from sales_tax_jurisdictions \
         where entity_id = $1 and deleted_at is null and is_active = true",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let rates: Vec<(String, Option<String>, String, Option<String>)> = sqlx::query_as(
        "select jurisdiction_id, rate::text, effective_from::text, effective_to::text \
         from sales_tax_jurisdiction_rates where entity_id = $1 and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    #[allow(clippy::type_complexity)] // the zone's columns
    let zones: Vec<(String, Option<Value>, Option<Value>, bool, i32)> = sqlx::query_as(
        "select agency_id, jurisdiction_ids, postal_codes, is_origin, priority \
         from sales_tax_zones where entity_id = $1 and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let rules: Vec<RuleRow> = sqlx::query_as(
        "select agency_id, tax_code, taxable, taxable_percent::text, applies_to_use, rate_override::text, \
         effective_from::text, effective_to::text \
         from sales_tax_taxability_rules where entity_id = $1 and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;

    let text_list = |value: Option<Value>| match value {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map_or_else(|| item.to_string(), str::to_owned)
            })
            .collect(),
        _ => Vec::new(),
    };
    Ok(manual::Data {
        jurisdictions: jurisdictions
            .into_iter()
            .map(
                |(id, agency_id, state_code, lvl, code, name)| manual::Jurisdiction {
                    rates: rates
                        .iter()
                        .filter(|r| r.0 == id)
                        .map(|r| manual::Rate {
                            rate: num(r.1.as_deref(), 0.0),
                            effective_from: r.2.clone(),
                            effective_to: r.3.clone(),
                        })
                        .collect(),
                    id,
                    agency_id,
                    state_code: state_code.to_uppercase(),
                    level: level(&lvl),
                    code,
                    name,
                },
            )
            .collect(),
        zones: zones
            .into_iter()
            .map(|(agency_id, ids, codes, is_origin, priority)| Zone {
                agency_id,
                jurisdiction_ids: text_list(ids),
                postal_codes: match codes {
                    Some(Value::Array(codes)) => codes
                        .iter()
                        .map(|entry| match entry {
                            Value::String(code) => PostalEntry::Code(code.clone()),
                            other => PostalEntry::Range(
                                other.get("from").and_then(Value::as_str).map(str::to_owned),
                                other.get("to").and_then(Value::as_str).map(str::to_owned),
                            ),
                        })
                        .collect(),
                    _ => Vec::new(),
                },
                is_origin,
                priority: i64::from(priority),
            })
            .collect(),
        rules: rules
            .into_iter()
            .map(
                |(agency_id, tax_code, taxable, percent, applies, rate_override, from, to)| {
                    manual::Rule {
                        agency_id,
                        tax_code,
                        taxable,
                        taxable_percent: num(percent.as_deref(), 100.0),
                        applies_to_use: TaxUse::parse(&applies),
                        rate_override: rate_override.as_deref().map(|r| num(Some(r), 0.0)),
                        effective_from: from,
                        effective_to: to,
                    }
                },
            )
            .collect(),
    })
}

/// `loadSalesTaxContext(db, entityId, { decrypt })`.
pub(crate) async fn load_context(
    db: &PgPool,
    entity_id: &str,
    keyring: &weldsuite_db::Keyring,
) -> Result<Context, LoadError> {
    let entity: Option<(Option<String>, Option<Value>, Option<String>)> = sqlx::query_as(
        "select sales_tax_engine, sales_tax_engine_config, sales_tax_credentials_encrypted \
         from entities where id = $1 limit 1",
    )
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some((engine, config, credentials)) = entity else {
        return Err(LoadError::Engine(EngineError::not_configured(format!(
            "Accounting entity {entity_id} was not found"
        ))));
    };
    let requested = engine.unwrap_or_else(|| "manual".to_owned());
    if !["manual", "stripe_tax", "avalara"].contains(&requested.as_str()) {
        return Err(LoadError::Engine(EngineError::not_configured(format!(
            "Unknown sales tax engine \"{requested}\""
        ))));
    }

    let agencies: Vec<AgencyRow> = sqlx::query_as(
        "select id, state_code, level, status, registered_from::text, registered_until::text \
         from sales_tax_agencies where entity_id = $1 and deleted_at is null",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let registrations: Vec<Registration> = agencies
        .into_iter()
        .map(
            |(id, state_code, level, status, from, until)| Registration {
                agency_id: id,
                state_code: state_code.to_uppercase(),
                local: level == "local",
                status: match status.as_deref() {
                    Some(s @ ("registered" | "pending" | "monitoring" | "closed")) => s.to_owned(),
                    _ => "monitoring".to_owned(),
                },
                registered_from: from,
                registered_until: until,
            },
        )
        .collect();

    let clean_of = |map: &Map<String, Value>, key: &str| clean(map.get(key));
    match requested.as_str() {
        "manual" => Ok(Context {
            engine: manual::Engine::new(load_manual(db, entity_id).await?),
            registrations,
        }),
        "stripe_tax" => {
            let creds = read_credentials(credentials.as_deref(), keyring, "Stripe Tax")
                .map_err(LoadError::Engine)?;
            if clean_of(&creds, "apiKey").is_none() {
                return Err(LoadError::Engine(EngineError::not_configured(
                    "The Stripe Tax engine needs an API key",
                )));
            }
            Err(LoadError::Engine(not_ported("Stripe Tax")))
        }
        _ => {
            let creds = read_credentials(credentials.as_deref(), keyring, "Avalara")
                .map_err(LoadError::Engine)?;
            let settings = match config {
                Some(Value::Object(map)) => map,
                _ => Map::new(),
            };
            if clean_of(&creds, "accountId").is_none() || clean_of(&creds, "licenseKey").is_none() {
                return Err(LoadError::Engine(EngineError::not_configured(
                    "The Avalara engine needs an account id and a license key",
                )));
            }
            if clean_of(&settings, "companyCode").is_none() {
                return Err(LoadError::Engine(EngineError::not_configured(
                    "The Avalara engine needs a company code",
                )));
            }
            Err(LoadError::Engine(not_ported("Avalara")))
        }
    }
}

type CertificateRow = (
    String,
    Option<Value>,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    Option<String>,
    String,
);

/// `loadCustomerCertificates(db, entityId, partyId)`: each with the tax
/// date of its last use.
pub(crate) async fn load_customer_certificates(
    db: &PgPool,
    entity_id: &str,
    party_id: &str,
) -> Result<Vec<Certificate>, sqlx::Error> {
    let rows: Vec<CertificateRow> = sqlx::query_as(
        "select id, states, reason, form, issued_on::text, expires_on::text, blanket, invoice_id, status \
         from exemption_certificates where entity_id = $1 and party_id = $2 and deleted_at is null",
    )
    .bind(entity_id)
    .bind(party_id)
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let used: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "select certificate_id, max(tax_date)::text from tax_lines \
         where entity_id = $1 and certificate_id = any($2) group by certificate_id",
    )
    .bind(entity_id)
    .bind(&ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, states, reason, form, issued_on, expires_on, blanket, invoice_id, status)| {
                let last_used_on = used
                    .iter()
                    .find(|(cert, _)| cert.as_deref() == Some(id.as_str()))
                    .and_then(|(_, day)| day.clone());
                Certificate {
                    states: match states {
                        Some(Value::Array(states)) => states
                            .iter()
                            .map(|s| s.as_str().map_or_else(|| s.to_string(), str::to_uppercase))
                            .collect(),
                        _ => Vec::new(),
                    },
                    reason: if [
                        "resale",
                        "nonprofit",
                        "government",
                        "manufacturing",
                        "agricultural",
                        "other",
                    ]
                    .contains(&reason.as_str())
                    {
                        reason
                    } else {
                        "other".to_owned()
                    },
                    form,
                    issued_on,
                    expires_on,
                    blanket,
                    invoice_id,
                    status: if ["valid", "expired", "pending", "revoked"].contains(&status.as_str())
                    {
                        status
                    } else {
                        "pending".to_owned()
                    },
                    last_used_on,
                    id,
                }
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(state: &str, zip: &str) -> Address {
        Address {
            state: Some(state.to_owned()),
            postal_code: Some(zip.to_owned()),
            ..Address::default()
        }
    }

    #[test]
    fn reads_addresses_and_sourcing() {
        let raw = json!({ "street": "Damrak", "houseNumber": "1", "province": "Texas", "country": " us " });
        let normalized = normalize_postal_address(Some(&raw)).expect("an address");
        assert_eq!(normalized.line1.as_deref(), Some("Damrak 1"));
        assert_eq!(state_code_of(Some(&normalized)).as_deref(), Some("TX"));
        assert_eq!(normalized.country.as_deref(), Some("US"));
        assert!(normalize_postal_address(Some(&json!({ "line1": "  " }))).is_none());

        assert_eq!(
            zip5_of(Some(&address("TX", "78701-1234"))).as_deref(),
            Some("78701")
        );
        assert_eq!(
            zip5_of(Some(&address("TX", "787011234"))).as_deref(),
            Some("78701")
        );
        assert_eq!(zip5_of(Some(&address("TX", "7870"))), None);

        let tx = address("TX", "78701");
        let decided = decide_sourcing(Some(&tx), Some(&tx)).expect("a decision");
        assert_eq!(decided.sourcing, "origin");
        let ca = address("CA", "94105");
        assert_eq!(
            decide_sourcing(Some(&tx), Some(&ca))
                .expect("a decision")
                .sourcing,
            "destination"
        );
        assert_eq!(
            decide_sourcing(Some(&ca), Some(&ca))
                .expect("a decision")
                .sourcing,
            "modified_origin"
        );
        assert!(decide_sourcing(Some(&tx), None).is_none());
    }

    #[test]
    fn dates() {
        assert_eq!(add_months("2025-01-31", 1).as_deref(), Some("2025-02-28"));
        assert_eq!(add_months("2024-01-31", 13).as_deref(), Some("2025-02-28"));
        assert_eq!(end_of_year("2025-06-01").as_deref(), Some("2025-12-31"));
        assert!(in_range("2026-03-15", Some("2020-01-01"), None));
        assert!(!in_range("2019-03-15", Some("2020-01-01"), None));
    }
}
