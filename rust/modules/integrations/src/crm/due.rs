//! The CRM due sweep (integration-sync-worker's `crm-due.ts`): CRM
//! connections whose sync interval has passed get a sync through
//! WeldConnect's internal sync route, a Google Calendar watch close to its
//! expiry a renewal first.
//!
//! Global keeps one D1 `crm_sync_index` row per connection. Here the master
//! `workspace_due_index` (kind [`CRM_SYNC_DUE_KIND`]) says which workspaces
//! to open, and the tenant's `integration_connections` say what is due,
//! when, exactly as the sweep before the index read it: a connection's next
//! sync is its last sync (or its connection) plus its interval
//! (`normalizeCrmIntervalMinutes(syncSettings.syncIntervalHours)`), and a
//! Google watch renews a day before it expires. A connection the sweep
//! triggers is next due an interval from now, whatever the trigger
//! answered (the index's `markCrmSyncIndexTriggered`). WeldConnect's connect
//! flows mark the workspace due when a CRM connection is made.

use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_db::PgPool;
use weldsuite_db::due_index::{SweepResult, run_sweep};

use super::adapters::millis_of;
use super::db_message;
use crate::connect_internal::{ConnectCall, ConnectInternal};

/// The `workspace_due_index` kind of the CRM syncs.
pub const CRM_SYNC_DUE_KIND: &str = "crm_sync";

/// `CRM_INDEX_PROVIDERS` (connect-api `lib/crm-sync-index.ts`).
pub const CRM_INDEX_PROVIDERS: &[&str] = &[
    "attio",
    "hubspot",
    "salesforce",
    "pipedrive",
    "google_calendar",
];

const DEFAULT_INTERVAL_MINUTES: i64 = 6 * 60;
const MIN_INTERVAL_MINUTES: i64 = 60;
const WATCH_RENEWAL_LEAD_MS: i64 = 24 * 60 * 60 * 1000;

/// `normalizeCrmIntervalMinutes(hours)`.
pub fn interval_minutes(hours: Option<&Value>) -> i64 {
    #[allow(clippy::cast_precision_loss)]
    let hours = hours
        .and_then(Value::as_f64)
        .filter(|h| h.is_finite())
        .unwrap_or(DEFAULT_INTERVAL_MINUTES as f64 / 60.0);
    // `Math.round` rounds half up.
    #[allow(clippy::cast_possible_truncation)]
    let minutes = (hours * 60.0 + 0.5).floor() as i64;
    minutes.max(MIN_INTERVAL_MINUTES)
}

/// `googleWatchRenewalTime(webhookSecret)`: a day before the watch expires.
pub fn watch_renewal_at(webhook_secret: Option<&str>) -> Option<i64> {
    let info: Value = serde_json::from_str(webhook_secret?).ok()?;
    let expiration = info.get("expiration")?;
    let millis = match expiration {
        Value::String(text) if !text.is_empty() => text.trim().parse::<f64>().ok()?,
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    #[allow(clippy::cast_possible_truncation)]
    millis
        .is_finite()
        .then(|| millis as i64 - WATCH_RENEWAL_LEAD_MS)
}

/// One CRM connection as the sweep reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueConnection {
    pub id: String,
    pub provider: String,
    /// When its next sync is due, in milliseconds.
    pub due_at: i64,
    pub interval_minutes: i64,
    /// When its Google watch should be renewed, in milliseconds.
    pub renew_at: Option<i64>,
}

/// `(id, provider, sync_settings, webhook_secret, last activity)`.
type ConnectionRow = (
    String,
    String,
    Option<Value>,
    Option<String>,
    Option<String>,
);

/// The workspace's live CRM connections, with when each is due.
pub async fn due_connections(db: &PgPool) -> Result<Vec<DueConnection>, sqlx::Error> {
    let rows: Vec<ConnectionRow> =
        sqlx::query_as(
            "select id, provider, sync_settings, webhook_secret,
                    to_char(coalesce(last_sync_at, connected_at, created_at), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')
             from integration_connections
             where deleted_at is null and provider = any($1)
             order by id",
        )
        .bind(CRM_INDEX_PROVIDERS)
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, provider, settings, secret, last)| {
            let interval =
                interval_minutes(settings.as_ref().and_then(|s| s.get("syncIntervalHours")));
            let last = last.as_deref().and_then(millis_of).unwrap_or_default();
            let renew_at = if provider == "google_calendar" {
                watch_renewal_at(secret.as_deref())
            } else {
                None
            };
            DueConnection {
                id,
                provider,
                due_at: last + interval * 60_000,
                interval_minutes: interval,
                renew_at,
            }
        })
        .collect())
}

/// What one workspace's pass did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CrmDueCounts {
    pub triggered: u32,
    pub renewed: u32,
    pub failed: u32,
}

/// `processCrmDueRow`: renew the watch when due, then trigger the sync.
async fn process(
    connect: &dyn ConnectInternal,
    clerk_org_id: &str,
    connection: &DueConnection,
    now: i64,
) -> &'static str {
    let mut renewed = false;
    if connection.provider == "google_calendar" && connection.renew_at.is_some_and(|at| at <= now) {
        let call = ConnectCall::post(
            format!(
                "/api/integrations/connections/{}/renew-watch",
                connection.id
            ),
            "X-Workspace-Id",
            clerk_org_id,
            None,
        );
        match connect.fetch(call).await {
            Ok(response) if response.ok() => renewed = true,
            Ok(response) => tracing::error!(
                "[CrmDue] Watch renewal failed for {}: {}",
                connection.id,
                response.status
            ),
            Err(error) => {
                tracing::error!(
                    "[CrmDue] Watch renewal error for {}: {error}",
                    connection.id
                );
            }
        }
    }
    let call = ConnectCall::post(
        format!("/api/integrations/connections/{}/sync", connection.id),
        "X-Workspace-Id",
        clerk_org_id,
        None,
    );
    match connect.fetch(call).await {
        Ok(response) if response.ok() => {
            if renewed {
                "renewed"
            } else {
                "triggered"
            }
        }
        Ok(response) => {
            tracing::error!(
                "[CrmDue] Sync failed for {}: {}",
                connection.id,
                response.status
            );
            if renewed { "renewed" } else { "failed" }
        }
        Err(error) => {
            tracing::error!("[CrmDue] Sync error for {}: {error}", connection.id);
            if renewed { "renewed" } else { "failed" }
        }
    }
}

/// One workspace: trigger what is due, and when it next has work.
pub async fn sweep_workspace(
    db: &PgPool,
    connect: &dyn ConnectInternal,
    clerk_org_id: &str,
    now: i64,
    counts: &mut CrmDueCounts,
) -> Result<Option<i64>, sqlx::Error> {
    let connections = due_connections(db).await?;
    let mut next: Option<i64> = None;
    for connection in &connections {
        let at = if connection.due_at <= now {
            match process(connect, clerk_org_id, connection, now).await {
                "triggered" => counts.triggered += 1,
                "renewed" => counts.renewed += 1,
                _ => counts.failed += 1,
            }
            now + connection.interval_minutes * 60_000
        } else {
            connection.due_at
        };
        // A watch renews on the next pass at or after its renewal time.
        let at = match connection.renew_at {
            Some(renew) if renew > now => at.min(renew),
            _ => at,
        };
        next = Some(next.map_or(at, |n| n.min(at)));
    }
    Ok(next)
}

fn at_millis(millis: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// The workspace's tenant database and Clerk org id.
pub type WorkspaceOpener = std::sync::Arc<
    dyn Fn(String) -> weldsuite_ports::BoxFuture<'static, Result<(PgPool, String), String>>
        + Send
        + Sync,
>;

/// `runCrmDueSweep`: every workspace whose CRM syncs are due (50 a tick).
pub async fn run_crm_due_sweep(
    master: &PgPool,
    open: &WorkspaceOpener,
    connect: &dyn ConnectInternal,
    now: OffsetDateTime,
) -> (SweepResult, CrmDueCounts) {
    let now_ms = i64::try_from(now.unix_timestamp_nanos() / 1_000_000).unwrap_or_default();
    let counts = std::sync::Mutex::new(CrmDueCounts::default());
    let result = run_sweep(
        master,
        CRM_SYNC_DUE_KIND,
        now,
        50,
        None,
        |workspace_id: String, _| {
            let open = std::sync::Arc::clone(open);
            let counts = &counts;
            async move {
                let (db, clerk_org_id) = open(workspace_id).await?;
                let mut local = CrmDueCounts::default();
                let next = sweep_workspace(&db, connect, &clerk_org_id, now_ms, &mut local)
                    .await
                    .map_err(|e| db_message(&e))?;
                let mut counts = counts
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                counts.triggered += local.triggered;
                counts.renewed += local.renewed;
                counts.failed += local.failed;
                Ok::<_, String>(next.map(at_millis))
            }
        },
    )
    .await;
    let counts = counts
        .into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    tracing::info!(
        "[IntegrationScheduler] CRM due. Triggered: {}, Renewed watches: {}, Failed: {}",
        counts.triggered,
        counts.renewed,
        counts.failed
    );
    (result, counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn intervals_are_whole_minutes_of_at_least_an_hour() {
        assert_eq!(interval_minutes(None), 360);
        assert_eq!(interval_minutes(Some(&json!(0.5))), 60);
        assert_eq!(interval_minutes(Some(&json!(2.25))), 135);
        assert_eq!(interval_minutes(Some(&json!("3"))), 360);
    }

    #[test]
    fn watches_renew_a_day_before_they_expire() {
        assert_eq!(
            watch_renewal_at(Some(r#"{"expiration":"172800000","token":"t"}"#)),
            Some(86_400_000)
        );
        assert_eq!(watch_renewal_at(Some(r#"{"token":"t"}"#)), None);
        assert_eq!(watch_renewal_at(Some("not json")), None);
        assert_eq!(watch_renewal_at(None), None);
    }
}
