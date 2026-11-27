//! The MTA's own database (`weldsuite_mta`): the queue, DKIM keys,
//! suppressions, per-IP counters, TLS results and the event outbox.
//!
//! Its migrations are embedded here and applied by [`Store::migrate`] under
//! an advisory lock, so every mail node can run them at start. They are not
//! Drizzle's: no TypeScript code reads this database.
//!
//! The queue is one row per recipient. A delivery worker claims due rows
//! with `FOR UPDATE SKIP LOCKED` and a lease, so the nodes of a pool share
//! the work and a node that dies mid-delivery only delays its rows by the
//! lease. Every outcome and its delivery event are written in one
//! transaction (the outbox).

use std::time::Duration;

use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Postgres, Transaction};

use crate::crypto::new_id;
use crate::events::{self, Kind};
use crate::warmup::{DaySent, HISTORY_DAYS, Warmup};

/// A database failure.
#[derive(Debug)]
pub struct StoreError(pub String);

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "MTA database: {}", self.0)
    }
}

impl std::error::Error for StoreError {}

impl From<sqlx::Error> for StoreError {
    fn from(error: sqlx::Error) -> Self {
        Self(error.to_string())
    }
}

type Result<T> = std::result::Result<T, StoreError>;

/// The migrations, in order. Never edit one that has shipped; add another.
const MIGRATIONS: &[(i32, &str, &str)] = &[
    (
        1,
        "queue, domains, suppressions, counters, outbox",
        r"
CREATE TABLE mta_messages (
  id text PRIMARY KEY,
  pool text NOT NULL,
  mail_from text NOT NULL,
  header_from text NOT NULL,
  body bytea NOT NULL,
  size_bytes integer NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mta_messages_received ON mta_messages (received_at);

CREATE TABLE mta_recipients (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES mta_messages (id) ON DELETE CASCADE,
  pool text NOT NULL,
  address text NOT NULL,
  domain text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'delivered', 'bounced', 'expired')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  last_response text,
  deferred_reported boolean NOT NULL DEFAULT false,
  complained boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX mta_recipients_due ON mta_recipients (next_attempt_at) WHERE status = 'queued';
CREATE INDEX mta_recipients_message ON mta_recipients (message_id);

CREATE TABLE mta_domains (
  domain text PRIMARY KEY,
  selector text NOT NULL,
  algorithm text NOT NULL,
  sealed_key bytea NOT NULL,
  public_key text NOT NULL,
  pools text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mta_suppressions (
  pool text NOT NULL,
  address text NOT NULL,
  reason text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (pool, address)
);

CREATE TABLE mta_outbox (
  id bigserial PRIMARY KEY,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX mta_outbox_pending ON mta_outbox (id) WHERE published_at IS NULL;

CREATE TABLE mta_ips (
  ip text PRIMARY KEY,
  first_day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date
);

CREATE TABLE mta_ip_usage (
  ip text NOT NULL,
  day date NOT NULL,
  sent integer NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);

CREATE TABLE mta_tls_results (
  policy_domain text NOT NULL,
  day date NOT NULL,
  policy_type text NOT NULL,
  policy_strings text[] NOT NULL DEFAULT '{}',
  mx_host text NOT NULL DEFAULT '',
  successes integer NOT NULL DEFAULT 0,
  failures jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (policy_domain, day, policy_type, mx_host)
);

CREATE TABLE mta_jobs (
  name text PRIMARY KEY,
  last_run date NOT NULL
);
",
    ),
    (
        2,
        "mail nodes: each sending address with its pools (DMARC reports, MAIL-015)",
        r"
CREATE TABLE mta_nodes (
  ip text PRIMARY KEY,
  hostname text NOT NULL,
  pools text[] NOT NULL DEFAULT '{}',
  seen_at timestamptz NOT NULL DEFAULT now()
);
",
    ),
];

const MIGRATION_LOCK: i64 = 0x5745_4c44_4d54_4131; // "WELDMTA1"

/// A recipient claimed for delivery.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Claimed {
    pub id: String,
    pub message_id: String,
    pub pool: String,
    pub address: String,
    pub domain: String,
    pub attempts: i32,
    /// Seconds since the message was received.
    pub age_seconds: f64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct StoredMessage {
    pub id: String,
    pub pool: String,
    pub mail_from: String,
    pub header_from: String,
    pub body: Vec<u8>,
}

/// A recipient, for the return path.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RecipientInfo {
    pub id: String,
    pub pool: String,
    pub address: String,
    pub status: String,
    pub header_from: String,
    pub complained: bool,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DomainRow {
    pub domain: String,
    pub selector: String,
    pub algorithm: String,
    pub sealed_key: Vec<u8>,
    pub public_key: String,
    pub pools: Vec<String>,
    pub created_at: String,
}

/// One TLS-RPT result row.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TlsResultRow {
    pub policy_domain: String,
    pub policy_type: String,
    pub policy_strings: Vec<String>,
    pub mx_host: String,
    pub successes: i32,
    pub failures: Value,
}

/// How a recipient's attempt ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Delivered {
        response: String,
    },
    /// Try again after `delay`; `report` emits the one `deferred` event.
    Deferred {
        response: String,
        delay: Duration,
    },
    /// Permanent failure. `hard`: the address does not exist (suppressed).
    Bounced {
        response: String,
        hard: bool,
    },
    /// Out of retries.
    Expired {
        response: String,
    },
}

/// What [`Store::reserve_ip`] decided for one send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reservation {
    /// Under today's cap, or the IP has none: send.
    Granted,
    /// Over today's cap in a soft pool: send; `sent` is today's count with
    /// this one.
    OverCap { cap: u32, sent: u32 },
    /// Today's cap is reached: hold the send until the next UTC day.
    Held { cap: u32 },
}

const DOMAIN_ONE: &str = r#"SELECT domain, selector, algorithm, sealed_key, public_key, pools,
       to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
  FROM mta_domains WHERE domain = $1"#;
const DOMAIN_ALL: &str = r#"SELECT domain, selector, algorithm, sealed_key, public_key, pools,
       to_char(created_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
  FROM mta_domains ORDER BY domain"#;

/// The MTA database.
#[derive(Debug, Clone)]
pub struct Store {
    pool: PgPool,
    suppress_days: i32,
}

impl Store {
    /// A lazy pool: the process starts and reports not-ready until the
    /// database answers.
    pub fn connect(url: &str, max_connections: u32) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(max_connections)
            .acquire_timeout(Duration::from_secs(5))
            .connect_lazy(url)?;
        Ok(Self {
            pool,
            suppress_days: 30,
        })
    }

    #[must_use]
    pub fn with_suppress_days(mut self, days: u32) -> Self {
        self.suppress_days = i32::try_from(days).unwrap_or(i32::MAX);
        self
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(&self.pool).await?;
        Ok(())
    }

    /// Applies the missing migrations, one transaction each, under a
    /// session advisory lock. Returns how many ran.
    pub async fn migrate(&self) -> Result<usize> {
        let mut conn = self.pool.acquire().await?;
        sqlx::query("SELECT pg_advisory_lock($1)")
            .bind(MIGRATION_LOCK)
            .execute(&mut *conn)
            .await?;
        let result = async {
            sqlx::query(
                "CREATE TABLE IF NOT EXISTS mta_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
            )
            .execute(&mut *conn)
            .await?;
            let applied: Vec<i32> = sqlx::query_scalar("SELECT version FROM mta_migrations")
                .fetch_all(&mut *conn)
                .await?;
            let mut ran = 0;
            for (version, name, sql) in MIGRATIONS {
                if applied.contains(version) {
                    continue;
                }
                let mut tx = sqlx::Connection::begin(&mut *conn).await?;
                sqlx::raw_sql(*sql).execute(&mut *tx).await?;
                sqlx::query("INSERT INTO mta_migrations (version, name) VALUES ($1, $2)")
                    .bind(version)
                    .bind(name)
                    .execute(&mut *tx)
                    .await?;
                tx.commit().await?;
                tracing::info!(version, name, "MTA migration applied");
                ran += 1;
            }
            Ok::<usize, sqlx::Error>(ran)
        }
        .await;
        let _ = sqlx::query("SELECT pg_advisory_unlock($1)")
            .bind(MIGRATION_LOCK)
            .execute(&mut *conn)
            .await;
        Ok(result?)
    }

    // ---- submission -------------------------------------------------------

    /// Stores a message and its recipients; returns the message id.
    pub async fn enqueue(
        &self,
        pool: &str,
        mail_from: &str,
        header_from: &str,
        body: &[u8],
        recipients: &[String],
    ) -> Result<String> {
        let message_id = new_id("m");
        let size = i32::try_from(body.len()).unwrap_or(i32::MAX);
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO mta_messages (id, pool, mail_from, header_from, body, size_bytes) VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(&message_id)
        .bind(pool)
        .bind(mail_from)
        .bind(header_from)
        .bind(body)
        .bind(size)
        .execute(&mut *tx)
        .await?;
        for address in recipients {
            let domain = crate::message::domain_of(address).unwrap_or_default();
            sqlx::query(
                "INSERT INTO mta_recipients (id, message_id, pool, address, domain) VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(new_id("r"))
            .bind(&message_id)
            .bind(pool)
            .bind(address.to_lowercase())
            .bind(domain)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(message_id)
    }

    /// Whether `address` is suppressed in `pool` right now.
    pub async fn is_suppressed(&self, pool: &str, address: &str) -> Result<bool> {
        let found: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM mta_suppressions WHERE pool = $1 AND address = $2 AND expires_at > now()",
        )
        .bind(pool)
        .bind(address.to_lowercase())
        .fetch_optional(&self.pool)
        .await?;
        Ok(found.is_some())
    }

    // ---- delivery ---------------------------------------------------------

    /// Claims up to `limit` due recipients of `pools` for `lease`.
    pub async fn claim(
        &self,
        pools: &[String],
        owner: &str,
        limit: i64,
        lease: Duration,
    ) -> Result<Vec<Claimed>> {
        let rows = sqlx::query_as::<_, Claimed>(
            "UPDATE mta_recipients r
                SET lease_owner = $2, lease_until = now() + make_interval(secs => $4)
               FROM mta_messages m
              WHERE m.id = r.message_id
                AND r.id IN (
                    SELECT id FROM mta_recipients
                     WHERE status = 'queued' AND pool = ANY($1) AND next_attempt_at <= now()
                       AND (lease_until IS NULL OR lease_until < now())
                     ORDER BY next_attempt_at
                     LIMIT $3
                     FOR UPDATE SKIP LOCKED)
          RETURNING r.id, r.message_id, r.pool, r.address, r.domain, r.attempts,
                    extract(epoch FROM now() - m.received_at)::float8 AS age_seconds",
        )
        .bind(pools)
        .bind(owner)
        .bind(limit)
        .bind(lease.as_secs_f64())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    pub async fn message(&self, id: &str) -> Result<Option<StoredMessage>> {
        Ok(sqlx::query_as::<_, StoredMessage>(
            "SELECT id, pool, mail_from, header_from, body FROM mta_messages WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// Gives a claimed recipient back without counting an attempt (warm-up
    /// cap, shaping, a failed message load), due again after `delay`. Only
    /// while `owner` still holds the lease.
    pub async fn release(&self, id: &str, owner: &str, delay: Duration) -> Result<()> {
        sqlx::query(
            "UPDATE mta_recipients SET lease_owner = NULL, lease_until = NULL,
                    next_attempt_at = now() + make_interval(secs => $3)
              WHERE id = $1 AND lease_owner = $2 AND status = 'queued'",
        )
        .bind(id)
        .bind(owner)
        .bind(delay.as_secs_f64())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Extends `owner`'s lease on a recipient before it is sent. `false`:
    /// the lease ran out and another worker may have it; don't send.
    pub async fn renew(&self, id: &str, owner: &str, lease: Duration) -> Result<bool> {
        let renewed = sqlx::query(
            "UPDATE mta_recipients SET lease_until = now() + make_interval(secs => $3)
              WHERE id = $1 AND lease_owner = $2 AND status = 'queued'",
        )
        .bind(id)
        .bind(owner)
        .bind(lease.as_secs_f64())
        .execute(&self.pool)
        .await?;
        Ok(renewed.rows_affected() == 1)
    }

    /// Records an attempt's outcome and its event, only while `owner` still
    /// leases the recipient and it is queued: a worker whose lease ran out
    /// records nothing (`Ok(false)`), so an outcome and its event are never
    /// written twice and a final status is never overwritten.
    pub async fn finish(
        &self,
        claimed: &Claimed,
        owner: &str,
        sender: &str,
        outcome: &Outcome,
    ) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        let (status, event) = match outcome {
            Outcome::Delivered { response } => (
                "delivered",
                Some(events::event(
                    Kind::Delivered,
                    sender,
                    &claimed.address,
                    response,
                )),
            ),
            Outcome::Bounced { response, hard } => {
                let kind = if *hard {
                    Kind::HardBounce
                } else {
                    Kind::SoftBounce
                };
                (
                    "bounced",
                    Some(events::event(kind, sender, &claimed.address, response)),
                )
            }
            Outcome::Expired { response } => (
                "expired",
                Some(events::event(
                    Kind::SoftBounce,
                    sender,
                    &claimed.address,
                    response,
                )),
            ),
            Outcome::Deferred { response, delay } => {
                // `first`: this is the recipient's first deferral (one
                // `deferred` event per recipient, as Cloudflare sends).
                let first: Option<bool> = sqlx::query_scalar(
                    "WITH before AS (
                         SELECT deferred_reported FROM mta_recipients WHERE id = $1 FOR UPDATE)
                     UPDATE mta_recipients SET attempts = attempts + 1, last_response = $3,
                            next_attempt_at = now() + make_interval(secs => $4),
                            lease_owner = NULL, lease_until = NULL, deferred_reported = true
                      WHERE id = $1 AND lease_owner = $2 AND status = 'queued'
                  RETURNING NOT (SELECT deferred_reported FROM before)",
                )
                .bind(&claimed.id)
                .bind(owner)
                .bind(response)
                .bind(delay.as_secs_f64())
                .fetch_optional(&mut *tx)
                .await?;
                let Some(first) = first else {
                    return Ok(false);
                };
                if first {
                    outbox(
                        &mut tx,
                        events::event(Kind::Deferred, sender, &claimed.address, response),
                    )
                    .await?;
                }
                tx.commit().await?;
                return Ok(true);
            }
        };
        let response = match outcome {
            Outcome::Delivered { response }
            | Outcome::Bounced { response, .. }
            | Outcome::Expired { response }
            | Outcome::Deferred { response, .. } => response,
        };
        if !self
            .set_final(&mut tx, &claimed.id, owner, status, response)
            .await?
        {
            return Ok(false);
        }
        if let Some(event) = event {
            outbox(&mut tx, event).await?;
        }
        if let Outcome::Bounced {
            hard: true,
            response,
        } = outcome
        {
            self.suppress(&mut tx, &claimed.pool, &claimed.address, "bounce", response)
                .await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Sets a final status; `false` when `owner` no longer holds the lease.
    async fn set_final(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        id: &str,
        owner: &str,
        status: &str,
        response: &str,
    ) -> Result<bool> {
        let updated = sqlx::query(
            "UPDATE mta_recipients SET status = $3, last_response = $4, attempts = attempts + 1,
                    lease_owner = NULL, lease_until = NULL, finished_at = now()
              WHERE id = $1 AND lease_owner = $2 AND status = 'queued'",
        )
        .bind(id)
        .bind(owner)
        .bind(status)
        .bind(response)
        .execute(&mut **tx)
        .await?;
        Ok(updated.rows_affected() == 1)
    }

    async fn suppress(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        pool: &str,
        address: &str,
        reason: &str,
        detail: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO mta_suppressions (pool, address, reason, detail, expires_at)
                  VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
             ON CONFLICT (pool, address) DO UPDATE
                     SET reason = EXCLUDED.reason, detail = EXCLUDED.detail,
                         created_at = now(), expires_at = EXCLUDED.expires_at",
        )
        .bind(pool)
        .bind(address.to_lowercase())
        .bind(reason)
        .bind(detail)
        .bind(self.suppress_days)
        .execute(&mut **tx)
        .await?;
        Ok(())
    }

    /// Today's UTC date (`YYYY-MM-DD`) and `ip`'s daily counts of the last
    /// [`HISTORY_DAYS`] days and today, oldest first.
    pub async fn ip_history(&self, ip: &str) -> Result<(String, Vec<DaySent>)> {
        // (today, days ago, day, sent); one row of NULLs past today when the
        // IP has no counts.
        type Row = (String, Option<i32>, Option<String>, Option<i32>);
        let rows: Vec<Row> = sqlx::query_as(
            "WITH t AS (SELECT (now() AT TIME ZONE 'utc')::date AS today)
             SELECT to_char(t.today, 'YYYY-MM-DD'), (t.today - u.day)::int4,
                    to_char(u.day, 'YYYY-MM-DD'), u.sent
               FROM t LEFT JOIN mta_ip_usage u
                 ON u.ip = $1 AND u.day >= t.today - $2::int4 AND u.day <= t.today
              ORDER BY u.day",
        )
        .bind(ip)
        .bind(HISTORY_DAYS)
        .fetch_all(&self.pool)
        .await?;
        let today = rows.first().map(|row| row.0.clone()).unwrap_or_default();
        let history = rows
            .into_iter()
            .filter_map(|(_, days_ago, day, sent)| {
                Some(DaySent {
                    days_ago: u32::try_from(days_ago?).ok()?,
                    day: day?,
                    sent: u32::try_from(sent?).unwrap_or(0),
                })
            })
            .collect();
        Ok((today, history))
    }

    /// Reserves one send from `ip` under the `warmup` (the step its history
    /// earned, [`crate::warmup`]). In a `soft` pool a send over today's cap
    /// is reserved too ([`Reservation::OverCap`]); otherwise it is
    /// [`Reservation::Held`]. Logs the first send of a day that starts a
    /// new step, and the send that reaches today's advance threshold.
    pub async fn reserve_ip(&self, ip: &str, warmup: &Warmup, soft: bool) -> Result<Reservation> {
        if warmup.is_off() {
            return Ok(Reservation::Granted);
        }
        let (today, history) = self.ip_history(ip).await?;
        let state = warmup.state(&history);
        let cap = warmup.cap(state.step);
        let limit = match cap {
            Some(cap) if !soft => i32::try_from(cap).unwrap_or(i32::MAX),
            _ => i32::MAX,
        };
        // Today's row as of the history read, so a send at midnight never
        // counts a day against the other day's cap.
        let sent: Option<i32> = sqlx::query_scalar(
            "INSERT INTO mta_ip_usage AS u (ip, day, sent) VALUES ($1, $2::date, 1)
             ON CONFLICT (ip, day) DO UPDATE SET sent = u.sent + 1 WHERE u.sent < $3
             RETURNING sent",
        )
        .bind(ip)
        .bind(&today)
        .bind(limit)
        .fetch_optional(&self.pool)
        .await?;
        let Some(sent) = sent else {
            return Ok(Reservation::Held {
                cap: cap.unwrap_or_default(),
            });
        };
        let sent = u32::try_from(sent).unwrap_or(u32::MAX);
        let step = state.step + 1;
        let steps = warmup.steps();
        if sent == 1 {
            sqlx::query(
                "INSERT INTO mta_ips (ip, first_day) VALUES ($1, $2::date) ON CONFLICT DO NOTHING",
            )
            .bind(ip)
            .bind(&today)
            .execute(&self.pool)
            .await?;
            if state.advanced_today() {
                tracing::info!(
                    %ip, step, steps, cap = ?cap,
                    "warm-up step advanced: yesterday sent the advance share of the previous step's cap"
                );
            }
        }
        if warmup.threshold(state.step) == Some(sent) {
            tracing::info!(
                %ip, step, steps, sent, next_cap = ?warmup.cap(state.step + 1),
                "warm-up: today reached the advance share; the next step starts tomorrow (UTC)"
            );
        }
        Ok(match cap {
            Some(cap) if sent > cap => Reservation::OverCap { cap, sent },
            _ => Reservation::Granted,
        })
    }

    /// Records this node's sending address, EHLO name and pools, at start
    /// (`GET /v1/ips`, for DMARC reports, MAIL-015).
    pub async fn register_node(&self, ip: &str, hostname: &str, pools: &[String]) -> Result<()> {
        sqlx::query(
            "INSERT INTO mta_nodes (ip, hostname, pools, seen_at) VALUES ($1, $2, $3, now())
             ON CONFLICT (ip) DO UPDATE SET hostname = EXCLUDED.hostname, pools = EXCLUDED.pools, seen_at = now()",
        )
        .bind(ip)
        .bind(hostname)
        .bind(pools)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// The mail nodes seen in the last 30 days: address, EHLO name, pools.
    pub async fn nodes(&self) -> Result<Vec<(String, String, Vec<String>)>> {
        Ok(sqlx::query_as(
            "SELECT ip, hostname, pools FROM mta_nodes
              WHERE seen_at > now() - interval '30 days' ORDER BY ip",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    /// Every IP that has sent, with its first day (`YYYY-MM-DD`) when known.
    pub async fn warmup_ips(&self) -> Result<Vec<(String, Option<String>)>> {
        Ok(sqlx::query_as(
            "SELECT ip, to_char(min(first_day), 'YYYY-MM-DD') FROM (
                 SELECT ip, first_day FROM mta_ips
                 UNION ALL SELECT DISTINCT ip, NULL::date FROM mta_ip_usage) ips
              GROUP BY ip ORDER BY ip",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    /// Seconds until the next UTC day (a capped send waits for it).
    pub async fn seconds_to_tomorrow(&self) -> Result<f64> {
        Ok(sqlx::query_scalar(
            "SELECT extract(epoch FROM (date_trunc('day', now() AT TIME ZONE 'utc') + interval '1 day' + interval '5 minutes') - (now() AT TIME ZONE 'utc'))::float8",
        )
        .fetch_one(&self.pool)
        .await?)
    }

    // ---- return path ------------------------------------------------------

    pub async fn recipient(&self, id: &str) -> Result<Option<RecipientInfo>> {
        Ok(sqlx::query_as::<_, RecipientInfo>(
            "SELECT r.id, r.pool, r.address, r.status, m.header_from, r.complained
               FROM mta_recipients r JOIN mta_messages m ON m.id = r.message_id
              WHERE r.id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?)
    }

    /// A bounce that came back after the remote server accepted the
    /// message (a DSN). A recipient already bounced is left alone.
    pub async fn late_bounce(
        &self,
        info: &RecipientInfo,
        hard: bool,
        detail: &str,
    ) -> Result<bool> {
        if info.status == "bounced" || info.status == "expired" {
            return Ok(false);
        }
        let mut tx = self.pool.begin().await?;
        // Only from `delivered` (or `queued`, a copy accepted earlier while a
        // retry is pending): a status that is already final stays, and no
        // second event is written.
        let updated = sqlx::query(
            "UPDATE mta_recipients SET status = 'bounced', last_response = $2,
                    lease_owner = NULL, lease_until = NULL, finished_at = now()
              WHERE id = $1 AND status IN ('queued', 'delivered')",
        )
        .bind(&info.id)
        .bind(detail)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() == 0 {
            return Ok(false);
        }
        let kind = if hard {
            Kind::HardBounce
        } else {
            Kind::SoftBounce
        };
        outbox(
            &mut tx,
            events::event(kind, &info.header_from, &info.address, detail),
        )
        .await?;
        if hard {
            self.suppress(&mut tx, &info.pool, &info.address, "bounce", detail)
                .await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    /// A complaint (ARF). Counted once per recipient.
    pub async fn complaint(&self, info: &RecipientInfo, kind: &str) -> Result<bool> {
        if info.complained {
            return Ok(false);
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE mta_recipients SET complained = true WHERE id = $1")
            .bind(&info.id)
            .execute(&mut *tx)
            .await?;
        outbox(
            &mut tx,
            events::event(Kind::Complained, &info.header_from, &info.address, kind),
        )
        .await?;
        self.suppress(&mut tx, &info.pool, &info.address, "complaint", kind)
            .await?;
        tx.commit().await?;
        Ok(true)
    }

    // ---- domains ----------------------------------------------------------

    pub async fn domain(&self, domain: &str) -> Result<Option<DomainRow>> {
        Ok(sqlx::query_as::<_, DomainRow>(DOMAIN_ONE)
            .bind(domain.to_ascii_lowercase())
            .fetch_optional(&self.pool)
            .await?)
    }

    pub async fn domains(&self) -> Result<Vec<DomainRow>> {
        Ok(sqlx::query_as::<_, DomainRow>(DOMAIN_ALL)
            .fetch_all(&self.pool)
            .await?)
    }

    /// Inserts a domain; `false` when it already existed (left unchanged).
    pub async fn insert_domain(
        &self,
        domain: &str,
        selector: &str,
        sealed_key: &[u8],
        public_key: &str,
        pools: &[String],
    ) -> Result<bool> {
        let inserted = sqlx::query(
            "INSERT INTO mta_domains (domain, selector, algorithm, sealed_key, public_key, pools)
                  VALUES ($1, $2, 'rsa-sha256', $3, $4, $5)
             ON CONFLICT (domain) DO NOTHING",
        )
        .bind(domain.to_ascii_lowercase())
        .bind(selector)
        .bind(sealed_key)
        .bind(public_key)
        .bind(pools)
        .execute(&self.pool)
        .await?;
        Ok(inserted.rows_affected() == 1)
    }

    pub async fn delete_domain(&self, domain: &str) -> Result<bool> {
        let deleted = sqlx::query("DELETE FROM mta_domains WHERE domain = $1")
            .bind(domain.to_ascii_lowercase())
            .execute(&self.pool)
            .await?;
        Ok(deleted.rows_affected() == 1)
    }

    // ---- outbox -----------------------------------------------------------

    pub async fn outbox_pending(&self, limit: i64) -> Result<Vec<(i64, Value)>> {
        Ok(sqlx::query_as::<_, (i64, Value)>(
            "SELECT id, event FROM mta_outbox WHERE published_at IS NULL ORDER BY id LIMIT $1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?)
    }

    pub async fn outbox_published(&self, ids: &[i64]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        sqlx::query("UPDATE mta_outbox SET published_at = now() WHERE id = ANY($1)")
            .bind(ids)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // ---- TLS-RPT ----------------------------------------------------------

    /// Counts one connection's TLS result for the destination domain today.
    pub async fn record_tls(
        &self,
        policy_domain: &str,
        policy_type: &str,
        policy_strings: &[String],
        mx_host: &str,
        failure: Option<&str>,
    ) -> Result<()> {
        let (successes, failures) = match failure {
            None => (1, serde_json::json!({})),
            Some(kind) => (0, serde_json::json!({ kind: 1 })),
        };
        sqlx::query(
            "INSERT INTO mta_tls_results AS t (policy_domain, day, policy_type, policy_strings, mx_host, successes, failures)
                  VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2, $3, $4, $5, $6)
             ON CONFLICT (policy_domain, day, policy_type, mx_host) DO UPDATE
                     SET successes = t.successes + EXCLUDED.successes,
                         policy_strings = EXCLUDED.policy_strings,
                         failures = (SELECT coalesce(jsonb_object_agg(key, total), '{}'::jsonb) FROM (
                             SELECT key, sum(value::int) AS total
                               FROM (SELECT * FROM jsonb_each_text(t.failures)
                                     UNION ALL SELECT * FROM jsonb_each_text(EXCLUDED.failures)) all_failures
                              GROUP BY key) summed)",
        )
        .bind(policy_domain.to_ascii_lowercase())
        .bind(policy_type)
        .bind(policy_strings)
        .bind(mx_host)
        .bind(successes)
        .bind(failures)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Yesterday's TLS results, by policy domain.
    pub async fn tls_results_yesterday(&self) -> Result<Vec<TlsResultRow>> {
        Ok(sqlx::query_as::<_, TlsResultRow>(
            "SELECT policy_domain, policy_type, policy_strings, mx_host, successes, failures
               FROM mta_tls_results
              WHERE day = (now() AT TIME ZONE 'utc')::date - 1
              ORDER BY policy_domain, policy_type, mx_host",
        )
        .fetch_all(&self.pool)
        .await?)
    }

    /// Claims today's run of a daily job; `false` when another node has.
    pub async fn claim_daily(&self, job: &str) -> Result<bool> {
        let claimed = sqlx::query(
            "INSERT INTO mta_jobs AS j (name, last_run) VALUES ($1, (now() AT TIME ZONE 'utc')::date)
             ON CONFLICT (name) DO UPDATE SET last_run = EXCLUDED.last_run
                WHERE j.last_run < EXCLUDED.last_run",
        )
        .bind(job)
        .execute(&self.pool)
        .await?;
        Ok(claimed.rows_affected() == 1)
    }

    // ---- housekeeping and stats -------------------------------------------

    /// Drops the bodies of finished messages, then rows older than 30 days
    /// (late bounces and complaints need the recipient rows that long), the
    /// published outbox after a day, the per-IP counts the warm-up no longer
    /// reads ([`HISTORY_DAYS`]) and expired suppressions.
    pub async fn housekeep(&self) -> Result<()> {
        sqlx::raw_sql(
            "UPDATE mta_messages m SET body = '\\x'::bytea
              WHERE octet_length(m.body) > 0
                AND NOT EXISTS (SELECT 1 FROM mta_recipients r WHERE r.message_id = m.id AND r.status = 'queued');
             DELETE FROM mta_messages m
              WHERE m.received_at < now() - interval '30 days'
                AND NOT EXISTS (SELECT 1 FROM mta_recipients r WHERE r.message_id = m.id AND r.status = 'queued');
             DELETE FROM mta_outbox WHERE published_at < now() - interval '1 day';
             DELETE FROM mta_suppressions WHERE expires_at < now();
             DELETE FROM mta_tls_results WHERE day < (now() AT TIME ZONE 'utc')::date - 14;",
        )
        .execute(&self.pool)
        .await?;
        sqlx::query(
            "DELETE FROM mta_ip_usage WHERE day < (now() AT TIME ZONE 'utc')::date - $1::int4",
        )
        .bind(HISTORY_DAYS)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Recipients by pool and status, plus the unpublished events.
    pub async fn stats(&self) -> Result<Value> {
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT pool, status, count(*) FROM mta_recipients GROUP BY pool, status ORDER BY pool, status",
        )
        .fetch_all(&self.pool)
        .await?;
        let pending: i64 =
            sqlx::query_scalar("SELECT count(*) FROM mta_outbox WHERE published_at IS NULL")
                .fetch_one(&self.pool)
                .await?;
        let mut pools = serde_json::Map::new();
        for (pool, status, count) in rows {
            let entry = pools
                .entry(pool)
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            entry[status] = Value::from(count);
        }
        Ok(serde_json::json!({ "pools": pools, "pendingEvents": pending }))
    }
}

async fn outbox(tx: &mut Transaction<'_, Postgres>, event: Value) -> Result<()> {
    sqlx::query("INSERT INTO mta_outbox (event) VALUES ($1)")
        .bind(event)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// The warm-up against a real Postgres (`WELDSUITE_TEST_DATABASE_URL`, in a
/// throwaway database; skipped without it).
#[cfg(test)]
mod tests {
    use super::*;
    use crate::e2e::Scratch;

    /// Caps 4 then 8; a day needs 2, then 4, to advance.
    fn warmup() -> Warmup {
        Warmup {
            schedule: vec![4, 8],
            advance_percent: 50,
        }
    }

    async fn seed(store: &Store, ip: &str, days_ago: i32, sent: i32) {
        sqlx::query(
            "INSERT INTO mta_ip_usage (ip, day, sent) VALUES ($1, (now() AT TIME ZONE 'utc')::date - $2::int4, $3)",
        )
        .bind(ip)
        .bind(days_ago)
        .bind(sent)
        .execute(store.pool())
        .await
        .expect("seed");
    }

    async fn reserve(store: &Store, ip: &str, times: usize, soft: bool) -> Vec<Reservation> {
        let mut out = Vec::new();
        for _ in 0..times {
            out.push(
                store
                    .reserve_ip(ip, &warmup(), soft)
                    .await
                    .expect("reserve"),
            );
        }
        out
    }

    #[tokio::test]
    async fn reserve_ip_caps_by_the_step_the_history_earned() {
        let Some(scratch) = Scratch::create().await else {
            eprintln!("WELDSUITE_TEST_DATABASE_URL not set: skipped");
            return;
        };
        let store = Store::connect(&scratch.url, 4).expect("store");
        store.migrate().await.expect("migrate");
        let granted = Reservation::Granted;

        // A new IP: the first step, then held.
        let fresh = reserve(&store, "192.0.2.1", 5, false).await;
        assert_eq!(fresh[..4], [granted; 4]);
        assert_eq!(fresh[4], Reservation::Held { cap: 4 });
        let (today, history) = store.ip_history("192.0.2.1").await.expect("history");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].day, today);
        assert_eq!((history[0].days_ago, history[0].sent), (0, 4));

        // A soft pool sends past the cap, counted.
        let soft = reserve(&store, "192.0.2.1", 2, true).await;
        assert_eq!(
            soft,
            [
                Reservation::OverCap { cap: 4, sent: 5 },
                Reservation::OverCap { cap: 4, sent: 6 }
            ]
        );
        // Strict sends stay held.
        assert_eq!(
            reserve(&store, "192.0.2.1", 1, false).await,
            [Reservation::Held { cap: 4 }]
        );

        // Weeks of days under the share (2): still the first step.
        for days_ago in 1..=20 {
            seed(&store, "192.0.2.2", days_ago, 1).await;
        }
        let quiet = reserve(&store, "192.0.2.2", 5, false).await;
        assert_eq!(quiet[4], Reservation::Held { cap: 4 });

        // Yesterday reached the share: the second step today.
        seed(&store, "192.0.2.3", 1, 2).await;
        let second = reserve(&store, "192.0.2.3", 9, false).await;
        assert_eq!(second[..8], [granted; 8]);
        assert_eq!(second[8], Reservation::Held { cap: 8 });

        // Two days at the share around a gap: past the last step, no cap.
        seed(&store, "192.0.2.4", 9, 3).await;
        seed(&store, "192.0.2.4", 2, 4).await;
        assert!(
            reserve(&store, "192.0.2.4", 12, false)
                .await
                .iter()
                .all(|r| *r == granted)
        );

        // Counts older than the history window are not read.
        seed(&store, "192.0.2.5", HISTORY_DAYS + 5, 50).await;
        seed(&store, "192.0.2.5", HISTORY_DAYS + 1, 50).await;
        let (_, old) = store.ip_history("192.0.2.5").await.expect("history");
        assert_eq!(old, Vec::new());
        let cold = reserve(&store, "192.0.2.5", 5, false).await;
        assert_eq!(cold[4], Reservation::Held { cap: 4 });

        // Warm-up off: nothing counted.
        assert_eq!(
            store
                .reserve_ip("192.0.2.6", &Warmup::off(), false)
                .await
                .expect("off"),
            granted
        );

        let ips = store.warmup_ips().await.expect("ips");
        let names: Vec<&str> = ips.iter().map(|(ip, _)| ip.as_str()).collect();
        assert_eq!(
            names,
            [
                "192.0.2.1",
                "192.0.2.2",
                "192.0.2.3",
                "192.0.2.4",
                "192.0.2.5"
            ]
        );
        // The first send today recorded the IP.
        assert_eq!(ips[0].1.as_deref(), Some(today.as_str()));

        store.housekeep().await.expect("housekeep");
        let left: i64 =
            sqlx::query_scalar("SELECT count(*) FROM mta_ip_usage WHERE ip = '192.0.2.5'")
                .fetch_one(store.pool())
                .await
                .expect("count");
        assert_eq!(left, 1, "only today's row is left");

        drop(store);
        scratch.drop_it().await;
    }
}
