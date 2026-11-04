//! Client portal rules (`packages/domains/flow/src/project-portal.ts`, ADR
//! FLOW-020): the sign-in constants, the KV records and keys, and the
//! allowlisted shapes `/public/project-portal` answers with.
//!
//! Rows come in as `js_row` values (camelCase keys, timestamps as
//! `toISOString()`), the way Drizzle returns them. The presenters build each
//! shape field by field: a row is never passed through, which is what keeps
//! costs, rates, RAID items, internal notes and members' emails out of the
//! portal. Every message here is sent to the client as it is, so both backends
//! answer alike.

use std::collections::HashMap;
use std::hash::BuildHasher;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::js_trim;

use crate::js::{millis_of, number_value};

// ── Sign-in ─────────────────────────────────────────────────────────────────

/// A sign-in code lives 15 minutes.
pub const PORTAL_CODE_TTL_SECONDS: u64 = 15 * 60;
/// A session lives 30 days from its last use.
pub const PORTAL_SESSION_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
/// The session record is written again when it was last used more than a day ago.
pub const PORTAL_SESSION_REFRESH_AFTER_SECONDS: i64 = 24 * 60 * 60;
/// Wrong guesses a code survives before it is thrown away.
pub const PORTAL_MAX_VERIFY_ATTEMPTS: u32 = 8;
/// Code requests per 15 minutes, per address and per workspace.
pub const PORTAL_REQUEST_LIMIT_EMAIL: u32 = 5;
pub const PORTAL_REQUEST_LIMIT_WORKSPACE: u32 = 200;
pub const PORTAL_REQUEST_WINDOW_SECONDS: u64 = 15 * 60;
/// Failed verifies per 15 minutes, per address and per workspace.
pub const PORTAL_VERIFY_LIMIT_EMAIL: u32 = 20;
pub const PORTAL_VERIFY_LIMIT_WORKSPACE: u32 = 200;
/// The workspace lookup by slug is cached this long.
pub const PORTAL_SLUG_TTL_SECONDS: u64 = 300;

/// `PORTAL_MESSAGES`: the refusals, sent to the client as they are.
pub mod messages {
    pub const INVALID_CODE: &str = "Invalid or expired code";
    pub const TOO_MANY_ATTEMPTS: &str = "Too many attempts, try again later";
    pub const SIGN_IN_UNAVAILABLE: &str = "Sign-in is temporarily unavailable, try again shortly";
    pub const SIGN_IN_REQUIRED: &str = "Sign in required";
    pub const SESSION_EXPIRED: &str = "Session expired";
    pub const ACCESS_REVOKED: &str = "Access revoked";
}

/// `email.trim().toLowerCase()`.
pub fn normalize_portal_email(email: &str) -> String {
    js_trim(email).to_lowercase()
}

/// The text hashed for a code: salted with the workspace and the address, so a
/// leaked record cannot be searched for 6-digit codes with a table that works
/// for every workspace (`portalCodeHash` hashes it with SHA-256).
pub fn portal_code_input(workspace_id: &str, email: &str, code: &str) -> String {
    format!("{workspace_id}:{}:{code}", normalize_portal_email(email))
}

/// A pending sign-in code (KV, 15 minutes). Fields in the order
/// `JSON.stringify` writes them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalChallenge {
    pub code_hash: String,
    pub email: String,
    pub workspace_id: String,
    /// The CRM contacts with this address that hold portal access.
    #[serde(default)]
    pub contact_ids: Vec<String>,
    #[serde(default)]
    pub attempts: u32,
}

/// A signed-in session (KV, 30 days from the last use), keyed by the SHA-256
/// of its token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalSessionRecord {
    pub workspace_id: String,
    /// The Clerk org id the tenant database is opened with; null when only
    /// `workspaces.id` is known.
    pub clerk_org_id: Option<String>,
    pub workspace_slug: String,
    pub workspace_name: String,
    pub email: String,
    pub contact_ids: Vec<String>,
    /// ISO.
    pub created_at: String,
    /// ISO; moves forward when the record is written again.
    pub last_seen_at: String,
}

/// The workspace lookup cached under [`portal_slug_key`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortalSlugEntry {
    pub workspace_id: String,
    pub clerk_org_id: String,
    pub name: String,
}

pub fn portal_code_key(workspace_id: &str, email: &str) -> String {
    format!(
        "pportal:code:{workspace_id}:{}",
        normalize_portal_email(email)
    )
}

pub fn portal_session_key(token_hash: &str) -> String {
    format!("pportal:sess:{token_hash}")
}

pub fn portal_slug_key(slug: &str) -> String {
    format!("pportal:slug:{slug}")
}

/// True when the session was last written more than a day ago.
pub fn session_needs_refresh(last_seen_at: &str, now_millis: i64) -> bool {
    match millis_of(last_seen_at) {
        Some(seen) => now_millis - seen > PORTAL_SESSION_REFRESH_AFTER_SECONDS * 1000,
        None => true,
    }
}

/// When a session last used at `last_seen_at` lapses (ISO); `now_millis` stands
/// in when it does not parse.
pub fn session_expires_at(last_seen_at: &str, now_millis: i64) -> String {
    let seen = millis_of(last_seen_at).unwrap_or(now_millis);
    let ttl = i64::try_from(PORTAL_SESSION_TTL_SECONDS).unwrap_or(0) * 1000;
    crate::js::iso_from_millis(seen + ttl).unwrap_or_default()
}

// ── Visibility ──────────────────────────────────────────────────────────────

/// `PORTAL_APPROVAL_SUBJECTS`.
pub const PORTAL_APPROVAL_SUBJECTS: [&str; 2] = ["deliverable", "change_request"];

/// The colours of a report (`PORTAL_STATUS_COLOURS`).
pub const PORTAL_STATUS_COLOURS: [&str; 4] = ["green", "amber", "red", "grey"];

/// `PORTAL_DECISIONS`: the answers a contact can give.
pub const PORTAL_DECISIONS: [&str; 3] = ["approved", "rejected", "info_requested"];

/// `PORTAL_LOCALES`.
pub const PORTAL_LOCALES: [&str; 2] = ["en", "nl"];

/// Digits in the emailed sign-in code.
pub const PORTAL_CODE_LENGTH: usize = 6;

/// The subjects of approvals the portal shows.
pub fn is_portal_approval_subject(subject_type: &str) -> bool {
    PORTAL_APPROVAL_SUBJECTS.contains(&subject_type)
}

fn pass(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// A timestamp of a row (already ISO), or null.
fn iso(row: &Value, key: &str) -> Value {
    match row.get(key) {
        Some(Value::String(text)) => Value::String(text.clone()),
        _ => Value::Null,
    }
}

fn str_of<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

// ── Codes and names ─────────────────────────────────────────────────────────

/// `D1`.
pub fn deliverable_code(number: i64) -> String {
    format!("D{number}")
}

/// `CR-8`.
pub fn change_request_code(number: i64) -> String {
    format!("CR-{number}")
}

/// A document file's name without its `.docx` suffix.
pub fn document_name(file_name: &str) -> String {
    // The suffix is ASCII, so the last five bytes are a whole suffix when they match.
    match file_name.len().checked_sub(DOCX.len()) {
        Some(cut)
            if file_name.is_char_boundary(cut) && file_name[cut..].eq_ignore_ascii_case(DOCX) =>
        {
            file_name[..cut].to_owned()
        }
        _ => file_name.to_owned(),
    }
}

const DOCX: &str = ".docx";

/// The sender name shown when the sender is not a known member.
pub const PORTAL_TEAM_SENDER: &str = "Project team";

// ── Progress and milestones ─────────────────────────────────────────────────

/// `Number.parseFloat(text)`: the longest numeric prefix; `None` is NaN.
fn parse_float(text: &str) -> Option<f64> {
    let text = js_trim(text);
    let bytes = text.as_bytes();
    let mut end = 0;
    if matches!(bytes.first(), Some(b'+' | b'-')) {
        end = 1;
    }
    let digits_start = end;
    while bytes.get(end).is_some_and(u8::is_ascii_digit) {
        end += 1;
    }
    let mut seen_digits = end > digits_start;
    if bytes.get(end) == Some(&b'.') {
        let fraction_start = end + 1;
        let mut after = fraction_start;
        while bytes.get(after).is_some_and(u8::is_ascii_digit) {
            after += 1;
        }
        if after > fraction_start || seen_digits {
            seen_digits |= after > fraction_start;
            end = after;
        }
    }
    if !seen_digits {
        return None;
    }
    // An exponent only counts with digits after it.
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let mut after = end + 1;
        if matches!(bytes.get(after), Some(b'+' | b'-')) {
            after += 1;
        }
        let exp_start = after;
        while bytes.get(after).is_some_and(u8::is_ascii_digit) {
            after += 1;
        }
        if after > exp_start {
            end = after;
        }
    }
    text[..end].trim_end_matches('.').parse::<f64>().ok()
}

/// A `numeric` progress as a number from 0 to 100; 0 when it is missing or not
/// a number (`progressPercent`).
pub fn progress_percent(value: Option<&Value>) -> Value {
    let parsed = match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(text)) => parse_float(text),
        _ => None,
    };
    let n = parsed.filter(|n| n.is_finite()).unwrap_or(0.0);
    number_value(n.clamp(0.0, 100.0))
}

pub const MILESTONE_COMPLETED_STATUS: &str = "completed";

/// `presentMilestone`.
pub fn present_milestone(row: &Value) -> Value {
    json!({
        "id": pass(row, "id"),
        "name": pass(row, "name"),
        "dueDate": pass(row, "dueDate"),
        "completed": str_of(row, "status") == Some(MILESTONE_COMPLETED_STATUS),
    })
}

/// The next milestone: the earliest one that is not completed, ties by id. An
/// overdue milestone that is still open counts, because it is what the project
/// is waiting for.
pub fn next_milestone_of(rows: &[Value]) -> Value {
    let mut open: Vec<&Value> = rows
        .iter()
        .filter(|row| str_of(row, "status") != Some(MILESTONE_COMPLETED_STATUS))
        .collect();
    open.sort_by(|a, b| {
        let at = |row: &Value| str_of(row, "dueDate").and_then(millis_of).unwrap_or(0);
        at(a).cmp(&at(b)).then_with(|| {
            str_of(a, "id")
                .unwrap_or_default()
                .cmp(str_of(b, "id").unwrap_or_default())
        })
    });
    match open.first() {
        Some(next) => json!({
            "id": pass(next, "id"),
            "name": pass(next, "name"),
            "description": pass(next, "description"),
            "dueDate": pass(next, "dueDate"),
        }),
        None => Value::Null,
    }
}

// ── Reports ─────────────────────────────────────────────────────────────────

fn colour_of(value: Option<&Value>) -> Value {
    match value.and_then(Value::as_str) {
        Some(colour) if PORTAL_STATUS_COLOURS.contains(&colour) => json!(colour),
        _ => Value::Null,
    }
}

fn item_texts(items: Option<&Value>) -> Vec<Value> {
    items
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .map(js_trim)
                        .unwrap_or_default()
                })
                .filter(|text| !text.is_empty())
                .map(|text| json!(text))
                .collect()
        })
        .unwrap_or_default()
}

/// A published report as the client sees it: the colours without the reasons
/// behind them, the summary, and the done and next lists as text. The report's
/// `snapshot` (risks, figures) is never read.
pub fn present_report(row: &Value, published_by_name: Option<&str>) -> Value {
    let areas: Vec<Value> = row
        .get("areas")
        .and_then(Value::as_array)
        .map(|areas| {
            areas
                .iter()
                .filter_map(|area| {
                    let colour = colour_of(area.get("colour"));
                    (!colour.is_null()).then(|| {
                        let mut out = Map::new();
                        if let Some(key) = area.get("key") {
                            out.insert("key".to_owned(), key.clone());
                        }
                        out.insert("colour".to_owned(), colour);
                        Value::Object(out)
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "id": pass(row, "id"),
        "period": pass(row, "period"),
        "publishedAt": str_of(row, "publishedAt").unwrap_or("1970-01-01T00:00:00.000Z"),
        "publishedByName": published_by_name,
        "overall": colour_of(row.get("overall")),
        "areas": areas,
        "summary": pass(row, "summary"),
        "done": item_texts(row.get("done")),
        "next": item_texts(row.get("next")),
    })
}

// ── Deliverables and changes ────────────────────────────────────────────────

pub fn present_deliverable(row: &Value) -> Value {
    json!({
        "id": pass(row, "id"),
        "code": deliverable_code(row.get("number").and_then(Value::as_i64).unwrap_or(0)),
        "title": pass(row, "title"),
        "status": pass(row, "status"),
        "plannedEnd": iso(row, "plannedEnd"),
        "acceptedAt": iso(row, "acceptedAt"),
    })
}

pub fn present_change_request(row: &Value, currency: Option<&str>) -> Value {
    json!({
        "id": pass(row, "id"),
        "code": change_request_code(row.get("number").and_then(Value::as_i64).unwrap_or(0)),
        "title": pass(row, "title"),
        "status": pass(row, "status"),
        "costDelta": pass(row, "costDelta"),
        "currency": currency,
        "scheduleDeltaDays": pass(row, "scheduleDeltaDays"),
        "decidedAt": iso(row, "decidedAt"),
    })
}

// ── Approvals ───────────────────────────────────────────────────────────────

/// What `presentApproval` reads.
pub struct ApprovalView<'a> {
    pub approval: &'a Value,
    pub project_name: &'a str,
    pub currency: Option<&'a str>,
    pub requested_by_name: Option<&'a str>,
    pub actionable: bool,
    pub deliverable: Option<&'a Value>,
    pub change: Option<&'a Value>,
}

/// One review as the portal shows it. `None` when the subject is not one the
/// portal shows, or its deliverable or change request is gone.
pub fn present_approval(view: &ApprovalView<'_>) -> Option<Value> {
    let approval = view.approval;
    let subject_type = str_of(approval, "subjectType")?;
    let project_id = str_of(approval, "projectId").filter(|id| !id.is_empty())?;
    if !is_portal_approval_subject(subject_type) {
        return None;
    }
    let mut out = Map::new();
    let mut put = |key: &str, value: Value| {
        out.insert(key.to_owned(), value);
    };
    put("id", pass(approval, "id"));
    put("projectId", json!(project_id));
    put("projectName", json!(view.project_name));
    put("subjectType", json!(subject_type));
    put("subjectId", pass(approval, "subjectId"));
    put("roleLabel", pass(approval, "roleLabel"));
    put("step", pass(approval, "step"));
    put("dueAt", iso(approval, "dueAt"));
    put("requestedAt", iso(approval, "createdAt"));
    put("requestedByName", json!(view.requested_by_name));
    put("actionable", json!(view.actionable));
    if subject_type == "deliverable" {
        let deliverable = view.deliverable?;
        let criteria: Vec<Value> = deliverable
            .get("acceptanceCriteria")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|c| {
                        json!({
                            "text": pass(c, "text"),
                            "met": c.get("met") == Some(&Value::Bool(true)),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        put(
            "code",
            json!(deliverable_code(
                deliverable
                    .get("number")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            )),
        );
        put("title", pass(deliverable, "title"));
        put("description", pass(deliverable, "description"));
        put("acceptanceCriteria", Value::Array(criteria));
        put("impact", Value::Null);
        return Some(Value::Object(out));
    }
    let change = view.change?;
    let new_go_live = change
        .get("planChanges")
        .and_then(|plan| plan.get("goLive"))
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or(Value::Null);
    put(
        "code",
        json!(change_request_code(
            change.get("number").and_then(Value::as_i64).unwrap_or(0)
        )),
    );
    put("title", pass(change, "title"));
    put("description", pass(change, "description"));
    put("acceptanceCriteria", json!([]));
    put(
        "impact",
        json!({
            "costDelta": pass(change, "costDelta"),
            "currency": view.currency,
            "scheduleDeltaDays": pass(change, "scheduleDeltaDays"),
            "newGoLive": new_go_live,
        }),
    );
    Some(Value::Object(out))
}

// ── Messages, files, documents ──────────────────────────────────────────────

pub const PORTAL_MESSAGE_SOURCE: &str = "portal";

/// The metadata of a message a client wrote in the portal
/// (`{ source, contactId, contactName }`).
pub fn portal_message_metadata(contact_id: &str, contact_name: &str) -> Value {
    json!({
        "source": PORTAL_MESSAGE_SOURCE,
        "contactId": contact_id,
        "contactName": contact_name,
    })
}

fn text_of(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !js_trim(text).is_empty())
}

/// A message of the thread. A client's message carries its sender in
/// `metadata` (`source: 'portal'`); a team member's is named from
/// `member_names` (member user id to name), and never shows more than the name.
pub fn present_message<S: BuildHasher>(
    row: &Value,
    member_names: &HashMap<String, String, S>,
    contact_ids: &[String],
) -> Value {
    let metadata = row.get("metadata");
    let from_client = metadata
        .and_then(|m| m.get("source"))
        .and_then(Value::as_str)
        == Some(PORTAL_MESSAGE_SOURCE);
    let contact_id = text_of(metadata.and_then(|m| m.get("contactId")));
    let sender_name = if from_client {
        text_of(metadata.and_then(|m| m.get("contactName")))
            .unwrap_or(PORTAL_TEAM_SENDER)
            .to_owned()
    } else {
        str_of(row, "senderId")
            .and_then(|id| member_names.get(id))
            .cloned()
            .unwrap_or_else(|| PORTAL_TEAM_SENDER.to_owned())
    };
    let mine = from_client && contact_id.is_some_and(|id| contact_ids.iter().any(|c| c == id));
    json!({
        "id": pass(row, "id"),
        "projectId": str_of(row, "projectId").unwrap_or_default(),
        "senderName": sender_name,
        "fromClient": from_client,
        "mine": mine,
        "message": pass(row, "message"),
        "createdAt": iso(row, "createdAt"),
        "editedAt": iso(row, "editedAt"),
    })
}

pub fn present_file<S: BuildHasher>(
    row: &Value,
    member_names: &HashMap<String, String, S>,
) -> Value {
    json!({
        "id": pass(row, "id"),
        "name": pass(row, "fileName"),
        "mimeType": pass(row, "mimeType"),
        "size": pass(row, "fileSize"),
        "uploadedByName": str_of(row, "uploadedById").and_then(|id| member_names.get(id)),
        "createdAt": iso(row, "createdAt"),
    })
}

pub fn present_document(row: &Value) -> Value {
    json!({
        "id": pass(row, "id"),
        "name": document_name(str_of(row, "fileName").unwrap_or_default()),
        "createdAt": iso(row, "createdAt"),
        "updatedAt": iso(row, "updatedAt"),
    })
}

/// `encodeURIComponent`.
fn encode_uri_component(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// The `Content-Disposition` of a download: always an attachment, with the name
/// in both forms.
pub fn attachment_disposition(file_name: &str, fallback_id: &str) -> String {
    let name = if file_name.is_empty() {
        format!("file-{fallback_id}")
    } else {
        file_name.to_owned()
    };
    let safe = name.replace('"', "");
    format!(
        "attachment; filename=\"{safe}\"; filename*=UTF-8''{}",
        encode_uri_component(&safe)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn keys_and_hash_input() {
        assert_eq!(
            portal_code_key("ws_1", " Femke@Client.test "),
            "pportal:code:ws_1:femke@client.test"
        );
        assert_eq!(portal_session_key("abc"), "pportal:sess:abc");
        assert_eq!(portal_slug_key("acme"), "pportal:slug:acme");
        assert_eq!(
            portal_code_input("ws_1", "A@B.c", "123456"),
            "ws_1:a@b.c:123456"
        );
    }

    #[test]
    fn records_serialise_in_the_order_the_worker_writes_them() {
        let challenge = PortalChallenge {
            code_hash: "h".into(),
            email: "a@b.c".into(),
            workspace_id: "ws".into(),
            contact_ids: vec!["pe_1".into()],
            attempts: 0,
        };
        assert_eq!(
            serde_json::to_string(&challenge).expect("json"),
            r#"{"codeHash":"h","email":"a@b.c","workspaceId":"ws","contactIds":["pe_1"],"attempts":0}"#
        );
        let session = PortalSessionRecord {
            workspace_id: "ws".into(),
            clerk_org_id: None,
            workspace_slug: "acme".into(),
            workspace_name: "Acme".into(),
            email: "a@b.c".into(),
            contact_ids: vec![],
            created_at: "2026-11-01T08:00:00.000Z".into(),
            last_seen_at: "2026-11-01T08:00:00.000Z".into(),
        };
        assert_eq!(
            serde_json::to_string(&session).expect("json"),
            r#"{"workspaceId":"ws","clerkOrgId":null,"workspaceSlug":"acme","workspaceName":"Acme","email":"a@b.c","contactIds":[],"createdAt":"2026-11-01T08:00:00.000Z","lastSeenAt":"2026-11-01T08:00:00.000Z"}"#
        );
    }

    #[test]
    fn sessions_refresh_after_a_day_and_expire_after_thirty() {
        let seen = "2026-11-01T08:00:00.000Z";
        let seen_ms = millis_of(seen).expect("ms");
        assert!(!session_needs_refresh(seen, seen_ms + 86_400_000));
        assert!(session_needs_refresh(seen, seen_ms + 86_400_001));
        assert!(session_needs_refresh("nope", seen_ms));
        assert_eq!(
            session_expires_at(seen, seen_ms),
            "2026-12-01T08:00:00.000Z"
        );
    }

    #[test]
    fn progress_is_clamped_and_never_nan() {
        let pct = |v: Value| progress_percent(Some(&v));
        assert_eq!(pct(json!("58.00")), json!(58));
        assert_eq!(pct(json!("12.5")), json!(12.5));
        assert_eq!(pct(json!("120")), json!(100));
        assert_eq!(pct(json!("-3")), json!(0));
        assert_eq!(pct(json!("abc")), json!(0));
        assert_eq!(pct(json!(41)), json!(41));
        assert_eq!(progress_percent(None), json!(0));
        assert_eq!(pct(json!("7%")), json!(7));
    }

    #[test]
    fn codes_and_names() {
        assert_eq!(deliverable_code(1), "D1");
        assert_eq!(change_request_code(8), "CR-8");
        assert_eq!(document_name("Beta plan.docx"), "Beta plan");
        assert_eq!(document_name("Beta plan.DOCX"), "Beta plan");
        assert_eq!(document_name("notes.pdf"), "notes.pdf");
    }

    #[test]
    fn the_next_milestone_is_the_earliest_open_one() {
        let rows = vec![
            json!({"id":"ms_done","name":"Alpha","description":null,"dueDate":"2026-10-01T00:00:00.000Z","status":"completed"}),
            json!({"id":"ms_b","name":"B","description":"d","dueDate":"2026-12-01T00:00:00.000Z","status":"pending"}),
            json!({"id":"ms_a","name":"A","description":null,"dueDate":"2026-12-01T00:00:00.000Z","status":"in_progress"}),
        ];
        let next = next_milestone_of(&rows);
        assert_eq!(next["id"], "ms_a");
        assert_eq!(next["dueDate"], "2026-12-01T00:00:00.000Z");
        assert!(next_milestone_of(&rows[..1]).is_null());
        assert_eq!(present_milestone(&rows[0])["completed"], true);
        assert_eq!(present_milestone(&rows[1])["completed"], false);
    }

    #[test]
    fn a_report_shows_colours_and_text_only() {
        let row = json!({
            "id": "rpt_pub", "period": "2026-W45", "publishedAt": "2026-11-02T08:00:00.000Z",
            "overall": "amber",
            "areas": [
                {"key":"schedule","colour":"amber","reason":"INTERNAL reason","auto":false},
                {"key":"budget","colour":"purple"}
            ],
            "summary": "Going well",
            "done": [{"text":" Login "},{"text":"  "},{}],
            "next": [{"text":"Ordering"}],
            "snapshot": {"cost": 12345}
        });
        let report = present_report(&row, Some("Sanne Jansen"));
        assert_eq!(
            report,
            json!({
                "id": "rpt_pub", "period": "2026-W45", "publishedAt": "2026-11-02T08:00:00.000Z",
                "publishedByName": "Sanne Jansen", "overall": "amber",
                "areas": [{"key":"schedule","colour":"amber"}],
                "summary": "Going well", "done": ["Login"], "next": ["Ordering"]
            })
        );
        let bare = present_report(&json!({"id":"r","period":"2026-11","overall":"nope"}), None);
        assert_eq!(bare["publishedAt"], "1970-01-01T00:00:00.000Z");
        assert!(bare["overall"].is_null());
        assert_eq!(bare["areas"], json!([]));
    }

    #[test]
    fn deliverables_and_changes_carry_codes() {
        let d = present_deliverable(&json!({
            "id":"del_1","number":1,"title":"Account","status":"in_progress",
            "plannedEnd":null,"acceptedAt":null,"clientVisible":true,"ownerId":"u"
        }));
        assert_eq!(
            d,
            json!({"id":"del_1","code":"D1","title":"Account","status":"in_progress","plannedEnd":null,"acceptedAt":null})
        );
        let c = present_change_request(
            &json!({"id":"cr_8","number":8,"title":"Pay in 3","status":"awaiting_approval","costDelta":"7500.00","scheduleDeltaDays":6,"decidedAt":null}),
            Some("EUR"),
        );
        assert_eq!(c["code"], "CR-8");
        assert_eq!(c["costDelta"], "7500.00");
        assert_eq!(c["currency"], "EUR");
        assert_eq!(c["scheduleDeltaDays"], 6);
    }

    #[test]
    fn approvals_are_shown_for_deliverables_and_change_requests_only() {
        let base = json!({
            "id":"apr_1","projectId":"prj_p1","subjectType":"deliverable","subjectId":"del_1",
            "roleLabel":null,"step":2,"dueAt":null,"createdAt":"2026-11-01T08:00:00.000Z"
        });
        let deliverable = json!({
            "number":1,"title":"Account and login","description":"Ready",
            "acceptanceCriteria":[{"text":"Sign in works","met":true,"metAt":null},{"text":"Dutch texts","met":false,"metAt":null}]
        });
        let view = ApprovalView {
            approval: &base,
            project_name: "Relaunch",
            currency: Some("EUR"),
            requested_by_name: Some("Sanne Jansen"),
            actionable: true,
            deliverable: Some(&deliverable),
            change: None,
        };
        let shown = present_approval(&view).expect("shown");
        assert_eq!(shown["code"], "D1");
        assert_eq!(
            shown["acceptanceCriteria"],
            json!([{"text":"Sign in works","met":true},{"text":"Dutch texts","met":false}])
        );
        assert!(shown["impact"].is_null());
        assert_eq!(shown["requestedAt"], "2026-11-01T08:00:00.000Z");
        // A deliverable that is gone hides the review.
        assert!(
            present_approval(&ApprovalView {
                deliverable: None,
                ..view
            })
            .is_none()
        );

        let cr = json!({"id":"apr_2","projectId":"prj_p1","subjectType":"change_request","subjectId":"cr_8","roleLabel":"Board","step":1,"dueAt":"2026-11-10T00:00:00.000Z","createdAt":"2026-11-01T08:00:00.000Z"});
        let change = json!({"number":8,"title":"Pay in 3","description":"Split","costDelta":"7500.00","scheduleDeltaDays":6,"planChanges":{"goLive":"2027-01-25"}});
        let shown = present_approval(&ApprovalView {
            approval: &cr,
            project_name: "Relaunch",
            currency: Some("EUR"),
            requested_by_name: None,
            actionable: true,
            deliverable: None,
            change: Some(&change),
        })
        .expect("shown");
        assert_eq!(shown["code"], "CR-8");
        assert_eq!(shown["acceptanceCriteria"], json!([]));
        assert_eq!(
            shown["impact"],
            json!({"costDelta":"7500.00","currency":"EUR","scheduleDeltaDays":6,"newGoLive":"2027-01-25"})
        );

        let other = json!({"id":"a","projectId":"p","subjectType":"gate","subjectId":"g","step":1,"createdAt":"2026-11-01T08:00:00.000Z"});
        assert!(
            present_approval(&ApprovalView {
                approval: &other,
                project_name: "p",
                currency: None,
                requested_by_name: None,
                actionable: true,
                deliverable: None,
                change: None,
            })
            .is_none()
        );
        assert!(is_portal_approval_subject("change_request"));
        assert!(!is_portal_approval_subject("gate"));
    }

    #[test]
    fn messages_name_their_sender() {
        let members = names(&[("user_sanne", "Sanne Jansen")]);
        let mine = vec!["pe_femke".to_owned()];
        let team = present_message(
            &json!({"id":"pm_team","projectId":"prj_p1","senderId":"user_sanne","message":"D1 is ready","metadata":null,"createdAt":"2026-11-01T08:00:00.000Z","editedAt":null}),
            &members,
            &mine,
        );
        assert_eq!(team["senderName"], "Sanne Jansen");
        assert_eq!(team["fromClient"], false);
        assert_eq!(team["mine"], false);
        let unknown = present_message(
            &json!({"id":"m","projectId":null,"senderId":"user_x","message":"hi","createdAt":"2026-11-01T08:00:00.000Z"}),
            &members,
            &mine,
        );
        assert_eq!(unknown["senderName"], PORTAL_TEAM_SENDER);
        assert_eq!(unknown["projectId"], "");
        let client = present_message(
            &json!({"id":"m2","projectId":"prj_p1","senderId":"pe_femke","message":"Thanks!","metadata":portal_message_metadata("pe_femke","Femke de Graaf"),"createdAt":"2026-11-01T08:00:00.000Z","editedAt":null}),
            &members,
            &mine,
        );
        assert_eq!(client["senderName"], "Femke de Graaf");
        assert_eq!(client["fromClient"], true);
        assert_eq!(client["mine"], true);
        let other = present_message(
            &json!({"id":"m3","projectId":"prj_p1","senderId":"pe_other","message":"x","metadata":portal_message_metadata("pe_other","  "),"createdAt":"2026-11-01T08:00:00.000Z"}),
            &members,
            &mine,
        );
        assert_eq!(other["senderName"], PORTAL_TEAM_SENDER);
        assert_eq!(other["mine"], false);
    }

    #[test]
    fn files_and_documents_show_names_only() {
        let members = names(&[("user_sanne", "Sanne Jansen")]);
        let file = present_file(
            &json!({"id":"pf","fileName":"plan.pdf","mimeType":"application/pdf","fileSize":10,"uploadedById":"user_sanne","createdAt":"2026-11-01T08:00:00.000Z","storagePath":"k"}),
            &members,
        );
        assert_eq!(
            file,
            json!({"id":"pf","name":"plan.pdf","mimeType":"application/pdf","size":10,"uploadedByName":"Sanne Jansen","createdAt":"2026-11-01T08:00:00.000Z"})
        );
        let doc = present_document(
            &json!({"id":"f_doc","fileName":"Beta plan.docx","createdAt":"2026-11-01T08:00:00.000Z","updatedAt":"2026-11-02T08:00:00.000Z"}),
        );
        assert_eq!(doc["name"], "Beta plan");
    }

    #[test]
    fn downloads_are_always_attachments() {
        assert_eq!(
            attachment_disposition("plan \"v2\".pdf", "pf_1"),
            "attachment; filename=\"plan v2.pdf\"; filename*=UTF-8''plan%20v2.pdf"
        );
        assert_eq!(
            attachment_disposition("", "pf_1"),
            "attachment; filename=\"file-pf_1\"; filename*=UTF-8''file-pf_1"
        );
    }
}
