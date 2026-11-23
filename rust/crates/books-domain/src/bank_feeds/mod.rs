//! Bank feeds (`services/bank-feeds/*` and `@weldsuite/bank-feeds`): linking
//! a bank through an aggregator, mapping its accounts to bank accounts,
//! syncing transactions into the books, provider events, disconnecting.
//!
//! The banking routes (`/api/bank-connections`) call these with a
//! [`FeedContext`] built from the request; the integration workers' internal
//! calls (`/internal/bank-connections/{events,:id/sync}` on Global) are
//! [`sync::sync_connection`] and [`sync::apply_events`] with a context built
//! for the workspace, once those workers are ported (P8 wave C).

pub mod connections;
pub mod events;
pub mod normalize;
pub mod ponto_signature;
pub mod providers;
pub mod sync;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{Keyring, OrmConn, PgPool, decrypt_field, encrypt_field, orm, utc_timestamp};
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::master::bank_feed_connection_index as index;

pub use providers::{FeedConfig, LinkInput, Provider};

/// Statuses that stop syncing until the user acts or the link is gone.
pub const INACTIVE_STATUSES: [&str; 3] = ["reauth_required", "revoked", "disconnected"];
pub const SYNC_LOCK_MINUTES: i64 = 5;
pub const MAX_WARNINGS: usize = 50;
pub const DEFAULT_HISTORY_DAYS: i64 = 730;

/// `FeedProviderError`: a failed provider call. The message carries the
/// provider's code and text, never request bodies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedError {
    pub provider: String,
    pub kind: &'static str,
    pub message: String,
    pub status: Option<u16>,
    pub code: Option<String>,
}

impl FeedError {
    pub fn new(provider: &str, kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            provider: provider.to_owned(),
            kind,
            message: message.into(),
            status: None,
            code: None,
        }
    }
}

impl std::fmt::Display for FeedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// `FeedServiceError` and what else a feed operation can fail with.
#[derive(Debug)]
pub enum ServiceError {
    /// `not_found`, `bad_request`, `conflict`, `upstream` or `unavailable`.
    Service(&'static str, String),
    Database(DbErr),
    /// Anything else (a crypto failure): the route's 500.
    Other(String),
    /// The provider is outside the EU and the workspace hasn't switched it
    /// on (ADR OPS-026): the route's 403.
    OutsideEu(weldsuite_outside_eu::OutsideEuError),
}

impl From<DbErr> for ServiceError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

impl From<weldsuite_outside_eu::OutsideEuError> for ServiceError {
    fn from(error: weldsuite_outside_eu::OutsideEuError) -> Self {
        Self::OutsideEu(error)
    }
}

/// The service outside the EU a bank feed provider is (ADR OPS-026): Plaid,
/// and Stripe Financial Connections. Ponto and Enable Banking are EU
/// companies.
pub fn outside_eu_service(provider_id: &str) -> Option<weldsuite_outside_eu::ServiceId> {
    match providers::normalize_provider_id(provider_id).as_str() {
        "plaid" => Some(weldsuite_outside_eu::ServiceId::Plaid),
        "stripe_fc" => Some(weldsuite_outside_eu::ServiceId::Stripe),
        _ => None,
    }
}

impl From<FeedError> for ServiceError {
    /// `translateProviderError(err)`.
    fn from(error: FeedError) -> Self {
        let code = match error.kind {
            "not_configured" => "unavailable",
            "permanent" | "unsupported" | "reauth_required" | "revoked" => "bad_request",
            _ => "upstream",
        };
        Self::Service(code, error.message)
    }
}

pub(crate) fn service(code: &'static str, message: impl Into<String>) -> ServiceError {
    ServiceError::Service(code, message.into())
}

/// `new Date()` once: as the feeds keep it in JSON (`toISOString()`), and as
/// the `timestamp` columns hold it.
pub(crate) fn now_both() -> (String, PrimitiveDateTime) {
    let at = OffsetDateTime::now_utc();
    (weldsuite_events::iso_timestamp(at), utc_timestamp(at))
}

/// An ISO instant as `toISOString()` writes it (`$n::timestamptz`); text
/// Postgres would not read is refused as it would refuse it.
pub(crate) fn instant(iso: &str) -> Result<OffsetDateTime, DbErr> {
    crate::js::js_date_millis(iso)
        .and_then(|millis| {
            OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()
        })
        .ok_or_else(|| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp: \"{iso}\""
            ))
        })
}

/// [`instant`] as a `timestamp` column holds it (`$n::timestamp`: UTC).
pub(crate) fn stamp(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    instant(iso).map(utc_timestamp)
}

/// A row as Drizzle returns it.
pub(crate) fn js<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// An account as the provider reports it (`FeedAccount`).
#[derive(Debug, Clone, Default)]
pub struct FeedAccount {
    pub provider_account_id: String,
    pub name: String,
    pub mask: Option<String>,
    pub iban: Option<String>,
    /// `depository`, `credit` or `loan`.
    pub kind: String,
    pub subtype: Option<String>,
    pub currency: String,
    pub institution_id: Option<String>,
    pub institution_name: Option<String>,
    pub fingerprint: String,
    pub status: Option<String>,
    pub balance: Option<FeedBalance>,
}

impl FeedAccount {
    /// `toStoredFeedAccount`: what `bank_connections.metadata.feedAccounts`
    /// keeps (nothing secret).
    pub fn stored(&self) -> Value {
        json!({
            "providerAccountId": self.provider_account_id,
            "name": self.name,
            "mask": self.mask,
            "iban": self.iban,
            "type": self.kind,
            "subtype": self.subtype,
            "currency": self.currency,
            "fingerprint": self.fingerprint,
            "status": self.status.clone().unwrap_or_else(|| "active".to_owned()),
        })
    }
}

/// `FeedConnection`: a link the provider completed.
#[derive(Debug, Clone, Default)]
pub struct FeedConnection {
    pub provider: String,
    pub provider_connection_id: String,
    pub index_keys: Option<Vec<String>>,
    pub institution_id: Option<String>,
    pub institution_name: Option<String>,
    pub status: String,
    pub credentials: Value,
    pub cursor: Value,
    pub consent_expires_at: Option<String>,
    pub metadata: Option<Value>,
}

/// `StoredConnection`: a connection with its credentials opened.
#[derive(Debug, Clone, Default)]
pub struct StoredConnection {
    pub provider: String,
    pub provider_connection_id: String,
    pub credentials: Value,
    pub cursor: Value,
    pub metadata: Map<String, Value>,
    pub history_days: Option<i64>,
    pub account_ids: Option<Vec<String>>,
}

impl StoredConnection {
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("provider".to_owned(), json!(self.provider));
        out.insert(
            "providerConnectionId".to_owned(),
            json!(self.provider_connection_id),
        );
        out.insert("credentials".to_owned(), self.credentials.clone());
        out.insert("cursor".to_owned(), self.cursor.clone());
        out.insert("metadata".to_owned(), Value::Object(self.metadata.clone()));
        out.insert("historyDays".to_owned(), json!(self.history_days));
        if let Some(ids) = &self.account_ids {
            out.insert("accountIds".to_owned(), json!(ids));
        }
        Value::Object(out)
    }

    pub fn from_value(value: &Value) -> Option<Self> {
        let map = value.as_object()?;
        Some(Self {
            provider: providers::st(map.get("provider")).unwrap_or_default(),
            provider_connection_id: providers::st(map.get("providerConnectionId"))
                .unwrap_or_default(),
            credentials: map.get("credentials").cloned().unwrap_or_else(|| json!({})),
            cursor: map.get("cursor").cloned().unwrap_or(Value::Null),
            metadata: providers::rec(map.get("metadata")),
            history_days: map.get("historyDays").and_then(Value::as_i64),
            account_ids: map.get("accountIds").and_then(Value::as_array).map(|ids| {
                ids.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            }),
        })
    }
}

/// `FeedTransaction`.
#[derive(Debug, Clone, Default)]
pub struct FeedTransaction {
    pub provider_transaction_id: String,
    pub pending_transaction_id: Option<String>,
    pub account_id: String,
    pub date: String,
    pub amount_minor: i64,
    pub currency: String,
    pub description: String,
    pub merchant_name: Option<String>,
    pub check_number: Option<String>,
    pub category: Option<Value>,
    pub pending: bool,
    pub raw: Value,
}

/// `FeedBalance`.
#[derive(Debug, Clone, Default)]
pub struct FeedBalance {
    pub account_id: String,
    pub current: i64,
    pub currency: String,
    pub as_of: String,
}

/// `SyncResult`.
#[derive(Debug, Clone, Default)]
pub struct SyncResult {
    pub upserts: Vec<FeedTransaction>,
    pub removals: Vec<String>,
    pub next_cursor: Value,
    pub has_more: bool,
    pub account_statuses: Option<Map<String, Value>>,
    pub credentials: Option<Value>,
    /// When the bank consent now ends, as the provider reports it on this
    /// read (Ponto: the accounts' earliest
    /// `authorizationExpirationExpectedAt`, which moves on when the customer
    /// reauthorizes in Ponto). None leaves the stored end as it is.
    pub consent_expires_at: Option<String>,
}

/// What a feed operation needs (`FeedContext`).
pub struct FeedContext {
    pub db: PgPool,
    pub keyring: Keyring,
    /// The master database (`bank_feed_connection_index`); without one the
    /// index is not written.
    pub master: Option<PgPool>,
    pub config: FeedConfig,
    pub http: Option<OutboundHttp>,
    /// Ponto's client with its mTLS certificate, when the server has one.
    pub ponto_http: Option<OutboundHttp>,
    /// The workspace's Clerk org id, for the master index.
    pub clerk_org_id: String,
    /// Run the reconciliation matcher over the lines a sync brought in.
    pub auto_reconcile: bool,
}

impl FeedContext {
    /// `Err` when `provider_id` is outside the EU and the workspace hasn't
    /// switched it on (ADR OPS-026); `Ok` without enforcement and for the
    /// EU providers.
    pub async fn outside_eu(
        &self,
        provider_id: &str,
    ) -> Result<(), weldsuite_outside_eu::OutsideEuError> {
        match outside_eu_service(provider_id) {
            Some(service) => weldsuite_outside_eu::require(&self.db, service).await,
            None => Ok(()),
        }
    }

    /// `ctx.getProvider(id)`.
    pub fn provider(&self, id: &str) -> Result<Provider<'_>, FeedError> {
        Provider::create(
            id,
            &self.config,
            self.http.as_ref(),
            self.ponto_http.as_ref(),
        )
    }

    // ── The master index (`master-index.ts`) ──

    /// `index.upsert(rows)`: one row per key the provider's webhooks name
    /// the connection by. Without a master database nothing is written.
    pub async fn index_upsert(
        &self,
        provider: &str,
        keys: &[String],
        connection_id: &str,
        entity_id: &str,
        interval_hours: i64,
        next_sync_at: &str,
    ) -> Result<(), DbErr> {
        let Some(master) = &self.master else {
            return Ok(());
        };
        let now = utc_timestamp(OffsetDateTime::now_utc()).assume_utc();
        let next_sync_at = instant(next_sync_at)?;
        let mut tx = master.begin().await.map_err(weldsuite_db::orm_error)?;
        {
            let conn = OrmConn::new(&mut tx);
            for key in keys {
                index::Entity::insert(index::ActiveModel {
                    id: Set(generate_id("bfi")),
                    provider: Set(provider.to_owned()),
                    provider_connection_id: Set(key.clone()),
                    clerk_org_id: Set(self.clerk_org_id.clone()),
                    connection_id: Set(connection_id.to_owned()),
                    entity_id: Set(entity_id.to_owned()),
                    is_active: Set(true),
                    sync_interval_hours: Set(i32::try_from(interval_hours).unwrap_or(24)),
                    next_sync_at: Set(Some(next_sync_at)),
                    created_at: Set(now),
                    updated_at: Set(now),
                    ..Default::default()
                })
                .on_conflict(
                    OnConflict::columns([
                        index::Column::Provider,
                        index::Column::ProviderConnectionId,
                    ])
                    .update_columns([
                        index::Column::ClerkOrgId,
                        index::Column::ConnectionId,
                        index::Column::EntityId,
                        index::Column::SyncIntervalHours,
                        index::Column::NextSyncAt,
                    ])
                    .value(index::Column::IsActive, Expr::val(true))
                    .value(index::Column::LastError, Expr::val(Option::<String>::None))
                    .value(index::Column::UpdatedAt, Expr::val(now))
                    .to_owned(),
                )
                .exec_without_returning(&conn)
                .await?;
            }
        }
        tx.commit().await.map_err(weldsuite_db::orm_error)
    }

    /// `index.setActive(connectionId, active, lastError)`.
    pub async fn index_set_active(
        &self,
        connection_id: &str,
        active: bool,
        last_error: Option<&str>,
    ) -> Result<(), DbErr> {
        let Some(master) = &self.master else {
            return Ok(());
        };
        let now = utc_timestamp(OffsetDateTime::now_utc()).assume_utc();
        index::Entity::update_many()
            .col_expr(index::Column::IsActive, Expr::val(active))
            .col_expr(index::Column::LastError, Expr::val(last_error))
            .col_expr(index::Column::UpdatedAt, Expr::val(now))
            .filter(index::Column::ConnectionId.eq(connection_id))
            .exec(&orm(master))
            .await
            .map(|_| ())
    }

    /// `index.remove(connectionId)`.
    pub async fn index_remove(&self, connection_id: &str) -> Result<(), DbErr> {
        let Some(master) = &self.master else {
            return Ok(());
        };
        index::Entity::delete_many()
            .filter(index::Column::ConnectionId.eq(connection_id))
            .exec(&orm(master))
            .await
            .map(|_| ())
    }

    // ── Credentials (`credentials.ts`) ──

    /// `sealCredentials`: the credentials JSON, encrypted.
    pub fn seal(&self, credentials: &Value) -> Result<String, ServiceError> {
        encrypt_field(&credentials.to_string(), &self.keyring)
            .map_err(|error| ServiceError::Other(format!("{error:?}")))
    }

    /// `openCredentials`: `{}` for a blob that doesn't open.
    pub fn open(&self, blob: Option<&str>) -> Value {
        blob.filter(|b| !b.is_empty())
            .and_then(|blob| decrypt_field(blob, &self.keyring).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}))
    }
}
