//! Backup withholding (24%) on payments to vendors without a valid TIN
//! (`us-compliance/backup-withholding` and books-api's
//! `services/backup-withholding.ts`).
//!
//! It applies to reportable payments to a 1099 vendor with no TIN on file, or
//! flagged after an IRS "B" notice (`parties.backup_withholding`); not to
//! exempt payees (an exempt payee code on the W-9, or a corporation other
//! than an attorney), not to card or third-party-network payments, nor to
//! payments run through payroll. Withholding starts with the payment that
//! brings the year's total to the reporting threshold of the vendor's default
//! box and covers that whole payment. The Form 945 summary is the reports
//! area's.

use serde_json::Value;
use sqlx::PgPool;

use crate::js::{math_round, numeric};
use crate::tables::PARTIES;
use crate::vendor_tax::{FORM_1099_OMIT, is_allocatable_box, is_corporation_classification};

/// `BACKUP_WITHHOLDING_RATE`.
pub const BACKUP_WITHHOLDING_RATE: f64 = 0.24;

/// `FORM_1099K_PAYMENT_METHODS`: paid by card or a third-party network, the
/// processor reports it on a 1099-K.
pub const FORM_1099K_PAYMENT_METHODS: [&str; 3] =
    ["credit_card", "debit_card", "third_party_network"];

/// `BackupWithholdingVendor`.
#[derive(Debug, Clone, Copy, Default)]
pub struct BackupWithholdingVendor {
    pub backup_withholding: bool,
    /// `hasTin === false`: no TIN on file.
    pub no_tin: bool,
    pub exempt_payee: bool,
}

/// `backupWithholdingReason(vendor)`: `no_tin`, `flagged` or none.
pub fn backup_withholding_reason(vendor: BackupWithholdingVendor) -> Option<&'static str> {
    if vendor.exempt_payee {
        return None;
    }
    if vendor.no_tin {
        return Some("no_tin");
    }
    if vendor.backup_withholding {
        return Some("flagged");
    }
    None
}

/// The reporting threshold a payment is compared with: `None` is
/// `undefined` (not compared), `Some(None)` a null threshold (any positive
/// amount).
pub type Threshold = Option<Option<f64>>;

/// `BackupWithholdingResult`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackupWithholdingResult {
    pub reason: Option<&'static str>,
    /// Dollars kept back, to the cent.
    pub withheld: f64,
    /// What the vendor receives.
    pub net: f64,
}

/// `toCents(amount)`.
#[allow(clippy::cast_possible_truncation)]
fn to_cents(amount: f64) -> i64 {
    math_round(amount * 100.0) as i64
}

/// `backupWithholdingDetail(amount, vendor, { yearToDate, threshold })`.
#[allow(clippy::cast_precision_loss)]
pub fn backup_withholding_detail(
    amount: f64,
    vendor: BackupWithholdingVendor,
    year_to_date: f64,
    threshold: Threshold,
) -> BackupWithholdingResult {
    let gross = to_cents(amount);
    let reason = backup_withholding_reason(vendor);
    let reportable = match threshold {
        None | Some(None) => true,
        Some(Some(threshold)) => to_cents(year_to_date) + gross >= to_cents(threshold),
    };
    if reason.is_none() || gross <= 0 || !reportable {
        return BackupWithholdingResult {
            reason: None,
            withheld: 0.0,
            net: gross as f64 / 100.0,
        };
    }
    // 24% in whole cents, half a cent rounded up.
    let withheld_cents = (gross * 24 + 50).div_euclid(100);
    BackupWithholdingResult {
        reason,
        withheld: withheld_cents as f64 / 100.0,
        net: (gross - withheld_cents) as f64 / 100.0,
    }
}

/// `form1099Thresholds(year).boxes[box]` for the boxes a payment can be
/// allocated to: $600 (general) before 2026 and $2,000 from 2026, royalties
/// and substitute payments $10, attorney proceeds and fish $600, golden
/// parachutes any amount (`Some(None)`). `None` for anything else.
pub fn box_threshold(code: &str, year: i64) -> Threshold {
    let general = if year >= 2026 { 2000.0 } else { 600.0 };
    match code {
        "nec_1" | "misc_1" | "misc_3" | "misc_5" | "misc_6" | "misc_9" | "misc_12"
        | "misc_14" => Some(Some(general)),
        "misc_2" | "misc_8" => Some(Some(10.0)),
        "misc_10" | "misc_11" => Some(Some(600.0)),
        "nec_3" => Some(None),
        _ => None,
    }
}

/// `BackupWithholdingOutcome`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackupWithholdingOutcome {
    /// Dollars to keep back; 0 when none applies.
    pub amount: f64,
    pub reason: Option<&'static str>,
    pub rate: f64,
    pub net: f64,
}

/// `ComputeBackupWithholdingInput`.
#[derive(Debug, Clone, Default)]
pub struct ComputeBackupWithholdingInput<'a> {
    pub entity_id: &'a str,
    pub party_id: &'a str,
    pub gross_amount: f64,
    /// The payment's day, `YYYY-MM-DD` (`dayOf(date)`).
    pub day: &'a str,
    pub payment_method: Option<&'a str>,
    pub paid_through_payroll: bool,
    pub from_credit_card_account: bool,
}

fn none(gross: f64) -> BackupWithholdingOutcome {
    BackupWithholdingOutcome {
        amount: 0.0,
        reason: None,
        rate: BACKUP_WITHHOLDING_RATE,
        net: gross,
    }
}

/// `defaultBox(party)`: the box a payment to the vendor lands in when
/// nothing more specific says otherwise.
fn default_box(form: Option<&str>, raw_box: Option<&str>) -> Option<String> {
    let raw = weldsuite_kit::validation::js_trim(raw_box.unwrap_or_default()).to_lowercase();
    let form = form.filter(|f| !f.is_empty());
    if raw == FORM_1099_OMIT {
        return Some(FORM_1099_OMIT.to_owned());
    }
    if !raw.is_empty()
        && raw.bytes().all(|b| b.is_ascii_digit())
        && let Some(form) = form
    {
        return Some(format!("{form}_{raw}"));
    }
    if !raw.is_empty() {
        return Some(raw);
    }
    (form == Some("nec")).then(|| "nec_1".to_owned())
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `computeBackupWithholding(db, input)`: what to keep back from a payment
/// to the vendor.
pub async fn compute_backup_withholding(
    db: &PgPool,
    input: ComputeBackupWithholdingInput<'_>,
) -> Result<BackupWithholdingOutcome, sqlx::Error> {
    let gross = math_round(input.gross_amount * 100.0) / 100.0;
    if gross <= 0.0 || gross.is_nan() {
        return Ok(none(gross));
    }
    let method = weldsuite_kit::validation::js_trim(input.payment_method.unwrap_or_default())
        .to_lowercase();
    if FORM_1099K_PAYMENT_METHODS.contains(&method.as_str())
        || input.paid_through_payroll
        || input.from_credit_card_account
    {
        return Ok(none(gross));
    }
    let party: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(parties),
        " from parties t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(input.party_id)
    .fetch_optional(db)
    .await?;
    let Some(party) = party.map(|row| PARTIES.js(row)) else {
        return Ok(none(gross));
    };
    if party.get("is1099Vendor").and_then(Value::as_bool) != Some(true) {
        return Ok(none(gross));
    }
    let w9 = party.get("w9").filter(|w| w.is_object());
    let w9_text = |key: &str| w9.and_then(|w| text(w, key));
    let corporation = is_corporation_classification(
        w9_text("federalTaxClassification"),
        w9_text("llcTaxClassification"),
    );
    let is_attorney = w9.is_some_and(|w| crate::js::truthy(w.get("isAttorney")));
    let exempt_payee = w9_text("exemptPayeeCode")
        .is_some_and(|code| !weldsuite_kit::validation::js_trim(code).is_empty())
        || (corporation && !is_attorney);

    let code = default_box(text(&party, "default1099Form"), text(&party, "default1099Box"));
    if code.as_deref() == Some(FORM_1099_OMIT) {
        return Ok(none(gross));
    }
    let year = crate::js::parse_int(input.day.get(..4).unwrap_or_default());
    let mut threshold: Threshold = None;
    let mut year_to_date = 0.0;
    if let (Some(code), Some(year)) = (code.as_deref(), year)
        && is_allocatable_box(code)
        && year >= 2020
    {
        threshold = box_threshold(code, year);
        if threshold.is_some() {
            let start = format!("{year:04}-01-01T00:00:00.000Z");
            let end = format!("{}T23:59:59.999Z", input.day);
            let total: String = sqlx::query_scalar(
                "select coalesce(sum(amount), 0)::text from payments \
                 where entity_id = $1 and type = 'sent' and contact_id = $2 and deleted_at is null \
                 and date >= $3::timestamp and date <= $4::timestamp \
                 and coalesce(payment_method, '') not in ('credit_card', 'debit_card', 'third_party_network') \
                 and coalesce(paid_through_payroll, false) = false",
            )
            .bind(input.entity_id)
            .bind(input.party_id)
            .bind(&start)
            .bind(&end)
            .fetch_one(db)
            .await?;
            year_to_date = numeric(&Value::String(total));
        }
    }
    let result = backup_withholding_detail(
        gross,
        BackupWithholdingVendor {
            backup_withholding: party.get("backupWithholding").and_then(Value::as_bool)
                == Some(true),
            no_tin: !crate::js::truthy(party.get("tinLast4")),
            exempt_payee,
        },
        year_to_date,
        threshold,
    );
    Ok(BackupWithholdingOutcome {
        amount: result.withheld,
        reason: result.reason,
        rate: BACKUP_WITHHOLDING_RATE,
        net: result.net,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn withholding_in_cents() {
        let vendor = BackupWithholdingVendor {
            no_tin: true,
            ..BackupWithholdingVendor::default()
        };
        let result = backup_withholding_detail(5000.0, vendor, 0.0, None);
        assert_eq!(result.withheld, 1200.0);
        assert_eq!(result.net, 3800.0);
        assert_eq!(result.reason, Some("no_tin"));
        // Below the year's threshold: nothing yet.
        let below = backup_withholding_detail(500.0, vendor, 0.0, Some(Some(2000.0)));
        assert_eq!(below.withheld, 0.0);
        // Half a cent rounds up.
        assert_eq!(
            backup_withholding_detail(0.02, vendor, 0.0, None).withheld,
            0.0
        );
        assert_eq!(
            backup_withholding_detail(0.03, vendor, 0.0, None).withheld,
            0.01
        );
        let exempt = BackupWithholdingVendor {
            exempt_payee: true,
            no_tin: true,
            ..BackupWithholdingVendor::default()
        };
        assert_eq!(backup_withholding_reason(exempt), None);
    }

    #[test]
    fn default_boxes() {
        assert_eq!(default_box(Some("nec"), None).as_deref(), Some("nec_1"));
        assert_eq!(default_box(Some("misc"), Some(" 3 ")).as_deref(), Some("misc_3"));
        assert_eq!(default_box(None, Some("OMIT")).as_deref(), Some("omit"));
        assert_eq!(default_box(Some("misc"), None), None);
        assert_eq!(box_threshold("nec_1", 2026), Some(Some(2000.0)));
        assert_eq!(box_threshold("nec_3", 2026), Some(None));
    }
}
