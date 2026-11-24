//! Accounting integrity guards (`@weldsuite/books-domain/accounting-guards`):
//! no booking in a closed fiscal period or on or before a lock date, the
//! Dutch KOR, and the tax-facing audit trail (`audit_log`).

use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{audit_log, fiscal_periods, lock_date_exceptions};

use crate::db_values::date_of;
use crate::http::Caller;

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
    Database(DbErr),
}

impl From<DbErr> for GuardError {
    fn from(error: DbErr) -> Self {
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
    let day = date_of(iso)?;
    let closed: Option<String> = fiscal_periods::Entity::find()
        .select_only()
        .column(fiscal_periods::Column::Name)
        .filter(fiscal_periods::Column::EntityId.eq(entity_id))
        .filter(fiscal_periods::Column::Status.eq("closed"))
        .filter(fiscal_periods::Column::StartDate.lte(day))
        .filter(fiscal_periods::Column::EndDate.gte(day))
        .filter(fiscal_periods::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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

/// The entity's lock dates: sales, purchase, tax, period, hard.
type Locks = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// A lock date that covers `iso` (a posting on or before it).
fn locked<'a>(lock: Option<&'a str>, iso: &str) -> Option<&'a str> {
    lock.filter(|d| !d.is_empty() && iso <= *d)
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
    // The lock dates, the WeldBooks extension's values first (`loadEntityLockDates`).
    let locks = crate::accounting_entity::load_entity_lock_dates(db, check.entity_id).await?;
    let Some(locks) = locks else {
        return Ok(());
    };
    let (sales, purchase, tax, period, hard): Locks = (
        locks.sales_lock_date,
        locks.purchase_lock_date,
        locks.tax_lock_date,
        locks.period_lock_date,
        locks.hard_lock_date,
    );
    if let Some(hard) = locked(hard.as_deref(), iso) {
        return Err(GuardError::Locked(LockedPeriodError {
            lock_type: LockType::Hard,
            lock_date: hard.to_owned(),
            date: iso.to_owned(),
        }));
    }
    let mut candidates = vec![(LockType::Period, period.as_deref())];
    if check.kind == PostingLockKind::Sales {
        candidates.push((LockType::Sales, sales.as_deref()));
    }
    if check.kind == PostingLockKind::Purchase {
        candidates.push((LockType::Purchase, purchase.as_deref()));
    }
    if check.affects_tax {
        candidates.push((LockType::Tax, tax.as_deref()));
    }
    let hits: Vec<(LockType, String)> = candidates
        .into_iter()
        .filter_map(|(kind, lock)| locked(lock, iso).map(|date| (kind, date.to_owned())))
        .collect();
    if hits.is_empty() {
        return Ok(());
    }
    let exceptions: Vec<(String, Option<String>)> = lock_date_exceptions::Entity::find()
        .select_only()
        .columns([
            lock_date_exceptions::Column::LockType,
            lock_date_exceptions::Column::UserId,
        ])
        .filter(lock_date_exceptions::Column::EntityId.eq(check.entity_id))
        .filter(lock_date_exceptions::Column::RevokedAt.is_null())
        .filter(lock_date_exceptions::Column::EndsAt.gt(utc_now()))
        .into_tuple()
        .all(&orm(db))
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
    write_audit(
        db,
        input,
        Some(&caller.user_id),
        caller.ip_address().as_deref(),
    )
    .await;
}

/// [`write_accounting_audit`] for a caller without a request (an in-process
/// call from another module): the user and client address it records.
pub async fn write_audit(
    db: &PgPool,
    input: AuditInput<'_>,
    user_id: Option<&str>,
    ip_address: Option<&str>,
) {
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
    let result: Result<_, DbErr> = audit_log::Entity::insert(audit_log::ActiveModel {
        id: Set(generate_id("aud")),
        accounting_entity_id: Set(input.accounting_entity_id.map(str::to_owned)),
        entity_type: Set(input.entity_type.to_owned()),
        entity_id: Set(input.entity_id.to_owned()),
        action: Set(input.action.to_owned()),
        changes: Set(changes),
        user_id: Set(user_id.map(str::to_owned)),
        user_email: Set(None),
        ip_address: Set(ip_address.map(str::to_owned)),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
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
