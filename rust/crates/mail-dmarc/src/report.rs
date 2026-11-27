//! A DMARC aggregate report (RFC 7489 appendix C; `DMARCbis`'s form adds a
//! namespace and a few elements, read the same way by local name).
//!
//! The XML comes from anyone who can mail the report address, so the reader
//! keeps to what it knows: no DTD is read and no entity but XML's five and
//! character references is expanded, text is cut at [`MAX_TEXT`], and a
//! report with more than [`MAX_RECORDS`] rows is refused.

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::Serialize;

/// Rows one report may have.
pub const MAX_RECORDS: usize = 100_000;
/// Characters kept of one element's text.
pub const MAX_TEXT: usize = 1024;
/// Nesting the reader follows.
const MAX_DEPTH: usize = 16;

/// Why a report was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReportError {
    /// The XML doesn't parse.
    Xml(String),
    /// Not an aggregate report (no `<feedback>`), or a required element is
    /// missing.
    NotAReport(&'static str),
    /// More than [`MAX_RECORDS`] rows, or nested deeper than the format.
    TooLarge,
}

impl std::fmt::Display for ReportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Xml(error) => write!(f, "XML: {error}"),
            Self::NotAReport(why) => write!(f, "not an aggregate report: {why}"),
            Self::TooLarge => f.write_str("report too large"),
        }
    }
}

impl std::error::Error for ReportError {}

/// The policy the reporter found at `_dmarc.<domain>`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedPolicy {
    pub domain: String,
    pub adkim: Option<String>,
    pub aspf: Option<String>,
    pub p: Option<String>,
    pub sp: Option<String>,
    pub np: Option<String>,
    pub pct: Option<String>,
    pub testing: Option<String>,
    pub fo: Option<String>,
}

/// A `<reason>` for a disposition other than the policy's.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Reason {
    #[serde(rename = "type")]
    pub kind: String,
    pub comment: Option<String>,
}

/// One DKIM signature the reporter checked.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct DkimResult {
    pub domain: String,
    pub selector: Option<String>,
    pub result: String,
}

/// The SPF check the reporter made.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SpfResult {
    pub domain: String,
    pub scope: Option<String>,
    pub result: String,
}

/// One row: messages from one source IP with one outcome.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Row {
    pub source_ip: String,
    pub count: u32,
    /// `none`, `quarantine` or `reject`.
    pub disposition: String,
    /// The DMARC-aligned DKIM result: `pass` or `fail`.
    pub dkim: Option<String>,
    /// The DMARC-aligned SPF result: `pass` or `fail`.
    pub spf: Option<String>,
    pub reasons: Vec<Reason>,
    pub header_from: String,
    pub envelope_from: Option<String>,
    pub dkim_results: Vec<DkimResult>,
    pub spf_results: Vec<SpfResult>,
}

impl Row {
    pub fn dkim_aligned(&self) -> bool {
        self.dkim.as_deref() == Some("pass")
    }

    pub fn spf_aligned(&self) -> bool {
        self.spf.as_deref() == Some("pass")
    }

    /// DMARC passes when either identifier passed aligned.
    pub fn passed(&self) -> bool {
        self.dkim_aligned() || self.spf_aligned()
    }
}

/// An aggregate report.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub org_name: String,
    /// The reporter's address (`report_metadata/email`).
    pub email: String,
    pub report_id: String,
    /// The period, in seconds since the epoch.
    pub begin: i64,
    pub end: i64,
    pub policy: PublishedPolicy,
    pub records: Vec<Row>,
}

impl Report {
    /// The domain of the reporter's address, lower-cased: who sent it, for
    /// de-duplication and display.
    pub fn reporter_domain(&self) -> String {
        let from_email = self
            .email
            .rsplit_once('@')
            .map(|(_, domain)| domain.trim().trim_end_matches('>').to_ascii_lowercase())
            .filter(|domain| !domain.is_empty());
        from_email.unwrap_or_else(|| self.org_name.trim().to_ascii_lowercase())
    }

    /// Messages in the report.
    pub fn messages(&self) -> u64 {
        self.records.iter().map(|row| u64::from(row.count)).sum()
    }

    /// Messages that passed DMARC.
    pub fn passed(&self) -> u64 {
        self.records
            .iter()
            .filter(|row| row.passed())
            .map(|row| u64::from(row.count))
            .sum()
    }
}

fn clip(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(MAX_TEXT) {
        Some((at, _)) => text[..at].to_owned(),
        None => text.to_owned(),
    }
}

fn lower(text: &str) -> String {
    clip(text).to_ascii_lowercase()
}

fn optional(text: &str) -> Option<String> {
    let text = clip(text);
    (!text.is_empty()).then_some(text)
}

/// The predefined entities; any other named entity reads as nothing.
fn entity(name: &str) -> Option<char> {
    match name {
        "lt" => Some('<'),
        "gt" => Some('>'),
        "amp" => Some('&'),
        "apos" => Some('\''),
        "quot" => Some('"'),
        _ => None,
    }
}

/// Puts the text of the element ending at `path` where it belongs.
fn assign(report: &mut Report, path: &[String], text: &str) {
    let names: Vec<&str> = path.iter().map(String::as_str).collect();
    if let Some(at) = names.iter().position(|name| *name == "record") {
        if let Some(row) = report.records.last_mut() {
            assign_row(row, &names[at + 1..], text);
        }
        return;
    }
    match names.as_slice() {
        [.., "report_metadata", "org_name"] => report.org_name = clip(text),
        [.., "report_metadata", "email"] => report.email = clip(text),
        [.., "report_metadata", "report_id"] => report.report_id = clip(text),
        [.., "report_metadata", "date_range", "begin"] => {
            report.begin = text.trim().parse().unwrap_or_default();
        }
        [.., "report_metadata", "date_range", "end"] => {
            report.end = text.trim().parse().unwrap_or_default();
        }
        [.., "policy_published", field] => {
            let policy = &mut report.policy;
            match *field {
                "domain" => policy.domain = lower(text),
                "adkim" => policy.adkim = optional(text),
                "aspf" => policy.aspf = optional(text),
                "p" => policy.p = optional(text),
                "sp" => policy.sp = optional(text),
                "np" => policy.np = optional(text),
                "pct" => policy.pct = optional(text),
                "testing" => policy.testing = optional(text),
                "fo" => policy.fo = optional(text),
                _ => {}
            }
        }
        _ => {}
    }
}

/// The text of an element under `<record>`; `rest` is its path below it.
fn assign_row(row: &mut Row, rest: &[&str], text: &str) {
    match rest {
        ["row", "source_ip"] => row.source_ip = clip(text),
        ["row", "count"] => row.count = text.trim().parse().unwrap_or_default(),
        ["row", "policy_evaluated", "disposition"] => row.disposition = lower(text),
        ["row", "policy_evaluated", "dkim"] => row.dkim = Some(lower(text)),
        ["row", "policy_evaluated", "spf"] => row.spf = Some(lower(text)),
        ["row", "policy_evaluated", "reason", "type"] => {
            if let Some(reason) = row.reasons.last_mut() {
                reason.kind = lower(text);
            }
        }
        ["row", "policy_evaluated", "reason", "comment"] => {
            if let Some(reason) = row.reasons.last_mut() {
                reason.comment = optional(text);
            }
        }
        ["identifiers", "header_from"] => row.header_from = lower(text),
        ["identifiers", "envelope_from"] => row.envelope_from = optional(text),
        ["auth_results", "dkim", field] => {
            if let Some(result) = row.dkim_results.last_mut() {
                match *field {
                    "domain" => result.domain = lower(text),
                    "selector" => result.selector = optional(text),
                    "result" => result.result = lower(text),
                    _ => {}
                }
            }
        }
        ["auth_results", "spf", field] => {
            if let Some(result) = row.spf_results.last_mut() {
                match *field {
                    "domain" => result.domain = lower(text),
                    "scope" => result.scope = optional(text),
                    "result" => result.result = lower(text),
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// Opens what an element at `path` starts: a row, a reason, a DKIM or SPF
/// result.
fn open(report: &mut Report, path: &[String]) -> Result<(), ReportError> {
    let names: Vec<&str> = path.iter().map(String::as_str).collect();
    match names.as_slice() {
        [.., "feedback", "record"] => {
            if report.records.len() >= MAX_RECORDS {
                return Err(ReportError::TooLarge);
            }
            report.records.push(Row::default());
        }
        [.., "record", "row", "policy_evaluated", "reason"] => {
            if let Some(row) = report.records.last_mut() {
                row.reasons.push(Reason::default());
            }
        }
        [.., "record", "auth_results", "dkim"] => {
            if let Some(row) = report.records.last_mut() {
                row.dkim_results.push(DkimResult::default());
            }
        }
        [.., "record", "auth_results", "spf"] => {
            if let Some(row) = report.records.last_mut() {
                row.spf_results.push(SpfResult::default());
            }
        }
        _ => {}
    }
    Ok(())
}

/// Parses an aggregate report.
///
/// # Errors
///
/// [`ReportError`] when the XML is broken, isn't a `<feedback>` report or
/// lacks its id, period or policy domain, or is too large.
pub fn parse(xml: &str) -> Result<Report, ReportError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut report = Report::default();
    let mut path: Vec<String> = Vec::new();
    let mut text = String::new();
    let mut saw_feedback = false;
    loop {
        match reader
            .read_event()
            .map_err(|error| ReportError::Xml(error.to_string()))?
        {
            Event::Start(start) => {
                if path.len() >= MAX_DEPTH {
                    return Err(ReportError::TooLarge);
                }
                let name = String::from_utf8_lossy(start.local_name().as_ref().as_bytes())
                    .to_ascii_lowercase();
                if path.is_empty() {
                    if name != "feedback" {
                        return Err(ReportError::NotAReport("the root is not <feedback>"));
                    }
                    saw_feedback = true;
                }
                path.push(name);
                open(&mut report, &path)?;
                text.clear();
            }
            Event::Empty(_) => text.clear(),
            Event::End(_) => {
                assign(&mut report, &path, &text);
                path.pop();
                text.clear();
            }
            Event::Text(chunk) => {
                if text.len() < MAX_TEXT * 4 {
                    text.push_str(&chunk.xml_content(quick_xml::XmlVersion::Implicit1_0));
                }
            }
            Event::CData(chunk) => {
                if text.len() < MAX_TEXT * 4 {
                    text.push_str(&chunk.into_inner());
                }
            }
            Event::GeneralRef(reference) => {
                let resolved = match reference.resolve_char_ref() {
                    Ok(Some(ch)) => Some(ch),
                    Ok(None) => entity(&reference),
                    Err(_) => None,
                };
                if let Some(ch) = resolved
                    && text.len() < MAX_TEXT * 4
                {
                    text.push(ch);
                }
            }
            Event::Eof => break,
            // Declarations, comments, processing instructions and any DTD
            // are skipped, never followed.
            Event::Decl(_) | Event::Comment(_) | Event::PI(_) | Event::DocType(_) => {}
        }
    }
    if !saw_feedback {
        return Err(ReportError::NotAReport("no <feedback>"));
    }
    if report.report_id.is_empty() {
        return Err(ReportError::NotAReport("no report_id"));
    }
    if report.policy.domain.is_empty() {
        return Err(ReportError::NotAReport("no policy_published/domain"));
    }
    if report.begin <= 0 || report.end < report.begin {
        return Err(ReportError::NotAReport("no date_range"));
    }
    // A row without a source or a From domain says nothing.
    report
        .records
        .retain(|row| !row.source_ip.is_empty() && row.count > 0);
    for row in &mut report.records {
        if row.header_from.is_empty() {
            row.header_from.clone_from(&report.policy.domain);
        }
    }
    Ok(report)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A report as Google sends one (RFC 7489's schema, no namespace).
    pub(crate) const GOOGLE: &str = r#"<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <extra_contact_info>https://support.google.com/a/answer/2466580</extra_contact_info>
    <report_id>13059146574326891234</report_id>
    <date_range><begin>1764028800</begin><end>1764115199</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>acme.test</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><sp>none</sp><pct>100</pct><np>none</np>
  </policy_published>
  <record>
    <row>
      <source_ip>198.51.100.7</source_ip>
      <count>12</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>acme.test</header_from></identifiers>
    <auth_results>
      <dkim><domain>acme.test</domain><result>pass</result><selector>ws202611</selector></dkim>
      <spf><domain>bounces.weldsuite.test</domain><result>pass</result></spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>203.0.113.9</source_ip>
      <count>3</count>
      <policy_evaluated>
        <disposition>none</disposition><dkim>fail</dkim><spf>fail</spf>
        <reason><type>forwarded</type><comment>looks &amp; smells forwarded</comment></reason>
      </policy_evaluated>
    </row>
    <identifiers><header_from>News.Acme.test</header_from><envelope_from>spoof.test</envelope_from></identifiers>
    <auth_results><spf><domain>spoof.test</domain><scope>mfrom</scope><result>softfail</result></spf></auth_results>
  </record>
</feedback>"#;

    #[test]
    fn reads_a_google_report() {
        let report = parse(GOOGLE).expect("report");
        assert_eq!(report.org_name, "google.com");
        assert_eq!(report.reporter_domain(), "google.com");
        assert_eq!(report.report_id, "13059146574326891234");
        assert_eq!((report.begin, report.end), (1_764_028_800, 1_764_115_199));
        assert_eq!(report.policy.domain, "acme.test");
        assert_eq!(report.policy.p.as_deref(), Some("none"));
        assert_eq!(report.records.len(), 2);
        let first = &report.records[0];
        assert!(first.dkim_aligned() && !first.spf_aligned() && first.passed());
        assert_eq!(first.dkim_results[0].selector.as_deref(), Some("ws202611"));
        assert_eq!(first.spf_results[0].domain, "bounces.weldsuite.test");
        let second = &report.records[1];
        assert!(!second.passed());
        assert_eq!(second.header_from, "news.acme.test");
        assert_eq!(second.reasons[0].kind, "forwarded");
        assert_eq!(
            second.reasons[0].comment.as_deref(),
            Some("looks & smells forwarded")
        );
        assert_eq!(second.spf_results[0].scope.as_deref(), Some("mfrom"));
        assert_eq!(report.messages(), 15);
        assert_eq!(report.passed(), 12);
    }

    #[test]
    fn reads_the_dmarcbis_namespace() {
        let xml = r#"<?xml version="1.0"?>
<feedback xmlns="urn:ietf:params:xml:ns:dmarc-2.0">
  <version>1.0</version>
  <report_metadata><org_name>Outlook.com</org_name><email>dmarcreport@microsoft.com</email>
    <report_id>abc-1</report_id><date_range><begin>100</begin><end>200</end></date_range></report_metadata>
  <policy_published><domain>acme.test</domain><p>quarantine</p><testing>n</testing><discovery_method>treewalk</discovery_method></policy_published>
  <record><row><source_ip>2001:db8::1</source_ip><count>1</count>
    <policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row>
    <identifiers><header_from>acme.test</header_from></identifiers><auth_results/></record>
</feedback>"#;
        let report = parse(xml).expect("report");
        assert_eq!(report.reporter_domain(), "microsoft.com");
        assert_eq!(report.policy.testing.as_deref(), Some("n"));
        assert_eq!(report.records[0].disposition, "quarantine");
        assert_eq!(report.records[0].source_ip, "2001:db8::1");
    }

    #[test]
    fn refuses_what_is_not_an_aggregate_report() {
        assert!(matches!(parse("<html/>"), Err(ReportError::NotAReport(_))));
        assert!(matches!(
            parse("<feedback><report_metadata/></feedback>"),
            Err(ReportError::NotAReport(_))
        ));
        assert!(matches!(
            parse("<feedback><unclosed></feedback>"),
            Err(ReportError::Xml(_))
        ));
    }

    #[test]
    fn never_expands_a_dtd_entity() {
        let xml = r#"<?xml version="1.0"?>
<!DOCTYPE feedback [<!ENTITY lol "lollollollollol"><!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<feedback><report_metadata><org_name>&lol;&xxe;x</org_name><email>a@b.test</email><report_id>1</report_id>
<date_range><begin>1</begin><end>2</end></date_range></report_metadata>
<policy_published><domain>acme.test</domain></policy_published></feedback>"#;
        let report = parse(xml).expect("report");
        assert_eq!(report.org_name, "x");
    }

    #[test]
    fn deep_nesting_is_refused() {
        let xml = format!(
            "<feedback>{}{}</feedback>",
            "<a>".repeat(MAX_DEPTH + 1),
            "</a>".repeat(MAX_DEPTH + 1)
        );
        assert_eq!(parse(&xml), Err(ReportError::TooLarge));
    }
}
