//! The password-manager routes (`routes/weldpass/passwords.ts`): vaults,
//! members, the trail, items, matching a page, import and health.
//!
//! `passwords:use` opens the door; the role on the vault decides the rest
//! (`password_vaults`). `passwords:manage` widens which shared vaults resolve
//! but never opens a personal one, and reading a shared vault's items still
//! takes joining it.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::permission_keys::PASSWORDS_MANAGE;
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{ApiError, NoContent};

use crate::audit::{VaultEvent, record_vault_event};
use crate::health::build_health_report;
use crate::import::parse_import;
use crate::js::{clamped_limit, parse_js_date};
use crate::password_items as items;
use crate::password_vaults::{
    self as vaults, VaultAccess, assert_vault_admin, assert_vault_role, open_password_vault,
    personal_vault_error, require_vault_access,
};
use crate::routes_projects::page;
use crate::schemas::{IMPORT_FORMATS, ITEM_TYPES, VAULT_ROLES, host_of, read_item};
use crate::{
    Caller, PassError, PassResult, PassState, answer, created, json_value, merge, ok,
    ok_or_created, param, validate,
};

type Params = Path<HashMap<String, String>>;

/// A query parameter as `c.req.query(name)` reads it.
fn query(raw: Option<&str>, name: &str) -> Option<String> {
    url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// `vaultFor(c)`: the `:vaultId` resolved for this caller.
async fn vault_for(caller: &Caller, params: &HashMap<String, String>) -> PassResult<(VaultAccess, bool)> {
    let can_manage_all = caller.can(PASSWORDS_MANAGE);
    let access = require_vault_access(
        &caller.db,
        caller.org(),
        &caller.user_id,
        param(params, "vaultId"),
        can_manage_all,
    )
    .await?;
    Ok((access, can_manage_all))
}

/// `readableVaultIds(c)`: membership only.
async fn readable_vault_ids(caller: &Caller) -> PassResult<Vec<String>> {
    let vaults = vaults::list_vaults(&caller.db, caller.org(), &caller.user_id, false).await?;
    Ok(vaults
        .iter()
        .filter_map(|vault| vault["id"].as_str().map(str::to_owned))
        .collect())
}

/// `itemInputSchema` as the body.
fn validate_item(headers: &HeaderMap, body: &Bytes) -> PassResult<crate::schemas::ItemDocument> {
    let value = json_value(headers, body)?;
    let mut issues = Issues::default();
    let document = read_item(&mut issues, &value);
    issues
        .finish()
        .map_err(|invalid| PassError::Response(Box::new(invalid.into_response())))?;
    document.ok_or_else(|| PassError::Internal("validated item without a document".to_owned()))
}

// ── Vaults ─────────────────────────────────────────────────────────────────

pub(crate) async fn list_vaults(caller: Caller, State(state): State<PassState>) -> Response {
    answer(
        async {
            vaults::ensure_personal_vault(
                &caller.db,
                caller.org(),
                &caller.keyring(&state),
                &caller.user_id,
            )
            .await?;
            let can_manage_all = caller.can(PASSWORDS_MANAGE);
            Ok(ok(Value::Array(
                vaults::list_vaults(&caller.db, caller.org(), &caller.user_id, can_manage_all).await?,
            )))
        }
        .await,
    )
}

pub(crate) async fn create_vault(
    caller: Caller,
    State(state): State<PassState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, description) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text_with(fields, "name", Presence::Required, Text::trimmed(Some(1), Some(100))),
                    issues.text_with(fields, "description", Presence::Nullish, Text::trimmed(None, Some(2000))),
                )
            })?;
            let vault = vaults::create_shared_vault(
                &caller.db,
                caller.org(),
                &caller.keyring(&state),
                &name.into_option().unwrap_or_default(),
                description.as_set().map(String::as_str),
                &caller.user_id,
            )
            .await?;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&vault.id, &caller.user_id, "vault.created").label(&vault.name),
            )
            .await;
            Ok(created(merge(
                vault.json,
                json!({ "role": "manager", "itemCount": 0, "memberCount": 1 }),
            )))
        }
        .await,
    )
}

pub(crate) async fn get_vault(caller: Caller, Path(params): Params) -> Response {
    answer(
        async {
            let (access, _) = vault_for(&caller, &params).await?;
            Ok(ok(access.json()))
        }
        .await,
    )
}

pub(crate) async fn update_vault(
    caller: Caller,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (name, description) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text_with(fields, "name", Presence::Optional, Text::trimmed(Some(1), Some(100))),
                    issues.text_with(fields, "description", Presence::Nullish, Text::trimmed(None, Some(2000))),
                )
            })?;
            let (access, can_manage_all) = vault_for(&caller, &params).await?;
            assert_vault_admin(&access, can_manage_all)?;
            let description = match &description {
                Field::Absent => None,
                Field::Null => Some(None),
                Field::Set(text) => Some(Some(text.as_str())),
            };
            let updated = vaults::update_vault(
                &caller.db,
                &access.vault.id,
                name.as_set().map(String::as_str),
                description,
            )
            .await?;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&access.vault.id, &caller.user_id, "vault.updated").label(&updated.name),
            )
            .await;
            let mut json = updated.json;
            json["role"] = access.role.map_or(Value::Null, Value::String);
            Ok(ok(json))
        }
        .await,
    )
}

pub(crate) async fn delete_vault(caller: Caller, Path(params): Params) -> Response {
    answer(
        async {
            let (access, can_manage_all) = vault_for(&caller, &params).await?;
            assert_vault_admin(&access, can_manage_all)?;
            vaults::delete_vault(&caller.db, &access.vault.id).await?;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&access.vault.id, &caller.user_id, "vault.deleted")
                    .label(&access.vault.name),
            )
            .await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── Members ────────────────────────────────────────────────────────────────

pub(crate) async fn teammates(caller: Caller) -> Response {
    answer(
        async { Ok(ok(Value::Array(vaults::list_teammates(&caller.db).await?))) }.await,
    )
}

pub(crate) async fn list_members(caller: Caller, Path(params): Params) -> Response {
    answer(
        async {
            let (access, _) = vault_for(&caller, &params).await?;
            if access.vault.is_personal() {
                return Ok(ok(json!([])));
            }
            Ok(ok(Value::Array(
                vaults::list_vault_members(&caller.db, &access.vault.id).await?,
            )))
        }
        .await,
    )
}

pub(crate) async fn add_member(
    caller: Caller,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (user, role) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text(fields, "userId", Presence::Required, Some(1), Some(255)),
                    issues.choice(fields, "role", Presence::Required, &VAULT_ROLES),
                )
            })?;
            let (access, can_manage_all) = vault_for(&caller, &params).await?;
            assert_vault_admin(&access, can_manage_all)?;
            let user = user.into_option().unwrap_or_default();
            let role = role.into_option().unwrap_or_default();
            let added =
                vaults::add_vault_member(&caller.db, &access.vault.id, &user, &role, &caller.user_id)
                    .await?;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(
                    &access.vault.id,
                    &caller.user_id,
                    if added { "member.added" } else { "member.role_changed" },
                )
                .label(&user)
                .metadata(json!({ "role": role })),
            )
            .await;
            Ok(ok_or_created(
                Value::Array(vaults::list_vault_members(&caller.db, &access.vault.id).await?),
                added,
            ))
        }
        .await,
    )
}

pub(crate) async fn set_member_role(
    caller: Caller,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let role = validate(&headers, &body, |issues, fields| {
                issues.choice(fields, "role", Presence::Required, &VAULT_ROLES)
            })?
            .into_option()
            .unwrap_or_default();
            let (access, can_manage_all) = vault_for(&caller, &params).await?;
            assert_vault_admin(&access, can_manage_all)?;
            let member = param(&params, "userId");
            let previous =
                vaults::set_vault_member_role(&caller.db, &access.vault.id, member, &role).await?;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&access.vault.id, &caller.user_id, "member.role_changed")
                    .label(member)
                    .metadata(json!({ "from": previous, "to": role })),
            )
            .await;
            Ok(ok(Value::Array(
                vaults::list_vault_members(&caller.db, &access.vault.id).await?,
            )))
        }
        .await,
    )
}

pub(crate) async fn remove_member(caller: Caller, Path(params): Params) -> Response {
    answer(
        async {
            let (access, can_manage_all) = vault_for(&caller, &params).await?;
            let member = param(&params, "userId");
            // Anyone may leave; removing somebody else takes a manager.
            if member != caller.user_id {
                assert_vault_admin(&access, can_manage_all)?;
            } else if access.vault.is_personal() {
                return Err(personal_vault_error());
            }
            vaults::remove_vault_member(&caller.db, &access.vault.id, member).await?;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&access.vault.id, &caller.user_id, "member.removed")
                    .label(member)
                    .metadata(json!({ "left": member == caller.user_id })),
            )
            .await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

/// A vault's trail: who revealed which login and when, so a manager's.
pub(crate) async fn activity(
    caller: Caller,
    Path(params): Params,
    RawQuery(raw): RawQuery,
) -> Response {
    answer(
        async {
            let (access, can_manage_all) = vault_for(&caller, &params).await?;
            if access.role.as_deref() != Some("manager") && !can_manage_all {
                return Err(PassError::Forbidden(
                    "This needs the manager role on the vault.".to_owned(),
                ));
            }
            let limit = clamped_limit(query(raw.as_deref(), "limit").as_deref(), 50, 1, 200);
            let before = query(raw.as_deref(), "cursor")
                .filter(|cursor| !cursor.is_empty())
                .and_then(|cursor| parse_js_date(&cursor));
            let rows: Vec<Value> = sqlx::query_scalar(
                "select jsonb_build_object('id', e.id, 'itemId', e.item_id, 'actorId', e.actor_id, \
                 'actorName', w.name, 'action', e.action, 'targetLabel', e.target_label, \
                 'metadata', e.metadata, 'createdAt', e.created_at) \
                 from weldpass_vault_events e left join workspace_members w on w.user_id = e.actor_id \
                 where e.vault_id = $1 and ($2::text is null or e.created_at < $2::timestamptz) \
                 order by e.created_at desc limit $3",
            )
            .bind(&access.vault.id)
            .bind(before)
            .bind(limit + 1)
            .fetch_all(&caller.db)
            .await?;
            Ok(page(rows, limit))
        }
        .await,
    )
}

// ── Items across vaults ────────────────────────────────────────────────────

pub(crate) async fn list_items(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    answer(
        async {
            let readable = readable_vault_ids(&caller).await?;
            let vault = query(raw.as_deref(), "vaultId").filter(|id| !id.is_empty());
            if let Some(vault) = &vault
                && !readable.contains(vault)
            {
                return Err(ApiError::not_found("vault", Some(vault)).into());
            }
            // `weldpassItemTypeSchema.safeParse(type)`: anything else is no filter.
            let kind = query(raw.as_deref(), "type").filter(|kind| ITEM_TYPES.contains(&kind.as_str()));
            let ids = match vault {
                Some(vault) => vec![vault],
                None => readable,
            };
            Ok(ok(Value::Array(
                items::list_items(&caller.db, &ids, kind.as_deref()).await?,
            )))
        }
        .await,
    )
}

/// Logins for the page at `?url=`: what the browser extension asks.
pub(crate) async fn match_items(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    answer(
        async {
            let Some(host) = host_of(query(raw.as_deref(), "url").as_deref()) else {
                return Ok(ok(json!([])));
            };
            let readable = readable_vault_ids(&caller).await?;
            Ok(ok(Value::Array(
                items::match_logins(&caller.db, &readable, &host).await?,
            )))
        }
        .await,
    )
}

/// Weak, reused and old passwords across the caller's vaults; verdicts only.
pub(crate) async fn password_health(caller: Caller, State(state): State<PassState>) -> Response {
    answer(
        async {
            let keyring = caller.keyring(&state);
            let mut keys = Vec::new();
            for vault in readable_vault_ids(&caller).await? {
                let kek = open_password_vault(&caller.db, &keyring, &vault).await?;
                keys.push((vault, kek));
            }
            let logins = items::open_logins(&caller.db, &keys).await?;
            Ok(ok(build_health_report(logins, OffsetDateTime::now_utc())))
        }
        .await,
    )
}

// ── Items in a vault ───────────────────────────────────────────────────────

pub(crate) async fn create_item(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let document = validate_item(&headers, &body)?;
            let (access, _) = vault_for(&caller, &params).await?;
            assert_vault_role(&access, "editor")?;
            let kek = open_password_vault(&caller.db, &caller.keyring(&state), &access.vault.id).await?;
            let item = items::create_items(
                &caller.db,
                &kek,
                &access.vault.id,
                std::slice::from_ref(&document),
                &caller.user_id,
            )
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| PassError::Internal("the item was not created".to_owned()))?;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&access.vault.id, &caller.user_id, "item.created")
                    .item(&item.id)
                    .label(&item.title)
                    .metadata(json!({ "type": item.kind })),
            )
            .await;
            Ok(created(item.json))
        }
        .await,
    )
}

pub(crate) async fn import_items(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (content, format) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text(fields, "content", Presence::Required, None, Some(5 * 1024 * 1024)),
                    issues.choice(fields, "format", Presence::Optional, &IMPORT_FORMATS),
                )
            })?;
            let (access, _) = vault_for(&caller, &params).await?;
            assert_vault_role(&access, "editor")?;
            let format = format.into_option().unwrap_or_else(|| "auto".to_owned());
            let parsed = parse_import(&content.into_option().unwrap_or_default(), &format)
                .map_err(|error| PassError::BadRequest(error.0.to_owned()))?;
            let skipped: Vec<Value> = parsed.skipped.iter().map(crate::import::ImportNote::to_json).collect();
            if parsed.documents.is_empty() {
                return Err(ApiError::bad_request("Nothing to import was found in that file.")
                    .with_details(json!({ "skipped": skipped }))
                    .into());
            }
            let kek = open_password_vault(&caller.db, &caller.keyring(&state), &access.vault.id).await?;
            let created_items = items::create_items(
                &caller.db,
                &kek,
                &access.vault.id,
                &parsed.documents,
                &caller.user_id,
            )
            .await?;
            let warnings: Vec<Value> = parsed.warnings.iter().map(crate::import::ImportNote::to_json).collect();
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&access.vault.id, &caller.user_id, "items.imported").metadata(json!({
                    "format": parsed.format,
                    "created": created_items.len(),
                    "skipped": skipped.len(),
                    "warnings": warnings.len(),
                })),
            )
            .await;
            Ok(ok(json!({
                "format": parsed.format,
                "created": created_items.len(),
                "skipped": skipped,
                "warnings": warnings,
            })))
        }
        .await,
    )
}

/// Decrypt one item. Any member may; every call is written to the trail.
pub(crate) async fn reveal_item(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
) -> Response {
    answer(
        async {
            let (access, _) = vault_for(&caller, &params).await?;
            assert_vault_role(&access, "viewer")?;
            let kek = open_password_vault(&caller.db, &caller.keyring(&state), &access.vault.id).await?;
            let (item, document) =
                items::reveal_item(&caller.db, &kek, &access.vault.id, param(&params, "itemId")).await?;
            // Tells a person reading a password from the extension filling
            // a form. Client-supplied, so informational only.
            let client = caller
                .client
                .as_deref()
                .map_or_else(|| "web".to_owned(), |client| crate::js::utf16_slice(client, 0, 40));
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&access.vault.id, &caller.user_id, "item.revealed")
                    .item(&item.id)
                    .label(&item.title)
                    .metadata(json!({ "client": client })),
            )
            .await;
            Ok(ok(merge(item.json, json!({ "fields": document.fields_json() }))))
        }
        .await,
    )
}

/// The current 2FA code; the seed stays in the vault.
pub(crate) async fn item_totp(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
) -> Response {
    answer(
        async {
            let (access, _) = vault_for(&caller, &params).await?;
            assert_vault_role(&access, "viewer")?;
            let kek = open_password_vault(&caller.db, &caller.keyring(&state), &access.vault.id).await?;
            let (item, code) =
                items::item_totp_code(&caller.db, &kek, &access.vault.id, param(&params, "itemId")).await?;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&access.vault.id, &caller.user_id, "item.totp_generated")
                    .item(&item.id)
                    .label(&item.title),
            )
            .await;
            Ok(ok(json!({
                "code": code.code,
                "period": code.period,
                "expiresAt": code.expires_at,
            })))
        }
        .await,
    )
}

pub(crate) async fn update_item(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let document = validate_item(&headers, &body)?;
            let (access, _) = vault_for(&caller, &params).await?;
            assert_vault_role(&access, "editor")?;
            let kek = open_password_vault(&caller.db, &caller.keyring(&state), &access.vault.id).await?;
            let result = items::update_item(
                &caller.db,
                &kek,
                &access.vault.id,
                param(&params, "itemId"),
                &document,
                &caller.user_id,
                "updated",
            )
            .await?;
            if result.changed {
                record_vault_event(
                    &caller.db,
                    &caller.audit,
                    VaultEvent::new(&access.vault.id, &caller.user_id, "item.updated")
                        .item(&result.item.id)
                        .label(&result.item.title)
                        .metadata(json!({ "passwordChanged": result.password_changed })),
                )
                .await;
            }
            Ok(ok(result.item.json))
        }
        .await,
    )
}

pub(crate) async fn delete_item(caller: Caller, Path(params): Params) -> Response {
    answer(
        async {
            let (access, _) = vault_for(&caller, &params).await?;
            assert_vault_role(&access, "editor")?;
            let item = items::delete_item(
                &caller.db,
                &access.vault.id,
                param(&params, "itemId"),
                &caller.user_id,
            )
            .await?;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&access.vault.id, &caller.user_id, "item.deleted")
                    .item(&item.id)
                    .label(&item.title),
            )
            .await;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

pub(crate) async fn item_versions(caller: Caller, Path(params): Params) -> Response {
    answer(
        async {
            let (access, _) = vault_for(&caller, &params).await?;
            assert_vault_role(&access, "viewer")?;
            let item = items::require_item(&caller.db, &access.vault.id, param(&params, "itemId")).await?;
            Ok(ok(Value::Array(
                items::list_item_versions(&caller.db, &item.id).await?,
            )))
        }
        .await,
    )
}

pub(crate) async fn restore_item(
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
            let (access, _) = vault_for(&caller, &params).await?;
            assert_vault_role(&access, "editor")?;
            let kek = open_password_vault(&caller.db, &caller.keyring(&state), &access.vault.id).await?;
            let result = items::restore_item_version(
                &caller.db,
                &kek,
                &access.vault.id,
                param(&params, "itemId"),
                version,
                &caller.user_id,
            )
            .await?;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&access.vault.id, &caller.user_id, "item.restored")
                    .item(&result.item.id)
                    .label(&result.item.title)
                    .metadata(json!({ "restoredFrom": version, "changed": result.changed })),
            )
            .await;
            Ok(ok(result.item.json))
        }
        .await,
    )
}

/// Move an item to another vault: editor on both ends, and both trails.
pub(crate) async fn move_item(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let target_id = validate(&headers, &body, |issues, fields| {
                issues.text(fields, "targetVaultId", Presence::Required, Some(1), Some(30))
            })?
            .into_option()
            .unwrap_or_default();
            let (access, _) = vault_for(&caller, &params).await?;
            assert_vault_role(&access, "editor")?;
            if target_id == access.vault.id {
                return Err(ApiError::bad_request("The item is already in that vault.").into());
            }
            // Without `passwords:manage`: moving in is writing, which takes
            // membership like any other write.
            let target =
                require_vault_access(&caller.db, caller.org(), &caller.user_id, &target_id, false)
                    .await?;
            assert_vault_role(&target, "editor")?;
            let keyring = caller.keyring(&state);
            let source_key = open_password_vault(&caller.db, &keyring, &access.vault.id).await?;
            let target_key = open_password_vault(&caller.db, &keyring, &target.vault.id).await?;
            let (source, moved) = items::move_item(
                &caller.db,
                &source_key,
                &target_key,
                &access.vault.id,
                &target.vault.id,
                param(&params, "itemId"),
                &caller.user_id,
            )
            .await?;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&access.vault.id, &caller.user_id, "item.moved_out")
                    .item(&source.id)
                    .label(&source.title)
                    .metadata(json!({ "toVaultId": target.vault.id })),
            )
            .await;
            record_vault_event(
                &caller.db,
                &caller.audit,
                VaultEvent::new(&target.vault.id, &caller.user_id, "item.moved_in")
                    .item(&moved.id)
                    .label(&moved.title)
                    .metadata(json!({ "fromVaultId": access.vault.id })),
            )
            .await;
            Ok(ok(moved.json))
        }
        .await,
    )
}

