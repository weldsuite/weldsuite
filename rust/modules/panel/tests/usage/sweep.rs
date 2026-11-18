//! `weldsuite cron panel-usage`, the `PanelUsage` Durable Object's
//! settlement alarm over the collector's counters
//! (`panel-usage-settlement.test.ts`): counts reach the settlement at the
//! next run while there are new ones, nothing is sent when there are none, a
//! failed settlement is retried, and a blocked workspace keeps asking until
//! the settlement says `ok`, because a blocked collector counts nothing that
//! could lift it. panel-api is faked as there. And the object's month
//! totals (`panel-usage.test.ts`), read from the counters the collector
//! writes ([`CacheUsage`]).
//!
//! The object's alarm timing (five minutes after the first count, not
//! pushed back by later ones) is the `CronJob`'s schedule here: a count
//! waits for the next run.

use std::sync::{Arc, Mutex, PoisonError};

use weldsuite_panel::usage_mail::NoticeSender;
use weldsuite_panel::usage_settlement::{SettlementInput, UsageNotice, month_of, quota_cache_key};
use weldsuite_panel::usage_sweep::{
    Settle, SettleAnswer, SweepReport, Totals, UsageSweep, month_totals, read_marker, run,
};
use weldsuite_panel::{CacheUsage, UsageCounter};
use weldsuite_panel_domain::js;
use weldsuite_ports::{BoxFuture, Cache, DynCache, MemoryCache};

const WS: &str = "ws_test_workspace";
const MINUTE: i64 = 60_000;
const SETTLE_INTERVAL_MS: i64 = 5 * MINUTE;

fn at(iso: &str) -> i64 {
    js::parse_iso(iso).expect("a time")
}

fn now() -> i64 {
    at("2026-10-27T12:00:00.000Z")
}

/// What the fake panel-api answers a call.
#[derive(Clone)]
enum Answer {
    Quota(&'static str),
    /// panel-api answered 500.
    Fail,
    /// The call didn't arrive.
    Throw,
}

/// panel-api's settle route as the object's tests fake it: each call takes
/// the next answer (the last one repeats; `ok` without any) and, as the
/// settlement does for the current month, writes the quota state the
/// collector reads.
struct FakeApi {
    cache: Arc<dyn DynCache>,
    answers: Vec<Answer>,
    calls: Mutex<Vec<(String, i64, i64)>>,
    now: Mutex<i64>,
    /// Counted while the first call is answered: a collector call landing
    /// during the settlement.
    during_first: Mutex<Option<(&'static str, u64)>>,
    /// The notice each accepted settlement claims.
    notice: Option<UsageNotice>,
}

impl FakeApi {
    fn new(answers: Vec<Answer>) -> Self {
        Self {
            cache: Arc::new(MemoryCache::new()),
            answers,
            calls: Mutex::new(Vec::new()),
            now: Mutex::new(now()),
            during_first: Mutex::new(None),
            notice: None,
        }
    }

    fn calls(&self) -> Vec<(String, i64, i64)> {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    async fn add(&self, day: &str, events: u64) {
        CacheUsage::new(Arc::clone(&self.cache))
            .add(WS, day, events)
            .await
            .expect("counted");
    }

    async fn add_recordings(&self, day: &str, recordings: u64) {
        CacheUsage::new(Arc::clone(&self.cache))
            .add_recordings(WS, day, recordings)
            .await
            .expect("counted");
    }

    /// One run of the job at `now`.
    async fn sweep_at(&self, now: i64, notices: Option<&dyn NoticeSender>) -> SweepReport {
        *self.now.lock().unwrap_or_else(PoisonError::into_inner) = now;
        let cache = Arc::clone(&self.cache);
        run(
            &UsageSweep {
                cache: &cache,
                settle: self,
                notices,
                now,
            },
            &[WS.to_owned()],
        )
        .await
    }

    async fn sweep(&self, now: i64) -> SweepReport {
        self.sweep_at(now, None).await
    }
}

impl Settle for FakeApi {
    fn settle<'a>(
        &'a self,
        input: &'a SettlementInput,
    ) -> BoxFuture<'a, Result<Option<SettleAnswer>, String>> {
        Box::pin(async move {
            let index = {
                let mut calls = self.calls.lock().unwrap_or_else(PoisonError::into_inner);
                calls.push((input.month.clone(), input.events, input.recordings));
                calls.len() - 1
            };
            let during = if index == 0 {
                self.during_first
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take()
            } else {
                None
            };
            if let Some((day, events)) = during {
                self.add(day, events).await;
            }
            let answer = self
                .answers
                .get(index)
                .or_else(|| self.answers.last())
                .cloned()
                .unwrap_or(Answer::Quota("ok"));
            match answer {
                Answer::Fail => Err("panel-api answered 500".to_owned()),
                Answer::Throw => Err("network down".to_owned()),
                Answer::Quota(quota) => {
                    let now = *self.now.lock().unwrap_or_else(PoisonError::into_inner);
                    if input.month == month_of(now) {
                        let key = quota_cache_key(&input.workspace_id);
                        if quota == "ok" {
                            self.cache.delete(&key).await.expect("quota");
                        } else {
                            self.cache.put(&key, quota, None).await.expect("quota");
                        }
                    }
                    Ok(Some(SettleAnswer {
                        quota,
                        notice: self.notice.clone(),
                    }))
                }
            }
        })
    }
}

/// Records the notices it is handed and mails each to one owner.
#[derive(Default)]
struct FakeMail(Mutex<Vec<String>>);

impl NoticeSender for FakeMail {
    fn send<'a>(&'a self, notice: &'a UsageNotice) -> BoxFuture<'a, usize> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(format!("{}:{}", notice.month, notice.kind));
        Box::pin(std::future::ready(1))
    }
}

fn call(month: &str, events: i64, recordings: i64) -> (String, i64, i64) {
    (month.to_owned(), events, recordings)
}

#[tokio::test]
async fn a_count_waits_for_the_next_run_which_sends_everything_counted_by_then() {
    let api = FakeApi::new(Vec::new());
    api.sweep(now()).await;
    assert!(api.calls().is_empty(), "nothing counted, nothing sent");

    api.add("2026-10-27", 5).await;
    api.add("2026-10-27", 5).await;
    api.add_recordings("2026-10-27", 1).await;
    api.sweep(now() + SETTLE_INTERVAL_MS).await;
    assert_eq!(api.calls(), [call("2026-10", 10, 1)]);
}

#[tokio::test]
async fn sends_the_month_totals_and_goes_quiet_once_they_are_accepted() {
    let api = FakeApi::new(vec![Answer::Quota("ok")]);
    api.add("2026-10-26", 40).await;
    api.add("2026-10-27", 2).await;
    api.add_recordings("2026-10-27", 3).await;

    let report = api.sweep(now()).await;
    assert_eq!(api.calls(), [call("2026-10", 42, 3)]);
    assert_eq!((report.workspaces, report.settled), (1, 1));

    // Nothing new: the next run sends nothing.
    api.sweep(now() + SETTLE_INTERVAL_MS).await;
    assert_eq!(api.calls().len(), 1);
}

#[tokio::test]
async fn keeps_each_month_apart_when_counts_from_a_finished_month_are_still_unsent() {
    let api = FakeApi::new(Vec::new());
    api.add("2026-09-30", 7).await;
    api.add("2026-10-01", 1).await;

    api.sweep(now()).await;

    assert_eq!(api.calls(), [call("2026-09", 7, 0), call("2026-10", 1, 0)]);
}

#[tokio::test]
async fn retries_a_failed_or_refused_settlement_at_the_next_run_then_stops_when_accepted() {
    let api = FakeApi::new(vec![Answer::Fail, Answer::Throw, Answer::Quota("ok")]);
    api.add("2026-10-27", 9).await;

    let report = api.sweep(now()).await;
    assert_eq!((report.settled, report.failed), (0, 1));
    api.sweep(now() + SETTLE_INTERVAL_MS).await;
    api.sweep(now() + 2 * SETTLE_INTERVAL_MS).await;
    assert_eq!(api.calls().len(), 3);

    api.sweep(now() + 3 * SETTLE_INTERVAL_MS).await;
    assert_eq!(api.calls().len(), 3, "accepted: nothing left to send");
}

#[tokio::test]
async fn keeps_asking_while_the_quota_is_not_ok_without_new_counts_and_lets_go_at_ok() {
    let api = FakeApi::new(vec![
        Answer::Quota("events_blocked"),
        Answer::Quota("events_blocked"),
        Answer::Quota("ok"),
    ]);
    api.add("2026-10-27", 60_000).await;

    api.sweep(now() + SETTLE_INTERVAL_MS).await;
    api.sweep(now() + 2 * SETTLE_INTERVAL_MS).await;
    assert_eq!(api.calls().len(), 2);
    // The same totals: the settlement retries the unpaid blocks.
    assert_eq!(api.calls()[1], call("2026-10", 60_000, 0));

    api.sweep(now() + 3 * SETTLE_INTERVAL_MS).await;
    assert_eq!(api.calls().len(), 3);
    api.sweep(now() + 4 * SETTLE_INTERVAL_MS).await;
    assert_eq!(api.calls().len(), 3, "nothing more after `ok`");
}

#[tokio::test]
async fn asks_again_for_the_new_month_while_blocked_so_a_block_lifts_when_the_month_turns() {
    let api = FakeApi::new(vec![Answer::Quota("replay_blocked"), Answer::Quota("ok")]);
    api.add("2026-10-31", 10).await;
    api.sweep(at("2026-10-31T23:58:00.000Z")).await;

    api.sweep(at("2026-11-01T00:03:00.000Z")).await;

    assert_eq!(api.calls(), [call("2026-10", 10, 0), call("2026-11", 0, 0)]);
    assert_eq!(
        api.cache.get(&quota_cache_key(WS)).await.expect("quota"),
        None
    );
}

#[tokio::test]
async fn counts_that_arrive_while_a_settlement_runs_go_out_at_the_next_run() {
    let api = FakeApi::new(Vec::new());
    api.add("2026-10-27", 5).await;
    *api.during_first
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = Some(("2026-10-27", 1));

    api.sweep(now()).await;
    api.sweep(now() + SETTLE_INTERVAL_MS).await;

    assert_eq!(
        api.calls()
            .iter()
            .map(|(_, events, _)| *events)
            .collect::<Vec<_>>(),
        [5, 6]
    );
}

#[tokio::test]
async fn does_nothing_for_a_workspace_with_nothing_counted_and_its_quota_ok() {
    let api = FakeApi::new(Vec::new());
    let report = api.sweep(now()).await;
    assert_eq!(api.calls(), Vec::<(String, i64, i64)>::new());
    assert_eq!(
        report,
        SweepReport {
            workspaces: 1,
            ..SweepReport::default()
        }
    );
}

#[tokio::test]
async fn a_finished_month_is_read_until_a_run_past_its_end_closes_it() {
    let api = FakeApi::new(Vec::new());
    api.add("2026-10-31", 10).await;
    api.sweep(at("2026-11-01T00:03:00.000Z")).await;
    // A count the collector took just before midnight lands late.
    api.add("2026-10-31", 2).await;
    api.sweep(at("2026-11-01T00:20:00.000Z")).await;
    assert!(
        read_marker(&api.cache, WS, "2026-10")
            .await
            .expect("marker")
            .closed
    );

    api.add("2026-10-31", 5).await;
    api.sweep(at("2026-11-01T00:25:00.000Z")).await;

    assert_eq!(
        api.calls(),
        [call("2026-10", 10, 0), call("2026-10", 12, 0)]
    );
}

#[tokio::test]
async fn the_notice_a_settlement_claims_is_mailed_and_counted() {
    let mut api = FakeApi::new(Vec::new());
    api.notice = Some(UsageNotice {
        workspace_id: WS.to_owned(),
        workspace_name: "Acme".to_owned(),
        clerk_org_id: None,
        kind: "near",
        month: "2026-10".to_owned(),
        events: (41_000, 50_000),
        recordings: (0, 500),
    });
    api.add("2026-10-27", 41_000).await;
    let mail = FakeMail::default();

    let report = api.sweep_at(now(), Some(&mail)).await;
    assert_eq!((report.notices, report.mailed), (1, 1));
    assert_eq!(
        *mail.0.lock().unwrap_or_else(PoisonError::into_inner),
        ["2026-10:near"]
    );

    // Without mail the notice is claimed and nobody is mailed, as panel-api
    // without a mail binding.
    api.add("2026-10-27", 1).await;
    let report = api.sweep(now() + SETTLE_INTERVAL_MS).await;
    assert_eq!((report.notices, report.mailed), (1, 0));
}

// ── PanelUsage.month(): the month's totals from the day counters ─────────

#[tokio::test]
async fn counts_events_per_utc_day() {
    let api = FakeApi::new(Vec::new());
    api.add("2026-10-27", 3).await;
    api.add("2026-10-27", 2).await;
    api.add("2026-10-28", 10).await;

    assert_eq!(
        month_totals(&api.cache, WS, "2026-10", None)
            .await
            .expect("totals"),
        Totals {
            events: 15,
            recordings: 0
        }
    );
    // The current month is read up to today.
    assert_eq!(
        month_totals(&api.cache, WS, "2026-10", Some("2026-10-27"))
            .await
            .expect("totals")
            .events,
        5
    );
}

#[tokio::test]
async fn keeps_months_apart() {
    let api = FakeApi::new(Vec::new());
    api.add("2026-09-30", 7).await;
    api.add("2026-10-01", 1).await;

    let totals = |month: &'static str| {
        let cache = Arc::clone(&api.cache);
        async move { month_totals(&cache, WS, month, None).await.expect("totals") }
    };
    assert_eq!(totals("2026-09").await.events, 7);
    assert_eq!(totals("2026-10").await.events, 1);
    assert_eq!(totals("2026-11").await, Totals::default());
}

#[tokio::test]
async fn counts_recordings_apart_from_events_per_utc_day_and_month() {
    let api = FakeApi::new(Vec::new());
    api.add_recordings("2026-10-27", 1).await;
    api.add_recordings("2026-10-27", 2).await;
    api.add_recordings("2026-10-28", 1).await;
    api.add_recordings("2026-11-01", 5).await;
    api.add("2026-10-27", 4).await;

    assert_eq!(
        month_totals(&api.cache, WS, "2026-10", None)
            .await
            .expect("totals"),
        Totals {
            events: 4,
            recordings: 4
        }
    );
    assert_eq!(
        month_totals(&api.cache, WS, "2026-11", None)
            .await
            .expect("totals")
            .recordings,
        5
    );
}
