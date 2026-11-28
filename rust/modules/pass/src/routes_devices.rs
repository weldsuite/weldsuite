//! Devices and their offline copy (ADR PASS-010): `/api/weldpass/devices`
//! and `/api/weldpass/settings`. These exist only here: the TypeScript
//! backend is frozen, so the platform and the app hide them on Global, and
//! the `pass` conformance suite leaves them out.
//!
//! `passwords:use` opens the door. A device is its owner's: syncing it and
//! reporting what it did with its copy take being that owner (anyone else
//! gets a 404). Revoking one takes its owner or `passwords:manage`, which
//! also lists every device in the workspace and switches offline copies off.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::PASSWORDS_MANAGE;
use weldsuite_kit::NoContent;
use weldsuite_kit::validation::{Format, Issues, Presence, Text};

use crate::audit::{VaultEvent, record_vault_event, require_vault_event};
use crate::devices::{self, Device};
use crate::password_items as items;
use crate::password_vaults as vaults;
use crate::{Caller, PassError, PassResult, PassState, answer, created, ok, param, validate};

type Params = Path<HashMap<String, String>>;

/// `weldpassDevicePlatformSchema`.
const PLATFORMS: [&str; 3] = ["ios", "android", "other"];

/// `deviceEventActionSchema`.
const EVENT_ACTIONS: [&str; 3] = ["revealed", "copied", "autofilled"];

/// `MAX_SYNC_VAULTS`: cursors in one sync request.
const MAX_SYNC_VAULTS: usize = 500;

/// `MAX_DEVICE_EVENTS`: events in one upload.
const MAX_DEVICE_EVENTS: usize = 500;

/// The permission gate's own refusal, for `?all=true` without
/// `passwords:manage`.
const NOT_ALLOWED: &str = "You do not have permission to perform this action";

/// A query parameter as `c.req.query(name)` reads it.
fn query(raw: Option<&str>, name: &str) -> Option<String> {
    url::form_urlencoded::parse(raw.unwrap_or_default().as_bytes())
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// The caller's own device `device_id`: anyone else's is a 404, as one that
/// doesn't exist.
async fn own_device(caller: &Caller, device_id: &str) -> PassResult<Device> {
    devices::find_device(&caller.db, caller.org(), device_id)
        .await?
        .filter(|device| device.user_id == caller.user_id)
        .ok_or_else(|| PassError::not_found("device", device_id))
}

/// `syncDeviceSchema`: the cursors by vault id, none when left out. The
/// record's keys and values are checked at `["cursors", <vault id>]`; the
/// count is a refinement, settled after them unless a value had the wrong
/// type (Zod aborts the record then).
fn read_cursors(issues: &mut Issues, fields: &Map<String, Value>) -> Vec<(String, String)> {
    let before = issues.count();
    let cursors = issues.nested(fields, "cursors", Presence::Optional, |issues, cursors| {
        let mut read = Vec::with_capacity(cursors.len());
        for vault in cursors.keys() {
            let length = crate::js::utf16_len(vault);
            if length == 0 {
                issues.string_too_small(vault, 1, "String must contain at least 1 character(s)");
            }
            if length > 30 {
                issues.string_too_big(vault, 30, "String must contain at most 30 character(s)");
            }
            if let Some(cursor) = issues
                .text(cursors, vault, Presence::Required, Some(1), Some(64))
                .into_option()
            {
                read.push((vault.clone(), cursor));
            }
        }
        read
    });
    let count = fields
        .get("cursors")
        .and_then(Value::as_object)
        .map_or(0, Map::len);
    let aborted = issues
        .issues_since(before)
        .iter()
        .any(|issue| issue["code"] == "invalid_type");
    if count > MAX_SYNC_VAULTS && !aborted {
        issues.custom("cursors", &format!("At most {MAX_SYNC_VAULTS} vaults"));
    }
    cursors.into_option().unwrap_or_default()
}

/// One event a device reports (`deviceEventsSchema.events[]`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct DeviceEvent {
    vault_id: String,
    item_id: String,
    /// The trail's action for it (`item.revealed`, …).
    action: &'static str,
    /// When it happened on the device, as sent.
    at: String,
}

/// The trail's action for a device's event.
fn vault_event_action(action: &str) -> Option<&'static str> {
    match action {
        "revealed" => Some("item.revealed"),
        "copied" => Some("item.copied"),
        "autofilled" => Some("item.autofilled"),
        _ => None,
    }
}

/// One item of `events`, reported at its own path; `None` when invalid.
fn read_event(issues: &mut Issues, item: &Value) -> Option<DeviceEvent> {
    let fields = issues.object(item)?;
    let vault_id = issues.text(fields, "vaultId", Presence::Required, Some(1), Some(30));
    let item_id = issues.text(fields, "itemId", Presence::Required, Some(1), Some(30));
    let action = issues.choice(fields, "action", Presence::Required, &EVENT_ACTIONS);
    let at = issues.text_with(
        fields,
        "at",
        Presence::Required,
        Text {
            format: Some(Format::DatetimeOffset),
            ..Text::default()
        },
    );
    Some(DeviceEvent {
        vault_id: vault_id.into_option()?,
        item_id: item_id.into_option()?,
        action: vault_event_action(&action.into_option()?)?,
        at: at.into_option()?,
    })
}

/// `deviceEventsSchema`.
fn read_events(issues: &mut Issues, fields: &Map<String, Value>) -> Vec<DeviceEvent> {
    issues
        .list(
            fields,
            "events",
            Presence::Required,
            Some(1),
            Some(MAX_DEVICE_EVENTS),
            read_event,
        )
        .into_option()
        .unwrap_or_default()
}

// ── Devices ────────────────────────────────────────────────────────────────

/// Register the caller's device; its id names it in every sync.
pub(crate) async fn register_device(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let (name, platform, app_version) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text_with(
                        fields,
                        "name",
                        Presence::Required,
                        Text::trimmed(Some(1), Some(100)),
                    ),
                    issues.choice(fields, "platform", Presence::Required, &PLATFORMS),
                    issues.text_with(
                        fields,
                        "appVersion",
                        Presence::Nullish,
                        Text::trimmed(None, Some(40)),
                    ),
                )
            })?;
            let app_version = app_version
                .into_option()
                .filter(|version| !version.is_empty());
            let device = devices::register_device(
                &caller.db,
                caller.org(),
                &caller.user_id,
                &name.into_option().unwrap_or_default(),
                &platform.into_option().unwrap_or_default(),
                app_version.as_deref(),
            )
            .await?;
            Ok(created(device))
        }
        .await,
    )
}

/// The caller's devices, newest first; `?all=true` lists every device in
/// the workspace with its owner (`passwords:manage`).
pub(crate) async fn list_devices(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    answer(
        async {
            let all = query(raw.as_deref(), "all").as_deref() == Some("true");
            let rows = if all {
                if !caller.can(PASSWORDS_MANAGE) {
                    return Err(PassError::Forbidden(NOT_ALLOWED.to_owned()));
                }
                devices::list_workspace_devices(&caller.db, caller.org()).await?
            } else {
                devices::list_devices(&caller.db, caller.org(), &caller.user_id).await?
            };
            Ok(ok(Value::Array(rows)))
        }
        .await,
    )
}

/// Revoke a device: its copy is wiped at its next sync. Its owner may, and
/// `passwords:manage` may revoke anyone's.
pub(crate) async fn revoke_device(caller: Caller, Path(params): Params) -> Response {
    answer(
        async {
            let device_id = param(&params, "deviceId");
            let can_manage_all = caller.can(PASSWORDS_MANAGE);
            let device = devices::find_device(&caller.db, caller.org(), device_id)
                .await?
                .filter(|device| device.user_id == caller.user_id || can_manage_all)
                .ok_or_else(|| PassError::not_found("device", device_id))?;
            devices::revoke_device(&caller.db, caller.org(), &device.id, &caller.user_id).await?;
            Ok(NoContent.into_response())
        }
        .await,
    )
}

/// Items changed since each vault's cursor (whole and decrypted), the ids
/// deleted since, and the vaults to drop; or `wipe` for a revoked device or
/// a workspace without offline copies. One trail row per vault that sent
/// something.
pub(crate) async fn sync_device(
    caller: Caller,
    State(state): State<PassState>,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let cursors = validate(&headers, &body, read_cursors)?;
            let device = own_device(&caller, param(&params, "deviceId")).await?;
            let synced = devices::sync_copy(
                &caller.db,
                &caller.keyring(&state),
                caller.org(),
                &device,
                &cursors,
            )
            .await?;
            // The copy carries every item decrypted: no row, no copy.
            for sent in &synced.sent {
                require_vault_event(
                    &caller.db,
                    &caller.audit,
                    VaultEvent::new(&sent.vault_id, &caller.user_id, "device.synced")
                        .label(&device.name)
                        .metadata(json!({
                            "deviceId": device.id,
                            "full": sent.full,
                            "items": sent.items,
                            "deleted": sent.deleted,
                        })),
                )
                .await?;
            }
            Ok(ok(synced.json))
        }
        .await,
    )
}

/// What the device did with its copy (reveals, copies, autofills), into the
/// vaults' trails. An event for a vault the caller can no longer read, or an
/// item that was never in it, is skipped. A revoked device's events are
/// still recorded: they happened.
pub(crate) async fn device_events(
    caller: Caller,
    Path(params): Params,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let events = validate(&headers, &body, read_events)?;
            let device = own_device(&caller, param(&params, "deviceId")).await?;
            let readable: Vec<String> =
                vaults::list_vaults(&caller.db, caller.org(), &caller.user_id, false)
                    .await?
                    .iter()
                    .filter_map(|vault| vault["id"].as_str().map(str::to_owned))
                    .collect();
            let wanted: Vec<String> = events
                .iter()
                .filter(|event| readable.contains(&event.vault_id))
                .map(|event| event.item_id.clone())
                .collect();
            let known = items::item_titles(&caller.db, &readable, &wanted).await?;
            let mut recorded = 0_usize;
            for event in &events {
                let Some((_, _, title)) = known
                    .iter()
                    .find(|(id, vault, _)| *id == event.item_id && *vault == event.vault_id)
                else {
                    continue;
                };
                record_vault_event(
                    &caller.db,
                    &caller.audit,
                    VaultEvent::new(&event.vault_id, &caller.user_id, event.action)
                        .item(&event.item_id)
                        .label(title)
                        .metadata(json!({
                            "client": "mobile",
                            "deviceId": device.id,
                            "offline": true,
                            "at": event.at,
                        })),
                )
                .await;
                recorded += 1;
            }
            Ok(ok(json!({ "recorded": recorded })))
        }
        .await,
    )
}

// ── Settings ───────────────────────────────────────────────────────────────

/// The workspace's WeldPass settings.
pub(crate) async fn get_settings(caller: Caller) -> Response {
    answer(
        async {
            let offline_copies = devices::offline_copies(&caller.db).await?;
            Ok(ok(json!({ "offlineCopies": offline_copies })))
        }
        .await,
    )
}

/// Change them (`passwords:manage`, checked by the route). Switching offline
/// copies off wipes every device at its next sync.
pub(crate) async fn update_settings(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let offline_copies = validate(&headers, &body, |issues, fields| {
                issues.boolean(fields, "offlineCopies", Presence::Required)
            })?
            .into_option()
            .ok_or_else(|| PassError::Internal("validated settings without a value".to_owned()))?;
            devices::set_offline_copies(&caller.db, offline_copies).await?;
            Ok(ok(json!({ "offlineCopies": offline_copies })))
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read<T>(
        body: &Value,
        reader: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
    ) -> Result<T, Vec<Value>> {
        let mut issues = Issues::default();
        let value = issues
            .object(body)
            .map(|fields| reader(&mut issues, fields));
        issues
            .finish()
            .map_err(|invalid| invalid.issues().to_vec())?;
        value.ok_or_else(Vec::new)
    }

    #[test]
    fn cursors_default_to_none() {
        assert_eq!(read(&json!({}), read_cursors), Ok(Vec::new()));
        assert_eq!(
            read(
                &json!({ "cursors": { "wpk_a": "2026-11-24T10:00:00.000Z" } }),
                read_cursors
            ),
            Ok(vec![(
                "wpk_a".to_owned(),
                "2026-11-24T10:00:00.000Z".to_owned()
            )])
        );
    }

    #[test]
    fn a_cursor_is_checked_where_it_sits() {
        let issues =
            read(&json!({ "cursors": { "wpk_a": 5 } }), read_cursors).expect_err("invalid");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0]["code"], "invalid_type");
        assert_eq!(issues[0]["path"], json!(["cursors", "wpk_a"]));

        let issues =
            read(&json!({ "cursors": { "wpk_a": "" } }), read_cursors).expect_err("invalid");
        assert_eq!(issues[0]["code"], "too_small");
        assert_eq!(issues[0]["path"], json!(["cursors", "wpk_a"]));

        let long = "v".repeat(31);
        let mut cursors = Map::new();
        cursors.insert(long.clone(), json!("c"));
        let issues = read(&json!({ "cursors": cursors }), read_cursors).expect_err("invalid");
        assert_eq!(issues[0]["code"], "too_big");
        assert_eq!(issues[0]["path"], json!(["cursors", long]));

        let issues = read(&json!({ "cursors": null }), read_cursors).expect_err("invalid");
        assert_eq!(issues[0]["expected"], "object");
    }

    #[test]
    fn a_sync_holds_at_most_500_vaults() {
        let many: Map<String, Value> = (0..=MAX_SYNC_VAULTS)
            .map(|i| (format!("wpk_{i}"), json!("c")))
            .collect();
        let issues = read(&json!({ "cursors": many }), read_cursors).expect_err("too many");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0]["code"], "custom");
        assert_eq!(issues[0]["message"], "At most 500 vaults");
        assert_eq!(issues[0]["path"], json!(["cursors"]));
    }

    #[test]
    fn events_read_into_trail_actions() {
        let events = read(
            &json!({ "events": [
                { "vaultId": "wpk_a", "itemId": "wpi_a", "action": "copied", "at": "2026-11-24T10:00:00.000Z" },
                { "vaultId": "wpk_a", "itemId": "wpi_b", "action": "autofilled", "at": "2026-11-24T11:00:00+01:00" },
            ] }),
            read_events,
        )
        .expect("valid");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].action, "item.copied");
        assert_eq!(events[1].action, "item.autofilled");
        assert_eq!(events[1].at, "2026-11-24T11:00:00+01:00");
    }

    #[test]
    fn events_are_checked_at_their_index() {
        let issues = read(
            &json!({ "events": [
                { "vaultId": "wpk_a", "itemId": "wpi_a", "action": "printed", "at": "yesterday" },
            ] }),
            read_events,
        )
        .expect_err("invalid");
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0]["code"], "invalid_enum_value");
        assert_eq!(issues[0]["path"], json!(["events", 0, "action"]));
        assert_eq!(issues[1]["code"], "invalid_string");
        assert_eq!(issues[1]["path"], json!(["events", 0, "at"]));

        let issues = read(&json!({ "events": [] }), read_events).expect_err("empty");
        assert_eq!(issues[0]["code"], "too_small");
    }

    #[test]
    fn every_event_action_has_a_trail_action() {
        for action in EVENT_ACTIONS {
            assert!(vault_event_action(action).is_some(), "{action}");
        }
        assert_eq!(vault_event_action("printed"), None);
    }
}
