//! The NACHA file of an ACH payment run (`services/payment-runs/nacha.ts`):
//! one credit per vendor (the payment less any backup withholding), prenotes
//! for new accounts, the offsetting debit of a balanced file. Vendor account
//! numbers (and the company's, for a balanced file) are decrypted here, each
//! decryption logged in `tax_id_reveals` (`nacha_file`). A vendor whose bank
//! details changed after approval blocks the file, and the finished file is
//! read back by the verifier before it is released.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::bank_accounts::reveal_account_number;
use weldsuite_books_domain::js::{millis_of, parse_float, to_fixed};
use weldsuite_books_domain::nacha::{
    NachaBuildError, NachaFileInput, NachaOffsetAccount, NachaOriginator, NachaPayment,
    build_nacha_file, build_rmr_segments, issues_json, suggest_effective_entry_date,
    verify_nacha_file,
};
use weldsuite_books_domain::payments::payment_net_amount;
use weldsuite_books_domain::tables::{PAYMENT_RUNS, PAYMENTS};
use weldsuite_books_domain::vendor_tax::{SecretField, VendorTaxError, reveal_party_secret};
use weldsuite_db::Keyring;

use super::holds::{decode_holds, load_parties};
use super::runs::{approvals_of, load_run, s, text};
use super::settings::{
    ach_missing, can_offset, effective_originator, load_entity, read_ach_settings,
};
use super::{RunError, load_bank_account, run_error};

const FALLBACK_TIME_ZONE: &str = "America/New_York";

/// `localDateTime(now, timeZone)`: the date and `HHMM` in a time zone (Nacha
/// dates are the originator's local ones).
pub(crate) fn local_date_time(millis: i64, time_zone: Option<&str>) -> (String, String) {
    let zone = time_zone
        .filter(|z| !z.is_empty())
        .and_then(|z| jiff::tz::TimeZone::get(z).ok())
        .or_else(|| jiff::tz::TimeZone::get(FALLBACK_TIME_ZONE).ok())
        .unwrap_or(jiff::tz::TimeZone::UTC);
    let Ok(timestamp) = jiff::Timestamp::from_millisecond(millis) else {
        return ("1970-01-01".to_owned(), "0000".to_owned());
    };
    let local = timestamp.to_zoned(zone).datetime();
    (
        format!(
            "{:04}-{:02}-{:02}",
            local.year(),
            local.month(),
            local.day()
        ),
        format!("{:02}{:02}", local.hour(), local.minute()),
    )
}

/// `fileIdModifierFor(index)`: A to Z, then digits.
pub(crate) fn file_id_modifier_for(index: usize) -> String {
    const ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    ALPHABET.chars().nth(index).unwrap_or('9').to_string()
}

/// `isIndividual(party)`.
fn is_individual(party: &Value) -> bool {
    text(party, "kind") == Some("person")
        || party
            .get("w9")
            .and_then(|w| w.get("federalTaxClassification"))
            .and_then(Value::as_str)
            == Some("individual")
}

/// `cents(n)`.
#[allow(clippy::cast_precision_loss)]
fn cents(n: i64) -> String {
    to_fixed(n as f64 / 100.0, 2)
}

struct Meta {
    party_id: String,
    name: String,
    sec_code: String,
    last4: Value,
    amount: String,
    gross: String,
    withheld: Value,
}

/// What `GET /:id/nacha` answers, and the run after.
pub(crate) struct NachaFile {
    pub file_name: String,
    pub content: String,
    pub summary: Value,
    pub run: Value,
}

/// `generateNachaFile(db, env, { entityId, runId, userId })`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub(crate) async fn generate_nacha_file(
    db: &PgPool,
    keyring: &Keyring,
    entity_id: &str,
    run_id: &str,
    user_id: &str,
) -> Result<NachaFile, RunError> {
    let now = weldsuite_books_domain::http::now_ms();
    let run = load_run(db, entity_id, run_id).await?;
    if s(&run, "method") != "ach" {
        return Err(run_error(
            "NOT_AN_ACH_RUN",
            "This is a check run: it has no NACHA file.".to_owned(),
            409,
            None,
        ));
    }
    let status = s(&run, "status");
    if status != "approved" && status != "exported" {
        return Err(run_error(
            "RUN_NOT_APPROVED",
            "The NACHA file can be made once the run is approved.".to_owned(),
            409,
            Some(json!({ "status": status })),
        ));
    }
    let bank = load_bank_account(db, entity_id, s(&run, "bankAccountId")).await?;
    let ach = read_ach_settings(bank.get("achSettings"));
    let Some(entity) = load_entity(db, entity_id).await? else {
        return Err(run_error(
            "NOT_FOUND",
            "Accounting entity not found".to_owned(),
            404,
            None,
        ));
    };
    let same_day = run.get("sameDay") == Some(&Value::Bool(true));
    if same_day && !ach.same_day_allowed {
        return Err(run_error(
            "SAME_DAY_NOT_ALLOWED",
            "Same Day ACH is off for this bank account.".to_owned(),
            409,
            None,
        ));
    }
    let bank_id = s(&bank, "id").to_owned();
    let offset_bank = if ach.balanced {
        match ach.offset_bank_account_id.as_deref() {
            Some(offset_id) if offset_id != bank_id => {
                Some(load_bank_account(db, entity_id, offset_id).await?)
            }
            _ => Some(bank.clone()),
        }
    } else {
        None
    };
    let effective = effective_originator(&bank, &entity, &ach);
    let missing = ach_missing(&effective, &ach, can_offset(offset_bank.as_ref()));
    if !missing.is_empty() {
        return Err(run_error(
            "ACH_SETTINGS_INCOMPLETE",
            format!(
                "The bank account's ACH settings are incomplete: {}.",
                missing.join(", ")
            ),
            409,
            Some(json!({ "missing": missing })),
        ));
    }

    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payments),
        " from payments t where t.payment_run_id = $1 and t.type = 'sent' and t.deleted_at is null \
         order by t.created_at, t.id"
    ))
    .bind(s(&run, "id"))
    .fetch_all(db)
    .await?;
    let payments = PAYMENTS.js_rows(rows);
    let prenote_holds: Vec<_> = decode_holds(run.get("holds"))
        .into_iter()
        .filter(|h| h.code == "prenote_required" && !h.is_released())
        .collect();
    if payments.is_empty() && prenote_holds.is_empty() {
        return Err(run_error(
            "NOTHING_TO_EXPORT",
            "This run has no active payments to put in a file.".to_owned(),
            409,
            None,
        ));
    }
    let mut party_ids: Vec<String> = Vec::new();
    for id in payments
        .iter()
        .map(|p| s(p, "contactId").to_owned())
        .chain(prenote_holds.iter().map(|h| h.party_id.clone()))
    {
        if !party_ids.contains(&id) {
            party_ids.push(id);
        }
    }
    let parties = load_parties(db, &party_ids).await?;
    let party_of = |id: &str| parties.iter().find(|p| s(p, "id") == id);
    let name_of = |party: &Value| -> String {
        text(party, "displayName")
            .unwrap_or(s(party, "id"))
            .to_owned()
    };

    // A vendor whose details changed after approval would be paid to an account nobody signed off.
    let approved_at = approvals_of(&run).iter().fold(String::new(), |latest, a| {
        let at = a.get("at").and_then(Value::as_str).unwrap_or_default();
        if at > latest.as_str() {
            at.to_owned()
        } else {
            latest
        }
    });
    let changed: Vec<&Value> = parties
        .iter()
        .filter(|p| {
            let Some(changed_at) = text(p, "bankDetailsChangedAt") else {
                return false;
            };
            let changed_ms = millis_of(changed_at).unwrap_or(0);
            let verified = text(p, "bankDetailsVerifiedAt")
                .and_then(millis_of)
                .is_some_and(|v| v >= changed_ms);
            !verified && changed_at > approved_at.as_str()
        })
        .collect();
    if !changed.is_empty() {
        return Err(run_error(
            "BANK_DETAILS_CHANGED",
            format!(
                "Bank details changed after this run was approved and haven't been verified: {}. Verify the change on the vendor, or void the payment.",
                changed
                    .iter()
                    .map(|p| name_of(p))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            409,
            Some(json!({
                "vendors": changed.iter().map(|p| json!({
                    "partyId": p.get("id"),
                    "name": p.get("displayName"),
                    "changedAt": p.get("bankDetailsChangedAt"),
                })).collect::<Vec<_>>(),
            })),
        ));
    }

    let payment_ids: Vec<String> = payments.iter().map(|p| s(p, "id").to_owned()).collect();
    let allocations: Vec<(String, String, Option<String>)> = if payment_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "select pa.payment_id, pa.amount::text, b.bill_number from payment_allocations pa \
             inner join bills b on b.id = pa.bill_id where pa.payment_id = any($1) and pa.deleted_at is null",
        )
        .bind(&payment_ids)
        .fetch_all(db)
        .await?
    };

    let reveal = async |party: &Value| -> Result<String, RunError> {
        match reveal_party_secret(
            db,
            keyring,
            party,
            SecretField::AchAccountNumber,
            user_id,
            Some("nacha_file"),
            Some(entity_id),
        )
        .await
        {
            Ok(number) => Ok(number),
            Err(VendorTaxError::SecretNotFound(_)) => Err(run_error(
                "NO_ACCOUNT_NUMBER",
                format!("{} has no ACH account number on file.", name_of(party)),
                409,
                Some(json!({ "partyId": party.get("id") })),
            )),
            Err(other) => Err(other.into()),
        }
    };
    let run_sec = text(&run, "secCode").map(str::to_owned);
    let sec_for = |party: &Value| -> String {
        run_sec.clone().unwrap_or_else(|| {
            if is_individual(party) {
                "PPD".to_owned()
            } else {
                ach.default_sec_code.clone()
            }
        })
    };

    let mut nacha_payments: Vec<NachaPayment> = Vec::new();
    let mut meta: Vec<(String, Meta)> = Vec::new();
    for payment in &payments {
        let contact = s(payment, "contactId");
        let Some(party) = party_of(contact) else {
            return Err(run_error(
                "NOT_FOUND",
                format!("Vendor {contact} not found"),
                404,
                None,
            ));
        };
        let Some(routing) = text(party, "achRoutingNumber").filter(|r| !r.is_empty()) else {
            return Err(run_error(
                "NO_BANK_DETAILS",
                format!("{} has no ACH routing number.", name_of(party)),
                409,
                Some(json!({ "partyId": party.get("id") })),
            ));
        };
        let sec_code = sec_for(party);
        let own: Vec<&(String, String, Option<String>)> = allocations
            .iter()
            .filter(|(id, _, _)| id == s(payment, "id"))
            .collect();
        let remittance = build_rmr_segments(
            &own.iter()
                .map(|(_, amount, number)| {
                    (
                        number
                            .clone()
                            .unwrap_or_else(|| s(payment, "id").to_owned()),
                        parse_float(amount),
                    )
                })
                .collect::<Vec<_>>(),
        );
        let name = name_of(party);
        // The vendor is paid what is left after backup withholding; the withheld part stays in the bank account.
        let net = payment_net_amount(payment);
        let withheld = parse_float(text(payment, "backupWithholdingAmount").unwrap_or("0"));
        let identification = if own.len() == 1 {
            own[0].2.clone().unwrap_or_default()
        } else {
            text(party, "partyCode").unwrap_or_default().to_owned()
        };
        nacha_payments.push(NachaPayment {
            id: s(payment, "id").to_owned(),
            sec_code: Some(sec_code.clone()),
            name: name.clone(),
            routing_number: routing.to_owned(),
            account_number: reveal(party).await?,
            savings: text(party, "achAccountType") == Some("savings"),
            amount: net,
            prenote: false,
            identification: Some(identification),
            payment_info: (sec_code == "CCD+" || sec_code == "CTX").then_some(remittance),
        });
        meta.push((
            s(payment, "id").to_owned(),
            Meta {
                party_id: s(party, "id").to_owned(),
                name,
                sec_code,
                last4: party.get("achAccountLast4").cloned().unwrap_or(Value::Null),
                amount: to_fixed(net, 2),
                gross: to_fixed(parse_float(s(payment, "amount")), 2),
                withheld: if withheld > 0.0 {
                    json!(to_fixed(withheld, 2))
                } else {
                    Value::Null
                },
            },
        ));
    }
    for hold in &prenote_holds {
        let Some(party) = party_of(&hold.party_id) else {
            continue;
        };
        let Some(routing) = text(party, "achRoutingNumber").filter(|r| !r.is_empty()) else {
            continue;
        };
        let name = name_of(party);
        let sec = sec_for(party);
        nacha_payments.push(NachaPayment {
            id: format!("prenote:{}", s(party, "id")),
            sec_code: Some(if sec == "CCD+" || sec == "CTX" {
                "CCD".to_owned()
            } else {
                sec.clone()
            }),
            name: name.clone(),
            routing_number: routing.to_owned(),
            account_number: reveal(party).await?,
            savings: text(party, "achAccountType") == Some("savings"),
            amount: 0.0,
            prenote: true,
            identification: None,
            payment_info: None,
        });
        meta.push((
            format!("prenote:{}", s(party, "id")),
            Meta {
                party_id: s(party, "id").to_owned(),
                name,
                sec_code: sec,
                last4: party.get("achAccountLast4").cloned().unwrap_or(Value::Null),
                amount: "0.00".to_owned(),
                gross: "0.00".to_owned(),
                withheld: Value::Null,
            },
        ));
    }

    let offset_account = match &offset_bank {
        Some(offset) => {
            let revealed =
                reveal_account_number(db, keyring, offset, user_id, Some("nacha_file")).await?;
            Some(NachaOffsetAccount {
                routing_number: s(offset, "routingNumber").to_owned(),
                account_number: revealed.account_number,
                savings: text(offset, "accountType") == Some("savings"),
                name: Some(effective.company_name.clone()),
                identification: None,
            })
        }
        None => None,
    };

    let time_zone = text(&entity, "timezone");
    let (file_date, file_time) = local_date_time(now, time_zone);
    let effective_entry_date =
        suggest_effective_entry_date(s(&run, "paymentDate"), &file_date, same_day);
    let generated: Vec<Option<String>> = sqlx::query_scalar(
        "select to_char(file_generated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from payment_runs \
         where bank_account_id = $1 and method = 'ach' and id <> $2 and deleted_at is null and file_generated_at is not null",
    )
    .bind(&bank_id)
    .bind(s(&run, "id"))
    .fetch_all(db)
    .await?;
    let same_day_count = generated
        .iter()
        .filter_map(|at| at.as_deref().and_then(millis_of))
        .filter(|at| local_date_time(*at, time_zone).0 == file_date)
        .count();
    let file_id_modifier = file_id_modifier_for(same_day_count);
    let immediate_destination = effective.immediate_destination.clone().unwrap_or_default();
    let immediate_origin = effective.immediate_origin.clone().unwrap_or_default();
    let company_identification = effective.company_identification.clone().unwrap_or_default();

    let built = build_nacha_file(&NachaFileInput {
        originator: NachaOriginator {
            immediate_destination: immediate_destination.clone(),
            immediate_destination_name: effective.immediate_destination_name.clone(),
            immediate_origin: immediate_origin.clone(),
            immediate_origin_name: effective.immediate_origin_name.clone(),
            company_name: effective.company_name.clone(),
            company_identification: company_identification.clone(),
            odfi_routing_number: effective
                .odfi_routing_number
                .clone()
                .filter(|r| !r.is_empty()),
            offset_account,
            ..NachaOriginator::default()
        },
        payments: nacha_payments,
        effective_entry_date: effective_entry_date.clone(),
        file_date: file_date.clone(),
        file_time: Some(file_time),
        file_id_modifier: Some(file_id_modifier.clone()),
        default_sec_code: Some(
            run_sec
                .clone()
                .unwrap_or_else(|| ach.default_sec_code.clone()),
        ),
        entry_description: Some(
            ach.entry_description
                .clone()
                .unwrap_or_else(|| "VENDOR PAY".to_owned()),
        ),
        balanced: ach.balanced,
        same_day,
        ..NachaFileInput::default()
    });
    let built = match built {
        Ok(built) => built,
        Err(NachaBuildError::Refused(refused)) => {
            return Err(run_error(
                "NACHA_INVALID",
                "The NACHA file can't be made: fix the issues listed and try again.".to_owned(),
                422,
                Some(json!({
                    "errors": issues_json(&refused.errors),
                    "warnings": issues_json(&refused.warnings),
                })),
            ));
        }
        Err(NachaBuildError::Broken(message)) => return Err(RunError::Internal(message)),
    };
    let verification = verify_nacha_file(&built.content);
    if !verification.ok {
        return Err(run_error(
            "NACHA_INVALID",
            "The NACHA file failed its own check and was not released.".to_owned(),
            422,
            Some(json!({
                "errors": issues_json(&verification.issues),
                "warnings": issues_json(&built.warnings),
            })),
        ));
    }

    let file_name = format!("ach-{}-{}.ach", s(&run, "paymentDate"), s(&run, "id"));
    let at = weldsuite_books_domain::js::iso_from_millis(now)
        .unwrap_or_else(weldsuite_books_domain::http::now);
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update payment_runs t set status = 'exported', file_name = $2, file_generated_at = $3::timestamp, \
         updated_at = $3::timestamp where t.id = $1 returning ",
        weldsuite_books_domain::books_row!(payment_runs)
    ))
    .bind(s(&run, "id"))
    .bind(&file_name)
    .bind(&at)
    .fetch_optional(db)
    .await?;
    let updated = row.map_or_else(|| run.clone(), |row| PAYMENT_RUNS.js(row));

    let trace_of = |id: &str| {
        built
            .traces
            .iter()
            .find(|t| t.payment_id.as_deref() == Some(id))
            .map(|t| t.trace_number.clone())
    };
    let summary = json!({
        "runId": s(&run, "id"),
        "fileName": file_name,
        "fileDate": file_date,
        "effectiveEntryDate": effective_entry_date,
        "fileIdModifier": file_id_modifier,
        "sameDay": same_day,
        "balanced": ach.balanced,
        "paymentCount": payments.len(),
        "prenoteCount": prenote_holds.len(),
        "batchCount": built.batch_count,
        "recordCount": built.record_count,
        "blockCount": built.block_count,
        "entryHash": built.entry_hash,
        "totalCredit": cents(built.total_credit_cents),
        "totalDebit": cents(built.total_debit_cents),
        "originator": {
            "immediateDestination": immediate_destination,
            "immediateDestinationName": effective.immediate_destination_name,
            "immediateOrigin": immediate_origin,
            "immediateOriginName": effective.immediate_origin_name,
            "companyName": effective.company_name,
            "companyIdentification": company_identification,
            "odfiRoutingNumber": effective.odfi_routing_number.clone().unwrap_or_else(|| immediate_destination.clone()),
        },
        "payments": meta.iter().filter(|(id, _)| !id.starts_with("prenote:")).map(|(id, m)| json!({
            "paymentId": id,
            "partyId": m.party_id,
            "name": m.name,
            "amount": m.amount,
            "grossAmount": m.gross,
            "backupWithholdingAmount": m.withheld,
            "secCode": m.sec_code,
            "accountLast4": m.last4,
            "traceNumber": trace_of(id),
        })).collect::<Vec<_>>(),
        "prenotes": meta.iter().filter(|(id, _)| id.starts_with("prenote:")).map(|(id, m)| json!({
            "partyId": m.party_id,
            "name": m.name,
            "traceNumber": trace_of(id),
        })).collect::<Vec<_>>(),
        "warnings": built.warnings.iter().map(|w| {
            let mut out = serde_json::Map::new();
            out.insert("code".to_owned(), json!(w.code));
            out.insert("message".to_owned(), json!(w.message));
            if let Some(id) = w.payment_id.as_deref().filter(|id| !id.is_empty()) {
                out.insert("paymentId".to_owned(), json!(id));
            }
            Value::Object(out)
        }).collect::<Vec<_>>(),
    });
    Ok(NachaFile {
        file_name,
        content: built.content,
        summary,
        run: updated,
    })
}

/// `completeAchRun(db, entityId, runId)`: the bank accepted the file.
pub(crate) async fn complete_ach_run(
    db: &PgPool,
    entity_id: &str,
    run_id: &str,
) -> Result<Value, RunError> {
    let run = load_run(db, entity_id, run_id).await?;
    if s(&run, "method") != "ach" {
        return Err(run_error(
            "NOT_AN_ACH_RUN",
            "Only an ACH run is completed this way: print and mark its checks instead.".to_owned(),
            409,
            None,
        ));
    }
    if s(&run, "status") != "exported" {
        return Err(run_error(
            "INVALID_STATE",
            "Make and send the NACHA file first: a run is completed once the bank has accepted it."
                .to_owned(),
            409,
            Some(json!({ "status": s(&run, "status") })),
        ));
    }
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update payment_runs t set status = 'completed', updated_at = $2::timestamp \
         where t.id = $1 and t.status = 'exported' returning ",
        weldsuite_books_domain::books_row!(payment_runs)
    ))
    .bind(s(&run, "id"))
    .bind(weldsuite_books_domain::http::now())
    .fetch_optional(db)
    .await?;
    row.map(|row| PAYMENT_RUNS.js(row)).ok_or_else(|| {
        run_error(
            "INVALID_STATE",
            "The run changed while you were completing it. Reload it and try again.".to_owned(),
            409,
            None,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_times() {
        // 2026-11-02T03:30:00Z is 22:30 the day before in New York.
        let millis = 1_793_590_200_000;
        assert_eq!(
            local_date_time(millis, None),
            ("2026-11-01".to_owned(), "2230".to_owned())
        );
        assert_eq!(
            local_date_time(millis, Some("Europe/Amsterdam")),
            ("2026-11-02".to_owned(), "0430".to_owned())
        );
        assert_eq!(local_date_time(millis, Some("Not/AZone")).1, "2230");
        assert_eq!(file_id_modifier_for(0), "A");
        assert_eq!(file_id_modifier_for(99), "9");
    }
}
