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
//! One step at a time: a step takes a lease on the run (`leaseUntil` in the
//! sync state, a compare-and-set) before it does anything, and gives it up
//! with its last write. A tick that finds the run leased does nothing; a
//! step that died leaves the lease to expire ([`STEP_LEASE`]).
//!
//! The last check-in is not part of the checksum: devices check in several
//! times a day, and a record write per device per run is more than a larger
//! fleet's import can do. A step keeps the check-in of the devices it leaves
//! unwritten current with one statement on the field's value column
//! instead: no record write, no event. Mappings written while the check-in
//! was part of the checksum are recognised and their checksum replaced, so
//! the change does not rewrite every device once.
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

use std::collections::{BTreeMap, HashMap, HashSet};

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{ASSET_SOURCE_UPDATED, CUSTOM_FIELD_CREATED};
use weldsuite_db::{Keyring, PgPool, decrypt_field, is_unique_violation, orm, orm_error};
use weldsuite_events::{EntityEvent, EntityEventPublisher, EventContext, EventType, iso_timestamp};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::tenant::{
    custom_field_definitions as definitions, custom_field_values as values,
    custom_object_links as links, custom_object_records as records,
    custom_object_relations as relations, integration_entity_mappings as mappings, people,
};

use super::device::{
    CHECK_IN_SLUG, COMPLIANCE_OPTIONS, CREATED_STATUS, MappedDevice, map_intune_device, text,
};
use super::microsoft::{
    DEFAULT_RETRY_AFTER_SECONDS, ErrorCode, Page, SourceError, fetch_intune_page, intune_token,
};
use super::source::{self, INTUNE_DEVICE_ENTITY_TYPE, Source, instant};
use crate::js::{Js, js_date};
use crate::objects::{CustomObject, object_by_slug};
use crate::records::{create_record_as, update_record_as};
use crate::values::ValuesError;
use crate::{iso, timestamp};

/// `ASSET_IMPORT_MAX_WRITES`: record writes (creates and updates) in one
/// step.
pub(crate) const MAX_WRITES: usize = 20;
/// `ASSET_IMPORT_MAX_RUN_MS`: a run that has not finished after this long is
/// stopped.
const MAX_RUN: time::Duration = time::Duration::hours(24);
/// `ASSET_IMPORT_STEP_LEASE_MS`: how long a step holds the run. Well over
/// what a step takes, short enough that a step that died does not hold the
/// import up for long.
const STEP_LEASE: time::Duration = time::Duration::minutes(5);

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
    /// Another step holds the run (the one of an earlier tick is still at
    /// work): this one did nothing, and the run is still under way.
    pub(crate) busy: bool,
    /// The source as stored after the step.
    pub(crate) source: Source,
}

impl StepResult {
    /// The run ended (finished or failed).
    fn ended(source: Source) -> Self {
        Self {
            done: true,
            retry_after_seconds: None,
            busy: false,
            source,
        }
    }

    /// The run goes on with a later step.
    fn under_way(source: Source) -> Self {
        Self {
            done: false,
            retry_after_seconds: None,
            busy: false,
            source,
        }
    }
}

/// What TypeScript throws out of a step: the run stays as it was and the
/// next tick repeats the step.
#[derive(Debug)]
pub(crate) enum StepFailure {
    Database(DbErr),
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

impl From<DbErr> for StepFailure {
    fn from(error: DbErr) -> Self {
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

impl From<DbErr> for Stop {
    fn from(error: DbErr) -> Self {
        Self::Failed(StepFailure::Database(error))
    }
}

/// `StepRun`: a step at work, with the run as its claim returned it.
struct Run<'a> {
    ctx: &'a ImportContext<'a>,
    /// The source as stored when the step claimed the run.
    source: Source,
    /// The run's state without the lease: what the next step finds.
    state: Value,
    /// The `leaseUntil` this step wrote: its writes go through only while
    /// the row still carries it.
    lease: String,
}

impl Run<'_> {
    /// `lostRun`: the step's last write found the run no longer its own
    /// (its lease ran out and another step took over, or the source was
    /// deleted). This step settles nothing.
    fn lost(&self) -> StepResult {
        StepResult::under_way(self.source.clone())
    }

    /// `endRun`: the run is over, finished or failed.
    async fn end(
        &self,
        stats: Option<&Value>,
        failure: Option<&SourceError>,
    ) -> Result<StepResult, DbErr> {
        let stored = source::end_run(
            self.ctx.db,
            &self.source.id,
            stats,
            self.ctx.now,
            failure,
            &self.lease,
        )
        .await?;
        Ok(stored.map_or_else(|| self.lost(), StepResult::ended))
    }

    /// `saveState`: where the run stands, for the next step; the lease goes
    /// with the write.
    async fn save(&self, next: Value) -> Result<StepResult, DbErr> {
        let saved = source::save_state(
            self.ctx.db,
            &self.source.id,
            &next,
            &iso_timestamp(self.ctx.now),
            &self.lease,
        )
        .await?;
        if !saved {
            return Ok(self.lost());
        }
        Ok(StepResult::under_way(Source {
            sync_state: Some(next),
            ..self.source.clone()
        }))
    }

    /// Where the run stands after a step's devices: stopped inside the page
    /// (`within`), on to the next page, or over. The state is saved, or the
    /// run ended.
    async fn after_page(
        &self,
        counters: Map<String, Value>,
        within: Option<usize>,
        next_link: Option<String>,
    ) -> Result<StepResult, DbErr> {
        let mut next = self.state.as_object().cloned().unwrap_or_default();
        next.insert("stats".to_owned(), Value::Object(counters));
        if let Some(index) = within {
            let link = self.state.get("nextLink").cloned().unwrap_or(Value::Null);
            next.insert("nextLink".to_owned(), link);
            next.insert("offset".to_owned(), json!(index));
        } else if let Some(next_link) = next_link {
            next.insert("nextLink".to_owned(), json!(next_link));
            next.insert("offset".to_owned(), json!(0));
        } else {
            return self.end(next.get("stats"), None).await;
        }
        self.save(Value::Object(next)).await
    }
}

/// `withoutLease(state)`: the state as the next step finds it.
fn without_lease(mut state: Value) -> Value {
    if let Some(entries) = state.as_object_mut() {
        entries.remove("leaseUntil");
    }
    state
}

/// `runAssetImportStep(ctx, source)`: one bounded step of the run under way
/// (`source.syncState`). A problem with Microsoft or with one device never
/// fails it: those end the run as `failed` (or, when throttled, wait). An
/// `Err` is a tenant database failure; the run stays as it was and a later
/// tick repeats the step, once the lease this one took has run out.
///
/// The step takes the run's lease before it does anything. When another
/// step holds it, this one does nothing and answers `busy` (not done), so
/// two ticks never import the same devices at once.
pub(crate) async fn run_step(
    ctx: &ImportContext<'_>,
    source: Source,
) -> Result<StepResult, StepFailure> {
    if source.running().is_none() {
        return Ok(StepResult::ended(source));
    }

    let lease = iso_timestamp(ctx.now + STEP_LEASE);
    let claimed = source::claim_step(ctx.db, &source.id, &iso_timestamp(ctx.now), &lease).await?;
    let Some(held) = claimed else {
        return Ok(StepResult {
            busy: true,
            ..StepResult::under_way(source)
        });
    };
    let run = Run {
        ctx,
        state: without_lease(held.sync_state.clone().unwrap_or(Value::Null)),
        source: held,
        lease,
    };

    if ran_too_long(run.state["startedAt"].as_str(), ctx.now) {
        // Its own code: the run is over, unlike `throttled`, after which the import
        // continues shortly.
        let failure = SourceError::new(ErrorCode::RunTimeout);
        return Ok(run.end(run.state.get("stats"), Some(&failure)).await?);
    }

    match step(&run).await {
        Ok(result) => Ok(result),
        Err(Stop::Failed(failure)) => Err(failure),
        Err(Stop::Refused(failure)) if failure.code == ErrorCode::Throttled => {
            source::release_lease(ctx.db, &run.source.id, &run.lease).await?;
            let waiting = Source {
                sync_state: Some(run.state),
                ..run.source
            };
            Ok(StepResult {
                retry_after_seconds: Some(
                    failure
                        .retry_after_seconds
                        .unwrap_or(DEFAULT_RETRY_AFTER_SECONDS),
                ),
                ..StepResult::under_way(waiting)
            })
        }
        Err(Stop::Refused(failure)) => Ok(run.end(run.state.get("stats"), Some(&failure)).await?),
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
#[derive(Debug, Clone)]
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
    let db = &orm(db);
    let mut by_device: HashMap<String, Mapping> = HashMap::new();
    if !ids.is_empty() {
        let rows: Vec<(String, String, String, Option<String>)> = mappings::Entity::find()
            .select_only()
            .columns([
                mappings::Column::Id,
                mappings::Column::ExternalEntityId,
                mappings::Column::InternalEntityId,
                mappings::Column::SyncChecksum,
            ])
            .filter(mappings::Column::ConnectionId.eq(&source.id))
            .filter(mappings::Column::ExternalEntityType.eq(INTUNE_DEVICE_ENTITY_TYPE))
            .filter(mappings::Column::ExternalEntityId.is_in(ids))
            .into_tuple()
            .all(db)
            .await?;
        for (id, external_id, internal_entity_id, sync_checksum) in rows {
            by_device.insert(
                external_id,
                Mapping {
                    id,
                    internal_entity_id,
                    sync_checksum,
                },
            );
        }
    }
    let mut deleted: HashMap<String, bool> = HashMap::new();
    if !by_device.is_empty() {
        let record_ids = by_device
            .values()
            .map(|mapping| mapping.internal_entity_id.as_str());
        let rows: Vec<(String, Option<PrimitiveDateTime>)> = records::Entity::find()
            .select_only()
            .columns([records::Column::Id, records::Column::DeletedAt])
            .filter(records::Column::EntityKey.eq(entity_key))
            .filter(records::Column::Id.is_in(record_ids))
            .into_tuple()
            .all(db)
            .await?;
        deleted.extend(
            rows.into_iter()
                .map(|(id, deleted_at)| (id, deleted_at.is_some())),
        );
    }
    Ok((by_device, deleted))
}

/// What a step keeps of the page it reads while it goes through the
/// devices.
struct PageWork {
    /// The mappings of the devices still to handle, by device id.
    mappings: HashMap<String, Mapping>,
    /// Whether the record a mapping points to is deleted, by record id.
    records: HashMap<String, bool>,
    /// Records this run has already tied to a device (adoption must not
    /// take them twice).
    claimed: HashSet<String>,
    /// The last check-in of each device this step left unwritten, by its
    /// (live) record.
    check_ins: BTreeMap<String, String>,
    /// The checksum to put in place of one of the old kind, by mapping id.
    replaced: BTreeMap<String, String>,
    /// The check-ins the page's records hold, read once, when a checksum
    /// first differs.
    stored_check_ins: Option<HashMap<String, String>>,
}

async fn step(run: &Run<'_>) -> Result<StepResult, Stop> {
    let ctx = run.ctx;
    let (source, state) = (&run.source, &run.state);
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
    let (mappings, records) = page_matches(db, source, entity_key, remaining).await?;
    let mut work = PageWork {
        mappings,
        records,
        claimed: HashSet::new(),
        check_ins: BTreeMap::new(),
        replaced: BTreeMap::new(),
        stored_check_ins: None,
    };
    let job = Job {
        ctx,
        source,
        object: &object,
        user_id,
        now: &now,
        lookups: prepare_lookups(db, entity_key).await?,
    };
    let mut writes = 0;

    while index < page.devices.len() && writes < ctx.max_writes {
        let device = &page.devices[index];
        index += 1;
        bump(&mut counters, "total");
        match job.import_device(device, &mut work).await {
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

    // What the step owes the devices it did not write: neither counts as a
    // write. The checksums first: one of the old kind is recognised by the
    // check-in the record still holds, so a step that dies in between must
    // not have moved it.
    job.replace_checksums(&work.replaced).await?;
    job.refresh_check_ins(&work.check_ins).await?;

    // Stopped inside the page: the next step reads it again from `index`.
    let within = (index < page.devices.len()).then_some(index);
    Ok(run.after_page(counters, within, page.next_link).await?)
}

/// `ensureAssetImportFields`: add the fields the import writes that the
/// object does not have yet, once. A field that exists (made by the
/// template, by hand or by an earlier import) is left as it is. Answers the
/// definitions it created, for their events.
async fn ensure_import_fields(
    db: &PgPool,
    entity_key: &str,
    now: &str,
) -> Result<Vec<Value>, DbErr> {
    let db = &orm(db);
    let now = timestamp(now)?;
    let existing: Vec<(String, Option<i32>)> = definitions::Entity::find()
        .select_only()
        .columns([definitions::Column::Slug, definitions::Column::SortOrder])
        .filter(definitions::Column::EntityType.eq(entity_key))
        .filter(definitions::Column::DeletedAt.is_null())
        .into_tuple()
        .all(db)
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
        let inserted = definitions::Entity::insert(definitions::ActiveModel {
            id: Set(id.clone()),
            entity_type: Set(entity_key.to_owned()),
            name: Set(name.to_owned()),
            slug: Set(slug.to_owned()),
            field_type: Set(field_type.to_owned()),
            options: Set(options),
            required: Set(Some(false)),
            sort_order: Set(Some(position)),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_without_returning(db)
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

/// The value column the last check-in is kept in, by the type of its field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CheckInColumn {
    Date,
    Text,
}

/// `checkInColumnOf(fieldType)`: the import adds the field as a date; one
/// made by hand may be text. Any other type is left to the record writes.
fn check_in_column_of(field_type: &str) -> Option<CheckInColumn> {
    match field_type {
        "date" => Some(CheckInColumn::Date),
        "text" | "textarea" => Some(CheckInColumn::Text),
        _ => None,
    }
}

/// `isStorableCheckIn(checkIn)`: a check-in the value column takes as it is
/// written, `toISOString()` of a four-digit year. (A later year has a sign
/// and six digits, which Postgres does not read; a record write refuses it
/// too.)
fn is_storable_check_in(check_in: &str) -> bool {
    check_in.len() == 24
}

/// `Lookups`: what matching a device needs from the object, read once per
/// step.
struct Lookups {
    /// The live `serial_number` field.
    serial_field_id: Option<String>,
    /// The live `last_check_in` field, when its type keeps the check-in as
    /// a date or as plain text: `(id, value column)`.
    check_in_field: Option<(String, CheckInColumn)>,
    /// The live `owner` link: `(id, target entity key)`.
    owner_link: Option<(String, String)>,
}

async fn prepare_lookups(db: &PgPool, entity_key: &str) -> Result<Lookups, DbErr> {
    let db = &orm(db);
    let fields: Vec<(String, String, String)> = definitions::Entity::find()
        .select_only()
        .columns([
            definitions::Column::Id,
            definitions::Column::Slug,
            definitions::Column::FieldType,
        ])
        .filter(definitions::Column::EntityType.eq(entity_key))
        .filter(definitions::Column::Slug.is_in(["serial_number", CHECK_IN_SLUG]))
        .filter(definitions::Column::DeletedAt.is_null())
        .into_tuple()
        .all(db)
        .await?;
    let field = |slug: &str| fields.iter().find(|(_, found, _)| found == slug);
    let serial_field_id = field("serial_number").map(|(id, _, _)| id.clone());
    let check_in_field = field(CHECK_IN_SLUG).and_then(|(id, _, field_type)| {
        check_in_column_of(field_type).map(|column| (id.clone(), column))
    });
    let owner_link: Option<(String, String)> = links::Entity::find()
        .select_only()
        .columns([links::Column::Id, links::Column::TargetEntityKey])
        .filter(links::Column::SourceEntityKey.eq(entity_key))
        .filter(links::Column::Slug.eq("owner"))
        .filter(links::Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await?;
    Ok(Lookups {
        serial_field_id,
        check_in_field,
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
    Database(DbErr),
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

impl From<DbErr> for DeviceError {
    fn from(error: DbErr) -> Self {
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

    /// `importDevice(job, device)`.
    async fn import_device(
        &self,
        device: &Value,
        work: &mut PageWork,
    ) -> Result<Outcome, DeviceError> {
        let mapped = map_intune_device(device).ok_or(DeviceError::NoId)?;
        let checksum = mapped.checksum();
        match work.mappings.get(&mapped.external_id).cloned() {
            Some(mapping) => self.import_mapped(&mapped, &mapping, checksum, work).await,
            None => self.import_unmapped(&mapped, &checksum, work).await,
        }
    }

    /// `importMapped`: a device this source imported before, written again
    /// only when a fact other than the last check-in changed.
    async fn import_mapped(
        &self,
        mapped: &MappedDevice,
        mapping: &Mapping,
        checksum: String,
        work: &mut PageWork,
    ) -> Result<Outcome, DeviceError> {
        let db = self.ctx.db;
        let record_id = mapping.internal_entity_id.as_str();
        // A record a person deleted stays deleted; the import does not
        // bring it back.
        let live = work.records.get(record_id).is_some_and(|deleted| !deleted);
        if !live {
            return Ok(Outcome::Unchanged);
        }

        if mapping.sync_checksum.as_deref() == Some(checksum.as_str())
            || self
                .is_checksum_of_old_kind(mapped, mapping, &checksum, work)
                .await?
        {
            if let Some(check_in) = mapped.check_in().filter(|at| is_storable_check_in(at)) {
                work.check_ins
                    .insert(record_id.to_owned(), check_in.to_owned());
            }
            return Ok(Outcome::Unchanged);
        }

        let updated = update_record_as(
            db,
            self.user_id,
            self.object,
            record_id,
            Some(&mapped.facts()),
            &Field::Absent,
        )
        .await?;
        let now = timestamp(self.now)?;
        mappings::Entity::update_many()
            .col_expr(
                mappings::Column::SyncChecksum,
                Expr::value(checksum.as_str()),
            )
            .col_expr(mappings::Column::LastSyncedAt, Expr::value(now))
            .col_expr(mappings::Column::UpdatedAt, Expr::value(now))
            .filter(mappings::Column::Id.eq(&mapping.id))
            .exec(&orm(db))
            .await?;
        if let Some(kept) = work.mappings.get_mut(&mapped.external_id) {
            kept.sync_checksum = Some(checksum);
        }
        // The write carried the check-in and the checksum: nothing is left
        // to settle for this record.
        work.check_ins.remove(record_id);
        work.replaced.remove(&mapping.id);
        self.emit("updated", &updated).await?;
        Ok(Outcome::Updated)
    }

    /// `isChecksumOfOldKind`: whether the mapping carries a checksum of the
    /// old kind (taken with the last check-in) of these same facts: with
    /// the check-in the record holds, with the one the device reports now,
    /// or with none. Then nothing but the check-in differs, and the
    /// checksum is replaced at the end of the step instead of the record
    /// being rewritten: the first import after the checksum changed does
    /// not write every device once.
    async fn is_checksum_of_old_kind(
        &self,
        mapped: &MappedDevice,
        mapping: &Mapping,
        checksum: &str,
        work: &mut PageWork,
    ) -> Result<bool, DbErr> {
        if work.stored_check_ins.is_none() {
            work.stored_check_ins = Some(self.load_stored_check_ins(&work.records).await?);
        }
        let stored = work
            .stored_check_ins
            .as_ref()
            .and_then(|stored| stored.get(&mapping.internal_entity_id))
            .map(String::as_str);
        let of_old_kind = [stored, mapped.check_in(), None]
            .into_iter()
            .any(|check_in| Some(mapped.checksum_with_check_in(check_in)) == mapping.sync_checksum);
        if of_old_kind {
            work.replaced
                .insert(mapping.id.clone(), checksum.to_owned());
            if let Some(kept) = work.mappings.get_mut(&mapped.external_id) {
                kept.sync_checksum = Some(checksum.to_owned());
            }
        }
        Ok(of_old_kind)
    }

    /// `loadStoredCheckIns`: the last check-in each live record of the page
    /// holds, as the import wrote it (ISO). One query.
    async fn load_stored_check_ins(
        &self,
        records: &HashMap<String, bool>,
    ) -> Result<HashMap<String, String>, DbErr> {
        let ids: Vec<&str> = records
            .iter()
            .filter(|(_, deleted)| !**deleted)
            .map(|(id, _)| id.as_str())
            .collect();
        let Some((field_id, column)) = self.lookups.check_in_field.as_ref() else {
            return Ok(HashMap::new());
        };
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(String, Option<PrimitiveDateTime>, Option<String>)> = values::Entity::find()
            .select_only()
            .columns([
                values::Column::EntityId,
                values::Column::ValueDate,
                values::Column::ValueText,
            ])
            .filter(values::Column::FieldId.eq(field_id))
            .filter(values::Column::EntityType.eq(&self.object.entity_key))
            .filter(values::Column::EntityId.is_in(ids))
            .into_tuple()
            .all(&orm(self.ctx.db))
            .await?;
        let mut stored = HashMap::new();
        for (record_id, date, text) in rows {
            let value = match column {
                // `row.date?.toISOString()`.
                CheckInColumn::Date => date.map(iso),
                CheckInColumn::Text => text,
            };
            if let Some(value) = value.filter(|value| !value.is_empty()) {
                stored.insert(record_id, value);
            }
        }
        Ok(stored)
    }

    /// `refreshCheckIns`: keep the last check-in of the devices this step
    /// left unwritten current. One statement on the field's value column:
    /// a value that differs is replaced, a record that holds none yet (the
    /// device had not checked in when it was last written) gets its value
    /// row, and a value that is current is left as it is. No record is
    /// written (its `updated_at` stays), no event goes out, and it does not
    /// count against the step's writes.
    #[allow(
        clippy::disallowed_methods,
        reason = "one bulk upsert from `unnest`ed arrays that writes only the values that \
                  differ (`on conflict … do update … where … is distinct from`)"
    )]
    async fn refresh_check_ins(&self, check_ins: &BTreeMap<String, String>) -> Result<(), DbErr> {
        let Some((field_id, column)) = self.lookups.check_in_field.as_ref() else {
            return Ok(());
        };
        if check_ins.is_empty() {
            return Ok(());
        }
        // The id is only used for a value row that does not exist yet.
        let ids: Vec<String> = check_ins.iter().map(|_| generate_id("cfv")).collect();
        let record_ids: Vec<&str> = check_ins.keys().map(String::as_str).collect();
        let stamps: Vec<&str> = check_ins.values().map(String::as_str).collect();
        let statement = match column {
            CheckInColumn::Date => {
                "insert into custom_field_values as v
                     (id, field_id, entity_type, entity_id, value_date, created_at, updated_at)
                 select x.id, $1, $2, x.record_id, x.check_in::timestamp,
                        $3::timestamp, $3::timestamp
                   from unnest($4::text[], $5::text[], $6::text[]) as x(id, record_id, check_in)
                 on conflict (entity_type, entity_id, field_id) do update
                    set value_date = excluded.value_date, updated_at = excluded.updated_at
                  where v.value_date is distinct from excluded.value_date"
            }
            CheckInColumn::Text => {
                "insert into custom_field_values as v
                     (id, field_id, entity_type, entity_id, value_text, created_at, updated_at)
                 select x.id, $1, $2, x.record_id, x.check_in, $3::timestamp, $3::timestamp
                   from unnest($4::text[], $5::text[], $6::text[]) as x(id, record_id, check_in)
                 on conflict (entity_type, entity_id, field_id) do update
                    set value_text = excluded.value_text, updated_at = excluded.updated_at
                  where v.value_text is distinct from excluded.value_text"
            }
        };
        sqlx::query(statement)
            .bind(field_id)
            .bind(&self.object.entity_key)
            .bind(self.now)
            .bind(&ids)
            .bind(&record_ids)
            .bind(&stamps)
            .execute(self.ctx.db)
            .await
            .map_err(orm_error)?;
        Ok(())
    }

    /// `replaceChecksums`: put the checksum without the check-in in place
    /// of each one of the old kind this step recognised. One statement.
    #[allow(
        clippy::disallowed_methods,
        reason = "one bulk `update … from unnest(…)`: each mapping its own checksum, in one \
                  statement"
    )]
    async fn replace_checksums(&self, replaced: &BTreeMap<String, String>) -> Result<(), DbErr> {
        if replaced.is_empty() {
            return Ok(());
        }
        let ids: Vec<&str> = replaced.keys().map(String::as_str).collect();
        let checksums: Vec<&str> = replaced.values().map(String::as_str).collect();
        sqlx::query(
            "update integration_entity_mappings as m
                set sync_checksum = x.checksum, updated_at = $1::timestamp
               from unnest($2::text[], $3::text[]) as x(id, checksum)
              where m.id = x.id",
        )
        .bind(self.now)
        .bind(&ids)
        .bind(&checksums)
        .execute(self.ctx.db)
        .await
        .map_err(orm_error)?;
        Ok(())
    }

    /// `importUnmapped`: a device this source has not imported yet. A
    /// record with its serial number is adopted, else one is created.
    async fn import_unmapped(
        &self,
        mapped: &MappedDevice,
        checksum: &str,
        work: &mut PageWork,
    ) -> Result<Outcome, DeviceError> {
        let db = self.ctx.db;
        let facts = mapped.facts();

        let adoptable = self
            .find_adoptable_record(mapped.serial_number.as_deref(), &work.claimed)
            .await?;
        if let Some(record_id) = adoptable {
            work.claimed.insert(record_id.clone());
            let updated = update_record_as(
                db,
                self.user_id,
                self.object,
                &record_id,
                Some(&facts),
                &Field::Absent,
            )
            .await?;
            self.insert_mapping(
                &mapped.external_id,
                &record_id,
                checksum,
                &mut work.mappings,
            )
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
        let definitions = crate::values::definitions(db, &self.object.entity_key).await?;
        let created =
            create_record_as(db, self.user_id, self.object, &definitions, fields, None).await?;
        let record_id = created["id"].as_str().unwrap_or_default().to_owned();
        work.claimed.insert(record_id.clone());
        self.insert_mapping(
            &mapped.external_id,
            &record_id,
            checksum,
            &mut work.mappings,
        )
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
        known: &mut HashMap<String, Mapping>,
    ) -> Result<(), DbErr> {
        let id = generate_id("iem");
        let now = timestamp(self.now)?;
        mappings::Entity::insert(mappings::ActiveModel {
            id: Set(id.clone()),
            connection_id: Set(self.source.id.clone()),
            external_entity_type: Set(INTUNE_DEVICE_ENTITY_TYPE.to_owned()),
            external_entity_id: Set(external_id.to_owned()),
            internal_entity_type: Set(self.object.entity_key.clone()),
            internal_entity_id: Set(record_id.to_owned()),
            sync_checksum: Set(Some(checksum.to_owned())),
            last_synced_at: Set(Some(now)),
            created_at: Set(now),
            updated_at: Set(now),
        })
        .exec_without_returning(&orm(self.ctx.db))
        .await?;
        known.insert(
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
    ) -> Result<Option<String>, DbErr> {
        let (Some(serial), Some(serial_field_id)) = (
            serial.filter(|serial| !serial.is_empty()),
            self.lookups.serial_field_id.as_deref(),
        ) else {
            return Ok(None);
        };
        let db = &orm(self.ctx.db);
        let key = self.object.entity_key.as_str();
        // The records whose serial number value matches: value rows joined
        // to their (live) records.
        let candidates: Vec<String> = records::Entity::find()
            .select_only()
            .column(records::Column::Id)
            .join(
                JoinType::InnerJoin,
                records::Entity::belongs_to(values::Entity)
                    .from(records::Column::Id)
                    .to(values::Column::EntityId)
                    .into(),
            )
            .filter(values::Column::FieldId.eq(serial_field_id))
            .filter(values::Column::EntityType.eq(key))
            .filter(values::Column::ValueText.eq(serial))
            .filter(records::Column::EntityKey.eq(key))
            .filter(records::Column::DeletedAt.is_null())
            .order_by_asc(records::Column::CreatedAt)
            .order_by_asc(records::Column::Id)
            .into_tuple()
            .all(db)
            .await?;
        let free: Vec<String> = candidates
            .into_iter()
            .filter(|id| !claimed.contains(id))
            .collect();
        if free.is_empty() {
            return Ok(None);
        }
        let taken: Vec<String> = mappings::Entity::find()
            .select_only()
            .column(mappings::Column::InternalEntityId)
            .filter(mappings::Column::ConnectionId.eq(&self.source.id))
            .filter(mappings::Column::ExternalEntityType.eq(INTUNE_DEVICE_ENTITY_TYPE))
            .filter(mappings::Column::InternalEntityId.is_in(free.iter().map(String::as_str)))
            .into_tuple()
            .all(db)
            .await?;
        Ok(free.into_iter().find(|id| !taken.contains(id)))
    }

    /// `attachOwner`: the `owner` link to the one person with the device
    /// user's email; none or several: no owner.
    async fn attach_owner(&self, record_id: &str, email: Option<&str>) -> Result<(), DbErr> {
        let (Some((link_id, target_entity_key)), Some(email)) = (
            self.lookups.owner_link.as_ref(),
            email.filter(|email| !email.is_empty()),
        ) else {
            return Ok(());
        };
        let db = &orm(self.ctx.db);
        // `lower(email) = $email`.
        let same_email = sea_orm::ExprTrait::eq(
            Expr::expr(Func::lower(Expr::col((
                people::Entity,
                people::Column::Email,
            )))),
            email,
        );
        let matches: Vec<String> = people::Entity::find()
            .select_only()
            .column(people::Column::Id)
            .filter(people::Column::DeletedAt.is_null())
            .filter(same_email)
            .limit(2)
            .into_tuple()
            .all(db)
            .await?;
        let [person] = matches.as_slice() else {
            return Ok(());
        };
        relations::Entity::insert(relations::ActiveModel {
            id: Set(generate_id("corl")),
            link_id: Set(link_id.clone()),
            source_entity_key: Set(self.object.entity_key.clone()),
            source_id: Set(record_id.to_owned()),
            target_entity_key: Set(target_entity_key.clone()),
            target_id: Set(person.clone()),
            created_by: Set(Some(self.user_id.to_owned())),
            created_at: Set(timestamp(self.now)?),
            ..Default::default()
        })
        .exec_without_returning(db)
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
    fn the_lease_is_the_steps_own_and_never_part_of_the_state_it_saves() {
        let now = instant("2026-11-10T08:00:30.000Z").unwrap_or(OffsetDateTime::UNIX_EPOCH);
        // `new Date(now.getTime() + ASSET_IMPORT_STEP_LEASE_MS).toISOString()`.
        assert_eq!(iso_timestamp(now + STEP_LEASE), "2026-11-10T08:05:30.000Z");

        let state = json!({
            "startedAt": "2026-11-10T08:00:00.000Z", "nextLink": null, "offset": 20,
            "stats": source::zero_stats(), "leaseUntil": "2026-11-10T08:05:30.000Z",
        });
        assert_eq!(
            without_lease(state),
            json!({
                "startedAt": "2026-11-10T08:00:00.000Z", "nextLink": null, "offset": 20,
                "stats": source::zero_stats(),
            })
        );
        // A state that is no object has no lease to drop.
        assert_eq!(without_lease(Value::Null), Value::Null);
    }

    #[test]
    fn the_check_in_is_refreshed_in_the_column_its_field_keeps_it_in() {
        assert_eq!(check_in_column_of("date"), Some(CheckInColumn::Date));
        assert_eq!(check_in_column_of("text"), Some(CheckInColumn::Text));
        assert_eq!(check_in_column_of("textarea"), Some(CheckInColumn::Text));
        // Any other type is left to the record writes.
        for other in ["number", "single_select", "boolean", "url", ""] {
            assert_eq!(check_in_column_of(other), None, "{other}");
        }
        // `toISOString()` of a four-digit year; a later one carries a sign.
        assert!(is_storable_check_in("2026-11-10T07:45:00.000Z"));
        assert!(!is_storable_check_in("+012026-11-10T07:45:00.000Z"));
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
