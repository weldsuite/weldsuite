//! The plain object routes: campaigns (`/api/social-campaigns`), team
//! members (`/api/social-team-members`) and media assets
//! (`/api/social-media`), on [`crate::crud`]. Schemas from
//! `@weldsuite/core-api-client/schemas/social-*` (all `.passthrough()`).

use std::sync::Arc;

use axum::Router;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::crud::{
    self, Crud, Filter, Gates, Messages, Partial, Standard, event, field, no_prepare, or_default,
    update_or_existing, update_or_existing_or,
};
use crate::{Caller, SocialState, tables};

pub(crate) const OPT: Presence = Presence::Optional;

/// `z.string().max(max)` with `presence`.
pub(crate) fn string(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    max: Option<usize>,
) {
    issues.text(body, key, presence, None, max);
}

/// `z.array(z.string())` with `presence`.
pub(crate) fn strings(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) {
    issues.list(body, key, presence, None, None, |issues, item| {
        issues.item_text(item, Text::default())
    });
}

pub(crate) const POSTS: Gates = Gates {
    read: perm::POSTS_READ,
    create: perm::POSTS_CREATE,
    update: perm::POSTS_UPDATE,
    delete: perm::POSTS_DELETE,
};

pub(crate) const fn messages(
    list: &'static str,
    fetch: &'static str,
    create: &'static str,
    update: &'static str,
    delete: &'static str,
) -> Messages {
    Messages {
        list,
        fetch,
        create,
        update,
        delete,
    }
}

// ── campaigns ───────────────────────────────────────────────────────────────

const CAMPAIGN_LIST: (&str, &str) = listing!("social_campaigns";
    "($2::boolean or t.status = $3::social_campaign_status)", "($4::boolean or t.name like $5::text)";
    6, 7, 8; "$9");

fn campaign_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    issues.text(body, "name", partial.required(), Some(1), Some(255));
    string(issues, body, "status", OPT, Some(30));
    string(issues, body, "startsAt", OPT, None);
    string(issues, body, "endsAt", OPT, None);
    issues.string_or_number(body, "budget", OPT);
}

fn campaign_created(id: &str, data: &Map<String, Value>) -> Value {
    event(&[
        ("id", Some(json!(id))),
        ("name", field(data, "name")),
        ("status", or_default(data, "status", "draft")),
    ])
}

fn campaign_updated(id: &str, data: &Map<String, Value>, existing: &Value) -> Value {
    event(&[
        ("id", Some(json!(id))),
        ("name", update_or_existing(data, existing, "name")),
        (
            "status",
            update_or_existing_or(data, existing, "status", "draft"),
        ),
    ])
}

static CAMPAIGNS: Crud = Crud {
    table: &tables::SOCIAL_CAMPAIGNS,
    resource: "Social campaign",
    id_prefix: "scm",
    gates: Gates {
        read: perm::CAMPAIGNS_READ,
        create: perm::CAMPAIGNS_CREATE,
        update: perm::CAMPAIGNS_UPDATE,
        delete: perm::CAMPAIGNS_DELETE,
    },
    messages: messages(
        "Failed to list social campaigns",
        "Failed to fetch social campaign",
        "Failed to create social campaign",
        "Failed to update social campaign",
        "Failed to delete social campaign",
    ),
    schema: campaign_schema,
    filters: &[Filter::eq("status"), Filter::like("search")],
    list_sql: CAMPAIGN_LIST.0,
    count_sql: CAMPAIGN_LIST.1,
    slice_count: true,
    hidden: &[],
    prepare: no_prepare,
    created: ev::SOCIAL_CAMPAIGN_CREATED,
    created_event: campaign_created,
    updated: ev::SOCIAL_CAMPAIGN_UPDATED,
    updated_event: campaign_updated,
    guard: None,
    deleted: ev::SOCIAL_CAMPAIGN_DELETED,
};

pub(crate) fn campaigns<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<SocialState> {
    crud::routes(
        &CAMPAIGNS,
        gate,
        Standard {
            create: true,
            remove: true,
        },
    )
}

// ── team members ────────────────────────────────────────────────────────────

const TEAM_LIST: (&str, &str) = listing!("social_team_members";
    "($2::boolean or t.user_id = $3::text)";
    4, 5, 6; "$7");

fn team_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "userId", partial.required(), None);
    string(issues, body, "role", OPT, Some(50));
    strings(issues, body, "accountIds", OPT);
}

fn member_added(id: &str, data: &Map<String, Value>) -> Value {
    event(&[
        ("id", Some(json!(id))),
        ("userId", field(data, "userId")),
        ("role", or_default(data, "role", "contributor")),
    ])
}

fn member_updated(id: &str, data: &Map<String, Value>, existing: &Value) -> Value {
    event(&[
        ("id", Some(json!(id))),
        ("userId", existing.get("userId").cloned()),
        (
            "role",
            update_or_existing_or(data, existing, "role", "contributor"),
        ),
    ])
}

static TEAM_MEMBERS: Crud = Crud {
    table: &tables::SOCIAL_TEAM_MEMBERS,
    resource: "Social team member",
    id_prefix: "stm",
    gates: POSTS,
    messages: messages(
        "Failed to list social team members",
        "Failed to fetch social team member",
        "Failed to create social team member",
        "Failed to update social team member",
        "Failed to delete social team member",
    ),
    schema: team_schema,
    filters: &[Filter::eq("userId")],
    list_sql: TEAM_LIST.0,
    count_sql: TEAM_LIST.1,
    slice_count: true,
    hidden: &[],
    prepare: no_prepare,
    created: ev::SOCIAL_TEAM_MEMBER_ADDED,
    created_event: member_added,
    updated: ev::SOCIAL_TEAM_MEMBER_UPDATED,
    updated_event: member_updated,
    guard: None,
    deleted: ev::SOCIAL_TEAM_MEMBER_REMOVED,
};

pub(crate) fn team_members<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<SocialState> {
    crud::routes(
        &TEAM_MEMBERS,
        gate,
        Standard {
            create: true,
            remove: true,
        },
    )
}

// ── media ───────────────────────────────────────────────────────────────────

const MEDIA_LIST: (&str, &str) = listing!("social_media"; ; 2, 3, 4; "$5");

fn media_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "fileName", partial.required(), Some(500));
    string(issues, body, "contentType", OPT, Some(255));
    string(issues, body, "url", OPT, Some(2000));
    issues.whole_number(body, "size", OPT, Number::default());
}

/// A value JavaScript's `||` keeps.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// `a || b`.
fn or(data: &Map<String, Value>, key: &str, fallback: Value) -> Value {
    data.get(key)
        .filter(|v| truthy(Some(v)))
        .cloned()
        .unwrap_or(fallback)
}

/// `resolveMediaType`: an explicit image/video/gif wins, else the extension.
#[allow(clippy::case_sensitive_file_extension_comparisons)] // `lower` is lower-cased
fn media_type(explicit: Option<&str>, lower: &str) -> &'static str {
    match explicit {
        Some("image") => return "image",
        Some("video") => return "video",
        Some("gif") => return "gif",
        _ => {}
    }
    if [".mp4", ".webm", ".mov"]
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        "video"
    } else if lower.ends_with(".gif") {
        "gif"
    } else {
        "image"
    }
}

/// `guessMimeType`.
#[allow(clippy::case_sensitive_file_extension_comparisons)] // `lower` is lower-cased
fn guess_mime_type(lower: &str, media_type: &str) -> &'static str {
    const BY_EXTENSION: [(&[&str], &str); 5] = [
        (&[".png"], "image/png"),
        (&[".jpg", ".jpeg"], "image/jpeg"),
        (&[".gif"], "image/gif"),
        (&[".webp"], "image/webp"),
        (&[".mp4"], "video/mp4"),
    ];
    for (extensions, mime) in BY_EXTENSION {
        if extensions.iter().any(|ext| lower.ends_with(ext)) {
            return mime;
        }
    }
    if media_type == "video" {
        "video/mp4"
    } else {
        "image/png"
    }
}

/// What `POST /api/social-media` writes beyond the body: the derived type,
/// MIME type, size, storage and status, and who uploaded it.
#[allow(clippy::unnecessary_wraps)] // a crud::Prepare
fn media_prepare(
    caller: &Caller,
    id: &str,
    data: &mut Map<String, Value>,
) -> Result<Vec<&'static str>, ()> {
    let file_name = match data.get("fileName") {
        None | Some(Value::Null) => "asset".to_owned(),
        Some(Value::String(name)) => name.clone(),
        Some(other) => other.to_string(),
    };
    let url = data.get("url").and_then(Value::as_str).map(str::to_owned);
    let explicit = data.get("mediaType").and_then(Value::as_str);
    let lower = file_name.to_lowercase();
    let kind = media_type(explicit, &lower);
    let mime = data
        .get("mimeType")
        .filter(|v| truthy(Some(v)))
        .or_else(|| data.get("contentType").filter(|v| truthy(Some(v))))
        .cloned()
        .unwrap_or_else(|| json!(guess_mime_type(&lower, kind)));
    let size = match (data.get("fileSize"), data.get("size")) {
        (Some(Value::Number(size)), _) | (_, Some(Value::Number(size))) => {
            Value::Number(size.clone())
        }
        _ => json!(0),
    };
    let storage_path = or(
        data,
        "storagePath",
        json!(url.as_ref().map_or_else(
            || format!("social-media/{id}/{file_name}"),
            |url| format!("url:{url}")
        )),
    );
    let original_name = or(data, "originalName", json!(file_name));
    let provider = or(
        data,
        "storageProvider",
        json!(if url.is_some() { "url" } else { "r2" }),
    );
    let status = if url.is_some() {
        json!("ready")
    } else {
        data.get("status")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!("uploading"))
    };
    let uploaded_by = or(data, "uploadedByUserId", json!(caller.user_id));
    data.insert("fileName".to_owned(), json!(file_name));
    data.insert("originalName".to_owned(), original_name);
    data.insert("mimeType".to_owned(), mime);
    data.insert("fileSize".to_owned(), size);
    data.insert("mediaType".to_owned(), json!(kind));
    data.insert("storagePath".to_owned(), storage_path);
    data.insert("url".to_owned(), url.map_or(Value::Null, Value::String));
    data.insert("storageProvider".to_owned(), provider);
    data.insert("status".to_owned(), status);
    data.insert("uploadedByUserId".to_owned(), uploaded_by);
    Ok(Vec::new())
}

fn media_created(id: &str, data: &Map<String, Value>) -> Value {
    event(&[
        ("id", Some(json!(id))),
        ("fileName", field(data, "fileName")),
        ("mediaType", field(data, "mediaType")),
        ("status", field(data, "status")),
    ])
}

fn media_updated(id: &str, data: &Map<String, Value>, existing: &Value) -> Value {
    event(&[
        ("id", Some(json!(id))),
        ("fileName", update_or_existing(data, existing, "fileName")),
        ("mediaType", existing.get("mediaType").cloned()),
        (
            "status",
            update_or_existing_or(data, existing, "status", "uploading"),
        ),
    ])
}

static MEDIA: Crud = Crud {
    table: &tables::SOCIAL_MEDIA,
    resource: "Social media asset",
    id_prefix: "smed",
    gates: POSTS,
    messages: messages(
        "Failed to list social media assets",
        "Failed to fetch social media asset",
        "Failed to create social media asset",
        "Failed to update social media asset",
        "Failed to delete social media asset",
    ),
    schema: media_schema,
    filters: &[],
    list_sql: MEDIA_LIST.0,
    count_sql: MEDIA_LIST.1,
    slice_count: false,
    hidden: &[],
    prepare: media_prepare,
    created: ev::SOCIAL_MEDIA_CREATED,
    created_event: media_created,
    updated: ev::SOCIAL_MEDIA_UPDATED,
    updated_event: media_updated,
    guard: None,
    deleted: ev::SOCIAL_MEDIA_DELETED,
};

pub(crate) fn media<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<SocialState> {
    crud::routes(
        &MEDIA,
        gate,
        Standard {
            create: true,
            remove: true,
        },
    )
}
