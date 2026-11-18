//! The MTA's Prometheus metrics, recorded through the `metrics` facade; the
//! binary exports them on `METRICS_ADDR` (`weldsuite mta`). The alert rules
//! and dashboards read these names: don't rename them.
//!
//! - [`MESSAGES_METRIC`] `{pool, outcome}`: delivery attempts whose outcome
//!   was recorded, one per recipient: `delivered`, `deferred` (4xx or a
//!   broken connection; retried) or `bounced` (5xx, or out of retries).
//! - [`DB_POOL_CONNECTIONS_METRIC`] `{pool="mta", state}` (`idle`,
//!   `in_use`) and [`DB_POOL_MAX_METRIC`] `{pool="mta"}`: the queue
//!   database's pool, sampled every [`POOL_SAMPLE_INTERVAL`]. The same names
//!   the binary uses for `serve` and `consume`.

use std::time::Duration;

use sqlx::PgPool;
use tokio_util::sync::CancellationToken;

use crate::store::Outcome;

pub const MESSAGES_METRIC: &str = "weldsuite_mta_messages_total";
pub const DB_POOL_CONNECTIONS_METRIC: &str = "weldsuite_db_pool_connections";
pub const DB_POOL_MAX_METRIC: &str = "weldsuite_db_pool_max_connections";
pub const POOL_SAMPLE_INTERVAL: Duration = Duration::from_secs(15);

/// The `outcome` label of a recorded delivery attempt.
pub fn outcome_label(outcome: &Outcome) -> &'static str {
    match outcome {
        Outcome::Delivered { .. } => "delivered",
        Outcome::Deferred { .. } => "deferred",
        Outcome::Bounced { .. } | Outcome::Expired { .. } => "bounced",
    }
}

/// Count one recorded delivery attempt of a recipient in `pool`.
pub(crate) fn count_delivery(pool: &str, outcome: &Outcome) {
    metrics::counter!(
        MESSAGES_METRIC,
        "pool" => pool.to_owned(),
        "outcome" => outcome_label(outcome)
    )
    .increment(1);
}

/// Record the pool's connections now.
pub fn record_pool(pool: &PgPool) {
    let open = pool.size();
    let idle = u32::try_from(pool.num_idle()).unwrap_or(u32::MAX).min(open);
    metrics::gauge!(DB_POOL_CONNECTIONS_METRIC, "pool" => "mta", "state" => "idle")
        .set(f64::from(idle));
    metrics::gauge!(DB_POOL_CONNECTIONS_METRIC, "pool" => "mta", "state" => "in_use")
        .set(f64::from(open - idle));
    metrics::gauge!(DB_POOL_MAX_METRIC, "pool" => "mta")
        .set(f64::from(pool.options().get_max_connections()));
}

/// Record the pool every [`POOL_SAMPLE_INTERVAL`] until `shutdown`.
pub(crate) async fn sample_pool(pool: PgPool, shutdown: CancellationToken) {
    let mut ticker = tokio::time::interval(POOL_SAMPLE_INTERVAL);
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return,
            _ = ticker.tick() => record_pool(&pool),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcomes_fold_into_three_labels() {
        let response = || "250 ok".to_owned();
        assert_eq!(
            outcome_label(&Outcome::Delivered {
                response: response()
            }),
            "delivered"
        );
        assert_eq!(
            outcome_label(&Outcome::Deferred {
                response: response(),
                delay: Duration::from_secs(60),
            }),
            "deferred"
        );
        assert_eq!(
            outcome_label(&Outcome::Bounced {
                response: response(),
                hard: true,
            }),
            "bounced"
        );
        assert_eq!(
            outcome_label(&Outcome::Expired {
                response: response()
            }),
            "bounced"
        );
    }
}
