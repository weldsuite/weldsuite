//! Where a DMARC report goes in the databases (ADR MAIL-015).
//!
//! - **Routing**: master `mail_domain_registry` says which workspaces proved
//!   a domain; a row goes to every workspace that verified its header From
//!   domain or a parent, under that workspace's most specific such domain.
//! - **Tenant**: one `mail_dmarc_reports` row per domain, reporter and
//!   report id (a resent report changes nothing), its rows in
//!   `mail_dmarc_records`, and the domain's reports older than
//!   [`RETENTION_DAYS`] pruned on the way.
//! - **Master**: `mail_dmarc_report_log` once per report, and, only the
//!   first time, the operator's rollup of WeldSuite's own addresses
//!   (`mail_dmarc_pool_daily`).

use std::collections::{BTreeMap, BTreeSet};

use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use weldsuite_db::{OrmConn, PgPool, orm, orm_error};
use weldsuite_kit::generate_id;
use weldsuite_mail_dmarc::report::{Report, Row};
use weldsuite_mail_dmarc::sources;
use weldsuite_schema::master::{
    mail_dmarc_pool_daily, mail_dmarc_report_log, mail_domain_registry,
};
use weldsuite_schema::tenant::{mail_dmarc_records, mail_dmarc_reports};

/// Parsed rows a workspace keeps.
pub const RETENTION_DAYS: i64 = 180;
/// The report log and the operator's rollup.
pub(super) const LOG_RETENTION_DAYS: i64 = 60;
pub(super) const ROLLUP_RETENTION_DAYS: i64 = 400;

/// A row of a report, with what WeldSuite knows about its source.
#[derive(Debug, Clone)]
pub struct Sourced<'r> {
    pub row: &'r Row,
    /// WeldSuite's pool, when the source is one of the MTA's addresses.
    pub pool: Option<String>,
    /// The source's reverse DNS name.
    pub name: Option<String>,
}

/// A verified domain of a workspace, and the rows that go to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub workspace_id: String,
    pub mail_domain_id: String,
    pub domain: String,
}

/// The domains a header From domain may be filed under: itself and its
/// parents of two labels or more.
fn candidates(domain: &str) -> Vec<String> {
    let labels: Vec<&str> = domain.split('.').filter(|l| !l.is_empty()).collect();
    (0..labels.len().saturating_sub(1))
        .map(|from| labels[from..].join("."))
        .collect()
}

/// Which verified domains the rows go to: for each workspace, a row's most
/// specific verified domain covering its header From domain. Returns the
/// targets with the indexes of their rows.
///
/// # Errors
///
/// The master database's.
pub(super) async fn route(
    master: &PgPool,
    rows: &[Sourced<'_>],
) -> Result<Vec<(Target, Vec<usize>)>, DbErr> {
    let froms: BTreeSet<String> = rows.iter().map(|s| s.row.header_from.clone()).collect();
    let wanted: BTreeSet<String> = froms.iter().flat_map(|d| candidates(d)).collect();
    if wanted.is_empty() {
        return Ok(Vec::new());
    }
    let registered: Vec<(String, String, String)> = mail_domain_registry::Entity::find()
        .select_only()
        .columns([
            mail_domain_registry::Column::Domain,
            mail_domain_registry::Column::WorkspaceId,
            mail_domain_registry::Column::MailDomainId,
        ])
        .filter(mail_domain_registry::Column::Domain.is_in(wanted))
        .into_tuple()
        .all(&orm(master))
        .await?;
    let mut targets: BTreeMap<(String, String), (Target, Vec<usize>)> = BTreeMap::new();
    for (index, sourced) in rows.iter().enumerate() {
        let from = &sourced.row.header_from;
        // Per workspace, the longest registered domain covering this row.
        let mut best: BTreeMap<&str, &(String, String, String)> = BTreeMap::new();
        for entry in registered
            .iter()
            .filter(|(d, _, _)| sources::within(from, d))
        {
            let keep = best
                .get(entry.1.as_str())
                .is_none_or(|current| entry.0.len() > current.0.len());
            if keep {
                best.insert(entry.1.as_str(), entry);
            }
        }
        for (domain, workspace_id, mail_domain_id) in best.into_values() {
            targets
                .entry((workspace_id.clone(), mail_domain_id.clone()))
                .or_insert_with(|| {
                    (
                        Target {
                            workspace_id: workspace_id.clone(),
                            mail_domain_id: mail_domain_id.clone(),
                            domain: domain.clone(),
                        },
                        Vec::new(),
                    )
                })
                .1
                .push(index);
        }
    }
    Ok(targets.into_values().collect())
}

fn at(seconds: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(seconds).unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// Text cut to a `varchar(255)` column: a report may hold longer values
/// (the parser keeps 1024 characters), and a refused insert would retry the
/// message instead of filing it.
fn column(text: &str) -> String {
    text.chars().take(255).collect()
}

fn count(value: u64) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

fn dkim_json(row: &Row) -> Value {
    serde_json::to_value(&row.dkim_results).unwrap_or(Value::Null)
}

/// Writes the report's rows for one target, in one transaction. `false`
/// when the workspace has the report already (a resend or a redelivery).
///
/// # Errors
///
/// The tenant database's.
pub(super) async fn write_tenant(
    db: &PgPool,
    target: &Target,
    report: &Report,
    rows: &[&Sourced<'_>],
    authenticated: bool,
) -> Result<bool, DbErr> {
    let now = OffsetDateTime::now_utc();
    let report_row_id = generate_id("dmrpt");
    let messages: u64 = rows.iter().map(|s| u64::from(s.row.count)).sum();
    let passed: u64 = rows
        .iter()
        .filter(|s| s.row.passed())
        .map(|s| u64::from(s.row.count))
        .sum();
    let period_end = at(report.end);
    let mut tx = sqlx::Acquire::begin(db).await.map_err(orm_error)?;
    let conn = OrmConn::new(&mut tx);
    let inserted = mail_dmarc_reports::Entity::insert(mail_dmarc_reports::ActiveModel {
        id: Set(report_row_id.clone()),
        mail_domain_id: Set(target.mail_domain_id.clone()),
        domain_name: Set(column(&target.domain)),
        reporter_org: Set(column(&report.org_name)),
        reporter_email: Set(column(&report.email)),
        reporter_domain: Set(column(&report.reporter_domain())),
        report_id: Set(column(&report.report_id)),
        period_start: Set(at(report.begin)),
        period_end: Set(period_end),
        policy_domain: Set(column(&report.policy.domain)),
        policy: Set(serde_json::to_value(&report.policy).ok()),
        authenticated: Set(authenticated),
        messages: Set(count(messages)),
        passed: Set(count(passed)),
        received_at: Set(now),
    })
    .on_conflict(
        OnConflict::columns([
            mail_dmarc_reports::Column::MailDomainId,
            mail_dmarc_reports::Column::ReporterDomain,
            mail_dmarc_reports::Column::ReportId,
        ])
        .do_nothing()
        .to_owned(),
    )
    .exec_without_returning(&conn)
    .await?;
    if inserted == 0 {
        tx.rollback().await.map_err(orm_error)?;
        return Ok(false);
    }
    for chunk in rows.chunks(500) {
        let models = chunk.iter().map(|sourced| {
            let row = sourced.row;
            mail_dmarc_records::ActiveModel {
                id: Set(generate_id("dmrec")),
                report_id: Set(report_row_id.clone()),
                mail_domain_id: Set(target.mail_domain_id.clone()),
                period_end: Set(period_end),
                source_ip: Set(row.source_ip.chars().take(45).collect()),
                source_name: Set(sourced.name.clone()),
                weldsuite_pool: Set(sourced.pool.clone()),
                source_key: Set(column(&sources::key(
                    sourced.pool.as_deref(),
                    sourced.name.as_deref(),
                    &row.source_ip,
                ))),
                count: Set(count(u64::from(row.count))),
                disposition: Set(row.disposition.chars().take(20).collect()),
                dkim_aligned: Set(row.dkim_aligned()),
                spf_aligned: Set(row.spf_aligned()),
                header_from: Set(row.header_from.chars().take(255).collect()),
                envelope_from: Set(row
                    .envelope_from
                    .as_ref()
                    .map(|from| from.chars().take(255).collect())),
                dkim_results: Set(Some(dkim_json(row))),
                spf_results: Set(serde_json::to_value(&row.spf_results).ok()),
                reasons: Set(serde_json::to_value(&row.reasons).ok()),
            }
        });
        mail_dmarc_records::Entity::insert_many(models)
            .exec_without_returning(&conn)
            .await?;
    }
    // Retention: the domain's reports past the window go (their rows
    // cascade), now that the workspace is open anyway.
    mail_dmarc_reports::Entity::delete_many()
        .filter(mail_dmarc_reports::Column::MailDomainId.eq(&target.mail_domain_id))
        .filter(mail_dmarc_reports::Column::PeriodEnd.lt(now - Duration::days(RETENTION_DAYS)))
        .exec(&conn)
        .await?;
    tx.commit().await.map_err(orm_error)?;
    Ok(true)
}

/// One rollup row: a day, pool, address, reporter and From domain.
type RollupKey = (time::Date, String, String, String, String);

#[derive(Debug, Default, Clone, Copy)]
struct RollupCounts {
    messages: u64,
    dkim: u64,
    spf: u64,
    pass: u64,
    quarantine: u64,
    reject: u64,
}

/// WeldSuite's own rows of a report, summed per rollup row.
fn rollup(report: &Report, rows: &[Sourced<'_>]) -> BTreeMap<RollupKey, RollupCounts> {
    let day = at(report.end).date();
    let reporter = column(&report.reporter_domain());
    let mut rollup: BTreeMap<RollupKey, RollupCounts> = BTreeMap::new();
    for sourced in rows {
        let Some(pool) = &sourced.pool else { continue };
        let row = sourced.row;
        let key = (
            day,
            pool.clone(),
            row.source_ip.clone(),
            reporter.clone(),
            row.header_from.clone(),
        );
        let counts = rollup.entry(key).or_default();
        let n = u64::from(row.count);
        counts.messages += n;
        counts.dkim += if row.dkim_aligned() { n } else { 0 };
        counts.spf += if row.spf_aligned() { n } else { 0 };
        counts.pass += if row.passed() { n } else { 0 };
        counts.quarantine += if row.disposition == "quarantine" {
            n
        } else {
            0
        };
        counts.reject += if row.disposition == "reject" { n } else { 0 };
    }
    rollup
}

/// Logs the report once; the first time, adds WeldSuite's own rows to the
/// operator's rollup in the same transaction. `false` for a report logged
/// before.
///
/// # Errors
///
/// The master database's.
pub(super) async fn log_and_roll_up(
    master: &PgPool,
    report: &Report,
    outcome: &str,
    rows: &[Sourced<'_>],
) -> Result<bool, DbErr> {
    let now = OffsetDateTime::now_utc();
    let mut tx = sqlx::Acquire::begin(master).await.map_err(orm_error)?;
    let conn = OrmConn::new(&mut tx);
    let logged = mail_dmarc_report_log::Entity::insert(mail_dmarc_report_log::ActiveModel {
        id: Set(generate_id("dmlog")),
        reporter_domain: Set(column(&report.reporter_domain())),
        report_id: Set(column(&report.report_id)),
        policy_domain: Set(column(&report.policy.domain)),
        messages: Set(count(report.messages())),
        outcome: Set(outcome.to_owned()),
        received_at: Set(now),
    })
    .on_conflict(
        OnConflict::columns([
            mail_dmarc_report_log::Column::ReporterDomain,
            mail_dmarc_report_log::Column::ReportId,
            mail_dmarc_report_log::Column::PolicyDomain,
        ])
        .do_nothing()
        .to_owned(),
    )
    .exec_without_returning(&conn)
    .await?;
    if logged == 0 {
        tx.rollback().await.map_err(orm_error)?;
        return Ok(false);
    }
    let rollup = rollup(report, rows);
    for ((day, pool, ip, reporter, from), counts) in rollup {
        use mail_dmarc_pool_daily::Column as C;
        use sea_orm::ExprTrait as _;
        let add = |column: C| {
            Expr::col((mail_dmarc_pool_daily::Entity, column)).add(Expr::col((
                sea_orm::sea_query::Alias::new("excluded"),
                column,
            )))
        };
        mail_dmarc_pool_daily::Entity::insert(mail_dmarc_pool_daily::ActiveModel {
            id: Set(generate_id("dmpool")),
            day: Set(day),
            pool: Set(pool),
            source_ip: Set(ip.chars().take(45).collect()),
            reporter: Set(reporter.chars().take(255).collect()),
            header_from_domain: Set(from.chars().take(255).collect()),
            messages: Set(count(counts.messages)),
            dkim_aligned: Set(count(counts.dkim)),
            spf_aligned: Set(count(counts.spf)),
            dmarc_pass: Set(count(counts.pass)),
            disposition_quarantine: Set(count(counts.quarantine)),
            disposition_reject: Set(count(counts.reject)),
            updated_at: Set(now),
        })
        .on_conflict(
            OnConflict::columns([
                C::Day,
                C::Pool,
                C::SourceIp,
                C::Reporter,
                C::HeaderFromDomain,
            ])
            .value(C::Messages, add(C::Messages))
            .value(C::DkimAligned, add(C::DkimAligned))
            .value(C::SpfAligned, add(C::SpfAligned))
            .value(C::DmarcPass, add(C::DmarcPass))
            .value(C::DispositionQuarantine, add(C::DispositionQuarantine))
            .value(C::DispositionReject, add(C::DispositionReject))
            .value(C::UpdatedAt, Expr::value(now))
            .to_owned(),
        )
        .exec_without_returning(&conn)
        .await?;
    }
    tx.commit().await.map_err(orm_error)?;
    Ok(true)
}

/// Drops log rows and rollup days past their retention. Cheap with the
/// indexes; the caller runs it at most hourly.
///
/// # Errors
///
/// The master database's.
pub(super) async fn prune_master(master: &PgPool) -> Result<(), DbErr> {
    let now = OffsetDateTime::now_utc();
    let db = orm(master);
    mail_dmarc_report_log::Entity::delete_many()
        .filter(
            mail_dmarc_report_log::Column::ReceivedAt.lt(now - Duration::days(LOG_RETENTION_DAYS)),
        )
        .exec(&db)
        .await?;
    mail_dmarc_pool_daily::Entity::delete_many()
        .filter(
            mail_dmarc_pool_daily::Column::Day
                .lt((now - Duration::days(ROLLUP_RETENTION_DAYS)).date()),
        )
        .exec(&db)
        .await?;
    Ok(())
}

/// The workspace's realtime hub (`clerk_org_id`, else its id).
///
/// # Errors
///
/// The master database's.
pub(super) async fn hub(master: &PgPool, workspace_id: &str) -> Result<String, DbErr> {
    use weldsuite_schema::master::workspaces;
    let org: Option<Option<String>> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::ClerkOrgId)
        .filter(workspaces::Column::Id.eq(workspace_id))
        .into_tuple()
        .one(&orm(master))
        .await?;
    Ok(org.flatten().unwrap_or_else(|| workspace_id.to_owned()))
}

/// Marks `mail_domain_id`'s DMARC alert as sent now, unless one went out
/// in the last day. `true` when this call may send it.
///
/// # Errors
///
/// The tenant database's.
pub(super) async fn claim_alert(db: &PgPool, mail_domain_id: &str) -> Result<bool, DbErr> {
    use weldsuite_schema::tenant::mail_domains;
    let now = OffsetDateTime::now_utc();
    let metadata: Option<Option<Value>> = mail_domains::Entity::find()
        .select_only()
        .column(mail_domains::Column::Metadata)
        .filter(mail_domains::Column::Id.eq(mail_domain_id))
        .filter(mail_domains::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    let Some(metadata) = metadata else {
        return Ok(false);
    };
    let last = metadata
        .as_ref()
        .and_then(|m| m["dmarcAlertedAt"].as_i64())
        .unwrap_or_default();
    if now.unix_timestamp() - last < 24 * 3600 {
        return Ok(false);
    }
    let mut metadata = metadata.unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({});
    }
    metadata["dmarcAlertedAt"] = json!(now.unix_timestamp());
    mail_domains::Entity::update_many()
        .col_expr(mail_domains::Column::Metadata, Expr::value(metadata))
        .filter(mail_domains::Column::Id.eq(mail_domain_id))
        .exec(&orm(db))
        .await?;
    Ok(true)
}

/// The user ids of the workspace's active owners and admins.
///
/// # Errors
///
/// The tenant database's.
pub(super) async fn admins(db: &impl ConnectionTrait) -> Result<Vec<String>, DbErr> {
    use weldsuite_schema::tenant::workspace_members;
    let members: Vec<(String, String)> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::UserId,
            workspace_members::Column::Role,
        ])
        .filter(workspace_members::Column::DeletedAt.is_null())
        .filter(workspace_members::Column::Status.eq("ACTIVE"))
        .into_tuple()
        .all(db)
        .await?;
    Ok(members
        .into_iter()
        .filter(|(_, role)| matches!(role.to_uppercase().as_str(), "OWNER" | "ADMIN"))
        .map(|(user, _)| user)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_domain_is_filed_under_itself_and_its_parents() {
        assert_eq!(
            candidates("news.acme.co.uk"),
            vec!["news.acme.co.uk", "acme.co.uk", "co.uk"]
        );
        assert_eq!(candidates("acme.test"), vec!["acme.test"]);
        assert_eq!(candidates("localhost"), Vec::<String>::new());
    }
}
