//! Holds on a payment run (`services/payment-runs/holds.ts`): reasons a
//! vendor is left out of the payments until someone looks at it.
//!
//! - `no_bank_details`, `invalid_bank_details`: ACH needs a routing number,
//!   an account number and an account type, the routing number passing the
//!   ABA checksum. Fixed on the vendor, never released.
//! - `bank_details_changed`: changed in the last `holdWindowDays` and not
//!   verified. Cleared by verifying on the vendor.
//! - `prenote_required`, `prenote_pending`: with `requirePrenotes` on, a new
//!   account gets a $0 prenote and its payment waits three banking days.
//! - `in_other_run`: a bill of the vendor is in another open run.
//! - `backup_withholding`: withholding applies and the chart has no Backup
//!   Withholding Payable account. Never released.
//!
//! Stored in `payment_runs.holds` as `{ partyId, reason }`, `reason` a small
//! JSON document (`code`, `message`, `key`, `released`) written in that key
//! order, as `JSON.stringify` writes it.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::dates::add_days;
use weldsuite_books_domain::js::millis_of;
use weldsuite_books_domain::nacha::{aba_checksum_valid, is_ach_banking_day};
use weldsuite_books_domain::tables::PARTIES;

use super::runs::{RunItem, compute_run_withholding, has_backup_withholding_account};
use super::settings::AchSettings;

pub(crate) const HOLD_CODES: [&str; 7] = [
    "no_bank_details",
    "invalid_bank_details",
    "bank_details_changed",
    "prenote_required",
    "prenote_pending",
    "in_other_run",
    "backup_withholding",
];

/// `UNRELEASABLE_HOLD_CODES`: only fixing the vendor (or the chart) clears them.
const UNRELEASABLE_HOLD_CODES: [&str; 4] = [
    "no_bank_details",
    "invalid_bank_details",
    "bank_details_changed",
    "backup_withholding",
];

/// Banking days between a prenote and the first live entry.
pub(crate) const PRENOTE_WAIT_BANKING_DAYS: i64 = 3;

/// `RunHold`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RunHold {
    pub party_id: String,
    pub code: String,
    pub message: String,
    pub key: String,
    /// `{ by, at, reason }` once released, else `null`.
    pub released: Value,
}

impl RunHold {
    pub(crate) fn is_released(&self) -> bool {
        weldsuite_books_domain::js::truthy(Some(&self.released))
    }
}

/// A JSON value as `JSON.stringify` writes it, a release's keys in the order
/// it is built (`by`, `at`, `reason`).
fn stringify(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = ["by", "at", "reason"]
                .iter()
                .filter_map(|k| map.get_key_value(*k).map(|(key, _)| key))
                .collect();
            let mut rest: Vec<&String> = map
                .keys()
                .filter(|k| !["by", "at", "reason"].contains(&k.as_str()))
                .collect();
            rest.sort();
            keys.extend(rest);
            let fields: Vec<String> = keys
                .into_iter()
                .map(|key| format!("{}:{}", Value::String(key.clone()), stringify(&map[key])))
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(stringify).collect::<Vec<_>>().join(",")
        ),
        other => other.to_string(),
    }
}

/// `encodeHold(hold)`.
pub(crate) fn encode_hold(hold: &RunHold) -> Value {
    let reason = format!(
        "{{\"code\":{},\"message\":{},\"key\":{},\"released\":{}}}",
        Value::String(hold.code.clone()),
        Value::String(hold.message.clone()),
        Value::String(hold.key.clone()),
        stringify(&hold.released),
    );
    json!({ "partyId": hold.party_id, "reason": reason })
}

/// `encodeHolds(holds)`.
pub(crate) fn encode_holds(holds: &[RunHold]) -> Value {
    Value::Array(holds.iter().map(encode_hold).collect())
}

/// `decodeHold(stored)`: a plain-text reason from an older writer reads as
/// an `in_other_run` hold with that message.
pub(crate) fn decode_hold(stored: &Value) -> RunHold {
    let party_id = stored
        .get("partyId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let reason = stored
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(reason)
        && let Some(code) = parsed.get("code").and_then(Value::as_str)
        && HOLD_CODES.contains(&code)
    {
        return RunHold {
            party_id,
            code: code.to_owned(),
            message: parsed
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or(reason)
                .to_owned(),
            key: parsed
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            released: parsed.get("released").cloned().unwrap_or(Value::Null),
        };
    }
    RunHold {
        party_id,
        code: "in_other_run".to_owned(),
        message: reason.to_owned(),
        key: String::new(),
        released: Value::Null,
    }
}

/// `decodeHolds(stored)`.
pub(crate) fn decode_holds(stored: Option<&Value>) -> Vec<RunHold> {
    stored
        .and_then(Value::as_array)
        .map(|holds| holds.iter().map(decode_hold).collect())
        .unwrap_or_default()
}

/// `activeHolds(holds)`.
pub(crate) fn active_holds(holds: &[RunHold]) -> Vec<&RunHold> {
    holds.iter().filter(|h| !h.is_released()).collect()
}

/// `heldPartyIds(holds)`.
pub(crate) fn held_party_ids(holds: &[RunHold]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for hold in active_holds(holds) {
        if !ids.contains(&hold.party_id) {
            ids.push(hold.party_id.clone());
        }
    }
    ids
}

/// `releaseBlocker(hold)`: why the hold can't be released from the run.
pub(crate) fn release_blocker(hold: &RunHold) -> Option<&'static str> {
    match hold.code.as_str() {
        "no_bank_details" | "invalid_bank_details" => {
            Some("Fix the vendor's bank details first: this hold can't be released from the run.")
        }
        "bank_details_changed" => Some(
            "Verify the vendor's changed bank details on the vendor first; the hold then clears by itself.",
        ),
        "backup_withholding" => Some(
            "Add a Backup Withholding Payable account to the chart of accounts first: a vendor subject to backup withholding can't be paid in full.",
        ),
        _ => None,
    }
}

// ── Vendor ACH status ───────────────────────────────────────────────────────

/// `VendorAchStatus`.
#[derive(Debug, Clone)]
#[allow(clippy::struct_excessive_bools)] // the readiness checks, one flag each
pub(crate) struct VendorAchStatus {
    pub has_routing: bool,
    pub has_account: bool,
    pub has_account_type: bool,
    pub routing_valid: bool,
    pub last4: Value,
    pub account_type: Value,
    pub changed_at: Option<String>,
    pub verified_at: Option<String>,
    pub verified: bool,
    pub hold_active: bool,
    pub ready: bool,
}

impl VendorAchStatus {
    pub(crate) fn to_json(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("hasRouting".to_owned(), json!(self.has_routing));
        out.insert("hasAccount".to_owned(), json!(self.has_account));
        out.insert("hasAccountType".to_owned(), json!(self.has_account_type));
        out.insert("routingValid".to_owned(), json!(self.routing_valid));
        out.insert("last4".to_owned(), self.last4.clone());
        out.insert("accountType".to_owned(), self.account_type.clone());
        out.insert("bankDetailsChangedAt".to_owned(), json!(self.changed_at));
        out.insert("bankDetailsVerifiedAt".to_owned(), json!(self.verified_at));
        out.insert("verified".to_owned(), json!(self.verified));
        out.insert("holdActive".to_owned(), json!(self.hold_active));
        out.insert("ready".to_owned(), json!(self.ready));
        out
    }
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `vendorAchStatus(party, holdWindowDays, now)`.
pub(crate) fn vendor_ach_status(
    party: &Value,
    hold_window_days: i64,
    now_ms: i64,
) -> VendorAchStatus {
    let truthy = |key: &str| weldsuite_books_domain::js::truthy(party.get(key));
    let has_routing = truthy("achRoutingNumber");
    let has_account = truthy("achAccountLast4");
    let account_type = text(party, "achAccountType");
    let has_account_type = matches!(account_type, Some("checking" | "savings"));
    let routing_valid =
        has_routing && aba_checksum_valid(text(party, "achRoutingNumber").unwrap_or_default());
    let changed = text(party, "bankDetailsChangedAt").and_then(millis_of);
    let verified_at = text(party, "bankDetailsVerifiedAt").and_then(millis_of);
    let verified = match changed {
        None => true,
        Some(changed) => verified_at.is_some_and(|v| v >= changed),
    };
    let hold_active = changed
        .is_some_and(|changed| !verified && now_ms - changed < hold_window_days * 86_400_000);
    VendorAchStatus {
        has_routing,
        has_account,
        has_account_type,
        routing_valid,
        last4: party.get("achAccountLast4").cloned().unwrap_or(Value::Null),
        account_type: party.get("achAccountType").cloned().unwrap_or(Value::Null),
        changed_at: changed.and_then(weldsuite_books_domain::js::iso_from_millis),
        verified_at: verified_at.and_then(weldsuite_books_domain::js::iso_from_millis),
        verified,
        hold_active,
        ready: has_routing && has_account && has_account_type && routing_valid,
    }
}

// ── Prenotes ────────────────────────────────────────────────────────────────

/// `addBankingDays(date, n)`.
pub(crate) fn add_banking_days(date: &str, n: i64) -> String {
    let mut current = date.to_owned();
    let mut left = n;
    while left > 0 {
        let Some(next) = add_days(&current, 1) else {
            break;
        };
        current = next;
        if is_ach_banking_day(&current) {
            left -= 1;
        }
    }
    current
}

/// `AchHistory`: millis of live ACH payments and of prenotes per vendor.
#[derive(Debug, Clone, Default)]
pub(crate) struct AchHistory {
    pub live_payments: Vec<i64>,
    pub prenotes: Vec<i64>,
}

fn day_of(millis: i64) -> String {
    weldsuite_books_domain::js::iso_from_millis(millis)
        .map(|iso| iso.chars().take(10).collect())
        .unwrap_or_default()
}

/// `prenoteState(party, history, now)`: `proven`, `pending` or `needed`.
pub(crate) fn prenote_state(party: &Value, history: &AchHistory, now_ms: i64) -> &'static str {
    let since = text(party, "bankDetailsChangedAt")
        .and_then(millis_of)
        .unwrap_or(0);
    if history.live_payments.iter().any(|d| *d >= since) {
        return "proven";
    }
    let today = day_of(now_ms);
    let prenotes: Vec<i64> = history
        .prenotes
        .iter()
        .copied()
        .filter(|d| *d >= since)
        .collect();
    if prenotes.is_empty() {
        return "needed";
    }
    let aged = prenotes
        .iter()
        .any(|d| add_banking_days(&day_of(*d), PRENOTE_WAIT_BANKING_DAYS) <= today);
    if aged { "proven" } else { "pending" }
}

/// `loadAchHistory(db, entityId, partyIds)`.
pub(crate) async fn load_ach_history(
    db: &PgPool,
    entity_id: &str,
    party_ids: &[String],
) -> Result<HashMap<String, AchHistory>, sqlx::Error> {
    let mut result: HashMap<String, AchHistory> = party_ids
        .iter()
        .map(|id| (id.clone(), AchHistory::default()))
        .collect();
    if party_ids.is_empty() {
        return Ok(result);
    }
    let payments: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select p.contact_id, to_char(p.date, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
         to_char(r.file_generated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') \
         from payments p left join payment_runs r on r.id = p.payment_run_id \
         where p.entity_id = $1 and p.type = 'sent' and p.payment_method = 'ach' and p.deleted_at is null \
         and p.contact_id = any($2) and (p.payment_run_id is null or r.status in ('exported', 'completed'))",
    )
    .bind(entity_id)
    .bind(party_ids)
    .fetch_all(db)
    .await?;
    for (contact, date, file_generated_at) in payments {
        if let Some(entry) = result.get_mut(&contact)
            && let Some(at) = file_generated_at.or(date).as_deref().and_then(millis_of)
        {
            entry.live_payments.push(at);
        }
    }
    let runs: Vec<(Option<Value>, Option<String>)> = sqlx::query_as(
        "select holds, to_char(file_generated_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from payment_runs \
         where entity_id = $1 and method = 'ach' and deleted_at is null and status in ('exported', 'completed')",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    for (holds, file_generated_at) in runs {
        let Some(at) = file_generated_at.as_deref().and_then(millis_of) else {
            continue;
        };
        for hold in decode_holds(holds.as_ref()) {
            if hold.code == "prenote_required"
                && !hold.is_released()
                && let Some(entry) = result.get_mut(&hold.party_id)
            {
                entry.prenotes.push(at);
            }
        }
    }
    Ok(result)
}

// ── Evaluating the holds of a run ───────────────────────────────────────────

/// `EvaluateHoldsArgs`.
pub(crate) struct EvaluateHolds<'a> {
    pub entity_id: &'a str,
    /// The run being evaluated (excluded from the other-run check).
    pub run_id: Option<&'a str>,
    pub ach: bool,
    pub payment_date: &'a str,
    pub items: &'a [RunItem],
    pub settings: &'a AchSettings,
    /// The run's earlier holds: a release carries over when the same hold
    /// comes back for the same reason.
    pub previous: &'a [RunHold],
}

/// The parties of a list of ids, in the order the database returns them.
pub(crate) async fn load_parties(db: &PgPool, ids: &[String]) -> Result<Vec<Value>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(parties),
        " from parties t where t.id = any($1)"
    ))
    .bind(ids)
    .fetch_all(db)
    .await?;
    Ok(PARTIES.js_rows(rows))
}

/// The distinct party ids of items, in order.
pub(crate) fn party_ids_of(items: &[RunItem]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for item in items {
        if !ids.contains(&item.party_id) {
            ids.push(item.party_id.clone());
        }
    }
    ids
}

/// `evaluateHolds(db, args)`: the holds a run has right now, with earlier
/// releases carried over.
#[allow(clippy::too_many_lines)] // the hold rules, in the worker's order
pub(crate) async fn evaluate_holds(
    db: &PgPool,
    args: EvaluateHolds<'_>,
) -> Result<Vec<RunHold>, sqlx::Error> {
    let now = weldsuite_books_domain::http::now_ms();
    let party_ids = party_ids_of(args.items);
    if party_ids.is_empty() {
        return Ok(Vec::new());
    }
    let parties = load_parties(db, &party_ids).await?;
    let party = |id: &str| parties.iter().find(|p| text(p, "id") == Some(id));
    let name = |id: &str| -> String {
        party(id)
            .and_then(|p| text(p, "displayName"))
            .unwrap_or(id)
            .to_owned()
    };
    let mut found: Vec<RunHold> = Vec::new();
    let mut hold = |party_id: &str, code: &str, key: String, message: String| {
        found.push(RunHold {
            party_id: party_id.to_owned(),
            code: code.to_owned(),
            message,
            key,
            released: Value::Null,
        });
    };

    if args.ach {
        let history = if args.settings.require_prenotes {
            Some(load_ach_history(db, args.entity_id, &party_ids).await?)
        } else {
            None
        };
        for party_id in &party_ids {
            let Some(row) = party(party_id) else {
                continue;
            };
            let status = vendor_ach_status(row, args.settings.hold_window_days, now);
            if !status.has_routing || !status.has_account || !status.has_account_type {
                let missing: Vec<&str> = [
                    (!status.has_routing).then_some("routing number"),
                    (!status.has_account).then_some("account number"),
                    (!status.has_account_type).then_some("account type"),
                ]
                .into_iter()
                .flatten()
                .collect();
                hold(
                    party_id,
                    "no_bank_details",
                    String::new(),
                    format!(
                        "{} has no ACH {}. Add the bank details on the vendor.",
                        name(party_id),
                        missing.join(", ")
                    ),
                );
                continue;
            }
            if !status.routing_valid {
                hold(
                    party_id,
                    "invalid_bank_details",
                    String::new(),
                    format!(
                        "{} has a routing number that fails the ABA checksum. Correct it on the vendor.",
                        name(party_id)
                    ),
                );
                continue;
            }
            if status.hold_active {
                let day: String = status
                    .changed_at
                    .as_deref()
                    .unwrap_or_default()
                    .chars()
                    .take(10)
                    .collect();
                hold(
                    party_id,
                    "bank_details_changed",
                    String::new(),
                    format!(
                        "{}'s bank details changed on {day} and have not been verified. Call the vendor on a number you already had, then verify the change on the vendor.",
                        name(party_id)
                    ),
                );
                continue;
            }
            if let Some(history) = &history {
                let empty = AchHistory::default();
                match prenote_state(row, history.get(party_id).unwrap_or(&empty), now) {
                    "needed" => hold(
                        party_id,
                        "prenote_required",
                        String::new(),
                        format!(
                            "First payment to a new account for {}: a $0 prenote goes in the next file and the payment waits {PRENOTE_WAIT_BANKING_DAYS} banking days.",
                            name(party_id)
                        ),
                    ),
                    "pending" => hold(
                        party_id,
                        "prenote_pending",
                        String::new(),
                        format!(
                            "The prenote for {} was sent less than {PRENOTE_WAIT_BANKING_DAYS} banking days ago.",
                            name(party_id)
                        ),
                    ),
                    _ => {}
                }
            }
        }
    }

    // Bills already in another open run.
    let other_runs: Vec<(String, Option<Value>)> = sqlx::query_as(
        "select id, items from payment_runs where entity_id = $1 and deleted_at is null \
         and status in ('draft', 'pending_approval')",
    )
    .bind(args.entity_id)
    .fetch_all(db)
    .await?;
    let mut bill_run: HashMap<String, String> = HashMap::new();
    for (run_id, items) in &other_runs {
        if Some(run_id.as_str()) == args.run_id {
            continue;
        }
        for item in super::runs::items_of(items.as_ref()) {
            bill_run.insert(item.bill_id, run_id.clone());
        }
    }
    if !bill_run.is_empty() {
        for party_id in &party_ids {
            let shared: Vec<&RunItem> = args
                .items
                .iter()
                .filter(|i| &i.party_id == party_id && bill_run.contains_key(&i.bill_id))
                .collect();
            if shared.is_empty() {
                continue;
            }
            let mut run_ids: Vec<&str> = Vec::new();
            for item in &shared {
                let run = bill_run[&item.bill_id].as_str();
                if !run_ids.contains(&run) {
                    run_ids.push(run);
                }
            }
            let mut bills: Vec<&str> = shared.iter().map(|i| i.bill_id.as_str()).collect();
            bills.sort_unstable();
            let count = shared.len();
            hold(
                party_id,
                "in_other_run",
                bills.join(","),
                format!(
                    "{count} of {}'s bills {} already in another open payment run ({}).",
                    name(party_id),
                    if count == 1 { "is" } else { "are" },
                    run_ids.join(", ")
                ),
            );
        }
    }

    // Backup withholding is taken out of the payment, so it only holds a vendor when the chart has nowhere to put it.
    let withholding = compute_run_withholding(
        db,
        args.entity_id,
        args.ach,
        args.payment_date,
        args.items,
        &parties,
    )
    .await?;
    if !withholding.is_empty() && !has_backup_withholding_account(db, args.entity_id).await? {
        for (party_id, outcome) in &withholding {
            hold(
                party_id,
                "backup_withholding",
                String::new(),
                format!(
                    "{} is subject to {}% backup withholding ({} of {}), but this accounting entity has no Backup Withholding Payable account to put it in. Add one to the chart of accounts, then check the run again.",
                    name(party_id),
                    weldsuite_books_domain::js::number_text(
                        weldsuite_books_domain::js::math_round(outcome.rate * 100.0)
                    ),
                    weldsuite_books_domain::js::to_fixed(outcome.amount, 2),
                    weldsuite_books_domain::js::to_fixed(outcome.gross, 2),
                ),
            );
        }
    }

    Ok(found
        .into_iter()
        .map(|mut hold| {
            let earlier = args.previous.iter().find(|p| {
                p.party_id == hold.party_id
                    && p.code == hold.code
                    && p.key == hold.key
                    && p.is_released()
            });
            // A hold that can't be released has nothing to carry: fixing the vendor (or the chart) is what clears it.
            if let Some(earlier) = earlier
                && !UNRELEASABLE_HOLD_CODES.contains(&hold.code.as_str())
            {
                hold.released = earlier.released.clone();
            }
            hold
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_round_trip_as_typescript_writes_them() {
        let hold = RunHold {
            party_id: "pty_a".to_owned(),
            code: "in_other_run".to_owned(),
            message: "1 of A's bills is \"held\"".to_owned(),
            key: "bil_1".to_owned(),
            released: json!({ "by": "user_x", "at": "2026-11-01T10:00:00.000Z", "reason": "ok" }),
        };
        let stored = encode_hold(&hold);
        assert_eq!(
            stored["reason"],
            json!(
                "{\"code\":\"in_other_run\",\"message\":\"1 of A's bills is \\\"held\\\"\",\"key\":\"bil_1\",\"released\":{\"by\":\"user_x\",\"at\":\"2026-11-01T10:00:00.000Z\",\"reason\":\"ok\"}}"
            )
        );
        assert_eq!(decode_hold(&stored), hold);
        let legacy = decode_hold(&json!({ "partyId": "pty_a", "reason": "in another run" }));
        assert_eq!(legacy.code, "in_other_run");
        assert_eq!(legacy.message, "in another run");
    }

    #[test]
    fn banking_days() {
        // Thanksgiving 2026 is a Thursday.
        assert_eq!(add_banking_days("2026-11-24", 3), "2026-11-30");
    }
}
