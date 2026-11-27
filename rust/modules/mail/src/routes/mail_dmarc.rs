//! A custom mail domain's DMARC aggregate reports (ADR MAIL-015), Rust
//! only (edition feature `mail-dmarc-reports`; Global has no counterpart):
//!
//! - `GET /mail-domains/:id/dmarc?days=7|30|90`: the record as last
//!   checked, the period's messages, sending sources, alignment failures and
//!   reporters, and whether the domain is ready for a stricter policy
//!   (`weldsuite_mail_dmarc::readiness`, authenticated reports only).
//! - `GET /mail-domains/:id/dmarc/reports`: the reports, newest first.
//! - `PATCH /mail-domains/:id/dmarc/sources` `{ key, mark }`: a sending
//!   source is the workspace's own (`mine`), not (`not_mine`), or unmarked
//!   (`null`). The key is in the body: it holds `:` and `.`.
//!
//! The reports are written by `weldsuite consume`
//! (`weldsuite_mail_inbound::dmarc`) into `mail_dmarc_reports` and
//! `mail_dmarc_records`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, Order, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use weldsuite_catalogs::entity_events::MAIL_DMARC_SOURCE_UPDATED;
use weldsuite_catalogs::permission_keys::{ACCOUNTS_READ, ACCOUNTS_UPDATE};
use weldsuite_db::orm;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::Presence;
use weldsuite_kit::{Data, List, Pagination, generate_id};
use weldsuite_mail_dmarc::readiness::{self, Mark, SourceStat, Window};
use weldsuite_mail_dmarc::record::{self, Inspection};
use weldsuite_mail_dmarc::sources;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    mail_dmarc_records, mail_dmarc_reports, mail_dmarc_sources, mail_domains,
};

use crate::util::{MailError, MailResult, answer, query_map, validate};
use crate::{Caller, MailState};

/// Failing groups listed at most.
const MAX_FAILURES: u64 = 20;
/// Addresses listed per source at most.
const MAX_SOURCE_IPS: usize = 20;
/// How far back the policy history goes for the `reject` step.
const POLICY_HISTORY_DAYS: i64 = 60;

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([ACCOUNTS_READ]);
    Router::new()
        .route("/mail-domains/{id}/dmarc", get(summary).route_layer(read()))
        .route(
            "/mail-domains/{id}/dmarc/reports",
            get(reports).route_layer(read()),
        )
        .route(
            "/mail-domains/{id}/dmarc/sources",
            patch(mark_source).route_layer(gate.require([ACCOUNTS_UPDATE])),
        )
        .with_state(state)
}

/// The domain row, or 404.
async fn domain(caller: &Caller, id: &str) -> MailResult<mail_domains::Model> {
    mail_domains::Entity::find_by_id(id.to_owned())
        .filter(mail_domains::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .ok_or_else(|| MailError::not_found("Domain", Some(id)))
}

/// The DMARC entry of the domain's `dns_records`, as the last check left it.
fn dmarc_entry(row: &mail_domains::Model) -> Option<&Value> {
    row.dns_records
        .as_ref()?
        .as_array()?
        .iter()
        .find(|record| record["purpose"] == "dmarc")
}

/// The record as last checked: its state, and the inspection the advice
/// works from (recomputed from the records found).
fn record_view(row: &mail_domains::Model, address: Option<&str>) -> (Value, Inspection) {
    let entry = dmarc_entry(row);
    let found: Vec<String> = entry
        .and_then(|e| e["dmarc"]["found"].as_array())
        .map(|found| {
            found
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let suggested = entry
        .and_then(|e| e["value"].as_str())
        .map_or_else(|| record::suggested_new(address), str::to_owned);
    let inspection = record::inspect(&found, address, &suggested);
    let checked = entry.is_some_and(|e| e.get("dmarc").is_some());
    let view = json!({
        "state": if checked { inspection.state.as_str() } else { "unchecked" },
        "found": inspection.found,
        "policy": inspection.policy,
        "reportsToWeldSuite": inspection.reports_to_weldsuite,
        "suggested": suggested,
    });
    (view, inspection)
}

/// Messages, DMARC passes and aligned identifiers, summed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Tally {
    messages: u64,
    passed: u64,
    dkim: u64,
    spf: u64,
}

impl Tally {
    fn from_sums(messages: i64, passed: i64, dkim: i64, spf: i64) -> Self {
        let n = |v: i64| u64::try_from(v).unwrap_or_default();
        Self {
            messages: n(messages),
            passed: n(passed),
            dkim: n(dkim),
            spf: n(spf),
        }
    }

    fn minus(self, other: Self) -> Self {
        Self {
            messages: self.messages.saturating_sub(other.messages),
            passed: self.passed.saturating_sub(other.passed),
            dkim: self.dkim.saturating_sub(other.dkim),
            spf: self.spf.saturating_sub(other.spf),
        }
    }
}

/// One sending source over the window.
#[derive(Debug, Clone)]
struct SourceSums {
    key: String,
    pool: Option<String>,
    ips: Vec<String>,
    tally: Tally,
}

/// Sources listed on the page at most.
const MAX_SOURCES: u64 = 200;
/// Sources the readiness looks at one by one; the rest are summed.
const MAX_ADVICE_SOURCES: u64 = 500;

const SUM_MESSAGES: &str = "coalesce(sum(count), 0)::bigint";
const SUM_PASSED: &str =
    "coalesce(sum(case when dkim_aligned or spf_aligned then count else 0 end), 0)::bigint";
const SUM_DKIM: &str = "coalesce(sum(case when dkim_aligned then count else 0 end), 0)::bigint";
const SUM_SPF: &str = "coalesce(sum(case when spf_aligned then count else 0 end), 0)::bigint";

/// The domain's rows of the window, optionally of some reports only.
fn window_rows(
    id: &str,
    from: OffsetDateTime,
    reports: Option<&[String]>,
) -> sea_orm::Select<mail_dmarc_records::Entity> {
    let mut find = mail_dmarc_records::Entity::find()
        .filter(mail_dmarc_records::Column::MailDomainId.eq(id))
        .filter(mail_dmarc_records::Column::PeriodEnd.gte(from));
    if let Some(ids) = reports {
        find = find.filter(mail_dmarc_records::Column::ReportId.is_in(ids.iter().cloned()));
    }
    find
}

/// The window's sums, in SQL: a busy domain's reports hold many rows.
async fn totals(
    db: &impl ConnectionTrait,
    id: &str,
    from: OffsetDateTime,
    reports: Option<&[String]>,
) -> Result<Tally, DbErr> {
    let sums: Option<(i64, i64, i64, i64)> = window_rows(id, from, reports)
        .select_only()
        .column_as(Expr::cust(SUM_MESSAGES), "messages")
        .column_as(Expr::cust(SUM_PASSED), "passed")
        .column_as(Expr::cust(SUM_DKIM), "dkim")
        .column_as(Expr::cust(SUM_SPF), "spf")
        .into_tuple()
        .one(db)
        .await?;
    Ok(sums.map_or_else(Tally::default, |(m, p, d, s)| Tally::from_sums(m, p, d, s)))
}

/// The busiest `limit` sources of the window, grouped in SQL.
async fn source_sums(
    db: &impl ConnectionTrait,
    id: &str,
    from: OffsetDateTime,
    reports: Option<&[String]>,
    limit: u64,
) -> Result<Vec<SourceSums>, DbErr> {
    type Row = (String, Option<String>, Option<String>, i64, i64, i64, i64);
    let rows: Vec<Row> = window_rows(id, from, reports)
        .select_only()
        .column(mail_dmarc_records::Column::SourceKey)
        .column_as(Expr::cust("max(weldsuite_pool)"), "pool")
        .column_as(
            Expr::cust(format!(
                "array_to_string((array_agg(distinct source_ip))[1:{MAX_SOURCE_IPS}], ',')"
            )),
            "ips",
        )
        .column_as(Expr::cust(SUM_MESSAGES), "messages")
        .column_as(Expr::cust(SUM_PASSED), "passed")
        .column_as(Expr::cust(SUM_DKIM), "dkim")
        .column_as(Expr::cust(SUM_SPF), "spf")
        .group_by(mail_dmarc_records::Column::SourceKey)
        .order_by(Expr::cust("coalesce(sum(count), 0)"), Order::Desc)
        .order_by(mail_dmarc_records::Column::SourceKey, Order::Asc)
        .limit(limit)
        .into_tuple()
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(key, pool, ips, m, p, d, s)| SourceSums {
            key,
            pool,
            ips: ips
                .unwrap_or_default()
                .split(',')
                .filter(|ip| !ip.is_empty())
                .map(str::to_owned)
                .collect(),
            tally: Tally::from_sums(m, p, d, s),
        })
        .collect())
}

/// The failing rows, grouped by source and From domain, the largest first,
/// in SQL; one row's DKIM and SPF results stand for the group.
async fn failures(
    db: &impl ConnectionTrait,
    id: &str,
    from: OffsetDateTime,
) -> Result<Vec<Value>, DbErr> {
    type Row = (String, String, i64, Option<String>, Option<String>);
    let rows: Vec<Row> = window_rows(id, from, None)
        .filter(mail_dmarc_records::Column::DkimAligned.eq(false))
        .filter(mail_dmarc_records::Column::SpfAligned.eq(false))
        .select_only()
        .column(mail_dmarc_records::Column::SourceKey)
        .column(mail_dmarc_records::Column::HeaderFrom)
        .column_as(Expr::cust(SUM_MESSAGES), "messages")
        .column_as(Expr::cust("min(dkim_results::text)"), "dkim_results")
        .column_as(Expr::cust("min(spf_results::text)"), "spf_results")
        .group_by(mail_dmarc_records::Column::SourceKey)
        .group_by(mail_dmarc_records::Column::HeaderFrom)
        .order_by(Expr::cust("coalesce(sum(count), 0)"), Order::Desc)
        .limit(MAX_FAILURES)
        .into_tuple()
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(key, from, messages, dkim, spf)| failure_json(&key, &from, messages, dkim, spf))
        .collect())
}

/// One failing group as the page shows it.
fn failure_json(
    key: &str,
    from: &str,
    messages: i64,
    dkim_results: Option<String>,
    spf_results: Option<String>,
) -> Value {
    let parsed = |text: Option<String>| {
        text.and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
    };
    let dkim_domains: BTreeSet<String> = parsed(dkim_results)
        .iter()
        .filter_map(|r| r["domain"].as_str())
        .map(str::to_owned)
        .collect();
    let spf_domain = parsed(spf_results)
        .first()
        .and_then(|r| r["domain"].as_str())
        .map(str::to_owned);
    json!({
        "sourceKey": key,
        "sourceName": sources::label(key),
        "headerFrom": from,
        "dkimAligned": false,
        "spfAligned": false,
        "dkimDomains": dkim_domains,
        "spfDomain": spf_domain,
        "messages": messages,
    })
}

/// `GET /mail-domains/:id/dmarc`.
async fn summary(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    let result = async {
        let days: i64 = match query_map(raw.as_deref()).get("days").map(String::as_str) {
            Some("7") => 7,
            Some("90") => 90,
            _ => 30,
        };
        let row = domain(&caller, &id).await?;
        let address = state
            .domains
            .as_ref()
            .and_then(|d| d.dmarc_report_address());
        let (record_view, inspection) = record_view(&row, address);
        let now = OffsetDateTime::now_utc();
        let from = now - Duration::days(days);
        let db = orm(&caller.db);
        // A domain gets a few reports a day per receiver: these are few.
        let reports = mail_dmarc_reports::Entity::find()
            .filter(mail_dmarc_reports::Column::MailDomainId.eq(&id))
            .filter(
                mail_dmarc_reports::Column::PeriodEnd
                    .gte(now - Duration::days(POLICY_HISTORY_DAYS.max(days))),
            )
            .order_by_desc(mail_dmarc_reports::Column::PeriodEnd)
            .all(&db)
            .await?;
        let last_report_at = mail_dmarc_reports::Entity::find()
            .select_only()
            .column(mail_dmarc_reports::Column::ReceivedAt)
            .filter(mail_dmarc_reports::Column::MailDomainId.eq(&id))
            .order_by_desc(mail_dmarc_reports::Column::ReceivedAt)
            .into_tuple::<OffsetDateTime>()
            .one(&db)
            .await?;
        let marks: HashMap<String, Mark> = mail_dmarc_sources::Entity::find()
            .filter(mail_dmarc_sources::Column::MailDomainId.eq(&id))
            .all(&db)
            .await?
            .into_iter()
            .filter_map(|m| Mark::parse(&m.mark).map(|mark| (m.source_key, mark)))
            .collect();
        let in_window: Vec<&mail_dmarc_reports::Model> =
            reports.iter().filter(|r| r.period_end >= from).collect();
        let authenticated: Vec<String> = in_window
            .iter()
            .filter(|r| r.authenticated)
            .map(|r| r.id.clone())
            .collect();
        // The rows themselves can be many: everything below is summed in SQL.
        let all = totals(&db, &id, from, None).await?;
        let listed = source_sums(&db, &id, from, None, MAX_SOURCES).await?;
        let trusted_total = totals(&db, &id, from, Some(&authenticated)).await?;
        let trusted = source_sums(&db, &id, from, Some(&authenticated), MAX_ADVICE_SOURCES).await?;
        let failing = failures(&db, &id, from).await?;
        let body = build_summary(&SummaryInput {
            row: &row,
            address,
            record_view,
            inspection: &inspection,
            days,
            from,
            now,
            reports: &reports,
            in_window: &in_window,
            totals: all,
            sources: &listed,
            trusted: &trusted,
            trusted_total,
            failures: failing,
            marks: &marks,
            last_report_at,
        });
        Ok(Data(body).into_response())
    }
    .await;
    answer(result, "Failed to load the domain's DMARC reports")
}

struct SummaryInput<'a> {
    row: &'a mail_domains::Model,
    address: Option<&'a str>,
    record_view: Value,
    inspection: &'a Inspection,
    days: i64,
    from: OffsetDateTime,
    now: OffsetDateTime,
    /// The policy history's reports, newest first.
    reports: &'a [mail_dmarc_reports::Model],
    in_window: &'a [&'a mail_dmarc_reports::Model],
    totals: Tally,
    /// The busiest sources, all reports.
    sources: &'a [SourceSums],
    /// The busiest sources of the authenticated reports, and their total.
    trusted: &'a [SourceSums],
    trusted_total: Tally,
    failures: Vec<Value>,
    marks: &'a HashMap<String, Mark>,
    last_report_at: Option<OffsetDateTime>,
}

fn build_summary(input: &SummaryInput<'_>) -> Value {
    let sources_json: Vec<Value> = input
        .sources
        .iter()
        .map(|source| {
            let key = source.key.as_str();
            let kind = key.split_once(':').map_or("ip", |(kind, _)| kind);
            json!({
                "key": key,
                "kind": kind,
                "name": source.pool.clone().unwrap_or_else(|| sources::label(key).to_owned()),
                "ips": source.ips,
                "messages": source.tally.messages,
                "passed": source.tally.passed,
                "dkimAligned": source.tally.dkim,
                "spfAligned": source.tally.spf,
                "mark": input.marks.get(key).map(|m| m.as_str()),
            })
        })
        .collect();
    let advice = readiness::advise(input.inspection, &window(input));
    let totals = input.totals;
    json!({
        "domainId": input.row.id,
        "domainName": input.row.domain_name,
        "reportAddress": input.address,
        "record": input.record_view.clone(),
        "period": {
            "days": input.days,
            "from": iso_timestamp(input.from),
            "to": iso_timestamp(input.now),
        },
        "totals": {
            "messages": totals.messages,
            "passed": totals.passed,
            "dkimAligned": totals.dkim,
            "spfAligned": totals.spf,
            "reports": input.in_window.len(),
            "authenticatedReports": input.in_window.iter().filter(|r| r.authenticated).count(),
            "lastReportAt": input.last_report_at.map(iso_timestamp),
        },
        "sources": sources_json,
        "reporters": reporters(input.in_window),
        "failures": input.failures,
        "advice": advice,
    })
}

/// The readiness window: authenticated reports only. Sources beyond the
/// busiest are one summed source ([`sources::REST_KEY`]): they count toward
/// the pass rate, never as one failing source.
fn window(input: &SummaryInput<'_>) -> Window {
    let authenticated: Vec<&&mail_dmarc_reports::Model> =
        input.in_window.iter().filter(|r| r.authenticated).collect();
    let days: BTreeSet<time::Date> = authenticated.iter().map(|r| r.period_end.date()).collect();
    let reporters: BTreeSet<&str> = authenticated
        .iter()
        .map(|r| r.reporter_domain.as_str())
        .collect();
    let mut listed = Tally::default();
    let mut sources: Vec<SourceStat> = input
        .trusted
        .iter()
        .map(|source| {
            listed.messages += source.tally.messages;
            listed.passed += source.tally.passed;
            SourceStat {
                key: source.key.clone(),
                messages: source.tally.messages,
                passed: source.tally.passed,
                mark: input.marks.get(&source.key).copied(),
            }
        })
        .collect();
    let rest = input.trusted_total.minus(listed);
    if rest.messages > 0 {
        sources.push(SourceStat {
            key: sources::REST_KEY.to_owned(),
            messages: rest.messages,
            passed: rest.passed,
            mark: None,
        });
    }
    Window {
        days_with_reports: u32::try_from(days.len()).unwrap_or(u32::MAX),
        reporters: u32::try_from(reporters.len()).unwrap_or(u32::MAX),
        sources,
        days_at_policy: days_at_policy(input),
    }
}

/// Days the authenticated reports have shown the domain's current policy
/// without a break, counted back from the newest.
fn days_at_policy(input: &SummaryInput<'_>) -> u32 {
    let Some(current) = input.inspection.policy.as_ref().map(|p| p.p.as_str()) else {
        return 0;
    };
    let mut oldest = None;
    for report in input.reports.iter().filter(|r| r.authenticated) {
        let p = report
            .policy
            .as_ref()
            .and_then(|policy| policy["p"].as_str())
            .unwrap_or("none")
            .to_ascii_lowercase();
        if p != current {
            break;
        }
        oldest = Some(report.period_start);
    }
    oldest.map_or(0, |start| {
        u32::try_from((input.now - start).whole_days().max(0)).unwrap_or(u32::MAX)
    })
}

fn reporters(reports: &[&mail_dmarc_reports::Model]) -> Vec<Value> {
    let mut by: BTreeMap<&str, (&str, u64, u64)> = BTreeMap::new();
    for report in reports {
        let entry = by.entry(report.reporter_domain.as_str()).or_insert((
            report.reporter_org.as_str(),
            0,
            0,
        ));
        entry.1 += 1;
        entry.2 += u64::try_from(report.messages).unwrap_or_default();
    }
    let mut out: Vec<Value> = by
        .into_iter()
        .map(|(domain, (org, count, messages))| {
            json!({ "domain": domain, "org": org, "reports": count, "messages": messages })
        })
        .collect();
    out.sort_by(|a, b| b["messages"].as_u64().cmp(&a["messages"].as_u64()));
    out
}

/// `GET /mail-domains/:id/dmarc/reports?limit=&cursor=`: newest first; the
/// cursor is an offset.
async fn reports(caller: Caller, Path(id): Path<String>, RawQuery(raw): RawQuery) -> Response {
    let result = async {
        let query = query_map(raw.as_deref());
        let limit: u64 = query
            .get("limit")
            .and_then(|l| l.parse().ok())
            .unwrap_or(25)
            .clamp(1, 100);
        let offset: u64 = query
            .get("cursor")
            .and_then(|c| c.parse().ok())
            .unwrap_or_default();
        domain(&caller, &id).await?;
        let find = mail_dmarc_reports::Entity::find()
            .filter(mail_dmarc_reports::Column::MailDomainId.eq(&id));
        let total = find.clone().count(&orm(&caller.db)).await?;
        let page = find
            .order_by_desc(mail_dmarc_reports::Column::PeriodEnd)
            .order_by_desc(mail_dmarc_reports::Column::Id)
            .offset(offset)
            .limit(limit)
            .all(&orm(&caller.db))
            .await?;
        let next = offset + u64::try_from(page.len()).unwrap_or_default();
        let has_more = next < total;
        let data: Vec<Value> = page
            .into_iter()
            .map(|report| {
                json!({
                    "id": report.id,
                    "reporterOrg": report.reporter_org,
                    "reporterEmail": report.reporter_email,
                    "reporterDomain": report.reporter_domain,
                    "reportId": report.report_id,
                    "periodStart": iso_timestamp(report.period_start),
                    "periodEnd": iso_timestamp(report.period_end),
                    "policyDomain": report.policy_domain,
                    "policy": report.policy,
                    "authenticated": report.authenticated,
                    "messages": report.messages,
                    "passed": report.passed,
                    "receivedAt": iso_timestamp(report.received_at),
                })
            })
            .collect();
        Ok(List::new(
            data,
            Pagination::new(total, has_more, has_more.then(|| next.to_string())),
        )
        .into_response())
    }
    .await;
    answer(result, "Failed to list the domain's DMARC reports")
}

/// A key `weldsuite_mail_dmarc::sources::key` makes.
fn is_source_key(key: &str) -> bool {
    ["weldsuite:", "name:", "ip:"]
        .iter()
        .any(|prefix| key.len() > prefix.len() && key.starts_with(prefix))
}

/// `PATCH /mail-domains/:id/dmarc/sources` `{ key, mark }`.
async fn mark_source(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        // The module's body reader: JSON only, each field checked, 400 with
        // the issues otherwise.
        let (key, mark) = validate(&headers, &body, |issues, fields| {
            let key = issues
                .text(fields, "key", Presence::Required, Some(1), Some(255))
                .into_option()
                .map(|key| key.trim().to_owned());
            let mark = issues
                .choice(fields, "mark", Presence::Nullable, &["mine", "not_mine"])
                .into_option()
                .and_then(|mark| Mark::parse(&mark));
            if key.as_deref().is_some_and(|key| !is_source_key(key)) {
                issues.custom("key", "key must be a source key (name:, ip: or weldsuite:)");
            }
            (key, mark)
        })?;
        let key = key.ok_or_else(|| MailError::bad_request("key is required".to_owned()))?;
        if sources::is_weldsuite(&key) {
            return Err(MailError::bad_request(
                "WeldSuite's own sending addresses can't be marked".to_owned(),
            ));
        }
        domain(&caller, &id).await?;
        let db = orm(&caller.db);
        let now = OffsetDateTime::now_utc();
        match mark {
            Some(mark) => {
                mail_dmarc_sources::Entity::insert(mail_dmarc_sources::ActiveModel {
                    id: Set(generate_id("dmsrc")),
                    mail_domain_id: Set(id.clone()),
                    source_key: Set(key.clone()),
                    mark: Set(mark.as_str().to_owned()),
                    updated_by: Set(Some(caller.user_id.clone())),
                    created_at: Set(now),
                    updated_at: Set(now),
                })
                .on_conflict(
                    OnConflict::columns([
                        mail_dmarc_sources::Column::MailDomainId,
                        mail_dmarc_sources::Column::SourceKey,
                    ])
                    .value(
                        mail_dmarc_sources::Column::Mark,
                        Expr::value(mark.as_str().to_owned()),
                    )
                    .value(
                        mail_dmarc_sources::Column::UpdatedBy,
                        Expr::value(caller.user_id.clone()),
                    )
                    .value(mail_dmarc_sources::Column::UpdatedAt, Expr::value(now))
                    .to_owned(),
                )
                .exec_without_returning(&db)
                .await?;
            }
            None => {
                mail_dmarc_sources::Entity::delete_many()
                    .filter(mail_dmarc_sources::Column::MailDomainId.eq(&id))
                    .filter(mail_dmarc_sources::Column::SourceKey.eq(&key))
                    .exec(&db)
                    .await?;
            }
        }
        let data = json!({
            "id": format!("{id}:{key}"),
            "mailDomainId": id,
            "sourceKey": key,
            "mark": mark.map(Mark::as_str),
        });
        caller.publish(
            &state,
            MAIL_DMARC_SOURCE_UPDATED,
            &format!("{id}:{key}"),
            &data,
        );
        Ok(Data(json!({ "key": key, "mark": mark.map(Mark::as_str) })).into_response())
    }
    .await;
    answer(result, "Failed to mark the source")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failing_group_names_its_dkim_and_spf_domains() {
        let failure = failure_json(
            "name:mailer.test",
            "acme.test",
            5,
            Some(r#"[{"domain":"acme.test","result":"fail"},{"domain":"mailer.test","result":"pass"}]"#.to_owned()),
            Some(r#"[{"domain":"bounces.mailer.test","result":"pass"}]"#.to_owned()),
        );
        assert_eq!(failure["sourceName"], "mailer.test");
        assert_eq!(failure["messages"], 5);
        assert_eq!(failure["dkimDomains"], json!(["acme.test", "mailer.test"]));
        assert_eq!(failure["spfDomain"], "bounces.mailer.test");
        let bare = failure_json("ip:203.0.113.9", "acme.test", 1, None, None);
        assert_eq!(bare["dkimDomains"], json!([]));
        assert_eq!(bare["spfDomain"], Value::Null);
    }

    #[test]
    fn tallies_subtract_without_going_below_zero() {
        let all = Tally::from_sums(10, 8, 7, 1);
        let listed = Tally::from_sums(12, 5, 7, 0);
        assert_eq!(all.minus(listed), Tally::from_sums(0, 3, 0, 1));
    }
}
