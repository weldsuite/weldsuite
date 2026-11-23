//! The connector sync runner (`connectors/sync.ts`): pulls pages from the
//! provider, ingests them, and writes a sync-run row. A run reads at most ten
//! pages; a truncated run keeps a `<model>__page` / `<model>__cursor`
//! watermark so the next pass continues, and the modified-at watermark
//! advances only when a full scan finishes cleanly. Plus the run bookkeeping
//! of `connectors/connections.ts` (`startSyncRun`, `finishSyncRun`,
//! `markConnectionError`).

use std::sync::Arc;
use std::sync::atomic::AtomicI64;

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect, RuntimeErr,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::{Keyring, PgPool, orm, utc_now};
use weldsuite_schema::tenant::{connector_connections as connections, connector_sync_runs as runs};
use weldsuite_events::EntityEventPublisher;
use weldsuite_kit::generate_id;
use weldsuite_ports::{DynFileStore, OutboundHttp};

use crate::catalog::{get_connector, syncs};
use crate::clients::{ConnectorError, Kind, decrypt_credentials};
use crate::ingest::{
    IngestArgs, IngestResult, MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET, MoneybirdFiles,
    STRIPE_PDF_DOWNLOAD_BUDGET, StripeFiles, ingest_records,
};
use crate::mappers::modified_at_of;
use crate::provider::ProviderClient;

const MAX_PAGES: u32 = 10;
const PER_PAGE: u32 = 100;

/// Where the workspace's background work is scheduled: the master due
/// index (`workspace_due_index`) and the workspace's `workspaces.id`.
#[derive(Clone)]
pub struct DueIndex {
    pub master: PgPool,
    pub workspace_id: String,
}

/// What a sync reads besides the connection: `ConnectorSyncEnv`.
#[derive(Clone)]
pub struct SyncEnv {
    pub keyring: Keyring,
    /// `STRIPE_SECRET_KEY`: OAuth Stripe connections read with it.
    pub stripe_secret_key: Option<String>,
    /// `STORAGE`: where Moneybird attachments and Stripe PDFs are copied.
    pub storage: Option<Arc<dyn DynFileStore>>,
    pub http: Option<OutboundHttp>,
    pub events: EntityEventPublisher,
    /// The due index (the Moneybird push backlog, the connector catch-up);
    /// without it nothing is scheduled.
    pub due: Option<DueIndex>,
}

/// `SyncConnectionArgs.trigger`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Manual,
    Initial,
    Schedule,
    Webhook,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Initial => "initial",
            Self::Schedule => "schedule",
            Self::Webhook => "webhook",
        }
    }
}

/// `SyncConnectionArgs`.
pub struct SyncArgs<'a> {
    pub db: &'a PgPool,
    pub env: &'a SyncEnv,
    /// The connection row (`to_jsonb`, `snake_case`).
    pub connection: &'a Value,
    pub owner_id: &'a str,
    /// The Clerk org id: events and R2 keys use it.
    pub workspace_id: &'a str,
    pub trigger: Trigger,
    pub full: bool,
    pub syncs: Option<Vec<String>>,
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `withRuntimeCredentials(connection, credentials, env)`: Stripe rebuilt
/// from an allow-list, with the platform key only for the OAuth account the
/// connection was made for.
pub fn with_runtime_credentials(
    connection: &Value,
    credentials: Map<String, Value>,
    stripe_secret_key: Option<&str>,
) -> Map<String, Value> {
    if text(connection, "provider") != Some("stripe") {
        return credentials;
    }
    let trim = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .map(|s| weldsuite_kit::validation::js_trim(s).to_owned())
            .filter(|s| !s.is_empty())
    };
    let mut runtime = Map::new();
    if let Some(entity) = credentials.get("entityId").filter(|v| crate::js::truthy(v)) {
        runtime.insert("entityId".to_owned(), entity.clone());
    }
    let start = connection
        .get("settings")
        .and_then(|s| s.get("importStartDate"));
    if let Some(start) = trim(start) {
        runtime.insert("importStartDate".to_owned(), json!(start));
    }
    if let Some(key) = trim(credentials.get("apiKey")) {
        runtime.insert("apiKey".to_owned(), json!(key));
        return runtime;
    }
    let account = trim(credentials.get("stripeUserId"));
    let platform = stripe_secret_key
        .map(|k| weldsuite_kit::validation::js_trim(k).to_owned())
        .filter(|k| !k.is_empty());
    if let (Some(account), Some(platform)) = (account, platform)
        && Some(account.as_str()) == text(connection, "external_account_id")
    {
        runtime.insert("stripeUserId".to_owned(), json!(account));
        runtime.insert("platformSecretKey".to_owned(), json!(platform));
    }
    runtime
}

/// `skippedFinancialAccountIds(connection)`.
pub fn skipped_financial_account_ids(connection: &Value) -> Vec<String> {
    if text(connection, "provider") != Some("moneybird") {
        return Vec::new();
    }
    connection
        .get("settings")
        .and_then(|s| s.get("moneybirdPush"))
        .and_then(|p| p.get("financialAccountId"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(|id| vec![id.to_owned()])
        .unwrap_or_default()
}

/// The decrypted credentials plus the runtime ones, and the client.
pub fn client_for(
    connection: &Value,
    env: &SyncEnv,
) -> Result<(Map<String, Value>, ProviderClient), ConnectorError> {
    let credentials = with_runtime_credentials(
        connection,
        decrypt_credentials(connection.get("credentials"), &env.keyring),
        env.stripe_secret_key.as_deref(),
    );
    let client = ProviderClient::new(
        text(connection, "provider").unwrap_or_default(),
        &credentials,
        text(connection, "external_account_id"),
    )?;
    Ok((credentials, client))
}

// ── run bookkeeping ─────────────────────────────────────────────────────────

/// `startSyncRun(...)`.
pub async fn start_sync_run(
    db: &PgPool,
    connection_id: &str,
    sync_name: &str,
    model: &str,
    trigger: &str,
    sync_type: &str,
) -> Result<String, DbErr> {
    let id = generate_id("crun");
    runs::Entity::insert(runs::ActiveModel {
        id: Set(id.clone()),
        connection_id: Set(connection_id.to_owned()),
        sync_name: Set(sync_name.to_owned()),
        model_: Set(model.to_owned()),
        status: Set("running".to_owned()),
        trigger: Set(trigger.to_owned()),
        sync_type: Set(Some(sync_type.to_owned())),
        started_at: Set(utc_now()),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
    .await?;
    Ok(id)
}

/// What `finishSyncRun` records.
pub struct RunEnd<'a> {
    pub status: &'a str,
    pub applied: &'a IngestResult,
    pub error: Option<String>,
    /// `syncWatermarksPatch`: `None` values remove a key.
    pub watermarks: Vec<(String, Option<String>)>,
}

/// `(extract(epoch from (finished - started)) * 1000)::bigint`: whole
/// milliseconds, a half rounded away from zero as `numeric` casts.
fn duration_ms(started: PrimitiveDateTime, finished: PrimitiveDateTime) -> i64 {
    let micros = (finished - started).whole_microseconds();
    let millis = if micros < 0 {
        -((-micros + 500) / 1000)
    } else {
        (micros + 500) / 1000
    };
    i64::try_from(millis).unwrap_or(if millis < 0 { i64::MIN } else { i64::MAX })
}

/// `finishSyncRun(...)`.
pub async fn finish_sync_run(
    db: &PgPool,
    run_id: &str,
    connection_id: &str,
    end: &RunEnd<'_>,
) -> Result<(), DbErr> {
    let now = utc_now();
    let error = end
        .error
        .as_deref()
        .filter(|e| !e.is_empty())
        .map(|e| crate::mappers::slice_units(e, 2000));
    let samples = (!end.applied.error_samples.is_empty()).then(|| end.applied.samples_json());
    let db = &orm(db);
    // `duration_ms = case when started_at is null then null else … end`.
    let started: Option<PrimitiveDateTime> = runs::Entity::find()
        .select_only()
        .column(runs::Column::StartedAt)
        .filter(runs::Column::Id.eq(run_id))
        .into_tuple()
        .one(db)
        .await?;
    let count = |n: u64| Expr::value(i64::try_from(n).unwrap_or(i64::MAX));
    runs::Entity::update_many()
        .col_expr(runs::Column::Status, Expr::value(end.status))
        .col_expr(runs::Column::RecordsAdded, Expr::value(0))
        .col_expr(runs::Column::RecordsUpdated, Expr::value(0))
        .col_expr(runs::Column::RecordsDeleted, Expr::value(0))
        .col_expr(runs::Column::RecordsCreated, count(end.applied.created))
        .col_expr(runs::Column::RecordsModified, count(end.applied.modified))
        .col_expr(runs::Column::RecordsSkipped, count(end.applied.skipped))
        .col_expr(runs::Column::RecordsFailed, count(end.applied.failed))
        .col_expr(runs::Column::FinishedAt, Expr::value(now))
        .col_expr(
            runs::Column::DurationMs,
            Expr::value(started.map(|started| duration_ms(started, now))),
        )
        .col_expr(runs::Column::Error, Expr::value(error.clone()))
        .col_expr(runs::Column::ErrorSamples, Expr::value(samples))
        .filter(runs::Column::Id.eq(run_id))
        .exec(db)
        .await?;
    let applied = i64::try_from(end.applied.created + end.applied.modified).unwrap_or(i64::MAX);
    let set: Map<String, Value> = end
        .watermarks
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|v| (k.clone(), json!(v))))
        .collect();
    // `status = case when status = 'auth_error' then 'auth_error' when $2 =
    // 'error' then 'sync_error' when status = 'paused' then 'paused' else
    // 'active' end`.
    let status = if end.status == "error" {
        Expr::case(connections::Column::Status.eq("auth_error"), "auth_error").finally("sync_error")
    } else {
        Expr::case(connections::Column::Status.eq("auth_error"), "auth_error")
            .case(connections::Column::Status.eq("paused"), "paused")
            .finally("active")
    };
    let mut update = connections::Entity::update_many()
        .col_expr(connections::Column::LastSyncAt, Expr::value(now))
        .col_expr(connections::Column::LastSyncStatus, Expr::value(end.status))
        .col_expr(
            connections::Column::LastErrorAt,
            Expr::value(error.is_some().then_some(now)),
        )
        .col_expr(connections::Column::LastError, Expr::value(error))
        .col_expr(
            connections::Column::RecordsSynced,
            sea_orm::ExprTrait::add(Expr::col(connections::Column::RecordsSynced), applied),
        )
        .col_expr(connections::Column::Status, status.into())
        .col_expr(connections::Column::UpdatedAt, Expr::value(now));
    if !end.watermarks.is_empty() {
        // `(coalesce(sync_watermarks, '{}') || $set) - $remove`: one key at a time.
        let mut watermarks = sea_orm::sea_query::extension::postgres::PgExpr::concat(
            Expr::from(Func::coalesce([
                Expr::col(connections::Column::SyncWatermarks),
                Expr::val(json!({})),
            ])),
            Expr::val(Value::Object(set)),
        );
        for (key, value) in &end.watermarks {
            if value.is_none() {
                watermarks = sea_orm::ExprTrait::sub(watermarks, Expr::val(key.as_str()));
            }
        }
        update = update.col_expr(connections::Column::SyncWatermarks, watermarks);
    }
    update
        .filter(connections::Column::Id.eq(connection_id))
        .exec(db)
        .await?;
    Ok(())
}

/// `markConnectionError({ status, message })`.
pub async fn mark_connection_error(
    db: &PgPool,
    connection_id: &str,
    status: &str,
    message: &str,
) -> Result<(), DbErr> {
    let now = utc_now();
    connections::Entity::update_many()
        .set(connections::ActiveModel {
            status: Set(status.to_owned()),
            last_error: Set(Some(crate::mappers::slice_units(message, 2000))),
            last_error_at: Set(Some(now)),
            updated_at: Set(now),
            ..Default::default()
        })
        .filter(connections::Column::Id.eq(connection_id))
        .exec(&orm(db))
        .await
        .map(|_| ())
}

/// A database error's text as sqlx wrote it (SeaORM's wrapper adds a
/// prefix of its own): what a failed run records and logs.
pub(crate) fn db_error_text(error: &DbErr) -> String {
    match error {
        DbErr::Conn(RuntimeErr::SqlxError(inner))
        | DbErr::Exec(RuntimeErr::SqlxError(inner))
        | DbErr::Query(RuntimeErr::SqlxError(inner)) => inner.to_string(),
        other => other.to_string(),
    }
}

// ── the runner ──────────────────────────────────────────────────────────────

/// Why a sync stopped: a connector error (auth failures end the whole sync)
/// or the database.
#[derive(Debug)]
pub enum SyncError {
    Connector(ConnectorError),
    Database(DbErr),
}

impl From<DbErr> for SyncError {
    fn from(error: DbErr) -> Self {
        Self::Database(error)
    }
}

impl From<ConnectorError> for SyncError {
    fn from(error: ConnectorError) -> Self {
        Self::Connector(error)
    }
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connector(error) => f.write_str(&error.message),
            Self::Database(error) => f.write_str(&db_error_text(error)),
        }
    }
}

/// `requestedSyncKeys(connector, args)`: bank transactions pull bank
/// accounts first.
fn requested_sync_keys(connector: &Value, args: &SyncArgs<'_>) -> Vec<String> {
    let requested: Vec<String> = match &args.syncs {
        Some(keys) if !keys.is_empty() => keys.clone(),
        _ => args
            .connection
            .get("enabled_syncs")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    };
    let names_for = |entity: &str| -> Vec<String> {
        syncs(connector)
            .iter()
            .filter(|s| s["internalEntity"] == entity)
            .filter_map(|s| s["syncName"].as_str().map(str::to_owned))
            .collect()
    };
    let wants_tx = requested
        .iter()
        .any(|k| k == "bankTransactions" || names_for("bank_transaction").contains(k));
    let has_accounts = requested
        .iter()
        .any(|k| k == "bankAccounts" || names_for("bank_account").contains(k));
    if wants_tx && !has_accounts && !names_for("bank_account").is_empty() {
        let mut out = vec!["bankAccounts".to_owned()];
        out.extend(requested);
        return out;
    }
    requested
}

/// `enabledConnectorSyncs(connector, enabled)` keeping inbound ones.
fn syncs_to_run(connector: &Value, args: &SyncArgs<'_>) -> Vec<Value> {
    let requested = requested_sync_keys(connector, args);
    let all = syncs(connector);
    let enabled: Vec<&Value> = if requested.is_empty() {
        all.iter().collect()
    } else {
        all.iter()
            .filter(|s| {
                requested.iter().any(|k| {
                    s["syncName"].as_str() == Some(k.as_str())
                        || s["settingKey"].as_str() == Some(k.as_str())
                })
            })
            .collect()
    };
    enabled
        .into_iter()
        .filter(|sync| {
            let key = sync["settingKey"].as_str().unwrap_or_default();
            let direction = args
                .connection
                .get("object_sync_directions")
                .and_then(|o| o.get(key))
                .and_then(Value::as_str)
                .filter(|d| !d.is_empty())
                .or_else(|| text(args.connection, "direction"))
                .unwrap_or("inbound");
            direction == "inbound" || direction == "bidirectional"
        })
        .cloned()
        .collect()
}

struct PullState {
    page: u32,
    cursor: Option<String>,
    truncated: bool,
    done: bool,
    pages: u32,
    last_watermark: Option<String>,
    applied: IngestResult,
}

struct Pull<'a> {
    args: &'a SyncArgs<'a>,
    client: &'a ProviderClient,
    entity_id: Option<String>,
    moneybird_files: Option<&'a MoneybirdFiles>,
    stripe_files: Option<&'a StripeFiles>,
    skip_accounts: &'a [String],
}

async fn pull_pages(
    pull: &Pull<'_>,
    sync: &Value,
    state: &mut PullState,
    modified_after: Option<&str>,
) -> Result<(), SyncError> {
    let args = pull.args;
    while state.pages < MAX_PAGES {
        let page = pull
            .client
            .list_sync(
                args.env.http.as_ref(),
                sync,
                state.page,
                state.cursor.as_deref(),
                PER_PAGE,
                modified_after,
            )
            .await?;
        state.pages += 1;
        if page.items.is_empty() {
            state.done = true;
            return Ok(());
        }
        let latest = page.items.iter().filter_map(modified_at_of).fold(
            None::<String>,
            |acc, at| match acc {
                Some(prev) if !(at.encode_utf16().cmp(prev.encode_utf16()).is_gt()) => Some(prev),
                _ => Some(at),
            },
        );
        let ingested = ingest_records(&IngestArgs {
            db: args.db,
            http: args.env.http.as_ref(),
            events: &args.env.events,
            connection_id: text(args.connection, "id").unwrap_or_default(),
            provider: text(args.connection, "provider").unwrap_or_default(),
            display_name: text(args.connection, "display_name"),
            store_url: Some(&pull.client.store_url()),
            sync,
            records: page.items,
            owner_id: args.owner_id,
            workspace_id: args.workspace_id,
            entity_id: pull.entity_id.as_deref(),
            force_deleted: false,
            moneybird_files: pull.moneybird_files,
            stripe_files: pull.stripe_files,
            skip_financial_account_ids: pull.skip_accounts,
        })
        .await?;
        state.applied.add(&ingested);
        let room = 5usize.saturating_sub(state.applied.error_samples.len());
        state
            .applied
            .error_samples
            .extend(ingested.error_samples.into_iter().take(room));
        if latest.is_some() {
            state.last_watermark = latest;
        }
        if page.done {
            state.done = true;
            return Ok(());
        }
        state.page += 1;
        state.cursor = page.next_cursor;
        if state.pages == MAX_PAGES {
            state.truncated = true;
            return Ok(());
        }
    }
    Ok(())
}

async fn run_single_sync(pull: &Pull<'_>, sync: &Value) -> Result<(), SyncError> {
    let args = pull.args;
    let connection_id = text(args.connection, "id").unwrap_or_default();
    let model = sync["model"].as_str().unwrap_or_default();
    let watermarks = args.connection.get("sync_watermarks");
    let mark = |key: &str| {
        watermarks
            .and_then(|w| w.get(key))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let page_key = format!("{model}__page");
    let cursor_key = format!("{model}__cursor");
    let saved_page = if args.full { None } else { mark(&page_key) };
    let continuing = saved_page.as_deref().is_some_and(|p| !p.is_empty());
    let sync_type = if args.full {
        "FULL"
    } else if continuing || mark(model).is_none_or(|m| m.is_empty()) {
        "INITIAL"
    } else {
        "INCREMENTAL"
    };
    let run_id = start_sync_run(
        args.db,
        connection_id,
        sync["syncName"].as_str().unwrap_or_default(),
        model,
        args.trigger.as_str(),
        sync_type,
    )
    .await?;
    let modified_after = if args.full || continuing {
        None
    } else {
        mark(model).filter(|m| !m.is_empty())
    };
    let page = if continuing {
        let n = weldsuite_kit::validation::js_number(saved_page.as_deref().unwrap_or_default());
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let n = if n.is_finite() && n != 0.0 {
            n as i64
        } else {
            1
        };
        u32::try_from(n.max(1)).unwrap_or(1)
    } else {
        1
    };
    let mut state = PullState {
        page,
        cursor: if continuing { mark(&cursor_key) } else { None },
        truncated: false,
        done: false,
        pages: 0,
        last_watermark: modified_after.clone(),
        applied: IngestResult::default(),
    };
    match pull_pages(pull, sync, &mut state, modified_after.as_deref()).await {
        Ok(()) => {
            let mut patch: Vec<(String, Option<String>)> = Vec::new();
            if state.truncated {
                patch.push((page_key, Some(state.page.to_string())));
                patch.push((cursor_key, state.cursor.clone()));
            } else if state.done || !continuing {
                patch.push((page_key, None));
                patch.push((cursor_key, None));
                if state.applied.failed == 0
                    && let Some(mark) = state.last_watermark.clone().filter(|m| !m.is_empty())
                {
                    patch.push((model.to_owned(), Some(mark)));
                }
            }
            let error = if state.applied.failed > 0 {
                Some(format!(
                    "{} record(s) failed to import",
                    state.applied.failed
                ))
            } else if state.truncated {
                Some("Page ceiling reached — run again to continue".to_owned())
            } else {
                None
            };
            finish_sync_run(
                args.db,
                &run_id,
                connection_id,
                &RunEnd {
                    status: if state.applied.failed > 0 || state.truncated {
                        "partial"
                    } else {
                        "success"
                    },
                    applied: &state.applied,
                    error,
                    watermarks: patch,
                },
            )
            .await?;
            Ok(())
        }
        Err(error) => {
            let auth = matches!(&error, SyncError::Connector(e) if e.kind == Kind::Auth);
            let message = error.to_string();
            if auth {
                mark_connection_error(args.db, connection_id, "auth_error", &message).await?;
            }
            finish_sync_run(
                args.db,
                &run_id,
                connection_id,
                &RunEnd {
                    status: "error",
                    applied: &state.applied,
                    error: Some(message),
                    watermarks: Vec::new(),
                },
            )
            .await?;
            if auth { Err(error) } else { Ok(()) }
        }
    }
}

/// `syncConnection(args)`: the sync names it ran. A sync the catch-up did
/// not start schedules the connection's next catch-up ([`crate::catchup::schedule`]).
pub async fn sync_connection(args: &SyncArgs<'_>) -> Result<Vec<String>, SyncError> {
    let result = run_syncs(args).await;
    if args.trigger != Trigger::Schedule {
        crate::catchup::schedule(args.env, args.workspace_id, args.connection, result.is_ok())
            .await;
    }
    result
}

async fn run_syncs(args: &SyncArgs<'_>) -> Result<Vec<String>, SyncError> {
    let provider = text(args.connection, "provider").unwrap_or_default();
    let Some(connector) = get_connector(provider) else {
        return Err(SyncError::Connector(ConnectorError::new(
            format!("Unknown connector '{provider}'"),
            400,
            Kind::Permanent,
        )));
    };
    let to_run = syncs_to_run(connector, args);
    if to_run.is_empty() {
        return Ok(Vec::new());
    }
    let (credentials, client) = client_for(args.connection, args.env)?;
    // Odoo pages, ingests and keeps its watermarks its own way (`crate::odoo`).
    if let ProviderClient::Odoo(odoo) = &client {
        crate::odoo::sync::run(args, &to_run, odoo).await?;
        return Ok(to_run
            .iter()
            .filter_map(|s| s["syncName"].as_str().map(str::to_owned))
            .collect());
    }
    let entity_id = credentials
        .get("entityId")
        .and_then(Value::as_str)
        .map(|e| weldsuite_kit::validation::js_trim(e).to_owned())
        .filter(|e| !e.is_empty());
    let moneybird_files = match (&client, &args.env.storage) {
        (ProviderClient::Moneybird(mb), Some(storage)) => Some(MoneybirdFiles {
            client: mb.clone(),
            storage: Arc::clone(storage),
            workspace_id: args.workspace_id.to_owned(),
            budget: Arc::new(AtomicI64::new(MONEYBIRD_ATTACHMENT_DOWNLOAD_BUDGET)),
        }),
        _ => None,
    };
    let stripe_files = match (&client, &args.env.storage) {
        (ProviderClient::Stripe(stripe), Some(storage)) => Some(StripeFiles {
            client: stripe.clone(),
            storage: Arc::clone(storage),
            workspace_id: args.workspace_id.to_owned(),
            budget: Arc::new(AtomicI64::new(STRIPE_PDF_DOWNLOAD_BUDGET)),
        }),
        _ => None,
    };
    let skip = skipped_financial_account_ids(args.connection);
    let pull = Pull {
        args,
        client: &client,
        entity_id,
        moneybird_files: moneybird_files.as_ref(),
        stripe_files: stripe_files.as_ref(),
        skip_accounts: &skip,
    };
    for sync in &to_run {
        run_single_sync(&pull, sync).await?;
    }
    if provider == "stripe" {
        crate::moneybird_push::push_after_stripe_ingest(
            args.db,
            args.env,
            text(args.connection, "id").unwrap_or_default(),
        )
        .await;
    }
    Ok(to_run
        .iter()
        .filter_map(|s| s["syncName"].as_str().map(str::to_owned))
        .collect())
}
