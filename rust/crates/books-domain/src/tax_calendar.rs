//! The US tax due-date calendar (`us-compliance/tax-calendar.ts`) and the
//! federal legal holidays its deadlines roll past
//! (`us-compliance/federal-holidays.ts`): income tax returns and their
//! extensions, estimated tax, 1099s, payroll (informational) and the sales
//! tax returns of every agency. The sales tax returns' periods are the
//! agency deadlines here.

use serde_json::{Map, Value, json};

use crate::dates::{
    add_days, add_months, days_in_month, end_of_month, format_iso, parse_iso, start_of_month,
    weekday_of,
};
use crate::fiscal_year::{FiscalYearConfig, fiscal_year_for};

fn observed(date: &str, saturday_to_friday: bool) -> String {
    match weekday_of(date) {
        Some(0) => add_days(date, 1).unwrap_or_default(),
        Some(6) if saturday_to_friday => add_days(date, -1).unwrap_or_default(),
        _ => date.to_owned(),
    }
}

/// `nthWeekdayOfMonth(y, m, weekday, n)`.
fn nth_weekday(y: i64, m: i64, weekday: i64, n: i64) -> String {
    let first = weekday_of(&format_iso(y, m, 1)).unwrap_or(0);
    format_iso(y, m, 1 + (weekday - first + 7).rem_euclid(7) + (n - 1) * 7)
}

/// `lastWeekdayOfMonth(y, m, weekday)`.
fn last_weekday(y: i64, m: i64, weekday: i64) -> String {
    let last = format_iso(y, m, days_in_month(y, m));
    let back = (weekday_of(&last).unwrap_or(0) - weekday + 7).rem_euclid(7);
    add_days(&last, -back).unwrap_or_default()
}

fn holidays_starting_in(year: i64) -> Vec<String> {
    let mut list = vec![
        observed(&format_iso(year, 1, 1), true),
        nth_weekday(year, 1, 1, 3),
        nth_weekday(year, 2, 1, 3),
        observed(&format_iso(year, 4, 16), true),
        last_weekday(year, 5, 1),
        observed(&format_iso(year, 6, 19), true),
        observed(&format_iso(year, 7, 4), true),
        nth_weekday(year, 9, 1, 1),
        nth_weekday(year, 10, 1, 2),
        observed(&format_iso(year, 11, 11), true),
        nth_weekday(year, 11, 4, 4),
        observed(&format_iso(year, 12, 25), true),
    ];
    if year >= 1937 && (year - 1937) % 4 == 0 {
        list.push(observed(&format_iso(year, 1, 20), false));
    }
    list
}

/// `isLegalHoliday(date)`: a federal legal holiday in Washington, DC (the
/// IRS's rule for due dates).
pub fn is_legal_holiday(date: &str) -> bool {
    let Ok(year) = date.get(..4).unwrap_or("").parse::<i64>() else {
        return false;
    };
    let prefix = format!("{year:04}-");
    holidays_starting_in(year)
        .into_iter()
        .chain(holidays_starting_in(year + 1))
        .any(|h| h.starts_with(&prefix) && h == date)
}

/// `isBusinessDay(date)`.
pub fn is_business_day(date: &str) -> bool {
    let weekday = weekday_of(date);
    weekday != Some(0) && weekday != Some(6) && !is_legal_holiday(date)
}

/// `rollToBusinessDay(date)`: the date, or the next business day.
pub fn roll_to_business_day(date: &str) -> String {
    let mut current = date.to_owned();
    for _ in 0..30 {
        if is_business_day(&current) {
            break;
        }
        match add_days(&current, 1) {
            Some(next) => current = next,
            None => break,
        }
    }
    current
}

/// `dateIn(y, m, day)`: month overflow rolls into the year, the day is
/// clamped to the month.
pub fn date_in(y: i64, m: i64, day: i64) -> String {
    let index = y * 12 + (m - 1);
    let year = index.div_euclid(12);
    let month = index.rem_euclid(12) + 1;
    format_iso(year, month, day.min(days_in_month(year, month)))
}

/// `TaxDeadline`, as JSON in the domain's key order.
#[derive(Debug, Clone, PartialEq)]
pub struct Deadline {
    pub key: String,
    pub kind: &'static str,
    pub title: String,
    pub due_date: String,
    pub nominal_date: String,
    pub form: String,
    pub tax_year: Option<i64>,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub agency_id: Option<String>,
    /// `Some(None)`: the agency's state, `null`.
    pub state_code: Option<Option<String>>,
    pub extension_form: Option<String>,
    pub informational: bool,
    pub note: Option<String>,
}

impl Deadline {
    fn new(key: String, kind: &'static str, title: String, form: &str, nominal: String) -> Self {
        Self {
            key,
            kind,
            title,
            due_date: roll_to_business_day(&nominal),
            nominal_date: nominal,
            form: form.to_owned(),
            tax_year: None,
            period_start: None,
            period_end: None,
            agency_id: None,
            state_code: None,
            extension_form: None,
            informational: false,
            note: None,
        }
    }

    /// The deadline as the API returns it (`undefined` fields left out).
    pub fn to_json(&self) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("key".into(), json!(self.key));
        out.insert("kind".into(), json!(self.kind));
        out.insert("title".into(), json!(self.title));
        out.insert("dueDate".into(), json!(self.due_date));
        out.insert("nominalDate".into(), json!(self.nominal_date));
        out.insert("form".into(), json!(self.form));
        if let Some(year) = self.tax_year {
            out.insert("taxYear".into(), json!(year));
        }
        if let Some(start) = &self.period_start {
            out.insert("periodStart".into(), json!(start));
        }
        if let Some(end) = &self.period_end {
            out.insert("periodEnd".into(), json!(end));
        }
        if let Some(agency) = &self.agency_id {
            out.insert("agencyId".into(), json!(agency));
        }
        if let Some(state) = &self.state_code {
            out.insert("stateCode".into(), json!(state));
        }
        if let Some(form) = &self.extension_form {
            out.insert("extensionForm".into(), json!(form));
        }
        if self.informational {
            out.insert("informational".into(), json!(true));
        }
        if let Some(note) = &self.note {
            out.insert("note".into(), json!(note));
        }
        out
    }
}

/// `TaxCalendarEntity`.
#[derive(Debug, Clone)]
pub struct CalendarEntity {
    /// `sch_c` | `f1065` | `f1120s` | `f1120` | `f990`.
    pub form: String,
    pub fiscal_year: Option<FiscalYearConfig>,
    pub has_payroll: bool,
    pub files_1099: bool,
    pub has_backup_withholding: bool,
}

/// `SalesTaxAgencyInput`.
#[derive(Debug, Clone)]
pub struct AgencyInput {
    pub id: String,
    pub name: Option<String>,
    pub state_code: Option<String>,
    /// `monthly` | `quarterly` | `semiannual` | `annual`.
    pub filing_frequency: String,
    /// `None`: `last`.
    pub due_day: Option<i64>,
    pub first_period_start: Option<String>,
    pub registered_until: Option<String>,
    pub status: Option<String>,
}

fn form_label(form: &str) -> &'static str {
    match form {
        "f1065" => "Form 1065",
        "f1120s" => "Form 1120-S",
        "f1120" => "Form 1120",
        "f990" => "Form 990",
        _ => "Schedule C (Form 1040)",
    }
}

fn extension_form(form: &str) -> &'static str {
    match form {
        "f1065" | "f1120s" | "f1120" => "Form 7004",
        "f990" => "Form 8868",
        _ => "Form 4868",
    }
}

#[allow(clippy::cast_possible_truncation)]
fn end_month_of(config: &FiscalYearConfig) -> i64 {
    match config {
        FiscalYearConfig::FiftyTwoFiftyThree { end_month, .. } => {
            (end_month.trunc() as i64).clamp(1, 12)
        }
        FiscalYearConfig::Month { start_month } => {
            let start = (start_month.trunc() as i64).clamp(1, 12);
            if start == 1 { 12 } else { start - 1 }
        }
    }
}

/// `incomeTaxDeadlines(entity, fiscalYear)`.
pub fn income_tax_deadlines(entity: &CalendarEntity, fiscal_year: i64) -> Vec<Deadline> {
    let calendar = FiscalYearConfig::Month { start_month: 1.0 };
    let config = if entity.form == "sch_c" {
        calendar
    } else {
        entity.fiscal_year.clone().unwrap_or(calendar)
    };
    let Some(year) = fiscal_year_for(&config, fiscal_year) else {
        return Vec::new();
    };
    let end_month = end_month_of(&config);
    let label = form_label(&entity.form);
    let (mut months_after_end, mut extension_months) = match entity.form.as_str() {
        "f1065" | "f1120s" => (3, 6),
        "f990" => (5, 6),
        _ => (4, 6),
    };
    if entity.form == "f1120"
        && matches!(config, FiscalYearConfig::Month { .. })
        && end_month == 6
        && year.start.as_str() < "2026-01-01"
    {
        months_after_end = 3;
        extension_months = 7;
    }
    let nominal = date_in(fiscal_year, end_month + months_after_end, 15);
    let base = |key: String, kind, title: String, nominal: String| {
        let mut d = Deadline::new(key, kind, title, &entity.form, nominal);
        d.tax_year = Some(fiscal_year);
        d.period_start = Some(year.start.clone());
        d.period_end = Some(year.end.clone());
        d
    };
    let mut first = base(
        format!("{}:{fiscal_year}", entity.form),
        "income_tax_return",
        format!("{label}, tax year {fiscal_year}"),
        nominal.clone(),
    );
    first.note = Some(format!(
        "File {} by this date to extend.",
        extension_form(&entity.form)
    ));
    let mut extended = base(
        format!("{}:{fiscal_year}:extended", entity.form),
        "income_tax_extended_return",
        format!("{label}, tax year {fiscal_year}, extended"),
        add_months(&nominal, extension_months).unwrap_or_default(),
    );
    extended.extension_form = Some(extension_form(&entity.form).to_owned());
    let mut out = vec![first, extended];
    if entity.form == "f1120" {
        for (index, (quarter, offset)) in [("q1", -8), ("q2", -6), ("q3", -3), ("q4", 0)]
            .into_iter()
            .enumerate()
        {
            let mut d = Deadline::new(
                format!("1120w:{fiscal_year}:{quarter}"),
                "estimated_tax",
                format!(
                    "Form 1120-W estimated tax, installment {}, tax year {fiscal_year}",
                    index + 1
                ),
                "1120w",
                date_in(fiscal_year, end_month + offset, 15),
            );
            d.tax_year = Some(fiscal_year);
            out.push(d);
        }
    }
    out
}

/// `estimatedTaxDeadlines(taxYear)`.
pub fn estimated_tax_deadlines(tax_year: i64) -> Vec<Deadline> {
    [
        format_iso(tax_year, 4, 15),
        format_iso(tax_year, 6, 15),
        format_iso(tax_year, 9, 15),
        format_iso(tax_year + 1, 1, 15),
    ]
    .into_iter()
    .enumerate()
    .map(|(index, nominal)| {
        let mut d = Deadline::new(
            format!("1040es:{tax_year}:q{}", index + 1),
            "estimated_tax",
            format!(
                "Form 1040-ES estimated tax, installment {}, tax year {tax_year}",
                index + 1
            ),
            "1040es",
            nominal,
        );
        d.tax_year = Some(tax_year);
        d.note = Some("Paid by the owner personally.".to_owned());
        d
    })
    .collect()
}

/// `information1099Deadlines(taxYear, { form945 })`.
pub fn information_1099_deadlines(tax_year: i64, form_945: bool) -> Vec<Deadline> {
    let next = tax_year + 1;
    let jan31 = format_iso(next, 1, 31);
    let mut items = vec![
        (
            "1099_nec_recipient",
            "1099_nec",
            format!("Form 1099-NEC recipient copies, tax year {tax_year}"),
            jan31.clone(),
        ),
        (
            "1099_nec_irs",
            "1099_nec",
            format!("Form 1099-NEC to the IRS, tax year {tax_year}"),
            jan31.clone(),
        ),
        (
            "1099_misc_recipient",
            "1099_misc",
            format!("Form 1099-MISC recipient copies, tax year {tax_year}"),
            jan31.clone(),
        ),
        (
            "1099_misc_irs_paper",
            "1099_misc",
            format!("Form 1099-MISC to the IRS on paper, tax year {tax_year}"),
            format_iso(next, 2, 28),
        ),
        (
            "1099_misc_irs_electronic",
            "1099_misc",
            format!("Form 1099-MISC to the IRS electronically, tax year {tax_year}"),
            format_iso(next, 3, 31),
        ),
    ];
    if form_945 {
        items.push((
            "945",
            "945",
            format!("Form 945 backup withholding, tax year {tax_year}"),
            jan31,
        ));
    }
    items
        .into_iter()
        .map(|(id, form, title, nominal)| {
            let mut d = Deadline::new(
                format!("{id}:{tax_year}"),
                "information_return",
                title,
                form,
                nominal,
            );
            d.tax_year = Some(tax_year);
            d
        })
        .collect()
}

/// `payrollDeadlines(taxYear)`: informational (the payroll provider files).
pub fn payroll_deadlines(tax_year: i64) -> Vec<Deadline> {
    let next = tax_year + 1;
    let mut out: Vec<Deadline> = [
        ("q1", format_iso(tax_year, 4, 30)),
        ("q2", format_iso(tax_year, 7, 31)),
        ("q3", format_iso(tax_year, 10, 31)),
        ("q4", format_iso(next, 1, 31)),
    ]
    .into_iter()
    .map(|(quarter, nominal)| {
        Deadline::new(
            format!("941:{tax_year}:{quarter}"),
            "payroll",
            format!("Form 941, {} {tax_year}", quarter.to_uppercase()),
            "941",
            nominal,
        )
    })
    .collect();
    out.push(Deadline::new(
        format!("940:{tax_year}"),
        "payroll",
        format!("Form 940, tax year {tax_year}"),
        "940",
        format_iso(next, 1, 31),
    ));
    out.push(Deadline::new(
        format!("w2:{tax_year}"),
        "payroll",
        format!("Forms W-2 and W-3, tax year {tax_year}"),
        "w2",
        format_iso(next, 1, 31),
    ));
    for d in &mut out {
        d.tax_year = Some(tax_year);
        d.informational = true;
    }
    out
}

fn by_due_date(a: &Deadline, b: &Deadline) -> std::cmp::Ordering {
    a.due_date.cmp(&b.due_date).then_with(|| a.key.cmp(&b.key))
}

fn period_months(frequency: &str) -> i64 {
    match frequency {
        "monthly" => 1,
        "semiannual" => 6,
        "annual" => 12,
        _ => 3,
    }
}

/// `agencyDeadlines(agencies, from, to)`: the sales tax returns due between
/// the dates (each period's return; the first period starts on the agency's
/// first period start).
pub fn agency_deadlines(agencies: &[AgencyInput], from: &str, to: &str) -> Vec<Deadline> {
    let mut out = Vec::new();
    for agency in agencies {
        let Some(first) = agency
            .first_period_start
            .as_deref()
            .filter(|f| !f.is_empty())
        else {
            continue;
        };
        if matches!(agency.status.as_deref(), Some("closed" | "monitoring")) {
            continue;
        }
        let length = period_months(&agency.filing_frequency);
        let Some(anchor) = start_of_month(first) else {
            continue;
        };
        for index in 0..1200 {
            let Some(grid_start) = add_months(&anchor, index * length) else {
                break;
            };
            if grid_start.as_str() > to {
                break;
            }
            if agency
                .registered_until
                .as_deref()
                .is_some_and(|u| !u.is_empty() && grid_start.as_str() > u)
            {
                break;
            }
            let period_start = if index == 0 {
                first.to_owned()
            } else {
                grid_start.clone()
            };
            let Some(period_end) =
                add_months(&grid_start, length - 1).and_then(|d| end_of_month(&d))
            else {
                break;
            };
            let Some(p) = parse_iso(&period_end) else {
                break;
            };
            let nominal = match agency.due_day {
                None => end_of_month(&date_in(p.y, p.m + 1, 1)).unwrap_or_default(),
                Some(day) => date_in(p.y, p.m + 1, day),
            };
            let due = roll_to_business_day(&nominal);
            if due.as_str() < from || due.as_str() > to {
                continue;
            }
            let who = agency
                .name
                .clone()
                .filter(|n| !n.is_empty())
                .or_else(|| agency.state_code.clone().filter(|s| !s.is_empty()))
                .unwrap_or_else(|| "Sales tax".to_owned());
            let mut d = Deadline::new(
                format!("sales_tax:{}:{period_end}", agency.id),
                "sales_tax",
                format!("{who} return, {period_start} to {period_end}"),
                "sales_tax",
                nominal,
            );
            d.due_date = due;
            d.period_start = Some(period_start);
            d.period_end = Some(period_end);
            d.agency_id = Some(agency.id.clone());
            d.state_code = Some(agency.state_code.clone());
            out.push(d);
        }
    }
    out.sort_by(by_due_date);
    out
}

/// `taxCalendar(entity, year, { agencies })`: the deadlines due in a
/// calendar year, by due date.
pub fn tax_calendar(
    entity: &CalendarEntity,
    year: i64,
    agencies: Option<&[AgencyInput]>,
) -> Vec<Deadline> {
    let from = format_iso(year, 1, 1);
    let to = format_iso(year, 12, 31);
    let mut all = Vec::new();
    for fiscal_year in (year - 2)..=(year + 1) {
        all.extend(income_tax_deadlines(entity, fiscal_year));
    }
    if matches!(entity.form.as_str(), "sch_c" | "f1065" | "f1120s") {
        for tax_year in [year - 1, year] {
            all.extend(estimated_tax_deadlines(tax_year));
        }
    }
    for tax_year in [year - 1, year] {
        if entity.files_1099 {
            all.extend(information_1099_deadlines(
                tax_year,
                entity.has_backup_withholding,
            ));
        }
        if entity.has_payroll {
            all.extend(payroll_deadlines(tax_year));
        }
    }
    if let Some(agencies) = agencies {
        all.extend(agency_deadlines(agencies, &from, &to));
    }
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Deadline> = all
        .into_iter()
        .filter(|d| d.due_date >= from && d.due_date <= to)
        .filter(|d| seen.insert(d.key.clone()))
        .collect();
    out.sort_by(by_due_date);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadlines_roll_past_weekends_and_holidays() {
        // 2026-01-19 is Martin Luther King, Jr. Day.
        assert!(is_legal_holiday("2026-01-19"));
        assert_eq!(roll_to_business_day("2026-01-17"), "2026-01-20");
        // DC Emancipation Day 2027 (a Friday): 16 April.
        assert!(is_legal_holiday("2027-04-16"));
        assert_eq!(date_in(2026, 14, 31), "2027-02-28");
        let agency = AgencyInput {
            id: "sta_tx".into(),
            name: Some("Texas Comptroller".into()),
            state_code: Some("TX".into()),
            filing_frequency: "quarterly".into(),
            due_day: Some(20),
            first_period_start: Some("2026-02-10".into()),
            registered_until: None,
            status: Some("registered".into()),
        };
        let found = agency_deadlines(&[agency], "2026-01-01", "2026-12-31");
        assert_eq!(found[0].period_start.as_deref(), Some("2026-02-10"));
        assert_eq!(found[0].period_end.as_deref(), Some("2026-04-30"));
        assert_eq!(found[0].due_date, "2026-05-20");
    }
}
