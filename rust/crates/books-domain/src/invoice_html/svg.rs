//! The SVG painter (`invoice-template/svg.ts`): one `<svg>` per page, in
//! points, drawing what the layout placed, and the printable HTML document
//! around the pages.

use super::fonts::{Font, FontFace};
use super::layout::{InvoiceLayout, Primitive, safe_image_src};
use crate::js;

/// `fontStack(font)`.
pub fn font_stack(font: Font) -> &'static str {
    match font {
        Font::Helvetica => "Helvetica, Arial, 'Liberation Sans', sans-serif",
        Font::Times => "'Times New Roman', Times, 'Liberation Serif', serif",
        Font::Courier => "'Courier New', Courier, 'Liberation Mono', monospace",
    }
}

/// `esc(value)`.
pub fn esc(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// `col(value)`: a hex colour, else black.
fn col(value: &str) -> &str {
    let ok = (4..=9).contains(&value.len())
        && value.starts_with('#')
        && value[1..].bytes().all(|b| b.is_ascii_hexdigit());
    if ok { value } else { "#000000" }
}

/// `n(v)`: `Number(v.toFixed(2))` as a template literal prints it.
pub fn n(value: f64) -> String {
    js::number_text(js::parse_float(&js::to_fixed(value, 2)))
}

fn font_attrs(face: FontFace) -> String {
    format!(
        "font-family=\"{}\"{}{}",
        esc(font_stack(face.font)),
        if face.bold {
            " font-weight=\"bold\""
        } else {
            ""
        },
        if face.italic {
            " font-style=\"italic\""
        } else {
            ""
        }
    )
}

fn primitive_svg(p: &Primitive, width: f64, height: f64) -> String {
    match p {
        Primitive::Text {
            x,
            y,
            text,
            size,
            face,
            color,
        } => format!(
            "<text x=\"{}\" y=\"{}\" font-size=\"{}\" {} fill=\"{}\">{}</text>",
            n(*x),
            n(*y),
            n(*size),
            font_attrs(*face),
            col(color),
            esc(text)
        ),
        Primitive::Rect {
            x,
            y,
            w,
            h,
            fill,
            stroke,
            stroke_width,
            radius,
        } => {
            let fill = fill.as_deref().map_or("none", col);
            let stroke = stroke.as_deref().map_or_else(String::new, |s| {
                format!(
                    " stroke=\"{}\" stroke-width=\"{}\"",
                    col(s),
                    n(stroke_width.unwrap_or(1.0))
                )
            });
            let radius = radius
                .filter(|r| *r != 0.0 && !r.is_nan())
                .map_or_else(String::new, |r| format!(" rx=\"{}\"", n(r)));
            format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"{fill}\"{stroke}{radius}/>",
                n(*x),
                n(*y),
                n(*w),
                n(*h)
            )
        }
        Primitive::Line {
            x1,
            y1,
            x2,
            y2,
            color,
            width,
        } => format!(
            "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"{}\"/>",
            n(*x1),
            n(*y1),
            n(*x2),
            n(*y2),
            col(color),
            n(*width)
        ),
        Primitive::Image {
            x,
            y,
            w,
            h,
            src,
            align,
        } => {
            let Some(src) = safe_image_src(Some(src)) else {
                return String::new();
            };
            let align = match align.as_str() {
                "center" => "xMid",
                "right" => "xMax",
                _ => "xMin",
            };
            format!(
                "<image href=\"{}\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" preserveAspectRatio=\"{align}YMid meet\"/>",
                esc(&src),
                n(*x),
                n(*y),
                n(*w),
                n(*h)
            )
        }
        Primitive::Qr { x, y, size, matrix } => {
            #[allow(clippy::cast_precision_loss)]
            let cell = size / matrix.len().max(1) as f64;
            let mut d = String::new();
            for (r, row) in matrix.iter().enumerate() {
                for (c, dark) in row.iter().enumerate() {
                    if *dark {
                        #[allow(clippy::cast_precision_loss)]
                        d.push_str(&format!(
                            "M{} {}h{}v{}h{}z",
                            n(x + c as f64 * cell),
                            n(y + r as f64 * cell),
                            n(cell),
                            n(cell),
                            n(-cell)
                        ));
                    }
                }
            }
            format!(
                "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#ffffff\"/><path d=\"{d}\" fill=\"#000000\" shape-rendering=\"crispEdges\"/>",
                n(*x),
                n(*y),
                n(*size),
                n(*size)
            )
        }
        Primitive::Watermark {
            text,
            size,
            color,
            face,
        } => format!(
            "<text x=\"{}\" y=\"{}\" font-size=\"{}\" {} fill=\"{}\" fill-opacity=\"0.08\" text-anchor=\"middle\" dominant-baseline=\"middle\" transform=\"rotate(-30 {} {})\">{}</text>",
            n(width / 2.0),
            n(height / 2.0),
            n(*size),
            font_attrs(*face),
            col(color),
            n(width / 2.0),
            n(height / 2.0),
            esc(text)
        ),
    }
}

/// `renderPageSvg(layout, pageIndex)` with the size attributes.
pub fn render_page_svg(layout: &InvoiceLayout, index: usize) -> String {
    let Some(page) = layout.pages.get(index) else {
        return String::new();
    };
    let (width, height) = (layout.width, layout.height);
    let body: String = page
        .iter()
        .map(|p| primitive_svg(p, width, height))
        .collect();
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" width=\"{w}pt\" height=\"{h}pt\" xml:space=\"preserve\" style=\"white-space:pre\"><rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>{body}</svg>",
        w = n(width),
        h = n(height)
    )
}

/// `renderInvoiceHtmlDocument(layout, { title, lang, mobile })`.
pub fn render_invoice_html_document(
    layout: &InvoiceLayout,
    title: &str,
    lang: &str,
    mobile: Option<&str>,
) -> String {
    let pages = (0..layout.pages.len())
        .map(|i| format!("<div class=\"page\">{}</div>", render_page_svg(layout, i)))
        .collect::<Vec<_>>()
        .join("\n");
    let mobile_html = mobile.map_or_else(String::new, |m| {
        format!("\n<div class=\"mobile\">{m}</div>")
    });
    let w = n(layout.width);
    let h = n(layout.height);
    format!(
        "<!DOCTYPE html>\n<html lang=\"{lang}\">\n<head>\n<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n<title>{title}</title>\n<style>\n  @page {{ size: {w}pt {h}pt; margin: 0; }}\n  html, body {{ margin: 0; padding: 0; background: #e9ebef; }}\n  .page {{ width: {w}pt; max-width: 100%; margin: 16px auto; box-shadow: 0 1px 4px rgba(0,0,0,.15); background: #fff; }}\n  .page svg {{ display: block; width: 100%; height: auto; }}\n  .mobile {{ display: none; }}\n  @media screen and (max-width: 640px) {{\n    html, body {{ background: #fff; }}\n    body.has-mobile .page {{ display: none; }}\n    body.has-mobile .mobile {{ display: block; }}\n  }}\n  @media print {{\n    html, body {{ background: #fff; }}\n    .mobile {{ display: none !important; }}\n    .page {{ display: block !important; }}\n    .page {{ margin: 0; box-shadow: none; max-width: none; break-after: page; }}\n    .page:last-child {{ break-after: auto; }}\n  }}\n</style>\n</head>\n<body{class}>\n{pages}{mobile_html}\n</body>\n</html>",
        lang = esc(lang.split('-').next().unwrap_or("en")),
        title = esc(title),
        class = if mobile.is_some() {
            " class=\"has-mobile\""
        } else {
            ""
        },
    )
}
