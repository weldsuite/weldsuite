//! `/api/mail/subscriptions` (`routes/mail-subscriptions.ts`,
//! `services/mail-subscriptions.ts`, `@weldsuite/email/list-unsubscribe`):
//! the newsletters a personal mailbox receives, the scan of its stored
//! mail that finds them, and unsubscribing (RFC 8058 one-click POST, the
//! unsubscribe mail, or the link).

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_kit::ApiError;
use weldsuite_kit::cursor::decode_uri_component;
use weldsuite_kit::validation::Presence;
use weldsuite_mail_domain::outbound::OutboundKind;
use weldsuite_mail_inbound::unsubscribe::parse_list_unsubscribe;
use weldsuite_ports::HttpRequest;

use crate::PersonalState;
use crate::caller::{Caller, Failure, answer, data, rows, validate, validate_query};
use crate::js::{iso, js_trim, now_iso, now_ms, stamp_ms, utf16_prefix};
use crate::mail_send::{Compose, SendContext, SendError, require_account, send_and_persist};

pub(crate) fn routes() -> Router<Arc<PersonalState>> {
    Router::new()
        .route("/api/mail/subscriptions", get(list))
        .route("/api/mail/subscriptions/scan", post(scan))
        .route(
            "/api/mail/subscriptions/{id}/unsubscribe",
            post(unsubscribe),
        )
}

/// `SCAN_WINDOW_DAYS`, `SCAN_MESSAGE_LIMIT`.
const SCAN_WINDOW_DAYS: i64 = 180;
const SCAN_MESSAGE_LIMIT: i64 = 2000;

/// The mailbox check: an unknown mailbox is the route's 404.
async fn mailbox(db: &weldsuite_db::PgPool, account: &str, mailbox: &str) -> Result<(), Failure> {
    match require_account(db, account, mailbox).await {
        Ok(_) => Ok(()),
        Err(SendError::Mail { .. }) => {
            Err(ApiError::not_found("Mail account", Some(mailbox)).into())
        }
        Err(SendError::Internal(error)) => Err(Failure::Internal(error)),
    }
}

/// `GET /api/mail/subscriptions?accountId=&status=`.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), |issues, q| {
        (
            issues
                .text(q, "accountId", Presence::Required, Some(1), None)
                .into_option()
                .unwrap_or_default(),
            issues
                .choice(q, "status", Presence::Optional, &["active", "unsubscribed"])
                .into_option(),
        )
    }) {
        Ok(query) => query,
        Err(response) => return response,
    };
    let (mailbox_id, status) = query;
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        mailbox(db, &account, &mailbox_id).await?;
        let found: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(s) from personal_mail_subscriptions s
             where s.personal_account_id = $1 and s.account_id = $2
               and ($3::text is null or s.status = $3)
             order by s.last_received_at desc limit 1000",
        )
        .bind(&account)
        .bind(&mailbox_id)
        .bind(&status)
        .fetch_all(db)
        .await?;
        Ok(data(Value::Array(rows(found))))
    }
    .await;
    answer(result, "Failed to list subscriptions")
}

/// `parseRawHeaders(rawMessage)`: the header block, unfolded, names
/// lower-cased; the first of a repeated header wins.
fn parse_raw_headers(raw: &str) -> Vec<(String, String)> {
    // `/\r?\n\r?\n/`: the first blank line.
    let end = raw
        .match_indices('\n')
        .find_map(|(at, _)| {
            let rest = &raw[at + 1..];
            (rest.starts_with('\n') || rest.starts_with("\r\n")).then(|| {
                if at > 0 && raw.as_bytes()[at - 1] == b'\r' {
                    at - 1
                } else {
                    at
                }
            })
        })
        .unwrap_or(raw.len());
    let block = &raw[..end];
    // `.replace(/\r?\n[ \t]+/g, ' ')`.
    let mut unfolded = String::with_capacity(block.len());
    let mut chars = block.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        let newline = if c == '\r' && block[at + 1..].starts_with('\n') {
            Some(at + 2)
        } else if c == '\n' {
            Some(at + 1)
        } else {
            None
        };
        if let Some(after) = newline
            && block[after..].starts_with([' ', '\t'])
        {
            unfolded.push(' ');
            let skip = block[after..].len() - block[after..].trim_start_matches([' ', '\t']).len();
            let resume = after + skip;
            while chars.peek().is_some_and(|(i, _)| *i < resume) {
                chars.next();
            }
            continue;
        }
        unfolded.push(c);
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in unfolded.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(idx) = line.find(':').filter(|idx| *idx > 0) else {
            continue;
        };
        let name = js_trim(&line[..idx]).to_lowercase();
        if !headers.iter().any(|(n, _)| *n == name) {
            headers.push((name, js_trim(&line[idx + 1..]).to_owned()));
        }
    }
    headers
}

/// `SubscriptionAggregate`.
struct Aggregate {
    sender_email: String,
    sender_name: Option<String>,
    sender_domain: Option<String>,
    list_id: Option<String>,
    url: Option<String>,
    mailto: Option<String>,
    one_click: bool,
    message_count: i64,
    last_subject: Option<String>,
    first_received_at: i64,
    last_received_at: i64,
}

/// `POST /api/mail/subscriptions/scan` (`scanSubscriptions`).
async fn scan(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let mailbox_id = match validate(&headers, &body, |issues, b| {
        issues
            .text(b, "accountId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(mailbox_id) => mailbox_id,
        Err(response) => return response,
    };
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        mailbox(db, &account, &mailbox_id).await?;
        let since = iso(now_ms() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        let found: Vec<(Value, Option<String>, Option<Value>, Value, Option<String>)> = sqlx::query_as(
            "select \"from\", subject, to_jsonb(received_date), to_jsonb(sent_date),
                    substring(raw_message from 1 for 32000)
             from personal_mail_messages
             where personal_account_id = $1 and account_id = $2 and source = 'inbound'
               and is_spam = false and deleted_at is null and raw_message is not null
               and sent_date >= $3::timestamp
             order by sent_date desc limit $4",
        )
        .bind(&account)
        .bind(&mailbox_id)
        .bind(&since)
        .bind(SCAN_MESSAGE_LIMIT)
        .fetch_all(db)
        .await?;

        // `aggregateSubscriptions(rows)`, newest first.
        let mut order: Vec<String> = Vec::new();
        let mut by_sender: HashMap<String, Aggregate> = HashMap::new();
        for (from, subject, received, sent, raw) in &found {
            let Some(email) = from["email"].as_str().map(|e| js_trim(e).to_lowercase()).filter(|e| !e.is_empty()) else {
                continue;
            };
            let Some(raw) = raw.as_deref().filter(|r| !r.is_empty()) else {
                continue;
            };
            let Some(info) = parse_list_unsubscribe(&parse_raw_headers(raw)) else {
                continue;
            };
            let received_at = received
                .as_ref()
                .and_then(stamp_ms)
                .or_else(|| stamp_ms(sent))
                .unwrap_or(0);
            match by_sender.get_mut(&email) {
                Some(aggregate) => {
                    aggregate.message_count += 1;
                    aggregate.first_received_at = aggregate.first_received_at.min(received_at);
                    aggregate.last_received_at = aggregate.last_received_at.max(received_at);
                }
                None => {
                    order.push(email.clone());
                    by_sender.insert(email.clone(), Aggregate {
                        sender_name: from["name"]
                            .as_str()
                            .map(|n| utf16_prefix(n, 255))
                            .filter(|n| !n.is_empty()),
                        sender_domain: email.split('@').nth(1).map(str::to_owned),
                        sender_email: email,
                        list_id: info.list_id,
                        url: info.url,
                        mailto: info.mailto,
                        one_click: info.one_click,
                        message_count: 1,
                        last_subject: subject.as_deref().map(|s| utf16_prefix(s, 998)),
                        first_received_at: received_at,
                        last_received_at: received_at,
                    });
                }
            }
        }
        let now = now_iso();
        for email in &order {
            let Some(aggregate) = by_sender.get(email) else {
                continue;
            };
            sqlx::query(
                "insert into personal_mail_subscriptions as s
                   (id, personal_account_id, account_id, sender_email, sender_name, sender_domain,
                    list_id, unsubscribe_url, unsubscribe_mailto, one_click, message_count,
                    last_subject, first_received_at, last_received_at)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamp, $14::timestamp)
                 on conflict (account_id, sender_email) do update set
                   message_count = greatest(s.message_count, $11),
                   first_received_at = least(s.first_received_at, $13::timestamp),
                   updated_at = $15::timestamp",
            )
            .bind(weldsuite_kit::generate_id("pmsub"))
            .bind(&account)
            .bind(&mailbox_id)
            .bind(&aggregate.sender_email)
            .bind(&aggregate.sender_name)
            .bind(&aggregate.sender_domain)
            .bind(&aggregate.list_id)
            .bind(&aggregate.url)
            .bind(&aggregate.mailto)
            .bind(aggregate.one_click)
            .bind(i32::try_from(aggregate.message_count).unwrap_or(i32::MAX))
            .bind(&aggregate.last_subject)
            .bind(iso(aggregate.first_received_at))
            .bind(iso(aggregate.last_received_at))
            .bind(&now)
            .execute(db)
            .await?;
        }
        Ok(data(json!({ "scanned": found.len(), "subscriptions": order.len() })))
    }
    .await;
    answer(result, "Failed to scan for subscriptions")
}

/// `isSafeUnsubscribeUrl(value)`: https, no credentials, a public host.
fn is_safe_unsubscribe_url(value: &str) -> bool {
    let Ok(parsed) = url::Url::parse(value) else {
        return false;
    };
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return false;
    }
    let Some(host) = parsed.host_str().map(str::to_lowercase) else {
        return false;
    };
    if !host.contains('.') || host.starts_with('[') {
        return false;
    }
    let dotted_quad = host.split('.').count() == 4
        && host
            .split('.')
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()));
    if dotted_quad || host == "localhost" {
        return false;
    }
    ![
        ".localhost",
        ".local",
        ".internal",
        ".lan",
        ".home",
        ".corp",
    ]
    .iter()
    .any(|suffix| host.ends_with(suffix))
}

/// `parseMailto(value)`: the address, and the subject and body to send.
fn parse_mailto(value: &str) -> Option<(String, String, String)> {
    if value.len() < 7
        || !value
            .get(..7)
            .is_some_and(|p| p.eq_ignore_ascii_case("mailto:"))
    {
        return None;
    }
    let rest = &value[7..];
    let (address, query) = rest.split_once('?').unwrap_or((rest, ""));
    let query = query.split('?').next().unwrap_or_default();
    let to = js_trim(&decode_uri_component(address)?).to_owned();
    // `/^[^\s@,]+@[^\s@,][^\s@,.]*\.[^\s@,]+$/`.
    let bad = |c: char| crate::js::is_js_space(c) || c == '@' || c == ',';
    let (local, domain) = to.split_once('@')?;
    if local.is_empty() || local.chars().any(bad) || domain.chars().any(bad) {
        return None;
    }
    let mut chars = domain.chars();
    chars.next()?;
    let rest: String = chars.collect();
    let dot = rest.find('.')?;
    if dot + 1 >= rest.len() {
        return None;
    }
    let mut subject = None;
    let mut body = None;
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "subject" if subject.is_none() => subject = Some(js_trim(&value).to_owned()),
            "body" if body.is_none() => body = Some(js_trim(&value).to_owned()),
            _ => {}
        }
    }
    let pick = |v: Option<String>| {
        v.filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unsubscribe".to_owned())
    };
    Some((to, pick(subject), pick(body)))
}

/// `POST /api/mail/subscriptions/:id/unsubscribe` (`performUnsubscribe`).
async fn unsubscribe(caller: Caller, Path(id): Path<String>) -> Response {
    let account = match caller.account_id() {
        Ok(account) => account.to_owned(),
        Err(response) => return response,
    };
    let result = async {
        let db = caller.personal()?;
        let found: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(s) from personal_mail_subscriptions s
             where s.id = $1 and s.personal_account_id = $2 limit 1",
        )
        .bind(&id)
        .bind(&account)
        .fetch_optional(db)
        .await?;
        let Some(subscription) = found.map(weldsuite_db::js_row) else {
            return Err(Failure::from(ApiError::not_found("Subscription", Some(&id))));
        };
        let url = subscription["unsubscribeUrl"]
            .as_str()
            .filter(|u| !u.is_empty() && is_safe_unsubscribe_url(u))
            .map(str::to_owned);
        let mailto = subscription["unsubscribeMailto"]
            .as_str()
            .filter(|m| !m.is_empty())
            .and_then(parse_mailto);
        let one_click = subscription["oneClick"].as_bool().unwrap_or(false);
        let mut last_error: Option<String> = None;
        let mut method: Option<&'static str> = None;
        if let (Some(url), true) = (&url, one_click) {
            let request = HttpRequest {
                method: "POST".to_owned(),
                url: url.clone(),
                headers: vec![(
                    "Content-Type".to_owned(),
                    "application/x-www-form-urlencoded".to_owned(),
                )],
                body: Some(b"List-Unsubscribe=One-Click".to_vec()),
            };
            match caller.http.as_ref() {
                Some(http) => match http.send(request).await {
                    Ok(response) if (200..400).contains(&response.status) => method = Some("one_click"),
                    Ok(response) => {
                        last_error = Some(format!("One-click POST returned HTTP {}", response.status));
                    }
                    Err(error) => last_error = Some(error.to_string()),
                },
                None => last_error = Some("fetch failed".to_owned()),
            }
        }
        if method.is_none()
            && let Some((to, subject, body)) = &mailto
        {
            let ctx = SendContext::new(&caller, db, &account);
            let input = Compose {
                account_id: subscription["accountId"].as_str().unwrap_or_default().to_owned(),
                to: vec![to.clone()],
                subject: subject.clone(),
                text_body: Some(body.clone()),
                source: Some("subscription"),
                kind: Some(OutboundKind::NewThread),
                ..Compose::default()
            };
            match send_and_persist(&ctx, &input).await {
                Ok(_) => method = Some("mailto"),
                Err(error) => last_error = Some(error.message().to_owned()),
            }
        }
        let (method, link) = match (method, &url, last_error) {
            (Some(method), _, _) => (method, None),
            (None, Some(url), _) => ("link", Some(url.clone())),
            (None, None, Some(error)) => {
                return Err(Failure::from(
                    ApiError::unavailable(format!("Unsubscribe failed: {error}")).into_response(),
                ));
            }
            (None, None, None) => {
                return Err(ApiError::bad_request("This sender offers no way to unsubscribe").into());
            }
        };
        let now = now_iso();
        let updated: Option<Value> = sqlx::query_scalar(
            "update personal_mail_subscriptions s set status = 'unsubscribed', unsubscribe_method = $2,
               unsubscribed_at = $3::timestamp, updated_at = $3::timestamp
             where s.id = $1 returning to_jsonb(s)",
        )
        .bind(&id)
        .bind(method)
        .bind(&now)
        .fetch_optional(db)
        .await?;
        let subscription = updated.map(weldsuite_db::js_row).unwrap_or(subscription);
        Ok(data(json!({ "subscription": subscription, "method": method, "url": link })))
    }
    .await;
    answer(result, "Failed to unsubscribe")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_headers_unfold_and_keep_the_first() {
        let headers = parse_raw_headers(
            "From: a@x.example\r\nList-Unsubscribe: <mailto:l@x.example>,\r\n <https://x.example/u>\r\nlist-unsubscribe: second\r\n\r\nBody: not a header",
        );
        assert_eq!(
            headers,
            vec![
                ("from".to_owned(), "a@x.example".to_owned()),
                (
                    "list-unsubscribe".to_owned(),
                    "<mailto:l@x.example>, <https://x.example/u>".to_owned()
                ),
            ]
        );
        assert_eq!(
            parse_raw_headers("X: 1\n\nY: 2"),
            vec![("x".to_owned(), "1".to_owned())]
        );
    }

    #[test]
    fn mailto_and_urls() {
        assert_eq!(
            parse_mailto("mailto:leave@news.example?subject=Remove%20me"),
            Some((
                "leave@news.example".to_owned(),
                "Remove me".to_owned(),
                "unsubscribe".to_owned()
            ))
        );
        assert_eq!(parse_mailto("mailto:nobody"), None);
        assert!(is_safe_unsubscribe_url("https://news.example/u"));
        assert!(!is_safe_unsubscribe_url("http://news.example/u"));
        assert!(!is_safe_unsubscribe_url("https://10.0.0.1/u"));
        assert!(!is_safe_unsubscribe_url("https://intranet.local/u"));
    }
}
