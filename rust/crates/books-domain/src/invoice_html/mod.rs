//! The printable invoice (`@weldsuite/books-domain/accounting-invoice-html`
//! and `invoice-template/*`): the built-in layout ([`generate_invoice_html`])
//! and an invoice laid out with a designed template
//! ([`generate_templated_invoice_html`]: [`layout`], [`svg`], [`mobile`]),
//! with the jurisdiction's rules (US per-jurisdiction tax and exempt sales,
//! India's HSN/SAC and CGST/SGST split, Brazil's tax groups) and its labels.
//! Money, numbers and dates are formatted as Node's `Intl` does ([`intl`]).
//!
//! Brazil's Pix QR code (`jurisdictions/br/pix`) is not drawn yet: a
//! Brazilian invoice prints without the Pix block.

#![allow(
    clippy::format_collect,
    clippy::format_push_string,
    clippy::assigning_clones,
    reason = "the HTML is built as the TypeScript template literals build it, piece by piece"
)]

pub mod fonts;
pub mod intl;
pub mod layout;
pub mod mobile;
pub mod svg;

use serde_json::{Map, Value};

use crate::address::{format_postal_address_lines, normalize_postal_address};
use crate::compliance::invoice_requirements;
use layout::{DocumentData, LegalData, PartyData, TableColumnData, TableRowData, TotalsRow};

/// One printed line (`InvoiceLineItem`).
#[derive(Debug, Clone, Default)]
pub struct RenderItem {
    pub description: String,
    pub quantity: String,
    pub unit_price: String,
    pub unit: Option<String>,
    pub discount_percent: Option<String>,
    pub tax_rate: Option<String>,
    pub line_total: String,
    pub line_total_with_tax: Option<String>,
    pub tax_amount: Option<String>,
    pub hsn_sac: Option<String>,
}

/// Brazil: the authorised fiscal document of the invoice.
#[derive(Debug, Clone, Default)]
pub struct FiscalDocument {
    pub label: String,
    pub number: Option<String>,
    pub access_key: Option<String>,
}

/// `InvoiceRenderData`.
#[derive(Debug, Clone, Default)]
pub struct InvoiceRenderData {
    pub invoice_number: String,
    pub kind: String,
    /// `toISOString()`.
    pub issue_date: String,
    pub due_date: String,
    pub currency: String,
    pub contact_name: String,
    pub contact_email: Option<String>,
    pub contact_vat_number: Option<String>,
    pub compliance_notices: Vec<String>,
    pub billing_address: Option<Value>,
    pub shipping_address: Option<Value>,
    pub reference: Option<String>,
    pub notes: Option<String>,
    pub items: Vec<RenderItem>,
    pub subtotal: String,
    pub discount_total: String,
    pub tax_total: String,
    pub total: String,
    pub amount_paid: Option<String>,
    pub balance_due: Option<String>,
    pub tax_breakdown: Vec<Value>,
    pub place_of_supply: Option<String>,
    /// US: certificate number by certificate id.
    pub certificate_numbers: Map<String, Value>,
    pub draft: bool,
    pub fiscal_document: Option<FiscalDocument>,
}

/// Why an invoice can't be printed (TypeScript throws: the route's 500).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderError(pub String);

// ── JavaScript values ───────────────────────────────────────────────────────

/// `Number(value)`.
fn number_of(value: Option<&str>) -> f64 {
    value.map_or(f64::NAN, weldsuite_kit::validation::js_number)
}

fn json_number(value: Option<&Value>) -> f64 {
    crate::js::js_number_value(value)
}

/// `escapeHtml(str)`.
fn esc(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#039;")
}

/// `labels.key` in a template literal ("undefined" when the label set has none).
fn l<'a>(labels: &'a Value, key: &str) -> &'a str {
    labels[key].as_str().unwrap_or("undefined")
}

/// `labels.key ?? fallback`.
fn l_or<'a>(labels: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    labels[key].as_str().unwrap_or(fallback)
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn filled<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    text(row, key).filter(|v| !v.is_empty())
}

/// Formatters of a locale and currency.
struct Fmt {
    locale: String,
    currency: String,
}

impl Fmt {
    /// `fmtCurrency(value)`: `Number(value) || 0`.
    fn money_of(&self, value: f64) -> String {
        // `Number(value) || 0`: NaN and -0 are 0.
        let value = if value.is_nan() || value == 0.0 {
            0.0
        } else {
            value
        };
        intl::format_currency(&self.locale, &self.currency, value)
    }

    fn money(&self, value: &str) -> String {
        self.money_of(number_of(Some(value)))
    }

    /// `fmtNumber(value)`.
    fn num_of(&self, value: f64) -> String {
        if value.is_finite() {
            intl::format_number(&self.locale, value)
        } else {
            crate::js::number_text(value)
        }
    }

    fn num(&self, value: &str) -> String {
        let n = number_of(Some(value));
        if n.is_finite() {
            intl::format_number(&self.locale, n)
        } else {
            value.to_owned()
        }
    }

    /// `fmtDate(dateStr)`: an invalid date prints as given.
    fn date(&self, value: &str) -> String {
        match crate::js::js_date_millis(value) {
            Some(millis) => intl::format_long_date(&self.locale, millis),
            None => value.to_owned(),
        }
    }
}

/// `isNotPositive(n)`.
fn not_positive(n: f64) -> bool {
    n.is_nan() || n <= 0.0
}

/// `Math.round(n * 100) / 100`.
fn round_cents(n: f64) -> f64 {
    crate::js::round_cents(n)
}

/// `safeColor(value, fallback)`.
fn safe_color(value: Option<&str>, fallback: &str) -> String {
    let Some(color) = value
        .map(crate::jurisdictions::js_trim)
        .filter(|c| !c.is_empty())
    else {
        return fallback.to_owned();
    };
    let lower = color.to_ascii_lowercase();
    let hex = lower.starts_with('#')
        && (4..=9).contains(&lower.len())
        && lower[1..].bytes().all(|b| b.is_ascii_hexdigit());
    let word = (3..=20).contains(&lower.len()) && lower.bytes().all(|b| b.is_ascii_lowercase());
    let func = ["rgb(", "rgba(", "hsl(", "hsla("].iter().any(|p| {
        lower
            .strip_prefix(p)
            .and_then(|rest| rest.strip_suffix(')'))
            .is_some_and(|inner| {
                !inner.is_empty()
                    && inner.chars().all(|c| {
                        c.is_ascii_digit()
                            || matches!(c, '.' | ',' | '%' | '/')
                            || crate::jurisdictions::is_js_space(c)
                    })
            })
    });
    if hex || word || func {
        esc(color)
    } else {
        fallback.to_owned()
    }
}

/// `safeImageUrl(value)`: http(s) or an inline image.
fn safe_image_url(value: Option<&str>) -> Option<String> {
    let url = crate::jurisdictions::js_trim(value?);
    let lower = url.to_ascii_lowercase();
    (!url.is_empty()
        && (lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("data:image/")))
    .then(|| url.to_owned())
}

/// `formatExemptSaleNotice(reason, certificateNumber)`.
fn exempt_sale_notice(reason: &str, certificate: Option<&str>) -> String {
    let label = match reason {
        "resale" => "Resale",
        "nonprofit" => "Nonprofit organization",
        "government" => "Government entity",
        "manufacturing" => "Manufacturing",
        "agricultural" => "Agricultural",
        _ => "Exempt purchaser",
    };
    match certificate
        .map(crate::jurisdictions::js_trim)
        .filter(|c| !c.is_empty())
    {
        Some(certificate) => format!("Exempt sale: {label}. Certificate no. {certificate}."),
        None => format!("Exempt sale: {label}. Exemption certificate on file."),
    }
}

// ── Tax rows ────────────────────────────────────────────────────────────────

struct UsGroup {
    name: String,
    level: String,
    rate: f64,
    taxable: f64,
    tax: f64,
}

/// `usTaxGroups(taxBreakdown)`: one per jurisdiction and rate, state first.
fn us_tax_groups(rows: &[Value]) -> Vec<UsGroup> {
    let mut groups: Vec<(String, UsGroup)> = Vec::new();
    for row in rows {
        let tax = json_number(row.get("taxAmount"));
        let taxable = json_number(row.get("taxableAmount"));
        if tax == 0.0 && taxable == 0.0 {
            continue;
        }
        let name = text(row, "jurisdictionName")
            .or_else(|| text(row, "taxRateName"))
            .unwrap_or_default()
            .to_owned();
        let rate = json_number(row.get("taxRate"));
        let key = format!(
            "{}|{}|{}",
            text(row, "jurisdictionCode").unwrap_or(&name),
            text(row, "jurisdictionLevel").unwrap_or_default(),
            crate::js::number_text(rate)
        );
        if let Some((_, group)) = groups.iter_mut().find(|(k, _)| *k == key) {
            group.taxable += taxable;
            group.tax += tax;
        } else {
            groups.push((
                key,
                UsGroup {
                    name,
                    level: text(row, "jurisdictionLevel").unwrap_or("state").to_owned(),
                    rate,
                    taxable,
                    tax,
                },
            ));
        }
    }
    let order = |level: &str| match level {
        "state" => 0,
        "county" => 1,
        "city" => 2,
        "district" => 3,
        _ => 9,
    };
    let mut groups: Vec<UsGroup> = groups.into_iter().map(|(_, g)| g).collect();
    groups.sort_by(|a, b| {
        order(&a.level)
            .cmp(&order(&b.level))
            .then_with(|| crate::js::locale_compare(&a.name, &b.name))
    });
    groups
}

/// `usExemptNotices(taxBreakdown, certificateNumbers, fmtCurrency)`.
fn us_exempt_notices(rows: &[Value], certificates: &Map<String, Value>, fmt: &Fmt) -> Vec<String> {
    let mut seen_lines: Vec<String> = Vec::new();
    let mut notices: Vec<(String, String, Option<String>, f64)> = Vec::new();
    for row in rows {
        let Some(reason) = filled(row, "exemptReason") else {
            continue;
        };
        let amount = row
            .get("exemptAmount")
            .filter(|v| !v.is_null())
            .map_or(0.0, |v| json_number(Some(v)));
        if not_positive(amount) {
            continue;
        }
        if let Some(line) = filled(row, "lineId") {
            if seen_lines.iter().any(|l| l == line) {
                continue;
            }
            seen_lines.push(line.to_owned());
        }
        let certificate = text(row, "certificateId").map(str::to_owned);
        let key = format!("{reason}|{}", certificate.as_deref().unwrap_or_default());
        if let Some(notice) = notices.iter_mut().find(|n| n.0 == key) {
            notice.3 += amount;
        } else {
            notices.push((key, reason.to_owned(), certificate, amount));
        }
    }
    notices
        .into_iter()
        .map(|(_, reason, certificate, amount)| {
            let number = certificate
                .as_deref()
                .filter(|c| !c.is_empty())
                .and_then(|c| certificates.get(c))
                .and_then(Value::as_str);
            format!(
                "{} ({} not taxed)",
                exempt_sale_notice(&reason, number),
                fmt.money_of(amount)
            )
        })
        .collect()
}

/// `gstSupplyOf(taxBreakdown)`: (`intra` | `inter` | `export` | `unknown`, state tax).
fn gst_supply_of(rows: &[Value]) -> (&'static str, &'static str) {
    let has = |c: &str| rows.iter().any(|r| text(r, "component") == Some(c));
    let state_tax = if has("utgst") { "utgst" } else { "sgst" };
    let supply = if has("igst") {
        "inter"
    } else if has("cgst") {
        "intra"
    } else if has("export") {
        "export"
    } else {
        "unknown"
    };
    (supply, state_tax)
}

fn gst_component_label(component: &str) -> Option<&'static str> {
    match component {
        "cgst" => Some("CGST"),
        "sgst" => Some("SGST"),
        "utgst" => Some("UTGST"),
        "igst" => Some("IGST"),
        _ => None,
    }
}

/// `gstPlaceOfSupplyText(code)`.
fn gst_place_of_supply_text(code: Option<&str>) -> String {
    let Some(code) = code.filter(|c| !c.is_empty()) else {
        return String::new();
    };
    match crate::jurisdictions::india::gst_state_name(Some(code)) {
        Some(name) => format!("{name} ({code})"),
        None => code.to_owned(),
    }
}

struct GstGroup {
    component: Option<String>,
    rate: f64,
    taxable: f64,
    tax: f64,
}

/// `gstTaxGroups(taxBreakdown)`: per component and rate, CGST/SGST/UTGST/IGST order.
fn gst_tax_groups(rows: &[Value]) -> Vec<GstGroup> {
    let mut groups: Vec<(String, GstGroup)> = Vec::new();
    for row in rows {
        let component = text(row, "component").map(str::to_owned);
        if component.as_deref() == Some("export") {
            continue;
        }
        let rate = json_number(row.get("taxRate"));
        let key = format!(
            "{}|{}",
            component.as_deref().unwrap_or_default(),
            crate::js::number_text(rate)
        );
        let taxable = json_number(row.get("taxableAmount"));
        let tax = json_number(row.get("taxAmount"));
        if let Some((_, g)) = groups.iter_mut().find(|(k, _)| *k == key) {
            g.taxable += taxable;
            g.tax += tax;
        } else {
            groups.push((
                key,
                GstGroup {
                    component,
                    rate,
                    taxable,
                    tax,
                },
            ));
        }
    }
    let order = |c: &Option<String>| -> i32 {
        match c.as_deref().unwrap_or_default() {
            "cgst" => 0,
            "sgst" => 1,
            "utgst" => 2,
            "igst" => 3,
            _ => -1,
        }
    };
    let mut groups: Vec<GstGroup> = groups.into_iter().map(|(_, g)| g).collect();
    groups.sort_by(|a, b| {
        order(&a.component).cmp(&order(&b.component)).then_with(|| {
            a.rate
                .partial_cmp(&b.rate)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    groups
}

fn br_rows<'a>(rows: &'a [Value], treatment: &str) -> Vec<&'a Value> {
    rows.iter()
        .filter(|r| {
            text(r, "treatment").unwrap_or("added") == treatment
                && json_number(r.get("taxAmount")) != 0.0
        })
        .collect()
}

// ── The built-in layout ─────────────────────────────────────────────────────

fn item_rows(items: &[RenderItem], fmt: &Fmt) -> String {
    items
        .iter()
        .map(|item| {
            let unit = item.unit.as_deref().filter(|u| !u.is_empty()).map_or_else(String::new, |u| format!(" {}", esc(u)));
            let rate = item
                .tax_rate
                .as_deref()
                .filter(|r| !r.is_empty())
                .map_or_else(|| "—".to_owned(), |r| format!("{}%", esc(&fmt.num(r))));
            format!(
                "\n    <tr>\n      <td style=\"padding:8px 12px;border-bottom:1px solid #eee;\">{}</td>\n      <td style=\"padding:8px 12px;border-bottom:1px solid #eee;text-align:center;\">{}{unit}</td>\n      <td style=\"padding:8px 12px;border-bottom:1px solid #eee;text-align:right;\">{}</td>\n      <td style=\"padding:8px 12px;border-bottom:1px solid #eee;text-align:right;\">{rate}</td>\n      <td style=\"padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:500;\">{}</td>\n    </tr>\n  ",
                esc(&item.description),
                esc(&fmt.num(&item.quantity)),
                fmt.money(&item.unit_price),
                fmt.money(&item.line_total)
            )
        })
        .collect()
}

fn tax_rows(rows: &[Value], labels: &Value, fmt: &Fmt) -> String {
    rows.iter()
        .map(|tb| {
            format!(
                "\n    <tr>\n      <td style=\"padding:4px 0;\">{} {}% {}</td>\n      <td style=\"padding:4px 0;text-align:right;\">{}</td>\n    </tr>\n  ",
                l(labels, "tax"),
                esc(&fmt.num_of(json_number(tb.get("taxRate")))),
                fmt.money_of(json_number(tb.get("taxableAmount"))),
                fmt.money_of(json_number(tb.get("taxAmount")))
            )
        })
        .collect()
}

fn us_tax_rows(rows: &[Value], labels: &Value, fmt: &Fmt) -> String {
    us_tax_groups(rows)
        .iter()
        .map(|g| {
            format!(
                "\n    <tr>\n      <td style=\"padding:4px 0;\">{} - {} {}% on {}</td>\n      <td style=\"padding:4px 0;text-align:right;\">{}</td>\n    </tr>\n  ",
                esc(l(labels, "tax")),
                esc(&g.name),
                esc(&fmt.num_of(g.rate)),
                fmt.money_of(g.taxable),
                fmt.money_of(g.tax)
            )
        })
        .collect()
}

fn gst_tax_rows(rows: &[Value], labels: &Value, fmt: &Fmt) -> String {
    gst_tax_groups(rows)
        .iter()
        .map(|g| {
            let label = g.component.as_deref().and_then(gst_component_label).unwrap_or_else(|| l(labels, "tax"));
            format!(
                "\n    <tr>\n      <td style=\"padding:4px 0;\">{} {}% {}</td>\n      <td style=\"padding:4px 0;text-align:right;\">{}</td>\n    </tr>",
                esc(label),
                esc(&fmt.num_of(g.rate)),
                fmt.money_of(g.taxable),
                fmt.money_of(g.tax)
            )
        })
        .collect()
}

fn br_tax_group(title: &str, rows: &[&Value], fmt: &Fmt, negative: bool) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let lines: String = rows
        .iter()
        .map(|row| {
            format!(
                "\n        <tr>\n          <td style=\"padding:2px 0 2px 8px;color:#666;font-size:13px;\">{} <span style=\"color:#999;\">({})</span></td>\n          <td style=\"padding:2px 0;text-align:right;font-size:13px;\">{}{}</td>\n        </tr>",
                esc(text(row, "taxRateName").unwrap_or_default()),
                fmt.money_of(json_number(row.get("taxableAmount"))),
                if negative { "-" } else { "" },
                fmt.money_of(json_number(row.get("taxAmount")))
            )
        })
        .collect();
    format!(
        "\n        <tr><td colspan=\"2\" style=\"padding:8px 0 2px;font-size:11px;text-transform:uppercase;color:#999;\">{}</td></tr>{lines}",
        esc(title)
    )
}

fn br_tax_rows(rows: &[Value], labels: &Value, fmt: &Fmt) -> String {
    [
        br_tax_group(l(labels, "tax"), &br_rows(rows, "added"), fmt, false),
        br_tax_group(
            l_or(labels, "withholdings", "Retenções"),
            &br_rows(rows, "withheld"),
            fmt,
            true,
        ),
        br_tax_group(
            l_or(labels, "includedTaxes", "Tributos incluídos no preço"),
            &br_rows(rows, "embedded"),
            fmt,
            false,
        ),
        br_tax_group(
            l_or(labels, "informationalTaxes", "CBS/IBS"),
            &br_rows(rows, "informational"),
            fmt,
            false,
        ),
    ]
    .concat()
}

#[allow(
    clippy::too_many_lines,
    reason = "the GST table of buildGstItemsTable, as written"
)]
fn gst_items_table(
    items: &[RenderItem],
    rows: &[Value],
    labels: &Value,
    fmt: &Fmt,
    primary: &str,
) -> String {
    let (supply, state_tax) = gst_supply_of(rows);
    let split = supply == "intra";
    let state_label = gst_component_label(state_tax).unwrap_or("SGST");
    let th = |text: &str, align: &str| {
        format!(
            "<th style=\"padding:8px 6px;text-align:{align};font-weight:500;font-size:11px;\">{}</th>",
            esc(text)
        )
    };
    let td = |html: &str, align: &str, extra: &str| {
        format!(
            "<td style=\"padding:6px;border-bottom:1px solid #eee;text-align:{align};font-size:12px;{extra}\">{html}</td>"
        )
    };
    let tax_label = l(labels, "tax");
    let tax_heads = if split {
        [
            th("CGST %", "right"),
            th("CGST", "right"),
            th(&format!("{state_label} %"), "right"),
            th(state_label, "right"),
        ]
        .concat()
    } else {
        let inter = supply == "inter";
        [
            th(
                &if inter {
                    "IGST %".to_owned()
                } else {
                    format!("{tax_label} %")
                },
                "right",
            ),
            th(if inter { "IGST" } else { tax_label }, "right"),
        ]
        .concat()
    };
    let body: String = items
        .iter()
        .map(|item| {
            let rate = crate::js::parse_float(item.tax_rate.as_deref().unwrap_or("0"));
            let rate = if rate.is_nan() || rate == 0.0 { 0.0 } else { rate };
            let line_tax = crate::js::parse_float(item.tax_amount.as_deref().unwrap_or("0"));
            let line_tax = if line_tax.is_nan() { 0.0 } else { line_tax };
            let taxable = crate::js::parse_float(&item.line_total);
            let taxable = if taxable.is_nan() { 0.0 } else { taxable };
            let tax_cells = if split {
                let cgst = round_cents(taxable * (rate / 2.0) / 100.0);
                let state = round_cents(line_tax - cgst);
                let half = format!("{}%", esc(&fmt.num_of(rate / 2.0)));
                [td(&half, "right", ""), td(&fmt.money_of(cgst), "right", ""), td(&half, "right", ""), td(&fmt.money_of(state), "right", "")].concat()
            } else {
                let shown = if rate == 0.0 { "—".to_owned() } else { format!("{}%", esc(&fmt.num_of(rate))) };
                [td(&shown, "right", ""), td(&fmt.money_of(line_tax), "right", "")].concat()
            };
            let unit = item.unit.as_deref().filter(|u| !u.is_empty()).map_or_else(String::new, |u| format!(" {}", esc(u)));
            let quantity = format!("{}{unit}", esc(&fmt.num(&item.quantity)));
            let hsn = item.hsn_sac.as_deref().filter(|h| !h.is_empty()).map_or_else(|| "—".to_owned(), esc);
            format!(
                "\n    <tr>\n      {}\n      {}\n      {}\n      {}\n      {}\n      {tax_cells}\n    </tr>",
                td(&esc(&item.description), "left", ""),
                td(&hsn, "center", ""),
                td(&quantity, "center", ""),
                td(&fmt.money(&item.unit_price), "right", ""),
                td(&fmt.money(&item.line_total), "right", "font-weight:500;"),
            )
        })
        .collect();
    format!(
        "<table style=\"margin-bottom:24px;\">\n    <thead>\n      <tr style=\"background:{primary};color:white;\">\n        {}\n        {}\n        {}\n        {}\n        {}\n        {tax_heads}\n      </tr>\n    </thead>\n    <tbody>{body}\n    </tbody>\n  </table>",
        th(l(labels, "description"), "left"),
        th(l_or(labels, "hsnSac", "HSN/SAC"), "center"),
        th(l(labels, "quantity"), "center"),
        th(l(labels, "unitPrice"), "right"),
        th(l_or(labels, "taxableValue", "Taxable value"), "right"),
    )
}

fn address_block(address: Option<&Value>, omit: Option<&str>) -> String {
    format_postal_address_lines(address, omit)
        .iter()
        .map(|line| esc(line))
        .collect::<Vec<_>>()
        .join("<br>")
}

/// `distinctShippingAddress(invoice)`: the ship-to when it isn't the billing address.
fn distinct_shipping(invoice: &InvoiceRenderData) -> Option<Value> {
    let shipping = normalize_postal_address(invoice.shipping_address.as_ref())?;
    let billing = normalize_postal_address(invoice.billing_address.as_ref());
    (Some(&shipping) != billing.as_ref()).then_some(shipping)
}

fn seller_country(entity: &Value) -> String {
    normalize_postal_address(entity.get("address"))
        .and_then(|a| a["country"].as_str().map(str::to_owned))
        .unwrap_or_else(|| {
            entity["jurisdictionCode"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .to_uppercase()
}

/// The entity's locale (`entity.locale || 'en-US'`).
fn locale_of(entity: &Value) -> String {
    filled(entity, "locale").unwrap_or("en-US").to_owned()
}

fn requirements_of(entity: &Value) -> Result<&'static Value, RenderError> {
    let code = entity["jurisdictionCode"].as_str().unwrap_or_default();
    invoice_requirements(code, &locale_of(entity))
        .ok_or_else(|| RenderError(format!("No jurisdiction adapter registered for '{code}'")))
}

/// `generateInvoiceHtml(invoice, entity)`: the built-in layout. `entity` is
/// a row as Drizzle returns it.
#[allow(
    clippy::too_many_lines,
    reason = "the one HTML document of generateInvoiceHtml, as written"
)]
pub fn generate_invoice_html(
    invoice: &InvoiceRenderData,
    entity: &Value,
) -> Result<String, RenderError> {
    let locale = locale_of(entity);
    let currency = Some(invoice.currency.as_str())
        .filter(|c| !c.is_empty())
        .or_else(|| filled(entity, "baseCurrency"))
        .unwrap_or("EUR")
        .to_owned();
    let requirements = requirements_of(entity)?;
    let labels = &requirements["labels"];
    let fmt = Fmt {
        locale: locale.clone(),
        currency,
    };
    let branding = entity
        .get("branding")
        .filter(|b| b.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let primary = safe_color(text(&branding, "primaryColor"), "#1a1a2e");
    let accent = safe_color(text(&branding, "accentColor"), "#16213e");
    let type_label = if invoice.kind == "credit_note" {
        l(labels, "creditNote")
    } else {
        l(labels, "invoice")
    };
    let tax_ids = entity.get("taxIdentifiers").cloned().unwrap_or(Value::Null);
    let bank = entity.get("bankDetails").cloned().unwrap_or(Value::Null);

    let items_html = item_rows(&invoice.items, &fmt);
    let rows = &invoice.tax_breakdown;
    let code = entity["jurisdictionCode"].as_str().unwrap_or_default();
    let sales_tax = crate::sales_tax::document_tax::uses_sales_tax_code(code);
    let us_sales_tax = sales_tax
        && rows
            .iter()
            .any(|r| crate::js::truthy(r.get("jurisdictionName")));
    let gst = code == "IN";
    let br = code == "BR";
    let tax_rows_html = if us_sales_tax {
        us_tax_rows(rows, labels, &fmt)
    } else if gst {
        gst_tax_rows(rows, labels, &fmt)
    } else if br {
        br_tax_rows(rows, labels, &fmt)
    } else {
        tax_rows(rows, labels, &fmt)
    };
    let tax_total_row = if br {
        String::new()
    } else {
        format!(
            "<tr>\n          <td style=\"padding:6px 0;color:#666;\">{}</td>\n          <td style=\"padding:6px 0;text-align:right;\">{}</td>\n        </tr>",
            l(labels, "taxTotal"),
            fmt.money(&invoice.tax_total)
        )
    };
    let exempt = if us_sales_tax {
        let notices = us_exempt_notices(rows, &invoice.certificate_numbers, &fmt);
        if notices.is_empty() {
            String::new()
        } else {
            format!(
                "\n      <div style=\"margin-top:12px;font-size:12px;color:#666;\">{}</div>",
                notices
                    .iter()
                    .map(|n| format!("<div>{}</div>", esc(n)))
                    .collect::<String>()
            )
        }
    } else {
        String::new()
    };
    let seller = seller_country(entity);
    let buyer = normalize_postal_address(invoice.billing_address.as_ref())
        .and_then(|a| a["country"].as_str().map(str::to_owned));
    let cross_border = buyer
        .as_deref()
        .is_some_and(|b| !b.is_empty() && b != seller);
    let billing_block = address_block(invoice.billing_address.as_ref(), Some(&seller));
    let ship_block = address_block(distinct_shipping(invoice).as_ref(), Some(&seller));
    let entity_block = address_block(
        entity.get("address"),
        if cross_border { None } else { Some(&seller) },
    );
    let entity_name = text(entity, "name").unwrap_or_default();
    let logo = match safe_image_url(text(&branding, "logoUrl")) {
        Some(url) => format!(
            "<img src=\"{}\" alt=\"{}\" style=\"max-height:60px;max-width:200px;\" />",
            esc(&url),
            esc(entity_name)
        ),
        None => format!(
            "<div style=\"font-size:24px;font-weight:bold;color:{primary};\">{}</div>",
            esc(entity_name)
        ),
    };
    let balance_due = crate::js::parse_float(
        invoice
            .balance_due
            .as_deref()
            .filter(|b| !b.is_empty())
            .unwrap_or(&invoice.total),
    );
    let amount_paid = crate::js::parse_float(
        invoice
            .amount_paid
            .as_deref()
            .filter(|a| !a.is_empty())
            .unwrap_or("0"),
    );

    let draft_notice = l(labels, "draftNotice");
    let draft_marking = if invoice.draft {
        format!(
            "<div data-draft-notice style=\"border:2px solid #c0392b;color:#c0392b;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;text-align:center;padding:10px;margin-bottom:24px;border-radius:6px;\">{}</div>\n  <div aria-hidden=\"true\" style=\"position:absolute;top:40%;left:0;right:0;text-align:center;font-size:96px;font-weight:800;color:rgba(192,57,43,0.08);transform:rotate(-30deg);pointer-events:none;user-select:none;\">{}</div>",
            esc(draft_notice),
            esc(draft_notice.split(':').next().unwrap_or_default())
        )
    } else {
        String::new()
    };
    let registration = filled(&tax_ids, "registrationNumber").map_or_else(String::new, |r| {
        format!(
            "<div style=\"font-size:13px;color:#666;margin-top:8px;\">{}: {}</div>",
            l(labels, "registrationLabel"),
            esc(r)
        )
    });
    let vat = filled(&tax_ids, "vatNumber").map_or_else(String::new, |v| {
        format!(
            "<div style=\"font-size:13px;color:#666;\">{}: {}</div>",
            l(labels, "vatNumberLabel"),
            esc(v)
        )
    });
    let buyer_address = if billing_block.is_empty() {
        String::new()
    } else {
        format!("<div style=\"font-size:14px;color:#555;\">{billing_block}</div>")
    };
    let buyer_email = invoice
        .contact_email
        .as_deref()
        .filter(|e| !e.is_empty())
        .map_or_else(String::new, |e| {
            format!(
                "<div style=\"font-size:13px;color:#666;margin-top:4px;\">{}</div>",
                esc(e)
            )
        });
    let buyer_vat = invoice
        .contact_vat_number
        .as_deref()
        .filter(|v| !v.is_empty())
        .map_or_else(String::new, |v| {
            format!(
                "<div style=\"font-size:13px;color:#666;\">{}: {}</div>",
                l(labels, "vatNumberLabel"),
                esc(v)
            )
        });
    let ship_to = if ship_block.is_empty() {
        String::new()
    } else {
        format!(
            "<div style=\"margin-top:16px;\">\n        <div style=\"font-size:11px;text-transform:uppercase;color:#999;margin-bottom:8px;\">{}</div>\n        <div style=\"font-size:14px;color:#555;\">{ship_block}</div>\n      </div>",
            esc(l(labels, "shipTo"))
        )
    };
    let reference = invoice.reference.as_deref().filter(|r| !r.is_empty()).map_or_else(String::new, |r| {
        format!("<div>\n      <div style=\"font-size:11px;text-transform:uppercase;color:#999;\">Ref.</div>\n      <div style=\"font-weight:500;\">{}</div>\n    </div>", esc(r))
    });
    let place = if gst {
        let place_text = gst_place_of_supply_text(invoice.place_of_supply.as_deref());
        if place_text.is_empty() {
            String::new()
        } else {
            format!(
                "<div>\n      <div style=\"font-size:11px;text-transform:uppercase;color:#999;\">{}</div>\n      <div style=\"font-weight:500;\">{}</div>\n    </div>",
                esc(l_or(labels, "placeOfSupply", "Place of supply")),
                esc(&place_text)
            )
        }
    } else {
        String::new()
    };
    let fiscal = invoice.fiscal_document.as_ref().map_or_else(String::new, |doc| {
        let key = doc.access_key.as_deref().filter(|k| !k.is_empty()).map_or_else(String::new, |k| {
            format!("<div>{}: <span style=\"font-family:monospace;\">{}</span></div>", esc(l_or(labels, "accessKey", "Chave")), esc(&group_fours(k)))
        });
        let number = doc.number.as_deref().filter(|n| !n.is_empty()).map_or_else(String::new, |n| format!(" nº {}", esc(n)));
        format!(
            "\n    <div>\n      <div style=\"font-size:11px;text-transform:uppercase;color:#999;\">{}</div>\n      <div style=\"font-weight:500;\">{}{number}</div>\n      <div style=\"font-size:11px;color:#777;\">{key}</div>\n    </div>",
            esc(l_or(labels, "fiscalDocument", "NF")),
            esc(&doc.label)
        )
    });
    let table = if gst {
        gst_items_table(&invoice.items, rows, labels, &fmt, &primary)
    } else {
        format!(
            "<table style=\"margin-bottom:24px;\">\n    <thead>\n      <tr style=\"background:{primary};color:white;\">\n        <th style=\"padding:10px 12px;text-align:left;font-weight:500;\">{}</th>\n        <th style=\"padding:10px 12px;text-align:center;font-weight:500;width:80px;\">{}</th>\n        <th style=\"padding:10px 12px;text-align:right;font-weight:500;width:120px;\">{}</th>\n        <th style=\"padding:10px 12px;text-align:right;font-weight:500;width:80px;\">{}</th>\n        <th style=\"padding:10px 12px;text-align:right;font-weight:500;width:120px;\">{}</th>\n      </tr>\n    </thead>\n    <tbody>\n      {items_html}\n    </tbody>\n  </table>",
            l(labels, "description"),
            l(labels, "quantity"),
            l(labels, "unitPrice"),
            l(labels, "tax"),
            l(labels, "amount")
        )
    };
    let discount = if not_positive(crate::js::parse_float(&invoice.discount_total)) {
        String::new()
    } else {
        format!(
            "\n        <tr>\n          <td style=\"padding:6px 0;color:#666;\">{}</td>\n          <td style=\"padding:6px 0;text-align:right;color:#e74c3c;\">-{}</td>\n        </tr>",
            l(labels, "discount"),
            fmt.money(&invoice.discount_total)
        )
    };
    let paid = if not_positive(amount_paid) {
        String::new()
    } else {
        format!(
            "\n        <tr>\n          <td style=\"padding:4px 0;color:#666;\">{}</td>\n          <td style=\"padding:4px 0;text-align:right;color:#27ae60;\">-{}</td>\n        </tr>\n        <tr>\n          <td style=\"padding:4px 0;font-weight:600;\">{}</td>\n          <td style=\"padding:4px 0;text-align:right;font-weight:600;\">{}</td>\n        </tr>",
            l(labels, "amountPaid"),
            fmt.money_of(amount_paid),
            l(labels, "balanceDue"),
            fmt.money_of(balance_due)
        )
    };
    let compliance = if invoice.compliance_notices.is_empty() {
        String::new()
    } else {
        format!(
            "\n  <div style=\"margin-top:24px;padding:12px 16px;background:#fffbe6;border:1px solid #f0e6b8;border-radius:6px;\">\n    {}\n  </div>",
            invoice
                .compliance_notices
                .iter()
                .map(|n| format!(
                    "<div style=\"font-size:13px;font-weight:600;color:#5c4d00;\">{}</div>",
                    esc(n)
                ))
                .collect::<String>()
        )
    };
    let iban = filled(&bank, "iban");
    let bank_html = format!(
        "{}\n      {}\n      {}\n      {}",
        iban.map_or_else(String::new, |i| format!(
            "<div>IBAN: <strong>{}</strong></div>",
            esc(i)
        )),
        filled(&bank, "bic").map_or_else(String::new, |b| format!("<div>BIC: {}</div>", esc(b))),
        filled(&bank, "accountNumber")
            .filter(|_| iban.is_none())
            .map_or_else(String::new, |a| format!(
                "<div>Account: <strong>{}</strong></div>",
                esc(a)
            )),
        filled(&bank, "routingNumber")
            .map_or_else(String::new, |r| format!("<div>Routing: {}</div>", esc(r)))
    );
    let instructions = filled(&branding, "paymentInstructions").map_or_else(String::new, |t| {
        format!(
            "<div style=\"margin-top:8px;font-size:13px;color:#666;\">{}</div>",
            esc(t)
        )
    });
    let notes = invoice.notes.as_deref().filter(|n| !n.is_empty()).map_or_else(String::new, |n| {
        format!("\n  <div style=\"margin-top:20px;\">\n    <div style=\"font-weight:600;margin-bottom:4px;\">Notes</div>\n    <div style=\"font-size:14px;color:#555;white-space:pre-wrap;\">{}</div>\n  </div>", esc(n))
    });
    let terms = filled(&branding, "termsAndConditions").map_or_else(String::new, |t| {
        format!("\n  <div style=\"margin-top:30px;padding-top:20px;border-top:1px solid #eee;\">\n    <div style=\"font-size:12px;color:#666;\">{}</div>\n  </div>", esc(t))
    });
    let footer = filled(requirements, "requiredFooter").map_or_else(String::new, |f| {
        format!(
            "\n  <div style=\"margin-top:20px;font-size:11px;color:#999;\">{}</div>",
            esc(f)
        )
    });
    let footer_text = filled(&branding, "footerText").map_or_else(String::new, |f| {
        format!("\n  <div style=\"margin-top:30px;text-align:center;font-size:12px;color:#999;\">\n    {}\n  </div>", esc(f))
    });
    let seller_name = filled(entity, "legalName")
        .or_else(|| text(entity, "legalName"))
        .unwrap_or(entity_name);
    let seller_name = if entity.get("legalName").is_some_and(|v| !v.is_null()) {
        text(entity, "legalName").unwrap_or_default()
    } else {
        seller_name
    };
    let title_prefix = if invoice.draft {
        format!("{} · ", esc(draft_notice))
    } else {
        String::new()
    };
    Ok(format!(
        "<!DOCTYPE html>\n<html lang=\"{lang}\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>{title_prefix}{type_label} {number}</title>\n<style>\n  @media print {{\n    body {{ margin: 0; }}\n    .no-print {{ display: none !important; }}\n  }}\n  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #333; line-height: 1.5; margin: 0; padding: 0; }}\n  .container {{ max-width: 800px; margin: 0 auto; padding: 40px; position: relative; }}\n  table {{ border-collapse: collapse; width: 100%; }}\n</style>\n</head>\n<body>\n<div class=\"container\">\n  {draft_marking}\n  <div style=\"display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:40px;\">\n    <div>{logo}</div>\n    <div style=\"text-align:right;\">\n      <div style=\"font-size:28px;font-weight:bold;color:{primary};text-transform:uppercase;\">{type_label}</div>\n      <div style=\"font-size:16px;color:#666;margin-top:4px;\">{number}</div>\n    </div>\n  </div>\n\n  <div style=\"display:flex;justify-content:space-between;margin-bottom:30px;\">\n    <div style=\"flex:1;\">\n      <div style=\"font-size:11px;text-transform:uppercase;color:#999;margin-bottom:8px;\">{from}</div>\n      <div style=\"font-weight:600;\">{seller_name}</div>\n      <div style=\"font-size:14px;color:#555;\">{entity_block}</div>\n      {registration}\n      {vat}\n    </div>\n    <div style=\"flex:1;text-align:right;\">\n      <div style=\"font-size:11px;text-transform:uppercase;color:#999;margin-bottom:8px;\">{bill_to}</div>\n      <div style=\"font-weight:600;\">{contact}</div>\n      {buyer_address}\n      {buyer_email}\n      {buyer_vat}\n      {ship_to}\n    </div>\n  </div>\n\n  <div style=\"display:flex;gap:40px;margin-bottom:30px;padding:16px;background:#f8f9fa;border-radius:6px;\">\n    <div>\n      <div style=\"font-size:11px;text-transform:uppercase;color:#999;\">{date_label}</div>\n      <div style=\"font-weight:500;\">{issue}</div>\n    </div>\n    <div>\n      <div style=\"font-size:11px;text-transform:uppercase;color:#999;\">{due_label}</div>\n      <div style=\"font-weight:500;\">{due}</div>\n    </div>\n    {reference}\n    {place}\n    {fiscal}\n  </div>\n\n  {table}\n\n  <div style=\"display:flex;justify-content:flex-end;\">\n    <div style=\"width:300px;\">\n      <table>\n        <tr>\n          <td style=\"padding:6px 0;color:#666;\">{subtotal_label}</td>\n          <td style=\"padding:6px 0;text-align:right;\">{subtotal}</td>\n        </tr>\n        {discount}\n        {tax_rows_html}\n        {tax_total_row}\n        <tr style=\"border-top:2px solid {primary};\">\n          <td style=\"padding:12px 0;font-size:18px;font-weight:bold;\">{total_label}</td>\n          <td style=\"padding:12px 0;text-align:right;font-size:18px;font-weight:bold;\">{total}</td>\n        </tr>\n        {paid}\n      </table>{exempt}\n    </div>\n  </div>\n\n  {compliance}\n\n  <div style=\"margin-top:40px;padding:20px;background:#f8f9fa;border-radius:6px;border-left:4px solid {accent};\">\n    <div style=\"font-weight:600;margin-bottom:8px;\">{payment_label}</div>\n    <div style=\"font-size:14px;color:#555;\">\n      {bank_html}\n      <div>{entity_name_html}</div>\n      <div>Ref: {number}</div>\n    </div>\n    {instructions}\n    \n  </div>\n\n  {notes}\n\n  {terms}\n\n  {footer}\n\n  {footer_text}\n</div>\n</body>\n</html>",
        lang = esc(locale.split('-').next().unwrap_or_default()),
        number = esc(&invoice.invoice_number),
        from = esc(l(labels, "from")),
        seller_name = esc(seller_name),
        bill_to = l(labels, "billTo"),
        contact = esc(&invoice.contact_name),
        date_label = l(labels, "date"),
        issue = fmt.date(&invoice.issue_date),
        due_label = l(labels, "dueDate"),
        due = fmt.date(&invoice.due_date),
        subtotal_label = l(labels, "subtotal"),
        subtotal = fmt.money(&invoice.subtotal),
        total_label = l(labels, "total"),
        total = fmt.money(&invoice.total),
        payment_label = l(labels, "paymentInstructions"),
        entity_name_html = esc(entity_name),
    ))
}

/// `value.replace(/(\d{4})(?=\d)/g, '$1 ')`: a space after each four digits
/// followed by another digit.
fn group_fours(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if i + 4 < chars.len() && chars[i..i + 5].iter().all(char::is_ascii_digit) {
            out.extend(&chars[i..i + 4]);
            out.push(' ');
            i += 4;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

// ── Designed invoices ───────────────────────────────────────────────────────

/// `invoiceTemplateData(invoice, entity)`: what a designed invoice prints.
#[allow(clippy::too_many_lines, reason = "every part of invoiceTemplateData")]
pub fn invoice_template_data(
    invoice: &InvoiceRenderData,
    entity: &Value,
) -> Result<DocumentData, RenderError> {
    let locale = locale_of(entity);
    let currency = Some(invoice.currency.as_str())
        .filter(|c| !c.is_empty())
        .or_else(|| filled(entity, "baseCurrency"))
        .unwrap_or("EUR")
        .to_owned();
    let requirements = requirements_of(entity)?;
    let labels = &requirements["labels"];
    let fmt = Fmt {
        locale,
        currency: currency.clone(),
    };
    let rows = &invoice.tax_breakdown;
    let code = entity["jurisdictionCode"].as_str().unwrap_or_default();
    let us_sales_tax = crate::sales_tax::document_tax::uses_sales_tax_code(code)
        && rows
            .iter()
            .any(|r| crate::js::truthy(r.get("jurisdictionName")));
    let gst = code == "IN";
    let br = code == "BR";
    let amount_paid = crate::js::parse_float(
        invoice
            .amount_paid
            .as_deref()
            .filter(|a| !a.is_empty())
            .unwrap_or("0"),
    );
    let balance_due = crate::js::parse_float(
        invoice
            .balance_due
            .as_deref()
            .filter(|b| !b.is_empty())
            .unwrap_or(&invoice.total),
    );
    let branding = entity
        .get("branding")
        .filter(|b| b.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let tax_ids = entity.get("taxIdentifiers").cloned().unwrap_or(Value::Null);
    let bank = entity.get("bankDetails").cloned().unwrap_or(Value::Null);
    let contact = entity.get("contact").cloned().unwrap_or(Value::Null);
    let type_label = if invoice.kind == "credit_note" {
        l(labels, "creditNote")
    } else {
        l(labels, "invoice")
    };
    let tax_label = l(labels, "tax");

    // Table.
    let (supply, state_tax) = gst_supply_of(rows);
    let igst = gst && supply == "inter";
    let column = |label: &str, align: Option<&'static str>, required: bool| TableColumnData {
        label: label.to_owned(),
        align,
        required,
    };
    let mut columns: Vec<(&'static str, TableColumnData)> = vec![
        ("index", column("#", Some("right"), false)),
        ("description", column(l(labels, "description"), None, false)),
        (
            "quantity",
            column(l(labels, "quantity"), Some("right"), false),
        ),
        (
            "unitPrice",
            column(l(labels, "unitPrice"), Some("right"), false),
        ),
        (
            "taxRate",
            column(
                &if igst {
                    "IGST %".to_owned()
                } else {
                    format!("{tax_label} %")
                },
                Some("right"),
                gst,
            ),
        ),
        (
            "taxAmount",
            column(if igst { "IGST" } else { tax_label }, Some("right"), gst),
        ),
        ("amount", column(l(labels, "amount"), Some("right"), false)),
        (
            "amountWithTax",
            column(l(labels, "total"), Some("right"), false),
        ),
    ];
    let has_discount = |item: &RenderItem| {
        crate::js::parse_float(item.discount_percent.as_deref().unwrap_or("0")) > 0.0
    };
    if invoice
        .items
        .iter()
        .any(|i| i.unit.as_deref().is_some_and(|u| !u.is_empty()))
    {
        columns.push(("unit", column("Unit", None, false)));
    }
    if invoice.items.iter().any(has_discount) {
        columns.push((
            "discount",
            column(l(labels, "discount"), Some("right"), false),
        ));
    }
    if gst {
        columns.push((
            "hsnSac",
            column(l_or(labels, "hsnSac", "HSN/SAC"), None, true),
        ));
    }
    let split_label =
        (gst && supply == "intra").then(|| gst_component_label(state_tax).unwrap_or("SGST"));
    let table_rows: Vec<TableRowData> = invoice
        .items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let rate = crate::js::parse_float(item.tax_rate.as_deref().unwrap_or("0"));
            let rate = if rate.is_nan() { 0.0 } else { rate };
            let line_tax = crate::js::parse_float(item.tax_amount.as_deref().unwrap_or("0"));
            let line_tax = if line_tax.is_nan() { 0.0 } else { line_tax };
            let (tax_rate, tax_amount) = match split_label {
                None => (
                    if rate == 0.0 {
                        "-".to_owned()
                    } else {
                        format!("{}%", fmt.num_of(rate))
                    },
                    fmt.money_of(line_tax),
                ),
                Some(state_label) => {
                    let total = crate::js::parse_float(&item.line_total);
                    let total = if total.is_nan() { 0.0 } else { total };
                    let cgst = round_cents(total * (rate / 2.0) / 100.0);
                    let half = fmt.num_of(rate / 2.0);
                    (
                        format!("CGST {half}%\n{state_label} {half}%"),
                        format!(
                            "{}\n{}",
                            fmt.money_of(cgst),
                            fmt.money_of(round_cents(line_tax - cgst))
                        ),
                    )
                }
            };
            TableRowData {
                cells: vec![
                    ("index", (i + 1).to_string()),
                    ("description", item.description.clone()),
                    ("hsnSac", item.hsn_sac.clone().unwrap_or_default()),
                    ("quantity", fmt.num(&item.quantity)),
                    ("unit", item.unit.clone().unwrap_or_default()),
                    ("unitPrice", fmt.money(&item.unit_price)),
                    (
                        "discount",
                        if has_discount(item) {
                            format!(
                                "{}%",
                                fmt.num(item.discount_percent.as_deref().unwrap_or("0"))
                            )
                        } else {
                            String::new()
                        },
                    ),
                    ("taxRate", tax_rate),
                    ("taxAmount", tax_amount),
                    ("amount", fmt.money(&item.line_total)),
                    (
                        "amountWithTax",
                        fmt.money(
                            item.line_total_with_tax
                                .as_deref()
                                .unwrap_or(&item.line_total),
                        ),
                    ),
                ],
                sub_lines: Vec::new(),
            }
        })
        .collect();

    // Totals.
    let tax_rows: Vec<TotalsRow> = if us_sales_tax {
        us_tax_groups(rows)
            .iter()
            .map(|g| TotalsRow {
                label: format!("{tax_label} - {} {}%", g.name, fmt.num_of(g.rate)),
                value: fmt.money_of(g.tax),
                kind: None,
            })
            .collect()
    } else if gst {
        gst_tax_groups(rows)
            .iter()
            .map(|g| {
                let name = g
                    .component
                    .as_deref()
                    .and_then(gst_component_label)
                    .unwrap_or(tax_label);
                TotalsRow {
                    label: format!("{name} {}%", fmt.num_of(g.rate)),
                    value: fmt.money_of(g.tax),
                    kind: None,
                }
            })
            .collect()
    } else if br {
        let mut out: Vec<TotalsRow> = br_rows(rows, "added")
            .iter()
            .map(|r| TotalsRow {
                label: text(r, "taxRateName").unwrap_or(tax_label).to_owned(),
                value: fmt.money_of(json_number(r.get("taxAmount"))),
                kind: None,
            })
            .collect();
        out.extend(br_rows(rows, "withheld").iter().map(|r| TotalsRow {
            label: text(r, "taxRateName").unwrap_or(tax_label).to_owned(),
            value: format!("-{}", fmt.money_of(json_number(r.get("taxAmount")))),
            kind: None,
        }));
        out
    } else {
        rows.iter()
            .map(|r| TotalsRow {
                label: format!("{tax_label} {}%", fmt.num_of(json_number(r.get("taxRate")))),
                value: fmt.money_of(json_number(r.get("taxAmount"))),
                kind: None,
            })
            .collect()
    };
    let mut totals = vec![TotalsRow {
        label: l(labels, "subtotal").to_owned(),
        value: fmt.money(&invoice.subtotal),
        kind: None,
    }];
    if crate::js::parse_float(&invoice.discount_total) > 0.0 {
        totals.push(TotalsRow {
            label: l(labels, "discount").to_owned(),
            value: format!("-{}", fmt.money(&invoice.discount_total)),
            kind: None,
        });
    }
    let tax_row_count = tax_rows.len();
    totals.extend(tax_rows);
    if !br && tax_row_count != 1 {
        totals.push(TotalsRow {
            label: l(labels, "taxTotal").to_owned(),
            value: fmt.money(&invoice.tax_total),
            kind: None,
        });
    }
    totals.push(TotalsRow {
        label: if br {
            l_or(labels, "netAmount", l(labels, "total"))
        } else {
            l(labels, "total")
        }
        .to_owned(),
        value: fmt.money(&invoice.total),
        kind: Some("total"),
    });
    if !not_positive(amount_paid) {
        totals.push(TotalsRow {
            label: l(labels, "amountPaid").to_owned(),
            value: format!("-{}", fmt.money_of(amount_paid)),
            kind: Some("muted"),
        });
        totals.push(TotalsRow {
            label: l(labels, "balanceDue").to_owned(),
            value: fmt.money_of(balance_due),
            kind: Some("balance"),
        });
    }
    if br {
        for (title, group) in [
            (
                l_or(labels, "includedTaxes", "Tributos incluídos no preço"),
                br_rows(rows, "embedded"),
            ),
            (
                l_or(labels, "informationalTaxes", "CBS/IBS"),
                br_rows(rows, "informational"),
            ),
        ] {
            if group.is_empty() {
                continue;
            }
            totals.push(TotalsRow {
                label: title.to_owned(),
                value: String::new(),
                kind: Some("heading"),
            });
            totals.extend(group.iter().map(|r| TotalsRow {
                label: text(r, "taxRateName").unwrap_or_default().to_owned(),
                value: fmt.money_of(json_number(r.get("taxAmount"))),
                kind: Some("muted"),
            }));
        }
    }

    // Legal.
    let mut notices = invoice.compliance_notices.clone();
    if us_sales_tax {
        notices.extend(us_exempt_notices(rows, &invoice.certificate_numbers, &fmt));
    }
    let fiscal_document = invoice.fiscal_document.as_ref().map(|doc| {
        let number = doc
            .number
            .as_deref()
            .filter(|n| !n.is_empty())
            .map_or_else(String::new, |n| format!(" nº {n}"));
        let key = doc
            .access_key
            .as_deref()
            .filter(|k| !k.is_empty())
            .map(group_fours)
            .unwrap_or_default();
        [
            format!(
                "{}: {}{number}",
                l_or(labels, "fiscalDocument", "NF"),
                doc.label
            ),
            if key.is_empty() {
                String::new()
            } else {
                format!("{}: {key}", l_or(labels, "accessKey", "Chave"))
            },
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect()
    });

    // Fields.
    let entity_name = text(entity, "name").unwrap_or_default().to_owned();
    let legal_name = if entity.get("legalName").is_some_and(|v| !v.is_null()) {
        text(entity, "legalName").unwrap_or_default().to_owned()
    } else {
        entity_name.clone()
    };
    let s = |v: Option<&str>| v.unwrap_or_default().to_owned();
    let fields = vec![
        ("title", type_label.to_owned()),
        ("invoiceNumber", invoice.invoice_number.clone()),
        ("issueDate", fmt.date(&invoice.issue_date)),
        ("dueDate", fmt.date(&invoice.due_date)),
        ("reference", invoice.reference.clone().unwrap_or_default()),
        (
            "placeOfSupply",
            if gst {
                gst_place_of_supply_text(invoice.place_of_supply.as_deref())
            } else {
                String::new()
            },
        ),
        ("currency", currency),
        ("total", fmt.money(&invoice.total)),
        ("balanceDue", fmt.money_of(balance_due)),
        (
            "amountPaid",
            if not_positive(amount_paid) {
                String::new()
            } else {
                fmt.money_of(amount_paid)
            },
        ),
        ("customerName", invoice.contact_name.clone()),
        (
            "customerEmail",
            invoice.contact_email.clone().unwrap_or_default(),
        ),
        (
            "customerTaxId",
            invoice.contact_vat_number.clone().unwrap_or_default(),
        ),
        ("sellerName", entity_name.clone()),
        ("sellerLegalName", legal_name.clone()),
        ("sellerEmail", s(text(&contact, "email"))),
        ("sellerPhone", s(text(&contact, "phone"))),
        ("sellerWebsite", s(text(&contact, "website"))),
        ("sellerTaxId", s(text(&tax_ids, "vatNumber"))),
        (
            "sellerRegistrationId",
            s(text(&tax_ids, "registrationNumber")),
        ),
        ("sellerIban", s(text(&bank, "iban"))),
        ("sellerBic", s(text(&bank, "bic"))),
        ("footerText", s(text(&branding, "footerText"))),
    ];
    let field_labels = vec![
        ("title", type_label.to_owned()),
        ("invoiceNumber", l(labels, "invoiceNumber").to_owned()),
        ("issueDate", l(labels, "date").to_owned()),
        ("dueDate", l(labels, "dueDate").to_owned()),
        (
            "reference",
            l_or(labels, "reference", "Reference").to_owned(),
        ),
        (
            "placeOfSupply",
            l_or(labels, "placeOfSupply", "Place of supply").to_owned(),
        ),
        ("total", l(labels, "total").to_owned()),
        ("balanceDue", l(labels, "balanceDue").to_owned()),
        ("amountPaid", l(labels, "amountPaid").to_owned()),
        ("customerTaxId", l(labels, "vatNumberLabel").to_owned()),
        ("sellerTaxId", l(labels, "vatNumberLabel").to_owned()),
        (
            "sellerRegistrationId",
            l(labels, "registrationLabel").to_owned(),
        ),
    ];

    // Parties.
    let seller = seller_country(entity);
    let buyer = normalize_postal_address(invoice.billing_address.as_ref())
        .and_then(|a| a["country"].as_str().map(str::to_owned));
    let cross_border = buyer
        .as_deref()
        .is_some_and(|b| !b.is_empty() && b != seller);
    let shipping = distinct_shipping(invoice);
    let party_seller = PartyData {
        name: legal_name,
        lines: format_postal_address_lines(
            entity.get("address"),
            if cross_border { None } else { Some(&seller) },
        ),
        contact_lines: ["email", "phone", "website"]
            .iter()
            .filter_map(|k| filled(&contact, k).map(str::to_owned))
            .collect(),
        tax_id_lines: [
            filled(&tax_ids, "registrationNumber")
                .map(|r| format!("{}: {r}", l(labels, "registrationLabel"))),
            filled(&tax_ids, "vatNumber").map(|v| format!("{}: {v}", l(labels, "vatNumberLabel"))),
        ]
        .into_iter()
        .flatten()
        .collect(),
    };
    let bill_to = PartyData {
        name: invoice.contact_name.clone(),
        lines: format_postal_address_lines(invoice.billing_address.as_ref(), Some(&seller)),
        contact_lines: invoice
            .contact_email
            .iter()
            .filter(|e| !e.is_empty())
            .cloned()
            .collect(),
        tax_id_lines: invoice
            .contact_vat_number
            .iter()
            .filter(|v| !v.is_empty())
            .map(|v| format!("{}: {v}", l(labels, "vatNumberLabel")))
            .collect(),
    };
    let ship_to = shipping.map(|s| PartyData {
        name: invoice.contact_name.clone(),
        lines: format_postal_address_lines(Some(&s), Some(&seller)),
        ..PartyData::default()
    });
    let iban = filled(&bank, "iban");
    let bank_lines: Vec<String> = [
        iban.map(|i| format!("IBAN: {i}")),
        filled(&bank, "bic").map(|b| format!("BIC: {b}")),
        filled(&bank, "accountNumber")
            .filter(|_| iban.is_none())
            .map(|a| format!("Account: {a}")),
        filled(&bank, "routingNumber").map(|r| format!("Routing: {r}")),
    ]
    .into_iter()
    .flatten()
    .collect();
    let draft_notice = l(labels, "draftNotice");
    Ok(DocumentData {
        fields,
        field_labels,
        labels: layout::Labels {
            from: l(labels, "from").to_owned(),
            bill_to: l(labels, "billTo").to_owned(),
            ship_to: l(labels, "shipTo").to_owned(),
            payment: l(labels, "paymentInstructions").to_owned(),
            notes: l_or(labels, "notes", "Notes").to_owned(),
            terms: l_or(labels, "terms", "Terms").to_owned(),
            page: "{page} / {total}".to_owned(),
        },
        logo_url: safe_image_url(text(&branding, "logoUrl")),
        seller: party_seller,
        bill_to,
        ship_to,
        columns,
        rows: table_rows,
        totals,
        bank_lines,
        instructions: text(&branding, "paymentInstructions").map(str::to_owned),
        notes: invoice.notes.clone(),
        terms: text(&branding, "termsAndConditions").map(str::to_owned),
        legal: LegalData {
            notices,
            fiscal_document,
            pix: None,
            required_footer: text(requirements, "requiredFooter").map(str::to_owned),
        },
        draft: invoice.draft.then(|| {
            (
                draft_notice.to_owned(),
                draft_notice
                    .split(':')
                    .next()
                    .unwrap_or_default()
                    .to_owned(),
            )
        }),
    })
}

/// `generateTemplatedInvoiceHtml(template, invoice, entity)`.
pub fn generate_templated_invoice_html(
    template: &Value,
    invoice: &InvoiceRenderData,
    entity: &Value,
) -> Result<String, RenderError> {
    let labels = &requirements_of(entity)?["labels"];
    let data = invoice_template_data(invoice, entity)?;
    let laid_out = layout::layout_invoice(template, &data);
    let type_label = if invoice.kind == "credit_note" {
        l(labels, "creditNote")
    } else {
        l(labels, "invoice")
    };
    let prefix = if invoice.draft {
        format!("{} · ", l(labels, "draftNotice"))
    } else {
        String::new()
    };
    let locale = locale_of(entity);
    Ok(svg::render_invoice_html_document(
        &laid_out,
        &format!("{prefix}{type_label} {}", invoice.invoice_number),
        &locale,
        Some(&mobile::render_mobile_invoice(template, &data)),
    ))
}
