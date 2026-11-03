//! The connector catch-up's connector side (integration-sync-worker's
//! `connector-catchup.ts` with `@weldsuite/connectors`' `probe.ts` and
//! `sync-index.ts`), for the Kubernetes editions.
//!
//! Global keeps one D1 `connector_sync_index` row per connection, with a
//! copy of its encrypted credentials, so a quiet tick opens no tenant
//! database. Here the master `workspace_due_index` (kind [`DUE_KIND`]) says
//! which workspaces to open, and the tenant's `connector_connections` say
//! what is due and when ([`due_connections`]):
//!
//! - a connection is next due its interval ([`interval_minutes`]: six hours
//!   for a connector with webhooks, fifteen minutes for one without) after
//!   its last sync, or after it was connected. A webhook ingest is a sync
//!   too, so a connection whose webhooks arrive is not probed (Global skips
//!   the probe when a webhook landed in the last hour);
//! - a connection whose last sync failed is next due a back-off after it
//!   ([`backoff_ms`]: six hours for an authentication failure, thirty
//!   minutes otherwise);
//! - paused, pending and credential-less connections are never due.
//!
//! A due connection is probed ([`probe_updates`]: has anything changed since
//! its watermarks?) and only on a hit caught up through WeldConnect's
//! internal `/api/integrations/connections/:id/catch-up`. Global's daily
//! count reconcile (`connectorRemoteFingerprint`) is not ported: it needs a
//! per-connection fingerprint the tenant does not keep.
//!
//! The write side ([`schedule`]): every sync a person or a connect flow
//! starts marks the workspace due when that connection is next due, as
//! Global's connect-api upserts the index row.

use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_db::PgPool;

use crate::catalog::get_connector;
use crate::clients::{ConnectorError, Kind};
use crate::sync::{SyncEnv, client_for};
use crate::webhooks::enabled_syncs;

/// The `workspace_due_index` kind of the connector catch-up.
pub const DUE_KIND: &str = "connector_catchup";

/// `WEBHOOK_CATCHUP_INTERVAL_MINUTES`: connectors with webhooks.
pub const WEBHOOK_CATCHUP_INTERVAL_MINUTES: i64 = 6 * 60;
/// `POLL_INTERVAL_MINUTES`: connectors without webhooks.
pub const POLL_INTERVAL_MINUTES: i64 = 15;

/// `connectorIntervalMinutes(provider)`: a `poll` connector (or one the
/// catalog does not know) every fifteen minutes, the rest every six hours.
pub fn interval_minutes(provider: &str) -> i64 {
    let delivery = get_connector(provider)
        .and_then(|c| c["delivery"].as_str())
        .unwrap_or("poll");
    if delivery == "poll" {
        POLL_INTERVAL_MINUTES
    } else {
        WEBHOOK_CATCHUP_INTERVAL_MINUTES
    }
}

/// Why a catch-up backs off (`backoffUntil`'s kinds).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backoff {
    Auth,
    RateLimit,
    Transient,
}

impl Backoff {
    /// `classifyCatchupError(err)`: a connector error's kind.
    pub fn of(error: &ConnectorError) -> Self {
        match error.kind {
            Kind::Auth => Self::Auth,
            Kind::RateLimit => Self::RateLimit,
            Kind::Transient | Kind::Permanent => Self::Transient,
        }
    }

    /// `backoffKindForStatus(status)`: a failed catch-up call's status.
    pub fn of_status(status: u16) -> Self {
        match status {
            401 | 403 => Self::Auth,
            429 => Self::RateLimit,
            _ => Self::Transient,
        }
    }
}

/// `backoffUntil(kind, now, retryAfterSeconds) - now`, in milliseconds.
pub fn backoff_ms(kind: Backoff, retry_after_seconds: Option<f64>) -> i64 {
    match kind {
        Backoff::Auth => 6 * 60 * 60_000,
        Backoff::RateLimit => match retry_after_seconds {
            Some(seconds) if seconds > 0.0 && seconds.is_finite() => (seconds * 1000.0) as i64,
            _ => 15 * 60_000,
        },
        Backoff::Transient => 30 * 60_000,
    }
}

/// One connection as the sweep reads it.
#[derive(Debug, Clone)]
pub struct DueConnection {
    pub id: String,
    pub provider: String,
    /// When it is next due, in milliseconds.
    pub due_at: i64,
    pub interval_minutes: i64,
    /// The `connector_connections` row (`to_jsonb`), for the probe.
    pub row: Value,
}

/// `(row, last sync, last error, connected)`, the times in milliseconds.
type ConnectionRow = (Value, Option<f64>, Option<f64>, Option<f64>);

/// When a connection is next due: its back-off after a failure newer than
/// its last sync, else its interval after its last sync (or connection).
pub fn due_at(
    provider: &str,
    status: &str,
    last_sync: Option<i64>,
    last_error: Option<i64>,
    connected: i64,
) -> i64 {
    let base = last_sync.unwrap_or(connected);
    match last_error {
        Some(failed) if failed >= base => {
            let kind = if status == "auth_error" {
                Backoff::Auth
            } else {
                Backoff::Transient
            };
            failed + backoff_ms(kind, None)
        }
        _ => base + interval_minutes(provider) * 60_000,
    }
}

/// The workspace's connections the catch-up looks after, with when each is
/// next due.
pub async fn due_connections(db: &PgPool) -> Result<Vec<DueConnection>, sqlx::Error> {
    let rows: Vec<ConnectionRow> = sqlx::query_as(
        "select to_jsonb(c),
                (extract(epoch from c.last_sync_at) * 1000)::float8,
                (extract(epoch from c.last_error_at) * 1000)::float8,
                (extract(epoch from coalesce(c.connected_at, c.created_at)) * 1000)::float8
         from connector_connections c
         where c.deleted_at is null and c.status not in ('paused', 'pending')
           and c.credentials is not null and c.credentials <> '{}'::jsonb
         order by c.id",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(row, last_sync, last_error, connected)| {
            let id = row["id"].as_str()?.to_owned();
            let provider = row["provider"].as_str()?.to_owned();
            get_connector(&provider)?;
            let status = row["status"].as_str().unwrap_or_default();
            let due_at = due_at(
                &provider,
                status,
                last_sync.map(|ms| ms as i64),
                last_error.map(|ms| ms as i64),
                connected.map_or(0, |ms| ms as i64),
            );
            Some(DueConnection {
                interval_minutes: interval_minutes(&provider),
                id,
                provider,
                due_at,
                row,
            })
        })
        .collect())
}

/// `watermarkFor(watermarks, provider, resource)`: the sync's model
/// watermark, else one stored under the setting key.
fn watermark_for<'a>(row: &'a Value, connector: &Value, resource: &str) -> Option<&'a str> {
    let marks = row.get("sync_watermarks")?;
    let model = crate::catalog::syncs(connector)
        .iter()
        .find(|s| s["settingKey"].as_str() == Some(resource))
        .and_then(|s| s["model"].as_str());
    model
        .and_then(|m| marks.get(m))
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .or_else(|| marks.get(resource).and_then(Value::as_str))
        .filter(|m| !m.is_empty())
}

/// `probeConnectorUpdates({ provider, credentials, enabledSyncs, watermarks })`:
/// whether any enabled resource changed since its watermark. Every resource
/// is asked, as Global's probe does.
///
/// # Errors
///
/// The connector's error (credentials it cannot read, the provider's
/// refusal).
pub async fn probe_updates(row: &Value, env: &SyncEnv) -> Result<bool, ConnectorError> {
    let provider = row["provider"].as_str().unwrap_or_default();
    let Some(connector) = get_connector(provider) else {
        return Ok(false);
    };
    let mut resources: Vec<String> = Vec::new();
    for sync in enabled_syncs(connector, row.get("enabled_syncs")) {
        if let Some(key) = sync["settingKey"].as_str()
            && !resources.iter().any(|r| r == key)
        {
            resources.push(key.to_owned());
        }
    }
    if resources.is_empty() {
        return Ok(false);
    }
    let (_, client) = client_for(row, env)?;
    let mut hit = false;
    for resource in &resources {
        let since = watermark_for(row, connector, resource);
        if client
            .has_updates_since(env.http.as_ref(), resource, since)
            .await?
        {
            hit = true;
        }
    }
    Ok(hit)
}

/// `upsertConnectorIndexFromRow(...)`: after a sync of `connection` (not the
/// catch-up's own), mark the workspace due when the connection next is.
/// `workspace` is the sync's workspace reference (`workspaces.id` or the
/// Clerk org id). Best effort, and only with the app's master database.
pub async fn schedule(env: &SyncEnv, workspace: &str, connection: &Value, succeeded: bool) {
    let Some(due) = &env.due else {
        return;
    };
    let provider = connection["provider"].as_str().unwrap_or_default();
    if connection["status"] == "paused" || get_connector(provider).is_none() {
        return;
    }
    let workspace_id = if due.workspace_id.is_empty() {
        let found: Result<Option<String>, sqlx::Error> = sqlx::query_scalar(
            "select id from workspaces where id = $1 or clerk_org_id = $1 limit 1",
        )
        .bind(workspace)
        .fetch_optional(&due.master)
        .await;
        match found {
            Ok(Some(id)) => id,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(%error, "[connector-sync-index] workspace lookup failed");
                return;
            }
        }
    } else {
        due.workspace_id.clone()
    };
    let wait = if succeeded {
        interval_minutes(provider) * 60_000
    } else {
        backoff_ms(Backoff::Transient, None)
    };
    let at = OffsetDateTime::now_utc() + time::Duration::milliseconds(wait);
    weldsuite_db::due_index::mark_due(&due.master, DUE_KIND, &workspace_id, at).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_catalog_connector_is_caught_up_every_six_hours() {
        for provider in ["woocommerce", "shopify", "picqer", "moneybird", "stripe"] {
            assert_eq!(interval_minutes(provider), 360, "{provider}");
        }
        assert_eq!(interval_minutes("unknown"), 15);
    }

    #[test]
    fn back_offs_follow_the_error_kind() {
        assert_eq!(backoff_ms(Backoff::Auth, None), 21_600_000);
        assert_eq!(backoff_ms(Backoff::RateLimit, None), 900_000);
        assert_eq!(backoff_ms(Backoff::RateLimit, Some(30.0)), 30_000);
        assert_eq!(backoff_ms(Backoff::RateLimit, Some(0.0)), 900_000);
        assert_eq!(backoff_ms(Backoff::Transient, Some(30.0)), 1_800_000);
        assert_eq!(Backoff::of_status(401), Backoff::Auth);
        assert_eq!(Backoff::of_status(429), Backoff::RateLimit);
        assert_eq!(Backoff::of_status(500), Backoff::Transient);
    }

    #[test]
    fn a_failure_newer_than_the_last_sync_backs_off() {
        let hour = 3_600_000;
        // Synced at 10h: due six hours later.
        assert_eq!(
            due_at("shopify", "active", Some(10 * hour), None, 0),
            16 * hour
        );
        // Never synced: six hours after it was connected.
        assert_eq!(due_at("shopify", "active", None, None, 2 * hour), 8 * hour);
        // The last sync failed: thirty minutes, six hours on an auth failure.
        assert_eq!(
            due_at("shopify", "sync_error", Some(10 * hour), Some(10 * hour), 0),
            10 * hour + 1_800_000
        );
        assert_eq!(
            due_at("shopify", "auth_error", Some(10 * hour), Some(11 * hour), 0),
            17 * hour
        );
        // An old failure, synced since: the interval.
        assert_eq!(
            due_at("shopify", "active", Some(10 * hour), Some(9 * hour), 0),
            16 * hour
        );
    }
}
