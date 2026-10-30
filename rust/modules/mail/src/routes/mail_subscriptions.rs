//! `/api/mail-subscriptions` (`routes/mail-subscriptions/index.ts`,
//! `services/mail/subscriptions.ts`, `@weldsuite/email/list-unsubscribe`):
//! the newsletters a mailbox receives, the scan that finds them, and
//! unsubscribing (RFC 8058 one-click POST, a mailto, or the link).

use std::sync::Arc;

use axum::Extension;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::MAIL_SUBSCRIPTION_UNSUBSCRIBED;
use weldsuite_catalogs::permission_keys::{MESSAGES_READ, MESSAGES_UPDATE};
use weldsuite_db::js_row;
use weldsuite_kit::cursor::decode_uri_component;
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{ApiError, Data};
use weldsuite_mail_domain::access::check_account_access;
use weldsuite_mail_domain::messages::iso;
use weldsuite_mail_domain::outbound::OutboundKind;
use weldsuite_mail_domain::send::{SendError, SendInput, SendOptions, send_and_persist};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::HttpRequest;

use crate::send::{RequestDoh, SendContext};
use crate::util::{MailError, answer, unhandled, validate, validate_query};
use crate::{Caller, MailState};

/// `SCAN_WINDOW_DAYS` / `SCAN_MESSAGE_LIMIT`.
const SCAN_WINDOW_DAYS: i64 = 180;
const SCAN_MESSAGE_LIMIT: i64 = 2000;

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/mail-subscriptions",
            get(list).route_layer(gate.require([MESSAGES_READ])),
        )
        .route(
            "/mail-subscriptions/scan",
            post(scan).route_layer(gate.require([MESSAGES_UPDATE])),
        )
        .route(
            "/mail-subscriptions/{id}/unsubscribe",
            post(unsubscribe).route_layer(gate.require([MESSAGES_UPDATE])),
        )
        .with_state(state)
}

/// The access check before the route's try/catch: a closed mailbox is a 404.
async fn mailbox(caller: &Caller, account: &str) -> Result<(), Response> {
    match check_account_access(&caller.db, account, &caller.user_id).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(ApiError::not_found("Mail account", Some(account)).into_response()),
        Err(error) => Err(unhandled(error.into())),
    }
}

/// `GET /?accountId=&status=`.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = validate_query(raw.as_deref(), |issues, q| {
        let account = issues.text(q, "accountId", Presence::Required, Some(1), None);
        let status = issues.choice(q, "status", Presence::Optional, &["active", "unsubscribed"]);
        (
            account.into_option().unwrap_or_default(),
            status.into_option(),
        )
    });
    let (account, status) = match query {
        Ok(query) => query,
        Err(error) => return error.respond(""),
    };
    if let Err(response) = mailbox(&caller, &account).await {
        return response;
    }
    let result = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(s) from mail_subscriptions s
             where s.account_id = $1 and ($2::text is null or s.status = $2)
             order by s.last_received_at desc limit 1000",
        )
        .bind(&account)
        .bind(&status)
        .fetch_all(&caller.db)
        .await?;
        Ok(Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response())
    }
    .await;
    answer(result, "Failed to list subscriptions")
}

/// `POST /scan` (`scanSubscriptions`): the mailbox's inbound mail of the
/// last 180 days, grouped by sender where a List-Unsubscribe header says
/// how to leave. The headers come from the raw MIME (`MAIL_STORAGE`), which
/// the Kubernetes editions do not keep yet, so no message qualifies there:
/// the scan counts what it read and records nothing, as mail-api does
/// without `MAIL_STORAGE`.
async fn scan(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let account = match validate(&headers, &body, |issues, body| {
        issues
            .text(body, "accountId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(account) => account,
        Err(error) => return error.respond(""),
    };
    if let Err(response) = mailbox(&caller, &account).await {
        return response;
    }
    let result = async {
        let since_ms = weldsuite_mail_domain::outbound::clock::now_ms()
            - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        let since = weldsuite_mail_domain::outbound::clock::iso(since_ms);
        let scanned: Vec<String> = sqlx::query_scalar(
            "select id from mail_messages
             where account_id = $1 and source = 'inbound' and is_spam = false
               and sent_date >= $2::timestamp
             order by sent_date desc limit $3",
        )
        .bind(&account)
        .bind(&since)
        .bind(SCAN_MESSAGE_LIMIT)
        .fetch_all(&caller.db)
        .await?;
        Ok(Data(json!({ "scanned": scanned.len(), "subscriptions": 0 })).into_response())
    }
    .await;
    answer(result, "Failed to scan for subscriptions")
}

/// `isSafeUnsubscribeUrl(value)`: https, no credentials, a public host.
fn is_safe_unsubscribe_url(value: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(value) else {
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

/// `parseMailto(value)`: the address and the subject and body to send.
fn parse_mailto(value: &str) -> Option<(String, String, String)> {
    if value.len() < 7 || !value[..7].eq_ignore_ascii_case("mailto:") {
        return None;
    }
    let rest = &value[7..];
    let (address, query) = rest.split_once('?').unwrap_or((rest, ""));
    let to = decode_uri_component(address)?.trim().to_owned();
    let valid = {
        let mut parts = to.splitn(2, '@');
        let local = parts.next().unwrap_or_default();
        let domain = parts.next().unwrap_or_default();
        let bad = |c: char| c.is_whitespace() || c == '@' || c == ',';
        !local.is_empty()
            && !local.chars().any(bad)
            && domain.contains('.')
            && !domain.chars().any(bad)
            && !domain.starts_with('.')
            && {
                // `[^\s@,][^\s@,.]*\.[^\s@,]+`: the first dot ends a non-empty
                // label and something follows it.
                let dot = domain.find('.').unwrap_or(0);
                dot > 0 && dot + 1 < domain.len()
            }
    };
    if !valid {
        return None;
    }
    let mut subject = None;
    let mut body = None;
    for (key, value) in form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "subject" if subject.is_none() => subject = Some(value.trim().to_owned()),
            "body" if body.is_none() => body = Some(value.trim().to_owned()),
            _ => {}
        }
    }
    let pick = |v: Option<String>| {
        v.filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unsubscribe".to_owned())
    };
    Some((to, pick(subject), pick(body)))
}

/// What `performUnsubscribe` did.
enum Outcome {
    Done(&'static str, Option<String>),
    NoMethod,
    Failed(String),
}

/// `POST /:id/unsubscribe`.
#[allow(clippy::too_many_lines)] // every way to unsubscribe, in TypeScript's order
async fn unsubscribe(
    State(state): State<MailState>,
    caller: Caller,
    doh: Option<Extension<RequestDoh>>,
    Path(id): Path<String>,
) -> Response {
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.into_response(),
    };
    let doh = doh
        .map(|d| Arc::clone(&d.0.0))
        .or_else(|| state.doh.clone());
    let result = async {
        let row: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(s) from mail_subscriptions s where s.id = $1 limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(row) = row.map(js_row) else {
            return Err(MailError::not_found("Subscription", Some(&id)));
        };
        let account = row["accountId"].as_str().unwrap_or_default().to_owned();
        if !check_account_access(&caller.db, &account, &caller.user_id).await? {
            return Err(MailError::not_found("Subscription", Some(&id)));
        }
        let url = row["unsubscribeUrl"]
            .as_str()
            .filter(|u| is_safe_unsubscribe_url(u))
            .map(str::to_owned);
        let mailto = row["unsubscribeMailto"].as_str().and_then(parse_mailto);
        let one_click = row["oneClick"].as_bool().unwrap_or(false);
        let mut last_error: Option<String> = None;
        let mut outcome = None;
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
            match caller.bindings.http(&state) {
                Some(http) => match http.0.send(request).await {
                    Ok(response) if (200..400).contains(&response.status) => {
                        outcome = Some(Outcome::Done("one_click", None));
                    }
                    Ok(response) => {
                        last_error =
                            Some(format!("One-click POST returned HTTP {}", response.status));
                    }
                    Err(error) => last_error = Some(error.to_string()),
                },
                None => last_error = Some("fetch failed".to_owned()),
            }
        }
        if outcome.is_none()
            && let Some((to, subject, body)) = &mailto
        {
            let context = SendContext::new(&state, &caller, doh.clone());
            let input = SendInput {
                to: vec![to.clone()],
                subject: Some(subject.clone()),
                body: Some(body.clone()),
                ..SendInput::default()
            };
            let options = SendOptions {
                source: Some("subscription".to_owned()),
                kind: Some(OutboundKind::NewThread),
                ..SendOptions::default()
            };
            match send_and_persist(
                &context.deps(&caller),
                &org,
                &caller.user_id,
                &account,
                &input,
                &options,
            )
            .await
            {
                Ok(_) => outcome = Some(Outcome::Done("mailto", None)),
                Err(SendError::Mail { message, .. } | SendError::Internal(message)) => {
                    last_error = Some(message);
                }
            }
        }
        let outcome = match (outcome, &url, last_error) {
            (Some(outcome), _, _) => outcome,
            (None, Some(url), _) => Outcome::Done("link", Some(url.clone())),
            (None, None, Some(error)) => Outcome::Failed(error),
            (None, None, None) => Outcome::NoMethod,
        };
        let (method, link) = match outcome {
            Outcome::Done(method, link) => (method, link),
            Outcome::NoMethod => {
                return Err(MailError::bad_request(
                    "This sender offers no way to unsubscribe",
                ));
            }
            Outcome::Failed(detail) => {
                return Err(MailError::api(
                    ApiError::bad_gateway().with_message(format!("Unsubscribe failed: {detail}")),
                ));
            }
        };
        let at = iso(time::OffsetDateTime::now_utc());
        let updated: Option<Value> = sqlx::query_scalar(
            "update mail_subscriptions s set status = 'unsubscribed', unsubscribe_method = $2,
               unsubscribed_at = $3::timestamp, unsubscribed_by = $4, updated_at = $3::timestamp
             where s.id = $1 returning to_jsonb(s)",
        )
        .bind(&id)
        .bind(method)
        .bind(&at)
        .bind(&caller.user_id)
        .fetch_optional(&caller.db)
        .await?;
        let subscription = updated.map(js_row).unwrap_or(row);
        caller.publish(
            &state,
            MAIL_SUBSCRIPTION_UNSUBSCRIBED,
            &id,
            &json!({
                "id": subscription["id"],
                "accountId": subscription["accountId"],
                "senderEmail": subscription["senderEmail"],
                "method": method,
            }),
        );
        Ok(
            Data(json!({ "subscription": subscription, "method": method, "url": link }))
                .into_response(),
        )
    }
    .await;
    answer(result, "Failed to unsubscribe")
}
