//! WeldBooks → Moneybird push (`connectors/moneybird-push.ts`): imported
//! Stripe sales go on to Moneybird. State lives in
//! `integration_entity_mappings` on the Moneybird connection (`pending:` /
//! `failed:` claims, else the Moneybird id).
//!
//! Here so far: the settings as stored, what the settings form picks from
//! ([`options`]) and how far the push is ([`status`]).

use sea_orm::sea_query::{Alias, Expr, Func, OnConflict, Query, SelectStatement};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, JoinType, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, RelationTrait as _, Select,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{Keyring, PgPool, orm, utc_now, utc_timestamp};
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::tenant::{
    bank_transactions, companies, connector_connections as connections, connector_sync_runs,
    integration_entity_mappings as mappings, invoice_items, invoices, parties, people,
};

use crate::clients::{ConnectorError, Kind, as_text, decrypt_credentials};
use crate::js::{now_ms, string};
use crate::moneybird::Moneybird;

pub const SYNC_NAME: &str = "moneybird-push";
pub const MB_INVOICE_TYPE: &str = "moneybird_external_sales_invoice";
pub const MB_STATEMENT_TYPE: &str = "moneybird_financial_statement";
pub const MB_PUSHED_MUTATION_TYPE: &str = "moneybird_pushed_mutation";
pub const MB_CONTACT_TYPE: &str = "moneybird_contact";
pub const STRIPE_INVOICE_TYPE: &str = "stripe_invoice";
pub const STRIPE_LINE_TYPE: &str = "stripe_balance_transaction";

pub(crate) const FAILED_RETRY_AFTER_MS: f64 = 6.0 * 60.0 * 60_000.0;
pub(crate) const STALE_CLAIM_MS: f64 = 30.0 * 60_000.0;
pub(crate) const PUSHABLE_STATUSES: [&str; 5] =
    ["sent", "paid", "partial", "overdue", "uncollectible"];

/// `DEFAULT_TAX_OVERRIDES`.
fn default_tax_overrides() -> Map<String, Value> {
    let mut out = Map::new();
    for key in ["reverseCharge", "outsideEu", "exempt", "noTax"] {
        out.insert(key.to_owned(), Value::Null);
    }
    out
}

/// `pushSettingsOf(connection)`: the stored `moneybirdPush` with its
/// defaults filled in, `None` when there is none.
pub fn settings_of(connection: &Value) -> Option<Map<String, Value>> {
    let push = connection
        .get("settings")
        .and_then(|s| s.get("moneybirdPush"))
        .and_then(Value::as_object)?;
    let mut out = push.clone();
    if out.get("sourceConnectionIds").is_none_or(Value::is_null) {
        out.insert("sourceConnectionIds".to_owned(), json!([]));
    }
    let mut overrides = default_tax_overrides();
    if let Some(Value::Object(stored)) = push.get("taxRateOverrides") {
        for (k, v) in stored {
            overrides.insert(k.clone(), v.clone());
        }
    }
    out.insert("taxRateOverrides".to_owned(), Value::Object(overrides));
    Some(out)
}

/// `defaultPushSettings()`.
pub fn default_settings() -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("enabled".to_owned(), json!(false));
    out.insert("sourceConnectionIds".to_owned(), json!([]));
    for key in [
        "revenueLedgerAccountId",
        "financialAccountId",
        "feeLedgerAccountId",
        "payoutLedgerAccountId",
    ] {
        out.insert(key.to_owned(), Value::Null);
    }
    out.insert(
        "taxRateOverrides".to_owned(),
        Value::Object(default_tax_overrides()),
    );
    out.insert("startDate".to_owned(), Value::Null);
    out
}

/// `listConnectionsByProvider(db, provider)`: live rows, newest first
/// (`to_jsonb`, `snake_case`).
pub async fn connections_by_provider(db: &PgPool, provider: &str) -> Result<Vec<Value>, DbErr> {
    connections::Entity::find()
        .filter(connections::Column::Provider.eq(provider))
        .filter(connections::Column::DeletedAt.is_null())
        .order_by_desc(connections::Column::CreatedAt)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(crate::connections::connection_row)
        .collect()
}

/// `sourceStripeConnectionIds(db, settings)`.
pub async fn source_stripe_connection_ids(
    db: &PgPool,
    settings: &Map<String, Value>,
) -> Result<Vec<String>, DbErr> {
    let ids: Vec<String> = connections_by_provider(db, "stripe")
        .await?
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_owned))
        .collect();
    let chosen: Vec<&str> = settings
        .get("sourceConnectionIds")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if chosen.is_empty() {
        return Ok(ids);
    }
    Ok(ids
        .into_iter()
        .filter(|id| chosen.contains(&id.as_str()))
        .collect())
}

/// `invoiceStartDate(settings)`: `startDate` at midnight UTC.
pub(crate) fn start_date(settings: &Map<String, Value>) -> Option<String> {
    let start = string(settings.get("startDate")).filter(|s| !s.is_empty())?;
    weldsuite_kit::validation::js_date_iso(&format!("{start}T00:00:00Z"))
}

/// A JavaScript time (`Date.now()` milliseconds) as a `timestamp` column
/// holds it.
fn at_millis(millis: f64) -> PrimitiveDateTime {
    #[allow(clippy::cast_possible_truncation)]
    let nanos = (millis as i128) * 1_000_000;
    utc_timestamp(OffsetDateTime::from_unix_timestamp_nanos(nanos).unwrap_or(OffsetDateTime::UNIX_EPOCH))
}

/// A `timestamp` as `Date.parse` reads its text: UTC milliseconds.
fn epoch_ms(at: PrimitiveDateTime) -> f64 {
    let millis = at.assume_utc().unix_timestamp_nanos().div_euclid(1_000_000);
    #[allow(clippy::cast_precision_loss)]
    let millis = millis as f64;
    millis
}

/// [`start_date`] as the `$n::timestamp` the pending queries compare with.
fn start_at(settings: &Map<String, Value>) -> Option<PrimitiveDateTime> {
    start_date(settings)
        .as_deref()
        .and_then(crate::js::date_parse)
        .map(at_millis)
}

/// The cutoffs of `noBlockingRow`: a claim older than the stale cutoff, or
/// a failure older than the retry cutoff, no longer blocks.
pub(crate) fn cutoffs(force: bool) -> (PrimitiveDateTime, PrimitiveDateTime) {
    let now = now_ms();
    (
        at_millis(now - STALE_CLAIM_MS),
        at_millis(if force {
            now
        } else {
            now - FAILED_RETRY_AFTER_MS
        }),
    )
}

/// `noBlockingRow`: the internal ids `kind` rows of the Moneybird connection
/// block (pushed, or a claim or failure still fresh). `not exists (select 1
/// from integration_entity_mappings p where … and p.internal_entity_id =
/// x.id)` is `x.id not in (this)`: a mapped id is never null.
fn blocking_rows(
    connection_id: &str,
    kind: &str,
    (stale, retry): (PrimitiveDateTime, PrimitiveDateTime),
) -> SelectStatement {
    use sea_orm::ExprTrait as _;
    let p = || Alias::new("p");
    let external = || Expr::col((p(), mappings::Column::ExternalEntityId));
    let updated = || Expr::col((p(), mappings::Column::UpdatedAt));
    Query::select()
        .column((p(), mappings::Column::InternalEntityId))
        .from_as(mappings::Entity, p())
        .and_where(Expr::col((p(), mappings::Column::ConnectionId)).eq(connection_id))
        .and_where(Expr::col((p(), mappings::Column::ExternalEntityType)).eq(kind))
        .and_where(
            external()
                .not_like("pending:%")
                .and(external().not_like("failed:%"))
                .or(external().like("pending:%").and(updated().gt(stale)))
                .or(external().like("failed:%").and(updated().gt(retry))),
        )
        .to_owned()
}

/// What `pendingInvoiceConditions` / `pendingPayoutIds` read of a pass.
pub struct PendingScope<'a> {
    pub connection_id: &'a str,
    pub settings: &'a Map<String, Value>,
    pub sources: &'a [String],
}

/// `pendingInvoiceConditions(state, force)`: the sources' Stripe invoices
/// (their mappings joined to `invoices`) the Moneybird connection has not
/// pushed.
fn pending_invoices(scope: &PendingScope<'_>, force: bool) -> Select<mappings::Entity> {
    let mut select = mappings::Entity::find()
        .join(
            JoinType::InnerJoin,
            mappings::Entity::belongs_to(invoices::Entity)
                .from(mappings::Column::InternalEntityId)
                .to(invoices::Column::Id)
                .into(),
        )
        .filter(mappings::Column::ConnectionId.is_in(scope.sources.iter().map(String::as_str)))
        .filter(mappings::Column::ExternalEntityType.eq(STRIPE_INVOICE_TYPE))
        .filter(mappings::Column::InternalEntityType.eq("invoice"))
        .filter(invoices::Column::DeletedAt.is_null())
        .filter(invoices::Column::Status.is_in(PUSHABLE_STATUSES))
        .filter(invoices::Column::Id.not_in_subquery(blocking_rows(
            scope.connection_id,
            MB_INVOICE_TYPE,
            cutoffs(force),
        )));
    if let Some(start) = start_at(scope.settings) {
        select = select.filter(invoices::Column::IssueDate.gte(start));
    }
    select
}

/// `count(distinct invoices.id)` under `pendingInvoiceConditions(state, false)`.
async fn pending_invoice_count(db: &PgPool, scope: &PendingScope<'_>) -> Result<i64, DbErr> {
    let count: Option<i64> = pending_invoices(scope, false)
        .select_only()
        .expr_as(
            Func::count_distinct(Expr::col((invoices::Entity, invoices::Column::Id))),
            "count",
        )
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(count.unwrap_or(0))
}

/// `pendingPayoutIds(db, state, force, limit)`: payout lines of the sources
/// not yet on a statement, oldest first.
pub async fn pending_payout_ids(
    db: &PgPool,
    scope: &PendingScope<'_>,
    force: bool,
    limit: i64,
) -> Result<Vec<String>, DbErr> {
    use sea_orm::ExprTrait as _;
    if scope.sources.is_empty()
        || string(scope.settings.get("financialAccountId")).is_none_or(str::is_empty)
    {
        return Ok(Vec::new());
    }
    let mut select = mappings::Entity::find()
        .select_only()
        .column(bank_transactions::Column::Id)
        .join(
            JoinType::InnerJoin,
            mappings::Entity::belongs_to(bank_transactions::Entity)
                .from(mappings::Column::InternalEntityId)
                .to(bank_transactions::Column::Id)
                .into(),
        )
        .filter(mappings::Column::ConnectionId.is_in(scope.sources.iter().map(String::as_str)))
        .filter(mappings::Column::ExternalEntityType.eq(STRIPE_LINE_TYPE))
        .filter(bank_transactions::Column::DeletedAt.is_null())
        .filter(
            sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
                Expr::col((bank_transactions::Entity, bank_transactions::Column::RawData)),
                "stripeLine",
            )
            .eq("payout"),
        )
        .filter(bank_transactions::Column::Id.not_in_subquery(blocking_rows(
            scope.connection_id,
            MB_STATEMENT_TYPE,
            cutoffs(force),
        )));
    if let Some(start) = start_at(scope.settings) {
        select = select.filter(bank_transactions::Column::Date.gte(start));
    }
    select
        .order_by_asc(bank_transactions::Column::Date)
        .order_by_asc(bank_transactions::Column::Id)
        .limit(u64::try_from(limit).unwrap_or(0))
        .into_tuple()
        .all(&orm(db))
        .await
}

/// `countRows(db, connectionId, type, 'done' | 'failed')`.
async fn count_rows(
    db: &PgPool,
    connection_id: &str,
    kind: &str,
    failed: bool,
) -> Result<i64, DbErr> {
    let mut select = mappings::Entity::find()
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(kind));
    select = if failed {
        select.filter(mappings::Column::ExternalEntityId.like("failed:%"))
    } else {
        select
            .filter(mappings::Column::ExternalEntityId.not_like("pending:%"))
            .filter(mappings::Column::ExternalEntityId.not_like("failed:%"))
    };
    let count = select.count(&orm(db)).await?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}

/// `moneybirdPushStatus(db, connection)`.
pub async fn status(db: &PgPool, connection: &Value) -> Result<Value, DbErr> {
    let connection_id = connection["id"].as_str().unwrap_or_default();
    let stored = settings_of(connection);
    let sources = match &stored {
        Some(settings) => source_stripe_connection_ids(db, settings).await?,
        None => Vec::new(),
    };
    let settings = stored.clone().unwrap_or_else(default_settings);
    let scope = PendingScope {
        connection_id,
        settings: &settings,
        sources: &sources,
    };
    let mut pending_invoices = 0;
    let mut pending_payouts = 0;
    if !sources.is_empty() {
        pending_invoices = pending_invoice_count(db, &scope).await?;
        if string(settings.get("financialAccountId")).is_some_and(|s| !s.is_empty()) {
            pending_payouts = pending_payout_ids(db, &scope, false, 500).await?.len();
        }
    }
    let last = connector_sync_runs::Entity::find()
        .filter(connector_sync_runs::Column::ConnectionId.eq(connection_id))
        .filter(connector_sync_runs::Column::SyncName.eq(SYNC_NAME))
        .order_by_desc(connector_sync_runs::Column::CreatedAt)
        .one(&orm(db))
        .await?
        .map(|run| serde_json::to_value(run).map_err(crate::connections::json_error))
        .transpose()?;
    let last_run = last.map(|run| {
        json!({
            "status": run["status"],
            "startedAt": run["startedAt"],
            "finishedAt": run["finishedAt"],
            "error": run["error"],
            "errorSamples": run["errorSamples"],
        })
    });
    let enabled = stored
        .as_ref()
        .and_then(|s| s.get("enabled"))
        .is_some_and(crate::js::truthy);
    Ok(json!({
        "enabled": enabled,
        "pushedInvoices": count_rows(db, connection_id, MB_INVOICE_TYPE, false).await?,
        "pendingInvoices": pending_invoices,
        "failedInvoices": count_rows(db, connection_id, MB_INVOICE_TYPE, true).await?,
        "pushedPayouts": count_rows(db, connection_id, MB_STATEMENT_TYPE, false).await?,
        "pendingPayouts": pending_payouts,
        "lastRun": last_run,
    }))
}

/// `moneybirdClientFor(env, connection)`.
pub fn client_for(connection: &Value, keyring: &Keyring) -> Moneybird {
    let credentials = decrypt_credentials(connection.get("credentials"), keyring);
    Moneybird::from_credentials(&credentials, connection["external_account_id"].as_str())
}

/// Why [`options`] failed.
pub enum OptionsError {
    Connector(ConnectorError),
    Database(DbErr),
}

/// `moneybirdPushOptions(db, env, connection)`: the administration's
/// ledgers, accounts and sales tax rates, and the Stripe connections.
pub async fn options(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    connection: &Value,
    keyring: &Keyring,
) -> Result<Value, OptionsError> {
    let client = client_for(connection, keyring);
    let (ledgers, financial, rates) = tokio::join!(
        client.list_ledger_accounts(http),
        client.list_financial_accounts(http),
        client.list_tax_rates(http),
    );
    let ledgers = ledgers.map_err(OptionsError::Connector)?;
    let financial = financial.map_err(OptionsError::Connector)?;
    let rates = rates.map_err(OptionsError::Connector)?;
    let stripe = connections_by_provider(db, "stripe")
        .await
        .map_err(OptionsError::Database)?;
    let text_id = |v: Option<&Value>| match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => as_text(v),
    };
    Ok(json!({
        "ledgerAccounts": ledgers.iter().map(|l| json!({
            "id": l.id, "name": l.name, "accountType": l.account_type, "accountId": l.account_id,
        })).collect::<Vec<_>>(),
        "financialAccounts": financial.items.iter().map(|row| {
            let name = string(row.get("name")).filter(|n| !n.is_empty()).map_or_else(
                || text_id(row.get("identifier").filter(|v| !v.is_null()).or_else(|| row.get("id"))),
                str::to_owned,
            );
            json!({
                "id": text_id(row.get("id")),
                "name": name,
                "type": string(row.get("type")),
                "identifier": string(row.get("identifier")),
                "currency": string(row.get("currency")),
            })
        }).collect::<Vec<_>>(),
        "taxRates": rates.iter()
            .filter(|r| r.active && matches!(r.tax_rate_type.as_deref(), Some("sales_invoice") | None))
            .map(|r| json!({
                "id": r.id, "name": r.name, "percentage": r.percentage.map(crate::js::number_value),
                "taxRateType": r.tax_rate_type, "country": r.country,
            }))
            .collect::<Vec<_>>(),
        "stripeConnections": stripe.iter().map(|row| json!({
            "id": row["id"], "displayName": row["display_name"], "externalAccountId": row["external_account_id"],
        })).collect::<Vec<_>>(),
    }))
}

// ── the push pass (`pushToMoneybird`) ───────────────────────────────────────

const REQUEST_BUDGET: u32 = 100;
const MAX_INVOICES_PER_PASS: i64 = 20;
const MAX_PAYOUTS_PER_PASS: i64 = 3;
const MAX_LINKS_PER_PASS: i64 = 60;
const MAX_ERROR_SAMPLES: usize = 10;
/// Pause between passes while a backlog remains (`MONEYBIRD_PUSH_INTERVAL_MS`).
pub const PUSH_INTERVAL_SECONDS: i64 = 5 * 60;
/// The due-index kind of a Moneybird push backlog.
pub const DUE_KIND: &str = "moneybird_push";

/// `MoneybirdPushResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PushResult {
    pub invoices_pushed: u64,
    pub statements_pushed: u64,
    pub lines_booked: u64,
    pub failed: u64,
    pub remaining: bool,
    pub skipped: Option<String>,
}

/// Why a step stopped.
#[derive(Debug)]
enum PushError {
    /// `BudgetExhausted`.
    Budget,
    Connector(ConnectorError),
    Other(String),
}

/// The database's own message (no driver prefix), else the error's text.
impl From<DbErr> for PushError {
    fn from(error: DbErr) -> Self {
        Self::Other(weldsuite_commerce_domain::db::message_of(&error))
    }
}

impl From<ConnectorError> for PushError {
    fn from(error: ConnectorError) -> Self {
        Self::Connector(error)
    }
}

impl PushError {
    fn message(&self) -> String {
        match self {
            Self::Budget => "Moneybird request budget for this pass used up".to_owned(),
            Self::Connector(error) => error.message.clone(),
            Self::Other(message) => message.clone(),
        }
    }

    /// `endsPass(err)`: the budget or a rate limit.
    fn ends_pass(&self) -> bool {
        matches!(self, Self::Budget)
            || matches!(self, Self::Connector(e) if e.kind == Kind::RateLimit)
    }

    fn is_auth(&self) -> bool {
        matches!(self, Self::Connector(e) if e.kind == Kind::Auth)
    }
}

type Step<T> = Result<T, PushError>;

struct Pass<'a> {
    db: &'a PgPool,
    env: &'a crate::sync::SyncEnv,
    http: Option<&'a OutboundHttp>,
    connection_id: String,
    settings: Map<String, Value>,
    client: Moneybird,
    sources: Vec<String>,
    budget: u32,
    remaining: bool,
    invoices: u64,
    statements: u64,
    lines: u64,
    failed: u64,
    errors: Vec<(String, String)>,
    tax_rates: Option<Vec<crate::moneybird::TaxRate>>,
    /// The financial account's currency, once read (the read may find none).
    #[allow(clippy::option_option)]
    account_currency: Option<Option<String>>,
}

impl Pass<'_> {
    fn spend(&mut self) -> Step<()> {
        if self.budget < 1 {
            return Err(PushError::Budget);
        }
        self.budget -= 1;
        Ok(())
    }

    fn record(&mut self, external_id: &str, error: &PushError) {
        self.failed += 1;
        if self.errors.len() >= MAX_ERROR_SAMPLES {
            return;
        }
        let message = crate::mappers::slice_units(&error.message(), 300);
        self.errors.push((external_id.to_owned(), message));
    }

    fn setting(&self, key: &str) -> Option<String> {
        string(self.settings.get(key))
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }

    fn scope(&self) -> PendingScope<'_> {
        PendingScope {
            connection_id: &self.connection_id,
            settings: &self.settings,
            sources: &self.sources,
        }
    }
}

fn text_id(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(v) => as_text(v),
    }
}

/// `ymd(date)`: the date part of an ISO timestamp.
fn ymd(iso: Option<&str>) -> String {
    let at = iso
        .filter(|s| !s.is_empty())
        .map_or_else(crate::js::now_iso, |s| {
            crate::mappers::js_date_loose(s)
                .and_then(weldsuite_kit::validation::js_iso_from_millis)
                .unwrap_or_else(|| s.to_owned())
        });
    at.chars().take(10).collect()
}

fn num(text: &str) -> f64 {
    weldsuite_kit::validation::js_number(text)
}

/// `Math.round(n)`: halves up.
fn js_round(n: f64) -> f64 {
    (n + 0.5).floor()
}

// ── claims ──────────────────────────────────────────────────────────────────

async fn claim(
    db: &PgPool,
    connection_id: &str,
    kind: &str,
    internal_type: &str,
    internal_id: &str,
    force: bool,
) -> Result<Option<String>, DbErr> {
    let db = &orm(db);
    let rows: Vec<(String, String, PrimitiveDateTime)> = mappings::Entity::find()
        .select_only()
        .columns([
            mappings::Column::Id,
            mappings::Column::ExternalEntityId,
            mappings::Column::UpdatedAt,
        ])
        .filter(mappings::Column::ConnectionId.eq(connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(kind))
        .filter(mappings::Column::InternalEntityId.eq(internal_id))
        .into_tuple()
        .all(db)
        .await?;
    let now = crate::js::now_ms();
    let pending_id = format!("pending:{internal_id}");
    let mut reusable: Option<(String, PrimitiveDateTime)> = None;
    for (id, external, updated) in rows {
        // `updatedAt` as JavaScript reads it: to the millisecond.
        let updated = utc_timestamp(updated.assume_utc());
        let age = now - epoch_ms(updated);
        if external.starts_with("pending:") {
            if age < STALE_CLAIM_MS {
                return Ok(None);
            }
            reusable = Some((id, updated));
        } else if external.starts_with("failed:") {
            if !force && age < FAILED_RETRY_AFTER_MS {
                return Ok(None);
            }
            reusable = Some((id, updated));
        } else {
            return Ok(None);
        }
    }
    if let Some((id, updated)) = reusable {
        // Compare-and-set on updated_at, at the millisecond JavaScript reads.
        let claimed = mappings::Entity::update_many()
            .col_expr(
                mappings::Column::ExternalEntityId,
                Expr::value(pending_id.as_str()),
            )
            .col_expr(mappings::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(mappings::Column::Id.eq(id.as_str()))
            .filter(mappings::Column::UpdatedAt.eq(updated))
            .exec(db)
            .await?;
        return Ok((claimed.rows_affected > 0).then_some(id));
    }
    let stamp = utc_now();
    let id = weldsuite_kit::generate_id("iem");
    let inserted = mappings::Entity::insert(mappings::ActiveModel {
        id: Set(id.clone()),
        created_at: Set(stamp),
        updated_at: Set(stamp),
        connection_id: Set(connection_id.to_owned()),
        external_entity_type: Set(kind.to_owned()),
        external_entity_id: Set(pending_id),
        internal_entity_type: Set(internal_type.to_owned()),
        internal_entity_id: Set(internal_id.to_owned()),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(db)
    .await?;
    Ok((inserted > 0).then_some(id))
}

async fn complete_claim(
    db: &PgPool,
    row_id: &str,
    external_id: &str,
    checksum: &str,
) -> Result<(), DbErr> {
    let now = utc_now();
    mappings::Entity::update_many()
        .set(mappings::ActiveModel {
            external_entity_id: Set(external_id.to_owned()),
            sync_checksum: Set(Some(checksum.to_owned())),
            last_synced_at: Set(Some(now)),
            updated_at: Set(now),
            ..Default::default()
        })
        .filter(mappings::Column::Id.eq(row_id))
        .exec(&orm(db))
        .await
        .map(|_| ())
}

async fn fail_claim(db: &PgPool, row_id: &str, internal_id: &str) -> Result<(), DbErr> {
    mappings::Entity::update_many()
        .set(mappings::ActiveModel {
            external_entity_id: Set(format!("failed:{internal_id}")),
            updated_at: Set(utc_now()),
            ..Default::default()
        })
        .filter(mappings::Column::Id.eq(row_id))
        .exec(&orm(db))
        .await
        .map(|_| ())
}

async fn release_claim(db: &PgPool, row_id: &str) -> Result<(), DbErr> {
    mappings::Entity::delete_many()
        .filter(mappings::Column::Id.eq(row_id))
        .exec(&orm(db))
        .await
        .map(|_| ())
}

// ── contacts ────────────────────────────────────────────────────────────────

/// `loadContact(db, partyId)` as `buildMoneybirdContactPayload` reads it.
/// A party's company: `(name, email, phone, vat number, primary address)`.
type CompanyContact = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<Value>,
);
/// A party's person: `(first name, last name, email, phone, primary address)`.
type PersonContact = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<Value>,
);

async fn contact_payload(
    db: &PgPool,
    party_id: &str,
) -> Result<Option<(Option<String>, Value)>, DbErr> {
    let db = &orm(db);
    #[allow(clippy::type_complexity)]
    let party: Option<(
        Option<String>,
        Option<String>,
        Option<Value>,
        Option<String>,
        Option<String>,
    )> = parties::Entity::find()
        .select_only()
        .columns([
            parties::Column::Kind,
            parties::Column::DisplayName,
            parties::Column::BillingAddress,
            parties::Column::CompanyId,
            parties::Column::PersonId,
        ])
        .filter(parties::Column::Id.eq(party_id))
        .into_tuple()
        .one(db)
        .await?;
    let Some((party_kind, display, billing, company_id, person_id)) = party else {
        return Ok(None);
    };
    // A JSON `null` in the column reads as no address, as `jsonb_build_object` did.
    let billing = billing.filter(|v| !v.is_null());
    let address_of = |address: Option<Value>| address.filter(|v| !v.is_null());
    let (kind, display_name, first, last, email, phone, vat, address) =
        if let (Some("company"), Some(company_id)) = (party_kind.as_deref(), company_id) {
            let company: Option<CompanyContact> = companies::Entity::find()
                .select_only()
                .columns([
                    companies::Column::Name,
                    companies::Column::Email,
                    companies::Column::Phone,
                    companies::Column::VatNumber,
                    companies::Column::PrimaryAddress,
                ])
                .filter(companies::Column::Id.eq(company_id))
                .into_tuple()
                .one(db)
                .await?;
            let (name, email, phone, vat, primary) = match company {
                Some((name, email, phone, vat, primary)) => {
                    (Some(name), email, phone, vat, primary)
                }
                None => (None, None, None, None, None),
            };
            (
                "company",
                name.or(display)
                    .unwrap_or_else(|| "Customer".to_owned()),
                None,
                None,
                email,
                phone,
                vat,
                billing.or_else(|| address_of(primary)),
            )
        } else {
            let person: Option<PersonContact> = match person_id {
                Some(id) => {
                    people::Entity::find()
                        .select_only()
                        .columns([
                            people::Column::FirstName,
                            people::Column::LastName,
                            people::Column::Email,
                            people::Column::DirectPhone,
                            people::Column::PrimaryAddress,
                        ])
                        .filter(people::Column::Id.eq(id))
                        .into_tuple()
                        .one(db)
                        .await?
                }
                None => None,
            };
            let (first, last, email, phone, primary) =
                person.unwrap_or((None, None, None, None, None));
            (
                "person",
                display.unwrap_or_else(|| "Customer".to_owned()),
                first,
                last,
                email,
                phone,
                None,
                billing.or_else(|| address_of(primary)),
            )
        };
    // `buildMoneybirdContactPayload(contact)`.
    let mut payload = Map::new();
    let is_person = kind == "person"
        && (first.as_deref().is_some_and(|f| !f.is_empty())
            || last.as_deref().is_some_and(|l| !l.is_empty()));
    if is_person {
        payload.insert(
            "firstname".to_owned(),
            json!(first.clone().unwrap_or_default()),
        );
        payload.insert(
            "lastname".to_owned(),
            json!(last.clone().unwrap_or_default()),
        );
    } else {
        payload.insert("company_name".to_owned(), json!(display_name));
    }
    let address = address.unwrap_or(Value::Null);
    let a = |k: &str| string(address.get(k)).map(str::to_owned);
    let optional = [
        ("email", email.clone()),
        ("send_invoices_to_email", email.clone()),
        ("phone", phone),
        ("tax_number", vat),
        ("address1", a("line1")),
        ("address2", a("line2")),
        ("zipcode", a("postalCode")),
        ("city", a("city")),
        ("country", a("country").map(|c| c.to_uppercase())),
    ];
    for (key, value) in optional {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            payload.insert(key.to_owned(), json!(value));
        }
    }
    Ok(Some((email, Value::Object(payload))))
}

/// `resolveMoneybirdContact(db, state, partyId)`: mapped, found by email, or created.
async fn resolve_contact(pass: &mut Pass<'_>, party_id: &str) -> Step<String> {
    let mapped: Option<String> = mappings::Entity::find()
        .select_only()
        .column(mappings::Column::ExternalEntityId)
        .filter(mappings::Column::ConnectionId.eq(pass.connection_id.as_str()))
        .filter(mappings::Column::ExternalEntityType.eq(MB_CONTACT_TYPE))
        .filter(mappings::Column::InternalEntityType.eq("party"))
        .filter(mappings::Column::InternalEntityId.eq(party_id))
        .into_tuple()
        .one(&orm(pass.db))
        .await?;
    if let Some(mapped) = mapped {
        return Ok(mapped);
    }
    let Some((email, payload)) = contact_payload(pass.db, party_id).await? else {
        return Err(PushError::Other(
            "The invoice contact no longer exists".to_owned(),
        ));
    };
    let mut contact_id = String::new();
    if let Some(email) = email.filter(|e| !e.is_empty()) {
        pass.spend()?;
        let found = pass.client.search_contacts(pass.http, &email).await?;
        let lower = email.to_lowercase();
        if let Some(hit) = found
            .iter()
            .find(|row| string(row.get("email")).is_some_and(|e| e.to_lowercase() == lower))
        {
            contact_id = text_id(hit.get("id"));
        }
    }
    if contact_id.is_empty() {
        pass.spend()?;
        let created = pass.client.create_contact(pass.http, payload).await?;
        contact_id = text_id(created.get("id"));
    }
    if contact_id.is_empty() {
        return Err(PushError::Other(
            "Moneybird did not return a contact id".to_owned(),
        ));
    }
    mappings::Entity::insert(mappings::ActiveModel {
        id: Set(weldsuite_kit::generate_id("iem")),
        connection_id: Set(pass.connection_id.clone()),
        external_entity_type: Set(MB_CONTACT_TYPE.to_owned()),
        external_entity_id: Set(contact_id.clone()),
        internal_entity_type: Set("party".to_owned()),
        internal_entity_id: Set(party_id.to_owned()),
        last_synced_at: Set(Some(utc_now())),
        ..Default::default()
    })
    .on_conflict(OnConflict::new().do_nothing().to_owned())
    .exec_without_returning(&orm(pass.db))
    .await?;
    Ok(contact_id)
}

// ── invoices ────────────────────────────────────────────────────────────────

async fn tax_rates(pass: &mut Pass<'_>) -> Step<Vec<crate::moneybird::TaxRate>> {
    if let Some(rates) = &pass.tax_rates {
        return Ok(rates.clone());
    }
    pass.spend()?;
    let rates = pass.client.list_tax_rates(pass.http).await?;
    pass.tax_rates = Some(rates.clone());
    Ok(rates)
}

/// `pendingInvoiceIds(db, state, force, limit)`.
async fn pending_invoice_ids(
    db: &PgPool,
    scope: &PendingScope<'_>,
    force: bool,
    limit: i64,
) -> Result<Vec<String>, DbErr> {
    if scope.sources.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<String> = pending_invoices(scope, force)
        .select_only()
        .column(invoices::Column::Id)
        .order_by_asc(invoices::Column::IssueDate)
        .order_by_asc(invoices::Column::Id)
        .limit(u64::try_from(limit).unwrap_or(0))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let mut out: Vec<String> = Vec::new();
    for id in rows {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

/// `resolveMoneybirdTaxRate(line, rates, overrides)`.
fn resolve_tax_rate(
    percentage: Option<f64>,
    breakdown: &[Value],
    all: &[crate::moneybird::TaxRate],
    overrides: &Map<String, Value>,
) -> Result<String, String> {
    let same = |a: Option<f64>, b: f64| a.is_some_and(|a| (a - b).abs() < 0.005);
    let rates: Vec<&crate::moneybird::TaxRate> = all
        .iter()
        .filter(|r| r.active && matches!(r.tax_rate_type.as_deref(), Some("sales_invoice") | None))
        .collect();
    let row = percentage.and_then(|pct| {
        breakdown
            .iter()
            .find(|entry| same(entry.get("taxRate").and_then(Value::as_f64), pct))
    });
    if let Some(pct) = percentage.filter(|p| *p > 0.0) {
        let candidates: Vec<&&crate::moneybird::TaxRate> =
            rates.iter().filter(|r| same(r.percentage, pct)).collect();
        let country = row
            .and_then(|r| string(r.get("jurisdictionCode")))
            .map(str::to_uppercase);
        let matched = country
            .as_ref()
            .and_then(|c| {
                candidates
                    .iter()
                    .find(|r| r.country.as_deref().map(str::to_uppercase).as_ref() == Some(c))
            })
            .or_else(|| {
                candidates
                    .iter()
                    .find(|r| r.country.as_deref().is_none_or(str::is_empty))
            })
            .or_else(|| candidates.first());
        let place = country.map_or_else(String::new, |c| format!(" for {c}"));
        return matched.map(|r| r.id.clone()).ok_or_else(|| {
            format!(
                "No {}% sales tax rate in Moneybird{place}",
                crate::js::number_text(pct)
            )
        });
    }
    let category = match percentage {
        None => "noTax",
        Some(_) => match row.and_then(|r| string(r.get("taxCategoryCode"))) {
            None | Some("") => "noTax",
            Some("reverse_charge") => "reverseCharge",
            Some(
                "not_collecting"
                | "not_subject_to_tax"
                | "excluded_territory"
                | "jurisdiction_unsupported"
                | "not_supported",
            ) => "outsideEu",
            Some(_) => "exempt",
        },
    };
    if let Some(id) = string(overrides.get(category)).filter(|s| !s.is_empty()) {
        return Ok(id.to_owned());
    }
    let ci = |pattern: &str| regex::Regex::new(pattern).expect("pattern");
    let reverse = ci(r"(?i)verlegd|reverse");
    let outside = ci(r"(?i)buiten|outside|export|non[- ]?eu|niet[- ]?eu|world|wereld");
    let exempt = ci(r"(?i)vrijgesteld|exempt|geen btw|no vat|0\s?%");
    let zero: Vec<&&crate::moneybird::TaxRate> =
        rates.iter().filter(|r| same(r.percentage, 0.0)).collect();
    let is_reverse = |r: &&&crate::moneybird::TaxRate| reverse.is_match(&r.name);
    let is_outside = |r: &&&crate::moneybird::TaxRate| outside.is_match(&r.name);
    let picked = match category {
        "reverseCharge" => zero.iter().find(|r| is_reverse(r)),
        "outsideEu" => zero
            .iter()
            .find(|r| is_outside(r))
            .or_else(|| zero.iter().find(|r| !is_reverse(r))),
        _ => {
            let plain: Vec<&&&crate::moneybird::TaxRate> = zero
                .iter()
                .filter(|r| !is_reverse(r) && !is_outside(r))
                .collect();
            plain
                .iter()
                .find(|r| exempt.is_match(&r.name))
                .copied()
                .or_else(|| plain.first().copied())
                .or_else(|| zero.iter().find(|r| !is_reverse(r)))
        }
    };
    let label = match category {
        "reverseCharge" => "reverse charge",
        "outsideEu" => "outside the EU",
        "exempt" => "exempt",
        _ => "no VAT",
    };
    picked.map(|r| r.id.clone()).ok_or_else(|| {
        format!("No Moneybird sales tax rate for {label} lines: pick one under tax rates on the Moneybird connection")
    })
}

/// `lineAmountAndPrice(line)`.
// `Number.isInteger` and `===` on cents, exactly as JavaScript compares.
#[allow(clippy::float_cmp)]
fn amount_and_price(
    quantity: Option<&str>,
    unit_price: &str,
    line_total: Option<&str>,
) -> (String, String) {
    let total_cents = js_round(num(line_total.unwrap_or(unit_price)) * 100.0);
    let quantity = num(quantity.unwrap_or("1"));
    let unit_cents = num(unit_price) * 100.0;
    let whole = (unit_cents - js_round(unit_cents)).abs() < 1e-6;
    if quantity.is_finite()
        && quantity.fract() == 0.0
        && quantity > 0.0
        && whole
        && js_round(unit_cents) * quantity == total_cents
    {
        return (
            crate::js::number_text(quantity),
            crate::js::to_fixed(js_round(unit_cents) / 100.0, 2),
        );
    }
    ("1".to_owned(), crate::js::to_fixed(total_cents / 100.0, 2))
}

/// `buildExternalSalesInvoicePayload(...)`.
fn invoice_payload(
    invoice: &Value,
    items: &[Value],
    contact_id: &str,
    revenue: &str,
    rates: &[crate::moneybird::TaxRate],
    overrides: &Map<String, Value>,
) -> Result<Value, String> {
    let breakdown: Vec<Value> = invoice["taxBreakdown"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut details = Vec::new();
    for item in items {
        let percentage = match string(item.get("taxRate")) {
            None | Some("") => None,
            Some(rate) => Some(num(rate)).filter(|p| p.is_finite()),
        };
        let tax_rate_id = resolve_tax_rate(percentage, &breakdown, rates, overrides)?;
        let (amount, price) = amount_and_price(
            string(item.get("quantity")),
            string(item.get("unitPrice")).unwrap_or("0"),
            string(item.get("lineTotal")),
        );
        let mut detail = Map::new();
        detail.insert(
            "description".to_owned(),
            json!(crate::mappers::slice_units(
                string(item.get("description")).unwrap_or_default(),
                2000
            )),
        );
        detail.insert("amount".to_owned(), json!(amount));
        detail.insert("price".to_owned(), json!(price));
        detail.insert("tax_rate_id".to_owned(), json!(tax_rate_id));
        detail.insert("ledger_account_id".to_owned(), json!(revenue));
        let period = item.get("period");
        if let (Some(from), Some(to)) = (
            period
                .and_then(|p| string(p.get("from")))
                .filter(|s| !s.is_empty()),
            period
                .and_then(|p| string(p.get("to")))
                .filter(|s| !s.is_empty()),
        ) {
            detail.insert(
                "period".to_owned(),
                json!(format!(
                    "{}..{}",
                    from.replace('-', ""),
                    to.replace('-', "")
                )),
            );
        }
        details.push(Value::Object(detail));
    }
    if details.is_empty() {
        return Err("The invoice has no lines".to_owned());
    }
    let mut payload = Map::new();
    payload.insert("contact_id".to_owned(), json!(contact_id));
    payload.insert(
        "reference".to_owned(),
        json!(
            string(invoice.get("invoiceNumber"))
                .unwrap_or_else(|| invoice["id"].as_str().unwrap_or_default())
        ),
    );
    payload.insert(
        "date".to_owned(),
        json!(ymd(string(invoice.get("issueDate")))),
    );
    payload.insert(
        "due_date".to_owned(),
        json!(ymd(string(invoice.get("dueDate")))),
    );
    payload.insert(
        "currency".to_owned(),
        json!(
            string(invoice.get("currency"))
                .unwrap_or("EUR")
                .to_uppercase()
        ),
    );
    payload.insert("prices_are_incl_tax".to_owned(), json!(false));
    payload.insert("source".to_owned(), json!("Stripe"));
    if let Some(link) = string(invoice.get("paymentLink")).filter(|l| !l.is_empty()) {
        payload.insert("source_url".to_owned(), json!(link));
    }
    payload.insert("details_attributes".to_owned(), Value::Array(details));
    Ok(Value::Object(payload))
}

async fn attach_pdf(pass: &mut Pass<'_>, moneybird_id: &str, keys: Option<&Value>) -> Step<()> {
    let Some(key) = keys
        .and_then(Value::as_array)
        .and_then(|k| k.first())
        .and_then(Value::as_str)
    else {
        return Ok(());
    };
    let Some(storage) = pass.env.storage.clone() else {
        return Ok(());
    };
    let object = storage
        .get_boxed(key)
        .await
        .map_err(|error| PushError::Other(error.to_string()))?;
    let Some(object) = object else {
        return Ok(());
    };
    pass.spend()?;
    let filename = key.rsplit('/').next().unwrap_or("invoice.pdf");
    let content_type = object
        .info
        .content_type
        .clone()
        .unwrap_or_else(|| "application/pdf".to_owned());
    pass.client
        .upload_external_sales_invoice_attachment(
            pass.http,
            moneybird_id,
            &object.bytes,
            filename,
            &content_type,
        )
        .await?;
    Ok(())
}

async fn mark_paid(pass: &mut Pass<'_>, moneybird_id: &str, invoice: &Value) -> Step<()> {
    pass.spend()?;
    let date = string(invoice.get("paidAt")).or_else(|| string(invoice.get("issueDate")));
    let total = string(invoice.get("total")).map_or(0.0, num);
    pass.client
        .create_external_sales_invoice_payment(
            pass.http,
            moneybird_id,
            json!({ "payment_date": ymd(date), "price": crate::js::to_fixed(total, 2) }),
        )
        .await?;
    Ok(())
}

async fn push_invoice(pass: &mut Pass<'_>, invoice_id: &str, force: bool) -> Step<()> {
    let Some(claim_id) = claim(
        pass.db,
        &pass.connection_id.clone(),
        MB_INVOICE_TYPE,
        "invoice",
        invoice_id,
        force,
    )
    .await?
    else {
        return Ok(());
    };
    // The row as Drizzle reads it (`total` as text, as `numeric` prints).
    let invoice = invoices::Entity::find_by_id(invoice_id)
        .one(&orm(pass.db))
        .await?
        .map(|row| serde_json::to_value(row).map_err(crate::connections::json_error))
        .transpose()?;
    let label = invoice
        .as_ref()
        .and_then(|i| string(i.get("invoiceNumber")))
        .map_or_else(|| invoice_id.to_owned(), str::to_owned);
    let created: Step<(String, Value)> = async {
        let Some(invoice) = &invoice else {
            return Err(PushError::Other("Invoice not found".to_owned()));
        };
        let Some(revenue) = pass.setting("revenueLedgerAccountId") else {
            return Err(PushError::Other("Pick a revenue ledger account on the Moneybird connection".to_owned()));
        };
        // The amounts as text, as `numeric` prints them.
        let items: Vec<Value> = invoice_items::Entity::find()
            .filter(invoice_items::Column::InvoiceId.eq(invoice_id))
            .filter(invoice_items::Column::DeletedAt.is_null())
            .order_by_asc(invoice_items::Column::SortOrder)
            .all(&orm(pass.db))
            .await?
            .into_iter()
            .map(|item| serde_json::to_value(item).map_err(crate::connections::json_error))
            .collect::<Result<_, _>>()?;
        let party = string(invoice.get("counterpartyId"))
            .or_else(|| string(invoice.get("contactId")))
            .unwrap_or_default()
            .to_owned();
        let contact_id = resolve_contact(pass, &party).await?;
        let rates = tax_rates(pass).await?;
        let overrides = pass
            .settings
            .get("taxRateOverrides")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let payload = invoice_payload(&json!({ "invoiceNumber": label, "id": invoice_id, "issueDate": invoice["issueDate"], "dueDate": invoice["dueDate"], "currency": invoice["currency"], "paymentLink": invoice["paymentLink"], "taxBreakdown": invoice["taxBreakdown"] }), &items, &contact_id, &revenue, &rates, &overrides)
            .map_err(PushError::Other)?;
        pass.spend()?;
        let created = pass.client.create_external_sales_invoice(pass.http, payload).await?;
        let moneybird_id = text_id(created.get("id"));
        if moneybird_id.is_empty() {
            return Err(PushError::Other("Moneybird did not return an invoice id".to_owned()));
        }
        complete_claim(pass.db, &claim_id, &moneybird_id, "open").await?;
        pass.invoices += 1;
        Ok((moneybird_id, created))
    }
    .await;
    let (moneybird_id, created) = match created {
        Ok(done) => done,
        Err(error) => {
            if error.ends_pass() {
                release_claim(pass.db, &claim_id).await?;
                return Err(error);
            }
            fail_claim(pass.db, &claim_id, invoice_id).await?;
            pass.record(&label, &error);
            return if error.is_auth() { Err(error) } else { Ok(()) };
        }
    };
    let invoice = invoice.unwrap_or(Value::Null);
    // The invoice exists in Moneybird now; what follows may fail without undoing it.
    let rest: Step<()> = async {
        attach_pdf(pass, &moneybird_id, invoice.get("attachmentKeys")).await?;
        // `settleRounding`: Moneybird recomputes VAT; settle a cent so the invoice closes.
        let moneybird_total = created
            .get("total_price_incl_tax")
            .map_or(f64::NAN, |v| match v {
                Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
                other => weldsuite_kit::validation::js_number_of(Some(other)),
            });
        let stripe_total = string(invoice.get("total")).map_or(0.0, num);
        let diff = js_round((moneybird_total - stripe_total) * 100.0) / 100.0;
        if diff.is_finite() && diff > 0.0 && diff <= 0.05 {
            pass.spend()?;
            pass.client
                .create_external_sales_invoice_payment(
                    pass.http,
                    &moneybird_id,
                    json!({
                        "payment_date": ymd(string(invoice.get("issueDate"))),
                        "price": crate::js::to_fixed(diff, 2),
                        "manual_payment_action": "rounding_error",
                    }),
                )
                .await?;
        }
        if invoice["status"] == "paid" && pass.setting("financialAccountId").is_none() {
            mark_paid(pass, &moneybird_id, &invoice).await?;
            complete_claim(pass.db, &claim_id, &moneybird_id, "paid").await?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = rest {
        if error.ends_pass() {
            return Err(error);
        }
        pass.record(&label, &error);
    }
    Ok(())
}

/// `followUpRows`: pushed invoices whose state moved on in WeldBooks.
async fn follow_up_rows(
    db: &PgPool,
    scope: &PendingScope<'_>,
    limit: i64,
) -> Result<Vec<Value>, DbErr> {
    let with_account =
        string(scope.settings.get("financialAccountId")).is_some_and(|s| !s.is_empty());
    // `case when $3 then i.status = 'cancelled' else i.status in ('cancelled', 'paid') end`.
    let statuses: &[&str] = if with_account {
        &["cancelled"]
    } else {
        &["cancelled", "paid"]
    };
    let rows = mappings::Entity::find()
        .select_also(invoices::Entity)
        .join(
            JoinType::InnerJoin,
            mappings::Entity::belongs_to(invoices::Entity)
                .from(mappings::Column::InternalEntityId)
                .to(invoices::Column::Id)
                .into(),
        )
        .filter(mappings::Column::ConnectionId.eq(scope.connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(MB_INVOICE_TYPE))
        .filter(mappings::Column::SyncChecksum.eq("open"))
        .filter(mappings::Column::ExternalEntityId.not_like("pending:%"))
        .filter(mappings::Column::ExternalEntityId.not_like("failed:%"))
        .filter(invoices::Column::Status.is_in(statuses.iter().copied()))
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(&orm(db))
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (mapping, invoice) in rows {
        // The row as Drizzle reads it (`total` as text, as `numeric` prints).
        let invoice = invoice
            .map(|row| serde_json::to_value(row).map_err(crate::connections::json_error))
            .transpose()?
            .unwrap_or(Value::Null);
        out.push(json!({
            "rowId": mapping.id,
            "moneybirdId": mapping.external_entity_id,
            "invoice": invoice,
        }));
    }
    Ok(out)
}

async fn follow_up_invoices(pass: &mut Pass<'_>) -> Step<()> {
    let scope_rows = {
        let scope = pass.scope();
        follow_up_rows(pass.db, &scope, MAX_INVOICES_PER_PASS).await?
    };
    for row in scope_rows {
        let row_id = row["rowId"].as_str().unwrap_or_default().to_owned();
        let moneybird_id = row["moneybirdId"].as_str().unwrap_or_default().to_owned();
        let invoice = row["invoice"].clone();
        let cancelled = invoice["status"] == "cancelled";
        let step: Step<()> = async {
            if cancelled {
                pass.spend()?;
                pass.client
                    .delete_external_sales_invoice(pass.http, &moneybird_id)
                    .await?;
                complete_claim(pass.db, &row_id, &moneybird_id, "void").await?;
            } else {
                mark_paid(pass, &moneybird_id, &invoice).await?;
                complete_claim(pass.db, &row_id, &moneybird_id, "paid").await?;
            }
            pass.lines += 1;
            Ok(())
        }
        .await;
        if let Err(error) = step {
            if error.ends_pass() {
                return Err(error);
            }
            let label = string(invoice.get("invoiceNumber"))
                .or_else(|| string(invoice.get("id")))
                .unwrap_or_default()
                .to_owned();
            pass.record(&label, &error);
            if cancelled {
                complete_claim(pass.db, &row_id, &moneybird_id, "void_failed").await?;
            }
        }
    }
    Ok(())
}

// ── payouts ─────────────────────────────────────────────────────────────────

struct PayoutLine {
    bank_transaction_id: String,
    stripe_line: String,
    kind: String,
    amount: String,
    date: String,
    description: Option<String>,
    balance_transaction_id: Option<String>,
    moneybird_invoice_id: Option<String>,
    invoice_number: Option<String>,
    counterparty: Option<String>,
}

struct Planned {
    token: String,
    date: String,
    message: String,
    amount: String,
    /// `todo:…` / `manual`, as `bookingChecksum` writes it.
    checksum: String,
    bank_transaction_id: String,
}

fn raw_text(raw: &Value, key: &str) -> Option<String> {
    string(raw.get(key))
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `pushedInvoiceFor(...)`: the Moneybird invoice and number for the Stripe
/// invoice a charge paid, and whether the statement has to wait for it.
async fn pushed_invoice_for(
    pass: &Pass<'_>,
    source: &str,
    stripe_invoice: &str,
) -> Result<(Option<String>, Option<String>, bool), DbErr> {
    let db = &orm(pass.db);
    let mapping: Option<String> = mappings::Entity::find()
        .select_only()
        .column(mappings::Column::InternalEntityId)
        .filter(mappings::Column::ConnectionId.eq(source))
        .filter(mappings::Column::ExternalEntityType.eq(STRIPE_INVOICE_TYPE))
        .filter(mappings::Column::ExternalEntityId.eq(stripe_invoice))
        .into_tuple()
        .one(db)
        .await?;
    let Some(invoice_id) = mapping else {
        return Ok((None, None, false));
    };
    let invoice: Option<(Option<String>, String, PrimitiveDateTime)> = invoices::Entity::find()
        .select_only()
        .columns([
            invoices::Column::InvoiceNumber,
            invoices::Column::Status,
            invoices::Column::IssueDate,
        ])
        .filter(invoices::Column::Id.eq(invoice_id.as_str()))
        .into_tuple()
        .one(db)
        .await?;
    let pushed: Option<String> = mappings::Entity::find()
        .select_only()
        .column(mappings::Column::ExternalEntityId)
        .filter(mappings::Column::ConnectionId.eq(pass.connection_id.as_str()))
        .filter(mappings::Column::ExternalEntityType.eq(MB_INVOICE_TYPE))
        .filter(mappings::Column::InternalEntityId.eq(invoice_id.as_str()))
        .into_tuple()
        .one(db)
        .await?;
    let done = pushed
        .as_deref()
        .is_some_and(|p| !p.starts_with("pending:") && !p.starts_with("failed:"));
    let start = start_date(&pass.settings);
    let in_scope = invoice.as_ref().is_some_and(|(_, status, issue_date)| {
        let issued = epoch_ms(*issue_date);
        PUSHABLE_STATUSES.contains(&status.as_str())
            && start
                .as_deref()
                .and_then(crate::js::date_parse)
                .is_none_or(|s| issued >= s)
    });
    let failed = pushed.as_deref().is_some_and(|p| p.starts_with("failed:"));
    Ok((
        if done { pushed } else { None },
        invoice.and_then(|(number, ..)| number.filter(|n| !n.is_empty())),
        in_scope && !done && !failed,
    ))
}

/// `loadPayoutLines(...)`.
async fn load_payout_lines(
    pass: &Pass<'_>,
    payout_txn: &str,
) -> Result<Option<(String, String, Vec<PayoutLine>, bool)>, DbErr> {
    use sea_orm::ExprTrait as _;
    let db = &orm(pass.db);
    let line_mapping = || {
        bank_transactions::Entity::belongs_to(mappings::Entity)
            .from(bank_transactions::Column::Id)
            .to(mappings::Column::InternalEntityId)
            .into()
    };
    let payout: Option<(Option<Value>, String)> = bank_transactions::Entity::find()
        .select_only()
        .column(bank_transactions::Column::RawData)
        .column(mappings::Column::ConnectionId)
        .join(JoinType::InnerJoin, line_mapping())
        .filter(bank_transactions::Column::Id.eq(payout_txn))
        .filter(mappings::Column::ExternalEntityType.eq(STRIPE_LINE_TYPE))
        .into_tuple()
        .one(db)
        .await?;
    let Some((raw, source)) = payout else {
        return Ok(None);
    };
    let raw = raw.unwrap_or(Value::Null);
    let Some(payout_id) = raw_text(&raw, "payoutId") else {
        return Ok(None);
    };
    // The lines as Drizzle reads them: `amount` as text, `date` as `toISOString()`.
    let rows: Vec<Value> = bank_transactions::Entity::find()
        .join(JoinType::InnerJoin, line_mapping())
        .filter(mappings::Column::ConnectionId.eq(source.as_str()))
        .filter(mappings::Column::ExternalEntityType.eq(STRIPE_LINE_TYPE))
        .filter(bank_transactions::Column::DeletedAt.is_null())
        .filter(
            sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
                Expr::col((bank_transactions::Entity, bank_transactions::Column::RawData)),
                "payoutId",
            )
            .eq(payout_id.as_str()),
        )
        .order_by_asc(bank_transactions::Column::Date)
        .order_by_asc(bank_transactions::Column::Id)
        .all(db)
        .await?
        .into_iter()
        .map(|row| serde_json::to_value(row).map_err(crate::connections::json_error))
        .collect::<Result<_, _>>()?;
    let mut waiting = false;
    let mut lines = Vec::new();
    for row in rows {
        let raw = row["rawData"].clone();
        let (moneybird, number, wait) = match raw_text(&raw, "invoiceId") {
            Some(stripe_invoice) => pushed_invoice_for(pass, &source, &stripe_invoice).await?,
            None => (None, None, false),
        };
        waiting = waiting || wait;
        let line = raw_text(&raw, "stripeLine").unwrap_or_default();
        lines.push(PayoutLine {
            bank_transaction_id: row["id"].as_str().unwrap_or_default().to_owned(),
            stripe_line: if line == "fee" || line == "payout" {
                line
            } else {
                "gross".to_owned()
            },
            kind: raw_text(&raw, "type").unwrap_or_else(|| "adjustment".to_owned()),
            amount: row["amount"].as_str().unwrap_or("0").to_owned(),
            date: row["date"].as_str().unwrap_or_default().to_owned(),
            description: string(row.get("description")).map(str::to_owned),
            balance_transaction_id: raw_text(&raw, "balanceTransactionId"),
            moneybird_invoice_id: moneybird,
            invoice_number: number,
            counterparty: string(row.get("counterpartyName")).map(str::to_owned),
        });
    }
    let currency = raw_text(&raw, "currency").unwrap_or_else(|| "EUR".to_owned());
    Ok(Some((payout_id, currency, lines, waiting)))
}

/// `planPayoutStatement(payoutId, lines)`.
fn plan_statement(payout_id: &str, lines: &[PayoutLine]) -> Vec<Planned> {
    let cents = |amount: &str| js_round(num(amount) * 100.0);
    let mut planned = Vec::new();
    let mut fee_cents = 0.0;
    let mut fee_date: Option<String> = None;
    let mut payout: Option<&PayoutLine> = None;
    for line in lines {
        if line.stripe_line == "payout" {
            payout = Some(line);
            continue;
        }
        if line.stripe_line == "fee" || line.kind == "stripe_fee" {
            fee_cents += cents(&line.amount);
            let later = fee_date.as_deref().is_none_or(|d| {
                crate::mappers::js_date_loose(&line.date).unwrap_or(0.0)
                    > crate::mappers::js_date_loose(d).unwrap_or(0.0)
            });
            if later {
                fee_date = Some(line.date.clone());
            }
            continue;
        }
        let token = line
            .balance_transaction_id
            .clone()
            .unwrap_or_else(|| line.bank_transaction_id.clone());
        let is_payment = line.kind == "charge" || line.kind == "payment";
        let label = if is_payment {
            let joined = [line.invoice_number.clone(), line.counterparty.clone()]
                .into_iter()
                .flatten()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if joined.is_empty() {
                "Stripe payment".to_owned()
            } else {
                joined
            }
        } else {
            line.description
                .clone()
                .unwrap_or_else(|| format!("Stripe {}", line.kind))
        };
        let amount = crate::js::to_fixed(num(&line.amount), 2);
        let checksum = match (&line.moneybird_invoice_id, is_payment) {
            (Some(invoice), true) => format!("todo:invoice:{invoice}:{amount}"),
            _ => "manual".to_owned(),
        };
        planned.push(Planned {
            message: crate::mappers::slice_units(&format!("{label} [{token}]"), 255),
            date: ymd(Some(&line.date)),
            amount,
            checksum,
            bank_transaction_id: line.bank_transaction_id.clone(),
            token,
        });
    }
    if let Some(payout) = payout {
        if fee_cents != 0.0 {
            let amount = crate::js::to_fixed(fee_cents / 100.0, 2);
            planned.push(Planned {
                token: format!("{payout_id}-fees"),
                date: ymd(Some(fee_date.as_deref().unwrap_or(&payout.date))),
                message: format!("Stripe fees {payout_id} [{payout_id}-fees]"),
                checksum: format!("todo:fee:{amount}"),
                amount,
                bank_transaction_id: payout.bank_transaction_id.clone(),
            });
        }
        let amount = crate::js::to_fixed(num(&payout.amount), 2);
        planned.push(Planned {
            token: payout_id.to_owned(),
            date: ymd(Some(&payout.date)),
            message: format!("Stripe payout {payout_id} [{payout_id}]"),
            checksum: format!("todo:payout:{amount}"),
            amount,
            bank_transaction_id: payout.bank_transaction_id.clone(),
        });
    }
    planned
}

async fn account_currency(pass: &mut Pass<'_>) -> Step<Option<String>> {
    if let Some(currency) = &pass.account_currency {
        return Ok(currency.clone());
    }
    pass.spend()?;
    let accounts = pass.client.list_financial_accounts(pass.http).await?;
    let wanted = pass.setting("financialAccountId").unwrap_or_default();
    let currency = accounts
        .items
        .iter()
        .find(|row| text_id(row.get("id")) == wanted)
        .and_then(|row| string(row.get("currency")))
        .map(str::to_uppercase);
    pass.account_currency = Some(currency.clone());
    Ok(currency)
}

async fn push_payout(pass: &mut Pass<'_>, payout_txn: &str, force: bool) -> Step<()> {
    let Some(claim_id) = claim(
        pass.db,
        &pass.connection_id.clone(),
        MB_STATEMENT_TYPE,
        "bank_transaction",
        payout_txn,
        force,
    )
    .await?
    else {
        return Ok(());
    };
    let mut label = payout_txn.to_owned();
    let step: Step<()> = async {
        let Some((payout_id, currency, lines, waiting)) = load_payout_lines(pass, payout_txn).await? else {
            return Err(PushError::Other("Payout lines not found".to_owned()));
        };
        label.clone_from(&payout_id);
        if waiting {
            release_claim(pass.db, &claim_id).await?;
            pass.remaining = true;
            return Ok(());
        }
        if let Some(account) = account_currency(pass).await?
            && account != currency.to_uppercase()
        {
            return Err(PushError::Other(format!(
                "Stripe payout is in {currency}, the Moneybird account in {account}"
            )));
        }
        let planned = plan_statement(&payout_id, &lines);
        if planned.is_empty() {
            return Err(PushError::Other("Payout has no lines".to_owned()));
        }
        pass.spend()?;
        let mutations: Vec<Value> = planned
            .iter()
            .map(|p| json!({ "date": p.date, "message": p.message, "amount": p.amount }))
            .collect();
        let statement = pass
            .client
            .create_financial_statement(
                pass.http,
                &pass.setting("financialAccountId").unwrap_or_default(),
                &format!("Stripe {payout_id}"),
                planned.last().map(|p| p.date.as_str()),
                &mutations,
            )
            .await?;
        let statement_id = text_id(statement.get("id"));
        let external = if statement_id.is_empty() { format!("statement:{payout_id}") } else { statement_id };
        complete_claim(pass.db, &claim_id, &external, "posted").await?;
        pass.statements += 1;
        // `recordStatementLines`: one row per created line saying how to book it.
        let created = statement
            .get("financial_mutations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut matched: Vec<(String, String)> = Vec::new();
        for mutation in &created {
            let message = string(mutation.get("message")).unwrap_or_default();
            let id = text_id(mutation.get("id"));
            if id.is_empty() {
                continue;
            }
            if let Some(hit) = planned.iter().find(|p| {
                message.contains(&format!("[{}]", p.token)) && !matched.iter().any(|(t, _)| *t == p.token)
            }) {
                matched.push((hit.token.clone(), id));
            }
        }
        let now = utc_now();
        let mut recorded = 0;
        for line in &planned {
            let Some((_, mutation_id)) = matched.iter().find(|(t, _)| *t == line.token) else {
                continue;
            };
            mappings::Entity::insert(mappings::ActiveModel {
                id: Set(weldsuite_kit::generate_id("iem")),
                created_at: Set(now),
                updated_at: Set(now),
                connection_id: Set(pass.connection_id.clone()),
                external_entity_type: Set(MB_PUSHED_MUTATION_TYPE.to_owned()),
                external_entity_id: Set(mutation_id.clone()),
                internal_entity_type: Set("bank_transaction".to_owned()),
                internal_entity_id: Set(line.bank_transaction_id.clone()),
                sync_checksum: Set(Some(line.checksum.clone())),
                last_synced_at: Set(Some(now)),
            })
            .on_conflict(OnConflict::new().do_nothing().to_owned())
            .exec_without_returning(&orm(pass.db))
            .await?;
            recorded += 1;
        }
        if recorded < planned.len() {
            let error = PushError::Other("Some statement lines could not be matched; book them in Moneybird".to_owned());
            pass.record(&payout_id, &error);
        }
        Ok(())
    }
    .await;
    if let Err(error) = step {
        if error.ends_pass() {
            let _ = release_claim(pass.db, &claim_id).await;
            return Err(error);
        }
        let row: Option<String> = mappings::Entity::find()
            .select_only()
            .column(mappings::Column::ExternalEntityId)
            .filter(mappings::Column::Id.eq(claim_id.as_str()))
            .into_tuple()
            .one(&orm(pass.db))
            .await?;
        if row.as_deref().is_some_and(|r| r.starts_with("pending:")) {
            fail_claim(pass.db, &claim_id, payout_txn).await?;
        }
        pass.record(&label, &error);
        if error.is_auth() {
            return Err(error);
        }
    }
    Ok(())
}

/// `bookStatementLine(...)`: `linked` or `manual`.
async fn book_line(
    pass: &mut Pass<'_>,
    mutation_id: &str,
    checksum: &str,
    bank_transaction_id: &str,
) -> Step<&'static str> {
    let parts: Vec<&str> = checksum.split(':').collect();
    let kind = parts.get(1).copied().unwrap_or_default();
    if kind == "invoice" {
        let invoice = parts.get(2).copied().unwrap_or_default().to_owned();
        let amount = parts.get(3).copied().unwrap_or_default().to_owned();
        // `to_char(t.date, 'YYYY-MM-DD')`.
        let date: Option<PrimitiveDateTime> = bank_transactions::Entity::find()
            .select_only()
            .column(bank_transactions::Column::Date)
            .filter(bank_transactions::Column::Id.eq(bank_transaction_id))
            .into_tuple()
            .one(&orm(pass.db))
            .await?;
        let date = date.and_then(|at| {
            at.format(time::macros::format_description!("[year]-[month]-[day]"))
                .ok()
        });
        pass.spend()?;
        pass.client
            .create_external_sales_invoice_payment(
                pass.http,
                &invoice,
                json!({
                    "payment_date": ymd(date.as_deref()),
                    "price": amount,
                    "price_base": amount,
                    "financial_account_id": pass.setting("financialAccountId"),
                    "financial_mutation_id": mutation_id,
                }),
            )
            .await?;
        mappings::Entity::update_many()
            .col_expr(mappings::Column::SyncChecksum, Expr::value("paid"))
            .col_expr(mappings::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(mappings::Column::ConnectionId.eq(pass.connection_id.as_str()))
            .filter(mappings::Column::ExternalEntityType.eq(MB_INVOICE_TYPE))
            .filter(mappings::Column::ExternalEntityId.eq(invoice.as_str()))
            .exec(&orm(pass.db))
            .await?;
        return Ok("linked");
    }
    let ledger = pass.setting(if kind == "fee" {
        "feeLedgerAccountId"
    } else {
        "payoutLedgerAccountId"
    });
    let Some(ledger) = ledger else {
        return Ok("manual");
    };
    pass.spend()?;
    let base = crate::js::to_fixed(num(parts.get(2).copied().unwrap_or("0")).abs(), 2);
    pass.client
        .link_financial_mutation(
            pass.http,
            mutation_id,
            "LedgerAccount",
            &ledger,
            &base,
            Some(if kind == "fee" {
                "Stripe fees"
            } else {
                "Stripe payout"
            }),
        )
        .await?;
    Ok("linked")
}

/// `update integration_entity_mappings set sync_checksum = $1, updated_at = now where id = $2`.
async fn set_checksum(db: &PgPool, row_id: &str, checksum: &str) -> Result<(), DbErr> {
    mappings::Entity::update_many()
        .col_expr(mappings::Column::SyncChecksum, Expr::value(checksum))
        .col_expr(mappings::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(mappings::Column::Id.eq(row_id))
        .exec(&orm(db))
        .await
        .map(|_| ())
}

async fn book_lines(pass: &mut Pass<'_>) -> Step<()> {
    let rows: Vec<(String, String, Option<String>, String)> = mappings::Entity::find()
        .select_only()
        .columns([
            mappings::Column::Id,
            mappings::Column::ExternalEntityId,
            mappings::Column::SyncChecksum,
            mappings::Column::InternalEntityId,
        ])
        .filter(mappings::Column::ConnectionId.eq(pass.connection_id.as_str()))
        .filter(mappings::Column::ExternalEntityType.eq(MB_PUSHED_MUTATION_TYPE))
        .filter(mappings::Column::SyncChecksum.like("todo:%"))
        .order_by_asc(mappings::Column::CreatedAt)
        .limit(u64::try_from(MAX_LINKS_PER_PASS).unwrap_or(0))
        .into_tuple()
        .all(&orm(pass.db))
        .await?;
    let count = rows.len();
    for (row_id, mutation_id, checksum, bank_transaction_id) in rows {
        let checksum = checksum.unwrap_or_default();
        let kind = checksum.split(':').nth(1).unwrap_or("line").to_owned();
        match book_line(pass, &mutation_id, &checksum, &bank_transaction_id).await {
            Ok(outcome) => {
                set_checksum(pass.db, &row_id, outcome).await?;
                if outcome == "linked" {
                    pass.lines += 1;
                }
            }
            Err(error) => {
                if error.ends_pass() {
                    return Err(error);
                }
                set_checksum(pass.db, &row_id, &format!("failed:{kind}")).await?;
                pass.record(&mutation_id, &error);
                if error.is_auth() {
                    return Err(error);
                }
            }
        }
    }
    if i64::try_from(count).unwrap_or(0) == MAX_LINKS_PER_PASS {
        pass.remaining = true;
    }
    Ok(())
}

/// `hasWork(db, state, force)`.
async fn has_work(db: &PgPool, scope: &PendingScope<'_>, force: bool) -> Result<bool, DbErr> {
    if !pending_invoice_ids(db, scope, force, 1).await?.is_empty() {
        return Ok(true);
    }
    if !pending_payout_ids(db, scope, force, 1).await?.is_empty() {
        return Ok(true);
    }
    if !follow_up_rows(db, scope, 1).await?.is_empty() {
        return Ok(true);
    }
    let todo: Option<String> = mappings::Entity::find()
        .select_only()
        .column(mappings::Column::Id)
        .filter(mappings::Column::ConnectionId.eq(scope.connection_id))
        .filter(mappings::Column::ExternalEntityType.eq(MB_PUSHED_MUTATION_TYPE))
        .filter(mappings::Column::SyncChecksum.like("todo:%"))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(todo.is_some())
}

/// `pushToMoneybird({ connection, trigger, force })`: one pass for one
/// Moneybird connection.
pub async fn push_to_moneybird(
    db: &PgPool,
    env: &crate::sync::SyncEnv,
    connection: &Value,
    trigger: &str,
    force: bool,
) -> Result<PushResult, DbErr> {
    let Some(settings) =
        settings_of(connection).filter(|s| s.get("enabled").is_some_and(crate::js::truthy))
    else {
        return Ok(PushResult {
            skipped: Some("Sending to Moneybird is off".to_owned()),
            ..PushResult::default()
        });
    };
    let status = connection["status"].as_str().unwrap_or_default();
    if status == "paused" || status == "auth_error" || !connection["deleted_at"].is_null() {
        return Ok(PushResult {
            skipped: Some(format!("Moneybird connection is {status}")),
            ..PushResult::default()
        });
    }
    let connection_id = connection["id"].as_str().unwrap_or_default().to_owned();
    let sources = source_stripe_connection_ids(db, &settings).await?;
    let mut pass = Pass {
        db,
        env,
        http: env.http.as_ref(),
        connection_id: connection_id.clone(),
        client: client_for(connection, &env.keyring),
        settings,
        sources,
        budget: REQUEST_BUDGET,
        remaining: false,
        invoices: 0,
        statements: 0,
        lines: 0,
        failed: 0,
        errors: Vec::new(),
        tax_rates: None,
        account_currency: None,
    };
    if !has_work(db, &pass.scope(), force).await? {
        return Ok(PushResult::default());
    }
    let run_id = crate::sync::start_sync_run(
        db,
        &connection_id,
        SYNC_NAME,
        "MoneybirdPush",
        trigger,
        "PUSH",
    )
    .await?;
    let mut auth_error = false;
    let outcome: Step<()> = async {
        let invoices = {
            let scope = pass.scope();
            pending_invoice_ids(db, &scope, force, MAX_INVOICES_PER_PASS).await?
        };
        for invoice in invoices {
            push_invoice(&mut pass, &invoice, force).await?;
        }
        follow_up_invoices(&mut pass).await?;
        let payouts = {
            let scope = pass.scope();
            pending_payout_ids(db, &scope, force, MAX_PAYOUTS_PER_PASS).await?
        };
        for payout in payouts {
            push_payout(&mut pass, &payout, force).await?;
        }
        book_lines(&mut pass).await?;
        if !pass.remaining {
            let scope = pass.scope();
            pass.remaining = has_work(db, &scope, false).await?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = outcome {
        if error.ends_pass() {
            pass.remaining = true;
        } else if error.is_auth() {
            auth_error = true;
        } else {
            pass.record("-", &error);
        }
    }
    let mut applied = crate::ingest::IngestResult {
        created: pass.invoices + pass.statements,
        modified: pass.lines,
        failed: pass.failed,
        ..crate::ingest::IngestResult::default()
    };
    applied.error_samples.clone_from(&pass.errors);
    let status = if auth_error {
        "error"
    } else if pass.failed > 0 {
        "partial"
    } else {
        "success"
    };
    let error = if auth_error {
        Some("Moneybird rejected the connection — reconnect it".to_owned())
    } else {
        pass.errors.first().map(|(_, message)| {
            format!(
                "{} item(s) could not be sent to Moneybird: {message}",
                pass.failed
            )
        })
    };
    crate::sync::finish_sync_run(
        db,
        &run_id,
        &connection_id,
        &crate::sync::RunEnd {
            status,
            applied: &applied,
            error,
            watermarks: Vec::new(),
        },
    )
    .await?;
    Ok(PushResult {
        invoices_pushed: pass.invoices,
        statements_pushed: pass.statements,
        lines_booked: pass.lines,
        failed: pass.failed,
        remaining: pass.remaining,
        skipped: None,
    })
}

/// `scheduleMoneybirdPushBacklog(env, connectionId)`: ask the cron for
/// another pass in five minutes (the master due index, kind
/// [`DUE_KIND`], for the workspace). Best effort.
pub async fn schedule_backlog(env: &crate::sync::SyncEnv) {
    let Some(due) = &env.due else {
        return;
    };
    let at = time::OffsetDateTime::now_utc() + time::Duration::seconds(PUSH_INTERVAL_SECONDS);
    weldsuite_db::due_index::mark_due(&due.master, DUE_KIND, &due.workspace_id, at).await;
}

/// `pushAllMoneybirdConnections({ trigger, stripeConnectionId })`: a pass for
/// every Moneybird connection sending (that Stripe account's) sales.
pub async fn push_all(
    db: &PgPool,
    env: &crate::sync::SyncEnv,
    trigger: &str,
    stripe_connection_id: Option<&str>,
) -> Result<bool, DbErr> {
    let targets: Vec<Value> = connections_by_provider(db, "moneybird")
        .await?
        .into_iter()
        .filter(|connection| {
            let Some(settings) = settings_of(connection) else {
                return false;
            };
            if !settings.get("enabled").is_some_and(crate::js::truthy) {
                return false;
            }
            let sources: Vec<&str> = settings
                .get("sourceConnectionIds")
                .and_then(Value::as_array)
                .map(|l| l.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            match stripe_connection_id {
                Some(id) if !sources.is_empty() => sources.contains(&id),
                _ => true,
            }
        })
        .collect();
    let mut remaining = false;
    for connection in targets {
        match push_to_moneybird(db, env, &connection, trigger, false).await {
            Ok(result) if result.remaining => {
                remaining = true;
                schedule_backlog(env).await;
            }
            Ok(_) => {}
            Err(error) => {
                tracing::error!(%error, "[connectors/moneybird-push] pass failed");
            }
        }
    }
    Ok(remaining)
}

/// `pushAfterStripeIngest({ stripeConnectionId })`: never fails the import.
pub async fn push_after_stripe_ingest(
    db: &PgPool,
    env: &crate::sync::SyncEnv,
    stripe_connection_id: &str,
) {
    if let Err(error) = push_all(db, env, "webhook", Some(stripe_connection_id)).await {
        tracing::error!(%error, "[connectors/moneybird-push] after Stripe import failed");
    }
}
