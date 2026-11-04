//! Bank feed connections (`services/bank-feeds/connections.ts`): views, link
//! sessions, completing a link, mapping feed accounts to bank accounts,
//! disconnecting and deleting, pending transactions. Tokens are encrypted at
//! rest and never returned.

use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_kit::generate_id;

use super::normalize::{connection_status, normalize_iban};
use super::providers::{arr, rec};
use super::{
    DEFAULT_HISTORY_DAYS, FeedContext, INACTIVE_STATUSES, LinkInput, ServiceError,
    StoredConnection, service,
};
use crate::http::now;
use crate::js::{iso_from_millis, millis_of, slice_utf16};
use crate::tables::{BANK_ACCOUNTS, BANK_CONNECTIONS, BANK_FEED_PENDING_TRANSACTIONS};

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// `loadConnection(db, id)`: the live connection.
pub async fn load_connection(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    BANK_CONNECTIONS.find_live(db, id).await
}

/// `requireConnection(db, id, entityId)`.
pub async fn require_connection(
    db: &PgPool,
    id: &str,
    entity_id: Option<&str>,
) -> Result<Value, ServiceError> {
    match load_connection(db, id).await? {
        Some(row)
            if entity_id.is_none_or(|e| e.is_empty() || text(&row, "entityId") == Some(e)) =>
        {
            Ok(row)
        }
        _ => Err(service(
            "not_found",
            format!("Bank connection '{id}' not found"),
        )),
    }
}

/// `storedFeedAccounts(row)`.
pub fn stored_feed_accounts(row: &Value) -> Vec<Value> {
    arr(row.get("metadata").and_then(|m| m.get("feedAccounts")))
}

/// `toStoredConnection(ctx, row, accountIds)`.
pub fn to_stored(
    ctx: &FeedContext,
    row: &Value,
    account_ids: Option<Vec<String>>,
) -> StoredConnection {
    StoredConnection {
        provider: text(row, "provider").unwrap_or_default().to_owned(),
        provider_connection_id: text(row, "providerConnectionId")
            .unwrap_or_default()
            .to_owned(),
        credentials: ctx.open(text(row, "credentialsEncrypted")),
        cursor: row.get("syncCursor").cloned().unwrap_or(Value::Null),
        metadata: rec(row.get("metadata")),
        history_days: row.get("historyDays").and_then(Value::as_i64),
        account_ids,
    }
}

fn reasonable_name(value: &str) -> String {
    value
        .to_lowercase()
        .split(crate::jurisdictions::is_js_space)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `suggestionFor(account, candidates)`: the bank account a new feed account
/// most likely belongs to.
fn suggestion_for(account: &Value, candidates: &[Value]) -> Option<Value> {
    let named = |ba: &Value, reason: &str| json!({ "bankAccountId": ba.get("id"), "bankAccountName": ba.get("name"), "reason": reason });
    let fingerprint = text(account, "fingerprint");
    if let Some(ba) = candidates.iter().find(|ba| {
        text(ba, "feedAccountFingerprint").is_some_and(|f| !f.is_empty())
            && text(ba, "feedAccountFingerprint") == fingerprint
    }) {
        return Some(named(ba, "fingerprint"));
    }
    if let Some(iban) = text(account, "iban").filter(|i| !i.is_empty()) {
        let wanted = normalize_iban(iban);
        if let Some(ba) = candidates.iter().find(|ba| {
            text(ba, "iban")
                .filter(|i| !i.is_empty())
                .is_some_and(|i| normalize_iban(i) == wanted)
        }) {
            return Some(named(ba, "iban"));
        }
    }
    if let Some(mask) = text(account, "mask").filter(|m| !m.is_empty())
        && let Some(ba) = candidates.iter().find(|ba| {
            text(ba, "accountNumberLast4") == Some(mask)
                || text(ba, "iban")
                    .filter(|i| !i.is_empty())
                    .is_some_and(|i| normalize_iban(i).ends_with(mask))
        })
    {
        return Some(named(ba, "last4"));
    }
    let name = reasonable_name(text(account, "name").unwrap_or_default());
    candidates
        .iter()
        .find(|ba| reasonable_name(text(ba, "name").unwrap_or_default()) == name)
        .map(|ba| named(ba, "name"))
}

fn iso_of(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// `connectionViews(ctx, rows, { suggestions })`.
#[allow(clippy::too_many_lines)] // the worker's view, field by field
pub async fn connection_views(
    ctx: &FeedContext,
    rows: &[Value],
    suggestions: bool,
) -> Result<Vec<Value>, sqlx::Error> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = rows
        .iter()
        .filter_map(|r| text(r, "id").map(str::to_owned))
        .collect();
    let accounts: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(bank_accounts),
        " from bank_accounts t where t.feed_connection_id = any($1) and t.deleted_at is null"
    ))
    .bind(&ids)
    .fetch_all(&ctx.db)
    .await?;
    let accounts = BANK_ACCOUNTS.js_rows(accounts);
    let mut views = Vec::new();
    for row in rows {
        let id = text(row, "id").unwrap_or_default();
        let mapped: Vec<&Value> = accounts
            .iter()
            .filter(|a| text(a, "feedConnectionId") == Some(id))
            .collect();
        let feed_accounts = stored_feed_accounts(row);
        let is_mapped = |fa: &Value| {
            mapped
                .iter()
                .find(|m| {
                    text(m, "feedAccountId").is_some()
                        && text(m, "feedAccountId") == text(fa, "providerAccountId")
                })
                .copied()
        };
        let mut candidates: Vec<Value> = Vec::new();
        if suggestions && feed_accounts.iter().any(|fa| is_mapped(fa).is_none()) {
            let all: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                crate::books_row!(bank_accounts),
                " from bank_accounts t where t.entity_id = $1 and t.deleted_at is null"
            ))
            .bind(text(row, "entityId"))
            .fetch_all(&ctx.db)
            .await?;
            candidates = BANK_ACCOUNTS
                .js_rows(all)
                .into_iter()
                .filter(|ba| {
                    text(ba, "feedConnectionId").is_none_or(str::is_empty)
                        || matches!(text(ba, "feedStatus"), Some("disconnected" | "revoked"))
                })
                .collect();
        }
        let mut account_views = Vec::new();
        for fa in &feed_accounts {
            let bank = is_mapped(fa);
            let mut view = Map::new();
            view.insert(
                "feedAccountId".to_owned(),
                fa.get("providerAccountId").cloned().unwrap_or(Value::Null),
            );
            for (key, from) in [
                ("name", "name"),
                ("mask", "mask"),
                ("type", "type"),
                ("subtype", "subtype"),
                ("currency", "currency"),
                ("status", "status"),
            ] {
                view.insert(key.to_owned(), fa.get(from).cloned().unwrap_or(Value::Null));
            }
            view.insert(
                "bankAccountId".to_owned(),
                bank.and_then(|b| b.get("id").cloned())
                    .unwrap_or(Value::Null),
            );
            view.insert(
                "bankAccountName".to_owned(),
                bank.and_then(|b| b.get("name").cloned())
                    .unwrap_or(Value::Null),
            );
            view.insert(
                "syncFrom".to_owned(),
                bank.and_then(|b| b.get("feedSyncFrom").cloned())
                    .unwrap_or(Value::Null),
            );
            if suggestions && bank.is_none() {
                let suggestion = suggestion_for(fa, &candidates);
                if let Some(chosen) = suggestion
                    .as_ref()
                    .and_then(|s| s["bankAccountId"].as_str())
                {
                    candidates.retain(|c| text(c, "id") != Some(chosen));
                }
                view.insert("suggestion".to_owned(), suggestion.unwrap_or(Value::Null));
            }
            account_views.push(Value::Object(view));
        }
        let capabilities = ctx
            .provider(text(row, "provider").unwrap_or_default())
            .map_or(Value::Null, |p| p.capabilities());
        let warnings = stored_warnings(row);
        let tail = warnings.len().saturating_sub(20);
        views.push(json!({
            "id": id,
            "entityId": row.get("entityId"),
            "provider": row.get("provider"),
            "institutionId": row.get("institutionId"),
            "institutionName": row.get("institutionName"),
            "status": row.get("status"),
            "lastSyncedAt": iso_of(row, "lastSyncedAt"),
            "lastError": row.get("lastError"),
            "consentExpiresAt": iso_of(row, "consentExpiresAt"),
            "historyDays": row.get("historyDays"),
            "createdAt": row.get("createdAt"),
            "capabilities": capabilities,
            "accounts": account_views,
            "warnings": warnings[tail..],
        }));
    }
    Ok(views)
}

pub(crate) fn stored_warnings(row: &Value) -> Vec<Value> {
    arr(row.get("metadata").and_then(|m| m.get("warnings")))
}

/// `listConnectionViews(ctx, entityId)`.
pub async fn list_views(ctx: &FeedContext, entity_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(bank_connections),
        " from bank_connections t where t.entity_id = $1 and t.deleted_at is null order by t.created_at desc"
    ))
    .bind(entity_id)
    .fetch_all(&ctx.db)
    .await?;
    connection_views(ctx, &BANK_CONNECTIONS.js_rows(rows), false).await
}

/// `connectionViewById(ctx, id, { suggestions })`.
pub async fn view_by_id(
    ctx: &FeedContext,
    id: &str,
    suggestions: bool,
) -> Result<Value, ServiceError> {
    let row = require_connection(&ctx.db, id, None).await?;
    connection_views(ctx, std::slice::from_ref(&row), suggestions)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| service("not_found", format!("Bank connection '{id}' not found")))
}

fn assert_not_disconnected(row: &Value) -> Result<(), ServiceError> {
    if text(row, "status") == Some("disconnected") {
        return Err(service(
            "conflict",
            "This bank connection was disconnected. Connect the bank again as a new connection.",
        ));
    }
    Ok(())
}

/// `createLinkSession(ctx, args)` arguments.
pub struct LinkSessionArgs {
    pub provider_id: String,
    pub mode: String,
    pub connection_id: Option<String>,
    pub workspace_id: String,
    pub redirect_url: String,
    pub institution: Option<Value>,
    pub psu_type: Option<String>,
}

/// `createLinkSession(ctx, args)`: the session, with `provider` and
/// `historyDays`.
pub async fn create_link_session(
    ctx: &FeedContext,
    args: LinkSessionArgs,
) -> Result<Value, ServiceError> {
    let provider = ctx.provider(&args.provider_id)?;
    let mut stored = None;
    if args.mode != "create" {
        let Some(connection_id) = args.connection_id.as_deref().filter(|c| !c.is_empty()) else {
            return Err(service(
                "bad_request",
                "connectionId is required to reconnect or add accounts",
            ));
        };
        let row = require_connection(&ctx.db, connection_id, None).await?;
        if text(&row, "provider") != Some(provider.id) {
            return Err(service(
                "bad_request",
                "The connection belongs to another provider",
            ));
        }
        assert_not_disconnected(&row)?;
        stored = Some(to_stored(ctx, &row, None));
    }
    let history_days = provider.max_history_days().min(DEFAULT_HISTORY_DAYS);
    let session = provider
        .create_link_session(&LinkInput {
            workspace_id: args.workspace_id,
            mode: args.mode,
            history_days,
            redirect_url: args.redirect_url,
            connection: stored,
            institution: args.institution,
            psu_type: args.psu_type,
        })
        .await?;
    let mut out = session.as_object().cloned().unwrap_or_default();
    out.insert("provider".to_owned(), json!(provider.id));
    out.insert("historyDays".to_owned(), json!(history_days));
    Ok(Value::Object(out))
}

fn clip(value: Option<&str>, max: usize) -> Value {
    match value.filter(|v| !v.is_empty()) {
        Some(v) => Value::String(slice_utf16(v, max)),
        None => Value::Null,
    }
}

/// `mergeFeedAccounts`: the link's accounts replace same-id and
/// same-fingerprint entries; others stay.
fn merge_feed_accounts(existing: Vec<Value>, incoming: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = existing
        .into_iter()
        .filter(|old| {
            !incoming.iter().any(|n| {
                n.get("providerAccountId") == old.get("providerAccountId")
                    || n.get("fingerprint") == old.get("fingerprint")
            })
        })
        .collect();
    out.extend(incoming.iter().cloned());
    out
}

/// What [`complete_link`] did.
pub struct Linked {
    pub view: Value,
    pub created: bool,
    pub restored: bool,
}

/// `completeLink(ctx, args)`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub async fn complete_link(
    ctx: &FeedContext,
    provider_id: &str,
    payload: &Value,
    connection_id: Option<&str>,
    entity_id: &str,
    user_id: Option<&str>,
) -> Result<Linked, ServiceError> {
    let provider = ctx.provider(provider_id)?;
    let mut client = rec(Some(payload));
    client.remove("connection");
    let mut existing: Option<Value> = None;
    if let Some(id) = connection_id.filter(|c| !c.is_empty()) {
        let row = require_connection(&ctx.db, id, Some(entity_id)).await?;
        if text(&row, "provider") != Some(provider.id) {
            return Err(service(
                "bad_request",
                "The connection belongs to another provider",
            ));
        }
        assert_not_disconnected(&row)?;
        client.insert(
            "connection".to_owned(),
            to_stored(ctx, &row, None).to_value(),
        );
        existing = Some(row);
    }
    let (connection, accounts) = provider.complete_link(&Value::Object(client)).await?;

    if existing.is_none() {
        let duplicate: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            crate::books_row!(bank_connections),
            " from bank_connections t where t.provider = $1 and t.provider_connection_id = $2 and t.deleted_at is null limit 1"
        ))
        .bind(provider.id)
        .bind(&connection.provider_connection_id)
        .fetch_optional(&ctx.db)
        .await?;
        let duplicate = duplicate.map(|row| BANK_CONNECTIONS.js(row));
        if let Some(duplicate) = &duplicate
            && text(duplicate, "entityId") != Some(entity_id)
        {
            return Err(service(
                "conflict",
                "This bank connection already belongs to another entity",
            ));
        }
        existing = duplicate;
    }

    let stamp = now();
    let incoming: Vec<Value> = accounts.iter().map(super::FeedAccount::stored).collect();
    let feed_accounts = match &existing {
        Some(row) => merge_feed_accounts(stored_feed_accounts(row), &incoming),
        None => incoming.clone(),
    };
    let credentials = ctx.seal(&connection.credentials)?;
    let consent = connection
        .consent_expires_at
        .as_deref()
        .filter(|c| !c.is_empty())
        .and_then(crate::js::js_date);
    let mut metadata = existing
        .as_ref()
        .map(|r| rec(r.get("metadata")))
        .unwrap_or_default();
    metadata.extend(rec(connection.metadata.as_ref()));
    metadata.insert(
        "feedAccounts".to_owned(),
        Value::Array(feed_accounts.clone()),
    );
    let status = if connection.status == "active" {
        let statuses: Vec<String> = feed_accounts
            .iter()
            .map(|a| text(a, "status").unwrap_or("active").to_owned())
            .collect();
        connection_status(&statuses).to_owned()
    } else {
        connection.status.clone()
    };
    let history_days = provider.max_history_days().min(DEFAULT_HISTORY_DAYS);

    let id = if let Some(row) = &existing {
        let id = text(row, "id").unwrap_or_default().to_owned();
        let mut set = Map::new();
        let keep = |value: Value, key: &str| {
            if value.is_null() {
                row.get(key).cloned().unwrap_or(Value::Null)
            } else {
                value
            }
        };
        set.insert(
            "institutionId".to_owned(),
            keep(
                clip(connection.institution_id.as_deref(), 100),
                "institutionId",
            ),
        );
        set.insert(
            "institutionName".to_owned(),
            keep(
                clip(connection.institution_name.as_deref(), 255),
                "institutionName",
            ),
        );
        set.insert("status".to_owned(), json!(status));
        set.insert("credentialsEncrypted".to_owned(), json!(credentials));
        let cursor = match row.get("syncCursor") {
            Some(c) if !c.is_null() => c.clone(),
            _ => connection.cursor.clone(),
        };
        set.insert("syncCursor".to_owned(), cursor);
        set.insert("consentExpiresAt".to_owned(), json!(consent));
        set.insert("lastError".to_owned(), Value::Null);
        set.insert("metadata".to_owned(), Value::Object(metadata));
        set.insert("updatedAt".to_owned(), json!(stamp));
        BANK_CONNECTIONS
            .patch_raw(&ctx.db, &id, BANK_CONNECTIONS.values(&set), false)
            .await?;
        let attached: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            crate::books_row!(bank_accounts),
            " from bank_accounts t where t.feed_connection_id = $1 and t.deleted_at is null"
        ))
        .bind(&id)
        .fetch_all(&ctx.db)
        .await?;
        for ba in BANK_ACCOUNTS.js_rows(attached) {
            let Some(found) = incoming
                .iter()
                .find(|a| a.get("fingerprint") == ba.get("feedAccountFingerprint"))
            else {
                continue;
            };
            sqlx::query("update bank_accounts set feed_account_id = $2, feed_status = $3, updated_at = $4::timestamp where id = $1")
                .bind(text(&ba, "id"))
                .bind(text(found, "providerAccountId"))
                .bind(text(found, "status").unwrap_or("active"))
                .bind(&stamp)
                .execute(&ctx.db)
                .await?;
        }
        id
    } else {
        let id = generate_id("bkc");
        let mut row = Map::new();
        for (key, value) in [
            ("id", json!(id)),
            ("entityId", json!(entity_id)),
            ("provider", json!(provider.id)),
            (
                "providerConnectionId",
                json!(connection.provider_connection_id),
            ),
            (
                "institutionId",
                clip(connection.institution_id.as_deref(), 100),
            ),
            (
                "institutionName",
                clip(connection.institution_name.as_deref(), 255),
            ),
            ("status", json!(status)),
            ("credentialsEncrypted", json!(credentials)),
            ("syncCursor", connection.cursor.clone()),
            ("consentExpiresAt", json!(consent)),
            ("historyDays", json!(history_days)),
            ("createdBy", json!(user_id)),
            ("metadata", Value::Object(metadata)),
            ("createdAt", json!(stamp)),
            ("updatedAt", json!(stamp)),
        ] {
            BANK_CONNECTIONS.set(&mut row, key, value);
        }
        BANK_CONNECTIONS.insert_raw(&ctx.db, row).await?;
        id
    };

    let mut restored = false;
    if !INACTIVE_STATUSES.contains(&status.as_str()) {
        restored = existing
            .as_ref()
            .is_some_and(|row| text(row, "status") == Some("disconnected"));
        let interval = if provider.has_webhooks() { 24 } else { 6 };
        let next = millis_of(&stamp).unwrap_or(0) + interval * 3_600_000;
        let keys = connection
            .index_keys
            .clone()
            .unwrap_or_else(|| vec![connection.provider_connection_id.clone()]);
        ctx.index_upsert(
            provider.id,
            &keys,
            &id,
            entity_id,
            interval,
            &iso_from_millis(next).unwrap_or_default(),
        )
        .await?;
    }
    let created = connection_id.is_none_or(str::is_empty) && existing.is_none();
    Ok(Linked {
        view: view_by_id(ctx, &id, true).await?,
        created,
        restored,
    })
}

/// One mapping of `POST /:id/map-accounts`.
#[derive(Debug, Clone, Default)]
pub struct Mapping {
    pub feed_account_id: String,
    pub bank_account_id: Option<String>,
    /// `{ name, accountType?, ledgerAccountId? }`.
    pub create: Option<(String, Option<String>, Option<String>)>,
    /// `Some(None)` is an explicit null.
    pub sync_from: Option<Option<String>>,
}

fn default_account_type(account: &Value) -> &'static str {
    match text(account, "subtype") {
        Some("savings") => "savings",
        Some("money_market") => "money_market",
        Some("credit_card") => "credit_card",
        Some("line_of_credit") => "line_of_credit",
        _ => match text(account, "type") {
            Some("credit") => "credit_card",
            Some("loan") => "line_of_credit",
            _ => "checking",
        },
    }
}

fn last_four(mask: Option<&str>) -> Value {
    match mask.filter(|m| !m.is_empty()) {
        Some(mask) => {
            let units: Vec<u16> = mask.encode_utf16().collect();
            json!(String::from_utf16_lossy(
                &units[units.len().saturating_sub(4)..]
            ))
        }
        None => Value::Null,
    }
}

/// What [`map_accounts`] did.
pub struct Mapped {
    pub view: Value,
    pub mapped: Vec<Value>,
    pub needs_sync: bool,
}

/// `mapAccounts(ctx, connectionId, input, entityId)`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub async fn map_accounts(
    ctx: &FeedContext,
    connection_id: &str,
    mappings: &[Mapping],
    sync_from: Option<Option<String>>,
    entity_id: Option<&str>,
) -> Result<Mapped, ServiceError> {
    let row = require_connection(&ctx.db, connection_id, entity_id).await?;
    let row_id = text(&row, "id").unwrap_or_default().to_owned();
    let row_entity = text(&row, "entityId").unwrap_or_default().to_owned();
    let feed_accounts = stored_feed_accounts(&row);
    let stamp = now();
    let mut seen_feed: Vec<String> = Vec::new();
    let mut seen_bank: Vec<String> = Vec::new();
    let mut results = Vec::new();
    let mut newly = 0;
    for mapping in mappings {
        let Some(feed) = feed_accounts
            .iter()
            .find(|a| text(a, "providerAccountId") == Some(mapping.feed_account_id.as_str()))
        else {
            return Err(service(
                "bad_request",
                format!(
                    "Feed account '{}' is not on this connection",
                    mapping.feed_account_id
                ),
            ));
        };
        let feed_id = text(feed, "providerAccountId")
            .unwrap_or_default()
            .to_owned();
        if seen_feed.contains(&feed_id) {
            return Err(service(
                "bad_request",
                format!("Feed account '{feed_id}' is mapped twice"),
            ));
        }
        seen_feed.push(feed_id.clone());
        if mapping.bank_account_id.as_deref().is_none_or(str::is_empty) && mapping.create.is_none()
        {
            return Err(service(
                "bad_request",
                "Each mapping needs bankAccountId or create",
            ));
        }
        // `mapping.syncFrom ?? input.syncFrom ?? null`
        let from = mapping
            .sync_from
            .clone()
            .flatten()
            .or_else(|| sync_from.clone().flatten());
        let mut feed_columns = Map::new();
        feed_columns.insert("feedConnectionId".to_owned(), json!(row_id));
        feed_columns.insert(
            "feedProvider".to_owned(),
            row.get("provider").cloned().unwrap_or(Value::Null),
        );
        feed_columns.insert("feedAccountId".to_owned(), json!(feed_id));
        feed_columns.insert(
            "feedAccountFingerprint".to_owned(),
            feed.get("fingerprint").cloned().unwrap_or(Value::Null),
        );
        feed_columns.insert("feedSyncFrom".to_owned(), json!(from));
        feed_columns.insert(
            "feedStatus".to_owned(),
            feed.get("status").cloned().unwrap_or(Value::Null),
        );
        feed_columns.insert("updatedAt".to_owned(), json!(stamp));

        if let Some(bank_id) = mapping.bank_account_id.as_deref().filter(|b| !b.is_empty()) {
            if seen_bank.iter().any(|b| b == bank_id) {
                return Err(service(
                    "bad_request",
                    format!("Bank account '{bank_id}' is mapped twice"),
                ));
            }
            seen_bank.push(bank_id.to_owned());
            let bank: Option<Value> = sqlx::query_scalar(concat!(
                "select ",
                crate::books_row!(bank_accounts),
                " from bank_accounts t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
            ))
            .bind(bank_id)
            .bind(&row_entity)
            .fetch_optional(&ctx.db)
            .await?;
            let Some(bank) = bank.map(|r| BANK_ACCOUNTS.js(r)) else {
                return Err(service(
                    "not_found",
                    format!("Bank account '{bank_id}' not found"),
                ));
            };
            let elsewhere = text(&bank, "feedConnectionId")
                .is_some_and(|c| !c.is_empty() && c != row_id)
                && !matches!(text(&bank, "feedStatus"), Some("disconnected" | "revoked"));
            if elsewhere {
                return Err(service(
                    "conflict",
                    format!(
                        "Bank account '{}' is already linked to another bank connection",
                        text(&bank, "name").unwrap_or_default()
                    ),
                ));
            }
            let already = text(&bank, "feedConnectionId") == Some(row_id.as_str())
                && text(&bank, "feedAccountId") == Some(feed_id.as_str());
            let mut set = feed_columns.clone();
            let or_keep = |key: &str, fallback: Value| match bank.get(key) {
                Some(v) if !v.is_null() => v.clone(),
                _ => fallback,
            };
            set.insert(
                "accountType".to_owned(),
                or_keep("accountType", json!(default_account_type(feed))),
            );
            set.insert(
                "accountNumberLast4".to_owned(),
                or_keep("accountNumberLast4", last_four(text(feed, "mask"))),
            );
            set.insert(
                "iban".to_owned(),
                or_keep(
                    "iban",
                    text(feed, "iban")
                        .filter(|i| !i.is_empty())
                        .map_or(Value::Null, |i| json!(slice_utf16(&normalize_iban(i), 34))),
                ),
            );
            set.insert(
                "bankName".to_owned(),
                or_keep(
                    "bankName",
                    row.get("institutionName").cloned().unwrap_or(Value::Null),
                ),
            );
            set.insert("isActive".to_owned(), json!(true));
            BANK_ACCOUNTS
                .patch_raw(&ctx.db, bank_id, BANK_ACCOUNTS.values(&set), false)
                .await?;
            results.push(
                json!({ "feedAccountId": feed_id, "bankAccountId": bank_id, "created": false }),
            );
            if !already {
                newly += 1;
            }
            continue;
        }
        let Some((name, account_type, ledger)) = &mapping.create else {
            continue;
        };
        let account_type = account_type
            .clone()
            .unwrap_or_else(|| default_account_type(feed).to_owned());
        if let Some(ledger) = ledger.as_deref().filter(|l| !l.is_empty()) {
            let found: Option<String> = sqlx::query_scalar(
                "select id from accounts where id = $1 and entity_id = $2 and deleted_at is null limit 1",
            )
            .bind(ledger)
            .bind(&row_entity)
            .fetch_optional(&ctx.db)
            .await?;
            if found.is_none() {
                return Err(service(
                    "bad_request",
                    format!("Ledger account '{ledger}' not found on this entity"),
                ));
            }
        }
        let currency = text(feed, "currency").unwrap_or_default().to_owned();
        let ledger_id = match ledger.as_deref().filter(|l| !l.is_empty()) {
            Some(ledger) => ledger.to_owned(),
            None => {
                crate::bank_accounts::create_ledger_account_for_bank(
                    &ctx.db,
                    &row_entity,
                    name,
                    &account_type,
                    &currency,
                )
                .await?
            }
        };
        let id = generate_id("ba");
        let default: Option<String> = sqlx::query_scalar(
            "select id from bank_accounts where entity_id = $1 and is_default = true and deleted_at is null limit 1",
        )
        .bind(&row_entity)
        .fetch_optional(&ctx.db)
        .await?;
        let mut values = Map::new();
        for (key, value) in [
            ("id", json!(id)),
            ("entityId", json!(row_entity)),
            ("name", json!(name)),
            (
                "bankName",
                row.get("institutionName").cloned().unwrap_or(Value::Null),
            ),
            (
                "iban",
                text(feed, "iban")
                    .filter(|i| !i.is_empty())
                    .map_or(Value::Null, |i| json!(slice_utf16(&normalize_iban(i), 34))),
            ),
            ("currency", json!(currency)),
            ("ledgerAccountId", json!(ledger_id)),
            ("currentBalance", json!("0")),
            ("isDefault", json!(default.is_none())),
            ("isActive", json!(true)),
            ("autoReconcile", json!(true)),
            ("accountType", json!(account_type)),
            ("accountNumberLast4", last_four(text(feed, "mask"))),
            ("createdAt", json!(stamp)),
        ] {
            values.insert(key.to_owned(), value);
        }
        values.extend(feed_columns);
        BANK_ACCOUNTS
            .insert_raw(&ctx.db, BANK_ACCOUNTS.values(&values))
            .await?;
        seen_bank.push(id.clone());
        results.push(json!({ "feedAccountId": feed_id, "bankAccountId": id, "created": true }));
        newly += 1;
    }
    if newly > 0 {
        sqlx::query(
            "update bank_connections set sync_cursor = null, \
             metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('resyncAt', $2::text), \
             updated_at = $2::timestamp where id = $1",
        )
        .bind(&row_id)
        .bind(&stamp)
        .execute(&ctx.db)
        .await?;
    }
    Ok(Mapped {
        view: view_by_id(ctx, &row_id, false).await?,
        mapped: results,
        needs_sync: newly > 0,
    })
}

/// `revokeAtProvider(ctx, row)`.
async fn revoke(ctx: &FeedContext, row: &Value) -> Result<(), ServiceError> {
    if text(row, "status") == Some("disconnected")
        || text(row, "credentialsEncrypted").is_none_or(str::is_empty)
    {
        return Ok(());
    }
    let Ok(provider) = ctx.provider(text(row, "provider").unwrap_or_default()) else {
        return Ok(());
    };
    let ids: Vec<String> = stored_feed_accounts(row)
        .iter()
        .filter_map(|a| text(a, "providerAccountId").map(str::to_owned))
        .collect();
    let stored = to_stored(ctx, row, Some(ids));
    match provider.disconnect(&stored).await {
        Ok(()) => Ok(()),
        Err(e) if matches!(e.kind, "reauth_required" | "revoked" | "permanent") => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// `disconnectConnection(ctx, id, entityId)`: revoke at the provider, keep
/// every synced transaction, stop syncing.
pub async fn disconnect(
    ctx: &FeedContext,
    connection_id: &str,
    entity_id: Option<&str>,
) -> Result<Value, ServiceError> {
    let row = require_connection(&ctx.db, connection_id, entity_id).await?;
    revoke(ctx, &row).await?;
    let stamp = now();
    let id = text(&row, "id").unwrap_or_default().to_owned();
    let feed_accounts: Vec<Value> = stored_feed_accounts(&row)
        .into_iter()
        .map(|mut a| {
            a["status"] = json!("disconnected");
            a
        })
        .collect();
    let mut metadata = rec(row.get("metadata"));
    metadata.insert("feedAccounts".to_owned(), Value::Array(feed_accounts));
    sqlx::query(
        "update bank_connections set status = 'disconnected', credentials_encrypted = null, last_error = null, \
         metadata = $2, updated_at = $3::timestamp where id = $1",
    )
    .bind(&id)
    .bind(Value::Object(metadata))
    .bind(&stamp)
    .execute(&ctx.db)
    .await?;
    sqlx::query(
        "update bank_accounts set feed_status = 'disconnected', updated_at = $2::timestamp \
         where feed_connection_id = $1 and deleted_at is null",
    )
    .bind(&id)
    .bind(&stamp)
    .execute(&ctx.db)
    .await?;
    ctx.index_remove(&id).await?;
    view_by_id(ctx, &id, false).await
}

/// `deleteConnection(ctx, id, entityId)`: disconnect, then drop it. The
/// connection as it was.
pub async fn delete(
    ctx: &FeedContext,
    connection_id: &str,
    entity_id: Option<&str>,
) -> Result<Value, ServiceError> {
    let row = require_connection(&ctx.db, connection_id, entity_id).await?;
    revoke(ctx, &row).await?;
    let stamp = now();
    let id = text(&row, "id").unwrap_or_default().to_owned();
    sqlx::query(
        "update bank_accounts set feed_connection_id = null, feed_account_id = null, feed_status = null, \
         updated_at = $2::timestamp where feed_connection_id = $1 and deleted_at is null",
    )
    .bind(&id)
    .bind(&stamp)
    .execute(&ctx.db)
    .await?;
    sqlx::query(
        "update bank_connections set status = 'disconnected', credentials_encrypted = null, deleted_at = $2::timestamp, \
         updated_at = $2::timestamp where id = $1",
    )
    .bind(&id)
    .bind(&stamp)
    .execute(&ctx.db)
    .await?;
    ctx.index_remove(&id).await?;
    Ok(row)
}

/// `listPendingTransactions(db, connectionId, bankAccountId)`.
pub async fn list_pending(
    db: &PgPool,
    connection_id: &str,
    bank_account_id: Option<&str>,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        crate::books_row!(bank_feed_pending_transactions),
        " from bank_feed_pending_transactions t where t.connection_id = $1 and t.voided_at is null \
         and ($2::text is null or t.bank_account_id = $2) order by t.date desc limit 500"
    ))
    .bind(connection_id)
    .bind(bank_account_id.filter(|b| !b.is_empty()))
    .fetch_all(db)
    .await?;
    Ok(BANK_FEED_PENDING_TRANSACTIONS
        .js_rows(rows)
        .into_iter()
        .map(|r| {
            json!({
                "id": r.get("id"),
                "bankAccountId": r.get("bankAccountId"),
                "date": r.get("date"),
                "amount": r.get("amount"),
                "currency": r.get("currency"),
                "description": r.get("description"),
                "merchantName": r.get("merchantName"),
            })
        })
        .collect())
}
