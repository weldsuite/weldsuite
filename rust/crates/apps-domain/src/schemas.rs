//! The request bodies, as `@weldsuite/app-api-client/schemas/user-apps`
//! (and the cli-auth / auth-desktop inputs) validate them: fields in the
//! schemas' order, refinements after every other check (`zValidator` parses
//! asynchronously), and the manifest of an upload with `safeParse` (inline
//! refinements, issues flattened).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text, js_trim};

use crate::scopes::{is_safe_lifecycle_webhook_url, is_scope};

const CODE_MESSAGE: &str = "lowercase letters, digits and dashes, starting with a letter";
const SCOPE_MESSAGE: &str = "scope must look like resource:action, resource:* or *";
const ICON_MESSAGE: &str = "icon must be a short Lucide name or a public logo URL";
const WEBHOOK_MESSAGE: &str = "webhookUrl must be a public https URL with a DNS hostname (no private, link-local, loopback, metadata, or IP-literal hosts)";
const SLUG_MESSAGE: &str = "lowercase letters, digits, dashes, underscores";

fn regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("the schema pattern compiles")
}

static APP_CODE: LazyLock<Regex> = LazyLock::new(|| regex("^[a-z][a-z0-9-]*$"));
static SEMVER: LazyLock<Regex> = LazyLock::new(|| regex(r"^[0-9]+\.[0-9]+\.[0-9]+$"));
static SLUG: LazyLock<Regex> = LazyLock::new(|| regex("^[a-z][a-z0-9_-]*$"));
static SNAKE: LazyLock<Regex> = LazyLock::new(|| regex("^[a-z][a-z0-9_]*$"));
static NAV_PATH: LazyLock<Regex> = LazyLock::new(|| regex("(?i)^/(?:[a-z0-9][a-z0-9/_-]*)?$"));

/// `z.string().url().max(max)`.
fn url_text(max: usize) -> Text {
    Text {
        format: Some(Format::Url),
        ..Text::length(None, Some(max))
    }
}

/// `isUserAppLogoUrl`.
fn is_logo_url(trimmed: &str) -> bool {
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || trimmed.starts_with('/')
        || trimmed.starts_with("data:image/")
}

/// `userAppIconSchema`'s refinement.
fn icon_ok(value: &str) -> bool {
    let trimmed = js_trim(value);
    !trimmed.is_empty() && (is_logo_url(trimmed) || trimmed.encode_utf16().count() <= 50)
}

/// A refinement on `key`, run when the value got past its type check.
fn refine(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    ok: fn(&str) -> bool,
    message: &str,
) {
    if let Some(Value::String(value)) = body.get(key)
        && !ok(value)
    {
        issues.custom(key, message);
    }
}

fn code(issues: &mut Issues, body: &Map<String, Value>) -> Field<String> {
    issues.pattern(
        body,
        "code",
        Presence::Required,
        Some(3),
        Some(50),
        |text| APP_CODE.is_match(text),
        CODE_MESSAGE,
    )
}

/// `z.array(scopeSchema).max(50)`.
fn scope_list(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<Vec<String>> {
    issues.list(body, key, presence, None, Some(50), |issues, item| {
        issues.item_pattern(
            item,
            Text::length(Some(1), Some(100)),
            is_scope,
            SCOPE_MESSAGE,
        )
    })
}

fn screenshots(issues: &mut Issues, body: &Map<String, Value>) -> Field<Vec<String>> {
    issues.list(
        body,
        "screenshots",
        Presence::Optional,
        None,
        Some(8),
        |issues, item| issues.item_text(item, url_text(2000)),
    )
}

// ── POST /api/user-apps ──────────────────────────────────────────────────────

pub struct CreateApp {
    pub code: String,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub category: Option<String>,
    pub website_url: Option<String>,
    pub privacy_url: Option<String>,
    pub screenshots: Option<Vec<String>>,
    pub webhook_url: Option<String>,
}

/// `createUserAppSchema`.
pub fn create_app(issues: &mut Issues, body: &Map<String, Value>) -> CreateApp {
    let code = code(issues, body);
    let name = issues.text(body, "name", Presence::Required, Some(1), Some(100));
    let description = issues.text(body, "description", Presence::Optional, None, Some(2000));
    let icon = issues.text(body, "icon", Presence::Optional, None, Some(2000));
    let category = issues.text(body, "category", Presence::Optional, None, Some(50));
    let website_url = issues.text_with(body, "websiteUrl", Presence::Optional, url_text(2000));
    let privacy_url = issues.text_with(body, "privacyUrl", Presence::Optional, url_text(2000));
    let screenshots = screenshots(issues, body);
    let webhook_url = issues.text_with(body, "webhookUrl", Presence::Optional, url_text(2000));
    refine(issues, body, "icon", icon_ok, ICON_MESSAGE);
    refine(
        issues,
        body,
        "webhookUrl",
        is_safe_lifecycle_webhook_url,
        WEBHOOK_MESSAGE,
    );
    CreateApp {
        code: code.into_option().unwrap_or_default(),
        name: name.into_option().unwrap_or_default(),
        description: description.into_option(),
        icon: icon.into_option(),
        category: category.into_option(),
        website_url: website_url.into_option(),
        privacy_url: privacy_url.into_option(),
        screenshots: screenshots.into_option(),
        webhook_url: webhook_url.into_option(),
    }
}

// ── PATCH /api/user-apps/:id ─────────────────────────────────────────────────

pub struct UpdateApp {
    pub name: Field<String>,
    pub description: Field<String>,
    pub icon: Field<String>,
    pub category: Field<String>,
    pub is_active: Field<bool>,
    pub website_url: Field<String>,
    pub privacy_url: Field<String>,
    pub screenshots: Field<Vec<String>>,
    pub webhook_url: Field<String>,
}

/// `updateUserAppSchema`.
pub fn update_app(issues: &mut Issues, body: &Map<String, Value>) -> UpdateApp {
    let name = issues.text(body, "name", Presence::Optional, Some(1), Some(100));
    let description = issues.text(body, "description", Presence::Optional, None, Some(2000));
    let icon = issues.text(body, "icon", Presence::Optional, None, Some(2000));
    let category = issues.text(body, "category", Presence::Optional, None, Some(50));
    let is_active = issues.boolean(body, "isActive", Presence::Optional);
    let website_url = issues.text_with(body, "websiteUrl", Presence::Nullish, url_text(2000));
    let privacy_url = issues.text_with(body, "privacyUrl", Presence::Nullish, url_text(2000));
    let screenshots = screenshots(issues, body);
    let webhook_url = issues.text_with(body, "webhookUrl", Presence::Nullish, url_text(2000));
    refine(issues, body, "icon", icon_ok, ICON_MESSAGE);
    refine(
        issues,
        body,
        "webhookUrl",
        is_safe_lifecycle_webhook_url,
        WEBHOOK_MESSAGE,
    );
    UpdateApp {
        name,
        description,
        icon,
        category,
        is_active,
        website_url,
        privacy_url,
        screenshots,
        webhook_url,
    }
}

// ── small bodies ─────────────────────────────────────────────────────────────

/// `installUserAppSchema`: `grantedScopes`, default `[]`.
pub fn install(issues: &mut Issues, body: &Map<String, Value>) -> Vec<String> {
    scope_list(issues, body, "grantedScopes", Presence::Optional)
        .into_option()
        .unwrap_or_default()
}

/// `consentUserAppScopesSchema`: `approvedScopes`.
pub fn consent(issues: &mut Issues, body: &Map<String, Value>) -> Vec<String> {
    scope_list(issues, body, "approvedScopes", Presence::Required)
        .into_option()
        .unwrap_or_default()
}

/// `submitUserAppSchema`: `notes`.
pub fn submit(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    issues
        .text(body, "notes", Presence::Optional, None, Some(2000))
        .into_option()
}

/// `reviewUserAppSchema`: the decision and the notes.
pub fn review(issues: &mut Issues, body: &Map<String, Value>) -> (String, Option<String>) {
    let decision = issues
        .one_of(body, "decision", &["approved", "rejected"])
        .unwrap_or_default();
    let notes = issues
        .text(body, "notes", Presence::Optional, None, Some(2000))
        .into_option();
    (decision, notes)
}

/// `upsertUserAppDevSessionSchema`: the URL (`userId` is validated and
/// ignored: the session is the caller's).
pub fn dev_session(issues: &mut Issues, body: &Map<String, Value>) -> String {
    let url = issues.text_with(body, "url", Presence::Required, url_text(2000));
    let _ = issues.text(body, "userId", Presence::Optional, Some(1), Some(255));
    url.into_option().unwrap_or_default()
}

/// `upsertUserAppDevSessionSchema` with the `userId` it carries: external-api
/// registers the preview for that user when the key has none.
pub fn dev_session_for(issues: &mut Issues, body: &Map<String, Value>) -> (String, Option<String>) {
    let url = issues.text_with(body, "url", Presence::Required, url_text(2000));
    let user_id = issues.text(body, "userId", Presence::Optional, Some(1), Some(255));
    (url.into_option().unwrap_or_default(), user_id.into_option())
}

/// `startDeviceInput`: `loginUrl`.
pub fn cli_device(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    issues
        .text_with(
            body,
            "loginUrl",
            Presence::Optional,
            Text {
                format: Some(Format::Url),
                ..Text::default()
            },
        )
        .into_option()
}

/// `tokenInput`: `deviceCode`.
pub fn cli_token(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .text(body, "deviceCode", Presence::Required, Some(16), Some(128))
        .into_option()
        .unwrap_or_default()
}

/// `approveInput`: `userCode`.
pub fn cli_approve(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .text(body, "userCode", Presence::Required, Some(4), Some(32))
        .into_option()
        .unwrap_or_default()
}

/// `createDesktopTicketInput`: `returnTo`.
pub fn desktop_ticket(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    issues
        .text_with(
            body,
            "returnTo",
            Presence::Optional,
            Text {
                format: Some(Format::Url),
                ..Text::default()
            },
        )
        .into_option()
}

// ── the manifest (`weldapp.json`) ────────────────────────────────────────────

/// `userAppManifestSchema.safeParse(json)`: the parsed manifest (unknown keys
/// dropped, `scopes` defaulted), or the issues, flattened.
pub fn manifest(json: &Value) -> Result<Value, Value> {
    let mut issues = Issues::default();
    if let Some(body) = issues.object(json) {
        read_manifest(&mut issues, body);
    }
    match issues.finish() {
        Ok(()) => Ok(strip_manifest(json)),
        Err(invalid) => Err(invalid.flatten()),
    }
}

#[allow(clippy::too_many_lines)] // one block per manifest field, in the schema's order
fn read_manifest(issues: &mut Issues, body: &Map<String, Value>) {
    let _ = code(issues, body);
    let _ = issues.text(body, "name", Presence::Required, Some(1), Some(100));
    let _ = issues.text(body, "description", Presence::Optional, None, Some(2000));
    let _ = issues.text(body, "icon", Presence::Optional, None, Some(2000));
    refine(issues, body, "icon", icon_ok, ICON_MESSAGE);
    let _ = issues.text(body, "category", Presence::Optional, None, Some(50));
    let _ = issues.pattern(
        body,
        "version",
        Presence::Required,
        None,
        Some(20),
        |text| SEMVER.is_match(text),
        "semver (e.g. 1.0.0)",
    );
    let _ = issues.text(body, "entrypoint", Presence::Optional, None, Some(255));
    let _ = scope_list(issues, body, "scopes", Presence::Optional);
    let _ = issues.list(
        body,
        "collections",
        Presence::Optional,
        None,
        Some(50),
        |issues, item| {
            let fields = issues.object(item)?;
            let _ = issues.pattern(
                fields,
                "name",
                Presence::Required,
                Some(1),
                Some(100),
                |text| SLUG.is_match(text),
                SLUG_MESSAGE,
            );
            let _ = issues.text(fields, "description", Presence::Optional, None, Some(500));
            Some(())
        },
    );
    let _ = issues.list(
        body,
        "agentTools",
        Presence::Optional,
        None,
        Some(50),
        |issues, item| {
            let fields = issues.object(item)?;
            let _ = issues.pattern(
                fields,
                "name",
                Presence::Required,
                Some(1),
                Some(64),
                |text| SNAKE.is_match(text),
                "lowercase snake_case",
            );
            let _ = issues.text(
                fields,
                "description",
                Presence::Required,
                Some(1),
                Some(1000),
            );
            let _ = issues.nested(fields, "parameters", Presence::Optional, |_, _| ());
            let _ = issues.nested(fields, "action", Presence::Required, |issues, action| {
                let _ = issues.choice(
                    action,
                    "type",
                    Presence::Required,
                    &[
                        "storage.list",
                        "storage.create",
                        "storage.update",
                        "storage.delete",
                        "api.request",
                    ],
                );
                let _ = issues.text(action, "collection", Presence::Optional, None, Some(100));
                let _ = issues.choice(
                    action,
                    "method",
                    Presence::Optional,
                    &["GET", "POST", "PATCH", "PUT", "DELETE"],
                );
                let _ = issues.text(action, "path", Presence::Optional, None, Some(500));
            });
            Some(())
        },
    );
    let _ = issues.list(
        body,
        "navigation",
        Presence::Optional,
        None,
        Some(50),
        |issues, item| {
            let fields = issues.object(item)?;
            let _ = issues.pattern(
                fields,
                "id",
                Presence::Required,
                Some(1),
                Some(50),
                |text| SLUG.is_match(text),
                SLUG_MESSAGE,
            );
            let _ = issues.text(fields, "label", Presence::Required, Some(1), Some(100));
            let _ = issues.pattern(
                fields,
                "path",
                Presence::Required,
                Some(1),
                Some(100),
                |text| NAV_PATH.is_match(text),
                "app-relative path starting with /",
            );
            let _ = issues.text(fields, "icon", Presence::Optional, None, Some(50));
            let _ = issues.text(fields, "permission", Presence::Optional, None, Some(100));
            let _ = issues.text(fields, "group", Presence::Optional, None, Some(100));
            Some(())
        },
    );
    let _ = issues.nested(body, "pricing", Presence::Optional, |issues, pricing| {
        let _ = issues.choice(
            pricing,
            "type",
            Presence::Required,
            &["free", "subscription"],
        );
        let _ = issues.number(
            pricing,
            "monthlyPrice",
            Presence::Optional,
            Number {
                min: Some(0.0),
                max: Some(10_000.0),
                ..Number::default()
            },
        );
        // `.length(3)`: only the message reaches the flattened issues.
        if let Field::Set(currency) =
            issues.text(pricing, "currency", Presence::Optional, None, None)
            && currency.encode_utf16().count() != 3
        {
            issues.custom("currency", "String must contain exactly 3 character(s)");
        }
    });
    let _ = issues.text_with(body, "websiteUrl", Presence::Optional, url_text(2000));
    let _ = issues.text_with(body, "privacyUrl", Presence::Optional, url_text(2000));
    let _ = screenshots(issues, body);
    let _ = issues.text_with(body, "webhookUrl", Presence::Optional, url_text(2000));
    refine(
        issues,
        body,
        "webhookUrl",
        is_safe_lifecycle_webhook_url,
        WEBHOOK_MESSAGE,
    );
    let _ = issues.boolean(body, "mobile", Presence::Optional);
}

/// Keep `keys` of `object` (in that order), each through `inner`.
fn keep(
    object: &Map<String, Value>,
    keys: &[&str],
    inner: impl Fn(&str, &Value) -> Value,
) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = object.get(*key) {
            out.insert((*key).to_owned(), inner(key, value));
        }
    }
    Value::Object(out)
}

fn keep_items(value: &Value, keys: &[&str], inner: impl Fn(&str, &Value) -> Value + Copy) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| match item {
                    Value::Object(object) => keep(object, keys, inner),
                    other => other.clone(),
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

fn same(_: &str, value: &Value) -> Value {
    value.clone()
}

/// The manifest as Zod outputs it: known keys only, `scopes` defaulted.
fn strip_manifest(json: &Value) -> Value {
    let Value::Object(object) = json else {
        return json.clone();
    };
    let mut manifest = keep(
        object,
        &[
            "code",
            "name",
            "description",
            "icon",
            "category",
            "version",
            "entrypoint",
            "scopes",
            "collections",
            "agentTools",
            "navigation",
            "pricing",
            "websiteUrl",
            "privacyUrl",
            "screenshots",
            "webhookUrl",
            "mobile",
        ],
        |key, value| match key {
            "collections" => keep_items(value, &["name", "description"], same),
            "agentTools" => keep_items(
                value,
                &["name", "description", "parameters", "action"],
                |key, value| match (key, value) {
                    ("action", Value::Object(action)) => {
                        keep(action, &["type", "collection", "method", "path"], same)
                    }
                    _ => value.clone(),
                },
            ),
            "navigation" => keep_items(
                value,
                &["id", "label", "path", "icon", "permission", "group"],
                same,
            ),
            "pricing" => match value {
                Value::Object(pricing) => {
                    keep(pricing, &["type", "monthlyPrice", "currency"], same)
                }
                other => other.clone(),
            },
            _ => value.clone(),
        },
    );
    if let Value::Object(fields) = &mut manifest {
        fields
            .entry("scopes")
            .or_insert_with(|| Value::Array(Vec::new()));
    }
    manifest
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn manifests_flatten_like_zod() {
        let issues = manifest(&json!({
            "code": "mineapp",
            "name": "",
            "version": "1.0",
            "scopes": ["BAD"],
            "pricing": { "type": "gift" },
            "webhookUrl": "http://10.0.0.1/x",
        }))
        .expect_err("invalid");
        assert_eq!(
            issues,
            json!({
                "formErrors": [],
                "fieldErrors": {
                    "name": ["String must contain at least 1 character(s)"],
                    "version": ["semver (e.g. 1.0.0)"],
                    "scopes": [SCOPE_MESSAGE],
                    "pricing": ["Invalid enum value. Expected 'free' | 'subscription', received 'gift'"],
                    "webhookUrl": [WEBHOOK_MESSAGE],
                },
            })
        );
        assert_eq!(
            manifest(&json!([])).expect_err("invalid"),
            json!({ "formErrors": ["Expected object, received array"], "fieldErrors": {} })
        );
    }

    #[test]
    fn manifests_drop_unknown_keys_and_default_scopes() {
        let parsed = manifest(&json!({
            "code": "mineapp",
            "name": "Mine",
            "version": "1.0.0",
            "unknownKey": "dropped",
            "pricing": { "type": "free", "extra": 1 },
            "agentTools": [{
                "name": "list_x",
                "description": "d",
                "parameters": { "type": "object", "anything": true },
                "action": { "type": "storage.list", "collection": "x", "nope": 1 },
                "nope": 2,
            }],
        }))
        .expect("valid");
        assert_eq!(
            parsed,
            json!({
                "code": "mineapp",
                "name": "Mine",
                "version": "1.0.0",
                "scopes": [],
                "pricing": { "type": "free" },
                "agentTools": [{
                    "name": "list_x",
                    "description": "d",
                    "parameters": { "type": "object", "anything": true },
                    "action": { "type": "storage.list", "collection": "x" },
                }],
            })
        );
    }

    #[test]
    fn icons_refine_after_their_checks() {
        assert!(
            icon_ok("Rocket")
                && icon_ok("https://cdn.example.com/logo.png")
                && icon_ok("/logo.svg")
        );
        assert!(!icon_ok("  ") && !icon_ok(&"a".repeat(60)));
    }
}
