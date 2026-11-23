//! An `asset_sources` row as the routes and the import pass it around, the
//! row as the API shows it (`assetSourceView`), and the statements that
//! start, save and end a run (`startAssetImport`, `saveState`, `endRun` of
//! `@weldsuite/core-domain/asset-sources`).
//!
//! `secret_encrypted` is never part of the row: every statement here selects
//! (or returns) the row without it, with a `has_secret` flag in its place
//! ([`COLUMNS`], [`has_secret`]). The import and the test routes read the
//! sealed secret on its own ([`stored_secret`]).

use sea_orm::sea_query::{Expr, Func, ReturningClause};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, FromQueryResult,
    QueryFilter, QueryOrder, QueryResult, QuerySelect, QueryTrait,
};
use serde_json::{Map, Value, json};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{OrmConn, PgPool, orm, orm_error, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::Field;
use weldsuite_schema::tenant::asset_sources::{self, Column, Entity};
use weldsuite_schema::tenant::integration_entity_mappings as mappings;

use super::microsoft::{SourceError, parse_stored_error};

/// The due index kind of the import sweep (`markWorkspaceDue(d1, 'asset_import', …)`).
pub const DUE_KIND: &str = "asset_import";
/// `ASSET_OBJECT_SLUG`: the custom object the devices become records of.
pub(crate) const ASSET_OBJECT_SLUG: &str = "asset";
/// `INTUNE_DEVICE_ENTITY_TYPE`: `external_entity_type` of an Intune device
/// in `integration_entity_mappings`.
pub(crate) const INTUNE_DEVICE_ENTITY_TYPE: &str = "intune_device";

const TIMESTAMPS: [&str; 4] = ["created_at", "updated_at", "next_sync_at", "last_sync_at"];

/// Every column but the sealed secret, in the order [`Source`] reads them;
/// [`has_secret`] comes after them.
const COLUMNS: [Column; 16] = [
    Column::Id,
    Column::CreatedAt,
    Column::UpdatedAt,
    Column::Type,
    Column::Name,
    Column::ObjectSlug,
    Column::Config,
    Column::Enabled,
    Column::IntervalHours,
    Column::NextSyncAt,
    Column::SyncState,
    Column::LastSyncAt,
    Column::LastStatus,
    Column::LastError,
    Column::LastStats,
    Column::CreatedById,
];

/// `secret_encrypted is not null`: the flag that stands in for the secret.
fn has_secret() -> Expr {
    Column::SecretEncrypted.is_not_null()
}

/// `returning` the row without the sealed secret ([`COLUMNS`], then
/// [`has_secret`]).
fn returning() -> ReturningClause {
    ReturningClause::Exprs(
        COLUMNS
            .iter()
            .map(|column| Expr::col(*column))
            .chain([has_secret()])
            .collect(),
    )
}

/// The row without the sealed secret, with `has_secret` in its place, as
/// the lease claim ([`claim_step`]) returns it.
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

/// An ISO time as the `timestamp` it is written as (`$n::timestamp`); text
/// that is no time is the database error Postgres answered it with.
fn timestamp(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    instant(iso).map(utc_timestamp).ok_or_else(|| {
        DbErr::Type(format!(
            "invalid input syntax for type timestamp: \"{iso}\""
        ))
    })
}

/// A `timestamp` column as `toISOString()` writes it.
fn iso(at: PrimitiveDateTime) -> String {
    iso_timestamp(at.assume_utc())
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

/// A row read as [`COLUMNS`] then [`has_secret`], by position (the flag has
/// no column name in a `returning`).
impl FromQueryResult for Source {
    fn from_query_result(row: &QueryResult, _pre: &str) -> Result<Self, DbErr> {
        let json = |index: usize| -> Result<Option<Value>, DbErr> {
            let value: Option<Value> = row.try_get_by_index(index)?;
            Ok(value.filter(|value| !value.is_null()))
        };
        let stamp = |index: usize| -> Result<Option<String>, DbErr> {
            let at: Option<PrimitiveDateTime> = row.try_get_by_index(index)?;
            Ok(at.map(iso))
        };
        let created_at: PrimitiveDateTime = row.try_get_by_index(1)?;
        let updated_at: PrimitiveDateTime = row.try_get_by_index(2)?;
        let interval_hours: i32 = row.try_get_by_index(8)?;
        Ok(Self {
            id: row.try_get_by_index(0)?,
            kind: row.try_get_by_index(3)?,
            name: row.try_get_by_index(4)?,
            object_slug: row.try_get_by_index(5)?,
            config: row.try_get_by_index(6)?,
            enabled: row.try_get_by_index(7)?,
            interval_hours: i64::from(interval_hours),
            next_sync_at: stamp(9)?,
            sync_state: json(10)?,
            last_sync_at: stamp(11)?,
            last_status: row.try_get_by_index(12)?,
            last_error: row.try_get_by_index(13)?,
            last_stats: json(14)?,
            created_by_id: row.try_get_by_index(15)?,
            has_secret: row.try_get_by_index(16)?,
            created_at: iso(created_at),
            updated_at: iso(updated_at),
        })
    }
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

/// `select <the row without the secret> from asset_sources`.
fn select() -> sea_orm::Select<Entity> {
    Entity::find()
        .select_only()
        .columns(COLUMNS)
        .expr(has_secret())
}

/// Run a write that `returning` the row ([`returning`]): the row as stored
/// afterwards, or `None` when the write matched none.
async fn written(
    db: &PgPool,
    statement: &impl sea_orm::StatementBuilder,
) -> Result<Option<Source>, DbErr> {
    let row = orm(db).query_one(statement).await?;
    row.map(|row| Source::from_query_result(&row, "")).transpose()
}

/// Every source, oldest first.
pub(crate) async fn list(db: &PgPool) -> Result<Vec<Source>, DbErr> {
    select()
        .order_by_asc(Column::CreatedAt)
        .order_by_asc(Column::Id)
        .into_model()
        .all(&orm(db))
        .await
}

/// The sources of one type (the one-source-per-app-registration check).
pub(crate) async fn of_type(db: &PgPool, kind: &str) -> Result<Vec<Source>, DbErr> {
    select()
        .filter(Column::Type.eq(kind))
        .into_model()
        .all(&orm(db))
        .await
}

pub(crate) async fn by_id(db: &PgPool, id: &str) -> Result<Option<Source>, DbErr> {
    select()
        .filter(Column::Id.eq(id))
        .into_model()
        .one(&orm(db))
        .await
}

/// The sealed client secret of a source, for the caller to open and use at
/// once; `None` when none is stored.
pub(crate) async fn stored_secret(db: &PgPool, id: &str) -> Result<Option<String>, DbErr> {
    let secret: Option<Option<String>> = Entity::find()
        .select_only()
        .column(Column::SecretEncrypted)
        .filter(Column::Id.eq(id))
        .into_tuple()
        .one(&orm(db))
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

pub(crate) async fn insert(db: &PgPool, new: NewSource<'_>) -> Result<Source, DbErr> {
    let now = timestamp(new.now)?;
    let mut statement = Entity::insert(asset_sources::ActiveModel {
        id: Set(new.id.to_owned()),
        type_: Set(new.kind.to_owned()),
        name: Set(new.name.to_owned()),
        object_slug: Set(new.object_slug.to_owned()),
        config: Set(new.config),
        secret_encrypted: Set(Some(new.secret_encrypted.to_owned())),
        enabled: Set(new.enabled),
        interval_hours: Set(new.interval_hours),
        next_sync_at: Set(new.next_sync_at.map(timestamp).transpose()?),
        created_by_id: Set(Some(new.created_by_id.to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .into_query();
    statement.returning(returning());
    written(db, &statement)
        .await?
        .ok_or(DbErr::RecordNotInserted)
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
) -> Result<Option<Source>, DbErr> {
    let mut update = Entity::update_many().col_expr(Column::UpdatedAt, Expr::value(timestamp(now)?));
    if let Some(name) = changes.name {
        update = update.col_expr(Column::Name, Expr::value(name));
    }
    if let Some(config) = changes.config {
        update = update.col_expr(Column::Config, Expr::value(config));
    }
    if let Some(sealed) = changes.secret_encrypted {
        update = update.col_expr(Column::SecretEncrypted, Expr::value(sealed));
    }
    if let Some(enabled) = changes.enabled {
        update = update.col_expr(Column::Enabled, Expr::value(enabled));
    }
    if let Some(hours) = changes.interval_hours {
        update = update.col_expr(Column::IntervalHours, Expr::value(hours));
    }
    if !changes.next_sync_at.is_absent() {
        let next = changes.next_sync_at.as_set().copied().map(timestamp).transpose()?;
        update = update.col_expr(Column::NextSyncAt, Expr::value(next));
    }
    let mut statement = update.filter(Column::Id.eq(id)).into_query();
    statement.returning(returning());
    written(db, &statement).await
}

/// `startAssetImport(db, source, { now, startedById })`: start an import by
/// hand or on schedule. The updated source, or `None` when a run is already
/// under way (nothing is changed then).
pub(crate) async fn start_import(
    db: &PgPool,
    id: &str,
    now: &str,
    started_by: Option<&str>,
) -> Result<Option<Source>, DbErr> {
    let state = json!({
        "startedAt": now,
        "nextLink": null,
        "offset": 0,
        "stats": zero_stats(),
        "startedById": started_by,
    });
    let mut statement = Entity::update_many()
        .col_expr(Column::SyncState, Expr::value(state))
        .col_expr(Column::LastStatus, Expr::value("running"))
        .col_expr(Column::LastError, Expr::value(Option::<String>::None))
        .col_expr(Column::UpdatedAt, Expr::value(timestamp(now)?))
        .filter(Column::Id.eq(id))
        .filter(Column::SyncState.is_null())
        .into_query();
    statement.returning(returning());
    written(db, &statement).await
}

/// `claimStep`: take the run for one step. A compare-and-set that goes
/// through only while no other step holds a lease that has not run out; it
/// writes `lease` as the state's `leaseUntil`. The source as stored then (the
/// step works from it, not from what its caller read earlier), or `None`:
/// another step is at work, or no run is under way any more.
#[allow(
    clippy::disallowed_methods,
    reason = "a compare-and-set claim in one statement that compares the stored lease \
              `collate \"C\"` (byte order), which the query builder cannot express"
)]
pub(crate) async fn claim_step(
    db: &PgPool,
    id: &str,
    now: &str,
    lease: &str,
) -> Result<Option<Source>, DbErr> {
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
    .await
    .map_err(orm_error)?;
    Ok(row.map(Source::from_row))
}

/// `sync_state->>'leaseUntil' = lease`: the run is still this step's.
fn holds_lease(lease: &str) -> Expr {
    sea_orm::ExprTrait::eq(
        sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
            Expr::col((Entity, Column::SyncState)),
            "leaseUntil",
        ),
        lease,
    )
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
) -> Result<bool, DbErr> {
    let saved = Entity::update_many()
        .col_expr(Column::SyncState, Expr::value(state.clone()))
        .col_expr(Column::UpdatedAt, Expr::value(timestamp(now)?))
        .filter(Column::Id.eq(id))
        .filter(holds_lease(lease))
        .exec(&orm(db))
        .await?;
    Ok(saved.rows_affected > 0)
}

/// `releaseLease`: give the lease up and leave everything else as it is (a
/// throttled step waits).
pub(crate) async fn release_lease(db: &PgPool, id: &str, lease: &str) -> Result<(), DbErr> {
    // `sync_state - 'leaseUntil'`: the key removed.
    let without_lease =
        sea_orm::ExprTrait::sub(Expr::col((Entity, Column::SyncState)), "leaseUntil");
    Entity::update_many()
        .col_expr(Column::SyncState, without_lease)
        .filter(Column::Id.eq(id))
        .filter(holds_lease(lease))
        .exec(&orm(db))
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
) -> Result<Option<Source>, DbErr> {
    let at = utc_timestamp(now);
    // `$at + interval_hours * interval '1 hour'` while the schedule is on.
    let after_interval = sea_orm::ExprTrait::add(
        Expr::val(at),
        Func::cust("make_interval").args([
            Expr::val(0),
            Expr::val(0),
            Expr::val(0),
            Expr::val(0),
            Expr::col((Entity, Column::IntervalHours)),
        ]),
    );
    let next_sync_at = Expr::case(Expr::col((Entity, Column::Enabled)), after_interval)
        .finally(Expr::null());
    let mut statement = Entity::update_many()
        .col_expr(Column::SyncState, Expr::value(Option::<Value>::None))
        .col_expr(Column::LastSyncAt, Expr::value(at))
        .col_expr(
            Column::LastStatus,
            Expr::value(if failure.is_some() { "failed" } else { "ok" }),
        )
        .col_expr(Column::LastError, Expr::value(failure.map(SourceError::stored)))
        .col_expr(Column::LastStats, Expr::value(stats.cloned()))
        .col_expr(Column::NextSyncAt, next_sync_at.into())
        .col_expr(Column::UpdatedAt, Expr::value(at))
        .filter(Column::Id.eq(id))
        .filter(holds_lease(lease))
        .into_query();
    statement.returning(returning());
    written(db, &statement).await
}

/// The source goes with its mappings; the asset records it imported stay.
pub(crate) async fn delete(db: &PgPool, id: &str) -> Result<(), DbErr> {
    let mappings = mappings::Entity::delete_many()
        .filter(mappings::Column::ConnectionId.eq(id))
        .filter(mappings::Column::ExternalEntityType.eq(INTUNE_DEVICE_ENTITY_TYPE));
    let source = Entity::delete_many().filter(Column::Id.eq(id));
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            mappings.exec(&tx).await?;
            source.exec(&tx).await?;
            Ok::<_, Transaction>(())
        })
    })
    .await
    .map_err(|Transaction(error)| error)
}

/// A transaction's failure: a statement's, or opening or committing it.
struct Transaction(DbErr);

impl From<DbErr> for Transaction {
    fn from(error: DbErr) -> Self {
        Self(error)
    }
}

impl From<sqlx::Error> for Transaction {
    fn from(error: sqlx::Error) -> Self {
        Self(orm_error(error))
    }
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
