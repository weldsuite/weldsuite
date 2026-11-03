//! WeldAds code more than one module uses: `@weldsuite/ads-domain` (the
//! campaign sync, the ad sync index) and `@weldsuite/meta-ads` (Meta's
//! Marketing API and OAuth). ads-api's routes use it, and so do connect-api's
//! integration endpoints (`/api/integrations/ad-connections/:id/sync`).
//!
//! Meta is reached through [`weldsuite_ports::OutboundHttp`], which is a
//! plain HTTP client on Kubernetes and the harness's outbound bridge in
//! conformance builds, so the calls both backends make are compared.

pub mod campaigns;
pub mod meta;
pub mod sync;
pub mod sync_index;

use std::fmt;

use time::OffsetDateTime;
use weldsuite_events::iso_timestamp;

/// Why a sync step failed, as the TypeScript code throws it.
#[derive(Debug)]
pub enum AdsError {
    /// An `Error` thrown with this message: Meta's, or the sync's own
    /// (`Campaign objective is required before syncing`).
    Message(String),
    /// A failing statement.
    Database(sqlx::Error),
}

impl AdsError {
    pub fn message(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }
}

impl fmt::Display for AdsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Message(message) => f.write_str(message),
            Self::Database(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for AdsError {}

impl From<sqlx::Error> for AdsError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `new Date()` as Drizzle writes it: UTC with milliseconds, bound as text
/// and cast to the column's timestamp type.
pub fn now() -> String {
    iso_timestamp(OffsetDateTime::now_utc())
}

/// `new Date(Date.now() + hours)`, as [`now`] writes it.
pub fn hours_from_now(hours: i64) -> String {
    iso_timestamp(OffsetDateTime::now_utc() + time::Duration::hours(hours))
}
