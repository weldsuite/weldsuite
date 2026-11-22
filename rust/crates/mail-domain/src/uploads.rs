//! Compose attachments uploaded through the public API
//! (`@weldsuite/mail-domain/uploads`).
//!
//! The send path takes attachments as storage keys under the workspace's
//! prefix (`workspaces/{orgId}/…`). API callers upload here and get an opaque
//! id back, which they pass as `attachmentIds` on a send or a draft. No table
//! is behind an upload: the object carries its file name and content type,
//! and its key is derived from the id, which is checked against a strict
//! pattern first, so a lookup can never leave the workspace's upload folder.
//! Uploads go to the public bucket (`STORAGE`), as the worker puts them.

use serde_json::{Value, json};
use weldsuite_kit::generate_id;
use weldsuite_ports::{DynFileStore, PutOptions};

use crate::outbound::clock::{iso, now_ms};
use crate::send::{MAX_EMAIL_SIZE_BYTES, SendAttachmentInput, SendError};
use crate::text::{js_trim, utf16_prefix};

/// One file may use the whole message budget; the send path enforces the
/// total.
pub const MAX_UPLOAD_BYTES: usize = MAX_EMAIL_SIZE_BYTES;

/// `MailUploadError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MailUploadError {
    StorageBindingMissing,
    EmptyFile,
    FileTooLarge,
    /// The bucket failed: the worker's unhandled error.
    Store(String),
}

impl MailUploadError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::StorageBindingMissing => "STORAGE_BINDING_MISSING",
            Self::EmptyFile => "EMPTY_FILE",
            Self::FileTooLarge => "FILE_TOO_LARGE",
            Self::Store(_) => "INTERNAL_ERROR",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::StorageBindingMissing => "Storage binding not configured".to_owned(),
            Self::EmptyFile => "The file is empty".to_owned(),
            Self::FileTooLarge => format!(
                "Files are limited to {} MB, the size limit of a whole email.",
                MAX_UPLOAD_BYTES / (1024 * 1024)
            ),
            Self::Store(error) => error.clone(),
        }
    }
}

fn upload_prefix(org: &str, id: &str) -> String {
    format!("workspaces/{org}/mail/uploads/{id}/")
}

/// `[\w]` as JavaScript reads it without the `u` flag.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Every run of characters `keep` refuses, as one `_`.
fn replace_runs(text: &str, keep: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if keep(c) {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    out
}

/// `safeFilename(name)`: a file name safe as the key's last segment, its
/// extension kept.
fn safe_filename(name: &str) -> String {
    let slashes = replace_runs(name, |c| c != '\\' && c != '/');
    let cleaned = replace_runs(&slashes, |c| is_word(c) || matches!(c, '.' | '-' | ' '));
    let cleaned: String = cleaned.trim().chars().take(200).collect();
    if cleaned.is_empty() {
        "attachment".to_owned()
    } else {
        cleaned
    }
}

/// `isUploadId(id)`: `/^mupl_[a-z0-9]{8,40}$/`.
pub fn is_upload_id(id: &str) -> bool {
    id.strip_prefix("mupl_").is_some_and(|rest| {
        (8..=40).contains(&rest.len())
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    })
}

/// `storeMailUpload(env, orgId, input)`: the upload's id, name, type, size
/// and time, as the API answers them.
pub async fn store_mail_upload(
    store: Option<&dyn DynFileStore>,
    org: &str,
    filename: &str,
    content_type: Option<&str>,
    content: Vec<u8>,
) -> Result<Value, MailUploadError> {
    let Some(store) = store else {
        return Err(MailUploadError::StorageBindingMissing);
    };
    if content.is_empty() {
        return Err(MailUploadError::EmptyFile);
    }
    if content.len() > MAX_UPLOAD_BYTES {
        return Err(MailUploadError::FileTooLarge);
    }
    let id = generate_id("mupl");
    let name = utf16_prefix(js_trim(filename), 500);
    let name = if name.is_empty() { "attachment" } else { name };
    let content_type = content_type
        .filter(|t| !t.is_empty())
        .unwrap_or("application/octet-stream");
    let created_at = iso(now_ms());
    let size = content.len();
    let options = PutOptions::content_type(content_type)
        .with_metadata("filename", name)
        .with_metadata("createdAt", created_at.clone());
    let key = format!("{}{}", upload_prefix(org, &id), safe_filename(name));
    store
        .put_boxed(&key, content, &options)
        .await
        .map_err(|error| MailUploadError::Store(error.to_string()))?;
    Ok(json!({
        "id": id,
        "filename": name,
        "contentType": content_type,
        "size": size,
        "createdAt": created_at,
    }))
}

/// `findUploadObject(env, orgId, id)`: the upload's key and what the object
/// says about itself, or `None` when there is no such upload here.
async fn find_upload(
    store: &dyn DynFileStore,
    org: &str,
    id: &str,
) -> Result<Option<(String, weldsuite_ports::ObjectInfo)>, SendError> {
    if !is_upload_id(id) {
        return Ok(None);
    }
    let listed = store
        .list_boxed(&upload_prefix(org, id))
        .await
        .map_err(|error| SendError::Internal(error.to_string()))?;
    let Some(key) = listed.into_iter().next().map(|object| object.key) else {
        return Ok(None);
    };
    let head = store
        .head_boxed(&key)
        .await
        .map_err(|error| SendError::Internal(error.to_string()))?;
    Ok(head.map(|info| (key, info)))
}

/// `resolveMailUploads(env, orgId, ids)`: upload ids as the attachments the
/// send path takes. `ATTACHMENT_NOT_IN_STORAGE` names the first id that is
/// no upload of this workspace (another workspace's id resolves to nothing,
/// by key).
pub async fn resolve_mail_uploads(
    store: Option<&dyn DynFileStore>,
    org: &str,
    ids: &[String],
) -> Result<Vec<SendAttachmentInput>, SendError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let Some(store) = store else {
        return Err(SendError::mail(
            "STORAGE_BINDING_MISSING",
            "Storage binding not configured",
        ));
    };
    let mut seen: Vec<&str> = Vec::new();
    let mut resolved = Vec::new();
    for id in ids {
        if seen.contains(&id.as_str()) {
            continue;
        }
        seen.push(id);
        let Some((key, info)) = find_upload(store, org, id).await? else {
            return Err(SendError::Mail {
                code: "ATTACHMENT_NOT_IN_STORAGE".to_owned(),
                message: format!("Attachment upload {id} not found"),
                details: Some(json!({ "id": id })),
            });
        };
        let filename = info
            .metadata
            .get("filename")
            .cloned()
            .unwrap_or_else(|| key.rsplit('/').next().unwrap_or_default().to_owned());
        resolved.push(SendAttachmentInput {
            filename,
            content_type: info.content_type.clone(),
            size: i64::try_from(info.size).unwrap_or(i64::MAX),
            file_key: key,
        });
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_made_safe_like_the_worker() {
        assert_eq!(safe_filename("report.txt"), "report.txt");
        assert_eq!(safe_filename("a/b\\\\c.pdf"), "a_b_c.pdf");
        assert_eq!(safe_filename("résumé 2026.pdf"), "r_sum_ 2026.pdf");
        assert_eq!(safe_filename("  ///  "), "_");
        assert_eq!(safe_filename(""), "attachment");
    }

    #[test]
    fn upload_ids_follow_the_pattern() {
        assert!(is_upload_id("mupl_abc12345"));
        assert!(!is_upload_id("mupl_ABC12345"));
        assert!(!is_upload_id("mupl_abc"));
        assert!(!is_upload_id("../mupl_abc12345"));
        assert!(is_upload_id(&generate_id("mupl")));
    }
}
