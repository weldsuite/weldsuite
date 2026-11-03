//! Text measurement with the metrics of the standard PDF fonts
//! (`invoice-template/fonts.ts`): the widths and kerning pdf-lib uses, so
//! line breaks and right-aligned amounts land where the PDF puts them. The
//! metrics are `@pdf-lib/standard-fonts`', exported into `data/invoice.json`.

use std::collections::HashMap;
use std::sync::LazyLock;

use crate::compliance::INVOICE_DATA;

/// `TemplateFont`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Font {
    Helvetica,
    Times,
    Courier,
}

impl Font {
    pub fn parse(name: &str) -> Self {
        match name {
            "times" => Self::Times,
            "courier" => Self::Courier,
            _ => Self::Helvetica,
        }
    }
}

/// `FontFace`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FontFace {
    pub font: Font,
    pub bold: bool,
    pub italic: bool,
}

/// `standardFontName(face)`.
fn standard_font_name(face: FontFace) -> &'static str {
    let names = match face.font {
        Font::Helvetica => [
            "Helvetica",
            "Helvetica-Bold",
            "Helvetica-Oblique",
            "Helvetica-BoldOblique",
        ],
        Font::Times => [
            "Times-Roman",
            "Times-Bold",
            "Times-Italic",
            "Times-BoldItalic",
        ],
        Font::Courier => [
            "Courier",
            "Courier-Bold",
            "Courier-Oblique",
            "Courier-BoldOblique",
        ],
    };
    names[usize::from(face.bold) + 2 * usize::from(face.italic)]
}

/// One font's metrics.
struct Metrics {
    ascent: f64,
    widths: Vec<f64>,
    question: f64,
    kerning: HashMap<(usize, usize), f64>,
}

static GLYPHS: LazyLock<HashMap<u32, usize>> = LazyLock::new(|| {
    INVOICE_DATA["glyphs"]["byCodePoint"]
        .as_object()
        .map(|map| {
            map.iter()
                .filter_map(|(cp, index)| {
                    Some((cp.parse().ok()?, usize::try_from(index.as_u64()?).ok()?))
                })
                .collect()
        })
        .unwrap_or_default()
});

static FONTS: LazyLock<HashMap<String, Metrics>> = LazyLock::new(|| {
    INVOICE_DATA["fonts"]
        .as_object()
        .map(|fonts| {
            fonts
                .iter()
                .map(|(name, font)| {
                    let kerning = font["kerning"]
                        .as_array()
                        .map(|pairs| {
                            pairs
                                .iter()
                                .filter_map(|pair| {
                                    Some((
                                        (
                                            usize::try_from(pair[0].as_u64()?).ok()?,
                                            usize::try_from(pair[1].as_u64()?).ok()?,
                                        ),
                                        pair[2].as_f64()?,
                                    ))
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    (
                        name.clone(),
                        Metrics {
                            ascent: font["ascent"].as_f64().unwrap_or(0.718),
                            widths: font["widths"]
                                .as_array()
                                .map(|w| w.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect())
                                .unwrap_or_default(),
                            question: font["question"].as_f64().unwrap_or(0.0),
                            kerning,
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default()
});

fn metrics(face: FontFace) -> Option<&'static Metrics> {
    FONTS.get(standard_font_name(face))
}

/// The narrow, thin and figure spaces some locales put in amounts and dates.
fn is_space_like(c: char) -> bool {
    matches!(c, '\u{202f}' | '\u{2009}' | '\u{2007}' | '\u{200a}')
}

/// `normalizeText(text)`: odd spaces, tabs and line breaks as plain spaces.
pub fn normalize_text(text: &str) -> String {
    text.chars()
        .map(|c| {
            if is_space_like(c) || matches!(c, '\t' | '\r' | '\n') {
                ' '
            } else {
                c
            }
        })
        .collect()
}

/// `textWidth(text, size, face)`: points; a character the font lacks is a
/// "?". `Array.from` walks code points.
pub fn text_width(text: &str, size: f64, face: FontFace) -> f64 {
    let Some(font) = metrics(face) else {
        return 0.0;
    };
    let glyphs: Vec<Option<usize>> = text
        .chars()
        .map(|c| GLYPHS.get(&u32::from(c)).copied())
        .collect();
    let mut total = 0.0;
    for (i, glyph) in glyphs.iter().enumerate() {
        let width = match glyph {
            Some(g) => font.widths.get(*g).copied().unwrap_or(0.0),
            None => font.question,
        };
        let kern = match (glyph, glyphs.get(i + 1)) {
            (Some(a), Some(Some(b))) => font.kerning.get(&(*a, *b)).copied().unwrap_or(0.0),
            _ => 0.0,
        };
        total += width + kern;
    }
    total * size / 1000.0
}

/// `ascentRatio(face)`.
pub fn ascent_ratio(face: FontFace) -> f64 {
    metrics(face).map_or(0.718, |m| m.ascent)
}

/// `wrapText(text, size, face, maxWidth)`: greedy word wrap; a word longer
/// than the line breaks by character.
pub fn wrap_text(text: &str, size: f64, face: FontFace, max_width: f64) -> Vec<String> {
    let fits = |value: &str| text_width(value, size, face) <= max_width;
    // `text.split(/\r?\n/)`
    let paragraphs: Vec<&str> = text
        .split('\n')
        .map(|p| p.strip_suffix('\r').unwrap_or(p))
        .collect();
    paragraphs
        .into_iter()
        .flat_map(|p| wrap_paragraph(&normalize_text(p), &fits))
        .collect()
}

fn wrap_paragraph(paragraph: &str, fits: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in paragraph.split(' ').filter(|w| !w.is_empty()) {
        let candidate = if current.is_empty() {
            word.to_owned()
        } else {
            format!("{current} {word}")
        };
        if fits(&candidate) {
            current = candidate;
            continue;
        }
        if !current.is_empty() {
            lines.push(std::mem::take(&mut current));
        }
        let mut pieces = break_word(word, fits);
        current = pieces.pop().unwrap_or_default();
        lines.extend(pieces);
    }
    lines.push(current);
    lines
}

/// `breakWord(word, fits)`: pieces that each fit; one when the word fits.
fn break_word(word: &str, fits: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut piece = String::new();
    for c in word.chars() {
        let mut next = piece.clone();
        next.push(c);
        if !piece.is_empty() && !fits(&next) {
            pieces.push(std::mem::take(&mut piece));
        }
        piece.push(c);
    }
    pieces.push(piece);
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELVETICA: FontFace = FontFace {
        font: Font::Helvetica,
        bold: false,
        italic: false,
    };

    #[test]
    fn measures_like_pdf_lib() {
        // Helvetica: "A" 667, "V" 667, kerning A-V -70.
        assert!((text_width("AV", 10.0, HELVETICA) - 12.64).abs() < 1e-9);
        assert!((ascent_ratio(HELVETICA) - 0.718).abs() < 1e-9);
        assert_eq!(
            wrap_text("aaa bbb ccc", 10.0, HELVETICA, 40.0),
            vec!["aaa bbb", "ccc"]
        );
    }
}
