//! `weldsuite cron panel-usage` (every 5 minutes): the settlement alarm of
//! the `PanelUsage` Durable Objects
//! (`apps/workers/panel-ingest/src/durable-objects/panel-usage.ts`, ADR
//! PANEL-007) over the counts the collector keeps in the cache.
//!
//! On Global each workspace's object counts its events and recordings per
//! UTC day and, about every five minutes while it holds counts panel-api has
//! not seen, posts each such month's totals to
//! `POST /internal/panel/usage/settle` ([`settle_usage`]). Here the counts are
//! cache counters per workspace and day ([`crate::CacheUsage`]), and one job
//! does what every object's alarm did:
//!
//! - The workspaces come from the master `panel_project_registry`: every
//!   workspace the collector counts for has a project there (live, or
//!   deleted since the start of the month before). No tenant database is
//!   opened to find them.
//! - A month is settled when its totals differ from what was last settled
//!   (kept next to the counters, `panel:usage-settled:<workspace>:<month>`),
//!   the objects' "dirty" marks. Counts that arrive while a settlement runs
//!   make the totals differ again, so they go out at the next run.
//! - The current month is settled also while the collector's quota state is
//!   not `ok`, with or without new counts: a blocked workspace sends
//!   nothing, so a top-up or a new month would otherwise never lift the block.
//! - The month before is read until it is closed: the collector counts on
//!   the day it receives, so a finished month changes only in the minutes
//!   around its end. A run [`CLOSE_AFTER_MS`] past the end settles what
//!   changed and marks the month closed; it isn't read again.
//! - A failed settlement leaves its marker as it was: the next run tries
//!   again.
//!
//! A tenant database is opened only to mail the owners a notice a
//! settlement claimed ([`NoticeSender`]), as panel-api's `sendUsageNotice`
//! does.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde::{Deserialize, Serialize};
use weldsuite_db::{PgPool, orm};
use weldsuite_panel_domain::js;
use weldsuite_ports::{BoxFuture, Cache, DynCache, PortError};
use weldsuite_schema::master::panel_project_registry::{self as registry, Column};

use crate::domain::{parse_quota_state, quota_key};
use crate::saved::instant;
use crate::usage_mail::NoticeSender;
use crate::usage_settlement::{
    Settlement, SettlementInput, UsageNotice, month_of, month_start, settle_usage,
};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// A finished month is read until a run this long past its end.
pub const CLOSE_AFTER_MS: i64 = 15 * 60 * 1000;
/// How long a month's marker is kept: well past the month after it.
const MARKER_TTL: Duration = Duration::from_hours(70 * 24);
/// Workspaces settled at the same time.
const AT_ONCE: usize = 8;

/// The collector's events on a UTC day (`YYYY-MM-DD`), [`crate::CacheUsage`].
pub fn events_key(workspace_id: &str, day: &str) -> String {
    format!("panel:usage:{workspace_id}:{day}")
}

/// The collector's recordings started on a UTC day, [`crate::CacheUsage`].
pub fn recordings_key(workspace_id: &str, day: &str) -> String {
    format!("panel:usage-recordings:{workspace_id}:{day}")
}

/// What was last settled of a workspace's month.
pub fn settled_key(workspace_id: &str, month: &str) -> String {
    format!("panel:usage-settled:{workspace_id}:{month}")
}

/// A month's events and recordings.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Totals {
    pub events: i64,
    pub recordings: i64,
}

/// What was last settled of a month, and whether it is closed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Marker {
    pub events: i64,
    pub recordings: i64,
    #[serde(default)]
    pub closed: bool,
}

impl Marker {
    fn totals(self) -> Totals {
        Totals {
            events: self.events,
            recordings: self.recordings,
        }
    }
}

/// A count as the cache holds it; anything else counts nothing.
fn count(raw: Option<&str>) -> i64 {
    raw.and_then(|text| text.trim().parse::<i64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(0)
}

/// `PanelUsage.month(month)`: the month's totals, its days' counters added
/// up. `through` (`YYYY-MM-DD`) leaves out the days after it.
pub async fn month_totals(
    cache: &Arc<dyn DynCache>,
    workspace_id: &str,
    month: &str,
    through: Option<&str>,
) -> Result<Totals, PortError> {
    let (Some(start), Some(end)) = (month_start(month, 0), month_start(month, 1)) else {
        return Err(PortError::backend(format!("not a month: {month}")));
    };
    let days: Vec<String> = (0..(end - start) / DAY_MS)
        .map(|n| js::iso_day(start + n * DAY_MS))
        .filter(|day| through.is_none_or(|last| day.as_str() <= last))
        .collect();
    let events = futures_util::future::join_all(
        days.iter()
            .map(|day| async move { cache.get(&events_key(workspace_id, day)).await }),
    );
    let recordings = futures_util::future::join_all(
        days.iter()
            .map(|day| async move { cache.get(&recordings_key(workspace_id, day)).await }),
    );
    let (events, recordings) = futures_util::join!(events, recordings);
    let mut totals = Totals::default();
    for value in events {
        totals.events += count(value?.as_deref());
    }
    for value in recordings {
        totals.recordings += count(value?.as_deref());
    }
    Ok(totals)
}

/// The month's marker; none yet is nothing settled.
pub async fn read_marker(
    cache: &Arc<dyn DynCache>,
    workspace_id: &str,
    month: &str,
) -> Result<Marker, PortError> {
    let raw = cache.get(&settled_key(workspace_id, month)).await?;
    Ok(raw
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default())
}

async fn write_marker(
    cache: &Arc<dyn DynCache>,
    workspace_id: &str,
    month: &str,
    marker: Marker,
) -> Result<(), PortError> {
    let text = serde_json::to_string(&marker).map_err(PortError::backend)?;
    cache
        .put(&settled_key(workspace_id, month), &text, Some(MARKER_TTL))
        .await
}

/// A settlement's answer: the quota state (`{ quota }` of the settle route)
/// and the notice it claimed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleAnswer {
    pub quota: &'static str,
    pub notice: Option<UsageNotice>,
}

/// What the job settles a month with: [`MasterSettle`], or a test's double
/// (`PanelUsage`'s `PANEL_API` binding).
pub trait Settle: Send + Sync {
    /// `None` when there is no such workspace.
    fn settle<'a>(
        &'a self,
        input: &'a SettlementInput,
    ) -> BoxFuture<'a, Result<Option<SettleAnswer>, String>>;
}

/// [`settle_usage`] on the master database, as
/// `POST /internal/panel/usage/settle` runs it.
pub struct MasterSettle<'a>(pub Settlement<'a>);

impl Settle for MasterSettle<'_> {
    fn settle<'a>(
        &'a self,
        input: &'a SettlementInput,
    ) -> BoxFuture<'a, Result<Option<SettleAnswer>, String>> {
        Box::pin(async move {
            settle_usage(&self.0, input)
                .await
                .map(|settled| {
                    settled.map(|settled| SettleAnswer {
                        quota: settled.quota,
                        notice: settled.notice,
                    })
                })
                .map_err(|error| error.to_string())
        })
    }
}

/// One run of the job.
pub struct UsageSweep<'a> {
    /// The cache the collector counts in, and the settlement writes the
    /// quota state to (Valkey).
    pub cache: &'a Arc<dyn DynCache>,
    pub settle: &'a dyn Settle,
    /// Mails the notices the settlements claim; `None` mails none (no mail
    /// transport).
    pub notices: Option<&'a dyn NoticeSender>,
    /// Epoch milliseconds.
    pub now: i64,
}

/// What a run did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct SweepReport {
    /// Workspaces looked at.
    pub workspaces: usize,
    /// Months settled.
    pub settled: usize,
    /// Months whose counters or settlement failed: tried again next run.
    pub failed: usize,
    /// Months of a workspace the master database doesn't know.
    pub unknown: usize,
    /// Notices the settlements claimed, and the emails sent for them.
    pub notices: usize,
    pub mailed: usize,
}

impl SweepReport {
    fn add(&mut self, other: Self) {
        self.workspaces += other.workspaces;
        self.settled += other.settled;
        self.failed += other.failed;
        self.unknown += other.unknown;
        self.notices += other.notices;
        self.mailed += other.mailed;
    }
}

/// The workspaces the collector may have counted for since the start of the
/// month before: every one with a project in the master registry, live or
/// deleted since then.
pub async fn counted_workspaces(master: &PgPool, now: i64) -> Result<Vec<String>, DbErr> {
    let since = month_start(&month_of(now), -1).unwrap_or(now);
    registry::Entity::find()
        .select_only()
        .column(Column::WorkspaceId)
        .distinct()
        .filter(
            Condition::any()
                .add(Column::DeletedAt.is_null())
                .add(Column::DeletedAt.gte(instant(since))),
        )
        .order_by_asc(Column::WorkspaceId)
        .into_tuple()
        .all(&orm(master))
        .await
}

/// Settles what is due of every workspace in `workspaces`, a few at a time.
pub async fn run(sweep: &UsageSweep<'_>, workspaces: &[String]) -> SweepReport {
    let mut report = SweepReport::default();
    let mut runs = futures_util::stream::iter(workspaces)
        .map(|workspace_id| sweep_workspace(sweep, workspace_id))
        .buffer_unordered(AT_ONCE);
    while let Some(one) = runs.next().await {
        report.add(one);
    }
    report
}

/// The alarm of one workspace's object: its month before (until closed)
/// and its current month, settled when due.
pub async fn sweep_workspace(sweep: &UsageSweep<'_>, workspace_id: &str) -> SweepReport {
    let mut report = SweepReport {
        workspaces: 1,
        ..SweepReport::default()
    };
    let cache = sweep.cache;
    let current = month_of(sweep.now);
    let Some(previous) = month_start(&current, -1).map(month_of) else {
        return report;
    };
    let quota = match cache.get(&quota_key(workspace_id)).await {
        Ok(raw) => parse_quota_state(raw.as_deref()),
        Err(error) => {
            tracing::error!(%error, workspace = workspace_id, "[panel-usage] quota state read failed");
            report.failed += 1;
            return report;
        }
    };
    let today = js::iso_day(sweep.now);
    for month in [previous, current.clone()] {
        let is_current = month == current;
        let read = async {
            let marker = read_marker(cache, workspace_id, &month).await?;
            if marker.closed {
                return Ok(None);
            }
            let through = is_current.then_some(today.as_str());
            let totals = month_totals(cache, workspace_id, &month, through).await?;
            Ok::<_, PortError>(Some((marker, totals)))
        };
        let (marker, totals) = match read.await {
            Ok(Some(read)) => read,
            Ok(None) => continue,
            Err(error) => {
                tracing::error!(%error, workspace = workspace_id, %month, "[panel-usage] counter read failed");
                report.failed += 1;
                continue;
            }
        };
        let closes = !is_current
            && month_start(&month, 1).is_some_and(|end| sweep.now >= end + CLOSE_AFTER_MS);
        let due = totals != marker.totals() || (is_current && quota != "ok");
        if !due {
            if closes {
                let finished = Marker {
                    closed: true,
                    ..marker
                };
                if let Err(error) = write_marker(cache, workspace_id, &month, finished).await {
                    tracing::warn!(%error, workspace = workspace_id, %month, "[panel-usage] marker write failed");
                }
            }
            continue;
        }
        settle_month(sweep, &mut report, workspace_id, &month, totals, closes).await;
    }
    report
}

/// Settles one month's totals and remembers them when they were accepted.
async fn settle_month(
    sweep: &UsageSweep<'_>,
    report: &mut SweepReport,
    workspace_id: &str,
    month: &str,
    totals: Totals,
    closes: bool,
) {
    let input = SettlementInput {
        workspace_id: workspace_id.to_owned(),
        month: month.to_owned(),
        events: totals.events,
        recordings: totals.recordings,
    };
    match sweep.settle.settle(&input).await {
        Ok(Some(answer)) => {
            report.settled += 1;
            let marker = Marker {
                events: totals.events,
                recordings: totals.recordings,
                closed: closes,
            };
            if let Err(error) = write_marker(sweep.cache, workspace_id, month, marker).await {
                // Settled again next run, which changes nothing.
                tracing::warn!(%error, workspace = workspace_id, month, "[panel-usage] marker write failed");
            }
            if let Some(notice) = answer.notice {
                report.notices += 1;
                if let Some(sender) = sweep.notices {
                    report.mailed += sender.send(&notice).await;
                }
            }
        }
        Ok(None) => {
            tracing::warn!(
                workspace = workspace_id,
                month,
                "[panel-usage] usage of a workspace the master database doesn't know"
            );
            report.unknown += 1;
        }
        Err(error) => {
            tracing::error!(%error, workspace = workspace_id, month, "[panel-usage] settlement failed");
            report.failed += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_read_as_the_cache_holds_them() {
        assert_eq!(count(Some("42")), 42);
        assert_eq!(count(Some(" 7 ")), 7);
        assert_eq!(count(Some("x")), 0);
        assert_eq!(count(Some("-3")), 0);
        assert_eq!(count(None), 0);
    }

    #[test]
    fn markers_round_trip_and_default_to_nothing_settled() {
        let marker: Marker =
            serde_json::from_str(r#"{"events":5,"recordings":1}"#).expect("marker");
        assert_eq!(
            marker,
            Marker {
                events: 5,
                recordings: 1,
                closed: false
            }
        );
        assert_eq!(
            marker.totals(),
            Totals {
                events: 5,
                recordings: 1
            }
        );
    }
}
