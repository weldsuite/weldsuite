//! Step-up authentication for sensitive actions
//! (`middleware/second-factor.ts`): the caller must have verified a second
//! factor in this session within the last `max_age_minutes`, read from
//! Clerk's `fva` claim.
//!
//! This never falls back to the first factor. No second factor verified in
//! this session at all (`fva[1] == -1`) is `MFA_REQUIRED`: a user without one,
//! or one who signed in with a passkey. The client tells those apart. A stale
//! second factor is `REVERIFICATION_REQUIRED`, which the client answers by
//! letting the user confirm it again and retrying.

use http::StatusCode;
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
    match check_second_factor(context.factor_verification_age, max_age_minutes) {
        SecondFactorCheck::Pass => Ok(()),
        SecondFactorCheck::MfaRequired => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            MFA_REQUIRED,
            "No second factor was verified in this session. Confirm it, or set up two-step verification first.",
        )),
        SecondFactorCheck::ReverificationRequired => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            REVERIFICATION_REQUIRED,
            "Confirm your identity with your second factor to do this.",
        )
        .with_details(json!({ "level": "second_factor", "afterMinutes": max_age_minutes }))),
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
}
