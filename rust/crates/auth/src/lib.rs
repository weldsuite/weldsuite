//! Session token verification for the API: the Rust counterpart of
//! `clerkMiddleware()` and `requireSecondFactor()` in worker-kit
//! (`packages/core/worker-kit/src/middleware/{clerk,second-factor}.ts`).
//!
//! Today this verifies Clerk session tokens, the Global edition's identity
//! provider. The EU and self-hosted editions verify OIDC tokens from Zitadel
//! or the customer's provider (ADR SEC-012); those rules join this crate when
//! the identity port lands.
//!
//! A request carries `Authorization: Bearer <token>`. The token must:
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
mod second_factor;
mod verifier;

pub use keys::{CLERK_JWKS_URL, SessionVerifier};
pub use middleware::clerk_auth;
pub use second_factor::{
    DEFAULT_SECOND_FACTOR_MAX_AGE_MINUTES, MFA_REQUIRED, REVERIFICATION_REQUIRED,
    SecondFactorCheck, check_second_factor, require_second_factor,
};
pub use verifier::{AuthContext, ClerkVerifier, KeyError, TokenError};
