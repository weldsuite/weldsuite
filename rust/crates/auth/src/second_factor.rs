//! Step-up authentication for sensitive actions
//! (`middleware/second-factor.ts`): the caller must have verified a second
//! factor in this session within the last `max_age_minutes`, read from
//! Clerk's `fva` claim, or from `auth_time` and `amr` with OIDC
//! ([`crate::factor_verification_age`]).
//!
//! This never falls back to the first factor. No second factor verified in
//! this session at all (`fva[1] == -1`) is `MFA_REQUIRED`: a user without one,
//! or one who signed in with a passkey. The client tells those apart. A stale
//! second factor is `REVERIFICATION_REQUIRED`, which the client answers by
//! letting the user confirm it again and retrying.
//!
//! Two tiers ([`StepUp`]): money actions (bank accounts, payment provider
//! connections) always want a second factor; other sensitive actions (API
//! keys, invites, roles, SSO, deleting the workspace) take a fresh sign-in
//! from a user who has no second factor. Outside the bank-feed link, which
//! asks on Clerk too, step-up runs only where the install switched it on
//! ([`StepUpEnabled`], WeldID): the guard ([`StepUpGuard`]) lets everything
//! through elsewhere.

use std::convert::Infallible;

use axum::extract::FromRequestParts;
use http::StatusCode;
use http::request::Parts;
use serde_json::json;
use weldsuite_kit::{ApiError, ApiResult};

use crate::AuthContext;

pub const MFA_REQUIRED: &str = "MFA_REQUIRED";
pub const REVERIFICATION_REQUIRED: &str = "REVERIFICATION_REQUIRED";

/// Clerk's `strict` window.
pub const DEFAULT_SECOND_FACTOR_MAX_AGE_MINUTES: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecondFactorCheck {
    Pass,
    MfaRequired,
    ReverificationRequired,
}

/// `checkSecondFactor`.
pub fn check_second_factor(
    factor_verification_age: Option<[f64; 2]>,
    max_age_minutes: u32,
) -> SecondFactorCheck {
    let Some([_, second_factor_age]) = factor_verification_age else {
        return SecondFactorCheck::ReverificationRequired;
    };
    // Exact comparison with the sentinel, as `=== -1` in TypeScript.
    #[allow(clippy::float_cmp)]
    if second_factor_age == -1.0 {
        return SecondFactorCheck::MfaRequired;
    }
    if second_factor_age < f64::from(max_age_minutes) {
        SecondFactorCheck::Pass
    } else {
        SecondFactorCheck::ReverificationRequired
    }
}

/// `requireSecondFactor`, called at the top of a sensitive handler: `Ok` to
/// go on, or the 403 the TypeScript middleware sends.
pub fn require_second_factor(context: &AuthContext, max_age_minutes: u32) -> ApiResult<()> {
    refusal(
        check_step_up(
            context.factor_verification_age,
            StepUp::SecondFactor,
            max_age_minutes,
        ),
        max_age_minutes,
    )
}

/// How much a sensitive action asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepUp {
    /// Money: a second factor verified within the window. A user without
    /// one gets `MFA_REQUIRED` and sets one up first.
    SecondFactor,
    /// A second factor verified within the window, or, for a session
    /// without one (on WeldID: a user who has none set up, since WeldID asks
    /// every user who has one for it), a sign-in within the window.
    Recent,
}

/// Which factor the client has the user confirm again
/// (`details.level`, Clerk's reverification levels).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepUpLevel {
    /// A sign-in: the password, an email code or a passkey.
    FirstFactor,
    /// The second factor: an authenticator app, a passkey or a recovery
    /// code.
    SecondFactor,
}

impl StepUpLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FirstFactor => "first_factor",
            Self::SecondFactor => "second_factor",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepUpCheck {
    Pass,
    /// No second factor in this session, and the action needs one.
    MfaRequired,
    /// Too long ago: confirm this factor again.
    Reverify(StepUpLevel),
}

/// The step-up verdict for a session's factor ages (`fva`: minutes since
/// the first and the second factor, -1 for none).
pub fn check_step_up(
    factor_verification_age: Option<[f64; 2]>,
    step_up: StepUp,
    max_age_minutes: u32,
) -> StepUpCheck {
    let max_age = f64::from(max_age_minutes);
    // Nothing to go on (a token without the claims): confirming a sign-in
    // is what every user can do; a provider that asks for the second factor
    // of a user who has one does so on its own.
    let Some([first_factor_age, second_factor_age]) = factor_verification_age else {
        return StepUpCheck::Reverify(match step_up {
            StepUp::SecondFactor => StepUpLevel::SecondFactor,
            StepUp::Recent => StepUpLevel::FirstFactor,
        });
    };
    // Exact comparison with the sentinel, as `=== -1` in TypeScript.
    #[allow(clippy::float_cmp)]
    let no_second_factor = second_factor_age == -1.0;
    match (step_up, no_second_factor) {
        (StepUp::SecondFactor, true) => StepUpCheck::MfaRequired,
        (StepUp::Recent, true) if (0.0..max_age).contains(&first_factor_age) => StepUpCheck::Pass,
        (StepUp::Recent, true) => StepUpCheck::Reverify(StepUpLevel::FirstFactor),
        (_, false) if second_factor_age < max_age => StepUpCheck::Pass,
        (_, false) => StepUpCheck::Reverify(StepUpLevel::SecondFactor),
    }
}

/// The 403 for a verdict that isn't [`StepUpCheck::Pass`]:
///
/// ```text
/// 403 { error: { code: 'MFA_REQUIRED' } }
/// 403 { error: { code: 'REVERIFICATION_REQUIRED', details: { level, afterMinutes } } }
/// ```
fn refusal(check: StepUpCheck, max_age_minutes: u32) -> ApiResult<()> {
    match check {
        StepUpCheck::Pass => Ok(()),
        StepUpCheck::MfaRequired => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            MFA_REQUIRED,
            "No second factor was verified in this session. Confirm it, or set up two-step verification first.",
        )),
        StepUpCheck::Reverify(level) => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            REVERIFICATION_REQUIRED,
            match level {
                StepUpLevel::SecondFactor => {
                    "Confirm your identity with your second factor to do this."
                }
                StepUpLevel::FirstFactor => "Sign in again to confirm your identity to do this.",
            },
        )
        .with_details(json!({ "level": level.as_str(), "afterMinutes": max_age_minutes }))),
    }
}

/// On the request when this install asks for step-up on sensitive actions:
/// [`crate::session_auth`] puts it there when the verifier was built
/// [`with_step_up`](crate::SessionVerifier::with_step_up) (WeldID, whose
/// access tokens carry `auth_time` and `amr`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StepUpEnabled;

/// A sensitive handler's step-up check: the session's factor ages and
/// whether the install asks for step-up at all. Never rejects: a request
/// without a session (an API key) or on an install without step-up passes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StepUpGuard {
    factor_verification_age: Option<[f64; 2]>,
    enabled: bool,
}

impl StepUpGuard {
    /// A guard that checks (`enabled`) or lets everything through.
    pub fn new(factor_verification_age: Option<[f64; 2]>, enabled: bool) -> Self {
        Self {
            factor_verification_age,
            enabled,
        }
    }

    /// Whether this install asks for step-up.
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// `Ok` to go on, or the 403 asking the user to confirm (a window of
    /// [`DEFAULT_SECOND_FACTOR_MAX_AGE_MINUTES`]).
    pub fn require(&self, step_up: StepUp) -> ApiResult<()> {
        if !self.enabled {
            return Ok(());
        }
        let window = DEFAULT_SECOND_FACTOR_MAX_AGE_MINUTES;
        refusal(
            check_step_up(self.factor_verification_age, step_up, window),
            window,
        )
    }
}

impl<S: Send + Sync> FromRequestParts<S> for StepUpGuard {
    type Rejection = Infallible;

    fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        let context = parts.extensions.get::<AuthContext>();
        let enabled = context.is_some() && parts.extensions.get::<StepUpEnabled>().is_some();
        std::future::ready(Ok(Self::new(
            context.and_then(|context| context.factor_verification_age),
            enabled,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_check_second_factor() {
        let check = |fva| check_second_factor(fva, 10);
        assert_eq!(check(None), SecondFactorCheck::ReverificationRequired);
        assert_eq!(check(Some([3.0, -1.0])), SecondFactorCheck::MfaRequired);
        assert_eq!(check(Some([3.0, 9.0])), SecondFactorCheck::Pass);
        assert_eq!(
            check(Some([3.0, 10.0])),
            SecondFactorCheck::ReverificationRequired
        );
    }

    #[test]
    fn money_actions_always_want_a_fresh_second_factor() {
        let check = |fva| check_step_up(fva, StepUp::SecondFactor, 10);
        let second = StepUpCheck::Reverify(StepUpLevel::SecondFactor);
        assert_eq!(check(None), second);
        assert_eq!(check(Some([0.0, -1.0])), StepUpCheck::MfaRequired);
        assert_eq!(check(Some([0.0, 0.0])), StepUpCheck::Pass);
        assert_eq!(check(Some([3.0, 9.0])), StepUpCheck::Pass);
        assert_eq!(check(Some([3.0, 10.0])), second);
        assert_eq!(check(Some([300.0, 300.0])), second);
    }

    #[test]
    fn other_actions_take_a_fresh_sign_in_without_a_second_factor() {
        let check = |fva| check_step_up(fva, StepUp::Recent, 10);
        let first = StepUpCheck::Reverify(StepUpLevel::FirstFactor);
        let second = StepUpCheck::Reverify(StepUpLevel::SecondFactor);
        assert_eq!(check(None), first);
        // No second factor: the sign-in must be fresh.
        assert_eq!(check(Some([2.0, -1.0])), StepUpCheck::Pass);
        assert_eq!(check(Some([10.0, -1.0])), first);
        assert_eq!(check(Some([-1.0, -1.0])), first);
        // A second factor in the session: it must be fresh, whatever the
        // first factor's age.
        assert_eq!(check(Some([2.0, 2.0])), StepUpCheck::Pass);
        assert_eq!(check(Some([2.0, 45.0])), second);
        assert_eq!(check(Some([45.0, 45.0])), second);
    }

    fn refused(result: ApiResult<()>) -> ApiError {
        let error = result.expect_err("refused");
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
        error
    }

    #[test]
    fn refusals_name_the_factor_to_confirm() {
        let guard = |fva| StepUpGuard::new(fva, true);
        let stale = refused(guard(Some([30.0, 30.0])).require(StepUp::Recent));
        assert_eq!(stale.code(), REVERIFICATION_REQUIRED);
        assert_eq!(
            stale.details(),
            Some(&json!({ "level": "second_factor", "afterMinutes": 10 }))
        );
        let sign_in = refused(guard(Some([30.0, -1.0])).require(StepUp::Recent));
        assert_eq!(
            sign_in.details(),
            Some(&json!({ "level": "first_factor", "afterMinutes": 10 }))
        );
        let none = refused(guard(Some([1.0, -1.0])).require(StepUp::SecondFactor));
        assert_eq!(none.code(), MFA_REQUIRED);
        assert!(
            guard(Some([1.0, 1.0]))
                .require(StepUp::SecondFactor)
                .is_ok()
        );
    }

    #[test]
    fn a_guard_that_is_off_lets_everything_through() {
        let off = StepUpGuard::new(None, false);
        assert!(off.require(StepUp::SecondFactor).is_ok());
        assert!(off.require(StepUp::Recent).is_ok());
    }

    #[tokio::test]
    async fn the_guard_reads_the_session_and_the_install_switch() {
        let context = AuthContext {
            user_id: "user_1".into(),
            org_id: None,
            session_id: String::new(),
            factor_verification_age: Some([30.0, 30.0]),
        };
        let guard = |extensions: http::Extensions| async move {
            let (mut parts, ()) = http::Request::new(()).into_parts();
            parts.extensions = extensions;
            StepUpGuard::from_request_parts(&mut parts, &())
                .await
                .expect("infallible")
        };

        let mut on = http::Extensions::new();
        on.insert(context.clone());
        on.insert(StepUpEnabled);
        let checked = guard(on).await;
        assert!(checked.enabled());
        assert!(checked.require(StepUp::Recent).is_err());

        let mut off = http::Extensions::new();
        off.insert(context);
        assert!(!guard(off).await.enabled());

        // The switch without a session (an API key's request): nothing to check.
        let mut keyed = http::Extensions::new();
        keyed.insert(StepUpEnabled);
        assert!(!guard(keyed).await.enabled());
    }
}
