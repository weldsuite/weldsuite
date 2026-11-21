//! Shoppers (ADR COM-012): sign in with an emailed code, the session
//! (`X-Shopper-Token: wss_…`), the account and the company a B2B shopper buys
//! for.
//!
//! The code and session machinery is the portal kit's
//! (`weldsuite_kit::portal::signin`), the one the project portal runs on:
//! 5 code requests per address and 20 per client address (the browser's, or
//! the shopper's a private key names) per 15 minutes, 8 attempts per code, codes
//! live 15 minutes, sessions 30 days, hashed in the cache. A code and a
//! session belong to one channel (the cache scope is `<workspace>:<channel>`,
//! and the session record names its channel and workspace, both checked on
//! every use), so a session of one shop is no good in another.
//!
//! A shopper is a WeldCRM person: found by email at the first sign-in, or
//! made with `in_crm = false` (`accounts::find_or_create_person`).

#![allow(
    clippy::result_large_err,
    clippy::option_option,
    reason = "a refusal is the response to send; a patch field is absent, null or a value"
)]

use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::COMMERCE_BUYER_UPDATED;
use weldsuite_commerce_domain::accounts::{self, Membership, Person, Profile};
use weldsuite_commerce_domain::money;
use weldsuite_events::publish_entity_event;
use weldsuite_kit::portal::rate_limit::{
    CacheRateLimitCounters, RateLimitCounters, RateLimitOutcome, consume_rate_limit,
};
use weldsuite_kit::portal::signin::{
    Challenge, Namespace, REQUEST_WINDOW_SECONDS, SessionRecord, SignIn, Verdict, attempts_left,
    consume_email_request, consume_workspace_request, create_session_prefixed, end_session,
    normalize_email, read_header_token, read_session, session_expires_at, store_challenge,
    store_session, verify_code,
};
use weldsuite_kit::portal::tokens::{PortalKv, kv_get_json};

use super::{Principal, body_object, data, fail, internal, limit, validation};
use crate::mail;

/// The storefront's cache keys: `shopper:code:…`, `shopper:sess:…`.
pub(crate) const NAMESPACE: Namespace = Namespace("shopper");
/// The header a session is sent in.
pub(crate) const HEADER: &str = "x-shopper-token";

#[allow(clippy::struct_field_names, reason = "the JSON the cache holds")]
/// What a code and a session are for: one channel; a session also knows its
/// person and the company the shopper picked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Subject {
    pub(crate) channel_id: String,
    #[serde(default)]
    pub(crate) person_id: String,
    #[serde(default)]
    pub(crate) active_company_id: Option<String>,
}

/// A live session.
#[derive(Debug, Clone)]
pub(crate) struct Session {
    pub(crate) hash: String,
    pub(crate) record: SessionRecord<Subject>,
}

/// The shopper behind a session.
#[derive(Debug, Clone)]
pub(crate) struct Loaded {
    pub(crate) session: Session,
    pub(crate) person: Person,
    pub(crate) companies: Vec<Membership>,
    /// The picked company, or the only one.
    pub(crate) active: Option<Membership>,
}

impl Loaded {
    /// The `Shopper` of the API.
    pub(crate) fn json(&self) -> Value {
        json!({
            "personId": self.person.id,
            "email": self.person.email,
            "firstName": self.person.first_name,
            "lastName": self.person.last_name,
            "phone": self.person.phone,
            "companies": self.companies.iter().map(|m| json!({
                "id": m.company_id,
                "name": m.name,
                "role": m.role,
                "spendLimit": m.spend_limit.map(money::format),
                "currency": m.currency,
            })).collect::<Vec<_>>(),
            "activeCompanyId": self.active.as_ref().map(|m| m.company_id.clone()),
        })
    }
}

fn scope(principal: &Principal) -> String {
    format!("{}:{}", principal.workspace_id, principal.channel.id)
}

fn kv(principal: &Principal) -> PortalKv {
    principal.state.cache.clone()
}

fn limiter(principal: &Principal) -> Option<Arc<dyn RateLimitCounters>> {
    principal
        .state
        .cache
        .clone()
        .map(|cache| Arc::new(CacheRateLimitCounters::new(cache)) as Arc<dyn RateLimitCounters>)
}

fn unavailable() -> Response {
    fail(
        StatusCode::SERVICE_UNAVAILABLE,
        "SIGN_IN_UNAVAILABLE",
        "Sign-in is temporarily unavailable, try again shortly",
        None,
    )
}

fn limited() -> Response {
    fail(
        StatusCode::TOO_MANY_REQUESTS,
        "RATE_LIMITED",
        "Too many attempts, try again later",
        None,
    )
}

fn session_required() -> Response {
    fail(
        StatusCode::UNAUTHORIZED,
        "SESSION_REQUIRED",
        "Sign in required: send X-Shopper-Token",
        None,
    )
}

fn session_expired() -> Response {
    fail(
        StatusCode::UNAUTHORIZED,
        "SESSION_EXPIRED",
        "The session has expired: sign in again",
        None,
    )
}

/// The session the request carries: `None` without the header, 401
/// `SESSION_EXPIRED` for one that is not (or no longer) valid on this channel.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
pub(crate) async fn session(
    principal: &Principal,
    headers: &HeaderMap,
) -> Result<Option<Session>, Response> {
    let Some(token) = read_header_token(headers, HEADER) else {
        return Ok(None);
    };
    let found = read_session::<Subject>(&kv(principal), NAMESPACE, &token)
        .await
        .map_err(|e| internal(&e, "The session could not be checked"))?;
    match found {
        Some((hash, record))
            if record.workspace_id == principal.workspace_id
                && record.subject.channel_id == principal.channel.id
                && !record.subject.person_id.is_empty() =>
        {
            Ok(Some(Session { hash, record }))
        }
        _ => Err(session_expired()),
    }
}

/// The shopper behind a session; 401 when the person is gone.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
pub(crate) async fn load(principal: &Principal, session: Session) -> Result<Loaded, Response> {
    let mut conn = principal
        .db
        .acquire()
        .await
        .map_err(|e| internal(&e, "The account could not be read"))?;
    let person = accounts::person(&mut conn, &session.record.subject.person_id)
        .await
        .map_err(|e| internal(&e, "The account could not be read"))?;
    let Some(person) = person else {
        return Err(session_expired());
    };
    let companies = accounts::memberships(&mut conn, &person.id)
        .await
        .map_err(|e| internal(&e, "The account could not be read"))?;
    let chosen = session.record.subject.active_company_id.as_deref();
    let active = chosen
        .and_then(|id| companies.iter().find(|m| m.company_id == id).cloned())
        .or_else(|| (companies.len() == 1).then(|| companies[0].clone()));
    Ok(Loaded {
        session,
        person,
        companies,
        active,
    })
}

/// A signed-in shopper, or 401.
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
pub(crate) async fn require(
    principal: &Principal,
    headers: &HeaderMap,
) -> Result<Loaded, Response> {
    match session(principal, headers).await? {
        Some(session) => load(principal, session).await,
        None => Err(session_required()),
    }
}

/// The signed-in shopper when a session is sent, else none (a guest).
#[allow(clippy::result_large_err, reason = "the Err is the response to send")]
pub(crate) async fn optional(
    principal: &Principal,
    headers: &HeaderMap,
) -> Result<Option<Loaded>, Response> {
    match session(principal, headers).await? {
        Some(session) => load(principal, session).await.map(Some),
        None => Ok(None),
    }
}

fn email_of(body: &serde_json::Map<String, Value>) -> Result<String, Response> {
    let Some(raw) = body.get("email").and_then(Value::as_str) else {
        return Err(validation(&[("email".to_owned(), "Required".to_owned())]));
    };
    let email = normalize_email(raw);
    let ok = email.len() <= 255
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !email.contains(char::is_whitespace)
        });
    if ok {
        Ok(email)
    } else {
        Err(validation(&[(
            "email".to_owned(),
            "Must be an email address".to_owned(),
        )]))
    }
}

/// `POST /auth/code`: 202 `{ data: { sent: true } }` for every address (no
/// account enumeration); the code goes by email.
pub(crate) async fn request_code(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let email = match email_of(&body) {
        Ok(email) => email,
        Err(response) => return response,
    };
    let locale = body.get("locale").and_then(Value::as_str);
    if let Some(locale) = locale
        && !matches!(locale, "en" | "nl")
    {
        return validation(&[("locale".to_owned(), "Must be en or nl".to_owned())]);
    }
    let kv = kv(&principal);
    let limiter = limiter(&principal);
    let scope = scope(&principal);
    let env = SignIn {
        kv: &kv,
        limiter: limiter.as_ref(),
        ns: NAMESPACE,
        workspace_id: &scope,
    };
    // The caller's own budget comes first, so one caller spraying made-up
    // addresses cannot use up the channel's.
    let client = limit::sign_in_client(
        &headers,
        principal.state.trusted_proxies,
        principal.key_kind == "publishable",
    );
    if let Some(client) = client {
        let outcome = consume_rate_limit(
            limiter.as_ref(),
            &scope,
            &format!("ip:{client}"),
            limit::SIGN_IN_CODE_LIMIT,
            REQUEST_WINDOW_SECONDS,
        )
        .await;
        match outcome {
            RateLimitOutcome::Allowed => {}
            RateLimitOutcome::Limited => return limited(),
            RateLimitOutcome::Unavailable => return unavailable(),
        }
    }
    for outcome in [
        consume_email_request(&env, &email).await,
        consume_workspace_request(&env).await,
    ] {
        match outcome {
            RateLimitOutcome::Allowed => {}
            RateLimitOutcome::Limited => return limited(),
            RateLimitOutcome::Unavailable => return unavailable(),
        }
    }
    let subject = Subject {
        channel_id: principal.channel.id.clone(),
        person_id: String::new(),
        active_company_id: None,
    };
    let code = match store_challenge(&env, &email, subject).await {
        Ok(code) => code,
        Err(error) => return internal(&error, "The code could not be sent"),
    };
    mail::code(
        &principal.state.mail,
        &principal.channel.name,
        &email,
        &code,
        mail::locale(locale, Some(&headers)),
    )
    .await;
    (
        StatusCode::ACCEPTED,
        axum::Json(json!({ "data": { "sent": true } })),
    )
        .into_response()
}

fn now_iso() -> String {
    crate::now()
        .replace(' ', "T")
        .trim_end_matches('Z')
        .to_owned()
        + "Z"
}

fn now_millis() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp() * 1000
}

/// `POST /auth/verify`: the session.
#[allow(
    clippy::too_many_lines,
    reason = "check the code, find the person, open the session"
)]
pub(crate) async fn verify(Extension(principal): Extension<Principal>, body: Bytes) -> Response {
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let email = match email_of(&body) {
        Ok(email) => email,
        Err(response) => return response,
    };
    let code = body
        .get("code")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return validation(&[("code".to_owned(), "The code is 6 digits".to_owned())]);
    }
    let kv = kv(&principal);
    let limiter = limiter(&principal);
    let scope = scope(&principal);
    let env = SignIn {
        kv: &kv,
        limiter: limiter.as_ref(),
        ns: NAMESPACE,
        workspace_id: &scope,
    };
    // What was pending before this guess: tells an expired code from a wrong one.
    let pending =
        match kv_get_json::<Challenge<Subject>>(&kv, &NAMESPACE.code_key(&scope, &email)).await {
            Ok(pending) => pending,
            Err(error) => return internal(&error, "The code could not be checked"),
        };
    let verdict = match verify_code::<Subject>(&env, &email, code).await {
        Ok(verdict) => verdict,
        Err(error) => return internal(&error, "The code could not be checked"),
    };
    match verdict {
        Verdict::Verified(subject) if subject.channel_id == principal.channel.id => {}
        Verdict::Verified(_) | Verdict::Invalid => {
            return match pending {
                Some(challenge) => fail(
                    StatusCode::UNAUTHORIZED,
                    "INVALID_CODE",
                    "Invalid code",
                    Some(json!({ "attemptsLeft": attempts_left(challenge.attempts + 1) })),
                ),
                None => fail(
                    StatusCode::GONE,
                    "CODE_EXPIRED",
                    "The code has expired: request a new one",
                    None,
                ),
            };
        }
        Verdict::Limited => return limited(),
        Verdict::Unavailable => return unavailable(),
    }
    // The shopper: found by email, or made (`in_crm = false`); invitations
    // are accepted. One transaction, one connection.
    let accepted = async {
        let mut tx = principal.db.begin().await?;
        let person =
            accounts::find_or_create_person(&mut tx, &email, None, None, "storefront").await?;
        let accepted = accounts::accept_invitations(&mut tx, &person.id).await?;
        tx.commit().await?;
        Ok::<_, weldsuite_commerce_domain::Error>((person, accepted))
    }
    .await;
    let (person, accepted) = match accepted {
        Ok(found) => found,
        Err(error) => return internal(&error, "The account could not be opened"),
    };
    for id in &accepted {
        publish_entity_event(
            &principal.state.events,
            &principal.events,
            COMMERCE_BUYER_UPDATED,
            id.clone(),
            &json!({ "id": id, "personId": person.id, "status": "active" }),
        );
    }
    let created = now_iso();
    let record = SessionRecord {
        workspace_id: principal.workspace_id.clone(),
        clerk_org_id: None,
        workspace_slug: String::new(),
        workspace_name: principal.channel.name.clone(),
        email: email.clone(),
        subject: Subject {
            channel_id: principal.channel.id.clone(),
            person_id: person.id.clone(),
            active_company_id: None,
        },
        created_at: created.clone(),
        last_seen_at: created.clone(),
    };
    let token = match create_session_prefixed(&env, &record, "wss_").await {
        Ok(token) => token,
        Err(error) => return internal(&error, "The session could not be opened"),
    };
    let hash = weldsuite_kit::portal::tokens::sha256_hex(&token);
    let loaded = match load(&principal, Session { hash, record }).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    data(json!({
        "sessionToken": token,
        "expiresAt": session_expires_at(&created, now_millis()),
        "shopper": loaded.json(),
    }))
}

/// `POST /auth/sign-out`: ends the session (a session already gone is a
/// success too).
pub(crate) async fn sign_out(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Response {
    if let Some(token) = read_header_token(&headers, HEADER) {
        end_session(&kv(&principal), NAMESPACE, &token).await;
    }
    StatusCode::NO_CONTENT.into_response()
}

/// `GET /account`.
pub(crate) async fn read(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> Response {
    match require(&principal, &headers).await {
        Ok(loaded) => data(loaded.json()),
        Err(response) => response,
    }
}

#[allow(
    clippy::option_option,
    reason = "a patch field: absent, null or a value"
)]
fn name_field(
    body: &serde_json::Map<String, Value>,
    key: &str,
    max: usize,
    problems: &mut Vec<(String, String)>,
) -> Option<Option<String>> {
    match body.get(key)? {
        Value::Null => Some(None),
        Value::String(text) => {
            let text = text.trim();
            if text.chars().count() > max {
                problems.push((key.to_owned(), format!("At most {max} characters")));
                None
            } else {
                Some(Some(text.to_owned()).filter(|t| !t.is_empty()))
            }
        }
        _ => {
            problems.push((key.to_owned(), "Must be text".to_owned()));
            None
        }
    }
}

/// `PATCH /account`: first name, last name and phone.
pub(crate) async fn patch(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let loaded = match require(&principal, &headers).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let mut problems = Vec::new();
    let profile = Profile {
        first_name: name_field(&body, "firstName", 100, &mut problems),
        last_name: name_field(&body, "lastName", 100, &mut problems),
        phone: name_field(&body, "phone", 50, &mut problems),
    };
    if !problems.is_empty() {
        return validation(&problems);
    }
    let updated = async {
        let mut conn = principal.db.acquire().await?;
        Ok::<_, weldsuite_commerce_domain::Error>(
            accounts::update_profile(&mut conn, &loaded.person.id, &profile).await?,
        )
    }
    .await;
    match updated {
        Ok(Some(person)) => data(Loaded { person, ..loaded }.json()),
        Ok(None) => session_expired(),
        Err(error) => internal(&error, "The account could not be changed"),
    }
}

/// `PUT /account/company`: the company a B2B shopper buys for; null clears.
pub(crate) async fn select_company(
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let loaded = match require(&principal, &headers).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let body = match body_object(&body) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let chosen = match body.get("companyId") {
        Some(Value::Null) => None,
        Some(Value::String(id)) if !id.is_empty() && id.len() <= 64 => Some(id.clone()),
        _ => {
            return validation(&[(
                "companyId".to_owned(),
                "Must be a company id or null".to_owned(),
            )]);
        }
    };
    if let Some(id) = &chosen
        && !loaded.companies.iter().any(|m| &m.company_id == id)
    {
        return fail(
            StatusCode::FORBIDDEN,
            "NOT_A_BUYER",
            "You are not a buyer of that company",
            None,
        );
    }
    let mut record = loaded.session.record.clone();
    record.subject.active_company_id = chosen.clone();
    if let Err(error) =
        store_session(&kv(&principal), NAMESPACE, &loaded.session.hash, &record).await
    {
        return internal(&error, "The company could not be selected");
    }
    let session = Session {
        hash: loaded.session.hash.clone(),
        record,
    };
    let active = chosen
        .as_deref()
        .and_then(|id| {
            loaded
                .companies
                .iter()
                .find(|m| m.company_id == id)
                .cloned()
        })
        .or_else(|| (loaded.companies.len() == 1).then(|| loaded.companies[0].clone()));
    data(
        Loaded {
            session,
            active,
            ..loaded
        }
        .json(),
    )
}
