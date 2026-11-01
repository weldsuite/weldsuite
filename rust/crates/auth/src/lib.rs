//! Session token verification for the API: the Rust counterpart of
//! `clerkMiddleware()` and `requireSecondFactor()` in worker-kit
//! (`packages/core/worker-kit/src/middleware/{clerk,second-factor}.ts`).
//!
//! Two providers (ADR SEC-012), picked by configuration, behind one
//! [`SessionVerifier`] and one middleware:
//!
//! - **Clerk**, the Global edition's provider and the default: its session
//!   tokens, with the rules below.
//! - **OIDC**, the EU and self-hosted editions' provider (Zitadel, or the
//!   customer's own): access or ID tokens checked against the issuer, the
//!   audience and the provider's JWKS found through discovery, with the
//!   claims mapped onto the same [`AuthContext`] (`oidc.rs`).
//!
//! A request carries `Authorization: Bearer <token>`. A Clerk token must:
//!
//! - be an RS256/RS384/RS512 JWT (`typ`, when present, is `JWT`) signed by
//!   the configured key;
//! - carry `exp`, not be expired, and not be used before `nbf` or `iat`, each
//!   with Clerk's 5-second clock skew;
//! - name a subject (`sub`);
//! - come from an authorized party (`azp`): a first-party origin, a
//!   configured extra origin, or no claim at all (native apps).

mod keys;
mod middleware;
mod oidc;
mod second_factor;
mod verifier;

pub use keys::{CLERK_JWKS_URL, SessionVerifier};
pub use middleware::clerk_auth;
/// [`clerk_auth`] under the name that fits both providers.
pub use middleware::clerk_auth as session_auth;
pub use oidc::{
    OIDC_CLOCK_SKEW_SECONDS, OidcSettings, ZITADEL_ORG_CLAIM, factor_verification_age, organization,
};
pub use second_factor::{
    DEFAULT_SECOND_FACTOR_MAX_AGE_MINUTES, MFA_REQUIRED, REVERIFICATION_REQUIRED,
    SecondFactorCheck, check_second_factor, require_second_factor,
};
pub use verifier::{AuthContext, ClerkVerifier, KeyError, TokenError};
