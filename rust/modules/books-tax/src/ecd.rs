//! SPED ECD, leiaute 9 (books-domain's `jurisdictions/br/ecd`, books-api's
//! `br-ecd`): the posted journal of a fiscal year as the Livro Diário file
//! the contador imports into the PGE. Blocks 0, I (chart, monthly balances,
//! journal, result balances), J (statements, closing term, signatories) and
//! 9 (register counts); a closing entry is generated when the ledger has
//! none. Fields are `|`-separated, dates `ddmmaaaa`, amounts with a decimal
//! comma; the route encodes the text as ISO-8859-1.

use std::collections::HashMap;

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_books_domain::js::{self, locale_compare, round_money as r2};
use weldsuite_books_domain::jurisdictions::js_trim;
use weldsuite_books_domain::posting::{account_for_role, load_entity_accounts};

/// `EcdSignatory`, as the body validated it.
#[derive(Debug, Clone)]
pub(crate) struct Signatory {
    pub name: String,
    pub tax_id: String,
    pub code: String,
    pub qualification: String,
    pub crc: Option<String>,
    pub crc_uf: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub legal_representative: bool,
}

struct Account {
    code: String,
    name: String,
    kind: String,
}

struct Line {
    account_code: String,
    debit: f64,
    credit: f64,
    description: Option<String>,
}

struct Entry {
    id: String,
    date: String,
    description: Option<String>,
    lines: Vec<Line>,
    closing: bool,
}

struct Company {
    name: String,
    cnpj: String,
    uf: String,
    ie: Option<String>,
    municipality_code: Option<String>,
    municipality_name: Option<String>,
    im: Option<String>,
}

struct Input {
    period_start: String,
    period_end: String,
    company: Company,
    accounts: Vec<Account>,
    opening: HashMap<String, f64>,
    entries: Vec<Entry>,
    retained_code: String,
    signatories: Vec<Signatory>,
}

/// `EcdResult`.
pub(crate) struct Ecd {
    pub content: String,
    pub warnings: Vec<String>,
}

fn amount(n: f64) -> String {
    js::to_fixed(r2(n).abs(), 2).replacen('.', ",", 1)
}

fn dc(balance: f64) -> &'static str {
    if balance < 0.0 { "C" } else { "D" }
}

fn ddmmaaaa(iso: &str) -> String {
    let day: String = iso.chars().take(10).collect();
    let parts: Vec<&str> = day.split('-').collect();
    format!(
        "{}{}{}",
        parts.get(2).unwrap_or(&""),
        parts.get(1).unwrap_or(&""),
        parts.first().unwrap_or(&"")
    )
}

/// `text(value)`: no pipes or line breaks.
fn text(value: Option<&str>) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in value.unwrap_or_default().chars() {
        if matches!(c, '|' | '\r' | '\n') {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            out.push(c);
            in_run = false;
        }
    }
    js_trim(&out).to_owned()
}

fn synthetic_name(code: &str) -> String {
    match code {
        "1" => "ATIVO",
        "1.1" => "ATIVO CIRCULANTE",
        "1.2" => "ATIVO NAO CIRCULANTE",
        "2" => "PASSIVO E PATRIMONIO LIQUIDO",
        "2.1" => "PASSIVO CIRCULANTE",
        "2.2" => "PASSIVO NAO CIRCULANTE",
        "2.3" => "PATRIMONIO LIQUIDO",
        "3" => "RECEITAS",
        "3.1" => "RECEITA OPERACIONAL",
        "3.2" => "OUTRAS RECEITAS",
        "4" => "CUSTOS E DESPESAS",
        "4.1" => "CUSTOS",
        "4.2" => "DESPESAS OPERACIONAIS",
        "4.3" => "DESPESAS FINANCEIRAS E OUTRAS",
        "4.9" => "TRIBUTOS SOBRE O LUCRO",
        other => return format!("GRUPO {other}"),
    }
    .to_owned()
}

fn nature_root(kind: &str) -> &'static str {
    match kind {
        "asset" => "1",
        "liability" | "equity" => "2",
        "revenue" => "3",
        // `NATURE_ROOT[type]`: anything else has no root (`undefined`).
        _ => "4",
    }
}

fn nature_code(kind: Option<&str>, code: &str) -> &'static str {
    match kind {
        Some("asset") => "01",
        Some("liability") => "02",
        Some("equity") => "03",
        Some("revenue" | "expense") => "04",
        _ if code.starts_with('1') => "01",
        _ if code.starts_with("2.3") => "03",
        _ if code.starts_with('2') => "02",
        _ => "04",
    }
}

#[derive(Debug, Clone)]
struct Node {
    code: String,
    name: String,
    level: i64,
    parent: Option<String>,
    synthetic: bool,
    nature: &'static str,
}

/// `buildChart(accounts)`: the chart with synthetic parents.
fn build_chart(accounts: &[Account]) -> Vec<Node> {
    let mut nodes: Vec<Node> = Vec::new();
    let add_synthetic =
        |nodes: &mut Vec<Node>, code: String, level: i64, parent: Option<String>| {
            if nodes.iter().any(|n| n.code == code) {
                return;
            }
            nodes.push(Node {
                name: synthetic_name(&code),
                nature: nature_code(None, &code),
                code,
                level,
                parent,
                synthetic: true,
            });
        };
    for account in accounts {
        let parts: Vec<&str> = account.code.split('.').collect();
        let parent = if parts.len() > 1 {
            for i in 1..parts.len() {
                let parent = (i > 1).then(|| parts[..i - 1].join("."));
                #[allow(clippy::cast_possible_wrap)]
                add_synthetic(&mut nodes, parts[..i].join("."), i as i64, parent);
            }
            parts[..parts.len() - 1].join(".")
        } else {
            let root = nature_root(&account.kind).to_owned();
            add_synthetic(&mut nodes, root.clone(), 1, None);
            root
        };
        let level = nodes
            .iter()
            .find(|n| n.code == parent)
            .map_or(0, |n| n.level)
            + 1;
        let node = Node {
            code: account.code.clone(),
            name: account.name.clone(),
            level,
            parent: Some(parent),
            synthetic: false,
            nature: nature_code(Some(&account.kind), &account.code),
        };
        // `Map.set` on an existing key keeps its place.
        if let Some(existing) = nodes.iter_mut().find(|n| n.code == account.code) {
            *existing = node;
        } else {
            nodes.push(node);
        }
    }
    let order = |code: &str| {
        code.split('.')
            .map(|p| {
                let width = js::utf16_len(p);
                if width >= 4 {
                    p.to_owned()
                } else {
                    format!("{}{p}", "0".repeat(4 - width))
                }
            })
            .collect::<Vec<_>>()
            .join(".")
    };
    nodes.sort_by(|a, b| locale_compare(&order(&a.code), &order(&b.code)));
    nodes
}

/// `monthsOf(start, end)`.
fn months_of(start: &str, end: &str) -> Vec<(String, String)> {
    let parse = |d: &str| {
        (
            js::parse_int(&d[..4]).unwrap_or(0),
            js::parse_int(&d[5..7]).unwrap_or(1),
        )
    };
    let (sy, sm) = parse(start);
    let (ey, em) = parse(end);
    let mut months = Vec::new();
    for index in (sy * 12 + sm - 1)..(ey * 12 + em) {
        let (y, m) = (index.div_euclid(12), index.rem_euclid(12) + 1);
        let first = format!("{y}-{m:02}-01");
        let next = js::days_from_civil(y + m / 12, m % 12 + 1, 1);
        let last_day = js::civil_from_days(next - 1).2;
        let last = format!("{y}-{m:02}-{last_day:02}");
        months.push((
            if first.as_str() < start {
                start.to_owned()
            } else {
                first
            },
            if last.as_str() > end {
                end.to_owned()
            } else {
                last
            },
        ));
    }
    months
}

struct Emitter {
    lines: Vec<String>,
    counts: Vec<(String, i64)>,
}

impl Emitter {
    fn emit(&mut self, fields: &[String]) {
        let reg = fields[0].clone();
        if let Some(count) = self.counts.iter_mut().find(|(r, _)| *r == reg) {
            count.1 += 1;
        } else {
            self.counts.push((reg, 1));
        }
        self.lines.push(format!("|{}|", fields.join("|")));
    }
}

macro_rules! emit {
    ($e:expr, $($field:expr),+ $(,)?) => {
        $e.emit(&[$(($field).to_string()),+])
    };
}

/// `buildEcd(input)`.
#[allow(clippy::too_many_lines)] // the file's blocks in order, as TypeScript
fn build_ecd(input: Input) -> Ecd {
    let mut warnings: Vec<String> = Vec::new();
    let mut out = Emitter {
        lines: Vec::new(),
        counts: Vec::new(),
    };
    let chart = build_chart(&input.accounts);
    let analytical: Vec<&Node> = chart.iter().filter(|n| !n.synthetic).collect();
    let by_code: HashMap<&str, &Node> = chart.iter().map(|n| (n.code.as_str(), n)).collect();
    let cnpj: String = input
        .company
        .cnpj
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_uppercase();
    let start = input.period_start.as_str();
    let end = input.period_end.as_str();

    // The period's entries on known accounts, without zero lines, by date.
    let mut entries: Vec<Entry> = input
        .entries
        .into_iter()
        .filter(|e| e.date.as_str() >= start && e.date.as_str() <= end)
        .map(|mut e| {
            e.lines.retain(|l| {
                by_code.contains_key(l.account_code.as_str()) && (l.debit != 0.0 || l.credit != 0.0)
            });
            e
        })
        .filter(|e| !e.lines.is_empty())
        .collect();
    entries.sort_by(|a, b| {
        locale_compare(&a.date, &b.date).then_with(|| locale_compare(&a.id, &b.id))
    });

    let opening = |code: &str| input.opening.get(code).copied().unwrap_or(0.0);
    let mut before_closing: HashMap<String, f64> = analytical
        .iter()
        .map(|n| (n.code.clone(), opening(&n.code)))
        .collect();
    for entry in entries.iter().filter(|e| !e.closing) {
        for l in &entry.lines {
            let balance = before_closing.entry(l.account_code.clone()).or_insert(0.0);
            *balance = *balance + l.debit - l.credit;
        }
    }
    let result_accounts: Vec<&Node> = analytical
        .iter()
        .copied()
        .filter(|n| n.nature == "04")
        .collect();
    if !entries.iter().any(|e| e.closing) {
        if by_code.contains_key(input.retained_code.as_str()) {
            let mut lines = Vec::new();
            let mut net = 0.0;
            for node in &result_accounts {
                let balance = r2(before_closing.get(&node.code).copied().unwrap_or(0.0));
                if balance == 0.0 {
                    continue;
                }
                lines.push(Line {
                    account_code: node.code.clone(),
                    debit: if balance < 0.0 { -balance } else { 0.0 },
                    credit: if balance > 0.0 { balance } else { 0.0 },
                    description: Some("Encerramento do exercício".into()),
                });
                net += balance;
            }
            if !lines.is_empty() {
                lines.push(Line {
                    account_code: input.retained_code.clone(),
                    debit: if net > 0.0 { r2(net) } else { 0.0 },
                    credit: if net < 0.0 { r2(-net) } else { 0.0 },
                    description: Some("Resultado do exercício".into()),
                });
                entries.push(Entry {
                    id: format!("ENC-{}", &end[..4]),
                    date: end.to_owned(),
                    description: Some("Encerramento do exercício".into()),
                    lines,
                    closing: true,
                });
            }
        } else {
            warnings.push(format!(
                "Retained earnings account {} is not in the chart; no closing entry was generated.",
                input.retained_code
            ));
        }
    }

    // Bloco 0
    let company = &input.company;
    let opt = |v: &Option<String>| v.clone().unwrap_or_default();
    emit!(
        out,
        "0000",
        "LECD",
        ddmmaaaa(start),
        ddmmaaaa(end),
        text(Some(&company.name)),
        cnpj,
        company.uf,
        text(company.ie.as_deref()),
        opt(&company.municipality_code),
        text(company.im.as_deref()),
        "",
        0,
        0,
        0,
        "",
        0,
        0,
        "",
        "N",
        "N",
        0,
        0,
        ""
    );
    emit!(out, "0001", 0);
    let has_ie = company.ie.as_deref().is_some_and(|ie| !ie.is_empty());
    emit!(
        out,
        "0007",
        if has_ie { company.uf.as_str() } else { "00" },
        text(company.ie.as_deref())
    );
    emit!(out, "0990", 4);

    // Bloco I
    let block_i_start = out.lines.len();
    emit!(out, "I001", 0);
    emit!(out, "I010", "G", "9.00");
    emit!(
        out,
        "I030",
        "TERMO DE ABERTURA",
        1,
        "DIARIO GERAL",
        "{QTD_LIN}",
        text(Some(&company.name)),
        "",
        cnpj,
        "",
        "",
        text(company.municipality_name.as_deref()),
        ddmmaaaa(end)
    );
    for node in &chart {
        emit!(
            out,
            "I050",
            ddmmaaaa(start),
            node.nature,
            if node.synthetic { "S" } else { "A" },
            node.level,
            node.code,
            node.parent.clone().unwrap_or_default(),
            text(Some(&node.name))
        );
        if !node.synthetic {
            emit!(out, "I052", "", node.code);
        }
    }

    // I150 / I155: monthly balances.
    let mut running: HashMap<String, f64> = analytical
        .iter()
        .map(|n| (n.code.clone(), opening(&n.code)))
        .collect();
    for (month_start, month_end) in months_of(start, end) {
        let mut moves: HashMap<&str, (f64, f64)> = HashMap::new();
        for entry in &entries {
            if entry.date < month_start || entry.date > month_end {
                continue;
            }
            for l in &entry.lines {
                let m = moves.entry(l.account_code.as_str()).or_insert((0.0, 0.0));
                m.0 += l.debit;
                m.1 += l.credit;
            }
        }
        let mut rows: Vec<Vec<String>> = Vec::new();
        for node in &analytical {
            let opening_balance = r2(running.get(&node.code).copied().unwrap_or(0.0));
            let (debit, credit) = moves.get(node.code.as_str()).copied().unwrap_or((0.0, 0.0));
            let closing = r2(opening_balance + debit - credit);
            running.insert(node.code.clone(), closing);
            if opening_balance == 0.0 && debit == 0.0 && credit == 0.0 {
                continue;
            }
            rows.push(vec![
                "I155".into(),
                node.code.clone(),
                String::new(),
                amount(opening_balance),
                dc(opening_balance).into(),
                amount(debit),
                amount(credit),
                amount(closing),
                dc(closing).into(),
            ]);
        }
        if rows.is_empty() {
            continue;
        }
        emit!(out, "I150", ddmmaaaa(&month_start), ddmmaaaa(&month_end));
        for row in rows {
            out.emit(&row);
        }
    }

    // I200 / I250: the journal.
    for entry in &entries {
        let total = r2(entry.lines.iter().fold(0.0, |s, l| s + l.debit));
        let credits = r2(entry.lines.iter().fold(0.0, |s, l| s + l.credit));
        if total != credits {
            warnings.push(format!(
                "Entry {} does not balance ({} / {}).",
                entry.id,
                js::to_fixed(total, 2),
                js::to_fixed(credits, 2)
            ));
        }
        emit!(
            out,
            "I200",
            text(Some(&entry.id)),
            ddmmaaaa(&entry.date),
            amount(total),
            if entry.closing { "E" } else { "N" },
            ""
        );
        for l in &entry.lines {
            let hist = text(l.description.as_deref().or(entry.description.as_deref()));
            let hist = if hist.is_empty() {
                "Lançamento".to_owned()
            } else {
                hist
            };
            if l.debit != 0.0 && !l.debit.is_nan() {
                emit!(
                    out,
                    "I250",
                    l.account_code,
                    "",
                    amount(l.debit),
                    "D",
                    "",
                    "",
                    hist,
                    ""
                );
            }
            if l.credit != 0.0 && !l.credit.is_nan() {
                emit!(
                    out,
                    "I250",
                    l.account_code,
                    "",
                    amount(l.credit),
                    "C",
                    "",
                    "",
                    hist,
                    ""
                );
            }
        }
    }

    // I350 / I355: results before the closing.
    let result_balances: Vec<(String, f64)> = result_accounts
        .iter()
        .map(|n| {
            (
                n.code.clone(),
                r2(before_closing.get(&n.code).copied().unwrap_or(0.0)),
            )
        })
        .filter(|(_, b)| *b != 0.0)
        .collect();
    if !result_balances.is_empty() {
        emit!(out, "I350", ddmmaaaa(end));
        for (code, balance) in result_balances {
            emit!(out, "I355", code, "", amount(balance), dc(balance));
        }
    }
    let count = out.lines.len() - block_i_start + 1;
    emit!(out, "I990", count);

    // Bloco J
    let block_j_start = out.lines.len();
    emit!(out, "J001", 0);
    emit!(out, "J005", ddmmaaaa(start), ddmmaaaa(end), 1, "");
    let subtree = |node: &Node, value: &dyn Fn(&str) -> f64| {
        let prefix = format!("{}.", node.code);
        analytical
            .iter()
            .filter(|a| {
                a.code == node.code
                    || a.code.starts_with(&prefix)
                    || (!a.code.contains('.') && a.parent.as_deref() == Some(node.code.as_str()))
            })
            .fold(0.0, |s, a| s + value(&a.code))
    };
    for node in chart.iter().filter(|n| n.nature != "04") {
        let ini = r2(subtree(node, &|code| opening(code)));
        let fin = r2(subtree(node, &|code| {
            running.get(code).copied().unwrap_or(0.0)
        }));
        emit!(
            out,
            "J100",
            node.code,
            if node.synthetic { "T" } else { "D" },
            node.level,
            node.parent.clone().unwrap_or_default(),
            if node.code.starts_with('1') { "A" } else { "P" },
            text(Some(&node.name)),
            amount(ini),
            dc(ini),
            amount(fin),
            dc(fin),
            ""
        );
    }
    for (index, node) in chart.iter().filter(|n| n.nature == "04").enumerate() {
        let order = index + 1;
        let value = r2(subtree(node, &|code| {
            before_closing.get(code).copied().unwrap_or(0.0)
        }));
        emit!(
            out,
            "J150",
            order,
            node.code,
            if node.synthetic { "T" } else { "D" },
            node.level,
            node.parent.clone().unwrap_or_default(),
            text(Some(&node.name)),
            "",
            "",
            amount(value),
            dc(value),
            if value <= 0.0 { "R" } else { "D" },
            ""
        );
    }
    emit!(
        out,
        "J900",
        "TERMO DE ENCERRAMENTO",
        1,
        "DIARIO GERAL",
        text(Some(&company.name)),
        "{QTD_LIN}",
        ddmmaaaa(start),
        ddmmaaaa(end)
    );
    if !input.signatories.iter().any(|s| s.code == "900") {
        warnings.push("The ECD must be signed by a contador (code 900): add one.".into());
    }
    if !input.signatories.iter().any(|s| s.legal_representative) {
        warnings.push("The ECD must be signed by the legal representative: add one.".into());
    }
    for s in &input.signatories {
        let tax_id: String = s.tax_id.chars().filter(char::is_ascii_digit).collect();
        emit!(
            out,
            "J930",
            text(Some(&s.name)),
            tax_id,
            text(Some(&s.qualification)),
            s.code,
            opt(&s.crc),
            opt(&s.email),
            opt(&s.phone),
            opt(&s.crc_uf),
            "",
            "",
            if s.legal_representative { "S" } else { "N" }
        );
    }
    let count = out.lines.len() - block_j_start + 1;
    emit!(out, "J990", count);

    // Bloco 9
    emit!(out, "9001", 0);
    let mut registers: Vec<String> = out.counts.iter().map(|(r, _)| r.clone()).collect();
    for extra in ["9900", "9990", "9999"] {
        if !registers.iter().any(|r| r == extra) {
            registers.push(extra.into());
        }
    }
    let unique = registers.len();
    for reg in &registers {
        let count = match reg.as_str() {
            "9900" => i64::try_from(unique).unwrap_or(0),
            "9990" | "9999" => 1,
            other => out
                .counts
                .iter()
                .find(|(r, _)| r == other)
                .map_or(0, |(_, c)| *c),
        };
        emit!(out, "9900", reg, count);
    }
    emit!(out, "9990", unique + 3);
    let total_lines = out.lines.len() + 1;
    emit!(out, "9999", total_lines);

    let line_count = out.lines.len().to_string();
    let mut content = out
        .lines
        .iter()
        .map(|l| l.replacen("{QTD_LIN}", &line_count, 1))
        .collect::<Vec<_>>()
        .join("\r\n");
    content.push_str("\r\n");
    Ecd { content, warnings }
}

/// `encodeLatin1(content)`: UTF-16 units under 256 as themselves, others `?`.
pub(crate) fn encode_latin1(content: &str) -> Vec<u8> {
    content
        .encode_utf16()
        .map(|unit| u8::try_from(unit).unwrap_or(b'?'))
        .collect()
}

/// Why the file can't be made (`BrEcdError`): a 400.
#[derive(Debug)]
pub(crate) enum EcdError {
    User(String),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for EcdError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// `fiscalYearRange(entity, year)`: the fiscal year ending in `year`.
fn fiscal_year_range(start_month: i64, year: i64) -> (String, String) {
    let start_year = if start_month == 1 { year } else { year - 1 };
    let start_days = js::days_from_civil(start_year, start_month, 1);
    let end_days = js::days_from_civil(start_year + 1, start_month, 1) - 1;
    let day = |days: i64| {
        let (y, m, d) = js::civil_from_days(days);
        format!("{y:04}-{m:02}-{d:02}")
    };
    (day(start_days), day(end_days))
}

/// `Number.parseFloat(value ?? '0') || 0`.
fn money(value: Option<&str>) -> f64 {
    let parsed = js::parse_float(value.unwrap_or("0"));
    if parsed.is_nan() { 0.0 } else { parsed }
}

/// `buildEntityEcd(db, entity, year, signatories)`.
#[allow(clippy::too_many_lines)] // the service's reads, in its order
pub(crate) async fn build_entity_ecd(
    db: &PgPool,
    entity: &Value,
    year: i64,
    signatories: Vec<Signatory>,
) -> Result<Ecd, EcdError> {
    if entity["jurisdictionCode"].as_str() != Some("BR") {
        return Err(EcdError::User(
            "The SPED ECD is for Brazilian entities only".into(),
        ));
    }
    let identifiers = entity.get("taxIdentifiers");
    let Some(cnpj) = identifiers
        .and_then(|t| t.get("vatNumber"))
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
    else {
        return Err(EcdError::User("The entity's CNPJ is missing".into()));
    };
    let settings = entity.get("jurisdictionSettings");
    let setting = |key: &str| {
        settings
            .and_then(|s| s.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let Some(uf) = setting("uf").filter(|u| !u.is_empty()) else {
        return Err(EcdError::User("The entity's state (UF) is missing".into()));
    };
    let entity_id = entity["id"].as_str().unwrap_or_default();
    let start_month = entity["fiscalYearStart"].as_i64().unwrap_or(1);
    let (start, end) = fiscal_year_range(start_month, year);
    let from = format!("{start}T00:00:00.000Z");
    let (ey, em, ed) = (
        js::parse_int(&end[..4]).unwrap_or(0),
        js::parse_int(&end[5..7]).unwrap_or(1),
        js::parse_int(&end[8..10]).unwrap_or(1),
    );
    let (ty, tm, td) = js::civil_from_days(js::days_from_civil(ey, em, ed) + 1);
    let to = format!("{ty:04}-{tm:02}-{td:02}T00:00:00.000Z");

    let account_rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "select \"id\", \"code\", \"name\", \"type\" from \"accounts\" \
         where (\"accounts\".\"entity_id\" = $1 and \"accounts\".\"deleted_at\" is null)",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    // `new Map(...)`: a later row of the same key wins.
    let code_by_id: HashMap<&str, &str> = account_rows
        .iter()
        .map(|a| (a.0.as_str(), a.1.as_str()))
        .collect();
    let type_by_code: HashMap<&str, &str> = account_rows
        .iter()
        .map(|a| (a.1.as_str(), a.3.as_str()))
        .collect();

    let accounts = load_entity_accounts(db, entity_id).await?;
    let Some(retained) = account_for_role(&accounts, "retained_earnings", &[])
        .and_then(|a| a["code"].as_str())
        .map(str::to_owned)
    else {
        return Err(EcdError::User(
            "No retained earnings account (Lucros ou prejuízos acumulados) in the chart".into(),
        ));
    };

    let before: Vec<(String, String)> = sqlx::query_as(
        "select \"journal_lines\".\"account_id\", (coalesce(sum(coalesce(\"journal_lines\".\"base_currency_debit\", \"journal_lines\".\"debit\") \
         - coalesce(\"journal_lines\".\"base_currency_credit\", \"journal_lines\".\"credit\")), 0))::text \
         from \"journal_lines\" inner join \"journal_entries\" on \"journal_lines\".\"journal_entry_id\" = \"journal_entries\".\"id\" \
         where (\"journal_lines\".\"entity_id\" = $1 and \"journal_entries\".\"date\" < $2::timestamp \
         and \"journal_entries\".\"status\" = 'posted') group by \"journal_lines\".\"account_id\"",
    )
    .bind(entity_id)
    .bind(&from)
    .fetch_all(db)
    .await?;
    let mut opening: HashMap<String, f64> = HashMap::new();
    for (account_id, net) in &before {
        let Some(code) = code_by_id.get(account_id.as_str()) else {
            continue;
        };
        let kind = type_by_code.get(code).copied();
        let target = if matches!(kind, Some("revenue" | "expense")) {
            retained.clone()
        } else {
            (*code).to_owned()
        };
        *opening.entry(target).or_insert(0.0) += js::parse_float(net);
    }

    let entry_rows: Vec<(String, Option<String>, Value, Option<String>)> = sqlx::query_as(
        "select \"id\", \"entry_number\", to_jsonb(\"date\"), \"description\" from \"journal_entries\" \
         where (\"journal_entries\".\"entity_id\" = $1 and \"journal_entries\".\"status\" = 'posted' \
         and \"journal_entries\".\"date\" >= $2::timestamp and \"journal_entries\".\"date\" < $3::timestamp) \
         order by \"journal_entries\".\"date\" asc",
    )
    .bind(entity_id)
    .bind(&from)
    .bind(&to)
    .fetch_all(db)
    .await?;
    let ids: Vec<String> = entry_rows.iter().map(|e| e.0.clone()).collect();
    type LineRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let mut line_rows: Vec<LineRow> = Vec::new();
    for chunk in ids.chunks(500) {
        let rows: Vec<LineRow> = sqlx::query_as(
            "select \"journal_entry_id\", \"account_id\", \"debit\"::text, \"credit\"::text, \
             \"base_currency_debit\"::text, \"base_currency_credit\"::text, \"description\" \
             from \"journal_lines\" where \"journal_lines\".\"journal_entry_id\" = any($1)",
        )
        .bind(chunk)
        .fetch_all(db)
        .await?;
        line_rows.extend(rows);
    }
    let mut entries = Vec::new();
    for (id, number, date, description) in entry_rows {
        let date = date
            .as_str()
            .and_then(weldsuite_db::js_timestamp)
            .unwrap_or_default();
        entries.push(Entry {
            id: number.unwrap_or_else(|| id.clone()),
            date: date.chars().take(10).collect(),
            description,
            lines: line_rows
                .iter()
                .filter(|l| l.0 == id)
                .map(|l| Line {
                    account_code: code_by_id
                        .get(l.1.as_str())
                        .map_or_else(String::new, |c| (*c).to_owned()),
                    debit: if l.4.is_some() {
                        money(l.4.as_deref())
                    } else {
                        money(l.2.as_deref())
                    },
                    credit: if l.5.is_some() {
                        money(l.5.as_deref())
                    } else {
                        money(l.3.as_deref())
                    },
                    description: l.6.clone(),
                })
                .collect(),
            closing: false,
        });
    }

    let registration = identifiers
        .and_then(|t| t.get("registrationNumber"))
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty() && *r != "ISENTO")
        .map(str::to_owned);
    let name = match entity.get("legalName") {
        Some(Value::String(legal)) => legal.clone(),
        _ => entity["name"].as_str().unwrap_or_default().to_owned(),
    };
    Ok(build_ecd(Input {
        period_start: start,
        period_end: end,
        company: Company {
            name,
            cnpj,
            uf,
            ie: registration,
            municipality_code: setting("municipalityCode"),
            municipality_name: setting("municipalityName"),
            im: setting("inscricaoMunicipal"),
        },
        accounts: account_rows
            .into_iter()
            .map(|(_, code, name, kind)| Account { code, name, kind })
            .collect(),
        opening,
        entries,
        retained_code: retained,
        signatories,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(amount(-1234.5), "1234,50");
        assert_eq!(ddmmaaaa("2026-03-04"), "04032026");
        assert_eq!(text(Some(" a|b\r\nc ")), "a b c");
        assert_eq!(
            fiscal_year_range(1, 2026),
            ("2026-01-01".into(), "2026-12-31".into())
        );
        assert_eq!(
            fiscal_year_range(7, 2026),
            ("2025-07-01".into(), "2026-06-30".into())
        );
        assert_eq!(months_of("2026-01-15", "2026-02-10").len(), 2);
        assert_eq!(encode_latin1("ç€"), vec![0xe7, b'?']);
    }

    #[test]
    fn a_small_book() {
        let ecd = build_ecd(Input {
            period_start: "2026-01-01".into(),
            period_end: "2026-12-31".into(),
            company: Company {
                name: "Empresa".into(),
                cnpj: "12.345.678/0001-23".into(),
                uf: "SP".into(),
                ie: None,
                municipality_code: None,
                municipality_name: None,
                im: None,
            },
            accounts: vec![
                Account {
                    code: "1.1.1.01".into(),
                    name: "Caixa".into(),
                    kind: "asset".into(),
                },
                Account {
                    code: "2.3.1.01".into(),
                    name: "Lucros".into(),
                    kind: "equity".into(),
                },
                Account {
                    code: "3.1.1.01".into(),
                    name: "Receita".into(),
                    kind: "revenue".into(),
                },
            ],
            opening: HashMap::new(),
            entries: vec![Entry {
                id: "JE-1".into(),
                date: "2026-03-01".into(),
                description: Some("Venda".into()),
                lines: vec![
                    Line {
                        account_code: "1.1.1.01".into(),
                        debit: 100.0,
                        credit: 0.0,
                        description: None,
                    },
                    Line {
                        account_code: "3.1.1.01".into(),
                        debit: 0.0,
                        credit: 100.0,
                        description: None,
                    },
                ],
                closing: false,
            }],
            retained_code: "2.3.1.01".into(),
            signatories: Vec::new(),
        });
        assert!(
            ecd.content
                .starts_with("|0000|LECD|01012026|31122026|Empresa|12345678000123|SP|")
        );
        assert!(ecd.content.contains("|I200|ENC-2026|31122026|100,00|E||"));
        assert_eq!(ecd.warnings.len(), 2);
    }
}
