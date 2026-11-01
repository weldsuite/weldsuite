//! Focus NFe request bodies of a Brazilian invoice (books-api's
//! `br-fiscal/payload`): NF-e for goods (`/v2/nfe`), NFS-e Nacional
//! (`/v2/nfsen`) and municipal NFS-e (`/v2/nfse`) for services. Pure: the
//! taxes come from the BR engine's breakdown rows per line.

use serde_json::{Map, Value, json};
use weldsuite_books_domain::js::{self, number_value as n, round_money as round2};
use weldsuite_books_domain::jurisdictions::br_tax::{crt_of, is_simples_regime};
use weldsuite_books_domain::jurisdictions::{is_js_space, js_trim};

/// `HOMOLOGACAO_RECIPIENT_NAME`.
pub(crate) const HOMOLOGACAO_RECIPIENT_NAME: &str =
    "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";

/// `BrPayloadError`: what to fill in before the document can be issued.
#[derive(Debug, Clone)]
pub(crate) struct PayloadError {
    pub message: String,
    pub missing: Vec<String>,
}

impl PayloadError {
    fn new(message: &str, missing: Vec<String>) -> Self {
        let message = if missing.is_empty() {
            message.to_owned()
        } else {
            format!("{message}: {}", missing.join("; "))
        };
        Self { message, missing }
    }
}

/// `BrFiscalLine`.
#[derive(Debug, Clone)]
pub(crate) struct Line {
    pub description: String,
    pub quantity: f64,
    pub unit_price: f64,
    pub unit: Option<String>,
    pub line_total: f64,
    pub product_code: Option<String>,
    pub ncm: Option<String>,
    pub cfop: Option<String>,
    pub fiscal: Map<String, Value>,
    pub kind: Option<String>,
}

/// `BrFiscalCounterparty`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Counterparty {
    pub name: String,
    pub email: Option<String>,
    pub tax_id: Option<String>,
    pub address: Map<String, Value>,
    pub fiscal: Map<String, Value>,
}

/// `BrFiscalIssuer`.
#[derive(Debug, Clone)]
pub(crate) struct Issuer {
    pub cnpj: String,
    pub regime: String,
    pub inscricao_estadual: Option<String>,
    pub settings: Map<String, Value>,
}

/// `BrFiscalDocument`.
#[derive(Debug, Clone)]
pub(crate) struct Document {
    pub number: Option<String>,
    pub issue_date: String,
    pub due_date: Option<String>,
    pub notes: Option<String>,
    pub fiscal: Map<String, Value>,
    pub is_credit_note: bool,
    pub referenced_access_key: Option<String>,
    pub online: bool,
}

/// `BrFiscalTaxes`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Taxes {
    pub lines: Vec<Vec<Map<String, Value>>>,
    pub withheld: Vec<Map<String, Value>>,
}

/// `BuildPayloadArgs` (+ the DPS number of an NFS-e Nacional).
#[derive(Debug, Clone)]
pub(crate) struct Args {
    pub environment: String,
    /// `now`, epoch milliseconds.
    pub now_ms: i64,
    pub issuer: Issuer,
    pub counterparty: Counterparty,
    pub document: Document,
    pub lines: Vec<Line>,
    pub taxes: Taxes,
    pub dps_number: Option<i64>,
}

// ── helpers ─────────────────────────────────────────────────────────────────

/// A string field (`map.key`), as it is.
pub(crate) fn text(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// A truthy string field.
fn present(map: &Map<String, Value>, key: &str) -> Option<String> {
    text(map, key).filter(|v| !v.is_empty())
}

fn digits_of(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_digit)
        .collect()
}

fn head(text: &str, n: usize) -> String {
    js::slice_utf16(text, n)
}

fn bool_of(map: &Map<String, Value>, key: &str) -> Option<bool> {
    map.get(key).and_then(Value::as_bool)
}

/// `compact(record)`: without undefined, null and empty strings.
fn compact(record: Map<String, Value>) -> Map<String, Value> {
    record
        .into_iter()
        .filter(|(_, v)| !(v.is_null() || v.as_str() == Some("")))
        .collect()
}

fn put(map: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    map.insert(key.to_owned(), value.into());
}

fn put_opt<T: Into<Value>>(map: &mut Map<String, Value>, key: &str, value: Option<T>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), value.into());
    }
}

/// `brasiliaIso(now)`: Brasília time (UTC-3).
pub(crate) fn brasilia_iso(now_ms: i64) -> String {
    let iso = js::iso_from_millis(now_ms - 3 * 3600 * 1000).unwrap_or_default();
    format!("{}-03:00", head(&iso, 19))
}

fn is_foreign(country: Option<&str>) -> bool {
    let c = js_trim(country.unwrap_or_default()).to_uppercase();
    !c.is_empty() && !matches!(c.as_str(), "BR" | "BRA" | "BRAZIL" | "BRASIL")
}

fn component(row: &Map<String, Value>) -> Option<&str> {
    row.get("component").and_then(Value::as_str)
}

fn amount(row: &Map<String, Value>, key: &str) -> f64 {
    row.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn row_of<'a>(rows: &'a [Map<String, Value>], name: &str) -> Option<&'a Map<String, Value>> {
    rows.iter().find(|r| component(r) == Some(name))
}

fn sum_rows(rows: &[Map<String, Value>], name: &str) -> f64 {
    round2(
        rows.iter()
            .filter(|r| component(r) == Some(name))
            .fold(0.0, |s, r| s + amount(r, "taxAmount")),
    )
}

/// The rate of a row as it is (`row.taxRate`).
fn rate_value(row: &Map<String, Value>) -> Value {
    row.get("taxRate").cloned().unwrap_or(Value::Null)
}

/// `/^(?:\d+[a-z]?|s\/?n)$/i`.
fn is_house_number(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    if lower == "sn" || lower == "s/n" {
        return true;
    }
    let digits = lower.bytes().take_while(u8::is_ascii_digit).count();
    let rest = &lower[digits..];
    digits > 0 && (rest.is_empty() || (rest.len() == 1 && rest.as_bytes()[0].is_ascii_lowercase()))
}

fn split_trailing_number(text: &str) -> Option<(String, String)> {
    let chars: Vec<char> = text.chars().collect();
    let space = |c: char| is_js_space(c);
    let mut number_start = chars.len();
    while number_start > 0 && !space(chars[number_start - 1]) {
        number_start -= 1;
    }
    let mut street_end = number_start;
    while street_end > 0 && space(chars[street_end - 1]) {
        street_end -= 1;
    }
    if street_end == 0 || street_end == number_start {
        return None;
    }
    let street: String = chars[..street_end].iter().collect();
    let number: String = chars[number_start..].iter().collect();
    if street.contains(['\n', '\r', '\u{2028}', '\u{2029}']) || !is_house_number(&number) {
        return None;
    }
    Some((js_trim(&street).to_owned(), number.to_uppercase()))
}

/// `splitStreet(line1)`: street and number ("S/N" when there is none).
pub(crate) fn split_street(line1: Option<&str>) -> (String, String) {
    let text = js_trim(line1.unwrap_or_default());
    // `/^(.+?),\s*(\d+[a-z]?|s\/?n)\b/i`
    for (at, _) in text.match_indices(',') {
        if at == 0 {
            continue;
        }
        let rest = text[at + 1..].trim_start_matches(is_js_space);
        let candidate: String = {
            let lower = rest.to_ascii_lowercase();
            if lower.starts_with("s/n") {
                rest[..3].to_owned()
            } else if lower.starts_with("sn") {
                rest[..2].to_owned()
            } else {
                let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
                if digits == 0 {
                    String::new()
                } else {
                    let letter = rest[digits..]
                        .chars()
                        .next()
                        .filter(char::is_ascii_alphabetic)
                        .map_or(0, |_| 1);
                    // `[a-z]?` then `\b`: take the letter only when a word boundary follows it.
                    let with_letter = &rest[..digits + letter];
                    let after = rest[digits + letter..].chars().next();
                    if letter == 1 && after.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_')) {
                        with_letter.to_owned()
                    } else {
                        rest[..digits].to_owned()
                    }
                }
            }
        };
        if candidate.is_empty() {
            continue;
        }
        let after = rest[candidate.len()..].chars().next();
        let last = candidate.chars().last();
        let boundary = match (last, after) {
            (_, None) => true,
            (Some(l), Some(a)) => {
                let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
                word(l) != word(a)
            }
            _ => true,
        };
        if boundary {
            return (js_trim(&text[..at]).to_owned(), candidate.to_uppercase());
        }
    }
    split_trailing_number(text).unwrap_or_else(|| (text.to_owned(), "S/N".to_owned()))
}

/// `returnCfop(cfop)`.
pub(crate) fn return_cfop(cfop: &str) -> String {
    if cfop.starts_with(['1', '2', '3']) {
        return cfop.to_owned();
    }
    match cfop {
        "5101" => return "1201".into(),
        "5102" => return "1202".into(),
        "6101" => return "2201".into(),
        "6102" => return "2202".into(),
        "7101" => return "3201".into(),
        "7102" => return "3202".into(),
        _ => {}
    }
    let mut chars = cfop.chars();
    let first = chars.next().map_or(String::new(), |c| match c {
        '5' => "1".into(),
        '6' => "2".into(),
        '7' => "3".into(),
        other => other.to_string(),
    });
    format!("{first}{}", chars.as_str())
}

fn default_sale_cfop(kind: Option<&str>, destination: i64) -> String {
    let prefix = match destination {
        1 => "5",
        2 => "6",
        _ => "7",
    };
    let base = if kind == Some("goods_production") {
        "101"
    } else {
        "102"
    };
    format!("{prefix}{base}")
}

/// `nationalServiceCode(code)`: the 6-digit LC 116 code.
pub(crate) fn national_service_code(code: &str) -> Option<String> {
    let digits = digits_of(Some(code));
    match digits.len() {
        6 => Some(digits),
        3 | 4 => Some(format!("{digits:0>4}01")),
        _ => None,
    }
}

fn municipal_service_item(code: &str) -> Option<String> {
    national_service_code(code).map(|n| n[..4].to_owned())
}

// ── which document ──────────────────────────────────────────────────────────

/// `lineCategory(line)`: `goods`, `service`, or nothing.
fn line_category(line: &Line) -> Option<&'static str> {
    match line.kind.as_deref() {
        Some("service" | "export_service") => return Some("service"),
        Some("goods_resale" | "goods_production" | "export_goods") => return Some("goods"),
        _ => {}
    }
    if line.ncm.as_deref().is_some_and(|v| !v.is_empty())
        || line.cfop.as_deref().is_some_and(|v| !v.is_empty())
    {
        return Some("goods");
    }
    if js::truthy(line.fiscal.get("serviceCode")) {
        return Some("service");
    }
    None
}

/// `chooseFiscalKind(lines, settings)`.
pub(crate) fn choose_kind(lines: &[Line], settings: &Map<String, Value>) -> Result<&'static str, PayloadError> {
    let mut categories: Vec<&str> = Vec::new();
    for category in lines.iter().filter_map(line_category) {
        if !categories.contains(&category) {
            categories.push(category);
        }
    }
    if categories.len() > 1 {
        return Err(PayloadError::new(
            "This invoice mixes goods and services, which need different fiscal documents (NF-e and NFS-e). Split it into two invoices",
            Vec::new(),
        ));
    }
    match categories.first() {
        None => Err(PayloadError::new(
            "The lines have no tax profile that says whether they are goods or services. Give them a tax rate (or an NCM or LC 116 code)",
            Vec::new(),
        )),
        Some(&"goods") => Ok("nfe"),
        Some(_) if text(settings, "nfseStandard").as_deref() == Some("municipal") => Ok("nfse"),
        Some(_) => Ok("nfsen"),
    }
}

// ── recipient ───────────────────────────────────────────────────────────────

fn buyer_is_icms_contributor(args: &Args) -> bool {
    bool_of(&args.document.fiscal, "buyerIcmsContributor")
        .or_else(|| bool_of(&args.counterparty.fiscal, "icmsContributor"))
        .unwrap_or_else(|| digits_of(args.counterparty.tax_id.as_deref()).len() == 14)
}

/// `counterpartyId(counterparty)`: (`cnpj` | `cpf`, value).
fn counterparty_id(counterparty: &Counterparty) -> Option<(&'static str, String)> {
    let id = digits_of(counterparty.tax_id.as_deref());
    if id.len() == 14 {
        return Some(("cnpj", id));
    }
    if id.len() == 11 {
        return Some(("cpf", id));
    }
    let raw: String = counterparty
        .tax_id
        .as_deref()
        .unwrap_or_default()
        .chars()
        .filter(|c| !(is_js_space(*c) || matches!(c, '.' | '/' | '-')))
        .collect::<String>()
        .to_uppercase();
    let b = raw.as_bytes();
    (b.len() == 14
        && b[..12]
            .iter()
            .all(|c| c.is_ascii_digit() || c.is_ascii_uppercase())
        && b[12..].iter().all(u8::is_ascii_digit))
    .then_some(("cnpj", raw))
}

fn party_id_fields(out: &mut Map<String, Value>, id: Option<&(&str, String)>, cnpj: &str, cpf: &str) {
    match id {
        Some(("cnpj", value)) => put(out, cnpj, value.clone()),
        Some((_, value)) => put(out, cpf, value.clone()),
        None => {}
    }
}

fn local_destination(args: &Args, missing: &mut Vec<String>) -> i64 {
    let address = &args.counterparty.address;
    if is_foreign(text(address, "country").as_deref()) {
        return 3;
    }
    let issuer_uf = present(&args.issuer.settings, "uf").map(|u| u.to_uppercase());
    let uf = present(address, "state").map(|u| u.to_uppercase());
    if issuer_uf.is_none() {
        missing.push("the entity's state (UF) in its Brazil settings".into());
    }
    if uf.is_none() {
        missing.push("the customer's state (UF)".into());
    }
    match (issuer_uf, uf) {
        (Some(a), Some(b)) if a == b => 1,
        (Some(_), Some(_)) => 2,
        _ => 1,
    }
}

// ── NF-e ────────────────────────────────────────────────────────────────────

fn ibs_cbs_fields(out: &mut Map<String, Value>, line: &Line, rows: &[Map<String, Value>]) {
    let cbs = row_of(rows, "cbs");
    let ibs = row_of(rows, "ibs");
    if cbs.is_none() && ibs.is_none() {
        return;
    }
    let base = cbs
        .or(ibs)
        .map_or(0.0, |r| amount(r, "taxableAmount"));
    let cbs_value = cbs.map_or(0.0, |r| amount(r, "taxAmount"));
    let ibs_value = ibs.map_or(0.0, |r| amount(r, "taxAmount"));
    put(
        out,
        "ibs_cbs_situacao_tributaria",
        line.fiscal.get("ibsCbsCst").cloned().filter(|v| !v.is_null()).unwrap_or_else(|| json!("000")),
    );
    put(
        out,
        "ibs_cbs_classificacao_tributaria",
        line.fiscal.get("cClassTrib").cloned().filter(|v| !v.is_null()).unwrap_or_else(|| json!("000001")),
    );
    put(out, "ibs_cbs_base_calculo", n(round2(base)));
    put(out, "ibs_uf_aliquota", ibs.map_or(json!(0), rate_value));
    put(out, "ibs_uf_valor", n(round2(ibs_value)));
    put(out, "ibs_mun_aliquota", 0);
    put(out, "ibs_mun_valor", 0);
    put(out, "ibs_valor_total", n(round2(ibs_value)));
    put(out, "cbs_aliquota", cbs.map_or(json!(0), rate_value));
    put(out, "cbs_valor", n(round2(cbs_value)));
}

fn number_setting(settings: &Map<String, Value>, key: &str) -> f64 {
    settings.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn simples_item_taxes(out: &mut Map<String, Value>, line: &Line, args: &Args, exempt: bool) {
    let credit = if args.issuer.regime == "simples_nacional" {
        number_setting(&args.issuer.settings, "simplesCreditRate")
    } else {
        0.0
    };
    if args.document.is_credit_note || exempt {
        put(out, "icms_situacao_tributaria", "400");
    } else if credit > 0.0 {
        put(out, "icms_situacao_tributaria", "101");
        put(out, "icms_aliquota_credito_simples", n(credit));
        put(
            out,
            "icms_valor_credito_simples",
            n(round2((line.line_total * credit) / 100.0)),
        );
    } else {
        put(out, "icms_situacao_tributaria", "102");
    }
    put(out, "pis_situacao_tributaria", "07");
    put(out, "cofins_situacao_tributaria", "07");
}

fn regular_item_taxes(out: &mut Map<String, Value>, line: &Line, rows: &[Map<String, Value>]) {
    if let Some(icms) = row_of(rows, "icms") {
        put(out, "icms_situacao_tributaria", "00");
        put(out, "icms_modalidade_base_calculo", 3);
        put(out, "icms_base_calculo", n(round2(amount(icms, "taxableAmount"))));
        put(out, "icms_aliquota", rate_value(icms));
        put(out, "icms_valor", n(round2(amount(icms, "taxAmount"))));
    } else {
        put(
            out,
            "icms_situacao_tributaria",
            if line.kind.as_deref() == Some("exempt") {
                "40"
            } else {
                "41"
            },
        );
    }
    if let Some(fcp) = row_of(rows, "fcp") {
        put(out, "fcp_percentual", rate_value(fcp));
        put(out, "fcp_base_calculo", n(round2(amount(fcp, "taxableAmount"))));
        put(out, "fcp_valor", n(round2(amount(fcp, "taxAmount"))));
    }
    if let Some(ipi) = row_of(rows, "ipi") {
        put(out, "ipi_situacao_tributaria", "50");
        put(out, "ipi_codigo_enquadramento_legal", "999");
        put(out, "ipi_base_calculo", n(round2(amount(ipi, "taxableAmount"))));
        put(out, "ipi_aliquota", rate_value(ipi));
        put(out, "ipi_valor", n(round2(amount(ipi, "taxAmount"))));
    }
    for tax in ["pis", "cofins"] {
        if let Some(row) = row_of(rows, tax) {
            put(out, &format!("{tax}_situacao_tributaria"), "01");
            put(out, &format!("{tax}_base_calculo"), n(round2(amount(row, "taxableAmount"))));
            put(out, &format!("{tax}_aliquota_porcentual"), rate_value(row));
            put(out, &format!("{tax}_valor"), n(round2(amount(row, "taxAmount"))));
        } else {
            put(
                out,
                &format!("{tax}_situacao_tributaria"),
                if line.kind.as_deref() == Some("exempt") {
                    "07"
                } else {
                    "08"
                },
            );
        }
    }
    ibs_cbs_fields(out, line, rows);
}

/// `Number.parseInt(value ?? '0', 10) || 0` of a field that may be a string or a number.
fn int_or_zero(value: Option<&Value>) -> i64 {
    let text = match value {
        None | Some(Value::Null) => "0".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(num)) => js::number_text(num.as_f64().unwrap_or(0.0)),
        Some(other) => other.to_string(),
    };
    js::parse_int(&text).unwrap_or(0)
}

fn nfe_item(index: usize, line: &Line, rows: &[Map<String, Value>], args: &Args, destination: i64, missing: &mut Vec<String>) -> Value {
    let simples = is_simples_regime(&args.issuer.regime);
    let number = index + 1;
    let ncm = digits_of(line.ncm.as_deref());
    if ncm.len() != 8 {
        missing.push(format!("line {number}: NCM (8 digits)"));
    }
    let mut cfop = line
        .cfop
        .clone()
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| default_sale_cfop(line.kind.as_deref(), destination));
    if args.document.is_credit_note {
        cfop = return_cfop(&cfop);
    }
    let gross = round2(line.quantity * line.unit_price);
    let discount = round2(gross - line.line_total);
    let unit = head(
        &line
            .unit
            .clone()
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| "UN".into())
            .to_uppercase(),
        6,
    );
    let mut item = Map::new();
    put(&mut item, "numero_item", number);
    put(
        &mut item,
        "codigo_produto",
        line.product_code
            .clone()
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| number.to_string()),
    );
    put(&mut item, "descricao", head(js_trim(&line.description), 120));
    put(&mut item, "codigo_ncm", ncm);
    put(&mut item, "cest", line.fiscal.get("cest").cloned().unwrap_or(Value::Null));
    put(&mut item, "codigo_barras_comercial", "SEM GTIN");
    put(&mut item, "codigo_barras_tributavel", "SEM GTIN");
    put(&mut item, "cfop", cfop);
    put(&mut item, "unidade_comercial", unit.clone());
    put(&mut item, "quantidade_comercial", n(line.quantity));
    put(&mut item, "valor_unitario_comercial", n(line.unit_price));
    put(&mut item, "valor_bruto", n(gross));
    put(&mut item, "unidade_tributavel", unit);
    put(&mut item, "quantidade_tributavel", n(line.quantity));
    put(&mut item, "valor_unitario_tributavel", n(line.unit_price));
    if discount > 0.0 {
        put(&mut item, "valor_desconto", n(discount));
    }
    put(&mut item, "inclui_no_total", 1);
    put(&mut item, "icms_origem", int_or_zero(line.fiscal.get("origin")));
    let exempt = matches!(line.kind.as_deref(), Some("exempt" | "export_goods"));
    if simples {
        simples_item_taxes(&mut item, line, args, exempt);
    } else {
        regular_item_taxes(&mut item, line, rows);
    }
    Value::Object(compact(item))
}

fn invoice_notes(document: &Document) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(number) = document.number.as_deref().filter(|n| !n.is_empty()) {
        out.push(format!("Fatura {number}"));
    }
    if let Some(notes) = document.notes.as_deref().map(js_trim).filter(|n| !n.is_empty()) {
        out.push(notes.to_owned());
    }
    out
}

fn unique(missing: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in missing {
        if !out.contains(&m) {
            out.push(m);
        }
    }
    out
}

/// `buildNfePayload(args)`.
#[allow(clippy::too_many_lines)] // the body field by field, as TypeScript
pub(crate) fn build_nfe(args: &Args) -> Result<Value, PayloadError> {
    let issuer = &args.issuer;
    let counterparty = &args.counterparty;
    let document = &args.document;
    let mut missing: Vec<String> = Vec::new();
    let simples = is_simples_regime(&issuer.regime);
    if issuer.cnpj.is_empty() {
        missing.push("the entity's CNPJ".into());
    }
    let ie = digits_of(issuer.inscricao_estadual.as_deref());
    if ie.is_empty() {
        missing.push("the entity's Inscrição Estadual (registration number)".into());
    }
    let destination = local_destination(args, &mut missing);
    let id = counterparty_id(counterparty);
    if id.is_none() && destination != 3 {
        missing.push("the customer's CNPJ or CPF".into());
    }
    let contributor = buyer_is_icms_contributor(args);
    let final_consumer = bool_of(&document.fiscal, "finalConsumer").unwrap_or(!contributor);
    let buyer_ie = digits_of(text(&counterparty.fiscal, "inscricaoEstadual").as_deref());
    let ie_indicator = if destination == 3 {
        9
    } else {
        let exempt_ie = text(&counterparty.fiscal, "inscricaoEstadual")
            .unwrap_or_default()
            .to_uppercase()
            == "ISENTO";
        if contributor && !exempt_ie {
            if buyer_ie.is_empty() {
                missing.push(
                    "the customer's Inscrição Estadual (or mark it as not an ICMS taxpayer)".into(),
                );
            }
            1
        } else if exempt_ie {
            2
        } else {
            9
        }
    };
    let address = &counterparty.address;
    let (street, number) = split_street(text(address, "line1").as_deref());
    if destination != 3 {
        if street.is_empty() {
            missing.push("the customer's street address".into());
        }
        if present(address, "county").is_none() {
            missing.push("the customer's neighbourhood (bairro)".into());
        }
        if present(address, "city").is_none() {
            missing.push("the customer's city".into());
        }
        if !js::truthy(counterparty.fiscal.get("municipalityCode")) {
            missing.push("the customer's IBGE municipality code".into());
        }
    }
    let items: Vec<Value> = args
        .lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let rows = args.taxes.lines.get(i).cloned().unwrap_or_default();
            nfe_item(i, line, &rows, args, destination, &mut missing)
        })
        .collect();
    if !missing.is_empty() {
        return Err(PayloadError::new("The NF-e is missing data", unique(missing)));
    }

    let total = round2(args.lines.iter().enumerate().fold(0.0, |sum, (i, line)| {
        let added = args.taxes.lines.get(i).map_or(0.0, |rows| {
            rows.iter()
                .filter(|r| r.get("treatment").and_then(Value::as_str) == Some("added"))
                .fold(0.0, |s, r| s + amount(r, "taxAmount"))
        });
        sum + line.line_total + added
    }));
    let credit = if simples && issuer.regime == "simples_nacional" && !document.is_credit_note {
        number_setting(&issuer.settings, "simplesCreditRate")
    } else {
        0.0
    };
    let credit_value = round2(
        args.lines
            .iter()
            .fold(0.0, |sum, l| sum + (l.line_total * credit) / 100.0),
    );
    let mut extra: Vec<String> = Vec::new();
    if simples {
        extra.push("DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL".into());
        if credit > 0.0 {
            extra.push(format!(
                "PERMITE O APROVEITAMENTO DO CREDITO DE ICMS CORRESPONDENTE A ALIQUOTA DE {}%, NO VALOR DE R$ {}, NOS TERMOS DO ART. 23 DA LC 123/2006",
                js::to_fixed(credit, 2).replacen('.', ",", 1),
                js::to_fixed(credit_value, 2).replacen('.', ",", 1)
            ));
        }
        extra.push("NAO GERA DIREITO A CREDITO FISCAL DE IPI".into());
    }
    extra.extend(invoice_notes(document));

    let issue_iso = brasilia_iso(args.now_ms);
    let mut out = Map::new();
    let default_nature = if document.is_credit_note {
        "Devolucao de venda de mercadoria"
    } else {
        "Venda de mercadoria"
    };
    let nature = document
        .fiscal
        .get("naturezaOperacao")
        .and_then(Value::as_str)
        .unwrap_or(default_nature);
    put(&mut out, "natureza_operacao", head(nature, 60));
    put(&mut out, "data_emissao", issue_iso.clone());
    put(&mut out, "data_entrada_saida", issue_iso);
    put(&mut out, "tipo_documento", i64::from(!document.is_credit_note));
    put(&mut out, "local_destino", destination);
    put(&mut out, "finalidade_emissao", if document.is_credit_note { 4 } else { 1 });
    put(&mut out, "consumidor_final", i64::from(final_consumer));
    put(&mut out, "presenca_comprador", if document.online { 2 } else { 9 });
    put(&mut out, "cnpj_emitente", issuer.cnpj.clone());
    put(&mut out, "inscricao_estadual_emitente", ie);
    put(
        &mut out,
        "regime_tributario_emitente",
        js::parse_int(crt_of(&issuer.regime, false)).unwrap_or(0),
    );
    if let Some(series) = present(&issuer.settings, "nfeSeries") {
        put_opt(&mut out, "serie", js::parse_int(&series).filter(|s| *s != 0));
    }
    put(
        &mut out,
        "nome_destinatario",
        if args.environment == "homologacao" {
            HOMOLOGACAO_RECIPIENT_NAME.to_owned()
        } else {
            head(&counterparty.name, 60)
        },
    );
    party_id_fields(&mut out, id.as_ref(), "cnpj_destinatario", "cpf_destinatario");
    put(&mut out, "indicador_inscricao_estadual_destinatario", ie_indicator);
    if ie_indicator == 1 {
        put(&mut out, "inscricao_estadual_destinatario", buyer_ie);
    }
    if destination == 3 {
        put(&mut out, "pais_destinatario", address.get("country").cloned().unwrap_or(Value::Null));
        put(&mut out, "municipio_destinatario", address.get("city").cloned().unwrap_or(Value::Null));
        put(&mut out, "logradouro_destinatario", street);
        put(&mut out, "numero_destinatario", number);
        put(&mut out, "bairro_destinatario", address.get("county").cloned().unwrap_or(Value::Null));
    } else {
        put(&mut out, "logradouro_destinatario", street);
        put(&mut out, "numero_destinatario", number);
        put(&mut out, "complemento_destinatario", address.get("line2").cloned().unwrap_or(Value::Null));
        put(&mut out, "bairro_destinatario", address.get("county").cloned().unwrap_or(Value::Null));
        put(&mut out, "municipio_destinatario", address.get("city").cloned().unwrap_or(Value::Null));
        put(
            &mut out,
            "codigo_municipio_destinatario",
            counterparty.fiscal.get("municipalityCode").cloned().unwrap_or(Value::Null),
        );
        put_opt(&mut out, "uf_destinatario", text(address, "state").map(|s| s.to_uppercase()));
        let cep = digits_of(text(address, "postalCode").as_deref());
        if !cep.is_empty() {
            put(&mut out, "cep_destinatario", cep);
        }
    }
    put_opt(&mut out, "email_destinatario", counterparty.email.as_deref().map(|e| head(e, 60)));
    put(&mut out, "modalidade_frete", 9);
    if document.is_credit_note
        && let Some(key) = document.referenced_access_key.as_deref().filter(|k| !k.is_empty())
    {
        put(&mut out, "notas_referenciadas", json!([{ "chave_nfe": key }]));
    }
    if !extra.is_empty() {
        put(&mut out, "informacoes_adicionais_contribuinte", head(&extra.join(" | "), 5000));
    }
    let payment = if document.is_credit_note {
        json!({ "indicador_pagamento": 0, "forma_pagamento": "90", "valor_pagamento": 0 })
    } else {
        let on_credit = document
            .due_date
            .as_deref()
            .is_some_and(|due| !due.is_empty() && due > document.issue_date.as_str());
        let pix = js::truthy(issuer.settings.get("pixKey"));
        let mut payment = Map::new();
        put(&mut payment, "indicador_pagamento", i64::from(on_credit));
        put(&mut payment, "forma_pagamento", if pix { "17" } else { "99" });
        if !pix {
            put(&mut payment, "descricao_pagamento", "Outros");
        }
        put(&mut payment, "valor_pagamento", n(total));
        Value::Object(payment)
    };
    put(&mut out, "formas_pagamento", json!([payment]));
    put(&mut out, "items", Value::Array(items));
    Ok(Value::Object(compact(out)))
}

// ── NFS-e ───────────────────────────────────────────────────────────────────

struct Withheld {
    iss: f64,
    irrf: f64,
    pis: f64,
    cofins: f64,
    csll: f64,
    inss: f64,
}

fn withholding_totals(withheld: &[Map<String, Value>]) -> Withheld {
    Withheld {
        iss: sum_rows(withheld, "iss_ret"),
        irrf: sum_rows(withheld, "irrf"),
        pis: sum_rows(withheld, "pis_ret"),
        cofins: sum_rows(withheld, "cofins_ret"),
        csll: sum_rows(withheld, "csll_ret"),
        inss: sum_rows(withheld, "inss_ret"),
    }
}

struct Service {
    amount: f64,
    description: String,
    service_code: String,
    nbs: Option<String>,
    iss_rate: Option<Value>,
    iss_amount: f64,
    export_service: bool,
    exempt: bool,
}

fn summarize_service(args: &Args, missing: &mut Vec<String>) -> Result<Service, PayloadError> {
    let lines = &args.lines;
    let mut codes: Vec<String> = Vec::new();
    for line in lines {
        let code = js_trim(&text(&line.fiscal, "serviceCode").unwrap_or_default()).to_owned();
        if !code.is_empty() && !codes.contains(&code) {
            codes.push(code);
        }
    }
    if codes.is_empty() {
        missing.push("the LC 116 service code on the lines (e.g. 01.07)".into());
    }
    if codes.len() > 1 {
        return Err(PayloadError::new(
            "One NFS-e covers one service code, but the lines use several. Split the invoice per service code",
            codes,
        ));
    }
    let service_amount = round2(lines.iter().fold(0.0, |s, l| s + l.line_total));
    let description = lines
        .iter()
        .map(|l| {
            if lines.len() > 1 {
                format!(
                    "{} ({} x {})",
                    js_trim(&l.description),
                    js::number_text(l.quantity),
                    js::to_fixed(l.unit_price, 2)
                )
            } else {
                js_trim(&l.description).to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let iss_rows: Vec<&Map<String, Value>> = args
        .taxes
        .lines
        .iter()
        .flat_map(|rows| rows.iter().filter(|r| component(r) == Some("iss")))
        .collect();
    Ok(Service {
        amount: service_amount,
        description: head(&description, 1000),
        service_code: codes.into_iter().next().unwrap_or_default(),
        nbs: lines
            .iter()
            .map(|l| digits_of(text(&l.fiscal, "nbs").as_deref()))
            .find(|d| !d.is_empty()),
        iss_rate: iss_rows.first().map(|r| rate_value(r)),
        iss_amount: round2(iss_rows.iter().fold(0.0, |s, r| s + amount(r, "taxAmount"))),
        export_service: lines.iter().all(|l| l.kind.as_deref() == Some("export_service")),
        exempt: lines.iter().all(|l| l.kind.as_deref() == Some("exempt")),
    })
}

fn require_service_issuer(issuer: &Issuer, missing: &mut Vec<String>) {
    if issuer.cnpj.is_empty() {
        missing.push("the entity's CNPJ".into());
    }
    if digits_of(text(&issuer.settings, "municipalityCode").as_deref()).is_empty() {
        missing.push("the entity's IBGE municipality code in its Brazil settings".into());
    }
    if !js::truthy(issuer.settings.get("inscricaoMunicipal")) {
        missing.push("the entity's Inscrição Municipal in its Brazil settings".into());
    }
}

fn require_domestic_tomador(
    counterparty: &Counterparty,
    missing: &mut Vec<String>,
) -> Result<Option<(&'static str, String)>, PayloadError> {
    if is_foreign(text(&counterparty.address, "country").as_deref()) {
        return Err(PayloadError::new(
            "An NFS-e to a customer abroad (exportação de serviços) is not supported yet: issue it in the provider or municipal portal",
            Vec::new(),
        ));
    }
    let id = counterparty_id(counterparty);
    if id.is_none() {
        missing.push("the customer's CNPJ or CPF".into());
    }
    Ok(id)
}

fn service_notes(document: &Document) -> Option<String> {
    let parts = invoice_notes(document);
    (!parts.is_empty()).then(|| head(&parts.join(" | "), 2000))
}

/// The tomador's address (`tomadorAddress`).
fn tomador_address(counterparty: &Counterparty) -> Map<String, Value> {
    let address = &counterparty.address;
    let (street, number) = split_street(text(address, "line1").as_deref());
    let mut out = Map::new();
    if !street.is_empty() {
        put(&mut out, "logradouro", street);
        put(&mut out, "numero", number);
    }
    put(&mut out, "complemento", address.get("line2").cloned().unwrap_or(Value::Null));
    put(&mut out, "bairro", address.get("county").cloned().unwrap_or(Value::Null));
    put(
        &mut out,
        "codigo_municipio",
        counterparty.fiscal.get("municipalityCode").cloned().unwrap_or(Value::Null),
    );
    put_opt(&mut out, "uf", text(address, "state").map(|s| s.to_uppercase()));
    let cep = digits_of(text(address, "postalCode").as_deref());
    if !cep.is_empty() {
        put(&mut out, "cep", cep);
    }
    out
}

fn parse_municipality(text: &str) -> Value {
    js::parse_int(text).map_or(Value::Null, |v| json!(v))
}

/// `buildNfsenPayload(args)`: the NFS-e Nacional (DPS).
#[allow(clippy::too_many_lines)] // the body field by field, as TypeScript
pub(crate) fn build_nfsen(args: &Args) -> Result<Value, PayloadError> {
    let issuer = &args.issuer;
    let counterparty = &args.counterparty;
    let mut missing = Vec::new();
    require_service_issuer(issuer, &mut missing);
    let id = require_domestic_tomador(counterparty, &mut missing)?;
    let service = summarize_service(args, &mut missing)?;
    let national = if service.service_code.is_empty() {
        None
    } else {
        national_service_code(&service.service_code)
    };
    if !service.service_code.is_empty() && national.is_none() {
        missing.push(format!(
            "the service code \"{}\" is not an LC 116 item",
            service.service_code
        ));
    }
    if args.dps_number.is_none() {
        missing.push("the DPS number".into());
    }
    if !missing.is_empty() {
        return Err(PayloadError::new("The NFS-e is missing data", unique(missing)));
    }
    let simples = is_simples_regime(&issuer.regime);
    let withheld = withholding_totals(&args.taxes.withheld);
    let municipality = digits_of(text(&issuer.settings, "municipalityCode").as_deref());
    let emission = brasilia_iso(args.now_ms);
    let emission_day = head(&emission, 10);
    let competence = if args.document.issue_date.as_str() > emission_day.as_str() {
        emission_day
    } else {
        args.document.issue_date.clone()
    };
    let iss_taxation = if service.export_service {
        3
    } else if service.exempt {
        4
    } else {
        1
    };
    let mut out = Map::new();
    put(&mut out, "data_emissao", emission);
    put(&mut out, "data_competencia", competence);
    put(
        &mut out,
        "serie_dps",
        issuer.settings.get("dpsSeries").cloned().filter(|v| !v.is_null()).unwrap_or(json!(1)),
    );
    put_opt(&mut out, "numero_dps", args.dps_number);
    put(&mut out, "emitente_dps", 1);
    put(&mut out, "codigo_municipio_emissora", parse_municipality(&municipality));
    put(&mut out, "cnpj_prestador", issuer.cnpj.clone());
    put(
        &mut out,
        "inscricao_municipal_prestador",
        issuer.settings.get("inscricaoMunicipal").cloned().unwrap_or(Value::Null),
    );
    put(&mut out, "codigo_municipio_prestador", parse_municipality(&municipality));
    put(
        &mut out,
        "codigo_opcao_simples_nacional",
        if issuer.regime == "mei" {
            2
        } else if simples {
            3
        } else {
            1
        },
    );
    if simples {
        put(&mut out, "regime_tributario_simples_nacional", 1);
    }
    put(&mut out, "regime_especial_tributacao", 0);
    let tomador = tomador_address(counterparty);
    party_id_fields(&mut out, id.as_ref(), "cnpj_tomador", "cpf_tomador");
    put(&mut out, "razao_social_tomador", head(&counterparty.name, 150));
    put(
        &mut out,
        "inscricao_municipal_tomador",
        counterparty.fiscal.get("inscricaoMunicipal").cloned().unwrap_or(Value::Null),
    );
    if let Some(code) = tomador.get("codigo_municipio").filter(|c| js::truthy(Some(c))) {
        let code = match code {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        put(&mut out, "codigo_municipio_tomador", parse_municipality(&code));
    }
    for (key, from) in [
        ("cep_tomador", "cep"),
        ("logradouro_tomador", "logradouro"),
        ("numero_tomador", "numero"),
        ("complemento_tomador", "complemento"),
        ("bairro_tomador", "bairro"),
    ] {
        put(&mut out, key, tomador.get(from).cloned().unwrap_or(Value::Null));
    }
    put_opt(&mut out, "email_tomador", counterparty.email.as_deref().map(|e| head(e, 80)));
    put(&mut out, "codigo_municipio_prestacao", parse_municipality(&municipality));
    put_opt(&mut out, "codigo_tributacao_nacional_iss", national);
    put_opt(&mut out, "codigo_nbs", service.nbs.clone());
    put(&mut out, "descricao_servico", service.description.clone());
    put_opt(&mut out, "informacoes_complementares", service_notes(&args.document));
    put(&mut out, "valor_servico", n(service.amount));
    put(&mut out, "tributacao_iss", iss_taxation);
    put(&mut out, "tipo_retencao_iss", if withheld.iss > 0.0 { 2 } else { 1 });
    if !simples && iss_taxation == 1 {
        put_opt(&mut out, "percentual_aliquota_relativa_municipio", service.iss_rate.clone());
    }
    if withheld.pis > 0.0 || withheld.cofins > 0.0 || withheld.csll > 0.0 {
        put(&mut out, "situacao_tributaria_pis_cofins", "01");
        put(&mut out, "base_calculo_pis_cofins", n(service.amount));
        put(&mut out, "aliquota_pis", n(0.65));
        put(&mut out, "aliquota_cofins", 3);
        put(&mut out, "valor_pis", n(withheld.pis));
        put(&mut out, "valor_cofins", n(withheld.cofins));
        put(&mut out, "tipo_retencao_pis_cofins", 3);
        put(&mut out, "valor_csll", n(withheld.csll));
    }
    if withheld.irrf > 0.0 {
        put(&mut out, "valor_irrf", n(withheld.irrf));
    }
    if withheld.inss > 0.0 {
        put(&mut out, "valor_cp", n(withheld.inss));
    }
    let has_ibs_cbs = args
        .taxes
        .lines
        .iter()
        .any(|rows| rows.iter().any(|r| matches!(component(r), Some("cbs" | "ibs"))));
    if has_ibs_cbs {
        let first = args.lines.first();
        put(&mut out, "finalidade_emissao", 0);
        put(
            &mut out,
            "consumidor_final",
            i64::from(js::truthy(args.document.fiscal.get("finalConsumer"))),
        );
        put(&mut out, "indicador_destinatario", 0);
        put(
            &mut out,
            "ibs_cbs_situacao_tributaria",
            first
                .and_then(|l| l.fiscal.get("ibsCbsCst").cloned())
                .filter(|v| !v.is_null())
                .unwrap_or(json!("000")),
        );
        put(
            &mut out,
            "ibs_cbs_classificacao_tributaria",
            first
                .and_then(|l| l.fiscal.get("cClassTrib").cloned())
                .filter(|v| !v.is_null())
                .unwrap_or(json!("000001")),
        );
    }
    Ok(Value::Object(compact(out)))
}

/// `buildNfsePayload(args)`: the municipal NFS-e.
pub(crate) fn build_nfse(args: &Args) -> Result<Value, PayloadError> {
    let issuer = &args.issuer;
    let counterparty = &args.counterparty;
    let mut missing = Vec::new();
    require_service_issuer(issuer, &mut missing);
    let id = require_domestic_tomador(counterparty, &mut missing)?;
    let service = summarize_service(args, &mut missing)?;
    let item = if service.service_code.is_empty() {
        None
    } else {
        municipal_service_item(&service.service_code)
    };
    if !service.service_code.is_empty() && item.is_none() {
        missing.push(format!(
            "the service code \"{}\" is not an LC 116 item",
            service.service_code
        ));
    }
    if !missing.is_empty() {
        return Err(PayloadError::new("The NFS-e is missing data", unique(missing)));
    }
    let simples = is_simples_regime(&issuer.regime);
    let withheld = withholding_totals(&args.taxes.withheld);
    let municipality = digits_of(text(&issuer.settings, "municipalityCode").as_deref());
    let rate = service
        .iss_rate
        .clone()
        .or_else(|| issuer.settings.get("issRate").cloned())
        .unwrap_or(Value::Null);

    let mut prestador = Map::new();
    put(&mut prestador, "cnpj", issuer.cnpj.clone());
    put(
        &mut prestador,
        "inscricao_municipal",
        issuer.settings.get("inscricaoMunicipal").cloned().unwrap_or(Value::Null),
    );
    put(&mut prestador, "codigo_municipio", municipality.clone());

    let mut tomador = Map::new();
    party_id_fields(&mut tomador, id.as_ref(), "cnpj", "cpf");
    put(&mut tomador, "razao_social", head(&counterparty.name, 115));
    put(
        &mut tomador,
        "inscricao_municipal",
        counterparty.fiscal.get("inscricaoMunicipal").cloned().unwrap_or(Value::Null),
    );
    put_opt(&mut tomador, "email", counterparty.email.as_deref().map(|e| head(e, 80)));
    put(&mut tomador, "endereco", Value::Object(compact(tomador_address(counterparty))));

    let mut servico = Map::new();
    put(&mut servico, "valor_servicos", n(service.amount));
    put(&mut servico, "iss_retido", withheld.iss > 0.0);
    if !simples {
        put(&mut servico, "valor_iss", n(service.iss_amount));
    }
    if withheld.iss > 0.0 {
        put(&mut servico, "valor_iss_retido", n(withheld.iss));
    }
    put(&mut servico, "aliquota", rate);
    for (key, value) in [
        ("valor_pis", withheld.pis),
        ("valor_cofins", withheld.cofins),
        ("valor_csll", withheld.csll),
        ("valor_ir", withheld.irrf),
        ("valor_inss", withheld.inss),
    ] {
        if value > 0.0 {
            put(&mut servico, key, n(value));
        }
    }
    put_opt(&mut servico, "item_lista_servico", item);
    let cnae = digits_of(text(&issuer.settings, "cnae").as_deref());
    if !cnae.is_empty() {
        put(&mut servico, "codigo_cnae", cnae);
    }
    put(
        &mut servico,
        "codigo_tributario_municipio",
        issuer.settings.get("codigoTributarioMunicipio").cloned().unwrap_or(Value::Null),
    );
    let discriminacao: Vec<String> = [Some(service.description.clone()), service_notes(&args.document)]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect();
    put(&mut servico, "discriminacao", head(&discriminacao.join("\n"), 2000));
    put(&mut servico, "codigo_municipio", municipality);

    let mut out = Map::new();
    put(&mut out, "data_emissao", brasilia_iso(args.now_ms));
    put(&mut out, "natureza_operacao", if service.exempt { "3" } else { "1" });
    put(&mut out, "optante_simples_nacional", simples);
    put(&mut out, "prestador", Value::Object(compact(prestador)));
    put(&mut out, "tomador", Value::Object(compact(tomador)));
    put(&mut out, "servico", Value::Object(compact(servico)));
    Ok(Value::Object(compact(out)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streets() {
        assert_eq!(split_street(Some("Rua das Flores, 123")), ("Rua das Flores".into(), "123".into()));
        assert_eq!(split_street(Some("Rua das Flores 12a")), ("Rua das Flores".into(), "12A".into()));
        assert_eq!(split_street(Some("Av. Paulista, s/n")), ("Av. Paulista".into(), "S/N".into()));
        assert_eq!(split_street(Some("Praça da Sé")), ("Praça da Sé".into(), "S/N".into()));
        assert_eq!(return_cfop("5102"), "1202");
        assert_eq!(return_cfop("5405"), "1405");
        assert_eq!(national_service_code("01.07").as_deref(), Some("010701"));
        assert_eq!(brasilia_iso(0), "1969-12-31T21:00:00-03:00");
    }
}
