//! `lib/engine/sync/orchestrator.ts` and `upsert.ts`: one entity type of a
//! connection synced page by page into its table, through the field
//! mappings, the bidirectional conflict check and the shared
//! "mapping → checksum → email dedup → create" write path that the webhook
//! ingress uses too.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::table::{Table, WriteError};
use weldsuite_core_domain::js::{Js, as_text};
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;

use super::adapters::{Adapter, ExternalEntity, millis_of};
use super::mapper::{FieldMapper, FieldMapping, resolve_conflict, truthy};
use super::{Record, checksum, db_message, tables};

const THROTTLE: Duration = Duration::from_millis(200);

/// `SyncEntityStats`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncEntityStats {
    pub processed: i64,
    pub created: i64,
    pub updated: i64,
    pub skipped: i64,
    pub failed: i64,
    pub conflicts: i64,
}

/// `getEntityTable(entityType)`.
#[derive(Debug, Clone, Copy)]
pub struct EntityTable {
    pub table: &'static Table,
    pub select_any: &'static str,
    pub by_email: Option<&'static str>,
    pub prefix: &'static str,
    pub internal_type: &'static str,
}

impl EntityTable {
    pub fn of(entity_type: &str) -> Result<Self, String> {
        let (table, select_any, by_email, prefix, internal_type) = match entity_type {
            "customer" => (
                &tables::COMPANIES,
                tables::COMPANIES_SELECT_ANY,
                tables::COMPANIES_BY_EMAIL,
                "company",
                "company",
            ),
            "contact" => (
                &tables::PEOPLE,
                tables::PEOPLE_SELECT_ANY,
                tables::PEOPLE_BY_EMAIL,
                "person",
                "person",
            ),
            "lead" => (
                &tables::CRM_LEADS,
                tables::CRM_LEADS_SELECT_ANY,
                tables::CRM_LEADS_BY_EMAIL,
                "lead",
                "lead",
            ),
            "opportunity" => (
                &tables::CRM_OPPORTUNITIES,
                tables::CRM_OPPORTUNITIES_SELECT_ANY,
                tables::CRM_OPPORTUNITIES_BY_EMAIL,
                "opp",
                "opportunity",
            ),
            "activity" => (
                &tables::CRM_ACTIVITIES,
                tables::CRM_ACTIVITIES_SELECT_ANY,
                tables::CRM_ACTIVITIES_BY_EMAIL,
                "act",
                "activity",
            ),
            "calendar_event" => (
                &tables::CALENDAR_EVENTS,
                tables::CALENDAR_EVENTS_SELECT_ANY,
                tables::CALENDAR_EVENTS_BY_EMAIL,
                "evt",
                "calendar_event",
            ),
            "pipeline" => (
                &tables::CRM_PIPELINES,
                tables::CRM_PIPELINES_SELECT_ANY,
                tables::CRM_PIPELINES_BY_EMAIL,
                "pipe",
                "pipeline",
            ),
            other => return Err(format!("Unsupported entity type: {other}")),
        };
        Ok(Self {
            table,
            select_any,
            by_email,
            prefix,
            internal_type,
        })
    }

    /// `companies`.
    ///
    /// # Panics
    ///
    /// Never: the entity type has a table.
    pub fn companies() -> Self {
        Self::of("customer").expect("customer is a table")
    }

    /// `people`.
    ///
    /// # Panics
    ///
    /// Never: the entity type has a table.
    pub fn people() -> Self {
        Self::of("contact").expect("contact is a table")
    }
}

/// `new Date()`, as a timestamp column takes it.
pub(crate) fn now() -> String {
    iso_timestamp(time::OffsetDateTime::now_utc())
}

/// `{ ...values, updatedAt: new Date() }` written to `table` as Drizzle would.
fn write_values(
    entity: EntityTable,
    record: &Record,
    updated_at: bool,
) -> (Map<String, Value>, Vec<String>) {
    let mut values = entity.table.values(&record.values);
    let mut trusted = record.dates.clone();
    if updated_at {
        entity
            .table
            .set(&mut values, "updatedAt", Value::String(now()));
        trusted.push("updatedAt".to_owned());
    }
    (values, trusted)
}

fn write_error(error: WriteError) -> String {
    match error {
        WriteError::NotADate(_) => "value.toISOString is not a function".to_owned(),
        WriteError::Database(error) => db_message(&error),
    }
}

/// `db.update(table).set({ ...values, updatedAt: new Date() }).where(eq(table.id, id))`.
pub(crate) async fn update_row(
    db: &PgPool,
    entity: EntityTable,
    id: &str,
    record: &Record,
) -> Result<(), String> {
    if record.invalid_date {
        return Err("Invalid time value".to_owned());
    }
    let (values, trusted) = write_values(entity, record, true);
    let trusted: Vec<&str> = trusted.iter().map(String::as_str).collect();
    entity
        .table
        .patch(db, id, values, false, &trusted)
        .await
        .map(|_| ())
        .map_err(write_error)
}

/// `db.insert(table).values({ id, ...values })`.
pub(crate) async fn insert_row(
    db: &PgPool,
    entity: EntityTable,
    id: &str,
    record: &Record,
) -> Result<(), String> {
    if record.invalid_date {
        return Err("Invalid time value".to_owned());
    }
    let mut data = Map::new();
    data.insert("id".to_owned(), Value::String(id.to_owned()));
    data.extend(record.values.clone());
    let with_id = Record {
        values: data,
        ..record.clone()
    };
    let (values, trusted) = write_values(entity, &with_id, false);
    let trusted: Vec<&str> = trusted.iter().map(String::as_str).collect();
    entity
        .table
        .insert(db, values, &trusted)
        .await
        .map(|_| ())
        .map_err(write_error)
}

/// An `integration_entity_mappings` row the upserts read.
#[derive(Debug, Clone, sqlx::FromRow)]
pub(crate) struct EntityMapping {
    pub id: String,
    pub internal_entity_type: String,
    pub internal_entity_id: String,
    pub sync_checksum: Option<String>,
}

/// The mapping of `(connection, externalEntityType, externalEntityId)`.
pub(crate) async fn find_mapping(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: &str,
) -> Result<Option<EntityMapping>, String> {
    sqlx::query_as(
        "select id, internal_entity_type, internal_entity_id, sync_checksum
         from integration_entity_mappings
         where connection_id = $1 and external_entity_type = $2 and external_entity_id = $3
         limit 1",
    )
    .bind(connection_id)
    .bind(external_type)
    .bind(external_id)
    .fetch_optional(db)
    .await
    .map_err(|e| db_message(&e))
}

/// A new `integration_entity_mappings` row (`generateId('iem')`).
pub(crate) async fn insert_mapping(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: &str,
    internal_type: &str,
    internal_id: &str,
    checksum: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        "insert into integration_entity_mappings
            (id, connection_id, external_entity_type, external_entity_id, internal_entity_type,
             internal_entity_id, last_synced_at, sync_checksum)
         values ($1, $2, $3, $4, $5, $6, $7::timestamp, $8)",
    )
    .bind(generate_id("iem"))
    .bind(connection_id)
    .bind(external_type)
    .bind(external_id)
    .bind(internal_type)
    .bind(internal_id)
    .bind(now())
    .bind(checksum)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|e| db_message(&e))
}

/// `set({ syncChecksum, lastSyncedAt: new Date(), updatedAt: new Date() })` on a mapping.
pub(crate) async fn touch_mapping(db: &PgPool, id: &str, checksum: &str) -> Result<(), String> {
    let at = now();
    sqlx::query(
        "update integration_entity_mappings
         set sync_checksum = $2, last_synced_at = $3::timestamp, updated_at = $3::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(checksum)
    .bind(at)
    .execute(db)
    .await
    .map(|_| ())
    .map_err(|e| db_message(&e))
}

/// `upsertByMapping(args)`'s outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpsertAction {
    Created,
    Updated,
    Skipped,
}

impl UpsertAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Updated => "updated",
            Self::Skipped => "skipped",
        }
    }
}

/// `upsertByMapping(args)` with the default `dedupColumn` (`email`).
pub(crate) async fn upsert_by_mapping(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: &str,
    entity: EntityTable,
    record: &Record,
    checksum: &str,
) -> Result<(UpsertAction, String), String> {
    // 1. An existing mapping.
    if let Some(mapping) = find_mapping(db, connection_id, external_type, external_id).await? {
        if mapping.sync_checksum.as_deref() == Some(checksum) {
            return Ok((UpsertAction::Skipped, mapping.internal_entity_id));
        }
        update_row(db, entity, &mapping.internal_entity_id, record).await?;
        touch_mapping(db, &mapping.id, checksum).await?;
        return Ok((UpsertAction::Updated, mapping.internal_entity_id));
    }

    // 2. Dedup by email.
    let email = record.values.get("email");
    if let Some(query) = entity.by_email
        && truthy(email)
    {
        let email = as_text(&Js::from_jsonb(email.expect("truthy")));
        let found: Option<String> = sqlx::query_scalar(query)
            .bind(&email)
            .fetch_optional(db)
            .await
            .map_err(|e| db_message(&e))?;
        if let Some(id) = found {
            insert_mapping(
                db,
                connection_id,
                external_type,
                external_id,
                entity.internal_type,
                &id,
                Some(checksum),
            )
            .await?;
            update_row(db, entity, &id, record).await?;
            return Ok((UpsertAction::Updated, id));
        }
    }

    // 3. Create.
    let id = generate_id(entity.prefix);
    insert_row(db, entity, &id, record).await?;
    insert_mapping(
        db,
        connection_id,
        external_type,
        external_id,
        entity.internal_type,
        &id,
        Some(checksum),
    )
    .await?;
    Ok((UpsertAction::Created, id))
}

/// The connection fields a sync step reads.
#[derive(Debug, Clone, Default)]
pub struct SyncConnection {
    pub id: String,
    pub sync_cursor: Option<Value>,
    pub conflict_strategy: Option<String>,
    pub entity_config: Option<Value>,
}

/// `loadFieldMappings(db, connectionId, entityType, adapter)`.
async fn load_field_mappings(
    db: &PgPool,
    connection_id: &str,
    entity_type: &str,
    adapter: Adapter,
) -> Result<Vec<FieldMapping>, String> {
    let rows: Vec<(String, String, String, String, Option<Value>, bool)> = sqlx::query_as(
        "select external_field_path, internal_field_path, direction, transform_type,
                transform_config, is_required
         from integration_field_mappings where connection_id = $1 and entity_type = $2",
    )
    .bind(connection_id)
    .bind(entity_type)
    .fetch_all(db)
    .await
    .map_err(|e| db_message(&e))?;
    if rows.is_empty() {
        return Ok(adapter.default_field_mappings(entity_type));
    }
    Ok(rows
        .into_iter()
        .map(
            |(external, internal, direction, transform, config, required)| FieldMapping {
                external_field_path: external,
                internal_field_path: internal,
                direction,
                transform_type: transform,
                transform_config: config.filter(|c| !c.is_null()),
                is_required: required,
            },
        )
        .collect())
}

/// What `syncOneEntity` resolved once per run.
struct Context<'a> {
    db: &'a PgPool,
    connection: &'a SyncConnection,
    entity_type: &'a str,
    mapper: Option<FieldMapper>,
    strategy: String,
    defaults: &'a [(&'a str, Option<Value>)],
    table: EntityTable,
}

/// `new Date(asText(internalData.updatedAt || 0))`: `asText` of a `Date` is
/// its `toString()`, which keeps whole seconds only.
fn internal_updated_millis(updated_at: Option<&Value>) -> Option<i64> {
    match updated_at {
        Some(Value::String(iso)) if !iso.is_empty() => {
            millis_of(iso).map(|ms| ms.div_euclid(1000) * 1000)
        }
        // `new Date("0")` is 2000-01-01 in V8.
        _ => Some(946_684_800_000),
    }
}

enum Outcome {
    Proceed,
    Conflict,
    Skip,
}

/// `resolveBidirectionalConflict(ctx, entity, checksum)`.
async fn resolve_bidirectional(
    ctx: &Context<'_>,
    entity: &ExternalEntity,
    sum: &str,
) -> Result<Outcome, String> {
    let Some(mapping) =
        find_mapping(ctx.db, &ctx.connection.id, ctx.entity_type, &entity.id).await?
    else {
        return Ok(Outcome::Proceed);
    };
    if mapping.sync_checksum.as_deref() == Some(sum) {
        return Ok(Outcome::Proceed);
    }
    let row: Option<Value> = sqlx::query_scalar(ctx.table.select_any)
        .bind(&mapping.internal_entity_id)
        .fetch_optional(ctx.db)
        .await
        .map_err(|e| db_message(&e))?;
    let Some(row) = row else {
        return Ok(Outcome::Proceed);
    };
    let internal = ctx.table.table.js(row);
    let internal = internal.as_object().cloned().unwrap_or_default();
    let fields = ctx
        .mapper
        .as_ref()
        .map(|m| m.detect_conflicts(&internal, &entity.data.values))
        .unwrap_or_default();
    if fields.is_empty() {
        return Ok(Outcome::Proceed);
    }
    let action = resolve_conflict(
        &ctx.strategy,
        internal_updated_millis(internal.get("updatedAt")),
        millis_of(&entity.updated_at),
    );
    match action {
        "queue_manual" => {
            sqlx::query(
                "insert into integration_sync_conflicts
                    (id, connection_id, entity_type, internal_entity_id, external_entity_id,
                     conflict_type, internal_data, external_data, conflict_fields)
                 values ($1, $2, $3, $4, $5, 'field_mismatch', $6, $7, $8)",
            )
            .bind(generate_id("cnfl"))
            .bind(&ctx.connection.id)
            .bind(ctx.entity_type)
            .bind(&mapping.internal_entity_id)
            .bind(&entity.id)
            .bind(Value::Object(internal))
            .bind(Value::Object(entity.data.values.clone()))
            .bind(json!(fields))
            .execute(ctx.db)
            .await
            .map_err(|e| db_message(&e))?;
            Ok(Outcome::Conflict)
        }
        "use_internal" => Ok(Outcome::Skip),
        _ => Ok(Outcome::Proceed),
    }
}

/// `syncOneEntity(ctx, entity, stats)`.
async fn sync_one(
    ctx: &Context<'_>,
    entity: &ExternalEntity,
    stats: &mut SyncEntityStats,
) -> Result<(), String> {
    let sum = checksum(&entity.raw);
    let mapped = match &ctx.mapper {
        Some(mapper) => Record::plain(mapper.map_to_internal(&entity.data.values)),
        None => entity.data.clone(),
    }
    .with_defaults(ctx.defaults);

    let direction = ctx
        .connection
        .entity_config
        .as_ref()
        .and_then(|c| c.get(ctx.entity_type))
        .filter(|v| truthy(Some(v)))
        .and_then(Value::as_str)
        .unwrap_or("inbound");
    if direction == "bidirectional" {
        match resolve_bidirectional(ctx, entity, &sum).await? {
            Outcome::Conflict => {
                stats.conflicts += 1;
                return Ok(());
            }
            Outcome::Skip => {
                stats.skipped += 1;
                return Ok(());
            }
            Outcome::Proceed => {}
        }
    }

    let (action, _) = upsert_by_mapping(
        ctx.db,
        &ctx.connection.id,
        ctx.entity_type,
        &entity.id,
        ctx.table,
        &mapped,
        &sum,
    )
    .await?;
    match action {
        UpsertAction::Created => stats.created += 1,
        UpsertAction::Updated => stats.updated += 1,
        UpsertAction::Skipped => stats.skipped += 1,
    }
    Ok(())
}

/// The connection's cursor for an entity type (`cursors[entityType] || undefined`).
fn cursor_of(cursors: Option<&Value>, entity_type: &str) -> Option<String> {
    let value = cursors?.get(entity_type)?;
    if !truthy(Some(value)) {
        return None;
    }
    Some(match value {
        Value::String(text) => text.clone(),
        other => weldsuite_core_domain::js::js_string(&Js::from_jsonb(other)),
    })
}

/// `syncEntityType(db, adapter, connection, entityType, accessToken, options)`.
pub async fn sync_entity_type(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    adapter: Adapter,
    connection: &SyncConnection,
    entity_type: &str,
    access_token: &str,
    defaults: &[(&str, Option<Value>)],
) -> Result<SyncEntityStats, String> {
    let mut stats = SyncEntityStats::default();
    let mappings = load_field_mappings(db, &connection.id, entity_type, adapter).await?;
    let mapper = (!mappings.is_empty()).then(|| FieldMapper::new(&mappings));
    let strategy = connection
        .conflict_strategy
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "last_write_wins".to_owned());
    let ctx = Context {
        db,
        connection,
        entity_type,
        mapper,
        strategy,
        defaults,
        table: EntityTable::of(entity_type)?,
    };

    let cursors = connection
        .sync_cursor
        .clone()
        .filter(|c| truthy(Some(c)))
        .unwrap_or_else(|| json!({}));
    let mut cursor = cursor_of(Some(&cursors), entity_type);
    loop {
        let page = adapter
            .fetch_entities(http, access_token, entity_type, cursor.as_deref())
            .await?;
        for entity in &page.entities {
            stats.processed += 1;
            if let Err(error) = sync_one(&ctx, entity, &mut stats).await {
                stats.failed += 1;
                tracing::error!(
                    "[SyncOrchestrator] Failed to sync {entity_type} {}: {error}",
                    entity.id
                );
            }
        }
        cursor = page.next_cursor;
        if !page.has_more {
            break;
        }
        tokio_sleep(THROTTLE).await;
    }

    let mut updated = match cursors {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    updated.insert(
        entity_type.to_owned(),
        Value::String(cursor.filter(|c| !c.is_empty()).unwrap_or_default()),
    );
    sqlx::query(
        "update integration_connections set sync_cursor = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(&connection.id)
    .bind(Value::Object(updated))
    .bind(now())
    .execute(db)
    .await
    .map_err(|e| db_message(&e))?;
    Ok(stats)
}

/// `await new Promise(r => setTimeout(r, ms))`.
async fn tokio_sleep(duration: Duration) {
    tokio::time::sleep(duration).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_times_keep_whole_seconds() {
        assert_eq!(
            internal_updated_millis(Some(&json!("2026-10-05T10:00:00.789Z"))),
            millis_of("2026-10-05T10:00:00.000Z")
        );
        assert_eq!(internal_updated_millis(None), Some(946_684_800_000));
    }

    #[test]
    fn cursors_are_read_when_truthy() {
        let cursors = json!({ "customer": "500", "contact": "" });
        assert_eq!(
            cursor_of(Some(&cursors), "customer").as_deref(),
            Some("500")
        );
        assert_eq!(cursor_of(Some(&cursors), "contact"), None);
        assert_eq!(cursor_of(None, "contact"), None);
    }
}
