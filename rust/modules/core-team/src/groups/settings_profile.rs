//! `/api/settings/profile` (`app-api/src/routes/settings-profile`,
//! `services/settings-profile.ts`): the caller's own profile, composed from
//! their `workspace_members` row (name, email, picture) and the field bag at
//! `user_preferences.ui_preferences.profile` plus `user_preferences.timezone`.
//! Every route needs `general:read`, which every role holds.
//!
//! - `GET /`: the profile.
//! - `PUT /`: change name, nickname, phone, job title, bio, timezone. The
//!   `ui_preferences` write merges (the column and the `profile` bag), so a
//!   save never drops a sibling key.
//! - `PUT /avatar`: a base64 data URL, stored in the public bucket, its URL
//!   saved as the member's picture (the object is removed again when that
//!   write fails).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::GENERAL_READ;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynFileStore, PutOptions};

use crate::{Caller, CoreTeamState, TeamError, TeamResult, answer, now, validate};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([GENERAL_READ]);
    Router::new()
        .route("/", get(profile).route_layer(read()))
        .route("/", put(update).route_layer(read()))
        .route(
            "/avatar",
            put(avatar)
                .route_layer(read())
                // A 5 MB image is about 7 MB as a data URL.
                .layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
}

const PROFILE_NAME_MAX: usize = 200;
const MAX_AVATAR_BYTES: usize = 5 * 1024 * 1024;

/// `a || b`: JavaScript's falsy values fall through.
fn or<'a>(a: &'a Value, b: &'a Value) -> &'a Value {
    let falsy = match a {
        Value::Null => true,
        Value::Bool(flag) => !flag,
        Value::Number(n) => n.as_f64().is_none_or(|n| n == 0.0 || n.is_nan()),
        Value::String(s) => s.is_empty(),
        _ => false,
    };
    if falsy { b } else { a }
}

async fn member_row(db: &PgPool, user_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from workspace_members m
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn prefs_row(db: &PgPool, user_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(p) from user_preferences p
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `composeProfile`: the member row and the preferences projected into the
/// response.
async fn compose(db: &PgPool, user_id: &str) -> Result<Value, sqlx::Error> {
    let member = member_row(db, user_id).await?.unwrap_or(Value::Null);
    let prefs = prefs_row(db, user_id).await?.unwrap_or(Value::Null);
    let ui = &prefs["uiPreferences"];
    let ext = match &ui["profile"] {
        Value::Null => &Value::Null,
        profile => profile,
    };
    let empty = json!("");
    let user = json!(user_id);
    let utc = json!("UTC");
    Ok(json!({
        "id": or(&member["id"], &user),
        "email": or(&member["email"], &empty),
        "name": or(&member["name"], &empty),
        "nickname": or(&ext["nickname"], &empty),
        "picture": or(&member["picture"], &empty),
        "phone": or(&ext["phone"], &empty),
        "company": or(&ext["company"], &empty),
        "jobTitle": or(&ext["jobTitle"], &empty),
        "bio": or(&ext["bio"], &empty),
        "timezone": or(&prefs["timezone"], or(&ext["timezone"], &utc)),
    }))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn profile(caller: Caller) -> Response {
    match compose(&caller.db, &caller.user_id).await {
        Ok(profile) => Data(profile).into_response(),
        Err(error) => TeamError::internal("Failed to fetch profile", error).respond(),
    }
}

// ── PUT / ───────────────────────────────────────────────────────────────────

/// The validated `updateProfileSchema`.
#[derive(Default)]
struct ProfileChanges {
    name: Option<String>,
    nickname: Option<String>,
    phone: Option<String>,
    job_title: Option<String>,
    bio: Option<String>,
    timezone: Option<String>,
}

/// `normalizePhone`: trimmed, inner whitespace collapsed to one space.
fn normalize_phone(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `isValidPhone`: empty, or digits, spaces, a leading `+`, `-`, `()`, `.`
/// with 6 to 15 digits.
fn is_valid_phone(value: &str) -> bool {
    let phone = normalize_phone(value);
    if phone.is_empty() {
        return true;
    }
    let body = phone.strip_prefix('+').unwrap_or(&phone);
    if body.is_empty()
        || !body
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, ' ' | '-' | '(' | ')' | '.'))
    {
        return false;
    }
    let digits = phone.chars().filter(char::is_ascii_digit).count();
    (6..=15).contains(&digits)
}

fn read_changes(
    issues: &mut weldsuite_kit::validation::Issues,
    body: &Map<String, Value>,
) -> ProfileChanges {
    let name = match issues.text_with(body, "name", Presence::Optional, Text::trimmed(None, None)) {
        weldsuite_kit::validation::Field::Set(name) => {
            let length = name.encode_utf16().count();
            if length < 1 {
                issues.string_too_small("name", 1, "Name is required");
                None
            } else if length > PROFILE_NAME_MAX {
                issues.string_too_big(
                    "name",
                    PROFILE_NAME_MAX,
                    &format!("Name must be {PROFILE_NAME_MAX} characters or fewer"),
                );
                None
            } else {
                Some(name)
            }
        }
        _ => None,
    };
    let nickname = issues.string(body, "nickname", false, None, None);
    let phone = issues.string(body, "phone", false, None, None);
    let job_title = issues.string(body, "jobTitle", false, None, None);
    let bio = issues.string(body, "bio", false, None, None);
    let timezone = issues.string(body, "timezone", false, Some(1), Some(100));
    // zValidator parses asynchronously, so the refinement reports after
    // every other field.
    let phone = phone.and_then(|phone| {
        if is_valid_phone(&phone) {
            Some(normalize_phone(&phone))
        } else {
            issues.custom("phone", "Enter a valid phone number");
            None
        }
    });
    ProfileChanges {
        name,
        nickname,
        phone,
        job_title,
        bio,
        timezone,
    }
}

async fn update(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let changes = validate(&headers, &body, read_changes)?;
            match update_profile(&caller.db, &caller.user_id, &changes).await {
                Ok(profile) => Ok(Data(profile).into_response()),
                Err(error) => Err(TeamError::internal("Failed to update profile", error)),
            }
        }
        .await,
    )
}

async fn update_profile(
    db: &PgPool,
    user_id: &str,
    changes: &ProfileChanges,
) -> Result<Value, sqlx::Error> {
    if let Some(name) = &changes.name {
        sqlx::query(
            "update workspace_members set name = $2, updated_at = $3::timestamptz
             where user_id = $1 and deleted_at is null",
        )
        .bind(user_id)
        .bind(name)
        .bind(now())
        .execute(db)
        .await?;
    }

    let mut ext = Map::new();
    for (key, value) in [
        ("nickname", &changes.nickname),
        ("phone", &changes.phone),
        ("jobTitle", &changes.job_title),
        ("bio", &changes.bio),
    ] {
        if let Some(value) = value {
            ext.insert(key.to_owned(), json!(value));
        }
    }
    if !ext.is_empty() || changes.timezone.is_some() {
        upsert_preferences(db, user_id, ext, changes.timezone.as_deref()).await?;
    }
    compose(db, user_id).await
}

/// Merge the extended fields and the timezone into the caller's preferences
/// row, creating it when missing.
async fn upsert_preferences(
    db: &PgPool,
    user_id: &str,
    ext: Map<String, Value>,
    timezone: Option<&str>,
) -> Result<(), sqlx::Error> {
    let has_ext = !ext.is_empty();
    let existing = prefs_row(db, user_id).await?;
    let stamp = now();
    if let Some(existing) = existing {
        let mut ui = match &existing["uiPreferences"] {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        let mut profile = match ui.get("profile") {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        profile.extend(ext);
        ui.insert("profile".to_owned(), Value::Object(profile));
        sqlx::query(
            "update user_preferences set
                 ui_preferences = case when $2 then $3 else ui_preferences end,
                 timezone = coalesce($4, timezone),
                 updated_at = $5::timestamptz
             where id = $1",
        )
        .bind(existing["id"].as_str().unwrap_or_default())
        .bind(has_ext)
        .bind(Value::Object(ui))
        .bind(timezone)
        .bind(&stamp)
        .execute(db)
        .await?;
        return Ok(());
    }
    let seed = has_ext.then(|| json!({ "profile": ext }));
    sqlx::query(
        "insert into user_preferences (id, user_id, ui_preferences, timezone, created_at, updated_at)
         values ($1, $2, $3, coalesce($4, 'UTC'), $5::timestamptz, $5::timestamptz)",
    )
    .bind(generate_id("upref"))
    .bind(user_id)
    .bind(seed)
    .bind(timezone)
    .bind(&stamp)
    .execute(db)
    .await?;
    Ok(())
}

// ── PUT /avatar ─────────────────────────────────────────────────────────────

fn extension_for(mime: &str) -> Option<&'static str> {
    Some(match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/avif" => "avif",
        _ => return None,
    })
}

/// `/^data:([^;,]+)?(;base64)?,(.*)$/s`: the media type, whether it says
/// base64, and the payload; `None` when the text is no data URL.
fn parse_data_url(file: &str) -> Option<(Option<&str>, bool, &str)> {
    let rest = file.strip_prefix("data:")?;
    let end = rest.find([';', ',']).unwrap_or(rest.len());
    let mime = (end > 0).then(|| &rest[..end]);
    let rest = &rest[end..];
    if let Some(payload) = rest.strip_prefix(";base64,") {
        return Some((mime, true, payload));
    }
    rest.strip_prefix(',').map(|payload| (mime, false, payload))
}

/// `atob`: forgiving base64 (ASCII whitespace ignored, padding optional).
fn atob(text: &str) -> Option<Vec<u8>> {
    let mut data: Vec<u8> = text
        .bytes()
        .filter(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\x0c' | b'\r'))
        .collect();
    if data.len().is_multiple_of(4) {
        for _ in 0..2 {
            if data.last() == Some(&b'=') {
                data.pop();
            }
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in data {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((buffer >> bits) & 0xff).unwrap_or_default());
        }
    }
    Some(out)
}

/// `resolvePublicUrl`: on localhost the worker's own passthrough, else the
/// public bucket's URL (`R2_PUBLIC_URL`, the test host by default).
fn public_url(headers: &HeaderMap, public_base: Option<&str>, key: &str) -> String {
    // Behind the ingress the original host is `X-Forwarded-Host`.
    let header = |name: &str| headers.get(name).and_then(|value| value.to_str().ok());
    let host = header("x-forwarded-host")
        .or_else(|| header("host"))
        .unwrap_or_default();
    let scheme = header("x-forwarded-proto").unwrap_or("http");
    let hostname = host.rsplit_once(':').map_or(host, |(name, port)| {
        if port.bytes().all(|b| b.is_ascii_digit()) {
            name
        } else {
            host
        }
    });
    let local = hostname.eq_ignore_ascii_case("localhost") || hostname == "127.0.0.1";
    if local && matches!(scheme, "http" | "https") {
        return format!(
            "{scheme}://{}/api/storage/public/{key}",
            host.to_ascii_lowercase()
        );
    }
    let base = public_base
        .filter(|base| !base.is_empty())
        .unwrap_or("https://weldsuite-storage-test.weldsuite.org");
    format!("{base}/{key}")
}

struct AvatarInput {
    file: String,
    content_type: Option<String>,
}

async fn avatar(
    State(state): State<CoreTeamState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = validate(&headers, &body, |issues, fields| AvatarInput {
                file: issues
                    .string(fields, "file", true, Some(1), None)
                    .unwrap_or_default(),
                content_type: {
                    let _ = issues.string(fields, "fileName", false, None, None);
                    issues.string(fields, "contentType", false, None, None)
                },
            })?;
            store_avatar(&state, &caller, &headers, input).await
        }
        .await,
    )
}

async fn store_avatar(
    state: &CoreTeamState,
    caller: &Caller,
    headers: &HeaderMap,
    input: AvatarInput,
) -> TeamResult<Response> {
    const FAILED: &str = "Failed to update avatar";
    let Some(store) = caller.files(state).and_then(|files| files.public) else {
        return Err(TeamError::api(
            ApiError::internal().with_message("Storage is not configured"),
        ));
    };
    let bad = |message: &str| TeamError::api(ApiError::bad_request(message));
    let Some((mime, true, payload)) = parse_data_url(&input.file) else {
        return Err(bad("Avatar must be a base64 data URL"));
    };
    let mime = mime
        .filter(|m| !m.is_empty())
        .or_else(|| input.content_type.as_deref().filter(|m| !m.is_empty()))
        .unwrap_or_default()
        .to_lowercase();
    let Some(extension) = extension_for(&mime) else {
        return Err(bad("Avatar must be a PNG, JPEG, GIF, WebP or AVIF image"));
    };
    let Some(bytes) = atob(payload) else {
        return Err(bad("Avatar is not valid base64"));
    };
    if bytes.is_empty() {
        return Err(bad("Avatar is empty"));
    }
    if bytes.len() > MAX_AVATAR_BYTES {
        return Err(bad("Avatar exceeds the 5MB limit"));
    }

    // R2 keys stay under the Clerk org id until phase 3 (workspace-id plan).
    let org = caller.clerk_org_id.as_deref().unwrap_or("null");
    let millis = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    let key = format!(
        "workspaces/{org}/avatars/{}_{millis}.{extension}",
        caller.user_id
    );
    store
        .put_boxed(&key, bytes, &PutOptions::content_type(mime.as_str()))
        .await
        .map_err(|error| TeamError::internal(FAILED, error))?;

    let image_url = public_url(headers, caller.env("R2_PUBLIC_URL"), &key);
    let saved = sqlx::query(
        "update workspace_members set picture = $2, updated_at = $3::timestamptz
         where user_id = $1 and deleted_at is null",
    )
    .bind(&caller.user_id)
    .bind(&image_url)
    .bind(now())
    .execute(&caller.db)
    .await;
    if let Err(error) = saved {
        // Nothing references the object: take it back, best effort.
        if let Err(cleanup) = store.delete_boxed(&key).await {
            tracing::error!(%cleanup, key, "settings-profile: orphaned avatar left behind");
        }
        return Err(TeamError::internal(FAILED, error));
    }
    Ok(Data(json!({ "imageUrl": image_url })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phones_follow_is_valid_phone() {
        assert!(is_valid_phone(""));
        assert!(is_valid_phone("  "));
        assert!(is_valid_phone("+31 (0)20 123-4567"));
        assert!(!is_valid_phone("12345"));
        assert!(!is_valid_phone("+"));
        assert!(!is_valid_phone("call me"));
        assert!(!is_valid_phone("1234567890123456"));
        assert_eq!(normalize_phone("  +31   20\t12 "), "+31 20 12");
    }

    #[test]
    fn data_urls_parse_like_the_regex() {
        assert_eq!(
            parse_data_url("data:image/png;base64,AAA="),
            Some((Some("image/png"), true, "AAA="))
        );
        assert_eq!(parse_data_url("data:;base64,AA"), Some((None, true, "AA")));
        assert_eq!(
            parse_data_url("data:image/png,raw"),
            Some((Some("image/png"), false, "raw"))
        );
        assert_eq!(parse_data_url("data:image/png;charset=x;base64,AA"), None);
        assert_eq!(parse_data_url("image/png;base64,AA"), None);
    }

    #[test]
    fn atob_is_forgiving() {
        assert_eq!(atob("aGk=").as_deref(), Some(&b"hi"[..]));
        assert_eq!(atob("aGk").as_deref(), Some(&b"hi"[..]));
        assert_eq!(atob("aG k=\n").as_deref(), Some(&b"hi"[..]));
        assert_eq!(atob("a"), None);
        assert_eq!(atob("a$=="), None);
        assert_eq!(atob("").as_deref(), Some(&b""[..]));
    }
}
