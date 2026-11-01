//! Exemption certificate resolution (`sales-tax/exemptions.ts`).
//!
//! A valid certificate covering the ship-to state on the document date zeroes
//! the tax; the sale still counts as gross and exempt sales on the return.
//! Validity comes from the certificate's own expiry date, else from the
//! state's rule (`us/states.ts`): Florida's annual resale certificate ends on
//! 31 December, a Washington reseller permit after 48 months, an SST blanket
//! certificate once purchases are more than 12 months apart.

use serde_json::{Value, json};

use super::dates::{add_days, add_months, end_of_year, is_iso_day, iso_day};
use super::types::CertificateRef;
use crate::jurisdictions::{js_trim, us};

/// SST: a seller is protected when a complete certificate arrives within 90
/// days of the sale.
pub const CERTIFICATE_CURE_DAYS: i64 = 90;

/// `missingCertificateCureDeadline(saleDate)`.
pub fn missing_certificate_cure_deadline(sale_date: &str) -> Option<String> {
    add_days(&iso_day(sale_date), CERTIFICATE_CURE_DAYS)
}

/// `getCertificateRules(code)`: the state's own rules plus the SST blanket
/// rule for SST members.
pub fn certificate_rules(state_code: &str) -> Vec<Value> {
    let Some(info) = us::state(Some(state_code)) else {
        return Vec::new();
    };
    let mut rules: Vec<Value> = info["certificateRules"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if info["sst"].as_str() != Some("none") {
        rules.push(json!({
            "forms": ["sst_f0003"],
            "blanketOnly": true,
            "expiry": { "kind": "months_from_last_purchase", "months": 12 },
        }));
    }
    rules
}

fn covers(cert: &CertificateRef, state_code: &str) -> bool {
    let state = js_trim(state_code).to_uppercase();
    cert.states
        .iter()
        .any(|s| js_trim(s).to_uppercase() == state)
}

fn listed(list: &Value, value: &str) -> bool {
    list.as_array()
        .is_some_and(|items| items.iter().any(|i| i.as_str() == Some(value)))
}

fn rule_applies(rule: &Value, cert: &CertificateRef) -> bool {
    if rule.get("reasons").is_some_and(|r| !r.is_null()) && !listed(&rule["reasons"], &cert.reason)
    {
        return false;
    }
    if rule.get("forms").is_some_and(|f| !f.is_null())
        && !listed(&rule["forms"], cert.form.as_deref().unwrap_or("state_form"))
    {
        return false;
    }
    if rule["blanketOnly"].as_bool() == Some(true) && !cert.blanket {
        return false;
    }
    true
}

/// `certificateExpiry(cert, stateCode)`: the last valid day in a state: its
/// own `expiresOn`, else what the state's rule gives, else `None` (it doesn't
/// expire).
pub fn certificate_expiry(cert: &CertificateRef, state_code: &str) -> Option<String> {
    if is_iso_day(cert.expires_on.as_deref()) {
        return cert.expires_on.as_deref().map(iso_day);
    }
    for rule in certificate_rules(state_code) {
        if !rule_applies(&rule, cert) {
            continue;
        }
        let expiry = &rule["expiry"];
        let months = expiry["months"].as_i64().unwrap_or(0);
        let issued = cert.issued_on.as_deref().filter(|d| is_iso_day(Some(d)));
        match expiry["kind"].as_str() {
            Some("calendar_year_end") => {
                if let Some(issued) = issued {
                    return end_of_year(issued);
                }
            }
            Some("months_from_issue") => {
                if let Some(issued) = issued {
                    return add_months(issued, months);
                }
            }
            Some("months_from_last_purchase") => {
                let base = cert
                    .last_used_on
                    .as_deref()
                    .filter(|d| is_iso_day(Some(d)))
                    .or(cert.issued_on.as_deref());
                if let Some(base) = base.filter(|d| is_iso_day(Some(d))) {
                    return add_months(base, months);
                }
            }
            _ => {}
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Standing {
    Valid,
    Expired,
    Unusable,
}

fn standing(
    cert: &CertificateRef,
    state_code: &str,
    date: &str,
    invoice_id: Option<&str>,
) -> (Standing, Option<String>) {
    if cert.status == "revoked" || cert.status == "pending" {
        return (Standing::Unusable, None);
    }
    if let Some(issued) = cert.issued_on.as_deref() {
        if is_iso_day(Some(issued)) && iso_day(issued).as_str() > date {
            return (Standing::Unusable, None);
        }
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

/// `CertificateResolution`.
#[derive(Debug, Clone, PartialEq)]
pub enum CertificateResolution {
    Valid {
        certificate: CertificateRef,
        expires_on: Option<String>,
    },
    Invalid {
        /// `certificate_expired` | `certificate_missing`.
        reason: &'static str,
        /// The certificate that covers the state but can't be used.
        candidate: Option<CertificateRef>,
    },
}

/// `resolveExemptionCertificate(certificates, { stateCode, date, invoiceId })`:
/// the certificate that exempts a sale to the state on the date. A
/// single-purchase certificate only covers its own invoice.
pub fn resolve_exemption_certificate(
    certificates: &[CertificateRef],
    state_code: &str,
    date: &str,
    invoice_id: Option<&str>,
) -> CertificateResolution {
    let date = iso_day(date);
    let covering: Vec<&CertificateRef> = certificates
        .iter()
        .filter(|c| covers(c, state_code))
        .collect();
    let mut valid: Vec<(&CertificateRef, Option<String>, bool)> = Vec::new();
    let mut expired: Option<&CertificateRef> = None;
    for cert in &covering {
        let (standing, expires_on) = standing(cert, state_code, &date, invoice_id);
        match standing {
            Standing::Valid => valid.push((cert, expires_on, !cert.blanket)),
            Standing::Expired if expired.is_none() => expired = Some(cert),
            _ => {}
        }
    }
    if !valid.is_empty() {
        // The certificate made for this invoice first, then the one that
        // lasts longest.
        valid.sort_by(|a, b| {
            if a.2 != b.2 {
                return if a.2 {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Greater
                };
            }
            let ea = a.1.as_deref().unwrap_or("9999-12-31");
            let eb = b.1.as_deref().unwrap_or("9999-12-31");
            eb.cmp(ea)
        });
        let (certificate, expires_on, _) = valid.swap_remove(0);
        return CertificateResolution::Valid {
            certificate: certificate.clone(),
            expires_on,
        };
    }
    if let Some(expired) = expired {
        return CertificateResolution::Invalid {
            reason: "certificate_expired",
            candidate: Some(expired.clone()),
        };
    }
    CertificateResolution::Invalid {
        reason: "certificate_missing",
        candidate: covering.first().map(|c| (*c).clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cert(id: &str, states: &[&str]) -> CertificateRef {
        CertificateRef {
            id: id.into(),
            states: states.iter().map(|s| (*s).to_owned()).collect(),
            reason: "resale".into(),
            blanket: true,
            status: "valid".into(),
            ..CertificateRef::default()
        }
    }

    #[test]
    fn florida_annual_and_sst_blanket_expiry() {
        let fl = CertificateRef {
            issued_on: Some("2026-03-01".into()),
            ..cert("c1", &["FL"])
        };
        // Florida's annual resale certificate (if the state data has one).
        let expiry = certificate_expiry(&fl, "FL");
        assert!(expiry.is_none() || expiry.as_deref() == Some("2026-12-31"));
        let sst = CertificateRef {
            form: Some("sst_f0003".into()),
            issued_on: Some("2025-01-10".into()),
            last_used_on: Some("2025-06-01".into()),
            ..cert("c2", &["WA"])
        };
        assert_eq!(certificate_expiry(&sst, "WA").as_deref(), Some("2026-06-01"));
        assert_eq!(
            missing_certificate_cure_deadline("2026-07-05").as_deref(),
            Some("2026-10-03")
        );
    }

    #[test]
    fn resolution_prefers_the_invoice_certificate() {
        let blanket = cert("b", &["TX"]);
        let single = CertificateRef {
            blanket: false,
            invoice_id: Some("inv_1".into()),
            ..cert("s", &["tx"])
        };
        let found = resolve_exemption_certificate(
            &[blanket.clone(), single],
            "TX",
            "2026-05-01",
            Some("inv_1"),
        );
        assert!(matches!(found, CertificateResolution::Valid { certificate, .. } if certificate.id == "s"));
        let revoked = CertificateRef {
            status: "revoked".into(),
            ..blanket
        };
        assert_eq!(
            resolve_exemption_certificate(&[revoked.clone()], "TX", "2026-05-01", None),
            CertificateResolution::Invalid {
                reason: "certificate_missing",
                candidate: Some(revoked)
            }
        );
    }
}
