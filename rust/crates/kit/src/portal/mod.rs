//! The public portals' passwordless sign-in (`@weldsuite/worker-kit/portal`):
//! what the project portal (`/public/project-portal`) builds on, and the
//! help desk and HR portals do on Global.
//!
//! - [`slug`]: validating the workspace slug a public request names.
//! - [`tokens`]: hashed tokens, uniformly random one-time codes and the small
//!   JSON helpers on the workspace cache (`WORKSPACE_CACHE`).
//! - [`rate_limit`]: the atomic fixed-window limits. On Global they live in a
//!   `PortalRateLimiter` Durable Object; here behind the
//!   [`rate_limit::RateLimitCounters`] port, on the shared cache's atomic
//!   counters (Valkey `INCRBY`).

pub mod rate_limit;
pub mod signin;
pub mod slug;
pub mod tokens;
pub mod workspace;
