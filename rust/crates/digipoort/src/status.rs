//! What a delivery's statuses mean for the filing, and the record a filing
//! keeps of its delivery (`digipoortResponse` on `vat_returns`,
//! `icp_declarations` and `annual_reports`).
//!
//! A delivery is final at 500 (accepted) or at one of the failure codes
//! ([`crate::profile::is_failure`]); everything else is still on its way.
//! The receiving party answers within two working days [DIALOOG], so a
//! filing is polled on a backing-off schedule ([`next_poll`]) until then.

use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::client::{Delivered, DigipoortError, StatusEntry};
use crate::config::Mode;
use crate::profile;

/// Where a delivery stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Received by Digipoort, not yet delivered (codes below 200).
    Submitted,
    /// On its way through Digipoort or the receiving party.
    Processing,
    /// The receiving party accepted it (500).
    Accepted,
    /// Refused, finally.
    Rejected,
    /// Digipoort wouldn't say: the statuses belong to another certificate.
    Unknown,
}

impl Outcome {
    /// As the filing-status routes answer it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Submitted => "submitted",
            Self::Processing => "processing",
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Unknown => "unknown",
        }
    }

    pub fn is_final(self) -> bool {
        matches!(self, Self::Accepted | Self::Rejected)
    }
}

/// The statuses read together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assessment {
    pub outcome: Outcome,
    /// The status that decided it (the latest otherwise).
    pub code: Option<String>,
    pub description: Option<String>,
    /// Why it was refused, for a rejection.
    pub reason: Option<String>,
}

/// The first `n` characters.
fn head(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// Reads every status of a delivery: a failure anywhere refuses it, 500
/// accepts it, otherwise the latest says how far it got.
pub fn assess(statuses: &[StatusEntry]) -> Assessment {
    if let Some(failed) = statuses.iter().find(|s| profile::is_failure(&s.code)) {
        let reason = failed
            .error_description
            .clone()
            .or_else(|| (!failed.description.is_empty()).then(|| failed.description.clone()))
            .map(|reason| match &failed.error_code {
                Some(code) => format!("{reason} ({code})"),
                None => reason,
            });
        return Assessment {
            outcome: Outcome::Rejected,
            code: Some(failed.code.clone()),
            description: Some(failed.description.clone()),
            reason,
        };
    }
    if let Some(accepted) = statuses.iter().find(|s| s.code == profile::ACCEPTED) {
        return Assessment {
            outcome: Outcome::Accepted,
            code: Some(accepted.code.clone()),
            description: Some(accepted.description.clone()),
            reason: None,
        };
    }
    let latest = statuses
        .iter()
        .max_by_key(|s| s.code.parse::<u32>().unwrap_or(0));
    let outcome = match latest {
        Some(s) if s.code == profile::NOT_AUTHORISED => Outcome::Unknown,
        Some(s) if s.code.parse::<u32>().unwrap_or(0) >= 200 => Outcome::Processing,
        _ => Outcome::Submitted,
    };
    Assessment {
        outcome,
        code: latest.map(|s| s.code.clone()),
        description: latest.map(|s| s.description.clone()),
        reason: None,
    }
}

/// When to read the statuses next, from the delivery's age: every five
/// minutes the first hour, hourly the first day, every four hours after
/// that (Logius suggests 15 s, 1 min, 15 min, 1 h, then 4 h), and not at
/// all after 14 days: the receiving party answers within two working days,
/// so a delivery still open then needs a person.
pub fn next_poll(submitted: OffsetDateTime, now: OffsetDateTime) -> Option<OffsetDateTime> {
    let age = now - submitted;
    if age >= time::Duration::days(14) {
        None
    } else if age < time::Duration::hours(1) {
        Some(now + time::Duration::minutes(5))
    } else if age < time::Duration::days(1) {
        Some(now + time::Duration::hours(1))
    } else {
        Some(now + time::Duration::hours(4))
    }
}

/// The ISO timestamp (`toISOString()`) of `at`.
pub fn iso(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
}

/// What a filing stores once Digipoort took the message.
pub fn delivered_record(
    mode: Mode,
    berichtsoort: &str,
    aanleverkenmerk: &str,
    delivered: &Delivered,
    now: OffsetDateTime,
) -> Value {
    json!({
        "success": true,
        "simulated": false,
        "environment": mode.as_str(),
        "berichtsoort": berichtsoort,
        "aanleverkenmerk": aanleverkenmerk,
        "kenmerk": delivered.kenmerk,
        "timestamp": iso(now),
        "deliveredAt": delivered.delivered_at,
        "status": Outcome::Submitted.as_str(),
        "statuses": [],
    })
}

/// What a filing stores when Digipoort refused or couldn't take the message.
pub fn failed_record(
    mode: Mode,
    berichtsoort: &str,
    error: &DigipoortError,
    now: OffsetDateTime,
) -> Value {
    let code = match error {
        DigipoortError::Fault { code, .. } => code.clone(),
        _ => None,
    };
    json!({
        "success": false,
        "simulated": false,
        "environment": mode.as_str(),
        "berichtsoort": berichtsoort,
        "timestamp": iso(now),
        "error": error.to_string(),
        "errorCode": code,
    })
}

/// The stored record with the statuses read at `now`. The receiving party's
/// own answer (`statusdetails`, a Belastingdienst responsemessage) is kept,
/// cut at 20,000 characters.
pub fn with_statuses(
    record: &Value,
    statuses: &[StatusEntry],
    assessment: &Assessment,
    now: OffsetDateTime,
) -> Value {
    let mut record = match record {
        Value::Object(map) => map.clone(),
        _ => serde_json::Map::new(),
    };
    let statuses: Vec<Value> = statuses
        .iter()
        .map(|s| {
            let mut entry = serde_json::to_value(s).unwrap_or(Value::Null);
            if let (Some(details), Value::Object(map)) = (&s.details, &mut entry) {
                map.insert("details".into(), json!(head(details, 20_000)));
            }
            entry
        })
        .collect();
    record.insert("statuses".into(), Value::Array(statuses));
    record.insert("status".into(), json!(assessment.outcome.as_str()));
    record.insert("statusCode".into(), json!(assessment.code));
    record.insert("statusDescription".into(), json!(assessment.description));
    if let Some(reason) = &assessment.reason {
        record.insert("reason".into(), json!(reason));
    }
    record.insert("checkedAt".into(), json!(iso(now)));
    Value::Object(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(code: &str, description: &str) -> StatusEntry {
        StatusEntry {
            kenmerk: "k".to_owned(),
            code: code.to_owned(),
            at: String::new(),
            description: description.to_owned(),
            error_code: None,
            error_description: None,
            details: None,
        }
    }

    #[test]
    fn reads_where_a_delivery_stands() {
        assert_eq!(assess(&[]).outcome, Outcome::Submitted);
        assert_eq!(
            assess(&[status("100", "Aanleveren gelukt")]).outcome,
            Outcome::Submitted
        );
        let delivered = assess(&[
            status("100", "a"),
            status("200", "b"),
            status("400", "Afgeleverd"),
        ]);
        assert_eq!(delivered.outcome, Outcome::Processing);
        assert_eq!(delivered.code.as_deref(), Some("400"));
        let accepted = assess(&[
            status("100", "a"),
            status("400", "b"),
            status("500", "Validatie gelukt"),
        ]);
        assert_eq!(accepted.outcome, Outcome::Accepted);
        let mut refused = status("510", "Validatie bij uitvragende partij niet gelukt");
        refused.error_code = Some("OB1234".to_owned());
        refused.error_description = Some("Rubriek 5g klopt niet".to_owned());
        let rejected = assess(&[status("100", "a"), status("400", "b"), refused]);
        assert_eq!(rejected.outcome, Outcome::Rejected);
        assert_eq!(
            rejected.reason.as_deref(),
            Some("Rubriek 5g klopt niet (OB1234)")
        );
        assert_eq!(
            assess(&[status("000", "U bent niet gerechtigd")]).outcome,
            Outcome::Unknown
        );
        assert!(Outcome::Accepted.is_final() && !Outcome::Processing.is_final());
    }

    #[test]
    fn backs_off_and_stops() {
        let start = time::macros::datetime!(2026-11-22 10:00 UTC);
        let at = |minutes: i64| start + time::Duration::minutes(minutes);
        assert_eq!(next_poll(start, at(10)), Some(at(15)));
        assert_eq!(next_poll(start, at(120)), Some(at(180)));
        assert_eq!(next_poll(start, at(60 * 30)), Some(at(60 * 34)));
        assert_eq!(next_poll(start, at(60 * 24 * 14)), None);
    }

    #[test]
    fn records_deliveries_and_statuses() {
        let now = time::macros::datetime!(2026-11-22 10:00:00.5 UTC);
        let record = delivered_record(
            Mode::Preprod,
            "Omzetbelasting",
            "OB-vat_1",
            &Delivered {
                kenmerk: "k-1".to_owned(),
                delivered_at: None,
            },
            now,
        );
        assert_eq!(record["timestamp"], "2026-11-22T10:00:00.500Z");
        assert_eq!(record["environment"], "preprod");
        let statuses = [status("100", "Aanleveren gelukt")];
        let updated = with_statuses(&record, &statuses, &assess(&statuses), now);
        assert_eq!(updated["kenmerk"], "k-1");
        assert_eq!(updated["status"], "submitted");
        assert_eq!(updated["statuses"][0]["code"], "100");
        let failed = failed_record(
            Mode::Production,
            "ICP",
            &DigipoortError::Fault {
                code: Some("ALS100".to_owned()),
                message: "x".to_owned(),
                http_status: 500,
            },
            now,
        );
        assert_eq!(failed["success"], false);
        assert_eq!(failed["errorCode"], "ALS100");
    }
}
