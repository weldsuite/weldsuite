//! The passwordless sign-in every public portal shares: the project portal
//! (`/public/project-portal`) and the WeldCommerce storefront
//! (`/storefront/v1/auth`) are both built on it, so there is one
//! implementation of the limits, the one-time code and the session.
//!
//! - A **code** is emailed (6 digits, 15 minutes) and kept in the workspace
//!   cache as a [`Challenge`] holding only its salted SHA-256. A request is
//!   limited per address and per workspace ([`consume_email_request`],
//!   [`consume_workspace_request`]); [`store_challenge`] draws and stores
//!   the code.
//! - [`verify_code`] is the whole check: the failed-attempt budgets are
//!   reserved up front (given back when the code is right), the per-challenge
//!   counter is atomic so parallel guesses cannot beat the cap of 8, a wrong
//!   guess is counted on the challenge, a right one is spent.
//! - A **session** is a [`SessionRecord`] under the SHA-256 of a bearer token
//!   (30 days, written again when last used over a day ago): [`read_session`],
//!   [`touch_session`], [`end_session`].
//!
//! What a portal adds is the record's `subject` (the project portal's
//! contacts, the storefront's channel and person) and its key [`Namespace`].

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::rate_limit::{
    RateLimitCounters, RateLimitOutcome, consume_rate_limit, release_rate_limit,
};
use super::tokens::{PortalKv, kv_delete, kv_get_json, kv_put_json, random_token, sha256_hex};
use crate::validation::{js_date_parse, js_iso_from_millis, js_trim};

/// A sign-in code lives 15 minutes.
pub const CODE_TTL_SECONDS: u64 = 15 * 60;
/// A session lives 30 days from its last use.
pub const SESSION_TTL_SECONDS: u64 = 30 * 24 * 60 * 60;
/// The session record is written again when it was last used more than a day ago.
pub const SESSION_REFRESH_AFTER_SECONDS: i64 = 24 * 60 * 60;
/// Wrong guesses a code survives before it is thrown away.
pub const MAX_VERIFY_ATTEMPTS: u32 = 8;
/// Code requests per window, per address.
pub const REQUEST_LIMIT_EMAIL: u32 = 5;
/// Code requests per window, per workspace.
pub const REQUEST_LIMIT_WORKSPACE: u32 = 200;
/// The window of the request and verify limits.
pub const REQUEST_WINDOW_SECONDS: u64 = 15 * 60;
/// Failed verifies per window, per address.
pub const VERIFY_LIMIT_EMAIL: u32 = 20;
/// Failed verifies per window, per workspace.
pub const VERIFY_LIMIT_WORKSPACE: u32 = 200;
/// A code is this many digits.
pub const CODE_LENGTH: usize = 6;

/// The refusals, sent to the visitor as they are.
pub mod messages {
    pub const INVALID_CODE: &str = "Invalid or expired code";
    pub const TOO_MANY_ATTEMPTS: &str = "Too many attempts, try again later";
    pub const SIGN_IN_UNAVAILABLE: &str = "Sign-in is temporarily unavailable, try again shortly";
    pub const SIGN_IN_REQUIRED: &str = "Sign in required";
    pub const SESSION_EXPIRED: &str = "Session expired";
    pub const ACCESS_REVOKED: &str = "Access revoked";
}

/// `email.trim().toLowerCase()`.
#[must_use]
pub fn normalize_email(email: &str) -> String {
    js_trim(email).to_lowercase()
}

/// The text hashed for a code: salted with the workspace and the address, so a
/// leaked record cannot be searched for 6-digit codes with a table that works
/// for every workspace.
#[must_use]
pub fn code_input(workspace_id: &str, email: &str, code: &str) -> String {
    format!("{workspace_id}:{}:{code}", normalize_email(email))
}

/// A portal's cache keys: `<prefix>:code:…`, `<prefix>:sess:…`,
/// `<prefix>:slug:…`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Namespace(pub &'static str);

impl Namespace {
    #[must_use]
    pub fn code_key(self, workspace_id: &str, email: &str) -> String {
        format!("{}:code:{workspace_id}:{}", self.0, normalize_email(email))
    }

    #[must_use]
    pub fn session_key(self, token_hash: &str) -> String {
        format!("{}:sess:{token_hash}", self.0)
    }

    #[must_use]
    pub fn slug_key(self, slug: &str) -> String {
        format!("{}:slug:{slug}", self.0)
    }
}

/// A pending sign-in code (cache, 15 minutes); `subject` is what the portal
/// resolved for the address when it sent the code. Fields in the order
/// `JSON.stringify` writes them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge<S> {
    pub code_hash: String,
    pub email: String,
    pub workspace_id: String,
    #[serde(flatten)]
    pub subject: S,
    #[serde(default)]
    pub attempts: u32,
}

/// A signed-in session (cache, 30 days from the last use), keyed by the
/// SHA-256 of its token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord<S> {
    pub workspace_id: String,
    /// The Clerk org id the tenant database is opened with; null when only
    /// `workspaces.id` is known.
    pub clerk_org_id: Option<String>,
    pub workspace_slug: String,
    pub workspace_name: String,
    pub email: String,
    #[serde(flatten)]
    pub subject: S,
    /// ISO.
    pub created_at: String,
    /// ISO; moves forward when the record is written again.
    pub last_seen_at: String,
}

/// True when the session was last written more than a day ago.
#[must_use]
pub fn session_needs_refresh(last_seen_at: &str, now_millis: i64) -> bool {
    match millis_of(last_seen_at) {
        Some(seen) => now_millis - seen > SESSION_REFRESH_AFTER_SECONDS * 1000,
        None => true,
    }
}

/// When a session last used at `last_seen_at` lapses (ISO); `now_millis` stands
/// in when it does not parse.
#[must_use]
pub fn session_expires_at(last_seen_at: &str, now_millis: i64) -> String {
    let seen = millis_of(last_seen_at).unwrap_or(now_millis);
    let ttl = i64::try_from(SESSION_TTL_SECONDS).unwrap_or(0) * 1000;
    #[allow(clippy::cast_precision_loss, reason = "milliseconds fit an f64")]
    let at = (seen + ttl) as f64;
    js_iso_from_millis(at).unwrap_or_default()
}

fn millis_of(text: &str) -> Option<i64> {
    #[allow(clippy::cast_possible_truncation, reason = "whole milliseconds")]
    js_date_parse(text).map(|millis| millis as i64)
}

/// `Authorization: Bearer <token>`.
#[must_use]
pub fn read_bearer(headers: &http::HeaderMap) -> Option<String> {
    let header = headers.get(http::header::AUTHORIZATION)?.to_str().ok()?;
    if !header.to_lowercase().starts_with("bearer ") {
        return None;
    }
    let token = js_trim(header.get(7..)?).to_owned();
    (!token.is_empty()).then_some(token)
}

/// A token sent in a header of its own (`X-Shopper-Token`).
#[must_use]
pub fn read_header_token(headers: &http::HeaderMap, name: &str) -> Option<String> {
    let token = js_trim(headers.get(name)?.to_str().ok()?).to_owned();
    (!token.is_empty()).then_some(token)
}

/// What a sign-in step works on: the portal's cache, its limiter, its key
/// namespace and the workspace.
#[derive(Clone, Copy)]
pub struct SignIn<'a> {
    pub kv: &'a PortalKv,
    pub limiter: Option<&'a Arc<dyn RateLimitCounters>>,
    pub ns: Namespace,
    pub workspace_id: &'a str,
}

/// The per-address budget of code requests.
pub async fn consume_email_request(env: &SignIn<'_>, email: &str) -> RateLimitOutcome {
    consume_rate_limit(
        env.limiter,
        env.workspace_id,
        &format!("e:{email}"),
        REQUEST_LIMIT_EMAIL,
        REQUEST_WINDOW_SECONDS,
    )
    .await
}

/// The per-workspace budget (mail cost, spraying). Charge it only for an
/// address that has access, i.e. when a mail would really be sent: charged
/// earlier, anonymous calls with made-up addresses could use it up.
pub async fn consume_workspace_request(env: &SignIn<'_>) -> RateLimitOutcome {
    consume_rate_limit(
        env.limiter,
        env.workspace_id,
        "request-ws",
        REQUEST_LIMIT_WORKSPACE,
        REQUEST_WINDOW_SECONDS,
    )
    .await
}

/// Draw a code for `email`, keep its challenge (replacing a pending one), and
/// return the code to send.
///
/// # Errors
/// The cache failed.
pub async fn store_challenge<S: Serialize + Sync>(
    env: &SignIn<'_>,
    email: &str,
    subject: S,
) -> Result<String, String> {
    let code = super::tokens::random_otp();
    let challenge = Challenge {
        code_hash: sha256_hex(&code_input(env.workspace_id, email, &code)),
        email: email.to_owned(),
        workspace_id: env.workspace_id.to_owned(),
        subject,
        attempts: 0,
    };
    kv_put_json(
        env.kv,
        &env.ns.code_key(env.workspace_id, email),
        &challenge,
        CODE_TTL_SECONDS,
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(code)
}

/// How a verify ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict<S> {
    /// The code was right and is spent; the challenge's subject.
    Verified(S),
    /// No pending code, a wrong one, or too many guesses: 401 `INVALID_CODE`.
    Invalid,
    /// A failed-attempt budget is used up: 429.
    Limited,
    /// The counters could not be reached: refuse (fail closed).
    Unavailable,
}

#[derive(Default)]
struct Reservation {
    keys: Vec<String>,
}

impl Reservation {
    async fn release(&self, env: &SignIn<'_>) {
        for key in &self.keys {
            release_rate_limit(env.limiter, env.workspace_id, key).await;
        }
    }
}

/// Reserve one failed-attempt budget, atomically, so parallel guesses cannot
/// all slip past a check-then-count. `None` when reserved; the verdict to
/// answer with (holding no slot) when not.
async fn reserve<S>(
    env: &SignIn<'_>,
    reservation: &mut Reservation,
    key: String,
    max: u32,
) -> Option<Verdict<S>> {
    let outcome = consume_rate_limit(
        env.limiter,
        env.workspace_id,
        &key,
        max,
        REQUEST_WINDOW_SECONDS,
    )
    .await;
    if outcome == RateLimitOutcome::Allowed {
        reservation.keys.push(key);
        return None;
    }
    reservation.release(env).await;
    Some(if outcome == RateLimitOutcome::Unavailable {
        Verdict::Unavailable
    } else {
        Verdict::Limited
    })
}

/// A wrong code counts the attempt on the challenge (deleting it at the cap).
async fn count_wrong<S: Serialize + Sync>(
    env: &SignIn<'_>,
    key: &str,
    challenge: Challenge<S>,
) -> Result<(), String> {
    let attempts = challenge.attempts + 1;
    if attempts >= MAX_VERIFY_ATTEMPTS {
        kv_delete(env.kv, key).await.map_err(|e| e.to_string())
    } else {
        let counted = Challenge {
            attempts,
            ..challenge
        };
        kv_put_json(env.kv, key, &counted, CODE_TTL_SECONDS)
            .await
            .map_err(|e| e.to_string())
    }
}

/// How many wrong guesses a challenge has left after `attempts` (for the
/// `attemptsLeft` a storefront answers with).
#[must_use]
pub fn attempts_left(attempts: u32) -> u32 {
    MAX_VERIFY_ATTEMPTS.saturating_sub(attempts)
}

/// Check `code` against the pending challenge of `email`.
///
/// The per-address budget is reserved first, before any lookup; the
/// per-workspace one only once a challenge exists, so calls with nothing
/// pending cannot use it up and lock every real visitor out. The budgets
/// count failures only: a right code gives them back.
///
/// # Errors
/// The cache failed.
pub async fn verify_code<S>(env: &SignIn<'_>, email: &str, code: &str) -> Result<Verdict<S>, String>
where
    S: Serialize + DeserializeOwned + Sync,
{
    let email = normalize_email(email);
    let ws = env.workspace_id;
    let mut reservation = Reservation::default();
    if let Some(refusal) = reserve(
        env,
        &mut reservation,
        format!("verify-e:{email}"),
        VERIFY_LIMIT_EMAIL,
    )
    .await
    {
        return Ok(refusal);
    }
    let key = env.ns.code_key(ws, &email);
    let challenge: Option<Challenge<S>> =
        kv_get_json(env.kv, &key).await.map_err(|e| e.to_string())?;
    let Some(challenge) = challenge else {
        return Ok(Verdict::Invalid);
    };
    if let Some(refusal) = reserve(
        env,
        &mut reservation,
        "verify-ws".to_owned(),
        VERIFY_LIMIT_WORKSPACE,
    )
    .await
    {
        return Ok(refusal);
    }
    if challenge.attempts >= MAX_VERIFY_ATTEMPTS {
        kv_delete(env.kv, &key).await.map_err(|e| e.to_string())?;
        return Ok(Verdict::Invalid);
    }
    // `attempts` is a cache read-modify-write, so guesses sent in parallel all
    // read the same value. This per-challenge counter is atomic and is what
    // really caps the guesses.
    let budget = consume_rate_limit(
        env.limiter,
        ws,
        &format!("verify-ch:{}", challenge.code_hash),
        MAX_VERIFY_ATTEMPTS,
        CODE_TTL_SECONDS,
    )
    .await;
    match budget {
        RateLimitOutcome::Unavailable => {
            reservation.release(env).await;
            return Ok(Verdict::Unavailable);
        }
        RateLimitOutcome::Limited => {
            kv_delete(env.kv, &key).await.map_err(|e| e.to_string())?;
            return Ok(Verdict::Invalid);
        }
        RateLimitOutcome::Allowed => {}
    }
    if sha256_hex(&code_input(ws, &email, code)) != challenge.code_hash {
        count_wrong(env, &key, challenge).await?;
        return Ok(Verdict::Invalid);
    }
    // The code was right: it is spent, and this attempt is not a failure.
    kv_delete(env.kv, &key).await.map_err(|e| e.to_string())?;
    reservation.release(env).await;
    Ok(Verdict::Verified(challenge.subject))
}

/// Keep a new session; the token to hand to the visitor.
///
/// # Errors
/// The cache failed.
pub async fn create_session<S: Serialize + Sync>(
    env: &SignIn<'_>,
    record: &SessionRecord<S>,
) -> Result<String, String> {
    create_session_prefixed(env, record, "").await
}

/// [`create_session`] with a token that starts with `prefix` (`wss_…`): the
/// session is kept under the hash of the whole token.
///
/// # Errors
/// The cache failed.
pub async fn create_session_prefixed<S: Serialize + Sync>(
    env: &SignIn<'_>,
    record: &SessionRecord<S>,
    prefix: &str,
) -> Result<String, String> {
    let token = format!("{prefix}{}", random_token(32));
    kv_put_json(
        env.kv,
        &env.ns.session_key(&sha256_hex(&token)),
        record,
        SESSION_TTL_SECONDS,
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(token)
}

/// The session of `token`, with its hash; `None` when it is gone or expired.
///
/// # Errors
/// The cache failed.
pub async fn read_session<S: DeserializeOwned>(
    kv: &PortalKv,
    ns: Namespace,
    token: &str,
) -> Result<Option<(String, SessionRecord<S>)>, String> {
    let hash = sha256_hex(token);
    let record = kv_get_json(kv, &ns.session_key(&hash))
        .await
        .map_err(|e| e.to_string())?;
    Ok(record.map(|record| (hash, record)))
}

/// Sliding expiry: the record to write again when the session was last
/// written more than a day ago, with `last_seen_at` moved to now. The caller
/// writes it with [`store_session`] in the background of the request.
#[must_use]
pub fn refreshed_session<S: Clone>(
    record: &SessionRecord<S>,
    now_iso: &str,
    now_millis: i64,
) -> Option<SessionRecord<S>> {
    session_needs_refresh(&record.last_seen_at, now_millis).then(|| SessionRecord {
        last_seen_at: now_iso.to_owned(),
        ..record.clone()
    })
}

/// Write a session record again under its token hash, with a new TTL.
///
/// # Errors
/// The cache failed.
pub async fn store_session<S: Serialize + Sync>(
    kv: &PortalKv,
    ns: Namespace,
    token_hash: &str,
    record: &SessionRecord<S>,
) -> Result<(), String> {
    kv_put_json(kv, &ns.session_key(token_hash), record, SESSION_TTL_SECONDS)
        .await
        .map_err(|e| e.to_string())
}

/// End the session of `token` (best effort).
pub async fn end_session(kv: &PortalKv, ns: Namespace, token: &str) {
    if let Err(error) = kv_delete(kv, &ns.session_key(&sha256_hex(token))).await {
        tracing::error!(%error, "[portal] sign-out failed");
    }
}

/// The `RATE_LIMITED` body every portal answers a spent budget with.
#[must_use]
pub fn rate_limited_body() -> serde_json::Value {
    json!({ "error": { "code": "RATE_LIMITED", "message": messages::TOO_MANY_ATTEMPTS } })
}

#[cfg(test)]
mod tests {
    use weldsuite_ports::{DynCache, MemoryCache};

    use super::*;
    use crate::portal::rate_limit::CacheRateLimitCounters;

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Contacts {
        #[serde(default)]
        contact_ids: Vec<String>,
    }

    fn parts() -> (PortalKv, Arc<dyn RateLimitCounters>) {
        let cache: Arc<dyn DynCache> = Arc::new(MemoryCache::new());
        (
            Some(Arc::clone(&cache)),
            Arc::new(CacheRateLimitCounters::new(cache)),
        )
    }

    fn record() -> SessionRecord<Contacts> {
        SessionRecord {
            workspace_id: "ws".into(),
            clerk_org_id: None,
            workspace_slug: "acme".into(),
            workspace_name: "Acme".into(),
            email: "a@b.c".into(),
            subject: Contacts {
                contact_ids: vec![],
            },
            created_at: "2026-11-01T08:00:00.000Z".into(),
            last_seen_at: "2026-11-01T08:00:00.000Z".into(),
        }
    }

    #[test]
    fn keys_and_hash_input() {
        let ns = Namespace("pportal");
        assert_eq!(
            ns.code_key("ws_1", " Femke@Client.test "),
            "pportal:code:ws_1:femke@client.test"
        );
        assert_eq!(ns.session_key("abc"), "pportal:sess:abc");
        assert_eq!(ns.slug_key("acme"), "pportal:slug:acme");
        assert_eq!(code_input("ws_1", "A@B.c", "123456"), "ws_1:a@b.c:123456");
    }

    #[test]
    fn records_serialise_in_the_order_the_worker_writes_them() {
        let challenge = Challenge {
            code_hash: "h".into(),
            email: "a@b.c".into(),
            workspace_id: "ws".into(),
            subject: Contacts {
                contact_ids: vec!["pe_1".into()],
            },
            attempts: 0,
        };
        assert_eq!(
            serde_json::to_string(&challenge).expect("json"),
            r#"{"codeHash":"h","email":"a@b.c","workspaceId":"ws","contactIds":["pe_1"],"attempts":0}"#
        );
        let back: Challenge<Contacts> = serde_json::from_str(
            r#"{"codeHash":"h","email":"a@b.c","workspaceId":"ws","contactIds":["pe_1"]}"#,
        )
        .expect("an old record without attempts");
        assert_eq!(back.attempts, 0);
        assert_eq!(
            serde_json::to_string(&record()).expect("json"),
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

    #[tokio::test]
    async fn a_code_is_checked_counted_and_spent() {
        let (kv, limiter) = parts();
        let env = SignIn {
            kv: &kv,
            limiter: Some(&limiter),
            ns: Namespace("t"),
            workspace_id: "ws",
        };
        let subject = Contacts {
            contact_ids: vec!["c1".into()],
        };
        let code = store_challenge(&env, "a@b.c", subject.clone())
            .await
            .expect("stored");
        let wrong = if code == "000000" { "111111" } else { "000000" };
        assert_eq!(
            verify_code::<Contacts>(&env, "A@B.c", wrong).await,
            Ok(Verdict::Invalid)
        );
        assert_eq!(
            verify_code::<Contacts>(&env, "a@b.c", &code).await,
            Ok(Verdict::Verified(subject))
        );
        // Spent.
        assert_eq!(
            verify_code::<Contacts>(&env, "a@b.c", &code).await,
            Ok(Verdict::Invalid)
        );
    }

    #[tokio::test]
    async fn eight_wrong_guesses_throw_the_code_away() {
        let (kv, limiter) = parts();
        let env = SignIn {
            kv: &kv,
            limiter: Some(&limiter),
            ns: Namespace("t"),
            workspace_id: "ws",
        };
        let code = store_challenge(
            &env,
            "a@b.c",
            Contacts {
                contact_ids: vec![],
            },
        )
        .await
        .expect("stored");
        let wrong = if code == "000000" { "111111" } else { "000000" };
        for _ in 0..8 {
            assert_eq!(
                verify_code::<Contacts>(&env, "a@b.c", wrong).await,
                Ok(Verdict::Invalid)
            );
        }
        // Even the right code is refused now.
        assert_eq!(
            verify_code::<Contacts>(&env, "a@b.c", &code).await,
            Ok(Verdict::Invalid)
        );
    }

    #[tokio::test]
    async fn no_limiter_fails_closed_and_sessions_round_trip() {
        let (kv, _) = parts();
        let env = SignIn {
            kv: &kv,
            limiter: None,
            ns: Namespace("t"),
            workspace_id: "ws",
        };
        assert_eq!(
            verify_code::<Contacts>(&env, "a@b.c", "123456").await,
            Ok(Verdict::Unavailable)
        );
        assert_eq!(
            consume_email_request(&env, "a@b.c").await,
            RateLimitOutcome::Unavailable
        );
        let token = create_session(&env, &record()).await.expect("session");
        let (hash, read) = read_session::<Contacts>(&kv, Namespace("t"), &token)
            .await
            .expect("read")
            .expect("found");
        assert_eq!(read, record());
        assert_eq!(hash, sha256_hex(&token));
        end_session(&kv, Namespace("t"), &token).await;
        assert!(
            read_session::<Contacts>(&kv, Namespace("t"), &token)
                .await
                .expect("read")
                .is_none()
        );
    }

    #[test]
    fn tokens_are_read_from_their_headers() {
        let mut headers = http::HeaderMap::new();
        assert_eq!(read_bearer(&headers), None);
        headers.insert("authorization", "Bearer  tok ".parse().expect("header"));
        assert_eq!(read_bearer(&headers), Some("tok".to_owned()));
        headers.insert("x-shopper-token", " wss_1 ".parse().expect("header"));
        assert_eq!(
            read_header_token(&headers, "x-shopper-token"),
            Some("wss_1".to_owned())
        );
        assert_eq!(read_header_token(&headers, "x-nothing"), None);
        assert_eq!(attempts_left(3), 5);
        assert_eq!(attempts_left(20), 0);
    }
}
