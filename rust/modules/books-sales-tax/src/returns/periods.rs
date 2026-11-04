//! Return periods and due dates per agency (`services/sales-tax-returns/periods.ts`):
//! the grid of the agency's filing frequency and first period start
//! (`agency_deadlines`), and the returns already created for each period.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::dates::diff_days;
use weldsuite_books_domain::tax_calendar::agency_deadlines;

use super::common::{
    FILED_STATUSES, add_days, add_months, agency_to_input, bad, n, num_at, opt, s,
};
use crate::common::text;

/// `AgencyPeriod`.
#[derive(Debug, Clone)]
pub(crate) struct AgencyPeriod {
    pub key: String,
    pub agency_id: String,
    pub period_start: String,
    pub period_end: String,
    pub due_date: String,
    pub nominal_due_date: String,
}

impl AgencyPeriod {
    fn to_json(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("key".into(), json!(self.key));
        out.insert("agencyId".into(), json!(self.agency_id));
        out.insert("periodStart".into(), json!(self.period_start));
        out.insert("periodEnd".into(), json!(self.period_end));
        out.insert("dueDate".into(), json!(self.due_date));
        out.insert("nominalDueDate".into(), json!(self.nominal_due_date));
        out
    }
}

/// `agencyPeriods(agency, from, to)`: the periods whose last day falls in
/// `[from, to]`, oldest first.
pub(crate) fn agency_periods(agency: &Value, from: &str, to: &str) -> Vec<AgencyPeriod> {
    if to < from {
        return Vec::new();
    }
    let deadlines = agency_deadlines(&[agency_to_input(agency)], from, &add_days(to, 45));
    let mut out: Vec<AgencyPeriod> = deadlines
        .into_iter()
        .filter_map(|d| {
            let start = d.period_start.clone().filter(|p| !p.is_empty())?;
            let end = d.period_end.clone().filter(|p| !p.is_empty())?;
            (end.as_str() >= from && end.as_str() <= to).then(|| AgencyPeriod {
                key: d.key.clone(),
                agency_id: s(agency, "id").to_owned(),
                period_start: start,
                period_end: end,
                due_date: d.due_date.clone(),
                nominal_due_date: d.nominal_date.clone(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.period_end.cmp(&b.period_end));
    out
}

/// `matchPeriod(agency, periodStart, periodEnd)`.
pub(crate) fn match_period(
    agency: &Value,
    period_start: &str,
    period_end: &str,
) -> Option<AgencyPeriod> {
    let found = agency_periods(agency, period_end, period_end)
        .into_iter()
        .find(|p| p.period_end == period_end);
    if let Some(found) = found
        && found.period_start == period_start
    {
        return Some(found);
    }
    if text(agency, "registeredUntil").is_some_and(|u| !u.is_empty() && u == period_end) {
        let containing = agency_periods(agency, period_start, &add_months(period_end, 13))
            .into_iter()
            .find(|p| p.period_start == period_start && p.period_end.as_str() >= period_end);
        if let Some(mut p) = containing {
            period_end.clone_into(&mut p.period_end);
            p.key = format!("sales_tax:{}:{period_end}", s(agency, "id"));
            return Some(p);
        }
    }
    None
}

/// `periodState(...)`.
pub(crate) fn period_state(
    period_start: &str,
    period_end: &str,
    due_date: &str,
    today: &str,
    return_status: Option<&str>,
) -> &'static str {
    match return_status {
        Some("paid") => return "paid",
        Some("filed") => return "filed",
        _ => {}
    }
    if period_end >= today {
        return if period_start > today {
            "upcoming"
        } else {
            "in_progress"
        };
    }
    if due_date < today { "overdue" } else { "due" }
}

/// `summarize(row)`.
pub(crate) fn summarize(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "status": row["status"],
        "totalDue": n(num_at(row, "totalDue")),
        "filedAt": opt(row, "filedAt"),
        "paidAt": opt(row, "paidAt"),
        "confirmationNumber": row["confirmationNumber"],
    })
}

/// `PeriodRow`.
#[derive(Debug, Clone)]
pub(crate) struct PeriodRow {
    pub period: AgencyPeriod,
    pub agency_name: String,
    pub state_code: String,
    pub own: Option<Value>,
    pub amendments: Vec<Value>,
    pub state: &'static str,
    pub unfiled: bool,
    pub overdue: bool,
    pub days_until_due: i64,
}

impl PeriodRow {
    pub(crate) fn to_json(&self) -> Value {
        let mut out = self.period.to_json();
        out.insert("agencyName".into(), json!(self.agency_name));
        out.insert("stateCode".into(), json!(self.state_code));
        out.insert(
            "return".into(),
            self.own.as_ref().map_or(Value::Null, summarize),
        );
        out.insert(
            "amendments".into(),
            Value::Array(self.amendments.iter().map(summarize).collect()),
        );
        out.insert("state".into(), json!(self.state));
        out.insert("unfiled".into(), json!(self.unfiled));
        out.insert("overdue".into(), json!(self.overdue));
        out.insert("daysUntilDue".into(), json!(self.days_until_due));
        Value::Object(out)
    }

    pub(crate) fn return_status(&self) -> Option<&str> {
        self.own.as_ref().and_then(|r| text(r, "status"))
    }
}

/// `buildPeriodRows(agency, returns, from, to, today)`.
pub(crate) fn build_period_rows(
    agency: &Value,
    returns: &[Value],
    from: &str,
    to: &str,
    today: &str,
) -> Vec<PeriodRow> {
    agency_periods(agency, from, to)
        .into_iter()
        .map(|period| {
            let for_period: Vec<&Value> = returns
                .iter()
                .filter(|r| s(r, "periodEnd") == period.period_end)
                .collect();
            let own = for_period
                .iter()
                .find(|r| text(r, "amendsReturnId").is_none_or(str::is_empty))
                .map(|r| (*r).clone());
            let amendments: Vec<Value> = for_period
                .iter()
                .filter(|r| text(r, "amendsReturnId").is_some_and(|a| !a.is_empty()))
                .map(|r| (*r).clone())
                .collect();
            let status = own.as_ref().and_then(|r| text(r, "status"));
            let filed = status.is_some_and(|st| FILED_STATUSES.contains(&st));
            let state = period_state(
                &period.period_start,
                &period.period_end,
                &period.due_date,
                today,
                status,
            );
            let unfiled = period.period_end.as_str() < today && !filed;
            let overdue = unfiled && period.due_date.as_str() < today;
            let days_until_due = diff_days(today, &period.due_date).unwrap_or(0);
            PeriodRow {
                agency_name: s(agency, "name").to_owned(),
                state_code: s(agency, "stateCode").to_owned(),
                own,
                amendments,
                state,
                unfiled,
                overdue,
                days_until_due,
                period,
            }
        })
        .collect()
}

/// `nextPeriodToOpen(agency, returns, today)`.
pub(crate) fn next_period_to_open(
    agency: &Value,
    returns: &[Value],
    today: &str,
) -> Result<AgencyPeriod, weldsuite_books_domain::http::Refusal> {
    let Some(start) = text(agency, "firstPeriodStart")
        .or_else(|| text(agency, "registeredFrom"))
        .filter(|s| !s.is_empty())
    else {
        return Err(bad(
            "This agency has no first period start; set it on the agency first",
        ));
    };
    let taken: Vec<&str> = returns
        .iter()
        .filter(|r| text(r, "amendsReturnId").is_none_or(str::is_empty))
        .map(|r| s(r, "periodEnd"))
        .collect();
    agency_periods(agency, start, &add_months(today, 13))
        .into_iter()
        .find(|p| !taken.contains(&p.period_end.as_str()) && p.period_start.as_str() <= today)
        .ok_or_else(|| bad("Every period of this agency up to today already has a return"))
}
