//! 1099 filings (`services/form-1099/filings.ts`): one filing per form type
//! and tax year of an entity, one line per recipient. `draft` lines follow
//! the computation (manual adjustments, exclusions and state fields survive
//! a refresh), `reviewed`, `generated` (recipients snapshotted, TINs sealed
//! in), `filed`, and `corrected` (a new line waits to be filed).

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::form_1099::compute::{Adjustment, VendorResult};
use weldsuite_books_domain::form_1099::{
    form_1099_box, form_1099_state_rule, form_of_box, state_needs_direct_filing,
    withholding_box_for,
};
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::js::{math_round, number_value, to_fixed};
use weldsuite_books_domain::tables::{FORM_1099_FILING_LINES, FORM_1099_FILINGS, PARTIES};
use weldsuite_books_domain::vendor_tax::read_sensitive;
use weldsuite_db::Keyring;
use weldsuite_kit::generate_id;

use super::Fail;
use super::data::{compute_for_entity, opt, text, w9_text};

/// `AUTO_EXCLUDED_PREFIX`.
pub(crate) const AUTO_EXCLUDED_PREFIX: &str = "Not reportable: ";
const EDITABLE: [&str; 2] = ["draft", "reviewed"];

fn cents(value: f64) -> f64 {
    math_round(value * 100.0) / 100.0
}

fn num(value: &Value) -> f64 {
    weldsuite_books_domain::js::numeric(value)
}

/// `isManualExclusion(line)`.
fn is_manual_exclusion(line: &Value) -> bool {
    text(line, "status") == "excluded"
        && opt(line, "excludedReason")
            .is_some_and(|r| !r.is_empty() && !r.starts_with(AUTO_EXCLUDED_PREFIX))
}

fn superseded_of(lines: &[Value]) -> HashSet<String> {
    lines
        .iter()
        .filter_map(|l| {
            opt(l, "correctionOfLineId")
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
        .collect()
}

fn line_view(line: &Value, names: &HashMap<String, String>, superseded: &HashSet<String>) -> Value {
    let mut view = line.clone();
    if let Value::Object(map) = &mut view {
        map.remove("recipientTinEncrypted");
    }
    let state = line["recipient"]["address"]["state"]
        .as_str()
        .filter(|s| !s.is_empty());
    let rule = state.and_then(form_1099_state_rule);
    view["hasTin"] = json!(opt(line, "recipientTinEncrypted").is_some_and(|t| !t.is_empty()));
    view["partyName"] = names
        .get(text(line, "partyId"))
        .map(|n| json!(n))
        .or_else(|| line["recipient"].get("name").cloned())
        .unwrap_or(Value::Null);
    view["superseded"] = json!(superseded.contains(text(line, "id")));
    view["pendingCorrection"] =
        json!(line["isCorrected"] == json!(true) && text(line, "status") == "included");
    view["stateHint"] = match (state, rule) {
        (Some(state), Some(rule)) => json!({
            "state": state.to_uppercase(),
            "cfsfCode": rule.cfsf_code,
            "direct": rule.direct,
            "verified": rule.verified,
            "note": rule.note,
            "needsDirectFiling": state_needs_direct_filing(state, num(&line["stateWithheld"]) > 0.0, true),
        }),
        _ => Value::Null,
    };
    view
}

fn filing_totals(filing: &Value, lines: &[Value]) -> Value {
    let superseded = superseded_of(lines);
    let mut status_counts = Map::new();
    let (mut amount, mut withheld) = (0.0, 0.0);
    let withholding = withholding_box_for(text(filing, "formType"));
    for line in lines {
        let status = text(line, "status");
        let count = status_counts
            .get(status)
            .and_then(Value::as_i64)
            .unwrap_or(0);
        status_counts.insert(status.to_owned(), json!(count + 1));
        if superseded.contains(text(line, "id"))
            || !matches!(status, "included" | "filed" | "needs_tin" | "needs_address")
        {
            continue;
        }
        if let Some(boxes) = line["boxes"].as_object() {
            for (code, value) in boxes {
                if form_1099_box(code).is_none_or(|d| d.kind != "amount") {
                    continue;
                }
                if code == withholding {
                    withheld += num(value);
                } else {
                    amount += num(value);
                }
            }
        }
    }
    let mut view = filing.clone();
    view["lineCount"] = json!(lines.len());
    view["totals"] =
        json!({ "amount": number_value(cents(amount)), "withheld": number_value(cents(withheld)) });
    view["statusCounts"] = Value::Object(status_counts);
    view
}

async fn party_names(db: &PgPool, ids: &[String]) -> Result<HashMap<String, String>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("select id, display_name from parties where id = any($1)")
            .bind(ids)
            .fetch_all(db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(id, n)| (id, n.unwrap_or_default()))
        .collect())
}

/// `loadFiling(db, entityId, filingId)`.
pub(crate) async fn load_filing(
    db: &PgPool,
    entity_id: &str,
    filing_id: &str,
) -> Result<Value, Fail> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(form_1099_filings),
        " from form_1099_filings t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(filing_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|r| FORM_1099_FILINGS.js(r))
        .ok_or_else(|| Fail::not_found(format!("1099 filing {filing_id} not found")))
}

/// `loadLines(db, filingId)`, by creation.
pub(crate) async fn load_lines(db: &PgPool, filing_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(form_1099_filing_lines),
        " from form_1099_filing_lines t where t.filing_id = $1 order by t.created_at, t.id"
    ))
    .bind(filing_id)
    .fetch_all(db)
    .await?;
    Ok(FORM_1099_FILING_LINES.js_rows(rows))
}

fn find_line(lines: &[Value], line_id: &str) -> Result<Value, Fail> {
    lines
        .iter()
        .find(|l| text(l, "id") == line_id)
        .cloned()
        .ok_or_else(|| Fail::not_found(format!("Filing line {line_id} not found")))
}

/// `loadFilingDetail(db, entityId, filingId)`: `{ filing, lines }`.
pub(crate) async fn load_filing_detail(
    db: &PgPool,
    entity_id: &str,
    filing_id: &str,
) -> Result<Value, Fail> {
    let filing = load_filing(db, entity_id, filing_id).await?;
    let lines = load_lines(db, text(&filing, "id")).await?;
    let ids: Vec<String> = lines
        .iter()
        .map(|l| text(l, "partyId").to_owned())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let names = party_names(db, &ids).await?;
    let superseded = superseded_of(&lines);
    Ok(json!({
        "filing": filing_totals(&filing, &lines),
        "lines": lines.iter().map(|l| line_view(l, &names, &superseded)).collect::<Vec<_>>(),
    }))
}

/// `listFilings(db, entityId, filter)`.
pub(crate) async fn list_filings(
    db: &PgPool,
    entity_id: &str,
    tax_year: Option<i64>,
    form_type: Option<&str>,
    status: Option<&str>,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(form_1099_filings),
        " from form_1099_filings t where t.entity_id = $1 and t.deleted_at is null \
         and ($2::int is null or t.tax_year = $2) and ($3::text is null or t.form_type = $3) \
         and ($4::text is null or t.status = $4) order by t.tax_year, t.form_type"
    ))
    .bind(entity_id)
    .bind(tax_year.and_then(|y| i32::try_from(y).ok()))
    .bind(form_type)
    .bind(status)
    .fetch_all(db)
    .await?;
    let filings = FORM_1099_FILINGS.js_rows(rows);
    if filings.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = filings.iter().map(|f| text(f, "id").to_owned()).collect();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(form_1099_filing_lines),
        " from form_1099_filing_lines t where t.filing_id = any($1)"
    ))
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let lines = FORM_1099_FILING_LINES.js_rows(rows);
    Ok(filings
        .iter()
        .map(|filing| {
            let own: Vec<Value> = lines
                .iter()
                .filter(|l| l["filingId"] == filing["id"])
                .cloned()
                .collect();
            filing_totals(filing, &own)
        })
        .collect())
}

/// `snapshotRecipient(party)`: the W-9 name, address and the TIN's type and last four.
pub(crate) fn snapshot_recipient(party: &Value) -> Value {
    let trim = |v: Option<&str>| {
        v.map(|s| weldsuite_kit::validation::js_trim(s).to_owned())
            .filter(|s| !s.is_empty())
    };
    let name = trim(w9_text(party, "legalName"))
        .or_else(|| trim(opt(party, "displayName")))
        .unwrap_or_else(|| "Unnamed vendor".to_owned());
    let mut out = Map::new();
    out.insert("name".into(), json!(name));
    if let Some(business) = trim(w9_text(party, "businessName"))
        && business.to_lowercase() != name.to_lowercase()
    {
        out.insert("businessName".into(), json!(business));
    }
    if let Some(address) = normalize_postal_address(party.get("billingAddress")) {
        out.insert("address".into(), address);
    }
    if let Some(t) = opt(party, "tinType").filter(|t| !t.is_empty()) {
        out.insert("tinType".into(), json!(t));
    }
    if let Some(t) = opt(party, "tinLast4").filter(|t| !t.is_empty()) {
        out.insert("tinLast4".into(), json!(t));
    }
    Value::Object(out)
}

/// `boxesOfForm(vendor.boxes, form)` as `{ code: amount }`.
fn boxes_of_form(vendor: &VendorResult, form: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for (code, cents) in &vendor.boxes {
        if form_of_box(code) == form {
            #[allow(clippy::cast_precision_loss)]
            out.insert((*code).to_owned(), number_value(*cents as f64 / 100.0));
        }
    }
    out
}

/// `lineFields(vendor, form, party)`: boxes, federalWithheld, recipient, status.
fn line_fields(vendor: &VendorResult, form: &str, party: &Value) -> Map<String, Value> {
    let boxes = boxes_of_form(vendor, form);
    let withheld = boxes.get(withholding_box_for(form)).map_or(0.0, num);
    let mut out = Map::new();
    out.insert("boxes".into(), Value::Object(boxes));
    out.insert("federalWithheld".into(), json!(to_fixed(withheld, 2)));
    out.insert("recipient".into(), snapshot_recipient(party));
    out.insert("status".into(), json!(vendor.status));
    out
}

fn is_reportable(vendor: &VendorResult, form: &str) -> bool {
    matches!(vendor.status, "included" | "needs_tin" | "needs_address")
        && boxes_of_form(vendor, form).values().any(|v| num(v) > 0.0)
}

fn new_line(
    entity_id: &str,
    filing_id: &str,
    party_id: &str,
    fields: Map<String, Value>,
    at: &str,
) -> Map<String, Value> {
    let mut row = Map::new();
    row.insert("id".into(), json!(generate_id("f9l")));
    row.insert("entityId".into(), json!(entity_id));
    row.insert("filingId".into(), json!(filing_id));
    row.insert("partyId".into(), json!(party_id));
    row.extend(fields);
    row.insert("createdAt".into(), json!(at));
    row.insert("updatedAt".into(), json!(at));
    row
}

async fn insert_line(
    conn: &mut sqlx::PgConnection,
    line: &Map<String, Value>,
) -> Result<(), sqlx::Error> {
    FORM_1099_FILING_LINES
        .insert_raw(&mut *conn, FORM_1099_FILING_LINES.values(line))
        .await
        .map(|_| ())
}

async fn patch_line(
    conn: &mut sqlx::PgConnection,
    id: &str,
    set: &Map<String, Value>,
) -> Result<(), sqlx::Error> {
    FORM_1099_FILING_LINES
        .patch_raw(&mut *conn, id, FORM_1099_FILING_LINES.values(set), false)
        .await
        .map(|_| ())
}

async fn patch_filing(
    conn: &mut sqlx::PgConnection,
    id: &str,
    set: Map<String, Value>,
) -> Result<(), sqlx::Error> {
    FORM_1099_FILINGS
        .patch_raw(&mut *conn, id, FORM_1099_FILINGS.values(&set), false)
        .await
        .map(|_| ())
}

fn set(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect()
}

/// `createFiling(db, { entityId, taxYear, formType, userId })`: `(filingId, lineCount, warnings)`.
pub(crate) async fn create_filing(
    db: &PgPool,
    entity_id: &str,
    tax_year: i64,
    form: &str,
    user_id: &str,
) -> Result<(String, usize, Vec<String>), Fail> {
    let existing: Option<String> = sqlx::query_scalar(
        "select id from form_1099_filings where entity_id = $1 and tax_year = $2 and form_type = $3 \
         and deleted_at is null limit 1",
    )
    .bind(entity_id)
    .bind(i32::try_from(tax_year).unwrap_or(0))
    .bind(form)
    .fetch_optional(db)
    .await?;
    if let Some(id) = existing {
        return Err(Fail::Conflict(
            format!(
                "There is already a 1099-{} filing for {tax_year}. Open it, or delete it while it is a draft.",
                form.to_uppercase()
            ),
            Some(json!({ "filingId": id })),
        ));
    }
    let (loaded, result) = compute_for_entity(db, entity_id, tax_year, None, Vec::new()).await?;
    let at = now();
    let filing_id = generate_id("f99");
    let lines: Vec<Map<String, Value>> = result
        .vendors
        .iter()
        .filter_map(|vendor| {
            let party = loaded.party(&vendor.party_id)?;
            is_reportable(vendor, form).then(|| {
                new_line(
                    entity_id,
                    &filing_id,
                    &vendor.party_id,
                    line_fields(vendor, form, party),
                    &at,
                )
            })
        })
        .collect();
    let filing = set(&[
        ("id", json!(filing_id)),
        ("entityId", json!(entity_id)),
        ("taxYear", json!(tax_year)),
        ("formType", json!(form)),
        ("status", json!("draft")),
        ("createdBy", json!(user_id)),
        ("createdAt", json!(at)),
        ("updatedAt", json!(at)),
    ]);
    let count = lines.len();
    weldsuite_db::atomically_with::<_, (), sqlx::Error, _>(db, move |conn| {
        Box::pin(async move {
            FORM_1099_FILINGS
                .insert_raw(&mut *conn, FORM_1099_FILINGS.values(&filing))
                .await?;
            for line in &lines {
                insert_line(conn, line).await?;
            }
            Ok(())
        })
    })
    .await?;
    Ok((filing_id, count, result.warnings))
}

fn adjustments_of(lines: &[Value], form: &str) -> Vec<Adjustment> {
    lines
        .iter()
        .flat_map(|line| {
            line["adjustments"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|a| {
                    let code = a["box"].as_str().unwrap_or_default();
                    form_of_box(code) == form
                        && form_1099_box(code).is_some_and(|d| d.kind == "amount")
                })
                .map(|a| Adjustment {
                    party_id: text(line, "partyId").to_owned(),
                    box_code: a["box"].as_str().unwrap_or_default().to_owned(),
                    amount: num(&a["amount"]),
                    reason: a["reason"].as_str().unwrap_or_default().to_owned(),
                    by: a["by"].as_str().map(str::to_owned),
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// `recomputeLines(db, filing, lines, { onlyLineIds })`: each editable
/// line's new fields, and the new lines.
async fn recompute_lines(
    db: &PgPool,
    filing: &Value,
    existing: &[Value],
    only: Option<&[String]>,
) -> Result<
    (
        Vec<(String, Map<String, Value>)>,
        Vec<Map<String, Value>>,
        Vec<String>,
    ),
    Fail,
> {
    let form = text(filing, "formType");
    let editable: Vec<&Value> = existing
        .iter()
        .filter(|l| l["isCorrected"] != json!(true) && text(l, "status") != "filed")
        .collect();
    let targets: Vec<Value> = editable
        .into_iter()
        .filter(|l| only.is_none_or(|ids| ids.iter().any(|id| id == text(l, "id"))))
        .cloned()
        .collect();
    let party_ids: Option<Vec<String>> = only.map(|_| {
        targets
            .iter()
            .map(|l| text(l, "partyId").to_owned())
            .collect()
    });
    let tax_year = filing["taxYear"].as_i64().unwrap_or(0);
    let (loaded, result) = compute_for_entity(
        db,
        text(filing, "entityId"),
        tax_year,
        party_ids.as_deref(),
        adjustments_of(&targets, form),
    )
    .await?;
    let by_party = |id: &str| result.vendors.iter().find(|v| v.party_id == id);

    let mut updates = Vec::new();
    for line in &targets {
        let Some(party) = loaded.party(text(line, "partyId")) else {
            continue;
        };
        let manual = is_manual_exclusion(line);
        let vendor = by_party(text(line, "partyId"));
        let fields = match vendor.filter(|v| is_reportable(v, form)) {
            Some(vendor) => {
                let mut fields = line_fields(vendor, form, party);
                if manual {
                    fields.insert("status".into(), json!("excluded"));
                }
                fields.insert(
                    "excludedReason".into(),
                    if manual {
                        line["excludedReason"].clone()
                    } else {
                        Value::Null
                    },
                );
                fields
            }
            None => {
                let why = vendor
                    .and_then(|v| v.reasons.first().cloned())
                    .unwrap_or_else(|| "There are no payments to report in the year.".to_owned());
                let reason = if manual {
                    line["excludedReason"].clone()
                } else {
                    json!(weldsuite_books_domain::js::slice_utf16(
                        &format!("{AUTO_EXCLUDED_PREFIX}{why}"),
                        255
                    ))
                };
                set(&[
                    ("boxes", json!({})),
                    ("federalWithheld", json!("0.00")),
                    ("recipient", snapshot_recipient(party)),
                    ("status", json!("excluded")),
                    ("excludedReason", reason),
                ])
            }
        };
        updates.push((text(line, "id").to_owned(), fields));
    }

    let mut added = Vec::new();
    if only.is_none() {
        let have: HashSet<&str> = existing
            .iter()
            .filter(|l| l["isCorrected"] != json!(true))
            .map(|l| text(l, "partyId"))
            .collect();
        let at = now();
        for vendor in &result.vendors {
            let Some(party) = loaded.party(&vendor.party_id) else {
                continue;
            };
            if have.contains(vendor.party_id.as_str()) || !is_reportable(vendor, form) {
                continue;
            }
            added.push(new_line(
                text(filing, "entityId"),
                text(filing, "id"),
                &vendor.party_id,
                line_fields(vendor, form, party),
                &at,
            ));
        }
    }
    Ok((updates, added, result.warnings))
}

fn assert_editable(filing: &Value) -> Result<(), Fail> {
    let status = text(filing, "status");
    if !EDITABLE.contains(&status) {
        return Err(Fail::conflict(format!(
            "The filing is {status}. Only a draft or reviewed filing can be changed; after filing, correct a recipient instead."
        )));
    }
    Ok(())
}

/// `refreshFiling(db, entityId, filingId)`: `{ warnings, updated, added }`.
pub(crate) async fn refresh_filing(
    db: &PgPool,
    entity_id: &str,
    filing_id: &str,
) -> Result<Value, Fail> {
    let filing = load_filing(db, entity_id, filing_id).await?;
    assert_editable(&filing)?;
    let lines = load_lines(db, filing_id).await?;
    let (updates, added, warnings) = recompute_lines(db, &filing, &lines, None).await?;
    let at = now();
    let result = json!({ "warnings": warnings, "updated": updates.len(), "added": added.len() });
    let id = filing_id.to_owned();
    weldsuite_db::atomically_with::<_, (), sqlx::Error, _>(db, move |conn| {
        Box::pin(async move {
            for (line_id, mut fields) in updates {
                fields.insert("updatedAt".into(), json!(at));
                patch_line(conn, &line_id, &fields).await?;
            }
            for line in &added {
                insert_line(conn, line).await?;
            }
            patch_filing(
                conn,
                &id,
                set(&[("status", json!("draft")), ("updatedAt", json!(at))]),
            )
            .await
        })
    })
    .await?;
    Ok(result)
}

/// `LinePatch`: each field left out, `null`, or a value.
#[derive(Debug, Clone, Default)]
pub(crate) struct LinePatch {
    /// `(box, amount, reason)`.
    pub(crate) adjustments: Option<Vec<(String, f64, String)>>,
    pub(crate) status: Option<String>,
    pub(crate) excluded_reason: Option<Option<String>>,
    pub(crate) state_code: Option<Option<String>>,
    pub(crate) state_id_number: Option<Option<String>>,
    pub(crate) state_income: Option<Option<f64>>,
    pub(crate) state_withheld: Option<Option<f64>>,
    pub(crate) boxes: Option<Vec<(String, f64)>>,
}

fn validate_boxes(boxes: &[(String, f64)], form: &str) -> Result<(), Fail> {
    for (code, value) in boxes {
        if form_1099_box(code).is_none_or(|d| d.kind != "amount" || d.form != form) {
            return Err(Fail::bad(format!(
                "{code} is not an amount box of form 1099-{}",
                form.to_uppercase()
            )));
        }
        if !value.is_finite() || *value < 0.0 {
            return Err(Fail::bad(format!("Box {code} must be zero or more")));
        }
    }
    Ok(())
}

fn boxes_object(boxes: &[(String, f64)]) -> Value {
    Value::Object(
        boxes
            .iter()
            .map(|(k, v)| (k.clone(), number_value(*v)))
            .collect(),
    )
}

fn stamp_adjustments(
    incoming: &[(String, f64, String)],
    existing: &[Value],
    form: &str,
    user_id: &str,
) -> Result<Vec<Value>, Fail> {
    let at = now();
    incoming
        .iter()
        .map(|(code, amount, reason)| {
            if form_1099_box(code).is_none_or(|d| d.kind != "amount" || d.form != form) {
                return Err(Fail::bad(format!(
                    "{code} is not an amount box of form 1099-{}",
                    form.to_uppercase()
                )));
            }
            let trimmed = weldsuite_kit::validation::js_trim(reason);
            if trimmed.is_empty() {
                return Err(Fail::bad("An adjustment needs a reason"));
            }
            #[allow(clippy::float_cmp)] // `amount === 0`
            if !amount.is_finite() || *amount == 0.0 {
                return Err(Fail::bad("An adjustment needs a non-zero amount"));
            }
            #[allow(clippy::float_cmp)] // `e.amount === adjustment.amount`
            let same = existing.iter().find(|e| {
                e["box"].as_str() == Some(code) && e["amount"].as_f64() == Some(*amount) && e["reason"].as_str() == Some(reason)
            });
            Ok(same.cloned().unwrap_or_else(|| {
                json!({ "box": code, "amount": number_value(*amount), "reason": trimmed, "by": user_id, "at": at })
            }))
        })
        .collect()
}

/// `updateLine(db, entityId, filingId, lineId, patch, userId)`: the filing detail.
#[allow(clippy::too_many_lines)] // the service's rules, in order
pub(crate) async fn update_line(
    db: &PgPool,
    entity_id: &str,
    filing_id: &str,
    line_id: &str,
    patch: &LinePatch,
    user_id: &str,
) -> Result<Value, Fail> {
    let filing = load_filing(db, entity_id, filing_id).await?;
    let lines = load_lines(db, filing_id).await?;
    let line = find_line(&lines, line_id)?;
    let form = text(&filing, "formType");
    let filing_status = text(&filing, "status");
    let mut changes = Map::new();

    let pending = filing_status == "corrected"
        && line["isCorrected"] == json!(true)
        && text(&line, "status") == "included";
    if !EDITABLE.contains(&filing_status) && !pending {
        return Err(Fail::conflict(format!(
            "The filing is {filing_status}. Only a draft or reviewed filing, or a correction that has not been filed, can be changed."
        )));
    }
    if let Some(code) = &patch.state_code {
        changes.insert(
            "stateCode".into(),
            json!(
                code.as_ref()
                    .filter(|c| !c.is_empty())
                    .map(|c| c.to_uppercase())
            ),
        );
    }
    if let Some(number) = &patch.state_id_number {
        changes.insert("stateIdNumber".into(), json!(number));
    }
    if let Some(income) = &patch.state_income {
        changes.insert("stateIncome".into(), json!(income.map(|v| to_fixed(v, 2))));
    }
    if let Some(withheld) = &patch.state_withheld {
        changes.insert(
            "stateWithheld".into(),
            json!(withheld.map(|v| to_fixed(v, 2))),
        );
    }

    let reason_of = |r: &Option<Option<String>>| {
        r.clone()
            .flatten()
            .map(|s| weldsuite_kit::validation::js_trim(&s).to_owned())
            .filter(|s| !s.is_empty())
    };
    if pending {
        if patch.adjustments.is_some() {
            return Err(Fail::bad(
                "Set the boxes of a correction directly with `boxes`",
            ));
        }
        if let Some(boxes) = &patch.boxes {
            validate_boxes(boxes, form)?;
            changes.insert("boxes".into(), boxes_object(boxes));
            let withheld = boxes
                .iter()
                .find(|(c, _)| c == withholding_box_for(form))
                .map_or(0.0, |(_, v)| *v);
            changes.insert("federalWithheld".into(), json!(to_fixed(withheld, 2)));
        }
        if patch.status.as_deref() == Some("excluded") {
            let Some(reason) = reason_of(&patch.excluded_reason) else {
                return Err(Fail::bad("Say why the correction is withdrawn"));
            };
            changes.insert("status".into(), json!("excluded"));
            changes.insert("excludedReason".into(), json!(reason));
        }
    } else {
        if patch.boxes.is_some() {
            return Err(Fail::bad(
                "`boxes` can only be set on a correction; use `adjustments`",
            ));
        }
        let mut manual = is_manual_exclusion(&line);
        let mut reason = line["excludedReason"].clone();
        match patch.status.as_deref() {
            Some("excluded") => {
                let Some(r) = reason_of(&patch.excluded_reason) else {
                    return Err(Fail::bad("Say why the recipient is excluded"));
                };
                manual = true;
                reason = json!(weldsuite_books_domain::js::slice_utf16(&r, 255));
            }
            Some("included") => {
                manual = false;
                reason = Value::Null;
            }
            _ => {}
        }
        if let Some(incoming) = &patch.adjustments {
            let existing = line["adjustments"].as_array().cloned().unwrap_or_default();
            changes.insert(
                "adjustments".into(),
                Value::Array(stamp_adjustments(incoming, &existing, form, user_id)?),
            );
        }
        if patch.adjustments.is_some() || patch.status.is_some() {
            let mut working = line.clone();
            if let Some(adjustments) = changes.get("adjustments") {
                working["adjustments"] = adjustments.clone();
            }
            working["status"] = json!(if manual { "excluded" } else { "included" });
            working["excludedReason"] = if manual { reason } else { Value::Null };
            let only = [line_id.to_owned()];
            let (updates, _, _) = recompute_lines(db, &filing, &[working], Some(&only)).await?;
            if let Some((_, computed)) = updates.into_iter().find(|(id, _)| id == line_id) {
                changes.extend(computed);
            }
        }
    }

    if changes.is_empty() {
        return load_filing_detail(db, entity_id, filing_id).await;
    }
    let at = now();
    let excluded_now = changes.get("status") == Some(&json!("excluded"));
    let (lid, fid) = (line_id.to_owned(), filing_id.to_owned());
    let stamp = at.clone();
    weldsuite_db::atomically_with::<_, (), sqlx::Error, _>(db, move |conn| {
        Box::pin(async move {
            changes.insert("updatedAt".into(), json!(stamp));
            patch_line(conn, &lid, &changes).await?;
            patch_filing(conn, &fid, set(&[("updatedAt", json!(stamp))])).await
        })
    })
    .await?;
    if pending && excluded_now {
        let remaining = load_lines(db, filing_id)
            .await?
            .into_iter()
            .filter(|l| l["isCorrected"] == json!(true) && text(l, "status") == "included")
            .count();
        if remaining == 0 {
            let mut conn = db.acquire().await?;
            patch_filing(
                &mut conn,
                filing_id,
                set(&[("status", json!("filed")), ("updatedAt", json!(at))]),
            )
            .await?;
        }
    }
    load_filing_detail(db, entity_id, filing_id).await
}

fn unresolved(lines: &[Value]) -> Vec<Value> {
    lines
        .iter()
        .filter(|l| matches!(text(l, "status"), "needs_tin" | "needs_address"))
        .map(|l| {
            json!({
                "lineId": l["id"],
                "partyId": l["partyId"],
                "name": l["recipient"].get("name").cloned().unwrap_or(Value::Null),
                "status": l["status"],
            })
        })
        .collect()
}

/// `reviewFiling(db, entityId, filingId)`: the lines still open.
pub(crate) async fn review_filing(
    db: &PgPool,
    entity_id: &str,
    filing_id: &str,
) -> Result<Vec<Value>, Fail> {
    let filing = load_filing(db, entity_id, filing_id).await?;
    let status = text(&filing, "status");
    if status != "draft" {
        return Err(Fail::conflict(format!(
            "Only a draft filing can be reviewed; this one is {status}."
        )));
    }
    let lines = load_lines(db, filing_id).await?;
    let mut conn = db.acquire().await?;
    patch_filing(
        &mut conn,
        filing_id,
        set(&[("status", json!("reviewed")), ("updatedAt", json!(now()))]),
    )
    .await?;
    Ok(unresolved(&lines))
}

fn vendor_tax_fail(error: weldsuite_books_domain::vendor_tax::VendorTaxError) -> Fail {
    use weldsuite_books_domain::vendor_tax::VendorTaxError;
    match error {
        VendorTaxError::NoKey => Fail::Unavailable(error.to_string()),
        other => Fail::Internal(other.to_string()),
    }
}

fn key_of(keyring: &Keyring) -> Result<&Keyring, Fail> {
    weldsuite_books_domain::vendor_tax::require_keyring(keyring).map_err(vendor_tax_fail)
}

async fn load_party(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(parties),
        " from parties t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| PARTIES.js(r)))
}

/// `generateFiling(db, env, entityId, filingId)`: the number of recipients.
pub(crate) async fn generate_filing(
    db: &PgPool,
    keyring: &Keyring,
    entity_id: &str,
    filing_id: &str,
) -> Result<usize, Fail> {
    let filing = load_filing(db, entity_id, filing_id).await?;
    let status = text(&filing, "status");
    if status != "reviewed" {
        return Err(Fail::conflict(format!(
            "Review the filing first; this one is {status}."
        )));
    }
    let lines = load_lines(db, filing_id).await?;
    let open = unresolved(&lines);
    if !open.is_empty() {
        return Err(Fail::Conflict(
            format!(
                "{} recipient(s) still need a TIN or an address. Fix them and refresh, or exclude them.",
                open.len()
            ),
            Some(json!({ "lines": open })),
        ));
    }
    let included: Vec<&Value> = lines
        .iter()
        .filter(|l| text(l, "status") == "included")
        .collect();
    if included.is_empty() {
        return Err(Fail::conflict(
            "There is no recipient to report on this filing.",
        ));
    }
    let keyring = key_of(keyring)?;
    let mut sealed: Vec<(String, String, Value)> = Vec::new();
    for line in &included {
        let party = load_party(db, text(line, "partyId")).await?;
        let tin = match &party {
            Some(party) => read_sensitive(party, keyring).map_err(vendor_tax_fail)?.tin,
            None => None,
        };
        let (Some(party), Some(tin)) = (party, tin.filter(|t| !t.is_empty())) else {
            let name = line["recipient"]["name"]
                .as_str()
                .map_or_else(|| text(line, "partyId").to_owned(), str::to_owned);
            return Err(Fail::Conflict(
                format!("{name} has no TIN on file"),
                Some(json!({ "lineId": line["id"] })),
            ));
        };
        let sealed_tin = weldsuite_db::encrypt_field(&tin, keyring)
            .map_err(|error| Fail::Internal(format!("encrypt failed: {error:?}")))?;
        sealed.push((
            text(line, "id").to_owned(),
            sealed_tin,
            snapshot_recipient(&party),
        ));
    }
    let count = included.len();
    let at = now();
    let id = filing_id.to_owned();
    weldsuite_db::atomically_with::<_, (), sqlx::Error, _>(db, move |conn| {
        Box::pin(async move {
            for (line_id, tin, recipient) in &sealed {
                patch_line(
                    conn,
                    line_id,
                    &set(&[
                        ("recipient", recipient.clone()),
                        ("recipientTinEncrypted", json!(tin)),
                        ("updatedAt", json!(at)),
                    ]),
                )
                .await?;
            }
            patch_filing(
                conn,
                &id,
                set(&[
                    ("status", json!("generated")),
                    ("generatedAt", json!(at)),
                    ("updatedAt", json!(at)),
                ]),
            )
            .await
        })
    })
    .await?;
    Ok(count)
}

/// `markFiled(db, entityId, filingId, { confirmationNumber, filedAt })`.
pub(crate) async fn mark_filed(
    db: &PgPool,
    entity_id: &str,
    filing_id: &str,
    confirmation_number: &str,
    filed_at: Option<String>,
) -> Result<(), Fail> {
    let filing = load_filing(db, entity_id, filing_id).await?;
    let status = text(&filing, "status");
    if status != "generated" && status != "corrected" {
        return Err(Fail::conflict(format!(
            "Generate the filing first; this one is {status}."
        )));
    }
    let at = now();
    let filed = filed_at.unwrap_or_else(|| at.clone());
    let (id, number) = (filing_id.to_owned(), confirmation_number.to_owned());
    weldsuite_db::atomically_with::<_, (), sqlx::Error, _>(db, move |conn| {
        Box::pin(async move {
            sqlx::query(
                "update form_1099_filing_lines set status = 'filed', updated_at = $1::timestamp \
                 where filing_id = $2 and status = 'included'",
            )
            .bind(&at)
            .bind(&id)
            .execute(&mut *conn)
            .await?;
            patch_filing(
                conn,
                &id,
                set(&[
                    ("status", json!("filed")),
                    ("filedAt", json!(filed)),
                    ("confirmationNumber", json!(number)),
                    ("updatedAt", json!(at)),
                ]),
            )
            .await
        })
    })
    .await?;
    Ok(())
}

/// `correctLine(db, env, entityId, filingId, lineId, input, userId)`: the new line's id.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn correct_line(
    db: &PgPool,
    keyring: &Keyring,
    entity_id: &str,
    filing_id: &str,
    line_id: &str,
    boxes: &[(String, f64)],
    reason: &str,
    refresh_recipient: bool,
    user_id: &str,
) -> Result<String, Fail> {
    let filing = load_filing(db, entity_id, filing_id).await?;
    let status = text(&filing, "status");
    if status != "filed" && status != "corrected" {
        return Err(Fail::conflict(format!(
            "Only a filed filing can be corrected; this one is {status}. Edit it instead."
        )));
    }
    let form = text(&filing, "formType");
    let all = load_lines(db, filing_id).await?;
    let line = find_line(&all, line_id)?;
    if all
        .iter()
        .any(|l| opt(l, "correctionOfLineId") == Some(line_id))
    {
        return Err(Fail::conflict(
            "This line was already corrected; correct the newer line.",
        ));
    }
    if text(&line, "status") != "filed" {
        return Err(Fail::conflict(
            "Only a line that was filed can be corrected; edit a pending correction instead.",
        ));
    }
    let reason = weldsuite_kit::validation::js_trim(reason);
    if reason.is_empty() {
        return Err(Fail::bad("A correction needs a reason"));
    }
    validate_boxes(boxes, form)?;

    let at = now();
    let old = line["boxes"].as_object().cloned().unwrap_or_default();
    let mut codes: Vec<String> = old.keys().cloned().collect();
    for (code, _) in boxes {
        if !codes.contains(code) {
            codes.push(code.clone());
        }
    }
    let mut adjustments = Vec::new();
    for code in codes {
        let new = boxes
            .iter()
            .find(|(c, _)| *c == code)
            .map_or(0.0, |(_, v)| *v);
        let delta = cents(new - old.get(&code).map_or(0.0, num));
        if delta != 0.0 {
            adjustments.push(json!({ "box": code, "amount": number_value(delta), "reason": reason, "by": user_id, "at": at }));
        }
    }

    let mut recipient = line["recipient"].clone();
    let mut tin = line["recipientTinEncrypted"].clone();
    if refresh_recipient {
        let Some(party) = load_party(db, text(&line, "partyId")).await? else {
            return Err(Fail::not_found("The vendor of this line no longer exists"));
        };
        let keyring = key_of(keyring)?;
        let plain = read_sensitive(&party, keyring)
            .map_err(vendor_tax_fail)?
            .tin
            .filter(|t| !t.is_empty());
        let Some(plain) = plain else {
            return Err(Fail::conflict("The vendor has no TIN on file"));
        };
        recipient = snapshot_recipient(&party);
        tin = json!(
            weldsuite_db::encrypt_field(&plain, keyring)
                .map_err(|error| Fail::Internal(format!("encrypt failed: {error:?}")))?
        );
    }
    let withheld = boxes
        .iter()
        .find(|(c, _)| c == withholding_box_for(form))
        .map_or(0.0, |(_, v)| *v);
    let new_id = generate_id("f9l");
    let row = set(&[
        ("id", json!(new_id)),
        ("entityId", json!(entity_id)),
        ("filingId", json!(filing_id)),
        ("partyId", line["partyId"].clone()),
        ("recipient", recipient),
        ("recipientTinEncrypted", tin),
        ("boxes", boxes_object(boxes)),
        ("adjustments", Value::Array(adjustments)),
        ("federalWithheld", json!(to_fixed(withheld, 2))),
        ("stateCode", line["stateCode"].clone()),
        ("stateIdNumber", line["stateIdNumber"].clone()),
        ("stateIncome", line["stateIncome"].clone()),
        ("stateWithheld", line["stateWithheld"].clone()),
        ("status", json!("included")),
        ("isCorrected", json!(true)),
        ("correctionOfLineId", json!(line_id)),
        ("createdAt", json!(at)),
        ("updatedAt", json!(at)),
    ]);
    let id = filing_id.to_owned();
    weldsuite_db::atomically_with::<_, (), sqlx::Error, _>(db, move |conn| {
        Box::pin(async move {
            insert_line(conn, &row).await?;
            patch_filing(
                conn,
                &id,
                set(&[("status", json!("corrected")), ("updatedAt", json!(at))]),
            )
            .await
        })
    })
    .await?;
    Ok(new_id)
}

/// `markLineDelivered(db, entityId, filingId, lineId, method)`: `{ deliveredAt, deliveryMethod }`.
pub(crate) async fn mark_line_delivered(
    db: &PgPool,
    entity_id: &str,
    filing_id: &str,
    line_id: &str,
    method: &str,
) -> Result<Value, Fail> {
    let filing = load_filing(db, entity_id, filing_id).await?;
    if !matches!(text(&filing, "status"), "generated" | "filed" | "corrected") {
        return Err(Fail::conflict(
            "Generate the filing before delivering copies.",
        ));
    }
    let lines = load_lines(db, filing_id).await?;
    let line = find_line(&lines, line_id)?;
    if !matches!(text(&line, "status"), "included" | "filed") {
        return Err(Fail::conflict("This recipient is not on the filing."));
    }
    if method == "email" {
        let consent: Option<Option<String>> = sqlx::query_scalar(
            "select form_1099_e_delivery_consent_at::text from parties where id = $1 limit 1",
        )
        .bind(text(&line, "partyId"))
        .fetch_optional(db)
        .await?;
        if consent.flatten().is_none() {
            return Err(Fail::conflict(
                "The recipient has not agreed to electronic delivery. Record their consent first, or deliver a printed copy.",
            ));
        }
    }
    let at = now();
    let mut conn = db.acquire().await?;
    patch_line(
        &mut conn,
        line_id,
        &set(&[
            ("deliveryMethod", json!(method)),
            ("deliveredAt", json!(at)),
            ("updatedAt", json!(at)),
        ]),
    )
    .await?;
    Ok(json!({ "deliveredAt": at, "deliveryMethod": method }))
}

/// `deleteFiling(db, entityId, filingId)`: the filing as it was.
pub(crate) async fn delete_filing(
    db: &PgPool,
    entity_id: &str,
    filing_id: &str,
) -> Result<Value, Fail> {
    let filing = load_filing(db, entity_id, filing_id).await?;
    let status = text(&filing, "status");
    if status != "draft" {
        return Err(Fail::conflict(format!(
            "Only a draft filing can be deleted; this one is {status}."
        )));
    }
    let at = now();
    let id = filing_id.to_owned();
    weldsuite_db::atomically_with::<_, (), sqlx::Error, _>(db, move |conn| {
        Box::pin(async move {
            sqlx::query("delete from form_1099_filing_lines where filing_id = $1")
                .bind(&id)
                .execute(&mut *conn)
                .await?;
            patch_filing(
                conn,
                &id,
                set(&[("deletedAt", json!(at)), ("updatedAt", json!(at))]),
            )
            .await
        })
    })
    .await?;
    Ok(filing)
}

/// `filingEventData(filing, extra)`: no recipients, no TINs.
pub(crate) fn filing_event_data(filing: &Value, extra: &[(&str, Value)]) -> Value {
    let mut out = set(&[
        ("id", filing["id"].clone()),
        ("entityId", filing["entityId"].clone()),
        ("taxYear", filing["taxYear"].clone()),
        ("formType", filing["formType"].clone()),
        ("status", filing["status"].clone()),
    ]);
    for (key, value) in extra {
        out.insert((*key).to_owned(), value.clone());
    }
    Value::Object(out)
}

/// `linesForFile(filing, lines)`: the lines that go into the IRIS file or the copies.
pub(crate) fn lines_for_file(filing: &Value, lines: &[Value]) -> Vec<Value> {
    let superseded = superseded_of(lines);
    let live = lines.iter().filter(|l| {
        !superseded.contains(text(l, "id")) && matches!(text(l, "status"), "included" | "filed")
    });
    if text(filing, "status") == "corrected" {
        live.filter(|l| l["isCorrected"] == json!(true) && text(l, "status") == "included")
            .cloned()
            .collect()
    } else {
        live.cloned().collect()
    }
}
