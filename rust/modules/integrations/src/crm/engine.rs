//! `lib/engine/sync/orchestrator.ts` and `upsert.ts`: one entity type of a
//! connection synced page by page into its table, through the field
//! mappings, the bidirectional conflict check and the shared
//! "mapping → checksum → email dedup → create" write path that the webhook
//! ingress uses too.

use std::time::Duration;

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DatabaseConnection, DbErr, EntityTrait, FromQueryResult, QueryFilter, QuerySelect,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_books_domain::table::{Table, WriteError};
use weldsuite_core_domain::js::{Js, as_text};
use weldsuite_db::{PgPool, orm};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::tenant::{
    calendar_events, companies, crm_activities, crm_leads, crm_opportunities, crm_pipelines,
    integration_connections, integration_entity_mappings as mappings,
    integration_field_mappings as field_mappings, integration_sync_conflicts as conflicts, people,
};

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

/// The entity a CRM table is read through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Store {
    Companies,
    People,
    CrmLeads,
    CrmOpportunities,
    CrmActivities,
    CalendarEvents,
    CrmPipelines,
}

/// A model as Drizzle's `select()` returns the row.
fn js_row<M: Serialize>(model: Option<M>) -> Result<Option<Value>, DbErr> {
    model
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| DbErr::Json(error.to_string()))
}

impl Store {
    /// `db.select().from(table).where(eq(table.id, id)).limit(1)`: the row,
    /// deleted or not, as Drizzle returns it.
    async fn select_any(self, db: &DatabaseConnection, id: &str) -> Result<Option<Value>, DbErr> {
        let id = id.to_owned();
        match self {
            Self::Companies => js_row(companies::Entity::find_by_id(id).one(db).await?),
            Self::People => js_row(people::Entity::find_by_id(id).one(db).await?),
            Self::CrmLeads => js_row(crm_leads::Entity::find_by_id(id).one(db).await?),
            Self::CrmOpportunities => {
                js_row(crm_opportunities::Entity::find_by_id(id).one(db).await?)
            }
            Self::CrmActivities => js_row(crm_activities::Entity::find_by_id(id).one(db).await?),
            Self::CalendarEvents => js_row(calendar_events::Entity::find_by_id(id).one(db).await?),
            Self::CrmPipelines => js_row(crm_pipelines::Entity::find_by_id(id).one(db).await?),
        }
    }

    /// Whether the table has an `email` property (`upsertByMapping`'s dedup).
    fn has_email(self) -> bool {
        matches!(self, Self::Companies | Self::People | Self::CrmLeads)
    }

    /// The live row with this `email`, on a table that has the property.
    async fn live_id_by_email(
        self,
        db: &DatabaseConnection,
        email: &str,
    ) -> Result<Option<String>, DbErr> {
        match self {
            Self::Companies => {
                companies::Entity::find()
                    .select_only()
                    .column(companies::Column::Id)
                    .filter(companies::Column::Email.eq(email))
                    .filter(companies::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(db)
                    .await
            }
            Self::People => {
                people::Entity::find()
                    .select_only()
                    .column(people::Column::Id)
                    .filter(people::Column::Email.eq(email))
                    .filter(people::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(db)
                    .await
            }
            Self::CrmLeads => {
                crm_leads::Entity::find()
                    .select_only()
                    .column(crm_leads::Column::Id)
                    .filter(crm_leads::Column::Email.eq(email))
                    .filter(crm_leads::Column::DeletedAt.is_null())
                    .into_tuple()
                    .one(db)
                    .await
            }
            _ => Ok(None),
        }
    }
}

/// `getEntityTable(entityType)`.
#[derive(Debug, Clone, Copy)]
pub struct EntityTable {
    pub table: &'static Table,
    pub store: Store,
    pub prefix: &'static str,
    pub internal_type: &'static str,
}

impl EntityTable {
    pub fn of(entity_type: &str) -> Result<Self, String> {
        let (table, store, prefix, internal_type) = match entity_type {
            "customer" => (&tables::COMPANIES, Store::Companies, "company", "company"),
            "contact" => (&tables::PEOPLE, Store::People, "person", "person"),
            "lead" => (&tables::CRM_LEADS, Store::CrmLeads, "lead", "lead"),
            "opportunity" => (
                &tables::CRM_OPPORTUNITIES,
                Store::CrmOpportunities,
                "opp",
                "opportunity",
            ),
            "activity" => (
                &tables::CRM_ACTIVITIES,
                Store::CrmActivities,
                "act",
                "activity",
            ),
            "calendar_event" => (
                &tables::CALENDAR_EVENTS,
                Store::CalendarEvents,
                "evt",
                "calendar_event",
            ),
            "pipeline" => (
                &tables::CRM_PIPELINES,
                Store::CrmPipelines,
                "pipe",
                "pipeline",
            ),
            other => return Err(format!("Unsupported entity type: {other}")),
        };
        Ok(Self {
            table,
            store,
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

/// `new Date()`, as Drizzle writes it to a `timestamp` column.
pub(crate) fn now_at() -> PrimitiveDateTime {
    weldsuite_db::utc_now()
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
#[derive(Debug, Clone, FromQueryResult)]
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
    mappings::Entity::find()
        .select_only()
        .columns([
            mappings::Column::Id,
            mappings::Column::InternalEntityType,
            mappings::Column::InternalEntityId,
            mappings::Column::SyncChecksum,
        ])
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(external_type))
        .filter(mappings::Column::ExternalEntityId.eq(external_id))
        .into_model::<EntityMapping>()
        .one(&orm(db))
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
    mappings::Entity::insert(mappings::ActiveModel {
        id: Set(generate_id("iem")),
        connection_id: Set(connection_id.to_owned()),
        external_entity_type: Set(external_type.to_owned()),
        external_entity_id: Set(external_id.to_owned()),
        internal_entity_type: Set(internal_type.to_owned()),
        internal_entity_id: Set(internal_id.to_owned()),
        last_synced_at: Set(Some(now_at())),
        sync_checksum: Set(checksum.map(str::to_owned)),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await
    .map(|_| ())
    .map_err(|e| db_message(&e))
}

/// `set({ syncChecksum, lastSyncedAt: new Date(), updatedAt: new Date() })` on a mapping.
pub(crate) async fn touch_mapping(db: &PgPool, id: &str, checksum: &str) -> Result<(), String> {
    let at = now_at();
    mappings::Entity::update_many()
        .col_expr(mappings::Column::SyncChecksum, Expr::value(checksum))
        .col_expr(mappings::Column::LastSyncedAt, Expr::value(at))
        .col_expr(mappings::Column::UpdatedAt, Expr::value(at))
        .filter(mappings::Column::Id.eq(id))
        .exec(&orm(db))
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
    if entity.store.has_email() && truthy(email) {
        let email = as_text(&Js::from_jsonb(email.expect("truthy")));
        let found = entity
            .store
            .live_id_by_email(&orm(db), &email)
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
    let rows: Vec<(String, String, String, String, Option<Value>, bool)> =
        field_mappings::Entity::find()
            .select_only()
            .columns([
                field_mappings::Column::ExternalFieldPath,
                field_mappings::Column::InternalFieldPath,
                field_mappings::Column::Direction,
                field_mappings::Column::TransformType,
                field_mappings::Column::TransformConfig,
                field_mappings::Column::IsRequired,
            ])
            .filter(field_mappings::Column::ConnectionId.eq(connection_id))
            .filter(field_mappings::Column::EntityType.eq(entity_type))
            .into_tuple()
            .all(&orm(db))
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
    let row = ctx
        .table
        .store
        .select_any(&orm(ctx.db), &mapping.internal_entity_id)
        .await
        .map_err(|e| db_message(&e))?;
    let Some(internal) = row else {
        return Ok(Outcome::Proceed);
    };
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
            conflicts::Entity::insert(conflicts::ActiveModel {
                id: Set(generate_id("cnfl")),
                connection_id: Set(ctx.connection.id.clone()),
                entity_type: Set(ctx.entity_type.to_owned()),
                internal_entity_id: Set(mapping.internal_entity_id.clone()),
                external_entity_id: Set(entity.id.clone()),
                conflict_type: Set("field_mismatch".to_owned()),
                internal_data: Set(Value::Object(internal)),
                external_data: Set(Value::Object(entity.data.values.clone())),
                conflict_fields: Set(Some(json!(fields))),
                ..Default::default()
            })
            .exec_without_returning(&orm(ctx.db))
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
    integration_connections::Entity::update_many()
        .col_expr(
            integration_connections::Column::SyncCursor,
            Expr::value(Value::Object(updated)),
        )
        .col_expr(
            integration_connections::Column::UpdatedAt,
            Expr::value(now_at()),
        )
        .filter(integration_connections::Column::Id.eq(&connection.id))
        .exec(&orm(db))
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
