//! `/api/workspace-settings` (`app-api/src/routes/workspace-settings`,
//! `services/workspace-settings.ts`):
//!
//! - `GET /` and `PUT /`: the `workspace_settings` business record
//!   (`general:read` / `general:update`). The business profile is the default
//!   legal entity ([`super::business_profile`]): the PUT refuses a country
//!   the entity's history locks (409), writes the legal fields through to the
//!   entity (creating it when there is none and the country is ISO-2), and
//!   both answer the record with the entity's values laid over it. The PUT
//!   mirrors the timezone into the master `digest_schedules`; the Stripe
//!   customer mirror is Global-only and skipped, as the worker skips it
//!   without `STRIPE_SECRET_KEY`.
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
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, PaginatorTrait, QueryFilter,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_auth::{StepUp, StepUpGuard};
use weldsuite_catalogs::entity_events::{
    LEGAL_ENTITY_CREATED, LEGAL_ENTITY_UPDATED, WORKSPACE_SETTINGS_DELETED,
    WORKSPACE_SETTINGS_UPDATED,
};
use weldsuite_catalogs::permission_keys::{GENERAL_READ, GENERAL_UPDATE};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Presence, json_body};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{IdentityError, OrganizationChanges, with_identity};
use weldsuite_schema::master::{
    digest_schedules, helpcenter_domain_registry, user_workspaces, workspaces,
};
use weldsuite_schema::tenant::workspace_settings as settings;
use weldsuite_schema::tenant::{helpcenter_settings, workspace_members as members};

use super::business_profile::{
    WriteThrough, default_entity_profile, locked_business_profile_change, overlay_default_entity,
    write_through_to_default_entity,
};
use super::vat_number;
use super::zod_issues::{
    ZodIssues, invalid_type_issue, js_length, js_trim, object, unrecognized_keys,
};
use crate::access::js;
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
async fn invalidate_workspace_cache(state: &CoreTeamState, caller: &Caller, org: &str) {
    let Some(cache) = caller.cache(state) else {
        return;
    };
    for key in [format!("wsx:{org}"), format!("ws:{org}")] {
        if let Err(error) = cache.delete_boxed(&key).await {
            tracing::warn!(%error, "workspace settings: cache delete failed");
        }
    }
}

/// The caller's role on their live tenant member row.
async fn caller_role(caller: &Caller) -> Result<Option<String>, DbErr> {
    let role: Option<Option<String>> = members::Entity::find()
        .select_only()
        .column(members::Column::Role)
        .filter(members::Column::UserId.eq(&caller.user_id))
        .filter(members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    Ok(role.flatten())
}

// ── GET / and PUT / ─────────────────────────────────────────────────────────

/// The live settings row, as Drizzle returns it.
async fn select_settings(db: &PgPool) -> Result<Option<Value>, DbErr> {
    let row = settings::Entity::find()
        .filter(settings::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    row.map(js).transpose()
}

async fn get_settings(caller: Caller) -> Response {
    if caller.org_id.is_none() {
        return ApiError::org_required().into_response();
    }
    match read_overlaid(&caller.db).await {
        Ok(row) => Data(row).into_response(),
        Err(cause) => TeamError::internal("Failed to fetch workspace settings", cause).respond(),
    }
}

/// The settings row with the default legal entity's business fields laid
/// over it. A workspace that never saved one gets the default entity's
/// business fields, or null without one either (TASK-1464: a null here made
/// the form's first save clear the entity's VAT and registration numbers).
async fn read_overlaid(db: &PgPool) -> Result<Value, String> {
    let Some(row) = select_settings(db)
        .await
        .map_err(|error| error.to_string())?
    else {
        return default_entity_profile(db)
            .await
            .map(|profile| profile.unwrap_or(Value::Null))
            .map_err(|error| error.to_string());
    };
    overlay_default_entity(db, row)
        .await
        .map_err(|error| error.to_string())
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
/// effort end to end. The Stripe customer update is Global-only; with
/// `skip_stripe` the default legal entity carries it instead.
async fn sync_billing_mirror(
    master: &PgPool,
    org: &str,
    data: &Map<String, Value>,
    skip_stripe: bool,
) {
    let master = orm(master);
    let workspace: Result<Option<(String, Option<String>)>, DbErr> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .column(workspaces::Column::StripeCustomerId)
        .filter(
            Condition::any()
                .add(workspaces::Column::Id.eq(org))
                .add(workspaces::Column::ClerkOrgId.eq(org)),
        )
        .into_tuple()
        .one(&master)
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
        && let Err(error) = digest_schedules::Entity::update_many()
            .col_expr(
                digest_schedules::Column::Timezone,
                Expr::value(timezone.clone()),
            )
            .col_expr(
                digest_schedules::Column::UpdatedAt,
                Expr::value(utc_now().assume_utc()),
            )
            .filter(digest_schedules::Column::WorkspaceId.eq(&workspace_id))
            .exec(&master)
            .await
    {
        tracing::error!(%error, "workspace settings: digest timezone sync failed");
    }
    if !skip_stripe && stripe_customer.is_some() {
        tracing::debug!("workspace settings: no Stripe on this edition, customer not updated");
    }
}

/// `mirrorStripeCustomer` with the default entity's profile: the Stripe
/// customer follows the default legal entity. Billing is Global-only, so
/// there is no customer to update on this edition.
fn mirror_stripe_customer(written: &WriteThrough) {
    tracing::debug!(
        entity_id = written.entity.id,
        "workspace settings: no Stripe on this edition, customer not updated"
    );
}

async fn put_settings(
    State(state): State<CoreTeamState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_put_settings(&state, &caller, &headers, &body).await)
}

/// `workspace_settings` written from the body's columns.
const SETTINGS: JsonTable = JsonTable::of::<settings::Entity>();

/// `upsertWorkspaceSettings`: the singleton row with the fields the body
/// sets; its id, whether it was created, and the row as Drizzle returns it.
/// The fields the body leaves out keep their value (update) or are null
/// (insert: none of them has a default).
async fn upsert_settings(
    db: &PgPool,
    data: &Map<String, Value>,
) -> Result<(String, bool, Value), DbErr> {
    // The columns the body sets, for `jsonb_populate_record`.
    let mut patch: Map<String, Value> = FIELDS
        .iter()
        .filter_map(|(key, column, _)| data.get(*key).map(|v| ((*column).to_owned(), v.clone())))
        .collect();
    let stamp = Value::String(now());
    let db = orm(db);

    let existing: Option<String> = settings::Entity::find()
        .select_only()
        .column(settings::Column::Id)
        .filter(settings::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
        .await?;
    if let Some(id) = existing {
        patch.insert("updated_at".to_owned(), stamp);
        let row = SETTINGS
            .update(&db, &id, patch, false)
            .await?
            .ok_or_else(|| DbErr::RecordNotFound(format!("workspace_settings {id}")))?;
        return Ok((id, false, row));
    }
    let id = generate_id("ws");
    patch.insert("id".to_owned(), Value::String(id.clone()));
    patch.insert("created_at".to_owned(), stamp.clone());
    patch.insert("updated_at".to_owned(), stamp);
    let row = SETTINGS.insert(&db, patch).await?;
    Ok((id, true, row))
}

async fn run_put_settings(
    state: &CoreTeamState,
    caller: &Caller,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    let data = read_settings(&body_json(headers, body)?)?;
    let org = org_of(caller)?;
    // A country the default entity's history locks is refused before
    // anything is saved.
    if let Some(reason) = locked_business_profile_change(&caller.db, &data)
        .await
        .map_err(|error| TeamError::internal("Failed to update workspace settings", error))?
    {
        return Err(TeamError::api(ApiError::conflict(reason)));
    }

    let (id, created, row) = upsert_settings(&caller.db, &data)
        .await
        .map_err(|error| TeamError::internal("Failed to update workspace settings", error))?;

    // The business profile is the default legal entity: write the legal
    // fields through to it. The settings row keeps its copy while old
    // workers may still read it, and a failure here never loses the save.
    let master = caller.master(state);
    let written = match write_through_to_default_entity(&caller.db, &data, &row, &master, &org)
        .await
    {
        Ok(written) => written,
        Err(error) => {
            tracing::error!(%error, "workspace settings: write-through to the default legal entity failed");
            None
        }
    };

    if touches_billing_mirror(&data) {
        // With a default entity the Stripe customer follows the entity (the
        // same mirror as /api/legal-entities); the digest timezone still
        // syncs here.
        sync_billing_mirror(&master, &org, &data, written.is_some()).await;
        if let Some(written) = &written {
            mirror_stripe_customer(written);
        }
    }

    if let Some(written) = &written {
        let event = if written.created {
            LEGAL_ENTITY_CREATED
        } else {
            LEGAL_ENTITY_UPDATED
        };
        caller.publish(state, event, &written.entity.id, &written.entity.row);
    }

    // The catalog has no `created` action: an insert is `updated` too.
    caller.publish(state, WORKSPACE_SETTINGS_UPDATED, &id, &row);
    let row = overlay_default_entity(&caller.db, row)
        .await
        .map_err(|error| TeamError::internal("Failed to update workspace settings", error))?;
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

    let master = orm(&caller.master(state));
    let workspace: Option<(String, String)> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .column(workspaces::Column::Name)
        .filter(workspaces::Column::ClerkOrgId.eq(&org))
        .into_tuple()
        .one(&master)
        .await
        .map_err(|e| failed(&e))?;
    let Some((id, previous)) = workspace else {
        return Err(TeamError::api(ApiError::not_found("Workspace", None)));
    };

    if previous != name {
        let set_name = |value: String| {
            workspaces::Entity::update_many()
                .col_expr(workspaces::Column::Name, Expr::value(value))
                .col_expr(workspaces::Column::UpdatedAt, Expr::value(utc_now()))
                .filter(workspaces::Column::Id.eq(&id))
        };
        set_name(name.clone())
            .exec(&master)
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
                .exec(&master)
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

    invalidate_workspace_cache(state, caller, &org).await;
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
    "test",
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
    "weldboard",
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
    "weldforms",
    "weldhost",
    "weldhr",
    "weldknow",
    "weldmail",
    "weldmeet",
    "weldmerge",
    "weldpanel",
    "weldpass",
    "weldreach",
    "weldsheets",
    "weldsign",
    "weldsocial",
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
    step_up: StepUpGuard,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_change_slug(&state, &caller, step_up, &headers, &body).await)
}

/// Point the help-center subdomain rows at `to` where they still say `from`.
async fn move_helpcenter(
    master: &DatabaseConnection,
    tenant: &PgPool,
    workspace_id: &str,
    from: &str,
    to: &str,
) -> Result<(), DbErr> {
    use helpcenter_domain_registry as registry;
    registry::Entity::update_many()
        .col_expr(registry::Column::Domain, Expr::value(to))
        .col_expr(registry::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(registry::Column::WorkspaceId.eq(workspace_id))
        .filter(registry::Column::Domain.eq(from))
        .exec(master)
        .await?;
    helpcenter_settings::Entity::update_many()
        .col_expr(
            helpcenter_settings::Column::DefaultSubdomain,
            Expr::value(to),
        )
        .col_expr(
            helpcenter_settings::Column::UpdatedAt,
            Expr::value(utc_now()),
        )
        .filter(helpcenter_settings::Column::DefaultSubdomain.eq(from))
        .exec(&orm(tenant))
        .await?;
    Ok(())
}

async fn set_slug(
    master: &DatabaseConnection,
    workspace_id: &str,
    slug: &str,
) -> Result<(), DbErr> {
    workspaces::Entity::update_many()
        .col_expr(workspaces::Column::Slug, Expr::value(slug))
        .col_expr(workspaces::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(workspaces::Column::Id.eq(workspace_id))
        .exec(master)
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
    step_up: StepUpGuard,
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
    // Every link to the workspace changes: a fresh confirmation (ADR SEC-022).
    step_up.require(StepUp::Recent)?;
    let failed = |error: &dyn std::fmt::Display| {
        TeamError::internal("Failed to update workspace slug", error)
    };

    let master = orm(&caller.master(state));
    let workspace: Option<(String, String)> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .column(workspaces::Column::Slug)
        .filter(workspaces::Column::ClerkOrgId.eq(&org))
        .into_tuple()
        .one(&master)
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
    let taken: Option<String> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .filter(workspaces::Column::Slug.eq(&slug))
        .into_tuple()
        .one(&master)
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

    invalidate_workspace_cache(state, caller, &org).await;
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
    let failed =
        |error: DbErr| TeamError::internal("Failed to compute workspace deletion status", error);
    let workspace: Option<(String, String, String, Option<String>)> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .column(workspaces::Column::Name)
        .column(workspaces::Column::Slug)
        .column(workspaces::Column::StripeSubscriptionId)
        .filter(workspaces::Column::ClerkOrgId.eq(&org))
        .into_tuple()
        .one(&orm(&caller.master(state)))
        .await
        .map_err(failed)?;
    let Some((id, name, slug, subscription)) = workspace else {
        return Err(TeamError::api(ApiError::not_found("Workspace", None)));
    };
    let member_count: u64 = members::Entity::find()
        .filter(members::Column::Status.eq("ACTIVE"))
        .filter(members::Column::DeletedAt.is_null())
        .count(&orm(&caller.db))
        .await
        .map_err(failed)?;
    Ok(Data(json!({
        "workspaceId": id,
        "name": name,
        "slug": slug,
        "memberCount": member_count,
        "hasActiveSubscription": subscription.is_some_and(|s| !s.is_empty()),
    }))
    .into_response())
}

async fn delete_workspace(
    State(state): State<CoreTeamState>,
    caller: Caller,
    step_up: StepUpGuard,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_delete(&state, &caller, step_up, &headers, &body).await)
}

async fn run_delete(
    state: &CoreTeamState,
    caller: &Caller,
    step_up: StepUpGuard,
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
    let failed = |error: DbErr| TeamError::internal("Failed to delete workspace", error);
    let master = orm(&caller.master(state));
    let workspace: Option<(String, String, Option<String>)> = workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::Id)
        .column(workspaces::Column::Slug)
        .column(workspaces::Column::StripeSubscriptionId)
        .filter(workspaces::Column::ClerkOrgId.eq(&org))
        .into_tuple()
        .one(&master)
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
    // Irreversible: a fresh confirmation (ADR SEC-022).
    step_up.require(StepUp::Recent)?;

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

    let stamp = utc_now();
    workspaces::Entity::update_many()
        .col_expr(workspaces::Column::IsActive, Expr::value(false))
        .col_expr(
            workspaces::Column::DeletedAt,
            Func::coalesce([Expr::col(workspaces::Column::DeletedAt), Expr::value(stamp)]).into(),
        )
        .col_expr(workspaces::Column::UpdatedAt, Expr::value(stamp))
        .filter(workspaces::Column::Id.eq(&id))
        .exec(&master)
        .await
        .map_err(failed)?;
    user_workspaces::Entity::delete_many()
        .filter(user_workspaces::Column::WorkspaceId.eq(&id))
        .exec(&master)
        .await
        .map_err(failed)?;

    invalidate_workspace_cache(state, caller, &org).await;
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
    fn slugs_refuse_reserved_names() {
        for slug in ["test", "settings", "weldforms"] {
            assert!(read_slug(&json!({ "slug": slug })).is_err(), "{slug}");
        }
        assert_eq!(
            read_slug(&json!({ "slug": "testing" })).expect("valid"),
            "testing"
        );
    }

    #[test]
    fn reserved_slugs_match_the_typescript_list() {
        let source = include_str!(
            "../../../../../packages/clients/app-api-client/src/schemas/workspace-slug.ts"
        );
        let (_, after_name) = source
            .split_once("RESERVED_WORKSPACE_SLUGS: readonly string[] = [")
            .expect("RESERVED_WORKSPACE_SLUGS in workspace-slug.ts");
        let (list, _) = after_name
            .split_once("];")
            .expect("the list's closing bracket");
        let mut typescript: Vec<&str> = list
            .lines()
            .map(|line| line.split("//").next().unwrap_or_default().trim())
            .filter(|entry| !entry.is_empty())
            .map(|entry| entry.trim_end_matches(',').trim_matches('\''))
            .collect();
        let mut rust: Vec<&str> = RESERVED_SLUGS.to_vec();
        typescript.sort_unstable();
        rust.sort_unstable();
        assert_eq!(rust, typescript);
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
