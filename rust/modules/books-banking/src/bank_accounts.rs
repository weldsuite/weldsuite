//! `/api/bank-accounts` (`routes/bank-accounts/index.ts`): entity-scoped
//! bank accounts with their ledger account, US routing and account numbers
//! (sealed, only the last four shown; the full number through
//! `POST /:id/reveal-account-number`, logged), and the remembered import
//! settings. Responses and events never carry the encrypted blob. `DELETE`
//! only reaches accounts that are in WeldBooks; one WeldHR pays salaries from
//! keeps its core row and only leaves WeldBooks.

use std::str::FromStr;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue, ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, QueryTrait,
};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::bank_accounts::{
    BANK_ACCOUNT_TYPES, BankLedgerPlan, assert_ledger_account_fits, insert_ledger_account,
    is_valid_aba_routing, normalize_account_number, plan_bank_ledger_account,
    plan_default_bank_ledger_account, public_bank_account, reveal_account_number,
    seal_account_number,
};
use weldsuite_books_domain::entity_context::{resolve_entity_base_currency, resolve_entity_id};
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, now, ok, reply, validate,
};
use weldsuite_books_domain::identifiers::invalid_iban_message;
use weldsuite_books_domain::tables::BANK_ACCOUNTS;
use weldsuite_catalogs::entity_events::{
    ACCOUNT_CREATED, BANK_ACCOUNT_CREATED, BANK_ACCOUNT_DELETED, BANK_ACCOUNT_UPDATED,
};
use weldsuite_db::{OrmConn, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_legal_entities::{EntityRecordGuard, EntityTable};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    accounting_bank_account_settings as books_settings, accounting_entity_settings, accounts,
    bank_accounts, hr_payroll_employers,
};

use crate::common::{bank_account_refusal, changes, field, text};
use crate::csv_format;
use crate::orm_bridge::refused;

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("banking:read")))
        .route("/", post(create).route_layer(need("banking:create")))
        .route("/{id}", get(detail).route_layer(need("banking:read")))
        .route("/{id}", put(update).route_layer(need("banking:update")))
        .route("/{id}", patch(update).route_layer(need("banking:update")))
        .route("/{id}", delete(remove).route_layer(need("banking:delete")))
        .route(
            "/{id}/reveal-account-number",
            post(reveal)
                .route_layer(need("tax_ids:reveal"))
                .route_layer(need("banking:read")),
        )
        // A record of an entity the request may not touch answers 404
        // (per-entity access; books-api `guardEntityRecords`).
        .route_layer(
            EntityRecordGuard::table(EntityTable::new("bank_accounts"), "Bank account").layer(),
        )
        .with_state(state)
}

/// What the create and update schemas read.
#[derive(Debug, Default)]
struct Body {
    /// The parsed fields in the schema's order, minus `accountNumber`,
    /// `createLedgerAccount` (and, on update, `importSettings`).
    fields: Map<String, Value>,
    account_number: Field<String>,
    create_ledger_account: Option<bool>,
    /// Create only: an existing core bank account to bring into WeldBooks.
    bank_account_id: Option<String>,
    import_settings: Option<Value>,
}

/// `baseFields` (+ `routingNumber`, `accountNumber`, `createLedgerAccount`,
/// `bankAccountId` on create): `createBankAccountSchema`, or `updateBankAccountSchema`
/// (`.partial()`, the numbers nullable) when `partial`.
#[allow(clippy::too_many_lines)] // one field after another, as the schema lists them
fn read_body(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
    deferred: &mut csv_format::Deferred,
) -> Body {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Body::default();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.fields.insert(key.to_owned(), value);
        }
    };
    let text_value = |field: Field<String>| match field {
        Field::Set(text) => Some(Value::String(text)),
        Field::Null => Some(Value::Null),
        Field::Absent => None,
    };
    put(
        "name",
        text_value(issues.text(body, "name", required, Some(1), Some(255))),
    );
    for (key, max) in [
        ("iban", 34),
        ("bic", 11),
        ("bankName", 255),
        ("accountHolderName", 255),
    ] {
        put(
            key,
            text_value(issues.text(body, key, Presence::Optional, None, Some(max))),
        );
    }
    let currency = issues.text(body, "currency", Presence::Optional, None, None);
    if let Field::Set(currency) = &currency {
        issues.string_length("currency", 3, currency.encode_utf16().count());
    }
    if let (Field::Set(value), Some(Value::String(raw))) = (&currency, body.get("currency"))
        && raw.encode_utf16().count() == 3
    {
        put("currency", Some(Value::String(value.clone())));
    }
    put(
        "ledgerAccountId",
        text_value(issues.text(body, "ledgerAccountId", Presence::Optional, None, Some(30))),
    );
    for key in ["isDefault", "autoReconcile"] {
        put(
            key,
            issues
                .boolean(body, key, Presence::Optional)
                .into_option()
                .map(Value::Bool),
        );
    }
    put(
        "accountType",
        issues
            .choice(body, "accountType", Presence::Optional, &BANK_ACCOUNT_TYPES)
            .into_option()
            .map(Value::String),
    );
    put(
        "nextCheckNumber",
        issues
            .number(
                body,
                "nextCheckNumber",
                Presence::Optional,
                Number {
                    coerce: false,
                    int: true,
                    min: Some(1.0),
                    max: Some(999_999_999.0),
                },
            )
            .into_option()
            .and_then(|_| body.get("nextCheckNumber").cloned()),
    );
    // `z.object({ csv: csvFormatSchema.optional() }).passthrough().optional()`
    let settings = issues.nested(
        body,
        "importSettings",
        Presence::Optional,
        |issues, settings| {
            let csv = csv_format::read(issues, settings, "csv", Presence::Optional, deferred);
            let mut out = settings.clone();
            match csv {
                Field::Set(csv) => {
                    out.insert("csv".to_owned(), csv);
                }
                _ => {
                    out.remove("csv");
                }
            }
            Value::Object(out)
        },
    );
    let numbers = if partial {
        Presence::Nullish
    } else {
        Presence::Optional
    };
    let routing = issues.pattern(
        body,
        "routingNumber",
        numbers,
        None,
        None,
        |v| v.len() == 9 && v.bytes().all(|b| b.is_ascii_digit()),
        "A routing number has nine digits",
    );
    if partial {
        if let Some(settings) = settings.as_set() {
            out.import_settings = Some(settings.clone());
        }
    } else {
        put("importSettings", settings.into_option());
    }
    match routing {
        Field::Set(routing) => put("routingNumber", Some(Value::String(routing))),
        Field::Null => put("routingNumber", Some(Value::Null)),
        Field::Absent => {}
    }
    out.account_number = issues.text(body, "accountNumber", numbers, Some(4), Some(40));
    if !partial {
        out.create_ledger_account = issues
            .boolean(body, "createLedgerAccount", Presence::Optional)
            .into_option();
        out.bank_account_id = issues
            .text(body, "bankAccountId", Presence::Optional, Some(1), Some(30))
            .into_option();
    }
    out
}

/// The body read, its refinements settled last.
fn read(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Body {
    let mut deferred = csv_format::Deferred::default();
    let out = read_body(issues, body, partial, &mut deferred);
    deferred.settle(issues);
    out
}

/// `badNumbers(data)`: the 400 message for a routing or account number, or
/// an IBAN, that doesn't check out.
fn bad_numbers(data: &Body) -> Option<String> {
    let fields = Value::Object(data.fields.clone());
    if let Some(routing) = text(&fields, "routingNumber")
        && !routing.is_empty()
        && !is_valid_aba_routing(routing)
    {
        return Some(
            "That routing number does not pass the ABA check. Check the nine digits.".to_owned(),
        );
    }
    if let Field::Set(number) = &data.account_number
        && !number.is_empty()
        && normalize_account_number(number).is_none()
    {
        return Some("An account number has 4 to 34 letters or digits.".to_owned());
    }
    // The same check a contact's IBAN gets: its shape, its length for the
    // country and the check digits.
    text(&fields, "iban").and_then(invalid_iban_message)
}

/// `loadLedgerAccount(db, entityId, ledgerAccountId, accountType)`.
async fn load_ledger_account(
    caller: &Caller,
    entity_id: &str,
    ledger_account_id: &str,
    account_type: Option<&str>,
) -> Result<Value, Refusal> {
    let ledger = accounts::Entity::find()
        .filter(accounts::Column::Id.eq(ledger_account_id))
        .filter(accounts::Column::EntityId.eq(entity_id))
        .filter(accounts::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await
        .map_err(refused)?;
    let Some(ledger) = ledger.map(|row| serde_json::to_value(row).unwrap_or_default()) else {
        return Err(Refusal::bad_request(
            "Ledger account not found for this accounting entity",
        ));
    };
    assert_ledger_account_fits(&ledger, account_type).map_err(bank_account_refusal)?;
    Ok(ledger)
}

/// `settingsValues(account)`: the WeldBooks columns of a bank account, for
/// `accounting_bank_account_settings` (release 1 writes them there next to
/// the old columns on `bank_accounts`), from the account as Drizzle has it.
struct BooksSettings {
    bank_account_id: Option<String>,
    entity_id: Option<String>,
    ledger_account_id: Option<String>,
    current_balance: String,
    auto_reconcile: bool,
    next_check_number: Option<i64>,
    import_settings: Option<Value>,
}

impl BooksSettings {
    fn of(account: &Value) -> Self {
        let owned = |key: &str| text(account, key).map(str::to_owned);
        Self {
            bank_account_id: owned("id"),
            entity_id: owned("entityId"),
            ledger_account_id: owned("ledgerAccountId"),
            // `account.currentBalance ?? '0'`
            current_balance: match account.get("currentBalance") {
                Some(Value::String(balance)) => balance.clone(),
                Some(Value::Number(balance)) => balance.to_string(),
                _ => "0".to_owned(),
            },
            auto_reconcile: account
                .get("autoReconcile")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            next_check_number: account.get("nextCheckNumber").and_then(Value::as_i64),
            import_settings: account
                .get("importSettings")
                .filter(|settings| !settings.is_null())
                .cloned(),
        }
    }

    /// `insert … values(settingsValues(account))`, with `upsert` the
    /// `onConflictDoUpdate` of `upsertBankAccountSettings`. The balance is
    /// written from its text, as `$n::numeric` read it; a key the account
    /// lacks is left out (the column has no default, so the insert fails as
    /// the null did).
    async fn write(&self, db: &impl ConnectionTrait, upsert: bool) -> Result<(), DbErr> {
        use books_settings::Column;
        let current_balance = BigDecimal::from_str(&self.current_balance).map_err(|_| {
            DbErr::Custom(format!(
                "invalid input syntax for type numeric: \"{}\"",
                self.current_balance
            ))
        })?;
        // `$n::integer`
        let next_check_number = self
            .next_check_number
            .map(i32::try_from)
            .transpose()
            .map_err(|_| DbErr::Custom("integer out of range".to_owned()))?;
        let given = |value: &Option<String>| {
            value
                .clone()
                .map_or(ActiveValue::NotSet, ActiveValue::Set)
        };
        let insert = books_settings::Entity::insert(books_settings::ActiveModel {
            bank_account_id: given(&self.bank_account_id),
            entity_id: given(&self.entity_id),
            ledger_account_id: ActiveValue::Set(self.ledger_account_id.clone()),
            current_balance: ActiveValue::Set(Some(current_balance)),
            auto_reconcile: ActiveValue::Set(Some(self.auto_reconcile)),
            next_check_number: ActiveValue::Set(next_check_number),
            import_settings: ActiveValue::Set(self.import_settings.clone()),
            ..Default::default()
        });
        let insert = if upsert {
            insert.on_conflict(
                OnConflict::column(Column::BankAccountId)
                    .update_columns([
                        Column::EntityId,
                        Column::LedgerAccountId,
                        Column::CurrentBalance,
                        Column::AutoReconcile,
                        Column::NextCheckNumber,
                        Column::ImportSettings,
                    ])
                    .value(Column::UpdatedAt, Expr::value(utc_now()))
                    .to_owned(),
            )
        } else {
            insert
        };
        insert.exec_without_returning(db).await?;
        Ok(())
    }
}

/// Whether the core bank account `id` is in WeldBooks (it has its
/// `accounting_bank_account_settings` row).
async fn in_books(db: &impl ConnectionTrait, id: &str) -> Result<bool, DbErr> {
    let row = books_settings::Entity::find_by_id(id.to_owned())
        .select_only()
        .column(books_settings::Column::BankAccountId)
        .into_tuple::<String>()
        .one(db)
        .await?;
    Ok(row.is_some())
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Ok(ok(json!([])));
        };
        let q = caller.query();
        let account_type = q.present("accountType");
        let is_active = q.get("isActive").map(|value| value == "true");
        let rows = bank_accounts::Entity::find()
            .filter(bank_accounts::Column::DeletedAt.is_null())
            .filter(bank_accounts::Column::EntityId.eq(entity_id.as_str()))
            .apply_if(account_type, |q, kind| {
                q.filter(bank_accounts::Column::AccountType.eq(kind))
            })
            .apply_if(is_active, |q, active| {
                q.filter(bank_accounts::Column::IsActive.eq(active))
            })
            .order_by_asc(bank_accounts::Column::Name)
            .all(&orm(&caller.db))
            .await
            .map_err(refused)?;
        Ok(ok(Value::Array(
            rows.into_iter()
                .map(|row| public_bank_account(&serde_json::to_value(row).unwrap_or_default()))
                .collect(),
        )))
    }
    .await;
    reply(result, "Failed to fetch bank accounts")
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match BANK_ACCOUNTS.find_live(&caller.db, &id).await? {
            Some(row) => Ok(ok(public_bank_account(&row))),
            None => Err(Refusal::not_found("Bank account", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch bank account")
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| read(issues, body, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create bank account"),
    };
    reply(
        create_account(&caller, &state, data).await,
        "Failed to create bank account",
    )
}

#[allow(clippy::too_many_lines)] // mirrors the TypeScript route step by step
async fn create_account(caller: &Caller, state: &BooksState, data: Body) -> Reply {
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    if let Some(message) = bad_numbers(&data) {
        return Err(Refusal::bad_request(message));
    }
    if let Some(core) = data.bank_account_id.as_deref() {
        return bring_into_weldbooks(caller, state, &entity_id, &data, core).await;
    }
    let fields = Value::Object(data.fields.clone());
    let currency = match text(&fields, "currency") {
        Some(currency) => currency.to_owned(),
        None => resolve_entity_base_currency(&caller.db, &entity_id).await?,
    };
    let account_type = text(&fields, "accountType");

    // `data.ledgerAccountId ?? null`: an empty id is stored as it came.
    let mut ledger_account_id = text(&fields, "ledgerAccountId").map(str::to_owned);
    let chosen = ledger_account_id.clone().filter(|id| !id.is_empty());
    let mut new_ledger: Option<Map<String, Value>> = None;
    let mut ledger_info: Option<Value> = None;
    if let Some(id) = &chosen {
        load_ledger_account(caller, &entity_id, id, account_type).await?;
    } else if data.create_ledger_account != Some(false) {
        // No type (the NL form sends none) reads as checking.
        let base = resolve_entity_base_currency(&caller.db, &entity_id).await?;
        let name = text(&fields, "name").unwrap_or_default();
        match plan_default_bank_ledger_account(&caller.db, &entity_id, name, account_type, &base)
            .await?
        {
            BankLedgerPlan::Existing(account) => {
                ledger_account_id = text(&account, "id").map(str::to_owned);
                ledger_info = Some(json!({
                    "id": field(&account, "id"),
                    "code": field(&account, "code"),
                    "name": field(&account, "name"),
                    "created": false,
                }));
            }
            BankLedgerPlan::New(row) => {
                ledger_account_id = row.get("id").and_then(Value::as_str).map(str::to_owned);
                ledger_info = Some(json!({
                    "id": row.get("id"),
                    "code": row.get("code"),
                    "name": row.get("name"),
                    "created": true,
                }));
                new_ledger = Some(row);
            }
        }
    }

    let sealed = match data
        .account_number
        .as_set()
        .and_then(|n| normalize_account_number(n))
    {
        Some(number) => Some(
            seal_account_number(&caller.keyring(state), &number).map_err(bank_account_refusal)?,
        ),
        None => None,
    };

    // `{ id, entityId, ...fields, currency, ledgerAccountId, ...sealed,
    // isActive, currentBalance, createdAt, updatedAt }`
    let stamp = now();
    let id = generate_id("ba");
    let mut account = Map::new();
    account.insert("id".to_owned(), json!(id));
    account.insert("entityId".to_owned(), json!(entity_id));
    for (key, value) in &data.fields {
        account.insert(key.clone(), value.clone());
    }
    account.insert("currency".to_owned(), json!(currency));
    account.insert("ledgerAccountId".to_owned(), json!(ledger_account_id));
    if let Some(sealed) = &sealed {
        account.insert("accountNumberEncrypted".to_owned(), json!(sealed.encrypted));
        account.insert("accountNumberLast4".to_owned(), json!(sealed.last4));
    }
    account.insert("isActive".to_owned(), json!(true));
    account.insert("currentBalance".to_owned(), json!("0"));
    account.insert("createdAt".to_owned(), json!(stamp));
    account.insert("updatedAt".to_owned(), json!(stamp));

    let mut tx = caller.db.begin().await?;
    if let Some(row) = &new_ledger {
        insert_ledger_account(&mut *tx, row).await?;
    }
    BANK_ACCOUNTS
        .insert_raw(&mut *tx, BANK_ACCOUNTS.values(&account))
        .await?;
    // WeldBooks' side of the account (release 1 writes it next to the old columns).
    BooksSettings::of(&Value::Object(account.clone()))
        .write(&OrmConn::new(&mut tx), false)
        .await
        .map_err(refused)?;
    tx.commit().await?;

    if let Some(row) = &new_ledger {
        caller.publish(
            state,
            ACCOUNT_CREATED,
            row.get("id").and_then(Value::as_str).unwrap_or_default(),
            Value::Object(row.clone()),
        );
    }
    let payload = public_bank_account(&Value::Object(account));
    caller.publish(state, BANK_ACCOUNT_CREATED, &id, payload.clone());
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "bank_account",
            entity_id: &id,
            action: "created",
            changes: Some(changes(vec![
                ("accountType", Value::Null, json!(account_type)),
                (
                    "accountNumberLast4",
                    Value::Null,
                    json!(sealed.as_ref().map(|s| s.last4.clone())),
                ),
                ("ledgerAccountId", Value::Null, json!(ledger_account_id)),
            ])),
        },
    )
    .await;
    let mut out = payload.as_object().cloned().unwrap_or_default();
    if let Some(info) = ledger_info {
        out.insert("ledgerAccount".to_owned(), info);
    }
    Ok(created(Value::Object(out)))
}

/// `bringIntoWeldbooks(c, db, entityId, data)`: POST with `bankAccountId`
/// makes an existing core bank account of the entity a WeldBooks bank
/// account. It takes the ledger account given, else (for an account with a
/// type) plans one as a new account would; only the WeldBooks columns change
/// on the core row, and its settings row is added.
#[allow(clippy::too_many_lines)] // mirrors the TypeScript route step by step
async fn bring_into_weldbooks(
    caller: &Caller,
    state: &BooksState,
    entity_id: &str,
    data: &Body,
    bank_account_id: &str,
) -> Reply {
    let db = orm(&caller.db);
    let core = bank_accounts::Entity::find()
        .filter(bank_accounts::Column::Id.eq(bank_account_id))
        .filter(bank_accounts::Column::EntityId.eq(entity_id))
        .filter(bank_accounts::Column::DeletedAt.is_null())
        .one(&db)
        .await
        .map_err(refused)?;
    let Some(core) = core.map(|row| serde_json::to_value(row).unwrap_or_default()) else {
        return Err(Refusal::not_found("Bank account", bank_account_id));
    };
    if in_books(&db, bank_account_id).await.map_err(refused)? {
        return Err(Refusal::conflict(
            "This bank account is already in WeldBooks",
        ));
    }

    let fields = Value::Object(data.fields.clone());
    let given_type = text(&fields, "accountType").filter(|t| !t.is_empty());
    // `data.accountType ?? core.accountType`
    let account_type = given_type.or_else(|| text(&core, "accountType"));
    // `data.ledgerAccountId ?? null`: an empty id counts as none.
    let mut ledger_account_id = text(&fields, "ledgerAccountId")
        .filter(|id| !id.is_empty())
        .map(str::to_owned);
    let mut new_ledger: Option<Map<String, Value>> = None;
    let mut ledger_info: Option<Value> = None;
    if let Some(id) = &ledger_account_id {
        load_ledger_account(caller, entity_id, id, account_type).await?;
    } else if let Some(kind) = account_type.filter(|t| !t.is_empty())
        && data.create_ledger_account != Some(false)
    {
        let base = resolve_entity_base_currency(&caller.db, entity_id).await?;
        let name = text(&core, "name").unwrap_or_default();
        match plan_bank_ledger_account(&caller.db, entity_id, name, kind, &base).await? {
            BankLedgerPlan::Existing(account) => {
                ledger_account_id = text(&account, "id").map(str::to_owned);
                ledger_info = Some(json!({
                    "id": field(&account, "id"),
                    "code": field(&account, "code"),
                    "name": field(&account, "name"),
                    "created": false,
                }));
            }
            BankLedgerPlan::New(row) => {
                ledger_account_id = row.get("id").and_then(Value::as_str).map(str::to_owned);
                ledger_info = Some(json!({
                    "id": row.get("id"),
                    "code": row.get("code"),
                    "name": row.get("name"),
                    "created": true,
                }));
                new_ledger = Some(row);
            }
        }
    }
    let Some(ledger_account_id) = ledger_account_id.filter(|id| !id.is_empty()) else {
        return Err(Refusal::bad_request(
            "Choose a ledger account for the bank account",
        ));
    };

    // `{ ledgerAccountId, accountType?, autoReconcile?, nextCheckNumber?, importSettings? }`
    let mut patch = Map::new();
    patch.insert("ledgerAccountId".to_owned(), json!(ledger_account_id));
    if let Some(kind) = given_type {
        patch.insert("accountType".to_owned(), json!(kind));
    }
    for key in ["autoReconcile", "nextCheckNumber"] {
        if let Some(value) = data.fields.get(key) {
            patch.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(settings) = data
        .fields
        .get("importSettings")
        .filter(|settings| weldsuite_books_domain::js::truthy(Some(settings)))
    {
        patch.insert("importSettings".to_owned(), settings.clone());
    }
    let mut merged = core.as_object().cloned().unwrap_or_default();
    for (key, value) in &patch {
        merged.insert(key.clone(), value.clone());
    }
    let merged = Value::Object(merged);

    let mut values = BANK_ACCOUNTS.values(&patch);
    BANK_ACCOUNTS.set(&mut values, "updatedAt", json!(now()));
    let mut tx = caller.db.begin().await?;
    if let Some(row) = &new_ledger {
        insert_ledger_account(&mut *tx, row).await?;
    }
    BANK_ACCOUNTS
        .patch_raw(&mut *tx, bank_account_id, values, false)
        .await?;
    BooksSettings::of(&merged)
        .write(&OrmConn::new(&mut tx), false)
        .await
        .map_err(refused)?;
    tx.commit().await?;

    if let Some(row) = &new_ledger {
        caller.publish(
            state,
            ACCOUNT_CREATED,
            row.get("id").and_then(Value::as_str).unwrap_or_default(),
            Value::Object(row.clone()),
        );
    }
    let payload = public_bank_account(&merged);
    caller.publish(
        state,
        BANK_ACCOUNT_UPDATED,
        bank_account_id,
        payload.clone(),
    );
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(entity_id),
            entity_type: "bank_account",
            entity_id: bank_account_id,
            action: "updated",
            changes: Some(changes(vec![(
                "ledgerAccountId",
                field(&core, "ledgerAccountId"),
                json!(ledger_account_id),
            )])),
        },
    )
    .await;
    let mut out = payload.as_object().cloned().unwrap_or_default();
    if let Some(info) = ledger_info {
        out.insert("ledgerAccount".to_owned(), info);
    }
    Ok(created(Value::Object(out)))
}

// ── PUT|PATCH /:id ──────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| read(issues, body, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update bank account"),
    };
    reply(
        update_account(&caller, &state, &id, data).await,
        "Failed to update bank account",
    )
}

async fn update_account(caller: &Caller, state: &BooksState, id: &str, data: Body) -> Reply {
    let Some(account) = BANK_ACCOUNTS.find_live(&caller.db, id).await? else {
        return Err(Refusal::not_found("Bank account", id));
    };
    if let Some(message) = bad_numbers(&data) {
        return Err(Refusal::bad_request(message));
    }
    let fields = Value::Object(data.fields.clone());
    let mut patch = data.fields.clone();

    let account_type = text(&fields, "accountType")
        .filter(|t| !t.is_empty())
        .or_else(|| text(&account, "accountType"));
    let given_ledger = text(&fields, "ledgerAccountId").filter(|t| !t.is_empty());
    let ledger_account_id = text(&fields, "ledgerAccountId")
        .or_else(|| text(&account, "ledgerAccountId"))
        .filter(|t| !t.is_empty());
    let given_type = text(&fields, "accountType").filter(|t| !t.is_empty());
    if let Some(ledger) = ledger_account_id
        && (given_ledger.is_some() || given_type.is_some())
    {
        let entity = text(&account, "entityId").unwrap_or_default();
        load_ledger_account(caller, entity, ledger, account_type).await?;
    }

    match &data.account_number {
        Field::Null => {
            patch.insert("accountNumberEncrypted".to_owned(), Value::Null);
            patch.insert("accountNumberLast4".to_owned(), Value::Null);
        }
        Field::Set(number) if !number.is_empty() => {
            let normalized = normalize_account_number(number).unwrap_or_default();
            let sealed = seal_account_number(&caller.keyring(state), &normalized)
                .map_err(bank_account_refusal)?;
            patch.insert("accountNumberEncrypted".to_owned(), json!(sealed.encrypted));
            patch.insert("accountNumberLast4".to_owned(), json!(sealed.last4));
        }
        _ => {}
    }
    if let Some(Value::Object(settings)) = &data.import_settings {
        let mut merged = account
            .get("importSettings")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for (key, value) in settings {
            merged.insert(key.clone(), value.clone());
        }
        patch.insert("importSettings".to_owned(), Value::Object(merged));
    }

    let mut values = BANK_ACCOUNTS.values(&patch);
    BANK_ACCOUNTS.set(&mut values, "updatedAt", json!(now()));
    BANK_ACCOUNTS
        .patch_raw(&caller.db, id, values, false)
        .await?;

    let mut updated = account.as_object().cloned().unwrap_or_default();
    for (key, value) in &patch {
        updated.insert(key.clone(), value.clone());
    }
    let updated = Value::Object(updated);
    // `upsertBankAccountSettings(db, { ...account, ...patch })`
    BooksSettings::of(&updated)
        .write(&orm(&caller.db), true)
        .await
        .map_err(refused)?;
    caller.publish(
        state,
        BANK_ACCOUNT_UPDATED,
        id,
        public_bank_account(&updated),
    );
    if !data.account_number.is_absent() {
        write_accounting_audit(
            caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: text(&account, "entityId"),
                entity_type: "bank_account",
                entity_id: id,
                action: "updated",
                changes: Some(changes(vec![(
                    "accountNumberLast4",
                    field(&account, "accountNumberLast4"),
                    field(&updated, "accountNumberLast4"),
                )])),
            },
        )
        .await;
    }
    Ok(ok(public_bank_account(&updated)))
}

// ── POST /:id/reveal-account-number ─────────────────────────────────────────

async fn reveal(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let result = async {
        let entity_id = resolve_entity_id(&caller).await?;
        let account = BANK_ACCOUNTS.find_live(&caller.db, &id).await?;
        let Some(account) = account.filter(|account| {
            entity_id
                .as_deref()
                .is_none_or(|entity| text(account, "entityId") == Some(entity))
        }) else {
            return Err(Refusal::not_found("Bank account", &id));
        };
        // `await c.req.json().catch(() => ({}))`
        let parsed: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let reason = parsed.get("reason").and_then(Value::as_str);
        let revealed = reveal_account_number(
            &caller.db,
            &caller.keyring(&state),
            &account,
            &caller.user_id,
            reason,
        )
        .await
        .map_err(bank_account_refusal)?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: text(&account, "entityId"),
                entity_type: "bank_account",
                entity_id: &id,
                action: "acct_number_revealed",
                changes: None,
            },
        )
        .await;
        let mut response = ok(json!({
            "accountNumber": revealed.account_number,
            "routingNumber": revealed.routing_number,
            "accountNumberLast4": field(&account, "accountNumberLast4"),
        }))
        .into_response();
        response.headers_mut().insert(
            http::header::CACHE_CONTROL,
            http::HeaderValue::from_static("no-store"),
        );
        Ok(response)
    }
    .await;
    reply(result, "Failed to reveal the account number")
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

/// The account leaves WeldBooks, and the core account is soft-deleted unless
/// WeldHR pays salaries from it (then only WeldBooks' part goes). A core
/// account WeldBooks never had (an HR-only salary account) is a 404.
async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let Some(account) = BANK_ACCOUNTS.find_live(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Bank account", &id));
        };
        let db = orm(&caller.db);
        if !in_books(&db, &id).await.map_err(refused)? {
            return Err(Refusal::not_found("Bank account", &id));
        }
        let pays_salaries = hr_payroll_employers::Entity::find()
            .select_only()
            .column(hr_payroll_employers::Column::Id)
            .filter(hr_payroll_employers::Column::BankAccountId.eq(id.as_str()))
            .filter(hr_payroll_employers::Column::DeletedAt.is_null())
            .into_tuple::<String>()
            .one(&db)
            .await
            .map_err(refused)?
            .is_some();
        let stamp = utc_now();
        if !pays_salaries {
            bank_accounts::Entity::update_many()
                .col_expr(bank_accounts::Column::DeletedAt, Expr::value(stamp))
                .col_expr(bank_accounts::Column::UpdatedAt, Expr::value(stamp))
                .filter(bank_accounts::Column::Id.eq(id.as_str()))
                .exec(&db)
                .await
                .map_err(refused)?;
        }
        // The account leaves WeldBooks; an entity that printed it on invoices
        // falls back to bank_details.
        books_settings::Entity::delete_many()
            .filter(books_settings::Column::BankAccountId.eq(id.as_str()))
            .exec(&db)
            .await
            .map_err(refused)?;
        accounting_entity_settings::Entity::update_many()
            .col_expr(
                accounting_entity_settings::Column::InvoiceBankAccountId,
                Expr::value(Option::<String>::None),
            )
            .col_expr(
                accounting_entity_settings::Column::UpdatedAt,
                Expr::value(stamp),
            )
            .filter(accounting_entity_settings::Column::InvoiceBankAccountId.eq(id.as_str()))
            .exec(&db)
            .await
            .map_err(refused)?;
        // Kept for WeldHR, the core account only lost its WeldBooks part (as
        // bringing it in is an update).
        let event = if pays_salaries {
            BANK_ACCOUNT_UPDATED
        } else {
            BANK_ACCOUNT_DELETED
        };
        caller.publish(&state, event, &id, public_bank_account(&account));
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete bank account")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_books_settings_default_as_settings_values_does() {
        let fresh = BooksSettings::of(&json!({
            "id": "ba_1",
            "entityId": "ent_1",
            "ledgerAccountId": null,
            "currentBalance": "0",
        }));
        assert_eq!(fresh.bank_account_id.as_deref(), Some("ba_1"));
        assert_eq!(fresh.entity_id.as_deref(), Some("ent_1"));
        assert_eq!(fresh.ledger_account_id, None);
        assert_eq!(fresh.current_balance, "0");
        assert!(fresh.auto_reconcile);
        assert_eq!(fresh.next_check_number, None);
        assert_eq!(fresh.import_settings, None);

        let row = BooksSettings::of(&json!({
            "id": "ba_2",
            "entityId": "ent_1",
            "ledgerAccountId": "acc_1",
            "currentBalance": "12.50",
            "autoReconcile": false,
            "nextCheckNumber": 1001,
            "importSettings": { "csv": { "delimiter": ";" } },
        }));
        assert_eq!(row.ledger_account_id.as_deref(), Some("acc_1"));
        assert_eq!(row.current_balance, "12.50");
        assert!(!row.auto_reconcile);
        assert_eq!(row.next_check_number, Some(1001));
        assert_eq!(
            row.import_settings,
            Some(json!({ "csv": { "delimiter": ";" } }))
        );

        // No balance at all reads as '0'.
        assert_eq!(
            BooksSettings::of(&json!({ "id": "ba_3" })).current_balance,
            "0"
        );
    }
}
