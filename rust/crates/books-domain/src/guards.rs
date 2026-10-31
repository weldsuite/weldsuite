//! Accounting integrity guards (`@weldsuite/books-domain/accounting-guards`):
//! no booking in a closed fiscal period or on or before a lock date, the
//! Dutch KOR, and the tax-facing audit trail (`audit_log`).

use serde_json::{Map, Value};
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use crate::http::{Caller, now};

/// A booking dated inside a closed fiscal period (`ClosedPeriodError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedPeriodError {
    pub period_name: String,
    pub date: String,
}

impl std::fmt::Display for ClosedPeriodError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Fiscal period '{}' is closed — bookings dated {} are not allowed. Reopen the period or use a date in an open period.",
            self.period_name, self.date
        )
    }
}

/// Which lock dates apply to a posting besides the period and hard locks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostingLockKind {
    Sales,
    Purchase,
    General,
}

/// A lock date's kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockType {
    Sales,
    Purchase,
    Tax,
    Period,
    Hard,
}

impl LockType {
    /// The `lock_date_exceptions.lock_type` value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sales => "sales",
            Self::Purchase => "purchase",
            Self::Tax => "tax",
            Self::Period => "period",
            Self::Hard => "hard",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Sales => "Sales",
            Self::Purchase => "Purchases",
            Self::Tax => "Tax",
            Self::Period => "The books",
            Self::Hard => "The books (hard lock)",
        }
    }
}

/// A booking on or before a lock date (`LockedPeriodError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockedPeriodError {
    pub lock_type: LockType,
    pub lock_date: String,
    pub date: String,
}

impl std::fmt::Display for LockedPeriodError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let remedy = if self.lock_type == LockType::Hard {
            "The hard lock cannot be lifted; use a later date."
        } else {
            "Use a later date or ask an admin for a lock exception."
        };
        write!(
            f,
            "{} are locked up to and including {} — a booking dated {} is not allowed. {remedy}",
            self.lock_type.label(),
            self.lock_date,
            self.date
        )
    }
}

/// Why a posting is refused by the guards, or the statement that failed.
#[derive(Debug)]
pub enum GuardError {
    Closed(ClosedPeriodError),
    Locked(LockedPeriodError),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for GuardError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed(error) => error.fmt(f),
            Self::Locked(error) => error.fmt(f),
            Self::Database(error) => error.fmt(f),
        }
    }
}

/// `date.slice(0, 10)` of a date string or `toISOString()`.
pub fn iso_date(date: &str) -> &str {
    date.get(..10).unwrap_or(date)
}

/// `assertPeriodOpen(db, entityId, date)`: refuse a booking dated inside a
/// closed fiscal period. A date with no period at all is allowed.
pub async fn assert_period_open(
    db: &PgPool,
    entity_id: &str,
    date: &str,
) -> Result<(), GuardError> {
    let iso = iso_date(date);
    let closed: Option<String> = sqlx::query_scalar(
        "select name from fiscal_periods where entity_id = $1 and status = 'closed' \
         and start_date <= $2::date and end_date >= $2::date and deleted_at is null limit 1",
    )
    .bind(entity_id)
    .bind(iso)
    .fetch_optional(db)
    .await?;
    match closed {
        Some(period_name) => Err(GuardError::Closed(ClosedPeriodError {
            period_name,
            date: iso.to_owned(),
        })),
        None => Ok(()),
    }
}

/// What [`assert_posting_allowed`] checks.
#[derive(Debug, Clone, Copy)]
pub struct PostingCheck<'a> {
    pub entity_id: &'a str,
    /// A date (`YYYY-MM-DD`) or an ISO timestamp.
    pub date: &'a str,
    pub kind: PostingLockKind,
    pub affects_tax: bool,
    pub user_id: Option<&'a str>,
}

/// `assertPostingAllowed(db, args)`: refuse a posting inside a closed period
/// or on or before one of the entity's lock dates (hard: always; period:
/// everything; sales/purchase: postings of that kind; tax: postings that
/// carry tax). Every lock but the hard one yields to an active, unrevoked
/// exception for the user (or for everyone).
pub async fn assert_posting_allowed(
    db: &PgPool,
    check: PostingCheck<'_>,
) -> Result<(), GuardError> {
    assert_period_open(db, check.entity_id, check.date).await?;
    let iso = iso_date(check.date);
    type Locks = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let locks: Option<Locks> = sqlx::query_as(
        "select sales_lock_date::text, purchase_lock_date::text, tax_lock_date::text, \
         period_lock_date::text, hard_lock_date::text from entities where id = $1 limit 1",
    )
    .bind(check.entity_id)
    .fetch_optional(db)
    .await?;
    let Some((sales, purchase, tax, period, hard)) = locks else {
        return Ok(());
    };
    fn locked<'a>(lock: &'a Option<String>, iso: &str) -> Option<&'a str> {
        lock.as_deref().filter(|d| !d.is_empty() && iso <= *d)
    }
    if let Some(hard) = locked(&hard, iso) {
        return Err(GuardError::Locked(LockedPeriodError {
            lock_type: LockType::Hard,
            lock_date: hard.to_owned(),
            date: iso.to_owned(),
        }));
    }
    let mut candidates = vec![(LockType::Period, &period)];
    if check.kind == PostingLockKind::Sales {
        candidates.push((LockType::Sales, &sales));
    }
    if check.kind == PostingLockKind::Purchase {
        candidates.push((LockType::Purchase, &purchase));
    }
    if check.affects_tax {
        candidates.push((LockType::Tax, &tax));
    }
    let hits: Vec<(LockType, String)> = candidates
        .into_iter()
        .filter_map(|(kind, lock)| locked(lock, iso).map(|date| (kind, date.to_owned())))
        .collect();
    if hits.is_empty() {
        return Ok(());
    }
    let exceptions: Vec<(String, Option<String>)> = sqlx::query_as(
        "select lock_type, user_id from lock_date_exceptions \
         where entity_id = $1 and revoked_at is null and ends_at > $2::timestamp",
    )
    .bind(check.entity_id)
    .bind(now())
    .fetch_all(db)
    .await?;
    for (kind, lock_date) in hits {
        let excepted = exceptions.iter().any(|(lock_type, user)| {
            lock_type == kind.as_str()
                && match user {
                    None => true,
                    Some(user) => check.user_id.is_some_and(|id| id == user),
                }
        });
        if !excepted {
            return Err(GuardError::Locked(LockedPeriodError {
                lock_type: kind,
                lock_date,
                date: iso.to_owned(),
            }));
        }
    }
    Ok(())
}

/// `isKorActive(entity, atDate)`: the Dutch small-business scheme
/// (`jurisdictionSettings.kor`) is on at `at` (an ISO timestamp).
pub fn is_kor_active(jurisdiction_code: &str, settings: Option<&Value>, at_millis: i64) -> bool {
    if jurisdiction_code != "NL" {
        return false;
    }
    let Some(kor) = settings.and_then(|s| s.get("kor")).filter(|k| !k.is_null()) else {
        return false;
    };
    if !crate::js::truthy(kor.get("enabled")) {
        return false;
    }
    if let Some(start) = kor.get("startDate").filter(|s| crate::js::truthy(Some(s)))
        && let Some(start) = start.as_str().and_then(crate::js::js_date_millis)
        && start > at_millis
    {
        return false;
    }
    true
}

/// One row of the accounting audit trail (`AccountingAuditInput`).
#[derive(Debug, Clone, Default)]
pub struct AuditInput<'a> {
    pub accounting_entity_id: Option<&'a str>,
    pub entity_type: &'a str,
    pub entity_id: &'a str,
    pub action: &'a str,
    /// `{ field: { old, new } }`, in the order TypeScript built it.
    pub changes: Option<Map<String, Value>>,
}

/// Plain-text identifiers that may be in a request body but never belong in
/// the audit trail.
const PLAIN_SECRET_KEYS: [&str; 4] = ["tin", "ssn", "accountNumber", "achAccountNumber"];

/// `writeAccountingAudit(c, db, input)`: append a row to `audit_log`.
/// Failures are logged, never returned (the mutation stands).
pub async fn write_accounting_audit(caller: &Caller, db: &PgPool, input: AuditInput<'_>) {
    let changes = input.changes.map(|changes| {
        let scrubbed = weldsuite_events::scrub_sensitive_keys(Value::Object(changes));
        match scrubbed {
            Value::Object(fields) => Value::Object(
                fields
                    .into_iter()
                    .filter(|(key, _)| !PLAIN_SECRET_KEYS.contains(&key.as_str()))
                    .collect(),
            ),
            other => other,
        }
    });
    let result = sqlx::query(
        "insert into audit_log (id, accounting_entity_id, entity_type, entity_id, action, changes, user_id, user_email, ip_address) \
         values ($1, $2, $3, $4, $5, $6, $7, null, $8)",
    )
    .bind(generate_id("aud"))
    .bind(input.accounting_entity_id)
    .bind(input.entity_type)
    .bind(input.entity_id)
    .bind(input.action)
    .bind(changes)
    .bind(&caller.user_id)
    .bind(caller.ip_address())
    .execute(db)
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "[accounting-audit] failed to write audit row");
    }
}

/// `{ old, new }`, an audit change.
pub fn change(old: Value, new: Value) -> Value {
    let mut entry = Map::new();
    entry.insert("old".to_owned(), old);
    entry.insert("new".to_owned(), new);
    Value::Object(entry)
}
