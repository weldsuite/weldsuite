//! `/api/workspace-settings` (`app-api/src/routes/workspace-settings`,
//! `services/workspace-settings.ts`):
//!
//! - `GET /` and `PUT /`: the `workspace_settings` business record
//!   (`general:read` / `general:update`). The PUT mirrors the timezone into the
//!   master `digest_schedules`; the Stripe customer mirror is Global-only and
//!   skipped, as the worker skips it without `STRIPE_SECRET_KEY`.
//! - `PUT /name` (owner or admin) and `POST /slug` (owner): mirrored to the
//!   identity provider, with the master (and help-center) writes undone when
//!   it refuses.
//! - `GET /deletion-status` and `POST /delete` (owner): deleting cancels the
//!   Stripe subscription in the Global edition (skipped here), deletes the
//!   organization at the identity provider, then marks the master rows.
//!
//! The roles come from the tenant `workspace_members` row, not a permission:
//! the provider's admin role is broader than WeldSuite's owner.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{WORKSPACE_SETTINGS_DELETED, WORKSPACE_SETTINGS_UPDATED};
use weldsuite_catalogs::permission_keys::{GENERAL_READ, GENERAL_UPDATE};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Presence, json_body};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{IdentityError, OrganizationChanges, with_identity};

use super::vat_number;
use super::zod_issues::{
    ZodIssues, invalid_type_issue, js_length, js_trim, object, unrecognized_keys,
};
use crate::{Caller, CoreTeamState, TeamError, TeamResult, answer, now, validate};

const HELPCENTER_DOMAIN_SUFFIX: &str = ".welddesk.org";

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/",
            get(get_settings).route_layer(gate.require([GENERAL_READ])),
        )
        .route(
            "/",
            put(put_settings).route_layer(gate.require([GENERAL_UPDATE])),
        )
        .route("/name", put(rename))
        .route("/slug", post(change_slug))
        .route("/deletion-status", get(deletion_status))
        .route("/delete", post(delete_workspace))
}

/// `error.orgRequired(c)` without an org on the session.
fn org_of(caller: &Caller) -> TeamResult<String> {
    caller
        .org_id
        .clone()
        .ok_or_else(|| TeamError::api(ApiError::org_required()))
}

fn body_json(headers: &HeaderMap, body: &Bytes) -> TeamResult<Value> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    json_body(content_type, body).map_err(|bad| TeamError::Response(Box::new(bad.into_response())))
}

/// Drop the cached tenant lookup of an org (`wsx:<org>` and the old
/// `ws:<org>`). Best effort.
async fn invalidate_workspace_cache(state: &CoreTeamState, org: &str) {
    let Some(cache) = &state.cache else {
        return;
    };
    for key in [format!("wsx:{org}"), format!("ws:{org}")] {
        if let Err(error) = cache.delete_boxed(&key).await {
            tracing::warn!(%error, "workspace settings: cache delete failed");
        }
    }
}

/// The caller's role on their live tenant member row.
async fn caller_role(caller: &Caller) -> Result<Option<String>, sqlx::Error> {
    let role: Option<Option<String>> = sqlx::query_scalar(
        "select role from workspace_members where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(&caller.user_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(role.flatten())
}

// ── GET / and PUT / ─────────────────────────────────────────────────────────

async fn select_settings(db: &PgPool) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(s) from workspace_settings s where deleted_at is null limit 1",
    )
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

async fn get_settings(caller: Caller) -> Response {
    if caller.org_id.is_none() {
        return ApiError::org_required().into_response();
    }
    match select_settings(&caller.db).await {
        Ok(row) => Data(row.unwrap_or(Value::Null)).into_response(),
        Err(error) => TeamError::internal("Failed to fetch workspace settings", error).respond(),
    }
}

/// How a field of `updateWorkspaceSettingsInput` is checked.
#[derive(Clone, Copy)]
enum Kind {
    /// `z.string().optional()`.
    Text,
    /// `z.string().max(n).nullable().optional()`.
    Max(usize),
    /// `z.union([z.literal(''), z.string().trim().max(255).email()]).nullish()`.
    Email,
    /// `z.record(z.unknown()).nullable().optional()`.
    Record,
}

/// The schema's fields in its order, with their columns.
const FIELDS: &[(&str, &str, Kind)] = &[
    ("timezone", "timezone", Kind::Text),
    ("currency", "currency", Kind::Text),
    ("language", "language", Kind::Text),
    ("dateFormat", "date_format", Kind::Text),
    ("timeFormat", "time_format", Kind::Text),
    ("theme", "theme", Kind::Text),
    ("legalName", "legal_name", Kind::Max(255)),
    ("tradingName", "trading_name", Kind::Max(255)),
    ("contactFirstName", "contact_first_name", Kind::Max(255)),
    ("contactLastName", "contact_last_name", Kind::Max(255)),
    ("email", "email", Kind::Email),
    ("phone", "phone", Kind::Max(30)),
    ("addressLine1", "address_line_1", Kind::Max(255)),
    ("addressLine2", "address_line_2", Kind::Max(255)),
    ("city", "city", Kind::Max(100)),
    ("state", "state", Kind::Max(100)),
    ("postalCode", "postal_code", Kind::Max(20)),
    ("country", "country", Kind::Max(100)),
    ("vatNumber", "vat_number", Kind::Max(50)),
    ("registrationNumber", "registration_number", Kind::Max(50)),
    ("logoUrl", "logo_url", Kind::Max(500)),
    ("websiteUrl", "website_url", Kind::Max(500)),
    ("primaryColor", "primary_color", Kind::Max(20)),
    ("accentColor", "accent_color", Kind::Max(20)),
    ("customSettings", "custom_settings", Kind::Record),
];

/// Zod 3's email pattern, minus its lookaheads (checked apart).
static EMAIL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?i-u)^([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$")
        .expect("the email pattern compiles")
});

fn is_email(text: &str) -> bool {
    !text.starts_with('.') && !text.contains("..") && EMAIL.is_match(text)
}

/// `z.string().max(max)` on a present string; the value read.
fn read_max(issues: &mut ZodIssues, key: &str, text: &str, max: usize) -> Value {
    if js_length(text) > max {
        issues.too_big(
            &json!([key]),
            max,
            &format!("String must contain at most {max} character(s)"),
        );
    }
    Value::String(text.to_owned())
}

/// The email union: `''`, or a trimmed address of at most 255.
fn read_email(issues: &mut ZodIssues, value: &Value) -> Value {
    let path = json!(["email"]);
    let Value::String(text) = value else {
        // Neither option takes it: Zod reports both.
        issues.push(json!({
            "code": "invalid_union",
            "unionErrors": [
                {
                    "issues": [{
                        "received": value,
                        "code": "invalid_literal",
                        "expected": "",
                        "path": ["email"],
                        "message": "Invalid literal value, expected \"\"",
                    }],
                    "name": "ZodError",
                },
                { "issues": [invalid_type_issue(&path, "string", Some(value))], "name": "ZodError" },
            ],
            "path": ["email"],
            "message": "Invalid input",
        }));
        issues.aborted = true;
        return Value::Null;
    };
    if text.is_empty() {
        return Value::String(String::new());
    }
    let trimmed = js_trim(text);
    if js_length(trimmed) > 255 {
        issues.too_big(&path, 255, "String must contain at most 255 character(s)");
    }
    if !is_email(trimmed) {
        issues.invalid_string(&path, "email", "Invalid email address");
    }
    Value::String(trimmed.to_owned())
}

/// `updateWorkspaceSettingsInput`: the present fields (camelCase), as parsed.
fn read_settings(body: &Value) -> TeamResult<Map<String, Value>> {
    let mut issues = ZodIssues::default();
    let mut data = Map::new();
    let Some(fields) = object(&mut issues, body) else {
        issues.finish()?;
        return Ok(data);
    };
    for (key, _, kind) in FIELDS {
        let Some(value) = fields.get(*key) else {
            continue;
        };
        let path = json!([key]);
        let presence = match kind {
            Kind::Text => Presence::Optional,
            _ => Presence::Nullish,
        };
        if value.is_null() {
            if presence == Presence::Nullish {
                data.insert((*key).to_owned(), Value::Null);
            } else {
                issues.invalid_type(&path, "string", Some(value));
            }
            continue;
        }
        let read = match (kind, value) {
            (Kind::Text, Value::String(text)) => Value::String(text.clone()),
            (Kind::Max(max), Value::String(text)) => read_max(&mut issues, key, text, *max),
            (Kind::Email, _) => read_email(&mut issues, value),
            (Kind::Record, Value::Object(_)) => value.clone(),
            (Kind::Record, _) => {
                issues.invalid_type(&path, "object", Some(value));
                continue;
            }
            _ => {
                issues.invalid_type(&path, "string", Some(value));
                continue;
            }
        };
        data.insert((*key).to_owned(), read);
    }
    let known: Vec<&str> = FIELDS.iter().map(|(key, _, _)| *key).collect();
    unrecognized_keys(&mut issues, fields, &known);
    // The VAT refinement runs unless a wrong type aborted the object.
    if !issues.aborted
        && let Some(Value::String(vat)) = data.get("vatNumber")
        && !vat.is_empty()
        && let Err(message) = vat_number::check(vat, data.get("country").and_then(Value::as_str))
    {
        issues.custom(&json!(["vatNumber"]), &message);
    }
    issues.finish()?;
    Ok(data)
}

/// JavaScript truthiness of a parsed value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `touchesBillingMirror`.
fn touches_billing_mirror(data: &Map<String, Value>) -> bool {
    [
        "legalName",
        "tradingName",
        "email",
        "addressLine1",
        "city",
        "postalCode",
        "country",
        "timezone",
    ]
    .iter()
    .any(|key| truthy(data.get(*key)))
}

/// `syncBillingMirror`: the digest timezone in the master database. Best
/// effort end to end. The Stripe customer update is Global-only.
async fn sync_billing_mirror(master: &PgPool, org: &str, data: &Map<String, Value>) {
    let workspace: Result<Option<(String, Option<String>)>, sqlx::Error> = sqlx::query_as(
        "select id, stripe_customer_id from workspaces where id = $1 or clerk_org_id = $1 limit 1",
    )
    .bind(org)
    .fetch_optional(master)
    .await;
    let (workspace_id, stripe_customer) = match workspace {
        Ok(Some(row)) => row,
        Ok(None) => return,
        Err(error) => {
            tracing::error!(%error, "workspace settings: billing mirror sync failed");
            return;
        }
    };
    if let Some(Value::String(timezone)) = data.get("timezone")
        && !timezone.is_empty()
        && let Err(error) = sqlx::query(
            "update digest_schedules set timezone = $2, updated_at = $3::timestamp
             where workspace_id = $1",
        )
        .bind(&workspace_id)
        .bind(timezone)
        .bind(now())
        .execute(master)
        .await
    {
        tracing::error!(%error, "workspace settings: digest timezone sync failed");
    }
    if stripe_customer.is_some() {
        tracing::debug!("workspace settings: no Stripe on this edition, customer not updated");
    }
}

async fn put_settings(
    State(state): State<CoreTeamState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_put_settings(&state, &caller, &headers, &body).await)
}

async fn run_put_settings(
    state: &CoreTeamState,
    caller: &Caller,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let data = read_settings(&body_json(headers, body)?)?;
    let org = org_of(caller)?;
    let failed =
        |error: sqlx::Error| TeamError::internal("Failed to update workspace settings", error);

    // The columns the body sets, for `jsonb_populate_record`.
    let patch: Map<String, Value> = FIELDS
        .iter()
        .filter_map(|(key, column, _)| data.get(*key).map(|v| ((*column).to_owned(), v.clone())))
        .collect();
    let patch = Value::Object(patch);
    let stamp = now();

    let existing: Option<String> =
        sqlx::query_scalar("select id from workspace_settings where deleted_at is null limit 1")
            .fetch_optional(&caller.db)
            .await
            .map_err(failed)?;
    let (id, created) = if let Some(id) = existing {
        sqlx::query(
            "update workspace_settings w set
                 theme = r.theme, timezone = r.timezone, currency = r.currency,
                 language = r.language, date_format = r.date_format, time_format = r.time_format,
                 legal_name = r.legal_name, trading_name = r.trading_name,
                 contact_first_name = r.contact_first_name, contact_last_name = r.contact_last_name,
                 email = r.email, phone = r.phone, address_line_1 = r.address_line_1,
                 address_line_2 = r.address_line_2, city = r.city, state = r.state,
                 postal_code = r.postal_code, country = r.country, vat_number = r.vat_number,
                 registration_number = r.registration_number, logo_url = r.logo_url,
                 website_url = r.website_url, primary_color = r.primary_color,
                 accent_color = r.accent_color, custom_settings = r.custom_settings,
                 updated_at = $3::timestamptz
             from (select (jsonb_populate_record(c, $2::jsonb)).*
                   from workspace_settings c where c.id = $1) r
             where w.id = $1",
        )
        .bind(&id)
        .bind(&patch)
        .bind(&stamp)
        .execute(&caller.db)
        .await
        .map_err(failed)?;
        (id, false)
    } else {
        let id = generate_id("ws");
        sqlx::query(
            "insert into workspace_settings
                 (id, theme, timezone, currency, language, date_format, time_format, legal_name,
                  trading_name, contact_first_name, contact_last_name, email, phone,
                  address_line_1, address_line_2, city, state, postal_code, country, vat_number,
                  registration_number, logo_url, website_url, primary_color, accent_color,
                  custom_settings, created_at, updated_at)
             select $1, r.theme, r.timezone, r.currency, r.language, r.date_format,
                    r.time_format, r.legal_name, r.trading_name, r.contact_first_name,
                    r.contact_last_name, r.email, r.phone, r.address_line_1, r.address_line_2,
                    r.city, r.state, r.postal_code, r.country, r.vat_number,
                    r.registration_number, r.logo_url, r.website_url, r.primary_color,
                    r.accent_color, r.custom_settings, $3::timestamptz, $3::timestamptz
             from jsonb_populate_record(null::workspace_settings, $2::jsonb) r",
        )
        .bind(&id)
        .bind(&patch)
        .bind(&stamp)
        .execute(&caller.db)
        .await
        .map_err(failed)?;
        (id, true)
    };
    let row: Value =
        sqlx::query_scalar("select to_jsonb(s) from workspace_settings s where id = $1 limit 1")
            .bind(&id)
            .fetch_one(&caller.db)
            .await
            .map_err(failed)?;
    let row = js_row(row);

    if touches_billing_mirror(&data) {
        sync_billing_mirror(&caller.master(state), &org, &data).await;
    }
    // The catalog has no `created` action: an insert is `updated` too.
    caller.publish(state, WORKSPACE_SETTINGS_UPDATED, &id, &row);
    Ok(if created {
        Created(row).into_response()
    } else {
        Data(row).into_response()
    })
}

// ── PUT /name ───────────────────────────────────────────────────────────────

/// `updateWorkspaceNameInput`: a trimmed name of 1 to 255.
fn read_name(body: &Value) -> TeamResult<String> {
    let mut issues = ZodIssues::default();
    let mut name = String::new();
    if let Some(fields) = object(&mut issues, body) {
        let path = json!(["name"]);
        match fields.get("name") {
            Some(Value::String(text)) => {
                js_trim(text).clone_into(&mut name);
                let length = js_length(&name);
                if length < 1 {
                    issues.too_small(&path, 1, "Name is required");
                }
                if length > 255 {
                    issues.too_big(&path, 255, "Name must be at most 255 characters");
                }
            }
            other => issues.invalid_type(&path, "string", other),
        }
    }
    issues.finish()?;
    Ok(name)
}

async fn rename(
    State(state): State<CoreTeamState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_rename(&state, &caller, &headers, &body).await)
}

async fn run_rename(
    state: &CoreTeamState,
    caller: &Caller,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let name = read_name(&body_json(headers, body)?)?;
    let org = org_of(caller)?;
    let role = caller_role(caller).await?;
    if !matches!(role.as_deref(), Some("OWNER" | "ADMIN")) {
        return Err(TeamError::api(ApiError::forbidden().with_message(
            "Only the workspace owner or an admin can rename the workspace.",
        )));
    }
    let failed = |error: &dyn std::fmt::Display| {
        TeamError::internal("Failed to update workspace name", error)
    };

    let master = caller.master(state);
    let workspace: Option<(String, String)> =
        sqlx::query_as("select id, name from workspaces where clerk_org_id = $1 limit 1")
            .bind(&org)
            .fetch_optional(&master)
            .await
            .map_err(|e| failed(&e))?;
    let Some((id, previous)) = workspace else {
        return Err(TeamError::api(ApiError::not_found("Workspace", None)));
    };

    if previous != name {
        let set_name = |value: String| {
            sqlx::query("update workspaces set name = $2, updated_at = $3::timestamp where id = $1")
                .bind(id.clone())
                .bind(value)
                .bind(now())
        };
        set_name(name.clone())
            .execute(&master)
            .await
            .map_err(|e| failed(&e))?;
        let changes = OrganizationChanges {
            name: Some(name.clone()),
            ..OrganizationChanges::default()
        };
        if let Err(error) = with_identity(caller.identity(state).as_ref(), |i| {
            i.update_organization(&org, &changes)
        })
        .await
        {
            // Compensating write: the previous name back.
            set_name(previous)
                .execute(&master)
                .await
                .map_err(|e| failed(&e))?;
            return Err(match error {
                IdentityError::Rejected { status, .. } => {
                    tracing::error!(status, "workspace settings: name sync failed");
                    TeamError::api(ApiError::conflict(
                        "That name could not be used. Please try a different value.",
                    ))
                }
                IdentityError::Unavailable(_) => failed(&error),
            });
        }
    }

    invalidate_workspace_cache(state, &org).await;
    caller.publish(
        state,
        WORKSPACE_SETTINGS_UPDATED,
        &id,
        &json!({ "id": id, "field": "name", "name": name }),
    );
    Ok(Data(json!({ "id": id, "name": name })).into_response())
}

// ── POST /slug ──────────────────────────────────────────────────────────────

/// `SLUG_REGEX`: `^[a-z][a-z0-9-]{1,61}[a-z0-9]$`.
fn slug_format(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    let n = bytes.len();
    (3..=63).contains(&n)
        && bytes[0].is_ascii_lowercase()
        && (bytes[n - 1].is_ascii_lowercase() || bytes[n - 1].is_ascii_digit())
        && bytes[1..n - 1]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// `RESERVED_WORKSPACE_SLUGS` (`schemas/workspace-slug.ts`).
const RESERVED_SLUGS: &[&str] = &[
    "www",
    "app",
    "api",
    "admin",
    "mail",
    "support",
    "help",
    "agents",
    "apps",
    "appstore",
    "auth",
    "call-room",
    "documents",
    "invite",
    "new-chat",
    "objects",
    "onboarding",
    "preview",
    "settings",
    "social",
    "welcome",
    "weldads",
    "weldbooks",
    "weldcalendar",
    "weldcall",
    "weldchat",
    "weldcommerce",
    "weldconnect",
    "weldcrm",
    "welddata",
    "welddesk",
    "welddocs",
    "welddrive",
    "weldflow",
    "weldhost",
    "weldhr",
    "weldknow",
    "weldmail",
    "weldmeet",
    "weldpanel",
    "weldpass",
    "weldreach",
    "weldsheets",
    "weldsign",
    "weldstash",
    "assets",
    "email",
    "logos",
    "models",
    "sounds",
];

/// `updateWorkspaceSlugInput` (`workspaceSlugSchema`).
fn read_slug(body: &Value) -> TeamResult<String> {
    let mut issues = ZodIssues::default();
    let mut slug = String::new();
    if let Some(fields) = object(&mut issues, body) {
        let path = json!(["slug"]);
        match fields.get("slug") {
            Some(Value::String(text)) => {
                slug.clone_from(text);
                let length = js_length(text);
                if length < 3 {
                    issues.too_small(&path, 3, "Slug must be at least 3 characters");
                }
                if length > 63 {
                    issues.too_big(&path, 63, "Slug must be at most 63 characters");
                }
                if !slug_format(text) {
                    issues.invalid_string(
                        &path,
                        "regex",
                        "Slug must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens",
                    );
                }
                // The refinement runs on a dirty string too.
                if RESERVED_SLUGS.contains(&text.to_lowercase().as_str()) {
                    issues.custom(&path, "This slug is reserved");
                }
            }
            other => issues.invalid_type(&path, "string", other),
        }
    }
    issues.finish()?;
    Ok(slug)
}

async fn change_slug(
    State(state): State<CoreTeamState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_change_slug(&state, &caller, &headers, &body).await)
}

/// Point the help-center subdomain rows at `to` where they still say `from`.
async fn move_helpcenter(
    master: &PgPool,
    tenant: &PgPool,
    workspace_id: &str,
    from: &str,
    to: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update helpcenter_domain_registry set domain = $3, updated_at = $4::timestamp
         where workspace_id = $1 and domain = $2",
    )
    .bind(workspace_id)
    .bind(from)
    .bind(to)
    .bind(now())
    .execute(master)
    .await?;
    sqlx::query(
        "update helpcenter_settings set default_subdomain = $2, updated_at = $3::timestamp
         where default_subdomain = $1",
    )
    .bind(from)
    .bind(to)
    .bind(now())
    .execute(tenant)
    .await?;
    Ok(())
}

async fn set_slug(master: &PgPool, workspace_id: &str, slug: &str) -> Result<(), sqlx::Error> {
    sqlx::query("update workspaces set slug = $2, updated_at = $3::timestamp where id = $1")
        .bind(workspace_id)
        .bind(slug)
        .bind(now())
        .execute(master)
        .await
        .map(|_| ())
}

/// What the provider's error code says about a refused slug.
fn slug_refusal_message(code: &str) -> &'static str {
    if code.contains("exists") || code.contains("unique") || code.contains("taken") {
        "That slug is already in use. Please try a different value."
    } else if code.contains("format") || code.contains("invalid") {
        "That slug is not in a valid format. Use lowercase letters, numbers, and hyphens."
    } else {
        "That slug could not be used. Please try a different value."
    }
}

async fn run_change_slug(
    state: &CoreTeamState,
    caller: &Caller,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let slug = read_slug(&body_json(headers, body)?)?;
    let org = org_of(caller)?;
    if caller_role(caller).await?.as_deref() != Some("OWNER") {
        return Err(TeamError::api(ApiError::forbidden().with_message(
            "Only the workspace owner can change the workspace slug.",
        )));
    }
    let failed = |error: &dyn std::fmt::Display| {
        TeamError::internal("Failed to update workspace slug", error)
    };

    let master = caller.master(state);
    let workspace: Option<(String, String)> =
        sqlx::query_as("select id, slug from workspaces where clerk_org_id = $1 limit 1")
            .bind(&org)
            .fetch_optional(&master)
            .await
            .map_err(|e| failed(&e))?;
    let Some((id, previous)) = workspace else {
        return Err(TeamError::api(ApiError::not_found("Workspace", None)));
    };
    if previous == slug {
        return Err(TeamError::api(ApiError::bad_request(
            "New slug is identical to the current slug",
        )));
    }
    let taken: Option<String> =
        sqlx::query_scalar("select id from workspaces where slug = $1 limit 1")
            .bind(&slug)
            .fetch_optional(&master)
            .await
            .map_err(|e| failed(&e))?;
    if taken.is_some() {
        return Err(TeamError::api(ApiError::conflict(format!(
            "Slug '{slug}' is already taken"
        ))));
    }

    let old_domain = format!("{previous}{HELPCENTER_DOMAIN_SUFFIX}");
    let new_domain = format!("{slug}{HELPCENTER_DOMAIN_SUFFIX}");
    set_slug(&master, &id, &slug)
        .await
        .map_err(|e| failed(&e))?;
    move_helpcenter(&master, &caller.db, &id, &old_domain, &new_domain)
        .await
        .map_err(|e| failed(&e))?;

    let changes = OrganizationChanges {
        slug: Some(slug.clone()),
        ..OrganizationChanges::default()
    };
    if let Err(error) = with_identity(caller.identity(state).as_ref(), |i| {
        i.update_organization(&org, &changes)
    })
    .await
    {
        // Compensating writes: everything back as it was.
        set_slug(&master, &id, &previous)
            .await
            .map_err(|e| failed(&e))?;
        move_helpcenter(&master, &caller.db, &id, &new_domain, &old_domain)
            .await
            .map_err(|e| failed(&e))?;
        return Err(match &error {
            IdentityError::Rejected { status, code, .. } => {
                tracing::error!(status, "workspace settings: slug sync failed");
                TeamError::api(ApiError::conflict(slug_refusal_message(
                    code.as_deref().unwrap_or_default(),
                )))
            }
            IdentityError::Unavailable(_) => failed(&error),
        });
    }

    invalidate_workspace_cache(state, &org).await;
    caller.publish(
        state,
        WORKSPACE_SETTINGS_UPDATED,
        &id,
        &json!({ "id": id, "field": "slug", "slug": slug, "previousSlug": previous }),
    );
    Ok(Data(json!({ "id": id, "slug": slug, "previousSlug": previous })).into_response())
}

// ── deletion ────────────────────────────────────────────────────────────────

fn owner_only() -> TeamError {
    TeamError::api(
        ApiError::forbidden().with_message("Only the workspace owner can delete the workspace."),
    )
}

async fn deletion_status(State(state): State<CoreTeamState>, caller: Caller) -> Response {
    answer(run_deletion_status(&state, &caller).await)
}

async fn run_deletion_status(state: &CoreTeamState, caller: &Caller) -> TeamResult<Response> {
    let org = org_of(caller)?;
    if caller_role(caller).await?.as_deref() != Some("OWNER") {
        return Err(owner_only());
    }
    let failed = |error: sqlx::Error| {
        TeamError::internal("Failed to compute workspace deletion status", error)
    };
    let workspace: Option<(String, String, String, Option<String>)> = sqlx::query_as(
        "select id, name, slug, stripe_subscription_id from workspaces
         where clerk_org_id = $1 limit 1",
    )
    .bind(&org)
    .fetch_optional(&caller.master(state))
    .await
    .map_err(failed)?;
    let Some((id, name, slug, subscription)) = workspace else {
        return Err(TeamError::api(ApiError::not_found("Workspace", None)));
    };
    let members: i32 = sqlx::query_scalar(
        "select count(*)::int from workspace_members
         where status = 'ACTIVE' and deleted_at is null",
    )
    .fetch_one(&caller.db)
    .await
    .map_err(failed)?;
    Ok(Data(json!({
        "workspaceId": id,
        "name": name,
        "slug": slug,
        "memberCount": members,
        "hasActiveSubscription": subscription.is_some_and(|s| !s.is_empty()),
    }))
    .into_response())
}

async fn delete_workspace(
    State(state): State<CoreTeamState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_delete(&state, &caller, &headers, &body).await)
}

async fn run_delete(
    state: &CoreTeamState,
    caller: &Caller,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let confirmation = validate(headers, body, |issues, fields| {
        issues.text(fields, "confirmation", Presence::Required, Some(1), None)
    })?
    .into_option()
    .unwrap_or_default();
    let org = org_of(caller)?;
    if caller_role(caller).await?.as_deref() != Some("OWNER") {
        return Err(owner_only());
    }
    let failed = |error: sqlx::Error| TeamError::internal("Failed to delete workspace", error);
    let master = caller.master(state);
    let workspace: Option<(String, String, Option<String>)> = sqlx::query_as(
        "select id, slug, stripe_subscription_id from workspaces where clerk_org_id = $1 limit 1",
    )
    .bind(&org)
    .fetch_optional(&master)
    .await
    .map_err(failed)?;
    let Some((id, slug, subscription)) = workspace else {
        return Err(TeamError::api(ApiError::not_found("Workspace", None)));
    };
    if confirmation != slug {
        return Err(TeamError::api(ApiError::bad_request(
            "Confirmation does not match the workspace identifier.",
        )));
    }

    // The Global edition cancels the Stripe subscription first; billing is
    // Global-only, so there is none to cancel here (the worker skips it too
    // without `STRIPE_SECRET_KEY`).
    if subscription.is_some_and(|s| !s.is_empty()) {
        tracing::warn!(
            workspace_id = id,
            "workspace settings: subscription left to billing"
        );
    }

    if let Err(error) = with_identity(caller.identity(state).as_ref(), |i| {
        i.delete_organization(&org)
    })
    .await
    {
        tracing::error!(%error, workspace_id = id, "workspace settings: deleting the organization failed");
        return Err(TeamError::api(
            ApiError::internal().with_message("Failed to delete workspace. Please try again."),
        ));
    }

    let stamp = now();
    sqlx::query(
        "update workspaces
         set is_active = false, deleted_at = coalesce(deleted_at, $2::timestamp),
             updated_at = $2::timestamp
         where id = $1",
    )
    .bind(&id)
    .bind(&stamp)
    .execute(&master)
    .await
    .map_err(failed)?;
    sqlx::query("delete from user_workspaces where workspace_id = $1")
        .bind(&id)
        .execute(&master)
        .await
        .map_err(failed)?;

    invalidate_workspace_cache(state, &org).await;
    caller.publish(
        state,
        WORKSPACE_SETTINGS_DELETED,
        &id,
        &json!({ "id": id, "slug": slug }),
    );
    Ok(Data(json!({ "deleted": true })).into_response())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn slugs_follow_the_slug_regex() {
        assert!(slug_format("acme-2"));
        assert!(!slug_format("ab"));
        assert!(!slug_format("2acme"));
        assert!(!slug_format("acme-"));
        assert!(!slug_format("Acme"));
    }

    #[test]
    fn settings_refuse_unknown_keys_and_bad_vat() {
        let error = read_settings(&json!({ "name": "x", "vatNumber": "NL1", "country": "NL" }));
        assert!(error.is_err());
        let data = read_settings(&json!({ "email": " a@b.co ", "logoUrl": null })).expect("valid");
        assert_eq!(data["email"], "a@b.co");
        assert_eq!(data["logoUrl"], Value::Null);
    }
}
