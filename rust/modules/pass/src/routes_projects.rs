//! The secret-vault routes (`routes/weldpass/index.ts`): projects,
//! environments, secrets, provider credentials, sync targets, runs and the
//! audit trail. Paths, bodies, statuses and messages are the worker's.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_kit::{ApiError, List, NoContent, Pagination};

use crate::audit::{AuditEntry, record_audit};
use crate::dotenv::{parse_dotenv, render_dotenv};
use crate::envelope::Key;
use crate::js::{clamped_limit, parse_js_date};
use crate::projects::{self, Environment, Project};
use crate::providers::{list_providers, redeploy_notice};
use crate::schemas::slugify;
use crate::secrets::{self, keys_of, list_secret_keys};
use crate::sync::{
    NewTarget, TargetPatch, create_target as insert_target, delete_target as remove_target,
    list_runs as select_runs, list_targets as select_targets, push_auto_targets, push_to_target,
    require_target, update_target as patch_target,
};
use crate::{
    Caller, PassError, PassResult, PassState, answer, created, credentials, dated, merge, ok,
    ok_or_created, param, validate,
};

type Params = Path<HashMap<String, String>>;

/// A query parameter as `c.req.query(name)` reads it: the first value,
/// form-decoded.
fn query(raw: Option<&str>, name: &str) -> Option<String> {
    form_urlencoded_pairs(raw.unwrap_or_default())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
}

fn form_urlencoded_pairs(raw: &str) -> impl Iterator<Item = (String, String)> + '_ {
    url::form_urlencoded::parse(raw.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned()))
}

/// `vaultFor(c)`: the project and its KEK.
async fn vault_for(
    caller: &Caller,
    state: &PassState,
    params: &HashMap<String, String>,
) -> PassResult<(Project, Key)> {
    projects::open_vault(
        &caller.db,
        caller.org(),
        &caller.keyring(state),
        param(params, "projectId"),
    )
    .await
}

/// `environmentFor(c)`: as [`vault_for`], plus the environment in it.
async fn environment_for(
    caller: &Caller,
    state: &PassState,
    params: &HashMap<String, String>,
) -> PassResult<(Project, Key, Environment)> {
    let (project, kek) = vault_for(caller, state, params).await?;
    let environment =
        projects::require_environment(&caller.db, &project.id, param(params, "environmentId"))
            .await?;
    Ok((project, kek, environment))
}

/// `{ ...project, environments: [{ ...environment, secretCount }] }`.
async fn project_with_environments(caller: &Caller, project: &Project) -> PassResult<Value> {
    let environments = projects::list_environments(&caller.db, &project.id).await?;
    let ids: Vec<String> = environments.iter().map(|e| e.id.clone()).collect();
    let keys = list_secret_keys(&caller.db, &ids).await?;
    let environments: Vec<Value> = environments
        .into_iter()
        .map(|environment| {
            let count = keys_of(&keys, &environment.id).len();
            merge(environment.json, json!({ "secretCount": count }))
        })
        .collect();
    Ok(merge(
        project.json.clone(),
        json!({ "environments": environments }),
    ))
}

// ── Providers ──────────────────────────────────────────────────────────────

pub(crate) async fn providers() -> Response {
    ok(list_providers())
}

// ── Projects ───────────────────────────────────────────────────────────────

pub(crate) async fn list_projects(caller: Caller) -> Response {
    answer(
        async {
            let projects = projects::list_projects(&caller.db, caller.org()).await?;
            let mut out = Vec::with_capacity(projects.len());
            for project in &projects {
                out.push(project_with_environments(&caller, project).await?);
            }
            Ok(ok(Value::Array(out)))
        }
        .await,
    )
}

pub(crate) async fn create_project(
    caller: Caller,
    State(state): State<PassState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, slug, description) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text(fields, "name", Presence::Required, Some(1), Some(100)),
                    issues.text(fields, "slug", Presence::Optional, Some(1), Some(60)),
                    issues.text(fields, "description", Presence::Nullish, None, Some(2000)),
                )
            })?;
            let name = name.into_option().unwrap_or_default();
            let slug_input = slug.into_option();
            let slug = slugify(slug_input.as_deref().unwrap_or(&name));
            if projects::find_project_by_slug(&caller.db, caller.org(), &slug)
                .await?
                .is_some()
            {
                return Err(ApiError::conflict(format!(
                    "A project with the slug \"{slug}\" already exists."
                ))
                .into());
            }
            let (project, environments) = projects::create_project(
                &caller.db,
                caller.org(),
                &caller.keyring(&state),
                &name,
                slug_input.as_deref(),
                description.as_set().map(String::as_str),
                &caller.user_id,
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "project.created")
                    .target(&project.slug),
            )
            .await;
            let environments: Vec<Value> = environments.into_iter().map(|e| e.json).collect();
            Ok(created(merge(
                project.json,
                json!({ "environments": environments }),
            )))
        }
        .await,
    )
}

pub(crate) async fn get_project(caller: Caller, Path(params): Params) -> Response {
    answer(
        async {
            let project =
                projects::require_project(&caller.db, caller.org(), param(&params, "projectId"))
                    .await?;
            Ok(ok(project_with_environments(&caller, &project).await?))
        }
        .await,
    )
}

pub(crate) async fn update_project(
    caller: Caller,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, description) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text(fields, "name", Presence::Optional, Some(1), Some(100)),
                    issues.text(fields, "description", Presence::Nullish, None, Some(2000)),
                )
            })?;
            let project_id = param(&params, "projectId");
            let description = match &description {
                Field::Absent => None,
                Field::Null => Some(None),
                Field::Set(text) => Some(Some(text.as_str())),
            };
            let project = projects::update_project(
                &caller.db,
                caller.org(),
                project_id,
                name.as_set().map(String::as_str),
                description,
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(project_id, &caller.user_id, "project.updated")
                    .target(&project.slug),
            )
            .await;
            Ok(ok(project.json))
        }
        .await,
    )
}

pub(crate) async fn delete_project(caller: Caller, Path(params): Params) -> Response {
    answer(
        async {
            let project_id = param(&params, "projectId");
            let project = projects::require_project(&caller.db, caller.org(), project_id).await?;
            projects::delete_project(&caller.db, caller.org(), project_id).await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(project_id, &caller.user_id, "project.deleted")
                    .target(&project.slug),
            )
            .await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── Environments ───────────────────────────────────────────────────────────

pub(crate) async fn list_environments(caller: Caller, Path(params): Params) -> Response {
    answer(
        async {
            let project =
                projects::require_project(&caller.db, caller.org(), param(&params, "projectId"))
                    .await?;
            let environments = projects::list_environments(&caller.db, &project.id).await?;
            Ok(ok(Value::Array(
                environments.into_iter().map(|e| e.json).collect(),
            )))
        }
        .await,
    )
}

pub(crate) async fn create_environment(
    caller: Caller,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, slug, is_production) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text(fields, "name", Presence::Required, Some(1), Some(60)),
                    issues.text(fields, "slug", Presence::Optional, Some(1), Some(40)),
                    issues.boolean(fields, "isProduction", Presence::Optional),
                )
            })?;
            let project =
                projects::require_project(&caller.db, caller.org(), param(&params, "projectId"))
                    .await?;
            let name = name.into_option().unwrap_or_default();
            let slug_input = slug.into_option();
            let slug = slugify(slug_input.as_deref().unwrap_or(&name));
            let existing = projects::list_environments(&caller.db, &project.id).await?;
            if existing.iter().any(|environment| environment.slug == slug) {
                return Err(ApiError::conflict(format!(
                    "This project already has an environment named \"{slug}\"."
                ))
                .into());
            }
            let environment = projects::create_environment(
                &caller.db,
                &project.id,
                &name,
                slug_input.as_deref(),
                is_production.into_option(),
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "environment.created")
                    .environment(&environment.id)
                    .target(&environment.slug),
            )
            .await;
            Ok(created(environment.json))
        }
        .await,
    )
}

pub(crate) async fn update_environment(
    caller: Caller,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, is_production, sort_order) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text(fields, "name", Presence::Optional, Some(1), Some(60)),
                    issues.boolean(fields, "isProduction", Presence::Optional),
                    issues.integer(fields, "sortOrder", Presence::Optional, Some(0)),
                )
            })?;
            let project =
                projects::require_project(&caller.db, caller.org(), param(&params, "projectId"))
                    .await?;
            let environment = projects::update_environment(
                &caller.db,
                &project.id,
                param(&params, "environmentId"),
                name.as_set().map(String::as_str),
                is_production.into_option(),
                sort_order.into_option(),
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "environment.updated")
                    .environment(&environment.id)
                    .target(&environment.slug),
            )
            .await;
            Ok(ok(environment.json))
        }
        .await,
    )
}

pub(crate) async fn delete_environment(caller: Caller, Path(params): Params) -> Response {
    answer(
        async {
            let project =
                projects::require_project(&caller.db, caller.org(), param(&params, "projectId"))
                    .await?;
            let environment_id = param(&params, "environmentId");
            projects::delete_environment(&caller.db, &project.id, environment_id).await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "environment.deleted")
                    .environment(environment_id),
            )
            .await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── Secrets ────────────────────────────────────────────────────────────────

/// `runAutoSync`: auto-sync targets after a write; a failure is reported,
/// never thrown (the secret is saved already).
async fn run_auto_sync(
    caller: &Caller,
    state: &PassState,
    project_id: &str,
    environment_id: &str,
    kek: &Key,
) -> Value {
    let http = caller.http(state);
    match push_auto_targets(
        &caller.db,
        kek,
        http.as_ref(),
        project_id,
        environment_id,
        &caller.user_id,
    )
    .await
    {
        Ok(outcomes) => Value::Array(
            outcomes
                .iter()
                .map(crate::sync::PushOutcome::summary)
                .collect(),
        ),
        Err(error) => {
            tracing::error!(?error, "[weldpass] auto-sync failed");
            json!([])
        }
    }
}

pub(crate) async fn list_secrets(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
) -> Response {
    answer(
        async {
            let (_, _, environment) = environment_for(&caller, &state, &params).await?;
            let secrets = secrets::list_secrets(&caller.db, &environment.id).await?;
            Ok(ok(Value::Array(
                secrets.into_iter().map(|s| s.json).collect(),
            )))
        }
        .await,
    )
}

pub(crate) async fn upsert_secret(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (key, value, note) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text(fields, "key", Presence::Required, Some(1), Some(255)),
                    issues.text(fields, "value", Presence::Required, None, Some(64 * 1024)),
                    issues.text(fields, "note", Presence::Nullish, None, Some(1000)),
                )
            })?;
            let (project, kek, environment) = environment_for(&caller, &state, &params).await?;
            let key = key.into_option().unwrap_or_default();
            let result = secrets::upsert_secret(
                &caller.db,
                &kek,
                &project.id,
                &environment.id,
                &key,
                &value.into_option().unwrap_or_default(),
                Some(note.as_set().map(String::as_str)),
                &caller.user_id,
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(
                    &project.id,
                    &caller.user_id,
                    if result.created {
                        "secret.created"
                    } else {
                        "secret.updated"
                    },
                )
                .environment(&environment.id)
                .secret(&result.secret.id)
                .target(&key)
                .metadata(json!({ "changed": result.changed })),
            )
            .await;
            let auto_sync = if result.changed {
                run_auto_sync(&caller, &state, &project.id, &environment.id, &kek).await
            } else {
                json!([])
            };
            Ok(ok_or_created(
                json!({ "secret": result.secret.json, "created": result.created, "autoSync": auto_sync }),
                result.created,
            ))
        }
        .await,
    )
}

pub(crate) async fn patch_secret(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (value, note) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text(fields, "value", Presence::Optional, None, Some(64 * 1024)),
                    issues.text(fields, "note", Presence::Nullish, None, Some(1000)),
                )
            })?;
            let (project, kek, environment) = environment_for(&caller, &state, &params).await?;
            if value.is_absent() && note.is_absent() {
                return Err(ApiError::bad_request("Provide a value, a note, or both.").into());
            }
            let existing =
                secrets::require_secret(&caller.db, &environment.id, param(&params, "secretId"))
                    .await?;
            let value_changed = !value.is_absent();
            let value = match value.into_option() {
                Some(value) => value,
                None => {
                    secrets::reveal_secret(&caller.db, &kek, &environment.id, &existing.id)
                        .await?
                        .1
                }
            };
            let note = match &note {
                Field::Absent => None,
                Field::Null => Some(None),
                Field::Set(text) => Some(Some(text.as_str())),
            };
            let result = secrets::upsert_secret(
                &caller.db,
                &kek,
                &project.id,
                &environment.id,
                &existing.key,
                &value,
                note,
                &caller.user_id,
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "secret.updated")
                    .environment(&environment.id)
                    .secret(&existing.id)
                    .target(&existing.key)
                    .metadata(json!({ "changed": result.changed, "valueChanged": value_changed })),
            )
            .await;
            let auto_sync = if result.changed {
                run_auto_sync(&caller, &state, &project.id, &environment.id, &kek).await
            } else {
                json!([])
            };
            Ok(ok(
                json!({ "secret": result.secret.json, "autoSync": auto_sync }),
            ))
        }
        .await,
    )
}

pub(crate) async fn reveal_secret(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
) -> Response {
    answer(
        async {
            let (project, kek, environment) = environment_for(&caller, &state, &params).await?;
            let (secret, value) = secrets::reveal_secret(
                &caller.db,
                &kek,
                &environment.id,
                param(&params, "secretId"),
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "secret.revealed")
                    .environment(&environment.id)
                    .secret(&secret.id)
                    .target(&secret.key),
            )
            .await;
            Ok(ok(merge(secret.json, json!({ "value": value }))))
        }
        .await,
    )
}

pub(crate) async fn list_versions(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
) -> Response {
    answer(
        async {
            let (_, _, environment) = environment_for(&caller, &state, &params).await?;
            let secret =
                secrets::require_secret(&caller.db, &environment.id, param(&params, "secretId"))
                    .await?;
            Ok(ok(Value::Array(
                secrets::list_versions(&caller.db, &secret.id).await?,
            )))
        }
        .await,
    )
}

pub(crate) async fn restore_secret(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let version = validate(&headers, &body, |issues, fields| {
                issues.integer(fields, "version", Presence::Required, Some(1))
            })?
            .into_option()
            .unwrap_or_default();
            let (project, kek, environment) = environment_for(&caller, &state, &params).await?;
            let secret = secrets::restore_version(
                &caller.db,
                &environment.id,
                param(&params, "secretId"),
                version,
                &caller.user_id,
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "secret.restored")
                    .environment(&environment.id)
                    .secret(&secret.id)
                    .target(&secret.key)
                    .metadata(json!({ "restoredFrom": version })),
            )
            .await;
            let auto_sync =
                run_auto_sync(&caller, &state, &project.id, &environment.id, &kek).await;
            Ok(ok(json!({ "secret": secret.json, "autoSync": auto_sync })))
        }
        .await,
    )
}

pub(crate) async fn delete_secret(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
) -> Response {
    answer(
        async {
            let (project, kek, environment) = environment_for(&caller, &state, &params).await?;
            let secret = secrets::delete_secret(
                &caller.db,
                &environment.id,
                param(&params, "secretId"),
                &caller.user_id,
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "secret.deleted")
                    .environment(&environment.id)
                    .secret(&secret.id)
                    .target(&secret.key),
            )
            .await;
            // A deleted key leaves a target only if it prunes; the push
            // still runs so the remaining values stay in step.
            run_auto_sync(&caller, &state, &project.id, &environment.id, &kek).await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

pub(crate) async fn import_secrets(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (content, replace) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text(
                        fields,
                        "content",
                        Presence::Required,
                        None,
                        Some(1024 * 1024),
                    ),
                    issues.boolean(fields, "replace", Presence::Optional),
                )
            })?;
            let (project, kek, environment) = environment_for(&caller, &state, &params).await?;
            let parsed = parse_dotenv(&content.into_option().unwrap_or_default());
            let skipped: Vec<Value> = parsed
                .skipped
                .iter()
                .map(crate::dotenv::Skipped::to_json)
                .collect();
            if parsed.values.is_empty() {
                return Err(ApiError::bad_request("No variables found in that file.")
                    .with_details(json!({ "skipped": skipped }))
                    .into());
            }
            let (created_keys, updated, unchanged) = secrets::import_secrets(
                &caller.db,
                &kek,
                &project.id,
                &environment.id,
                &parsed.values,
                &caller.user_id,
            )
            .await?;
            let mut removed = Vec::new();
            if replace.into_option() == Some(true) {
                for existing in secrets::list_secrets(&caller.db, &environment.id).await? {
                    if !parsed.values.has(&existing.key) {
                        secrets::delete_secret(
                            &caller.db,
                            &environment.id,
                            &existing.id,
                            &caller.user_id,
                        )
                        .await?;
                        removed.push(existing.key);
                    }
                }
            }
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "secrets.imported")
                    .environment(&environment.id)
                    .metadata(json!({
                        "created": created_keys.len(),
                        "updated": updated.len(),
                        "unchanged": unchanged.len(),
                        "removed": removed.len(),
                        "skippedLines": skipped.len(),
                    })),
            )
            .await;
            let auto_sync =
                run_auto_sync(&caller, &state, &project.id, &environment.id, &kek).await;
            Ok(ok(json!({
                "created": created_keys,
                "updated": updated,
                "unchanged": unchanged,
                "removed": removed,
                "skipped": skipped,
                "autoSync": auto_sync,
            })))
        }
        .await,
    )
}

pub(crate) async fn export_secrets(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    RawQuery(raw): RawQuery,
) -> Response {
    answer(
        async {
            let (project, kek, environment) = environment_for(&caller, &state, &params).await?;
            let values =
                secrets::read_environment_values(&caller.db, &kek, &environment.id).await?;
            let format = query(raw.as_deref(), "format");
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "secret.exported")
                    .environment(&environment.id)
                    .metadata(json!({
                        "keyCount": values.len(),
                        "format": format.as_deref().unwrap_or("json"),
                    })),
            )
            .await;
            if format.as_deref() == Some("dotenv") {
                let mut response = (StatusCode::OK, render_dotenv(&values)).into_response();
                let headers = response.headers_mut();
                headers.insert(
                    http::header::CONTENT_TYPE,
                    HeaderValue::from_static("text/plain; charset=utf-8"),
                );
                if let Ok(value) = HeaderValue::from_str(&format!(
                    "attachment; filename=\"{}.{}.env\"",
                    project.slug, environment.slug
                )) {
                    headers.insert(http::header::CONTENT_DISPOSITION, value);
                }
                return Ok(response);
            }
            Ok(ok(values.to_json()))
        }
        .await,
    )
}

// ── Provider credentials ───────────────────────────────────────────────────

/// `credentialMetadataSchema`, optional: the parsed object (unknown keys
/// dropped) or absent.
fn read_metadata(issues: &mut Issues, fields: &Map<String, Value>) -> Option<Value> {
    issues
        .nested(
            fields,
            "metadata",
            Presence::Optional,
            |issues, metadata| {
                let mut out = Map::new();
                for key in ["accountId", "teamId"] {
                    if let Field::Set(text) =
                        issues.text(metadata, key, Presence::Optional, None, Some(100))
                    {
                        out.insert(key.to_owned(), Value::String(text));
                    }
                }
                Value::Object(out)
            },
        )
        .into_option()
}

pub(crate) async fn list_credentials(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
) -> Response {
    answer(
        async {
            let (project, _) = vault_for(&caller, &state, &params).await?;
            let rows = credentials::list_credentials(&caller.db, &project.id).await?;
            Ok(ok(Value::Array(rows.into_iter().map(|c| c.json).collect())))
        }
        .await,
    )
}

const PROVIDERS: [&str; 3] = ["cloudflare_workers", "cloudflare_pages", "vercel"];

pub(crate) async fn create_credential(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (provider, name, token, metadata) = validate(&headers, &body, |issues, fields| {
                (
                    issues.choice(fields, "provider", Presence::Required, &PROVIDERS),
                    issues.text(fields, "name", Presence::Required, Some(1), Some(100)),
                    issues.text(fields, "token", Presence::Required, Some(1), Some(4096)),
                    read_metadata(issues, fields),
                )
            })?;
            let (project, kek) = vault_for(&caller, &state, &params).await?;
            let credential = credentials::create_credential(
                &caller.db,
                &kek,
                &project.id,
                &provider.into_option().unwrap_or_default(),
                &name.into_option().unwrap_or_default(),
                &token.into_option().unwrap_or_default(),
                metadata.as_ref(),
                &caller.user_id,
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "credential.created")
                    .target(&credential.name)
                    .metadata(json!({ "provider": credential.provider })),
            )
            .await;
            Ok(created(credential.json))
        }
        .await,
    )
}

pub(crate) async fn update_credential(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, token, metadata) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text(fields, "name", Presence::Optional, Some(1), Some(100)),
                    issues.text(fields, "token", Presence::Optional, Some(1), Some(4096)),
                    read_metadata(issues, fields),
                )
            })?;
            let (project, kek) = vault_for(&caller, &state, &params).await?;
            let credential = credentials::update_credential(
                &caller.db,
                &kek,
                &project.id,
                param(&params, "credentialId"),
                name.as_set().map(String::as_str),
                token.as_set().map(String::as_str),
                metadata.as_ref(),
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "credential.updated")
                    .target(&credential.name)
                    .metadata(json!({ "tokenReplaced": !token.is_absent() })),
            )
            .await;
            Ok(ok(credential.json))
        }
        .await,
    )
}

/// `syncTargetConfigSchema` at `key`: the parsed config (unknown keys
/// dropped, `teamId` only when given).
pub(crate) fn read_config(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Field<Value> {
    issues.nested(fields, key, presence, |issues, config| {
        let provider = match config.get("provider") {
            Some(Value::String(provider)) if PROVIDERS.contains(&provider.as_str()) => {
                provider.clone()
            }
            _ => {
                issues.invalid_discriminator("provider", &PROVIDERS);
                return Value::Null;
            }
        };
        let mut out = Map::new();
        out.insert("provider".to_owned(), Value::String(provider.clone()));
        let mut text = |issues: &mut Issues, name: &str, presence: Presence| {
            if let Field::Set(value) = issues.text(config, name, presence, Some(1), Some(100)) {
                out.insert(name.to_owned(), Value::String(value));
            }
        };
        match provider.as_str() {
            "cloudflare_workers" => {
                text(issues, "accountId", Presence::Required);
                text(issues, "scriptName", Presence::Required);
            }
            "cloudflare_pages" => {
                text(issues, "accountId", Presence::Required);
                text(issues, "projectName", Presence::Required);
                if let Field::Set(environment) = issues.choice(
                    config,
                    "environment",
                    Presence::Required,
                    &["production", "preview"],
                ) {
                    out.insert("environment".to_owned(), Value::String(environment));
                }
            }
            _ => {
                text(issues, "projectId", Presence::Required);
                text(issues, "teamId", Presence::Optional);
                if let Field::Set(targets) = issues.list(
                    config,
                    "targets",
                    Presence::Required,
                    Some(1),
                    Some(3),
                    |issues, item| {
                        issues.item_choice(item, &["production", "preview", "development"])
                    },
                ) {
                    out.insert("targets".to_owned(), json!(targets));
                }
            }
        }
        Value::Object(out)
    })
}

pub(crate) async fn verify_credential(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let config = validate(&headers, &body, |issues, fields| {
                read_config(issues, fields, "config", Presence::Required)
            })?
            .into_option()
            .unwrap_or_default();
            let (project, kek) = vault_for(&caller, &state, &params).await?;
            let http = caller.http(&state);
            let result = credentials::verify_credential(
                &caller.db,
                &kek,
                http.as_ref(),
                &project.id,
                param(&params, "credentialId"),
                &config,
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "credential.verified")
                    .metadata(json!({ "ok": result.is_ok() })),
            )
            .await;
            Ok(ok(result.to_json()))
        }
        .await,
    )
}

pub(crate) async fn delete_credential(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
) -> Response {
    answer(
        async {
            let (project, _) = vault_for(&caller, &state, &params).await?;
            let credential_id = param(&params, "credentialId");
            let credential =
                credentials::require_credential(&caller.db, &project.id, credential_id).await?;
            let detached =
                credentials::delete_credential(&caller.db, &project.id, credential_id).await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "credential.deleted")
                    .target(&credential.name)
                    .metadata(json!({ "detachedTargets": detached })),
            )
            .await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── Sync targets ───────────────────────────────────────────────────────────

pub(crate) async fn list_targets(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    RawQuery(raw): RawQuery,
) -> Response {
    answer(
        async {
            let (project, _) = vault_for(&caller, &state, &params).await?;
            let environment = query(raw.as_deref(), "environmentId").filter(|id| !id.is_empty());
            let targets = select_targets(&caller.db, &project.id, environment.as_deref()).await?;
            Ok(ok(Value::Array(
                targets
                    .iter()
                    .map(crate::sync::Target::with_notice)
                    .collect(),
            )))
        }
        .await,
    )
}

fn mismatch(credential_provider: &str, provider: &str) -> PassError {
    ApiError::bad_request(format!(
        "That credential is for {credential_provider}, but the target is configured for {provider}."
    ))
    .into()
}

pub(crate) async fn create_target(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (environment_id, credential_id, name, config, auto_sync, prune) =
                validate(&headers, &body, |issues, fields| {
                    (
                        issues.text(
                            fields,
                            "environmentId",
                            Presence::Required,
                            Some(1),
                            Some(30),
                        ),
                        issues.text(
                            fields,
                            "credentialId",
                            Presence::Required,
                            Some(1),
                            Some(30),
                        ),
                        issues.text(fields, "name", Presence::Required, Some(1), Some(100)),
                        read_config(issues, fields, "config", Presence::Required),
                        issues.boolean(fields, "autoSync", Presence::Optional),
                        issues.boolean(fields, "prune", Presence::Optional),
                    )
                })?;
            let (project, _) = vault_for(&caller, &state, &params).await?;
            let environment = projects::require_environment(
                &caller.db,
                &project.id,
                &environment_id.into_option().unwrap_or_default(),
            )
            .await?;
            let credential = credentials::require_credential(
                &caller.db,
                &project.id,
                &credential_id.into_option().unwrap_or_default(),
            )
            .await?;
            let config = config.into_option().unwrap_or_default();
            let provider = config["provider"].as_str().unwrap_or_default().to_owned();
            if credential.provider != provider {
                return Err(mismatch(&credential.provider, &provider));
            }
            let name = name.into_option().unwrap_or_default();
            let target = insert_target(
                &caller.db,
                NewTarget {
                    project_id: &project.id,
                    environment_id: &environment.id,
                    credential_id: &credential.id,
                    provider: &provider,
                    name: &name,
                    config: &config,
                    auto_sync: auto_sync.into_option(),
                    prune: prune.into_option(),
                    actor_id: &caller.user_id,
                },
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "sync_target.created")
                    .environment(&environment.id)
                    .target(&target.name)
                    .metadata(json!({
                        "provider": target.provider,
                        "autoSync": target.auto_sync,
                        "prune": target.prune,
                    })),
            )
            .await;
            Ok(created(target.with_notice()))
        }
        .await,
    )
}

pub(crate) async fn update_target(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, credential_id, config, auto_sync, prune) =
                validate(&headers, &body, |issues, fields| {
                    (
                        issues.text(fields, "name", Presence::Optional, Some(1), Some(100)),
                        issues.text(
                            fields,
                            "credentialId",
                            Presence::Optional,
                            Some(1),
                            Some(30),
                        ),
                        read_config(issues, fields, "config", Presence::Optional),
                        issues.boolean(fields, "autoSync", Presence::Optional),
                        issues.boolean(fields, "prune", Presence::Optional),
                    )
                })?;
            let (project, _) = vault_for(&caller, &state, &params).await?;
            let existing =
                require_target(&caller.db, &project.id, param(&params, "targetId")).await?;
            let config = config.into_option();
            let config_provider = config
                .as_ref()
                .and_then(|config| config["provider"].as_str())
                .map(str::to_owned);
            if let Some(credential_id) = credential_id.as_set().filter(|id| !id.is_empty()) {
                let credential =
                    credentials::require_credential(&caller.db, &project.id, credential_id).await?;
                let provider = config_provider
                    .clone()
                    .unwrap_or_else(|| existing.provider.clone());
                if credential.provider != provider {
                    return Err(mismatch(&credential.provider, &provider));
                }
            }
            if config_provider
                .as_ref()
                .is_some_and(|provider| *provider != existing.provider)
            {
                return Err(ApiError::bad_request(
                    "A target cannot change provider — create a new target instead.",
                )
                .into());
            }
            let target = patch_target(
                &caller.db,
                &project.id,
                &existing.id,
                TargetPatch {
                    name: name.as_set().map(String::as_str),
                    credential_id: credential_id.as_set().map(String::as_str),
                    config: config.as_ref(),
                    auto_sync: auto_sync.into_option(),
                    prune: prune.into_option(),
                },
            )
            .await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "sync_target.updated")
                    .environment(&target.environment_id)
                    .target(&target.name),
            )
            .await;
            Ok(ok(target.with_notice()))
        }
        .await,
    )
}

pub(crate) async fn delete_target(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
) -> Response {
    answer(
        async {
            let (project, _) = vault_for(&caller, &state, &params).await?;
            let target_id = param(&params, "targetId");
            let target = require_target(&caller.db, &project.id, target_id).await?;
            remove_target(&caller.db, &project.id, target_id).await?;
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(&project.id, &caller.user_id, "sync_target.deleted")
                    .environment(&target.environment_id)
                    .target(&target.name),
            )
            .await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

pub(crate) async fn preview_target(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
) -> Response {
    answer(
        async {
            let (project, _) = vault_for(&caller, &state, &params).await?;
            let target =
                require_target(&caller.db, &project.id, param(&params, "targetId")).await?;
            let keys =
                list_secret_keys(&caller.db, std::slice::from_ref(&target.environment_id)).await?;
            Ok(ok(json!({
                "targetId": target.id,
                "environmentId": target.environment_id,
                "keys": keys_of(&keys, &target.environment_id),
                "prune": target.prune,
                "redeployNotice": redeploy_notice(target.config()),
            })))
        }
        .await,
    )
}

pub(crate) async fn push_target(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
) -> Response {
    answer(
        async {
            let (project, kek) = vault_for(&caller, &state, &params).await?;
            let http = caller.http(&state);
            let outcome = push_to_target(
                &caller.db,
                &kek,
                http.as_ref(),
                &project.id,
                param(&params, "targetId"),
                "manual",
                &caller.user_id,
            )
            .await?;
            let failed = outcome.run["status"] == "failed";
            record_audit(
                &caller.db,
                &caller.audit,
                AuditEntry::new(
                    &project.id,
                    &caller.user_id,
                    if failed { "sync.failed" } else { "sync.pushed" },
                )
                .environment(&outcome.target.environment_id)
                .target(&outcome.target.name)
                .metadata(json!({
                    "provider": outcome.target.provider,
                    "pushed": outcome.run["pushed"],
                    "removed": outcome.run["removed"],
                    "failed": outcome.run["failed"],
                })),
            )
            .await;
            Ok(ok(
                json!({ "run": outcome.run, "target": outcome.target.with_notice() }),
            ))
        }
        .await,
    )
}

pub(crate) async fn list_runs(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    RawQuery(raw): RawQuery,
) -> Response {
    answer(
        async {
            let (project, _) = vault_for(&caller, &state, &params).await?;
            let limit = clamped_limit(query(raw.as_deref(), "limit").as_deref(), 25, 1, 100);
            let target = query(raw.as_deref(), "targetId").filter(|id| !id.is_empty());
            Ok(ok(Value::Array(
                select_runs(&caller.db, &project.id, target.as_deref(), limit).await?,
            )))
        }
        .await,
    )
}

// ── Audit trail ────────────────────────────────────────────────────────────

/// Needs `secrets:manage`: it shows who revealed which key and when.
pub(crate) async fn list_audit(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    RawQuery(raw): RawQuery,
) -> Response {
    answer(
        async {
            let (project, _) = vault_for(&caller, &state, &params).await?;
            let limit = clamped_limit(query(raw.as_deref(), "limit").as_deref(), 50, 1, 200);
            let before = query(raw.as_deref(), "cursor")
                .filter(|cursor| !cursor.is_empty())
                .and_then(|cursor| parse_js_date(&cursor));
            let rows: Vec<Value> = sqlx::query_scalar(
                "select jsonb_build_object('id', a.id, 'environmentId', a.environment_id, \
                 'secretId', a.secret_id, 'actorId', a.actor_id, 'action', a.action, \
                 'targetKey', a.target_key, 'metadata', a.metadata, 'ip', a.ip, 'createdAt', a.created_at) \
                 from weldpass_audit_events a where a.project_id = $1 \
                 and ($2::text is null or a.created_at < $2::timestamptz) \
                 order by a.created_at desc limit $3",
            )
            .bind(&project.id)
            .bind(before)
            .bind(limit + 1)
            .fetch_all(&caller.db)
            .await?;
            Ok(page(rows, limit))
        }
        .await,
    )
}

/// One page of a trail fetched with one row extra: `hasMore` without a
/// count, the last row's time as the cursor, the page size as the count.
pub(crate) fn page(rows: Vec<Value>, limit: i64) -> Response {
    let mut rows: Vec<Value> = rows
        .into_iter()
        .map(|row| dated(row, &["createdAt"]))
        .collect();
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let cursor = if has_more {
        rows.last()
            .and_then(|row| row["createdAt"].as_str())
            .map(str::to_owned)
    } else {
        None
    };
    let count = u64::try_from(rows.len()).unwrap_or(u64::MAX);
    List::new(rows, Pagination::new(count, has_more, cursor)).into_response()
}
