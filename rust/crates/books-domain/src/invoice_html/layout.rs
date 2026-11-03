//! The invoice template layout engine (`invoice-template/layout.ts`): a
//! template and an invoice become pages of positioned primitives (text
//! runs, rectangles, lines, images, a QR code) that the SVG painter draws.
//! Blocks are minimum-size boxes that grow and push the ones below them
//! down; the line-items table is the one block that splits across pages;
//! blocks under it follow it; `everyPage` blocks repeat; totals and legal
//! notices are never lost (implicit blocks).
//!
//! The template is the stored document (`serde_json::Value`, already
//! validated); [`DocumentData`] is what the invoice prints
//! (`invoice-template/data.ts`).

use std::cell::Cell;
use std::rc::Rc;

use serde_json::Value;

use super::fonts::{FontFace, ascent_ratio, normalize_text, text_width, wrap_text};
use crate::js;

// ── Output ──────────────────────────────────────────────────────────────────

/// `Primitive`.
#[derive(Debug, Clone, PartialEq)]
pub enum Primitive {
    Text {
        x: f64,
        /// Baseline, from the top of the page.
        y: f64,
        text: String,
        size: f64,
        face: FontFace,
        color: String,
    },
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: Option<String>,
        stroke: Option<String>,
        stroke_width: Option<f64>,
        radius: Option<f64>,
    },
    Line {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        color: String,
        width: f64,
    },
    Image {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        src: String,
        align: String,
    },
    Qr {
        x: f64,
        y: f64,
        size: f64,
        matrix: Vec<Vec<bool>>,
    },
    Watermark {
        text: String,
        size: f64,
        color: String,
        face: FontFace,
    },
}

/// `InvoiceLayout` (the placements the designer reads are left out).
#[derive(Debug, Clone, PartialEq)]
pub struct InvoiceLayout {
    pub width: f64,
    pub height: f64,
    pub pages: Vec<Vec<Primitive>>,
}

// ── Data ────────────────────────────────────────────────────────────────────

/// `PartyData`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PartyData {
    pub name: String,
    pub lines: Vec<String>,
    pub contact_lines: Vec<String>,
    pub tax_id_lines: Vec<String>,
}

/// `TableColumnData`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableColumnData {
    pub label: String,
    pub align: Option<&'static str>,
    pub required: bool,
}

/// `TableRowData`: cells by column key.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TableRowData {
    pub cells: Vec<(&'static str, String)>,
    pub sub_lines: Vec<String>,
}

impl TableRowData {
    pub(crate) fn cell(&self, key: &str) -> Option<&str> {
        self.cells
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.as_str())
    }
}

/// `TotalsRowData`; `kind` is `normal` (`None`), `muted`, `heading`,
/// `total` or `balance`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TotalsRow {
    pub label: String,
    pub value: String,
    pub kind: Option<&'static str>,
}

/// The Pix block of `LegalData`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PixData {
    pub title: String,
    pub key: String,
    pub payload: String,
    pub matrix: Vec<Vec<bool>>,
}

/// `LegalData`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegalData {
    pub notices: Vec<String>,
    pub fiscal_document: Option<Vec<String>>,
    pub pix: Option<PixData>,
    pub required_footer: Option<String>,
}

/// `InvoiceDocumentData.labels`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Labels {
    pub from: String,
    pub bill_to: String,
    pub ship_to: String,
    pub payment: String,
    pub notes: String,
    pub terms: String,
    pub page: String,
}

/// `InvoiceDocumentData`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocumentData {
    /// Field values (`fields[field]`); a missing one prints nothing.
    pub fields: Vec<(&'static str, String)>,
    pub field_labels: Vec<(&'static str, String)>,
    pub labels: Labels,
    pub logo_url: Option<String>,
    pub seller: PartyData,
    pub bill_to: PartyData,
    pub ship_to: Option<PartyData>,
    /// Columns in insertion order (`Object.entries`).
    pub columns: Vec<(&'static str, TableColumnData)>,
    pub rows: Vec<TableRowData>,
    pub totals: Vec<TotalsRow>,
    pub bank_lines: Vec<String>,
    pub instructions: Option<String>,
    pub notes: Option<String>,
    pub terms: Option<String>,
    pub legal: LegalData,
    /// `(banner, watermark)`.
    pub draft: Option<(String, String)>,
}

impl DocumentData {
    pub(crate) fn column(&self, key: &str) -> Option<&TableColumnData> {
        self.columns.iter().find(|(k, _)| *k == key).map(|(_, c)| c)
    }

    pub(crate) fn field_label(&self, field: &str) -> Option<&str> {
        self.field_labels
            .iter()
            .find(|(k, _)| *k == field)
            .map(|(_, v)| v.as_str())
    }
}

/// `fieldValue(data, field)`: trimmed, empty when missing.
pub fn field_value(data: &DocumentData, field: &str) -> String {
    data.fields
        .iter()
        .find(|(k, _)| *k == field)
        .map(|(_, v)| crate::jurisdictions::js_trim(v).to_owned())
        .unwrap_or_default()
}

const TEMPLATE_FIELDS: [&str; 24] = [
    "title",
    "invoiceNumber",
    "issueDate",
    "dueDate",
    "reference",
    "placeOfSupply",
    "currency",
    "total",
    "balanceDue",
    "amountPaid",
    "paymentTerms",
    "customerName",
    "customerEmail",
    "customerTaxId",
    "sellerName",
    "sellerLegalName",
    "sellerEmail",
    "sellerPhone",
    "sellerWebsite",
    "sellerTaxId",
    "sellerRegistrationId",
    "sellerIban",
    "sellerBic",
    "footerText",
];

/// `{{name}}` with `\s*` around a `\w+` name: the pieces of a line
/// (`line.split(/\{\{\s*(\w+)\s*\}\}/)`), odd entries the names.
fn split_placeholders(line: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut rest = line;
    let mut static_part = String::new();
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let trimmed_start = after.trim_start_matches(crate::jurisdictions::is_js_space);
        let name_len = trimmed_start
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(trimmed_start.len());
        let name = &trimmed_start[..name_len];
        let tail = trimmed_start[name_len..].trim_start_matches(crate::jurisdictions::is_js_space);
        if !name.is_empty() && tail.starts_with("}}") {
            static_part.push_str(&rest[..start]);
            parts.push(std::mem::take(&mut static_part));
            parts.push(name.to_owned());
            rest = &tail[2..];
        } else {
            static_part.push_str(&rest[..=start]);
            rest = &rest[start + 1..];
        }
    }
    static_part.push_str(rest);
    parts.push(static_part);
    parts
}

/// `/^\s*[·•|,–—/]\s*$/`.
fn is_separator(text: &str) -> bool {
    let trimmed = crate::jurisdictions::js_trim(text);
    let mut chars = trimmed.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some('·' | '•' | '|' | ',' | '–' | '—' | '/'), None)
    )
}

/// `fillLine(line, data)`.
fn fill_line(line: &str, data: &DocumentData) -> Option<String> {
    let parts = split_placeholders(line);
    if parts.len() == 1 {
        return Some(line.to_owned());
    }
    let mut values: Vec<String> = parts
        .iter()
        .enumerate()
        .map(|(i, part)| {
            if i % 2 == 0 {
                part.clone()
            } else if TEMPLATE_FIELDS.contains(&part.as_str()) {
                field_value(data, part)
            } else {
                format!("{{{{{part}}}}}")
            }
        })
        .collect();
    let empty: Vec<bool> = values
        .iter()
        .enumerate()
        .map(|(i, v)| i % 2 == 1 && v.is_empty())
        .collect();
    if (0..values.len()).all(|i| i % 2 == 0 || empty[i]) {
        return None;
    }
    for i in 0..values.len() {
        if !empty[i] {
            continue;
        }
        if i > 1 && is_separator(&values[i - 1]) {
            values[i - 1] = String::new();
        } else if i + 1 < values.len() - 1 && is_separator(&values[i + 1]) {
            values[i + 1] = String::new();
        }
    }
    Some(values.concat())
}

/// `fillPlaceholders(text, data)`.
pub fn fill_placeholders(text: &str, data: &DocumentData) -> String {
    text.split('\n')
        .filter_map(|line| fill_line(line, data))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `safeImageSrc(value)`: http(s) and inline PNG/JPEG only.
pub fn safe_image_src(value: Option<&str>) -> Option<String> {
    let url = crate::jurisdictions::js_trim(value?);
    let lower = url.to_ascii_lowercase();
    let ok = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:image/png;base64,")
        || lower.starts_with("data:image/jpeg;base64,")
        || lower.starts_with("data:image/jpg;base64,");
    (!url.is_empty() && ok).then(|| url.to_owned())
}

// ── Colours ─────────────────────────────────────────────────────────────────

fn channels(hex: &str) -> [f64; 3] {
    let ok =
        hex.len() == 7 && hex.starts_with('#') && hex[1..].bytes().all(|b| b.is_ascii_hexdigit());
    if !ok {
        return [0.0; 3];
    }
    let c = |i: usize| f64::from(u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0));
    [c(1), c(3), c(5)]
}

fn to_hex(c: [f64; 3]) -> String {
    let part = |v: f64| {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let n = js::math_round(v.clamp(0.0, 255.0)) as u8;
        format!("{n:02x}")
    };
    format!("#{}{}{}", part(c[0]), part(c[1]), part(c[2]))
}

fn shade(hex: &str, amount: f64) -> String {
    let a = channels(hex);
    to_hex([
        a[0] + (0.0 - a[0]) * amount,
        a[1] + (0.0 - a[1]) * amount,
        a[2] + (0.0 - a[2]) * amount,
    ])
}

fn luminance(hex: &str) -> f64 {
    let c = channels(hex).map(|v| {
        let s = v / 255.0;
        if s <= 0.039_28 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    });
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

fn contrast(a: &str, b: &str) -> f64 {
    let (x, y) = (luminance(a), luminance(b));
    let (hi, lo) = if x >= y { (x, y) } else { (y, x) };
    (hi + 0.05) / (lo + 0.05)
}

/// `legible(accent, background)`: the accent shaded until it reads (4.5:1).
pub fn legible(accent: &str, background: &str) -> String {
    let mut colour = accent.to_owned();
    let mut step = 0;
    while step < 20 && contrast(&colour, background) < 4.5 {
        colour = shade(&colour, 0.12);
        step += 1;
    }
    colour
}

// ── Styles ──────────────────────────────────────────────────────────────────

/// The template's theme.
#[derive(Debug, Clone)]
pub struct Theme {
    pub font: super::fonts::Font,
    pub accent: String,
    pub text: String,
    pub muted: String,
    pub font_size: f64,
}

impl Theme {
    pub fn of(template: &Value) -> Self {
        let theme = &template["theme"];
        Self {
            font: super::fonts::Font::parse(theme["font"].as_str().unwrap_or("helvetica")),
            accent: theme["accent"].as_str().unwrap_or("#000000").to_owned(),
            text: theme["text"].as_str().unwrap_or("#000000").to_owned(),
            muted: theme["muted"].as_str().unwrap_or("#000000").to_owned(),
            font_size: theme["fontSize"].as_f64().unwrap_or(9.0),
        }
    }

    pub(crate) fn face(&self, bold: bool, italic: bool) -> FontFace {
        FontFace {
            font: self.font,
            bold,
            italic,
        }
    }
}

struct Ctx<'a> {
    theme: Theme,
    data: &'a DocumentData,
}

fn token(value: Option<&str>, ctx: &Ctx<'_>, fallback: &str) -> String {
    match value.unwrap_or(fallback) {
        "accent" => ctx.theme.accent.clone(),
        "text" => ctx.theme.text.clone(),
        "muted" => ctx.theme.muted.clone(),
        other => other.to_owned(),
    }
}

#[derive(Debug, Clone)]
struct Resolved {
    size: f64,
    face: FontFace,
    color: String,
    align: String,
    line_height: f64,
    uppercase: bool,
}

#[derive(Default)]
struct Defaults<'a> {
    size: Option<f64>,
    bold: Option<bool>,
    align: Option<&'a str>,
    color: Option<&'a str>,
}

fn num(style: Option<&Value>, key: &str) -> Option<f64> {
    style.and_then(|s| s.get(key)).and_then(Value::as_f64)
}

fn flag(style: Option<&Value>, key: &str) -> Option<bool> {
    style.and_then(|s| s.get(key)).and_then(Value::as_bool)
}

fn string<'v>(style: Option<&'v Value>, key: &str) -> Option<&'v str> {
    style.and_then(|s| s.get(key)).and_then(Value::as_str)
}

/// `textStyle(style, ctx, defaults)`.
fn text_style(style: Option<&Value>, ctx: &Ctx<'_>, defaults: &Defaults<'_>) -> Resolved {
    Resolved {
        size: num(style, "fontSize")
            .or(defaults.size)
            .unwrap_or(ctx.theme.font_size),
        face: ctx.theme.face(
            flag(style, "bold").or(defaults.bold).unwrap_or(false),
            flag(style, "italic").unwrap_or(false),
        ),
        color: token(
            string(style, "color"),
            ctx,
            defaults.color.unwrap_or("text"),
        ),
        align: string(style, "align")
            .or(defaults.align)
            .unwrap_or("left")
            .to_owned(),
        line_height: num(style, "lineHeight").unwrap_or(1.3),
        uppercase: flag(style, "uppercase").unwrap_or(false),
    }
}

/// `labelStyle(label, ctx, align)`.
fn label_style(label: Option<&Value>, ctx: &Ctx<'_>, align: &str) -> Resolved {
    Resolved {
        size: num(label, "fontSize").unwrap_or_else(|| (ctx.theme.font_size - 1.5).max(6.0)),
        face: ctx.theme.face(flag(label, "bold").unwrap_or(true), false),
        color: token(string(label, "color"), ctx, "muted"),
        align: align.to_owned(),
        line_height: 1.3,
        uppercase: flag(label, "uppercase").unwrap_or(true),
    }
}

// ── Text runs ───────────────────────────────────────────────────────────────

fn baseline_offset(style: &Resolved) -> f64 {
    let ascent = ascent_ratio(style.face);
    let glyph = (ascent + 0.21) * style.size;
    (style.line_height * style.size - glyph) / 2.0 + ascent * style.size
}

/// `setLines(lines, style, x, y, width)`: the primitives and the height.
fn set_lines(
    lines: &[String],
    style: &Resolved,
    x: f64,
    y: f64,
    width: f64,
) -> (Vec<Primitive>, f64) {
    let line_box = style.size * style.line_height;
    let base = baseline_offset(style);
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if line.is_empty() {
            continue;
        }
        let w = text_width(line, style.size, style.face);
        let lx = match style.align.as_str() {
            "right" => x + width - w,
            "center" => x + (width - w) / 2.0,
            _ => x,
        };
        #[allow(clippy::cast_precision_loss)]
        out.push(Primitive::Text {
            x: lx,
            y: y + i as f64 * line_box + base,
            text: line.clone(),
            size: style.size,
            face: style.face,
            color: style.color.clone(),
        });
    }
    #[allow(clippy::cast_precision_loss)]
    (out, lines.len() as f64 * line_box)
}

fn upper(text: &str, uppercase: bool) -> String {
    if uppercase {
        text.to_uppercase()
    } else {
        text.to_owned()
    }
}

/// `setText(text, style, x, y, width)`.
fn set_text(text: &str, style: &Resolved, x: f64, y: f64, width: f64) -> Vec<Primitive> {
    let value = upper(text, style.uppercase);
    set_lines(
        &wrap_text(&value, style.size, style.face, width.max(1.0)),
        style,
        x,
        y,
        width,
    )
    .0
}

// ── Blocks ──────────────────────────────────────────────────────────────────

type Paint<'a> = Box<dyn Fn(f64, f64, f64) -> Vec<Primitive> + 'a>;

/// A block measured at its width.
struct Measured<'a> {
    height: f64,
    empty: bool,
    fixed: bool,
    paint: Paint<'a>,
}

fn nothing<'a>() -> Measured<'a> {
    Measured {
        height: 0.0,
        empty: true,
        fixed: false,
        paint: Box::new(|_, _, _| Vec::new()),
    }
}

struct Piece {
    text: Vec<String>,
    style: Resolved,
    gap_before: f64,
}

/// `stack(pieces, width)`.
fn stack<'a>(pieces: Vec<Option<Piece>>, width: f64) -> Measured<'a> {
    let present: Vec<Piece> = pieces
        .into_iter()
        .flatten()
        .filter(|p| p.text.iter().any(|t| !t.is_empty()))
        .collect();
    if present.is_empty() {
        return nothing();
    }
    let wrapped: Vec<(Vec<String>, Resolved, f64)> = present
        .into_iter()
        .map(|p| {
            let lines = p
                .text
                .iter()
                .flat_map(|t| {
                    wrap_text(
                        &upper(t, p.style.uppercase),
                        p.style.size,
                        p.style.face,
                        width.max(1.0),
                    )
                })
                .collect();
            (lines, p.style, p.gap_before)
        })
        .collect();
    #[allow(clippy::cast_precision_loss)]
    let height = wrapped
        .iter()
        .enumerate()
        .fold(0.0, |h, (i, (lines, style, gap))| {
            h + if i > 0 { *gap } else { 0.0 } + lines.len() as f64 * style.size * style.line_height
        });
    Measured {
        height,
        empty: false,
        fixed: false,
        paint: Box::new(move |x, y, _| {
            let mut out = Vec::new();
            let mut cy = y;
            for (i, (lines, style, gap)) in wrapped.iter().enumerate() {
                if i > 0 {
                    cy += gap;
                }
                let (set, h) = set_lines(lines, style, x, cy, width);
                out.extend(set);
                cy += h;
            }
            out
        }),
    }
}

#[allow(
    clippy::unnecessary_wraps,
    reason = "the pieces of a stack are optional, as in TypeScript"
)]
fn piece(text: Vec<String>, style: Resolved, gap_before: f64) -> Option<Piece> {
    Some(Piece {
        text,
        style,
        gap_before,
    })
}

/// `labelPiece(label, fallback, ctx, align)`.
fn label_piece(label: Option<&Value>, fallback: &str, ctx: &Ctx<'_>, align: &str) -> Option<Piece> {
    if flag(label, "show") == Some(false) {
        return None;
    }
    let text = string(label, "text").unwrap_or(fallback).to_owned();
    piece(vec![text], label_style(label, ctx, align), 0.0)
}

fn opt<'v>(block: &'v Value, key: &str) -> Option<&'v Value> {
    block.get(key).filter(|v| !v.is_null())
}

fn measure_party<'a>(
    block: &Value,
    party: Option<&PartyData>,
    default_label: &str,
    ctx: &Ctx<'_>,
    width: f64,
) -> Measured<'a> {
    let Some(party) = party.filter(|p| !p.name.is_empty() || !p.lines.is_empty()) else {
        return nothing();
    };
    let kind = block["type"].as_str().unwrap_or_default();
    let body = text_style(opt(block, "style"), ctx, &Defaults::default());
    let mut name_style = body.clone();
    name_style.face.bold = flag(Some(block), "boldName").unwrap_or(true);
    let show_contact = match kind {
        "seller" => flag(Some(block), "showContact") != Some(false),
        "billTo" => flag(Some(block), "showEmail") != Some(false),
        _ => false,
    };
    let show_tax_ids = kind != "seller" || flag(Some(block), "showTaxIds") != Some(false);
    let label = label_piece(opt(block, "label"), default_label, ctx, &body.align);
    if flag(Some(block), "inline") == Some(true) {
        let mut inline_parts = vec![party.name.clone()];
        inline_parts.extend(party.lines.iter().cloned());
        if show_contact {
            inline_parts.extend(party.contact_lines.iter().cloned());
        }
        if show_tax_ids {
            inline_parts.extend(party.tax_id_lines.iter().cloned());
        }
        let joined = inline_parts
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        return stack(vec![label, piece(vec![joined], body, 3.0)], width);
    }
    stack(
        vec![
            label,
            piece(vec![party.name.clone()], name_style, 3.0),
            piece(party.lines.clone(), body.clone(), 0.0),
            show_contact.then(|| Piece {
                text: party.contact_lines.clone(),
                style: body.clone(),
                gap_before: 0.0,
            }),
            show_tax_ids.then(|| Piece {
                text: party.tax_id_lines.clone(),
                style: body,
                gap_before: 0.0,
            }),
        ],
        width,
    )
}

fn measure_field<'a>(block: &Value, ctx: &Ctx<'_>, width: f64) -> Measured<'a> {
    let field = block["field"].as_str().unwrap_or_default();
    let value = field_value(ctx.data, field);
    if value.is_empty() {
        return nothing();
    }
    let style = text_style(opt(block, "style"), ctx, &Defaults::default());
    let layout = block["layout"].as_str().unwrap_or("stacked");
    let label = opt(block, "label");
    let label_text = string(label, "text")
        .map(str::to_owned)
        .or_else(|| ctx.data.field_label(field).map(str::to_owned))
        .unwrap_or_default();
    if layout == "value" || flag(label, "show") == Some(false) || label_text.is_empty() {
        return stack(vec![piece(vec![value], style, 0.0)], width);
    }
    if layout == "stacked" {
        let align = style.align.clone();
        return stack(
            vec![
                label_piece(label, &label_text, ctx, &align),
                piece(vec![value], style, 2.0),
            ],
            width,
        );
    }
    // inline: label left, value right on one line.
    let mut l_style = label_style(label, ctx, "left");
    l_style.uppercase = flag(label, "uppercase").unwrap_or(false);
    l_style.size = num(label, "fontSize").unwrap_or(style.size);
    let label_value = upper(&label_text, l_style.uppercase);
    let label_w = (width * 0.6)
        .min(text_width(&normalize_text(&label_value), l_style.size, l_style.face) + 8.0);
    let mut v_style = style;
    v_style.align = "right".into();
    let value_lines = wrap_text(
        &value,
        v_style.size,
        v_style.face,
        (width - label_w).max(1.0),
    );
    #[allow(clippy::cast_precision_loss)]
    let height = (l_style.size * l_style.line_height)
        .max(value_lines.len() as f64 * v_style.size * v_style.line_height);
    Measured {
        height,
        empty: false,
        fixed: false,
        paint: Box::new(move |x, y, _| {
            let mut label_line = l_style.clone();
            label_line.line_height = v_style.line_height * (v_style.size / l_style.size);
            let mut out = set_lines(&[normalize_text(&label_value)], &label_line, x, y, label_w).0;
            out.extend(set_lines(&value_lines, &v_style, x + label_w, y, width - label_w).0);
            out
        }),
    }
}

/// `totalsRowStyle(row, base, block, ctx, totalSize)`: (label, value).
fn totals_row_style(
    row: &TotalsRow,
    base: &Resolved,
    block: &Value,
    ctx: &Ctx<'_>,
    total_size: f64,
) -> (Resolved, Resolved) {
    let total = opt(block, "total");
    match row.kind {
        Some("heading") => {
            let mut s = base.clone();
            s.size = base.size - 1.5;
            s.face.bold = true;
            s.color = ctx.theme.muted.clone();
            s.uppercase = true;
            (s.clone(), s)
        }
        Some("muted") => {
            let mut s = base.clone();
            s.size = base.size - 1.0;
            s.color = ctx.theme.muted.clone();
            (s.clone(), s)
        }
        Some("total") => {
            let mut s = base.clone();
            s.size = total_size;
            s.face.bold = true;
            s.color = token(string(total, "color"), ctx, "text");
            (s.clone(), s)
        }
        Some("balance") => {
            let background = match string(opt(block, "box"), "background") {
                Some(bg) => token(Some(bg), ctx, "accent"),
                None => "#ffffff".to_owned(),
            };
            let mut s = base.clone();
            s.face.bold = true;
            s.color = legible(&ctx.theme.accent, &background);
            (s.clone(), s)
        }
        _ => {
            let mut label = base.clone();
            label.color = ctx.theme.muted.clone();
            (label, base.clone())
        }
    }
}

fn measure_totals<'a>(block: &'a Value, ctx: &Ctx<'a>, width: f64) -> Measured<'a> {
    let rows: Vec<&TotalsRow> = ctx
        .data
        .totals
        .iter()
        .filter(|r| flag(Some(block), "showBalance") != Some(false) || r.kind != Some("balance"))
        .collect();
    if rows.is_empty() {
        return nothing();
    }
    let base = text_style(opt(block, "style"), ctx, &Defaults::default());
    let total = opt(block, "total");
    let total_size = num(total, "fontSize").unwrap_or(base.size + 2.0);
    let row_gap = 3.0;
    let total_pad = 5.0;
    let layout_rows: Vec<(TotalsRow, Resolved, Resolved, Vec<String>, f64)> = rows
        .iter()
        .map(|row| {
            let (label, value) = totals_row_style(row, &base, block, ctx, total_size);
            let label_lines = wrap_text(
                &upper(&row.label, label.uppercase),
                label.size,
                label.face,
                width * 0.62,
            );
            #[allow(clippy::cast_precision_loss)]
            let row_h = label_lines.len().max(1) as f64 * label.size * label.line_height;
            let extra = if row.kind == Some("total") {
                total_pad * 2.0
            } else {
                0.0
            };
            ((*row).clone(), label, value, label_lines, row_h + extra)
        })
        .collect();
    let height = layout_rows.iter().fold(-row_gap, |h, r| h + r.4 + row_gap);
    let background = string(total, "background").map(|b| token(Some(b), ctx, "accent"));
    let rule = token(string(total, "rule"), ctx, "accent");
    Measured {
        height,
        empty: false,
        fixed: false,
        paint: Box::new(move |x, y, _| {
            let mut out = Vec::new();
            let mut cy = y;
            for (row, label, value, lines, h) in &layout_rows {
                let is_total = row.kind == Some("total");
                if is_total {
                    if let Some(fill) = &background {
                        out.push(Primitive::Rect {
                            x,
                            y: cy,
                            w: width,
                            h: *h,
                            fill: Some(fill.clone()),
                            stroke: None,
                            stroke_width: None,
                            radius: None,
                        });
                    }
                    out.push(Primitive::Line {
                        x1: x,
                        y1: cy,
                        x2: x + width,
                        y2: cy,
                        color: rule.clone(),
                        width: 1.0,
                    });
                }
                let inset = if is_total { total_pad } else { 0.0 };
                let pad = if is_total && background.is_some() {
                    6.0
                } else {
                    0.0
                };
                let mut l = label.clone();
                l.align = "left".into();
                out.extend(set_lines(lines, &l, x + pad, cy + inset, width * 0.62).0);
                if !row.value.is_empty() {
                    let mut v = value.clone();
                    v.align = "right".into();
                    out.extend(
                        set_lines(
                            &[normalize_text(&row.value)],
                            &v,
                            x,
                            cy + inset,
                            width - pad,
                        )
                        .0,
                    );
                }
                cy += h + row_gap;
            }
            out
        }),
    }
}

fn measure_payment<'a>(block: &Value, ctx: &Ctx<'_>, width: f64) -> Measured<'a> {
    let lines = if flag(Some(block), "showBank") == Some(false) {
        Vec::new()
    } else {
        ctx.data.bank_lines.clone()
    };
    let notes = if flag(Some(block), "showInstructions") == Some(false) {
        String::new()
    } else {
        ctx.data.instructions.clone().unwrap_or_default()
    };
    if lines.is_empty() && notes.is_empty() {
        return nothing();
    }
    let body = text_style(opt(block, "style"), ctx, &Defaults::default());
    let align = body.align.clone();
    stack(
        vec![
            label_piece(opt(block, "label"), &ctx.data.labels.payment, ctx, &align),
            piece(lines, body.clone(), 3.0),
            piece(vec![notes], body, 4.0),
        ],
        width,
    )
}

fn measure_labeled_text<'a>(
    block: &Value,
    text: Option<&str>,
    default_label: &str,
    ctx: &Ctx<'_>,
    width: f64,
) -> Measured<'a> {
    let Some(text) = text.filter(|t| !crate::jurisdictions::js_trim(t).is_empty()) else {
        return nothing();
    };
    let body = text_style(opt(block, "style"), ctx, &Defaults::default());
    let align = body.align.clone();
    stack(
        vec![
            label_piece(opt(block, "label"), default_label, ctx, &align),
            piece(vec![text.to_owned()], body, 3.0),
        ],
        width,
    )
}

const QR_SIZE: f64 = 84.0;

fn measure_legal<'a>(block: Option<&Value>, ctx: &Ctx<'_>, width: f64) -> Measured<'a> {
    let legal = &ctx.data.legal;
    let body = text_style(
        block.and_then(|b| opt(b, "style")),
        ctx,
        &Defaults {
            size: Some(ctx.theme.font_size - 0.5),
            ..Defaults::default()
        },
    );
    let mut strong = body.clone();
    strong.face.bold = true;
    let mut muted = body.clone();
    muted.size = body.size - 0.5;
    muted.color = ctx.theme.muted.clone();
    let text = stack(
        vec![
            legal
                .fiscal_document
                .as_ref()
                .filter(|f| !f.is_empty())
                .and_then(|f| piece(f.clone(), body.clone(), 0.0)),
            piece(legal.notices.clone(), strong.clone(), 6.0),
            legal
                .required_footer
                .as_ref()
                .filter(|f| !f.is_empty())
                .and_then(|f| piece(vec![f.clone()], muted.clone(), 6.0)),
        ],
        width,
    );
    let Some(pix) = legal.pix.clone() else {
        return text;
    };
    let pix_text_x = QR_SIZE + 12.0;
    let mut title = strong;
    title.size = body.size + 2.0;
    let mut payload = muted;
    payload.size = 6.5;
    let pix_text = stack(
        vec![
            piece(vec![pix.title.clone()], title, 0.0),
            piece(vec![pix.key.clone()], body, 3.0),
            piece(vec![pix.payload.clone()], payload, 3.0),
        ],
        width - pix_text_x,
    );
    let pix_height = QR_SIZE.max(pix_text.height);
    let gap = if text.empty { 0.0 } else { 10.0 };
    let text_height = text.height;
    Measured {
        height: text_height + gap + pix_height,
        empty: false,
        fixed: false,
        paint: Box::new(move |x, y, _| {
            let mut out = (text.paint)(x, y, text_height);
            out.push(Primitive::Qr {
                x,
                y: y + text_height + gap,
                size: QR_SIZE,
                matrix: pix.matrix.clone(),
            });
            out.extend((pix_text.paint)(
                x + pix_text_x,
                y + text_height + gap,
                pix_text.height,
            ));
            out
        }),
    }
}

fn has_legal_content(data: &DocumentData) -> bool {
    let legal = &data.legal;
    !legal.notices.is_empty()
        || legal
            .fiscal_document
            .as_ref()
            .is_some_and(|f| !f.is_empty())
        || legal.pix.is_some()
        || legal
            .required_footer
            .as_ref()
            .is_some_and(|f| !f.is_empty())
}

fn image<'a>(src: String, align: String, width: f64) -> Measured<'a> {
    Measured {
        height: 0.0,
        empty: false,
        fixed: true,
        paint: Box::new(move |x, y, h| {
            vec![Primitive::Image {
                x,
                y,
                w: width,
                h,
                src: src.clone(),
                align: align.clone(),
            }]
        }),
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "one arm per block type, as measureBlock"
)]
fn measure_block<'a>(
    block: &'a Value,
    ctx: &Ctx<'a>,
    width: f64,
    page: Rc<Cell<(usize, usize)>>,
) -> Measured<'a> {
    let data = ctx.data;
    match block["type"].as_str().unwrap_or_default() {
        "text" => {
            let text = fill_placeholders(block["text"].as_str().unwrap_or_default(), data);
            stack(
                vec![piece(
                    vec![text],
                    text_style(opt(block, "style"), ctx, &Defaults::default()),
                    0.0,
                )],
                width,
            )
        }
        "field" => measure_field(block, ctx, width),
        "logo" => {
            let align = block["align"].as_str().unwrap_or("left").to_owned();
            if let Some(src) = safe_image_src(data.logo_url.as_deref()) {
                return image(src, align, width);
            }
            let style = text_style(
                opt(block, "fallbackStyle"),
                ctx,
                &Defaults {
                    size: Some(16.0),
                    bold: Some(true),
                    align: block["align"].as_str(),
                    color: None,
                },
            );
            stack(
                vec![piece(vec![data.seller.name.clone()], style, 0.0)],
                width,
            )
        }
        "image" => match safe_image_src(block["src"].as_str()) {
            Some(src) => image(
                src,
                block["align"].as_str().unwrap_or("left").to_owned(),
                width,
            ),
            None => nothing(),
        },
        "seller" => measure_party(block, Some(&data.seller), &data.labels.from, ctx, width),
        "billTo" => measure_party(block, Some(&data.bill_to), &data.labels.bill_to, ctx, width),
        "shipTo" => measure_party(
            block,
            data.ship_to.as_ref(),
            &data.labels.ship_to,
            ctx,
            width,
        ),
        "totals" => measure_totals(block, ctx, width),
        "payment" => measure_payment(block, ctx, width),
        "notes" => {
            measure_labeled_text(block, data.notes.as_deref(), &data.labels.notes, ctx, width)
        }
        "terms" => {
            let text = block["text"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| data.terms.clone());
            measure_labeled_text(block, text.as_deref(), &data.labels.terms, ctx, width)
        }
        "legal" => measure_legal(Some(block), ctx, width),
        "rect" => Measured {
            height: 0.0,
            empty: false,
            fixed: true,
            paint: Box::new(|_, _, _| Vec::new()),
        },
        "line" => {
            let color = token(block["color"].as_str(), ctx, "muted");
            let thickness = block["thickness"].as_f64().unwrap_or(1.0);
            let vertical = block["orientation"] == "vertical";
            Measured {
                height: 0.0,
                empty: false,
                fixed: true,
                paint: Box::new(move |x, y, h| {
                    vec![if vertical {
                        Primitive::Line {
                            x1: x + width / 2.0,
                            y1: y,
                            x2: x + width / 2.0,
                            y2: y + h,
                            color: color.clone(),
                            width: thickness,
                        }
                    } else {
                        Primitive::Line {
                            x1: x,
                            y1: y + h / 2.0,
                            x2: x + width,
                            y2: y + h / 2.0,
                            color: color.clone(),
                            width: thickness,
                        }
                    }]
                }),
            }
        }
        "pageNumber" => {
            let style = text_style(
                opt(block, "style"),
                ctx,
                &Defaults {
                    size: Some(ctx.theme.font_size - 1.0),
                    color: Some("muted"),
                    ..Defaults::default()
                },
            );
            let template = data.labels.page.clone();
            Measured {
                height: style.size * style.line_height,
                empty: false,
                fixed: false,
                paint: Box::new(move |x, y, _| {
                    let (p, total) = page.get();
                    let text = template.replacen("{page}", &p.to_string(), 1).replacen(
                        "{total}",
                        &total.to_string(),
                        1,
                    );
                    set_text(&text, &style, x, y, width)
                }),
            }
        }
        _ => nothing(),
    }
}

fn box_primitives(block: &Value, x: f64, y: f64, w: f64, h: f64, ctx: &Ctx<'_>) -> Vec<Primitive> {
    let Some(bx) = opt(block, "box") else {
        return Vec::new();
    };
    let background = string(Some(bx), "background");
    let border_width = num(Some(bx), "borderWidth").filter(|w| *w != 0.0);
    let border_color = string(Some(bx), "borderColor");
    let has_border = border_width.is_some() && border_color.is_some();
    if background.is_none() && !has_border {
        return Vec::new();
    }
    vec![Primitive::Rect {
        x,
        y,
        w,
        h,
        fill: background.map(|b| token(Some(b), ctx, "accent")),
        stroke: has_border.then(|| token(border_color, ctx, "muted")),
        stroke_width: num(Some(bx), "borderWidth"),
        radius: num(Some(bx), "radius"),
    }]
}

// ── Line-items table ────────────────────────────────────────────────────────

fn default_column_width(key: &str) -> f64 {
    match key {
        "index" => 4.0,
        "description" => 40.0,
        "hsnSac" | "unit" | "quantity" => match key {
            "hsnSac" => 10.0,
            _ => 8.0,
        },
        "unitPrice" => 13.0,
        "discount" | "taxRate" => 9.0,
        "taxAmount" => 12.0,
        _ => 14.0,
    }
}

const NUMERIC_COLUMNS: [&str; 7] = [
    "quantity",
    "unitPrice",
    "discount",
    "taxRate",
    "taxAmount",
    "amount",
    "amountWithTax",
];

/// `TableColumn`.
#[derive(Debug, Clone)]
pub struct TableColumn {
    pub key: String,
    pub label: String,
    pub align: String,
    pub x: f64,
    pub width: f64,
}

/// `tableColumns(block, data)`: the template's columns the invoice has,
/// plus those its jurisdiction requires.
pub fn table_columns(block: &Value, data: &DocumentData) -> Vec<TableColumn> {
    let mut chosen: Vec<(String, f64, Option<String>, Option<String>)> = block["columns"]
        .as_array()
        .map(|cols| {
            cols.iter()
                .filter(|c| data.column(c["key"].as_str().unwrap_or_default()).is_some())
                .map(|c| {
                    (
                        c["key"].as_str().unwrap_or_default().to_owned(),
                        c["width"].as_f64().unwrap_or(0.0),
                        c["label"].as_str().map(str::to_owned),
                        c["align"].as_str().map(str::to_owned),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    for (key, col) in &data.columns {
        if col.required && !chosen.iter().any(|c| c.0 == *key) {
            chosen.push(((*key).to_owned(), default_column_width(key), None, None));
        }
    }
    let weights: Vec<f64> = chosen
        .iter()
        .map(|c| {
            if c.1 > 0.0 {
                c.1
            } else {
                default_column_width(&c.0)
            }
        })
        .collect();
    let sum: f64 = weights.iter().sum();
    let sum = if sum == 0.0 { 1.0 } else { sum };
    let block_w = block["w"].as_f64().unwrap_or(0.0);
    let mut x = 0.0;
    chosen
        .into_iter()
        .zip(weights)
        .map(|((key, _, label, align), weight)| {
            let width = block_w * weight / sum;
            let available = data.column(&key);
            let col = TableColumn {
                label: label
                    .or_else(|| available.map(|a| a.label.clone()))
                    .unwrap_or_else(|| key.clone()),
                align: align
                    .or_else(|| available.and_then(|a| a.align).map(str::to_owned))
                    .unwrap_or_else(|| {
                        if NUMERIC_COLUMNS.contains(&key.as_str()) {
                            "right"
                        } else {
                            "left"
                        }
                        .to_owned()
                    }),
                key,
                x,
                width,
            };
            x += width;
            col
        })
        .collect()
}

struct RowLayout<'a> {
    height: f64,
    paint: Box<dyn Fn(f64, f64, usize) -> Vec<Primitive> + 'a>,
}

#[allow(
    clippy::too_many_lines,
    reason = "the header and the rows, as tableParts"
)]
fn table_parts<'a>(block: &'a Value, ctx: &Ctx<'a>) -> (RowLayout<'a>, Vec<RowLayout<'a>>) {
    let columns = table_columns(block, ctx.data);
    let size = block["fontSize"].as_f64().unwrap_or(ctx.theme.font_size);
    let pad = block["rowPadding"].as_f64().unwrap_or(5.0);
    let cell_pad = 4.0;
    let block_w = block["w"].as_f64().unwrap_or(0.0);
    let body = Resolved {
        size,
        face: ctx.theme.face(false, false),
        color: ctx.theme.text.clone(),
        align: "left".into(),
        line_height: 1.3,
        uppercase: false,
    };
    let mut sub = body.clone();
    sub.size = size - 1.0;
    sub.color = ctx.theme.muted.clone();
    let header = opt(block, "header");
    let header_background = string(header, "background").map(str::to_owned);
    let header_style = Resolved {
        size: num(header, "fontSize").unwrap_or(size - 1.0),
        face: ctx.theme.face(flag(header, "bold").unwrap_or(true), false),
        color: token(
            string(header, "color"),
            ctx,
            if header_background.is_some() {
                "text"
            } else {
                "muted"
            },
        ),
        align: body.align.clone(),
        line_height: 1.3,
        uppercase: flag(header, "uppercase").unwrap_or(true),
    };
    let header_lines: Vec<Vec<String>> = columns
        .iter()
        .map(|c| {
            wrap_text(
                &upper(&c.label, header_style.uppercase),
                header_style.size,
                header_style.face,
                (c.width - 2.0 * cell_pad).max(1.0),
            )
        })
        .collect();
    #[allow(clippy::cast_precision_loss)]
    let header_height = header_lines.iter().map(Vec::len).max().unwrap_or(0).max(1) as f64
        * header_style.size
        * header_style.line_height
        + 2.0 * pad;
    let rule = string(header, "rule")
        .map(str::to_owned)
        .or_else(|| header_background.is_none().then(|| "accent".to_owned()));
    let fill = header_background
        .as_ref()
        .map(|b| token(Some(b), ctx, "accent"));
    let rule_color = rule.map(|r| token(Some(&r), ctx, "accent"));
    let header_columns = columns.clone();
    let header_row = RowLayout {
        height: header_height,
        paint: Box::new(move |x, y, _| {
            let mut out = Vec::new();
            if let Some(fill) = &fill {
                out.push(Primitive::Rect {
                    x,
                    y,
                    w: block_w,
                    h: header_height,
                    fill: Some(fill.clone()),
                    stroke: None,
                    stroke_width: None,
                    radius: None,
                });
            }
            for (i, c) in header_columns.iter().enumerate() {
                let mut style = header_style.clone();
                style.align = c.align.clone();
                out.extend(
                    set_lines(
                        &header_lines[i],
                        &style,
                        x + c.x + cell_pad,
                        y + pad,
                        c.width - 2.0 * cell_pad,
                    )
                    .0,
                );
            }
            if let Some(color) = &rule_color {
                out.push(Primitive::Line {
                    x1: x,
                    y1: y + header_height,
                    x2: x + block_w,
                    y2: y + header_height,
                    color: color.clone(),
                    width: 1.0,
                });
            }
            out
        }),
    };

    let zebra = string(Some(block), "zebra").map(|z| token(Some(z), ctx, "muted"));
    let row_rule = token(
        Some(string(Some(block), "rowRule").unwrap_or("#e2e4e8")),
        ctx,
        "muted",
    );
    let rows = ctx
        .data
        .rows
        .iter()
        .map(|row| {
            let cells: Vec<(Vec<String>, Vec<String>, f64)> = columns
                .iter()
                .map(|c| {
                    let lines: Vec<String> = row
                        .cell(&c.key)
                        .unwrap_or_default()
                        .split('\n')
                        .flat_map(|part| {
                            wrap_text(part, size, body.face, (c.width - 2.0 * cell_pad).max(1.0))
                        })
                        .collect();
                    let sub_lines: Vec<String> =
                        if c.key == "description" && !row.sub_lines.is_empty() {
                            row.sub_lines
                                .iter()
                                .flat_map(|s| {
                                    wrap_text(
                                        s,
                                        sub.size,
                                        sub.face,
                                        (c.width - 2.0 * cell_pad).max(1.0),
                                    )
                                })
                                .collect()
                        } else {
                            Vec::new()
                        };
                    #[allow(clippy::cast_precision_loss)]
                    let height = lines.len() as f64 * size * body.line_height
                        + sub_lines.len() as f64 * sub.size * sub.line_height;
                    (lines, sub_lines, height)
                })
                .collect();
            let height = cells
                .iter()
                .map(|c| c.2)
                .fold(size * body.line_height, f64::max)
                + 2.0 * pad;
            let columns = columns.clone();
            let body = body.clone();
            let sub = sub.clone();
            let zebra = zebra.clone();
            let row_rule = row_rule.clone();
            RowLayout {
                height,
                paint: Box::new(move |x, y, index| {
                    let mut out = Vec::new();
                    if let Some(fill) = zebra.as_ref().filter(|_| index % 2 == 1) {
                        out.push(Primitive::Rect {
                            x,
                            y,
                            w: block_w,
                            h: height,
                            fill: Some(fill.clone()),
                            stroke: None,
                            stroke_width: None,
                            radius: None,
                        });
                    }
                    for (i, c) in columns.iter().enumerate() {
                        let (lines, sub_lines, _) = &cells[i];
                        let mut style = body.clone();
                        style.align = c.align.clone();
                        let (set, set_height) = set_lines(
                            lines,
                            &style,
                            x + c.x + cell_pad,
                            y + pad,
                            c.width - 2.0 * cell_pad,
                        );
                        out.extend(set);
                        if !sub_lines.is_empty() {
                            let mut sub_style = sub.clone();
                            sub_style.align = c.align.clone();
                            out.extend(
                                set_lines(
                                    sub_lines,
                                    &sub_style,
                                    x + c.x + cell_pad,
                                    y + pad + set_height,
                                    c.width - 2.0 * cell_pad,
                                )
                                .0,
                            );
                        }
                    }
                    out.push(Primitive::Line {
                        x1: x,
                        y1: y + height,
                        x2: x + block_w,
                        y2: y + height,
                        color: row_rule.clone(),
                        width: 0.5,
                    });
                    out
                }),
            }
        })
        .collect();
    (header_row, rows)
}

// ── Page assembly ───────────────────────────────────────────────────────────

fn geometry(block: &Value) -> (f64, f64, f64, f64) {
    (
        block["x"].as_f64().unwrap_or(0.0),
        block["y"].as_f64().unwrap_or(0.0),
        block["w"].as_f64().unwrap_or(0.0),
        block["h"].as_f64().unwrap_or(0.0),
    )
}

fn overlaps_horizontally(a: (f64, f64), b: (f64, f64)) -> bool {
    a.0 < b.0 + b.1 - 0.5 && b.0 < a.0 + a.1 - 0.5
}

struct FlowItem<'a> {
    block: &'a Value,
    measured: Measured<'a>,
    x: f64,
    w: f64,
    top: f64,
    min_h: f64,
    h: f64,
}

/// `pushDown(items)`: blocks move down by the growth of the blocks above.
fn push_down(items: &mut [FlowItem<'_>]) {
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|&a, &b| {
        (items[a].top - items[b].top)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                (items[a].x - items[b].x)
                    .partial_cmp(&0.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let designed: Vec<(f64, f64)> = order
        .iter()
        .map(|&i| (items[i].top, items[i].top + items[i].min_h))
        .collect();
    for k in 0..order.len() {
        let mut shift: f64 = 0.0;
        for j in 0..k {
            let above = &items[order[j]];
            let item = &items[order[k]];
            if designed[j].1 <= designed[k].0 + 0.5
                && overlaps_horizontally((above.x, above.w), (item.x, item.w))
            {
                shift = shift.max(above.top + above.h - designed[j].1);
            }
        }
        items[order[k]].top += shift;
    }
}

struct Band {
    top: f64,
    bottom: f64,
}

fn paper(template: &Value) -> (f64, f64) {
    if template["paperSize"] == "letter" {
        (612.0, 792.0)
    } else {
        (595.28, 841.89)
    }
}

/// `bodyBand(template, repeating, table)`.
fn body_band(template: &Value, repeating: &[&Value], table: &Value) -> Band {
    let (_, height) = paper(template);
    let (tx, _, tw, _) = geometry(table);
    let bands: Vec<(f64, f64, f64, f64)> = repeating
        .iter()
        .map(|b| geometry(b))
        .filter(|&(x, y, w, h)| {
            overlaps_horizontally((x, w), (tx, tw)) && (y >= height / 2.0 || y + h <= height / 2.0)
        })
        .collect();
    let in_top_half = |&(_, y, _, h): &(f64, f64, f64, f64)| y + h / 2.0 < height / 2.0;
    let margins = &template["margins"];
    let top = bands
        .iter()
        .filter(|b| in_top_half(b))
        .map(|&(_, y, _, h)| y + h + 8.0)
        .fold(margins["top"].as_f64().unwrap_or(0.0), f64::max);
    let bottom = bands
        .iter()
        .filter(|b| !in_top_half(b))
        .map(|&(_, y, _, _)| y - 8.0)
        .fold(height - margins["bottom"].as_f64().unwrap_or(0.0), f64::min);
    Band { top, bottom }
}

/// `implicitBlocks(flowing, table, data)`.
fn implicit_blocks(flowing: &[&Value], table: &Value, data: &DocumentData) -> Vec<Value> {
    let mut extra: Vec<Value> = Vec::new();
    let (tx, ty, tw, th) = geometry(table);
    let table_bottom = ty + th;
    let last_bottom = |extra: &[Value]| {
        flowing
            .iter()
            .copied()
            .chain(extra.iter())
            .map(geometry)
            .filter(|&(_, y, _, _)| y >= table_bottom)
            .map(|(_, y, _, h)| y + h)
            .fold(table_bottom, f64::max)
    };
    if !flowing.iter().any(|b| b["type"] == "totals") {
        let w = tw.min(220.0);
        let y = last_bottom(&extra) + 14.0;
        extra.push(serde_json::json!({ "id": "__totals", "type": "totals", "x": tx + tw - w, "y": y, "w": w, "h": 20 }));
    }
    if !flowing.iter().any(|b| b["type"] == "legal") && has_legal_content(data) {
        let y = last_bottom(&extra) + 14.0;
        extra.push(serde_json::json!({ "id": "__legal", "type": "legal", "x": tx, "y": y, "w": tw, "h": 10 }));
    }
    extra
}

fn measure_all<'a>(
    ctx: &Ctx<'a>,
    page: &Rc<Cell<(usize, usize)>>,
    list: Vec<&'a Value>,
) -> Vec<FlowItem<'a>> {
    list.into_iter()
        .map(|block| {
            let pad = num(opt(block, "box"), "padding").unwrap_or(0.0);
            let (x, y, w, h) = geometry(block);
            let measured = measure_block(block, ctx, (w - 2.0 * pad).max(1.0), Rc::clone(page));
            let mut content = measured.height + 2.0 * pad;
            if measured.fixed {
                content = h;
            } else if measured.empty {
                content = 0.0;
            }
            FlowItem {
                block,
                measured,
                x,
                w,
                top: y,
                min_h: h,
                h: h.max(content),
            }
        })
        .collect()
}

fn on(pages: &mut Vec<Vec<Primitive>>, n: usize) -> &mut Vec<Primitive> {
    while pages.len() <= n {
        pages.push(Vec::new());
    }
    &mut pages[n]
}

/// `groupRows(items)`: indices of blocks whose tops are within 4 points.
fn group_rows(items: &[FlowItem<'_>]) -> Vec<Vec<usize>> {
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by(|&a, &b| {
        items[a]
            .top
            .partial_cmp(&items[b].top)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut rows: Vec<Vec<usize>> = Vec::new();
    for i in order {
        match rows.last_mut() {
            Some(row) if (items[i].top - items[row[0]].top).abs() <= 4.0 => row.push(i),
            _ => rows.push(vec![i]),
        }
    }
    rows
}

fn paint_block(
    block: &Value,
    measured: &Measured<'_>,
    x: f64,
    y: f64,
    h: f64,
    ctx: &Ctx<'_>,
) -> Vec<Primitive> {
    if measured.empty {
        return Vec::new();
    }
    let pad = num(opt(block, "box"), "padding").unwrap_or(0.0);
    let w = block["w"].as_f64().unwrap_or(0.0);
    let mut out = box_primitives(block, x, y, w, h, ctx);
    if block["type"] == "rect" && out.is_empty() {
        out.push(Primitive::Rect {
            x,
            y,
            w,
            h,
            fill: Some(ctx.theme.accent.clone()),
            stroke: None,
            stroke_width: None,
            radius: None,
        });
    }
    out.extend((measured.paint)(x + pad, y + pad, h - 2.0 * pad));
    out
}

/// `layoutInvoice(template, data)`.
#[allow(clippy::too_many_lines, reason = "the four steps of layoutInvoice")]
pub fn layout_invoice(template: &Value, data: &DocumentData) -> InvoiceLayout {
    let (width, height) = paper(template);
    let ctx = Ctx {
        theme: Theme::of(template),
        data,
    };
    let blocks: Vec<&Value> = template["blocks"]
        .as_array()
        .map(|b| b.iter().collect())
        .unwrap_or_default();
    // The line items always print, even from a template stored with the table hidden.
    let visible: Vec<&Value> = blocks
        .into_iter()
        .filter(|b| b["hidden"] != true || b["type"] == "lineItems")
        .collect();
    let Some(table) = visible.iter().copied().find(|b| b["type"] == "lineItems") else {
        return InvoiceLayout {
            width,
            height,
            pages: vec![Vec::new()],
        };
    };
    let page_info = Rc::new(Cell::new((1usize, 1usize)));
    let repeating: Vec<&Value> = visible
        .iter()
        .copied()
        .filter(|b| b["everyPage"] == true && b["type"] != "lineItems")
        .collect();
    let band = body_band(template, &repeating, table);
    let flowing: Vec<&Value> = visible
        .iter()
        .copied()
        .filter(|b| b["everyPage"] != true && b["type"] != "lineItems")
        .collect();
    let implicit = implicit_blocks(&flowing, table, data);
    let mut all: Vec<&Value> = flowing.clone();
    all.extend(implicit.iter());
    let (tx, ty, tw, th) = geometry(table);
    let table_bottom = ty + th;
    let mut pages: Vec<Vec<Primitive>> = vec![Vec::new()];

    // 1. Blocks above (or beside) the table; they can push it down.
    let mut before = measure_all(
        &ctx,
        &page_info,
        all.iter()
            .copied()
            .filter(|b| geometry(b).1 < table_bottom)
            .collect(),
    );
    let mut after = measure_all(
        &ctx,
        &page_info,
        all.iter()
            .copied()
            .filter(|b| geometry(b).1 >= table_bottom)
            .collect(),
    );
    before.push(FlowItem {
        block: table,
        measured: nothing(),
        x: tx,
        w: tw,
        top: ty,
        min_h: th,
        h: th,
    });
    push_down(&mut before);
    let table_item = before.pop().map_or(ty, |t| t.top);

    // 2. The table, split over pages.
    let (header_row, rows) = table_parts(table, &ctx);
    let first_row = rows.first().map_or(0.0, |r| r.height);
    let start = if table_item + header_row.height + first_row > band.bottom {
        (1usize, band.top)
    } else {
        (0usize, table_item)
    };
    let (mut page, mut y) = start;
    on(&mut pages, page).extend((header_row.paint)(tx, y, 0));
    y += header_row.height;
    for (i, row) in rows.iter().enumerate() {
        if y + row.height > band.bottom && y > band.top + header_row.height + 0.5 {
            page += 1;
            y = band.top;
            on(&mut pages, page).extend((header_row.paint)(tx, y, 0));
            y += header_row.height;
        }
        on(&mut pages, page).extend((row.paint)(tx, y, i));
        y += row.height;
    }
    let end = (page, y);
    let one_page = start.0 == end.0;
    let designed_end = if one_page {
        end.1.max(table_item + th)
    } else {
        end.1
    };

    // 3. Blocks below the table follow it, keeping their distance.
    for item in &mut after {
        item.top = designed_end + (geometry(item.block).1 - table_bottom);
    }
    push_down(&mut after);
    let mut placed: Vec<(usize, usize, f64, f64, bool)> = Vec::new(); // (list, index, y, h, page) – list 0 before, 1 after
    let mut placed_pages: Vec<usize> = Vec::new();
    for (i, item) in before.iter().enumerate() {
        placed.push((0, i, item.top, item.h, false));
        placed_pages.push(0);
    }
    let mut page_shift = 0.0;
    let mut following_page = end.0;
    for row in group_rows(&after) {
        let top = row
            .iter()
            .map(|&i| after[i].top)
            .fold(f64::INFINITY, f64::min)
            + page_shift;
        let bottom = row
            .iter()
            .map(|&i| after[i].top + after[i].h)
            .fold(f64::NEG_INFINITY, f64::max)
            + page_shift;
        if bottom > band.bottom && top > band.top + 0.5 {
            following_page += 1;
            page_shift += band.top - top;
        }
        for &i in &row {
            placed.push((1, i, after[i].top + page_shift, after[i].h, false));
            placed_pages.push(following_page);
        }
    }
    let page_count = following_page.max(end.0) + 1;
    on(&mut pages, page_count - 1);

    // 4. Flowing blocks, then the repeating ones on every page underneath the rest.
    for (k, &(list, i, py, ph, _)) in placed.iter().enumerate() {
        let item = if list == 0 { &before[i] } else { &after[i] };
        let p = placed_pages[k];
        page_info.set((p + 1, page_count));
        let primitives = paint_block(
            item.block,
            &item.measured,
            geometry(item.block).0,
            py,
            ph,
            &ctx,
        );
        on(&mut pages, p).extend(primitives);
    }
    let repeating_measured = measure_all(&ctx, &page_info, repeating);
    for (i, page_primitives) in pages.iter_mut().enumerate() {
        page_info.set((i + 1, page_count));
        let mut under: Vec<Primitive> = repeating_measured
            .iter()
            .flat_map(|r| {
                let (x, y, _, _) = geometry(r.block);
                paint_block(r.block, &r.measured, x, y, r.h, &ctx)
            })
            .collect();
        under.append(page_primitives);
        *page_primitives = under;
    }

    if let Some((banner, watermark)) = &data.draft {
        let face = ctx.theme.face(true, false);
        for (i, page_primitives) in pages.iter_mut().enumerate() {
            page_primitives.push(Primitive::Watermark {
                text: watermark.clone(),
                size: 80.0,
                color: "#c0392b".into(),
                face,
            });
            if i == 0 {
                let style = Resolved {
                    size: 8.0,
                    face,
                    color: "#c0392b".into(),
                    align: "center".into(),
                    line_height: 1.3,
                    uppercase: true,
                };
                page_primitives.extend(set_text(banner, &style, 24.0, 10.0, width - 48.0));
            }
        }
    }
    InvoiceLayout {
        width,
        height,
        pages,
    }
}
