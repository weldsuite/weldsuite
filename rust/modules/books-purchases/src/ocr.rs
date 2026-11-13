//! books-api's `services/accounting-ocr`: reading a stored purchase invoice
//! or receipt (PDF or photo) into fields (`processDocumentOcr`), the result
//! normalised (`normalizeOcrResult`), the bill lines it pre-fills
//! (`lineItemsForBill`) and the contact it matches (`matchVendorToContact`).
//!
//! Global sends the file to Claude Haiku with native file input. Here the
//! read goes through `weldsuite_ai` under the `books-ocr` feature (ADR
//! AI-012): Mistral OCR with a document annotation fills the fields in one
//! call; when the workspace admin routed `books-ocr` to Claude or `OpenAI`,
//! the crate uses their native file input and falls back to Mistral OCR. The
//! file checks (type from the bytes, the size caps), the prompt and the
//! shape of the answer are the worker's.

use serde_json::{Map, Value, json};
use weldsuite_ai::{Ai, AiCall, AiError, Document, JsonSchema, Served};
use weldsuite_books_domain::js::{math_round, number_text, number_value};
use weldsuite_books_domain::jurisdictions::js_trim;
use weldsuite_kit::ApiError;
use weldsuite_ports::StorageBuckets;

/// `asNumber(value)`: a finite number, else `None`.
fn as_number(value: Option<&Value>) -> Option<f64> {
    let n = match value? {
        Value::Null => return None,
        Value::String(s) if s.is_empty() => return None,
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => weldsuite_kit::validation::js_number(s),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Array(_) | Value::Object(_) => f64::NAN,
    };
    n.is_finite().then_some(n)
}

fn number_or_null(n: Option<f64>) -> Value {
    n.map_or(Value::Null, number_value)
}

/// `asIsoDate(value)`: `yyyy-mm-dd`, a Dutch `d-m-yyyy` turned around, the
/// trimmed text otherwise.
fn as_iso_date(value: Option<&Value>) -> Value {
    let Some(Value::String(raw)) = value else {
        return Value::Null;
    };
    let trimmed = js_trim(raw);
    if trimmed.is_empty() {
        return Value::Null;
    }
    let b = trimmed.as_bytes();
    let iso = b.len() >= 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|i| b[*i].is_ascii_digit());
    if iso {
        return json!(&trimmed[..10]);
    }
    let parts: Vec<&str> = trimmed.split(['.', '/', '-']).collect();
    let separators_ok = trimmed
        .chars()
        .filter(|c| matches!(c, '.' | '/' | '-'))
        .count()
        == 2;
    if separators_ok
        && let [d, m, y] = parts.as_slice()
        && (1..=2).contains(&d.len())
        && (1..=2).contains(&m.len())
        && y.len() == 4
        && [d, m, y]
            .iter()
            .all(|p| p.bytes().all(|c| c.is_ascii_digit()))
    {
        return json!(format!("{y}-{m:0>2}-{d:0>2}"));
    }
    json!(trimmed)
}

fn or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// `normalizeOcrResult(parsed)`.
pub(crate) fn normalize_ocr_result(parsed: &Value) -> Value {
    let raw = parsed.as_object().cloned().unwrap_or_default();
    let get = |key: &str| raw.get(key).filter(|v| !v.is_null());
    let empty = Value::Object(Map::new());
    let vendor = get("vendor").unwrap_or(&empty);
    let field = |key: &str| or_null(vendor.get(key).filter(|v| !v.is_null()));
    let line_items: Vec<Value> = get("lineItems")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    json!({
                        "description": item.get("description").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!("")),
                        "quantity": number_or_null(as_number(item.get("quantity"))),
                        "unitPrice": number_or_null(as_number(item.get("unitPrice"))),
                        "taxRate": number_or_null(as_number(item.get("taxRate"))),
                        "total": number_or_null(as_number(item.get("total"))),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let breakdown: Vec<Value> = get("taxBreakdown")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| {
                    json!({
                        "rate": number_value(as_number(row.get("rate")).unwrap_or(0.0)),
                        "taxableAmount": number_value(as_number(row.get("taxableAmount")).unwrap_or(0.0)),
                        "taxAmount": number_value(as_number(row.get("taxAmount")).unwrap_or(0.0)),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let confidence = get("confidence");
    json!({
        "vendor": {
            "name": field("name"),
            "address": field("address"),
            "taxNumber": field("taxNumber"),
            "kvkNumber": field("kvkNumber"),
            "iban": field("iban"),
            "bic": field("bic"),
        },
        "invoiceNumber": or_null(get("invoiceNumber")),
        "invoiceDate": as_iso_date(get("invoiceDate")),
        "dueDate": as_iso_date(get("dueDate")),
        "currency": get("currency").cloned().unwrap_or_else(|| json!("EUR")),
        "lineItems": line_items,
        "subtotal": number_or_null(as_number(get("subtotal"))),
        "taxBreakdown": breakdown,
        "totalTax": number_or_null(as_number(get("totalTax"))),
        "total": number_or_null(as_number(get("total"))),
        "paymentReference": or_null(get("paymentReference")),
        "iban": or_null(get("iban")),
        "confidence": {
            "overall": number_value(as_number(confidence.and_then(|c| c.get("overall"))).unwrap_or(0.0)),
            "fields": confidence.and_then(|c| c.get("fields")).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!({})),
        },
        "rawText": or_null(get("rawText")),
    })
}

fn num(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

/// `dominantTaxRate(ocr)`.
fn dominant_tax_rate(ocr: &Value) -> Option<f64> {
    if let Some(rate) = ocr["taxBreakdown"].get(0).and_then(|row| num(row, "rate")) {
        return Some(rate);
    }
    ocr["lineItems"]
        .as_array()?
        .iter()
        .find_map(|line| num(line, "taxRate"))
}

/// `exclusiveAmount(ocr)`: the amount without VAT, for a one-line expense.
fn exclusive_amount(ocr: &Value) -> Option<f64> {
    if let Some(subtotal) = num(ocr, "subtotal").filter(|n| n.is_finite()) {
        return Some(subtotal);
    }
    let from_lines: f64 = ocr["lineItems"].as_array().map_or(0.0, |lines| {
        lines
            .iter()
            .filter_map(|line| Some(num(line, "unitPrice")? * num(line, "quantity").unwrap_or(1.0)))
            .sum()
    });
    if from_lines > 0.0 {
        return Some(from_lines);
    }
    let total = num(ocr, "total").filter(|n| n.is_finite())?;
    match dominant_tax_rate(ocr) {
        Some(rate) if rate > 0.0 => Some(total / (1.0 + rate / 100.0)),
        _ => Some(total),
    }
}

fn truthy_text(value: &Value) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(false) => None,
        Value::String(s) if s.is_empty() => None,
        Value::Number(n) if n.as_f64() == Some(0.0) => None,
        other => Some(other.clone()),
    }
}

/// `lineItemsForBill(ocr)`: the OCR lines, or one line from the total.
pub(crate) fn line_items_for_bill(ocr: &Value) -> Vec<Value> {
    let lines = ocr["lineItems"].as_array().cloned().unwrap_or_default();
    if !lines.is_empty() {
        return lines
            .iter()
            .enumerate()
            .map(|(index, line)| {
                json!({
                    "description": truthy_text(&line["description"]).unwrap_or_else(|| json!("Item")),
                    "quantity": number_text(num(line, "quantity").unwrap_or(1.0)),
                    "unitPrice": number_text(num(line, "unitPrice").unwrap_or(0.0)),
                    "taxRate": num(line, "taxRate").map_or(Value::Null, |r| json!(number_text(r))),
                    "sortOrder": index,
                })
            })
            .collect();
    }
    let Some(exclusive) = exclusive_amount(ocr) else {
        return Vec::new();
    };
    vec![json!({
        "description": truthy_text(&ocr["vendor"]["name"]).unwrap_or_else(|| json!("Scanned receipt")),
        "quantity": "1",
        "unitPrice": number_text(math_round(exclusive * 100.0) / 100.0),
        "taxRate": dominant_tax_rate(ocr).map_or(Value::Null, |r| json!(number_text(r))),
        "sortOrder": 0,
    })]
}

/// `matchVendorToContact(db, schema, ocr)`: a live contact with the
/// document's IBAN. books-api also asks for `parties.taxNumber` and
/// `parties.name`, which the table doesn't have: Drizzle can't build that
/// query, so a result with a VAT number or a vendor name fails (the
/// route's 500), as it does on Global.
pub(crate) async fn match_vendor_to_contact(
    db: &sqlx::PgPool,
    ocr: &Value,
) -> Result<Option<String>, sqlx::Error> {
    let vendor = &ocr["vendor"];
    let tax_number = truthy_text(&vendor["taxNumber"]);
    let iban = truthy_text(&vendor["iban"]).or_else(|| truthy_text(&ocr["iban"]));
    let name = truthy_text(&vendor["name"]);
    if tax_number.is_some() || name.is_some() {
        return Err(sqlx::Error::Protocol(
            "parties has no taxNumber or name column to match on".to_owned(),
        ));
    }
    let Some(iban) = iban else {
        return Ok(None);
    };
    sqlx::query_scalar("select id from parties where iban = $1 and deleted_at is null limit 1")
        .bind(
            iban.as_str()
                .map_or_else(|| iban.to_string(), str::to_owned),
        )
        .fetch_optional(db)
        .await
}

// ── Reading the document (`processDocumentOcr`) ────────────────────────────

/// The ledger `op` of the credit charge (`chargeAiUsage({ op })`).
pub(crate) const OCR_OP: &str = "accounting-ocr";

const PDF_TYPE: &str = "application/pdf";
/// `MAX_IMAGE_BYTES`: Anthropic caps an image at 5 MB of base64, which is
/// 3.75 MB of file. Kept for every provider, so a workspace moved between
/// providers reads the same files.
const MAX_IMAGE_BYTES: usize = 3 * 1024 * 1024 + 768 * 1024;
/// `MAX_PDF_BYTES`.
const MAX_PDF_BYTES: usize = 20 * 1024 * 1024;

/// `SYSTEM_PROMPT`, verbatim: the extraction rules and the answer's shape.
const SYSTEM_PROMPT: &str = r#"You are an expert bookkeeper extracting data from a purchase invoice or till receipt (often Dutch or English): a PDF, a scan or a photo.

Rules:
- vendor.name is the supplier who ISSUED the document, not the customer.
- A PDF may have several pages: read all of them; totals are usually on the last page.
- Dates must be ISO YYYY-MM-DD. Convert Dutch formats like 24-08-2026.
- currency is an ISO 4217 code; default EUR if the symbol is €.
- unitPrice and line total are exclusive of VAT. taxRate is a percentage (21, not 0.21).
- subtotal is exclusive of VAT; total is the amount payable (inclusive).
- taxNumber is a VAT/BTW id (NL…B01). kvkNumber is a Dutch Chamber of Commerce number.
- If a field is not visible or you are unsure, use null (or [] for lists).
- confidence.overall is 0–1 for the extraction as a whole.
- Do not invent line items. If you can only see a total, leave lineItems empty.
- Reply with one JSON object only. No markdown fences. Shape:
{"vendor":{"name":null,"address":null,"taxNumber":null,"kvkNumber":null,"iban":null,"bic":null},"invoiceNumber":null,"invoiceDate":null,"dueDate":null,"currency":"EUR","lineItems":[{"description":"","quantity":null,"unitPrice":null,"taxRate":null,"total":null}],"subtotal":null,"taxBreakdown":[{"rate":21,"taxableAmount":0,"taxAmount":0}],"totalTax":null,"total":null,"paymentReference":null,"iban":null,"confidence":{"overall":0}}"#;

/// The user turn of the worker's request.
const USER_PROMPT: &str = "Extract the invoice / receipt fields from this document.";

/// The JSON schema of [`SYSTEM_PROMPT`]'s shape: Mistral OCR's document
/// annotation, or a file-input model's structured answer.
pub(crate) fn extraction_schema() -> Value {
    let text = || json!({ "type": ["string", "null"] });
    let number = || json!({ "type": ["number", "null"] });
    json!({
        "type": "object",
        "properties": {
            "vendor": {
                "type": "object",
                "properties": {
                    "name": text(),
                    "address": text(),
                    "taxNumber": text(),
                    "kvkNumber": text(),
                    "iban": text(),
                    "bic": text(),
                },
                "required": ["name", "address", "taxNumber", "kvkNumber", "iban", "bic"],
            },
            "invoiceNumber": text(),
            "invoiceDate": text(),
            "dueDate": text(),
            "currency": text(),
            "lineItems": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "description": { "type": "string" },
                        "quantity": number(),
                        "unitPrice": number(),
                        "taxRate": number(),
                        "total": number(),
                    },
                    "required": ["description", "quantity", "unitPrice", "taxRate", "total"],
                },
            },
            "subtotal": number(),
            "taxBreakdown": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "rate": { "type": "number" },
                        "taxableAmount": { "type": "number" },
                        "taxAmount": { "type": "number" },
                    },
                    "required": ["rate", "taxableAmount", "taxAmount"],
                },
            },
            "totalTax": number(),
            "total": number(),
            "paymentReference": text(),
            "iban": text(),
            "confidence": {
                "type": "object",
                "properties": { "overall": { "type": "number" } },
                "required": ["overall"],
            },
        },
        "required": [
            "vendor", "invoiceNumber", "invoiceDate", "dueDate", "currency", "lineItems",
            "subtotal", "taxBreakdown", "totalTax", "total", "paymentReference", "iban",
            "confidence",
        ],
    })
}

/// Why OCR stopped (`AccountingOcrError` and the errors around it), with the
/// answer the route gives for each.
#[derive(Debug)]
pub(crate) enum OcrFailure {
    /// `AI_NOT_CONFIGURED` / `AI_REQUEST_FAILED`: 502 with the message.
    Upstream(String),
    /// `FILE_NOT_FOUND` / `UNSUPPORTED_TYPE`: 400 with the message.
    Refused(String),
    /// The AI policy's own answers: the credit gate's 402
    /// `INSUFFICIENT_CREDITS` (`InsufficientAiCreditsError`), a model the
    /// workspace doesn't allow (422).
    Policy(ApiError),
    /// Anything else: 500 `OCR processing failed: <message>`.
    Failed(String),
}

impl OcrFailure {
    /// The route's answer (`catch (ocrErr)` in `POST /:id/process`).
    pub(crate) fn into_api_error(self) -> ApiError {
        match self {
            Self::Upstream(message) => ApiError::bad_gateway().with_message(message),
            Self::Refused(message) => ApiError::bad_request(message),
            Self::Policy(error) => error,
            Self::Failed(message) => {
                ApiError::internal().with_message(format!("OCR processing failed: {message}"))
            }
        }
    }
}

impl From<AiError> for OcrFailure {
    fn from(error: AiError) -> Self {
        match error {
            refused @ (AiError::InsufficientCredits { .. } | AiError::ModelNotAllowed { .. }) => {
                Self::Policy(refused.into_api_error())
            }
            AiError::Database(error) => Self::Failed(error.to_string()),
            // No provider, a provider's refusal (after the fallback), an
            // answer that isn't the schema's: `AI_REQUEST_FAILED`.
            other => Self::Upstream(other.to_string()),
        }
    }
}

/// A stored file OCR can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OcrFile {
    pub(crate) bytes: Vec<u8>,
    pub(crate) media_type: &'static str,
}

/// `isOcrCandidateMime(mime)`: declared types worth opening.
fn is_ocr_candidate_mime(mime: &str) -> bool {
    mime == PDF_TYPE || mime.starts_with("image/") || mime == "application/octet-stream"
}

/// `sniffImageType(bytes)`: the image type from its magic bytes.
fn sniff_image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0x47, 0x49, 0x46]) {
        return Some("image/gif");
    }
    if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// `looksLikePdf(bytes)`: `%PDF-` within the first 1024 bytes.
fn looks_like_pdf(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(1024)]
        .windows(5)
        .any(|window| window == b"%PDF-")
}

/// `sniffOcrMediaType(bytes)`: what to send the model the file as.
pub(crate) fn sniff_ocr_media_type(bytes: &[u8]) -> Option<&'static str> {
    if looks_like_pdf(bytes) {
        return Some(PDF_TYPE);
    }
    sniff_image_type(bytes)
}

/// `loadOcrFile(env, params)`: the stored file, checked to be a readable,
/// reasonably sized PDF or image of this workspace. The type comes from the
/// bytes, not the declared mime type. `owners` are the workspace's key
/// prefixes (uploads under the Clerk org id, accounting-inbox mail under
/// `workspaces.id`: `isOwnDocumentKey`).
pub(crate) async fn load_ocr_file(
    buckets: &StorageBuckets,
    file_key: &str,
    declared_mime: Option<&str>,
    owners: &[Option<&str>],
) -> Result<OcrFile, OcrFailure> {
    let declared = declared_mime.unwrap_or_default().to_lowercase();
    if !declared.is_empty() && !is_ocr_candidate_mime(&declared) {
        return Err(OcrFailure::Refused(
            "OCR reads PDF files and JPEG, PNG and WebP images.".to_owned(),
        ));
    }
    if buckets.private.is_none() && buckets.public.is_none() {
        return Err(OcrFailure::Refused(
            "File storage is not configured.".to_owned(),
        ));
    }
    let missing = || OcrFailure::Refused(format!("File not found: {file_key}"));
    // The key came from the client: never read another tenant's file.
    // Reported exactly like a missing one.
    if !weldsuite_books_domain::attachments::is_workspace_object_key(file_key, owners) {
        return Err(missing());
    }
    let mut stored = None;
    for bucket in [&buckets.private, &buckets.public].into_iter().flatten() {
        match bucket.get_boxed(file_key).await {
            Ok(Some(object)) => {
                stored = Some(object);
                break;
            }
            Ok(None) => {}
            Err(error) => return Err(OcrFailure::Failed(error.to_string())),
        }
    }
    let bytes = stored.ok_or_else(missing)?.bytes;
    if bytes.is_empty() {
        return Err(OcrFailure::Refused(
            "The uploaded file is empty.".to_owned(),
        ));
    }
    let Some(media_type) = sniff_ocr_media_type(&bytes) else {
        return Err(OcrFailure::Refused(if declared == PDF_TYPE {
            "That file is not a readable PDF.".to_owned()
        } else {
            "That file is not a PDF or a JPEG, PNG or WebP image. Take the photo again in the app."
                .to_owned()
        }));
    };
    if media_type == PDF_TYPE && bytes.len() > MAX_PDF_BYTES {
        return Err(OcrFailure::Refused(
            "The PDF is too large to read (20 MB at most).".to_owned(),
        ));
    }
    if media_type != PDF_TYPE && bytes.len() > MAX_IMAGE_BYTES {
        return Err(OcrFailure::Refused(
            "The image is too large to read. Capture it again a bit closer or at lower quality."
                .to_owned(),
        ));
    }
    Ok(OcrFile { bytes, media_type })
}

/// The body of the first closed Markdown code fence, minus an optional `json` tag
/// (`fencedBody`).
fn fenced_body(text: &str) -> Option<&str> {
    let open = text.find("```")?;
    let rest = &text[open + 3..];
    let close = rest.find("```")?;
    let body = &rest[..close];
    let tagged = body
        .get(..4)
        .is_some_and(|tag| tag.eq_ignore_ascii_case("json"));
    Some(if tagged { &body[4..] } else { body })
}

/// `parseOcrJson(text)`: the JSON object in a model's text answer, fenced
/// or not.
pub(crate) fn parse_ocr_json(text: &str) -> Result<Value, OcrFailure> {
    let trimmed = text.trim();
    let raw = fenced_body(trimmed).unwrap_or(trimmed).trim();
    let (Some(start), Some(end)) = (raw.find('{'), raw.rfind('}')) else {
        return Err(OcrFailure::Upstream(
            "The model did not return JSON.".to_owned(),
        ));
    };
    if end <= start {
        return Err(OcrFailure::Upstream(
            "The model did not return JSON.".to_owned(),
        ));
    }
    serde_json::from_str(&raw[start..=end])
        .map_err(|_| OcrFailure::Upstream("The model returned invalid JSON.".to_owned()))
}

/// The model part of `processDocumentOcr`: the credit gate
/// (`assertAiCredits`), the read with the fields extracted in the same call
/// (charged under [`OCR_OP`] by the crate), and the normalised result with
/// the model that served it.
pub(crate) async fn read_document(
    ai: &Ai,
    call: &AiCall,
    file: OcrFile,
    name: Option<&str>,
) -> Result<(Value, Served), OcrFailure> {
    ai.assert_credits(call).await?;
    let document = Document {
        mime: file.media_type.to_owned(),
        name: name.map(str::to_owned),
        data: file.bytes,
        extract: Some(JsonSchema {
            name: "accounting_document".to_owned(),
            schema: extraction_schema(),
        }),
        prompt: Some(format!("{SYSTEM_PROMPT}\n\n{USER_PROMPT}")),
    };
    let read = ai.ocr(call, document).await?;
    let parsed = match read.object {
        Some(object) => object,
        None => parse_ocr_json(&read.text())?,
    };
    Ok((normalize_ocr_result(&parsed), read.served))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_stored_result() {
        let ocr = normalize_ocr_result(&json!({
            "vendor": { "name": "Shop" },
            "invoiceDate": "4-8-2026",
            "dueDate": "2026-09-01T00:00:00Z",
            "total": "121",
            "taxBreakdown": [{ "rate": 21 }],
        }));
        assert_eq!(ocr["invoiceDate"], json!("2026-08-04"));
        assert_eq!(ocr["dueDate"], json!("2026-09-01"));
        assert_eq!(ocr["currency"], json!("EUR"));
        assert_eq!(ocr["total"], json!(121));
        assert_eq!(
            line_items_for_bill(&ocr),
            [
                json!({ "description": "Shop", "quantity": "1", "unitPrice": "100", "taxRate": "21", "sortOrder": 0 })
            ]
        );
    }

    use std::sync::Arc;

    use weldsuite_ai::config::Endpoint;
    use weldsuite_ai::{AiConfig, FakeProvider, Feature, ProviderId, Task, Tier};
    use weldsuite_ports::{DynFileStore, MemoryFileStore, PutOptions};

    const KEY: &str = "workspaces/org_1/accounting/1_abc/invoice.pdf";

    fn pdf() -> Vec<u8> {
        b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer\n%%EOF\n".to_vec()
    }

    fn png() -> Vec<u8> {
        let mut bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&[0; 32]);
        bytes
    }

    async fn buckets(files: &[(&str, Vec<u8>)]) -> StorageBuckets {
        let store = Arc::new(MemoryFileStore::default());
        for (key, bytes) in files {
            store
                .put_boxed(key, bytes.clone(), &PutOptions::default())
                .await
                .expect("put");
        }
        StorageBuckets {
            private: Some(store as Arc<dyn DynFileStore>),
            public: None,
        }
    }

    fn refused(result: Result<OcrFile, OcrFailure>) -> String {
        match result {
            Err(OcrFailure::Refused(message)) => message,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    const OWNERS: [Option<&str>; 2] = [Some("org_1"), Some("ws_1")];

    #[test]
    fn the_type_comes_from_the_bytes() {
        assert_eq!(sniff_ocr_media_type(&pdf()), Some("application/pdf"));
        // A PDF header a little way in, as some scanners write it.
        let mut late = vec![b' '; 300];
        late.extend_from_slice(&pdf());
        assert_eq!(sniff_ocr_media_type(&late), Some("application/pdf"));
        assert_eq!(sniff_ocr_media_type(&png()), Some("image/png"));
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0];
        jpeg.extend_from_slice(&[0; 12]);
        assert_eq!(sniff_ocr_media_type(&jpeg), Some("image/jpeg"));
        let mut webp = b"RIFF\0\0\0\0WEBP".to_vec();
        webp.extend_from_slice(&[0; 8]);
        assert_eq!(sniff_ocr_media_type(&webp), Some("image/webp"));
        // HEIC labelled as JPEG, and too short to tell.
        assert_eq!(sniff_ocr_media_type(b"\0\0\0\x18ftypheic\0\0\0\0"), None);
        assert_eq!(sniff_ocr_media_type(&[0xff, 0xd8, 0xff]), None);
    }

    #[tokio::test]
    async fn the_file_checks_are_the_workers() {
        let stored = buckets(&[
            (KEY, pdf()),
            ("workspaces/org_1/a/empty.pdf", Vec::new()),
            (
                "workspaces/org_1/a/photo.heic",
                b"\0\0\0\x18ftypheic\0\0\0\0".to_vec(),
            ),
            ("workspaces/org_1/a/big.png", {
                let mut big = png();
                big.resize(MAX_IMAGE_BYTES + 1, 0);
                big
            }),
            ("workspaces/ws_1/accounting/inbox/e1/mail.pdf", pdf()),
            ("workspaces/org_2/a/theirs.pdf", pdf()),
        ])
        .await;
        let file = load_ocr_file(&stored, KEY, Some("application/octet-stream"), &OWNERS)
            .await
            .expect("an own PDF");
        assert_eq!(file.media_type, "application/pdf");
        // Inbox mail is keyed by `workspaces.id`.
        load_ocr_file(
            &stored,
            "workspaces/ws_1/accounting/inbox/e1/mail.pdf",
            None,
            &OWNERS,
        )
        .await
        .expect("inbox mail");

        assert_eq!(
            refused(load_ocr_file(&stored, KEY, Some("text/csv"), &OWNERS).await),
            "OCR reads PDF files and JPEG, PNG and WebP images."
        );
        assert_eq!(
            refused(load_ocr_file(&StorageBuckets::default(), KEY, None, &OWNERS).await),
            "File storage is not configured."
        );
        // Another workspace's file reads as a missing one.
        let theirs = "workspaces/org_2/a/theirs.pdf";
        assert_eq!(
            refused(load_ocr_file(&stored, theirs, None, &OWNERS).await),
            format!("File not found: {theirs}")
        );
        assert_eq!(
            refused(load_ocr_file(&stored, "workspaces/org_1/a/gone.pdf", None, &OWNERS).await),
            "File not found: workspaces/org_1/a/gone.pdf"
        );
        assert_eq!(
            refused(load_ocr_file(&stored, "workspaces/org_1/a/empty.pdf", None, &OWNERS).await),
            "The uploaded file is empty."
        );
        let heic = "workspaces/org_1/a/photo.heic";
        assert_eq!(
            refused(load_ocr_file(&stored, heic, Some("image/jpeg"), &OWNERS).await),
            "That file is not a PDF or a JPEG, PNG or WebP image. Take the photo again in the app."
        );
        assert_eq!(
            refused(load_ocr_file(&stored, heic, Some("APPLICATION/PDF"), &OWNERS).await),
            "That file is not a readable PDF."
        );
        assert_eq!(
            refused(load_ocr_file(&stored, "workspaces/org_1/a/big.png", None, &OWNERS).await),
            "The image is too large to read. Capture it again a bit closer or at lower quality."
        );
    }

    #[test]
    fn text_answers_parse_like_the_worker() {
        assert_eq!(
            parse_ocr_json("```json\n{\"total\": 12}\n```").expect("fenced"),
            json!({ "total": 12 })
        );
        assert_eq!(
            parse_ocr_json("Here you go: {\"a\": {\"b\": 1}} done").expect("embedded"),
            json!({ "a": { "b": 1 } })
        );
        for (text, message) in [
            ("no json here", "The model did not return JSON."),
            ("} {", "The model did not return JSON."),
            ("{ not json }", "The model returned invalid JSON."),
        ] {
            match parse_ocr_json(text) {
                Err(OcrFailure::Upstream(got)) => assert_eq!(got, message),
                other => panic!("{text}: {other:?}"),
            }
        }
    }

    /// Mistral as the install provider, answered by `fake`. (Native file
    /// input for a workspace that routed `books-ocr` to Claude, and its
    /// fallback to Mistral OCR, are the crate's: `weldsuite-ai`'s tests.)
    fn ai(fake: &FakeProvider) -> Ai {
        let config = AiConfig {
            default_provider: Some(ProviderId::Mistral),
            mistral: Endpoint {
                base_url: "https://api.mistral.ai/v1".to_owned(),
                api_key: Some("key".to_owned()),
            },
            ..AiConfig::default()
        };
        Ai::fake(config, fake.clone())
    }

    fn call() -> AiCall {
        AiCall::new("ws_1", Feature::BooksOcr, Task::Ocr, Tier::Free)
            .user("user_1")
            .op(OCR_OP)
            .reference("doc_1")
    }

    #[tokio::test]
    async fn mistral_ocr_extracts_the_fields_in_one_call() {
        let fields = json!({
            "vendor": { "name": null, "iban": "NL91ABNA0417164300" },
            "invoiceNumber": "F-2026-12",
            "invoiceDate": "24-08-2026",
            "currency": "EUR",
            "lineItems": [{ "description": "Paper", "quantity": 2, "unitPrice": 5, "taxRate": 21, "total": 10 }],
            "subtotal": 10,
            "taxBreakdown": [{ "rate": 21, "taxableAmount": 10, "taxAmount": 2.1 }],
            "totalTax": 2.1,
            "total": 12.1,
            "confidence": { "overall": 0.9 },
        });
        let fake = FakeProvider::new().reply_json(&fields);
        let file = OcrFile {
            bytes: pdf(),
            media_type: "application/pdf",
        };
        let (result, served) = read_document(&ai(&fake), &call(), file, Some("f.pdf"))
            .await
            .expect("read");
        assert_eq!(result, normalize_ocr_result(&fields));
        assert_eq!(result["invoiceDate"], json!("2026-08-24"));
        assert_eq!(result["vendor"]["iban"], json!("NL91ABNA0417164300"));
        assert_eq!(served.provider, ProviderId::Mistral);
        assert_eq!(served.meta()["region"], json!("eu"));

        let calls = fake.calls();
        assert_eq!(calls.len(), 1, "one OCR call does the extraction");
        let request = &calls[0];
        assert!(request.url.ends_with("/ocr"), "{}", request.url);
        assert_eq!(
            request.body["document"]["type"],
            json!("document_url"),
            "a PDF is sent as a document"
        );
        assert!(
            request.body["document"]["document_url"]
                .as_str()
                .is_some_and(|url| url.starts_with("data:application/pdf;base64,"))
        );
        assert_eq!(
            request.body["document_annotation_format"]["json_schema"]["schema"],
            extraction_schema()
        );
        let prompt = request.body["document_annotation_prompt"]
            .as_str()
            .expect("prompt");
        assert!(prompt.starts_with("You are an expert bookkeeper"));
        assert!(prompt.ends_with(USER_PROMPT));
    }

    #[tokio::test]
    async fn a_photo_is_sent_as_an_image() {
        let fake = FakeProvider::new().reply_json(&json!({ "total": 3 }));
        let file = OcrFile {
            bytes: png(),
            media_type: "image/png",
        };
        let (result, _) = read_document(&ai(&fake), &call(), file, None)
            .await
            .expect("read");
        assert_eq!(result["total"], json!(3));
        assert_eq!(fake.calls()[0].body["document"]["type"], json!("image_url"));
    }

    #[tokio::test]
    async fn a_refusal_is_the_workers_bad_gateway() {
        let fake = FakeProvider::new().reply_status(400, r#"{"message":"bad document"}"#);
        let file = OcrFile {
            bytes: pdf(),
            media_type: "application/pdf",
        };
        let failure = read_document(&ai(&fake), &call(), file, None)
            .await
            .expect_err("refused");
        let error = failure.into_api_error();
        assert_eq!(error.status(), http::StatusCode::BAD_GATEWAY);
        assert_eq!(error.code(), "UPSTREAM_ERROR");
    }
}
