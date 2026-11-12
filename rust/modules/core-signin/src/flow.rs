//! What comes next in a sign-in: the provider's policy, applied.
//!
//! The provider checks passwords and codes, and nothing else: it would
//! answer an auth request with a session that only passed the password
//! check, whatever second factor the account has. So before a sign-in is
//! finished ([`advance`]), this module asks what the account needs and what
//! the session has, in the order the provider's own login does:
//!
//! 1. a session the provider still knows, signed in recently enough for
//!    what the auth request asked (`prompt=login`, `max_age`);
//! 2. an account that may sign in, with nothing the platform's screens
//!    cannot do first (a forced password change);
//! 3. a verified address;
//! 4. the second factor, when the account has one or the policy wants one.
//!
//! What these screens do not do (a passkey, a security key, a code by SMS,
//! enrolling a second factor) goes to the provider's own page.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use weldsuite_ports::{
    AuthRequest, CodeFormat, CodeKind, Prompt, SessionRef, SessionState, SignInError,
    SignInProvider, SignInResult, UserStatus,
};

/// A second factor the platform's screens ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Factor {
    Totp,
    EmailCode,
}

impl Factor {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Totp => "totp",
            Self::EmailCode => "email_code",
        }
    }

    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "totp" => Some(Self::Totp),
            "email_code" => Some(Self::EmailCode),
            _ => None,
        }
    }
}

/// What the screen shows next (`SignInStep` in the platform's
/// `lib/auth/oidc/sign-in-api.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Step {
    /// Signed in: the browser continues on the OIDC callback.
    Complete {
        redirect_url: String,
    },
    NeedsCredentials {
        sign_up: bool,
        login_hint: Option<String>,
        allow_register: bool,
        allow_password_reset: bool,
    },
    NeedsSecondFactor {
        factors: Vec<Factor>,
        email: String,
        email_code: CodeFormat,
    },
    NeedsEmailVerification {
        email: String,
        code: CodeFormat,
    },
    /// Something these screens don't do: the provider's own page does.
    Hosted {
        url: String,
    },
    /// The provider no longer knows the auth request.
    Expired,
}

fn code_json(format: CodeFormat) -> Value {
    json!({
        "length": format.length,
        "charset": if format.letters { "alphanumeric" } else { "digits" },
    })
}

impl Step {
    pub(crate) fn to_json(&self) -> Value {
        match self {
            Self::Complete { redirect_url } => {
                json!({ "status": "complete", "redirectUrl": redirect_url })
            }
            Self::NeedsCredentials {
                sign_up,
                login_hint,
                allow_register,
                allow_password_reset,
            } => json!({
                "status": "needs_credentials",
                "intent": if *sign_up { "sign-up" } else { "sign-in" },
                "loginHint": login_hint,
                "allowRegister": allow_register,
                "allowPasswordReset": allow_password_reset,
            }),
            Self::NeedsSecondFactor {
                factors,
                email,
                email_code,
            } => json!({
                "status": "needs_second_factor",
                "factors": factors.iter().map(|factor| factor.name()).collect::<Vec<_>>(),
                "email": email,
                "emailCode": code_json(*email_code),
            }),
            Self::NeedsEmailVerification { email, code } => json!({
                "status": "needs_email_verification",
                "email": email,
                "code": code_json(*code),
            }),
            Self::Hosted { url } => json!({ "status": "hosted", "url": url }),
            Self::Expired => json!({ "status": "expired" }),
        }
    }
}

/// Where a session stands against an auth request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// No session to go on with: ask for the credentials. `session_gone`
    /// when the provider no longer knows it at all (the cookie is stale).
    Credentials {
        session_gone: bool,
    },
    Step(Step),
}

/// What the caller established itself a moment ago. The provider's read side
/// lags its writes, so an address verified in this request may still read as
/// unverified.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct Known {
    pub(crate) email_verified: bool,
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or_default()
}

/// The session's sign-in is recent enough for what the auth request asked.
fn fresh_enough(request: &AuthRequest, session: &SessionState, now: i64) -> bool {
    let Some(signed_in_at) = session.first_factor_at() else {
        return false;
    };
    // `prompt=login` (and choosing an account, which these screens do by
    // signing in): only a sign-in made for this request counts.
    if (request.asks(Prompt::Login) || request.asks(Prompt::SelectAccount))
        && request.created_at.is_none_or(|asked| signed_in_at < asked)
    {
        return false;
    }
    request.max_age.is_none_or(|max_age| {
        let age = now.saturating_sub(signed_in_at);
        i64::try_from(max_age.as_millis()).is_ok_and(|max| age <= max)
    })
}

fn hosted(provider: &dyn SignInProvider, request: &AuthRequest) -> SignInResult<Outcome> {
    provider
        .hosted_url(&request.id)
        .map(|url| Outcome::Step(Step::Hosted { url }))
        .ok_or_else(|| {
            SignInError::Unavailable(
                "this sign-in needs the provider's own page, and its public address is not configured"
                    .to_owned(),
            )
        })
}

/// What `session` still needs before it answers `request`; when nothing,
/// the request is answered and the step is [`Step::Complete`].
pub(crate) async fn advance(
    provider: &dyn SignInProvider,
    request: &AuthRequest,
    session: &SessionRef,
    known: Known,
) -> SignInResult<Outcome> {
    let Some(state) = provider.session(session).await? else {
        return Ok(Outcome::Credentials { session_gone: true });
    };
    if !fresh_enough(request, &state, now_ms()) {
        return Ok(Outcome::Credentials {
            session_gone: false,
        });
    }
    let Some(user) = provider.user(&state.user_id).await? else {
        return Ok(Outcome::Credentials { session_gone: true });
    };
    if matches!(user.status, UserStatus::Locked | UserStatus::Inactive) {
        return Err(SignInError::Locked);
    }
    if user.password_change_required {
        return hosted(provider, request);
    }
    if !(user.email_verified || known.email_verified) {
        return Ok(Outcome::Step(Step::NeedsEmailVerification {
            email: user.email.unwrap_or_default(),
            code: provider.code_format(CodeKind::EmailVerification).await,
        }));
    }
    // A passkey is both factors in one.
    if state.passkey_at.is_none() {
        let methods = provider.auth_methods(&user.id).await?;
        if methods.any_second_factor() {
            // The account has one: it is due, whatever the policy says.
            if !state.has_second_factor() {
                let factors: Vec<Factor> = [
                    methods.totp.then_some(Factor::Totp),
                    methods.email_code.then_some(Factor::EmailCode),
                ]
                .into_iter()
                .flatten()
                .collect();
                if factors.is_empty() {
                    return hosted(provider, request);
                }
                return Ok(Outcome::Step(Step::NeedsSecondFactor {
                    factors,
                    email: user.email.unwrap_or_default(),
                    email_code: provider.code_format(CodeKind::EmailSecondFactor).await,
                }));
            }
        } else {
            // It has none: where the policy wants one, it is set up on the
            // provider's page.
            let settings = provider.settings(user.organization_id.as_deref()).await?;
            let signed_in_locally = state.external_at.is_none();
            if settings.force_second_factor
                || (settings.force_second_factor_local && signed_in_locally)
            {
                return hosted(provider, request);
            }
        }
    }
    match provider.complete(&request.id, session).await {
        Ok(redirect_url) => Ok(Outcome::Step(Step::Complete { redirect_url })),
        Err(SignInError::NoSession) => Ok(Outcome::Credentials { session_gone: true }),
        Err(SignInError::Expired) => Ok(Outcome::Step(Step::Expired)),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use weldsuite_ports::{MemorySignIn, SignInSettings};

    use super::*;

    const PASSWORD: &str = "Secret123";

    async fn signed_in(provider: &MemorySignIn, user: &str) -> SessionRef {
        provider
            .start_session(user, PASSWORD, None)
            .await
            .expect("session")
    }

    async fn request(provider: &MemorySignIn, prompts: &[Prompt]) -> AuthRequest {
        let id = provider.add_auth_request(prompts);
        provider.auth_request(&id).await.expect("request")
    }

    #[tokio::test]
    async fn a_password_is_enough_for_an_account_without_a_second_factor() {
        let provider = MemorySignIn::new();
        let user = provider.add_user("jane@acme.test", PASSWORD);
        let request = request(&provider, &[]).await;
        let session = signed_in(&provider, &user).await;

        let outcome = advance(&provider, &request, &session, Known::default())
            .await
            .expect("outcome");
        assert!(matches!(outcome, Outcome::Step(Step::Complete { .. })));
        assert_eq!(provider.completed_for(&request.id), Some(user));
    }

    #[tokio::test]
    async fn an_account_with_a_second_factor_is_not_finished_on_the_password_alone() {
        let provider = MemorySignIn::new();
        let user = provider.add_user("jane@acme.test", PASSWORD);
        provider.update_user(&user, |user| {
            user.methods.totp = true;
            user.methods.email_code = true;
        });
        let request = request(&provider, &[]).await;
        let session = signed_in(&provider, &user).await;

        let outcome = advance(&provider, &request, &session, Known::default())
            .await
            .expect("outcome");
        let Outcome::Step(Step::NeedsSecondFactor { factors, email, .. }) = outcome else {
            panic!("expected the second factor, got {outcome:?}");
        };
        assert_eq!(factors, vec![Factor::Totp, Factor::EmailCode]);
        assert_eq!(email, "jane@acme.test");
        // The provider was not asked to finish.
        assert_eq!(provider.completed_for(&request.id), None);

        let session = provider
            .check_totp(&session, MemorySignIn::TOTP)
            .await
            .expect("checked");
        let outcome = advance(&provider, &request, &session, Known::default())
            .await
            .expect("outcome");
        assert!(matches!(outcome, Outcome::Step(Step::Complete { .. })));
    }

    #[tokio::test]
    async fn a_factor_these_screens_do_not_ask_for_goes_to_the_providers_page() {
        let provider = MemorySignIn::new();
        let user = provider.add_user("jane@acme.test", PASSWORD);
        provider.update_user(&user, |user| user.methods.security_key = true);
        let request = request(&provider, &[]).await;
        let session = signed_in(&provider, &user).await;

        let outcome = advance(&provider, &request, &session, Known::default())
            .await
            .expect("outcome");
        assert!(matches!(outcome, Outcome::Step(Step::Hosted { .. })));
        assert_eq!(provider.completed_for(&request.id), None);
    }

    #[tokio::test]
    async fn a_forced_second_factor_is_set_up_on_the_providers_page() {
        let provider = MemorySignIn::new();
        provider.set_settings(SignInSettings {
            force_second_factor_local: true,
            ..SignInSettings::default()
        });
        let user = provider.add_user("jane@acme.test", PASSWORD);
        let request = request(&provider, &[]).await;
        let session = signed_in(&provider, &user).await;

        let outcome = advance(&provider, &request, &session, Known::default())
            .await
            .expect("outcome");
        assert!(matches!(outcome, Outcome::Step(Step::Hosted { .. })));
    }

    #[tokio::test]
    async fn an_unverified_address_comes_before_the_sign_in() {
        let provider = MemorySignIn::new();
        let user = provider.add_user("jane@acme.test", PASSWORD);
        provider.update_user(&user, |user| user.user.email_verified = false);
        let request = request(&provider, &[]).await;
        let session = signed_in(&provider, &user).await;

        let outcome = advance(&provider, &request, &session, Known::default())
            .await
            .expect("outcome");
        assert!(matches!(
            outcome,
            Outcome::Step(Step::NeedsEmailVerification { .. })
        ));

        // Verified in this request: the provider's lagging read is not asked again.
        let known = Known {
            email_verified: true,
        };
        let outcome = advance(&provider, &request, &session, known)
            .await
            .expect("outcome");
        assert!(matches!(outcome, Outcome::Step(Step::Complete { .. })));
    }

    #[tokio::test]
    async fn a_locked_account_and_a_forced_password_change_do_not_finish() {
        let provider = MemorySignIn::new();
        let user = provider.add_user("jane@acme.test", PASSWORD);
        let request = request(&provider, &[]).await;
        let session = signed_in(&provider, &user).await;

        provider.update_user(&user, |user| user.user.password_change_required = true);
        let outcome = advance(&provider, &request, &session, Known::default())
            .await
            .expect("outcome");
        assert!(matches!(outcome, Outcome::Step(Step::Hosted { .. })));

        provider.update_user(&user, |user| user.user.status = UserStatus::Locked);
        let refused = advance(&provider, &request, &session, Known::default()).await;
        assert_eq!(refused, Err(SignInError::Locked));
        assert_eq!(provider.completed_for(&request.id), None);
    }

    #[tokio::test]
    async fn a_session_the_provider_forgot_asks_for_the_credentials() {
        let provider = MemorySignIn::new();
        let user = provider.add_user("jane@acme.test", PASSWORD);
        let request = request(&provider, &[]).await;
        let session = signed_in(&provider, &user).await;
        provider.end_session(&session).await.expect("ended");

        let outcome = advance(&provider, &request, &session, Known::default())
            .await
            .expect("outcome");
        assert_eq!(outcome, Outcome::Credentials { session_gone: true });

        // Somebody else's session id without its token is no session either.
        let live = signed_in(&provider, &user).await;
        let forged = SessionRef {
            id: live.id,
            token: "guess".to_owned(),
        };
        let outcome = advance(&provider, &request, &forged, Known::default())
            .await
            .expect("outcome");
        assert_eq!(outcome, Outcome::Credentials { session_gone: true });
    }

    #[tokio::test]
    async fn prompt_login_takes_only_a_sign_in_made_for_it() {
        let provider = MemorySignIn::new();
        let user = provider.add_user("jane@acme.test", PASSWORD);
        let earlier = signed_in(&provider, &user).await;
        tokio::time::sleep(Duration::from_millis(5)).await;
        let request = request(&provider, &[Prompt::Login]).await;

        // The session from before the request does not count…
        let outcome = advance(&provider, &request, &earlier, Known::default())
            .await
            .expect("outcome");
        assert_eq!(
            outcome,
            Outcome::Credentials {
                session_gone: false
            }
        );
        // …a sign-in after it does.
        tokio::time::sleep(Duration::from_millis(5)).await;
        let fresh = signed_in(&provider, &user).await;
        let outcome = advance(&provider, &request, &fresh, Known::default())
            .await
            .expect("outcome");
        assert!(matches!(outcome, Outcome::Step(Step::Complete { .. })));
    }

    #[test]
    fn max_age_bounds_the_age_of_the_sign_in() {
        let session = SessionState {
            user_id: "user_1".to_owned(),
            password_at: Some(10_000),
            ..SessionState::default()
        };
        let request = AuthRequest {
            max_age: Some(Duration::from_secs(60)),
            ..AuthRequest::default()
        };
        assert!(fresh_enough(&request, &session, 10_000 + 60_000));
        assert!(!fresh_enough(&request, &session, 10_000 + 60_001));
        // No first factor at all is never fresh.
        assert!(!fresh_enough(
            &AuthRequest::default(),
            &SessionState::default(),
            0
        ));
    }

    #[test]
    fn steps_are_written_as_the_platform_reads_them() {
        assert_eq!(
            Step::NeedsCredentials {
                sign_up: true,
                login_hint: None,
                allow_register: true,
                allow_password_reset: false,
            }
            .to_json(),
            json!({
                "status": "needs_credentials",
                "intent": "sign-up",
                "loginHint": null,
                "allowRegister": true,
                "allowPasswordReset": false,
            })
        );
        assert_eq!(
            Step::NeedsSecondFactor {
                factors: vec![Factor::EmailCode],
                email: "jane@acme.test".to_owned(),
                email_code: CodeFormat {
                    length: 8,
                    letters: false,
                    uppercase: false
                },
            }
            .to_json(),
            json!({
                "status": "needs_second_factor",
                "factors": ["email_code"],
                "email": "jane@acme.test",
                "emailCode": { "length": 8, "charset": "digits" },
            })
        );
        assert_eq!(Step::Expired.to_json(), json!({ "status": "expired" }));
    }
}
