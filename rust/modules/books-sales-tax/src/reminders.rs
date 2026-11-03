//! Daily tax reminders (books-api `cron/tax-reminders.ts` and
//! `cron/reminder-notifier.ts`), part of `weldsuite cron books-sweep`, for
//! every US accounting entity of a workspace the sweep visits:
//!
//! - sales tax returns due in 7 days, due in 1 day (or today), overdue;
//! - tax calendar deadlines due in 14 days and in 3 days, not marked done;
//! - exemption certificates expiring within 30 days (one notice for all new ones);
//! - a state newly past its economic nexus threshold (checked on Mondays).
//!
//! A reminder goes once per key and threshold: a marker is stored when it is
//! sent ([`ReminderMarkers`]: the cache with a TTL, [`CacheMarkers`]), so the
//! daily run and a missed day never repeat it. Recipients are the workspace's
//! owners and admins; delivery is a `notifications` row per member and a
//! realtime publish ([`InAppNotifier`]).

use std::collections::BTreeMap;
use std::fmt::Write;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::{Map, Value, json};
use weldsuite_books_domain::books_row;
use weldsuite_books_domain::js::{number_text, to_fixed};
use weldsuite_books_domain::tables::ENTITIES;
use weldsuite_db::PgPool;
use weldsuite_ports::{BoxFuture, DynCache, DynRealtimePublisher, RealtimeMessage};

use crate::common::{day_in, text};

/// Platform routes the reminders link to.
pub const SALES_TAX_PATH: &str = "/weldbooks/sales-tax";
pub const CALENDAR_PATH: &str = "/weldbooks/tax-calendar";
pub const CERTIFICATES_PATH: &str = "/weldbooks/sales-tax/certificates/reports";
pub const NEXUS_PATH: &str = "/weldbooks/sales-tax/nexus";

/// The notification category of the reminders.
pub const REMINDER_CATEGORY: &str = "weldbooks";

const DAY_SECONDS: u64 = 24 * 60 * 60;

/// `ReminderNotice`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReminderNotice {
    pub title: String,
    pub body: String,
    /// `info` | `warning` | `error`.
    pub severity: &'static str,
    /// Path in the platform the notification opens.
    pub action_url: &'static str,
    pub entity_type: &'static str,
    pub entity_id: String,
    /// What the reminder is about (no personal data), in the TypeScript key order.
    pub data: Vec<(&'static str, String)>,
}

impl ReminderNotice {
    fn data_json(&self) -> Map<String, Value> {
        self.data
            .iter()
            .map(|(key, value)| ((*key).to_owned(), json!(value)))
            .collect()
    }

    /// The notice as the TypeScript object.
    pub fn to_json(&self) -> Value {
        json!({
            "title": self.title,
            "body": self.body,
            "severity": self.severity,
            "actionUrl": self.action_url,
            "entityType": self.entity_type,
            "entityId": self.entity_id,
            "data": self.data_json(),
        })
    }

    /// `notificationTypeOf(notice)`.
    fn notification_type(&self) -> &'static str {
        match self
            .data
            .iter()
            .find(|(key, _)| *key == "kind")
            .map(|(_, kind)| kind.as_str())
        {
            Some("sales_tax_due") => "sales_tax_due",
            Some("certificate_expiring") => "certificate_expiring",
            Some("nexus_exceeded") => "nexus_exceeded",
            _ => "tax_deadline",
        }
    }
}

/// `ReminderNotifier`: delivers one notice to one member; an error is a
/// failed delivery.
pub trait ReminderNotifier: Send + Sync {
    fn send<'a>(
        &'a self,
        user_id: &'a str,
        notice: &'a ReminderNotice,
    ) -> BoxFuture<'a, Result<(), String>>;
}

/// `ReminderMarkers`: which reminders went out.
pub trait ReminderMarkers: Send + Sync {
    fn has<'a>(&'a self, marker: &'a str) -> BoxFuture<'a, Result<bool, String>>;
    fn set<'a>(&'a self, marker: &'a str, ttl_seconds: u64) -> BoxFuture<'a, Result<(), String>>;
}

/// `kvMarkers(kv, orgId)`: one cache key per reminder and threshold,
/// `books:reminder:<workspaces.id>:<marker>`, kept for the reminder's TTL
/// (at least a minute).
pub struct CacheMarkers {
    cache: Arc<dyn DynCache>,
    workspace_id: String,
}

impl CacheMarkers {
    pub fn new(cache: Arc<dyn DynCache>, workspace_id: impl Into<String>) -> Self {
        Self {
            cache,
            workspace_id: workspace_id.into(),
        }
    }

    fn key(&self, marker: &str) -> String {
        format!("books:reminder:{}:{marker}", self.workspace_id)
    }
}

impl ReminderMarkers for CacheMarkers {
    fn has<'a>(&'a self, marker: &'a str) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            self.cache
                .get_boxed(&self.key(marker))
                .await
                .map(|value| value.is_some())
                .map_err(|error| error.to_string())
        })
    }

    fn set<'a>(&'a self, marker: &'a str, ttl_seconds: u64) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.cache
                .put_boxed(
                    &self.key(marker),
                    "1",
                    Some(Duration::from_secs(ttl_seconds.max(60))),
                )
                .await
                .map_err(|error| error.to_string())
        })
    }
}

/// `memoryMarkers()`: markers in memory, with their TTLs (the conformance
/// harness and tests).
#[derive(Debug, Default)]
pub struct MemoryMarkers {
    pub all: Mutex<BTreeMap<String, u64>>,
}

impl MemoryMarkers {
    pub fn with(markers: BTreeMap<String, u64>) -> Self {
        Self {
            all: Mutex::new(markers),
        }
    }

    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        self.all
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl ReminderMarkers for MemoryMarkers {
    fn has<'a>(&'a self, marker: &'a str) -> BoxFuture<'a, Result<bool, String>> {
        let found = self
            .all
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(marker);
        Box::pin(std::future::ready(Ok(found)))
    }

    fn set<'a>(&'a self, marker: &'a str, ttl_seconds: u64) -> BoxFuture<'a, Result<(), String>> {
        self.all
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(marker.to_owned(), ttl_seconds);
        Box::pin(std::future::ready(Ok(())))
    }
}

/// `createInAppNotifier(db, env, workspaceId)`: a `notifications` row per
/// member, pushed live on the realtime port (when there is one). The
/// realtime workspace is the one the hub knows (the identity provider's
/// organization id, as books-api's `clerkOrgId`).
pub struct InAppNotifier {
    db: PgPool,
    realtime: Option<Arc<dyn DynRealtimePublisher>>,
    realtime_workspace: String,
}

impl InAppNotifier {
    pub fn new(
        db: PgPool,
        realtime: Option<Arc<dyn DynRealtimePublisher>>,
        realtime_workspace: impl Into<String>,
    ) -> Self {
        Self {
            db,
            realtime,
            realtime_workspace: realtime_workspace.into(),
        }
    }
}

/// `value.slice(0, max)` in UTF-16 units.
fn js_slice(value: &str, max: usize) -> String {
    let units: Vec<u16> = value.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

impl ReminderNotifier for InAppNotifier {
    fn send<'a>(
        &'a self,
        user_id: &'a str,
        notice: &'a ReminderNotice,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let id = weldsuite_kit::generate_id("notif");
            let now = weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc());
            let notification_type = notice.notification_type();
            let data = if notice.data.is_empty() {
                None
            } else {
                Some(Value::Object(notice.data_json()))
            };
            sqlx::query(
                "insert into notifications \
                    (id, user_id, title, body, category, notification_type, entity_type, entity_id, \
                     action_url, actor_type, severity, data, delivered_in_app, created_at) \
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'system', $10, $11, true, $12::timestamptz)",
            )
            .bind(&id)
            .bind(user_id)
            .bind(js_slice(&notice.title, 255))
            .bind(&notice.body)
            .bind(REMINDER_CATEGORY)
            .bind(notification_type)
            .bind(js_slice(notice.entity_type, 50))
            .bind(js_slice(&notice.entity_id, 30))
            .bind(notice.action_url)
            .bind(notice.severity)
            .bind(data)
            .bind(&now)
            .execute(&self.db)
            .await
            .map_err(|error| error.to_string())?;
            let Some(realtime) = &self.realtime else {
                return Ok(());
            };
            let message = RealtimeMessage::personal(
                &self.realtime_workspace,
                &format!("notification.{user_id}"),
                "created",
                json!({
                    "id": id,
                    "title": notice.title,
                    "body": notice.body,
                    "category": REMINDER_CATEGORY,
                    "notificationType": notification_type,
                    "actionUrl": notice.action_url,
                    "entityType": notice.entity_type,
                    "entityId": notice.entity_id,
                    "createdAt": now,
                    "isRead": false,
                    "severity": notice.severity,
                    "actorType": "system",
                    "actorId": null,
                }),
                user_id,
            );
            // The row is saved: the member sees it on the next load.
            if let Err(error) = realtime.publish_boxed(&message).await {
                tracing::warn!(%error, "[tax-reminders] realtime publish failed");
            }
            Ok(())
        })
    }
}

/// `TaxReminderResult`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TaxReminderResult {
    pub entities: u64,
    /// Notices that went out (each to every recipient).
    pub sent: u64,
    pub skipped: u64,
    pub failed: u64,
}

impl TaxReminderResult {
    pub fn to_json(self) -> Value {
        json!({
            "entities": self.entities,
            "sent": self.sent,
            "skipped": self.skipped,
            "failed": self.failed,
        })
    }
}

/// `TaxReminderOptions`.
pub struct TaxReminderOptions<'a> {
    pub notifier: &'a dyn ReminderNotifier,
    pub markers: &'a dyn ReminderMarkers,
    pub now: time::OffsetDateTime,
    /// Overrides the owners and admins (tests).
    pub recipients: Option<Vec<String>>,
    /// Run the nexus check regardless of the weekday.
    pub force_nexus: bool,
}

/// Why the run stopped: the database, or the marker store.
#[derive(Debug)]
pub enum ReminderError {
    Database(sqlx::Error),
    Markers(String),
}

impl std::fmt::Display for ReminderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(f, "{error}"),
            Self::Markers(error) => write!(f, "reminder markers: {error}"),
        }
    }
}

impl std::error::Error for ReminderError {}

impl From<sqlx::Error> for ReminderError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

struct Candidate {
    /// `<key>:<threshold>`: the marker that keeps it from being sent twice.
    marker: String,
    ttl_days: u64,
    notice: ReminderNotice,
    /// Candidates of one group go out as a single notice.
    certificates: bool,
}

/// `inDays(days)`.
fn in_days(days: i64) -> String {
    match days {
        0 => "today".to_owned(),
        1 => "tomorrow".to_owned(),
        -1 => "yesterday".to_owned(),
        d if d > 0 => format!("in {d} days"),
        d => format!("{} days ago", -d),
    }
}

fn s<'a>(row: &'a Value, key: &str) -> &'a str {
    text(row, key).unwrap_or("")
}

/// Sales tax returns of the entity's agencies that are due soon or overdue.
async fn sales_tax_candidates(
    db: &PgPool,
    entity: &Value,
    today: &str,
) -> Result<Vec<Candidate>, sqlx::Error> {
    let entity_id = s(entity, "id");
    let mut out = Vec::new();
    let agencies: Vec<Value> = crate::returns::common::load_agencies(db, entity_id)
        .await?
        .into_iter()
        .filter(|a| matches!(text(a, "status"), Some("registered" | "pending")))
        .collect();
    let from = weldsuite_books_domain::dates::add_months(today, -6).unwrap_or_default();
    for agency in &agencies {
        let agency_id = s(agency, "id");
        let returns = crate::returns::common::load_agency_returns(db, entity_id, agency_id).await?;
        // Periods that ended in the last six months; older ones are left to the overdue list of the UI.
        let periods =
            crate::returns::periods::build_period_rows(agency, &returns, &from, today, today);
        for p in periods.iter().filter(|p| p.unfiled) {
            let d = p.days_until_due;
            let threshold = if d > 1 && d <= 7 {
                "7d"
            } else if (0..=1).contains(&d) {
                "1d"
            } else if (-90..0).contains(&d) {
                "overdue"
            } else {
                continue;
            };
            let status = p.return_status().map_or_else(
                || "The return has not been started.".to_owned(),
                |status| format!("The return is {status}."),
            );
            let name = s(agency, "name");
            out.push(Candidate {
                marker: format!("sales_tax:{agency_id}:{}:{threshold}", p.period.period_end),
                ttl_days: 150,
                certificates: false,
                notice: ReminderNotice {
                    title: if threshold == "overdue" {
                        format!("Sales tax return overdue: {name}")
                    } else {
                        format!("Sales tax return due {}: {name}", in_days(d))
                    },
                    body: format!(
                        "The {} return for {} to {} is due {} ({}). {status}",
                        s(agency, "stateCode"),
                        p.period.period_start,
                        p.period.period_end,
                        p.period.due_date,
                        in_days(d)
                    ),
                    severity: if threshold == "overdue" {
                        "error"
                    } else {
                        "warning"
                    },
                    action_url: SALES_TAX_PATH,
                    entity_type: "sales_tax_agency",
                    entity_id: agency_id.to_owned(),
                    data: vec![
                        ("kind", "sales_tax_due".to_owned()),
                        ("agencyId", agency_id.to_owned()),
                        ("periodEnd", p.period.period_end.clone()),
                        ("dueDate", p.period.due_date.clone()),
                        ("threshold", threshold.to_owned()),
                    ],
                },
            });
        }
    }
    Ok(out)
}

/// Income tax, 1099 and other calendar deadlines (the sales tax ones are covered above).
async fn calendar_candidates(
    db: &PgPool,
    entity: &Value,
    today: &str,
) -> Result<Vec<Candidate>, sqlx::Error> {
    let year: i64 = today.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(0);
    let years = if today.get(5..7) == Some("12") {
        vec![year, year + 1]
    } else {
        vec![year]
    };
    let mut out = Vec::new();
    for y in years {
        let calendar = crate::calendar::entity_calendar(db, entity, y, today).await?;
        for item in calendar["items"].as_array().into_iter().flatten() {
            let flag = |key: &str| item[key].as_bool().unwrap_or(false);
            if flag("completed") || flag("informational") || text(item, "kind") == Some("sales_tax")
            {
                continue;
            }
            let Some(d) = item["daysUntilDue"].as_i64() else {
                continue;
            };
            let threshold = if d > 3 && d <= 14 {
                "14d"
            } else if (0..=3).contains(&d) {
                "3d"
            } else {
                continue;
            };
            let note = text(item, "note").filter(|n| !n.is_empty());
            out.push(Candidate {
                marker: format!("calendar:{}:{threshold}", s(item, "key")),
                ttl_days: 60,
                certificates: false,
                notice: ReminderNotice {
                    title: format!("{} is due {}", s(item, "title"), in_days(d)),
                    body: format!(
                        "Due {}{}",
                        s(item, "dueDate"),
                        note.map_or_else(String::new, |n| format!(". {n}"))
                    ),
                    severity: if threshold == "3d" { "warning" } else { "info" },
                    action_url: CALENDAR_PATH,
                    entity_type: "tax_deadline",
                    entity_id: s(entity, "id").to_owned(),
                    data: vec![
                        ("kind", "tax_deadline".to_owned()),
                        ("deadlineKey", s(item, "key").to_owned()),
                        ("dueDate", s(item, "dueDate").to_owned()),
                        ("threshold", threshold.to_owned()),
                    ],
                },
            });
        }
    }
    Ok(out)
}

async fn certificate_candidates(
    db: &PgPool,
    entity: &Value,
    today: &str,
) -> Result<Vec<Candidate>, sqlx::Error> {
    let report = crate::reports::expiring_certificates(db, entity, 30, today).await?;
    Ok(report["certificates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| !c["expired"].as_bool().unwrap_or(false))
        .map(|c| {
            let id = s(c, "certificateId");
            let expires_on = s(c, "expiresOn");
            let number = text(c, "certificateNumber")
                .filter(|n| !n.is_empty())
                .map_or_else(String::new, |n| format!(" ({n})"));
            Candidate {
                marker: format!("certificate:{id}:{expires_on}:30d"),
                ttl_days: 60,
                certificates: true,
                notice: ReminderNotice {
                    title: "Exemption certificate expiring".to_owned(),
                    body: format!(
                        "{}{number} expires {expires_on} ({}).",
                        text(c, "customerName").unwrap_or("A customer"),
                        in_days(c["daysLeft"].as_i64().unwrap_or(0))
                    ),
                    severity: "warning",
                    action_url: CERTIFICATES_PATH,
                    entity_type: "exemption_certificate",
                    entity_id: id.to_owned(),
                    data: vec![
                        ("kind", "certificate_expiring".to_owned()),
                        ("certificateId", id.to_owned()),
                        ("expiresOn", expires_on.to_owned()),
                    ],
                },
            }
        })
        .collect())
}

async fn nexus_candidates(
    db: &PgPool,
    entity: &Value,
    today: &str,
) -> Result<Vec<Candidate>, sqlx::Error> {
    let overview = crate::nexus::nexus_overview(db, s(entity, "id"), today).await?;
    let as_of = s(&overview, "asOf");
    Ok(overview["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| text(r, "alert") == Some("register"))
        .map(|r| {
            let state_code = s(r, "stateCode");
            let state_name = s(r, "stateName");
            let exceeded_on = text(r, "exceededOn");
            let collect_from = text(r, "collectFrom").filter(|c| !c.is_empty());
            let sales = r["salesTotal"].as_f64().unwrap_or(0.0);
            let percent = r["percentOfThreshold"].as_f64().unwrap_or(0.0);
            Candidate {
                marker: format!("nexus:{state_code}:{}:exceeded", exceeded_on.unwrap_or(as_of)),
                ttl_days: 400,
                certificates: false,
                notice: ReminderNotice {
                    title: format!("Economic nexus reached in {state_name}"),
                    body: format!(
                        "Sales into {state_name} are {} ({}% of the threshold){}{}. Register to stay compliant.",
                        to_fixed(sales, 2),
                        number_text(percent),
                        exceeded_on
                            .filter(|e| !e.is_empty())
                            .map_or_else(String::new, |e| format!(
                                "; the threshold was reached on {e}"
                            )),
                        collect_from.map_or_else(String::new, |from| format!(
                            ". Collect sales tax from {from}{}",
                            if r["collectFromVerified"].as_bool().unwrap_or(false) {
                                ""
                            } else {
                                " (check with the state)"
                            }
                        )),
                    ),
                    severity: "error",
                    action_url: NEXUS_PATH,
                    entity_type: "nexus",
                    entity_id: state_code.to_owned(),
                    data: vec![
                        ("kind", "nexus_exceeded".to_owned()),
                        ("stateCode", state_code.to_owned()),
                    ],
                },
            }
        })
        .collect())
}

/// `reminderRecipients(db)`: the active owners and admins.
pub async fn reminder_recipients(db: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<String> = sqlx::query_scalar(
        "select user_id from workspace_members \
         where role in ('OWNER', 'ADMIN') and status = 'ACTIVE' and deleted_at is null",
    )
    .fetch_all(db)
    .await?;
    let mut out: Vec<String> = Vec::new();
    for user in rows {
        if !out.contains(&user) {
            out.push(user);
        }
    }
    Ok(out)
}

/// `runTaxReminders(db, options)`: the day's reminders of every US entity
/// in the tenant.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors tax-reminders.ts's runTaxReminders()"
)]
pub async fn run_tax_reminders(
    db: &PgPool,
    options: &TaxReminderOptions<'_>,
) -> Result<TaxReminderResult, ReminderError> {
    let mut result = TaxReminderResult::default();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(entities),
        " from entities t where t.jurisdiction_code = 'US' and t.deleted_at is null"
    ))
    .fetch_all(db)
    .await?;
    let active: Vec<Value> = ENTITIES
        .js_rows(rows)
        .into_iter()
        .filter(|e| e["isActive"] != Value::Bool(false))
        .collect();
    if active.is_empty() {
        return Ok(result);
    }
    let recipients = match &options.recipients {
        Some(recipients) => recipients.clone(),
        None => reminder_recipients(db).await?,
    };
    if recipients.is_empty() {
        return Ok(result);
    }
    let monday = options.now.to_offset(time::UtcOffset::UTC).weekday() == time::Weekday::Monday;
    let now = jiff::Timestamp::from_nanosecond(options.now.unix_timestamp_nanos())
        .unwrap_or_else(|_| jiff::Timestamp::now());

    for entity in &active {
        result.entities += 1;
        let today = day_in(now, text(entity, "timezone"));
        let entity_id = s(entity, "id");
        let mut candidates: Vec<Candidate> = Vec::new();
        let mut attempt = |label: &str, run: Result<Vec<Candidate>, sqlx::Error>| match run {
            Ok(found) => candidates.extend(found),
            Err(error) => {
                result.failed += 1;
                tracing::error!(entity = entity_id, %error, "[tax-reminders] {label} failed");
            }
        };
        attempt("sales tax", sales_tax_candidates(db, entity, &today).await);
        attempt("calendar", calendar_candidates(db, entity, &today).await);
        attempt(
            "certificates",
            certificate_candidates(db, entity, &today).await,
        );
        if options.force_nexus || monday {
            attempt("nexus", nexus_candidates(db, entity, &today).await);
        }

        // Candidates whose reminder has not been sent yet.
        let mut fresh: Vec<Candidate> = Vec::new();
        for candidate in candidates {
            if options
                .markers
                .has(&candidate.marker)
                .await
                .map_err(ReminderError::Markers)?
            {
                result.skipped += 1;
            } else {
                fresh.push(candidate);
            }
        }

        let (certificates, others): (Vec<Candidate>, Vec<Candidate>) =
            fresh.into_iter().partition(|c| c.certificates);
        let mut notices: Vec<(ReminderNotice, Vec<Candidate>)> = others
            .into_iter()
            .map(|c| (c.notice.clone(), vec![c]))
            .collect();
        if certificates.len() == 1 {
            notices.push((certificates[0].notice.clone(), certificates));
        } else if certificates.len() > 1 {
            let count = certificates.len();
            let mut body = certificates
                .iter()
                .take(5)
                .map(|c| c.notice.body.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            if count > 5 {
                let _ = write!(body, " And {} more.", count - 5);
            }
            notices.push((
                ReminderNotice {
                    title: format!("{count} exemption certificates expire within 30 days"),
                    body,
                    severity: "warning",
                    action_url: CERTIFICATES_PATH,
                    entity_type: "exemption_certificate",
                    entity_id: entity_id.to_owned(),
                    data: vec![
                        ("kind", "certificate_expiring".to_owned()),
                        ("count", count.to_string()),
                    ],
                },
                certificates,
            ));
        }

        for (notice, covered) in notices {
            let mut delivered = 0;
            for user_id in &recipients {
                match options.notifier.send(user_id, &notice).await {
                    Ok(()) => delivered += 1,
                    Err(error) => {
                        result.failed += 1;
                        tracing::error!(user = %user_id, %error, "[tax-reminders] could not notify");
                    }
                }
            }
            // Marked once at least one member was told; a total failure is retried tomorrow.
            if delivered > 0 {
                result.sent += 1;
                for c in &covered {
                    options
                        .markers
                        .set(&c.marker, c.ttl_days * DAY_SECONDS)
                        .await
                        .map_err(ReminderError::Markers)?;
                }
            }
        }
    }
    Ok(result)
}
