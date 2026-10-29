//! The request gates that run after authentication and tenant resolution, in
//! `apiAuth()`'s order: licence and read-only, then (per app) app access, then
//! feature flags. The Rust counterparts of `worker-kit/src/middleware/
//! licence-gate.ts`, `read-only.ts`, `app-access.ts` and
//! `middleware/feature-flags.ts`.

mod app_access;
mod flags;
mod licence;

pub use app_access::{
    APP_ACCESS_CACHE_TTL, AppAccess, AppAccessGate, app_access_gate, app_access_required,
    read_app_access,
};
pub use flags::{FlagGate, Flags, feature_flags};
pub use licence::{
    app_not_licensed, is_read_only_request_allowed, licence_decision, licence_gate,
    workspace_read_only,
};
