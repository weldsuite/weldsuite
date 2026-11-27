//! The DMARC record at `_dmarc.<domain>` (RFC 7489 §6.3, `DMARCbis`).
//!
//! A receiver discards TXT records there that don't start with `v=DMARC1`,
//! and applies no DMARC at all when more than one is left (§6.6.3). A record
//! without a valid `p` but with a valid `rua` counts as `p=none`; without
//! either it is ignored. [`inspect`] says which of those a domain is in, and
//! what to publish instead: the customer's own record with the install's
//! report address added among its first two `rua` URIs (a receiver need only
//! send to two, §6.2), its policy untouched.

use serde::Serialize;

/// The record WeldMail suggests for a domain without one, before the
/// install's report address is added.
pub const BASE_RECORD: &str = "v=DMARC1; p=none";

/// Where a domain's DMARC record stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordState {
    /// No TXT record at `_dmarc.<domain>` starts with `v=DMARC1`.
    Missing,
    /// Several do: receivers ignore all of them.
    Multiple,
    /// One does, but receivers can't use it (no valid `p` and no valid
    /// `rua`).
    Invalid,
    /// Exactly one usable record.
    Ok,
}

impl RecordState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "missing",
            Self::Multiple => "multiple",
            Self::Invalid => "invalid",
            Self::Ok => "ok",
        }
    }
}

/// The policy a usable record publishes.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    /// `none`, `quarantine` or `reject` (`none` for a record with only a
    /// `rua`).
    pub p: String,
    pub sp: Option<String>,
    /// `DMARCbis`: the policy for non-existent subdomains.
    pub np: Option<String>,
    /// RFC 7489's sampling percentage (`DMARCbis` dropped it).
    pub pct: Option<u8>,
    /// `DMARCbis` `t=y`: the policy is being tested.
    pub testing: bool,
    /// `r` (relaxed, the default) or `s`.
    pub adkim: String,
    pub aspf: String,
    pub rua: Vec<String>,
    pub ruf: Vec<String>,
}

/// A DMARC record's tags, in the order written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    tags: Vec<(String, String)>,
}

/// Whether `text` is a DMARC record: its first tag is `v=DMARC1`, which must
/// match exactly (§6.4), with optional spaces around `=`.
pub fn is_dmarc(text: &str) -> bool {
    let Some(rest) = text.trim_start().strip_prefix('v') else {
        return false;
    };
    let Some(rest) = rest.trim_start().strip_prefix('=') else {
        return false;
    };
    let Some(rest) = rest.trim_start().strip_prefix("DMARC1") else {
        return false;
    };
    rest.trim_start().is_empty() || rest.trim_start().starts_with(';')
}

fn valid_policy(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    matches!(value.as_str(), "none" | "quarantine" | "reject").then_some(value)
}

/// The address of a `mailto:` report URI, lower-cased, without the size
/// limit (`!10m`); `None` for another scheme.
pub fn mailto_address(uri: &str) -> Option<String> {
    let uri = uri.trim();
    let scheme = uri.get(..7)?;
    if !scheme.eq_ignore_ascii_case("mailto:") {
        return None;
    }
    let address = uri[7..].split('!').next().unwrap_or_default().trim();
    address.contains('@').then(|| address.to_ascii_lowercase())
}

fn uri_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|uri| !uri.is_empty())
        .map(str::to_owned)
        .collect()
}

impl Record {
    /// The tags of `text`, or `None` when it isn't a DMARC record.
    pub fn parse(text: &str) -> Option<Self> {
        if !is_dmarc(text) {
            return None;
        }
        let tags = text
            .split(';')
            .filter_map(|part| {
                let (tag, value) = part.split_once('=')?;
                let tag = tag.trim().to_ascii_lowercase();
                (!tag.is_empty()).then(|| (tag, value.trim().to_owned()))
            })
            .collect();
        Some(Self { tags })
    }

    pub fn get(&self, tag: &str) -> Option<&str> {
        self.tags
            .iter()
            .find(|(name, _)| name == tag)
            .map(|(_, value)| value.as_str())
    }

    /// The policy receivers apply, or `None` when they would ignore the
    /// record: no valid `p` and no `mailto:` address in `rua`.
    pub fn policy(&self) -> Option<Policy> {
        let rua = self.get("rua").map(uri_list).unwrap_or_default();
        let p = match self.get("p").and_then(valid_policy) {
            Some(p) => p,
            None if rua.iter().any(|uri| mailto_address(uri).is_some()) => "none".to_owned(),
            None => return None,
        };
        let alignment = |tag: &str| match self.get(tag).map(str::to_ascii_lowercase) {
            Some(mode) if mode == "s" => "s".to_owned(),
            _ => "r".to_owned(),
        };
        Some(Policy {
            p,
            sp: self.get("sp").and_then(valid_policy),
            np: self.get("np").and_then(valid_policy),
            pct: self
                .get("pct")
                .and_then(|pct| pct.parse::<u8>().ok())
                .filter(|pct| *pct <= 100),
            testing: self.get("t").is_some_and(|t| t.eq_ignore_ascii_case("y")),
            adkim: alignment("adkim"),
            aspf: alignment("aspf"),
            rua,
            ruf: self.get("ruf").map(uri_list).unwrap_or_default(),
        })
    }

    /// Whether `address` is among the first two `rua` URIs, the ones every
    /// receiver sends to.
    pub fn reports_to(&self, address: &str) -> bool {
        let address = address.to_ascii_lowercase();
        self.get("rua")
            .map(uri_list)
            .unwrap_or_default()
            .iter()
            .take(2)
            .any(|uri| mailto_address(uri).as_deref() == Some(address.as_str()))
    }

    /// The record as text, `v=DMARC1` first and `; ` between tags.
    pub fn render(&self) -> String {
        self.tags
            .iter()
            .map(|(tag, value)| format!("{tag}={value}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// This record with `mailto:<address>` among the first two `rua` URIs:
    /// added second when there is a first, moved there when it is further
    /// down, left alone when it is already one of the two. Without a `rua`
    /// tag one is added after `p` (or at the end).
    #[must_use]
    pub fn with_report_address(&self, address: &str) -> Self {
        let ours = format!("mailto:{address}");
        let mut tags = self.tags.clone();
        if let Some((_, value)) = tags.iter_mut().find(|(tag, _)| tag == "rua") {
            let mut uris = uri_list(value);
            let lower = address.to_ascii_lowercase();
            let at = uris
                .iter()
                .position(|uri| mailto_address(uri).as_deref() == Some(lower.as_str()));
            match at {
                Some(index) if index < 2 => {}
                Some(index) => {
                    let uri = uris.remove(index);
                    uris.insert(1, uri);
                }
                None => uris.insert(uris.len().min(1), ours),
            }
            *value = uris.join(",");
        } else {
            let after = tags
                .iter()
                .position(|(tag, _)| tag == "p")
                .map_or(tags.len(), |index| index + 1);
            tags.insert(after, ("rua".to_owned(), ours));
        }
        Self { tags }
    }

    /// This record with policy `p` and without `pct`, the next step of
    /// [`crate::readiness`].
    #[must_use]
    pub fn with_policy(&self, p: &str) -> Self {
        let mut tags: Vec<(String, String)> = self
            .tags
            .iter()
            .filter(|(tag, _)| tag != "pct")
            .cloned()
            .collect();
        match tags.iter_mut().find(|(tag, _)| tag == "p") {
            Some((_, value)) => p.clone_into(value),
            None => tags.insert(1.min(tags.len()), ("p".to_owned(), p.to_owned())),
        }
        Self { tags }
    }
}

/// The record WeldMail suggests for a domain without one: [`BASE_RECORD`]
/// with the install's report address, when it has one.
pub fn suggested_new(report_address: Option<&str>) -> String {
    match report_address {
        Some(address) => format!("{BASE_RECORD}; rua=mailto:{address}"),
        None => BASE_RECORD.to_owned(),
    }
}

/// A domain's DMARC record as found, and what to publish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub state: RecordState,
    /// The DMARC records found (TXT records that aren't DMARC are left out).
    pub found: Vec<String>,
    /// The policy of the one usable record.
    pub policy: Option<Policy>,
    /// The install's report address is among the first two `rua` URIs.
    pub reports_to_weldsuite: bool,
    /// The one record to publish at `_dmarc.<domain>`.
    pub suggested: String,
}

/// The strictest policy first: the record kept when several must become one.
fn strictness(policy: Option<&Policy>) -> u8 {
    match policy.map(|p| p.p.as_str()) {
        Some("reject") => 3,
        Some("quarantine") => 2,
        Some(_) => 1,
        None => 0,
    }
}

/// `answers` are the TXT records at `_dmarc.<domain>`. `default` is the
/// record suggested for a domain without one (the install's
/// `MAIL_DMARC_RECORD`, or [`suggested_new`]).
pub fn inspect(answers: &[String], report_address: Option<&str>, default: &str) -> Inspection {
    let found: Vec<String> = answers
        .iter()
        .map(|answer| answer.trim().to_owned())
        .filter(|answer| is_dmarc(answer))
        .collect();
    let records: Vec<Record> = found
        .iter()
        .filter_map(|text| Record::parse(text))
        .collect();
    let suggest = |record: &Record| match report_address {
        Some(address) => record.with_report_address(address).render(),
        None => record.render(),
    };
    match records.as_slice() {
        [] => Inspection {
            state: RecordState::Missing,
            found,
            policy: None,
            reports_to_weldsuite: false,
            suggested: default.to_owned(),
        },
        [record] => match record.policy() {
            Some(policy) => Inspection {
                state: RecordState::Ok,
                reports_to_weldsuite: report_address
                    .is_some_and(|address| record.reports_to(address)),
                suggested: suggest(record),
                found,
                policy: Some(policy),
            },
            None => Inspection {
                state: RecordState::Invalid,
                found,
                policy: None,
                reports_to_weldsuite: false,
                suggested: default.to_owned(),
            },
        },
        several => {
            // Keep the strictest so merging never weakens the policy.
            let keep = several
                .iter()
                .max_by_key(|record| strictness(record.policy().as_ref()))
                .map_or_else(|| default.to_owned(), suggest);
            Inspection {
                state: RecordState::Multiple,
                found,
                policy: None,
                reports_to_weldsuite: false,
                suggested: keep,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OURS: &str = "dmarc@reports.weldsuite.test";

    fn texts(records: &[&str]) -> Vec<String> {
        records.iter().map(|r| (*r).to_owned()).collect()
    }

    #[test]
    fn only_v_dmarc1_first_is_a_dmarc_record() {
        assert!(is_dmarc("v=DMARC1; p=none"));
        assert!(is_dmarc("v = DMARC1;p=reject"));
        assert!(is_dmarc("v=DMARC1"));
        assert!(!is_dmarc("v=dmarc1; p=none"));
        assert!(!is_dmarc("p=none; v=DMARC1"));
        assert!(!is_dmarc("v=spf1 -all"));
        assert!(!is_dmarc("v=DMARC10; p=none"));
    }

    #[test]
    fn a_domain_without_a_record_gets_the_default() {
        let default = suggested_new(Some(OURS));
        let found = inspect(
            &texts(&["google-site-verification=x"]),
            Some(OURS),
            &default,
        );
        assert_eq!(found.state, RecordState::Missing);
        assert_eq!(
            found.suggested,
            "v=DMARC1; p=none; rua=mailto:dmarc@reports.weldsuite.test"
        );
        assert_eq!(found.found, Vec::<String>::new());
    }

    #[test]
    fn two_records_are_void_and_the_strictest_is_kept() {
        let found = inspect(
            &texts(&[
                "v=DMARC1; p=none",
                "v=DMARC1; p=reject; rua=mailto:x@vendor.test",
            ]),
            Some(OURS),
            BASE_RECORD,
        );
        assert_eq!(found.state, RecordState::Multiple);
        assert_eq!(found.policy, None);
        assert_eq!(
            found.suggested,
            "v=DMARC1; p=reject; rua=mailto:x@vendor.test,mailto:dmarc@reports.weldsuite.test"
        );
    }

    #[test]
    fn one_record_keeps_its_policy_and_gains_the_address() {
        let found = inspect(
            &texts(&["v=DMARC1; p=quarantine; pct=50; rua=mailto:a@x.test,mailto:b@x.test"]),
            Some(OURS),
            BASE_RECORD,
        );
        assert_eq!(found.state, RecordState::Ok);
        let policy = found.policy.expect("policy");
        assert_eq!(policy.p, "quarantine");
        assert_eq!(policy.pct, Some(50));
        assert!(!found.reports_to_weldsuite);
        assert_eq!(
            found.suggested,
            "v=DMARC1; p=quarantine; pct=50; rua=mailto:a@x.test,mailto:dmarc@reports.weldsuite.test,mailto:b@x.test"
        );
    }

    #[test]
    fn an_address_third_in_line_moves_up() {
        let record = Record::parse(&format!(
            "v=DMARC1; p=none; rua=mailto:a@x.test,mailto:b@x.test,mailto:{OURS}!10m"
        ))
        .expect("record");
        assert!(!record.reports_to(OURS));
        let moved = record.with_report_address(OURS);
        assert!(moved.reports_to(OURS));
        assert_eq!(
            moved.get("rua"),
            Some("mailto:a@x.test,mailto:dmarc@reports.weldsuite.test!10m,mailto:b@x.test")
        );
    }

    #[test]
    fn a_record_without_rua_gets_one_after_p() {
        let record = Record::parse("v=DMARC1; p=none; adkim=s").expect("record");
        assert_eq!(
            record.with_report_address(OURS).render(),
            "v=DMARC1; p=none; rua=mailto:dmarc@reports.weldsuite.test; adkim=s"
        );
    }

    #[test]
    fn a_record_already_reporting_here_is_unchanged() {
        let text = format!("v=DMARC1; p=reject; rua=mailto:{}", OURS.to_uppercase());
        let found = inspect(&texts(&[&text]), Some(OURS), BASE_RECORD);
        assert!(found.reports_to_weldsuite);
        assert_eq!(found.suggested, text);
    }

    #[test]
    fn without_p_a_rua_makes_it_none_and_nothing_makes_it_invalid() {
        let rua_only = inspect(
            &texts(&["v=DMARC1; rua=mailto:a@x.test"]),
            None,
            BASE_RECORD,
        );
        assert_eq!(rua_only.state, RecordState::Ok);
        assert_eq!(rua_only.policy.map(|p| p.p), Some("none".to_owned()));
        let broken = inspect(&texts(&["v=DMARC1; p=sometimes"]), None, BASE_RECORD);
        assert_eq!(broken.state, RecordState::Invalid);
        assert_eq!(broken.suggested, BASE_RECORD);
    }

    #[test]
    fn the_next_step_drops_pct() {
        let record =
            Record::parse("v=DMARC1; p=none; pct=20; rua=mailto:a@x.test").expect("record");
        assert_eq!(
            record.with_policy("quarantine").render(),
            "v=DMARC1; p=quarantine; rua=mailto:a@x.test"
        );
        let rua_only = Record::parse("v=DMARC1; rua=mailto:a@x.test").expect("record");
        assert_eq!(
            rua_only.with_policy("quarantine").render(),
            "v=DMARC1; p=quarantine; rua=mailto:a@x.test"
        );
    }

    #[test]
    fn dmarcbis_tags_are_read() {
        let record = Record::parse("v=DMARC1; p=reject; np=reject; t=y; aspf=s").expect("record");
        let policy = record.policy().expect("policy");
        assert_eq!(policy.np.as_deref(), Some("reject"));
        assert!(policy.testing);
        assert_eq!(policy.aspf, "s");
        assert_eq!(policy.adkim, "r");
    }
}
