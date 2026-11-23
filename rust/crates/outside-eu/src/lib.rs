//! Services outside the EU (ADR OPS-026).
//!
//! On the EU edition every service outside the EU is off for a workspace
//! until an admin switches it on, behind a "leaves the EU" label and an
//! explicit acknowledgement; the backend enforces the switch, so a service a
//! workspace hasn't switched on is never called for it, and switching it off
//! stops the calls. A self-hosted install may use any of them (its operator's
//! choice), and Global is unchanged. AI providers follow the same rule in
//! their own settings (ADR AI-012, `weldsuite_ai::policy`).
//!
//! - [`catalog`]: the one list of services, by company: where, what data,
//!   what uses it, and which integration codes map to it.
//! - [`store`]: a workspace's opt-ins (`workspace_settings.features.outsideEu`).
//! - The check: [`require`] where a request starts a connection or calls a
//!   service (403 [`OFF_CODE`] when it is off), [`allowed`] in background
//!   jobs (false, with a log line, so the job skips the workspace).
//!
//! Whether the check applies is the install's [`Enforcement`], set once at
//! start by the binary from `EDITION` ([`Enforcement::install`]). Until then,
//! and in conformance builds, nothing is enforced.

pub mod catalog;
pub mod store;

use std::sync::OnceLock;

use http::StatusCode;
use serde_json::json;
use weldsuite_db::PgPool;
use weldsuite_kit::ApiError;

pub use catalog::{Account, SERVICES, Service, ServiceId, Use};
pub use store::{Change, OptIn, OptIns, Via};

/// The error code of a call to a service the workspace hasn't switched on.
pub const OFF_CODE: &str = "OUTSIDE_EU_SERVICE_OFF";

/// The error code of switching a service on without the acknowledgement
/// (the same as `/api/ai-settings`').
pub const NOT_ACKNOWLEDGED_CODE: &str = "OUTSIDE_EU_NOT_ACKNOWLEDGED";

/// Where the platform's settings page is.
pub const SETTINGS_PATH: &str = "/settings/outside-eu";

static ENFORCEMENT: OnceLock<Enforcement> = OnceLock::new();

/// Whether this install enforces the switches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enforcement {
    /// The EU edition: a service is called only for workspaces that switched
    /// it on.
    Enforced,
    /// Self-hosted (the operator's choice), conformance builds, tests.
    Off,
}

impl Enforcement {
    /// From `EDITION`: `eu` enforces, anything else doesn't.
    pub fn for_edition(edition: Option<&str>) -> Self {
        if edition.map(str::trim) == Some("eu") {
            Self::Enforced
        } else {
            Self::Off
        }
    }

    /// Sets the install's enforcement; the first call wins. Returns whether
    /// this one did.
    pub fn install(self) -> bool {
        ENFORCEMENT.set(self).is_ok()
    }

    /// The install's enforcement: [`Off`](Self::Off) until one is installed.
    pub fn current() -> Self {
        ENFORCEMENT.get().copied().unwrap_or(Self::Off)
    }

    pub fn is_enforced(self) -> bool {
        self == Self::Enforced
    }

    /// `Ok` when the workspace may call `service`: always without
    /// enforcement, else only when it switched the service on.
    pub async fn require(self, db: &PgPool, service: ServiceId) -> Result<(), OutsideEuError> {
        if !self.is_enforced() {
            return Ok(());
        }
        match store::is_on(db, service).await {
            Ok(true) => Ok(()),
            Ok(false) => Err(OutsideEuError::Off(service)),
            Err(error) => Err(OutsideEuError::Database(error)),
        }
    }

    /// [`require`](Self::require) for a job: false, logged with `context`
    /// (the job and workspace), when the service is off or the switch can't
    /// be read. The job skips the workspace instead of failing.
    pub async fn allowed(self, db: &PgPool, service: ServiceId, context: &str) -> bool {
        match self.require(db, service).await {
            Ok(()) => true,
            Err(OutsideEuError::Off(_)) => {
                tracing::info!(
                    service = service.as_str(),
                    context,
                    "outside-eu: the workspace has not switched this service on; skipped"
                );
                false
            }
            Err(OutsideEuError::Database(error)) => {
                tracing::warn!(
                    %error,
                    service = service.as_str(),
                    context,
                    "outside-eu: could not read the workspace's switch; skipped"
                );
                false
            }
        }
    }
}

/// Whether this install enforces the switches.
pub fn enforced() -> bool {
    Enforcement::current().is_enforced()
}

/// [`Enforcement::require`] on the install's enforcement.
pub async fn require(db: &PgPool, service: ServiceId) -> Result<(), OutsideEuError> {
    Enforcement::current().require(db, service).await
}

/// [`require`] for an integration code (`gmail`, `azure_devops`, …): codes
/// of EU or unknown services pass.
pub async fn require_integration(db: &PgPool, code: &str) -> Result<(), OutsideEuError> {
    match ServiceId::for_integration(code) {
        Some(service) => require(db, service).await,
        None => Ok(()),
    }
}

/// [`Enforcement::allowed`] on the install's enforcement.
pub async fn allowed(db: &PgPool, service: ServiceId, context: &str) -> bool {
    Enforcement::current().allowed(db, service, context).await
}

/// Why a service may not be called.
#[derive(Debug)]
pub enum OutsideEuError {
    /// The workspace hasn't switched it on.
    Off(ServiceId),
    /// The switch could not be read: refused, as off would be.
    Database(sea_orm::DbErr),
}

impl OutsideEuError {
    /// The service that is off.
    pub fn service(&self) -> Option<ServiceId> {
        match self {
            Self::Off(service) => Some(*service),
            Self::Database(_) => None,
        }
    }

    /// The message a refused request answers with.
    pub fn message(service: ServiceId) -> String {
        format!(
            "{} is outside the EU and is switched off for this workspace. A workspace admin \
             can switch it on under Services outside the EU in Settings.",
            service.service().name
        )
    }

    /// 403 [`OFF_CODE`] with the service in `details`, or a logged 500.
    pub fn to_api_error(&self) -> ApiError {
        match self {
            Self::Off(service) => {
                ApiError::new(StatusCode::FORBIDDEN, OFF_CODE, Self::message(*service))
                    .with_details(json!({
                        "service": service.as_str(),
                        "name": service.service().name,
                        "settingsPath": SETTINGS_PATH,
                    }))
            }
            Self::Database(error) => {
                tracing::error!(%error, "outside-eu: could not read the workspace's switch");
                ApiError::internal()
            }
        }
    }
}

impl std::fmt::Display for OutsideEuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off(service) => f.write_str(&Self::message(*service)),
            Self::Database(error) => write!(f, "could not read the outside-EU switch: {error}"),
        }
    }
}

impl std::error::Error for OutsideEuError {}

impl From<OutsideEuError> for ApiError {
    fn from(error: OutsideEuError) -> Self {
        error.to_api_error()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lazy_pool() -> PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(200))
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .expect("lazy pool")
    }

    #[test]
    fn only_the_eu_edition_enforces() {
        assert_eq!(Enforcement::for_edition(Some("eu")), Enforcement::Enforced);
        assert_eq!(
            Enforcement::for_edition(Some(" eu ")),
            Enforcement::Enforced
        );
        assert_eq!(
            Enforcement::for_edition(Some("self-hosted")),
            Enforcement::Off
        );
        assert_eq!(Enforcement::for_edition(None), Enforcement::Off);
    }

    #[tokio::test]
    async fn without_enforcement_nothing_reaches_the_database() {
        let db = lazy_pool();
        assert!(
            Enforcement::Off
                .require(&db, ServiceId::Telnyx)
                .await
                .is_ok()
        );
        assert!(
            Enforcement::Off
                .allowed(&db, ServiceId::Telnyx, "test")
                .await
        );
    }

    #[tokio::test]
    async fn an_unreadable_switch_is_refused_and_skipped() {
        let db = lazy_pool();
        let error = Enforcement::Enforced
            .require(&db, ServiceId::Telnyx)
            .await
            .expect_err("no database: refused");
        assert!(matches!(error, OutsideEuError::Database(_)));
        assert_eq!(
            error.to_api_error().status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert!(
            !Enforcement::Enforced
                .allowed(&db, ServiceId::Telnyx, "test")
                .await
        );
    }

    #[test]
    fn the_refusal_names_the_service_and_the_page() {
        let error = OutsideEuError::Off(ServiceId::Google).to_api_error();
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
        assert_eq!(error.code(), OFF_CODE);
        assert!(error.message().starts_with("Google is outside the EU"));
        let details = error.details().expect("details");
        assert_eq!(details["service"], "google");
        assert_eq!(details["settingsPath"], SETTINGS_PATH);
    }
}
