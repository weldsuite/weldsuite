//! Drawing signed values into PDFs, and the certificate of completion
//! (`packages/domains/sign/src/pdf-render.ts`, which uses pdf-lib).
//!
//! Field boxes are stored in PDF points of the page *as displayed* (origin
//! top left, crop box, /Rotate applied), the frame the editor and pdf.js use.
//! To draw into the page itself they are mapped back to page space
//! ([`place_box`]), and the content is rotated with the page so it reads
//! upright on screen.
//!
//! Standard fonts only (Helvetica, Helvetica-Bold, Courier, WinAnsi
//! encoding): text is reduced to WinAnsi ([`win_ansi`]), so a character the
//! font cannot show becomes "?" instead of failing the whole document. Text
//! is measured with the same metrics and kerning pdf-lib uses
//! (`standard_fonts.rs`), so sizes, line breaks and positions match; the
//! bytes of the file do not (object numbers, number formatting, compression),
//! which is why the tests compare what is drawn, not the bytes.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat, dictionary};

use crate::standard_fonts::{COURIER, HELVETICA, HELVETICA_BOLD, StandardFont, WIN_ANSI};

/// Why a PDF could not be built.
#[derive(Debug)]
pub struct PdfError(pub String);

impl std::fmt::Display for PdfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PdfError {}

impl From<lopdf::Error> for PdfError {
    fn from(error: lopdf::Error) -> Self {
        Self(format!("pdf: {error}"))
    }
}

impl From<std::io::Error> for PdfError {
    fn from(error: std::io::Error) -> Self {
        Self(format!("pdf: {error}"))
    }
}

impl From<png::DecodingError> for PdfError {
    fn from(error: png::DecodingError) -> Self {
        Self(format!("png: {error}"))
    }
}

type PdfResult<T> = Result<T, PdfError>;

/// A filled field to draw (`RenderField`).
#[derive(Debug, Clone, Default)]
pub struct RenderField {
    pub page: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// `signature`, `initials`, `checkbox`, or a text kind.
    pub kind: String,
    /// Text to draw: name, email, date, text, and `true`/`false` for a checkbox.
    pub value: Option<String>,
    /// PNG bytes of the adopted signature or initials.
    pub image: Option<Vec<u8>>,
}

/// A rectangle as pdf-lib hands one out: lower-left corner and size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where an element whose display box is `box` lands in page space, and how
/// it is turned (`Placement`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    /// Page-space point that is the element's bottom-left corner before rotation.
    pub x: f64,
    pub y: f64,
    /// Counter-clockwise rotation in degrees (the page's /Rotate).
    pub rotate: i64,
}

/// Map a box in display space (origin top-left of the rotated, cropped page)
/// to page space (`placeBox`). `crop` is the page's crop box in page space;
/// `rotation` its /Rotate (0, 90, 180 or 270, clockwise on screen).
pub fn place_box(field: Rect, crop: Rect, rotation: i64) -> Placement {
    let (w, h) = (crop.width, crop.height);
    let u = field.x;
    let v = field.y + field.height;
    let rotate = rotation.rem_euclid(360);
    let (px, py) = match rotate {
        90 => (v, u),
        180 => (w - u, v),
        270 => (w - v, h - u),
        _ => (u, h - v),
    };
    Placement {
        x: crop.x + px,
        y: crop.y + py,
        rotate,
    }
}

/// Offset within the element (local x right, y up) turned into page space.
fn offset(p: Placement, dx: f64, dy: f64) -> (f64, f64) {
    match p.rotate {
        90 => (p.x - dy, p.y + dx),
        180 => (p.x - dx, p.y - dy),
        270 => (p.x + dy, p.y - dx),
        _ => (p.x + dx, p.y + dy),
    }
}

// ── Text ───────────────────────────────────────────────────────────────────

fn code_of(c: char) -> Option<u8> {
    let cp = u32::from(c);
    WIN_ANSI
        .binary_search_by_key(&cp, |(point, _)| *point)
        .ok()
        .map(|i| WIN_ANSI[i].1)
}

fn char_of(code: u8) -> char {
    WIN_ANSI
        .iter()
        .find(|(_, c)| *c == code)
        .and_then(|(point, _)| char::from_u32(*point))
        .unwrap_or('?')
}

/// Replace what Helvetica (WinAnsi) cannot encode (`winAnsi`). Line breaks
/// and tabs become one space.
pub fn win_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_break = false;
    for c in text.chars() {
        if matches!(c, '\r' | '\n' | '\t') {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
            continue;
        }
        in_break = false;
        out.push(if code_of(c).is_some() { c } else { '?' });
    }
    out
}

fn encode(text: &str) -> Vec<u8> {
    text.chars().map(|c| code_of(c).unwrap_or(b'?')).collect()
}

/// WinAnsi codes back to text, for reading a drawn string.
pub fn decode_win_ansi(bytes: &[u8]) -> String {
    bytes.iter().map(|b| char_of(*b)).collect()
}

fn kerning(font: &StandardFont, left: u8, right: u8) -> f64 {
    font.kerning
        .binary_search_by_key(&(left, right), |(l, r, _)| (*l, *r))
        .map_or(0.0, |i| f64::from(font.kerning[i].2))
}

/// `font.widthOfTextAtSize(text, size)`: glyph widths plus kerning.
pub(crate) fn width_of_text(font: &StandardFont, text: &str, size: f64) -> f64 {
    let codes = encode(text);
    let mut total = 0.0;
    for (i, code) in codes.iter().enumerate() {
        total += f64::from(font.widths[usize::from(*code)]);
        if let Some(next) = codes.get(i + 1) {
            total += kerning(font, *code, *next);
        }
    }
    total * size / 1000.0
}

/// `font.heightAtSize(size)`: ascender to descender.
fn height_at_size(font: &StandardFont, size: f64) -> f64 {
    f64::from(font.ascender - font.descender) / 1000.0 * size
}

/// `breakTextIntoLines(text, [' '], maxWidth, widthOf)` for text that has no
/// line breaks left (after [`win_ansi`]): words keep their trailing space.
fn break_text_into_lines(
    text: &str,
    max_width: f64,
    font: &StandardFont,
    size: f64,
) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    for c in text.chars() {
        word.push(c);
        if c == ' ' {
            words.push(std::mem::take(&mut word));
        }
    }
    words.push(word);
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut width = 0.0;
    for word in words {
        let w = width_of_text(font, &word, size);
        if width + w > max_width {
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            width = 0.0;
        }
        line.push_str(&word);
        width += w;
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "PDF reals are f32 in lopdf"
)]
fn real(value: f64) -> Object {
    Object::Real(value as f32)
}

/// An RGB colour (`rgb(r, g, b)`).
#[derive(Debug, Clone, Copy)]
struct Rgb(f64, f64, f64);

const INK: Rgb = Rgb(0.07, 0.09, 0.15);
const GREY: Rgb = Rgb(0.42, 0.45, 0.5);
/// pdf-lib's line height on a page that never set one.
const LINE_HEIGHT: f64 = 24.0;

/// `page.drawText(lines…)` as pdf-lib writes it (`drawLinesOfText`).
struct TextRun<'a> {
    font_key: &'a str,
    size: f64,
    color: Rgb,
    x: f64,
    y: f64,
    rotate: i64,
    lines: Vec<String>,
}

fn push_text(ops: &mut Vec<Operation>, run: &TextRun<'_>) {
    #[allow(clippy::cast_precision_loss, reason = "a page rotation in degrees")]
    let angle = (run.rotate as f64).to_radians();
    let (sin, cos) = angle.sin_cos();
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new("BT", vec![]));
    ops.push(Operation::new(
        "rg",
        vec![real(run.color.0), real(run.color.1), real(run.color.2)],
    ));
    ops.push(Operation::new(
        "Tf",
        vec![
            Object::Name(run.font_key.as_bytes().to_vec()),
            real(run.size),
        ],
    ));
    ops.push(Operation::new("TL", vec![real(LINE_HEIGHT)]));
    ops.push(Operation::new(
        "Tm",
        vec![
            real(cos),
            real(sin),
            real(-sin),
            real(cos),
            real(run.x),
            real(run.y),
        ],
    ));
    for line in &run.lines {
        ops.push(Operation::new(
            "Tj",
            vec![Object::String(encode(line), StringFormat::Hexadecimal)],
        ));
        ops.push(Operation::new("T*", vec![]));
    }
    ops.push(Operation::new("ET", vec![]));
    ops.push(Operation::new("Q", vec![]));
}

/// `page.drawLine({ start, end, thickness, color })`.
fn push_line(
    ops: &mut Vec<Operation>,
    start: (f64, f64),
    end: (f64, f64),
    thickness: f64,
    color: Rgb,
) {
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new(
        "RG",
        vec![real(color.0), real(color.1), real(color.2)],
    ));
    ops.push(Operation::new("w", vec![real(thickness)]));
    ops.push(Operation::new(
        "d",
        vec![Object::Array(vec![]), Object::Integer(0)],
    ));
    ops.push(Operation::new("m", vec![real(start.0), real(start.1)]));
    ops.push(Operation::new("l", vec![real(end.0), real(end.1)]));
    ops.push(Operation::new("S", vec![]));
    ops.push(Operation::new("Q", vec![]));
}

/// `page.drawImage(image, { x, y, width, height, rotate })`.
fn push_image(ops: &mut Vec<Operation>, key: &str, at: (f64, f64), size: (f64, f64), rotate: i64) {
    #[allow(clippy::cast_precision_loss, reason = "a page rotation in degrees")]
    let angle = (rotate as f64).to_radians();
    let (sin, cos) = angle.sin_cos();
    let zero = || Object::Integer(0);
    let one = || Object::Integer(1);
    ops.push(Operation::new("q", vec![]));
    ops.push(Operation::new(
        "cm",
        vec![one(), zero(), zero(), one(), real(at.0), real(at.1)],
    ));
    ops.push(Operation::new(
        "cm",
        vec![real(cos), real(sin), real(-sin), real(cos), zero(), zero()],
    ));
    ops.push(Operation::new(
        "cm",
        vec![real(size.0), zero(), zero(), real(size.1), zero(), zero()],
    ));
    ops.push(Operation::new(
        "Do",
        vec![Object::Name(key.as_bytes().to_vec())],
    ));
    ops.push(Operation::new("Q", vec![]));
}

fn font_dictionary(font: &StandardFont) -> Dictionary {
    dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => font.base_font,
        "Encoding" => "WinAnsiEncoding",
    }
}

fn content_stream(ops: Vec<Operation>) -> PdfResult<Stream> {
    let bytes = Content { operations: ops }.encode()?;
    let mut stream = Stream::new(Dictionary::new(), bytes);
    stream.compress()?;
    Ok(stream)
}

// ── Images ─────────────────────────────────────────────────────────────────

/// An embedded PNG: its XObject and pixel size.
struct EmbeddedImage {
    id: ObjectId,
    width: f64,
    height: f64,
}

/// `doc.embedPng(bytes)`: the colour channels as an image XObject, with the
/// alpha channel as its soft mask when the PNG has transparency.
fn embed_png(doc: &mut Document, bytes: &[u8]) -> PdfResult<EmbeddedImage> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info()?;
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| PdfError("png: the image is too large".to_owned()))?;
    let mut buffer = vec![0; size];
    let info = reader.next_frame(&mut buffer)?;
    buffer.truncate(info.buffer_size());
    let (channels, gray) = match info.color_type {
        png::ColorType::Grayscale => (1, true),
        png::ColorType::GrayscaleAlpha => (2, true),
        png::ColorType::Rgb => (3, false),
        png::ColorType::Rgba => (4, false),
        png::ColorType::Indexed => {
            return Err(PdfError("png: palette not expanded".to_owned()));
        }
    };
    let colors = if gray { 1 } else { 3 };
    let has_alpha = channels == 2 || channels == 4;
    let mut color = Vec::with_capacity(buffer.len());
    let mut alpha = Vec::new();
    for pixel in buffer.chunks_exact(channels) {
        color.extend_from_slice(&pixel[..colors]);
        if has_alpha {
            alpha.push(pixel[channels - 1]);
        }
    }
    let mut dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => i64::from(info.width),
        "Height" => i64::from(info.height),
        "ColorSpace" => if gray { "DeviceGray" } else { "DeviceRGB" },
        "BitsPerComponent" => 8,
    };
    if has_alpha && alpha.iter().any(|a| *a != 255) {
        let mut mask = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => i64::from(info.width),
                "Height" => i64::from(info.height),
                "ColorSpace" => "DeviceGray",
                "BitsPerComponent" => 8,
            },
            alpha,
        );
        mask.compress()?;
        let mask_id = doc.add_object(mask);
        dict.set("SMask", Object::Reference(mask_id));
    }
    let mut stream = Stream::new(dict, color);
    stream.compress()?;
    Ok(EmbeddedImage {
        id: doc.add_object(stream),
        width: f64::from(info.width),
        height: f64::from(info.height),
    })
}

// ── Pages ──────────────────────────────────────────────────────────────────

/// An attribute of a page or the nearest page-tree node above it.
fn inherited(doc: &Document, page: ObjectId, key: &[u8]) -> Option<Object> {
    let mut node = doc.get_dictionary(page).ok()?;
    for _ in 0..64 {
        if let Ok(value) = node.get(key) {
            return Some(resolve(doc, value).clone());
        }
        let parent = node.get(b"Parent").ok()?.as_reference().ok()?;
        node = doc.get_dictionary(parent).ok()?;
    }
    None
}

fn resolve<'a>(doc: &'a Document, object: &'a Object) -> &'a Object {
    match object {
        Object::Reference(id) => doc.get_object(*id).unwrap_or(object),
        _ => object,
    }
}

fn number(doc: &Document, object: &Object) -> Option<f64> {
    match resolve(doc, object) {
        Object::Integer(n) =>
        {
            #[allow(clippy::cast_precision_loss, reason = "page coordinates")]
            Some(*n as f64)
        }
        Object::Real(n) => Some(f64::from(*n)),
        _ => None,
    }
}

fn rectangle(doc: &Document, object: &Object) -> Option<Rect> {
    let Object::Array(values) = resolve(doc, object) else {
        return None;
    };
    let n: Vec<f64> = values.iter().filter_map(|v| number(doc, v)).collect();
    (n.len() == 4).then(|| Rect {
        x: n[0],
        y: n[1],
        width: n[2] - n[0],
        height: n[3] - n[1],
    })
}

/// `page.getCropBox()`: the crop box, else the media box.
fn crop_box(doc: &Document, page: ObjectId) -> Rect {
    inherited(doc, page, b"CropBox")
        .and_then(|b| rectangle(doc, &b))
        .or_else(|| inherited(doc, page, b"MediaBox").and_then(|b| rectangle(doc, &b)))
        .unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 612.0,
            height: 792.0,
        })
}

/// `page.getRotation().angle`.
fn rotation(doc: &Document, page: ObjectId) -> i64 {
    inherited(doc, page, b"Rotate")
        .and_then(|r| match r {
            Object::Integer(n) => Some(n),
            #[allow(clippy::cast_possible_truncation, reason = "a rotation in degrees")]
            Object::Real(n) => Some(n.round() as i64),
            _ => None,
        })
        .unwrap_or(0)
}

/// A sub-dictionary of `resources` (`/Font`, `/XObject`), resolved and copied.
fn sub_dictionary(doc: &Document, resources: &Dictionary, key: &[u8]) -> Dictionary {
    resources
        .get(key)
        .ok()
        .map(|value| resolve(doc, value))
        .and_then(|value| value.as_dict().ok())
        .cloned()
        .unwrap_or_default()
}

/// A resource name not in `taken`.
fn free_name(taken: &Dictionary, base: &str) -> String {
    let mut n = 1;
    loop {
        let name = format!("{base}{n}");
        if !taken.has(name.as_bytes()) {
            return name;
        }
        n += 1;
    }
}

/// What one page gets drawn on it.
#[derive(Default)]
struct PageDrawing {
    ops: Vec<Operation>,
    images: Vec<(String, ObjectId)>,
}

/// Add `drawing` to `page`: its resources become the page's own (copied
/// from wherever it inherited them), and its content is appended after the
/// page's own, which is wrapped in `q … Q` so its graphics state can't leak.
fn apply_drawing(
    doc: &mut Document,
    page: ObjectId,
    font: Option<(String, ObjectId)>,
    drawing: PageDrawing,
) -> PdfResult<()> {
    let resources = inherited(doc, page, b"Resources")
        .and_then(|r| r.as_dict().ok().cloned())
        .unwrap_or_default();
    let mut fonts = sub_dictionary(doc, &resources, b"Font");
    let mut xobjects = sub_dictionary(doc, &resources, b"XObject");
    let mut resources = resources;
    if let Some((key, id)) = font {
        fonts.set(key, Object::Reference(id));
    }
    for (key, id) in drawing.images {
        xobjects.set(key, Object::Reference(id));
    }
    resources.set("Font", Object::Dictionary(fonts));
    resources.set("XObject", Object::Dictionary(xobjects));

    let existing = doc.get_dictionary(page)?.get(b"Contents").ok().cloned();
    let mut contents = Vec::new();
    match existing.map(|c| match c {
        Object::Reference(id) => match doc.get_object(id) {
            Ok(Object::Array(items)) => Object::Array(items.clone()),
            _ => Object::Reference(id),
        },
        other => other,
    }) {
        Some(Object::Array(items)) if !items.is_empty() => contents = items,
        Some(Object::Reference(id)) => contents.push(Object::Reference(id)),
        _ => {}
    }
    if !contents.is_empty() {
        let open = doc.add_object(Stream::new(Dictionary::new(), b"q".to_vec()));
        let close = doc.add_object(Stream::new(Dictionary::new(), b"Q".to_vec()));
        contents.insert(0, Object::Reference(open));
        contents.push(Object::Reference(close));
    }
    let drawn = doc.add_object(content_stream(drawing.ops)?);
    contents.push(Object::Reference(drawn));

    let dict = doc.get_dictionary_mut(page)?;
    dict.set("Resources", Object::Dictionary(resources));
    dict.set("Contents", Object::Array(contents));
    Ok(())
}

fn draw_text_field(ops: &mut Vec<Operation>, font_key: &str, field: &RenderField, p: Placement) {
    let font = &HELVETICA;
    let text = win_ansi(field.value.as_deref().unwrap_or_default());
    if text.is_empty() {
        return;
    }
    let mut size = (field.height * 0.7).min(14.0);
    let max_width = field.width - 4.0;
    while size > 5.0 && width_of_text(font, &text, size) > max_width {
        size -= 0.5;
    }
    // Vertically centred, 2pt in from the left.
    let height = height_at_size(font, size);
    let dy = (field.height - height) / 2.0 + height * 0.2;
    let at = offset(p, 2.0, dy.max(0.0));
    push_text(
        ops,
        &TextRun {
            font_key,
            size,
            color: INK,
            x: at.0,
            y: at.1,
            rotate: p.rotate,
            lines: break_text_into_lines(&text, max_width, font, size),
        },
    );
}

fn draw_checkbox(ops: &mut Vec<Operation>, field: &RenderField, p: Placement) {
    if field.value.as_deref() != Some("true") {
        return;
    }
    // A check mark from two strokes, scaled to the box.
    let (width, height) = (field.width, field.height);
    let start = offset(p, width * 0.2, height * 0.5);
    let corner = offset(p, width * 0.42, height * 0.22);
    let end = offset(p, width * 0.82, height * 0.82);
    let thickness = (width.min(height) * 0.12).max(1.0);
    push_line(ops, start, corner, thickness, INK);
    push_line(ops, corner, end, thickness, INK);
}

/// Draw `fields` into `doc`, in place (`drawFields`).
pub fn draw_fields(doc: &mut Document, fields: &[RenderField]) -> PdfResult<()> {
    if fields.is_empty() {
        return Ok(());
    }
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    let font_id = doc.add_object(font_dictionary(&HELVETICA));
    let mut drawings: BTreeMap<usize, PageDrawing> = BTreeMap::new();
    let mut font_keys: BTreeMap<usize, String> = BTreeMap::new();
    for field in fields {
        let Some(&page) = pages.get(field.page) else {
            continue;
        };
        let rect = Rect {
            x: field.x,
            y: field.y,
            width: field.width,
            height: field.height,
        };
        let p = place_box(rect, crop_box(doc, page), rotation(doc, page));
        let font_key = font_keys
            .entry(field.page)
            .or_insert_with(|| {
                let resources = inherited(doc, page, b"Resources")
                    .and_then(|r| r.as_dict().ok().cloned())
                    .unwrap_or_default();
                free_name(&sub_dictionary(doc, &resources, b"Font"), "WSHelv")
            })
            .clone();
        match field.kind.as_str() {
            "signature" | "initials" => {
                let Some(bytes) = &field.image else {
                    continue;
                };
                let image = embed_png(doc, bytes)?;
                // Fit inside the box, keeping the image's proportions, centred.
                let scale = (field.width / image.width).min(field.height / image.height);
                let (w, h) = (image.width * scale, image.height * scale);
                let at = offset(p, (field.width - w) / 2.0, (field.height - h) / 2.0);
                let drawing = drawings.entry(field.page).or_default();
                let key = format!("WSImg{}", drawing.images.len() + 1);
                push_image(&mut drawing.ops, &key, at, (w, h), p.rotate);
                drawing.images.push((key, image.id));
            }
            "checkbox" => draw_checkbox(&mut drawings.entry(field.page).or_default().ops, field, p),
            _ => draw_text_field(
                &mut drawings.entry(field.page).or_default().ops,
                &font_key,
                field,
                p,
            ),
        }
    }
    for (index, drawing) in drawings {
        let font = font_keys.get(&index).map(|key| (key.clone(), font_id));
        apply_drawing(doc, pages[index], font, drawing)?;
    }
    Ok(())
}

/// A document with `fields` drawn in, as new PDF bytes (`flattenDocument`).
pub fn flatten_document(original: &[u8], fields: &[RenderField]) -> PdfResult<Vec<u8>> {
    let mut doc = Document::load_mem(original)?;
    draw_fields(&mut doc, fields)?;
    let mut out = Vec::new();
    doc.save_to(&mut out)?;
    Ok(out)
}

// ── The signed document ────────────────────────────────────────────────────

/// Point every reference in `object` at its new number.
fn rewrite(object: &mut Object, mapping: &BTreeMap<ObjectId, ObjectId>) {
    match object {
        Object::Reference(id) => {
            if let Some(new) = mapping.get(id) {
                *id = *new;
            }
        }
        Object::Array(items) => items.iter_mut().for_each(|item| rewrite(item, mapping)),
        Object::Dictionary(dict) => dict.iter_mut().for_each(|(_, v)| rewrite(v, mapping)),
        Object::Stream(stream) => stream
            .dict
            .iter_mut()
            .for_each(|(_, v)| rewrite(v, mapping)),
        _ => {}
    }
}

/// Gives every object of `objects` a new number from `next`, references
/// included; returns the mapping.
fn renumber(
    objects: &mut BTreeMap<ObjectId, Object>,
    next: &mut u32,
) -> BTreeMap<ObjectId, ObjectId> {
    let mapping: BTreeMap<ObjectId, ObjectId> = objects
        .keys()
        .map(|old| {
            let new = (*next, 0);
            *next += 1;
            (*old, new)
        })
        .collect();
    let old = std::mem::take(objects);
    for (id, mut object) in old {
        rewrite(&mut object, &mapping);
        objects.insert(mapping[&id], object);
    }
    mapping
}

/// A new PDF that pages are copied into (`PDFDocument.create()` and
/// `copyPages`), then saved with a title.
pub struct OutputPdf {
    doc: Document,
    pages_id: ObjectId,
    kids: Vec<ObjectId>,
}

impl Default for OutputPdf {
    fn default() -> Self {
        Self::new()
    }
}

impl OutputPdf {
    pub fn new() -> Self {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        Self {
            doc,
            pages_id,
            kids: Vec::new(),
        }
    }

    /// Copy every page of `source` (`out.copyPages(pdf, pdf.getPageIndices())`
    /// and `addPage`). Inherited page attributes are copied onto each page.
    pub fn append_document(&mut self, mut source: Document) -> PdfResult<()> {
        let pages: Vec<ObjectId> = source.get_pages().into_values().collect();
        for page in &pages {
            for key in [&b"Resources"[..], b"MediaBox", b"CropBox", b"Rotate"] {
                let own = source.get_dictionary(*page).is_ok_and(|dict| dict.has(key));
                if !own && let Some(value) = inherited(&source, *page, key) {
                    source.get_dictionary_mut(*page)?.set(key.to_vec(), value);
                }
            }
        }
        // Everything but the source's catalog and page tree comes along.
        let skip: Vec<ObjectId> = source
            .objects
            .iter()
            .filter(|(_, object)| {
                object
                    .as_dict()
                    .ok()
                    .and_then(|d| d.get(b"Type").ok())
                    .and_then(|t| t.as_name().ok())
                    .is_some_and(|t| t == b"Catalog" || t == b"Pages")
            })
            .map(|(id, _)| *id)
            .collect();
        for id in skip {
            source.objects.remove(&id);
        }
        let mut next = self.doc.max_id + 1;
        let mapping = renumber(&mut source.objects, &mut next);
        self.doc.max_id = next - 1;
        for page in pages {
            let Some(new) = mapping.get(&page) else {
                continue;
            };
            if let Some(Object::Dictionary(dict)) = source.objects.get_mut(new) {
                dict.set("Parent", Object::Reference(self.pages_id));
            }
            self.kids.push(*new);
        }
        self.doc.objects.append(&mut source.objects);
        Ok(())
    }

    /// Add a page drawn with `ops`, using `fonts` (resource name → font).
    fn add_page(
        &mut self,
        size: (f64, f64),
        fonts: &[(&str, ObjectId)],
        ops: Vec<Operation>,
    ) -> PdfResult<()> {
        let mut font_dict = Dictionary::new();
        for (key, id) in fonts {
            font_dict.set(*key, Object::Reference(*id));
        }
        let contents = self.doc.add_object(content_stream(ops)?);
        let page = self.doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => self.pages_id,
            "MediaBox" => vec![0.into(), 0.into(), real(size.0), real(size.1)],
            "Resources" => dictionary! { "Font" => font_dict },
            "Contents" => contents,
        });
        self.kids.push(page);
        Ok(())
    }

    fn add_font(&mut self, font: &StandardFont) -> ObjectId {
        self.doc.add_object(font_dictionary(font))
    }

    pub fn page_count(&self) -> usize {
        self.kids.len()
    }

    /// The saved bytes, titled `title`, producer `WeldSign`.
    pub fn finish(mut self, title: &str) -> PdfResult<Vec<u8>> {
        let kids: Vec<Object> = self.kids.iter().map(|id| Object::Reference(*id)).collect();
        let count = i64::try_from(kids.len()).unwrap_or(i64::MAX);
        self.doc.objects.insert(
            self.pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => count,
            }),
        );
        let catalog = self.doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => self.pages_id,
        });
        let info = self.doc.add_object(dictionary! {
            "Title" => Object::String(utf16_text(title), StringFormat::Hexadecimal),
            "Producer" => Object::string_literal("WeldSign"),
            "Creator" => Object::string_literal("WeldSign"),
        });
        self.doc.trailer.set("Root", catalog);
        self.doc.trailer.set("Info", info);
        self.doc.prune_objects();
        let mut out = Vec::new();
        self.doc.save_to(&mut out)?;
        Ok(out)
    }
}

/// A text string as UTF-16BE with its byte order mark.
fn utf16_text(text: &str) -> Vec<u8> {
    let mut out = vec![0xFE, 0xFF];
    for unit in text.encode_utf16() {
        out.extend_from_slice(&unit.to_be_bytes());
    }
    out
}

// ── Certificate of completion ──────────────────────────────────────────────

/// One recipient on the certificate (`CertificateRecipient`). Times are
/// ISO strings.
#[derive(Debug, Clone, Default)]
pub struct CertificateRecipient {
    pub name: Option<String>,
    pub email: Option<String>,
    /// `signer` or `cc`.
    pub role: String,
    pub auth_mode: String,
    pub signature_kind: Option<String>,
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub sent_at: Option<String>,
    pub opened_at: Option<String>,
    pub consented_at: Option<String>,
    pub signed_at: Option<String>,
}

/// One document on the certificate.
#[derive(Debug, Clone, Default)]
pub struct CertificateDocument {
    pub name: String,
    pub page_count: i64,
    pub sha256: String,
}

/// What the certificate shows (`CertificateInput`).
#[derive(Debug, Clone, Default)]
pub struct CertificateInput {
    pub envelope_id: String,
    pub title: String,
    pub sender_name: Option<String>,
    pub sender_email: Option<String>,
    pub workspace_name: String,
    pub sent_at: Option<String>,
    pub completed_at: String,
    pub documents: Vec<CertificateDocument>,
    pub recipients: Vec<CertificateRecipient>,
    pub disclosure_version: String,
}

/// `utc(d)`: `2026-11-02 09:00:00 UTC`, or `-`.
fn utc(at: Option<&str>) -> String {
    match at {
        Some(at) if at.len() >= 19 => format!("{} UTC", at[..19].replacen('T', " ", 1)),
        _ => "-".to_owned(),
    }
}

/// `text.slice(0, n)` in UTF-16 units.
fn utf16_prefix(text: &str, units: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        used += c.len_utf16();
        if used > units {
            break;
        }
        out.push(c);
    }
    out
}

fn auth_label(mode: &str) -> String {
    match mode {
        "link" => "Email link".to_owned(),
        "email_code" => "Email link and one-time code".to_owned(),
        "access_code" => "Email link and access code".to_owned(),
        other => other.to_owned(),
    }
}

const PAGE: (f64, f64) = (595.28, 841.89);
const MARGIN: f64 = 50.0;

/// The certificate's pen: the current page, where it is, and the fonts.
struct Pen<'a> {
    out: &'a mut OutputPdf,
    fonts: [(&'static str, ObjectId); 3],
    ops: Vec<Operation>,
    y: f64,
}

impl Pen<'_> {
    const REGULAR: &'static str = "F1";
    const BOLD: &'static str = "F2";
    const MONO: &'static str = "F3";

    fn font_of(key: &str) -> &'static StandardFont {
        match key {
            Self::BOLD => &HELVETICA_BOLD,
            Self::MONO => &COURIER,
            _ => &HELVETICA,
        }
    }

    fn new_page(&mut self) -> PdfResult<()> {
        let ops = std::mem::take(&mut self.ops);
        let fonts = self.fonts;
        self.out.add_page(PAGE, &fonts, ops)?;
        self.y = PAGE.1 - MARGIN;
        Ok(())
    }

    fn ensure(&mut self, needed: f64) -> PdfResult<()> {
        if self.y - needed < MARGIN {
            self.new_page()?;
        }
        Ok(())
    }

    /// `line(text, { size, f, color, gap })`.
    fn line(
        &mut self,
        text: &str,
        size: f64,
        key: &'static str,
        color: Rgb,
        gap: f64,
    ) -> PdfResult<()> {
        self.ensure(size + 4.0)?;
        let font = Self::font_of(key);
        let text = win_ansi(text);
        let lines = break_text_into_lines(&text, PAGE.0 - 2.0 * MARGIN, font, size);
        push_text(
            &mut self.ops,
            &TextRun {
                font_key: key,
                size,
                color,
                x: MARGIN,
                y: self.y - size,
                rotate: 0,
                lines,
            },
        );
        self.y -= size + gap;
        Ok(())
    }

    /// `row(label, value)`.
    fn row(&mut self, label: &str, value: &str) -> PdfResult<()> {
        self.ensure(13.0)?;
        let label = win_ansi(label);
        push_text(
            &mut self.ops,
            &TextRun {
                font_key: Self::REGULAR,
                size: 9.0,
                color: GREY,
                x: MARGIN,
                y: self.y - 9.0,
                rotate: 0,
                lines: vec![label],
            },
        );
        let value = win_ansi(value);
        let lines = break_text_into_lines(&value, PAGE.0 - 2.0 * MARGIN - 130.0, &HELVETICA, 9.0);
        push_text(
            &mut self.ops,
            &TextRun {
                font_key: Self::REGULAR,
                size: 9.0,
                color: INK,
                x: MARGIN + 130.0,
                y: self.y - 9.0,
                rotate: 0,
                lines,
            },
        );
        self.y -= 13.0;
        Ok(())
    }

    /// `rule()`.
    fn rule(&mut self) -> PdfResult<()> {
        self.ensure(12.0)?;
        push_line(
            &mut self.ops,
            (MARGIN, self.y - 4.0),
            (PAGE.0 - MARGIN, self.y - 4.0),
            0.5,
            Rgb(0.85, 0.86, 0.88),
        );
        self.y -= 12.0;
        Ok(())
    }
}

/// One recipient on the certificate: name, role, and for a signer how they
/// were identified and when they signed.
fn recipient_block(pen: &mut Pen<'_>, r: &CertificateRecipient) -> PdfResult<()> {
    pen.ensure(110.0)?;
    let address = match (&r.email, &r.name) {
        (Some(email), Some(name)) if !email.is_empty() && !name.is_empty() => {
            format!(" <{email}>")
        }
        _ => String::new(),
    };
    let who = r
        .name
        .clone()
        .or_else(|| r.email.clone())
        .unwrap_or_else(|| "-".to_owned());
    pen.line(&format!("{who}{address}"), 10.0, Pen::BOLD, INK, 4.0)?;
    let role = if r.role == "signer" {
        "Signer"
    } else {
        "Receives a copy"
    };
    pen.row("Role", role)?;
    if r.role == "signer" {
        pen.row("Identity check", &auth_label(&r.auth_mode))?;
        let signature = match r.signature_kind.as_deref().filter(|k| !k.is_empty()) {
            Some(kind) => {
                let mut chars = kind.chars();
                let first: String = chars
                    .next()
                    .map(|c| c.to_uppercase().collect())
                    .unwrap_or_default();
                format!("{first}{}", chars.as_str())
            }
            None => "-".to_owned(),
        };
        pen.row("Signature", &signature)?;
        pen.row("Sent", &utc(r.sent_at.as_deref()))?;
        pen.row("Opened", &utc(r.opened_at.as_deref()))?;
        pen.row(
            "Agreed to sign electronically",
            &utc(r.consented_at.as_deref()),
        )?;
        pen.row("Signed", &utc(r.signed_at.as_deref()))?;
        pen.row("IP address", r.ip.as_deref().unwrap_or("-"))?;
        pen.row(
            "Browser",
            &utf16_prefix(r.user_agent.as_deref().unwrap_or("-"), 110),
        )?;
    }
    Ok(())
}

/// Append the certificate page(s) (`appendCertificate`).
pub fn append_certificate(out: &mut OutputPdf, input: &CertificateInput) -> PdfResult<()> {
    let fonts = [
        (Pen::REGULAR, out.add_font(&HELVETICA)),
        (Pen::BOLD, out.add_font(&HELVETICA_BOLD)),
        (Pen::MONO, out.add_font(&COURIER)),
    ];
    let mut pen = Pen {
        out,
        fonts,
        ops: Vec::new(),
        y: PAGE.1 - MARGIN,
    };
    pen.line("Certificate of completion", 18.0, Pen::BOLD, INK, 6.0)?;
    pen.line(
        &format!(
            "Electronic signatures by WeldSign for {}",
            input.workspace_name
        ),
        9.0,
        Pen::REGULAR,
        GREY,
        14.0,
    )?;

    pen.row("Request", &input.title)?;
    pen.row("Request id", &input.envelope_id)?;
    let sender: Vec<String> = [
        input.sender_name.clone().filter(|n| !n.is_empty()),
        input
            .sender_email
            .as_deref()
            .filter(|e| !e.is_empty())
            .map(|e| format!("<{e}>")),
    ]
    .into_iter()
    .flatten()
    .collect();
    let sender = sender.join(" ");
    pen.row("Sent by", if sender.is_empty() { "-" } else { &sender })?;
    pen.row("Sent", &utc(input.sent_at.as_deref()))?;
    pen.row("Completed", &utc(Some(&input.completed_at)))?;
    pen.row("Disclosure version", &input.disclosure_version)?;
    pen.rule()?;

    pen.line("Documents", 11.0, Pen::BOLD, INK, 6.0)?;
    for document in &input.documents {
        let plural = if document.page_count == 1 { "" } else { "s" };
        pen.line(
            &format!("{} ({} page{plural})", document.name, document.page_count),
            9.0,
            Pen::REGULAR,
            INK,
            2.0,
        )?;
        pen.line(
            &format!("SHA-256 of the original: {}", document.sha256),
            7.5,
            Pen::MONO,
            Rgb(0.3, 0.32, 0.36),
            8.0,
        )?;
    }
    pen.rule()?;

    pen.line("Recipients", 11.0, Pen::BOLD, INK, 6.0)?;
    for r in &input.recipients {
        recipient_block(&mut pen, r)?;
        pen.y -= 6.0;
    }
    pen.rule()?;
    pen.line(
        "The SHA-256 fingerprint of this complete file is recorded by WeldSign when it is created; compare it to check that the file has not been changed since.",
        7.5,
        Pen::REGULAR,
        GREY,
        4.0,
    )?;
    pen.new_page()
}

// ── Reading a drawn PDF (tests, and a check anyone can run) ────────────────

/// What a page draws, as far as these files go: text runs (decoded, with
/// their font, size and origin), images and lines, in page space.
#[derive(Debug, Clone, PartialEq)]
pub enum Drawn {
    Text {
        font: String,
        size: f64,
        x: f64,
        y: f64,
        text: String,
    },
    Image {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
    Line {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        width: f64,
    },
}

type Matrix = [f64; 6];

fn multiply(a: &Matrix, b: &Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn apply(m: &Matrix, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

fn operand_numbers(operation: &Operation) -> Vec<f64> {
    operation
        .operands
        .iter()
        .filter_map(|o| match o {
            Object::Integer(n) =>
            {
                #[allow(clippy::cast_precision_loss, reason = "page coordinates")]
                Some(*n as f64)
            }
            Object::Real(n) => Some(f64::from(*n)),
            _ => None,
        })
        .collect()
}

/// Everything page `index` (0-based) of `bytes` draws.
pub fn drawn_on_pages(bytes: &[u8]) -> PdfResult<Vec<Vec<Drawn>>> {
    let doc = Document::load_mem(bytes)?;
    let mut pages = Vec::new();
    for page in doc.get_pages().into_values() {
        let content = Content::decode(&doc.get_page_content(page))?;
        let resources = inherited(&doc, page, b"Resources")
            .and_then(|r| r.as_dict().ok().cloned())
            .unwrap_or_default();
        let fonts = sub_dictionary(&doc, &resources, b"Font");
        let base_font = |key: &[u8]| -> String {
            fonts
                .get(key)
                .ok()
                .map(|f| resolve(&doc, f))
                .and_then(|f| f.as_dict().ok())
                .and_then(|f| f.get(b"BaseFont").ok())
                .and_then(|n| n.as_name().ok())
                .map(|n| String::from_utf8_lossy(n).into_owned())
                .unwrap_or_default()
        };
        let mut drawn = Vec::new();
        let identity: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let mut ctm = identity;
        let mut stack = Vec::new();
        let (mut tm, mut font, mut size, mut leading, mut width) =
            (identity, String::new(), 0.0, 0.0, 1.0);
        let mut path_start = (0.0, 0.0);
        let mut segments = Vec::new();
        for op in &content.operations {
            let n = operand_numbers(op);
            match op.operator.as_str() {
                "q" => stack.push((ctm, width)),
                "Q" => (ctm, width) = stack.pop().unwrap_or((identity, 1.0)),
                "cm" if n.len() == 6 => {
                    ctm = multiply(&[n[0], n[1], n[2], n[3], n[4], n[5]], &ctm);
                }
                "w" if n.len() == 1 => width = n[0],
                "BT" => tm = identity,
                "Tf" => {
                    if let Some(Object::Name(key)) = op.operands.first() {
                        font = base_font(key);
                    }
                    size = n.first().copied().unwrap_or(0.0);
                }
                "TL" if n.len() == 1 => leading = n[0],
                "Tm" if n.len() == 6 => tm = [n[0], n[1], n[2], n[3], n[4], n[5]],
                "T*" => tm = multiply(&[1.0, 0.0, 0.0, 1.0, 0.0, -leading], &tm),
                "Tj" => {
                    if let Some(Object::String(bytes, _)) = op.operands.first() {
                        let (x, y) = apply(&multiply(&tm, &ctm), 0.0, 0.0);
                        drawn.push(Drawn::Text {
                            font: font.clone(),
                            size,
                            x,
                            y,
                            text: decode_win_ansi(bytes),
                        });
                    }
                }
                "Do" => {
                    let (x, y) = apply(&ctm, 0.0, 0.0);
                    let (x1, y1) = apply(&ctm, 1.0, 1.0);
                    drawn.push(Drawn::Image {
                        x: x.min(x1),
                        y: y.min(y1),
                        width: (x1 - x).abs(),
                        height: (y1 - y).abs(),
                    });
                }
                "m" if n.len() == 2 => path_start = apply(&ctm, n[0], n[1]),
                "l" if n.len() == 2 => {
                    let end = apply(&ctm, n[0], n[1]);
                    segments.push((path_start, end));
                    path_start = end;
                }
                "S" => {
                    for (a, b) in segments.drain(..) {
                        drawn.push(Drawn::Line {
                            x1: a.0,
                            y1: a.1,
                            x2: b.0,
                            y2: b.1,
                            width,
                        });
                    }
                }
                _ => {}
            }
        }
        pages.push(drawn);
    }
    Ok(pages)
}

/// The text a page shows, line by line, as [`drawn_on_pages`] reads it.
pub fn text_of(drawn: &[Drawn]) -> Vec<String> {
    drawn
        .iter()
        .filter_map(|d| match d {
            Drawn::Text { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

/// A short description of what is drawn, for test output.
pub fn describe(drawn: &[Drawn]) -> String {
    let mut out = String::new();
    for d in drawn {
        let _ = writeln!(out, "{d:?}");
    }
    out
}

#[cfg(test)]
mod tests;
