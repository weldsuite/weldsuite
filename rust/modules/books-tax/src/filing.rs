//! What the period filings share (books-api's `accounting-return-periods`,
//! `accounting-tax-ledger` and `accounting-digipoort`): which period a
//! calculation covers, which returns are still open, the period's tax-ledger
//! lines, stamping a filed period, and the Digipoort submission.
//!
//! Digipoort: the worker sends through its `DIGIPOORT_CERT` mTLS binding
//! (the PKIoverheid certificate); without the binding it builds the SOAP
//! envelope and answers a simulated submission, whatever `DIGIPOORT_MODE`
//! says. The Rust backend has no such binding, so it always answers what the
//! worker answers without it (`UNAVAILABLE_FEATURES`: `vat-digipoort`).

use base64::Engine;
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::http::{now, now_ms};
use weldsuite_books_domain::js;

use crate::nl::{ReturnLine, escape_xml};

/// `FILED_RETURN_STATUSES`.
const FILED_STATUSES: [&str; 3] = ["filed", "submitted", "accepted"];

/// `isUnfiledReturn(status)`.
pub(crate) fn is_unfiled(status: &str) -> bool {
    !FILED_STATUSES.contains(&status)
}

/// `parseReturnPeriod(start, end)`: the two instants as `toISOString()`, or
/// the message of the 400.
pub(crate) fn parse_period(start: &str, end: &str) -> Result<(String, String), &'static str> {
    let (Some(from), Some(to)) = (js::js_date_millis(start), js::js_date_millis(end)) else {
        return Err("The period start and end must be valid dates");
    };
    if to < from {
        return Err("The period end must not be before the period start");
    }
    match (js::iso_from_millis(from), js::iso_from_millis(to)) {
        (Some(from), Some(to)) => Ok((from, to)),
        _ => Err("The period start and end must be valid dates"),
    }
}

/// `isoDate(date)`: the day of a row's timestamp.
pub(crate) fn iso_day(timestamp: &str) -> String {
    timestamp.chars().take(10).collect()
}

/// A tax-ledger row of the period (`PeriodTaxLine`).
#[derive(Debug, Clone)]
pub(crate) struct PeriodLine {
    pub line: ReturnLine,
    pub contact_id: Option<String>,
}

/// `loadTaxLinesForPeriod(db, entityId, start, end)`: by tax date, inclusive.
pub(crate) async fn load_period_lines(
    db: &PgPool,
    entity_id: &str,
    start_day: &str,
    end_day: &str,
) -> Result<Vec<PeriodLine>, sqlx::Error> {
    type Row = (
        Option<String>,
        String,
        bool,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Value>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "select \"tax_lines\".\"tax_category_code\", \"tax_lines\".\"direction\", \
         \"tax_lines\".\"self_assessed\", \"tax_lines\".\"base_taxable_amount\"::text, \
         \"tax_lines\".\"base_tax_amount\"::text, \"tax_lines\".\"contact_id\", \
         \"tax_rates\".\"jurisdiction_metadata\" \
         from \"tax_lines\" left join \"tax_rates\" on \"tax_lines\".\"tax_rate_id\" = \"tax_rates\".\"id\" \
         where (\"tax_lines\".\"entity_id\" = $1 and \"tax_lines\".\"tax_date\" >= $2::date \
         and \"tax_lines\".\"tax_date\" <= $3::date)",
    )
    .bind(entity_id)
    .bind(start_day)
    .bind(end_day)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(category, direction, self_assessed, base, tax, contact_id, metadata)| PeriodLine {
                line: ReturnLine {
                    tax_category_code: category.unwrap_or_default(),
                    direction: if direction == "purchase" || direction == "use" {
                        "purchase".into()
                    } else {
                        "sales".into()
                    },
                    self_assessed,
                    taxable_amount: js::numeric_text(base.as_deref()),
                    tax_amount: js::numeric_text(tax.as_deref()),
                    jurisdiction_metadata: metadata.filter(|m| !m.is_null()),
                },
                contact_id,
            },
        )
        .collect())
}

/// `fileTaxPeriodStatements(h, …)`: stamp the period's unfiled ledger rows
/// with the return and move the entity's tax lock date up to the period end.
pub(crate) async fn file_period(
    tx: &mut sqlx::PgConnection,
    entity_id: &str,
    start_day: &str,
    end_day: &str,
    tax_return_id: &str,
    current_lock_date: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update tax_lines set tax_return_id = $1 where entity_id = $2 and tax_date >= $3::date \
         and tax_date <= $4::date and tax_return_id is null",
    )
    .bind(tax_return_id)
    .bind(entity_id)
    .bind(start_day)
    .bind(end_day)
    .execute(&mut *tx)
    .await?;
    if current_lock_date.is_none_or(|lock| lock.is_empty() || lock < end_day) {
        sqlx::query(
            "update entities set tax_lock_date = $1::date, updated_at = $2::timestamp where id = $3",
        )
        .bind(end_day)
        .bind(now())
        .bind(entity_id)
        .execute(&mut *tx)
        .await?;
    }
    Ok(())
}

// ── Digipoort ───────────────────────────────────────────────────────────────

/// `generateKenmerk()`: `WS-{Date.now() in base 36}-{6 random characters}`.
fn kenmerk() -> String {
    let millis = u64::try_from(now_ms()).unwrap_or(0);
    format!(
        "WS-{}-{}",
        base36(millis),
        weldsuite_kit::random_string(6, weldsuite_kit::id::BASE36_LOWER)
    )
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[usize::try_from(n % 36).unwrap_or(0)]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// `buildAanleverSoapEnvelope(btwNumber, xml, kenmerk, berichtsoort)`.
fn aanlever_envelope(btw_number: &str, xml: &str, kenmerk: &str, berichtsoort: &str) -> String {
    let content = base64::engine::general_purpose::STANDARD.encode(xml.as_bytes());
    let btw = escape_xml(btw_number);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<soapenv:Envelope
  xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\"
  xmlns:aanl=\"http://logius.nl/digipoort/wus/2.0/aanleverservice/1.2\"
  xmlns:iden=\"http://logius.nl/digipoort/koppelvlakstandaard/1.2/MSIdentificatie\">
  <soapenv:Header/>
  <soapenv:Body>
    <aanl:aanleverRequest>
      <aanl:berichtsoort>{}</aanl:berichtsoort>
      <aanl:aanleverkenmerk>{}</aanl:aanleverkenmerk>
      <aanl:rolBelanghebbende>Belanghebbende</aanl:rolBelanghebbende>
      <aanl:identiteitBelanghebbende>
        <iden:nummer>{btw}</iden:nummer>
        <iden:type>BTW</iden:type>
      </aanl:identiteitBelanghebbende>
      <aanl:identiteitIntermediair>
        <iden:nummer>{btw}</iden:nummer>
        <iden:type>BTW</iden:type>
      </aanl:identiteitIntermediair>
      <aanl:autorisatieAdres>http://geenausp.nl</aanl:autorisatieAdres>
      <aanl:berichtInhoud>
        <aanl:mimeType>application/xml</aanl:mimeType>
        <aanl:bestandsnaam>btw-aangifte.xbrl</aanl:bestandsnaam>
        <aanl:inhoud>{content}</aanl:inhoud>
      </aanl:berichtInhoud>
    </aanl:aanleverRequest>
  </soapenv:Body>
</soapenv:Envelope>",
        escape_xml(berichtsoort),
        escape_xml(kenmerk),
    )
}

/// What a submission answered (`DigipoortSubmitResult`).
pub(crate) struct Submission {
    pub kenmerk: String,
    /// The result as the return stores it (`digipoortResponse`).
    pub stored: Value,
}

/// `submitFiling(createConfig(env, btwNumber), xml, berichtsoort)` without
/// the certificate binding: the envelope is built, nothing is sent.
pub(crate) fn submit_filing(btw_number: &str, xml: &str, berichtsoort: &str) -> Submission {
    let kenmerk = kenmerk();
    let envelope = aanlever_envelope(btw_number, xml, &kenmerk, berichtsoort);
    let raw = format!(
        "<!-- Simulated response. SOAP envelope was built but not sent. -->\n{}...",
        js::slice_utf16(&envelope, 500)
    );
    let stored = json!({
        "success": true,
        "simulated": true,
        "kenmerk": kenmerk,
        "timestamp": now(),
        "rawResponse": raw,
    });
    Submission { kenmerk, stored }
}

/// `checkFilingStatus(config, kenmerk)` without the binding.
pub(crate) fn filing_status() -> Value {
    json!({
        "success": true,
        "simulated": true,
        "status": "submitted",
        "statusDescription": "Simulated: filing has been submitted and is awaiting processing.",
        "timestamp": now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn periods() {
        assert_eq!(
            parse_period("2026-01-01", "2026-03-31"),
            Ok((
                "2026-01-01T00:00:00.000Z".to_owned(),
                "2026-03-31T00:00:00.000Z".to_owned()
            ))
        );
        assert!(parse_period("2026-06-30", "2026-06-01").is_err());
        assert!(parse_period("nope", "2026-06-01").is_err());
        assert!(is_unfiled("calculated"));
        assert!(!is_unfiled("accepted"));
        assert_eq!(base36(35), "z");
        assert!(kenmerk().starts_with("WS-"));
    }
}
