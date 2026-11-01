//! Brazil's document tax engine (`jurisdictions/br/tax-engine`, with the
//! parts of `regimes`, `states` and `tax-profiles` it reads): the taxes of
//! every line of a document at once, plugged into the shared tax
//! calculation through [`crate::tax::document_tax_hook`].
//!
//! One line carries several taxes, each with its own base and relation to
//! the price: ISS, ICMS (+FCP), PIS and COFINS inside the price
//! (`embedded`), IPI on top (`added`), CBS / IBS printed only in 2026
//! (`informational`), and IRRF, CSRF, INSS and ISS retido kept back by the
//! payer (`withheld`, on the whole document). Simples Nacional and MEI
//! itemise nothing; withholdings still apply.
//!
//! Owned by the VAT/GST/Brazil area (`books-tax`); sales and purchases call
//! it through the hook.

use serde_json::{Map, Value, json};

use crate::js::{self, round_money as round2};
use crate::tax::{Direction, HookContext, HookLine, HookResult, TaxError};

/// `BrState`: UF, IBGE code, region, modal internal ICMS rate, FCP.
#[derive(Debug, Clone, Copy)]
pub struct BrState {
    pub uf: &'static str,
    pub name: &'static str,
    pub ibge: &'static str,
    pub region: &'static str,
    pub icms_internal: f64,
    pub fcp: f64,
}

const fn st(
    uf: &'static str,
    name: &'static str,
    ibge: &'static str,
    region: &'static str,
    icms_internal: f64,
    fcp: f64,
) -> BrState {
    BrState {
        uf,
        name,
        ibge,
        region,
        icms_internal,
        fcp,
    }
}

/// `BR_STATES` (rates as of October 2026).
pub const BR_STATES: [BrState; 27] = [
    st("AC", "Acre", "12", "N", 19.0, 0.0),
    st("AL", "Alagoas", "27", "NE", 20.5, 0.0),
    st("AP", "Amapá", "16", "N", 18.0, 0.0),
    st("AM", "Amazonas", "13", "N", 20.0, 0.0),
    st("BA", "Bahia", "29", "NE", 20.5, 0.0),
    st("CE", "Ceará", "23", "NE", 20.0, 0.0),
    st("DF", "Distrito Federal", "53", "CO", 20.0, 0.0),
    st("ES", "Espírito Santo", "32", "SE", 17.0, 0.0),
    st("GO", "Goiás", "52", "CO", 19.0, 0.0),
    st("MA", "Maranhão", "21", "NE", 23.0, 0.0),
    st("MT", "Mato Grosso", "51", "CO", 17.0, 0.0),
    st("MS", "Mato Grosso do Sul", "50", "CO", 17.0, 0.0),
    st("MG", "Minas Gerais", "31", "SE", 18.0, 0.0),
    st("PA", "Pará", "15", "N", 19.0, 0.0),
    st("PB", "Paraíba", "25", "NE", 20.0, 0.0),
    st("PR", "Paraná", "41", "S", 19.5, 0.0),
    st("PE", "Pernambuco", "26", "NE", 20.5, 0.0),
    st("PI", "Piauí", "22", "NE", 22.5, 0.0),
    st("RJ", "Rio de Janeiro", "33", "SE", 20.0, 2.0),
    st("RN", "Rio Grande do Norte", "24", "NE", 20.0, 0.0),
    st("RS", "Rio Grande do Sul", "43", "S", 17.0, 0.0),
    st("RO", "Rondônia", "11", "N", 19.5, 0.0),
    st("RR", "Roraima", "14", "N", 20.0, 0.0),
    st("SC", "Santa Catarina", "42", "S", 17.0, 0.0),
    st("SP", "São Paulo", "35", "SE", 18.0, 0.0),
    st("SE", "Sergipe", "28", "NE", 19.0, 1.0),
    st("TO", "Tocantins", "17", "N", 20.0, 0.0),
];

/// `brState(code)`: by UF, IBGE code or name (accents optional).
pub fn br_state(code: Option<&str>) -> Option<&'static BrState> {
    let code = code.filter(|c| !c.is_empty())?;
    let found = super::br::state(code)?;
    let uf = found["uf"].as_str()?;
    BR_STATES.iter().find(|s| s.uf == uf)
}

/// `IMPORTED_ORIGINS`: foreign goods or over 40% imported content.
const IMPORTED_ORIGINS: [&str; 4] = ["1", "2", "3", "8"];

/// `interstateIcmsRate(originUf, destinationUf, origin)`.
pub fn interstate_icms_rate(origin_uf: &str, destination_uf: &str, origin: Option<&str>) -> f64 {
    if origin.is_some_and(|o| IMPORTED_ORIGINS.contains(&o)) {
        return 4.0;
    }
    let (Some(from), Some(to)) = (br_state(Some(origin_uf)), br_state(Some(destination_uf)))
    else {
        return 12.0;
    };
    let south_southeast = (from.region == "S" || from.region == "SE") && from.uf != "ES";
    let lower =
        to.region == "N" || to.region == "NE" || to.region == "CO" || to.uf == "ES";
    if south_southeast && lower { 7.0 } else { 12.0 }
}

/// `icmsRateForSale(args)`: (rate, interstate, fcp).
pub fn icms_rate_for_sale(
    origin_uf: &str,
    destination_uf: Option<&str>,
    origin: Option<&str>,
) -> (f64, bool, f64) {
    let from = br_state(Some(origin_uf));
    let to = br_state(Some(destination_uf.unwrap_or(origin_uf))).or(from);
    match (from, to) {
        (Some(from), Some(to)) if from.uf != to.uf => (
            interstate_icms_rate(from.uf, to.uf, origin),
            true,
            0.0,
        ),
        _ => (
            from.map_or(0.0, |f| f.icms_internal),
            false,
            from.map_or(0.0, |f| f.fcp),
        ),
    }
}

/// `isSimplesRegime(regime)`.
pub fn is_simples_regime(regime: &str) -> bool {
    regime == "simples_nacional" || regime == "mei"
}

/// `pisCofinsRates(regime)`: (pis, cofins, cumulative).
pub fn pis_cofins_rates(regime: &str) -> Option<(f64, f64, bool)> {
    match regime {
        "lucro_presumido" => Some((0.65, 3.0, true)),
        "lucro_real" => Some((1.65, 7.6, false)),
        _ => None,
    }
}

/// `crtOf(regime, overSublimit)`.
pub fn crt_of(regime: &str, over_sublimit: bool) -> &'static str {
    match regime {
        "mei" => "4",
        "simples_nacional" if over_sublimit => "2",
        "simples_nacional" => "1",
        _ => "3",
    }
}

/// `BR_WITHHOLDING_MINIMUM`.
pub const WITHHOLDING_MINIMUM: f64 = 10.0;
/// `BR_CBS_TEST_RATE`, `BR_IBS_TEST_RATE`.
pub const CBS_TEST_RATE: f64 = 0.9;
pub const IBS_TEST_RATE: f64 = 0.1;

/// `rate.toLocaleString('pt-BR', { maximumFractionDigits: 2 })`: the
/// shortest decimal of the double rounded half away from zero, a decimal
/// comma and `.` between thousands.
pub fn pt_br_number(value: f64) -> String {
    if !value.is_finite() {
        return js::number_text(value);
    }
    let text = format!("{}", value.abs());
    let (int, frac) = text.split_once('.').unwrap_or((text.as_str(), ""));
    let mut digits: Vec<u8> = int.bytes().chain(frac.bytes()).collect();
    let int_len = int.len();
    let keep = int_len + frac.len().min(2);
    if frac.len() > 2 && digits[keep] >= b'5' {
        let mut at = keep;
        let mut carry = true;
        while carry && at > 0 {
            at -= 1;
            if digits[at] == b'9' {
                digits[at] = b'0';
            } else {
                digits[at] += 1;
                carry = false;
            }
        }
        digits.truncate(keep);
        if carry {
            digits.insert(0, b'1');
            return finish_pt(&digits, int_len + 1, value < 0.0);
        }
    }
    digits.truncate(keep);
    finish_pt(&digits, int_len, value < 0.0)
}

fn finish_pt(digits: &[u8], int_len: usize, negative: bool) -> String {
    let (int, frac) = digits.split_at(int_len);
    let mut frac: Vec<u8> = frac.to_vec();
    while frac.last() == Some(&b'0') {
        frac.pop();
    }
    let int = String::from_utf8_lossy(int).into_owned();
    let mut grouped = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            grouped.push('.');
        }
        grouped.push(c);
    }
    let zero = grouped.chars().all(|c| c == '0') && frac.is_empty();
    let mut out = if negative && !zero {
        format!("-{grouped}")
    } else {
        grouped
    };
    if !frac.is_empty() {
        out.push(',');
        out.push_str(&String::from_utf8_lossy(&frac));
    }
    out
}

fn pct(rate: f64) -> String {
    format!("{}%", pt_br_number(rate))
}

/// `yearOf(date)`: the issue year, or this year.
fn year_of(date: Option<&str>) -> i64 {
    let head: String = date.unwrap_or_default().chars().take(4).collect();
    match js::parse_int(&head) {
        Some(year) if year > 2000 => year,
        _ => {
            let now = crate::http::now();
            js::parse_int(&now[..4]).unwrap_or(2026)
        }
    }
}

/// `num(value)`: a finite number, or a numeric string (`,` as decimal).
pub fn num(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite()),
        Value::String(text) if !super::js_trim(text).is_empty() => {
            let parsed = js::parse_float(&text.replacen(',', ".", 1));
            parsed.is_finite().then_some(parsed)
        }
        _ => None,
    }
}

struct RowArgs<'a> {
    line: &'a HookLine,
    name: &'a str,
    component: &'a str,
    rate: f64,
    base: f64,
    treatment: &'a str,
    account_role: Option<&'a str>,
    offset_account_role: Option<&'a str>,
}

fn row(args: &RowArgs<'_>) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert(
        "taxRateId".into(),
        json!(args.line.tax_rate_id.clone().unwrap_or_default()),
    );
    out.insert(
        "taxRateName".into(),
        json!(format!("{} {}", args.name, pct(args.rate))),
    );
    out.insert("taxRate".into(), js::number_value(args.rate));
    out.insert("taxableAmount".into(), js::number_value(round2(args.base)));
    out.insert(
        "taxAmount".into(),
        js::number_value(round2(args.base * (args.rate / 100.0))),
    );
    out.insert("component".into(), json!(args.component));
    if let Some(role) = args.account_role {
        out.insert("accountRole".into(), json!(role));
    }
    if let Some(role) = args.offset_account_role {
        out.insert("offsetAccountRole".into(), json!(role));
    }
    out.insert(
        "taxCategoryCode".into(),
        json!(
            args.line
                .tax_category_code
                .clone()
                .unwrap_or_else(|| "standard".into())
        ),
    );
    out.insert("treatment".into(), json!(args.treatment));
    out
}

fn tax_of(row: &Map<String, Value>) -> f64 {
    row.get("taxAmount").and_then(Value::as_f64).unwrap_or(0.0)
}

struct State {
    regime: String,
    year: i64,
    sales: bool,
    entity_uf: Option<&'static str>,
    counterparty_uf: Option<&'static str>,
    foreign: bool,
    final_consumer: bool,
    cbs_rate: Option<f64>,
    ibs_rate: Option<f64>,
    default_iss_rate: f64,
    icms_contributor: bool,
    /// In first-seen order (a `Set`).
    warnings: Vec<String>,
}

impl State {
    fn warn(&mut self, message: impl Into<String>) {
        let message = message.into();
        if !self.warnings.contains(&message) {
            self.warnings.push(message);
        }
    }
}

fn kind_of(profile: &Value) -> &str {
    profile["kind"].as_str().unwrap_or_default()
}

fn sales_line(line: &HookLine, profile: &Value, s: &mut State) -> Vec<Map<String, Value>> {
    let kind = kind_of(profile);
    if matches!(kind, "exempt" | "export_goods" | "export_service")
        || s.foreign
        || is_simples_regime(&s.regime)
    {
        return Vec::new();
    }
    let fiscal = line.fiscal_data.clone().unwrap_or_else(|| json!({}));
    let amount = line.line_total;
    let mut rows = Vec::new();
    let mut icms_total = 0.0;
    let mut iss_amount = 0.0;
    if kind == "service" {
        let iss_rate = num(fiscal.get("issRate"))
            .or_else(|| profile["issRate"].as_f64())
            .unwrap_or(s.default_iss_rate);
        let iss = row(&RowArgs {
            line,
            name: "ISS",
            component: "iss",
            rate: iss_rate,
            base: line.line_total,
            treatment: "embedded",
            account_role: Some("tax_payable_iss"),
            offset_account_role: Some("revenue_deduction_iss"),
        });
        iss_amount = tax_of(&iss);
        rows.push(iss);
    } else {
        let mut ipi_amount = 0.0;
        if kind == "goods_production" {
            let ipi_rate = num(fiscal.get("ipiRate")).unwrap_or(0.0);
            if s.year >= 2027 && ipi_rate > 0.0 {
                s.warn("IPI is reduced to zero from 2027 (LC 214/2025) except for goods also made in the Zona Franca de Manaus: check the rate.");
            }
            if ipi_rate > 0.0 {
                let ipi = row(&RowArgs {
                    line,
                    name: "IPI",
                    component: "ipi",
                    rate: ipi_rate,
                    base: line.line_total,
                    treatment: "added",
                    account_role: Some("tax_payable_ipi"),
                    offset_account_role: None,
                });
                ipi_amount = tax_of(&ipi);
                rows.push(ipi);
            } else if !js::truthy(fiscal.get("ipiRate"))
                && fiscal.get("ipiRate").and_then(Value::as_f64) != Some(0.0)
            {
                s.warn("No IPI rate on a line of own production: enter the TIPI rate of its NCM (0 if none).");
            }
        }
        // ICMS (and FCP) inside the price.
        if s.entity_uf.is_none() {
            s.warn("The entity's state (UF) is not set, so ICMS can't be worked out.");
        }
        let origin = fiscal.get("origin").and_then(Value::as_str);
        let (resolved_rate, interstate, fcp) = match s.entity_uf {
            Some(uf) => icms_rate_for_sale(uf, Some(s.counterparty_uf.unwrap_or(uf)), origin),
            None => (0.0, false, 0.0),
        };
        let icms_rate = num(fiscal.get("icmsRate")).unwrap_or(resolved_rate);
        let icms_base = line.line_total + if s.final_consumer { ipi_amount } else { 0.0 };
        if icms_rate > 0.0 {
            let icms = row(&RowArgs {
                line,
                name: "ICMS",
                component: "icms",
                rate: icms_rate,
                base: icms_base,
                treatment: "embedded",
                account_role: Some("tax_payable_icms"),
                offset_account_role: Some("revenue_deduction_icms"),
            });
            icms_total += tax_of(&icms);
            rows.push(icms);
        }
        if fcp > 0.0 && fiscal.get("icmsRate").is_none() {
            let fcp_row = row(&RowArgs {
                line,
                name: "FCP",
                component: "fcp",
                rate: fcp,
                base: icms_base,
                treatment: "embedded",
                account_role: Some("tax_payable_icms"),
                offset_account_role: Some("revenue_deduction_icms"),
            });
            icms_total += tax_of(&fcp_row);
            rows.push(fcp_row);
        }
        if interstate && s.final_consumer {
            s.warn("Interstate sale to a final consumer: the ICMS rate difference (DIFAL) owed to the destination state is not calculated. Add it on the NF-e or pay it by GNRE.");
        }
    }

    // PIS / COFINS until 2026.
    let mut pis_cofins_total = 0.0;
    if let Some((pis, cofins, _)) = pis_cofins_rates(&s.regime)
        && s.year < 2027
    {
        let base = amount - icms_total;
        let pis_row = row(&RowArgs {
            line,
            name: "PIS",
            component: "pis",
            rate: pis,
            base,
            treatment: "embedded",
            account_role: Some("tax_payable_pis"),
            offset_account_role: Some("revenue_deduction_pis"),
        });
        let cofins_row = row(&RowArgs {
            line,
            name: "COFINS",
            component: "cofins",
            rate: cofins,
            base,
            treatment: "embedded",
            account_role: Some("tax_payable_cofins"),
            offset_account_role: Some("revenue_deduction_cofins"),
        });
        pis_cofins_total = tax_of(&pis_row) + tax_of(&cofins_row);
        rows.push(pis_row);
        rows.push(cofins_row);
    }
    rows.extend(cbs_ibs_rows(
        line,
        amount - icms_total - iss_amount - pis_cofins_total,
        s,
    ));
    rows
}

fn cbs_ibs_rows(line: &HookLine, base: f64, s: &mut State) -> Vec<Map<String, Value>> {
    if is_simples_regime(&s.regime) || base <= 0.0 {
        return Vec::new();
    }
    if s.year == 2026 {
        return vec![
            row(&RowArgs {
                line,
                name: "CBS",
                component: "cbs",
                rate: CBS_TEST_RATE,
                base,
                treatment: "informational",
                account_role: None,
                offset_account_role: None,
            }),
            row(&RowArgs {
                line,
                name: "IBS",
                component: "ibs",
                rate: IBS_TEST_RATE,
                base,
                treatment: "informational",
                account_role: None,
                offset_account_role: None,
            }),
        ];
    }
    if s.year < 2026 {
        return Vec::new();
    }
    let mut rows = Vec::new();
    let sales = s.sales;
    match s.cbs_rate {
        Some(rate) if rate > 0.0 => rows.push(row(&RowArgs {
            line,
            name: "CBS",
            component: "cbs",
            rate,
            base,
            treatment: "added",
            account_role: Some(if sales {
                "tax_payable_cbs"
            } else {
                "tax_recoverable_cbs"
            }),
            offset_account_role: None,
        })),
        _ => {
            let year = s.year;
            s.warn(format!(
                "No CBS rate is set for {year}: add it under the entity's Brazil settings."
            ));
        }
    }
    if let Some(rate) = s.ibs_rate.filter(|r| *r > 0.0) {
        rows.push(row(&RowArgs {
            line,
            name: "IBS",
            component: "ibs",
            rate,
            base,
            treatment: "added",
            account_role: Some(if sales {
                "tax_payable_ibs"
            } else {
                "tax_recoverable_ibs"
            }),
            offset_account_role: None,
        }));
    }
    rows
}

fn purchase_line(line: &HookLine, profile: &Value, s: &mut State) -> Vec<Map<String, Value>> {
    let Some(credits) = profile.get("credits").filter(|c| js::truthy(Some(c))) else {
        return Vec::new();
    };
    if is_simples_regime(&s.regime) || s.foreign {
        return Vec::new();
    }
    let fiscal = line.fiscal_data.clone().unwrap_or_else(|| json!({}));
    let amount = line.line_total;
    let mut rows = Vec::new();
    let ipi_rate = num(fiscal.get("ipiRate")).unwrap_or(0.0);
    if ipi_rate > 0.0 {
        rows.push(row(&RowArgs {
            line,
            name: "IPI",
            component: "ipi",
            rate: ipi_rate,
            base: amount,
            treatment: "added",
            account_role: js::truthy(credits.get("ipi")).then_some("tax_recoverable_ipi"),
            offset_account_role: None,
        }));
    }
    let mut icms_amount = 0.0;
    if js::truthy(credits.get("icms")) && s.icms_contributor {
        let origin = fiscal.get("origin").and_then(Value::as_str);
        let resolved = match s.entity_uf {
            Some(uf) => icms_rate_for_sale(s.counterparty_uf.unwrap_or(uf), Some(uf), origin).0,
            None => 0.0,
        };
        let icms_rate = num(fiscal.get("icmsRate")).unwrap_or(resolved);
        if icms_rate > 0.0 {
            let icms = row(&RowArgs {
                line,
                name: "ICMS",
                component: "icms",
                rate: icms_rate,
                base: amount,
                treatment: "embedded",
                account_role: Some("tax_recoverable_icms"),
                offset_account_role: None,
            });
            icms_amount = tax_of(&icms);
            rows.push(icms);
        }
    }
    if js::truthy(credits.get("pisCofins")) && s.regime == "lucro_real" && s.year < 2027 {
        let base = amount - icms_amount;
        rows.push(row(&RowArgs {
            line,
            name: "PIS",
            component: "pis",
            rate: 1.65,
            base,
            treatment: "embedded",
            account_role: Some("tax_recoverable_pis"),
            offset_account_role: None,
        }));
        rows.push(row(&RowArgs {
            line,
            name: "COFINS",
            component: "cofins",
            rate: 7.6,
            base,
            treatment: "embedded",
            account_role: Some("tax_recoverable_cofins"),
            offset_account_role: None,
        }));
    }
    rows
}

/// The withholdings of a document's service lines (`withholdingRows`).
fn withholding_rows(
    service_base: f64,
    config: &Value,
    s: &mut State,
    counterparty_simples: bool,
) -> Vec<Map<String, Value>> {
    if service_base <= 0.0 {
        return Vec::new();
    }
    let sales = s.sales;
    let doc = HookLine {
        line_total: service_base,
        tax_rate_id: None,
        tax_rate_name: None,
        tax_category_code: Some("standard".into()),
        rate: 0.0,
        jurisdiction_metadata: None,
        fiscal_data: None,
    };
    let provider_simples = if sales {
        is_simples_regime(&s.regime)
    } else {
        counterparty_simples
    };
    let withheld = |name: &'static str,
                    component: &'static str,
                    rate: f64,
                    role: &'static str| {
        row(&RowArgs {
            line: &doc,
            name,
            component,
            rate,
            base: service_base,
            treatment: "withheld",
            account_role: Some(role),
            offset_account_role: None,
        })
    };
    let mut rows = Vec::new();

    if let Some(iss) = num(config.get("iss")).filter(|r| *r > 0.0) {
        let role = if !sales {
            "withholding_payable_iss"
        } else if provider_simples {
            "revenue_deduction_iss"
        } else {
            "tax_payable_iss"
        };
        rows.push(withheld("ISS retido", "iss_ret", iss, role));
    }
    if let Some(irrf) = num(config.get("irrf")).filter(|r| *r > 0.0) {
        if provider_simples {
            s.warn("No IRRF is withheld from a Simples Nacional provider.");
        } else {
            let r = withheld(
                "IRRF",
                "irrf",
                irrf,
                if sales {
                    "withheld_receivable_irrf"
                } else {
                    "withholding_payable_irrf"
                },
            );
            if tax_of(&r) <= WITHHOLDING_MINIMUM {
                s.warn(format!(
                    "IRRF of R$ {} is not withheld (R$ 10.00 or less).",
                    js::to_fixed(tax_of(&r), 2)
                ));
            } else {
                rows.push(r);
            }
        }
    }
    if js::truthy(config.get("csrf")) {
        if provider_simples {
            s.warn("No PIS/COFINS/CSLL is withheld from a Simples Nacional provider.");
        } else {
            let csrf = vec![
                withheld(
                    "PIS retido",
                    "pis_ret",
                    0.65,
                    if sales {
                        "withheld_receivable_pis"
                    } else {
                        "withholding_payable_csrf"
                    },
                ),
                withheld(
                    "COFINS retida",
                    "cofins_ret",
                    3.0,
                    if sales {
                        "withheld_receivable_cofins"
                    } else {
                        "withholding_payable_csrf"
                    },
                ),
                withheld(
                    "CSLL retida",
                    "csll_ret",
                    1.0,
                    if sales {
                        "withheld_receivable_csll"
                    } else {
                        "withholding_payable_csrf"
                    },
                ),
            ];
            let total = round2(csrf.iter().fold(0.0, |sum, r| sum + tax_of(r)));
            if total <= WITHHOLDING_MINIMUM {
                s.warn(format!(
                    "PIS/COFINS/CSLL of R$ {} is not withheld (R$ 10.00 or less).",
                    js::to_fixed(total, 2)
                ));
            } else {
                rows.extend(csrf);
            }
        }
    }
    if let Some(inss) = num(config.get("inss")).filter(|r| *r > 0.0) {
        rows.push(withheld(
            "INSS retido",
            "inss_ret",
            inss,
            if sales {
                "withheld_receivable_inss"
            } else {
                "withholding_payable_inss"
            },
        ));
    }
    rows
}

/// `counterpartyIsForeign(country)`.
fn counterparty_is_foreign(country: Option<&str>) -> bool {
    let Some(country) = country.filter(|c| !c.is_empty()) else {
        return false;
    };
    let c = super::js_trim(country).to_uppercase();
    !c.is_empty() && !matches!(c.as_str(), "BR" | "BRA" | "BRAZIL" | "BRASIL")
}

/// `computeBrDocumentTaxes(lines, ctx)`: the document tax hook of Brazil.
pub fn compute_document_taxes(
    lines: &[HookLine],
    ctx: &HookContext,
) -> Result<HookResult, TaxError> {
    let empty = json!({});
    let settings = ctx.entity_settings.as_ref().unwrap_or(&empty);
    let fiscal = ctx
        .document_fiscal
        .as_ref()
        .filter(|f| !f.is_null())
        .unwrap_or(&empty);
    let counterparty_tax_id: String = ctx
        .counterparty
        .tax_id
        .as_deref()
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    let counterparty_fiscal = ctx
        .counterparty
        .fiscal
        .as_ref()
        .filter(|f| !f.is_null())
        .unwrap_or(&empty);
    let buyer_is_company = counterparty_tax_id.len() == 14;
    let bool_of = |v: Option<&Value>| v.filter(|v| !v.is_null()).and_then(Value::as_bool);
    let buyer_icms_contributor = bool_of(fiscal.get("buyerIcmsContributor"))
        .or_else(|| bool_of(counterparty_fiscal.get("icmsContributor")))
        .unwrap_or(buyer_is_company);

    let mut s = State {
        regime: super::br::regime_of(ctx.entity_tax_classification.as_deref()).to_owned(),
        year: year_of(ctx.issue_date.as_deref()),
        sales: ctx.direction == Direction::Sales,
        entity_uf: br_state(settings.get("uf").and_then(Value::as_str)).map(|s| s.uf),
        counterparty_uf: br_state(ctx.counterparty.state_code.as_deref()).map(|s| s.uf),
        foreign: counterparty_is_foreign(ctx.counterparty.country.as_deref()),
        final_consumer: bool_of(fiscal.get("finalConsumer")).unwrap_or(!buyer_icms_contributor),
        cbs_rate: num(settings.get("cbsRate")),
        ibs_rate: num(settings.get("ibsRate")),
        default_iss_rate: num(settings.get("issRate")).unwrap_or(5.0),
        icms_contributor: bool_of(settings.get("icmsContributor")).unwrap_or(true),
        warnings: Vec::new(),
    };

    let mut service_base = 0.0;
    let mut result_lines = Vec::with_capacity(lines.len());
    for line in lines {
        let profile = super::br::profile_of(line.jurisdiction_metadata.as_ref());
        let Some(profile) = profile else {
            // A rate without a Brazilian profile: a plain rate on top of the price.
            if line.rate == 0.0 || line.rate.is_nan() {
                result_lines.push(Vec::new());
                continue;
            }
            let mut plain = Map::new();
            plain.insert(
                "taxRateId".into(),
                json!(line.tax_rate_id.clone().unwrap_or_default()),
            );
            plain.insert(
                "taxRateName".into(),
                json!(line.tax_rate_name.clone().unwrap_or_else(|| pct(line.rate))),
            );
            plain.insert("taxRate".into(), js::number_value(line.rate));
            plain.insert(
                "taxableAmount".into(),
                js::number_value(round2(line.line_total)),
            );
            plain.insert(
                "taxAmount".into(),
                js::number_value(round2(line.line_total * (line.rate / 100.0))),
            );
            plain.insert(
                "taxCategoryCode".into(),
                json!(
                    line.tax_category_code
                        .clone()
                        .unwrap_or_else(|| "standard".into())
                ),
            );
            result_lines.push(vec![plain]);
            continue;
        };
        if matches!(kind_of(profile), "service" | "export_service") {
            service_base += line.line_total;
        }
        result_lines.push(if s.sales {
            sales_line(line, profile, &mut s)
        } else {
            purchase_line(line, profile, &mut s)
        });
    }

    let document_rows = match fiscal.get("withholdings").filter(|w| js::truthy(Some(w))) {
        Some(config) => {
            let simples = bool_of(fiscal.get("counterpartySimples"))
                .or_else(|| bool_of(counterparty_fiscal.get("simplesNacional")))
                .unwrap_or(false);
            withholding_rows(round2(service_base), config, &mut s, simples)
        }
        None => Vec::new(),
    };
    Ok(HookResult {
        lines: result_lines,
        document_rows,
        warnings: s.warnings,
    })
}

/// `suggestBrWithholdings(args)`: the federal withholdings on a service
/// sold to (or bought from) a company.
pub fn suggest_withholdings(
    provider_regime: &str,
    taker_is_company: bool,
    service_kind: Option<&str>,
) -> Value {
    if !taker_is_company || is_simples_regime(provider_regime) {
        return json!({});
    }
    let mut config = Map::new();
    config.insert("csrf".into(), json!(true));
    match service_kind {
        Some("professional") => {
            config.insert("irrf".into(), json!(1.5));
        }
        Some("cleaning_security") => {
            config.insert("irrf".into(), json!(1));
        }
        _ => {}
    }
    Value::Object(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tax::Counterparty;

    fn line(profile: Value, total: f64, fiscal: Option<Value>) -> HookLine {
        HookLine {
            line_total: total,
            tax_rate_id: Some("rate_x".into()),
            tax_rate_name: None,
            tax_category_code: Some("standard".into()),
            rate: 0.0,
            jurisdiction_metadata: Some(json!({ "br": profile })),
            fiscal_data: fiscal,
        }
    }

    fn ctx(regime: &str, direction: Direction, fiscal: Option<Value>) -> HookContext {
        HookContext {
            direction,
            issue_date: Some("2026-10-14".into()),
            entity_settings: Some(json!({ "uf": "SP", "issRate": 5 })),
            entity_tax_classification: Some(regime.into()),
            counterparty: Counterparty {
                country: Some("BR".into()),
                state_code: Some("SP".into()),
                tax_id: Some("99.887.766/0001-55".into()),
                fiscal: Some(json!({ "icmsContributor": true })),
            },
            document_fiscal: fiscal,
        }
    }

    #[test]
    fn goods_sale_in_sao_paulo() {
        let result = compute_document_taxes(
            &[line(
                json!({ "profile": "venda_mercadoria", "kind": "goods_resale", "regimes": [] }),
                200.0,
                None,
            )],
            &ctx("lucro_presumido", Direction::Sales, None),
        )
        .expect("taxes");
        let rows = &result.lines[0];
        let names: Vec<&str> = rows
            .iter()
            .map(|r| r["taxRateName"].as_str().expect("a name"))
            .collect();
        assert_eq!(
            names,
            ["ICMS 18%", "PIS 0,65%", "COFINS 3%", "CBS 0,9%", "IBS 0,1%"]
        );
        assert_eq!(rows[0]["taxAmount"], json!(36));
        assert_eq!(rows[1]["taxableAmount"], json!(164));
    }

    #[test]
    fn simples_itemises_nothing_but_withholds() {
        let result = compute_document_taxes(
            &[line(
                json!({ "profile": "sn_servicos_iii", "kind": "service", "regimes": [] }),
                1500.0,
                None,
            )],
            &ctx(
                "lucro_presumido",
                Direction::Sales,
                Some(json!({ "withholdings": { "irrf": 1.5, "csrf": true } })),
            ),
        )
        .expect("taxes");
        let components: Vec<&str> = result
            .document_rows
            .iter()
            .map(|r| r["component"].as_str().expect("a component"))
            .collect();
        assert_eq!(components, ["irrf", "pis_ret", "cofins_ret", "csll_ret"]);
    }

    #[test]
    fn numbers_in_portuguese() {
        assert_eq!(pt_br_number(0.65), "0,65");
        assert_eq!(pt_br_number(7.6), "7,6");
        assert_eq!(pt_br_number(18.0), "18");
        assert_eq!(pt_br_number(1.005), "1,01");
        assert_eq!(pt_br_number(2.999), "3");
        assert_eq!(pt_br_number(1234.5), "1.234,5");
        assert_eq!(
            suggest_withholdings("lucro_real", true, Some("professional")),
            json!({ "csrf": true, "irrf": 1.5 })
        );
    }
}
