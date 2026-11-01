//! The US sales tax return worksheet per agency and period, from tax-ledger
//! rows (`jurisdictions/us/sales-tax-return.ts`), and its CSV artifact.
//!
//! The ledger has one row per document line per jurisdiction, so a line's
//! gross and its exemptions are read once, from the line's highest-level row,
//! while tax and taxable sales per location come from every row. Credit memos
//! and bad-debt write-offs are negative rows: they count as returns and bad
//! debts. Money is summed in whole cents.

use serde_json::{Map, Value, json};

use super::dates::{add_days, iso_day};
use super::rounding::{from_cents, to_cents};
use crate::js::{locale_compare, number_text, number_value, parse_float, to_fixed};

/// `WORKSHEET_DEDUCTION_KEYS`.
pub const WORKSHEET_DEDUCTION_KEYS: [&str; 11] = [
    "resale",
    "nonprofit",
    "government",
    "manufacturing",
    "agricultural",
    "other_exempt",
    "non_taxable",
    "exempt_freight",
    "marketplace",
    "returns",
    "bad_debts",
];

fn deduction_label(key: &str) -> &'static str {
    match key {
        "resale" => "Sales for resale",
        "nonprofit" => "Sales to nonprofit organizations",
        "government" => "Sales to government",
        "manufacturing" => "Sales to manufacturers",
        "agricultural" => "Agricultural sales",
        "other_exempt" => "Other exempt sales",
        "non_taxable" => "Non-taxable sales",
        "exempt_freight" => "Exempt freight and delivery",
        "marketplace" => "Marketplace-facilitated sales",
        "returns" => "Returns and allowances",
        _ => "Bad debts written off",
    }
}

/// A tax-ledger row as the worksheet reads it (`SalesTaxWorksheetLine`,
/// built by `toWorksheetLine`).
#[derive(Debug, Clone, Default)]
pub struct WorksheetLine {
    pub tax_rate_id: String,
    pub tax_category_code: String,
    pub taxable_amount: f64,
    pub tax_amount: f64,
    /// `sales` | `purchase`.
    pub direction: String,
    pub self_assessed: bool,
    /// `sales` | `use`.
    pub kind: String,
    pub agency_id: Option<String>,
    pub state_code: Option<String>,
    pub jurisdiction_code: Option<String>,
    pub jurisdiction_name: Option<String>,
    pub jurisdiction_level: Option<String>,
    pub reporting_code: Option<String>,
    pub rate: f64,
    pub gross_amount: Option<f64>,
    pub exempt_amount: Option<f64>,
    pub non_taxable_amount: Option<f64>,
    pub exempt_reason: Option<String>,
    pub tax_code: Option<String>,
    pub ship_to_state: Option<String>,
    pub marketplace_facilitated: bool,
    pub source_type: String,
    pub source_id: Option<String>,
    pub source_line_id: Option<String>,
    pub certificate_id: Option<String>,
    pub tax_date: String,
}

/// `SalesTaxWorksheetOptions`.
#[derive(Debug, Clone)]
pub struct WorksheetOptions<'a> {
    pub agency_id: &'a str,
    pub state_code: &'a str,
    pub period_start: &'a str,
    pub period_end: &'a str,
    pub reporting_basis: &'a str,
    pub as_of: Option<&'a str>,
}

/// `SalesTaxWorksheetLocation`.
#[derive(Debug, Clone)]
pub struct WorksheetLocation {
    pub jurisdiction_code: String,
    pub jurisdiction_name: String,
    pub level: String,
    pub reporting_code: String,
    pub rate: f64,
    pub taxable_sales: f64,
    pub tax: f64,
}

impl WorksheetLocation {
    /// The location as JSON, after `extra` (`{ kind, ...location }`).
    pub fn to_json(&self, extra: Option<(&str, &str)>) -> Value {
        let mut out = Map::new();
        if let Some((key, value)) = extra {
            out.insert(key.to_owned(), json!(value));
        }
        out.insert("jurisdictionCode".into(), json!(self.jurisdiction_code));
        out.insert("jurisdictionName".into(), json!(self.jurisdiction_name));
        out.insert("level".into(), json!(self.level));
        out.insert("reportingCode".into(), json!(self.reporting_code));
        out.insert("rate".into(), number_value(self.rate));
        out.insert("taxableSales".into(), number_value(self.taxable_sales));
        out.insert("tax".into(), number_value(self.tax));
        Value::Object(out)
    }
}

/// `uncuredExempt`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Uncured {
    pub sales: f64,
    pub tax: f64,
    pub lines: i64,
}

/// `SalesTaxWorksheet`.
#[derive(Debug, Clone)]
pub struct Worksheet {
    pub agency_id: String,
    pub state_code: String,
    pub period_start: String,
    pub period_end: String,
    pub reporting_basis: String,
    pub gross_sales: f64,
    /// In `WORKSHEET_DEDUCTION_KEYS` order.
    pub deductions: Vec<(&'static str, f64)>,
    pub total_deductions: f64,
    pub taxable_sales: f64,
    pub sales_tax_due: f64,
    pub use_tax_due: f64,
    pub total_tax_due: f64,
    pub by_location: Vec<WorksheetLocation>,
    pub use_tax_by_location: Vec<WorksheetLocation>,
    pub document_count: i64,
    pub uncured_exempt: Uncured,
}

impl Worksheet {
    pub fn deduction(&self, key: &str) -> f64 {
        self.deductions
            .iter()
            .find(|(k, _)| *k == key)
            .map_or(0.0, |(_, v)| *v)
    }

    /// `deductions` as JSON.
    pub fn deductions_json(&self) -> Value {
        Value::Object(
            self.deductions
                .iter()
                .map(|(k, v)| ((*k).to_owned(), number_value(*v)))
                .collect(),
        )
    }

    /// `uncuredExempt` as JSON.
    pub fn uncured_json(&self) -> Value {
        json!({
            "sales": number_value(self.uncured_exempt.sales),
            "tax": number_value(self.uncured_exempt.tax),
            "lines": self.uncured_exempt.lines,
        })
    }
}

fn rank(level: Option<&str>) -> i64 {
    match level.unwrap_or("") {
        "state" => 0,
        "county" => 1,
        "city" => 2,
        "district" => 3,
        _ => 4,
    }
}

/// `rank` of a jurisdiction level (`LEVEL_RANK[level] ?? 4`).
pub fn level_rank(level: Option<&str>) -> i64 {
    rank(level)
}

fn cents(value: Option<f64>) -> i64 {
    to_cents(value.unwrap_or(0.0))
}

fn row_gross_cents(row: &WorksheetLine) -> i64 {
    match row.gross_amount {
        Some(gross) => to_cents(gross),
        None => {
            to_cents(row.taxable_amount) + cents(row.exempt_amount) + cents(row.non_taxable_amount)
        }
    }
}

fn exempt_key(reason: Option<&str>) -> &'static str {
    match reason {
        Some("resale") => "resale",
        Some("nonprofit") => "nonprofit",
        Some("government") => "government",
        Some("manufacturing") => "manufacturing",
        Some("agricultural") => "agricultural",
        _ => "other_exempt",
    }
}

struct LocationAcc {
    location: WorksheetLocation,
    taxable_cents: i64,
    tax_cents: i64,
}

fn add_location(map: &mut Vec<(String, LocationAcc)>, row: &WorksheetLine, taxable: i64, tax: i64) {
    let key = format!(
        "{}|{}|{}",
        row.jurisdiction_code.as_deref().unwrap_or(""),
        row.reporting_code.as_deref().unwrap_or(""),
        number_text(row.rate)
    );
    let index = if let Some(i) = map.iter().position(|(k, _)| *k == key) {
        i
    } else {
        map.push((
            key,
            LocationAcc {
                location: WorksheetLocation {
                    jurisdiction_code: row.jurisdiction_code.clone().unwrap_or_default(),
                    jurisdiction_name: row
                        .jurisdiction_name
                        .clone()
                        .or_else(|| row.jurisdiction_code.clone())
                        .unwrap_or_default(),
                    level: row.jurisdiction_level.clone().unwrap_or_default(),
                    reporting_code: row.reporting_code.clone().unwrap_or_default(),
                    rate: row.rate,
                    taxable_sales: 0.0,
                    tax: 0.0,
                },
                taxable_cents: 0,
                tax_cents: 0,
            },
        ));
        map.len() - 1
    };
    map[index].1.taxable_cents += taxable;
    map[index].1.tax_cents += tax;
}

fn locations_of(map: Vec<(String, LocationAcc)>) -> Vec<WorksheetLocation> {
    let mut accs: Vec<LocationAcc> = map
        .into_iter()
        .map(|(_, acc)| acc)
        .filter(|a| a.taxable_cents != 0 || a.tax_cents != 0)
        .collect();
    accs.sort_by(|a, b| {
        rank(Some(&a.location.level))
            .cmp(&rank(Some(&b.location.level)))
            .then_with(|| {
                locale_compare(&a.location.jurisdiction_name, &b.location.jurisdiction_name)
            })
            .then_with(|| a.location.rate.total_cmp(&b.location.rate))
    });
    accs.into_iter()
        .map(|a| WorksheetLocation {
            taxable_sales: from_cents(a.taxable_cents),
            tax: from_cents(a.tax_cents),
            ..a.location
        })
        .collect()
}

/// `buildUsSalesTaxWorksheet(lines, opts)`.
#[allow(
    clippy::too_many_lines,
    reason = "mirrors sales-tax-return.ts's buildUsSalesTaxWorksheet()"
)]
pub fn build_us_sales_tax_worksheet(lines: &[WorksheetLine], opts: &WorksheetOptions<'_>) -> Worksheet {
    let start = iso_day(opts.period_start);
    let end = iso_day(opts.period_end);
    let rows: Vec<&WorksheetLine> = lines
        .iter()
        .filter(|row| {
            if row.agency_id.as_deref().unwrap_or("") != opts.agency_id {
                return false;
            }
            if !row.tax_date.is_empty() {
                let day = iso_day(&row.tax_date);
                if day < start || day > end {
                    return false;
                }
            }
            row.kind == "use" || row.direction != "purchase"
        })
        .collect();

    let mut gross: i64 = 0;
    let mut deductions: Vec<(&'static str, i64)> =
        WORKSHEET_DEDUCTION_KEYS.iter().map(|k| (*k, 0)).collect();
    let add_deduction = |deductions: &mut Vec<(&'static str, i64)>, key: &str, value: i64| {
        if let Some(entry) = deductions.iter_mut().find(|(k, _)| *k == key) {
            entry.1 += value;
        }
    };
    let mut sales_tax: i64 = 0;
    let mut use_tax: i64 = 0;
    let mut locations: Vec<(String, LocationAcc)> = Vec::new();
    let mut use_locations: Vec<(String, LocationAcc)> = Vec::new();
    let mut documents: Vec<String> = Vec::new();
    let mut uncured_sales: i64 = 0;
    let mut uncured_tax: i64 = 0;
    let mut uncured_lines: i64 = 0;

    let mut groups: Vec<(String, Vec<&WorksheetLine>)> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        if row.kind == "use" {
            continue;
        }
        let key = format!(
            "{}|{}|{}",
            row.source_type,
            row.source_id.as_deref().unwrap_or(""),
            row.source_line_id
                .clone()
                .unwrap_or_else(|| format!("#{index}"))
        );
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(row),
            None => groups.push((key, vec![row])),
        }
    }

    for (group_key, group) in &groups {
        let mut sorted = group.clone();
        sorted.sort_by(|a, b| {
            rank(a.jurisdiction_level.as_deref())
                .cmp(&rank(b.jurisdiction_level.as_deref()))
                .then_with(|| {
                    locale_compare(
                        a.jurisdiction_code.as_deref().unwrap_or(""),
                        b.jurisdiction_code.as_deref().unwrap_or(""),
                    )
                })
        });
        let anchor = sorted[0];
        let source_type = anchor.source_type.as_str();
        let is_return = matches!(source_type, "credit_note" | "reversal");
        let is_bad_debt = matches!(source_type, "write_off" | "bad_debt");

        let g = row_gross_cents(anchor);
        let document = match anchor.source_id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => format!("{source_type}|{id}"),
            None => group_key.clone(),
        };
        if !documents.contains(&document) {
            documents.push(document);
        }
        if !is_return && !is_bad_debt {
            gross += g;
        }
        if is_return {
            add_deduction(&mut deductions, "returns", -g);
        }
        if is_bad_debt {
            add_deduction(&mut deductions, "bad_debts", -g);
        }
        if anchor.marketplace_facilitated {
            add_deduction(&mut deductions, "marketplace", g);
            continue;
        }
        let exempt = cents(anchor.exempt_amount);
        let non_taxable = cents(anchor.non_taxable_amount);
        let cure = (!anchor.tax_date.is_empty())
            .then(|| add_days(&iso_day(&anchor.tax_date), 90))
            .flatten();
        let is_uncured = match (opts.as_of, &cure) {
            (Some(as_of), Some(cure)) => {
                exempt > 0
                    && anchor.certificate_id.as_deref().is_none_or(str::is_empty)
                    && *cure < iso_day(as_of)
            }
            _ => false,
        };
        if is_uncured {
            uncured_lines += 1;
            uncured_sales += exempt;
            for row in group {
                let row_exempt = cents(row.exempt_amount);
                let extra_tax = to_cents(from_cents(row_exempt) * (row.rate / 100.0));
                uncured_tax += extra_tax;
                sales_tax += extra_tax;
                add_location(&mut locations, row, row_exempt, extra_tax);
            }
        } else if exempt != 0 {
            add_deduction(
                &mut deductions,
                exempt_key(anchor.exempt_reason.as_deref()),
                exempt,
            );
        }
        if non_taxable != 0 {
            let key = if matches!(anchor.tax_code.as_deref(), Some("shipping" | "handling")) {
                "exempt_freight"
            } else {
                "non_taxable"
            };
            add_deduction(&mut deductions, key, non_taxable);
        }
    }

    for row in &rows {
        if row.kind == "use" {
            use_tax += to_cents(row.tax_amount);
            add_location(
                &mut use_locations,
                row,
                to_cents(row.taxable_amount),
                to_cents(row.tax_amount),
            );
            continue;
        }
        sales_tax += to_cents(row.tax_amount);
        add_location(
            &mut locations,
            row,
            to_cents(row.taxable_amount),
            to_cents(row.tax_amount),
        );
    }

    let total_deductions: i64 = deductions.iter().map(|(_, v)| *v).sum();
    Worksheet {
        agency_id: opts.agency_id.to_owned(),
        state_code: opts.state_code.to_owned(),
        period_start: start,
        period_end: end,
        reporting_basis: opts.reporting_basis.to_owned(),
        gross_sales: from_cents(gross),
        deductions: deductions
            .into_iter()
            .map(|(k, v)| (k, from_cents(v)))
            .collect(),
        total_deductions: from_cents(total_deductions),
        taxable_sales: from_cents(gross - total_deductions),
        sales_tax_due: from_cents(sales_tax),
        use_tax_due: from_cents(use_tax),
        total_tax_due: from_cents(sales_tax + use_tax),
        by_location: locations_of(locations),
        use_tax_by_location: locations_of(use_locations),
        document_count: i64::try_from(documents.len()).unwrap_or(i64::MAX),
        uncured_exempt: Uncured {
            sales: from_cents(uncured_sales),
            tax: from_cents(uncured_tax),
            lines: uncured_lines,
        },
    }
}

/// A CSV cell: a number with two decimals, quoted when it needs to be.
pub fn csv_cell_number(value: f64) -> String {
    csv_cell(&to_fixed(value, 2))
}

/// A CSV cell of text, quoted when it holds `"`, `,` or a line break.
pub fn csv_cell(text: &str) -> String {
    if text.contains(['"', ',', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_owned()
    }
}

enum Cell<'a> {
    Text(&'a str),
    Number(f64),
}

fn csv_row(cells: &[Cell<'_>]) -> String {
    cells
        .iter()
        .map(|c| match c {
            Cell::Text(t) => csv_cell(t),
            Cell::Number(n) => csv_cell_number(*n),
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn rate_percent(rate: f64) -> String {
    number_text(parse_float(&to_fixed(rate, 4)))
}

fn worksheet_csv(ws: &Worksheet, entity_name: &str) -> Vec<String> {
    use Cell::{Number, Text};
    let documents = ws.document_count.to_string();
    let mut out = vec![
        csv_row(&[Text("Sales tax return worksheet")]),
        csv_row(&[Text("Entity"), Text(entity_name)]),
        csv_row(&[Text("State"), Text(&ws.state_code)]),
        csv_row(&[Text("Agency"), Text(&ws.agency_id)]),
        csv_row(&[Text("Period start"), Text(&ws.period_start)]),
        csv_row(&[Text("Period end"), Text(&ws.period_end)]),
        csv_row(&[Text("Reporting basis"), Text(&ws.reporting_basis)]),
        csv_row(&[Text("Documents"), Text(&documents)]),
        String::new(),
        csv_row(&[Text("Line"), Text("Amount")]),
        csv_row(&[Text("Gross sales"), Number(ws.gross_sales)]),
    ];
    for (key, value) in &ws.deductions {
        if *value != 0.0 {
            let label = format!("Less: {}", deduction_label(key));
            out.push(csv_row(&[Text(&label), Number(*value)]));
        }
    }
    out.push(csv_row(&[Text("Total deductions"), Number(ws.total_deductions)]));
    out.push(csv_row(&[Text("Taxable sales"), Number(ws.taxable_sales)]));
    out.push(csv_row(&[Text("Sales tax due"), Number(ws.sales_tax_due)]));
    out.push(csv_row(&[Text("Use tax due"), Number(ws.use_tax_due)]));
    out.push(csv_row(&[Text("Total tax due"), Number(ws.total_tax_due)]));
    if ws.uncured_exempt.lines > 0 {
        out.push(csv_row(&[
            Text("Exempt sales without a certificate, counted as taxable"),
            Number(ws.uncured_exempt.sales),
        ]));
        out.push(csv_row(&[
            Text("Tax on those sales"),
            Number(ws.uncured_exempt.tax),
        ]));
    }
    let mut section = |title: &str, locations: &[WorksheetLocation]| {
        if locations.is_empty() {
            return;
        }
        out.push(String::new());
        out.push(csv_row(&[Text(title)]));
        out.push(csv_row(&[
            Text("Location code"),
            Text("Location"),
            Text("Level"),
            Text("Reporting code"),
            Text("Rate (%)"),
            Text("Taxable sales"),
            Text("Tax"),
        ]));
        for l in locations {
            let rate = rate_percent(l.rate);
            out.push(csv_row(&[
                Text(&l.jurisdiction_code),
                Text(&l.jurisdiction_name),
                Text(&l.level),
                Text(&l.reporting_code),
                Text(&rate),
                Number(l.taxable_sales),
                Number(l.tax),
            ]));
        }
    };
    section("Tax by location", &ws.by_location);
    section("Use tax by location", &ws.use_tax_by_location);
    out
}

/// `TaxReturnArtifact`.
#[derive(Debug, Clone)]
pub struct ReturnArtifact {
    pub filename: String,
    pub mime_type: String,
    pub content: String,
    /// `summary`, in the domain's key order.
    pub summary: Vec<(String, f64)>,
}

impl ReturnArtifact {
    pub fn to_json(&self) -> Value {
        json!({
            "filename": self.filename,
            "mimeType": self.mime_type,
            "content": self.content,
            "summary": Value::Object(
                self.summary
                    .iter()
                    .map(|(k, v)| (k.clone(), number_value(*v)))
                    .collect()
            ),
        })
    }
}

/// `buildUsSalesTaxReturn(entity, periodStart, periodEnd, lines)`: the
/// worksheet as a CSV file, one section per agency of the lines.
/// `accounting_method` is the entity's (`cash` or else accrual).
pub fn build_us_sales_tax_return(
    entity_name: &str,
    accounting_method: &str,
    period_start: &str,
    period_end: &str,
    lines: &[WorksheetLine],
) -> ReturnArtifact {
    let reporting_basis = if accounting_method == "cash" {
        "cash"
    } else {
        "accrual"
    };
    let mut agency_ids: Vec<String> = Vec::new();
    for row in lines {
        let id = row.agency_id.clone().unwrap_or_default();
        if !agency_ids.contains(&id) {
            agency_ids.push(id);
        }
    }
    if agency_ids.is_empty() {
        agency_ids.push(String::new());
    }
    let mut states: Vec<String> = Vec::new();
    for row in lines {
        if let Some(state) = row.state_code.as_deref().filter(|s| !s.is_empty())
            && !states.iter().any(|s| s == state)
        {
            states.push(state.to_owned());
        }
    }
    let state_code = if states.len() == 1 {
        states[0].clone()
    } else {
        String::new()
    };
    let worksheets: Vec<Worksheet> = agency_ids
        .iter()
        .map(|agency_id| {
            let state = lines
                .iter()
                .find(|r| {
                    r.agency_id.as_deref().unwrap_or("") == agency_id
                        && r.state_code.as_deref().is_some_and(|s| !s.is_empty())
                })
                .and_then(|r| r.state_code.clone())
                .unwrap_or_else(|| state_code.clone());
            build_us_sales_tax_worksheet(
                lines,
                &WorksheetOptions {
                    agency_id,
                    state_code: &state,
                    period_start,
                    period_end,
                    reporting_basis,
                    as_of: None,
                },
            )
        })
        .collect();
    let content = worksheets
        .iter()
        .enumerate()
        .map(|(i, ws)| {
            let mut rows = worksheet_csv(ws, entity_name);
            if i > 0 {
                rows.insert(0, String::new());
            }
            rows.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let sum = |pick: &dyn Fn(&Worksheet) -> f64| {
        from_cents(worksheets.iter().map(|ws| to_cents(pick(ws))).sum())
    };
    let mut summary: Vec<(String, f64)> = vec![
        ("grossSales".into(), sum(&|ws| ws.gross_sales)),
        ("totalDeductions".into(), sum(&|ws| ws.total_deductions)),
        ("taxableSales".into(), sum(&|ws| ws.taxable_sales)),
        ("salesTaxDue".into(), sum(&|ws| ws.sales_tax_due)),
        ("useTaxDue".into(), sum(&|ws| ws.use_tax_due)),
        ("totalTaxDue".into(), sum(&|ws| ws.total_tax_due)),
        #[allow(clippy::cast_precision_loss)]
        (
            "documentCount".into(),
            worksheets.iter().map(|ws| ws.document_count).sum::<i64>() as f64,
        ),
    ];
    for key in WORKSHEET_DEDUCTION_KEYS {
        summary.push((format!("deduction_{key}"), sum(&|ws| ws.deduction(key))));
    }
    let label = if state_code.is_empty() {
        "all".to_owned()
    } else {
        state_code.to_lowercase()
    };
    ReturnArtifact {
        filename: format!(
            "sales-tax-{label}-{}-{}.csv",
            iso_day(period_start),
            iso_day(period_end)
        ),
        mime_type: "text/csv".to_owned(),
        content,
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(line: &str, code: &str, level: &str, taxable: f64, tax: f64) -> WorksheetLine {
        WorksheetLine {
            taxable_amount: taxable,
            tax_amount: tax,
            direction: "sales".into(),
            kind: "sales".into(),
            agency_id: Some("agy".into()),
            state_code: Some("TX".into()),
            jurisdiction_code: Some(code.into()),
            jurisdiction_name: Some(code.into()),
            jurisdiction_level: Some(level.into()),
            rate: 6.25,
            gross_amount: Some(taxable),
            source_type: "invoice".into(),
            source_id: Some("inv".into()),
            source_line_id: Some(line.into()),
            tax_date: "2026-07-10".into(),
            ..WorksheetLine::default()
        }
    }

    #[test]
    fn gross_counts_once_per_line() {
        let lines = vec![
            row("l1", "TX-CITY", "city", 1000.0, 20.0),
            row("l1", "TX-STATE", "state", 1000.0, 62.5),
        ];
        let ws = build_us_sales_tax_worksheet(
            &lines,
            &WorksheetOptions {
                agency_id: "agy",
                state_code: "TX",
                period_start: "2026-07-01",
                period_end: "2026-09-30",
                reporting_basis: "accrual",
                as_of: None,
            },
        );
        assert!((ws.gross_sales - 1000.0).abs() < 1e-9);
        assert!((ws.sales_tax_due - 82.5).abs() < 1e-9);
        assert_eq!(ws.by_location[0].jurisdiction_code, "TX-STATE");
        assert_eq!(ws.document_count, 1);
        let artifact = build_us_sales_tax_return("A, Inc", "accrual", "2026-07-01", "2026-09-30", &lines);
        assert_eq!(artifact.filename, "sales-tax-tx-2026-07-01-2026-09-30.csv");
        assert!(artifact.content.contains("Entity,\"A, Inc\""));
        assert!(artifact.content.contains("TX-STATE,TX-STATE,state,,6.25,1000.00,62.50"));
    }
}
