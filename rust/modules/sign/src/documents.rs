//! The PDFs of a draft or a template (`packages/domains/sign/src/documents.ts`,
//! `routes/envelopes/documents.ts`). Originals go to the private bucket
//! untouched (ADR SIGN-004); the row keeps their page geometry and SHA-256,
//! which the certificate of completion quotes later.

use aws_lc_rs::digest;
use axum::body::Bytes;
use axum::extract::{FromRequest, Multipart, Path, Request, State};
use axum::response::{IntoResponse, Response};
use http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS};
use http::{HeaderMap, HeaderValue, StatusCode};
use lopdf::{Dictionary, Document, Object};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_ports::{FileStores, PutOptions, get_stored, is_safe_key};

use crate::envelopes::{
    document_dto, list_documents, load_draft, load_envelope, load_template, publish_updated,
    touch_envelope, viewer_of,
};
use crate::templates::publish_template_updated;
use crate::{Caller, SignError, SignResult, SignState, answer, sources, text, validate};

/// `SIGN_LIMITS`.
const MAX_DOCUMENTS: i64 = 10;
pub(crate) const MAX_DOCUMENT_BYTES: usize = 25 * 1024 * 1024;
const MAX_PAGES: usize = 500;

/// A request's draft or a template: who may change it, which event a change
/// publishes (`DraftScope`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scope {
    Envelope,
    Template,
}

impl Scope {
    /// The draft the caller may change, or a `SignError`.
    pub(crate) async fn load_editable(self, caller: &Caller, id: &str) -> SignResult<Value> {
        match self {
            Self::Envelope => load_draft(&caller.db, id, &viewer_of(caller).await?).await,
            Self::Template => load_template(&caller.db, id).await,
        }
    }

    /// The draft the caller may read.
    async fn load_readable(self, caller: &Caller, id: &str) -> SignResult<Value> {
        match self {
            Self::Envelope => load_envelope(&caller.db, id, &viewer_of(caller).await?).await,
            Self::Template => load_template(&caller.db, id).await,
        }
    }

    /// After a change: its entity event.
    pub(crate) fn changed(self, caller: &Caller, state: &SignState, row: &Value) {
        match self {
            Self::Envelope => publish_updated(caller, state, row),
            Self::Template => publish_template_updated(caller, state, row),
        }
    }
}

// ── PDFs ───────────────────────────────────────────────────────────────────

/// `Math.round(n * 100) / 100`.
fn round2(n: f64) -> f64 {
    (n * 100.0 + 0.5).floor() / 100.0
}

/// A number as JavaScript writes it in JSON (`612`, not `612.0`): `jsonb`
/// keeps the scale it was given.
fn js_number(n: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// An inheritable page attribute (`/MediaBox`, `/CropBox`, `/Rotate`): the
/// page's own, else its nearest ancestor's.
fn inherited<'a>(doc: &'a Document, page: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    let mut node = page;
    for _ in 0..64 {
        if let Ok(value) = node.get(key) {
            return Some(resolve(doc, value));
        }
        let parent = node.get(b"Parent").ok()?.as_reference().ok()?;
        node = doc.get_object(parent).ok()?.as_dict().ok()?;
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
        #[allow(clippy::cast_precision_loss)]
        Object::Integer(n) => Some(*n as f64),
        Object::Real(n) => Some(f64::from(*n)),
        _ => None,
    }
}

/// `[llx, lly, urx, ury]` as width and height (`asRectangle`).
fn rectangle(doc: &Document, object: &Object) -> Option<(f64, f64)> {
    let values: Vec<f64> = object
        .as_array()
        .ok()?
        .iter()
        .map(|n| number(doc, n))
        .collect::<Option<_>>()?;
    let [x1, y1, x2, y2] = values.as_slice() else {
        return None;
    };
    Some((x2 - x1, y2 - y1))
}

/// Check that `bytes` is a PDF WeldSign can work with and read its pages
/// (`inspectPdf`). Sizes are the crop box as a viewer displays it: width and
/// height swap on a page rotated by 90 or 270 degrees.
pub(crate) fn inspect_pdf(bytes: &[u8]) -> SignResult<(i64, Vec<Value>)> {
    // pdf-lib reads an encrypted file (it ignores the encryption) and then
    // refuses it; lopdf may not read it at all, so look for the trailer key.
    let encrypted = bytes.windows(8).any(|w| w == b"/Encrypt");
    let doc = match Document::load_mem(bytes) {
        Ok(doc) => doc,
        Err(_) if encrypted => return Err(password_protected()),
        Err(_) => return Err(SignError::invalid("This file is not a readable PDF")),
    };
    if encrypted || doc.trailer.get(b"Encrypt").is_ok() {
        return Err(password_protected());
    }
    let pages = doc.get_pages();
    if pages.is_empty() {
        return Err(SignError::invalid("This PDF has no pages"));
    }
    if pages.len() > MAX_PAGES {
        return Err(SignError::invalid(format!(
            "A PDF can have at most {MAX_PAGES} pages"
        )));
    }
    let mut sizes = Vec::with_capacity(pages.len());
    for id in pages.values() {
        let page = doc
            .get_object(*id)
            .and_then(Object::as_dict)
            .map_err(|_| SignError::invalid("This file is not a readable PDF"))?;
        let boxed = inherited(&doc, page, b"CropBox")
            .and_then(|b| rectangle(&doc, b))
            .or_else(|| inherited(&doc, page, b"MediaBox").and_then(|b| rectangle(&doc, b)))
            .ok_or_else(|| SignError::invalid("This file is not a readable PDF"))?;
        let angle = inherited(&doc, page, b"Rotate")
            .and_then(|r| number(&doc, r))
            .unwrap_or(0.0);
        let rotation = ((angle % 360.0) + 360.0) % 360.0;
        #[allow(clippy::float_cmp)]
        let quarter = rotation == 90.0 || rotation == 270.0;
        let (width, height) = if quarter { (boxed.1, boxed.0) } else { boxed };
        let mut size = json!({
            "width": js_number(round2(width)),
            "height": js_number(round2(height)),
        });
        if rotation != 0.0 {
            size["rotation"] = js_number(rotation);
        }
        sizes.push(size);
    }
    Ok((i64::try_from(pages.len()).unwrap_or(i64::MAX), sizes))
}

fn password_protected() -> SignError {
    SignError::invalid("Password-protected PDFs cannot be signed; remove the password first")
}

fn too_big() -> SignError {
    SignError::invalid(format!(
        "A PDF can be at most {} MB",
        MAX_DOCUMENT_BYTES / (1024 * 1024)
    ))
}

fn document_key(org_id: &str, envelope_id: &str, document_id: &str) -> String {
    format!("workspaces/{org_id}/weldsign/{envelope_id}/documents/{document_id}.pdf")
}

/// A file name without any path, ending in `.pdf` (`documentName`).
pub(crate) fn document_name(file_name: &str) -> String {
    let base = file_name
        .rsplit(['/', '\\'])
        .next()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .unwrap_or("document.pdf");
    // `base.slice(base.length - 255)`, in UTF-16 units as JavaScript counts.
    let units: Vec<u16> = base.encode_utf16().collect();
    let name = if units.len() > 255 {
        String::from_utf16_lossy(&units[units.len() - 255..])
    } else {
        base.to_owned()
    };
    if name.to_ascii_lowercase().ends_with(".pdf") {
        name
    } else {
        format!("{name}.pdf")
    }
}

async fn get_document(db: &PgPool, envelope_id: &str, document_id: &str) -> SignResult<Value> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(d) from sign_documents d where id = $1 and envelope_id = $2 limit 1",
    )
    .bind(document_id)
    .bind(envelope_id)
    .fetch_optional(db)
    .await?;
    row.map(js_row).ok_or(SignError::NotFound("Document"))
}

fn files_of(caller: &Caller, state: &SignState) -> SignResult<FileStores> {
    caller
        .files(state)
        .ok_or_else(|| SignError::Internal("no file store configured (S3_ENDPOINT)".to_owned()))
}

/// Validate, store and record a PDF (`addDocument`). The bucket write comes
/// before the row, so a row never points at nothing.
async fn add_document(
    caller: &Caller,
    files: &FileStores,
    org_id: &str,
    envelope: &Value,
    file_name: &str,
    bytes: Vec<u8>,
) -> SignResult<Value> {
    if bytes.is_empty() {
        return Err(SignError::invalid("The file is empty"));
    }
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(too_big());
    }
    let envelope_id = text(envelope, "id");
    let (existing, last): (i64, Option<i32>) =
        sqlx::query_as("select count(*), max(position) from sign_documents where envelope_id = $1")
            .bind(envelope_id)
            .fetch_one(&caller.db)
            .await?;
    if existing >= MAX_DOCUMENTS {
        return Err(SignError::invalid(format!(
            "An envelope can hold at most {MAX_DOCUMENTS} documents"
        )));
    }

    let (page_count, page_sizes) = inspect_pdf(&bytes)?;
    let id = generate_id("sgd");
    let key = document_key(org_id, envelope_id, &id);
    let sha256 = hex::encode(digest::digest(&digest::SHA256, &bytes).as_ref());
    let size = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
    files
        .private
        .put_boxed(
            &key,
            bytes,
            &PutOptions::content_type("application/pdf").with_metadata("sha256", &sha256),
        )
        .await
        .map_err(|e| storage_error(&e))?;

    let position = last.map_or(0, |n| n + 1);
    let row: Value = sqlx::query_scalar(
        "insert into sign_documents
             (id, envelope_id, name, position, storage_key, size_bytes, page_count, page_sizes, sha256)
         values ($1, $2, $3, $4, $5, $6::int, $7::int, $8, $9)
         returning to_jsonb(sign_documents)",
    )
    .bind(&id)
    .bind(envelope_id)
    .bind(document_name(file_name))
    .bind(position)
    .bind(&key)
    .bind(size)
    .bind(page_count)
    .bind(Value::Array(page_sizes))
    .bind(&sha256)
    .fetch_one(&caller.db)
    .await?;
    Ok(js_row(row))
}

fn storage_error(error: &weldsuite_ports::PortError) -> SignError {
    SignError::Internal(format!("file store: {error}"))
}

/// Remove files without holding up the response (`waitUntil(bucket.delete)`).
pub(crate) fn delete_files_later(caller: &Caller, state: &SignState, keys: Vec<String>) {
    if keys.is_empty() {
        return;
    }
    let Some(files) = caller.files(state) else {
        tracing::warn!(
            count = keys.len(),
            "sign: no file store; files of a deleted draft stay"
        );
        return;
    };
    state.events.tracker().spawn(async move {
        if let Err(error) = files.private.delete_many_boxed(&keys).await {
            tracing::error!(%error, "sign: deleting files failed");
        }
    });
}

// ── POST / (multipart upload) ──────────────────────────────────────────────

/// The upload's `file` field (`c.req.parseBody()`): its name and bytes.
/// `None` when the body is not multipart or `file` is not a file; the last
/// `file` field wins, as in Hono.
async fn uploaded_file(request: Request) -> Option<(String, Vec<u8>)> {
    let mut multipart = Multipart::from_request(request, &()).await.ok()?;
    let mut found = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() != Some("file") {
            continue;
        }
        let name = field.file_name().map(str::to_owned);
        let bytes = field.bytes().await.ok()?;
        found = name.map(|name| (name, bytes.to_vec()));
    }
    found
}

async fn upload(
    scope: Scope,
    state: SignState,
    caller: Caller,
    id: String,
    request: Request,
) -> Response {
    answer(
        async {
            // The PDF is stored under workspaces/<org>/…, keyed by the Clerk org id.
            let Some(org_id) = caller.clerk_org_id.clone() else {
                return Ok(ApiError::org_required().into_response());
            };
            let envelope = scope.load_editable(&caller, &id).await?;
            let Some((file_name, bytes)) = uploaded_file(request).await else {
                return Err(SignError::invalid(
                    "Send the PDF as a multipart \"file\" field",
                ));
            };
            let files = files_of(&caller, &state)?;
            let doc = add_document(&caller, &files, &org_id, &envelope, &file_name, bytes).await?;
            touch_envelope(&caller.db, text(&envelope, "id")).await?;
            scope.changed(&caller, &state, &envelope);
            Ok(Created(document_dto(&doc)).into_response())
        }
        .await,
    )
}

pub(crate) async fn upload_envelope(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    upload(Scope::Envelope, state, caller, id, request).await
}

pub(crate) async fn upload_template(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    upload(Scope::Template, state, caller, id, request).await
}

// ── POST /from-drive ───────────────────────────────────────────────────────

/// The workspace a key belongs to (`workspaces/<id>/…`), when it is a safe
/// key of `org_id` (`isWorkspaceObjectKey`).
fn is_workspace_key(key: &str, org_id: &str) -> bool {
    let mut parts = key.split('/');
    let (Some("workspaces"), Some(owner), Some(_)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    is_safe_key(key)
        && !owner.is_empty()
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && owner == org_id
}

async fn from_drive(
    scope: Scope,
    state: SignState,
    caller: Caller,
    id: String,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let file_id = validate(&headers, &body, |issues, fields| {
                issues.text_with(
                    fields,
                    "fileId",
                    Presence::Required,
                    Text::length(Some(1), Some(255)),
                )
            })?
            .into_option()
            .unwrap_or_default();
            let Some(org_id) = caller.clerk_org_id.clone() else {
                return Ok(ApiError::org_required().into_response());
            };
            let envelope = scope.load_editable(&caller, &id).await?;
            let file = sources::visible_drive_file(&caller.db, &caller.user_id, &file_id).await?;
            let missing = || SignError::NotFound("File");
            let Some(file) = file else {
                return Err(missing());
            };
            let row = &file.row;
            let key = [&row["fileKey"], &row["storagePath"]]
                .into_iter()
                .filter_map(Value::as_str)
                .find(|k| !k.is_empty())
                .map(str::to_owned);
            // A row's key is client-supplied: only ever read this workspace's objects.
            let Some(key) = key.filter(|k| is_workspace_key(k, &org_id)) else {
                return Err(missing());
            };
            if row["mimeType"] != "application/pdf"
                && !file.file_name.to_lowercase().ends_with(".pdf")
            {
                return Err(SignError::invalid("Only PDF files can be signed"));
            }
            // Drive files have no body cap: refuse a big one before reading it.
            #[allow(clippy::cast_precision_loss)]
            if row["fileSize"].as_f64().unwrap_or(0.0) > MAX_DOCUMENT_BYTES as f64 {
                return Err(too_big());
            }
            let files = files_of(&caller, &state)?;
            let object = get_stored(&*files.private, files.public.as_deref(), &key)
                .await
                .map_err(|e| storage_error(&e))?
                .ok_or_else(missing)?;
            if object.bytes.len() > MAX_DOCUMENT_BYTES {
                return Err(too_big());
            }
            let doc = add_document(
                &caller,
                &files,
                &org_id,
                &envelope,
                &file.file_name,
                object.bytes,
            )
            .await?;
            touch_envelope(&caller.db, text(&envelope, "id")).await?;
            scope.changed(&caller, &state, &envelope);
            Ok(Created(document_dto(&doc)).into_response())
        }
        .await,
    )
}

pub(crate) async fn from_drive_envelope(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    from_drive(Scope::Envelope, state, caller, id, headers, body).await
}

pub(crate) async fn from_drive_template(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    from_drive(Scope::Template, state, caller, id, headers, body).await
}

// ── PUT /order ─────────────────────────────────────────────────────────────

async fn reorder(
    scope: Scope,
    state: SignState,
    caller: Caller,
    id: String,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let ids = validate(&headers, &body, |issues, fields| {
                #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
                let max = Some(MAX_DOCUMENTS as usize);
                issues.list(
                    fields,
                    "documentIds",
                    Presence::Required,
                    Some(1),
                    max,
                    |issues, item| issues.item_text(item, Text::length(Some(1), None)),
                )
            })?
            .into_option()
            .unwrap_or_default();
            let envelope = scope.load_editable(&caller, &id).await?;
            let envelope_id = text(&envelope, "id");
            let docs = list_documents(&caller.db, envelope_id).await?;
            let known: Vec<&str> = docs.iter().map(|d| text(d, "id")).collect();
            let mut unique = ids.clone();
            unique.sort();
            unique.dedup();
            if ids.len() != docs.len()
                || unique.len() != ids.len()
                || ids.iter().any(|id| !known.contains(&id.as_str()))
            {
                return Err(SignError::invalid(
                    "documentIds must list every document of the envelope exactly once",
                ));
            }
            for (position, document_id) in ids.iter().enumerate() {
                sqlx::query("update sign_documents set position = $2::int where id = $1")
                    .bind(document_id)
                    .bind(i64::try_from(position).unwrap_or(i64::MAX))
                    .execute(&caller.db)
                    .await?;
            }
            let docs = list_documents(&caller.db, envelope_id).await?;
            touch_envelope(&caller.db, envelope_id).await?;
            scope.changed(&caller, &state, &envelope);
            Ok(Data(docs.iter().map(document_dto).collect::<Vec<_>>()).into_response())
        }
        .await,
    )
}

pub(crate) async fn reorder_envelope(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    reorder(Scope::Envelope, state, caller, id, headers, body).await
}

pub(crate) async fn reorder_template(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    reorder(Scope::Template, state, caller, id, headers, body).await
}

// ── GET /:documentId/content ───────────────────────────────────────────────

async fn content(
    scope: Scope,
    state: SignState,
    caller: Caller,
    id: String,
    document_id: String,
) -> Response {
    answer(
        async {
            let envelope = scope.load_readable(&caller, &id).await?;
            let doc = get_document(&caller.db, text(&envelope, "id"), &document_id).await?;
            let files = files_of(&caller, &state)?;
            let object = files
                .private
                .get_boxed(text(&doc, "storageKey"))
                .await
                .map_err(|e| storage_error(&e))?;
            let Some(object) = object else {
                return Ok(
                    ApiError::not_found("Document file", Some(text(&doc, "id"))).into_response()
                );
            };
            let name = text(&doc, "name").replace('"', "");
            let disposition = HeaderValue::from_str(&format!("inline; filename=\"{name}\""))
                .unwrap_or_else(|_| HeaderValue::from_static("inline"));
            let mut response = (StatusCode::OK, object.bytes).into_response();
            let headers = response.headers_mut();
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
            headers.insert(CONTENT_DISPOSITION, disposition);
            headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
            headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            Ok(response)
        }
        .await,
    )
}

pub(crate) async fn content_envelope(
    State(state): State<SignState>,
    caller: Caller,
    Path((id, document_id)): Path<(String, String)>,
) -> Response {
    content(Scope::Envelope, state, caller, id, document_id).await
}

pub(crate) async fn content_template(
    State(state): State<SignState>,
    caller: Caller,
    Path((id, document_id)): Path<(String, String)>,
) -> Response {
    content(Scope::Template, state, caller, id, document_id).await
}

// ── DELETE /:documentId ────────────────────────────────────────────────────

async fn remove(
    scope: Scope,
    state: SignState,
    caller: Caller,
    id: String,
    document_id: String,
) -> Response {
    answer(
        async {
            let envelope = scope.load_editable(&caller, &id).await?;
            let envelope_id = text(&envelope, "id");
            let doc = get_document(&caller.db, envelope_id, &document_id).await?;
            let doc_id = text(&doc, "id");
            sqlx::query("delete from sign_fields where document_id = $1")
                .bind(doc_id)
                .execute(&caller.db)
                .await?;
            sqlx::query("delete from sign_documents where id = $1")
                .bind(doc_id)
                .execute(&caller.db)
                .await?;
            // Close the gap so positions stay 0..n-1.
            for (index, rest) in list_documents(&caller.db, envelope_id)
                .await?
                .iter()
                .enumerate()
            {
                let index = i64::try_from(index).unwrap_or(i64::MAX);
                if rest["position"].as_i64() != Some(index) {
                    sqlx::query("update sign_documents set position = $2::int where id = $1")
                        .bind(text(rest, "id"))
                        .bind(index)
                        .execute(&caller.db)
                        .await?;
                }
            }
            delete_files_later(&caller, &state, vec![text(&doc, "storageKey").to_owned()]);
            touch_envelope(&caller.db, envelope_id).await?;
            scope.changed(&caller, &state, &envelope);
            Ok(NoContent.into_response())
        }
        .await,
    )
}

pub(crate) async fn remove_envelope(
    State(state): State<SignState>,
    caller: Caller,
    Path((id, document_id)): Path<(String, String)>,
) -> Response {
    remove(Scope::Envelope, state, caller, id, document_id).await
}

pub(crate) async fn remove_template(
    State(state): State<SignState>,
    caller: Caller,
    Path((id, document_id)): Path<(String, String)>,
) -> Response {
    remove(Scope::Template, state, caller, id, document_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_names_like_typescript() {
        assert_eq!(document_name("C:\\docs\\Offer.PDF"), "Offer.PDF");
        assert_eq!(document_name("a/b/contract"), "contract.pdf");
        assert_eq!(document_name("  "), "document.pdf");
        assert_eq!(document_name(""), "document.pdf");
        let long = format!("{}.pdf", "x".repeat(300));
        assert_eq!(document_name(&long).len(), 255);
    }

    #[test]
    fn workspace_keys() {
        assert!(is_workspace_key("workspaces/org_1/drive/a.pdf", "org_1"));
        assert!(!is_workspace_key("workspaces/org_2/drive/a.pdf", "org_1"));
        assert!(!is_workspace_key("workspaces/org_1/../x", "org_1"));
        assert!(!is_workspace_key("workspaces/org_1", "org_1"));
        assert!(!is_workspace_key("other/org_1/a", "org_1"));
    }

    #[test]
    fn rounding_and_numbers_like_javascript() {
        assert_eq!(round2(595.276), 595.28);
        assert_eq!(js_number(612.0), json!(612));
        assert_eq!(js_number(595.28), json!(595.28));
    }
}
