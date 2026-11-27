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
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use weldsuite_catalogs::entity_events::MAIL_DMARC_SOURCE_UPDATED;
use weldsuite_catalogs::permission_keys::{ACCOUNTS_READ, ACCOUNTS_UPDATE};
use weldsuite_db::orm;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::{Data, List, Pagination, generate_id};
use weldsuite_mail_dmarc::readiness::{self, Mark, SourceStat, Window};
use weldsuite_mail_dmarc::record::{self, Inspection};
use weldsuite_mail_dmarc::sources;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    mail_dmarc_records, mail_dmarc_reports, mail_dmarc_sources, mail_domains,
};

use crate::util::{MailError, MailResult, answer, query_map};
use crate::{Caller, MailState};

/// Failing groups listed at most.
const MAX_FAILURES: usize = 20;
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

/// One record row of the window.
#[derive(Debug, Clone)]
struct RowView {
    report_id: String,
    source_ip: String,
    source_name: Option<String>,
    pool: Option<String>,
    count: u64,
    dkim: bool,
    spf: bool,
    header_from: String,
    dkim_results: Option<Value>,
    spf_results: Option<Value>,
}

impl RowView {
    fn passed(&self) -> bool {
        self.dkim || self.spf
    }

    fn key(&self) -> String {
        sources::key(
            self.pool.as_deref(),
            self.source_name.as_deref(),
            &self.source_ip,
        )
    }
}

#[derive(Debug, Default, Clone)]
struct Tally {
    messages: u64,
    passed: u64,
    dkim: u64,
    spf: u64,
}

impl Tally {
    fn add(&mut self, row: &RowView) {
        self.messages += row.count;
        self.passed += if row.passed() { row.count } else { 0 };
        self.dkim += if row.dkim { row.count } else { 0 };
        self.spf += if row.spf { row.count } else { 0 };
    }
}

async fn window_rows(
    caller: &Caller,
    id: &str,
    from: OffsetDateTime,
) -> Result<Vec<RowView>, DbErr> {
    let rows = mail_dmarc_records::Entity::find()
        .filter(mail_dmarc_records::Column::MailDomainId.eq(id))
        .filter(mail_dmarc_records::Column::PeriodEnd.gte(from))
        .all(&orm(&caller.db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| RowView {
            report_id: row.report_id,
            source_ip: row.source_ip,
            source_name: row.source_name,
            pool: row.weldsuite_pool,
            count: u64::try_from(row.count).unwrap_or_default(),
            dkim: row.dkim_aligned,
            spf: row.spf_aligned,
            header_from: row.header_from,
            dkim_results: row.dkim_results,
            spf_results: row.spf_results,
        })
        .collect())
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
        let reports = mail_dmarc_reports::Entity::find()
            .filter(mail_dmarc_reports::Column::MailDomainId.eq(&id))
            .filter(
                mail_dmarc_reports::Column::PeriodEnd
                    .gte(now - Duration::days(POLICY_HISTORY_DAYS.max(days))),
            )
            .order_by_desc(mail_dmarc_reports::Column::PeriodEnd)
            .all(&orm(&caller.db))
            .await?;
        let last_report_at = mail_dmarc_reports::Entity::find()
            .select_only()
            .column(mail_dmarc_reports::Column::ReceivedAt)
            .filter(mail_dmarc_reports::Column::MailDomainId.eq(&id))
            .order_by_desc(mail_dmarc_reports::Column::ReceivedAt)
            .into_tuple::<OffsetDateTime>()
            .one(&orm(&caller.db))
            .await?;
        let rows = window_rows(&caller, &id, from).await?;
        let marks: HashMap<String, Mark> = mail_dmarc_sources::Entity::find()
            .filter(mail_dmarc_sources::Column::MailDomainId.eq(&id))
            .all(&orm(&caller.db))
            .await?
            .into_iter()
            .filter_map(|m| Mark::parse(&m.mark).map(|mark| (m.source_key, mark)))
            .collect();
        let in_window: Vec<&mail_dmarc_reports::Model> =
            reports.iter().filter(|r| r.period_end >= from).collect();
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
            rows: &rows,
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
    rows: &'a [RowView],
    marks: &'a HashMap<String, Mark>,
    last_report_at: Option<OffsetDateTime>,
}

fn build_summary(input: &SummaryInput<'_>) -> Value {
    let authenticated: BTreeSet<&str> = input
        .in_window
        .iter()
        .filter(|r| r.authenticated)
        .map(|r| r.id.as_str())
        .collect();
    let mut totals = Tally::default();
    let mut by_source: BTreeMap<String, (Tally, BTreeSet<String>, Option<String>)> =
        BTreeMap::new();
    let mut trusted: BTreeMap<String, Tally> = BTreeMap::new();
    for row in input.rows {
        totals.add(row);
        let key = row.key();
        let entry = by_source.entry(key.clone()).or_default();
        entry.0.add(row);
        if entry.1.len() < MAX_SOURCE_IPS {
            entry.1.insert(row.source_ip.clone());
        }
        entry.2.clone_from(&row.pool);
        if authenticated.contains(row.report_id.as_str()) {
            trusted.entry(key).or_default().add(row);
        }
    }
    let mut sources: Vec<(String, Tally, BTreeSet<String>, Option<String>)> = by_source
        .into_iter()
        .map(|(key, (tally, ips, pool))| (key, tally, ips, pool))
        .collect();
    sources.sort_by(|a, b| b.1.messages.cmp(&a.1.messages).then_with(|| a.0.cmp(&b.0)));
    let sources_json: Vec<Value> = sources
        .iter()
        .map(|(key, tally, ips, pool)| {
            let kind = key.split_once(':').map_or("ip", |(kind, _)| kind);
            json!({
                "key": key,
                "kind": kind,
                "name": pool.clone().unwrap_or_else(|| sources::label(key).to_owned()),
                "ips": ips,
                "messages": tally.messages,
                "passed": tally.passed,
                "dkimAligned": tally.dkim,
                "spfAligned": tally.spf,
                "mark": input.marks.get(key).map(|m| m.as_str()),
            })
        })
        .collect();
    let advice = readiness::advise(input.inspection, &window(input, &trusted));
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
            "authenticatedReports": authenticated.len(),
            "lastReportAt": input.last_report_at.map(iso_timestamp),
        },
        "sources": sources_json,
        "reporters": reporters(input.in_window),
        "failures": failures(input.rows),
        "advice": advice,
    })
}

/// The readiness window: authenticated reports only.
fn window(input: &SummaryInput<'_>, trusted: &BTreeMap<String, Tally>) -> Window {
    let authenticated: Vec<&&mail_dmarc_reports::Model> =
        input.in_window.iter().filter(|r| r.authenticated).collect();
    let days: BTreeSet<time::Date> = authenticated.iter().map(|r| r.period_end.date()).collect();
    let reporters: BTreeSet<&str> = authenticated
        .iter()
        .map(|r| r.reporter_domain.as_str())
        .collect();
    let sources = trusted
        .iter()
        .map(|(key, tally)| SourceStat {
            key: key.clone(),
            messages: tally.messages,
            passed: tally.passed,
            mark: input.marks.get(key).copied(),
        })
        .collect();
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

/// The failing rows, grouped by source, From domain and which identifier
/// failed, the largest first.
fn failures(rows: &[RowView]) -> Vec<Value> {
    type Group = (String, String, bool, bool, BTreeSet<String>, Option<String>);
    let mut groups: BTreeMap<(String, String, bool, bool), (Group, u64)> = BTreeMap::new();
    for row in rows.iter().filter(|row| !row.passed()) {
        let key = row.key();
        let dkim_domains: BTreeSet<String> = row
            .dkim_results
            .as_ref()
            .and_then(Value::as_array)
            .map(|results| {
                results
                    .iter()
                    .filter_map(|r| r["domain"].as_str())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let spf_domain = row
            .spf_results
            .as_ref()
            .and_then(Value::as_array)
            .and_then(|results| results.first())
            .and_then(|r| r["domain"].as_str())
            .map(str::to_owned);
        let entry = groups
            .entry((key.clone(), row.header_from.clone(), row.dkim, row.spf))
            .or_insert_with(|| {
                (
                    (
                        key,
                        row.header_from.clone(),
                        row.dkim,
                        row.spf,
                        BTreeSet::new(),
                        spf_domain.clone(),
                    ),
                    0,
                )
            });
        entry.0.4.extend(dkim_domains);
        entry.1 += row.count;
    }
    let mut out: Vec<(Group, u64)> = groups.into_values().collect();
    out.sort_by_key(|group| std::cmp::Reverse(group.1));
    out.into_iter()
        .take(MAX_FAILURES)
        .map(
            |((key, from, dkim, spf, dkim_domains, spf_domain), messages)| {
                json!({
                    "sourceKey": key,
                    "sourceName": sources::label(&key),
                    "headerFrom": from,
                    "dkimAligned": dkim,
                    "spfAligned": spf,
                    "dkimDomains": dkim_domains,
                    "spfDomain": spf_domain,
                    "messages": messages,
                })
            },
        )
        .collect()
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

/// `PATCH /mail-domains/:id/dmarc/sources` `{ key, mark }`.
async fn mark_source(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let result = async {
        let body: Value = serde_json::from_slice(&body)
            .map_err(|_| MailError::bad_request("Invalid JSON body".to_owned()))?;
        let key = body["key"]
            .as_str()
            .map(str::trim)
            .filter(|key| {
                !key.is_empty()
                    && key.len() <= 255
                    && ["weldsuite:", "name:", "ip:"]
                        .iter()
                        .any(|prefix| key.starts_with(prefix))
            })
            .ok_or_else(|| MailError::bad_request("key must be a source key".to_owned()))?
            .to_owned();
        let mark = match &body["mark"] {
            Value::Null => None,
            Value::String(text) => Some(Mark::parse(text).ok_or_else(|| {
                MailError::bad_request("mark must be mine, not_mine or null".to_owned())
            })?),
            _ => {
                return Err(MailError::bad_request(
                    "mark must be mine, not_mine or null".to_owned(),
                ));
            }
        };
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

    fn row(ip: &str, pool: Option<&str>, name: Option<&str>, count: u64, dkim: bool) -> RowView {
        RowView {
            report_id: "r1".to_owned(),
            source_ip: ip.to_owned(),
            source_name: name.map(str::to_owned),
            pool: pool.map(str::to_owned),
            count,
            dkim,
            spf: false,
            header_from: "acme.test".to_owned(),
            dkim_results: Some(
                json!([{ "domain": "acme.test", "result": if dkim { "pass" } else { "fail" } }]),
            ),
            spf_results: Some(json!([{ "domain": "bounces.weldsuite.test", "result": "pass" }])),
        }
    }

    #[test]
    fn failures_group_by_source_and_outcome() {
        let rows = vec![
            row("198.51.100.7", Some("customer"), None, 10, true),
            row("203.0.113.9", None, Some("a.mailer.test"), 3, false),
            row("203.0.113.10", None, Some("b.mailer.test"), 2, false),
        ];
        let failures = failures(&rows);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0]["sourceName"], "mailer.test");
        assert_eq!(failures[0]["messages"], 5);
        assert_eq!(failures[0]["dkimDomains"], json!(["acme.test"]));
        assert_eq!(failures[0]["spfDomain"], "bounces.weldsuite.test");
    }
}
