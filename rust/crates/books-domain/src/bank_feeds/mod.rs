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
pub mod providers;
pub mod sync;

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_db::{Keyring, decrypt_field, encrypt_field};
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;

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
    Database(sqlx::Error),
    /// Anything else (a crypto failure): the route's 500.
    Other(String),
}

impl From<sqlx::Error> for ServiceError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
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
    ) -> Result<(), sqlx::Error> {
        let Some(master) = &self.master else {
            return Ok(());
        };
        let stamp = crate::http::now();
        let mut tx = master.begin().await?;
        for key in keys {
            sqlx::query(
                "insert into bank_feed_connection_index (id, provider, provider_connection_id, clerk_org_id, connection_id,                  entity_id, is_active, sync_interval_hours, next_sync_at, created_at, updated_at)                  values ($1, $2, $3, $4, $5, $6, true, $7, $8::timestamptz, $9::timestamptz, $9::timestamptz)                  on conflict (provider, provider_connection_id) do update set clerk_org_id = excluded.clerk_org_id,                  connection_id = excluded.connection_id, entity_id = excluded.entity_id, is_active = true,                  sync_interval_hours = excluded.sync_interval_hours, next_sync_at = excluded.next_sync_at,                  last_error = null, updated_at = $9::timestamptz",
            )
            .bind(generate_id("bfi"))
            .bind(provider)
            .bind(key)
            .bind(&self.clerk_org_id)
            .bind(connection_id)
            .bind(entity_id)
            .bind(i32::try_from(interval_hours).unwrap_or(24))
            .bind(next_sync_at)
            .bind(&stamp)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await
    }

    /// `index.setActive(connectionId, active, lastError)`.
    pub async fn index_set_active(
        &self,
        connection_id: &str,
        active: bool,
        last_error: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let Some(master) = &self.master else {
            return Ok(());
        };
        sqlx::query(
            "update bank_feed_connection_index set is_active = $2, last_error = $3, updated_at = $4::timestamptz              where connection_id = $1",
        )
        .bind(connection_id)
        .bind(active)
        .bind(last_error)
        .bind(crate::http::now())
        .execute(master)
        .await
        .map(|_| ())
    }

    /// `index.remove(connectionId)`.
    pub async fn index_remove(&self, connection_id: &str) -> Result<(), sqlx::Error> {
        let Some(master) = &self.master else {
            return Ok(());
        };
        sqlx::query("delete from bank_feed_connection_index where connection_id = $1")
            .bind(connection_id)
            .execute(master)
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
