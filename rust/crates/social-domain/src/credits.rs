//! The prepaid credits wallet (`@weldsuite/credits`), what social publishing
//! meters against. The wallet writes live in `weldsuite_core_domain::credits`
//! (social, calls, meetings, WeldMerge and AI share them); this module keeps
//! the names social's callers use, and social's own rate.

pub use weldsuite_core_domain::credits::{
    Consumed, CreditCheck, CreditsError, GrantKind, LedgerEntry, check_credits, consume_credits,
    consume_credits_by, grant_credits, refund_credits, resolve_internal_workspace_id,
};

/// `SERVICE_CREDIT_RATES.socialPostPerPlatform`.
pub const SOCIAL_POST_PER_PLATFORM: i64 = 2;
