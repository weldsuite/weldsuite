//! An `asset_sources` row as the routes and the import pass it around, the
//! row as the API shows it (`assetSourceView`), and the statements that
//! start, save and end a run (`startAssetImport`, `saveState`, `endRun` of
//! `@weldsuite/core-domain/asset-sources`).
//!
//! `secret_encrypted` is never part of the row: every statement here selects
//! the row without it, with a `has_secret` flag in its place. The import and
//! the test routes read the sealed secret on its own
//! ([`stored_secret`]).

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::Field;

use super::microsoft::{SourceError, parse_stored_error};

/// The due index kind of the import sweep (`markWorkspaceDue(d1, 'asset_import', …)`).
pub const DUE_KIND: &str = "asset_import";
/// `ASSET_OBJECT_SLUG`: the custom object the devices become records of.
pub(crate) const ASSET_OBJECT_SLUG: &str = "asset";
/// `INTUNE_DEVICE_ENTITY_TYPE`: `external_entity_type` of an Intune device
/// in `integration_entity_mappings`.
pub(crate) const INTUNE_DEVICE_ENTITY_TYPE: &str = "intune_device";

const TIMESTAMPS: [&str; 4] = ["created_at", "updated_at", "next_sync_at", "last_sync_at"];

/// The row without the sealed secret, with `has_secret` in its place.
macro_rules! columns {
    () => {
        "((to_jsonb(s) - 'secret_encrypted') \
         || jsonb_build_object('has_secret', s.secret_encrypted is not null))"
    };
}

/// An ISO time (`toISOString()`) as an instant.
pub(crate) fn instant(iso: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(iso, &Rfc3339).ok()
}

/// `new Date()`: an instant cut to the millisecond, as JavaScript holds it.
pub(crate) fn to_millisecond(at: OffsetDateTime) -> OffsetDateTime {
    at.replace_nanosecond(at.nanosecond() / 1_000_000 * 1_000_000)
        .unwrap_or(at)
}

/// JavaScript truthiness of a `jsonb` value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `{ total: 0, created: 0, updated: 0, unchanged: 0, failed: 0 }`.
pub(crate) fn zero_stats() -> Value {
    json!({ "total": 0, "created": 0, "updated": 0, "unchanged": 0, "failed": 0 })
}

/// An asset source, timestamps as `toISOString()` writes them.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Source {
    pub(crate) id: String,
    /// `type`: `intune`.
    pub(crate) kind: String,
    pub(crate) name: String,
    pub(crate) object_slug: String,
    /// `{ tenantId, clientId }`.
    pub(crate) config: Value,
    pub(crate) has_secret: bool,
    pub(crate) enabled: bool,
    pub(crate) interval_hours: i64,
    pub(crate) next_sync_at: Option<String>,
    /// The run under way (`AssetSourceSyncState`); `None` when the column is
    /// null.
    pub(crate) sync_state: Option<Value>,
    pub(crate) last_sync_at: Option<String>,
    pub(crate) last_status: Option<String>,
    /// `<code>: <message>`.
    pub(crate) last_error: Option<String>,
    pub(crate) last_stats: Option<Value>,
    pub(crate) created_by_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

impl Source {
    fn from_row(raw: Value) -> Self {
        let row = crate::row(raw, &TIMESTAMPS);
        let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
        let optional = |key: &str| row[key].as_str().map(str::to_owned);
        let json = |key: &str| Some(row[key].clone()).filter(|value| !value.is_null());
        Self {
            id: text("id"),
            kind: text("type"),
            name: text("name"),
            object_slug: text("objectSlug"),
            config: row["config"].clone(),
            has_secret: row["hasSecret"] == true,
            enabled: row["enabled"] == true,
            interval_hours: row["intervalHours"].as_i64().unwrap_or_default(),
            next_sync_at: optional("nextSyncAt"),
            sync_state: json("syncState"),
            last_sync_at: optional("lastSyncAt"),
            last_status: optional("lastStatus"),
            last_error: optional("lastError"),
            last_stats: json("lastStats"),
            created_by_id: optional("createdById"),
            created_at: text("createdAt"),
            updated_at: text("updatedAt"),
        }
    }

    /// `source.syncState`, when it is truthy: the run under way.
    pub(crate) fn running(&self) -> Option<&Value> {
        self.sync_state.as_ref().filter(|state| truthy(state))
    }

    /// `config.tenantId` (empty when it is not a string).
    pub(crate) fn tenant_id(&self) -> &str {
        self.config["tenantId"].as_str().unwrap_or_default()
    }

    /// `config.clientId` (empty when it is not a string).
    pub(crate) fn client_id(&self) -> &str {
        self.config["clientId"].as_str().unwrap_or_default()
    }

    /// `assetSourceView(row)`: the row as the API shows it. No
    /// `secretEncrypted`, a `hasSecret` flag in its place: safe for
    /// responses, events and logs.
    pub(crate) fn view(&self) -> Value {
        let (code, message) = parse_stored_error(self.last_error.as_deref());
        let mut config = Map::new();
        for key in ["tenantId", "clientId"] {
            if let Some(value) = self.config.get(key) {
                config.insert(key.to_owned(), value.clone());
            }
        }
        let progress = self.running().map(|state| {
            let mut progress = Map::new();
            for key in ["startedAt", "stats"] {
                if let Some(value) = state.get(key) {
                    progress.insert(key.to_owned(), value.clone());
                }
            }
            let started_by = state.get("startedById").cloned().unwrap_or(Value::Null);
            progress.insert("startedById".to_owned(), started_by);
            Value::Object(progress)
        });
        json!({
            "id": self.id,
            "type": self.kind,
            "name": self.name,
            "objectSlug": self.object_slug,
            "config": config,
            "hasSecret": self.has_secret,
            "enabled": self.enabled,
            "intervalHours": self.interval_hours,
            "nextSyncAt": self.next_sync_at,
            "lastStatus": self.last_status,
            "lastSyncAt": self.last_sync_at,
            "lastError": message,
            "lastErrorCode": code,
            "lastStats": self.last_stats,
            "progress": progress,
            "createdById": self.created_by_id,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }

    /// `assetSourceDueAt(source, now)`: when the sweep next has work for
    /// the source. Now while a run is under way, else its schedule.
    pub(crate) fn due_at(&self, now: OffsetDateTime) -> Option<OffsetDateTime> {
        if self.running().is_some() {
            return Some(now);
        }
        if self.enabled {
            return self.next_sync_at.as_deref().and_then(instant);
        }
        None
    }
}

/// Every source, oldest first.
pub(crate) async fn list(db: &PgPool) -> Result<Vec<Source>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        columns!(),
        " from asset_sources s order by s.created_at asc, s.id asc"
    ))
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Source::from_row).collect())
}

/// The sources of one type (the one-source-per-app-registration check).
pub(crate) async fn of_type(db: &PgPool, kind: &str) -> Result<Vec<Source>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        columns!(),
        " from asset_sources s where s.type = $1"
    ))
    .bind(kind)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Source::from_row).collect())
}

pub(crate) async fn by_id(db: &PgPool, id: &str) -> Result<Option<Source>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        columns!(),
        " from asset_sources s where s.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(Source::from_row))
}

/// The sealed client secret of a source, for the caller to open and use at
/// once; `None` when none is stored.
pub(crate) async fn stored_secret(db: &PgPool, id: &str) -> Result<Option<String>, sqlx::Error> {
    let secret: Option<Option<String>> =
        sqlx::query_scalar("select secret_encrypted from asset_sources where id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(secret.flatten())
}

/// What a new source is saved with.
pub(crate) struct NewSource<'a> {
    pub(crate) id: &'a str,
    pub(crate) kind: &'a str,
    pub(crate) name: &'a str,
    pub(crate) object_slug: &'a str,
    pub(crate) config: Value,
    pub(crate) secret_encrypted: &'a str,
    pub(crate) enabled: bool,
    pub(crate) interval_hours: i32,
    pub(crate) next_sync_at: Option<&'a str>,
    pub(crate) created_by_id: &'a str,
    /// `new Date()` as `toISOString()`.
    pub(crate) now: &'a str,
}

pub(crate) async fn insert(db: &PgPool, new: NewSource<'_>) -> Result<Source, sqlx::Error> {
    let row: Value = sqlx::query_scalar(concat!(
        "insert into asset_sources as s \
           (id, type, name, object_slug, config, secret_encrypted, enabled, interval_hours, \
            next_sync_at, created_by_id, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamp, $10, $11::timestamp, \
                 $11::timestamp) \
         returning ",
        columns!()
    ))
    .bind(new.id)
    .bind(new.kind)
    .bind(new.name)
    .bind(new.object_slug)
    .bind(new.config)
    .bind(new.secret_encrypted)
    .bind(new.enabled)
    .bind(new.interval_hours)
    .bind(new.next_sync_at)
    .bind(new.created_by_id)
    .bind(new.now)
    .fetch_one(db)
    .await?;
    Ok(Source::from_row(row))
}

/// What a `PATCH` changes: `None` keeps the column.
#[derive(Default)]
pub(crate) struct Changes<'a> {
    pub(crate) name: Option<&'a str>,
    pub(crate) config: Option<Value>,
    pub(crate) secret_encrypted: Option<&'a str>,
    pub(crate) enabled: Option<bool>,
    pub(crate) interval_hours: Option<i32>,
    /// `Null` clears the next import; `Absent` keeps it.
    pub(crate) next_sync_at: Field<&'a str>,
}

/// The update of a `PATCH`; `None` when the row went away meanwhile.
pub(crate) async fn update(
    db: &PgPool,
    id: &str,
    now: &str,
    changes: Changes<'_>,
) -> Result<Option<Source>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update asset_sources as s set \
           updated_at = $2::timestamp, \
           name = case when $3 then $4 else s.name end, \
           config = case when $5 then $6 else s.config end, \
           secret_encrypted = case when $7 then $8 else s.secret_encrypted end, \
           enabled = case when $9 then $10 else s.enabled end, \
           interval_hours = case when $11 then $12 else s.interval_hours end, \
           next_sync_at = case when $13 then $14::timestamp else s.next_sync_at end \
         where s.id = $1 returning ",
        columns!()
    ))
    .bind(id)
    .bind(now)
    .bind(changes.name.is_some())
    .bind(changes.name)
    .bind(changes.config.is_some())
    .bind(changes.config)
    .bind(changes.secret_encrypted.is_some())
    .bind(changes.secret_encrypted)
    .bind(changes.enabled.is_some())
    .bind(changes.enabled)
    .bind(changes.interval_hours.is_some())
    .bind(changes.interval_hours)
    .bind(!changes.next_sync_at.is_absent())
    .bind(changes.next_sync_at.as_set().copied())
    .fetch_optional(db)
    .await?;
    Ok(row.map(Source::from_row))
}

/// `startAssetImport(db, source, { now, startedById })`: start an import by
/// hand or on schedule. The updated source, or `None` when a run is already
/// under way (nothing is changed then).
pub(crate) async fn start_import(
    db: &PgPool,
    id: &str,
    now: &str,
    started_by: Option<&str>,
) -> Result<Option<Source>, sqlx::Error> {
    let state = json!({
        "startedAt": now,
        "nextLink": null,
        "offset": 0,
        "stats": zero_stats(),
        "startedById": started_by,
    });
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update asset_sources as s set \
           sync_state = $2, last_status = 'running', last_error = null, \
           updated_at = $3::timestamp \
         where s.id = $1 and s.sync_state is null returning ",
        columns!()
    ))
    .bind(id)
    .bind(state)
    .bind(now)
    .fetch_optional(db)
    .await?;
    Ok(row.map(Source::from_row))
}

/// `claimStep`: take the run for one step. A compare-and-set that goes
/// through only while no other step holds a lease that has not run out; it
/// writes `lease` as the state's `leaseUntil`. The source as stored then (the
/// step works from it, not from what its caller read earlier), or `None`:
/// another step is at work, or no run is under way any more.
pub(crate) async fn claim_step(
    db: &PgPool,
    id: &str,
    now: &str,
    lease: &str,
) -> Result<Option<Source>, sqlx::Error> {
    // ISO times of one form order as text; no lease reads as the empty string.
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update asset_sources as s set \
           sync_state = jsonb_set(s.sync_state, '{leaseUntil}', to_jsonb($2::text)) \
         where s.id = $1 and jsonb_typeof(s.sync_state) = 'object' \
           and coalesce(s.sync_state->>'leaseUntil', '') collate \"C\" <= $3 \
         returning ",
        columns!()
    ))
    .bind(id)
    .bind(lease)
    .bind(now)
    .fetch_optional(db)
    .await?;
    Ok(row.map(Source::from_row))
}

/// `saveState`: where the run stopped, for the next step. Written by the
/// step that holds `lease`, and the lease goes with it (`state` carries
/// none). `false`: the run was no longer this step's.
pub(crate) async fn save_state(
    db: &PgPool,
    id: &str,
    state: &Value,
    now: &str,
    lease: &str,
) -> Result<bool, sqlx::Error> {
    let saved = sqlx::query(
        "update asset_sources set sync_state = $2, updated_at = $3::timestamp \
          where id = $1 and sync_state->>'leaseUntil' = $4",
    )
    .bind(id)
    .bind(state)
    .bind(now)
    .bind(lease)
    .execute(db)
    .await?;
    Ok(saved.rows_affected() > 0)
}

/// `releaseLease`: give the lease up and leave everything else as it is (a
/// throttled step waits).
pub(crate) async fn release_lease(db: &PgPool, id: &str, lease: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update asset_sources set sync_state = sync_state - 'leaseUntil' \
          where id = $1 and sync_state->>'leaseUntil' = $2",
    )
    .bind(id)
    .bind(lease)
    .execute(db)
    .await?;
    Ok(())
}

/// `endRun`: the run is over, finished or failed. The next scheduled import
/// comes from the row's own `enabled` and `interval_hours` as they are when
/// this is written, not as the step read them: the schedule may have been
/// switched on, or its interval changed, while the step ran. The source as
/// stored afterwards, or `None` when the run was no longer this step's (its
/// lease ran out and another step took over, or the source was deleted).
pub(crate) async fn end_run(
    db: &PgPool,
    id: &str,
    stats: Option<&Value>,
    now: OffsetDateTime,
    failure: Option<&SourceError>,
    lease: &str,
) -> Result<Option<Source>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update asset_sources as s set \
           sync_state = null, last_sync_at = $2::timestamp, last_status = $3, last_error = $4, \
           last_stats = $5, \
           next_sync_at = case when s.enabled \
             then $2::timestamp + s.interval_hours * interval '1 hour' else null end, \
           updated_at = $2::timestamp \
         where s.id = $1 and s.sync_state->>'leaseUntil' = $6 returning ",
        columns!()
    ))
    .bind(id)
    .bind(iso_timestamp(now))
    .bind(if failure.is_some() { "failed" } else { "ok" })
    .bind(failure.map(SourceError::stored))
    .bind(stats)
    .bind(lease)
    .fetch_optional(db)
    .await?;
    Ok(row.map(Source::from_row))
}

/// The source goes with its mappings; the asset records it imported stay.
pub(crate) async fn delete(db: &PgPool, id: &str) -> Result<(), sqlx::Error> {
    weldsuite_db::atomically(
        db,
        [
            sqlx::query(
                "delete from integration_entity_mappings \
                  where connection_id = $1 and external_entity_type = $2",
            )
            .bind(id)
            .bind(INTUNE_DEVICE_ENTITY_TYPE),
            sqlx::query("delete from asset_sources where id = $1").bind(id),
        ],
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(extra: Value) -> Source {
        let mut row = json!({
            "id": "asrc_1",
            "created_at": "2026-11-10T07:00:30",
            "updated_at": "2026-11-10T07:00:30.5",
            "type": "intune",
            "name": "Contoso Intune",
            "object_slug": "asset",
            "config": { "clientId": "c", "tenantId": "t", "extra": true },
            "enabled": true,
            "interval_hours": 24,
            "next_sync_at": "2026-11-11T08:00:30",
            "sync_state": null,
            "last_sync_at": null,
            "last_status": null,
            "last_error": null,
            "last_stats": null,
            "created_by_id": "user_admin",
            "has_secret": true,
        });
        if let (Value::Object(row), Value::Object(extra)) = (&mut row, extra) {
            row.extend(extra);
        }
        Source::from_row(row)
    }

    #[test]
    fn the_view_is_typescripts_and_never_carries_the_secret() {
        let view = source(json!({})).view();
        assert_eq!(
            view,
            json!({
                "id": "asrc_1",
                "type": "intune",
                "name": "Contoso Intune",
                "objectSlug": "asset",
                "config": { "tenantId": "t", "clientId": "c" },
                "hasSecret": true,
                "enabled": true,
                "intervalHours": 24,
                "nextSyncAt": "2026-11-11T08:00:30.000Z",
                "lastStatus": null,
                "lastSyncAt": null,
                "lastError": null,
                "lastErrorCode": null,
                "lastStats": null,
                "progress": null,
                "createdById": "user_admin",
                "createdAt": "2026-11-10T07:00:30.000Z",
                "updatedAt": "2026-11-10T07:00:30.500Z",
            })
        );
        assert!(columns!().contains("- 'secret_encrypted'"));
    }

    #[test]
    fn a_run_under_way_shows_as_progress_and_a_failure_with_its_code() {
        let stats = json!({ "total": 3, "created": 2, "updated": 1, "unchanged": 0, "failed": 0 });
        let running = source(json!({
            "last_status": "running",
            "sync_state": {
                "startedAt": "2026-11-10T08:00:00.000Z", "nextLink": null, "offset": 3,
                "stats": stats, "startedById": "user_admin",
            },
        }));
        assert_eq!(
            running.view()["progress"],
            json!({ "startedAt": "2026-11-10T08:00:00.000Z", "stats": stats, "startedById": "user_admin" })
        );
        // A scheduled run has no starter.
        let scheduled = source(json!({ "sync_state": { "startedAt": "x", "stats": stats } }));
        assert_eq!(scheduled.view()["progress"]["startedById"], Value::Null);

        let failed = source(json!({
            "last_status": "failed",
            "last_error": "permission_missing: Microsoft refused access.",
        }));
        let view = failed.view();
        assert_eq!(view["lastError"], "Microsoft refused access.");
        assert_eq!(view["lastErrorCode"], "permission_missing");
        assert_eq!(view["progress"], Value::Null);
    }

    #[test]
    fn a_source_is_due_now_while_running_else_at_its_schedule() {
        let now = instant("2026-11-10T08:00:30.000Z").unwrap_or(OffsetDateTime::UNIX_EPOCH);
        let scheduled = source(json!({}));
        assert_eq!(scheduled.due_at(now), instant("2026-11-11T08:00:30.000Z"));
        let running = source(json!({ "sync_state": { "startedAt": "x" }, "enabled": false }));
        assert_eq!(running.due_at(now), Some(now));
        let paused = source(json!({ "enabled": false }));
        assert_eq!(paused.due_at(now), None);
        let never = source(json!({ "next_sync_at": null }));
        assert_eq!(never.due_at(now), None);

        assert_eq!(
            to_millisecond(now + time::Duration::microseconds(1_999)),
            now + time::Duration::milliseconds(1)
        );
    }
}
