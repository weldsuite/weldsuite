//! Streaming a stored invoice or bill attachment (`lib/document-attachment.ts`)
//! after checking the key belongs to the document and to this workspace.

use axum::response::IntoResponse;
use http::StatusCode;
use http::header::{CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_TYPE, ETAG, HeaderValue};
use serde_json::Value;
use weldsuite_kit::ApiError;
use weldsuite_ports::{FileStore, StorageBuckets};

use crate::http::{BooksState, Caller, Refusal, Reply};

/// `workspaceOfKey(key)`: `workspaces/<id>/…`'s id.
fn workspace_of_key(key: &str) -> Option<&str> {
    let mut parts = key.split('/');
    if parts.next() != Some("workspaces") {
        return None;
    }
    let id = parts.next()?;
    parts.next()?;
    (!id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    .then_some(id)
}

/// `isWorkspaceObjectKey(key, ...workspaceIds)`.
pub fn is_workspace_object_key(key: &str, workspace_ids: &[Option<&str>]) -> bool {
    weldsuite_ports::is_safe_key(key)
        && workspace_of_key(key).is_some_and(|owner| workspace_ids.contains(&Some(owner)))
}

fn header(value: &str) -> HeaderValue {
    HeaderValue::from_str(value).unwrap_or_else(|_| HeaderValue::from_static(""))
}

/// `streamDocumentAttachment(c, { attachmentKeys, index })`: `index_param`
/// is the raw `:index` (read with `Number()`).
pub async fn stream_document_attachment(
    caller: &Caller,
    state: &BooksState,
    attachment_keys: Option<&Value>,
    index_param: &str,
) -> Reply {
    let index = weldsuite_kit::validation::js_number(index_param);
    if !(index.is_finite() && index.fract() == 0.0 && index >= 0.0) {
        return Err(Refusal::bad_request("Invalid attachment index"));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let position = index as usize;
    let file_key = attachment_keys
        .and_then(Value::as_array)
        .and_then(|keys| keys.get(position))
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty());
    let Some(file_key) = file_key else {
        return Err(Refusal::not_found(
            "Attachment",
            &crate::js::number_text(index),
        ));
    };
    let org = caller
        .clerk_org_id
        .as_deref()
        .map(crate::jurisdictions::js_trim)
        .filter(|org| !org.is_empty());
    let Some(org) = org else {
        return Err(ApiError::org_required().into());
    };
    // Uploads sit under the Clerk org id, accounting-inbox mail under `workspaces.id`.
    if !is_workspace_object_key(file_key, &[Some(org), Some(caller.workspace_id.as_str())]) {
        return Err(Refusal::forbidden("Attachment is outside this workspace"));
    }
    let buckets: StorageBuckets = caller.buckets(state);
    if buckets.private.is_none() && buckets.public.is_none() {
        return Err(Refusal::Response(Box::new(
            ApiError::internal()
                .with_message("Storage is not configured")
                .into_response(),
        )));
    }
    let mut found = None;
    for bucket in [&buckets.private, &buckets.public].into_iter().flatten() {
        match bucket.get(file_key).await {
            Ok(Some(object)) => {
                found = Some(object);
                break;
            }
            Ok(None) => {}
            Err(error) => return Err(Refusal::Internal(error.to_string())),
        }
    }
    let Some(object) = found else {
        return Err(Refusal::not_found("Attachment", file_key));
    };
    let filename = file_key
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("attachment")
        .replace('"', "");
    let mut response = (StatusCode::OK, object.bytes).into_response();
    let headers = response.headers_mut();
    // `writeHttpMetadata`
    if let Some(content_type) = &object.info.content_type {
        headers.insert(CONTENT_TYPE, header(content_type));
    }
    if let Some(etag) = &object.info.etag {
        headers.insert(ETAG, header(&format!("\"{etag}\"")));
    }
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    headers.insert(
        CONTENT_DISPOSITION,
        header(&format!("inline; filename=\"{filename}\"")),
    );
    Ok(response)
}
