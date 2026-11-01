//! Webhook events from the providers (`services/bank-feeds/events.ts`),
//! already verified and normalized by the webhook worker. Status events
//! update the connection (and the affected accounts); `sync_available` only
//! says a sync is worth running.

use serde_json::{Value, json};

use super::connections::{load_connection, stored_feed_accounts};
use super::normalize::connection_status;
use super::sync::{SyncOutcome, sync_connection};
use super::{FeedContext, INACTIVE_STATUSES, ServiceError};
use crate::http::now;
use crate::js::{js_date, slice_utf16};

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `FeedEvent`.
#[derive(Debug, Clone, Default)]
pub struct FeedEvent {
    /// `sync_available`, `reauth_required`, `expiring`, `revoked`,
    /// `disconnected` or `error`.
    pub kind: String,
    pub provider_connection_id: String,
    pub account_ids: Option<Vec<String>>,
    pub expires_at: Option<String>,
    pub message: Option<String>,
}

/// `EventResult`.
#[derive(Debug, Clone)]
pub struct EventResult {
    /// The connection is unknown here (deleted); the index row is stale.
    pub missing: bool,
    pub needs_sync: bool,
    pub status: String,
    pub changed: bool,
}

fn default_message(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "reauth_required" => "The bank needs you to sign in again.",
        "revoked" => "Access was revoked at the bank.",
        "disconnected" => "The account was disconnected at the bank.",
        "expiring" => "The bank connection expires soon.",
        "error" => "The provider reported an error.",
        _ => return None,
    })
}

/// `applyFeedEvent(ctx, connectionId, event)`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub async fn apply_feed_event(
    ctx: &FeedContext,
    connection_id: &str,
    event: &FeedEvent,
) -> Result<EventResult, sqlx::Error> {
    let Some(row) = load_connection(&ctx.db, connection_id).await? else {
        return Ok(EventResult {
            missing: true,
            needs_sync: false,
            status: "disconnected".to_owned(),
            changed: false,
        });
    };
    let current = text(&row, "status").unwrap_or_default().to_owned();
    if event.kind == "sync_available" {
        return Ok(EventResult {
            missing: false,
            needs_sync: current != "disconnected" && current != "revoked",
            status: current,
            changed: false,
        });
    }

    let target = event.kind.as_str();
    let feed_accounts = stored_feed_accounts(&row);
    let scope = event.account_ids.as_ref().filter(|ids| !ids.is_empty());
    let in_scope = |fa: &Value| {
        scope.is_none_or(|ids| {
            text(fa, "providerAccountId").is_some_and(|id| ids.iter().any(|s| s == id))
        })
    };
    // Events for accounts a relink replaced are stale.
    if !feed_accounts.is_empty() && !feed_accounts.iter().any(in_scope) {
        return Ok(EventResult {
            missing: false,
            needs_sync: false,
            status: current,
            changed: false,
        });
    }
    let soft = target == "expiring" || target == "error";
    let updated: Vec<Value> = feed_accounts
        .iter()
        .map(|fa| {
            // "Expiring" and "error" never hide a harder state the account is already in.
            if !in_scope(fa) || (soft && text(fa, "status") != Some("active")) {
                return fa.clone();
            }
            let mut fa = fa.clone();
            fa["status"] = json!(target);
            fa
        })
        .collect();

    let mapped: Vec<Option<String>> = sqlx::query_scalar(
        "select feed_account_id from bank_accounts where feed_connection_id = $1 and deleted_at is null",
    )
    .bind(text(&row, "id"))
    .fetch_all(&ctx.db)
    .await?;
    let mapped: Vec<String> = mapped.into_iter().flatten().collect();
    let rollup: Vec<&Value> = updated
        .iter()
        .filter(|fa| text(fa, "providerAccountId").is_some_and(|id| mapped.iter().any(|m| m == id)))
        .collect();
    let statuses: Vec<String> = if rollup.is_empty() {
        updated
            .iter()
            .map(|fa| text(fa, "status").unwrap_or_default().to_owned())
            .collect()
    } else {
        rollup
            .iter()
            .map(|fa| text(fa, "status").unwrap_or_default().to_owned())
            .collect()
    };
    let next_status = connection_status(&statuses).to_owned();

    let timestamp = now();
    let message = event
        .message
        .as_deref()
        .or_else(|| default_message(&event.kind))
        .map(|m| slice_utf16(m, 500));
    let expires = if event.kind == "expiring" {
        event
            .expires_at
            .as_deref()
            .filter(|e| !e.is_empty())
            .and_then(js_date)
    } else {
        None
    };
    let last_error = if next_status == "active" {
        text(&row, "lastError").map(str::to_owned)
    } else {
        message.clone()
    };
    sqlx::query(
        "update bank_connections set status = $2, last_error = $3, \
         consent_expires_at = case when $4::text is null then consent_expires_at else $4::timestamp end, \
         metadata = (coalesce(metadata, '{}'::jsonb) || $5::jsonb), updated_at = $6::timestamp where id = $1",
    )
    .bind(text(&row, "id"))
    .bind(&next_status)
    .bind(last_error)
    .bind(expires)
    .bind(json!({ "feedAccounts": updated }).to_string())
    .bind(&timestamp)
    .execute(&ctx.db)
    .await?;

    let touched: Vec<&Value> = updated
        .iter()
        .zip(feed_accounts.iter())
        .filter(|(new, old)| new.get("status") != old.get("status"))
        .map(|(new, _)| new)
        .collect();
    for fa in &touched {
        sqlx::query(
            "update bank_accounts set feed_status = $3, updated_at = $4::timestamp \
             where feed_connection_id = $1 and feed_account_id = $2 and deleted_at is null",
        )
        .bind(text(&row, "id"))
        .bind(text(fa, "providerAccountId"))
        .bind(text(fa, "status"))
        .bind(&timestamp)
        .execute(&ctx.db)
        .await?;
    }

    if INACTIVE_STATUSES.contains(&next_status.as_str())
        && !INACTIVE_STATUSES.contains(&current.as_str())
    {
        ctx.index_set_active(
            text(&row, "id").unwrap_or_default(),
            false,
            message.as_deref(),
        )
        .await?;
    }
    Ok(EventResult {
        missing: false,
        needs_sync: false,
        changed: next_status != current || !touched.is_empty(),
        status: next_status,
    })
}

/// What `POST /internal/bank-connections/events` did with one webhook
/// delivery: the events applied, and the sync they asked for.
#[derive(Debug, Clone)]
pub struct EventsOutcome {
    pub applied: usize,
    /// The connection was deleted; its index row was removed.
    pub missing: bool,
    pub outcome: Option<SyncOutcome>,
}

impl EventsOutcome {
    /// The route's `data`.
    pub fn to_json(&self) -> Value {
        if self.missing {
            return json!({ "applied": 0, "synced": false, "missing": true });
        }
        let synced = self
            .outcome
            .as_ref()
            .is_some_and(|o| o.skipped.is_none() && o.error.is_none());
        json!({
            "applied": self.applied,
            "synced": synced,
            "outcome": self.outcome.as_ref().map(SyncOutcome::to_json),
        })
    }
}

/// The internal events route (`routes/bank-connections/internal.ts`): apply
/// each event, drop the index row of a deleted connection, and sync when an
/// event says new data is waiting. The caller publishes `bank_connection`
/// `synced` (source `system`) when the sync ran without error or skip.
pub async fn apply_events(
    ctx: &FeedContext,
    connection_id: &str,
    events: &[FeedEvent],
) -> Result<EventsOutcome, ServiceError> {
    let mut needs_sync = false;
    let mut missing = false;
    for event in events {
        let result = apply_feed_event(ctx, connection_id, event).await?;
        needs_sync |= result.needs_sync;
        missing |= result.missing;
    }
    if missing {
        // The connection was deleted: the index row is stale.
        if let Err(error) = ctx.index_remove(connection_id).await {
            tracing::warn!(%error, "[bank-feeds] stale index row not removed");
        }
        return Ok(EventsOutcome {
            applied: 0,
            missing: true,
            outcome: None,
        });
    }
    let outcome = if needs_sync {
        Some(sync_connection(ctx, connection_id, false).await?)
    } else {
        None
    };
    Ok(EventsOutcome {
        applied: events.len(),
        missing: false,
        outcome,
    })
}
