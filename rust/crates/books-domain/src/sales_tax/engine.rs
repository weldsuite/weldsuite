//! `createSalesTaxEngine(config)` (`sales-tax/index.ts`): the engine an
//! entity is configured for, behind one interface. The manual engine only
//! calculates; the provider engines also record, refund and void documents
//! with the provider, Avalara validates addresses, and both list the
//! provider's own registrations.

use time::OffsetDateTime;
use weldsuite_events::iso_timestamp;
use weldsuite_ports::OutboundHttp;

use super::avalara::AvalaraEngine;
use super::errors::EngineError;
use super::manual::ManualEngine;
use super::provider::not_configured;
use super::stripe::StripeEngine;
use super::types::{
    AddressValidation, AvalaraConfig, ManualData, ProviderRegistration, ReverseLine,
    SalesTaxRequest, SalesTaxResult,
};

/// `SalesTaxEngineConfig`.
#[derive(Debug, Clone)]
pub enum EngineConfig {
    Manual(Option<ManualData>),
    /// The restricted key of the customer's own Stripe account.
    StripeTax(Option<String>),
    Avalara(Option<AvalaraConfig>),
}

/// A sales tax engine.
#[derive(Debug)]
pub enum Engine {
    Manual(ManualEngine),
    StripeTax(StripeEngine),
    Avalara(AvalaraEngine),
}

/// `new Date().toISOString()` and `Date.now()`.
fn clock() -> (String, i64) {
    let now = OffsetDateTime::now_utc();
    let ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or(0);
    (iso_timestamp(now), ms)
}

/// `createSalesTaxEngine(config)`.
pub fn create_engine(
    config: EngineConfig,
    http: Option<OutboundHttp>,
) -> Result<Engine, EngineError> {
    match config {
        EngineConfig::Manual(Some(data)) => Ok(Engine::Manual(ManualEngine::new(data))),
        EngineConfig::Manual(None) => Err(not_configured(
            "The manual engine has no rates or zones loaded",
        )),
        EngineConfig::StripeTax(Some(api_key)) if !api_key.is_empty() => {
            Ok(Engine::StripeTax(StripeEngine { api_key, http }))
        }
        EngineConfig::StripeTax(_) => Err(not_configured("The Stripe Tax engine needs an API key")),
        EngineConfig::Avalara(Some(config))
            if !config.account_id.is_empty()
                && !config.license_key.is_empty()
                && !config.company_code.is_empty() =>
        {
            Ok(Engine::Avalara(AvalaraEngine::new(config, http)))
        }
        EngineConfig::Avalara(_) => Err(not_configured(
            "The Avalara engine needs an account id, a license key and a company code",
        )),
    }
}

impl Engine {
    /// `engine.id`.
    pub fn id(&self) -> &'static str {
        match self {
            Self::Manual(_) => "manual",
            Self::StripeTax(_) => "stripe_tax",
            Self::Avalara(_) => "avalara",
        }
    }

    /// `engine.calculate(req)`.
    pub async fn calculate(&self, req: &SalesTaxRequest) -> Result<SalesTaxResult, EngineError> {
        let (calculated_at, now_ms) = clock();
        match self {
            Self::Manual(engine) => Ok(engine.calculate(req, calculated_at)),
            Self::StripeTax(engine) => engine.calculate(req, calculated_at, now_ms).await,
            Self::Avalara(engine) => engine.calculate(req, calculated_at).await,
        }
    }

    /// `engine.commit` exists (provider engines).
    pub fn can_commit(&self) -> bool {
        !matches!(self, Self::Manual(_))
    }

    /// `engine.commit(req, result)`; `None` for the manual engine.
    pub async fn commit(
        &self,
        req: &SalesTaxRequest,
        result: &SalesTaxResult,
    ) -> Option<Result<String, EngineError>> {
        match self {
            Self::Manual(_) => None,
            Self::StripeTax(engine) => Some(engine.commit(req, result).await),
            Self::Avalara(engine) => Some(engine.commit(req).await),
        }
    }

    /// `engine.reverse(ref, lines, { documentNumber, date })`; `None` for
    /// the manual engine.
    pub async fn reverse(
        &self,
        reference: &str,
        lines: &[ReverseLine],
        document_number: &str,
        date: &str,
    ) -> Option<Result<String, EngineError>> {
        match self {
            Self::Manual(_) => None,
            Self::StripeTax(engine) => Some(
                engine
                    .reverse(reference, lines, document_number, date)
                    .await,
            ),
            Self::Avalara(engine) => Some(
                engine
                    .reverse(reference, lines, document_number, date)
                    .await,
            ),
        }
    }

    /// `engine.void(ref)`; `None` for the manual engine.
    pub async fn void(&self, reference: &str) -> Option<Result<(), EngineError>> {
        match self {
            Self::Manual(_) => None,
            Self::StripeTax(engine) => Some(engine.void(reference).await),
            Self::Avalara(engine) => Some(engine.void(reference).await),
        }
    }

    /// `engine.validateAddress(address)`; `None` where the engine has none
    /// (manual, Stripe Tax).
    pub async fn validate_address(
        &self,
        address: &serde_json::Value,
    ) -> Option<Result<AddressValidation, EngineError>> {
        match self {
            Self::Avalara(engine) => Some(engine.validate_address(address).await),
            _ => None,
        }
    }

    /// `engine.listRegistrations()`; `None` for the manual engine.
    pub async fn list_registrations(
        &self,
    ) -> Option<Result<Vec<ProviderRegistration>, EngineError>> {
        match self {
            Self::Manual(_) => None,
            Self::StripeTax(engine) => Some(engine.list_registrations().await),
            Self::Avalara(engine) => {
                let (now, _) = clock();
                Some(engine.list_registrations(&now[..10]).await)
            }
        }
    }
}
