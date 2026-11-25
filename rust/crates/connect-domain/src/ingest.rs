//! Connector sync ingest (`connectors/ingest.ts`): one page of provider
//! records into WeldSuite. Each record: an existing
//! `integration_entity_mappings` row with the same checksum is skipped,
//! otherwise its internal row is updated; without a mapping a natural key
//! (sku, email, code, …) links an existing row; else a row is created and
//! mapped. A failing record is counted and sampled, never aborts the page.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use sea_orm::sea_query::{Alias, Expr, Order, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, DbBackend, DbErr, EntityTrait, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use time::PrimitiveDateTime;
use weldsuite_books_domain::roles::{PromoteTo, promote_accounting_role};
use weldsuite_books_domain::table::{Table, TableDb};
use weldsuite_commerce_domain::channels::{Connector, ensure_connector};
use weldsuite_commerce_domain::orders::write::{Import, ImportLine, import};
use weldsuite_db::{OrmConn, PgPool, orm, utc_now};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventSource, EventType};
use weldsuite_kit::generate_id;
use weldsuite_ports::{DynFileStore, OutboundHttp, PutOptions};
use weldsuite_schema::tenant::{
    accounting_entity_settings, bill_items, bills, companies, entities,
    integration_entity_mappings as mappings, integration_field_mappings, invoice_items, invoices,
    orders, parties, people, product_sales_channels, product_variants, settings, warehouses,
};

use crate::catalog::{get_connector, syncs};
use crate::clients::as_text;
use crate::js::{now_iso, number_text};
use crate::mappers::{
    DocumentLine, FieldMapping, INVALID_DATE, Links, Mapped, OrderLine, ProductVariant,
    external_id_of, is_deleted_record, map_connector_record, map_with_field_mappings,
};
use crate::moneybird::{AttachmentKind, Moneybird};
use crate::stripe::Stripe;
use crate::tables;

const MAX_ERROR_SAMPLES: usize = 5;
const MAX_ERROR_MESSAGE_LENGTH: usize = 200;
/// Moneybird attachment downloads per sync run. Global's 30 fits a Worker's
/// subrequest cap; the server runs syncs in the background, with no such
/// cap. What a run leaves is fetched by the next one
/// ([`moneybird_attachment_backlog`]).
pub const MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET: i64 = 250;
pub const STRIPE_PDF_DOWNLOAD_BUDGET: i64 = 30;

/// `IngestCounts` + `errorSamples`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IngestResult {
    pub created: u64,
    pub modified: u64,
    pub skipped: u64,
    pub deleted: u64,
    pub failed: u64,
    pub error_samples: Vec<(String, String)>,
}

impl IngestResult {
    pub fn add(&mut self, other: &Self) {
        self.created += other.created;
        self.modified += other.modified;
        self.skipped += other.skipped;
        self.deleted += other.deleted;
        self.failed += other.failed;
    }

    pub fn counts_json(&self) -> Value {
        json!({
            "created": self.created,
            "modified": self.modified,
            "skipped": self.skipped,
            "deleted": self.deleted,
            "failed": self.failed,
        })
    }

    pub fn samples_json(&self) -> Value {
        Value::Array(
            self.error_samples
                .iter()
                .map(|(id, message)| json!({ "externalId": id, "message": message }))
                .collect(),
        )
    }
}

/// Moneybird PDF / attachment copies (`MoneybirdAttachmentSyncContext`).
pub struct MoneybirdFiles {
    pub client: Moneybird,
    pub storage: Arc<dyn DynFileStore>,
    pub workspace_id: String,
    pub budget: Arc<AtomicI64>,
}

/// Stripe invoice PDF copies (`StripeInvoicePdfContext`).
pub struct StripeFiles {
    pub client: Stripe,
    pub storage: Arc<dyn DynFileStore>,
    pub workspace_id: String,
    pub budget: Arc<AtomicI64>,
}

/// `IngestArgs`.
pub struct IngestArgs<'a> {
    pub db: &'a PgPool,
    pub http: Option<&'a OutboundHttp>,
    pub events: &'a EntityEventPublisher,
    pub connection_id: &'a str,
    pub provider: &'a str,
    pub display_name: Option<&'a str>,
    pub store_url: Option<&'a str>,
    /// The catalog sync definition (`ConnectorSyncDef`).
    pub sync: &'a Value,
    pub records: Vec<Value>,
    pub owner_id: &'a str,
    /// What events are stamped with (the Clerk org id) and R2 keys use.
    pub workspace_id: &'a str,
    pub entity_id: Option<&'a str>,
    pub force_deleted: bool,
    pub moneybird_files: Option<&'a MoneybirdFiles>,
    pub stripe_files: Option<&'a StripeFiles>,
    pub skip_financial_account_ids: &'a [String],
}

impl IngestArgs<'_> {
    fn internal_entity(&self) -> &str {
        self.sync["internalEntity"].as_str().unwrap_or_default()
    }

    fn external_type(&self) -> &str {
        self.sync["externalEntityType"].as_str().unwrap_or_default()
    }
}

/// What a record handler failed with: its message (sanitised for samples).
#[derive(Debug)]
struct Failure(String);

/// A transaction's own `BEGIN` / `COMMIT`.
impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::from(weldsuite_db::orm_error(error))
    }
}

/// The database's own message (no driver prefix), else the error's text.
impl From<DbErr> for Failure {
    fn from(error: DbErr) -> Self {
        Self(weldsuite_commerce_domain::db::message_of(&error))
    }
}

type Outcome<T> = Result<T, Failure>;

// ── checksums ───────────────────────────────────────────────────────────────

fn json_number(n: &serde_json::Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    n.as_f64().map_or_else(|| n.to_string(), number_text)
}

/// `stableStringify(value)`: keys sorted, numbers as JavaScript prints them.
pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => json_number(n),
        Value::String(s) => Value::String(s.clone()).to_string(),
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(stable_stringify)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let parts: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), stable_stringify(&map[k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// The version of the Moneybird mapping that a stored checksum was taken
/// with: bumping it makes the next full sync re-apply the mapping to every
/// record once (an unchanged checksum skips the record).
const MONEYBIRD_MAPPER_VERSION: &str = "moneybird-2";

/// `ingestChecksum(provider, record)`: [`record_checksum`], over a Moneybird
/// record with [`MONEYBIRD_MAPPER_VERSION`] added as `__mapperVersion`.
fn ingest_checksum(provider: &str, record: &Value) -> String {
    if provider == "moneybird"
        && let Some(object) = record.as_object()
    {
        let mut versioned = object.clone();
        versioned.insert(
            "__mapperVersion".to_owned(),
            json!(MONEYBIRD_MAPPER_VERSION),
        );
        return record_checksum(&Value::Object(versioned));
    }
    record_checksum(record)
}

/// `recordChecksum(record)`: SHA-256 hex of [`stable_stringify`].
pub fn record_checksum(record: &Value) -> String {
    hex::encode(Sha256::digest(stable_stringify(record).as_bytes()))
}

/// `sanitiseErrorMessage(err)`.
pub fn sanitise_error_message(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    // `)=(…)` → `)=(redacted)`.
    while let Some(at) = rest.find(")=(") {
        out.push_str(&rest[..at + 3]);
        let after = &rest[at + 3..];
        match after.find(')') {
            Some(end) => {
                out.push_str("redacted)");
                rest = &after[end + 1..];
            }
            None => {
                rest = after;
                break;
            }
        }
    }
    out.push_str(rest);
    let mut quoted = String::new();
    let mut chars = out.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' {
            let collected: String = chars.clone().take_while(|c| *c != '\'').collect();
            let closes = chars.clone().nth(collected.chars().count()) == Some('\'');
            if closes {
                for _ in 0..=collected.chars().count() {
                    chars.next();
                }
                quoted.push_str("'redacted'");
                continue;
            }
        }
        quoted.push(c);
    }
    crate::mappers::slice_units(&quoted, MAX_ERROR_MESSAGE_LENGTH)
}

// ── shared writes ───────────────────────────────────────────────────────────

fn has_invalid_date(values: &Map<String, Value>) -> bool {
    values.values().any(|v| v.as_str() == Some(INVALID_DATE))
}

fn check_dates(values: &Map<String, Value>) -> Outcome<()> {
    if has_invalid_date(values) {
        Err(Failure("Invalid time value".to_owned()))
    } else {
        Ok(())
    }
}

struct MappingRow {
    id: String,
    internal_id: String,
    checksum: Option<String>,
}

async fn find_mapping(
    db: &PgPool,
    connection_id: &str,
    external_type: &str,
    external_id: &str,
) -> Result<Option<MappingRow>, DbErr> {
    let row: Option<(String, String, Option<String>)> = mappings::Entity::find()
        .select_only()
        .columns([
            mappings::Column::Id,
            mappings::Column::InternalEntityId,
            mappings::Column::SyncChecksum,
        ])
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(external_type))
        .filter(mappings::Column::ExternalEntityId.eq(external_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.map(|(id, internal_id, checksum)| MappingRow {
        id,
        internal_id,
        checksum,
    }))
}

async fn insert_mapping<C: ConnectionTrait>(
    db: &C,
    connection_id: &str,
    external_type: &str,
    external_id: &str,
    internal_type: &str,
    internal_id: &str,
    checksum: &str,
) -> Result<(), DbErr> {
    mappings::Entity::insert(mappings::ActiveModel {
        id: Set(generate_id("iem")),
        connection_id: Set(connection_id.to_owned()),
        external_entity_type: Set(external_type.to_owned()),
        external_entity_id: Set(external_id.to_owned()),
        internal_entity_type: Set(internal_type.to_owned()),
        internal_entity_id: Set(internal_id.to_owned()),
        last_synced_at: Set(Some(utc_now())),
        sync_checksum: Set(Some(checksum.to_owned())),
        ..Default::default()
    })
    .exec_without_returning(db)
    .await
    .map(|_| ())
}

async fn touch_mapping<C: ConnectionTrait>(
    db: &C,
    mapping_id: &str,
    checksum: Option<&str>,
) -> Result<(), DbErr> {
    let now = utc_now();
    mappings::Entity::update_many()
        .set(mappings::ActiveModel {
            sync_checksum: Set(checksum.map(str::to_owned)),
            last_synced_at: Set(Some(now)),
            updated_at: Set(now),
            ..Default::default()
        })
        .filter(mappings::Column::Id.eq(mapping_id))
        .exec(db)
        .await
        .map(|_| ())
}

fn with(values: &Map<String, Value>, extra: &[(&str, Value)]) -> Map<String, Value> {
    let mut out = values.clone();
    for (k, v) in extra {
        out.insert((*k).to_owned(), v.clone());
    }
    out
}

/// `db.update(table).set(values).where(eq(table.id, id))`.
async fn patch(
    db: impl Into<TableDb<'_>>,
    table: &Table,
    id: &str,
    values: &Map<String, Value>,
) -> Result<(), DbErr> {
    let columns = table.values(values);
    if columns.is_empty() {
        return Ok(());
    }
    table.patch_raw(db, id, columns, false).await.map(|_| ())
}

/// `db.insert(table).values(values)`.
async fn insert(
    db: impl Into<TableDb<'_>>,
    table: &Table,
    values: &Map<String, Value>,
) -> Result<(), DbErr> {
    table.insert_raw(db, table.values(values)).await.map(|_| ())
}

/// `upsertByMapping(...)`'s outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Created,
    Updated,
    Skipped,
}

struct Upserted {
    action: Action,
    internal_id: String,
}

struct UpsertTarget<'a> {
    table: &'a Table,
    id_prefix: &'a str,
    dedup: Option<&'a str>,
    external_type: &'a str,
    external_id: &'a str,
    internal_type: &'a str,
}

/// `dedupValue`: a truthy value of the natural key.
fn dedup_value(values: &Map<String, Value>, key: &str) -> Option<Value> {
    values.get(key).filter(|v| crate::js::truthy(v)).cloned()
}

/// `select t.id from t where t.<column> = <value> and t.deleted_at is null
/// order by t.created_at, t.id limit 1`. The natural keys are text columns,
/// and the value is compared as `jsonb_populate_record` made it one: a JSON
/// string as it is, anything else as its JSON text.
async fn find_by_natural_key(
    db: &PgPool,
    table: &Table,
    column: &str,
    value: &Value,
) -> Result<Option<String>, DbErr> {
    use sea_orm::ExprTrait as _;
    let (Some(key), Some(id)) = (table.entity.column(column), table.entity.column("id")) else {
        return Ok(None);
    };
    let text = value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned);
    let mut select = table.entity.select();
    select
        .clear_selects()
        .expr_as(id.clone(), Alias::new("id"))
        .and_where(key.eq(text));
    if let Some(deleted_at) = table.entity.column("deleted_at") {
        select.and_where(deleted_at.is_null());
    }
    if let Some(created_at) = table.entity.column("created_at") {
        select.order_by_expr(created_at, Order::Asc);
    }
    select.order_by_expr(id, Order::Asc).limit(1);
    let row = orm(db)
        .query_one_raw(DbBackend::Postgres.build(&select))
        .await?;
    row.map(|row| row.try_get::<String>("", "id")).transpose()
}

async fn upsert_by_mapping(
    db: &PgPool,
    connection_id: &str,
    target: &UpsertTarget<'_>,
    values: &Map<String, Value>,
    checksum: &str,
) -> Outcome<Upserted> {
    if let Some(mapping) =
        find_mapping(db, connection_id, target.external_type, target.external_id).await?
    {
        if mapping.checksum.as_deref() == Some(checksum) {
            return Ok(Upserted {
                action: Action::Skipped,
                internal_id: mapping.internal_id,
            });
        }
        check_dates(values)?;
        let mut tx = db.begin().await?;
        patch(
            &mut *tx,
            target.table,
            &mapping.internal_id,
            &with(
                values,
                &[("deletedAt", Value::Null), ("updatedAt", json!(now_iso()))],
            ),
        )
        .await?;
        touch_mapping(&OrmConn::new(&mut tx), &mapping.id, Some(checksum)).await?;
        tx.commit().await?;
        return Ok(Upserted {
            action: Action::Updated,
            internal_id: mapping.internal_id,
        });
    }

    if let Some(column) = target.dedup.and_then(|prop| target.table.column(prop))
        && let Some(value) = dedup_value(values, column.prop)
    {
        let found = find_by_natural_key(db, target.table, column.name, &value).await?;
        if let Some(id) = found {
            check_dates(values)?;
            let mut tx = db.begin().await?;
            insert_mapping(
                &OrmConn::new(&mut tx),
                connection_id,
                target.external_type,
                target.external_id,
                target.internal_type,
                &id,
                checksum,
            )
            .await?;
            patch(
                &mut *tx,
                target.table,
                &id,
                &with(values, &[("updatedAt", json!(now_iso()))]),
            )
            .await?;
            tx.commit().await?;
            return Ok(Upserted {
                action: Action::Updated,
                internal_id: id,
            });
        }
    }

    check_dates(values)?;
    let new_id = generate_id(target.id_prefix);
    let mut tx = db.begin().await?;
    insert(
        &mut *tx,
        target.table,
        &with(values, &[("id", json!(new_id))]),
    )
    .await?;
    insert_mapping(
        &OrmConn::new(&mut tx),
        connection_id,
        target.external_type,
        target.external_id,
        target.internal_type,
        &new_id,
        checksum,
    )
    .await?;
    tx.commit().await?;
    Ok(Upserted {
        action: Action::Created,
        internal_id: new_id,
    })
}

async fn soft_delete_mapped(
    db: &PgPool,
    table: &Table,
    internal_id: &str,
    mapping_id: &str,
) -> Outcome<()> {
    let now = json!(now_iso());
    let mut tx = db.begin().await?;
    patch(
        &mut *tx,
        table,
        internal_id,
        &with(
            &Map::new(),
            &[("deletedAt", now.clone()), ("updatedAt", now)],
        ),
    )
    .await?;
    touch_mapping(&OrmConn::new(&mut tx), mapping_id, None).await?;
    tx.commit().await?;
    Ok(())
}

// ── events ──────────────────────────────────────────────────────────────────

/// After a Moneybird record was written: what WeldBooks has now is what
/// Moneybird has, the two-way sync's baseline (ADR INT-013). Best effort: a
/// missing baseline is set by the next push pass.
async fn moneybird_baseline(
    args: &IngestArgs<'_>,
    external_type: &str,
    external_id: &str,
    internal_id: &str,
) {
    if args.provider != "moneybird" {
        return;
    }
    if let Err(error) = crate::moneybird_push::two_way::refresh_baseline(
        args.db,
        args.connection_id,
        external_type,
        external_id,
        internal_id,
    )
    .await
    {
        tracing::warn!(%error, "[connectors/ingest] Moneybird baseline failed");
    }
}

/// After a Moneybird record was removed: nothing left to sync.
async fn moneybird_unbaseline(args: &IngestArgs<'_>, external_type: &str, external_id: &str) {
    if args.provider != "moneybird" {
        return;
    }
    if let Err(error) = crate::moneybird_push::two_way::drop_baseline(
        args.db,
        args.connection_id,
        external_type,
        external_id,
    )
    .await
    {
        tracing::warn!(%error, "[connectors/ingest] Moneybird baseline cleanup failed");
    }
}

/// A bill WeldBooks sent to Moneybird keeps its WeldBooks status while
/// Moneybird still calls it new (which reads as a draft and would undo the
/// approval).
async fn keep_pushed_bill_status(
    args: &IngestArgs<'_>,
    external_id: &str,
    mut values: Map<String, Value>,
) -> Result<Map<String, Value>, DbErr> {
    if values.get("status").and_then(Value::as_str) != Some("draft") {
        return Ok(values);
    }
    let Some(mapping) = find_mapping(
        args.db,
        args.connection_id,
        args.external_type(),
        external_id,
    )
    .await?
    else {
        return Ok(values);
    };
    // `exists (… x where x.internal_entity_id = b.id)`, with `b.id` the
    // mapped bill: WeldBooks pushed it.
    let pushed = Query::select()
        .expr(Expr::val(1))
        .from(mappings::Entity)
        .and_where(mappings::Column::ConnectionId.eq(args.connection_id))
        .and_where(
            mappings::Column::ExternalEntityType
                .eq(crate::moneybird_push::two_way::PUSHED_BILL_TYPE),
        )
        .and_where(mappings::Column::InternalEntityId.eq(mapping.internal_id.as_str()))
        .to_owned();
    let status: Option<String> = bills::Entity::find()
        .select_only()
        .column(bills::Column::Status)
        .filter(bills::Column::Id.eq(mapping.internal_id.as_str()))
        .filter(Expr::exists(pushed))
        .into_tuple()
        .one(&orm(args.db))
        .await?;
    if status.is_some_and(|s| s != "draft") {
        values.remove("status");
    }
    Ok(values)
}

async fn publish(args: &IngestArgs<'_>, entity_type: &str, action: &str, entity_id: &str) {
    let event = match EventType::catalog(entity_type, action) {
        Ok(event) => event,
        Err(error) => {
            tracing::warn!(%error, "[connectors/ingest] event not in the catalog");
            return;
        }
    };
    let context = EventContext::new(args.workspace_id, args.owner_id, EventSource::System);
    args.events
        .publish_and_wait(
            &context,
            EntityEvent::new(event, entity_id, json!({ "id": entity_id })),
        )
        .await;
}

async fn publish_upsert(args: &IngestArgs<'_>, entity_type: &str, outcome: &Upserted) {
    let action = match outcome.action {
        Action::Skipped => return,
        Action::Created => "created",
        Action::Updated => "updated",
    };
    publish(args, entity_type, action, &outcome.internal_id).await;
}

fn tally(result: &mut IngestResult, action: Action) {
    match action {
        Action::Created => result.created += 1,
        Action::Updated => result.modified += 1,
        Action::Skipped => result.skipped += 1,
    }
}

fn push_sample(result: &mut IngestResult, external_id: &str, message: String) {
    if result.error_samples.len() < MAX_ERROR_SAMPLES {
        result.error_samples.push((external_id.to_owned(), message));
    }
}

// ── catalog: products, orders, people ───────────────────────────────────────

async fn load_field_mappings(
    db: &PgPool,
    connection_id: &str,
    entity_type: &str,
) -> Result<Vec<FieldMapping>, DbErr> {
    use integration_field_mappings::Column;
    let rows: Vec<(String, String, String, String, Option<Value>)> =
        integration_field_mappings::Entity::find()
            .select_only()
            .columns([
                Column::ExternalFieldPath,
                Column::InternalFieldPath,
                Column::Direction,
                Column::TransformType,
                Column::TransformConfig,
            ])
            .filter(Column::ConnectionId.eq(connection_id))
            .filter(Column::EntityType.eq(entity_type))
            .into_tuple()
            .all(&orm(db))
            .await?;
    Ok(rows
        .into_iter()
        .map(|(e, i, d, t, c)| FieldMapping {
            external_field_path: e,
            internal_field_path: i,
            direction: d,
            transform_type: t,
            transform_config: c,
        })
        .collect())
}

fn catalog_target(
    entity: &str,
) -> (
    &'static Table,
    &'static str,
    Option<&'static str>,
    &'static str,
) {
    match entity {
        "order" => (&tables::ORDERS, "ord", Some("externalOrderId"), "order"),
        "person" => (&tables::PEOPLE, "pers", Some("email"), "person"),
        _ => (&tables::PRODUCTS, "prd", Some("sku"), "product"),
    }
}

/// An order from a store, written through `orders::write::import`
/// (ADR COM-010: the only way an order and its items change): the header as
/// mapped, the items brought in line with the store's lines without
/// replacing them, the buyer's party as counterparty once. The order, its
/// items and the mapping commit together.
async fn ingest_order(
    args: &IngestArgs<'_>,
    line_items: &[OrderLine],
    values: &Map<String, Value>,
    record: &Value,
    external_id: &str,
) -> Outcome<Upserted> {
    let checksum = record_checksum(record);
    let mapping = find_mapping(
        args.db,
        args.connection_id,
        args.external_type(),
        external_id,
    )
    .await?;
    if let Some(mapping) = &mapping
        && mapping.checksum.as_deref() == Some(checksum.as_str())
    {
        return Ok(Upserted {
            action: Action::Skipped,
            internal_id: mapping.internal_id.clone(),
        });
    }
    check_dates(values)?;
    // The order this store order is: its mapping, else an order already
    // there with the same external id that no other connection imported
    // (two stores of one provider may both have an order 1001), else a new one.
    let mut found = mapping.as_ref().map(|m| m.internal_id.clone());
    if found.is_none()
        && let Some(external) = dedup_value(values, "externalOrderId")
    {
        // `not exists (… where m.internal_entity_id = o.id …)`: the mapped id
        // is never null.
        found = orders::Entity::find()
            .select_only()
            .column(orders::Column::Id)
            .filter(
                orders::Column::ExternalOrderId.eq(external
                    .as_str()
                    .map_or_else(|| external.to_string(), str::to_owned)),
            )
            .filter(orders::Column::DeletedAt.is_null())
            .filter(
                orders::Column::Id.not_in_subquery(
                    Query::select()
                        .column(mappings::Column::InternalEntityId)
                        .from(mappings::Entity)
                        .and_where(mappings::Column::ConnectionId.ne(args.connection_id))
                        .to_owned(),
                ),
            )
            .order_by_asc(orders::Column::CreatedAt)
            .order_by_asc(orders::Column::Id)
            .into_tuple()
            .one(&orm(args.db))
            .await?;
    }
    let product_type = format!("{}_product", args.provider);
    let mut lines = Vec::with_capacity(line_items.len());
    for line in line_items {
        let product_id = match &line.external_product_id {
            Some(id) => find_mapping(args.db, args.connection_id, &product_type, id)
                .await?
                .map(|m| m.internal_id),
            None => None,
        };
        lines.push(ImportLine {
            external_line_id: line.external_line_id.clone(),
            product_id,
            sku: line.sku.clone(),
            name: line.name.clone(),
            quantity: line.quantity,
            unit_price: line.unit_price.clone(),
            total: line.total.clone(),
            image_url: line.image_url.clone(),
        });
    }
    let existing = found.is_some();
    let order_id = found.unwrap_or_else(|| generate_id("ord"));
    let mut tx = args.db.begin().await?;
    // The order belongs to its store connection's sales channel (ADR COM-011).
    let store_name = args
        .display_name
        .or(args.store_url)
        .map_or_else(|| provider_label(args.provider), str::to_owned);
    let channel = ensure_connector(
        &mut tx,
        &Connector {
            connection_id: args.connection_id,
            provider: args.provider,
            name: &store_name,
            currency: values
                .get("currency")
                .and_then(Value::as_str)
                .unwrap_or("EUR"),
        },
    )
    .await?;
    let mut header = values.clone();
    header.insert("channelId".to_owned(), json!(channel.id));
    import(
        &mut tx,
        &Import {
            id: &order_id,
            existing,
            header,
            lines: &lines,
            person_id: values.get("personId").and_then(Value::as_str),
            owner_id: args.owner_id,
        },
    )
    .await?;
    match &mapping {
        Some(mapping) => {
            touch_mapping(&OrmConn::new(&mut tx), &mapping.id, Some(checksum.as_str())).await?;
        }
        None => {
            insert_mapping(
                &OrmConn::new(&mut tx),
                args.connection_id,
                args.external_type(),
                external_id,
                "order",
                &order_id,
                &checksum,
            )
            .await?;
        }
    }
    tx.commit().await?;
    // A store's channel, made here with its first order, publishes no
    // `commerce_channel` event: a sync answers with the same events as the
    // TypeScript ingest, which has no channels (the "connect: integrations"
    // conformance suite). The channels list reads it fresh when opened.
    Ok(Upserted {
        action: if existing {
            Action::Updated
        } else {
            Action::Created
        },
        internal_id: order_id,
    })
}

fn variant_fields(variant: &ProductVariant) -> Map<String, Value> {
    let options: Option<Vec<Value>> = variant.option_values.as_ref().map(|values| {
        values
            .iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect()
    });
    let name = variant
        .name
        .as_deref()
        .map(weldsuite_kit::validation::js_trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            variant.option_values.as_ref().map(|values| {
                values
                    .iter()
                    .map(|(_, v)| v.as_str())
                    .collect::<Vec<_>>()
                    .join(" / ")
            })
        })
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Variant".to_owned());
    let mut out = Map::new();
    out.insert("name".to_owned(), json!(name));
    out.insert("sku".to_owned(), json!(variant.sku));
    out.insert("price".to_owned(), json!(variant.price));
    out.insert(
        "inventoryQuantity".to_owned(),
        crate::js::number_value(variant.inventory_quantity.unwrap_or(0.0)),
    );
    out.insert("trackInventory".to_owned(), json!(variant.track_inventory));
    out.insert("optionValues".to_owned(), json!(options));
    out.insert(
        "status".to_owned(),
        json!(if variant.status.is_empty() {
            "active"
        } else {
            variant.status.as_str()
        }),
    );
    out.insert(
        "position".to_owned(),
        crate::js::number_value(variant.position),
    );
    out.insert(
        "attributes".to_owned(),
        json!({ "externalId": variant.external_id }),
    );
    out.insert("updatedAt".to_owned(), json!(now_iso()));
    out
}

async fn upsert_product_variants(
    db: &PgPool,
    product_id: &str,
    variants: &[ProductVariant],
) -> Outcome<()> {
    let existing: Vec<(String, Option<String>, Option<Value>)> = product_variants::Entity::find()
        .select_only()
        .columns([
            product_variants::Column::Id,
            product_variants::Column::Sku,
            product_variants::Column::Attributes,
        ])
        .filter(product_variants::Column::ProductId.eq(product_id))
        .filter(product_variants::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    // bySku / byExternal, later rows winning as `Map.set` does.
    let mut by_sku: Vec<(String, String)> = Vec::new();
    let mut by_external: Vec<(String, String)> = Vec::new();
    let set = |list: &mut Vec<(String, String)>, key: String, id: String| match list
        .iter_mut()
        .find(|(k, _)| *k == key)
    {
        Some(entry) => entry.1 = id,
        None => list.push((key, id)),
    };
    for (id, sku, attributes) in existing {
        if let Some(sku) = sku.filter(|s| !s.is_empty()) {
            set(&mut by_sku, sku, id.clone());
        }
        if let Some(external) = attributes
            .as_ref()
            .and_then(|a| a.get("externalId"))
            .and_then(Value::as_str)
            .filter(|e| !e.is_empty())
        {
            set(&mut by_external, external.to_owned(), id);
        }
    }
    for variant in variants {
        let sku = variant.sku.as_deref().filter(|s| !s.is_empty());
        let matched = sku
            .and_then(|s| by_sku.iter().find(|(k, _)| k == s))
            .or_else(|| by_external.iter().find(|(k, _)| *k == variant.external_id))
            .map(|(_, id)| id.clone());
        let fields = variant_fields(variant);
        let id = match matched {
            Some(id) => {
                patch(db, &tables::PRODUCT_VARIANTS, &id, &fields).await?;
                id
            }
            None => {
                let id = generate_id("pvr");
                insert(
                    db,
                    &tables::PRODUCT_VARIANTS,
                    &with(
                        &fields,
                        &[("id", json!(id)), ("productId", json!(product_id))],
                    ),
                )
                .await?;
                id
            }
        };
        if let Some(sku) = sku {
            set(&mut by_sku, sku.to_owned(), id.clone());
        }
        set(&mut by_external, variant.external_id.clone(), id);
    }
    let mut values = Map::new();
    values.insert("hasVariants".to_owned(), json!(true));
    values.insert("variantCount".to_owned(), json!(variants.len()));
    values.insert("updatedAt".to_owned(), json!(now_iso()));
    patch(db, &tables::PRODUCTS, product_id, &values).await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)] // `upsertSalesChannel`'s arguments
async fn upsert_sales_channel(
    args: &IngestArgs<'_>,
    product_id: &str,
    external_id: &str,
    external_url: Option<String>,
    price: Option<String>,
    listing_status: Option<&str>,
) -> Outcome<()> {
    let now = json!(now_iso());
    let listing = listing_status
        .filter(|status| matches!(*status, "active" | "inactive" | "draft"))
        .unwrap_or("active");
    let existing: Option<String> = product_sales_channels::Entity::find()
        .select_only()
        .column(product_sales_channels::Column::Id)
        .filter(product_sales_channels::Column::ConnectionId.eq(args.connection_id))
        .filter(product_sales_channels::Column::ExternalId.eq(external_id))
        .into_tuple()
        .one(&orm(args.db))
        .await?;
    let mut values = Map::new();
    values.insert("productId".to_owned(), json!(product_id));
    values.insert("displayName".to_owned(), json!(args.display_name));
    values.insert("externalUrl".to_owned(), json!(external_url));
    values.insert("status".to_owned(), json!("active"));
    values.insert("listingStatus".to_owned(), json!(listing));
    values.insert("lastSyncedAt".to_owned(), now.clone());
    match existing {
        Some(id) => {
            if let Some(price) = price {
                values.insert("price".to_owned(), json!(price));
            }
            values.insert("updatedAt".to_owned(), now);
            patch(args.db, &tables::PRODUCT_SALES_CHANNELS, &id, &values).await?;
        }
        None => {
            values.insert("id".to_owned(), json!(generate_id("psch")));
            values.insert("connectionId".to_owned(), json!(args.connection_id));
            values.insert("provider".to_owned(), json!(args.provider));
            values.insert("externalId".to_owned(), json!(external_id));
            values.insert("price".to_owned(), json!(price));
            insert(args.db, &tables::PRODUCT_SALES_CHANNELS, &values).await?;
        }
    }
    Ok(())
}

async fn delete_catalog_record(
    args: &IngestArgs<'_>,
    table: &Table,
    entity_type: &str,
    external_id: &str,
    result: &mut IngestResult,
) -> Outcome<()> {
    let Some(mapping) = find_mapping(
        args.db,
        args.connection_id,
        args.external_type(),
        external_id,
    )
    .await?
    else {
        result.skipped += 1;
        return Ok(());
    };
    let product = args.internal_entity() == "product";
    if product {
        let now = utc_now();
        product_sales_channels::Entity::update_many()
            .col_expr(
                product_sales_channels::Column::Status,
                Expr::value("deleted_remote"),
            )
            .col_expr(product_sales_channels::Column::UpdatedAt, Expr::value(now))
            .col_expr(
                product_sales_channels::Column::LastSyncedAt,
                Expr::value(now),
            )
            .filter(product_sales_channels::Column::ConnectionId.eq(args.connection_id))
            .filter(product_sales_channels::Column::ExternalId.eq(external_id))
            .exec(&orm(args.db))
            .await?;
    }
    // A product listed on another channel stays; only the last channel removes it.
    let still_listed = product
        && product_sales_channels::Entity::find()
            .filter(product_sales_channels::Column::ProductId.eq(mapping.internal_id.as_str()))
            .filter(product_sales_channels::Column::Status.eq("active"))
            .count(&orm(args.db))
            .await?
            > 0;
    if !still_listed {
        soft_delete_mapped(args.db, table, &mapping.internal_id, &mapping.id).await?;
    }
    result.deleted += 1;
    moneybird_unbaseline(args, args.external_type(), external_id).await;
    publish(args, entity_type, "deleted", &mapping.internal_id).await;
    Ok(())
}

async fn ingest_catalog_record(
    args: &IngestArgs<'_>,
    record: &Value,
    external_id: &str,
    mappings: &[FieldMapping],
    result: &mut IngestResult,
) -> Outcome<()> {
    let (table, prefix, dedup, entity_type) = catalog_target(args.internal_entity());
    if is_deleted_record(record, args.force_deleted) {
        return delete_catalog_record(args, table, entity_type, external_id, result).await;
    }
    let Some(mapped) =
        map_with_field_mappings(args.internal_entity(), record, args.provider, mappings)
    else {
        result.skipped += 1;
        return Ok(());
    };
    let mut values = match &mapped {
        Mapped::Product { values, .. }
        | Mapped::Order { values, .. }
        | Mapped::Person { values, .. }
        | Mapped::Party { values, .. }
        | Mapped::Document { values, .. }
        | Mapped::BankAccount { values, .. }
        | Mapped::BankTransaction { values, .. }
        | Mapped::Wms { values, .. } => values.clone(),
    };
    match &mapped {
        Mapped::Person { .. } => {
            values.insert("ownerId".to_owned(), json!(args.owner_id));
        }
        Mapped::Product { .. } | Mapped::Order { .. }
            if values.get("createdBy").is_none_or(Value::is_null) =>
        {
            values.insert("createdBy".to_owned(), json!(args.owner_id));
        }
        _ => {}
    }
    if let Mapped::Order {
        customer_external_id: Some(customer),
        ..
    } = &mapped
        && let Some(found) = find_mapping(
            args.db,
            args.connection_id,
            &format!("{}_customer", args.provider),
            customer,
        )
        .await?
    {
        values.insert("personId".to_owned(), json!(found.internal_id));
    }
    if let Mapped::Order { line_items, .. } = &mapped {
        let outcome = ingest_order(args, line_items, &values, record, external_id).await?;
        tally(result, outcome.action);
        publish_upsert(args, entity_type, &outcome).await;
        return Ok(());
    }
    let checksum = ingest_checksum(args.provider, record);
    let outcome = upsert_by_mapping(
        args.db,
        args.connection_id,
        &UpsertTarget {
            table,
            id_prefix: prefix,
            dedup,
            external_type: args.external_type(),
            external_id,
            internal_type: entity_type,
        },
        &values,
        &checksum,
    )
    .await?;
    if let Mapped::Product {
        external_url,
        values: product_values,
        variants,
        ..
    } = &mapped
    {
        let permalink = external_url.clone().or_else(|| {
            let store = args.store_url.filter(|s| !s.is_empty())?;
            Some(if args.provider == "shopify" {
                let slug = product_values.get("slug").map_or_else(String::new, |s| {
                    if s.is_null() {
                        String::new()
                    } else {
                        as_text(s)
                    }
                });
                format!("{store}/products/{slug}")
            } else {
                format!("{store}/?p={external_id}")
            })
        });
        let price = product_values
            .get("price")
            .filter(|p| !p.is_null())
            .map(as_text);
        upsert_sales_channel(
            args,
            &outcome.internal_id,
            external_id,
            permalink,
            price,
            product_values.get("status").and_then(Value::as_str),
        )
        .await?;
        if let Some(variants) = variants.as_ref().filter(|v| !v.is_empty())
            && outcome.action != Action::Skipped
        {
            upsert_product_variants(args.db, &outcome.internal_id, variants).await?;
        }
        if outcome.action != Action::Skipped {
            moneybird_baseline(
                args,
                args.external_type(),
                external_id,
                &outcome.internal_id,
            )
            .await;
        }
    }
    tally(result, outcome.action);
    publish_upsert(args, entity_type, &outcome).await;
    Ok(())
}

// ── accounting: parties, invoices, bills ────────────────────────────────────

/// `partySyncExternalType(provider)`.
fn party_external_type(provider: &str) -> String {
    let connector = get_connector(provider);
    connector
        .and_then(|c| {
            syncs(c)
                .iter()
                .find(|s| s["internalEntity"] == "party")
                .and_then(|s| s["externalEntityType"].as_str().map(str::to_owned))
                .or_else(|| c["contactExternalEntityType"].as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| format!("{provider}_contact"))
}

fn provider_label(provider: &str) -> String {
    get_connector(provider)
        .and_then(|c| c["label"].as_str().map(str::to_owned))
        .unwrap_or_else(|| provider.to_owned())
}

fn sync_external_type(provider: &str, entity: &str, fallback: &str) -> String {
    get_connector(provider)
        .and_then(|c| {
            syncs(c)
                .iter()
                .find(|s| s["internalEntity"] == entity)
                .and_then(|s| s["externalEntityType"].as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| fallback.to_owned())
}

async fn upsert_party(
    args: &IngestArgs<'_>,
    external_id: &str,
    kind: &str,
    identity: &Map<String, Value>,
    party_values: &Map<String, Value>,
    checksum: &str,
) -> Outcome<Upserted> {
    let external_type = party_external_type(args.provider);
    let identity_table = if kind == "company" {
        &tables::COMPANIES
    } else {
        &tables::PEOPLE
    };
    let identity_values = with(
        identity,
        &[
            ("ownerId", json!(args.owner_id)),
            ("updatedAt", json!(now_iso())),
        ],
    );
    let mapping = find_mapping(args.db, args.connection_id, &external_type, external_id).await?;
    if let Some(mapping) = mapping {
        let current: Option<Option<String>> = mappings::Entity::find()
            .select_only()
            .column(mappings::Column::SyncChecksum)
            .filter(mappings::Column::Id.eq(mapping.id.as_str()))
            .into_tuple()
            .one(&orm(args.db))
            .await?;
        if current.flatten().as_deref() == Some(checksum) {
            return Ok(Upserted {
                action: Action::Skipped,
                internal_id: mapping.internal_id,
            });
        }
        let party = party_identities(args.db, &mapping.internal_id).await?;
        let identity_id =
            party.and_then(|(company, person)| if kind == "company" { company } else { person });
        check_dates(party_values)?;
        let mut tx = args.db.begin().await?;
        if let Some(identity_id) = &identity_id {
            patch(
                &mut *tx,
                identity_table,
                identity_id,
                &with(&identity_values, &[("deletedAt", Value::Null)]),
            )
            .await?;
        }
        patch(
            &mut *tx,
            &tables::PARTIES,
            &mapping.internal_id,
            &with(
                party_values,
                &[("deletedAt", Value::Null), ("updatedAt", json!(now_iso()))],
            ),
        )
        .await?;
        touch_mapping(&OrmConn::new(&mut tx), &mapping.id, Some(checksum)).await?;
        tx.commit().await?;
        return Ok(Upserted {
            action: Action::Updated,
            internal_id: mapping.internal_id,
        });
    }

    // The identity: by email, then (companies) by VAT number, else created.
    let email = identity.get("email").and_then(Value::as_str);
    let vat = identity.get("vatNumber").and_then(Value::as_str);
    let mut existing: Option<String> = None;
    let db = &orm(args.db);
    if let Some(email) = email {
        existing = if kind == "company" {
            companies::Entity::find()
                .select_only()
                .column(companies::Column::Id)
                .filter(companies::Column::Email.eq(email))
                .filter(companies::Column::DeletedAt.is_null())
                .order_by_asc(companies::Column::CreatedAt)
                .order_by_asc(companies::Column::Id)
                .into_tuple()
                .one(db)
                .await?
        } else {
            people::Entity::find()
                .select_only()
                .column(people::Column::Id)
                .filter(people::Column::Email.eq(email))
                .filter(people::Column::DeletedAt.is_null())
                .order_by_asc(people::Column::CreatedAt)
                .order_by_asc(people::Column::Id)
                .into_tuple()
                .one(db)
                .await?
        };
    }
    if existing.is_none()
        && kind == "company"
        && let Some(vat) = vat
    {
        existing = companies::Entity::find()
            .select_only()
            .column(companies::Column::Id)
            .filter(companies::Column::VatNumber.eq(vat))
            .filter(companies::Column::DeletedAt.is_null())
            .order_by_asc(companies::Column::CreatedAt)
            .order_by_asc(companies::Column::Id)
            .into_tuple()
            .one(db)
            .await?;
    }
    let identity_id = match existing {
        Some(id) => {
            patch(
                args.db,
                identity_table,
                &id,
                &with(&identity_values, &[("deletedAt", Value::Null)]),
            )
            .await?;
            id
        }
        None => {
            let id = generate_id(if kind == "company" {
                "company"
            } else {
                "person"
            });
            let display = identity
                .get("displayName")
                .filter(|v| !v.is_null())
                .or_else(|| party_values.get("displayName").filter(|v| !v.is_null()))
                .map_or_else(|| "Contact".to_owned(), as_text);
            let mut values = Map::new();
            values.insert("id".to_owned(), json!(id));
            values.insert("displayName".to_owned(), json!(display));
            for (k, v) in &identity_values {
                values.insert(k.clone(), v.clone());
            }
            insert(args.db, identity_table, &values).await?;
            id
        }
    };

    // The party wrapping it: found, else created.
    let wrapping: Option<String> = parties::Entity::find()
        .select_only()
        .column(parties::Column::Id)
        .filter(if kind == "company" {
            parties::Column::CompanyId.eq(identity_id.as_str())
        } else {
            parties::Column::PersonId.eq(identity_id.as_str())
        })
        .filter(parties::Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await?;
    check_dates(party_values)?;
    let (party_id, created) = match wrapping {
        Some(id) => {
            patch(
                args.db,
                &tables::PARTIES,
                &id,
                &with(
                    party_values,
                    &[("deletedAt", Value::Null), ("updatedAt", json!(now_iso()))],
                ),
            )
            .await?;
            (id, false)
        }
        None => {
            let id = generate_id("party");
            let mut values = Map::new();
            values.insert("id".to_owned(), json!(id));
            values.insert("kind".to_owned(), json!(kind));
            values.insert(
                "companyId".to_owned(),
                if kind == "company" {
                    json!(identity_id)
                } else {
                    Value::Null
                },
            );
            values.insert(
                "personId".to_owned(),
                if kind == "person" {
                    json!(identity_id)
                } else {
                    Value::Null
                },
            );
            values.insert("ownerId".to_owned(), json!(args.owner_id));
            for (k, v) in party_values {
                values.insert(k.clone(), v.clone());
            }
            insert(args.db, &tables::PARTIES, &values).await?;
            (id, true)
        }
    };
    insert_mapping(
        db,
        args.connection_id,
        &external_type,
        external_id,
        "party",
        &party_id,
        checksum,
    )
    .await?;
    Ok(Upserted {
        action: if created {
            Action::Created
        } else {
            Action::Updated
        },
        internal_id: party_id,
    })
}

/// `select company_id, person_id from parties where id = $1 limit 1`.
async fn party_identities(
    db: &PgPool,
    party_id: &str,
) -> Result<Option<(Option<String>, Option<String>)>, DbErr> {
    parties::Entity::find()
        .select_only()
        .columns([parties::Column::CompanyId, parties::Column::PersonId])
        .filter(parties::Column::Id.eq(party_id))
        .into_tuple()
        .one(&orm(db))
        .await
}

async fn soft_delete_party(db: &PgPool, party_id: &str, mapping_id: &str) -> Outcome<()> {
    let party = party_identities(db, party_id).await?;
    let now: PrimitiveDateTime = utc_now();
    let mut tx = db.begin().await?;
    {
        let conn = OrmConn::new(&mut tx);
        parties::Entity::update_many()
            .col_expr(parties::Column::DeletedAt, Expr::value(now))
            .col_expr(parties::Column::UpdatedAt, Expr::value(now))
            .filter(parties::Column::Id.eq(party_id))
            .exec(&conn)
            .await?;
        touch_mapping(&conn, mapping_id, None).await?;
        if let Some((company, person)) = party {
            if let Some(company) = company {
                companies::Entity::update_many()
                    .col_expr(companies::Column::DeletedAt, Expr::value(now))
                    .col_expr(companies::Column::UpdatedAt, Expr::value(now))
                    .filter(companies::Column::Id.eq(company))
                    .exec(&conn)
                    .await?;
            }
            if let Some(person) = person {
                people::Entity::update_many()
                    .col_expr(people::Column::DeletedAt, Expr::value(now))
                    .col_expr(people::Column::UpdatedAt, Expr::value(now))
                    .filter(people::Column::Id.eq(person))
                    .exec(&conn)
                    .await?;
            }
        }
    }
    tx.commit().await?;
    Ok(())
}

async fn resolve_contact_id(
    args: &IngestArgs<'_>,
    contact_external_id: Option<&str>,
    nested: Option<&Value>,
) -> Outcome<Option<String>> {
    let external_type = party_external_type(args.provider);
    if let Some(id) = contact_external_id
        && let Some(found) = find_mapping(args.db, args.connection_id, &external_type, id).await?
    {
        return Ok(Some(found.internal_id));
    }
    let Some(contact) = nested else {
        return Ok(None);
    };
    let Some(Mapped::Party {
        external_id,
        kind,
        identity,
        values,
    }) = map_connector_record("party", contact, args.provider)
    else {
        return Ok(None);
    };
    let checksum = record_checksum(contact);
    let outcome = Box::pin(upsert_party(
        args,
        &external_id,
        kind,
        &identity,
        &values,
        &checksum,
    ))
    .await?;
    Ok(Some(outcome.internal_id))
}

async fn replace_document_items(
    args: &IngestArgs<'_>,
    entity_id: &str,
    parent_id: &str,
    invoice: bool,
    items: &[DocumentLine],
) -> Outcome<()> {
    if invoice {
        invoice_items::Entity::delete_many()
            .filter(invoice_items::Column::InvoiceId.eq(parent_id))
            .exec(&orm(args.db))
            .await?;
    } else {
        bill_items::Entity::delete_many()
            .filter(bill_items::Column::BillId.eq(parent_id))
            .exec(&orm(args.db))
            .await?;
    }
    let product_type = sync_external_type(
        args.provider,
        "product",
        &format!("{}_product", args.provider),
    );
    for item in items {
        let product_id = match &item.external_product_id {
            Some(id) => find_mapping(args.db, args.connection_id, &product_type, id)
                .await?
                .map(|m| m.internal_id),
            None => None,
        };
        let mut values = Map::new();
        values.insert(
            "id".to_owned(),
            json!(generate_id(if invoice { "ili" } else { "bli" })),
        );
        values.insert("entityId".to_owned(), json!(entity_id));
        values.insert(
            if invoice { "invoiceId" } else { "billId" }.to_owned(),
            json!(parent_id),
        );
        values.insert("description".to_owned(), json!(item.description));
        values.insert("quantity".to_owned(), json!(item.quantity));
        values.insert("unitPrice".to_owned(), json!(item.unit_price));
        values.insert("taxRate".to_owned(), json!(item.tax_rate));
        values.insert("taxAmount".to_owned(), json!(item.tax_amount));
        values.insert("lineTotal".to_owned(), json!(item.line_total));
        values.insert(
            "lineTotalWithTax".to_owned(),
            json!(item.line_total_with_tax),
        );
        values.insert("productId".to_owned(), json!(product_id));
        values.insert("sortOrder".to_owned(), json!(item.sort_order));
        if invoice {
            values.insert(
                "period".to_owned(),
                item.period
                    .as_ref()
                    .map_or(Value::Null, |(from, to)| json!({ "from": from, "to": to })),
            );
            insert(args.db, &tables::INVOICE_ITEMS, &values).await?;
        } else {
            insert(args.db, &tables::BILL_ITEMS, &values).await?;
        }
    }
    Ok(())
}

/// `safeFilename(name, fallback)`.
fn safe_filename(name: Option<&str>, fallback: &str) -> String {
    let raw = name.filter(|n| !n.is_empty()).unwrap_or(fallback);
    let raw = weldsuite_kit::validation::js_trim(raw);
    let raw = if raw.is_empty() { fallback } else { raw };
    let mut out = String::new();
    let mut in_run = false;
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    let sliced = crate::mappers::slice_units(&out, 180);
    if sliced.is_empty() {
        fallback.to_owned()
    } else {
        sliced
    }
}

fn take_budget(budget: &AtomicI64) -> bool {
    if budget.load(Ordering::SeqCst) <= 0 {
        return false;
    }
    budget.fetch_sub(1, Ordering::SeqCst);
    true
}

async fn put(
    storage: &Arc<dyn DynFileStore>,
    key: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> bool {
    let content_type = if content_type.is_empty() {
        "application/octet-stream"
    } else {
        content_type
    };
    storage
        .put_boxed(key, bytes, &PutOptions::content_type(content_type))
        .await
        .is_ok()
}

/// `syncMoneybirdDocumentAttachments(...)`: the stored keys, or `None` when
/// the budget ran out with nothing stored.
async fn sync_moneybird_attachments(
    files: &MoneybirdFiles,
    http: Option<&OutboundHttp>,
    external_type: &str,
    external_id: &str,
    record: &Value,
) -> Option<Vec<String>> {
    let kind = match external_type {
        "moneybird_sales_invoice" => AttachmentKind::SalesInvoice,
        "moneybird_purchase_invoice" => AttachmentKind::PurchaseInvoice,
        "moneybird_receipt" => AttachmentKind::Receipt,
        _ => return Some(Vec::new()),
    };
    let admin = if files.client.administration_id.is_empty() {
        "unknown"
    } else {
        files.client.administration_id.as_str()
    };
    let base = format!(
        "workspaces/{}/connectors/moneybird/{admin}/{external_type}/{external_id}",
        files.workspace_id
    );
    let mut keys = Vec::new();
    if kind == AttachmentKind::SalesInvoice {
        if !take_budget(&files.budget) {
            return None;
        }
        if let Ok(pdf) = files
            .client
            .download_sales_invoice_pdf(http, external_id)
            .await
        {
            let key = format!("{base}/invoice.pdf");
            if put(&files.storage, &key, pdf.bytes, &pdf.content_type).await {
                keys.push(key);
            }
        }
    }
    for item in record
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if !item.is_object() {
            continue;
        }
        let id = match item.get("id") {
            None | Some(Value::Null) => String::new(),
            Some(v) => as_text(v),
        };
        if id.is_empty() {
            continue;
        }
        let filename = item
            .get("filename")
            .and_then(Value::as_str)
            .or_else(|| item.get("name").and_then(Value::as_str));
        if !take_budget(&files.budget) {
            // Out of budget part-way: no partial list, so the document is
            // fetched again (`attachment_keys` stays as it was).
            return None;
        }
        if let Ok(download) = files
            .client
            .download_document_attachment(http, kind, external_id, &id)
            .await
        {
            let name = safe_filename(
                download
                    .filename
                    .as_deref()
                    .filter(|f| !f.is_empty())
                    .or(filename),
                &format!("attachment-{id}"),
            );
            let key = format!("{base}/attachments/{id}/{name}");
            if put(&files.storage, &key, download.bytes, &download.content_type).await {
                keys.push(key);
            }
        }
    }
    Some(keys)
}

/// `storeStripeInvoicePdf(ctx, invoice)`.
async fn store_stripe_pdf(
    files: &StripeFiles,
    http: Option<&OutboundHttp>,
    invoice: &Value,
) -> Option<Vec<String>> {
    let (Some(id), Some(url)) = (
        invoice.get("id").and_then(Value::as_str),
        invoice.get("invoice_pdf").and_then(Value::as_str),
    ) else {
        return Some(Vec::new());
    };
    if !take_budget(&files.budget) {
        return None;
    }
    let Ok(Some((bytes, content_type))) = files.client.download_invoice_pdf(http, url).await else {
        return Some(Vec::new());
    };
    let account = files.client.account_id.as_deref().unwrap_or("account");
    let key = format!(
        "workspaces/{}/connectors/stripe/{account}/stripe_invoice/{id}/invoice.pdf",
        files.workspace_id
    );
    if put(&files.storage, &key, bytes, &content_type).await {
        Some(vec![key])
    } else {
        Some(Vec::new())
    }
}

async fn attachments_unset(db: &PgPool, invoice: bool, id: &str) -> Result<bool, DbErr> {
    let keys: Option<Option<Value>> = if invoice {
        invoices::Entity::find()
            .select_only()
            .column(invoices::Column::AttachmentKeys)
            .filter(invoices::Column::Id.eq(id))
            .into_tuple()
            .one(&orm(db))
            .await?
    } else {
        bills::Entity::find()
            .select_only()
            .column(bills::Column::AttachmentKeys)
            .filter(bills::Column::Id.eq(id))
            .into_tuple()
            .one(&orm(db))
            .await?
    };
    Ok(keys.flatten().is_none_or(|k| k.is_null()))
}

/// The stored `attachment_keys` of an invoice or bill (`None`: never set).
async fn stored_attachment_keys(
    db: &PgPool,
    invoice: bool,
    id: &str,
) -> Result<Option<Value>, DbErr> {
    let keys: Option<Option<Value>> = if invoice {
        invoices::Entity::find()
            .select_only()
            .column(invoices::Column::AttachmentKeys)
            .filter(invoices::Column::Id.eq(id))
            .into_tuple()
            .one(&orm(db))
            .await?
    } else {
        bills::Entity::find()
            .select_only()
            .column(bills::Column::AttachmentKeys)
            .filter(bills::Column::Id.eq(id))
            .into_tuple()
            .one(&orm(db))
            .await?
    };
    Ok(keys.flatten().filter(|k| !k.is_null()))
}

/// `moneybirdFilesWanted(...)`: whether to (re)download a Moneybird
/// document's files. Never fetched: yes. A changed sales invoice: yes (its
/// PDF is rendered from it). A changed purchase invoice or receipt: only
/// when its attachments differ from the stored ones, so a change elsewhere
/// (or a new mapping version) does not download every file again.
async fn moneybird_files_wanted(
    args: &IngestArgs<'_>,
    invoice: bool,
    id: &str,
    changed: bool,
    record: &Value,
) -> Result<bool, DbErr> {
    let Some(stored) = stored_attachment_keys(args.db, invoice, id).await? else {
        return Ok(true);
    };
    if !changed {
        return Ok(false);
    }
    if !matches!(
        args.external_type(),
        "moneybird_purchase_invoice" | "moneybird_receipt"
    ) {
        return Ok(true);
    }
    let wanted: BTreeSet<String> = record
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| match item.get("id") {
            None | Some(Value::Null) => None,
            Some(v) => Some(as_text(v)).filter(|id| !id.is_empty()),
        })
        .collect();
    let stored: BTreeSet<String> = stored
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|key| {
            key.split_once("/attachments/")
                .and_then(|(_, rest)| rest.split('/').next())
                .map(str::to_owned)
        })
        .collect();
    Ok(wanted != stored)
}

/// `moneybirdAttachmentBacklog(db, connectionId, externalType)`: whether this
/// connection imported a Moneybird document of that type (`None`: any of
/// them) whose files were never fetched (`attachment_keys` unset): a run
/// that ran out of download budget leaves them for the next.
///
/// # Errors
///
/// The tenant database's.
pub async fn moneybird_attachment_backlog(
    db: &PgPool,
    connection_id: &str,
    external_type: Option<&str>,
) -> Result<bool, DbErr> {
    let types: Vec<&str> = match external_type {
        Some(
            t @ ("moneybird_sales_invoice" | "moneybird_purchase_invoice" | "moneybird_receipt"),
        ) => {
            vec![t]
        }
        Some(_) => return Ok(false),
        None => vec![
            "moneybird_sales_invoice",
            "moneybird_purchase_invoice",
            "moneybird_receipt",
        ],
    };
    let mapped = |types: &[&str]| {
        Query::select()
            .column(mappings::Column::InternalEntityId)
            .from(mappings::Entity)
            .and_where(mappings::Column::ConnectionId.eq(connection_id))
            .and_where(mappings::Column::ExternalEntityType.is_in(types.iter().copied()))
            .to_owned()
    };
    let sales: Vec<&str> = types
        .iter()
        .copied()
        .filter(|t| *t == "moneybird_sales_invoice")
        .collect();
    let documents: Vec<&str> = types
        .iter()
        .copied()
        .filter(|t| *t != "moneybird_sales_invoice")
        .collect();
    if !sales.is_empty()
        && invoices::Entity::find()
            .filter(invoices::Column::AttachmentKeys.is_null())
            .filter(invoices::Column::DeletedAt.is_null())
            .filter(invoices::Column::Id.in_subquery(mapped(&sales)))
            .count(&orm(db))
            .await?
            > 0
    {
        return Ok(true);
    }
    Ok(!documents.is_empty()
        && bills::Entity::find()
            .filter(bills::Column::AttachmentKeys.is_null())
            .filter(bills::Column::DeletedAt.is_null())
            .filter(bills::Column::Id.in_subquery(mapped(&documents)))
            .count(&orm(db))
            .await?
            > 0)
}

async fn set_attachment_keys(
    db: &PgPool,
    invoice: bool,
    id: &str,
    keys: &[String],
) -> Result<(), DbErr> {
    let now = utc_now();
    if invoice {
        invoices::Entity::update_many()
            .col_expr(invoices::Column::AttachmentKeys, Expr::value(json!(keys)))
            .col_expr(invoices::Column::UpdatedAt, Expr::value(now))
            .filter(invoices::Column::Id.eq(id))
            .exec(&orm(db))
            .await?;
    } else {
        bills::Entity::update_many()
            .col_expr(bills::Column::AttachmentKeys, Expr::value(json!(keys)))
            .col_expr(bills::Column::UpdatedAt, Expr::value(now))
            .filter(bills::Column::Id.eq(id))
            .exec(&orm(db))
            .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)] // `ingestDocumentRecord`'s parameters
async fn ingest_document(
    args: &IngestArgs<'_>,
    entity_id: &str,
    entity: &str,
    contact_external_id: Option<&str>,
    nested: Option<&Value>,
    document_values: &Map<String, Value>,
    lines: &[DocumentLine],
    record: &Value,
    external_id: &str,
    checksum: &str,
    result: &mut IngestResult,
) -> Outcome<()> {
    let invoice = entity == "invoice";
    // A document without any contact (one still unprocessed in Moneybird's
    // inbox) waits: it imports once it has one, as that change syncs.
    if contact_external_id.is_none_or(str::is_empty) && nested.is_none() {
        result.skipped += 1;
        return Ok(());
    }
    let Some(contact_id) = resolve_contact_id(args, contact_external_id, nested).await? else {
        return Err(Failure(
            "Invoice/bill contact is not mapped — sync contacts first".to_owned(),
        ));
    };
    let values = with(
        document_values,
        &[
            ("entityId", json!(entity_id)),
            ("contactId", json!(contact_id)),
            ("counterpartyId", json!(contact_id)),
            ("createdBy", json!(args.owner_id)),
            ("journalEntryId", Value::Null),
        ],
    );
    let values = if args.provider == "moneybird" && !invoice {
        keep_pushed_bill_status(args, external_id, values).await?
    } else {
        values
    };
    let outcome = upsert_by_mapping(
        args.db,
        args.connection_id,
        &UpsertTarget {
            table: if invoice {
                &tables::INVOICES
            } else {
                &tables::BILLS
            },
            id_prefix: if invoice { "inv" } else { "bil" },
            dedup: None,
            external_type: args.external_type(),
            external_id,
            internal_type: entity,
        },
        &values,
        checksum,
    )
    .await?;
    let changed = outcome.action != Action::Skipped;
    if changed {
        replace_document_items(args, entity_id, &outcome.internal_id, invoice, lines).await?;
        promote_accounting_role(
            args.db,
            &contact_id,
            if invoice {
                PromoteTo::Customer
            } else {
                PromoteTo::Supplier
            },
        )
        .await?;
        moneybird_baseline(
            args,
            args.external_type(),
            external_id,
            &outcome.internal_id,
        )
        .await;
        publish_upsert(args, entity, &outcome).await;
    }
    if let Some(files) = args.moneybird_files
        && args.provider == "moneybird"
        && files.budget.load(Ordering::SeqCst) > 0
        && moneybird_files_wanted(args, invoice, &outcome.internal_id, changed, record).await?
        && let Some(keys) =
            sync_moneybird_attachments(files, args.http, args.external_type(), external_id, record)
                .await
    {
        set_attachment_keys(args.db, invoice, &outcome.internal_id, &keys).await?;
    }
    if invoice
        && let Some(files) = args.stripe_files
        && args.provider == "stripe"
        && (changed || attachments_unset(args.db, true, &outcome.internal_id).await?)
        && let Some(keys) = store_stripe_pdf(files, args.http, record).await
    {
        set_attachment_keys(args.db, true, &outcome.internal_id, &keys).await?;
    }
    tally(result, outcome.action);
    Ok(())
}

/// `resolveIngestEntityId(args)`: the entity the run names, else the
/// default WeldBooks entity ([`load_default_entity_id`]).
async fn resolve_entity_id(args: &IngestArgs<'_>) -> Result<Option<String>, DbErr> {
    if let Some(id) = args.entity_id.filter(|e| !e.is_empty()) {
        return Ok(Some(id.to_owned()));
    }
    load_default_entity_id(args.db).await
}

/// `loadDefaultEntityId(db)`: the workspace's default legal entity when
/// WeldBooks is enabled for it (an `accounting_entity_settings` row), else
/// the deprecated `settings.default_entity_id` when it is. The same rule as
/// `defaultEntityIdFor(db, 'weldbooks')` of the legal entities core, without
/// depending on it. No member is involved.
async fn load_default_entity_id(db: &PgPool) -> Result<Option<String>, DbErr> {
    async fn enabled(db: &PgPool, id: &str) -> Result<bool, DbErr> {
        let row: Option<String> = accounting_entity_settings::Entity::find()
            .select_only()
            .column(accounting_entity_settings::Column::EntityId)
            .filter(accounting_entity_settings::Column::EntityId.eq(id))
            .into_tuple()
            .one(&orm(db))
            .await?;
        Ok(row.is_some())
    }
    let core: Option<String> = entities::Entity::find()
        .select_only()
        .column(entities::Column::Id)
        .filter(entities::Column::IsDefault.eq(true))
        .filter(entities::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if let Some(core) = core
        && enabled(db, &core).await?
    {
        return Ok(Some(core));
    }
    let settings: Option<Option<String>> = settings::Entity::find()
        .select_only()
        .column(settings::Column::DefaultEntityId)
        .into_tuple()
        .one(&orm(db))
        .await?;
    match settings.flatten().filter(|id| !id.is_empty()) {
        Some(id) if enabled(db, &id).await? => Ok(Some(id)),
        _ => Ok(None),
    }
}

async fn ingest_accounting_record(
    args: &IngestArgs<'_>,
    entity_id: Option<&str>,
    record: &Value,
    external_id: &str,
    mappings: &[FieldMapping],
    result: &mut IngestResult,
) -> Outcome<()> {
    if is_deleted_record(record, args.force_deleted) {
        let Some(mapping) = find_mapping(
            args.db,
            args.connection_id,
            args.external_type(),
            external_id,
        )
        .await?
        else {
            result.skipped += 1;
            return Ok(());
        };
        let entity_type = if args.internal_entity() == "party" {
            let kind: Option<Option<String>> = parties::Entity::find()
                .select_only()
                .column(parties::Column::Kind)
                .filter(parties::Column::Id.eq(mapping.internal_id.as_str()))
                .into_tuple()
                .one(&orm(args.db))
                .await?;
            let kind = kind.flatten();
            soft_delete_party(args.db, &mapping.internal_id, &mapping.id).await?;
            if kind.as_deref() == Some("person") {
                "person"
            } else {
                "company"
            }
        } else {
            let invoice = args.internal_entity() == "invoice";
            soft_delete_mapped(
                args.db,
                if invoice {
                    &tables::INVOICES
                } else {
                    &tables::BILLS
                },
                &mapping.internal_id,
                &mapping.id,
            )
            .await?;
            if invoice { "invoice" } else { "bill" }
        };
        result.deleted += 1;
        moneybird_unbaseline(args, args.external_type(), external_id).await;
        publish(args, entity_type, "deleted", &mapping.internal_id).await;
        return Ok(());
    }
    let Some(mapped) =
        map_with_field_mappings(args.internal_entity(), record, args.provider, mappings)
    else {
        result.skipped += 1;
        return Ok(());
    };
    let checksum = ingest_checksum(args.provider, record);
    match mapped {
        Mapped::Party {
            external_id: party_external_id,
            kind,
            identity,
            values,
        } => {
            let outcome = upsert_party(
                args,
                &party_external_id,
                kind,
                &identity,
                &values,
                &checksum,
            )
            .await?;
            tally(result, outcome.action);
            if outcome.action != Action::Skipped {
                moneybird_baseline(
                    args,
                    &party_external_type(args.provider),
                    &party_external_id,
                    &outcome.internal_id,
                )
                .await;
            }
            publish_upsert(args, kind, &outcome).await;
            Ok(())
        }
        Mapped::Document {
            entity,
            contact_external_id,
            nested_contact,
            values,
            line_items,
            ..
        } => {
            let Some(entity_id) = entity_id else {
                return Err(Failure(format!(
                    "Select a WeldBooks entity for this {} connection (or set a default entity)",
                    provider_label(args.provider)
                )));
            };
            ingest_document(
                args,
                entity_id,
                entity,
                contact_external_id.as_deref(),
                nested_contact.as_ref(),
                &values,
                &line_items,
                record,
                external_id,
                &checksum,
                result,
            )
            .await
        }
        _ => {
            let Some(_) = entity_id else {
                return Err(Failure(format!(
                    "Select a WeldBooks entity for this {} connection (or set a default entity)",
                    provider_label(args.provider)
                )));
            };
            Ok(())
        }
    }
}

// ── bank accounts and transactions ──────────────────────────────────────────

fn pick_currency(values: &Map<String, Value>) -> Option<String> {
    let raw = values.get("currency")?.as_str()?;
    let trimmed = weldsuite_kit::validation::js_trim(raw);
    (!trimmed.is_empty()).then(|| crate::mappers::slice_units(trimmed, 3))
}

async fn resolve_bank_account_id(
    args: &IngestArgs<'_>,
    entity_id: &str,
    account_type: &str,
    txn_values: &Map<String, Value>,
    financial_account: &str,
) -> Outcome<String> {
    if let Some(found) =
        find_mapping(args.db, args.connection_id, account_type, financial_account).await?
    {
        return Ok(found.internal_id);
    }
    let currency = pick_currency(txn_values).unwrap_or_else(|| "EUR".to_owned());
    let mut values = Map::new();
    values.insert("entityId".to_owned(), json!(entity_id));
    if args.provider == "stripe" {
        values.insert(
            "name".to_owned(),
            json!(format!("Stripe balance ({currency})")),
        );
        values.insert("bankName".to_owned(), json!("Stripe"));
        values.insert("currency".to_owned(), json!(currency));
        values.insert("isActive".to_owned(), json!(true));
        values.insert("autoReconcile".to_owned(), json!(false));
        values.insert("metadata".to_owned(), json!({ "stripeBalance": true }));
    } else {
        values.insert(
            "name".to_owned(),
            json!(format!(
                "{} account {financial_account}",
                provider_label(args.provider)
            )),
        );
        values.insert("currency".to_owned(), json!(currency));
        values.insert("isActive".to_owned(), json!(false));
        values.insert(
            "metadata".to_owned(),
            json!({ "stubFromMutation": true, "moneybirdFinancialAccountId": financial_account }),
        );
    }
    let stub = upsert_by_mapping(
        args.db,
        args.connection_id,
        &UpsertTarget {
            table: &tables::BANK_ACCOUNTS,
            id_prefix: "ba",
            dedup: None,
            external_type: account_type,
            external_id: financial_account,
            internal_type: "bank_account",
        },
        &values,
        &format!("stub:{financial_account}"),
    )
    .await?;
    Ok(stub.internal_id)
}

/// `linkMoneybirdPayment(...)`: a Moneybird mutation names the bill (a
/// purchase invoice or receipt) or sales invoice its payment settles; when
/// this connection imported it, the transaction points at it, and a
/// reconciled one was reconciled automatically. The status stays the
/// mapper's.
async fn link_moneybird_payment(
    args: &IngestArgs<'_>,
    values: &mut Map<String, Value>,
    invoice_external_id: Option<&str>,
    bill_external_id: Option<&str>,
) -> Outcome<()> {
    let mut linked = false;
    if let Some(bill) = bill_external_id.filter(|b| !b.is_empty()) {
        for external_type in ["moneybird_purchase_invoice", "moneybird_receipt"] {
            if let Some(found) =
                find_mapping(args.db, args.connection_id, external_type, bill).await?
            {
                values.insert("reconciledBillId".to_owned(), json!(found.internal_id));
                linked = true;
                break;
            }
        }
    }
    if let Some(invoice) = invoice_external_id.filter(|i| !i.is_empty())
        && let Some(found) = find_mapping(
            args.db,
            args.connection_id,
            "moneybird_sales_invoice",
            invoice,
        )
        .await?
    {
        values.insert("reconciledInvoiceId".to_owned(), json!(found.internal_id));
        linked = true;
    }
    if linked && values.get("status").and_then(Value::as_str) == Some("reconciled") {
        values.insert("reconciliationType".to_owned(), json!("auto"));
    }
    Ok(())
}

async fn ingest_bank_record(
    args: &IngestArgs<'_>,
    entity_id: &str,
    account_type: &str,
    record: &Value,
    external_id: &str,
    mappings: &[FieldMapping],
    result: &mut IngestResult,
) -> Outcome<()> {
    if is_deleted_record(record, args.force_deleted) {
        let Some(mapping) = find_mapping(
            args.db,
            args.connection_id,
            args.external_type(),
            external_id,
        )
        .await?
        else {
            result.skipped += 1;
            return Ok(());
        };
        let account = args.internal_entity() == "bank_account";
        soft_delete_mapped(
            args.db,
            if account {
                &tables::BANK_ACCOUNTS
            } else {
                &tables::BANK_TRANSACTIONS
            },
            &mapping.internal_id,
            &mapping.id,
        )
        .await?;
        result.deleted += 1;
        publish(
            args,
            if account {
                "bank_account"
            } else {
                "bank_transaction"
            },
            "deleted",
            &mapping.internal_id,
        )
        .await;
        return Ok(());
    }
    let mapped = map_with_field_mappings(args.internal_entity(), record, args.provider, mappings);
    let (account_external, mapped) = match mapped {
        Some(m @ Mapped::BankAccount { .. }) => (Some(m.external_id().to_owned()), m),
        Some(m @ Mapped::BankTransaction { .. }) => {
            let Mapped::BankTransaction {
                financial_account_external_id,
                ..
            } = &m
            else {
                unreachable!()
            };
            (financial_account_external_id.clone(), m)
        }
        _ => {
            result.failed += 1;
            push_sample(
                result,
                external_id,
                format!(
                    "Could not map {} bank record (missing required fields)",
                    provider_label(args.provider)
                ),
            );
            return Ok(());
        }
    };
    if account_external
        .as_ref()
        .is_some_and(|a| !a.is_empty() && args.skip_financial_account_ids.contains(a))
    {
        result.skipped += 1;
        return Ok(());
    }
    let checksum = ingest_checksum(args.provider, record);
    match mapped {
        Mapped::BankAccount { values, .. } => {
            let outcome = upsert_by_mapping(
                args.db,
                args.connection_id,
                &UpsertTarget {
                    table: &tables::BANK_ACCOUNTS,
                    id_prefix: "ba",
                    dedup: None,
                    external_type: args.external_type(),
                    external_id,
                    internal_type: "bank_account",
                },
                &with(&values, &[("entityId", json!(entity_id))]),
                &checksum,
            )
            .await?;
            tally(result, outcome.action);
            publish_upsert(args, "bank_account", &outcome).await;
        }
        Mapped::BankTransaction {
            financial_account_external_id,
            invoice_external_id,
            bill_external_id,
            values,
            ..
        } => {
            let Some(financial_account) = financial_account_external_id.filter(|f| !f.is_empty())
            else {
                return Err(Failure(
                    "Bank transaction is missing financial_account_id".to_owned(),
                ));
            };
            let bank_account_id =
                resolve_bank_account_id(args, entity_id, account_type, &values, &financial_account)
                    .await?;
            let mut values = values;
            if args.provider == "stripe"
                && let Some(invoice) = invoice_external_id.as_deref().filter(|i| !i.is_empty())
            {
                let invoice_type = sync_external_type("stripe", "invoice", "stripe_invoice");
                if let Some(found) =
                    find_mapping(args.db, args.connection_id, &invoice_type, invoice).await?
                {
                    values.insert("status".to_owned(), json!("reconciled"));
                    values.insert("reconciliationType".to_owned(), json!("auto"));
                    values.insert("reconciledInvoiceId".to_owned(), json!(found.internal_id));
                }
            }
            if args.provider == "moneybird" {
                link_moneybird_payment(
                    args,
                    &mut values,
                    invoice_external_id.as_deref(),
                    bill_external_id.as_deref(),
                )
                .await?;
            }
            values.insert("entityId".to_owned(), json!(entity_id));
            values.insert("bankAccountId".to_owned(), json!(bank_account_id));
            let outcome = upsert_by_mapping(
                args.db,
                args.connection_id,
                &UpsertTarget {
                    table: &tables::BANK_TRANSACTIONS,
                    id_prefix: "bt",
                    dedup: None,
                    external_type: args.external_type(),
                    external_id,
                    internal_type: "bank_transaction",
                },
                &values,
                &checksum,
            )
            .await?;
            tally(result, outcome.action);
            publish_upsert(args, "bank_transaction", &outcome).await;
        }
        _ => {}
    }
    Ok(())
}

// ── WMS (Picqer) ────────────────────────────────────────────────────────────

const WMS_ENTITIES: [&str; 10] = [
    "inventory",
    "warehouse",
    "location",
    "picklist",
    "shipment",
    "supplier",
    "purchase_order",
    "return",
    "stock_count",
    "inventory_movement",
];

/// `wmsTarget(entity)`: table, id prefix, natural key, mapping type, event type.
fn wms_target(
    entity: &str,
) -> (
    &'static Table,
    &'static str,
    Option<&'static str>,
    &'static str,
    &'static str,
) {
    match entity {
        "inventory" => (&tables::INVENTORY, "inv", None, "inventory", "inventory"),
        "warehouse" => (
            &tables::WAREHOUSES,
            "wh",
            Some("code"),
            "warehouse",
            "warehouse",
        ),
        "location" => (
            &tables::WAREHOUSE_LOCATIONS,
            "wloc",
            Some("code"),
            "location",
            "wms_location",
        ),
        "picklist" => (
            &tables::PICK_LISTS,
            "pl",
            Some("pickListNumber"),
            "picklist",
            "picklist",
        ),
        "shipment" => (
            &tables::SHIPMENTS,
            "shp",
            Some("shipmentNumber"),
            "shipment",
            "shipment",
        ),
        "supplier" => (
            &tables::SUPPLIERS,
            "sup",
            Some("code"),
            "supplier",
            "supplier",
        ),
        "purchase_order" => (
            &tables::PURCHASE_ORDERS,
            "po",
            Some("poNumber"),
            "purchase_order",
            "purchase_order",
        ),
        "return" => (
            &tables::RETURNS,
            "ret",
            Some("returnNumber"),
            "return",
            "return",
        ),
        "stock_count" => (
            &tables::CYCLE_COUNTS,
            "cc",
            Some("countNumber"),
            "stock_count",
            "wms_cycle_count",
        ),
        _ => (
            &tables::INVENTORY_MOVEMENTS,
            "imv",
            Some("movementNumber"),
            "inventory_movement",
            "wms_inventory_movement",
        ),
    }
}

async fn ensure_default_warehouse(db: &PgPool, owner: &str) -> Result<String, DbErr> {
    let existing: Option<String> = warehouses::Entity::find()
        .select_only()
        .column(warehouses::Column::Id)
        .filter(warehouses::Column::DeletedAt.is_null())
        .order_by_asc(warehouses::Column::CreatedAt)
        .into_tuple()
        .one(&orm(db))
        .await?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = generate_id("wh");
    let mut values = Map::new();
    values.insert("id".to_owned(), json!(id));
    values.insert("name".to_owned(), json!("Default warehouse"));
    values.insert("code".to_owned(), json!("DEFAULT"));
    values.insert("isDefault".to_owned(), json!(true));
    values.insert("isActive".to_owned(), json!(true));
    values.insert(
        "metadata".to_owned(),
        json!({ "source": "picqer-connector", "createdFor": if owner.is_empty() { "sync" } else { owner } }),
    );
    insert(db, &tables::WAREHOUSES, &values).await?;
    Ok(id)
}

async fn linked_id(
    args: &IngestArgs<'_>,
    external_id: Option<&String>,
    kind: &str,
) -> Result<Option<String>, DbErr> {
    let Some(external_id) = external_id.filter(|e| !e.is_empty()) else {
        return Ok(None);
    };
    Ok(find_mapping(
        args.db,
        args.connection_id,
        &format!("{}_{kind}", args.provider),
        external_id,
    )
    .await?
    .map(|m| m.internal_id))
}

async fn resolve_links(
    args: &IngestArgs<'_>,
    entity: &str,
    links: &Links,
    values: &Map<String, Value>,
) -> Result<Map<String, Value>, DbErr> {
    let mut extra = Map::new();
    if let Some(id) = linked_id(args, links.product.as_ref(), "product").await? {
        extra.insert("productId".to_owned(), json!(id));
    }
    if let Some(id) = linked_id(args, links.warehouse.as_ref(), "warehouse").await? {
        extra.insert("warehouseId".to_owned(), json!(id));
        if entity == "inventory_movement" {
            extra.insert("sourceWarehouseId".to_owned(), json!(id));
            extra.insert("destWarehouseId".to_owned(), json!(id));
        }
    }
    if let Some(id) = linked_id(args, links.location.as_ref(), "location").await? {
        extra.insert("locationId".to_owned(), json!(id));
        if entity == "stock_count" {
            extra.insert("locationIds".to_owned(), json!([id]));
        }
    }
    if let Some(id) = linked_id(args, links.supplier.as_ref(), "supplier").await? {
        extra.insert("supplierId".to_owned(), json!(id));
    }
    if let Some(id) = linked_id(args, links.order.as_ref(), "order").await? {
        match entity {
            "picklist" => {
                extra.insert("orderIds".to_owned(), json!([id]));
            }
            "return" => {
                extra.insert("originalOrderId".to_owned(), json!(id));
            }
            _ => {}
        }
    }
    if let Some(id) = linked_id(args, links.picklist.as_ref(), "picklist").await? {
        let mut metadata = values
            .get("metadata")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        metadata.insert("pickListId".to_owned(), json!(id));
        extra.insert("metadata".to_owned(), Value::Object(metadata));
    }
    Ok(extra)
}

fn falsy(values: &Map<String, Value>, key: &str) -> bool {
    !values.get(key).is_some_and(crate::js::truthy)
}

async fn ingest_wms_record(
    args: &IngestArgs<'_>,
    default_warehouse: &str,
    record: &Value,
    external_id: &str,
    mappings: &[FieldMapping],
    result: &mut IngestResult,
) -> Outcome<()> {
    if is_deleted_record(record, args.force_deleted) {
        let Some(mapping) = find_mapping(
            args.db,
            args.connection_id,
            args.external_type(),
            external_id,
        )
        .await?
        else {
            result.skipped += 1;
            return Ok(());
        };
        let (table, ..) = wms_target(args.internal_entity());
        soft_delete_mapped(args.db, table, &mapping.internal_id, &mapping.id).await?;
        result.deleted += 1;
        return Ok(());
    }
    let Some(Mapped::Wms {
        entity,
        values,
        links,
        ..
    }) = map_with_field_mappings(args.internal_entity(), record, args.provider, mappings)
    else {
        result.skipped += 1;
        return Ok(());
    };
    let (table, prefix, dedup, internal_type, event_type) = wms_target(entity);
    let linked = resolve_links(args, entity, &links, &values).await?;
    let mut values = values;
    for (k, v) in linked {
        values.insert(k, v);
    }
    if values.get("createdBy").is_none_or(Value::is_null) {
        values.insert("createdBy".to_owned(), json!(args.owner_id));
    }
    if matches!(
        entity,
        "inventory" | "picklist" | "stock_count" | "location"
    ) && falsy(&values, "warehouseId")
    {
        values.insert("warehouseId".to_owned(), json!(default_warehouse));
    }
    if matches!(entity, "inventory" | "inventory_movement") && falsy(&values, "productId") {
        result.skipped += 1;
        return Ok(());
    }
    if entity == "inventory_movement" {
        for key in ["sourceWarehouseId", "destWarehouseId"] {
            if values.get(key).is_none_or(Value::is_null) {
                values.insert(key.to_owned(), json!(default_warehouse));
            }
        }
    }
    let checksum = record_checksum(record);
    let outcome = upsert_by_mapping(
        args.db,
        args.connection_id,
        &UpsertTarget {
            table,
            id_prefix: prefix,
            dedup,
            external_type: args.external_type(),
            external_id,
            internal_type,
        },
        &values,
        &checksum,
    )
    .await?;
    tally(result, outcome.action);
    publish_upsert(args, event_type, &outcome).await;
    Ok(())
}

// ── entry ───────────────────────────────────────────────────────────────────

enum Family {
    Accounting(Option<String>),
    Bank {
        entity_id: String,
        account_type: String,
    },
    Wms {
        default_warehouse: String,
    },
    Catalog,
}

/// `ingestRecords(args)`.
pub async fn ingest_records(args: &IngestArgs<'_>) -> Result<IngestResult, DbErr> {
    let entity = args.internal_entity().to_owned();
    let mut result = IngestResult::default();
    let mut records = args.records.clone();
    let family = match entity.as_str() {
        "party" | "invoice" | "bill" => Family::Accounting(if entity == "party" {
            None
        } else {
            resolve_entity_id(args).await?
        }),
        "bank_account" | "bank_transaction" => {
            let Some(entity_id) = resolve_entity_id(args).await? else {
                result.failed = records.len() as u64;
                result.error_samples.push((
                    "-".to_owned(),
                    format!(
                        "Select a WeldBooks entity for this {} connection (or set a default entity)",
                        provider_label(args.provider)
                    ),
                ));
                return Ok(result);
            };
            let account_type = sync_external_type(
                args.provider,
                "bank_account",
                &format!("{}_financial_account", args.provider),
            );
            Family::Bank {
                entity_id,
                account_type,
            }
        }
        e if WMS_ENTITIES.contains(&e) => Family::Wms {
            default_warehouse: String::new(),
        },
        _ => Family::Catalog,
    };
    let mappings = load_field_mappings(args.db, args.connection_id, &entity).await?;
    let family = match family {
        Family::Wms { .. } => {
            if args.provider == "picqer" && entity == "inventory" {
                records = records
                    .iter()
                    .flat_map(|r| {
                        if r.get("stock").is_some_and(Value::is_array) {
                            crate::lists::expand_picqer_product_stock(r)
                        } else {
                            vec![r.clone()]
                        }
                    })
                    .collect();
            }
            Family::Wms {
                default_warehouse: ensure_default_warehouse(args.db, args.owner_id).await?,
            }
        }
        other => other,
    };
    for record in &records {
        let Some(external_id) = external_id_of(record) else {
            result.skipped += 1;
            continue;
        };
        let outcome = match &family {
            Family::Accounting(entity_id) => {
                ingest_accounting_record(
                    args,
                    entity_id.as_deref(),
                    record,
                    &external_id,
                    &mappings,
                    &mut result,
                )
                .await
            }
            Family::Bank {
                entity_id,
                account_type,
            } => {
                ingest_bank_record(
                    args,
                    entity_id,
                    account_type,
                    record,
                    &external_id,
                    &mappings,
                    &mut result,
                )
                .await
            }
            Family::Wms { default_warehouse } => {
                ingest_wms_record(
                    args,
                    default_warehouse,
                    record,
                    &external_id,
                    &mappings,
                    &mut result,
                )
                .await
            }
            Family::Catalog => {
                ingest_catalog_record(args, record, &external_id, &mappings, &mut result).await
            }
        };
        if let Err(Failure(message)) = outcome {
            let message = sanitise_error_message(&message);
            tracing::error!("[connectors/ingest] record {external_id} failed: {message}");
            result.failed += 1;
            push_sample(&mut result, &external_id, message);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod db_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksums_and_messages() {
        assert_eq!(
            stable_stringify(&json!({ "b": 1.0, "a": [true, null, "x"], "c": { "z": 0.5 } })),
            r#"{"a":[true,null,"x"],"b":1,"c":{"z":0.5}}"#
        );
        assert_eq!(
            sanitise_error_message("duplicate key Key (lower(email))=(a@b.com) value 'x' here"),
            "duplicate key Key (lower(email))=(redacted) value 'redacted' here"
        );
        assert_eq!(
            safe_filename(Some("my file (1).pdf"), "x"),
            "my_file_1_.pdf"
        );
    }
}
