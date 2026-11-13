//! Zitadel behind the `SignInProvider` port (ADR SEC-016): the backend as
//! Zitadel's *login client*, so the platform can show its own sign-in screens
//! on the EU edition and the bundled self-host. Checked against the source of
//! Zitadel v4.19 (the version the Flux setup pins).
//!
//! Every call is made as a service user with the instance role
//! `IAM_LOGIN_CLIENT`: the only role with `session.link`, which answering an
//! auth request takes. `IAM_OWNER` alone can open sessions but not finish a
//! sign-in.
//!
//! | Port call | Zitadel |
//! |---|---|
//! | `auth_request` | `GET /v2/oidc/auth_requests/{id}` |
//! | `complete`, `refuse` | `POST /v2/oidc/auth_requests/{id}` with the session, or with `ERROR_REASON_LOGIN_REQUIRED` |
//! | `settings`, `password_rules` | `GET /v2/settings/login`, `/v2/settings/password/complexity` (`ctx.orgId`) |
//! | `code_format` | `GET /admin/v1/secretgenerators/{type}`, kept for the process |
//! | `find_user`, `user`, `auth_methods` | `POST /v2/users`, `GET /v2/users/{id}`, `GET /v2/users/{id}/authentication_methods` |
//! | `start_session` | `POST /v2/sessions` with the user and password checks |
//! | `session` | `GET /v2/sessions/{id}?sessionToken=…` |
//! | `check_totp`, `send_email_code`, `check_email_code` | `PATCH /v2/sessions/{id}` |
//! | `end_session` | `DELETE /v2/sessions/{id}` with the token |
//! | `create_user` | `POST /v2/users/human` in the instance's default organization |
//! | `send_email_verification`, `verify_email` | `POST /v2/users/{id}/email/send`, `/email/verify` |
//! | `send_password_reset`, `reset_password` | `POST /v2/users/{id}/password_reset`, `/password` |
//!
//! What Zitadel leaves to its login client, and so to the caller of this
//! port: whether a second factor is due, whether the address is verified,
//! whether sign-up is open. It does count wrong passwords and codes against
//! its lockout policy, and it checks new passwords against its complexity
//! policy.
//!
//! `PATCH /v2/sessions/{id}` does not look at the session token (Zitadel
//! deprecated the field and authorizes the service user instead), so every
//! call that changes a session first reads it *with* the token: a reference
//! with somebody else's session id and no token to match is no session.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use reqwest::Method;
use serde_json::{Value, json};
use weldsuite_ports::{
    AuthMethods, AuthRequest, BoxFuture, CodeFormat, CodeKind, LinkTemplate, NewUser,
    PasswordRules, Prompt, SessionRef, SessionState, SignInError, SignInProvider, SignInResult,
    SignInSettings, SignInUser, UserStatus,
};

use crate::zitadel_api::{ApiFailure, Refusal, ZitadelApi, millis, str_field};

/// How to reach Zitadel's login API.
#[derive(Clone)]
pub struct ZitadelSignInOptions {
    /// `ZITADEL_API_URL`: the instance's address (its external domain, or the
    /// in-cluster Service with the external domain as `host`).
    pub api_url: String,
    /// `ZITADEL_LOGIN_TOKEN`, else `ZITADEL_SERVICE_TOKEN`: a personal access
    /// token of a service user with the instance role `IAM_LOGIN_CLIENT`.
    pub token: String,
    /// `ZITADEL_HOST`: the `Host` header when `api_url` is in-cluster.
    pub host: Option<String>,
    /// The instance's public origin (the OIDC issuer), where its own login
    /// pages are, for what the platform's screens hand back to them.
    pub public_url: Option<String>,
}

impl std::fmt::Debug for ZitadelSignInOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZitadelSignInOptions")
            .field("api_url", &self.api_url)
            .field("host", &self.host)
            .field("public_url", &self.public_url)
            .finish_non_exhaustive()
    }
}

/// The `SignInProvider` port on Zitadel.
pub struct ZitadelSignIn {
    api: ZitadelApi,
    public_url: Option<String>,
    /// The organization people sign up in (the instance's default).
    default_org: Mutex<Option<String>>,
    /// How the instance writes its codes, read once per kind.
    formats: Mutex<HashMap<CodeKind, CodeFormat>>,
}

impl std::fmt::Debug for ZitadelSignIn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ZitadelSignIn")
            .field("public_url", &self.public_url)
            .finish_non_exhaustive()
    }
}

/// Zitadel's defaults, for an instance whose generators cannot be read: six
/// capitals and digits to verify an address or reset a password, eight
/// digits as a second factor.
const DEFAULT_VERIFICATION_CODE: CodeFormat = CodeFormat {
    length: 6,
    letters: true,
    uppercase: true,
};
const DEFAULT_SECOND_FACTOR_CODE: CodeFormat = CodeFormat {
    length: 8,
    letters: false,
    uppercase: false,
};

impl ZitadelSignIn {
    pub fn new(options: ZitadelSignInOptions) -> Result<Self, SignInError> {
        let api = ZitadelApi::new(&options.api_url, options.token, options.host)
            .map_err(SignInError::Unavailable)?;
        Ok(Self {
            api,
            public_url: options
                .public_url
                .map(|url| url.trim_end_matches('/').to_owned())
                .filter(|url| !url.is_empty()),
            default_org: Mutex::new(None),
            formats: Mutex::new(HashMap::new()),
        })
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value, ApiFailure> {
        self.api.call(method, path, query, None, body).await
    }

    /// The instance's default organization: where people sign up, and whose
    /// policy the screens show before anybody is known.
    async fn default_org(&self) -> SignInResult<String> {
        if let Some(org) = self
            .default_org
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
        {
            return Ok(org);
        }
        let settings = self
            .call(Method::GET, "/v2/settings", &[], None)
            .await
            .map_err(failed)?;
        let org = str_field(&settings, "defaultOrgId")
            .map(str::to_owned)
            .ok_or_else(|| {
                SignInError::Unavailable("zitadel names no default organization".to_owned())
            })?;
        *self
            .default_org
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(org.clone());
        Ok(org)
    }

    /// `GET /v2/settings/{path}` for `organization`, or the default one.
    async fn org_settings(&self, path: &str, organization: Option<&str>) -> SignInResult<Value> {
        let org = match organization {
            Some(org) => org.to_owned(),
            None => self.default_org().await?,
        };
        let answer = self
            .call(Method::GET, path, &[("ctx.orgId", &org)], None)
            .await
            .map_err(failed)?;
        Ok(answer.get("settings").cloned().unwrap_or(Value::Null))
    }

    async fn search_one(&self, query: Value) -> SignInResult<Option<SignInUser>> {
        let answer = self
            .call(
                Method::POST,
                "/v2/users",
                &[],
                // Two are enough to tell one account from several.
                Some(json!({ "query": { "limit": 2 }, "queries": [query] })),
            )
            .await
            .map_err(failed)?;
        let users: Vec<SignInUser> = answer
            .get("result")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter_map(user_from)
            .collect();
        Ok(match users.as_slice() {
            [user] => Some(user.clone()),
            _ => None,
        })
    }

    async fn read_session(&self, session: &SessionRef) -> SignInResult<Option<SessionState>> {
        let answer = self
            .call(
                Method::GET,
                &format!("/v2/sessions/{}", session.id),
                // With the token Zitadel checks it; without, the service
                // user's `session.read` alone would open any session.
                &[("sessionToken", &session.token)],
                None,
            )
            .await;
        match answer {
            Ok(answer) => Ok(answer.get("session").and_then(session_from)),
            Err(ApiFailure::Refused(refusal)) if matches!(refusal.status, 400 | 403 | 404) => {
                Ok(None)
            }
            Err(failure) => Err(failed(failure)),
        }
    }

    /// `PATCH /v2/sessions/{id}`, once the reference is known to be the
    /// session's; the reference with the new token.
    async fn change_session(&self, session: &SessionRef, body: Value) -> SignInResult<SessionRef> {
        if self.read_session(session).await?.is_none() {
            return Err(SignInError::NoSession);
        }
        let answer = self
            .call(
                Method::PATCH,
                &format!("/v2/sessions/{}", session.id),
                &[],
                Some(body),
            )
            .await
            .map_err(failed)?;
        let token = str_field(&answer, "sessionToken").ok_or_else(|| {
            SignInError::Unavailable("no sessionToken in zitadel's answer".to_owned())
        })?;
        Ok(SessionRef {
            id: session.id.clone(),
            token: token.to_owned(),
        })
    }

    /// `POST /v2/oidc/auth_requests/{id}`: the callback URL.
    async fn answer(&self, auth_request: &str, body: Value) -> SignInResult<String> {
        let answer = self
            .call(
                Method::POST,
                &format!("/v2/oidc/auth_requests/{auth_request}"),
                &[],
                Some(body),
            )
            .await
            .map_err(|failure| match failure {
                // Finishing a sign-in is the one call `IAM_OWNER` may not make.
                ApiFailure::Refused(refusal)
                    if refusal.status == 403 && refusal.code.as_deref() == Some("AUTH-AWfge") =>
                {
                    SignInError::Forbidden(
                        "the service user lacks the IAM_LOGIN_CLIENT role (session.link)"
                            .to_owned(),
                    )
                }
                ApiFailure::Refused(refusal) if refusal.status == 404 => SignInError::Expired,
                failure => failed(failure),
            })?;
        str_field(&answer, "callbackUrl")
            .map(str::to_owned)
            .ok_or_else(|| {
                SignInError::Unavailable("no callbackUrl in zitadel's answer".to_owned())
            })
    }

    async fn read_code_format(&self, kind: CodeKind) -> CodeFormat {
        if let Some(format) = self
            .formats
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&kind)
        {
            return *format;
        }
        let (generator, fallback) = match kind {
            CodeKind::EmailVerification => (
                "SECRET_GENERATOR_TYPE_VERIFY_EMAIL_CODE",
                DEFAULT_VERIFICATION_CODE,
            ),
            CodeKind::EmailSecondFactor => (
                "SECRET_GENERATOR_TYPE_OTP_EMAIL",
                DEFAULT_SECOND_FACTOR_CODE,
            ),
            CodeKind::PasswordReset => (
                "SECRET_GENERATOR_TYPE_PASSWORD_RESET_CODE",
                DEFAULT_VERIFICATION_CODE,
            ),
        };
        let answer = self
            .call(
                Method::GET,
                &format!("/admin/v1/secretgenerators/{generator}"),
                &[],
                None,
            )
            .await;
        let format = match answer {
            Ok(answer) => answer
                .get("secretGenerator")
                .and_then(code_format_from)
                .unwrap_or(fallback),
            Err(failure) => {
                // Not kept: the next sign-in asks again.
                tracing::warn!(
                    ?failure,
                    generator,
                    "zitadel: code format not read, using its default"
                );
                return fallback;
            }
        };
        self.formats
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(kind, format);
        format
    }

    async fn find_user_inner(
        &self,
        identifier: &str,
        by_email: bool,
    ) -> SignInResult<Option<SignInUser>> {
        let by_login_name = self
            .search_one(json!({ "loginNameQuery": {
                "loginName": identifier,
                "method": "TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE",
            } }))
            .await?;
        if by_login_name.is_some() || !by_email {
            return Ok(by_login_name);
        }
        self.search_one(json!({ "emailQuery": {
            "emailAddress": identifier,
            "method": "TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE",
        } }))
        .await
    }

    async fn user_inner(&self, user_id: &str) -> SignInResult<Option<SignInUser>> {
        match self
            .call(Method::GET, &format!("/v2/users/{user_id}"), &[], None)
            .await
        {
            Ok(answer) => Ok(answer.get("user").and_then(user_from)),
            Err(ApiFailure::Refused(refusal)) if refusal.status == 404 => Ok(None),
            Err(failure) => Err(failed(failure)),
        }
    }

    async fn auth_methods_inner(&self, user_id: &str) -> SignInResult<AuthMethods> {
        let answer = self
            .call(
                Method::GET,
                &format!("/v2/users/{user_id}/authentication_methods"),
                // No `domainQuery`: without one Zitadel lists every method,
                // passkeys and security keys whatever domain they were made
                // on. With one it requires `domain` and refuses the request
                // (400) without it, which failed every sign-in at this step.
                &[],
                None,
            )
            .await
            .map_err(failed)?;
        let mut methods = AuthMethods::default();
        for method in answer
            .get("authMethodTypes")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter_map(Value::as_str)
        {
            match method {
                "AUTHENTICATION_METHOD_TYPE_PASSWORD" => methods.password = true,
                "AUTHENTICATION_METHOD_TYPE_PASSKEY" => methods.passkey = true,
                "AUTHENTICATION_METHOD_TYPE_IDP" => methods.external = true,
                "AUTHENTICATION_METHOD_TYPE_TOTP" => methods.totp = true,
                "AUTHENTICATION_METHOD_TYPE_U2F" => methods.security_key = true,
                "AUTHENTICATION_METHOD_TYPE_OTP_SMS" => methods.sms_code = true,
                "AUTHENTICATION_METHOD_TYPE_OTP_EMAIL" => methods.email_code = true,
                _ => {}
            }
        }
        Ok(methods)
    }

    async fn start_session_inner(
        &self,
        user_id: &str,
        password: &str,
        lifetime: Option<Duration>,
    ) -> SignInResult<SessionRef> {
        let mut body = json!({ "checks": {
            "user": { "userId": user_id },
            "password": { "password": password },
        } });
        if let Some(lifetime) = lifetime.filter(|lifetime| !lifetime.is_zero()) {
            body["lifetime"] = json!(format!("{}s", lifetime.as_secs()));
        }
        let answer = self
            .call(Method::POST, "/v2/sessions", &[], Some(body))
            .await
            .map_err(failed)?;
        match (
            str_field(&answer, "sessionId"),
            str_field(&answer, "sessionToken"),
        ) {
            (Some(id), Some(token)) => Ok(SessionRef {
                id: id.to_owned(),
                token: token.to_owned(),
            }),
            _ => Err(SignInError::Unavailable(
                "no session in zitadel's answer".to_owned(),
            )),
        }
    }

    async fn create_user_inner(
        &self,
        user: &NewUser,
        link: LinkTemplate<'_>,
    ) -> SignInResult<String> {
        // Zitadel keeps login names apart, not addresses: an address that
        // already signs somebody in is taken, whatever its login name.
        if self.find_user_inner(&user.email, true).await?.is_some() {
            return Err(SignInError::EmailTaken);
        }
        // Zitadel wants both names; the address's local part stands in, as
        // for an invitation.
        let local = user.email.split('@').next().unwrap_or(&user.email);
        let name = |given: &str| {
            let given = given.trim();
            if given.is_empty() { local } else { given }.to_owned()
        };
        let answer = self
            .call(
                Method::POST,
                "/v2/users/human",
                &[],
                Some(json!({
                    "organization": { "orgId": self.default_org().await? },
                    "username": user.email,
                    "profile": {
                        "givenName": name(&user.first_name),
                        "familyName": name(&user.last_name),
                    },
                    "email": { "email": user.email, "sendCode": send_code(link) },
                    "password": { "password": user.password, "changeRequired": false },
                })),
            )
            .await
            .map_err(failed)?;
        str_field(&answer, "userId")
            .map(str::to_owned)
            .ok_or_else(|| SignInError::Unavailable("no userId in zitadel's answer".to_owned()))
    }
}

/// `{ "urlTemplate": … }` for a link, `{}` for Zitadel's own.
fn send_code(link: LinkTemplate<'_>) -> Value {
    match link {
        Some(link) => json!({ "urlTemplate": url_template(link) }),
        None => json!({}),
    }
}

/// The port's `{user}` and `{code}` in Zitadel's template syntax.
fn url_template(link: &str) -> String {
    link.replace("{user}", "{{.UserID}}")
        .replace("{code}", "{{.Code}}")
}

/// Zitadel's refusal under the port's names, by its stable error id.
fn failed(failure: ApiFailure) -> SignInError {
    let refusal = match failure {
        ApiFailure::Unreachable(reason) => return SignInError::Unavailable(reason),
        ApiFailure::Refused(refusal) => refusal,
    };
    let Refusal { status, code, .. } = &refusal;
    match code.as_deref().unwrap_or_default() {
        // Wrong password; no such user.
        "COMMAND-3M0fs" | "QUERY-Dfbg2" => SignInError::InvalidCredentials,
        "COMMAND-3nJ4t" => SignInError::NoPassword,
        // Locked or inactive, at the user, password, TOTP or OTP check.
        "SESSION-Gj4ko" | "SESSION-oL9nT" | "COMMAND-JLK35" | "COMMAND-SFA3t" | "COMMAND-SF3fg"
        | "COMMAND-S6h4R" => SignInError::Locked,
        // TOTP wrong, reused or not set up; a code wrong, expired or never asked for.
        "EVENT-8isk2" | "TOTP-Auw0a" | "COMMAND-3Mif9s" | "CODE-woT0xc" | "CODE-QvUQ4P"
        | "COMMAND-S34gh" | "COMMAND-eis9R" | "COMMAND-2M9fs" => SignInError::InvalidCode,
        // Session ended, expired or missing; not its token.
        "COMMAND-Hewfq" | "COMMAND-Hkl3d" | "COMMAND-Flk38" | "COMMAND-sGr42" | "QUERY-dsfr3"
        | "QUERY-SFeaa" => SignInError::NoSession,
        // Auth request unknown, or already answered.
        "COMMAND-jae5P" | "COMMAND-Sx208nt" | "QUERY-Thee9" => SignInError::Expired,
        // The complexity policy: length, lower, upper, number, symbol.
        "DOMAIN-HuJf6" | "DOMAIN-co3Xw" | "DOMAIN-VoaRj" | "DOMAIN-ZBv4H" | "DOMAIN-ZDLwA" => {
            SignInError::WeakPassword
        }
        code if *status == 409 => {
            tracing::debug!(code, "zitadel: already exists");
            SignInError::EmailTaken
        }
        code if *status == 403 => SignInError::Forbidden(code.to_owned()),
        code => SignInError::Unavailable(format!("zitadel answered {status} {code}")),
    }
}

fn flag(value: &Value, name: &str) -> bool {
    value.get(name).and_then(Value::as_bool).unwrap_or(false)
}

/// `"3600s"` (a protobuf duration as JSON).
fn seconds(value: &Value, name: &str) -> Option<Duration> {
    let text = str_field(value, name)?.strip_suffix('s')?;
    let seconds: f64 = text.parse().ok()?;
    (seconds.is_finite() && seconds > 0.0).then(|| Duration::from_secs_f64(seconds))
}

/// A number Zitadel writes as a number or (64-bit) as a string.
fn number(value: &Value, name: &str) -> Option<u32> {
    let field = value.get(name)?;
    field
        .as_u64()
        .or_else(|| field.as_str().and_then(|text| text.parse().ok()))
        .and_then(|n| u32::try_from(n).ok())
}

fn verified_at(factors: &Value, factor: &str) -> Option<i64> {
    factors
        .get(factor)
        .and_then(|factor| str_field(factor, "verifiedAt"))
        .and_then(millis)
}

/// A session, unless it has no user or has expired.
fn session_from(session: &Value) -> Option<SessionState> {
    let factors = session.get("factors")?;
    let user_id = factors
        .get("user")
        .and_then(|user| str_field(user, "id"))?
        .to_owned();
    if let Some(expires) = str_field(session, "expirationDate").and_then(millis)
        && expires <= jiff::Timestamp::now().as_millisecond()
    {
        return None;
    }
    // WebAuthn with user verification is a passkey; without, a security key.
    let web_authn = verified_at(factors, "webAuthN");
    let user_verified = factors
        .get("webAuthN")
        .is_some_and(|factor| flag(factor, "userVerified"));
    Some(SessionState {
        user_id,
        password_at: verified_at(factors, "password"),
        passkey_at: web_authn.filter(|_| user_verified),
        external_at: verified_at(factors, "intent"),
        totp_at: verified_at(factors, "totp"),
        email_code_at: verified_at(factors, "otpEmail"),
        sms_code_at: verified_at(factors, "otpSms"),
        security_key_at: web_authn.filter(|_| !user_verified),
    })
}

/// A human user of the v2 User API; `None` for a machine user.
fn user_from(user: &Value) -> Option<SignInUser> {
    let human = user.get("human")?;
    let email = human.get("email");
    Some(SignInUser {
        id: str_field(user, "userId")?.to_owned(),
        organization_id: user
            .get("details")
            .and_then(|details| str_field(details, "resourceOwner"))
            .map(str::to_owned),
        email: email
            .and_then(|email| str_field(email, "email"))
            .map(str::to_owned),
        email_verified: email.is_some_and(|email| flag(email, "isVerified")),
        status: match str_field(user, "state") {
            Some("USER_STATE_ACTIVE") => UserStatus::Active,
            Some("USER_STATE_INITIAL") => UserStatus::Initial,
            Some("USER_STATE_LOCKED") => UserStatus::Locked,
            // Deactivated, deleted, or a state this adapter does not know.
            _ => UserStatus::Inactive,
        },
        password_change_required: flag(human, "passwordChangeRequired"),
    })
}

fn auth_request_from(request: &Value) -> Option<AuthRequest> {
    Some(AuthRequest {
        id: str_field(request, "id")?.to_owned(),
        created_at: str_field(request, "creationDate").and_then(millis),
        prompts: request
            .get("prompt")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .filter_map(Value::as_str)
            .filter_map(|prompt| match prompt {
                "PROMPT_NONE" => Some(Prompt::None),
                "PROMPT_LOGIN" => Some(Prompt::Login),
                "PROMPT_SELECT_ACCOUNT" => Some(Prompt::SelectAccount),
                "PROMPT_CREATE" => Some(Prompt::Create),
                _ => None,
            })
            .collect(),
        login_hint: str_field(request, "loginHint").map(str::to_owned),
        max_age: seconds(request, "maxAge"),
    })
}

fn settings_from(settings: &Value) -> SignInSettings {
    SignInSettings {
        // `allowUsernamePassword` is the older name of the same switch.
        allow_password: flag(settings, "allowLocalAuthentication")
            || flag(settings, "allowUsernamePassword"),
        allow_register: flag(settings, "allowRegister"),
        allow_password_reset: !flag(settings, "hidePasswordReset"),
        force_second_factor: flag(settings, "forceMfa"),
        force_second_factor_local: flag(settings, "forceMfaLocalOnly"),
        hide_unknown_accounts: flag(settings, "ignoreUnknownUsernames"),
        sign_in_with_email: !flag(settings, "disableLoginWithEmail"),
        password_lifetime: seconds(settings, "passwordCheckLifetime"),
    }
}

fn password_rules_from(settings: &Value) -> PasswordRules {
    PasswordRules {
        min_length: number(settings, "minLength").unwrap_or(8),
        uppercase: flag(settings, "requiresUppercase"),
        lowercase: flag(settings, "requiresLowercase"),
        number: flag(settings, "requiresNumber"),
        symbol: flag(settings, "requiresSymbol"),
    }
}

/// A secret generator's settings; `None` when it has no length.
fn code_format_from(generator: &Value) -> Option<CodeFormat> {
    let length = number(generator, "length").filter(|length| *length > 0)?;
    let lower = flag(generator, "includeLowerLetters");
    let upper = flag(generator, "includeUpperLetters");
    Some(CodeFormat {
        length,
        letters: lower || upper || flag(generator, "includeSymbols"),
        uppercase: upper && !lower,
    })
}

impl SignInProvider for ZitadelSignIn {
    fn auth_request<'a>(&'a self, id: &'a str) -> BoxFuture<'a, SignInResult<AuthRequest>> {
        Box::pin(async move {
            let answer = self
                .call(
                    Method::GET,
                    &format!("/v2/oidc/auth_requests/{id}"),
                    &[],
                    None,
                )
                .await
                .map_err(|failure| match failure {
                    // Unknown, or answered: Zitadel forgets a request then.
                    ApiFailure::Refused(refusal) if refusal.status == 404 => SignInError::Expired,
                    failure => failed(failure),
                })?;
            answer
                .get("authRequest")
                .and_then(auth_request_from)
                .ok_or(SignInError::Expired)
        })
    }

    fn settings<'a>(
        &'a self,
        organization: Option<&'a str>,
    ) -> BoxFuture<'a, SignInResult<SignInSettings>> {
        Box::pin(async move {
            let settings = self
                .org_settings("/v2/settings/login", organization)
                .await?;
            Ok(settings_from(&settings))
        })
    }

    fn password_rules<'a>(
        &'a self,
        organization: Option<&'a str>,
    ) -> BoxFuture<'a, SignInResult<PasswordRules>> {
        Box::pin(async move {
            let settings = self
                .org_settings("/v2/settings/password/complexity", organization)
                .await?;
            Ok(password_rules_from(&settings))
        })
    }

    fn code_format(&self, kind: CodeKind) -> BoxFuture<'_, CodeFormat> {
        Box::pin(self.read_code_format(kind))
    }

    fn find_user<'a>(
        &'a self,
        identifier: &'a str,
        by_email: bool,
    ) -> BoxFuture<'a, SignInResult<Option<SignInUser>>> {
        Box::pin(self.find_user_inner(identifier, by_email))
    }

    fn user<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, SignInResult<Option<SignInUser>>> {
        Box::pin(self.user_inner(user_id))
    }

    fn auth_methods<'a>(&'a self, user_id: &'a str) -> BoxFuture<'a, SignInResult<AuthMethods>> {
        Box::pin(self.auth_methods_inner(user_id))
    }

    fn start_session<'a>(
        &'a self,
        user_id: &'a str,
        password: &'a str,
        lifetime: Option<Duration>,
    ) -> BoxFuture<'a, SignInResult<SessionRef>> {
        Box::pin(self.start_session_inner(user_id, password, lifetime))
    }

    fn session<'a>(
        &'a self,
        session: &'a SessionRef,
    ) -> BoxFuture<'a, SignInResult<Option<SessionState>>> {
        Box::pin(self.read_session(session))
    }

    fn check_totp<'a>(
        &'a self,
        session: &'a SessionRef,
        code: &'a str,
    ) -> BoxFuture<'a, SignInResult<SessionRef>> {
        Box::pin(self.change_session(session, json!({ "checks": { "totp": { "code": code } } })))
    }

    fn send_email_code<'a>(
        &'a self,
        session: &'a SessionRef,
        link: LinkTemplate<'a>,
    ) -> BoxFuture<'a, SignInResult<SessionRef>> {
        Box::pin(self.change_session(
            session,
            json!({ "challenges": { "otpEmail": { "sendCode": send_code(link) } } }),
        ))
    }

    fn check_email_code<'a>(
        &'a self,
        session: &'a SessionRef,
        code: &'a str,
    ) -> BoxFuture<'a, SignInResult<SessionRef>> {
        Box::pin(self.change_session(
            session,
            json!({ "checks": { "otpEmail": { "code": code } } }),
        ))
    }

    fn end_session<'a>(&'a self, session: &'a SessionRef) -> BoxFuture<'a, SignInResult<()>> {
        Box::pin(async move {
            let ended = self
                .call(
                    Method::DELETE,
                    &format!("/v2/sessions/{}", session.id),
                    &[],
                    // With the token Zitadel checks it is this session's.
                    Some(json!({ "sessionToken": session.token })),
                )
                .await;
            match ended {
                Ok(_) => Ok(()),
                // Gone already, or not this reference's to end.
                Err(ApiFailure::Refused(refusal)) if matches!(refusal.status, 400 | 403 | 404) => {
                    Ok(())
                }
                Err(failure) => Err(failed(failure)),
            }
        })
    }

    fn complete<'a>(
        &'a self,
        auth_request: &'a str,
        session: &'a SessionRef,
    ) -> BoxFuture<'a, SignInResult<String>> {
        Box::pin(self.answer(
            auth_request,
            json!({ "session": { "sessionId": session.id, "sessionToken": session.token } }),
        ))
    }

    fn refuse<'a>(&'a self, auth_request: &'a str) -> BoxFuture<'a, SignInResult<String>> {
        Box::pin(self.answer(
            auth_request,
            json!({ "error": { "error": "ERROR_REASON_LOGIN_REQUIRED" } }),
        ))
    }

    fn create_user<'a>(
        &'a self,
        user: &'a NewUser,
        link: LinkTemplate<'a>,
    ) -> BoxFuture<'a, SignInResult<String>> {
        Box::pin(self.create_user_inner(user, link))
    }

    fn send_email_verification<'a>(
        &'a self,
        user_id: &'a str,
        link: LinkTemplate<'a>,
    ) -> BoxFuture<'a, SignInResult<()>> {
        Box::pin(async move {
            self.call(
                Method::POST,
                &format!("/v2/users/{user_id}/email/send"),
                &[],
                Some(json!({ "sendCode": send_code(link) })),
            )
            .await
            .map(|_| ())
            .map_err(failed)
        })
    }

    fn verify_email<'a>(
        &'a self,
        user_id: &'a str,
        code: &'a str,
    ) -> BoxFuture<'a, SignInResult<()>> {
        Box::pin(async move {
            self.call(
                Method::POST,
                &format!("/v2/users/{user_id}/email/verify"),
                &[],
                Some(json!({ "verificationCode": code })),
            )
            .await
            .map(|_| ())
            .map_err(code_refused)
        })
    }

    fn send_password_reset<'a>(
        &'a self,
        user_id: &'a str,
        link: LinkTemplate<'a>,
    ) -> BoxFuture<'a, SignInResult<()>> {
        Box::pin(async move {
            let mut send_link = json!({ "notificationType": "NOTIFICATION_TYPE_Email" });
            if let Some(link) = link {
                send_link["urlTemplate"] = json!(url_template(link));
            }
            self.call(
                Method::POST,
                &format!("/v2/users/{user_id}/password_reset"),
                &[],
                Some(json!({ "sendLink": send_link })),
            )
            .await
            .map(|_| ())
            .map_err(failed)
        })
    }

    fn reset_password<'a>(
        &'a self,
        user_id: &'a str,
        code: &'a str,
        password: &'a str,
    ) -> BoxFuture<'a, SignInResult<()>> {
        Box::pin(async move {
            self.call(
                Method::POST,
                &format!("/v2/users/{user_id}/password"),
                &[],
                Some(json!({
                    "newPassword": { "password": password, "changeRequired": false },
                    "verificationCode": code,
                })),
            )
            .await
            .map(|_| ())
            .map_err(code_refused)
        })
    }

    fn hosted_url(&self, auth_request: &str) -> Option<String> {
        let public = self.public_url.as_deref()?;
        // The auth request id goes into a URL the browser opens.
        auth_request
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            .then(|| format!("{public}/ui/v2/login/login?authRequest={auth_request}"))
    }
}

/// A call that takes an emailed code: an account Zitadel does not know is
/// answered like a wrong code, so the answer says nothing about accounts.
fn code_refused(failure: ApiFailure) -> SignInError {
    match failure {
        ApiFailure::Refused(refusal) if refusal.status == 404 => SignInError::InvalidCode,
        failure => failed(failure),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refusal(status: u16, code: &str) -> ApiFailure {
        ApiFailure::Refused(Refusal {
            status,
            code: (!code.is_empty()).then(|| code.to_owned()),
            message: None,
            raw: String::new(),
        })
    }

    #[test]
    fn refusals_are_named_by_their_error_id() {
        assert_eq!(
            failed(refusal(400, "COMMAND-3M0fs")),
            SignInError::InvalidCredentials
        );
        assert_eq!(
            failed(refusal(400, "COMMAND-3nJ4t")),
            SignInError::NoPassword
        );
        assert_eq!(
            failed(refusal(404, "QUERY-Dfbg2")),
            SignInError::InvalidCredentials
        );
        assert_eq!(failed(refusal(400, "SESSION-Gj4ko")), SignInError::Locked);
        assert_eq!(
            failed(refusal(400, "CODE-QvUQ4P")),
            SignInError::InvalidCode
        );
        assert_eq!(
            failed(refusal(403, "COMMAND-sGr42")),
            SignInError::NoSession
        );
        assert_eq!(
            failed(refusal(400, "COMMAND-Sx208nt")),
            SignInError::Expired
        );
        assert_eq!(
            failed(refusal(400, "DOMAIN-VoaRj")),
            SignInError::WeakPassword
        );
        assert_eq!(
            failed(refusal(409, "COMMAND-k2unb")),
            SignInError::EmailTaken
        );
        assert_eq!(
            failed(refusal(403, "AUTH-AWfge")),
            SignInError::Forbidden("AUTH-AWfge".to_owned())
        );
        assert!(matches!(
            failed(refusal(500, "")),
            SignInError::Unavailable(_)
        ));
        assert_eq!(
            code_refused(refusal(404, "COMMAND-SAF4f")),
            SignInError::InvalidCode
        );
    }

    #[test]
    fn zero_values_zitadel_leaves_out_read_as_off() {
        // Everything false: an empty document.
        let settings = settings_from(&json!({}));
        assert!(!settings.allow_password);
        assert!(!settings.allow_register);
        assert!(settings.allow_password_reset);
        assert!(settings.sign_in_with_email);
        assert_eq!(settings.password_lifetime, None);

        let settings = settings_from(&json!({
            "allowUsernamePassword": true,
            "allowRegister": true,
            "forceMfaLocalOnly": true,
            "hidePasswordReset": true,
            "passwordCheckLifetime": "864000s",
        }));
        assert!(settings.allow_password);
        assert!(settings.allow_register);
        assert!(settings.force_second_factor_local);
        assert!(!settings.allow_password_reset);
        assert_eq!(settings.password_lifetime, Some(Duration::from_hours(240)));
    }

    #[test]
    fn password_rules_read_the_length_as_a_string() {
        let rules = password_rules_from(&json!({
            "minLength": "10",
            "requiresUppercase": true,
            "requiresSymbol": true,
        }));
        assert_eq!(
            rules,
            PasswordRules {
                min_length: 10,
                uppercase: true,
                lowercase: false,
                number: false,
                symbol: true,
            }
        );
    }

    #[test]
    fn a_session_names_its_user_and_checked_factors() {
        let session = session_from(&json!({
            "id": "1",
            "factors": {
                "user": { "id": "42", "organizationId": "7" },
                "password": { "verifiedAt": "1970-01-01T00:00:01Z" },
                "webAuthN": { "verifiedAt": "1970-01-01T00:00:02Z" },
            },
        }))
        .expect("session");
        assert_eq!(session.user_id, "42");
        assert_eq!(session.password_at, Some(1000));
        // No user verification: a security key, not a passkey.
        assert_eq!(session.passkey_at, None);
        assert_eq!(session.security_key_at, Some(2000));
        assert!(session.has_second_factor());

        // No user factor, or expired: no session.
        assert_eq!(session_from(&json!({ "factors": {} })), None);
        assert_eq!(
            session_from(&json!({
                "expirationDate": "2000-01-01T00:00:00Z",
                "factors": { "user": { "id": "42" } },
            })),
            None
        );
    }

    #[test]
    fn a_user_is_a_human_with_an_address() {
        let user = user_from(&json!({
            "userId": "42",
            "details": { "resourceOwner": "7" },
            "state": "USER_STATE_ACTIVE",
            "human": { "email": { "email": "jane@acme.test", "isVerified": true } },
        }))
        .expect("user");
        assert_eq!(user.id, "42");
        assert_eq!(user.organization_id.as_deref(), Some("7"));
        assert!(user.email_verified);
        assert_eq!(user.status, UserStatus::Active);
        assert!(!user.password_change_required);

        // A machine user signs nobody in.
        assert_eq!(user_from(&json!({ "userId": "9", "machine": {} })), None);
        // An unverified address: the flag is simply absent.
        let unverified = user_from(&json!({
            "userId": "43",
            "state": "USER_STATE_INITIAL",
            "human": { "email": { "email": "new@acme.test" }, "passwordChangeRequired": true },
        }))
        .expect("user");
        assert!(!unverified.email_verified);
        assert_eq!(unverified.status, UserStatus::Initial);
        assert!(unverified.password_change_required);
    }

    #[test]
    fn an_auth_request_carries_its_prompts() {
        let request = auth_request_from(&json!({
            "id": "V2_1",
            "creationDate": "1970-01-01T00:00:01Z",
            "prompt": ["PROMPT_LOGIN", "PROMPT_CREATE", "PROMPT_CONSENT"],
            "loginHint": "jane@acme.test",
            "maxAge": "3600s",
        }))
        .expect("request");
        assert_eq!(request.prompts, vec![Prompt::Login, Prompt::Create]);
        assert_eq!(request.login_hint.as_deref(), Some("jane@acme.test"));
        assert_eq!(request.max_age, Some(Duration::from_secs(3600)));
        assert_eq!(request.created_at, Some(1000));
    }

    #[test]
    fn code_formats_follow_the_generator() {
        assert_eq!(
            code_format_from(
                &json!({ "length": 6, "includeUpperLetters": true, "includeDigits": true })
            ),
            Some(DEFAULT_VERIFICATION_CODE)
        );
        assert_eq!(
            code_format_from(&json!({ "length": 8, "includeDigits": true })),
            Some(DEFAULT_SECOND_FACTOR_CODE)
        );
        assert_eq!(code_format_from(&json!({ "includeDigits": true })), None);
    }

    #[test]
    fn links_use_zitadels_placeholders() {
        assert_eq!(
            url_template("https://app.test/auth/reset-password?userId={user}&code={code}"),
            "https://app.test/auth/reset-password?userId={{.UserID}}&code={{.Code}}"
        );
        assert_eq!(send_code(None), json!({}));
    }

    #[test]
    fn the_hosted_page_takes_only_a_plain_request_id() {
        let provider = ZitadelSignIn::new(ZitadelSignInOptions {
            api_url: "http://zitadel.test".to_owned(),
            token: "token".to_owned(),
            host: None,
            public_url: Some("https://id.test/".to_owned()),
        })
        .expect("adapter");
        assert_eq!(
            provider.hosted_url("V2_300").as_deref(),
            Some("https://id.test/ui/v2/login/login?authRequest=V2_300")
        );
        assert_eq!(provider.hosted_url("V2_300&x=//evil.test"), None);
    }
}
