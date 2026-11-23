//! `/v1/mail-threads` (`routes/v1/mail-threads/index.ts`): conversations,
//! the way the WeldMail inbox shows them. A thread has no table: its key is
//! `COALESCE(threadId, id)` within one account. The list's opaque cursor is
//! a keyset cursor; a legacy offset cursor (`o:<n>`) a client already holds
//! still reads. Like the inbox, a list read also returns snoozed mail whose
//! time has come.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use http::HeaderMap;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::EMAIL_UPDATED;
use weldsuite_mail_domain::access::can_open_account;
use weldsuite_mail_domain::labels::{apply_label_to_thread, is_location_label, normalize_label};
use weldsuite_mail_domain::threads::{
    ThreadCursor, ThreadQuery, decode_thread_cursor, encode_thread_cursor, list_threads,
    mark_thread_read, thread_by_key,
};

use super::messages::{empty_page, list_accounts};
use super::schemas::{ACCOUNT_QUERY, LIST_THREADS, THREAD_LABELS, THREAD_READ};
use super::{MailCaller, public_message, strings};
use crate::ExternalApiState;
use crate::crud::{Answer, Fail, ok};
use crate::list::Page;
use crate::session::{bad_request, not_found};
use crate::zod;

type S = State<ExternalApiState>;

/// `decodeOffsetCursor(cursor)`: the offset in a legacy `o:<offset>`
/// cursor, `None` for anything else.
fn decode_offset_cursor(raw: &str) -> Option<i64> {
    let text = weldsuite_kit::cursor::atob(raw)?;
    let digits = text.strip_prefix("o:")?;
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// `decodeListCursor(raw)`: a keyset position, a legacy offset, or (for a
/// string that is neither) an invalid cursor.
fn decode_list_cursor(raw: Option<&str>) -> Result<(Option<ThreadCursor>, Option<i64>), Fail> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Ok((None, Some(0)));
    };
    if let Some(cursor) = decode_thread_cursor(Some(raw)) {
        return Ok((Some(cursor), None));
    }
    match decode_offset_cursor(raw) {
        Some(offset) => Ok((None, Some(offset))),
        None => Err(bad_request("Invalid cursor").into()),
    }
}

/// `GET /`.
pub(super) async fn list(mail: MailCaller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_THREADS, raw.as_deref())?;
    let (cursor, offset) = decode_list_cursor(q.get("cursor").and_then(Value::as_str))?;
    let account = q.text("accountId").map(str::to_owned);
    let account_ids = list_accounts(&mail, account.as_deref()).await?;
    if account_ids.is_empty() {
        return empty_page();
    }
    let text = |key: &str| q.get(key).and_then(Value::as_str).map(str::to_owned);
    #[allow(clippy::cast_possible_truncation)] // 1..=100
    let page_size = q
        .get("limit")
        .and_then(Value::as_f64)
        .map_or(25, |n| n.floor() as i64);
    let query = ThreadQuery {
        label_slug: text("label").unwrap_or_else(|| "inbox".to_owned()),
        account_id: (account_ids.len() == 1).then(|| account_ids[0].clone()),
        search: text("search"),
        from: text("from"),
        to: text("to"),
        subject: text("subject"),
        has_attachment: (q.get("hasAttachments").and_then(Value::as_str) == Some("true"))
            .then_some(true),
        exclude_words: None,
        page_size: Some(page_size),
        offset: if cursor.is_some() { None } else { offset },
        cursor,
    };
    let page = list_threads(mail.db(), &account_ids, &query, OffsetDateTime::now_utc()).await?;
    let rows: Vec<Value> = page
        .threads
        .into_iter()
        .map(|mut summary| {
            if let Some(object) = summary.as_object_mut() {
                object.remove("messages");
            }
            summary
        })
        .collect();
    let next = page.next_cursor.as_ref().map(encode_thread_cursor);
    Ok(axum::response::IntoResponse::into_response(
        Page {
            rows,
            total: page.total_count,
            has_more: next.is_some(),
            cursor: next.map_or(Value::Null, Value::String),
        }
        .respond(),
    ))
}

/// 404 for a thread in a mailbox out of reach.
async fn open_or_404(mail: &MailCaller, account: &str, thread_key: &str) -> Result<(), Fail> {
    if can_open_account(mail.db(), account, &mail.principal).await? {
        Ok(())
    } else {
        Err(not_found("MailThread", thread_key).into())
    }
}

/// `GET /:threadKey?accountId=`: the conversation with its messages.
pub(super) async fn detail(
    mail: MailCaller,
    Path(thread_key): Path<String>,
    RawQuery(raw): RawQuery,
) -> Answer {
    let q = zod::query(&ACCOUNT_QUERY, raw.as_deref())?;
    let account = q.text("accountId").unwrap_or_default().to_owned();
    open_or_404(&mail, &account, &thread_key).await?;
    let Some(mut thread) = thread_by_key(mail.db(), &account, &thread_key).await? else {
        return Err(not_found("MailThread", &thread_key).into());
    };
    let messages: Vec<Value> = thread["messages"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(public_message)
        .collect();
    thread["messages"] = Value::Array(messages);
    ok(thread)
}

/// The `email` event a thread change publishes.
fn publish_thread(state: &ExternalApiState, mail: &MailCaller, thread_key: &str, account: &str) {
    mail.caller.publish(
        &state.events,
        EMAIL_UPDATED,
        thread_key,
        json!({
            "id": thread_key,
            "accountId": account,
            "subject": null,
            "from": null,
            "to": null,
            "conversationId": thread_key,
        }),
    );
}

/// `POST /:threadKey/read`: every message read (or unread).
pub(super) async fn read(
    State(state): S,
    mail: MailCaller,
    Path(thread_key): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&THREAD_READ, &headers, &body)?;
    let account = parsed.text("accountId").unwrap_or_default().to_owned();
    let is_read = parsed
        .get("isRead")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    open_or_404(&mail, &account, &thread_key).await?;
    let updated = mark_thread_read(
        mail.db(),
        &account,
        &thread_key,
        is_read,
        OffsetDateTime::now_utc(),
    )
    .await?;
    if !updated.is_empty() {
        publish_thread(&state, &mail, &thread_key, &account);
    }
    ok(json!({
        "threadId": thread_key,
        "accountId": account,
        "isRead": is_read,
        "updatedCount": updated.len(),
    }))
}

/// `POST /:threadKey/labels`: labels on every message. Unlike a single
/// message, adding a location (`TRASH`, `ARCHIVE`, `SPAM`, `INBOX`) moves
/// the whole thread there.
pub(super) async fn labels(
    State(state): S,
    mail: MailCaller,
    Path(thread_key): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&THREAD_LABELS, &headers, &body)?;
    let account = parsed.text("accountId").unwrap_or_default().to_owned();
    open_or_404(&mail, &account, &thread_key).await?;
    let changes: Vec<(String, bool)> = strings(&parsed, "add")
        .iter()
        .map(|name| (normalize_label(name), true))
        .chain(
            strings(&parsed, "remove")
                .iter()
                .map(|name| (normalize_label(name), false)),
        )
        .collect();
    if let Some((name, _)) = changes
        .iter()
        .find(|(name, add)| !add && is_location_label(name))
    {
        return Err(bad_request(format!(
            "{name} is a location: add the location to move the thread there instead."
        ))
        .into());
    }
    let now = OffsetDateTime::now_utc();
    let mut affected = 0;
    for (label, add) in &changes {
        let ids = apply_label_to_thread(mail.db(), &account, &thread_key, label, *add, now).await?;
        affected = affected.max(ids.len());
    }
    if affected == 0 {
        return Err(not_found("MailThread", &thread_key).into());
    }
    publish_thread(&state, &mail, &thread_key, &account);
    ok(json!({ "threadId": thread_key, "accountId": account, "affected": affected }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_offset_cursors_still_read() {
        assert_eq!(decode_offset_cursor("bzoyNQ"), Some(25));
        assert_eq!(decode_offset_cursor("bzoyNQ=="), Some(25));
        assert_eq!(decode_offset_cursor("not-a-cursor"), None);
        assert!(decode_list_cursor(Some("not-a-cursor")).is_err());
        assert!(matches!(decode_list_cursor(None), Ok((None, Some(0)))));
    }
}
