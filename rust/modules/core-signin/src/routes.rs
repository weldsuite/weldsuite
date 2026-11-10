//! The `/api/sign-in` routes, relative to that path. None takes a session
//! token: they are what a person without one calls. Each answers the next
//! step of the sign-in ([`Step`]), or an error the screen words itself
//! (`INVALID_CREDENTIALS`, `INVALID_CODE`, `ACCOUNT_LOCKED`, `RATE_LIMITED`,
//! `EMAIL_TAKEN`, `WEAK_PASSWORD`, `SIGN_UP_DISABLED`, `NO_SESSION`).

use std::collections::HashMap;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use http::header::{CACHE_CONTROL, CONTENT_TYPE, SET_COOKIE};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::json_body;
use weldsuite_kit::{ApiError, Data, NoContent};
use weldsuite_ports::{
    AuthRequest, CodeFormat, CodeKind, NewUser, Prompt, SessionRef, SignInError, SignInSettings,
    UserStatus,
};

use crate::SignInState;
use crate::cookie::{self, Change};
use crate::flow::{Factor, Known, Outcome, Step, advance};
use crate::limits::{
    CODES_PER_CALLER, CODES_PER_TARGET, PASSWORDS_PER_ACCOUNT, PASSWORDS_PER_CALLER, READS,
    SENDS_PER_CALLER, SENDS_PER_TARGET, SIGN_UPS_PER_CALLER,
};

/// A session lives this long where the provider's policy names no lifetime
/// for a password check (the provider's own login uses the same fallback).
const DEFAULT_SESSION_LIFETIME: Duration = Duration::from_hours(24);
/// How long the browser keeps the cookie. The provider ends the session
/// itself; a cookie that outlives it names a session that is gone.
const COOKIE_LIFETIME: Duration = Duration::from_hours(30 * 24);

type Answer = Result<(Step, Change), ApiError>;

// ── answers ─────────────────────────────────────────────────────────────────

/// Any answer, never cached, with what it does to the cookie.
fn respond(headers: &HeaderMap, body: impl IntoResponse, change: &Change) -> Response {
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(value) = cookie::header(change, cookie::secure(headers)) {
        response.headers_mut().append(SET_COOKIE, value);
    }
    response
}

fn step_response(headers: &HeaderMap, answer: Answer) -> Response {
    match answer {
        Ok((step, change)) => respond(headers, Data(step.to_json()), &change),
        Err(error) => respond(headers, error, &Change::Keep),
    }
}

fn empty_response(headers: &HeaderMap, answer: Result<Change, ApiError>) -> Response {
    match answer {
        Ok(change) => respond(headers, NoContent, &change),
        Err(error) => respond(headers, error, &Change::Keep),
    }
}

fn refused(status: StatusCode, code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(status, code, message)
}

fn invalid_credentials() -> ApiError {
    refused(
        StatusCode::UNAUTHORIZED,
        "INVALID_CREDENTIALS",
        "Invalid email or password",
    )
}

fn invalid_code() -> ApiError {
    refused(
        StatusCode::BAD_REQUEST,
        "INVALID_CODE",
        "Invalid or expired code",
    )
}

fn no_session() -> ApiError {
    refused(StatusCode::UNAUTHORIZED, "NO_SESSION", "Sign in again")
}

fn email_taken() -> ApiError {
    refused(
        StatusCode::CONFLICT,
        "EMAIL_TAKEN",
        "An account with this email address already exists",
    )
}

/// The provider's refusal, as the screens word it. What a person cannot do
/// anything about is logged and answered as unavailable.
fn refusal(error: SignInError) -> ApiError {
    match error {
        SignInError::InvalidCredentials | SignInError::NoPassword => invalid_credentials(),
        SignInError::InvalidCode => invalid_code(),
        SignInError::Locked => refused(
            StatusCode::FORBIDDEN,
            "ACCOUNT_LOCKED",
            "This account is locked",
        ),
        SignInError::WeakPassword => refused(
            StatusCode::BAD_REQUEST,
            "WEAK_PASSWORD",
            "Password does not meet the requirements",
        ),
        SignInError::EmailTaken => email_taken(),
        SignInError::NoSession => no_session(),
        SignInError::Expired => refused(
            StatusCode::GONE,
            "SIGN_IN_EXPIRED",
            "This sign-in has expired. Start again.",
        ),
        SignInError::Forbidden(reason) => {
            // A setup fault, not the person's: the service user lacks a role.
            tracing::error!(%reason, "sign-in: the provider refused the service user");
            ApiError::unavailable("Sign-in is temporarily unavailable. Try again in a moment.")
        }
        SignInError::Unavailable(reason) => {
            tracing::warn!(%reason, "sign-in: provider unavailable");
            ApiError::unavailable("Sign-in is temporarily unavailable. Try again in a moment.")
        }
    }
}

// ── reading requests ────────────────────────────────────────────────────────

fn invalid(field: &str) -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "VALIDATION_ERROR",
        format!("{field} is missing or invalid"),
    )
}

/// A JSON object body. Anything else (a form post from another site
/// included) has no fields.
struct Fields(Map<String, Value>);

impl Fields {
    fn parse(headers: &HeaderMap, body: &Bytes) -> Result<Self, ApiError> {
        let content_type = headers
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok());
        match json_body(content_type, body) {
            Ok(Value::Object(fields)) => Ok(Self(fields)),
            _ => Err(invalid("The request body")),
        }
    }

    /// A string of 1 to `max` characters, as sent.
    fn text(&self, key: &str, max: usize) -> Result<&str, ApiError> {
        self.optional(key, max)?.ok_or_else(|| invalid(key))
    }

    /// As [`Fields::text`], or `None` when absent, null or empty.
    fn optional(&self, key: &str, max: usize) -> Result<Option<&str>, ApiError> {
        match self.0.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) if text.is_empty() => Ok(None),
            Some(Value::String(text)) if text.chars().count() <= max => Ok(Some(text)),
            Some(_) => Err(invalid(key)),
        }
    }

    /// An address: trimmed, with an `@` inside it.
    fn email(&self, key: &str) -> Result<&str, ApiError> {
        let email = self.text(key, 320)?.trim();
        let plausible = email
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.'))
            && !email.chars().any(char::is_whitespace);
        if plausible {
            Ok(email)
        } else {
            Err(invalid(key))
        }
    }

    fn password(&self) -> Result<&str, ApiError> {
        self.text("password", 1024)
    }

    /// The auth request's id, when it could be one. `None` is answered as
    /// an expired sign-in: the provider knows no such request either.
    fn auth_request(&self) -> Option<&str> {
        self.optional("authRequest", 128)
            .ok()
            .flatten()
            .filter(|id| plain_id(id))
    }
}

/// An id the provider could have made: letters, digits, `_` and `-`.
fn plain_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// A code as typed: without spaces, and in capitals where the provider's
/// codes have no small letters.
fn typed_code(code: &str, format: CodeFormat) -> String {
    let code: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    if format.uppercase {
        code.to_uppercase()
    } else {
        code
    }
}

// ── the sign-in ─────────────────────────────────────────────────────────────

async fn load_request(state: &SignInState, id: &str) -> Result<Option<AuthRequest>, ApiError> {
    match state.provider.auth_request(id).await {
        Ok(request) => Ok(Some(request)),
        Err(SignInError::Expired) => Ok(None),
        Err(error) => Err(refusal(error)),
    }
}

async fn settings(
    state: &SignInState,
    organization: Option<&str>,
) -> Result<SignInSettings, ApiError> {
    state.provider.settings(organization).await.map_err(refusal)
}

fn hosted(state: &SignInState, request: &AuthRequest) -> Result<Step, ApiError> {
    state
        .provider
        .hosted_url(&request.id)
        .map(|url| Step::Hosted { url })
        .ok_or_else(|| {
            tracing::error!(
                "sign-in: this sign-in needs the provider's own page, and its public address is not configured"
            );
            ApiError::unavailable("Sign-in is temporarily unavailable. Try again in a moment.")
        })
}

/// The auth request answered with "sign-in required", for a request that
/// asked not to be shown anything (`prompt=none`).
async fn refuse(state: &SignInState, request: &AuthRequest) -> Result<Step, ApiError> {
    match state.provider.refuse(&request.id).await {
        Ok(redirect_url) => Ok(Step::Complete { redirect_url }),
        Err(SignInError::Expired) => Ok(Step::Expired),
        Err(error) => Err(refusal(error)),
    }
}

/// Nobody is signed in: the form, the provider's page where it does not
/// take passwords, or a refusal for `prompt=none`.
async fn ask_credentials(state: &SignInState, request: &AuthRequest) -> Result<Step, ApiError> {
    if request.asks(Prompt::None) {
        return refuse(state, request).await;
    }
    let settings = settings(state, None).await?;
    if !settings.allow_password {
        return hosted(state, request);
    }
    Ok(Step::NeedsCredentials {
        sign_up: request.asks(Prompt::Create),
        login_hint: request.login_hint.clone(),
        allow_register: settings.allow_register,
        allow_password_reset: settings.allow_password_reset,
    })
}

/// Take `session` as far as it goes for `request`.
///
/// `changed`: the session is new, or has a new token, so the cookie is
/// written. `announce`: the step was reached by something the person did,
/// so a code it asks for is emailed now (reading where a sign-in stands
/// sends nothing: a reload must not send a new code).
async fn settle(
    state: &SignInState,
    request: &AuthRequest,
    session: SessionRef,
    changed: bool,
    known: Known,
    announce: bool,
) -> Answer {
    let mut session = session;
    let mut changed = changed;
    let outcome = advance(state.provider.as_ref(), request, &session, known)
        .await
        .map_err(refusal)?;
    let step = match outcome {
        Outcome::Credentials { session_gone } => {
            let step = ask_credentials(state, request).await?;
            let change = if session_gone {
                Change::Clear
            } else {
                Change::Keep
            };
            return Ok((step, change));
        }
        Outcome::Step(step) => step,
    };
    if request.asks(Prompt::None) && !matches!(step, Step::Complete { .. } | Step::Expired) {
        return Ok((refuse(state, request).await?, Change::Keep));
    }
    if announce {
        match &step {
            Step::NeedsSecondFactor { factors, .. } if !factors.contains(&Factor::Totp) => {
                // No authenticator app: the code goes by email, now, unless
                // the account was sent too many (the screen has "Resend").
                let account = account_of(state, &session).await?;
                if state.limits.hit(SENDS_PER_TARGET, &account).await.is_ok() {
                    session = state
                        .provider
                        .send_email_code(&session, state.links.second_factor())
                        .await
                        .map_err(refusal)?;
                    changed = true;
                }
            }
            Step::NeedsEmailVerification { .. } => {
                send_verification(state, &session).await;
            }
            _ => {}
        }
    }
    let change = if changed {
        Change::Set(session, COOKIE_LIFETIME)
    } else {
        Change::Keep
    };
    Ok((step, change))
}

/// Email the code that verifies the session's account, unless it was sent
/// too often. Never fails the step: the screen has "Resend".
async fn send_verification(state: &SignInState, session: &SessionRef) {
    let Ok(Some(session_state)) = state.provider.session(session).await else {
        return;
    };
    if state
        .limits
        .hit(SENDS_PER_TARGET, &session_state.user_id)
        .await
        .is_err()
    {
        return;
    }
    if let Err(error) = state
        .provider
        .send_email_verification(&session_state.user_id, state.links.verification())
        .await
    {
        tracing::warn!(%error, "sign-in: verification email not sent");
    }
}

/// How long a session of this account lives: its organization's policy.
async fn session_lifetime(state: &SignInState, organization: Option<&str>) -> Duration {
    match state.provider.settings(organization).await {
        Ok(settings) => settings
            .password_lifetime
            .unwrap_or(DEFAULT_SESSION_LIFETIME),
        Err(error) => {
            tracing::warn!(%error, "sign-in: policy not read, using the default session lifetime");
            DEFAULT_SESSION_LIFETIME
        }
    }
}

// ── GET /request ────────────────────────────────────────────────────────────

/// Where a sign-in stands: what the screen opens with. A browser the
/// provider still knows (switching workspace, another tab) goes straight on.
pub(crate) async fn request(
    State(state): State<SignInState>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let answer = async {
        state
            .limits
            .hit(READS, &state.limits.caller(&headers))
            .await?;
        let Some(id) = query.get("authRequest").filter(|id| plain_id(id)) else {
            return Ok((Step::Expired, Change::Keep));
        };
        let Some(request) = load_request(&state, id).await? else {
            return Ok((Step::Expired, Change::Keep));
        };
        match cookie::read(&headers) {
            // Sign-up was asked for: the form, whoever this browser's session is.
            Some(session) if !request.asks(Prompt::Create) => {
                settle(&state, &request, session, false, Known::default(), false).await
            }
            _ => Ok((ask_credentials(&state, &request).await?, Change::Keep)),
        }
    }
    .await;
    step_response(&headers, answer)
}

// ── POST /password ──────────────────────────────────────────────────────────

pub(crate) async fn password(
    State(state): State<SignInState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let answer = async {
        let fields = Fields::parse(&headers, &body)?;
        let email = fields.email("email")?;
        let password = fields.password()?;
        let caller = state.limits.caller(&headers);
        state.limits.hit(PASSWORDS_PER_CALLER, &caller).await?;
        state.limits.hit(PASSWORDS_PER_ACCOUNT, email).await?;
        let Some(request) = load_request_of(&state, &fields).await? else {
            return Ok((Step::Expired, Change::Keep));
        };

        let policy = settings(&state, None).await?;
        if !policy.allow_password {
            return Ok((hosted(&state, &request)?, Change::Keep));
        }
        // An unknown account and a wrong password get the same answer.
        let Some(user) = state
            .provider
            .find_user(email, policy.sign_in_with_email)
            .await
            .map_err(refusal)?
        else {
            return Err(invalid_credentials());
        };
        let lifetime = session_lifetime(&state, user.organization_id.as_deref()).await;
        let session = match state
            .provider
            .start_session(&user.id, password, Some(lifetime))
            .await
        {
            Ok(session) => session,
            // The account signs in another way (a passkey, an external
            // provider): the provider's page does that. Where the provider
            // hides which accounts exist, so does this answer.
            Err(SignInError::NoPassword) if !policy.hide_unknown_accounts => {
                return Ok((hosted(&state, &request)?, Change::Keep));
            }
            Err(error) => return Err(refusal(error)),
        };
        settle(&state, &request, session, true, Known::default(), true).await
    }
    .await;
    step_response(&headers, answer)
}

async fn load_request_of(
    state: &SignInState,
    fields: &Fields,
) -> Result<Option<AuthRequest>, ApiError> {
    match fields.auth_request() {
        Some(id) => load_request(state, id).await,
        None => Ok(None),
    }
}

// ── POST /second-factor, /second-factor/email-code ──────────────────────────

pub(crate) async fn second_factor(
    State(state): State<SignInState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let answer = async {
        let fields = Fields::parse(&headers, &body)?;
        let factor = Factor::parse(fields.text("factor", 32)?).ok_or_else(|| invalid("factor"))?;
        let code = fields.text("code", 64)?;
        let session = cookie::read(&headers).ok_or_else(no_session)?;
        state
            .limits
            .hit(CODES_PER_CALLER, &state.limits.caller(&headers))
            .await?;
        let account = account_of(&state, &session).await?;
        state.limits.hit(CODES_PER_TARGET, &account).await?;
        let Some(request) = load_request_of(&state, &fields).await? else {
            return Ok((Step::Expired, Change::Keep));
        };

        let checked = match factor {
            Factor::Totp => {
                let code = typed_code(
                    code,
                    CodeFormat {
                        length: 6,
                        letters: false,
                        uppercase: false,
                    },
                );
                state.provider.check_totp(&session, &code).await
            }
            Factor::EmailCode => {
                let format = state
                    .provider
                    .code_format(CodeKind::EmailSecondFactor)
                    .await;
                state
                    .provider
                    .check_email_code(&session, &typed_code(code, format))
                    .await
            }
        }
        .map_err(refusal)?;
        settle(&state, &request, checked, true, Known::default(), true).await
    }
    .await;
    step_response(&headers, answer)
}

/// Email the second-factor code (again) to whoever passed the password check.
pub(crate) async fn send_second_factor_code(
    State(state): State<SignInState>,
    headers: HeaderMap,
) -> Response {
    let answer = async {
        let session = cookie::read(&headers).ok_or_else(no_session)?;
        state
            .limits
            .hit(SENDS_PER_CALLER, &state.limits.caller(&headers))
            .await?;
        let account = account_of(&state, &session).await?;
        state.limits.hit(SENDS_PER_TARGET, &account).await?;
        let session = state
            .provider
            .send_email_code(&session, state.links.second_factor())
            .await
            .map_err(refusal)?;
        Ok(Change::Set(session, COOKIE_LIFETIME))
    }
    .await;
    empty_response(&headers, answer)
}

// ── POST /email-verification, /resend, /link ────────────────────────────────

/// The account a session belongs to: what codes and emails are counted
/// against. Never the session itself: the password again opens a new one,
/// which must not start a new count.
async fn account_of(state: &SignInState, session: &SessionRef) -> Result<String, ApiError> {
    state
        .provider
        .session(session)
        .await
        .map_err(refusal)?
        .map(|session_state| session_state.user_id)
        .ok_or_else(no_session)
}

/// The account behind the browser's session.
async fn session_user(
    state: &SignInState,
    headers: &HeaderMap,
) -> Result<(SessionRef, String), ApiError> {
    let session = cookie::read(headers).ok_or_else(no_session)?;
    let user_id = account_of(state, &session).await?;
    Ok((session, user_id))
}

pub(crate) async fn verify_email(
    State(state): State<SignInState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let answer = async {
        let fields = Fields::parse(&headers, &body)?;
        let code = fields.text("code", 64)?;
        let (session, user_id) = session_user(&state, &headers).await?;
        state
            .limits
            .hit(CODES_PER_CALLER, &state.limits.caller(&headers))
            .await?;
        state.limits.hit(CODES_PER_TARGET, &user_id).await?;
        let Some(request) = load_request_of(&state, &fields).await? else {
            return Ok((Step::Expired, Change::Keep));
        };

        let format = state
            .provider
            .code_format(CodeKind::EmailVerification)
            .await;
        state
            .provider
            .verify_email(&user_id, &typed_code(code, format))
            .await
            .map_err(refusal)?;
        let known = Known {
            email_verified: true,
        };
        settle(&state, &request, session, false, known, true).await
    }
    .await;
    step_response(&headers, answer)
}

pub(crate) async fn resend_verification(
    State(state): State<SignInState>,
    headers: HeaderMap,
) -> Response {
    let answer = async {
        let (_, user_id) = session_user(&state, &headers).await?;
        state
            .limits
            .hit(SENDS_PER_CALLER, &state.limits.caller(&headers))
            .await?;
        state.limits.hit(SENDS_PER_TARGET, &user_id).await?;
        state
            .provider
            .send_email_verification(&user_id, state.links.verification())
            .await
            .map_err(refusal)?;
        Ok(Change::Keep)
    }
    .await;
    empty_response(&headers, answer)
}

/// The link in the verification email, opened in any browser: the code
/// alone verifies the address. Signing in comes after.
pub(crate) async fn verify_email_link(
    State(state): State<SignInState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let answer = async {
        let fields = Fields::parse(&headers, &body)?;
        let user_id = fields.text("userId", 128)?;
        let code = fields.text("code", 64)?;
        if !plain_id(user_id) {
            return Err(invalid_code());
        }
        state
            .limits
            .hit(CODES_PER_CALLER, &state.limits.caller(&headers))
            .await?;
        state.limits.hit(CODES_PER_TARGET, user_id).await?;
        let format = state
            .provider
            .code_format(CodeKind::EmailVerification)
            .await;
        state
            .provider
            .verify_email(user_id, &typed_code(code, format))
            .await
            .map_err(refusal)?;
        Ok(Change::Keep)
    }
    .await;
    empty_response(&headers, answer)
}

// ── POST /sign-up ───────────────────────────────────────────────────────────

pub(crate) async fn sign_up(
    State(state): State<SignInState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let answer = async {
        let fields = Fields::parse(&headers, &body)?;
        let email = fields.email("email")?;
        let password = fields.password()?;
        let user = NewUser {
            email: email.to_owned(),
            password: password.to_owned(),
            first_name: fields
                .optional("firstName", 200)?
                .unwrap_or_default()
                .to_owned(),
            last_name: fields
                .optional("lastName", 200)?
                .unwrap_or_default()
                .to_owned(),
        };
        state
            .limits
            .hit(SIGN_UPS_PER_CALLER, &state.limits.caller(&headers))
            .await?;
        let Some(request) = load_request_of(&state, &fields).await? else {
            return Ok((Step::Expired, Change::Keep));
        };
        let policy = settings(&state, None).await?;
        if !policy.allow_register {
            return Err(refused(
                StatusCode::FORBIDDEN,
                "SIGN_UP_DISABLED",
                "Sign-up is not open",
            ));
        }
        let lifetime = policy.password_lifetime.unwrap_or(DEFAULT_SESSION_LIFETIME);

        match state
            .provider
            .create_user(&user, state.links.verification())
            .await
        {
            Ok(user_id) => {
                // The provider just emailed the code. Its read side may not
                // know the account yet, so the step is stated, not asked for.
                let session = state
                    .provider
                    .start_session(&user_id, password, Some(lifetime))
                    .await
                    .map_err(refusal)?;
                let step = Step::NeedsEmailVerification {
                    email: user.email,
                    code: state
                        .provider
                        .code_format(CodeKind::EmailVerification)
                        .await,
                };
                Ok((step, Change::Set(session, COOKIE_LIFETIME)))
            }
            Err(SignInError::EmailTaken) => {
                resume_sign_up(&state, &request, email, password, lifetime).await
            }
            Err(error) => Err(refusal(error)),
        }
    }
    .await;
    step_response(&headers, answer)
}

/// The address has an account. When it is the same person again (back from
/// the code screen, a reload), their password signs them in and the sign-up
/// goes on where it was. Anybody else learns only that the address is taken.
async fn resume_sign_up(
    state: &SignInState,
    request: &AuthRequest,
    email: &str,
    password: &str,
    lifetime: Duration,
) -> Answer {
    state.limits.hit(PASSWORDS_PER_ACCOUNT, email).await?;
    let existing = state
        .provider
        .find_user(email, true)
        .await
        .map_err(refusal)?
        .filter(|user| !user.email_verified && user.status == UserStatus::Active);
    let Some(existing) = existing else {
        return Err(email_taken());
    };
    match state
        .provider
        .start_session(&existing.id, password, Some(lifetime))
        .await
    {
        Ok(session) => settle(state, request, session, true, Known::default(), true).await,
        Err(_) => Err(email_taken()),
    }
}

// ── GET /password-policy ────────────────────────────────────────────────────

/// What the provider asks of a new password, for the checklist under the
/// field. The provider checks the password itself too.
pub(crate) async fn password_policy(
    State(state): State<SignInState>,
    headers: HeaderMap,
) -> Response {
    let answer: Result<Value, ApiError> = async {
        state
            .limits
            .hit(READS, &state.limits.caller(&headers))
            .await?;
        let rules = state.provider.password_rules(None).await.map_err(refusal)?;
        Ok(json!({
            "minLength": rules.min_length,
            "uppercase": rules.uppercase,
            "lowercase": rules.lowercase,
            "number": rules.number,
            "symbol": rules.symbol,
        }))
    }
    .await;
    match answer {
        Ok(rules) => respond(&headers, Data(rules), &Change::Keep),
        Err(error) => respond(&headers, error, &Change::Keep),
    }
}

// ── POST /password-reset, /password-reset/confirm ───────────────────────────

/// Email a reset code. The answer is the same whether or not an account has
/// the address.
pub(crate) async fn password_reset(
    State(state): State<SignInState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let answer = async {
        let fields = Fields::parse(&headers, &body)?;
        let email = fields.email("email")?;
        state
            .limits
            .hit(SENDS_PER_CALLER, &state.limits.caller(&headers))
            .await?;
        state.limits.hit(SENDS_PER_TARGET, email).await?;
        let policy = settings(&state, None).await?;
        if !policy.allow_password_reset {
            return Ok(Change::Keep);
        }
        let user = state
            .provider
            .find_user(email, policy.sign_in_with_email)
            .await
            .map_err(refusal)?
            .filter(|user| user.status == UserStatus::Active);
        if let Some(user) = user
            && let Err(error) = state
                .provider
                .send_password_reset(&user.id, state.links.password_reset())
                .await
        {
            tracing::warn!(%error, "sign-in: password reset email not sent");
        }
        Ok(Change::Keep)
    }
    .await;
    empty_response(&headers, answer)
}

/// Set a new password with the emailed code. An account nobody has is
/// answered like a wrong code.
pub(crate) async fn password_reset_confirm(
    State(state): State<SignInState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let answer = async {
        let fields = Fields::parse(&headers, &body)?;
        let code = fields.text("code", 64)?;
        let password = fields.password()?;
        let user_id = fields.optional("userId", 128)?;
        let email = match user_id {
            Some(_) => None,
            None => Some(fields.email("email")?),
        };
        state
            .limits
            .hit(CODES_PER_CALLER, &state.limits.caller(&headers))
            .await?;
        state
            .limits
            .hit(CODES_PER_TARGET, user_id.or(email).unwrap_or_default())
            .await?;

        let user_id = match (user_id, email) {
            (Some(user_id), _) if plain_id(user_id) => user_id.to_owned(),
            (None, Some(email)) => state
                .provider
                .find_user(email, true)
                .await
                .map_err(refusal)?
                .map(|user| user.id)
                .ok_or_else(invalid_code)?,
            _ => return Err(invalid_code()),
        };
        let format = state.provider.code_format(CodeKind::PasswordReset).await;
        state
            .provider
            .reset_password(&user_id, &typed_code(code, format), password)
            .await
            .map_err(refusal)?;
        Ok(Change::Keep)
    }
    .await;
    empty_response(&headers, answer)
}

// ── POST /sign-out ──────────────────────────────────────────────────────────

/// Forget the provider session: end it there, drop the cookie. The platform
/// then ends its OIDC session at the provider as before.
pub(crate) async fn sign_out(State(state): State<SignInState>, headers: HeaderMap) -> Response {
    if let Some(session) = cookie::read(&headers)
        && let Err(error) = state.provider.end_session(&session).await
    {
        tracing::warn!(%error, "sign-in: session not ended at the provider");
    }
    respond(&headers, NoContent, &Change::Clear)
}
