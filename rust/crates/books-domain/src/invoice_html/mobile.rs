//! The mobile layout (`invoice-template/mobile.ts`): the same invoice and
//! template as one column for phones, styles scoped under `.wim`. Blocks in
//! reading order, paper-only decoration left out, coloured bands kept around
//! the blocks drawn on them, line items as stacked rows.

use serde_json::Value;

use super::layout::{
    DocumentData, PartyData, TotalsRow, field_value, fill_placeholders, safe_image_src,
    table_columns,
};
use super::svg::{esc, font_stack};

/// Body text on a phone, in CSS pixels.
const BODY_PX: f64 = 15.0;

struct Ctx<'a> {
    theme: &'a Value,
    data: &'a DocumentData,
    font_size: f64,
}

/// Escaped text with its line breaks kept.
fn text(value: &str) -> String {
    esc(value).replace('\n', "<br>")
}

fn hex(value: &str) -> String {
    let ok = value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|b| b.is_ascii_hexdigit());
    if ok {
        value.to_owned()
    } else {
        "#000000".to_owned()
    }
}

fn theme(ctx: &Ctx<'_>, key: &str) -> String {
    hex(ctx.theme[key].as_str().unwrap_or_default())
}

fn color(value: Option<&str>, ctx: &Ctx<'_>, fallback: &str) -> String {
    match value.unwrap_or(fallback) {
        "accent" => theme(ctx, "accent"),
        "text" => theme(ctx, "text"),
        "muted" => theme(ctx, "muted"),
        other => hex(other),
    }
}

/// `px(size, ctx)`.
fn px(size: f64, ctx: &Ctx<'_>) -> String {
    let ratio = size / ctx.font_size;
    crate::js::number_text(crate::js::math_round(BODY_PX * ratio.powf(0.6) * 10.0) / 10.0)
}

fn get<'v>(value: Option<&'v Value>, key: &str) -> Option<&'v Value> {
    value.and_then(|v| v.get(key)).filter(|v| !v.is_null())
}

fn opt<'v>(block: &'v Value, key: &str) -> Option<&'v Value> {
    block.get(key).filter(|v| !v.is_null())
}

#[derive(Default)]
struct Defaults<'a> {
    size: Option<f64>,
    bold: Option<bool>,
    color: Option<&'a str>,
    align: Option<&'a str>,
}

/// `textCss(style, ctx, defaults)`; `no_align` drops the style's own align
/// (`{ ...style, align: undefined }`).
fn text_css(
    style: Option<&Value>,
    ctx: &Ctx<'_>,
    defaults: &Defaults<'_>,
    no_align: bool,
) -> String {
    let size = get(style, "fontSize")
        .and_then(Value::as_f64)
        .or(defaults.size)
        .unwrap_or(ctx.font_size);
    let mut parts = vec![
        format!("font-size:{}px", px(size, ctx)),
        format!(
            "color:{}",
            color(
                get(style, "color").and_then(Value::as_str),
                ctx,
                defaults.color.unwrap_or("text")
            )
        ),
    ];
    if get(style, "bold")
        .and_then(Value::as_bool)
        .or(defaults.bold)
        == Some(true)
    {
        parts.push("font-weight:700".into());
    }
    if get(style, "italic").and_then(Value::as_bool) == Some(true) {
        parts.push("font-style:italic".into());
    }
    let own_align = if no_align {
        None
    } else {
        get(style, "align").and_then(Value::as_str)
    };
    if let Some(align) = own_align.or(defaults.align).filter(|a| *a != "left") {
        parts.push(format!("text-align:{align}"));
    }
    if get(style, "uppercase").and_then(Value::as_bool) == Some(true) {
        parts.push("text-transform:uppercase".into());
    }
    if let Some(line_height) = get(style, "lineHeight")
        .and_then(Value::as_f64)
        .filter(|l| *l != 0.0)
    {
        parts.push(format!(
            "line-height:{}",
            crate::js::number_text(line_height)
        ));
    }
    parts.join(";")
}

fn label_html(label: Option<&Value>, fallback: &str, ctx: &Ctx<'_>) -> String {
    if get(label, "show").and_then(Value::as_bool) == Some(false) {
        return String::new();
    }
    let value = get(label, "text")
        .and_then(Value::as_str)
        .unwrap_or(fallback);
    if value.is_empty() {
        return String::new();
    }
    let css = [
        format!(
            "color:{}",
            color(get(label, "color").and_then(Value::as_str), ctx, "muted")
        ),
        if get(label, "bold").and_then(Value::as_bool) == Some(false) {
            "font-weight:400".into()
        } else {
            String::new()
        },
        if get(label, "uppercase").and_then(Value::as_bool) == Some(false) {
            "text-transform:none;letter-spacing:0".into()
        } else {
            String::new()
        },
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(";");
    format!(
        "<div class=\"wim-label\" style=\"{css}\">{}</div>",
        text(value)
    )
}

fn box_css(bx: Option<&Value>, ctx: &Ctx<'_>) -> String {
    let Some(bx) = bx else {
        return String::new();
    };
    let mut parts = Vec::new();
    if let Some(bg) = bx
        .get("background")
        .and_then(Value::as_str)
        .filter(|b| !b.is_empty())
    {
        parts.push(format!("background:{}", color(Some(bg), ctx, "accent")));
    }
    let border = bx
        .get("borderWidth")
        .and_then(Value::as_f64)
        .filter(|w| *w != 0.0);
    if let (Some(width), Some(border_color)) = (
        border,
        bx.get("borderColor")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty()),
    ) {
        parts.push(format!(
            "border:{}px solid {}",
            crate::js::number_text(width.min(3.0)),
            color(Some(border_color), ctx, "muted")
        ));
    }
    if let Some(radius) = bx
        .get("radius")
        .and_then(Value::as_f64)
        .filter(|r| *r != 0.0)
    {
        parts.push(format!(
            "border-radius:{}px",
            crate::js::number_text(radius.min(16.0))
        ));
    }
    if !parts.is_empty() {
        let padding = bx.get("padding").and_then(Value::as_f64).unwrap_or(8.0);
        parts.push(format!(
            "padding:{}px",
            crate::js::number_text(crate::js::math_round(padding * 1.4).max(10.0))
        ));
    }
    parts.join(";")
}

fn section(block: &Value, inner: &str, ctx: &Ctx<'_>, cls: &str) -> String {
    if inner.is_empty() {
        return String::new();
    }
    let style = box_css(opt(block, "box"), ctx);
    let classes = if cls.is_empty() {
        "wim-section".to_owned()
    } else {
        format!("wim-section {cls}")
    };
    let style_attr = if style.is_empty() {
        String::new()
    } else {
        format!(" style=\"{style}\"")
    };
    format!("<section class=\"{classes}\"{style_attr}>{inner}</section>")
}

fn lines_html(lines: &[String]) -> String {
    lines
        .iter()
        .map(|l| format!("<div>{}</div>", text(l)))
        .collect()
}

fn party_html(block: &Value, party: Option<&PartyData>, label: &str, ctx: &Ctx<'_>) -> String {
    let Some(party) = party.filter(|p| !p.name.is_empty() || !p.lines.is_empty()) else {
        return String::new();
    };
    let kind = block["type"].as_str().unwrap_or_default();
    let show_contact = match kind {
        "seller" => block["showContact"] != false,
        "billTo" => block["showEmail"] != false,
        _ => false,
    };
    let show_tax_ids = kind != "seller" || block["showTaxIds"] != false;
    let body = text_css(opt(block, "style"), ctx, &Defaults::default(), false);
    let mut lines = party.lines.clone();
    if show_contact {
        lines.extend(party.contact_lines.iter().cloned());
    }
    if show_tax_ids {
        lines.extend(party.tax_id_lines.iter().cloned());
    }
    lines.retain(|l| !l.is_empty());
    let name_style = if block["boldName"] == false {
        " style=\"font-weight:400\""
    } else {
        ""
    };
    let name = if party.name.is_empty() {
        String::new()
    } else {
        format!(
            "<div class=\"wim-name\"{name_style}>{}</div>",
            text(&party.name)
        )
    };
    format!(
        "{}<div style=\"{body}\">{name}{}</div>",
        label_html(opt(block, "label"), label, ctx),
        lines_html(&lines)
    )
}

enum FieldHtml {
    None,
    Row(String),
    Standalone(String),
}

fn field_html(block: &Value, ctx: &Ctx<'_>) -> FieldHtml {
    let field = block["field"].as_str().unwrap_or_default();
    let value = field_value(ctx.data, field);
    if value.is_empty() {
        return FieldHtml::None;
    }
    let label_spec = opt(block, "label");
    let label = get(label_spec, "text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| ctx.data.field_label(field).map(str::to_owned))
        .unwrap_or_default();
    let value_only = block["layout"] == "value"
        || get(label_spec, "show").and_then(Value::as_bool) == Some(false)
        || label.is_empty();
    if value_only {
        return FieldHtml::Standalone(format!(
            "<div style=\"{}\">{}</div>",
            text_css(opt(block, "style"), ctx, &Defaults::default(), false),
            text(&value)
        ));
    }
    let label_style = format!(
        "color:{}",
        color(
            get(label_spec, "color").and_then(Value::as_str),
            ctx,
            "muted"
        )
    );
    let value_style = text_css(opt(block, "style"), ctx, &Defaults::default(), true);
    FieldHtml::Row(format!(
        "<div class=\"wim-kv\"><span style=\"{label_style}\">{}</span><span style=\"{value_style}\">{}</span></div>",
        text(&label),
        text(&value)
    ))
}

fn logo_html(block: &Value, ctx: &Ctx<'_>) -> String {
    let align = block["align"].as_str().unwrap_or("left");
    if let Some(src) = safe_image_src(ctx.data.logo_url.as_deref()) {
        return format!(
            "<div class=\"wim-logo\" style=\"text-align:{align}\"><img src=\"{}\" alt=\"{}\"></div>",
            esc(&src),
            esc(&ctx.data.seller.name)
        );
    }
    if ctx.data.seller.name.is_empty() {
        return String::new();
    }
    format!(
        "<div style=\"{}\">{}</div>",
        text_css(
            opt(block, "fallbackStyle"),
            ctx,
            &Defaults {
                size: Some(16.0),
                bold: Some(true),
                align: Some(align),
                color: None
            },
            false
        ),
        text(&ctx.data.seller.name)
    )
}

fn image_html(block: &Value) -> String {
    safe_image_src(block["src"].as_str()).map_or_else(String::new, |src| {
        format!(
            "<div class=\"wim-image\" style=\"text-align:{}\"><img src=\"{}\" alt=\"\"></div>",
            block["align"].as_str().unwrap_or("left"),
            esc(&src)
        )
    })
}

fn items_html(block: &Value, ctx: &Ctx<'_>) -> String {
    let columns = table_columns(block, ctx.data);
    let amount_column = columns
        .iter()
        .rev()
        .find(|c| c.key == "amountWithTax" || c.key == "amount")
        .map(|c| c.key.clone());
    let detail_columns: Vec<_> = columns
        .iter()
        .filter(|c| {
            c.key != "description" && c.key != "index" && Some(&c.key) != amount_column.as_ref()
        })
        .collect();
    let header = opt(block, "header");
    let rule = color(get(header, "rule").and_then(Value::as_str), ctx, "accent");
    let row_rule = color(block["rowRule"].as_str(), ctx, "muted");
    let zebra = block["zebra"].as_str().filter(|z| !z.is_empty());
    let rows: Vec<String> = ctx
        .data
        .rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let description = row.cell("description").unwrap_or_default();
            let amount = amount_column.as_deref().and_then(|k| row.cell(k)).unwrap_or_default();
            let details = detail_columns
                .iter()
                .filter_map(|c| row.cell(&c.key).filter(|v| !v.is_empty()).map(|v| format!("{} {}", text(&c.label), text(v))))
                .collect::<Vec<_>>()
                .join(" · ");
            let sub: String = row.sub_lines.iter().map(|l| format!("<div class=\"wim-muted\">{}</div>", text(l))).collect();
            let zebra_attr = match zebra {
                Some(z) if i % 2 == 1 => format!(" style=\"background:{}\"", color(Some(z), ctx, "muted")),
                _ => String::new(),
            };
            let amount_html = if amount.is_empty() { String::new() } else { format!("<div class=\"wim-item-amount\">{}</div>", text(amount)) };
            let details_html = if details.is_empty() { String::new() } else { format!("<div class=\"wim-muted\">{details}</div>") };
            format!(
                "<div class=\"wim-item\"{zebra_attr}><div class=\"wim-item-top\"><div class=\"wim-item-desc\">{}</div>{amount_html}</div>{sub}{details_html}</div>",
                text(description)
            )
        })
        .collect();
    if rows.is_empty() {
        return String::new();
    }
    format!(
        "<div class=\"wim-items\" style=\"border-top:2px solid {rule};--wim-row-rule:{row_rule}33\">{}</div>",
        rows.concat()
    )
}

fn totals_row_html(row: &TotalsRow, block: &Value, ctx: &Ctx<'_>) -> String {
    let value = if row.value.is_empty() {
        "<span></span>".to_owned()
    } else {
        format!("<span>{}</span>", text(&row.value))
    };
    let muted = theme(ctx, "muted");
    match row.kind {
        Some("heading") => format!(
            "<div class=\"wim-kv wim-totals-heading\" style=\"color:{muted}\"><span>{}</span>{value}</div>",
            text(&row.label)
        ),
        Some("muted") => format!(
            "<div class=\"wim-kv wim-small\" style=\"color:{muted}\"><span>{}</span>{value}</div>",
            text(&row.label)
        ),
        Some("total") => {
            let total = opt(block, "total");
            let base = get(opt(block, "style"), "fontSize")
                .and_then(Value::as_f64)
                .unwrap_or(ctx.font_size);
            let size = px(
                get(total, "fontSize")
                    .and_then(Value::as_f64)
                    .unwrap_or(base + 2.0),
                ctx,
            );
            let bg = get(total, "background")
                .and_then(Value::as_str)
                .filter(|b| !b.is_empty())
                .map_or_else(String::new, |b| {
                    format!(
                        "background:{};padding:10px 12px;border-radius:6px;",
                        color(Some(b), ctx, "accent")
                    )
                });
            format!(
                "<div class=\"wim-kv wim-total\" style=\"{bg}border-top:2px solid {};font-size:{size}px;color:{}\"><span>{}</span>{value}</div>",
                color(get(total, "rule").and_then(Value::as_str), ctx, "accent"),
                color(get(total, "color").and_then(Value::as_str), ctx, "text"),
                text(&row.label)
            )
        }
        Some("balance") => format!(
            "<div class=\"wim-kv\" style=\"font-weight:700;color:{}\"><span>{}</span>{value}</div>",
            theme(ctx, "accent"),
            text(&row.label)
        ),
        _ => format!(
            "<div class=\"wim-kv\"><span style=\"color:{muted}\">{}</span>{value}</div>",
            text(&row.label)
        ),
    }
}

fn totals_html(block: &Value, ctx: &Ctx<'_>) -> String {
    let rows: Vec<&TotalsRow> = ctx
        .data
        .totals
        .iter()
        .filter(|r| block["showBalance"] != false || r.kind != Some("balance"))
        .collect();
    if rows.is_empty() {
        return String::new();
    }
    format!(
        "<div class=\"wim-totals\" style=\"{}\">{}</div>",
        text_css(opt(block, "style"), ctx, &Defaults::default(), true),
        rows.iter()
            .map(|r| totals_row_html(r, block, ctx))
            .collect::<String>()
    )
}

fn payment_html(block: &Value, ctx: &Ctx<'_>) -> String {
    let lines = if block["showBank"] == false {
        Vec::new()
    } else {
        ctx.data.bank_lines.clone()
    };
    let notes = if block["showInstructions"] == false {
        String::new()
    } else {
        ctx.data.instructions.clone().unwrap_or_default()
    };
    if lines.is_empty() && notes.is_empty() {
        return String::new();
    }
    let notes_html = if notes.is_empty() {
        String::new()
    } else {
        format!("<p>{}</p>", text(&notes))
    };
    format!(
        "{}<div style=\"{}\">{}{notes_html}</div>",
        label_html(opt(block, "label"), &ctx.data.labels.payment, ctx),
        text_css(opt(block, "style"), ctx, &Defaults::default(), false),
        lines_html(&lines)
    )
}

fn labeled_text_html(block: &Value, value: Option<&str>, label: &str, ctx: &Ctx<'_>) -> String {
    let Some(value) = value.filter(|v| !crate::jurisdictions::js_trim(v).is_empty()) else {
        return String::new();
    };
    format!(
        "{}<div style=\"{}\">{}</div>",
        label_html(opt(block, "label"), label, ctx),
        text_css(opt(block, "style"), ctx, &Defaults::default(), false),
        text(value)
    )
}

fn qr_svg(matrix: &[Vec<bool>]) -> String {
    let size = matrix.len().max(1);
    let mut d = String::new();
    for (r, row) in matrix.iter().enumerate() {
        for (c, dark) in row.iter().enumerate() {
            if *dark {
                d.push_str(&format!("M{c} {r}h1v1h-1z"));
            }
        }
    }
    format!(
        "<svg class=\"wim-qr\" viewBox=\"0 0 {size} {size}\" xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"{size}\" height=\"{size}\" fill=\"#fff\"/><path d=\"{d}\" fill=\"#000\" shape-rendering=\"crispEdges\"/></svg>"
    )
}

fn legal_html(block: Option<&Value>, ctx: &Ctx<'_>) -> String {
    let legal = &ctx.data.legal;
    let muted = format!("color:{}", theme(ctx, "muted"));
    let mut parts = Vec::new();
    if let Some(doc) = legal.fiscal_document.as_ref().filter(|d| !d.is_empty()) {
        parts.push(format!(
            "<div>{}</div>",
            doc.iter().map(|l| text(l)).collect::<Vec<_>>().join("<br>")
        ));
    }
    if !legal.notices.is_empty() {
        parts.push(format!(
            "<div style=\"font-weight:700\">{}</div>",
            legal
                .notices
                .iter()
                .map(|l| text(l))
                .collect::<Vec<_>>()
                .join("<br>")
        ));
    }
    if let Some(pix) = &legal.pix {
        parts.push(format!(
            "<div class=\"wim-pix\">{}<div><div style=\"font-weight:700\">{}</div><div>{}</div><div class=\"wim-small wim-break\" style=\"{muted}\">{}</div></div></div>",
            qr_svg(&pix.matrix),
            text(&pix.title),
            text(&pix.key),
            text(&pix.payload)
        ));
    }
    if let Some(footer) = legal.required_footer.as_ref().filter(|f| !f.is_empty()) {
        parts.push(format!(
            "<div class=\"wim-small\" style=\"{muted}\">{}</div>",
            text(footer)
        ));
    }
    if parts.is_empty() {
        return String::new();
    }
    format!(
        "<div class=\"wim-legal\" style=\"{}\">{}</div>",
        text_css(
            block.and_then(|b| opt(b, "style")),
            ctx,
            &Defaults {
                size: Some(ctx.font_size - 0.5),
                ..Defaults::default()
            },
            false
        ),
        parts.concat()
    )
}

fn text_block_html(block: &Value, ctx: &Ctx<'_>) -> String {
    let filled = fill_placeholders(block["text"].as_str().unwrap_or_default(), ctx.data);
    let value = crate::jurisdictions::js_trim(&filled);
    if value.is_empty() {
        return String::new();
    }
    format!(
        "<div style=\"{}\">{}</div>",
        text_css(opt(block, "style"), ctx, &Defaults::default(), false),
        text(value)
    )
}

// ── Reading order ───────────────────────────────────────────────────────────

const PAPER_ONLY: [&str; 3] = ["rect", "line", "pageNumber"];

fn num(block: &Value, key: &str) -> f64 {
    block[key].as_f64().unwrap_or(0.0)
}

fn kind(block: &Value) -> &str {
    block["type"].as_str().unwrap_or_default()
}

/// `readingOrder(blocks, keep)`.
fn reading_order<'a>(blocks: &[&'a Value], keep: &dyn Fn(&Value) -> bool) -> Vec<&'a Value> {
    let mut sorted: Vec<&Value> = blocks
        .iter()
        .copied()
        .filter(|b| b["hidden"] != true && keep(b))
        .collect();
    sorted.sort_by(|a, b| {
        (num(a, "y") - num(b, "y"))
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                (num(a, "x") - num(b, "x"))
                    .partial_cmp(&0.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let mut rows: Vec<(f64, Vec<&Value>)> = Vec::new();
    for block in sorted {
        match rows.last_mut() {
            Some((top, items)) if num(block, "y") < *top + (num(items[0], "h") / 2.0).max(8.0) => {
                items.push(block);
            }
            _ => rows.push((num(block, "y"), vec![block])),
        }
    }
    rows.into_iter()
        .flat_map(|(_, mut items)| {
            items.sort_by(|a, b| {
                num(a, "x")
                    .partial_cmp(&num(b, "x"))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            items
        })
        .collect()
}

struct Band<'a> {
    rect: &'a Value,
    members: Vec<&'a Value>,
}

/// `findBands(blocks)`: filled rectangles and what sits on them.
fn find_bands<'a>(blocks: &[&'a Value]) -> Vec<Band<'a>> {
    blocks
        .iter()
        .copied()
        .filter(|b| {
            kind(b) == "rect"
                && b["hidden"] != true
                && b["box"]["background"]
                    .as_str()
                    .is_some_and(|bg| !bg.is_empty())
        })
        .map(|rect| Band {
            rect,
            members: blocks
                .iter()
                .copied()
                .filter(|b| {
                    if std::ptr::eq(*b, rect)
                        || b["hidden"] == true
                        || PAPER_ONLY.contains(&kind(b))
                        || kind(b) == "lineItems"
                    {
                        return false;
                    }
                    let cx = num(b, "x") + num(b, "w") / 2.0;
                    let cy = num(b, "y") + num(b, "h") / 2.0;
                    cx >= num(rect, "x")
                        && cx <= num(rect, "x") + num(rect, "w")
                        && cy >= num(rect, "y")
                        && cy <= num(rect, "y") + num(rect, "h")
                })
                .collect(),
        })
        .filter(|band| !band.members.is_empty())
        .collect()
}

fn render_blocks(
    order: &[&Value],
    bands: &[Band<'_>],
    ctx: &Ctx<'_>,
    page_width: f64,
    has_totals: bool,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut field_rows: Vec<String> = Vec::new();
    let flush = |out: &mut Vec<String>, rows: &mut Vec<String>| {
        if !rows.is_empty() {
            out.push(format!(
                "<section class=\"wim-section wim-fields\">{}</section>",
                rows.concat()
            ));
            rows.clear();
        }
    };
    for block in order {
        if kind(block) == "field" {
            match field_html(block, ctx) {
                FieldHtml::Row(row) => {
                    field_rows.push(row);
                    continue;
                }
                FieldHtml::Standalone(html) => {
                    flush(&mut out, &mut field_rows);
                    out.push(section(block, &html, ctx, ""));
                }
                FieldHtml::None => flush(&mut out, &mut field_rows),
            }
            continue;
        }
        flush(&mut out, &mut field_rows);
        out.extend(block_sections(block, bands, ctx, page_width, has_totals));
    }
    flush(&mut out, &mut field_rows);
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

fn band_html(block: &Value, bands: &[Band<'_>], ctx: &Ctx<'_>, page_width: f64) -> String {
    let Some(band) = bands.iter().find(|b| b.rect["id"] == block["id"]) else {
        return String::new();
    };
    let order = reading_order(&band.members, &|b| !PAPER_ONLY.contains(&kind(b)));
    let inner = render_blocks(&order, bands, ctx, page_width, true).concat();
    if inner.is_empty() {
        return String::new();
    }
    let full_width =
        num(block, "x") <= 8.0 && num(block, "x") + num(block, "w") >= page_width - 8.0;
    let classes = [
        "wim-section",
        "wim-band",
        if full_width { "wim-bleed" } else { "" },
        if full_width && num(block, "y") <= 8.0 {
            "wim-bleed-top"
        } else {
            ""
        },
    ]
    .into_iter()
    .filter(|c| !c.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    format!(
        "<section class=\"{classes}\" style=\"background:{}\">{inner}</section>",
        color(block["box"]["background"].as_str(), ctx, "accent")
    )
}

fn block_sections(
    block: &Value,
    bands: &[Band<'_>],
    ctx: &Ctx<'_>,
    page_width: f64,
    has_totals: bool,
) -> Vec<String> {
    let data = ctx.data;
    match kind(block) {
        "rect" => vec![band_html(block, bands, ctx, page_width)],
        "text" => vec![section(block, &text_block_html(block, ctx), ctx, "")],
        "logo" => vec![section(block, &logo_html(block, ctx), ctx, "")],
        "image" => vec![section(block, &image_html(block), ctx, "")],
        "seller" => vec![section(
            block,
            &party_html(block, Some(&data.seller), &data.labels.from, ctx),
            ctx,
            "",
        )],
        "billTo" => vec![section(
            block,
            &party_html(block, Some(&data.bill_to), &data.labels.bill_to, ctx),
            ctx,
            "",
        )],
        "shipTo" => vec![section(
            block,
            &party_html(block, data.ship_to.as_ref(), &data.labels.ship_to, ctx),
            ctx,
            "",
        )],
        "lineItems" => {
            let items = section(block, &items_html(block, ctx), ctx, "wim-section-items");
            if has_totals {
                vec![items]
            } else {
                let implicit = serde_json::json!({ "id": "__totals", "type": "totals", "x": 0, "y": 0, "w": 1, "h": 1 });
                vec![
                    items,
                    format!(
                        "<section class=\"wim-section\">{}</section>",
                        totals_html(&implicit, ctx)
                    ),
                ]
            }
        }
        "totals" => vec![section(block, &totals_html(block, ctx), ctx, "")],
        "payment" => vec![section(block, &payment_html(block, ctx), ctx, "")],
        "notes" => vec![section(
            block,
            &labeled_text_html(block, data.notes.as_deref(), &data.labels.notes, ctx),
            ctx,
            "",
        )],
        "terms" => {
            let terms = block["text"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| data.terms.clone());
            vec![section(
                block,
                &labeled_text_html(block, terms.as_deref(), &data.labels.terms, ctx),
                ctx,
                "",
            )]
        }
        "legal" => vec![section(block, &legal_html(Some(block), ctx), ctx, "")],
        _ => Vec::new(),
    }
}

/// `withoutRepeatedFields(blocks)`: each field once, where it first appears.
fn without_repeated_fields<'a>(blocks: &[&'a Value]) -> Vec<&'a Value> {
    let rank = |b: &Value| {
        (if b["everyPage"] == true {
            1_000_000.0
        } else {
            0.0
        }) + num(b, "y") * 1000.0
            + num(b, "x")
    };
    let mut shown: Vec<(&str, &Value)> = Vec::new();
    for b in blocks {
        if kind(b) != "field" || b["hidden"] == true {
            continue;
        }
        let field = b["field"].as_str().unwrap_or_default();
        match shown.iter_mut().find(|(f, _)| *f == field) {
            Some(entry) => {
                if rank(b) < rank(entry.1) {
                    entry.1 = b;
                }
            }
            None => shown.push((field, b)),
        }
    }
    blocks
        .iter()
        .copied()
        .filter(|b| {
            kind(b) != "field"
                || b["hidden"] == true
                || shown.iter().any(|(f, s)| {
                    *f == b["field"].as_str().unwrap_or_default() && std::ptr::eq(*s, *b)
                })
        })
        .collect()
}

/// `renderMobileInvoice(template, data)`.
pub fn render_mobile_invoice(template: &Value, data: &DocumentData) -> String {
    let ctx = Ctx {
        theme: &template["theme"],
        data,
        font_size: template["theme"]["fontSize"].as_f64().unwrap_or(9.0),
    };
    let all: Vec<&Value> = template["blocks"]
        .as_array()
        .map(|b| b.iter().collect())
        .unwrap_or_default();
    let blocks = without_repeated_fields(&all);
    let bands = find_bands(&blocks);
    let in_band: Vec<&Value> = bands
        .iter()
        .flat_map(|b| b.members.iter().copied())
        .collect();
    let band_ids: Vec<&Value> = bands.iter().map(|b| &b.rect["id"]).collect();
    let order = reading_order(&blocks, &|b| {
        !in_band.iter().any(|m| m["id"] == b["id"])
            && (band_ids.contains(&&b["id"]) || !PAPER_ONLY.contains(&kind(b)))
    });
    let visible: Vec<&Value> = blocks
        .iter()
        .copied()
        .filter(|b| b["hidden"] != true)
        .collect();
    let has_totals = visible.iter().any(|b| kind(b) == "totals");
    let has_legal = visible.iter().any(|b| kind(b) == "legal");
    let page_width = if template["paperSize"] == "letter" {
        612.0
    } else {
        595.28
    };
    let mut out = render_blocks(&order, &bands, &ctx, page_width, has_totals);
    if !has_legal {
        let legal = legal_html(None, &ctx);
        if !legal.is_empty() {
            out.push(format!("<section class=\"wim-section\">{legal}</section>"));
        }
    }
    let draft = data.draft.as_ref().map_or_else(String::new, |(banner, _)| {
        format!("<div class=\"wim-draft\">{}</div>", text(banner))
    });
    format!(
        "{}<div class=\"wim\">{draft}{}</div>",
        styles(&ctx),
        out.concat()
    )
}

fn styles(ctx: &Ctx<'_>) -> String {
    let muted = theme(ctx, "muted");
    let font = super::fonts::Font::parse(ctx.theme["font"].as_str().unwrap_or("helvetica"));
    format!(
        "<style>\n.wim{{box-sizing:border-box;font-family:{};font-size:{}px;line-height:1.45;color:{};background:#fff;padding:20px 18px 28px;-webkit-text-size-adjust:100%;overflow-wrap:anywhere}}\n.wim *{{box-sizing:border-box}}\n.wim p{{margin:6px 0 0}}\n.wim img{{max-width:100%;height:auto;display:inline-block}}\n.wim-section{{margin:0 0 18px}}\n.wim-section:last-child{{margin-bottom:0}}\n.wim-label{{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin:0 0 4px}}\n.wim-name{{font-weight:700}}\n.wim-logo img{{max-height:56px}}\n.wim-image img{{max-height:140px}}\n.wim-kv{{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:3px 0}}\n.wim-kv>span:last-child{{text-align:right;font-variant-numeric:tabular-nums}}\n.wim-fields{{border-top:1px solid {muted}33;border-bottom:1px solid {muted}33;padding:8px 0}}\n.wim-items{{margin:0}}\n.wim-item{{padding:12px 0;border-bottom:1px solid var(--wim-row-rule)}}\n.wim-item-top{{display:flex;justify-content:space-between;align-items:baseline;gap:16px}}\n.wim-item-desc{{font-weight:600;min-width:0}}\n.wim-item-amount{{font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}}\n.wim-muted{{color:{muted};font-size:13px;margin-top:2px}}\n.wim-small{{font-size:13px}}\n.wim-break{{word-break:break-all}}\n.wim-totals .wim-kv{{padding:4px 0}}\n.wim-totals-heading{{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding-top:10px}}\n.wim-total{{font-weight:700;margin-top:6px;padding-top:10px}}\n.wim-legal>div+div{{margin-top:8px}}\n.wim-pix{{display:flex;gap:12px;align-items:flex-start}}\n.wim-qr{{width:96px;height:96px;flex:none}}\n.wim-band{{padding:18px;border-radius:10px}}\n.wim-band .wim-section{{margin-bottom:10px}}\n.wim-band .wim-section:last-child{{margin-bottom:0}}\n.wim-bleed{{margin-left:-18px;margin-right:-18px;border-radius:0;padding:22px 18px}}\n.wim-bleed-top{{margin-top:-20px}}\n.wim-draft{{background:#fef3c7;color:#92400e;font-size:13px;font-weight:700;padding:8px 12px;border-radius:6px;margin:0 0 16px}}\n</style>",
        font_stack(font),
        crate::js::number_text(BODY_PX),
        theme(ctx, "text"),
    )
}
