//! The upload broker's rules (`apps/workers/app-api/src/lib/storage-upload.ts`):
//! the `generate-upload-url` body, object keys, and the pending upload a
//! token stands for in the cache (`upload:<token>`, ten minutes).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use weldsuite_kit::id::ALPHANUMERIC;
use weldsuite_kit::random_string;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};

/// Hard cap on one brokered upload (`MAX_UPLOAD_BYTES`).
pub(crate) const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;

const MAX_FILE_NAME_LENGTH: usize = 255;
const MAX_FOLDER_SEGMENTS: usize = 3;

/// Cache keys of pending uploads, and how long a token lives.
pub(crate) const UPLOAD_TOKEN_PREFIX: &str = "upload:";
pub(crate) const UPLOAD_TOKEN_TTL: Duration = Duration::from_secs(600);

/// Fixed-key public images: always the public bucket, whatever `isPublic`
/// says.
pub(crate) const ALWAYS_PUBLIC_ENTITY_TYPES: [&str; 3] =
    ["customer-avatar", "contact-avatar", "user-app-logo"];

const FOLDER_MESSAGE: &str =
    "folder must be 1-3 segments of lowercase letters, digits, '-' or '_', separated by '/'";
const ENTITY_TYPE_MESSAGE: &str =
    "entityType must be lowercase letters, digits, '-' or '_' (max 48 characters)";
const ENTITY_ID_MESSAGE: &str = "entityId must be letters, digits, '-' or '_' (max 64 characters)";

/// The upload token is the only credential on the unauthenticated PUT: 32
/// secure random characters (~190 bits).
pub(crate) fn generate_upload_token() -> String {
    format!("upl_{}", random_string(32, ALPHANUMERIC))
}

/// `Date.now()`.
pub(crate) fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// One `folder` / `entityType` segment (`SEGMENT`): lowercase letters,
/// digits, `_` and `-`, starting with a letter or digit, at most 48.
fn is_segment(value: &str) -> bool {
    let mut bytes = value.bytes();
    value.len() <= 48
        && bytes
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// `isSafeFolder`: one to three safe segments joined by `/`.
pub(crate) fn is_safe_folder(value: &str) -> bool {
    let segments: Vec<&str> = value.split('/').collect();
    segments.len() <= MAX_FOLDER_SEGMENTS && segments.iter().all(|s| is_segment(s))
}

/// `isSafeEntityId`: the `generateId` charset, 1–64 characters.
pub(crate) fn is_safe_entity_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A validated `POST /generate-upload-url` body.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct UploadRequest {
    pub(crate) file_name: String,
    pub(crate) content_type: String,
    pub(crate) file_size: u64,
    pub(crate) folder: Option<String>,
    pub(crate) entity_type: Option<String>,
    pub(crate) entity_id: Option<String>,
    pub(crate) is_public: bool,
}

/// `generateUploadUrlRequestSchema`, with Zod's issue order under
/// `safeParseAsync`: the plain fields (and `isPublic`) first, then the
/// preprocessed ones (an empty string counts as absent), then the
/// refinements.
pub(crate) fn read_upload_request(issues: &mut Issues, body: &Map<String, Value>) -> UploadRequest {
    let file_name = issues
        .text(
            body,
            "fileName",
            Presence::Required,
            Some(1),
            Some(MAX_FILE_NAME_LENGTH),
        )
        .into_option();
    let content_type = issues
        .text(body, "contentType", Presence::Required, Some(1), None)
        .into_option();
    let file_size = file_size(issues, body);
    let is_public = issues
        .boolean(body, "isPublic", Presence::Optional)
        .into_option()
        .unwrap_or(false);

    // `z.preprocess(emptyToUndefined, …)`: '' is absent.
    let present = |key: &str| -> Map<String, Value> {
        body.get(key)
            .filter(|value| value.as_str() != Some(""))
            .map(|value| Map::from_iter([(key.to_owned(), value.clone())]))
            .unwrap_or_default()
    };
    let folder = issues
        .text_with(
            &present("folder"),
            "folder",
            Presence::Optional,
            Text::default(),
        )
        .into_option();
    let entity_type = issues
        .text_with(
            &present("entityType"),
            "entityType",
            Presence::Optional,
            Text::default(),
        )
        .into_option();
    let entity_id = match issues.text_with(
        &present("entityId"),
        "entityId",
        Presence::Nullish,
        Text::default(),
    ) {
        Field::Set(id) => Some(id),
        Field::Null | Field::Absent => None,
    };

    let folder = refine(issues, "folder", folder, is_safe_folder, FOLDER_MESSAGE);
    let entity_type = refine(
        issues,
        "entityType",
        entity_type,
        is_segment,
        ENTITY_TYPE_MESSAGE,
    );
    let entity_id = refine(
        issues,
        "entityId",
        entity_id,
        is_safe_entity_id,
        ENTITY_ID_MESSAGE,
    );

    UploadRequest {
        file_name: file_name.unwrap_or_default(),
        content_type: content_type.unwrap_or_default(),
        file_size: file_size.unwrap_or_default(),
        folder,
        entity_type,
        entity_id,
        is_public,
    }
}

/// `.refine(check, { message })` on a string that passed its type check.
fn refine(
    issues: &mut Issues,
    key: &str,
    value: Option<String>,
    check: fn(&str) -> bool,
    message: &str,
) -> Option<String> {
    match value {
        Some(text) if check(&text) => Some(text),
        Some(_) => {
            issues.custom(key, message);
            None
        }
        None => None,
    }
}

/// `z.number().int().min(0).max(MAX_UPLOAD_BYTES, message)`.
fn file_size(issues: &mut Issues, body: &Map<String, Value>) -> Option<u64> {
    // The cap's own message replaces Zod's: read the number without a max,
    // then check it.
    let rules = Number {
        int: true,
        min: Some(0.0),
        ..Number::default()
    };
    let size = issues
        .whole_number(body, "fileSize", Presence::Required, rules)
        .into_option()?;
    let size = u64::try_from(size).ok()?;
    if size > MAX_UPLOAD_BYTES {
        #[allow(clippy::cast_precision_loss)] // 100 MiB is exact in an f64
        issues.number_too_big(
            "fileSize",
            MAX_UPLOAD_BYTES as f64,
            &format!("fileSize must not exceed {MAX_UPLOAD_BYTES} bytes"),
        );
        return None;
    }
    Some(size)
}

/// `avatarExtension`: a short alphanumeric extension, else `png`.
pub(crate) fn avatar_extension(file_name: &str) -> String {
    let Some(dot) = file_name.rfind('.') else {
        return "png".to_owned();
    };
    let extension = file_name[dot + 1..].to_lowercase();
    if (1..=8).contains(&extension.len())
        && extension
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        extension
    } else {
        "png".to_owned()
    }
}

/// `sanitizeFileName`: letters, digits, `.`, `-`, `_` kept, anything else
/// `_` per UTF-16 unit (the regex has no `u` flag); only dots is `file`.
pub(crate) fn sanitize_file_name(file_name: &str) -> String {
    let mut cleaned = String::with_capacity(file_name.len());
    for c in file_name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
            cleaned.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                cleaned.push('_');
            }
        }
    }
    if cleaned.bytes().all(|b| b == b'.') {
        "file".to_owned()
    } else {
        cleaned
    }
}

/// `crypto.randomUUID().replace(/-/g, '')`: a version 4 UUID as 32 hex digits.
fn unguessable() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the operating system has a random source");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    hex::encode(bytes)
}

/// `buildUploadKey`: the object key for an upload, and whether it is
/// written create-only (keys with a random segment; avatar and logo keys
/// are fixed and meant to be replaced).
pub(crate) fn build_upload_key(workspace_id: &str, input: &UploadRequest) -> (String, bool) {
    let fixed = match (input.entity_type.as_deref(), input.entity_id.as_deref()) {
        (Some("customer-avatar"), Some(id)) => Some(format!("avatars/customers/{id}")),
        (Some("contact-avatar"), Some(id)) => Some(format!("avatars/contacts/{id}")),
        (Some("user-app-logo"), Some(id)) => Some(format!("user-apps/{id}")),
        _ => None,
    };
    if let Some(prefix) = fixed {
        let extension = avatar_extension(&input.file_name);
        return (
            format!("workspaces/{workspace_id}/{prefix}/logo.{extension}"),
            false,
        );
    }
    let entity_path = match (input.entity_type.as_deref(), input.entity_id.as_deref()) {
        (Some(kind), Some(id)) => format!("{kind}/{id}"),
        _ => "general".to_owned(),
    };
    let folder = input.folder.as_deref().unwrap_or("uploads");
    (
        format!(
            "workspaces/{workspace_id}/{folder}/{entity_path}/{}_{}/{}",
            now_millis(),
            unguessable(),
            sanitize_file_name(&input.file_name)
        ),
        true,
    )
}

/// What an upload token stands for, as JSON in the cache (`PendingUpload`),
/// field for field the TypeScript record, so either backend reads the
/// other's tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingUpload {
    pub(crate) file_key: String,
    /// What the client declared; the stored type is derived from it on use.
    pub(crate) content_type: String,
    pub(crate) file_name: String,
    pub(crate) file_size: u64,
    #[serde(default)]
    pub(crate) is_public: bool,
    /// The bucket the PUT writes to; absent on old tokens (public).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) bucket: Option<String>,
    pub(crate) user_id: String,
    #[serde(default)]
    pub(crate) created_at: u64,
    /// The key has a random segment: write it create-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) create_only: Option<bool>,
    /// Set by the PUT once the object is written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) uploaded: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) uploaded_at: Option<u64>,
}

impl PendingUpload {
    /// `pending.bucket ?? 'public'`.
    pub(crate) fn bucket(&self) -> &str {
        self.bucket.as_deref().unwrap_or("public")
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn read(body: &Value) -> Result<UploadRequest, Value> {
        let mut issues = Issues::default();
        let request = read_upload_request(&mut issues, body.as_object().expect("an object"));
        issues
            .finish()
            .map(|()| request)
            .map_err(|invalid| Value::Array(invalid.issues().to_vec()))
    }

    /// Zod 3's issues for these bodies (`safeParseAsync`, as `zValidator`
    /// runs it): the preprocessed fields' type issues after the plain
    /// fields', refinements last.
    #[test]
    fn issues_match_zod() {
        let issues = read(&json!({ "fileName": "", "contentType": 5, "fileSize": 1.5,
            "folder": "A", "entityType": 3, "entityId": "..", "isPublic": "x" }))
        .expect_err("invalid");
        assert_eq!(
            issues,
            json!([
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["fileName"]},
                {"code":"invalid_type","expected":"string","received":"number","path":["contentType"],"message":"Expected string, received number"},
                {"code":"invalid_type","expected":"integer","received":"float","message":"Expected integer, received float","path":["fileSize"]},
                {"code":"invalid_type","expected":"boolean","received":"string","path":["isPublic"],"message":"Expected boolean, received string"},
                {"code":"invalid_type","expected":"string","received":"number","path":["entityType"],"message":"Expected string, received number"},
                {"code":"custom","message":"folder must be 1-3 segments of lowercase letters, digits, '-' or '_', separated by '/'","path":["folder"]},
                {"code":"custom","message":"entityId must be letters, digits, '-' or '_' (max 64 characters)","path":["entityId"]}
            ])
        );
        let issues = read(&json!({ "fileName": "a", "contentType": "x", "fileSize": 1,
            "folder": null, "entityType": null, "entityId": null }))
        .expect_err("invalid");
        assert_eq!(
            issues,
            json!([
                {"code":"invalid_type","expected":"string","received":"null","path":["folder"],"message":"Expected string, received null"},
                {"code":"invalid_type","expected":"string","received":"null","path":["entityType"],"message":"Expected string, received null"}
            ])
        );
        let issues = read(
            &json!({ "fileName": "a".repeat(256), "contentType": "", "fileSize": 104_857_601 }),
        )
        .expect_err("invalid");
        assert_eq!(
            issues,
            json!([
                {"code":"too_big","maximum":255,"type":"string","inclusive":true,"exact":false,"message":"String must contain at most 255 character(s)","path":["fileName"]},
                {"code":"too_small","minimum":1,"type":"string","inclusive":true,"exact":false,"message":"String must contain at least 1 character(s)","path":["contentType"]},
                {"code":"too_big","maximum":104_857_600,"type":"number","inclusive":true,"exact":false,"message":"fileSize must not exceed 104857600 bytes","path":["fileSize"]}
            ])
        );
        let issues =
            read(&json!({ "fileName": 1, "folder": 5, "isPublic": 1 })).expect_err("invalid");
        assert_eq!(
            issues,
            json!([
                {"code":"invalid_type","expected":"string","received":"number","path":["fileName"],"message":"Expected string, received number"},
                {"code":"invalid_type","expected":"string","received":"undefined","path":["contentType"],"message":"Required"},
                {"code":"invalid_type","expected":"number","received":"undefined","path":["fileSize"],"message":"Required"},
                {"code":"invalid_type","expected":"boolean","received":"number","path":["isPublic"],"message":"Expected boolean, received number"},
                {"code":"invalid_type","expected":"string","received":"number","path":["folder"],"message":"Expected string, received number"}
            ])
        );
    }

    #[test]
    fn segments_folders_and_ids() {
        for good in [
            "avatars",
            "documents/content",
            "weldbooks/documents",
            "a/b/c",
        ] {
            assert!(is_safe_folder(good), "{good}");
        }
        for bad in [
            "..",
            ".",
            "../org_victim",
            "a/../b",
            "/abs",
            "a/",
            "a//b",
            "a.b",
            "a\\b",
            "%2e%2e",
            "a b",
            "A",
            "a/b/c/d",
        ] {
            assert!(!is_safe_folder(bad), "{bad}");
        }
        assert!(!is_safe_folder(&"x".repeat(49)));
        assert!(is_segment("customer-avatar") && !is_segment("Customer"));
        assert!(is_safe_entity_id("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(!is_safe_entity_id("a.b") && !is_safe_entity_id(&"x".repeat(65)));
        assert!(!is_safe_entity_id(""));
    }

    #[test]
    fn empty_strings_are_absent_and_hostile_values_refused() {
        let ok = read(
            &json!({ "fileName": "a.txt", "contentType": "text/plain", "fileSize": 1,
            "folder": "", "entityType": "", "entityId": "" }),
        )
        .expect("valid");
        assert_eq!(
            (ok.folder, ok.entity_type, ok.entity_id),
            (None, None, None)
        );
        assert!(!ok.is_public);
        assert!(
            read(&json!({ "fileName": "a", "contentType": "x", "fileSize": 1, "folder": "a//b" }))
                .is_err()
        );
        assert!(
            read(&json!({ "fileName": "a", "contentType": "x", "fileSize": MAX_UPLOAD_BYTES + 1 }))
                .is_err()
        );
        assert!(
            read(&json!({ "fileName": "a", "contentType": "x", "fileSize": 1, "entityId": null }))
                .is_ok()
        );
    }

    #[test]
    fn keys_like_build_upload_key() {
        let base = UploadRequest {
            file_name: "../../x/y.txt".to_owned(),
            content_type: "text/plain".to_owned(),
            file_size: 1,
            ..UploadRequest::default()
        };
        let (key, create_only) = build_upload_key("org_a", &base);
        assert!(create_only);
        let parts: Vec<&str> = key.split('/').collect();
        assert_eq!(&parts[..4], ["workspaces", "org_a", "uploads", "general"]);
        let (time, random) = parts[4].split_once('_').expect("time_random");
        assert!(time.len() == 13 && time.bytes().all(|b| b.is_ascii_digit()));
        assert!(random.len() == 32 && random.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(parts[5], ".._.._x_y.txt");

        let project = UploadRequest {
            folder: Some("projects".to_owned()),
            entity_type: Some("project".to_owned()),
            entity_id: Some("proj_1".to_owned()),
            file_name: "a.txt".to_owned(),
            ..base.clone()
        };
        assert!(
            build_upload_key("org_a", &project)
                .0
                .starts_with("workspaces/org_a/projects/project/proj_1/")
        );

        let avatar = UploadRequest {
            entity_type: Some("customer-avatar".to_owned()),
            entity_id: Some("cust_1".to_owned()),
            file_name: "x.png/../../../org_victim/avatars/a".to_owned(),
            ..base.clone()
        };
        assert_eq!(
            build_upload_key("org_a", &avatar),
            (
                "workspaces/org_a/avatars/customers/cust_1/logo.png".to_owned(),
                false
            )
        );
        let logo = UploadRequest {
            entity_type: Some("user-app-logo".to_owned()),
            entity_id: Some("app_1".to_owned()),
            file_name: "Me.WEBP".to_owned(),
            ..base
        };
        assert_eq!(
            build_upload_key("org_a", &logo).0,
            "workspaces/org_a/user-apps/app_1/logo.webp"
        );
    }

    #[test]
    fn file_names_like_sanitize_file_name() {
        assert_eq!(sanitize_file_name(".."), "file");
        assert_eq!(sanitize_file_name("a b.txt"), "a_b.txt");
        assert_eq!(sanitize_file_name("é😀.txt"), "___.txt");
        assert_eq!(avatar_extension("avatar"), "png");
        assert_eq!(avatar_extension("a.JPEG"), "jpeg");
        assert_eq!(avatar_extension("a.toolongext"), "png");
    }

    #[test]
    fn pending_uploads_read_typescript_records() {
        let legacy: PendingUpload = serde_json::from_value(json!({
            "fileKey": "workspaces/org_a/uploads/general/1_x/big.bin",
            "contentType": "application/pdf", "fileName": "big.bin",
            "fileSize": 104_857_601, "isPublic": false, "userId": "user_a", "createdAt": 1,
        }))
        .expect("a legacy record");
        assert_eq!(legacy.bucket(), "public");
        assert_eq!(legacy.uploaded, None);
        let minted = PendingUpload {
            bucket: Some("private".to_owned()),
            create_only: Some(true),
            uploaded: Some(false),
            ..legacy
        };
        assert_eq!(
            serde_json::to_string(&minted).expect("json"),
            r#"{"fileKey":"workspaces/org_a/uploads/general/1_x/big.bin","contentType":"application/pdf","fileName":"big.bin","fileSize":104857601,"isPublic":false,"bucket":"private","userId":"user_a","createdAt":1,"createOnly":true,"uploaded":false}"#
        );
    }
}
