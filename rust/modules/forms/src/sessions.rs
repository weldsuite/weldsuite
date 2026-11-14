//! Respondent sessions, verification tokens and seeds (`services/sessions.ts`).
//!
//! A session token is HMAC-signed with `FORMS_SESSION_SECRET` and bound to
//! the workspace, the form, the version, a pre-generated response id, the
//! respondent mode and, when known, the invitation or verified email. Valid
//! seven days. Its bytes are the worker's for the same payload and secret
//! (the keys in the order the worker writes them), so a session either
//! backend issued opens on the other. What the respondent arrived with waits
//! in the cache (the seed) until the first saved progress creates the row.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::common::{Env, FormsResult, Svc, forms_error};
use crate::crypto::{hmac_hex, sign_token, verify_token};

// `FORM_LIMITS` of `@weldsuite/app-api-client/schemas/weldforms`.
pub(crate) const SESSION_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;
pub(crate) const CODE_TTL_SECONDS: i64 = 10 * 60;
pub(crate) const CODE_MAX_ATTEMPTS: i64 = 5;
pub(crate) const CODE_LOCK_SECONDS: i64 = 15 * 60;
pub(crate) const MIN_FILL_MS: f64 = 1500.0;
pub(crate) const VERIFICATION_TTL_SECONDS: i64 = 30 * 60;

/// `sessionSecret(env)`: 503 while `FORMS_SESSION_SECRET` is unset.
pub(crate) fn session_secret(env: &Env) -> FormsResult<String> {
    env.non_empty("FORMS_SESSION_SECRET").ok_or_else(|| {
        forms_error(
            503,
            "SERVICE_UNAVAILABLE",
            "Forms are not configured on this deployment.",
        )
    })
}

/// `RespondentSession`, the keys in the worker's order (`{ ...session, exp }`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct RespondentSession {
    /// Clerk org id of the workspace.
    pub(crate) org: String,
    /// `workspaces.id`.
    pub(crate) ws: String,
    pub(crate) form: String,
    #[serde(rename = "pub")]
    pub(crate) public_id: String,
    pub(crate) ver: String,
    pub(crate) resp: String,
    pub(crate) mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) inv: Option<String>,
    pub(crate) exp: i64,
}

/// `issueSession(env, session, now)`: the token and its expiry (ms).
pub(crate) fn issue_session(
    env: &Env,
    mut session: RespondentSession,
    now_ms: i64,
) -> FormsResult<(String, i64)> {
    let secret = session_secret(env)?;
    let exp = now_ms + SESSION_TTL_SECONDS * 1000;
    session.exp = exp;
    Ok((sign_token(&secret, &session), exp))
}

/// `readSession(env, token, now)`.
pub(crate) fn read_session(
    env: &Env,
    token: Option<&str>,
    now_ms: i64,
) -> FormsResult<Option<RespondentSession>> {
    let Some(token) = token.filter(|token| !token.is_empty()) else {
        return Ok(None);
    };
    let secret = session_secret(env)?;
    let Some(payload) = verify_token(&secret, token, now_ms) else {
        return Ok(None);
    };
    let truthy = |key: &str| payload[key].as_str().is_some_and(|text| !text.is_empty());
    if !(truthy("org") && truthy("form") && truthy("resp") && truthy("ver")) {
        return Ok(None);
    }
    let text = |key: &str| payload[key].as_str().unwrap_or_default().to_owned();
    #[allow(clippy::cast_possible_truncation)]
    let exp = payload["exp"].as_f64().unwrap_or_default() as i64;
    Ok(Some(RespondentSession {
        org: text("org"),
        ws: text("ws"),
        form: text("form"),
        public_id: text("pub"),
        ver: text("ver"),
        resp: text("resp"),
        mode: text("mode"),
        email: payload["email"].as_str().map(str::to_owned),
        inv: payload["inv"].as_str().map(str::to_owned),
        exp,
    }))
}

/// `requireSession(env, authorization)`: 401 `UNAUTHORIZED` when it is
/// missing, forged or expired.
pub(crate) fn require_session(
    env: &Env,
    authorization: Option<&str>,
    now_ms: i64,
) -> FormsResult<RespondentSession> {
    let token = authorization
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(weldsuite_kit::validation::js_trim);
    read_session(env, token, now_ms)?.ok_or_else(expired)
}

pub(crate) fn expired() -> crate::common::Fail {
    forms_error(
        401,
        "UNAUTHORIZED",
        "Your session has expired. Open the form again.",
    )
}

#[derive(Serialize)]
struct VerificationToken<'a> {
    typ: &'static str,
    form: &'a str,
    email: &'a str,
    exp: i64,
}

/// `issueVerification(env, formId, email, now)`.
pub(crate) fn issue_verification(
    env: &Env,
    form_id: &str,
    email: &str,
    now_ms: i64,
) -> FormsResult<String> {
    let secret = session_secret(env)?;
    Ok(sign_token(
        &secret,
        &VerificationToken {
            typ: "verify",
            form: form_id,
            email,
            exp: now_ms + VERIFICATION_TTL_SECONDS * 1000,
        },
    ))
}

/// `readVerification(env, token, formId, now)`: the verified email.
pub(crate) fn read_verification(
    env: &Env,
    token: Option<&str>,
    form_id: &str,
    now_ms: i64,
) -> FormsResult<Option<String>> {
    let Some(token) = token.filter(|token| !token.is_empty()) else {
        return Ok(None);
    };
    let secret = session_secret(env)?;
    Ok(verify_token(&secret, token, now_ms).and_then(|payload| {
        (payload["typ"] == "verify" && payload["form"] == form_id)
            .then(|| payload["email"].as_str().map(str::to_owned))
            .flatten()
    }))
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/// `SessionSeed`, as the worker stores it (`forms:seed:<responseId>`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSeed {
    #[serde(default)]
    pub(crate) hidden: Map<String, Value>,
    #[serde(default)]
    pub(crate) metadata: Map<String, Value>,
    #[serde(default)]
    pub(crate) ip_hash: Option<String>,
    #[serde(default)]
    pub(crate) browser_hash: Option<String>,
    pub(crate) started_at: i64,
}

fn seed_key(response_id: &str) -> String {
    format!("forms:seed:{response_id}")
}

pub(crate) async fn save_seed(svc: &Svc, response_id: &str, seed: &SessionSeed) -> FormsResult<()> {
    let text = serde_json::to_string(seed)?;
    svc.cache
        .put_boxed(
            &seed_key(response_id),
            &text,
            Some(std::time::Duration::from_secs(
                u64::try_from(SESSION_TTL_SECONDS).unwrap_or(0),
            )),
        )
        .await?;
    Ok(())
}

pub(crate) async fn read_seed(svc: &Svc, response_id: &str) -> FormsResult<Option<SessionSeed>> {
    let Some(raw) = svc.cache.get_boxed(&seed_key(response_id)).await? else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&raw).ok())
}

pub(crate) async fn drop_seed(svc: &Svc, response_id: &str) -> FormsResult<()> {
    svc.cache.delete_boxed(&seed_key(response_id)).await?;
    Ok(())
}

/// `keyedHash(env, purpose, value)`: a keyed hash of something personal.
pub(crate) fn keyed_hash(env: &Env, purpose: &str, value: &str) -> FormsResult<String> {
    Ok(hmac_hex(
        &session_secret(env)?,
        &format!("{purpose}:{value}"),
    ))
}
