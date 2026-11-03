//! The bank feed due sweep (integration-sync-worker's `bank-feed-due.ts`,
//! `weldsuite cron bank-feed-due`): master `bank_feed_connection_index` rows
//! whose `next_sync_at` has passed (and are active) get a sync over
//! `BOOKS_INTERNAL`, one connection at a time.
//!
//! The polling path for providers without webhooks (Ponto, Enable Banking)
//! and the daily safety net for the ones with them (Plaid, Stripe FC). The
//! index holds ids only, so a quiet tick opens no tenant database. WeldBooks
//! owns the sync and deactivates the index row itself when a connection needs
//! the user; the sweep only moves the schedule.

use serde_json::Value;
use weldsuite_db::PgPool;

use crate::binding::{BindingRequest, ServiceBinding};

/// Connections synced per tick; the rest wait for the next one.
pub const BANK_FEED_SWEEP_LIMIT: usize = 25;
const HOUR_MS: i64 = 3_600_000;
/// After a failed or retryable run the connection is tried again within the hour.
pub const BANK_FEED_RETRY_MS: i64 = HOUR_MS;

/// `BankFeedSweepResult`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct BankFeedSweepResult {
    pub due: usize,
    pub synced: usize,
    pub failed: usize,
    pub skipped: usize,
    pub deactivated: usize,
}

impl BankFeedSweepResult {
    pub fn to_json(self) -> Value {
        serde_json::json!({
            "due": self.due,
            "synced": self.synced,
            "failed": self.failed,
            "skipped": self.skipped,
            "deactivated": self.deactivated,
        })
    }
}

#[derive(Debug, Clone)]
struct DueRow {
    id: String,
    clerk_org_id: String,
    connection_id: String,
    sync_interval_hours: i32,
}

fn iso(at: time::OffsetDateTime) -> String {
    weldsuite_events::iso_timestamp(at)
}

async fn list_due(
    master: &PgPool,
    now: time::OffsetDateTime,
    limit: usize,
) -> Result<Vec<DueRow>, sqlx::Error> {
    let rows: Vec<(String, String, String, i32)> = sqlx::query_as(
        "select id, clerk_org_id, connection_id, sync_interval_hours from bank_feed_connection_index \
         where is_active = true and (next_sync_at is null or next_sync_at <= $1::timestamptz) \
         order by next_sync_at asc limit $2",
    )
    .bind(iso(now))
    .bind(i64::try_from(limit).unwrap_or(i64::MAX))
    .fetch_all(master)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, clerk_org_id, connection_id, sync_interval_hours)| DueRow {
                id,
                clerk_org_id,
                connection_id,
                sync_interval_hours,
            },
        )
        .collect())
}

async fn schedule(
    master: &PgPool,
    ids: &[String],
    next_sync_at: time::OffsetDateTime,
    last_triggered_at: time::OffsetDateTime,
    last_error: Option<&str>,
) -> Result<(), sqlx::Error> {
    if ids.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "update bank_feed_connection_index set next_sync_at = $2::timestamptz, \
         last_triggered_at = $3::timestamptz, last_error = $4, updated_at = $5::timestamptz \
         where id = any($1)",
    )
    .bind(ids)
    .bind(iso(next_sync_at))
    .bind(iso(last_triggered_at))
    .bind(last_error)
    .bind(iso(time::OffsetDateTime::now_utc()))
    .execute(master)
    .await
    .map(|_| ())
}

async fn deactivate(master: &PgPool, ids: &[String], reason: &str) -> Result<(), sqlx::Error> {
    if ids.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "update bank_feed_connection_index set is_active = false, last_error = $2, \
         updated_at = $3::timestamptz where id = any($1)",
    )
    .bind(ids)
    .bind(reason)
    .bind(iso(time::OffsetDateTime::now_utc()))
    .execute(master)
    .await
    .map(|_| ())
}

/// `.slice(0, 500)` in UTF-16 units.
fn slice_500(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().take(500).collect();
    String::from_utf16_lossy(&units)
}

/// What one sync call meant for the schedule.
enum Outcome {
    Deactivate(&'static str),
    Schedule {
        after_ms: i64,
        error: Option<String>,
    },
}

/// Sync every due connection and move its schedule (`runBankFeedDueSweep`).
/// Without the binding nothing is done, as the worker without
/// `BOOKS_INTERNAL`.
pub async fn run_bank_feed_due_sweep(
    master: &PgPool,
    books: Option<&dyn ServiceBinding>,
    now: time::OffsetDateTime,
    limit: usize,
) -> Result<BankFeedSweepResult, sqlx::Error> {
    let mut result = BankFeedSweepResult::default();
    let Some(books) = books else {
        tracing::warn!("[BankFeedDue] BOOKS_INTERNAL binding not configured, skipping");
        return Ok(result);
    };
    // Stripe FC indexes one row per account, so group the rows of one connection.
    let rows = list_due(master, now, limit * 4).await?;
    result.due = rows.len();
    let mut groups: Vec<(String, Vec<DueRow>)> = Vec::new();
    for row in rows {
        let key = format!("{}|{}", row.clerk_org_id, row.connection_id);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, group)) => group.push(row),
            None => groups.push((key, vec![row])),
        }
    }

    for (processed, (_, group)) in groups.into_iter().enumerate() {
        if processed >= limit {
            break;
        }
        let Some(first) = group.first().cloned() else {
            continue;
        };
        let ids: Vec<String> = group.iter().map(|r| r.id.clone()).collect();
        let interval_hours = group
            .iter()
            .map(|r| r.sync_interval_hours)
            .min()
            .unwrap_or(1)
            .max(1);
        let interval_ms = i64::from(interval_hours) * HOUR_MS;
        let call = books
            .fetch(BindingRequest {
                method: "POST".to_owned(),
                path: format!(
                    "/internal/bank-connections/{}/sync",
                    weldsuite_kit::cursor::encode_uri_component(&first.connection_id)
                ),
                workspace_key: first.clerk_org_id.clone(),
                body: None,
            })
            .await;
        let outcome = match call {
            Ok(response) if response.status == 404 => {
                // The connection is gone from the tenant; the index row is stale.
                Outcome::Deactivate("Connection not found in the workspace")
            }
            Ok(response) if !response.ok() => {
                result.failed += 1;
                Outcome::Schedule {
                    after_ms: BANK_FEED_RETRY_MS,
                    error: Some(format!("books-api answered {}", response.status)),
                }
            }
            Ok(response) => {
                let body = response.json();
                let data = body.get("data").cloned().unwrap_or(Value::Null);
                let skipped = data
                    .get("skipped")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let error = data
                    .get("error")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                if skipped == Some("not_active") {
                    Outcome::Deactivate("Connection is no longer active")
                } else if skipped.is_some() {
                    result.skipped += 1;
                    Outcome::Schedule {
                        after_ms: interval_ms,
                        error: None,
                    }
                } else if let Some(error) = error {
                    result.failed += 1;
                    // A retryable error is worth another go soon; one that needs the
                    // user was already recorded and deactivated by WeldBooks.
                    let retryable = data.get("retryable").and_then(Value::as_bool) == Some(true);
                    Outcome::Schedule {
                        after_ms: if retryable {
                            BANK_FEED_RETRY_MS
                        } else {
                            interval_ms
                        },
                        error: Some(slice_500(error)),
                    }
                } else {
                    result.synced += 1;
                    Outcome::Schedule {
                        after_ms: interval_ms,
                        error: None,
                    }
                }
            }
            Err(error) => {
                result.failed += 1;
                tracing::error!(
                    "[BankFeedDue] sync error for {}: {error}",
                    first.connection_id
                );
                Outcome::Schedule {
                    after_ms: BANK_FEED_RETRY_MS,
                    error: Some(slice_500(&error)),
                }
            }
        };
        match outcome {
            Outcome::Deactivate(reason) => {
                deactivate(master, &ids, reason).await?;
                result.deactivated += 1;
            }
            Outcome::Schedule { after_ms, error } => {
                schedule(
                    master,
                    &ids,
                    now + time::Duration::milliseconds(after_ms),
                    now,
                    error.as_deref(),
                )
                .await?;
            }
        }
    }
    Ok(result)
}
