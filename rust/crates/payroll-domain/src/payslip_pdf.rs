//! Payslips and payroll documents as PDF (`payslip-pdf.ts`).
//!
//! The TypeScript draws with pdf-lib in Helvetica; this draws the same page
//! content, operator for operator (pdf-lib's `drawText`, `drawLine` and
//! `drawRectangle`), with Helvetica's own widths and kerning
//! (`data/helvetica.json`, taken from pdf-lib). The files differ around the
//! content (object numbers, compression, the font resource names pdf-lib
//! suffixes at random), so they compare by their pages' content.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write as _;
use std::sync::LazyLock;

use serde::Deserialize;
use unicode_normalization::UnicodeNormalization;

use crate::documents::{DocumentSection, Lang, PayrollDocument};
use crate::js::{is_integer, number_text, to_fixed};
use crate::labels::payslip_line_label;
use crate::money::Cents;
use crate::ordered::OrderedMap;
use crate::types::{PayslipLine, Section};

// ── fonts ───────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
struct FontData {
    /// [code point, WinAnsi byte, width] for every character the font has.
    chars: Vec<(u32, u8, f64)>,
    /// "left,right" code points → kerning.
    kern: BTreeMap<String, f64>,
}

#[derive(Debug, Default, Deserialize)]
struct FontsData {
    helvetica: FontData,
    #[serde(rename = "helveticaBold")]
    helvetica_bold: FontData,
}

struct Font {
    name: &'static str,
    glyphs: HashMap<u32, (u8, f64)>,
    kern: HashMap<(u32, u32), f64>,
}

impl Font {
    fn of(name: &'static str, data: &FontData) -> Self {
        let glyphs = data
            .chars
            .iter()
            .map(|(cp, code, width)| (*cp, (*code, *width)))
            .collect();
        let kern = data
            .kern
            .iter()
            .filter_map(|(pair, amount)| {
                let (a, b) = pair.split_once(',')?;
                Some(((a.parse().ok()?, b.parse().ok()?), *amount))
            })
            .collect();
        Self { name, glyphs, kern }
    }

    /// `widthOfTextAtSize(text, size)`.
    fn width(&self, text: &str, size: f64) -> f64 {
        let cps: Vec<u32> = text.chars().map(u32::from).collect();
        let mut total = 0.0;
        for (i, cp) in cps.iter().enumerate() {
            let width = self.glyphs.get(cp).map_or(0.0, |g| g.1);
            let kern = cps
                .get(i + 1)
                .and_then(|next| self.kern.get(&(*cp, *next)))
                .copied()
                .unwrap_or(0.0);
            total += width + kern;
        }
        total * (size / 1000.0)
    }

    /// `encodeText(text)`: the hex string of WinAnsi codes.
    fn encode(&self, text: &str) -> String {
        let mut out = String::from("<");
        for c in text.chars() {
            let code = self.glyphs.get(&u32::from(c)).map_or(0, |g| g.0);
            let _ = write!(out, "{code:02X}");
        }
        out.push('>');
        out
    }
}

static FONTS: LazyLock<(Font, Font)> = LazyLock::new(|| {
    let data: FontsData =
        serde_json::from_str(include_str!("../data/helvetica.json")).unwrap_or_default();
    (
        Font::of("Helvetica", &data.helvetica),
        Font::of("Helvetica-Bold", &data.helvetica_bold),
    )
});

// ── numbers and text ────────────────────────────────────────────────────────

/// pdf-lib's `numberToString(num)`: `String(num)` without exponents.
fn pdf_number(num: f64) -> String {
    let text = number_text(num);
    if let Some((mantissa, exponent)) = text.split_once("e-") {
        let e: usize = exponent.parse().unwrap_or(0);
        let negative = num < 0.0;
        let digits: String = mantissa
            .trim_start_matches('-')
            .chars()
            .filter(char::is_ascii_digit)
            .collect();
        return format!(
            "{}0.{}{digits}",
            if negative { "-" } else { "" },
            "0".repeat(e.saturating_sub(1))
        );
    }
    if let Some((mantissa, exponent)) = text.split_once("e+") {
        let e: usize = exponent.parse().unwrap_or(0);
        if e > 20 {
            let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
            return format!("{int}{frac}{}", "0".repeat(e - frac.len()));
        }
    }
    text
}

type Color = (f64, f64, f64);
const INK: Color = (0.12, 0.13, 0.15);
const MUTED: Color = (0.42, 0.45, 0.5);
const RULE: Color = (0.82, 0.84, 0.87);
const SHADE: Color = (0.95, 0.96, 0.97);
const WATERMARK: Color = (0.9, 0.9, 0.92);

const PAGE_W: f64 = 595.28;
const PAGE_H: f64 = 841.89;
const MARGIN: f64 = 40.0;
const CONTENT_W: f64 = PAGE_W - MARGIN * 2.0;
const BOTTOM: f64 = 56.0;
/// `Math.cos` and `Math.sin` of 45° (`degrees(45)` in radians), as V8 answers:
/// the sine is one ulp below the cosine.
const COS_45: f64 = std::f64::consts::FRAC_1_SQRT_2;
const SIN_45: f64 = 0.707_106_781_186_547_5;

fn color(c: Color) -> String {
    format!(
        "{} {} {}",
        pdf_number(c.0),
        pdf_number(c.1),
        pdf_number(c.2)
    )
}

// ── the canvas ──────────────────────────────────────────────────────────────

#[derive(Clone)]
enum Header {
    Payslip { title: String, employee: String },
    Document { title: String },
}

struct Page {
    ops: String,
    fonts: Vec<(String, bool)>,
}

struct Canvas {
    pages: Vec<Page>,
    y: f64,
    watermark: Option<String>,
    header: Header,
    font_keys: u64,
    supported: HashSet<u32>,
    target: Option<usize>,
}

#[derive(Clone, Copy)]
struct TextOpts {
    bold: bool,
    color: Color,
    y: Option<f64>,
}

impl Default for TextOpts {
    fn default() -> Self {
        Self {
            bold: false,
            color: INK,
            y: None,
        }
    }
}

fn bold() -> TextOpts {
    TextOpts {
        bold: true,
        ..TextOpts::default()
    }
}

fn muted() -> TextOpts {
    TextOpts {
        color: MUTED,
        ..TextOpts::default()
    }
}

impl Canvas {
    fn new(watermark: Option<&str>, header: Header) -> Self {
        let watermark = watermark
            .map(crate::js::js_trim)
            .filter(|w| !w.is_empty())
            .map(str::to_owned);
        let supported = FONTS.0.glyphs.keys().copied().collect();
        let mut canvas = Self {
            pages: vec![],
            y: 0.0,
            watermark,
            header,
            font_keys: 0,
            supported,
            target: None,
        };
        canvas.add_page(true);
        canvas
    }

    fn font(bold: bool) -> &'static Font {
        if bold { &FONTS.1 } else { &FONTS.0 }
    }

    /// `clean(text)`: what Helvetica can show.
    fn clean(&self, text: &str) -> String {
        let mut out = String::new();
        for ch in text.nfc() {
            let cp = u32::from(ch);
            if cp == 0x09 || cp == 0x0a || cp == 0x0d {
                out.push(' ');
            } else if cp == 0x2212 {
                out.push('-');
            } else if self.supported.contains(&cp) {
                out.push(ch);
            } else {
                let base = ch.to_string().nfd().next().unwrap_or('?');
                out.push(if self.supported.contains(&u32::from(base)) {
                    base
                } else {
                    '?'
                });
            }
        }
        out
    }

    /// The page drawing goes to: the last, or the one the footer is on.
    fn page(&mut self) -> &mut Page {
        let at = self.target.unwrap_or(self.pages.len() - 1);
        &mut self.pages[at]
    }

    fn add_page(&mut self, first: bool) {
        self.pages.push(Page {
            ops: String::new(),
            fonts: vec![],
        });
        self.y = PAGE_H - MARGIN;
        if let Some(watermark) = self.watermark.clone() {
            let text = self.clean(&watermark);
            let size = 96.0;
            let width = FONTS.1.width(&text, size);
            let x = PAGE_W / 2.0 - (width / 2.0) * COS_45 + (size / 3.0) * SIN_45;
            let y = PAGE_H / 2.0 - (width / 2.0) * SIN_45 - (size / 3.0) * COS_45;
            self.draw_text(&text, x, y, size, true, WATERMARK, true);
        }
        if !first {
            match self.header.clone() {
                Header::Payslip { title, employee } => {
                    self.text(&title, MARGIN, 9.0, bold());
                    self.text_right(&employee, PAGE_W - MARGIN, 9.0, muted());
                }
                Header::Document { title } => self.text(&title, MARGIN, 9.0, bold()),
            }
            self.y -= 8.0;
            self.rule(MARGIN, PAGE_W - MARGIN, RULE, 0.6);
            self.y -= 16.0;
        }
    }

    /// pdf-lib's `page.drawText(text, …)`: a new font key every time.
    fn draw_text(
        &mut self,
        text: &str,
        x: f64,
        y: f64,
        size: f64,
        is_bold: bool,
        c: Color,
        rotated: bool,
    ) {
        let font = Self::font(is_bold);
        self.font_keys += 1;
        let key = format!("{}-{}", font.name, self.font_keys);
        let matrix = if rotated {
            format!(
                "{} {} {} {}",
                pdf_number(COS_45),
                pdf_number(SIN_45),
                pdf_number(-SIN_45),
                pdf_number(COS_45)
            )
        } else {
            "1 0 0 1".to_owned()
        };
        let encoded = font.encode(text);
        let page = self.page();
        page.fonts.push((key.clone(), is_bold));
        let _ = write!(
            page.ops,
            "q\nBT\n{} rg\n/{key} {} Tf\n24 TL\n{matrix} {} {} Tm\n{encoded} Tj\nT*\nET\nQ\n",
            color(c),
            pdf_number(size),
            pdf_number(x),
            pdf_number(y),
        );
    }

    fn ensure(&mut self, height: f64) {
        if self.y - height < BOTTOM {
            self.add_page(false);
        }
    }

    fn width(&self, text: &str, size: f64, is_bold: bool) -> f64 {
        Self::font(is_bold).width(&self.clean(text), size)
    }

    fn text(&mut self, text: &str, x: f64, size: f64, opts: TextOpts) {
        let cleaned = self.clean(text);
        let y = opts.y.unwrap_or(self.y);
        self.draw_text(&cleaned, x, y, size, opts.bold, opts.color, false);
    }

    fn text_right(&mut self, text: &str, x_right: f64, size: f64, opts: TextOpts) {
        let w = self.width(text, size, opts.bold);
        self.text(text, x_right - w, size, opts);
    }

    fn fit(&self, text: &str, max_width: f64, size: f64, is_bold: bool) -> String {
        let cleaned = self.clean(text);
        if self.width(&cleaned, size, is_bold) <= max_width {
            return cleaned;
        }
        let mut cut: Vec<char> = cleaned.chars().collect();
        while cut.len() > 1
            && self.width(
                &format!("{}…", cut.iter().collect::<String>()),
                size,
                is_bold,
            ) > max_width
        {
            cut.pop();
        }
        let s: String = cut.into_iter().collect();
        format!("{}…", s.trim_end())
    }

    fn wrap(&self, text: &str, max_width: f64, size: f64, is_bold: bool) -> Vec<String> {
        let mut out = vec![];
        for paragraph in self.clean(text).split('\n') {
            let mut line = String::new();
            for word in paragraph
                .split(char::is_whitespace)
                .filter(|w| !w.is_empty())
            {
                let candidate = if line.is_empty() {
                    word.to_owned()
                } else {
                    format!("{line} {word}")
                };
                if self.width(&candidate, size, is_bold) <= max_width {
                    line = candidate;
                } else {
                    if !line.is_empty() {
                        out.push(line);
                    }
                    line = if self.width(word, size, is_bold) <= max_width {
                        word.to_owned()
                    } else {
                        self.fit(word, max_width, size, is_bold)
                    };
                }
            }
            out.push(line);
        }
        out
    }

    fn rule(&mut self, x1: f64, x2: f64, c: Color, thickness: f64) {
        let y = pdf_number(self.y);
        let (x1, x2) = (pdf_number(x1), pdf_number(x2));
        let ops = format!(
            "q\n{} RG\n{} w\n[] 0 d\n{x1} {y} m\n{x1} {y} m\n{x2} {y} l\nS\nQ\n",
            color(c),
            pdf_number(thickness)
        );
        self.page().ops.push_str(&ops);
    }

    fn shade(&mut self, height: f64) {
        self.shade_at(height, MARGIN, CONTENT_W);
    }

    fn shade_at(&mut self, height: f64, x: f64, width: f64) {
        let ops = format!(
            "q\n{} rg\n0 w\n[] 0 d\n1 0 0 1 {} {} cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n0 0 m\n0 {h} l\n{w} {h} l\n{w} 0 l\nh\nf\nQ\n",
            color(SHADE),
            pdf_number(x),
            pdf_number(self.y - 3.0),
            h = pdf_number(height),
            w = pdf_number(width),
        );
        self.page().ops.push_str(&ops);
    }

    fn finish(&mut self, footer: &[String], page_word: &str, of_word: &str) {
        let total = self.pages.len();
        for index in 0..total {
            let mut y = 34.0;
            for line in footer {
                let text = self.clean(line);
                self.draw_on(index, &text, MARGIN, y);
                y -= 9.0;
            }
            let label = self.clean(&format!("{page_word} {} {of_word} {total}", index + 1));
            let w = FONTS.0.width(&label, 7.0);
            self.draw_on(index, &label, PAGE_W - MARGIN - w, 34.0);
        }
    }

    /// A footer line on page `index`, in the muted 7-point face.
    fn draw_on(&mut self, index: usize, text: &str, x: f64, y: f64) {
        self.target = Some(index);
        self.draw_text(text, x, y, 7.0, false, MUTED, false);
        self.target = None;
    }

    /// The finished file.
    fn save(self) -> Vec<u8> {
        write_pdf(&self.pages)
    }
}

fn write_pdf(pages: &[Page]) -> Vec<u8> {
    let mut objects: Vec<String> = vec![];
    // 1 catalog, 2 pages, 3 Helvetica, 4 Helvetica-Bold, then a page and its content.
    let page_ref = |i: usize| 5 + i * 2;
    let kids: Vec<String> = (0..pages.len())
        .map(|i| format!("{} 0 R", page_ref(i)))
        .collect();
    objects.push("<< /Type /Catalog /Pages 2 0 R >>".into());
    objects.push(format!(
        "<< /Type /Pages /Kids [{}] /Count {} >>",
        kids.join(" "),
        pages.len()
    ));
    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".into(),
    );
    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
            .into(),
    );
    for (i, page) in pages.iter().enumerate() {
        let mut fonts = String::new();
        for (key, b) in &page.fonts {
            let _ = write!(fonts, " /{key} {} 0 R", if *b { 4 } else { 3 });
        }
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Contents {} 0 R /Resources << /Font <<{fonts} >> >> >>",
            pdf_number(PAGE_W),
            pdf_number(PAGE_H),
            page_ref(i) + 1
        ));
        objects.push(format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            page.ops.len(),
            page.ops
        ));
    }
    let mut out: Vec<u8> = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = vec![];
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
    }
    let xref_at = out.len();
    let mut xref = format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
    for offset in offsets {
        let _ = writeln!(xref, "{offset:010} 00000 n ");
    }
    let _ = write!(
        xref,
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
        objects.len() + 1
    );
    out.extend_from_slice(xref.as_bytes());
    out
}

// ── payslips ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipTotalsView {
    pub gross_cents: Cents,
    pub taxable_wage_cents: Cents,
    pub employee_taxes_cents: Cents,
    pub employee_deductions_cents: Cents,
    pub reimbursements_cents: Cents,
    pub net_cents: Cents,
    pub employer_taxes_cents: Cents,
    pub employer_cost_cents: Cents,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipYtdView {
    pub totals: PayslipTotalsView,
    pub by_line: OrderedMap<Cents>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TaxId {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipEmployerView {
    pub name: String,
    #[serde(default)]
    pub legal_name: Option<String>,
    pub address: Vec<String>,
    #[serde(default)]
    pub tax_id: Option<TaxId>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipEmployeeView {
    pub name: String,
    pub address: Vec<String>,
    #[serde(default)]
    pub employee_number: Option<String>,
    #[serde(default)]
    pub job_title: Option<String>,
    #[serde(default)]
    pub tax_id_masked: Option<String>,
    #[serde(default)]
    pub date_of_birth: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipPeriodView {
    pub start: String,
    pub end: String,
    pub pay_date: String,
    pub period_number: f64,
    pub tax_year: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipNlView {
    pub contract_hours_per_week: Option<f64>,
    pub written_contract: bool,
    pub indefinite_contract: bool,
    pub on_call: bool,
    #[serde(default)]
    pub minimum_hourly_wage_cents: Option<Cents>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipUsView {
    pub work_state: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipCorrectionView {
    pub original_number: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayslipView {
    pub country: String,
    pub currency: String,
    pub number: Option<String>,
    pub employer: PayslipEmployerView,
    pub employee: PayslipEmployeeView,
    pub period: PayslipPeriodView,
    pub lines: Vec<PayslipLine>,
    pub totals: PayslipTotalsView,
    #[serde(default)]
    pub ytd: Option<PayslipYtdView>,
    #[serde(default)]
    pub nl: Option<PayslipNlView>,
    #[serde(default)]
    pub us: Option<PayslipUsView>,
    #[serde(default)]
    pub pay_to: Option<String>,
    #[serde(default)]
    pub correction: Option<PayslipCorrectionView>,
    #[serde(default)]
    pub watermark: Option<String>,
}

/// `payslipLineKey(line)`: a line's identity across a year.
pub fn payslip_line_key(line: &PayslipLine) -> String {
    format!(
        "{}|{}|{}|{}",
        line.section.as_str(),
        line.code,
        line.jurisdiction.clone().flatten().unwrap_or_default(),
        line.label.clone().flatten().unwrap_or_default()
    )
}

struct Texts {
    payslip: &'static str,
    pay_stub: &'static str,
    employer: &'static str,
    employee: &'static str,
    period: &'static str,
    pay_date: &'static str,
    number: &'static str,
    period_no: &'static str,
    employee_no: &'static str,
    job_title: &'static str,
    date_of_birth: &'static str,
    description: &'static str,
    quantity: &'static str,
    rate: &'static str,
    amount: &'static str,
    ytd: &'static str,
    earning: &'static str,
    deduction: &'static str,
    tax: &'static str,
    reimbursement: &'static str,
    employer_costs: &'static str,
    info: &'static str,
    gross: &'static str,
    taxable_nl: &'static str,
    taxable_us: &'static str,
    taxes: &'static str,
    deductions: &'static str,
    reimbursements: &'static str,
    net: &'static str,
    employer_cost: &'static str,
    contract: &'static str,
    contract_written: &'static str,
    contract_not_written: &'static str,
    contract_open: &'static str,
    contract_fixed: &'static str,
    contract_on_call: &'static str,
    contract_not_on_call: &'static str,
    hours_per_week: &'static str,
    minimum_wage: &'static str,
    minimum_wage_see: &'static str,
    state: &'static str,
    pay_to: &'static str,
    correction_of: &'static str,
    correction_note: &'static str,
    page: &'static str,
    of: &'static str,
}

const EN: Texts = Texts {
    payslip: "Payslip",
    pay_stub: "Pay stub",
    employer: "Employer",
    employee: "Employee",
    period: "Period",
    pay_date: "Pay date",
    number: "Payslip no.",
    period_no: "Period no.",
    employee_no: "Employee no.",
    job_title: "Job title",
    date_of_birth: "Date of birth",
    description: "Description",
    quantity: "Qty",
    rate: "Rate",
    amount: "Amount",
    ytd: "Year to date",
    earning: "Earnings",
    deduction: "Deductions",
    tax: "Taxes withheld",
    reimbursement: "Reimbursements",
    employer_costs: "Employer costs (not deducted from your pay)",
    info: "Information",
    gross: "Gross pay",
    taxable_nl: "Wage for payroll tax",
    taxable_us: "Federal taxable wages",
    taxes: "Taxes withheld",
    deductions: "Deductions",
    reimbursements: "Reimbursements",
    net: "Net pay",
    employer_cost: "Total employer cost",
    contract: "Contract",
    contract_written: "written",
    contract_not_written: "not in writing",
    contract_open: "open-ended",
    contract_fixed: "fixed term",
    contract_on_call: "on-call contract",
    contract_not_on_call: "not an on-call contract",
    hours_per_week: "Agreed hours per week",
    minimum_wage: "Applicable statutory minimum hourly wage",
    minimum_wage_see: "see wetten.overheid.nl (Wet minimumloon)",
    state: "Work state",
    pay_to: "Paid to",
    correction_of: "Correction of payslip",
    correction_note: "This document shows only the difference with the earlier payslip.",
    page: "Page",
    of: "of",
};

const NL: Texts = Texts {
    payslip: "Loonstrook",
    pay_stub: "Loonstrook",
    employer: "Werkgever",
    employee: "Werknemer",
    period: "Periode",
    pay_date: "Betaaldatum",
    number: "Loonstrooknr.",
    period_no: "Periodenr.",
    employee_no: "Personeelsnr.",
    job_title: "Functie",
    date_of_birth: "Geboortedatum",
    description: "Omschrijving",
    quantity: "Aantal",
    rate: "Tarief",
    amount: "Bedrag",
    ytd: "Cumulatief",
    earning: "Inkomsten",
    deduction: "Inhoudingen",
    tax: "Ingehouden belastingen en premies",
    reimbursement: "Vergoedingen",
    employer_costs: "Werkgeverslasten (niet ingehouden op uw loon)",
    info: "Informatie",
    gross: "Bruto loon",
    taxable_nl: "Loon voor de loonbelasting",
    taxable_us: "Federaal belastbaar loon",
    taxes: "Ingehouden loonheffing",
    deductions: "Inhoudingen",
    reimbursements: "Vergoedingen",
    net: "Netto uitbetaald",
    employer_cost: "Totale werkgeverskosten",
    contract: "Arbeidsovereenkomst",
    contract_written: "schriftelijk",
    contract_not_written: "niet schriftelijk",
    contract_open: "voor onbepaalde tijd",
    contract_fixed: "voor bepaalde tijd",
    contract_on_call: "oproepovereenkomst",
    contract_not_on_call: "geen oproepovereenkomst",
    hours_per_week: "Overeengekomen uren per week",
    minimum_wage: "Toepasselijk wettelijk minimumuurloon",
    minimum_wage_see: "zie wetten.overheid.nl (Wet minimumloon)",
    state: "Werkstaat",
    pay_to: "Betaald op",
    correction_of: "Correctie op loonstrook",
    correction_note: "Dit document toont alleen het verschil met de eerdere loonstrook.",
    page: "Pagina",
    of: "van",
};

fn texts(lang: Lang) -> &'static Texts {
    if lang.is_nl() { &NL } else { &EN }
}

/// `formatMoney(cents, currency, lang)`.
pub fn format_money(cents: Cents, currency: &str, lang: Lang) -> String {
    let negative = cents < 0.0;
    let abs = cents.trunc().abs();
    let whole = number_text((abs / 100.0).floor());
    let fraction = format!("{:0>2}", number_text(abs % 100.0));
    let nl = lang.is_nl();
    let grouped = crate::documents::group_thousands(&whole, if nl { '.' } else { ',' });
    let symbol = match currency {
        "EUR" => Some("€"),
        "USD" => Some("$"),
        "GBP" => Some("£"),
        _ => None,
    };
    let space = if nl || symbol.is_none() { " " } else { "" };
    format!(
        "{}{}{space}{grouped}{}{fraction}",
        if negative { "-" } else { "" },
        symbol.unwrap_or(currency),
        if nl { ',' } else { '.' }
    )
}

fn format_number(value: f64, lang: Lang) -> String {
    let fixed = if is_integer(value) {
        number_text(value)
    } else {
        // `toFixed(2).replace(/\.?0+$/, '')`.
        let t = to_fixed(value, 2);
        let trimmed = t.trim_end_matches('0');
        let trimmed = trimmed.strip_suffix('.').unwrap_or(trimmed);
        if t.ends_with('0') {
            trimmed.to_owned()
        } else {
            t.clone()
        }
    };
    if lang.is_nl() {
        fixed.replacen('.', ",", 1)
    } else {
        fixed
    }
}

/// `formatDate(iso, lang)`.
pub fn format_date(iso: &str, lang: Lang) -> String {
    let b = iso.as_bytes();
    let ok = b.len() >= 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..10]
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if !ok {
        return iso.to_owned();
    }
    let (y, m, d) = (&iso[..4], &iso[5..7], &iso[8..10]);
    if lang.is_nl() {
        format!("{d}-{m}-{y}")
    } else {
        format!("{m}/{d}/{y}")
    }
}

fn non_empty(v: Option<&str>) -> Option<&str> {
    v.filter(|s| !s.is_empty())
}

/// `renderPayslipPdf(view, lang)`.
pub fn render_payslip_pdf(view: &PayslipView, lang: Lang) -> Vec<u8> {
    let t = texts(lang);
    let us = view.country == "US";
    let title = if us { t.pay_stub } else { t.payslip };
    let number = view.number.clone().unwrap_or_default();
    let header_title = crate::js::js_trim(&format!("{title} {number}")).to_owned();
    let mut c = Canvas::new(
        view.watermark.as_deref(),
        Header::Payslip {
            title: header_title.clone(),
            employee: view.employee.name.clone(),
        },
    );
    let money = |cents: Cents| format_money(cents, &view.currency, lang);
    c.text(title, MARGIN, 20.0, bold());
    c.text_right(&view.employer.name, PAGE_W - MARGIN, 11.0, bold());
    c.y -= 16.0;
    let period_text = format!(
        "{} - {}",
        format_date(&view.period.start, lang),
        format_date(&view.period.end, lang)
    );
    c.text(&period_text, MARGIN, 10.0, muted());
    c.y -= 24.0;
    if let Some(correction) = &view.correction {
        c.shade(26.0);
        let line = crate::js::js_trim(&format!(
            "{} {}",
            t.correction_of,
            correction.original_number.clone().unwrap_or_default()
        ))
        .to_owned();
        let y = c.y;
        c.text(
            &line,
            MARGIN + 8.0,
            9.0,
            TextOpts {
                y: Some(y + 11.0),
                ..bold()
            },
        );
        c.text(
            t.correction_note,
            MARGIN + 8.0,
            8.0,
            TextOpts {
                y: Some(y + 1.0),
                ..muted()
            },
        );
        c.y -= 30.0;
    }
    let col_w = (CONTENT_W - 20.0) / 2.0;
    let right_x = MARGIN + col_w + 20.0;
    let start_y = c.y;
    c.text(
        t.employer,
        MARGIN,
        8.0,
        TextOpts {
            y: Some(start_y),
            ..muted()
        },
    );
    c.text(
        t.employee,
        right_x,
        8.0,
        TextOpts {
            y: Some(start_y),
            ..muted()
        },
    );
    let mut left_y = start_y - 12.0;
    let mut right_y = start_y - 12.0;
    let e = &view.employer;
    let mut employer_block = vec![match non_empty(e.legal_name.as_deref()) {
        Some(legal) if legal != e.name => legal.to_owned(),
        _ => e.name.clone(),
    }];
    employer_block.extend(e.address.iter().cloned());
    if let Some(tax_id) = &e.tax_id {
        employer_block.push(format!("{}: {}", tax_id.label, tax_id.value));
    }
    for line in employer_block.into_iter().filter(|l| !l.is_empty()) {
        let fitted = c.fit(&line, col_w, 9.0, false);
        c.text(
            &fitted,
            MARGIN,
            9.0,
            TextOpts {
                y: Some(left_y),
                ..TextOpts::default()
            },
        );
        left_y -= 11.0;
    }
    let p = &view.employee;
    let mut employee_block = vec![p.name.clone()];
    employee_block.extend(p.address.iter().cloned());
    if let Some(v) = non_empty(p.employee_number.as_deref()) {
        employee_block.push(format!("{}: {v}", t.employee_no));
    }
    if let Some(v) = non_empty(p.job_title.as_deref()) {
        employee_block.push(format!("{}: {v}", t.job_title));
    }
    if let Some(v) = non_empty(p.date_of_birth.as_deref()) {
        employee_block.push(format!("{}: {}", t.date_of_birth, format_date(v, lang)));
    }
    if let Some(v) = non_empty(p.tax_id_masked.as_deref()) {
        employee_block.push(format!(
            "{}: {v}",
            if view.country == "NL" { "BSN" } else { "SSN" }
        ));
    }
    for line in employee_block.into_iter().filter(|l| !l.is_empty()) {
        let fitted = c.fit(&line, col_w, 9.0, false);
        c.text(
            &fitted,
            right_x,
            9.0,
            TextOpts {
                y: Some(right_y),
                ..TextOpts::default()
            },
        );
        right_y -= 11.0;
    }
    c.y = left_y.min(right_y) - 8.0;
    let mut facts: Vec<(String, String)> = vec![
        (t.period.into(), period_text.clone()),
        (t.pay_date.into(), format_date(&view.period.pay_date, lang)),
        (
            t.number.into(),
            view.number.clone().unwrap_or_else(|| "-".into()),
        ),
        (
            t.period_no.into(),
            format!(
                "{} / {}",
                number_text(view.period.period_number),
                number_text(view.period.tax_year)
            ),
        ),
    ];
    if let Some(nl) = &view.nl {
        facts.push((
            t.contract.into(),
            [
                if nl.written_contract {
                    t.contract_written
                } else {
                    t.contract_not_written
                },
                if nl.indefinite_contract {
                    t.contract_open
                } else {
                    t.contract_fixed
                },
                if nl.on_call {
                    t.contract_on_call
                } else {
                    t.contract_not_on_call
                },
            ]
            .join(", "),
        ));
        facts.push((
            t.hours_per_week.into(),
            nl.contract_hours_per_week
                .map_or_else(|| "-".into(), |h| format_number(h, lang)),
        ));
        facts.push((
            t.minimum_wage.into(),
            nl.minimum_hourly_wage_cents
                .map_or_else(|| t.minimum_wage_see.into(), money),
        ));
    }
    if let Some(state) = view
        .us
        .as_ref()
        .and_then(|u| non_empty(u.work_state.as_deref()))
    {
        facts.push((t.state.into(), state.to_owned()));
    }
    if let Some(pay_to) = non_empty(view.pay_to.as_deref()) {
        facts.push((t.pay_to.into(), pay_to.to_owned()));
    }
    c.rule(MARGIN, PAGE_W - MARGIN, RULE, 0.6);
    c.y -= 13.0;
    for (label, value) in &facts {
        c.ensure(14.0);
        c.text(label, MARGIN, 8.5, muted());
        let fitted = c.fit(value, CONTENT_W - 190.0, 8.5, false);
        c.text(&fitted, MARGIN + 190.0, 8.5, TextOpts::default());
        c.y -= 12.0;
    }
    c.y -= 2.0;
    c.rule(MARGIN, PAGE_W - MARGIN, RULE, 0.6);
    c.y -= 18.0;
    let has_ytd = view.ytd.is_some();
    let amount_x = if has_ytd { 470.0 } else { PAGE_W - MARGIN };
    let ytd_x = PAGE_W - MARGIN;
    let qty_x = if has_ytd { 335.0 } else { 380.0 };
    let rate_x = if has_ytd { 400.0 } else { 455.0 };
    let desc_w = qty_x - MARGIN - 40.0;
    c.shade(14.0);
    let y = c.y + 1.0;
    let head = TextOpts {
        y: Some(y),
        ..bold()
    };
    c.text(t.description, MARGIN + 4.0, 8.0, head);
    c.text_right(t.quantity, qty_x, 8.0, head);
    c.text_right(t.rate, rate_x, 8.0, head);
    c.text_right(t.amount, amount_x, 8.0, head);
    if has_ytd {
        c.text_right(t.ytd, ytd_x, 8.0, head);
    }
    c.y -= 18.0;
    let mut grouped: Vec<(Section, Vec<&PayslipLine>)> = vec![];
    for line in &view.lines {
        if line.code == "nl.minimum_wage" {
            continue;
        }
        match grouped.iter_mut().find(|(s, _)| *s == line.section) {
            Some((_, list)) => list.push(line),
            None => grouped.push((line.section, vec![line])),
        }
    }
    let lines_of = |section: Section| {
        grouped
            .iter()
            .find(|(s, _)| *s == section)
            .map(|(_, l)| l.clone())
            .unwrap_or_default()
    };
    let ytd_of = |line: &PayslipLine| {
        view.ytd
            .as_ref()
            .and_then(|y| y.by_line.get(&payslip_line_key(line)).copied())
    };
    let draw_lines = |c: &mut Canvas, section: Section, heading: &str| {
        let lines = lines_of(section);
        if lines.is_empty() {
            return;
        }
        c.ensure(30.0);
        c.text(heading, MARGIN + 4.0, 9.0, bold());
        c.y -= 13.0;
        for line in lines {
            c.ensure(14.0);
            let label = payslip_line_label(
                &line.label_key,
                line.label.clone().flatten().as_deref(),
                lang,
            );
            let fitted = c.fit(&label, desc_w, 9.0, false);
            c.text(&fitted, MARGIN + 12.0, 9.0, TextOpts::default());
            if let Some(q) = line.quantity.flatten() {
                let qty = format_number(q, lang);
                if !qty.is_empty() {
                    c.text_right(&qty, qty_x, 9.0, muted());
                }
            }
            if let Some(r) = line.rate.flatten() {
                let rate = format_number(r, lang);
                if !rate.is_empty() {
                    c.text_right(&rate, rate_x, 9.0, muted());
                }
            }
            c.text_right(
                &money(line.amount_cents),
                amount_x,
                9.0,
                TextOpts::default(),
            );
            if has_ytd {
                if let Some(ytd) = ytd_of(line) {
                    c.text_right(&money(ytd), ytd_x, 9.0, muted());
                }
            }
            c.y -= 12.0;
        }
        c.y -= 6.0;
    };
    for (section, heading) in [
        (Section::Earning, t.earning),
        (Section::Deduction, t.deduction),
        (Section::Tax, t.tax),
        (Section::Reimbursement, t.reimbursement),
        (Section::Info, t.info),
    ] {
        draw_lines(&mut c, section, heading);
    }
    c.ensure(120.0);
    c.rule(MARGIN, PAGE_W - MARGIN, INK, 0.8);
    c.y -= 16.0;
    let totals = &view.totals;
    let ytd_totals = view.ytd.as_ref().map(|y| &y.totals);
    let summary_rows: [(&str, f64, Option<f64>); 5] = [
        (
            t.gross,
            totals.gross_cents,
            ytd_totals.map(|y| y.gross_cents),
        ),
        (
            if view.country == "NL" {
                t.taxable_nl
            } else {
                t.taxable_us
            },
            totals.taxable_wage_cents,
            ytd_totals.map(|y| y.taxable_wage_cents),
        ),
        (
            t.taxes,
            -totals.employee_taxes_cents,
            ytd_totals.map(|y| -y.employee_taxes_cents),
        ),
        (
            t.deductions,
            -totals.employee_deductions_cents,
            ytd_totals.map(|y| -y.employee_deductions_cents),
        ),
        (
            t.reimbursements,
            totals.reimbursements_cents,
            ytd_totals.map(|y| y.reimbursements_cents),
        ),
    ];
    for (label, cents, ytd) in summary_rows {
        c.ensure(14.0);
        c.text(label, MARGIN + 4.0, 9.0, TextOpts::default());
        c.text_right(&money(cents), amount_x, 9.0, TextOpts::default());
        if let (true, Some(ytd)) = (has_ytd, ytd) {
            c.text_right(&money(ytd), ytd_x, 9.0, muted());
        }
        c.y -= 13.0;
    }
    c.ensure(28.0);
    c.rule(MARGIN, PAGE_W - MARGIN, INK, 0.8);
    c.y -= 6.0;
    c.shade(20.0);
    c.y -= 11.0;
    c.text(t.net, MARGIN + 4.0, 11.0, bold());
    c.text_right(&money(totals.net_cents), amount_x, 11.0, bold());
    if let (true, Some(y)) = (has_ytd, ytd_totals) {
        c.text_right(&money(y.net_cents), ytd_x, 9.0, muted());
    }
    c.y -= 22.0;
    let employer_lines = lines_of(Section::Employer);
    if !employer_lines.is_empty()
        || (totals.employer_taxes_cents != 0.0 && !totals.employer_taxes_cents.is_nan())
    {
        c.ensure(30.0 + employer_lines.len() as f64 * 12.0);
        c.text(
            t.employer_costs,
            MARGIN + 4.0,
            8.0,
            TextOpts {
                bold: true,
                color: MUTED,
                y: None,
            },
        );
        c.y -= 12.0;
        for line in &employer_lines {
            c.ensure(12.0);
            let label = payslip_line_label(
                &line.label_key,
                line.label.clone().flatten().as_deref(),
                lang,
            );
            let fitted = c.fit(&label, desc_w, 8.0, false);
            c.text(&fitted, MARGIN + 12.0, 8.0, muted());
            c.text_right(&money(line.amount_cents), amount_x, 8.0, muted());
            if has_ytd {
                if let Some(ytd) = ytd_of(line) {
                    c.text_right(&money(ytd), ytd_x, 8.0, muted());
                }
            }
            c.y -= 11.0;
        }
        c.text(
            t.employer_cost,
            MARGIN + 12.0,
            8.0,
            TextOpts {
                bold: true,
                color: MUTED,
                y: None,
            },
        );
        c.text_right(
            &money(totals.employer_cost_cents),
            amount_x,
            8.0,
            TextOpts {
                bold: true,
                color: MUTED,
                y: None,
            },
        );
        if let (true, Some(y)) = (has_ytd, ytd_totals) {
            c.text_right(&money(y.employer_cost_cents), ytd_x, 8.0, muted());
        }
        c.y -= 12.0;
    }
    let footer =
        crate::js::js_trim(&format!("{} - {title} {number}", view.employer.name)).to_owned();
    c.finish(&[footer], t.page, t.of);
    c.save()
}

/// `renderDocumentPdf(doc)`.
pub fn render_document_pdf(doc: &PayrollDocument) -> Vec<u8> {
    let lang = doc.language;
    let t = texts(lang);
    let mut c = Canvas::new(
        doc.watermark.clone().flatten().as_deref(),
        Header::Document {
            title: doc.title.clone(),
        },
    );
    c.text(&doc.title, MARGIN, 18.0, bold());
    c.y -= 16.0;
    if let Some(subtitle) = non_empty(doc.subtitle.as_deref()) {
        c.text(subtitle, MARGIN, 10.0, muted());
        c.y -= 14.0;
    }
    c.y -= 8.0;
    let from = doc.from.clone().unwrap_or_default();
    let to = doc.to.clone().unwrap_or_default();
    if !from.is_empty() || !to.is_empty() {
        let col_w = (CONTENT_W - 20.0) / 2.0;
        let right_x = MARGIN + col_w + 20.0;
        let mut left_y = c.y;
        let mut right_y = c.y;
        for (index, line) in from.iter().enumerate() {
            let fitted = c.fit(line, col_w, 9.0, index == 0);
            c.text(
                &fitted,
                MARGIN,
                9.0,
                TextOpts {
                    bold: index == 0,
                    color: INK,
                    y: Some(left_y),
                },
            );
            left_y -= 11.0;
        }
        for (index, line) in to.iter().enumerate() {
            let fitted = c.fit(line, col_w, 9.0, index == 0);
            c.text(
                &fitted,
                right_x,
                9.0,
                TextOpts {
                    bold: index == 0,
                    color: INK,
                    y: Some(right_y),
                },
            );
            right_y -= 11.0;
        }
        c.y = left_y.min(right_y) - 10.0;
    }
    for section in &doc.sections {
        c.ensure(40.0);
        let title = match section {
            DocumentSection::Fields { title, .. }
            | DocumentSection::Table { title, .. }
            | DocumentSection::Text { title, .. } => title.as_deref().filter(|t| !t.is_empty()),
        };
        if let Some(title) = title {
            c.text(title, MARGIN, 11.0, bold());
            c.y -= 6.0;
            c.rule(MARGIN, PAGE_W - MARGIN, RULE, 0.6);
            c.y -= 14.0;
        }
        match section {
            DocumentSection::Fields { fields, .. } => {
                for field in fields {
                    let emphasis = field.emphasis.unwrap_or(false);
                    let value_lines = c.wrap(&field.value, CONTENT_W - 230.0, 9.0, emphasis);
                    c.ensure(value_lines.len() as f64 * 12.0 + 2.0);
                    let label = c.fit(&field.label, 220.0, 9.0, false);
                    c.text(&label, MARGIN, 9.0, muted());
                    for line in &value_lines {
                        c.text(
                            line,
                            MARGIN + 230.0,
                            9.0,
                            TextOpts {
                                bold: emphasis,
                                ..TextOpts::default()
                            },
                        );
                        c.y -= 12.0;
                    }
                }
                c.y -= 6.0;
            }
            DocumentSection::Text { paragraphs, .. } => {
                for paragraph in paragraphs {
                    for line in c.wrap(paragraph, CONTENT_W, 9.0, false) {
                        c.ensure(12.0);
                        c.text(&line, MARGIN, 9.0, TextOpts::default());
                        c.y -= 12.0;
                    }
                    c.y -= 4.0;
                }
                c.y -= 4.0;
            }
            DocumentSection::Table {
                columns,
                align_right,
                rows,
                totals,
                ..
            } => {
                draw_table(
                    &mut c,
                    columns,
                    align_right.as_deref().unwrap_or(&[]),
                    rows,
                    totals.as_ref(),
                );
            }
        }
    }
    c.finish(&doc.footer.clone().unwrap_or_default(), t.page, t.of);
    c.save()
}

fn draw_table(
    c: &mut Canvas,
    columns: &[String],
    align_right: &[usize],
    rows: &[Vec<String>],
    totals: Option<&Vec<String>>,
) {
    let count = columns.len();
    let right = |col: usize| align_right.contains(&col);
    let gap = 10.0;
    let mut all_rows: Vec<(&Vec<String>, bool)> = rows.iter().map(|r| (r, false)).collect();
    if let Some(t) = totals {
        all_rows.push((t, true));
    }
    let natural: Vec<f64> = columns
        .iter()
        .enumerate()
        .map(|(col, header)| {
            let mut max = c.width(header, 8.0, true);
            for (row, is_total) in &all_rows {
                let w = c.width(row.get(col).map_or("", String::as_str), 8.5, *is_total);
                max = crate::money::js_max(max, w);
            }
            max
        })
        .collect();
    let available = CONTENT_W - gap * (count as f64 - 1.0);
    let total: f64 = natural.iter().fold(0.0, |a, b| a + b);
    let mut widths = natural.clone();
    if total > available {
        let fair = available / count as f64;
        let wide = natural.iter().filter(|w| **w > fair).count();
        let narrow_total = natural
            .iter()
            .filter(|w| **w <= fair)
            .fold(0.0, |a, b| a + b);
        let wide_share = (available - narrow_total) / (wide.max(1) as f64);
        widths = natural
            .iter()
            .map(|w| {
                if *w > fair {
                    crate::money::js_max(wide_share, 30.0)
                } else {
                    *w
                }
            })
            .collect();
    }
    let mut xs = vec![];
    let mut cursor = MARGIN;
    for w in &widths {
        xs.push(cursor);
        cursor += w + gap;
    }
    let draw_header = |c: &mut Canvas| {
        c.shade(14.0);
        let y = c.y + 1.0;
        for (col, header) in columns.iter().enumerate() {
            let text = c.fit(header, widths[col], 8.0, true);
            let opts = TextOpts {
                y: Some(y),
                ..bold()
            };
            if right(col) {
                c.text_right(&text, xs[col] + widths[col], 8.0, opts);
            } else {
                c.text(&text, xs[col], 8.0, opts);
            }
        }
        c.y -= 18.0;
    };
    draw_header(c);
    for row in rows {
        if c.y - 12.0 < BOTTOM {
            c.add_page(false);
            draw_header(c);
        }
        for (col, cell) in row.iter().enumerate() {
            let width = widths.get(col).copied().unwrap_or(f64::NAN);
            let x = xs.get(col).copied().unwrap_or(f64::NAN);
            let text = c.fit(cell, width, 8.5, false);
            if right(col) {
                c.text_right(&text, x + width, 8.5, TextOpts::default());
            } else {
                c.text(&text, x, 8.5, TextOpts::default());
            }
        }
        c.y -= 12.0;
    }
    if let Some(totals) = totals {
        c.ensure(18.0);
        c.rule(MARGIN, PAGE_W - MARGIN, INK, 0.8);
        c.y -= 12.0;
        for (col, cell) in totals.iter().enumerate() {
            let width = widths.get(col).copied().unwrap_or(f64::NAN);
            let x = xs.get(col).copied().unwrap_or(f64::NAN);
            let text = c.fit(cell, width, 8.5, true);
            if right(col) {
                c.text_right(&text, x + width, 8.5, bold());
            } else {
                c.text(&text, x, 8.5, bold());
            }
        }
        c.y -= 12.0;
    }
    c.y -= 10.0;
}

/// The pages' drawing operators, font resource names without pdf-lib's
/// random suffix: what two renderings of one document share. Works on the
/// files this module writes (uncompressed streams).
pub fn page_contents(pdf: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(pdf);
    let mut out = vec![];
    let mut rest: &str = &text;
    while let Some(at) = rest.find("stream\n") {
        let body = &rest[at + 7..];
        let Some(end) = body.find("\nendstream") else {
            break;
        };
        out.push(strip_font_suffixes(&body[..end]));
        rest = &body[end..];
    }
    out
}

/// `/Helvetica-Bold-123` → `/Helvetica-Bold`.
pub fn strip_font_suffixes(ops: &str) -> String {
    let mut out = String::new();
    for line in ops.split_inclusive('\n') {
        if let Some(rest) = line.strip_prefix('/') {
            if let Some((name, tail)) = rest.split_once(' ') {
                if let Some((base, suffix)) = name.rsplit_once('-') {
                    if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) {
                        out.push('/');
                        out.push_str(base);
                        out.push(' ');
                        out.push_str(tail);
                        continue;
                    }
                }
            }
        }
        out.push_str(line);
    }
    out
}
