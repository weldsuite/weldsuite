//! WeldBooks → Moneybird push (`connectors/moneybird-push.ts`): imported
//! Stripe sales go on to Moneybird. State lives in
//! `integration_entity_mappings` on the Moneybird connection (`pending:` /
//! `failed:` claims, else the Moneybird id).
//!
//! Here so far: the settings as stored, what the settings form picks from
//! ([`options`]) and how far the push is ([`status`]).

use serde_json::{Map, Value, json};
use weldsuite_db::{Keyring, PgPool, js_row};
use weldsuite_ports::OutboundHttp;

use crate::clients::{ConnectorError, as_text, decrypt_credentials};
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
pub async fn connections_by_provider(
    db: &PgPool,
    provider: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(
        "select to_jsonb(c) from connector_connections c
         where c.provider = $1 and c.deleted_at is null order by c.created_at desc",
    )
    .bind(provider)
    .fetch_all(db)
    .await
}

/// `sourceStripeConnectionIds(db, settings)`.
pub async fn source_stripe_connection_ids(
    db: &PgPool,
    settings: &Map<String, Value>,
) -> Result<Vec<String>, sqlx::Error> {
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

fn iso(millis: f64) -> String {
    weldsuite_kit::validation::js_iso_from_millis(millis).unwrap_or_default()
}

/// The cutoffs of `noBlockingRow`: a claim older than the stale cutoff, or
/// a failure older than the retry cutoff, no longer blocks.
pub(crate) fn cutoffs(force: bool) -> (String, String) {
    let now = now_ms();
    (
        iso(now - STALE_CLAIM_MS),
        iso(if force {
            now
        } else {
            now - FAILED_RETRY_AFTER_MS
        }),
    )
}

/// What `pendingInvoiceConditions` / `pendingPayoutIds` read of a pass.
pub struct PendingScope<'a> {
    pub connection_id: &'a str,
    pub settings: &'a Map<String, Value>,
    pub sources: &'a [String],
}

/// `count(distinct invoices.id)` under `pendingInvoiceConditions(state, false)`.
async fn pending_invoice_count(db: &PgPool, scope: &PendingScope<'_>) -> Result<i64, sqlx::Error> {
    let (stale, retry) = cutoffs(false);
    sqlx::query_scalar(
        "select count(distinct i.id) from integration_entity_mappings m
         inner join invoices i on i.id = m.internal_entity_id
         where m.connection_id = any($1) and m.external_entity_type = $2
           and m.internal_entity_type = 'invoice' and i.deleted_at is null
           and i.status = any($3) and ($4::text is null or i.issue_date >= $4::timestamp)
           and not exists (
             select 1 from integration_entity_mappings p
             where p.connection_id = $5 and p.external_entity_type = $6
               and p.internal_entity_id = i.id
               and ((p.external_entity_id not like 'pending:%' and p.external_entity_id not like 'failed:%')
                 or (p.external_entity_id like 'pending:%' and p.updated_at > $7::timestamp)
                 or (p.external_entity_id like 'failed:%' and p.updated_at > $8::timestamp)))",
    )
    .bind(scope.sources)
    .bind(STRIPE_INVOICE_TYPE)
    .bind(&PUSHABLE_STATUSES[..])
    .bind(start_date(scope.settings))
    .bind(scope.connection_id)
    .bind(MB_INVOICE_TYPE)
    .bind(stale)
    .bind(retry)
    .fetch_one(db)
    .await
}

/// `pendingPayoutIds(db, state, force, limit)`: payout lines of the sources
/// not yet on a statement, oldest first.
pub async fn pending_payout_ids(
    db: &PgPool,
    scope: &PendingScope<'_>,
    force: bool,
    limit: i64,
) -> Result<Vec<String>, sqlx::Error> {
    if scope.sources.is_empty()
        || string(scope.settings.get("financialAccountId")).is_none_or(str::is_empty)
    {
        return Ok(Vec::new());
    }
    let (stale, retry) = cutoffs(force);
    sqlx::query_scalar(
        "select bt.id from integration_entity_mappings m
         inner join bank_transactions bt on bt.id = m.internal_entity_id
         where m.connection_id = any($1) and m.external_entity_type = $2
           and bt.deleted_at is null and bt.raw_data->>'stripeLine' = 'payout'
           and ($3::text is null or bt.date >= $3::timestamp)
           and not exists (
             select 1 from integration_entity_mappings p
             where p.connection_id = $4 and p.external_entity_type = $5
               and p.internal_entity_id = bt.id
               and ((p.external_entity_id not like 'pending:%' and p.external_entity_id not like 'failed:%')
                 or (p.external_entity_id like 'pending:%' and p.updated_at > $6::timestamp)
                 or (p.external_entity_id like 'failed:%' and p.updated_at > $7::timestamp)))
         order by bt.date asc, bt.id asc limit $8",
    )
    .bind(scope.sources)
    .bind(STRIPE_LINE_TYPE)
    .bind(start_date(scope.settings))
    .bind(scope.connection_id)
    .bind(MB_STATEMENT_TYPE)
    .bind(stale)
    .bind(retry)
    .bind(limit)
    .fetch_all(db)
    .await
}

/// `countRows(db, connectionId, type, 'done' | 'failed')`.
async fn count_rows(
    db: &PgPool,
    connection_id: &str,
    kind: &str,
    failed: bool,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select count(*) from integration_entity_mappings m
         where m.connection_id = $1 and m.external_entity_type = $2
           and case when $3 then m.external_entity_id like 'failed:%'
                    else m.external_entity_id not like 'pending:%' and m.external_entity_id not like 'failed:%' end",
    )
    .bind(connection_id)
    .bind(kind)
    .bind(failed)
    .fetch_one(db)
    .await
}

/// `moneybirdPushStatus(db, connection)`.
pub async fn status(db: &PgPool, connection: &Value) -> Result<Value, sqlx::Error> {
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
    let last: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from connector_sync_runs r
         where r.connection_id = $1 and r.sync_name = $2 order by r.created_at desc limit 1",
    )
    .bind(connection_id)
    .bind(SYNC_NAME)
    .fetch_optional(db)
    .await?;
    let last_run = last.map(js_row).map(|run| {
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
    Database(sqlx::Error),
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

/// `pushAfterStripeIngest({ stripeConnectionId })`: after a Stripe import,
/// a push pass for every Moneybird connection sending that Stripe account's
/// sales. Never fails the import.
#[allow(clippy::unused_async)] // the push pass is still to come
pub async fn push_after_stripe_ingest(
    db: &PgPool,
    env: &crate::sync::SyncEnv,
    stripe_connection_id: &str,
) {
    let _ = (db, env, stripe_connection_id);
}
