//! `@weldsuite/commerce-domain`: what the B2B commerce portal shares with the
//! other portals (commerce-api's `/public/commerce-portal` and staff invites;
//! the helpdesk widget API's signed-in help center uses the same limiter).
//!
//! - [`portal_tokens`]: magic-link / OTP challenges and buyer sessions in the
//!   workspace cache (`WORKSPACE_CACHE`), hashed; the portal's origin.
//! - [`rate_limit`]: the atomic fixed-window limits. On Global they live in
//!   commerce-api's `PortalRateLimiter` Durable Object; here behind the
//!   [`rate_limit::RateLimitCounters`] port, on the shared cache's atomic
//!   counters (Valkey `INCRBY`).
//! - [`portal_slug`]: validating the workspace slug a public request names.

pub mod portal_slug;
pub mod portal_tokens;
pub mod rate_limit;
