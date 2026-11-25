//! PDF incremental revisions (ISO 32000 §7.5.6): what a signer, the seal,
//! the DSS and a document timestamp append to a file without touching what
//! is already signed.
//!
//! A [`Revision`] opens the bytes so far, collects new and changed objects,
//! and writes them after the old bytes with their own cross-reference
//! section and a trailer pointing back (`/Prev`). [`Revision::sign`] adds a
//! signature dictionary whose `/Contents` is a zero-filled placeholder; the
//! digest of everything outside it is what gets signed, and
//! [`Prepared::embed`] writes the CMS into the placeholder.
//!
//! WeldSign only appends to files it wrote itself (classic cross-reference
//! tables), so every update writes a classic table too.

use std::collections::BTreeMap;
use std::fmt;
use std::fmt::Write as _;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat, dictionary};
use time::OffsetDateTime;

use crate::crypto::Hash;
use crate::der;

/// Why a PDF could not be read or written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfError(pub String);

impl fmt::Display for PdfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "pdf: {}", self.0)
    }
}

impl std::error::Error for PdfError {}

impl From<lopdf::Error> for PdfError {
    fn from(error: lopdf::Error) -> Self {
        Self(error.to_string())
    }
}

pub type PdfResult<T> = Result<T, PdfError>;

fn bad(message: impl Into<String>) -> PdfError {
    PdfError(message.into())
}

/// Something objects can be added to: a whole document or a revision.
pub trait ObjectSink {
    fn add_object(&mut self, object: Object) -> ObjectId;
}

impl ObjectSink for Document {
    fn add_object(&mut self, object: Object) -> ObjectId {
        Document::add_object(self, object)
    }
}

// ── Writing objects ────────────────────────────────────────────────────────

fn write_name(out: &mut Vec<u8>, name: &[u8]) {
    out.push(b'/');
    for &byte in name {
        if b" \t\n\r\x0C()<>[]{}/%#".contains(&byte) || !(33..=126).contains(&byte) {
            let _ = write!(Hex(out), "#{byte:02X}");
        } else {
            out.push(byte);
        }
    }
}

/// `fmt::Write` into a byte buffer.
struct Hex<'a>(&'a mut Vec<u8>);

impl fmt::Write for Hex<'_> {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        self.0.extend_from_slice(s.as_bytes());
        Ok(())
    }
}

fn write_string(out: &mut Vec<u8>, bytes: &[u8], format: StringFormat) {
    match format {
        StringFormat::Literal => {
            out.push(b'(');
            for &byte in bytes {
                match byte {
                    b'(' | b')' | b'\\' => {
                        out.push(b'\\');
                        out.push(byte);
                    }
                    b'\r' => out.extend_from_slice(b"\\r"),
                    b'\n' => out.extend_from_slice(b"\\n"),
                    _ => out.push(byte),
                }
            }
            out.push(b')');
        }
        StringFormat::Hexadecimal => {
            out.push(b'<');
            for byte in bytes {
                let _ = write!(Hex(out), "{byte:02X}");
            }
            out.push(b'>');
        }
    }
}

/// An object in PDF syntax.
pub fn write_object(out: &mut Vec<u8>, object: &Object) {
    match object {
        Object::Null => out.extend_from_slice(b"null"),
        Object::Boolean(value) => out.extend_from_slice(if *value { b"true" } else { b"false" }),
        Object::Integer(value) => {
            let _ = write!(Hex(out), "{value}");
        }
        Object::Real(value) => {
            let _ = write!(Hex(out), "{value}");
        }
        Object::Name(name) => write_name(out, name),
        Object::String(bytes, format) => write_string(out, bytes, *format),
        Object::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b' ');
                }
                write_object(out, item);
            }
            out.push(b']');
        }
        Object::Dictionary(dict) => write_dictionary(out, dict),
        Object::Stream(stream) => {
            let mut dict = stream.dict.clone();
            dict.set(
                "Length",
                Object::Integer(i64::try_from(stream.content.len()).unwrap_or(i64::MAX)),
            );
            write_dictionary(out, &dict);
            out.extend_from_slice(b"\nstream\n");
            out.extend_from_slice(&stream.content);
            out.extend_from_slice(b"\nendstream");
        }
        Object::Reference(id) => {
            let _ = write!(Hex(out), "{} {} R", id.0, id.1);
        }
    }
}

fn write_dictionary(out: &mut Vec<u8>, dict: &Dictionary) {
    out.extend_from_slice(b"<<");
    for (key, value) in dict {
        write_name(out, key);
        out.push(b' ');
        write_object(out, value);
        out.push(b'\n');
    }
    out.extend_from_slice(b">>");
}

/// A text string: plain when ASCII, else UTF-16BE with its byte order mark.
pub fn text_string(text: &str) -> Object {
    if text.bytes().all(|b| (0x20..0x7F).contains(&b)) {
        Object::String(text.as_bytes().to_vec(), StringFormat::Literal)
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        Object::String(bytes, StringFormat::Hexadecimal)
    }
}

/// A PDF date, `D:YYYYMMDDHHmmSSZ`.
pub fn pdf_date(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    format!(
        "D:{:04}{:02}{:02}{:02}{:02}{:02}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second()
    )
}

/// Where the previous cross-reference section starts: the number after the
/// last `startxref`.
fn last_startxref(bytes: &[u8]) -> PdfResult<usize> {
    let needle = b"startxref";
    let at = bytes
        .windows(needle.len())
        .rposition(|w| w == needle)
        .ok_or_else(|| bad("no startxref"))?;
    let digits: String = bytes[at + needle.len()..]
        .iter()
        .skip_while(|b| b.is_ascii_whitespace())
        .take_while(|b| b.is_ascii_digit())
        .map(|b| char::from(*b))
        .collect();
    digits.parse().map_err(|_| bad("startxref has no offset"))
}

// ── Revisions ──────────────────────────────────────────────────────────────

/// An object to write: a lopdf object or bytes already in PDF syntax.
#[derive(Debug, Clone)]
enum Body {
    Object(Object),
    Raw(Vec<u8>),
}

/// Kinds of form field WeldSign puts in a prepared PDF.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    Text,
    Checkbox,
    Signature,
}

/// What [`Revision::sign`] adds.
#[derive(Debug, Clone)]
pub enum SignatureKind {
    /// A CAdES signature (`ETSI.CAdES.detached`): a signer or a seal.
    Cades {
        name: Option<String>,
        reason: Option<String>,
        location: Option<String>,
        signing_time: OffsetDateTime,
    },
    /// A document timestamp (`ETSI.RFC3161`).
    DocumentTimestamp,
}

/// A signature to add.
#[derive(Debug, Clone)]
pub struct SignatureSpec {
    /// The field's name (`/T`); a new invisible field unless `field` is given.
    pub field_name: String,
    /// An empty signature field made earlier ([`Revision::add_form_field`]).
    pub field: Option<ObjectId>,
    pub kind: SignatureKind,
    /// Bytes reserved for the CMS (the hex placeholder is twice as long).
    pub contents_size: usize,
}

/// A PDF being appended to.
pub struct Revision {
    base: Vec<u8>,
    doc: Document,
    bodies: BTreeMap<ObjectId, Body>,
    next: u32,
}

impl ObjectSink for Revision {
    fn add_object(&mut self, object: Object) -> ObjectId {
        self.add(object)
    }
}

/// The `ByteRange` placeholder: four ten-digit numbers.
const BYTE_RANGE_PLACEHOLDER: &str = "0000000000 0000000000 0000000000 0000000000";

impl Revision {
    pub fn open(base: Vec<u8>) -> PdfResult<Self> {
        let doc = Document::load_mem(&base)?;
        let next = doc.max_id + 1;
        Ok(Self {
            base,
            doc,
            bodies: BTreeMap::new(),
            next,
        })
    }

    /// The document as it was before this revision.
    pub fn document(&self) -> &Document {
        &self.doc
    }

    pub fn add(&mut self, object: Object) -> ObjectId {
        let id = (self.next, 0);
        self.next += 1;
        self.bodies.insert(id, Body::Object(object));
        id
    }

    pub fn set(&mut self, id: ObjectId, object: Object) {
        self.bodies.insert(id, Body::Object(object));
    }

    /// An object as this revision has it.
    pub fn object(&self, id: ObjectId) -> PdfResult<Object> {
        match self.bodies.get(&id) {
            Some(Body::Object(object)) => Ok(object.clone()),
            Some(Body::Raw(_)) => Err(bad("object written as raw bytes")),
            None => Ok(self.doc.get_object(id)?.clone()),
        }
    }

    pub fn dictionary(&self, id: ObjectId) -> PdfResult<Dictionary> {
        match self.object(id)? {
            Object::Dictionary(dict) => Ok(dict),
            _ => Err(bad(format!("object {} is not a dictionary", id.0))),
        }
    }

    fn resolved(&self, object: &Object) -> PdfResult<Object> {
        match object {
            Object::Reference(id) => self.object(*id),
            other => Ok(other.clone()),
        }
    }

    pub fn catalog_id(&self) -> PdfResult<ObjectId> {
        Ok(self.doc.trailer.get(b"Root")?.as_reference()?)
    }

    pub fn page_id(&self, index: usize) -> PdfResult<ObjectId> {
        self.doc
            .get_pages()
            .into_values()
            .nth(index)
            .ok_or_else(|| bad(format!("no page {index}")))
    }

    pub fn page_count(&self) -> usize {
        self.doc.get_pages().len()
    }

    /// Append `item` to the array at `key` of the dictionary `owner`, which
    /// may hold the array inline or by reference.
    fn push_to_array(&mut self, owner: ObjectId, key: &[u8], item: Object) -> PdfResult<()> {
        let mut dict = self.dictionary(owner)?;
        match dict.get(key).ok().cloned() {
            Some(Object::Reference(array_id)) => {
                let mut items = match self.object(array_id)? {
                    Object::Array(items) => items,
                    _ => Vec::new(),
                };
                items.push(item);
                self.set(array_id, Object::Array(items));
            }
            Some(Object::Array(mut items)) => {
                items.push(item);
                dict.set(key.to_vec(), Object::Array(items));
                self.set(owner, Object::Dictionary(dict));
            }
            _ => {
                dict.set(key.to_vec(), Object::Array(vec![item]));
                self.set(owner, Object::Dictionary(dict));
            }
        }
        Ok(())
    }

    /// The interactive form: its own object, made one if the catalog has none
    /// or holds it inline.
    fn acro_form_id(&mut self) -> PdfResult<ObjectId> {
        let catalog_id = self.catalog_id()?;
        let mut catalog = self.dictionary(catalog_id)?;
        match catalog.get(b"AcroForm").ok().cloned() {
            Some(Object::Reference(id)) => Ok(id),
            existing => {
                let form = if let Some(Object::Dictionary(form)) = existing {
                    form
                } else {
                    let mut form = Dictionary::new();
                    form.set("Fields", Object::Array(Vec::new()));
                    form
                };
                let id = self.add(Object::Dictionary(form));
                catalog.set("AcroForm", Object::Reference(id));
                self.set(catalog_id, Object::Dictionary(catalog));
                Ok(id)
            }
        }
    }

    /// Give the form a default font for its text fields (`/DR`, `/DA`).
    fn ensure_form_font(&mut self, form_id: ObjectId) -> PdfResult<()> {
        let mut form = self.dictionary(form_id)?;
        if form.has(b"DR") {
            return Ok(());
        }
        let font = self.add(Object::Dictionary(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        }));
        form.set(
            "DR",
            Object::Dictionary(dictionary! { "Font" => dictionary! { "Helv" => font } }),
        );
        form.set("DA", Object::string_literal("/Helv 0 Tf 0 g"));
        self.set(form_id, Object::Dictionary(form));
        Ok(())
    }

    /// Add a form field with its widget on page `page` at `rect` (default
    /// user space; `[0 0 0 0]` for an invisible signature field). Text and
    /// checkbox fields are read-only: WeldSign fills them, nobody types.
    pub fn add_form_field(
        &mut self,
        kind: FieldKind,
        name: &str,
        page: usize,
        rect: [f64; 4],
    ) -> PdfResult<ObjectId> {
        let page_id = self.page_id(page)?;
        let form_id = self.acro_form_id()?;
        let mut field = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Widget",
            "T" => text_string(name),
            "P" => page_id,
            "Rect" => rect.iter().map(|v| real(*v)).collect::<Vec<Object>>(),
        };
        match kind {
            FieldKind::Text => {
                self.ensure_form_font(form_id)?;
                field.set("FT", "Tx");
                field.set("Ff", 1_i64);
                field.set("F", 4_i64);
                field.set("DA", Object::string_literal("/Helv 0 Tf 0 g"));
            }
            FieldKind::Checkbox => {
                field.set("FT", "Btn");
                field.set("Ff", 1_i64);
                field.set("F", 4_i64);
                field.set("V", "Off");
                field.set("AS", "Off");
            }
            FieldKind::Signature => {
                field.set("FT", "Sig");
                // Print and Locked.
                field.set("F", 132_i64);
                let mut form = self.dictionary(form_id)?;
                form.set("SigFlags", 3_i64);
                self.set(form_id, Object::Dictionary(form));
            }
        }
        let id = self.add(Object::Dictionary(field));
        self.push_to_array(page_id, b"Annots", Object::Reference(id))?;
        self.push_to_array(form_id, b"Fields", Object::Reference(id))?;
        Ok(id)
    }

    /// A top-level field by name.
    pub fn find_field(&self, name: &str) -> Option<ObjectId> {
        let catalog = self.dictionary(self.catalog_id().ok()?).ok()?;
        let form = self.resolved(catalog.get(b"AcroForm").ok()?).ok()?;
        let fields = self
            .resolved(form.as_dict().ok()?.get(b"Fields").ok()?)
            .ok()?;
        fields.as_array().ok()?.iter().find_map(|field| {
            let id = field.as_reference().ok()?;
            let dict = self.dictionary(id).ok()?;
            (text_of(&dict, b"T")? == name).then_some(id)
        })
    }

    /// Fill a text field: its value and how it looks.
    pub fn fill_text(&mut self, field: ObjectId, value: &str, appearance: Stream) -> PdfResult<()> {
        let appearance = self.add(Object::Stream(appearance));
        let mut dict = self.dictionary(field)?;
        dict.set("V", text_string(value));
        dict.set("AP", dictionary! { "N" => appearance });
        self.set(field, Object::Dictionary(dict));
        Ok(())
    }

    /// Tick a checkbox, with the look of the tick.
    pub fn fill_checkbox(&mut self, field: ObjectId, appearance: Stream) -> PdfResult<()> {
        let on = self.add(Object::Stream(appearance));
        let off = self.add(Object::Stream(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => vec![Object::Integer(0), Object::Integer(0), Object::Integer(0), Object::Integer(0)],
            },
            Vec::new(),
        )));
        let mut dict = self.dictionary(field)?;
        dict.set("V", "Yes");
        dict.set("AS", "Yes");
        dict.set(
            "AP",
            dictionary! { "N" => dictionary! { "Yes" => on, "Off" => off } },
        );
        self.set(field, Object::Dictionary(dict));
        Ok(())
    }

    /// Add the validation material to the Document Security Store (B-LT).
    pub fn add_dss(
        &mut self,
        certs: &[Vec<u8>],
        ocsps: &[Vec<u8>],
        crls: &[Vec<u8>],
    ) -> PdfResult<()> {
        let catalog_id = self.catalog_id()?;
        let mut catalog = self.dictionary(catalog_id)?;
        let mut dss = match catalog.get(b"DSS").ok().cloned() {
            Some(object) => match self.resolved(&object)? {
                Object::Dictionary(dict) => dict,
                _ => Dictionary::new(),
            },
            None => Dictionary::new(),
        };
        for (key, items) in [
            (&b"Certs"[..], certs),
            (&b"OCSPs"[..], ocsps),
            (&b"CRLs"[..], crls),
        ] {
            let mut refs = match dss.get(key).ok().cloned() {
                Some(object) => match self.resolved(&object)? {
                    Object::Array(refs) => refs,
                    _ => Vec::new(),
                },
                None => Vec::new(),
            };
            let mut seen: Vec<&Vec<u8>> = Vec::new();
            for item in items {
                if seen.contains(&item) {
                    continue;
                }
                seen.push(item);
                let id = self.add(Object::Stream(Stream::new(Dictionary::new(), item.clone())));
                refs.push(Object::Reference(id));
            }
            if !refs.is_empty() {
                dss.set(key.to_vec(), Object::Array(refs));
            }
        }
        let dss_id = self.add(Object::Dictionary(dss));
        catalog.set("DSS", Object::Reference(dss_id));
        self.set(catalog_id, Object::Dictionary(catalog));
        Ok(())
    }

    /// Write the revision after the old bytes. With `raw_positions`, also the
    /// file offset of each raw object's first byte of content.
    fn write_out(self) -> PdfResult<(Vec<u8>, BTreeMap<ObjectId, usize>)> {
        let prev = last_startxref(&self.base)?;
        let mut out = self.base;
        if !out.ends_with(b"\n") {
            out.push(b'\n');
        }
        let mut offsets: BTreeMap<ObjectId, usize> = BTreeMap::new();
        let mut raw_at: BTreeMap<ObjectId, usize> = BTreeMap::new();
        for (id, body) in &self.bodies {
            offsets.insert(*id, out.len());
            let _ = writeln!(Hex(&mut out), "{} {} obj", id.0, id.1);
            match body {
                Body::Object(object) => write_object(&mut out, object),
                Body::Raw(bytes) => {
                    raw_at.insert(*id, out.len());
                    out.extend_from_slice(bytes);
                }
            }
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref_at = out.len();
        out.extend_from_slice(b"xref\n");
        let ids: Vec<ObjectId> = offsets.keys().copied().collect();
        let mut i = 0;
        while i < ids.len() {
            let start = ids[i].0;
            let mut end = i;
            while end + 1 < ids.len() && ids[end + 1].0 == ids[end].0 + 1 {
                end += 1;
            }
            let _ = writeln!(Hex(&mut out), "{} {}", start, end - i + 1);
            for id in &ids[i..=end] {
                let _ = write!(Hex(&mut out), "{:010} {:05} n\r", offsets[id], id.1);
                out.push(b'\n');
            }
            i = end + 1;
        }
        let previous_size = self
            .doc
            .trailer
            .get(b"Size")
            .ok()
            .and_then(|s| s.as_i64().ok())
            .unwrap_or(0);
        let size = previous_size.max(i64::from(self.next));
        let mut trailer = Dictionary::new();
        trailer.set("Size", size);
        for key in [&b"Root"[..], b"Info", b"ID"] {
            if let Ok(value) = self.doc.trailer.get(key) {
                trailer.set(key.to_vec(), value.clone());
            }
        }
        trailer.set("Prev", i64::try_from(prev).unwrap_or(0));
        out.extend_from_slice(b"trailer\n");
        write_dictionary(&mut out, &trailer);
        let _ = writeln!(Hex(&mut out), "\nstartxref\n{xref_at}\n%%EOF");
        Ok((out, raw_at))
    }

    /// The file with this revision appended.
    pub fn write(self) -> PdfResult<Vec<u8>> {
        if self.bodies.is_empty() {
            return Ok(self.base);
        }
        self.write_out().map(|(bytes, _)| bytes)
    }

    /// Append the revision with a signature placeholder.
    pub fn sign(mut self, spec: &SignatureSpec) -> PdfResult<Prepared> {
        let sig_id = (self.next, 0);
        self.next += 1;

        let mut raw = Vec::new();
        let (kind, sub_filter) = match spec.kind {
            SignatureKind::Cades { .. } => ("Sig", "ETSI.CAdES.detached"),
            SignatureKind::DocumentTimestamp => ("DocTimeStamp", "ETSI.RFC3161"),
        };
        let _ = write!(
            Hex(&mut raw),
            "<</Type /{kind} /Filter /Adobe.PPKLite /SubFilter /{sub_filter} /ByteRange ["
        );
        let byte_range_at = raw.len();
        raw.extend_from_slice(BYTE_RANGE_PLACEHOLDER.as_bytes());
        raw.extend_from_slice(b"] /Contents ");
        let contents_at = raw.len();
        raw.push(b'<');
        raw.extend(std::iter::repeat_n(b'0', spec.contents_size * 2));
        raw.push(b'>');
        if let SignatureKind::Cades {
            name,
            reason,
            location,
            signing_time,
        } = &spec.kind
        {
            raw.extend_from_slice(b" /M ");
            write_object(&mut raw, &Object::string_literal(pdf_date(*signing_time)));
            for (key, value) in [
                (&b"Name"[..], name),
                (&b"Reason"[..], reason),
                (&b"Location"[..], location),
            ] {
                if let Some(value) = value {
                    raw.push(b' ');
                    write_name(&mut raw, key);
                    raw.push(b' ');
                    write_object(&mut raw, &text_string(value));
                }
            }
        }
        raw.extend_from_slice(b">>");
        self.bodies.insert(sig_id, Body::Raw(raw));

        let field = match spec.field {
            Some(field) => field,
            None => self.add_form_field(FieldKind::Signature, &spec.field_name, 0, [0.0; 4])?,
        };
        let mut dict = self.dictionary(field)?;
        dict.set("V", Object::Reference(sig_id));
        self.set(field, Object::Dictionary(dict));

        let (mut bytes, raw_at) = self.write_out()?;
        let start = raw_at
            .get(&sig_id)
            .copied()
            .ok_or_else(|| bad("signature dictionary not written"))?;
        let contents_start = start + contents_at;
        let contents_end = contents_start + spec.contents_size * 2 + 2;
        let byte_range = [0, contents_start, contents_end, bytes.len() - contents_end];
        let text = format!("0 {} {} {}", byte_range[1], byte_range[2], byte_range[3]);
        if text.len() > BYTE_RANGE_PLACEHOLDER.len() {
            return Err(bad("file too large for the byte range"));
        }
        let at = start + byte_range_at;
        let padded = format!("{text:<width$}", width = BYTE_RANGE_PLACEHOLDER.len());
        bytes[at..at + padded.len()].copy_from_slice(padded.as_bytes());
        Ok(Prepared {
            bytes,
            byte_range,
            contents_size: spec.contents_size,
        })
    }
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "PDF reals are f32 in lopdf"
)]
fn real(value: f64) -> Object {
    Object::Real(value as f32)
}

/// A file with a signature placeholder, waiting for its CMS.
#[derive(Debug, Clone)]
pub struct Prepared {
    bytes: Vec<u8>,
    byte_range: [usize; 4],
    contents_size: usize,
}

impl Prepared {
    pub fn byte_range(&self) -> [usize; 4] {
        self.byte_range
    }

    /// The bytes as prepared (placeholder still zero).
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// The digest of the signed byte ranges: what the CMS's
    /// `message-digest` (or the timestamp's imprint) must be.
    pub fn digest(&self, hash: Hash) -> Vec<u8> {
        let [a, b, c, d] = self.byte_range;
        hash.digest_parts(&[&self.bytes[a..a + b], &self.bytes[c..c + d]])
    }

    /// Write `cms` into the placeholder: the signed file.
    pub fn embed(mut self, cms: &[u8]) -> PdfResult<Vec<u8>> {
        if cms.len() > self.contents_size {
            return Err(bad(format!(
                "the signature ({} bytes) does not fit the {} reserved",
                cms.len(),
                self.contents_size
            )));
        }
        let mut hex = String::with_capacity(cms.len() * 2);
        for byte in cms {
            let _ = write!(hex, "{byte:02X}");
        }
        let at = self.byte_range[1] + 1;
        self.bytes[at..at + hex.len()].copy_from_slice(hex.as_bytes());
        Ok(self.bytes)
    }

    /// Rebuild from stored parts (a pending signature kept between the
    /// signer leaving for their QTSP and coming back).
    pub fn from_parts(bytes: Vec<u8>, byte_range: [usize; 4]) -> PdfResult<Self> {
        let [a, b, c, d] = byte_range;
        if a != 0 || c < b + 2 || c + d != bytes.len() {
            return Err(bad("byte range does not fit the file"));
        }
        Ok(Self {
            bytes,
            byte_range,
            contents_size: (c - b - 2) / 2,
        })
    }
}

// ── Reading signatures ─────────────────────────────────────────────────────

/// A signature dictionary found in a file.
#[derive(Debug, Clone)]
pub struct FoundSignature {
    pub id: ObjectId,
    pub field_name: Option<String>,
    pub document_timestamp: bool,
    pub sub_filter: String,
    pub byte_range: [usize; 4],
    /// The CMS, padding cut off.
    pub contents: Vec<u8>,
    /// `/M`, as written.
    pub claimed_time: Option<String>,
    pub name: Option<String>,
}

impl FoundSignature {
    /// Where the revision it signs ends.
    pub fn covers(&self) -> usize {
        self.byte_range[2] + self.byte_range[3]
    }

    /// The digest of what it signs.
    pub fn digest(&self, bytes: &[u8], hash: Hash) -> PdfResult<Vec<u8>> {
        let [a, b, c, d] = self.byte_range;
        if a + b > bytes.len() || c + d > bytes.len() || b > c {
            return Err(bad("byte range outside the file"));
        }
        Ok(hash.digest_parts(&[&bytes[a..a + b], &bytes[c..c + d]]))
    }
}

fn text_of(dict: &Dictionary, key: &[u8]) -> Option<String> {
    dict.get(key)
        .ok()
        .and_then(|value| lopdf::decode_text_string(value).ok())
}

/// Every signature and document timestamp in `bytes`, oldest first.
pub fn find_signatures(bytes: &[u8]) -> PdfResult<Vec<FoundSignature>> {
    let doc = Document::load_mem(bytes)?;
    let mut names: BTreeMap<ObjectId, String> = BTreeMap::new();
    for object in doc.objects.values() {
        let Ok(dict) = object.as_dict() else { continue };
        if dict.get(b"FT").ok().and_then(|t| t.as_name().ok()) == Some(b"Sig".as_slice())
            && let Ok(Object::Reference(value)) = dict.get(b"V")
            && let Some(title) = text_of(dict, b"T")
        {
            names.insert(*value, title);
        }
    }
    let mut out = Vec::new();
    for (id, object) in &doc.objects {
        let Ok(dict) = object.as_dict() else { continue };
        let (Ok(Object::Array(range)), Ok(Object::String(contents, _))) =
            (dict.get(b"ByteRange"), dict.get(b"Contents"))
        else {
            continue;
        };
        let numbers: Vec<usize> = range
            .iter()
            .filter_map(|n| n.as_i64().ok())
            .filter_map(|n| usize::try_from(n).ok())
            .collect();
        let [a, b, c, d] = numbers[..] else { continue };
        let len = der::element_len(contents)
            .unwrap_or(contents.len())
            .min(contents.len());
        let kind = dict.get(b"Type").ok().and_then(|t| t.as_name().ok());
        out.push(FoundSignature {
            id: *id,
            field_name: names.get(id).cloned(),
            document_timestamp: kind == Some(b"DocTimeStamp".as_slice()),
            sub_filter: dict
                .get(b"SubFilter")
                .ok()
                .and_then(|s| s.as_name().ok())
                .map(|s| String::from_utf8_lossy(s).into_owned())
                .unwrap_or_default(),
            byte_range: [a, b, c, d],
            contents: contents[..len].to_vec(),
            claimed_time: text_of(dict, b"M"),
            name: text_of(dict, b"Name"),
        });
    }
    out.sort_by_key(FoundSignature::covers);
    Ok(out)
}
