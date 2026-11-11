//! The request schemas of `@weldsuite/app-api-client/schemas/weldforms`, read
//! as `zValidator('json' | 'query', schema)` reads them: a failure is the 400
//! with Zod's issues, in the schema's order.

use axum::body::Bytes;
use axum::response::IntoResponse;
use http::HeaderMap;
use http::header::CONTENT_TYPE;
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{
    Field, Format, Issues, Number, Presence, Text, json_body, query_values,
};

use crate::common::{Fail, FormsResult};
use crate::engine::{FormDefinition, FormThemeTokens, PathSegment, SchemaIssue};
use crate::forms::{CreateInput, ListQuery, UpdateInput};
use crate::model::{
    DEVICES, FORM_ABUSE_REASONS, FORM_ACCESS_LEVELS, FORM_ACCESS_ROLES, FORM_LAYOUTS,
    FORM_RESPONDENT_MODES, FORM_STATUSES, FORM_SUBSCRIPTION_MODES,
};

/// `zValidator('json', schema)`.
pub(crate) fn json<T>(
    headers: &HeaderMap,
    body: &Bytes,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> FormsResult<T> {
    let content_type = headers.get(CONTENT_TYPE).and_then(|v| v.to_str().ok());
    let body = json_body(content_type, body)
        .map_err(|bad| Fail::Response(Box::new(bad.into_response())))?;
    let mut issues = Issues::default();
    let value = issues.object(&body).map(|fields| read(&mut issues, fields));
    issues
        .finish()
        .map_err(|invalid| Fail::Response(Box::new(invalid.into_response())))?;
    value.ok_or_else(|| Fail::Internal("forms: a body read without issues".to_owned()))
}

/// `zValidator('query', schema)`.
pub(crate) fn query<T>(
    query: Option<&str>,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> FormsResult<T> {
    let values = query_values(query);
    let mut issues = Issues::default();
    let value = read(&mut issues, &values);
    issues
        .finish()
        .map_err(|invalid| Fail::Response(Box::new(invalid.into_response())))?;
    Ok(value)
}

/// `Field` → left out (`None`), cleared (`Some(None)`) or set.
#[allow(clippy::option_option, reason = "left out, cleared or set")]
fn tri<T>(field: Field<T>) -> Option<Option<T>> {
    match field {
        Field::Absent => None,
        Field::Null => Some(None),
        Field::Set(value) => Some(Some(value)),
    }
}

fn max(max: usize) -> Text {
    Text::length(None, Some(max))
}

fn trimmed(min: usize, max: usize) -> Text {
    Text::trimmed(Some(min), Some(max))
}

fn email() -> Text {
    Text {
        trim: true,
        lowercase: false,
        format: Some(Format::Email),
        min: None,
        max: Some(320),
    }
}

/// A Zod issue of the engine's schema, under `prefix`.
fn schema_issue(prefix: &Value, issue: &SchemaIssue) -> Value {
    let mut path: Vec<Value> = prefix.as_array().cloned().unwrap_or_default();
    path.extend(issue.path.iter().map(|segment| match segment {
        PathSegment::Key(key) => Value::String(key.clone()),
        PathSegment::Index(index) => json!(index),
    }));
    json!({ "code": "custom", "message": issue.message, "path": path })
}

/// `formDefinitionSchema.optional()` at `key`: the parsed definition as JSON.
fn definition(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Option<Value> {
    let value = body.get(key)?;
    match FormDefinition::parse(value) {
        Ok(def) => serde_json::to_value(def).ok(),
        Err(found) => {
            let prefix = issues.path_of(key);
            for issue in &found {
                issues.push_raw(schema_issue(&prefix, issue));
            }
            None
        }
    }
}

/// `formThemeTokensSchema` at `key`: the parsed tokens as JSON.
fn theme_tokens(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Option<Value> {
    let Some(value) = body.get(key) else {
        if presence == Presence::Required {
            let path = issues.path_of(key);
            issues.push_raw(json!({
                "code": "invalid_type",
                "expected": "object",
                "received": "undefined",
                "path": path,
                "message": "Required",
            }));
        }
        return None;
    };
    match FormThemeTokens::parse(value) {
        Ok(tokens) => serde_json::to_value(tokens).ok(),
        Err(found) => {
            let prefix = issues.path_of(key);
            for issue in &found {
                issues.push_raw(schema_issue(&prefix, issue));
            }
            None
        }
    }
}

/// `z.record(z.unknown())`.
fn record(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Option<Map<String, Value>> {
    issues
        .nested(body, key, presence, |_, fields| fields.clone())
        .into_option()
}

/// `z.record(z.string().max(max))`.
fn string_record(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    limit: usize,
) -> Option<Map<String, Value>> {
    issues
        .nested(body, key, presence, |issues, fields| {
            let mut out = Map::new();
            for name in fields.keys() {
                if let Some(text) = issues
                    .text_with(fields, name, Presence::Required, max(limit))
                    .into_option()
                {
                    out.insert(name.clone(), Value::String(text));
                }
            }
            out
        })
        .into_option()
}

/// `z.record(z.number().int().min(0)[.max(max)])`.
fn int_record(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    limit: Option<f64>,
) -> Option<Map<String, Value>> {
    issues
        .nested(body, key, Presence::Optional, |issues, fields| {
            let mut out = Map::new();
            for name in fields.keys() {
                let rules = Number {
                    coerce: false,
                    int: true,
                    min: Some(0.0),
                    max: limit,
                };
                if let Some(n) = issues
                    .number(fields, name, Presence::Required, rules)
                    .into_option()
                {
                    out.insert(name.clone(), fields[name].clone());
                    let _ = n;
                }
            }
            out
        })
        .into_option()
}

// ---------------------------------------------------------------------------
// Member schemas
// ---------------------------------------------------------------------------

/// `listFormsQuerySchema`.
pub(crate) fn list_forms(issues: &mut Issues, q: &Map<String, Value>) -> ListQuery {
    ListQuery {
        folder_id: issues
            .text_with(q, "folderId", Presence::Optional, max(30))
            .into_option(),
        status: issues
            .choice(q, "status", Presence::Optional, FORM_STATUSES)
            .into_option(),
        q: issues
            .text_with(q, "q", Presence::Optional, max(200))
            .into_option(),
        sort: issues
            .choice(
                q,
                "sort",
                Presence::Optional,
                &["updated", "created", "title", "responses"],
            )
            .into_option(),
        cursor: issues
            .text_with(q, "cursor", Presence::Optional, max(200))
            .into_option(),
        limit: issues
            .whole_number(
                q,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    int: true,
                    min: Some(1.0),
                    max: Some(100.0),
                },
            )
            .into_option(),
    }
}

/// `createFormSchema`.
pub(crate) fn create_form(issues: &mut Issues, b: &Map<String, Value>) -> CreateInput {
    CreateInput {
        title: issues
            .text_with(b, "title", Presence::Required, trimmed(1, 255))
            .into_option()
            .unwrap_or_default(),
        folder_id: issues
            .text_with(b, "folderId", Presence::Nullish, max(30))
            .into_option(),
        template_id: issues
            .text_with(b, "templateId", Presence::Optional, max(60))
            .into_option(),
        definition: definition(issues, b, "definition"),
        layout: issues
            .choice(b, "layout", Presence::Optional, FORM_LAYOUTS)
            .into_option(),
    }
}

/// `formSettingsSchema.partial()`: only the keys sent.
fn settings_patch(issues: &mut Issues, s: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    };
    let nullable_text =
        |field: Field<String>| tri(field).map(|v| v.map_or(Value::Null, Value::String));
    put(
        "respondentMode",
        issues
            .choice(
                s,
                "respondentMode",
                Presence::Optional,
                FORM_RESPONDENT_MODES,
            )
            .into_option()
            .map(Value::String),
    );
    for key in [
        "onePerRespondent",
        "allowEdit",
        "hideMemberIdentity",
        "collectPartial",
    ] {
        put(
            key,
            issues
                .boolean(s, key, Presence::Optional)
                .into_option()
                .map(Value::Bool),
        );
    }
    let date = Text {
        format: Some(Format::DatetimeOffset),
        ..Text::default()
    };
    put(
        "opensAt",
        nullable_text(issues.text_with(s, "opensAt", Presence::Nullish, date)),
    );
    put(
        "closesAt",
        nullable_text(issues.text_with(s, "closesAt", Presence::Nullish, date)),
    );
    put(
        "responseLimit",
        tri(issues.whole_number(
            s,
            "responseLimit",
            Presence::Nullish,
            Number {
                coerce: false,
                int: true,
                min: Some(1.0),
                max: Some(1_000_000.0),
            },
        ))
        .map(|v| v.map_or(Value::Null, |n| json!(n))),
    );
    put(
        "closedMessage",
        nullable_text(issues.text_with(s, "closedMessage", Presence::Nullish, max(1000))),
    );
    put(
        "allowedEmbedDomains",
        issues
            .list(
                s,
                "allowedEmbedDomains",
                Presence::Optional,
                None,
                Some(50),
                |issues, item| issues.item_text(item, Text::length(Some(1), Some(255))),
            )
            .into_option()
            .map(|domains| json!(domains)),
    );
    put(
        "sendReceipt",
        issues
            .boolean(s, "sendReceipt", Presence::Optional)
            .into_option()
            .map(Value::Bool),
    );
    out
}

/// `updateFormSchema`.
pub(crate) fn update_form(issues: &mut Issues, b: &Map<String, Value>) -> UpdateInput {
    UpdateInput {
        revision: issues
            .integer(b, "revision", Presence::Required, Some(1))
            .into_option()
            .unwrap_or_default(),
        title: issues
            .text_with(b, "title", Presence::Optional, trimmed(1, 255))
            .into_option(),
        folder_id: tri(issues.text_with(b, "folderId", Presence::Nullish, max(30))),
        definition: definition(issues, b, "definition"),
        settings: issues
            .nested(b, "settings", Presence::Optional, settings_patch)
            .into_option(),
        theme_id: tri(issues.text_with(b, "themeId", Presence::Nullish, max(30))),
        access: issues
            .choice(b, "access", Presence::Optional, FORM_ACCESS_LEVELS)
            .into_option(),
    }
}

/// `duplicateFormSchema`.
pub(crate) fn duplicate_form(issues: &mut Issues, b: &Map<String, Value>) -> Option<String> {
    issues
        .text_with(b, "title", Presence::Optional, trimmed(1, 255))
        .into_option()
}

/// `setFormAccessSchema`: `(userId, role)` pairs.
pub(crate) fn set_access(issues: &mut Issues, b: &Map<String, Value>) -> Vec<(String, String)> {
    issues
        .list(
            b,
            "entries",
            Presence::Required,
            None,
            Some(200),
            |issues, item| {
                let fields = issues.object(item)?;
                let user = issues
                    .text(fields, "userId", Presence::Required, Some(1), Some(255))
                    .into_option();
                let role = issues
                    .choice(fields, "role", Presence::Required, FORM_ACCESS_ROLES)
                    .into_option();
                Some((user?, role?))
            },
        )
        .into_option()
        .unwrap_or_default()
}

/// `formSubscriptionSchema`.
pub(crate) fn subscription(issues: &mut Issues, b: &Map<String, Value>) -> String {
    issues
        .choice(b, "mode", Presence::Required, FORM_SUBSCRIPTION_MODES)
        .into_option()
        .unwrap_or_default()
}

/// `createFormFolderSchema`.
pub(crate) fn create_folder(issues: &mut Issues, b: &Map<String, Value>) -> String {
    issues
        .text_with(b, "name", Presence::Required, trimmed(1, 255))
        .into_option()
        .unwrap_or_default()
}

/// `updateFormFolderSchema`.
pub(crate) fn update_folder(
    issues: &mut Issues,
    b: &Map<String, Value>,
) -> (Option<String>, Option<i64>) {
    (
        issues
            .text_with(b, "name", Presence::Optional, trimmed(1, 255))
            .into_option(),
        issues
            .integer(b, "position", Presence::Optional, Some(0))
            .into_option(),
    )
}

/// `createFormThemeSchema` (`partial` for the update).
pub(crate) struct ThemeInput {
    pub(crate) name: Option<String>,
    pub(crate) tokens: Option<Value>,
    pub(crate) is_default: Option<bool>,
}

pub(crate) fn theme(issues: &mut Issues, b: &Map<String, Value>, partial: bool) -> ThemeInput {
    let presence = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    ThemeInput {
        name: issues
            .text_with(b, "name", presence, trimmed(1, 255))
            .into_option(),
        tokens: theme_tokens(issues, b, "tokens", presence),
        is_default: issues
            .boolean(b, "isDefault", Presence::Optional)
            .into_option(),
    }
}

/// `updateFormsWorkspaceSettingsSchema`; a field left out is `None`, a cleared one `Some(None)`.
#[allow(
    clippy::option_option,
    reason = "left out, cleared or set, as Zod's `.nullable().optional()`"
)]
#[derive(Debug, Default)]
pub(crate) struct SettingsPatch {
    pub(crate) default_theme_id: Option<Option<String>>,
    pub(crate) sender_name: Option<Option<String>>,
    pub(crate) reminder_after_days: Option<Option<i64>>,
    pub(crate) reminder_every_days: Option<Option<i64>>,
    pub(crate) reminder_max_count: Option<i64>,
    pub(crate) show_badge: Option<bool>,
}

pub(crate) fn workspace_settings(issues: &mut Issues, b: &Map<String, Value>) -> SettingsPatch {
    let days = Number {
        coerce: false,
        int: true,
        min: Some(1.0),
        max: Some(30.0),
    };
    SettingsPatch {
        default_theme_id: tri(issues.text_with(
            b,
            "defaultThemeId",
            Presence::Nullish,
            Text::default(),
        )),
        sender_name: tri(issues.text_with(b, "senderName", Presence::Nullish, Text::default())),
        reminder_after_days: tri(issues.whole_number(
            b,
            "reminderAfterDays",
            Presence::Nullish,
            days,
        )),
        reminder_every_days: tri(issues.whole_number(
            b,
            "reminderEveryDays",
            Presence::Nullish,
            days,
        )),
        reminder_max_count: issues
            .whole_number(
                b,
                "reminderMaxCount",
                Presence::Optional,
                Number {
                    coerce: false,
                    int: true,
                    min: Some(0.0),
                    max: Some(5.0),
                },
            )
            .into_option(),
        show_badge: issues
            .boolean(b, "showBadge", Presence::Optional)
            .into_option(),
    }
}

/// `memberSubmitSchema`.
pub(crate) struct MemberSubmit {
    pub(crate) answers: Map<String, Value>,
    pub(crate) hidden: Option<Map<String, Value>>,
    pub(crate) timings: Option<Map<String, Value>>,
}

pub(crate) fn member_submit(issues: &mut Issues, b: &Map<String, Value>) -> MemberSubmit {
    MemberSubmit {
        answers: record(issues, b, "answers", Presence::Required).unwrap_or_default(),
        hidden: string_record(issues, b, "hidden", Presence::Optional, 1000),
        timings: int_record(issues, b, "timings", None),
    }
}

// ---------------------------------------------------------------------------
// Public schemas
// ---------------------------------------------------------------------------

/// `recordViewSchema`: the view key.
pub(crate) fn record_view(issues: &mut Issues, b: &Map<String, Value>) -> String {
    let key = issues
        .text(b, "viewKey", Presence::Required, Some(8), Some(64))
        .into_option();
    issues.text_with(b, "source", Presence::Optional, max(30));
    key.unwrap_or_default()
}

/// `startSessionSchema`.
#[derive(Debug, Default)]
pub(crate) struct StartSession {
    pub(crate) bot_token: Option<String>,
    pub(crate) invitation_token: Option<String>,
    pub(crate) verification: Option<String>,
    pub(crate) resume: Option<String>,
    pub(crate) browser_key: Option<String>,
    pub(crate) hidden: Option<Map<String, Value>>,
    /// `sessionMetadataSchema`'s keys only (Zod strips the rest).
    pub(crate) metadata: Option<Map<String, Value>>,
}

fn session_metadata(issues: &mut Issues, m: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(referrer) = issues
        .text_with(m, "referrer", Presence::Optional, max(2000))
        .into_option()
    {
        out.insert("referrer".to_owned(), Value::String(referrer));
    }
    if let Some(utm) = string_record(issues, m, "utm", Presence::Optional, 200) {
        out.insert("utm".to_owned(), Value::Object(utm));
    }
    if let Some(source) = issues
        .text_with(m, "source", Presence::Optional, max(30))
        .into_option()
    {
        out.insert("source".to_owned(), Value::String(source));
    }
    if let Some(device) = issues
        .choice(m, "device", Presence::Optional, DEVICES)
        .into_option()
    {
        out.insert("device".to_owned(), Value::String(device));
    }
    if let Some(browser) = issues
        .text_with(m, "browser", Presence::Optional, max(60))
        .into_option()
    {
        out.insert("browser".to_owned(), Value::String(browser));
    }
    if let Some(os) = issues
        .text_with(m, "os", Presence::Optional, max(60))
        .into_option()
    {
        out.insert("os".to_owned(), Value::String(os));
    }
    out
}

pub(crate) fn start_session(issues: &mut Issues, b: &Map<String, Value>) -> StartSession {
    StartSession {
        bot_token: issues
            .text_with(b, "botToken", Presence::Optional, max(5000))
            .into_option(),
        invitation_token: issues
            .text(
                b,
                "invitationToken",
                Presence::Optional,
                Some(20),
                Some(200),
            )
            .into_option(),
        verification: issues
            .text_with(b, "verification", Presence::Optional, max(500))
            .into_option(),
        resume: issues
            .text_with(b, "resume", Presence::Optional, max(1000))
            .into_option(),
        browser_key: issues
            .text_with(b, "browserKey", Presence::Optional, max(64))
            .into_option(),
        hidden: string_record(issues, b, "hidden", Presence::Optional, 1000),
        metadata: issues
            .nested(b, "metadata", Presence::Optional, session_metadata)
            .into_option(),
    }
}

/// `sendCodeSchema`: the email and the bot token.
pub(crate) fn send_code(issues: &mut Issues, b: &Map<String, Value>) -> (String, Option<String>) {
    (
        issues
            .text_with(b, "email", Presence::Required, email())
            .into_option()
            .unwrap_or_default(),
        issues
            .text_with(b, "botToken", Presence::Optional, max(5000))
            .into_option(),
    )
}

/// `verifyCodeSchema`: the email and the code.
pub(crate) fn verify_code(issues: &mut Issues, b: &Map<String, Value>) -> (String, String) {
    let email = issues
        .text_with(b, "email", Presence::Required, email())
        .into_option()
        .unwrap_or_default();
    let code = issues
        .pattern(
            b,
            "code",
            Presence::Required,
            None,
            None,
            |text| text.len() == 6 && text.bytes().all(|b| b.is_ascii_digit()),
            "Invalid",
        )
        .into_option()
        .unwrap_or_default();
    (email, code)
}

/// `saveProgressSchema`.
pub(crate) struct SaveProgress {
    pub(crate) last_block_id: String,
    pub(crate) answers: Option<Map<String, Value>>,
    pub(crate) timings: Option<Map<String, Value>>,
}

pub(crate) fn save_progress(issues: &mut Issues, b: &Map<String, Value>) -> SaveProgress {
    SaveProgress {
        last_block_id: issues
            .text_with(b, "lastBlockId", Presence::Required, max(30))
            .into_option()
            .unwrap_or_default(),
        answers: record(issues, b, "answers", Presence::Optional),
        timings: int_record(issues, b, "timings", Some(86_400_000.0)),
    }
}

/// `submitSessionSchema`.
pub(crate) struct SubmitSession {
    pub(crate) answers: Map<String, Value>,
    pub(crate) timings: Option<Map<String, Value>>,
    pub(crate) website: Option<String>,
}

pub(crate) fn submit_session(issues: &mut Issues, b: &Map<String, Value>) -> SubmitSession {
    SubmitSession {
        answers: record(issues, b, "answers", Presence::Required).unwrap_or_default(),
        timings: int_record(issues, b, "timings", Some(86_400_000.0)),
        website: issues
            .text_with(b, "website", Presence::Optional, max(500))
            .into_option(),
    }
}

/// `reportAbuseSchema`.
pub(crate) struct ReportAbuse {
    pub(crate) reason: String,
    pub(crate) details: Option<String>,
    pub(crate) email: Option<String>,
}

pub(crate) fn report_abuse(issues: &mut Issues, b: &Map<String, Value>) -> ReportAbuse {
    ReportAbuse {
        reason: issues
            .choice(b, "reason", Presence::Required, FORM_ABUSE_REASONS)
            .into_option()
            .unwrap_or_default(),
        details: issues
            .text_with(b, "details", Presence::Optional, max(2000))
            .into_option(),
        email: issues
            .text_with(b, "email", Presence::Optional, email())
            .into_option(),
    }
}
