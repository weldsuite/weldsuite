//! What leaves a filing (`services/form-1099/{outputs,payer}.ts`): the IRIS
//! upload files (full TINs, one reveal row per recipient), the layout data
//! of the copies (the recipient TIN truncated), the IRS TIN Matching files
//! and the answer they bring back.

use std::collections::HashMap;

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::form_1099::pdf::{self, form_1099_pdf_copies};
use weldsuite_books_domain::form_1099::{iris, tin_matching};
use weldsuite_books_domain::jurisdictions::us::mask_tin;
use weldsuite_books_domain::tables::{PARTIES, TAX_ID_REVEALS};
use weldsuite_books_domain::vendor_tax::{is_tin_type, read_sensitive};
use weldsuite_db::{Keyring, decrypt_field};
use weldsuite_kit::generate_id;

use super::Fail;
use super::data::{TIN_MATCH_PROBLEMS, load_entity, opt, text, w9_text};
use super::filings::{lines_for_file, load_filing, load_lines};

fn trim(value: Option<&str>) -> Option<String> {
    value
        .map(|v| weldsuite_kit::validation::js_trim(v).to_owned())
        .filter(|v| !v.is_empty())
}

async fn reveal(
    db: &PgPool,
    entity_id: Option<&str>,
    subject_type: &str,
    subject_id: &str,
    field: &str,
    user_id: &str,
    reason: &str,
) -> Result<(), sqlx::Error> {
    let row: serde_json::Map<String, Value> = [
        ("id", json!(generate_id("tir"))),
        ("entityId", json!(entity_id)),
        ("subjectType", json!(subject_type)),
        ("subjectId", json!(subject_id)),
        ("field", json!(field)),
        ("revealedBy", json!(user_id)),
        ("reason", json!(reason)),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    TAX_ID_REVEALS
        .insert_raw(db, TAX_ID_REVEALS.values(&row))
        .await?;
    Ok(())
}

/// `Payer` (`loadPayer`).
pub(crate) struct Payer {
    name: String,
    name_line2: Option<String>,
    tin_type: &'static str,
    tin: Option<String>,
    tin_masked: Option<String>,
    address: Option<iris::Address>,
    phone: Option<String>,
    email: Option<String>,
    pub(crate) issues: Vec<String>,
}

/// `loadPayer(db, entity, { env, revealSsn, userId, reason })`.
async fn load_payer(
    db: &PgPool,
    entity: &Value,
    keyring: &Keyring,
    reveal_ssn: bool,
    user_id: &str,
    reason: &str,
) -> Result<Payer, Fail> {
    let mut issues = Vec::new();
    let ein = trim(entity["taxIdentifiers"]["einOrSsn"].as_str());
    let mut tin_type = "ein";
    let mut tin = None;
    let mut masked = None;
    let digits = |v: &str| v.chars().filter(char::is_ascii_digit).collect::<String>();
    if let Some(ein) = ein {
        let d = digits(&ein);
        masked = Some(mask_tin(&d, Some("ein")));
        tin = Some(d);
    } else if let Some(sealed) = opt(entity, "ssnEncrypted").filter(|s| !s.is_empty()) {
        tin_type = "ssn";
        masked = opt(entity, "ssnLast4")
            .filter(|s| !s.is_empty())
            .map(|l| mask_tin(l, Some("ssn")));
        if reveal_ssn {
            if keyring.v1.is_none() && keyring.v2.is_none() {
                issues.push(
                    "The payer SSN cannot be read: the worker has no encryption key.".to_owned(),
                );
            } else {
                let plain = decrypt_field(sealed, keyring)
                    .map_err(|error| Fail::Internal(format!("decrypt failed: {error:?}")))?;
                reveal(
                    db,
                    Some(text(entity, "id")),
                    "entity",
                    text(entity, "id"),
                    "ssn",
                    user_id,
                    reason,
                )
                .await?;
                tin = Some(digits(&plain));
            }
        }
    } else {
        issues
            .push("The accounting entity has no EIN or SSN; add it on the entity page.".to_owned());
    }
    let address = normalize_postal_address(entity.get("address"));
    let field = |key: &str| {
        address
            .as_ref()
            .and_then(|a| a.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    if [
        field("line1"),
        field("city"),
        field("state"),
        field("postalCode"),
    ]
    .iter()
    .any(|f| f.as_deref().is_none_or(str::is_empty))
    {
        issues.push(
            "The accounting entity needs a complete address (street, city, state, ZIP).".to_owned(),
        );
    }
    let legal = weldsuite_kit::validation::js_trim(
        opt(entity, "legalName").unwrap_or_else(|| text(entity, "name")),
    )
    .to_owned();
    let dba = trim(opt(entity, "dba"));
    Ok(Payer {
        name_line2: dba.filter(|d| d.to_lowercase() != legal.to_lowercase()),
        name: legal,
        tin_type,
        tin,
        tin_masked: masked,
        address: address.as_ref().map(|_| iris::Address {
            line1: field("line1").unwrap_or_default(),
            line2: field("line2"),
            city: field("city").unwrap_or_default(),
            state: field("state").unwrap_or_default(),
            zip: field("postalCode").unwrap_or_default(),
            country: field("country").filter(|c| c != "US"),
        }),
        phone: entity["contact"]["phone"].as_str().map(str::to_owned),
        email: entity["contact"]["email"].as_str().map(str::to_owned),
        issues,
    })
}

fn recipient_address(line: &Value) -> iris::Address {
    let a = &line["recipient"]["address"];
    let s = |key: &str| a[key].as_str().map(str::to_owned);
    iris::Address {
        line1: s("line1").unwrap_or_default(),
        line2: s("line2"),
        city: s("city").unwrap_or_default(),
        state: s("state").unwrap_or_default(),
        zip: s("postalCode").unwrap_or_default(),
        country: s("country").filter(|c| !c.is_empty() && c != "US"),
    }
}

fn amounts_of(line: &Value, form: &str) -> Vec<(String, f64)> {
    line["boxes"]
        .as_object()
        .map(|boxes| {
            boxes
                .iter()
                .filter(|(code, _)| code.starts_with(&format!("{form}_")))
                .map(|(code, v)| (code.clone(), v.as_f64().unwrap_or(0.0)))
                .collect()
        })
        .unwrap_or_default()
}

fn states_of(line: &Value) -> Vec<iris::StateEntry> {
    let Some(code) = opt(line, "stateCode").filter(|c| !c.is_empty()) else {
        return Vec::new();
    };
    let amount =
        |key: &str| (!line[key].is_null()).then(|| weldsuite_books_domain::js::numeric(&line[key]));
    vec![iris::StateEntry {
        code: code.to_owned(),
        payer_state_number: opt(line, "stateIdNumber").map(str::to_owned),
        withheld: amount("stateWithheld"),
        income: amount("stateIncome"),
    }]
}

/// `parseTemplateHeaders(raw)`.
pub(crate) fn parse_template_headers(raw: Option<&Value>) -> Option<Vec<String>> {
    let to_text = |v: &Value| match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => weldsuite_books_domain::js::number_text(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_owned(),
        other => other.to_string(),
    };
    match raw {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .map(|h| weldsuite_kit::validation::js_trim(&to_text(h)).to_owned())
                .collect(),
        ),
        Some(other) => {
            let text = weldsuite_kit::validation::js_trim(&to_text(other)).to_owned();
            if text.starts_with('[')
                && let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&text)
            {
                return Some(
                    items
                        .iter()
                        .map(|h| weldsuite_kit::validation::js_trim(&to_text(h)).to_owned())
                        .collect(),
                );
            }
            let mut headers = Vec::new();
            let mut current = String::new();
            let mut quoted = false;
            let chars: Vec<char> = text.chars().collect();
            let mut i = 0;
            while i < chars.len() {
                let ch = chars[i];
                if quoted {
                    if ch == '"' && chars.get(i + 1) == Some(&'"') {
                        current.push('"');
                        i += 1;
                    } else if ch == '"' {
                        quoted = false;
                    } else {
                        current.push(ch);
                    }
                } else if ch == '"' {
                    quoted = true;
                } else if ch == ',' {
                    headers.push(weldsuite_kit::validation::js_trim(&current).to_owned());
                    current.clear();
                } else {
                    current.push(ch);
                }
                i += 1;
            }
            headers.push(weldsuite_kit::validation::js_trim(&current).to_owned());
            Some(headers)
        }
    }
}

/// `buildIrisFiles(db, env, { entityId, filingId, userId, templateHeaders })`.
#[allow(clippy::too_many_lines)] // the checks, the recipients, the reveal rows, the files
pub(crate) async fn build_iris_files(
    db: &PgPool,
    keyring: &Keyring,
    entity_id: &str,
    filing_id: &str,
    user_id: &str,
    template_headers: Option<Vec<String>>,
) -> Result<Value, Fail> {
    let filing = load_filing(db, entity_id, filing_id).await?;
    let status = text(&filing, "status");
    if !matches!(status, "generated" | "filed" | "corrected") {
        return Err(Fail::conflict(format!(
            "Generate the filing before creating the IRIS file; this one is {status}."
        )));
    }
    let form = text(&filing, "formType").to_owned();
    let lines = lines_for_file(&filing, &load_lines(db, filing_id).await?);
    if lines.is_empty() {
        return Err(Fail::conflict(
            "There are no recipients to put in the file.",
        ));
    }
    let entity = load_entity(db, entity_id).await?;
    let payer = load_payer(db, &entity, keyring, true, user_id, "iris_file").await?;
    let (Some(payer_tin), Some(payer_address)) = (payer.tin.clone(), payer.address.clone()) else {
        return Err(Fail::Conflict(
            "The payer details are incomplete".into(),
            Some(json!({ "issues": payer.issues })),
        ));
    };
    if !payer.issues.is_empty() {
        return Err(Fail::Conflict(
            "The payer details are incomplete".into(),
            Some(json!({ "issues": payer.issues })),
        ));
    }
    let key = weldsuite_books_domain::vendor_tax::require_keyring(keyring)
        .map_err(|e| Fail::Unavailable(e.to_string()))?;
    let mut recipients = Vec::new();
    for line in &lines {
        let Some(sealed) = opt(line, "recipientTinEncrypted").filter(|t| !t.is_empty()) else {
            let name = line["recipient"]["name"]
                .as_str()
                .map_or_else(|| text(line, "partyId").to_owned(), str::to_owned);
            return Err(Fail::Conflict(
                format!("{name} has no TIN on this filing"),
                Some(json!({ "lineId": line["id"] })),
            ));
        };
        let tin = decrypt_field(sealed, key)
            .map_err(|error| Fail::Internal(format!("decrypt failed: {error:?}")))?;
        let recipient = &line["recipient"];
        let tin_type = recipient["tinType"]
            .as_str()
            .filter(|t| is_tin_type(Some(t)))
            .unwrap_or("ein");
        recipients.push(iris::Recipient {
            id: Some(
                recipient["name"]
                    .as_str()
                    .map_or_else(|| text(line, "id").to_owned(), str::to_owned),
            ),
            legal_name: recipient["name"].as_str().unwrap_or_default().to_owned(),
            business_name: recipient["businessName"].as_str().map(str::to_owned),
            tin_type: tin_type.to_owned(),
            tin,
            address: recipient_address(line),
            account_number: recipient["accountNumber"].as_str().map(str::to_owned),
            corrected: line["isCorrected"] == json!(true),
            boxes: amounts_of(line, &form),
            states: states_of(line),
        });
    }
    for line in &lines {
        reveal(
            db,
            Some(entity_id),
            "form_1099_line",
            text(line, "id"),
            "tin",
            user_id,
            "iris_file",
        )
        .await?;
    }
    let tax_year = filing["taxYear"].as_i64().unwrap_or(0);
    let files = iris::generate_iris_csv(
        tax_year,
        &form,
        &iris::Payer {
            name: payer.name,
            name_line2: payer.name_line2,
            tin_type: payer.tin_type.to_owned(),
            tin: payer_tin,
            address: payer_address,
            phone: payer.phone,
            email: payer.email,
        },
        &recipients,
        template_headers.as_deref(),
    );
    Ok(json!({
        "files": files.iter().map(|f| json!({
            "filename": f.filename,
            "content": f.content,
            "recordCount": f.record_count,
            "warnings": f.warnings,
        })).collect::<Vec<_>>(),
        "taxYear": tax_year,
        "formType": form,
        "correctionsOnly": status == "corrected",
    }))
}

/// `parseCopies(raw)`.
pub(crate) fn parse_copies(raw: Option<&str>) -> Result<Option<Vec<String>>, Fail> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    let copies: Vec<String> = raw
        .split(',')
        .map(|c| weldsuite_kit::validation::js_trim(c).to_uppercase())
        .filter(|c| !c.is_empty())
        .collect();
    if let Some(bad) = copies.iter().find(|c| !pdf::COPIES.contains(&c.as_str())) {
        return Err(Fail::bad(format!(
            "Unknown copy {bad}; use {}",
            pdf::COPIES.join(", ")
        )));
    }
    Ok(Some(copies))
}

/// `buildCopies(db, env, c, { entityId, filingId, lineId, copies, userId })`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn build_copies(
    db: &PgPool,
    keyring: &Keyring,
    may_reveal: bool,
    entity_id: &str,
    filing_id: &str,
    line_id: &str,
    copies: Option<Vec<String>>,
    user_id: &str,
) -> Result<Value, Fail> {
    let filing = load_filing(db, entity_id, filing_id).await?;
    let lines = load_lines(db, filing_id).await?;
    let Some(line) = lines.iter().find(|l| text(l, "id") == line_id) else {
        return Err(Fail::not_found(format!("Filing line {line_id} not found")));
    };
    let recipient = &line["recipient"];
    let last4 = recipient["tinLast4"].as_str().filter(|l| !l.is_empty());
    let tin_type = recipient["tinType"]
        .as_str()
        .filter(|t| is_tin_type(Some(t)));
    let (Some(last4), Some(tin_type)) = (last4, tin_type) else {
        return Err(Fail::conflict(
            "This recipient has no TIN on the filing yet",
        ));
    };
    let form = text(&filing, "formType").to_owned();
    let entity = load_entity(db, entity_id).await?;
    let payer = load_payer(db, &entity, keyring, may_reveal, user_id, "form_1099_copy").await?;
    let mut warnings = payer.issues.clone();
    #[allow(clippy::single_match_else)] // the masked TIN, with a warning for an SSN
    let payer_tin = match &payer.tin {
        Some(tin) => tin.clone(),
        None => {
            if payer.tin_type == "ssn" {
                warnings.push("The payer TIN is an SSN and is printed truncated: revealing it needs the tax_ids:reveal permission.".to_owned());
            }
            payer.tin_masked.clone().unwrap_or_default()
        }
    };
    let Some(payer_address) = payer.address.clone() else {
        return Err(Fail::conflict(
            "The accounting entity needs an address before forms can be printed",
        ));
    };
    let to_pdf = |a: iris::Address| pdf::Address {
        line1: a.line1,
        line2: a.line2,
        city: a.city,
        state: a.state,
        zip: a.zip,
        country: a.country,
    };
    let input = pdf::Input {
        form: form.clone(),
        tax_year: filing["taxYear"].as_i64().unwrap_or(0),
        payer_name: payer.name.clone(),
        payer_name_line2: payer.name_line2.clone(),
        payer_address: to_pdf(payer_address),
        payer_phone: payer.phone.clone(),
        payer_tin_type: payer.tin_type.to_owned(),
        payer_tin,
        recipient_name: recipient["name"].as_str().unwrap_or_default().to_owned(),
        recipient_business_name: recipient["businessName"].as_str().map(str::to_owned),
        recipient_address: to_pdf(recipient_address(line)),
        recipient_tin_type: tin_type.to_owned(),
        recipient_tin_last4: last4.to_owned(),
        recipient_account_number: recipient["accountNumber"].as_str().map(str::to_owned),
        boxes: amounts_of(line, &form),
        corrected: line["isCorrected"] == json!(true),
        states: states_of(line),
        copies,
    };
    Ok(json!({
        "taxYear": filing["taxYear"],
        "formType": form,
        "lineId": line["id"],
        "recipientTin": mask_tin(last4, Some(tin_type)),
        "copies": form_1099_pdf_copies(&input),
        "warnings": warnings,
    }))
}

/// `buildTinMatching(db, env, { entityId, userId, all, partyIds })`.
pub(crate) async fn build_tin_matching(
    db: &PgPool,
    keyring: &Keyring,
    entity_id: Option<&str>,
    user_id: &str,
    all: bool,
    party_ids: Option<Vec<String>>,
) -> Result<Value, Fail> {
    let key = weldsuite_books_domain::vendor_tax::require_keyring(keyring)
        .map_err(|e| Fail::Unavailable(e.to_string()))?;
    let only = party_ids.filter(|ids| !ids.is_empty());
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(parties),
        " from parties t where t.is_1099_vendor = true and t.deleted_at is null \
         and ($1::text[] is null or t.id = any($1))"
    ))
    .bind(&only)
    .fetch_all(db)
    .await?;
    let parties = PARTIES.js_rows(rows);
    let mut records = Vec::new();
    let mut tin_parties = Vec::new();
    for party in &parties {
        let candidate = opt(party, "tinLast4").is_some_and(|t| !t.is_empty())
            && opt(party, "sensitiveEncrypted").is_some_and(|t| !t.is_empty())
            && (all || only.is_some() || opt(party, "tinMatchStatus") != Some("match"));
        if !candidate {
            continue;
        }
        let tin = read_sensitive(party, key)
            .map_err(|e| Fail::Internal(e.to_string()))?
            .tin
            .filter(|t| !t.is_empty());
        let Some(tin) = tin else {
            continue;
        };
        let name = trim(w9_text(party, "legalName"))
            .or_else(|| {
                opt(party, "displayName")
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        let tin_type = opt(party, "tinType")
            .filter(|t| is_tin_type(Some(t)))
            .unwrap_or("unknown");
        records.push(tin_matching::Record {
            party_id: text(party, "id").to_owned(),
            tin_type: tin_type.to_owned(),
            tin,
            name,
        });
        tin_parties.push(text(party, "id").to_owned());
    }
    let built = tin_matching::build_files(&records);
    let included: Vec<&String> = tin_parties
        .iter()
        .filter(|id| !built.skipped.iter().any(|(s, _)| s == *id))
        .collect();
    for id in &included {
        reveal(db, entity_id, "party", id, "tin", user_id, "tin_matching").await?;
    }
    let names: HashMap<&str, &str> = parties
        .iter()
        .map(|p| (text(p, "id"), opt(p, "displayName").unwrap_or_default()))
        .collect();
    Ok(json!({
        "files": built.files.iter().map(|f| json!({
            "filename": f.filename,
            "content": f.content,
            "recordCount": f.record_count,
        })).collect::<Vec<_>>(),
        "recordCount": included.len(),
        "skipped": built.skipped.iter().map(|(id, reason)| json!({
            "partyId": id,
            "reason": reason,
            "name": names.get(id.as_str()).copied(),
        })).collect::<Vec<_>>(),
    }))
}

/// A party as TIN matching reads it: id, name, TIN last four, backup withholding.
type PartyMatch = (String, Option<String>, Option<String>, Option<bool>);

/// `applyTinMatchingResults(db, text)`: the parties updated, and the
/// problems. The parties whose status changed, in answer order.
#[allow(clippy::too_many_lines)] // the answer, the updates, the report
pub(crate) async fn apply_tin_matching_results(
    db: &PgPool,
    body: &str,
) -> Result<(Vec<String>, Value), Fail> {
    let parties: Vec<PartyMatch> = sqlx::query_as(
        "select id, display_name, tin_last4, backup_withholding from parties where deleted_at is null",
    )
    .fetch_all(db)
    .await?;
    let accounts: HashMap<String, String> = parties
        .iter()
        .filter(|(_, _, last4, _)| last4.as_deref().is_some_and(|l| !l.is_empty()))
        .map(|(id, ..)| (tin_matching::account_number(id), id.clone()))
        .collect();
    let by_id: HashMap<&str, &PartyMatch> = parties.iter().map(|p| (p.0.as_str(), p)).collect();
    let (results, unreadable) = tin_matching::parse_results(body, |a| accounts.get(a).cloned());

    let mut latest: Vec<(String, &'static str)> = Vec::new();
    let (mut unknown, mut stale, mut ignored) = (Vec::new(), Vec::new(), Vec::new());
    for result in &results {
        let Some(party) = result.party_id.as_deref().and_then(|id| by_id.get(id)) else {
            unknown.push(json!({ "line": result.line, "accountNumber": result.account_number }));
            continue;
        };
        if result.status == "duplicate" {
            ignored.push(json!({
                "line": result.line,
                "code": result.code,
                "reason": "The IRS reports a duplicate request; no result for this record.",
            }));
            continue;
        }
        if let (Some(answer), Some(own)) = (
            result.tin_last4.as_deref(),
            party.2.as_deref().filter(|l| !l.is_empty()),
        ) && answer != own
        {
            stale.push(json!({ "partyId": party.0, "name": party.1 }));
            continue;
        }
        if let Some(entry) = latest.iter_mut().find(|(id, _)| *id == party.0) {
            entry.1 = result.status;
        } else {
            latest.push((party.0.clone(), result.status));
        }
    }
    if !latest.is_empty() {
        let at = weldsuite_books_domain::http::now();
        let updates = latest.clone();
        weldsuite_db::atomically_with::<_, (), sqlx::Error, _>(db, move |conn| {
            Box::pin(async move {
                for (id, status) in &updates {
                    sqlx::query(
                        "update parties set tin_match_status = $1, tin_matched_at = $2::timestamp, \
                         updated_at = $2::timestamp where id = $3",
                    )
                    .bind(status)
                    .bind(&at)
                    .bind(id)
                    .execute(&mut *conn)
                    .await?;
                }
                Ok(())
            })
        })
        .await?;
    }
    let mut by_status = serde_json::Map::new();
    for (_, status) in &latest {
        let count = by_status.get(*status).and_then(Value::as_i64).unwrap_or(0);
        by_status.insert((*status).to_owned(), json!(count + 1));
    }
    let problems: Vec<Value> = latest
        .iter()
        .filter(|(_, status)| TIN_MATCH_PROBLEMS.contains(status))
        .map(|(id, status)| {
            let party = by_id.get(id.as_str());
            let backup = party.and_then(|p| p.3).unwrap_or(false);
            json!({
                "partyId": id,
                "name": party.and_then(|p| p.1.clone()),
                "status": status,
                "backupWithholding": backup,
                "suggestion": if backup {
                    "Backup withholding is already on."
                } else {
                    "Send a first B notice and ask for a new W-9; turn on backup withholding if none arrives within 30 business days."
                },
            })
        })
        .collect();
    let updated: Vec<String> = latest.iter().map(|(id, _)| id.clone()).collect();
    Ok((
        updated.clone(),
        json!({
            "updated": updated,
            "byStatus": by_status,
            "problems": problems,
            "stale": stale,
            "unknownAccounts": unknown,
            "ignored": ignored,
            "unreadable": unreadable.iter().map(|(line, text)| json!({ "line": line, "text": text })).collect::<Vec<_>>(),
        }),
    ))
}
