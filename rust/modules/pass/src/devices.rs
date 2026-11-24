//! Registered devices and their offline copy (ADR PASS-010): the
//! `weldpass_devices` rows, the sync that sends a device every item changed
//! since its cursor (whole and decrypted), and the workspace setting that
//! allows offline copies at all.
//!
//! What leaves the server: every item of every vault the owner can read
//! (membership only, as `readableVaultIds`), except a shared vault's 2FA
//! seeds, whose codes still come from the server (PASS-007). A revoked
//! device, or one in a workspace that switched offline copies off, is told
//! to wipe its copy. Rows are never deleted: a revoked device stays listed.

use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{self, Expr, ExprTrait as _, Func};
use sea_orm::{
    ColumnTrait, EntityTrait, FromQueryResult, JoinType, QueryFilter, QueryOrder, QuerySelect,
    RelationDef, Select, Set, UpdateMany,
};
use serde::Serialize;
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use weldsuite_db::{PgPool, orm};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    weldpass_devices as devices, workspace_members, workspace_settings,
};

use crate::envelope::RootKeyring;
use crate::password_items::open_vault_changes;
use crate::password_vaults::{ensure_personal_vault, list_vaults, open_password_vault};
use crate::projects::workspace_of;
use crate::schemas::ItemDocument;
use crate::{PassResult, merge, now, row_json};

use devices::Column as D;
use workspace_settings::Column as S;

/// How far before the sync's start its cursor points: a write that commits
/// while the sync reads is sent again next time, never missed. Sending a few
/// items twice is harmless; the device replaces them by id.
const CURSOR_OVERLAP: Duration = Duration::seconds(60);

/// WeldPass's key in `workspace_settings.custom_settings`.
const SETTINGS_KEY: &str = "weldpass";

/// [`SETTINGS_KEY`] as a `jsonb_set` path.
const SETTINGS_PATH: &str = "{weldpass}";

/// A device as the routes return it (`WeldPassDevice`).
#[derive(Debug, Clone, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRow {
    id: String,
    user_id: String,
    name: String,
    platform: String,
    app_version: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamptz")]
    created_at: OffsetDateTime,
    #[serde(with = "weldsuite_schema::js::timestamptz::option")]
    last_sync_at: Option<OffsetDateTime>,
    #[serde(with = "weldsuite_schema::js::timestamptz::option")]
    revoked_at: Option<OffsetDateTime>,
    revoked_by: Option<String>,
}

impl DeviceRow {
    fn select() -> Select<devices::Entity> {
        devices::Entity::find().select_only().columns([
            D::Id,
            D::UserId,
            D::Name,
            D::Platform,
            D::AppVersion,
            D::CreatedAt,
            D::LastSyncAt,
            D::RevokedAt,
            D::RevokedBy,
        ])
    }
}

impl From<devices::Model> for DeviceRow {
    fn from(row: devices::Model) -> Self {
        Self {
            id: row.id,
            user_id: row.user_id,
            name: row.name,
            platform: row.platform,
            app_version: row.app_version,
            created_at: row.created_at,
            last_sync_at: row.last_sync_at,
            revoked_at: row.revoked_at,
            revoked_by: row.revoked_by,
        }
    }
}

/// A device and its owner's name and email (the workspace-wide list).
#[derive(Debug, FromQueryResult)]
struct DeviceWithOwner {
    #[sea_orm(nested)]
    device: DeviceRow,
    user_name: Option<String>,
    user_email: Option<String>,
}

/// A device the routes act on.
#[derive(Debug, Clone)]
pub(crate) struct Device {
    pub(crate) id: String,
    pub(crate) user_id: String,
    pub(crate) name: String,
    pub(crate) revoked: bool,
}

/// `leftJoin(workspaceMembers, eq(workspaceMembers.userId, devices.userId))`.
fn owner() -> RelationDef {
    devices::Entity::belongs_to(workspace_members::Entity)
        .from(D::UserId)
        .to(workspace_members::Column::UserId)
        .into()
}

/// A new device of `user_id`'s.
pub(crate) async fn register_device(
    db: &PgPool,
    workspace: Option<&str>,
    user_id: &str,
    name: &str,
    platform: &str,
    app_version: Option<&str>,
) -> PassResult<Value> {
    let row = devices::Entity::insert(devices::ActiveModel {
        id: Set(generate_id("wpd")),
        workspace_id: Set(workspace_of(workspace, "weldpass_devices")?),
        user_id: Set(user_id.to_owned()),
        name: Set(name.to_owned()),
        platform: Set(platform.to_owned()),
        app_version: Set(app_version.map(str::to_owned)),
        created_at: Set(now()),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok(row_json(&DeviceRow::from(row)))
}

/// A device of this workspace, whoever owns it; `None` when there is none.
pub(crate) async fn find_device(
    db: &PgPool,
    workspace: Option<&str>,
    device_id: &str,
) -> PassResult<Option<Device>> {
    let row = DeviceRow::select()
        .filter(D::Id.eq(device_id))
        .filter(D::WorkspaceId.eq(workspace))
        .into_model::<DeviceRow>()
        .one(&orm(db))
        .await?;
    Ok(row.map(|row| Device {
        revoked: row.revoked_at.is_some(),
        id: row.id,
        user_id: row.user_id,
        name: row.name,
    }))
}

/// `user_id`'s devices, revoked ones too, newest first.
pub(crate) async fn list_devices(
    db: &PgPool,
    workspace: Option<&str>,
    user_id: &str,
) -> PassResult<Vec<Value>> {
    let rows = DeviceRow::select()
        .filter(D::WorkspaceId.eq(workspace))
        .filter(D::UserId.eq(user_id))
        .order_by_desc(D::CreatedAt)
        .order_by_desc(D::Id)
        .into_model::<DeviceRow>()
        .all(&orm(db))
        .await?;
    Ok(rows.iter().map(row_json).collect())
}

/// Every device in the workspace, newest first, with its owner's name and
/// email when they are a member.
pub(crate) async fn list_workspace_devices(
    db: &PgPool,
    workspace: Option<&str>,
) -> PassResult<Vec<Value>> {
    let rows = DeviceRow::select()
        .column_as(workspace_members::Column::Name, "user_name")
        .column_as(workspace_members::Column::Email, "user_email")
        .join(JoinType::LeftJoin, owner())
        .filter(D::WorkspaceId.eq(workspace))
        .order_by_desc(D::CreatedAt)
        .order_by_desc(D::Id)
        .into_model::<DeviceWithOwner>()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |DeviceWithOwner {
                 device,
                 user_name,
                 user_email,
             }| {
                let mut json = row_json(&device);
                json["userName"] = user_name.map_or(Value::Null, Value::String);
                json["userEmail"] = user_email.map_or(Value::Null, Value::String);
                json
            },
        )
        .collect())
}

/// Revoke a device: its next sync wipes the copy. A device revoked already
/// keeps its first revocation.
pub(crate) async fn revoke_device(
    db: &PgPool,
    workspace: Option<&str>,
    device_id: &str,
    actor_id: &str,
) -> PassResult<()> {
    devices::Entity::update_many()
        .col_expr(D::RevokedAt, Expr::value(now()))
        .col_expr(D::RevokedBy, Expr::value(actor_id))
        .filter(D::Id.eq(device_id))
        .filter(D::WorkspaceId.eq(workspace))
        .filter(D::RevokedAt.is_null())
        .exec(&orm(db))
        .await?;
    Ok(())
}

/// The device synced at `at`.
async fn mark_synced(
    db: &PgPool,
    workspace: Option<&str>,
    device_id: &str,
    at: OffsetDateTime,
) -> PassResult<()> {
    devices::Entity::update_many()
        .col_expr(D::LastSyncAt, Expr::value(at))
        .filter(D::Id.eq(device_id))
        .filter(D::WorkspaceId.eq(workspace))
        .exec(&orm(db))
        .await?;
    Ok(())
}

// ── The sync ───────────────────────────────────────────────────────────────

/// The cursor every vault gets from a sync that started at `started`: an
/// ISO 8601 time to the millisecond, [`CURSOR_OVERLAP`] before it.
pub(crate) fn next_cursor(started: OffsetDateTime) -> String {
    iso_timestamp(started - CURSOR_OVERLAP)
}

/// A cursor a device sent, as the time it stands for. `None` (a full sync of
/// that vault) when it is not an RFC 3339 time, or lies after `now`: this
/// server never hands out one of those.
pub(crate) fn parse_cursor(cursor: &str, now: OffsetDateTime) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(cursor, &Rfc3339)
        .ok()
        .filter(|at| *at <= now)
}

/// The vaults a device holds a cursor for that `readable` no longer has
/// (left, removed, deleted, or never readable): it wipes them.
pub(crate) fn removed_vault_ids(cursors: &[(String, String)], readable: &[String]) -> Vec<String> {
    cursors
        .iter()
        .filter(|(vault, _)| !readable.contains(vault))
        .map(|(vault, _)| vault.clone())
        .collect()
}

/// An item's fields as the copy carries them: a shared vault's login without
/// its 2FA seed (PASS-007), whose `hasTotp` still says it has one.
pub(crate) fn synced_fields(document: &ItemDocument, shared: bool) -> Value {
    let mut fields = document.fields_json();
    if shared && matches!(document, ItemDocument::Login { .. }) {
        fields["totp"] = json!("");
    }
    fields
}

/// What a sync sent from one vault, for its trail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VaultSent {
    pub(crate) vault_id: String,
    pub(crate) full: bool,
    pub(crate) items: usize,
    pub(crate) deleted: usize,
}

/// A sync's answer (`WeldPassSyncResult`), and the vaults that sent the
/// device at least one item or deletion.
#[derive(Debug)]
pub(crate) struct Synced {
    pub(crate) json: Value,
    pub(crate) sent: Vec<VaultSent>,
}

/// `{ wipe: true, reason }`: the device deletes its copy and its key.
fn wipe(reason: &str, synced_at: &str) -> Value {
    json!({
        "wipe": true,
        "reason": reason,
        "syncedAt": synced_at,
        "vaults": [],
        "removedVaultIds": [],
    })
}

/// Sync `device`'s copy from `cursors` (vault id, cursor): every vault its
/// owner can read, each item changed since that vault's cursor (or all of
/// them without a usable one), the ids deleted since, and the vaults it held
/// that it may no longer keep. A vault whose key cannot be opened fails the
/// whole sync. The device's last sync is recorded either way.
pub(crate) async fn sync_copy(
    db: &PgPool,
    keyring: &RootKeyring,
    workspace: Option<&str>,
    device: &Device,
    cursors: &[(String, String)],
) -> PassResult<Synced> {
    let started = now();
    let synced_at = iso_timestamp(started);
    let reason = if device.revoked {
        Some("revoked")
    } else if offline_copies(db).await? {
        None
    } else {
        Some("disabled")
    };
    if let Some(reason) = reason {
        mark_synced(db, workspace, &device.id, started).await?;
        return Ok(Synced {
            json: wipe(reason, &synced_at),
            sent: Vec::new(),
        });
    }

    ensure_personal_vault(db, workspace, keyring, &device.user_id).await?;
    let readable = list_vaults(db, workspace, &device.user_id, false).await?;
    let readable_ids: Vec<String> = readable
        .iter()
        .filter_map(|vault| vault["id"].as_str().map(str::to_owned))
        .collect();
    let cursor = next_cursor(started);
    let mut vaults = Vec::with_capacity(readable.len());
    let mut sent = Vec::new();
    for vault in readable {
        let vault_id = vault["id"].as_str().unwrap_or_default().to_owned();
        let shared = vault["kind"] == "shared";
        let since = cursors
            .iter()
            .find(|(id, _)| *id == vault_id)
            .and_then(|(_, cursor)| parse_cursor(cursor, started));
        let full = since.is_none();
        let kek = open_password_vault(db, keyring, &vault_id).await?;
        let changes = open_vault_changes(db, &kek, &vault_id, since).await?;
        if !changes.items.is_empty() || !changes.deleted_ids.is_empty() {
            sent.push(VaultSent {
                vault_id: vault_id.clone(),
                full,
                items: changes.items.len(),
                deleted: changes.deleted_ids.len(),
            });
        }
        let items: Vec<Value> = changes
            .items
            .into_iter()
            .map(|(item, document)| {
                merge(
                    item.json,
                    json!({ "fields": synced_fields(&document, shared) }),
                )
            })
            .collect();
        vaults.push(json!({
            "vault": vault,
            "cursor": cursor,
            "full": full,
            "items": items,
            "deletedIds": changes.deleted_ids,
        }));
    }
    let removed = removed_vault_ids(cursors, &readable_ids);
    mark_synced(db, workspace, &device.id, started).await?;
    Ok(Synced {
        json: json!({
            "wipe": false,
            "reason": null,
            "syncedAt": synced_at,
            "vaults": vaults,
            "removedVaultIds": removed,
        }),
        sent,
    })
}

// ── The setting ────────────────────────────────────────────────────────────

/// `custom_settings.weldpass.offlineCopies`: on unless switched off.
pub(crate) fn offline_copies_of(custom: Option<&Value>) -> bool {
    custom
        .and_then(|custom| custom.get(SETTINGS_KEY))
        .and_then(|settings| settings.get("offlineCopies"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// The settings row WeldPass reads and writes, of `rows` (oldest first): the
/// first that holds its key, else the first.
fn settings_row(rows: &[(String, Option<Value>)]) -> Option<&(String, Option<Value>)> {
    rows.iter()
        .find(|(_, custom)| {
            custom
                .as_ref()
                .is_some_and(|custom| custom.get(SETTINGS_KEY).is_some())
        })
        .or_else(|| rows.first())
}

/// The workspace's settings rows, oldest first: id and custom settings.
async fn settings_rows(db: &PgPool) -> PassResult<Vec<(String, Option<Value>)>> {
    let rows: Vec<(String, Option<Value>)> = workspace_settings::Entity::find()
        .select_only()
        .columns([S::Id, S::CustomSettings])
        .filter(S::DeletedAt.is_null())
        .order_by_asc(S::CreatedAt)
        .order_by_asc(S::Id)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows)
}

/// Whether the workspace allows offline copies on phones (on by default).
pub(crate) async fn offline_copies(db: &PgPool) -> PassResult<bool> {
    let rows = settings_rows(db).await?;
    Ok(offline_copies_of(
        settings_row(&rows).and_then(|(_, custom)| custom.as_ref()),
    ))
}

/// `custom_settings -> 'weldpass'`.
fn stored_settings() -> Expr {
    PgExpr::get_json_field(Expr::col(S::CustomSettings), SETTINGS_KEY)
}

/// `case when jsonb_typeof(value) = 'object' then value else '{}' end`.
fn object_or_empty(value: Expr) -> Expr {
    Expr::case(
        sea_query::ExprTrait::eq(
            Expr::from(Func::cust("jsonb_typeof").arg(value.clone())),
            "object",
        ),
        value,
    )
    .finally(Expr::val(json!({})).cast_as("jsonb"))
    .into()
}

/// Row `id`'s custom settings with `weldpass.offlineCopies` set by
/// `jsonb_set` and `||`: the one key changes in the statement itself, so a
/// concurrent write of another setting (SSO's, say) is never overwritten.
fn offline_copies_update(id: &str, on: bool) -> UpdateMany<workspace_settings::Entity> {
    let merged = Func::cust("jsonb_set")
        .arg(object_or_empty(Expr::col(S::CustomSettings)))
        .arg(Expr::val(SETTINGS_PATH).cast_as("text[]"))
        .arg(PgExpr::concat(
            object_or_empty(stored_settings()),
            Expr::val(json!({ "offlineCopies": on })).cast_as("jsonb"),
        ))
        .arg(true);
    workspace_settings::Entity::update_many()
        .col_expr(S::CustomSettings, Expr::from(merged))
        .col_expr(S::UpdatedAt, Expr::value(now()))
        .filter(S::Id.eq(id))
}

/// Switch offline copies on or off, in the workspace's settings row
/// (created when there is none).
pub(crate) async fn set_offline_copies(db: &PgPool, on: bool) -> PassResult<()> {
    let rows = settings_rows(db).await?;
    let db = orm(db);
    if let Some((id, _)) = settings_row(&rows) {
        offline_copies_update(id, on).exec(&db).await?;
    } else {
        let stamp = now();
        workspace_settings::Entity::insert(workspace_settings::ActiveModel {
            id: Set(generate_id("ws")),
            custom_settings: Set(Some(json!({ SETTINGS_KEY: { "offlineCopies": on } }))),
            created_at: Set(stamp),
            updated_at: Set(stamp),
            ..Default::default()
        })
        .exec_without_returning(&db)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    // Not `super::*`: `PgExpr` is implemented for strings too, and its
    // `contains` would answer `sql.contains(..)` below.
    use sea_orm::{DbBackend, QueryTrait};
    use serde_json::json;
    use time::OffsetDateTime;
    use time::format_description::well_known::Rfc3339;

    use super::{
        CURSOR_OVERLAP, next_cursor, offline_copies_of, offline_copies_update, parse_cursor,
        removed_vault_ids, settings_row, synced_fields,
    };
    use crate::schemas::parse_item;

    const SEED: &str = "JBSWY3DPEHPK3PXP";

    fn at(text: &str) -> OffsetDateTime {
        OffsetDateTime::parse(text, &Rfc3339).expect("a time")
    }

    #[test]
    fn a_cursor_points_a_minute_before_the_sync_to_the_millisecond() {
        assert_eq!(
            next_cursor(at("2026-11-24T10:00:30.123456Z")),
            "2026-11-24T09:59:30.123Z"
        );
        assert_eq!(
            next_cursor(at("2026-11-24T00:00:10Z")),
            "2026-11-23T23:59:10.000Z"
        );
    }

    #[test]
    fn a_cursor_reads_back_as_its_time() {
        let started = at("2026-11-24T10:00:00Z");
        let cursor = next_cursor(started);
        assert_eq!(
            parse_cursor(&cursor, started),
            Some(started - CURSOR_OVERLAP)
        );
        assert_eq!(
            parse_cursor("2026-11-24T11:00:00+01:00", started),
            Some(started)
        );
    }

    #[test]
    fn an_unusable_cursor_means_a_full_sync() {
        let started = at("2026-11-24T10:00:00Z");
        assert_eq!(parse_cursor("", started), None);
        assert_eq!(parse_cursor("garbage", started), None);
        assert_eq!(parse_cursor("2026-11-24", started), None);
        // Ahead of the server's clock: not one it handed out.
        assert_eq!(parse_cursor("2026-11-24T10:00:00.001Z", started), None);
    }

    #[test]
    fn vaults_no_longer_readable_are_removed() {
        let cursors = [
            ("wpk_kept".to_owned(), "2026-11-24T10:00:00.000Z".to_owned()),
            ("wpk_gone".to_owned(), "garbage".to_owned()),
        ];
        let readable = ["wpk_kept".to_owned(), "wpk_new".to_owned()];
        assert_eq!(
            removed_vault_ids(&cursors, &readable),
            vec!["wpk_gone".to_owned()]
        );
        assert!(removed_vault_ids(&[], &readable).is_empty());
        assert_eq!(removed_vault_ids(&cursors, &[]).len(), 2);
    }

    #[test]
    fn shared_logins_come_without_their_2fa_seed() {
        let login = parse_item(
            &json!({
                "type": "login",
                "title": "Router",
                "fields": { "username": "admin", "password": "pw", "totp": SEED },
            })
            .to_string(),
        )
        .expect("a login");
        assert_eq!(synced_fields(&login, false)["totp"], SEED);
        let shared = synced_fields(&login, true);
        assert_eq!(shared["totp"], "");
        assert_eq!(shared["username"], "admin");
        assert_eq!(shared["password"], "pw");

        let note = parse_item(
            &json!({ "type": "note", "title": "Wifi", "fields": { "content": "hunter2" } })
                .to_string(),
        )
        .expect("a note");
        assert_eq!(synced_fields(&note, true), json!({ "content": "hunter2" }));
    }

    #[test]
    fn offline_copies_are_on_unless_switched_off() {
        assert!(offline_copies_of(None));
        assert!(offline_copies_of(Some(&json!({}))));
        assert!(offline_copies_of(Some(
            &json!({ "sso": { "defaultRole": "ADMIN" } })
        )));
        assert!(offline_copies_of(Some(&json!({ "weldpass": {} }))));
        assert!(offline_copies_of(Some(
            &json!({ "weldpass": { "offlineCopies": true } })
        )));
        assert!(!offline_copies_of(Some(
            &json!({ "weldpass": { "offlineCopies": false } })
        )));
        assert!(offline_copies_of(Some(
            &json!({ "weldpass": { "offlineCopies": "false" } })
        )));
        assert!(offline_copies_of(Some(&json!(["weldpass"]))));
    }

    #[test]
    fn the_settings_row_is_the_one_holding_weldpass() {
        let rows = [
            ("ws_first".to_owned(), Some(json!({ "sso": {} }))),
            (
                "ws_second".to_owned(),
                Some(json!({ "weldpass": { "offlineCopies": false } })),
            ),
        ];
        assert_eq!(
            settings_row(&rows).map(|(id, _)| id.as_str()),
            Some("ws_second")
        );
        assert_eq!(
            settings_row(&rows[..1]).map(|(id, _)| id.as_str()),
            Some("ws_first")
        );
        assert!(settings_row(&[]).is_none());
    }

    #[test]
    fn switching_offline_copies_merges_into_the_stored_settings() {
        let sql = offline_copies_update("ws_settings", false)
            .build(DbBackend::Postgres)
            .to_string();
        assert!(sql.contains("jsonb_set("), "{sql}");
        assert!(sql.contains("jsonb_typeof("), "{sql}");
        assert!(sql.contains("'{weldpass}'"), "{sql}");
        assert!(sql.contains("'weldpass'"), "{sql}");
        assert!(sql.contains(r#"{"offlineCopies":false}"#), "{sql}");
        assert!(sql.contains("'ws_settings'"), "{sql}");
    }
}
