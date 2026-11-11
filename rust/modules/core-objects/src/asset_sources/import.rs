//! One bounded step of an import (`runAssetImportStep` of
//! `@weldsuite/core-domain/asset-sources`).
//!
//! A step gets a fresh token, reads ONE Graph page, loads that page's
//! mappings and the records they point to in one query each, and writes at
//! most `max_writes` records (reading and skipping unchanged devices is
//! free); then it saves where it stopped in `asset_sources.sync_state` and
//! the next tick continues. Resuming is safe: a device that was already
//! written has its mapping and checksum, so a repeated device counts as
//! unchanged.
//!
//! Matching: a device maps to its record through
//! `integration_entity_mappings` (connection = the source, external type
//! `intune_device`, external id = the managedDevice id, internal type = the
//! object's entity key). No mapping: a record with the same serial number
//! that this source has not mapped yet is adopted, otherwise a record is
//! created. Devices that disappear from Intune are left alone.
//!
//! Records are written with the record functions the routes use
//! ([`create_record_as`], [`update_record_as`]): the same rows, the same
//! values, the same event data.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{ASSET_SOURCE_UPDATED, CUSTOM_FIELD_CREATED};
use weldsuite_db::{Keyring, PgPool, decrypt_field, is_unique_violation};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventType, iso_timestamp};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;
use weldsuite_ports::OutboundHttp;

use super::device::{COMPLIANCE_OPTIONS, CREATED_STATUS, map_intune_device, text};
use super::microsoft::{
    DEFAULT_RETRY_AFTER_SECONDS, ErrorCode, Page, SourceError, fetch_intune_page, intune_token,
};
use super::source::{self, INTUNE_DEVICE_ENTITY_TYPE, Source, instant};
use crate::js::{Js, js_date};
use crate::objects::{CustomObject, object_by_slug};
use crate::records::{create_record_as, update_record_as};
use crate::values::{ValuesError, definitions};

/// `ASSET_IMPORT_MAX_WRITES`: record writes (creates and updates) in one
/// step.
pub(crate) const MAX_WRITES: usize = 20;
/// `ASSET_IMPORT_MAX_RUN_MS`: a run that has not finished after this long is
/// stopped.
const MAX_RUN: time::Duration = time::Duration::hours(24);
const RUN_TOO_LONG: &str =
    "The import did not finish within 24 hours and was stopped. It starts again on schedule.";

/// `ASSET_IMPORT_FIELDS`: the fields the import adds to the object, as
/// `(slug, name, field type)`. The compliance field takes
/// [`COMPLIANCE_OPTIONS`].
const IMPORT_FIELDS: [(&str, &str, &str); 8] = [
    ("manufacturer", "Manufacturer", "text"),
    ("model", "Model", "text"),
    ("operating_system", "Operating system", "text"),
    ("os_version", "OS version", "text"),
    ("compliance", "Compliance", "single_select"),
    ("last_check_in", "Last check-in", "date"),
    ("primary_user", "Primary user", "text"),
    ("intune_device_id", "Intune device ID", "text"),
];

/// `AssetImportEvents` as the sweep fills it: every event is published and
/// waited for, so they go out in the order the import made them.
pub(crate) struct Announcer<'a> {
    pub(crate) publisher: &'a EntityEventPublisher,
    /// The workspace on the wire, as `system`.
    pub(crate) context: EventContext,
}

impl Announcer<'_> {
    /// `publishCustomObjectEventRaw`: a record was created or updated. An
    /// entity key that is no custom object's is refused, as TypeScript
    /// throws.
    async fn record(
        &self,
        action: &str,
        entity_key: &str,
        record_id: &str,
        data: Value,
    ) -> Result<(), DeviceError> {
        let event = EventType::custom_object(entity_key, action)
            .map_err(|error| DeviceError::Refused(error.to_string()))?;
        self.publisher
            .publish_and_wait(&self.context, EntityEvent::new(event, record_id, data))
            .await;
        Ok(())
    }

    /// A field definition was added to the object: the same event a field
    /// made by hand publishes.
    async fn field(&self, definition: &Value) {
        let id = definition["id"].as_str().unwrap_or_default();
        self.publisher
            .publish_and_wait(
                &self.context,
                EntityEvent::new(CUSTOM_FIELD_CREATED, id, definition.clone()),
            )
            .await;
    }

    /// A run finished or failed: `asset_source updated`, with the row as the
    /// API shows it.
    pub(crate) async fn source_updated(&self, source: &Source) {
        self.publisher
            .publish_and_wait(
                &self.context,
                EntityEvent::new(ASSET_SOURCE_UPDATED, source.id.as_str(), source.view()),
            )
            .await;
    }
}

/// `AssetImportContext`.
pub(crate) struct ImportContext<'a> {
    pub(crate) db: &'a PgPool,
    pub(crate) keyring: &'a Keyring,
    /// What Microsoft is called through.
    pub(crate) http: Option<&'a OutboundHttp>,
    /// The tick's time, to the millisecond.
    pub(crate) now: OffsetDateTime,
    /// Record writes per step ([`MAX_WRITES`]).
    pub(crate) max_writes: usize,
    pub(crate) events: Option<&'a Announcer<'a>>,
}

/// `AssetImportStepResult`.
#[derive(Debug)]
pub(crate) struct StepResult {
    /// The run ended (finished or failed); the source row is settled.
    pub(crate) done: bool,
    /// Microsoft asked to wait: do not continue before this many seconds.
    pub(crate) retry_after_seconds: Option<u32>,
    /// The source as stored after the step.
    pub(crate) source: Source,
}

/// What TypeScript throws out of a step: the run stays as it was and the
/// next tick repeats the step.
#[derive(Debug)]
pub(crate) enum StepFailure {
    Database(sqlx::Error),
    /// A page entry no device can be read from (`null`): reading its id
    /// throws before any device is handled.
    Page,
}

impl std::fmt::Display for StepFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(f, "{error}"),
            Self::Page => f.write_str("the page of devices holds an entry that is not a device"),
        }
    }
}

impl From<sqlx::Error> for StepFailure {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

/// How a step stops short: Microsoft's (or the asset register's) refusal,
/// which ends the run, or a failure that leaves it as it was.
enum Stop {
    Refused(SourceError),
    Failed(StepFailure),
}

impl From<SourceError> for Stop {
    fn from(error: SourceError) -> Self {
        Self::Refused(error)
    }
}

impl From<sqlx::Error> for Stop {
    fn from(error: sqlx::Error) -> Self {
        Self::Failed(StepFailure::Database(error))
    }
}

/// `runAssetImportStep(ctx, source)`: one bounded step of the run under way
/// (`source.syncState`). A problem with Microsoft or with one device never
/// fails it: those end the run as `failed` (or, when throttled, wait). An
/// `Err` is a tenant database failure; the run stays as it was and the next
/// tick repeats the step.
pub(crate) async fn run_step(
    ctx: &ImportContext<'_>,
    source: Source,
) -> Result<StepResult, StepFailure> {
    let Some(state) = source.running().cloned() else {
        return Ok(StepResult {
            done: true,
            retry_after_seconds: None,
            source,
        });
    };
    let ended = |source: Source| StepResult {
        done: true,
        retry_after_seconds: None,
        source,
    };

    if ran_too_long(state["startedAt"].as_str(), ctx.now) {
        let failure = SourceError::with_message(ErrorCode::Throttled, RUN_TOO_LONG);
        let stored =
            source::end_run(ctx.db, &source, state.get("stats"), ctx.now, Some(&failure)).await?;
        return Ok(ended(stored));
    }

    match step(ctx, &source, &state).await {
        Ok(result) => Ok(result),
        Err(Stop::Failed(failure)) => Err(failure),
        Err(Stop::Refused(failure)) if failure.code == ErrorCode::Throttled => Ok(StepResult {
            done: false,
            retry_after_seconds: Some(
                failure
                    .retry_after_seconds
                    .unwrap_or(DEFAULT_RETRY_AFTER_SECONDS),
            ),
            source,
        }),
        Err(Stop::Refused(failure)) => {
            let stored =
                source::end_run(ctx.db, &source, state.get("stats"), ctx.now, Some(&failure))
                    .await?;
            Ok(ended(stored))
        }
    }
}

/// `now.getTime() - Date.parse(startedAt) > ASSET_IMPORT_MAX_RUN_MS`: a
/// start that cannot be read never is.
fn ran_too_long(started_at: Option<&str>, now: OffsetDateTime) -> bool {
    started_at
        .and_then(js_date)
        .as_deref()
        .and_then(instant)
        .is_some_and(|started| now - started > MAX_RUN)
}

/// `stats[key] += 1`.
fn bump(stats: &mut Map<String, Value>, key: &str) {
    let count = stats.get(key).and_then(Value::as_i64).unwrap_or(0);
    stats.insert(key.to_owned(), json!(count + 1));
}

/// `openSecret(source, keyring)`: the client secret, for this step only.
async fn open_secret(db: &PgPool, source: &Source, keyring: &Keyring) -> Result<String, Stop> {
    let sealed = source::stored_secret(db, &source.id)
        .await?
        .filter(|sealed| !sealed.is_empty());
    let Some(sealed) = sealed else {
        return Err(SourceError::with_message(
            ErrorCode::InvalidSecret,
            "No client secret is stored; enter it again.",
        )
        .into());
    };
    decrypt_field(&sealed, keyring).map_err(|_| {
        SourceError::with_message(
            ErrorCode::InvalidSecret,
            "The stored client secret cannot be read; enter it again.",
        )
        .into()
    })
}

/// A mapping row, the parts the import reads.
struct Mapping {
    id: String,
    internal_entity_id: String,
    sync_checksum: Option<String>,
}

/// The page this step reads, with a fresh token. Microsoft comes first: a
/// refusal or a throttle leaves the tenant data untouched.
async fn read_page(ctx: &ImportContext<'_>, source: &Source, state: &Value) -> Result<Page, Stop> {
    let secret = open_secret(ctx.db, source, ctx.keyring).await?;
    let token = intune_token(ctx.http, source.tenant_id(), source.client_id(), &secret).await?;
    drop(secret);
    // `state.nextLink ?? null`: a link that is not text is no Graph link.
    let link = match state.get("nextLink") {
        None | Some(Value::Null) => None,
        Some(Value::String(link)) => Some(link.as_str()),
        Some(_) => Some(""),
    };
    Ok(fetch_intune_page(ctx.http, &token, link).await?)
}

/// The mappings of the devices still to handle on the page, by device id,
/// and whether the record each points to is deleted, by record id: one query
/// each.
async fn page_matches(
    db: &PgPool,
    source: &Source,
    entity_key: &str,
    remaining: &[Value],
) -> Result<(HashMap<String, Mapping>, HashMap<String, bool>), Stop> {
    if remaining.iter().any(Value::is_null) {
        return Err(Stop::Failed(StepFailure::Page));
    }
    let ids: Vec<String> = remaining
        .iter()
        .filter_map(|device| text(device.get("id")))
        .collect();
    let mut mappings: HashMap<String, Mapping> = HashMap::new();
    if !ids.is_empty() {
        let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
            "select id, external_entity_id, internal_entity_id, sync_checksum
               from integration_entity_mappings
              where connection_id = $1 and external_entity_type = $2
                and external_entity_id = any($3)",
        )
        .bind(&source.id)
        .bind(INTUNE_DEVICE_ENTITY_TYPE)
        .bind(&ids)
        .fetch_all(db)
        .await?;
        for (id, external_id, internal_entity_id, sync_checksum) in rows {
            mappings.insert(
                external_id,
                Mapping {
                    id,
                    internal_entity_id,
                    sync_checksum,
                },
            );
        }
    }
    let mut records: HashMap<String, bool> = HashMap::new();
    if !mappings.is_empty() {
        let record_ids: Vec<String> = mappings
            .values()
            .map(|mapping| mapping.internal_entity_id.clone())
            .collect();
        let rows: Vec<(String, bool)> = sqlx::query_as(
            "select id, deleted_at is not null from custom_object_records
              where entity_key = $1 and id = any($2)",
        )
        .bind(entity_key)
        .bind(&record_ids)
        .fetch_all(db)
        .await?;
        records.extend(rows);
    }
    Ok((mappings, records))
}

async fn step(ctx: &ImportContext<'_>, source: &Source, state: &Value) -> Result<StepResult, Stop> {
    let db = ctx.db;
    let now = iso_timestamp(ctx.now);

    let Some(object) = object_by_slug(db, &source.object_slug).await? else {
        return Err(SourceError::new(ErrorCode::AssetRegisterMissing).into());
    };
    let entity_key = object.entity_key.as_str();
    let page = read_page(ctx, source, state).await?;

    for created in ensure_import_fields(db, entity_key, &now).await? {
        if let Some(events) = ctx.events {
            events.field(&created).await;
        }
    }

    // `state.startedById ?? source.createdById ?? 'system'`.
    let user_id = state["startedById"]
        .as_str()
        .or(source.created_by_id.as_deref())
        .unwrap_or("system");
    let mut counters = state["stats"].as_object().cloned().unwrap_or_default();
    let mut index = state["offset"]
        .as_u64()
        .and_then(|offset| usize::try_from(offset).ok())
        .unwrap_or(0);

    let remaining = page.devices.get(index..).unwrap_or_default();
    let (mut mappings, records) = page_matches(db, source, entity_key, remaining).await?;
    let job = Job {
        ctx,
        source,
        object: &object,
        user_id,
        now: &now,
        lookups: prepare_lookups(db, entity_key).await?,
    };
    let mut claimed = HashSet::new();
    let mut writes = 0;

    while index < page.devices.len() && writes < ctx.max_writes {
        let device = &page.devices[index];
        index += 1;
        bump(&mut counters, "total");
        match job
            .import_device(device, &mut mappings, &records, &mut claimed)
            .await
        {
            Ok(outcome) => {
                bump(&mut counters, outcome.counter());
                if outcome != Outcome::Unchanged {
                    writes += 1;
                }
            }
            Err(error) => {
                tracing::warn!(%error, source_id = source.id, "asset import: a device could not be written");
                bump(&mut counters, "failed");
                writes += 1;
            }
        }
    }

    // Stopped inside the page: the next step reads it again from `index`.
    let within = (index < page.devices.len()).then_some(index);
    Ok(after_page(ctx, source, state, counters, within, page.next_link).await?)
}

/// Where the run stands after a step's devices: stopped inside the page
/// (`within`), on to the next page, or over. The state is saved, or the run
/// ended.
async fn after_page(
    ctx: &ImportContext<'_>,
    source: &Source,
    state: &Value,
    counters: Map<String, Value>,
    within: Option<usize>,
    next_link: Option<String>,
) -> Result<StepResult, sqlx::Error> {
    let mut next = state.as_object().cloned().unwrap_or_default();
    next.insert("stats".to_owned(), Value::Object(counters));
    if let Some(index) = within {
        let link = state.get("nextLink").cloned().unwrap_or(Value::Null);
        next.insert("nextLink".to_owned(), link);
        next.insert("offset".to_owned(), json!(index));
    } else if let Some(next_link) = next_link {
        next.insert("nextLink".to_owned(), json!(next_link));
        next.insert("offset".to_owned(), json!(0));
    } else {
        let stored = source::end_run(ctx.db, source, next.get("stats"), ctx.now, None).await?;
        return Ok(StepResult {
            done: true,
            retry_after_seconds: None,
            source: stored,
        });
    }
    let next = Value::Object(next);
    source::save_state(ctx.db, &source.id, &next, &iso_timestamp(ctx.now)).await?;
    Ok(StepResult {
        done: false,
        retry_after_seconds: None,
        source: Source {
            sync_state: Some(next),
            ..source.clone()
        },
    })
}

/// `ensureAssetImportFields`: add the fields the import writes that the
/// object does not have yet, once. A field that exists (made by the
/// template, by hand or by an earlier import) is left as it is. Answers the
/// definitions it created, for their events.
async fn ensure_import_fields(
    db: &PgPool,
    entity_key: &str,
    now: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let existing: Vec<(String, Option<i32>)> = sqlx::query_as(
        "select slug, sort_order from custom_field_definitions
          where entity_type = $1 and deleted_at is null",
    )
    .bind(entity_key)
    .fetch_all(db)
    .await?;
    let mut sort_order = existing
        .iter()
        .map(|(_, sort_order)| sort_order.unwrap_or(0))
        .fold(-1, i32::max)
        + 1;

    let mut created = Vec::new();
    for (slug, name, field_type) in IMPORT_FIELDS {
        if existing.iter().any(|(taken, _)| taken == slug) {
            continue;
        }
        let options = (slug == "compliance").then(|| {
            Value::Array(
                COMPLIANCE_OPTIONS
                    .iter()
                    .map(|(value, label)| json!({ "value": value, "label": label }))
                    .collect(),
            )
        });
        // The position is taken whether or not the insert goes through.
        let position = sort_order;
        sort_order += 1;
        let id = generate_id("cfld");
        let mut definition = json!({
            "id": id,
            "entityType": entity_key,
            "name": name,
            "slug": slug,
            "fieldType": field_type,
            "required": false,
            "sortOrder": position,
        });
        if let Some(options) = &options {
            definition["options"] = options.clone();
        }
        let inserted = sqlx::query(
            "insert into custom_field_definitions
                 (id, entity_type, name, slug, field_type, options, required, sort_order,
                  created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, false, $7, $8::timestamp, $8::timestamp)",
        )
        .bind(&id)
        .bind(entity_key)
        .bind(name)
        .bind(slug)
        .bind(field_type)
        .bind(&options)
        .bind(position)
        .bind(now)
        .execute(db)
        .await;
        match inserted {
            Ok(_) => created.push(definition),
            // Another step (or a person) added it between the read and the insert.
            Err(error) if is_unique_violation(&error) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(created)
}

/// `Lookups`: what matching a device needs from the object, read once per
/// step.
struct Lookups {
    /// The live `serial_number` field.
    serial_field_id: Option<String>,
    /// The live `owner` link: `(id, target entity key)`.
    owner_link: Option<(String, String)>,
}

async fn prepare_lookups(db: &PgPool, entity_key: &str) -> Result<Lookups, sqlx::Error> {
    let serial_field_id: Option<String> = sqlx::query_scalar(
        "select id from custom_field_definitions
          where entity_type = $1 and slug = 'serial_number' and deleted_at is null
          limit 1",
    )
    .bind(entity_key)
    .fetch_optional(db)
    .await?;
    let owner_link: Option<(String, String)> = sqlx::query_as(
        "select id, target_entity_key from custom_object_links
          where source_entity_key = $1 and slug = 'owner' and deleted_at is null
          limit 1",
    )
    .bind(entity_key)
    .fetch_optional(db)
    .await?;
    Ok(Lookups {
        serial_field_id,
        owner_link,
    })
}

/// What became of one device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Created,
    Updated,
    Unchanged,
}

impl Outcome {
    /// The `stats` counter it adds to.
    fn counter(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Updated => "updated",
            Self::Unchanged => "unchanged",
        }
    }
}

/// Why one device could not be written. It counts as failed and the step
/// goes on.
#[derive(Debug)]
enum DeviceError {
    /// A device without an id cannot be imported.
    NoId,
    /// A value the object's fields refuse, or an event that cannot go out.
    Refused(String),
    Database(sqlx::Error),
}

impl std::fmt::Display for DeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoId => f.write_str("A device without an id cannot be imported"),
            Self::Refused(message) => f.write_str(message),
            Self::Database(error) => write!(f, "{error}"),
        }
    }
}

impl From<sqlx::Error> for DeviceError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<ValuesError> for DeviceError {
    fn from(error: ValuesError) -> Self {
        match error {
            ValuesError::Invalid(message) => Self::Refused(message),
            ValuesError::Database(error) => Self::Database(error),
        }
    }
}

/// `DeviceJob`: what every device of a step is imported with.
struct Job<'a> {
    ctx: &'a ImportContext<'a>,
    source: &'a Source,
    object: &'a CustomObject,
    user_id: &'a str,
    /// The tick's time as `toISOString()`.
    now: &'a str,
    lookups: Lookups,
}

impl Job<'_> {
    /// `emit(action, data)`: the record's event, when the object has events
    /// on.
    async fn emit(&self, action: &str, record: &Value) -> Result<(), DeviceError> {
        if !self.object.enable_events {
            return Ok(());
        }
        let Some(events) = self.ctx.events else {
            return Ok(());
        };
        let id = record["id"].as_str().unwrap_or_default();
        events
            .record(action, &self.object.entity_key, id, record.clone())
            .await
    }

    /// `importDevice(job)`.
    async fn import_device(
        &self,
        device: &Value,
        mappings: &mut HashMap<String, Mapping>,
        records: &HashMap<String, bool>,
        claimed: &mut HashSet<String>,
    ) -> Result<Outcome, DeviceError> {
        let db = self.ctx.db;
        let mapped = map_intune_device(device).ok_or(DeviceError::NoId)?;
        let checksum = mapped.checksum();
        let facts = mapped.facts();

        if let Some(mapping) = mappings.get_mut(&mapped.external_id) {
            // A record a person deleted stays deleted; the import does not
            // bring it back.
            let live = records
                .get(&mapping.internal_entity_id)
                .is_some_and(|deleted| !deleted);
            if !live || mapping.sync_checksum.as_deref() == Some(checksum.as_str()) {
                return Ok(Outcome::Unchanged);
            }
            let updated = update_record_as(
                db,
                self.user_id,
                self.object,
                &mapping.internal_entity_id,
                Some(&facts),
                &Field::Absent,
            )
            .await?;
            sqlx::query(
                "update integration_entity_mappings
                    set sync_checksum = $2, last_synced_at = $3::timestamp,
                        updated_at = $3::timestamp
                  where id = $1",
            )
            .bind(&mapping.id)
            .bind(&checksum)
            .bind(self.now)
            .execute(db)
            .await?;
            mapping.sync_checksum = Some(checksum);
            self.emit("updated", &updated).await?;
            return Ok(Outcome::Updated);
        }

        let adoptable = self
            .find_adoptable_record(mapped.serial_number.as_deref(), claimed)
            .await?;
        if let Some(record_id) = adoptable {
            claimed.insert(record_id.clone());
            let updated = update_record_as(
                db,
                self.user_id,
                self.object,
                &record_id,
                Some(&facts),
                &Field::Absent,
            )
            .await?;
            self.insert_mapping(&mapped.external_id, &record_id, &checksum, mappings)
                .await?;
            self.emit("updated", &updated).await?;
            return Ok(Outcome::Updated);
        }

        // `{ ...facts, ...mapped.createdOnly }`: the asset type and the
        // status only when the record is created.
        let mut fields = facts;
        fields.push((
            "asset_type".to_owned(),
            Js::String(mapped.asset_type.to_owned()),
        ));
        fields.push(("status".to_owned(), Js::String(CREATED_STATUS.to_owned())));
        let definitions = definitions(db, &self.object.entity_key).await?;
        let created =
            create_record_as(db, self.user_id, self.object, &definitions, fields, None).await?;
        let record_id = created["id"].as_str().unwrap_or_default().to_owned();
        claimed.insert(record_id.clone());
        self.insert_mapping(&mapped.external_id, &record_id, &checksum, mappings)
            .await?;
        self.attach_owner(&record_id, mapped.user_email.as_deref())
            .await?;
        self.emit("created", &created).await?;
        Ok(Outcome::Created)
    }

    /// `insertMapping`: the device now maps to this record.
    async fn insert_mapping(
        &self,
        external_id: &str,
        record_id: &str,
        checksum: &str,
        mappings: &mut HashMap<String, Mapping>,
    ) -> Result<(), sqlx::Error> {
        let id = generate_id("iem");
        sqlx::query(
            "insert into integration_entity_mappings
                 (id, connection_id, external_entity_type, external_entity_id,
                  internal_entity_type, internal_entity_id, sync_checksum, last_synced_at,
                  created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $8::timestamp, $8::timestamp)",
        )
        .bind(&id)
        .bind(&self.source.id)
        .bind(INTUNE_DEVICE_ENTITY_TYPE)
        .bind(external_id)
        .bind(&self.object.entity_key)
        .bind(record_id)
        .bind(checksum)
        .bind(self.now)
        .execute(self.ctx.db)
        .await?;
        mappings.insert(
            external_id.to_owned(),
            Mapping {
                id,
                internal_entity_id: record_id.to_owned(),
                sync_checksum: Some(checksum.to_owned()),
            },
        );
        Ok(())
    }

    /// `findAdoptableRecord`: a live record with this serial number that no
    /// device of this source is mapped to yet and this run has not claimed
    /// (oldest first).
    async fn find_adoptable_record(
        &self,
        serial: Option<&str>,
        claimed: &HashSet<String>,
    ) -> Result<Option<String>, sqlx::Error> {
        let (Some(serial), Some(serial_field_id)) = (
            serial.filter(|serial| !serial.is_empty()),
            self.lookups.serial_field_id.as_deref(),
        ) else {
            return Ok(None);
        };
        let db = self.ctx.db;
        let candidates: Vec<String> = sqlx::query_scalar(
            "select r.id
               from custom_field_values v
               inner join custom_object_records r on r.id = v.entity_id
              where v.field_id = $1 and v.entity_type = $2 and v.value_text = $3
                and r.entity_key = $2 and r.deleted_at is null
              order by r.created_at asc, r.id asc",
        )
        .bind(serial_field_id)
        .bind(&self.object.entity_key)
        .bind(serial)
        .fetch_all(db)
        .await?;
        let free: Vec<String> = candidates
            .into_iter()
            .filter(|id| !claimed.contains(id))
            .collect();
        if free.is_empty() {
            return Ok(None);
        }
        let taken: Vec<String> = sqlx::query_scalar(
            "select internal_entity_id from integration_entity_mappings
              where connection_id = $1 and external_entity_type = $2
                and internal_entity_id = any($3)",
        )
        .bind(&self.source.id)
        .bind(INTUNE_DEVICE_ENTITY_TYPE)
        .bind(&free)
        .fetch_all(db)
        .await?;
        Ok(free.into_iter().find(|id| !taken.contains(id)))
    }

    /// `attachOwner`: the `owner` link to the one person with the device
    /// user's email; none or several: no owner.
    async fn attach_owner(&self, record_id: &str, email: Option<&str>) -> Result<(), sqlx::Error> {
        let (Some((link_id, target_entity_key)), Some(email)) = (
            self.lookups.owner_link.as_ref(),
            email.filter(|email| !email.is_empty()),
        ) else {
            return Ok(());
        };
        let db = self.ctx.db;
        let matches: Vec<String> = sqlx::query_scalar(
            "select id from people where deleted_at is null and lower(email) = $1 limit 2",
        )
        .bind(email)
        .fetch_all(db)
        .await?;
        let [person] = matches.as_slice() else {
            return Ok(());
        };
        sqlx::query(
            "insert into custom_object_relations
                 (id, link_id, source_entity_key, source_id, target_entity_key, target_id,
                  created_by, created_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8::timestamp)",
        )
        .bind(generate_id("corl"))
        .bind(link_id)
        .bind(&self.object.entity_key)
        .bind(record_id)
        .bind(target_entity_key)
        .bind(person)
        .bind(self.user_id)
        .bind(self.now)
        .execute(db)
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_import_fields_are_typescripts() {
        let slugs: Vec<&str> = IMPORT_FIELDS.iter().map(|(slug, _, _)| *slug).collect();
        assert_eq!(
            slugs,
            [
                "manufacturer",
                "model",
                "operating_system",
                "os_version",
                "compliance",
                "last_check_in",
                "primary_user",
                "intune_device_id",
            ]
        );
        assert_eq!(MAX_WRITES, 20);
        // Every option the device mapping can answer is one of the field's.
        for state in [
            "compliant",
            "inGracePeriod",
            "configManager",
            "somethingNew",
        ] {
            let option = super::super::device::map_compliance(Some(&json!(state)));
            assert!(COMPLIANCE_OPTIONS.iter().any(|(value, _)| *value == option));
        }
    }

    #[test]
    fn counters_start_from_what_the_run_saved() {
        let mut stats = source::zero_stats()
            .as_object()
            .cloned()
            .unwrap_or_default();
        bump(&mut stats, "total");
        bump(&mut stats, "total");
        bump(&mut stats, Outcome::Created.counter());
        bump(&mut stats, Outcome::Unchanged.counter());
        assert_eq!(
            Value::Object(stats),
            json!({ "total": 2, "created": 1, "updated": 0, "unchanged": 1, "failed": 0 })
        );
    }

    #[test]
    fn a_run_is_cut_off_after_a_day() {
        let now = instant("2026-11-11T08:00:30.001Z").unwrap_or(OffsetDateTime::UNIX_EPOCH);
        assert!(ran_too_long(Some("2026-11-10T08:00:30.000Z"), now));
        // Exactly a day is still in time.
        assert!(!ran_too_long(Some("2026-11-10T08:00:30.001Z"), now));
        assert!(!ran_too_long(Some("yesterday"), now));
        assert!(!ran_too_long(None, now));
    }
}
