//! Checks of a payment run (`services/payment-runs/checks.ts`): what the
//! platform prints them from, marking them printed, voiding and reissuing,
//! and the check register.
//!
//! A check is a payment with `payment_method = 'check'`: `to_print` until
//! printed, `printed`, `cleared` (bank reconciliation) or `voided`. A voided
//! check keeps its row and number (the payment is soft-deleted), so these
//! reads include deleted rows and call them voided. A check is written for
//! the payment less any backup withholding.

use base64::Engine;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::bank_accounts::reveal_account_number;
use weldsuite_books_domain::checks::{
    MicrInput, amount_in_words, build_micr_fields, build_micr_line, courtesy_amount,
    fractional_routing, get_check_layout,
};
use weldsuite_books_domain::guards::{PostingCheck, PostingLockKind, assert_posting_allowed};
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::js::{locale_compare, parse_float, to_fixed, utf16_len};
use weldsuite_books_domain::payments::{payment_net_amount, void_payment};
use weldsuite_books_domain::tables::{BILLS, PAYMENT_RUNS, PAYMENTS};
use weldsuite_db::Keyring;
use weldsuite_ports::OutboundHttp;

use super::approval::{RunPayment, create_run_payment};
use super::runs::{find_run, load_run, s, text};
use super::settings::{load_entity, read_check_settings};
use super::{Faults, RunError, bad, load_bank_account, not_found, run_error, us_address_lines};

/// `checkStatusOf(payment)`.
pub(crate) fn check_status_of(payment: &Value) -> &'static str {
    let deleted = payment.get("deletedAt").is_some_and(|d| !d.is_null());
    match text(payment, "checkStatus") {
        _ if deleted => "voided",
        Some("voided") => "voided",
        Some("to_print") => "to_print",
        Some("cleared") => "cleared",
        _ => "printed",
    }
}

/// `compareCheckNumbers(a, b)`: digits compare as numbers (shorter first).
fn compare_check_numbers(a: Option<&str>, b: Option<&str>) -> std::cmp::Ordering {
    let x = a.unwrap_or_default();
    let y = b.unwrap_or_default();
    let (lx, ly) = (utf16_len(x), utf16_len(y));
    if lx == ly {
        locale_compare(x, y)
    } else {
        lx.cmp(&ly)
    }
}

fn iso_day(value: &str) -> String {
    value.chars().take(10).collect()
}

fn us_date(iso: &str) -> String {
    let mut parts = iso.split('-');
    let (y, m, d) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    format!("{m}/{d}/{y}")
}

fn not_a_check_run() -> RunError {
    run_error(
        "NOT_A_CHECK_RUN",
        "This is an ACH run: it has no checks to print.".to_owned(),
        409,
        None,
    )
}

fn assert_printable(run: &Value) -> Result<(), RunError> {
    if s(run, "method") != "check" {
        return Err(not_a_check_run());
    }
    let status = s(run, "status");
    if status != "approved" && status != "completed" {
        return Err(run_error(
            "RUN_NOT_APPROVED",
            "Checks can be printed once the run is approved.".to_owned(),
            409,
            Some(json!({ "status": status })),
        ));
    }
    Ok(())
}

/// `buildCheckPrintData(db, env, args)`.
#[allow(clippy::too_many_lines)] // the print data, field by field
pub(crate) async fn build_check_print_data(
    db: &PgPool,
    keyring: &Keyring,
    entity_id: &str,
    run_id: &str,
    user_id: &str,
    include_printed: bool,
) -> Result<Value, RunError> {
    let run = load_run(db, entity_id, run_id).await?;
    assert_printable(&run)?;
    let bank = load_bank_account(db, entity_id, s(&run, "bankAccountId")).await?;
    let settings = read_check_settings(bank.get("checkSettings"));
    let Some(entity) = load_entity(db, entity_id).await? else {
        return Err(not_found("Accounting entity", entity_id));
    };
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payments),
        " from payments t where t.payment_run_id = $1 and t.deleted_at is null"
    ))
    .bind(s(&run, "id"))
    .fetch_all(db)
    .await?;
    let mut wanted: Vec<Value> = PAYMENTS
        .js_rows(rows)
        .into_iter()
        .filter(|p| include_printed || check_status_of(p) == "to_print")
        .filter(|p| text(p, "checkNumber").is_some_and(|n| !n.is_empty()))
        .collect();
    wanted.sort_by(|a, b| compare_check_numbers(text(a, "checkNumber"), text(b, "checkNumber")));
    let payment_ids: Vec<String> = wanted.iter().map(|p| s(p, "id").to_owned()).collect();
    let mut party_ids: Vec<String> = Vec::new();
    for payment in &wanted {
        let id = s(payment, "contactId").to_owned();
        if !party_ids.contains(&id) {
            party_ids.push(id);
        }
    }
    let allocations: Vec<(String, String, Value)> = if payment_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(concat!(
            "select pa.payment_id, pa.amount::text, ",
            weldsuite_books_domain::books_row!(bills),
            " from payment_allocations pa inner join bills t on t.id = pa.bill_id \
             where pa.payment_id = any($1) and pa.deleted_at is null"
        ))
        .bind(&payment_ids)
        .fetch_all(db)
        .await?
    };
    let allocations: Vec<(String, String, Value)> = allocations
        .into_iter()
        .map(|(payment, amount, bill)| (payment, amount, BILLS.js(bill)))
        .collect();
    let parties = super::holds::load_parties(db, &party_ids).await?;

    // Blank stock with MICR: the account number comes out of storage once for the whole sheet, and the reveal is logged.
    let mut account_number: Option<String> = None;
    if settings.print_micr && !wanted.is_empty() {
        let truthy = |key: &str| weldsuite_books_domain::js::truthy(bank.get(key));
        if !truthy("routingNumber") || !truthy("accountNumberEncrypted") {
            return Err(run_error(
                "MICR_UNAVAILABLE",
                "MICR printing needs the bank account's routing number and account number. Add them, or turn MICR printing off for preprinted stock.".to_owned(),
                409,
                None,
            ));
        }
        account_number = Some(
            reveal_account_number(db, keyring, &bank, user_id, Some("check_micr"))
                .await?
                .account_number,
        );
    }
    let routing = text(&bank, "routingNumber").filter(|r| !r.is_empty());

    let mut checks = Vec::with_capacity(wanted.len());
    for payment in &wanted {
        let check_number = s(payment, "checkNumber");
        let gross = parse_float(s(payment, "amount"));
        let withheld = parse_float(text(payment, "backupWithholdingAmount").unwrap_or("0"));
        let amount = payment_net_amount(payment);
        let rows: Vec<&(String, String, Value)> = allocations
            .iter()
            .filter(|(id, _, _)| id == s(payment, "id"))
            .collect();
        let party = parties
            .iter()
            .find(|p| s(p, "id") == s(payment, "contactId"));
        let external = |bill: &Value| {
            text(bill, "externalReference")
                .map(weldsuite_kit::validation::js_trim)
                .filter(|r| !r.is_empty())
                .map(str::to_owned)
        };
        let bill_numbers: Vec<String> = rows
            .iter()
            .map(|(_, _, bill)| {
                external(bill)
                    .or_else(|| {
                        text(bill, "billNumber")
                            .filter(|n| !n.is_empty())
                            .map(str::to_owned)
                    })
                    .or_else(|| {
                        text(bill, "reference")
                            .filter(|n| !n.is_empty())
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| s(bill, "id").to_owned())
            })
            .collect();

        let mut micr = Value::Null;
        if let (Some(account), Some(routing)) = (&account_number, routing) {
            let input = MicrInput {
                routing_number: routing,
                account_number: account,
                check_number,
                personal: settings.personal_micr,
                check_number_width: usize::try_from(settings.check_number_width).unwrap_or(6),
            };
            let built = build_micr_fields(&input).and_then(|fields| {
                build_micr_line(&input).map(|line| {
                    json!({
                        "line": line,
                        "fields": fields.to_json(),
                        "fieldsAsFontLetters": fields.as_font_letters().to_json(),
                    })
                })
            });
            micr = built.map_err(|message| {
                run_error(
                    "MICR_INVALID",
                    format!("The MICR line for check {check_number} can't be made: {message}"),
                    409,
                    None,
                )
            })?;
        }
        let fractional = routing.and_then(|r| {
            fractional_routing(r, settings.fractional_numerator.as_deref())
                .ok()
                .flatten()
        });
        let memo = if bill_numbers.is_empty() {
            Value::Null
        } else {
            let label = if bill_numbers.len() == 1 {
                "Bill"
            } else {
                "Bills"
            };
            json!(weldsuite_books_domain::js::slice_utf16(
                &format!("{label} {}", bill_numbers.join(", ")),
                60
            ))
        };
        let words = amount_in_words(amount).ok_or_else(|| {
            RunError::Internal(format!("A check amount is out of range: {amount}"))
        })?;
        let courtesy = courtesy_amount(amount).ok_or_else(|| {
            RunError::Internal(format!("A check amount is out of range: {amount}"))
        })?;
        let date = iso_day(s(payment, "date"));
        let withheld_text = if withheld > 0.0 {
            json!(to_fixed(withheld, 2))
        } else {
            Value::Null
        };
        let voucher_rows: Vec<Value> = rows
            .iter()
            .map(|(_, allocated, bill)| {
                let allocated = parse_float(allocated);
                let total = parse_float(text(bill, "total").unwrap_or("0"));
                let covers = (total - allocated).abs() < 0.005;
                let discount = parse_float(text(bill, "discountTotal").unwrap_or("0"));
                let description = match bill.get("reference") {
                    Some(Value::Null) | None => bill.get("notes").cloned().unwrap_or(Value::Null),
                    Some(value) => value.clone(),
                };
                json!({
                    "date": text(bill, "issueDate").map(iso_day),
                    "reference": external(bill).map_or_else(|| bill.get("billNumber").cloned().unwrap_or(Value::Null), Value::String),
                    "description": description,
                    "amount": to_fixed(allocated, 2),
                    "billTotal": bill.get("total").cloned().unwrap_or(Value::Null),
                    "discount": if covers && discount > 0.0 { json!(to_fixed(discount, 2)) } else { Value::Null },
                })
            })
            .collect();
        checks.push(json!({
            "paymentId": s(payment, "id"),
            "checkNumber": check_number,
            "checkStatus": check_status_of(payment),
            "date": date,
            "dateDisplay": us_date(&date),
            "amount": to_fixed(amount, 2),
            "grossAmount": to_fixed(gross, 2),
            "backupWithholdingAmount": withheld_text,
            "amountInWords": words,
            "courtesyAmount": courtesy,
            "payee": {
                "partyId": s(payment, "contactId"),
                "name": party.and_then(|p| text(p, "displayName")).unwrap_or(s(payment, "contactId")),
                "addressLines": party.map_or_else(Vec::new, |p| us_address_lines(p.get("billingAddress"))),
            },
            "memo": memo,
            "fractionalRouting": fractional,
            "micr": micr,
            "voucher": {
                "rows": voucher_rows,
                "grossTotal": to_fixed(gross, 2),
                "backupWithholding": withheld_text,
                "total": to_fixed(amount, 2),
            },
        }));
    }

    let layout = get_check_layout(&settings.layout, settings.alignment())
        .ok_or_else(|| RunError::Internal(format!("Unknown check layout {}", settings.layout)))?;
    let field = |row: &Value, key: &str| row.get(key).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "run": {
            "id": s(&run, "id"),
            "status": s(&run, "status"),
            "paymentDate": s(&run, "paymentDate"),
            "bankAccountId": s(&run, "bankAccountId"),
        },
        "layout": layout,
        "settings": {
            "layout": settings.layout,
            "printMicr": settings.print_micr,
            "signatureLineText": settings.signature_line_text,
            "checkNumberWidth": settings.check_number_width,
        },
        "payer": {
            "name": text(&entity, "legalName").or_else(|| text(&entity, "name")),
            "dba": field(&entity, "dba"),
            "addressLines": us_address_lines(entity.get("address")),
        },
        "bank": {
            "name": settings.bank_name.clone().map_or_else(|| field(&bank, "bankName"), Value::String),
            "addressLines": settings.bank_address_lines,
            "accountNumberLast4": field(&bank, "accountNumberLast4"),
        },
        "checks": checks,
    }))
}

/// `syncCheckRunStatus(db, run)`: completed once nothing is left to print;
/// a reissued check puts it back to approved.
pub(crate) async fn sync_check_run_status(db: &PgPool, run: Value) -> Result<Value, RunError> {
    let status = s(&run, "status");
    if s(&run, "method") != "check" || (status != "approved" && status != "completed") {
        return Ok(run);
    }
    let statuses: Vec<Option<String>> = sqlx::query_scalar(
        "select check_status from payments where payment_run_id = $1 and deleted_at is null",
    )
    .bind(s(&run, "id"))
    .fetch_all(db)
    .await?;
    if statuses.is_empty() {
        return Ok(run);
    }
    let next = if statuses.iter().any(|s| s.as_deref() == Some("to_print")) {
        "approved"
    } else {
        "completed"
    };
    if next == status {
        return Ok(run);
    }
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update payment_runs t set status = $2, updated_at = $3::timestamp where t.id = $1 returning ",
        weldsuite_books_domain::books_row!(payment_runs)
    ))
    .bind(s(&run, "id"))
    .bind(next)
    .bind(now())
    .fetch_optional(db)
    .await?;
    Ok(row.map_or(run, |row| PAYMENT_RUNS.js(row)))
}

/// `markChecksPrinted(db, args)`: `(run, printed, alreadyPrinted)`.
pub(crate) async fn mark_checks_printed(
    db: &PgPool,
    entity_id: &str,
    run_id: &str,
    payment_ids: &[String],
) -> Result<(Value, Vec<String>, Vec<String>), RunError> {
    let run = load_run(db, entity_id, run_id).await?;
    assert_printable(&run)?;
    let mut ids: Vec<String> = Vec::new();
    for id in payment_ids {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    let payments: Vec<(String, Option<String>)> = sqlx::query_as(
        "select id, check_status from payments where payment_run_id = $1 and id = any($2) and deleted_at is null",
    )
    .bind(s(&run, "id"))
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let missing: Vec<&String> = ids
        .iter()
        .filter(|id| !payments.iter().any(|(found, _)| found == *id))
        .collect();
    if !missing.is_empty() {
        return Err(bad(
            "PAYMENT_NOT_IN_RUN",
            "Some of these payments are not active checks of this run.",
            Some(json!({ "paymentIds": missing })),
        ));
    }
    let to_mark: Vec<String> = payments
        .iter()
        .filter(|(_, status)| status.as_deref() == Some("to_print"))
        .map(|(id, _)| id.clone())
        .collect();
    let already: Vec<String> = payments
        .iter()
        .filter(|(_, status)| status.as_deref() != Some("to_print"))
        .map(|(id, _)| id.clone())
        .collect();
    if !to_mark.is_empty() {
        sqlx::query(
            "update payments set check_status = 'printed', check_printed_at = $2::timestamp, updated_at = $2::timestamp \
             where id = any($1) and check_status = 'to_print'",
        )
        .bind(&to_mark)
        .bind(now())
        .execute(db)
        .await?;
    }
    let synced = sync_check_run_status(db, run).await?;
    Ok((synced, to_mark, already))
}

/// `VoidCheckResult`.
pub(crate) struct VoidedCheck {
    pub voided: Value,
    pub replacement: Option<Value>,
    pub run: Option<Value>,
}

/// `voidCheck(db, args)`: the payment voided (ledger entry reversed, bills
/// open again) keeping its number; with `reissue` the same amount goes out
/// again on a new check, to print, with the same backup withholding.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub(crate) async fn void_check(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    faults: &Faults,
    entity_id: &str,
    payment_id: &str,
    user_id: &str,
    reason: &str,
    reissue: bool,
    date: Option<&str>,
) -> Result<VoidedCheck, RunError> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payments),
        " from payments t where t.id = $1 and t.entity_id = $2 limit 1"
    ))
    .bind(payment_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some(payment) = row
        .map(|row| PAYMENTS.js(row))
        .filter(|p| s(p, "type") == "sent" && text(p, "paymentMethod") == Some("check"))
    else {
        return Err(not_found("Check", payment_id));
    };
    let deleted = payment.get("deletedAt").is_some_and(|d| !d.is_null());
    let check_status = text(&payment, "checkStatus");
    if deleted || check_status == Some("voided") {
        return Err(run_error(
            "ALREADY_VOIDED",
            "This check is already voided.".to_owned(),
            409,
            None,
        ));
    }
    if check_status == Some("cleared") {
        return Err(run_error(
            "CHECK_CLEARED",
            "This check has cleared the bank: it can't be voided.".to_owned(),
            409,
            None,
        ));
    }
    let Some(bank_account_id) = text(&payment, "bankAccountId")
        .filter(|b| !b.is_empty())
        .map(str::to_owned)
    else {
        return Err(run_error(
            "NO_BANK_ACCOUNT",
            "This check has no bank account.".to_owned(),
            409,
            None,
        ));
    };
    let rows: Vec<(Option<String>, String)> = sqlx::query_as(
        "select bill_id, amount::text from payment_allocations where payment_id = $1 and deleted_at is null",
    )
    .bind(s(&payment, "id"))
    .fetch_all(db)
    .await?;
    let mut allocations: Vec<(String, f64)> = rows
        .into_iter()
        .filter_map(|(bill, amount)| {
            bill.filter(|b| !b.is_empty())
                .map(|b| (b, parse_float(&amount)))
        })
        .collect();
    if allocations.is_empty()
        && let Some(bill) = text(&payment, "billId").filter(|b| !b.is_empty())
    {
        allocations.push((bill.to_owned(), parse_float(s(&payment, "amount"))));
    }
    let today = iso_day(&now());
    let replacement_date = date.map_or_else(|| today.clone(), str::to_owned);
    if reissue {
        if allocations.is_empty() {
            return Err(bad(
                "NOTHING_TO_REISSUE",
                "This check paid no bills, so there is nothing to reissue.",
                None,
            ));
        }
        // Fail before voiding, not after: the replacement posts on this date.
        assert_posting_allowed(
            db,
            PostingCheck {
                entity_id,
                date: &replacement_date,
                kind: PostingLockKind::General,
                affects_tax: false,
                user_id: Some(user_id),
            },
        )
        .await?;
    }

    void_payment(db, s(&payment, "id"), Some(user_id.to_owned()), None).await?;
    let note = format!(
        "Voided {}: {}",
        iso_day(&now()),
        weldsuite_kit::validation::js_trim(reason)
    );
    let notes = match text(&payment, "notes").filter(|n| !n.is_empty()) {
        Some(existing) => format!("{existing}\n{note}"),
        None => note,
    };
    sqlx::query("update payments set check_status = 'voided', notes = $2, updated_at = $3::timestamp where id = $1")
        .bind(s(&payment, "id"))
        .bind(&notes)
        .bind(now())
        .execute(db)
        .await?;

    let mut replacement = None;
    if reissue {
        let created = create_run_payment(
            db,
            http,
            faults,
            RunPayment {
                entity_id,
                run_id: text(&payment, "paymentRunId"),
                id: None,
                check: true,
                bank_account_id: &bank_account_id,
                party_id: s(&payment, "contactId"),
                date: &replacement_date,
                allocations,
                // The replacement is the same payment on a new check: the withholding taken from the voided one carries over.
                backup_withholding_amount: parse_float(
                    text(&payment, "backupWithholdingAmount").unwrap_or("0"),
                ),
                user_id,
                notes: Some(format!(
                    "Replaces check {}",
                    text(&payment, "checkNumber").unwrap_or(s(&payment, "id"))
                )),
                reference: text(&payment, "reference").map(str::to_owned),
            },
        )
        .await?;
        replacement = Some(json!({
            "paymentId": created.payment_id,
            "checkNumber": created.check_number,
            "amount": to_fixed(created.amount, 2),
            "backupWithholdingAmount": if created.backup_withholding_amount > 0.0 {
                json!(to_fixed(created.backup_withholding_amount, 2))
            } else {
                Value::Null
            },
            "netAmount": to_fixed(created.net_amount, 2),
            "checkStatus": "to_print",
        }));
    }

    let mut run = None;
    if let Some(run_id) = text(&payment, "paymentRunId").filter(|r| !r.is_empty())
        && let Some(row) = find_run(db, run_id).await?
    {
        run = Some(sync_check_run_status(db, row).await?);
    }
    let withheld = payment
        .get("backupWithholdingAmount")
        .cloned()
        .unwrap_or(Value::Null);
    let has_withholding = parse_float(withheld.as_str().unwrap_or("0")) > 0.0;
    Ok(VoidedCheck {
        voided: json!({
            "paymentId": s(&payment, "id"),
            "checkNumber": payment.get("checkNumber"),
            "amount": payment.get("amount"),
            "backupWithholdingAmount": if has_withholding { withheld } else { Value::Null },
            "netAmount": to_fixed(payment_net_amount(&payment), 2),
            "partyId": payment.get("contactId"),
            "runId": payment.get("paymentRunId"),
        }),
        replacement,
        run,
    })
}

// ── Check register ──────────────────────────────────────────────────────────

/// `RegisterFilter`.
pub(crate) struct Register<'a> {
    pub bank_account_id: Option<&'a str>,
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    pub status: Option<&'a str>,
    pub limit: i64,
    pub cursor: Option<&'a str>,
}

/// `registerWhere(filter)` on `t` (payments); `$1` entity, `$2` bank account,
/// `$3` from, `$4` to.
macro_rules! register_where {
    () => {
        "t.entity_id = $1 and t.type = 'sent' and t.payment_method = 'check' and t.check_number is not null \
         and ($2::text is null or t.bank_account_id = $2) \
         and ($3::text is null or t.date >= ($3 || 'T00:00:00.000Z')::timestamp) \
         and ($4::text is null or t.date <= ($4 || 'T23:59:59.999Z')::timestamp)"
    };
}
pub(crate) use register_where;

/// `STATUS_SQL`.
macro_rules! status_sql {
    () => {
        "(case when t.deleted_at is not null or t.check_status = 'voided' then 'voided' else coalesce(t.check_status, 'printed') end)"
    };
}

/// `decodeOffset(cursor)`.
fn decode_offset(cursor: Option<&str>) -> Result<i64, RunError> {
    let Some(cursor) = cursor.filter(|c| !c.is_empty()) else {
        return Ok(0);
    };
    let cleaned: String = cursor
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    let trimmed = if cleaned.len().is_multiple_of(4) {
        cleaned.trim_end_matches('=').to_owned()
    } else {
        cleaned
    };
    // `atob` throws on bad base64: the route's 500.
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(trimmed.as_bytes())
        .map_err(|error| RunError::Internal(format!("atob: {error}")))?;
    let decoded: String = bytes.iter().map(|b| char::from(*b)).collect();
    let offset = weldsuite_kit::validation::js_number(&decoded);
    if !(offset.is_finite() && offset.fract() == 0.0 && offset >= 0.0) {
        return Err(bad("INVALID_CURSOR", "Invalid cursor", None));
    }
    #[allow(clippy::cast_possible_truncation)]
    Ok(offset as i64)
}

/// `checkRegister(db, filter)`: the rows, the summary by status, the total,
/// whether there is more, the next cursor.
pub(crate) async fn check_register(
    db: &PgPool,
    entity_id: &str,
    filter: Register<'_>,
) -> Result<(Vec<Value>, Value, i64, bool, Option<String>), RunError> {
    let offset = decode_offset(filter.cursor)?;
    let rows: Vec<(Value, Option<String>, Option<String>)> = sqlx::query_as(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payments),
        ", p.display_name, r.status from payments t left join parties p on p.id = t.contact_id \
         left join payment_runs r on r.id = t.payment_run_id where ",
        register_where!(),
        " and ($5::text is null or ",
        status_sql!(),
        " = $5) order by length(t.check_number), t.check_number asc, t.id asc limit $6 offset $7"
    ))
    .bind(entity_id)
    .bind(filter.bank_account_id)
    .bind(filter.from)
    .bind(filter.to)
    .bind(filter.status)
    .bind(filter.limit + 1)
    .bind(offset)
    .fetch_all(db)
    .await?;
    let totals: Vec<(String, i64, String)> = sqlx::query_as(concat!(
        "select ",
        status_sql!(),
        ", count(*)::bigint, coalesce(sum(t.amount - coalesce(t.backup_withholding_amount, 0)), 0)::text \
         from payments t where ",
        register_where!(),
        " group by ",
        status_sql!()
    ))
    .bind(entity_id)
    .bind(filter.bank_account_id)
    .bind(filter.from)
    .bind(filter.to)
    .fetch_all(db)
    .await?;
    let has_more = i64::try_from(rows.len()).unwrap_or(0) > filter.limit;
    let mut summary = Map::new();
    for (status, count, total) in &totals {
        summary.insert(
            status.clone(),
            json!({ "count": count, "total": to_fixed(weldsuite_books_domain::js::numeric_text(Some(total)), 2) }),
        );
    }
    let page: Vec<Value> = rows
        .into_iter()
        .take(usize::try_from(filter.limit).unwrap_or(0))
        .map(|(row, payee, run_status)| {
            let payment = PAYMENTS.js(row);
            let field = |key: &str| payment.get(key).cloned().unwrap_or(Value::Null);
            let withheld = field("backupWithholdingAmount");
            let has_withholding = parse_float(withheld.as_str().unwrap_or("0")) > 0.0;
            json!({
                "paymentId": field("id"),
                "checkNumber": field("checkNumber"),
                "date": iso_day(s(&payment, "date")),
                "payeeId": field("contactId"),
                "payeeName": payee.map_or_else(|| field("contactId"), Value::String),
                "amount": to_fixed(payment_net_amount(&payment), 2),
                "grossAmount": field("amount"),
                "backupWithholdingAmount": if has_withholding { withheld } else { Value::Null },
                "status": check_status_of(&payment),
                "bankAccountId": field("bankAccountId"),
                "runId": field("paymentRunId"),
                "runStatus": run_status,
                "printedAt": field("checkPrintedAt"),
                "voidedAt": field("deletedAt"),
                "reference": field("reference"),
                "notes": field("notes"),
            })
        })
        .collect();
    let total_count = match filter.status {
        Some(status) => summary
            .get(status)
            .and_then(|s| s["count"].as_i64())
            .unwrap_or(0),
        None => totals.iter().map(|(_, count, _)| *count).sum(),
    };
    let cursor = has_more.then(|| {
        base64::engine::general_purpose::STANDARD.encode((offset + filter.limit).to_string())
    });
    Ok((page, Value::Object(summary), total_count, has_more, cursor))
}
