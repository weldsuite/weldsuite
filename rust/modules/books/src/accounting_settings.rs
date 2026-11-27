//! `/api/accounting-settings` (`routes/accounting-settings/index.ts`): the
//! workspace's one settings row (made on first read), the live exchange
//! rates, the accounting inbox (registered in the master database), the
//! finance workflow templates, and the posting catch-up.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::catch_up::run_posting_catch_up;
use weldsuite_books_domain::currency::{
    get_exchange_rate, get_exchange_rates, rates_json, supported_currencies,
};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, now, ok, reply, validate,
};
use weldsuite_books_domain::tables::{SETTINGS as T, WORKFLOW_TEMPLATES};
use weldsuite_catalogs::entity_events::ACCOUNTING_SETTINGS_UPDATED;
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::master::mail_account_registry;
use weldsuite_schema::tenant::{settings, workflow_templates};

use crate::orm_bridge::to_json;

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(read).route_layer(need("accounts:read")))
        .route(
            "/",
            axum::routing::put(update)
                .patch(update)
                .route_layer(need("accounts:update")),
        )
        .route(
            "/exchange-rates",
            get(exchange_rates).route_layer(need("accounts:read")),
        )
        .route(
            "/exchange-rate/{from}/{to}",
            get(exchange_rate).route_layer(need("accounts:read")),
        )
        // Rust only (edition feature `books-bank-processing`): the entity's
        // default accounts for bank costs, payment discount and rounding.
        .route(
            "/differences",
            get(read_differences).route_layer(need("accounts:read")),
        )
        .route(
            "/differences",
            axum::routing::put(update_differences)
                .patch(update_differences)
                .route_layer(need("accounts:update")),
        )
        .route("/inbox", post(inbox).route_layer(need("accounts:update")))
        .route(
            "/seed-workflows",
            post(seed_workflows).route_layer(need("accounts:create")),
        )
        .route(
            "/posting-catch-up",
            post(posting_catch_up).route_layer(need("accounts:update")),
        )
        .with_state(state)
}

// ── POST /posting-catch-up ──────────────────────────────────────────────────

/// Book documents from before automatic posting; `dryRun` (the default)
/// only reports what would be booked and what would be skipped.
async fn posting_catch_up(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to bring the ledger up to date";
    // `z.object({ dryRun: z.boolean().default(true) })`
    let dry_run = match validate(&headers, &body, |issues, fields| {
        issues.boolean(fields, "dryRun", Presence::Optional)
    }) {
        Ok(Field::Set(dry_run)) => dry_run,
        Ok(_) => true,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let http = caller.http(&state);
        let user_id = Some(caller.user_id.clone()).filter(|id| !id.is_empty());
        let result = run_posting_catch_up(&caller.db, http.as_ref(), &entity_id, dry_run, user_id)
            .await
            .map_err(|error| Refusal::Internal(error.to_string()))?;
        if !dry_run {
            let mut changes = Map::new();
            for (key, count) in [
                ("invoices", result.invoices),
                ("creditNotesCorrected", result.credit_notes_corrected),
                ("bills", result.bills),
                ("payments", result.payments),
                ("bankTransactions", result.bank_transactions),
                ("taxLines", result.tax_lines),
                ("skipped", i64::try_from(result.skipped.len()).unwrap_or(0)),
            ] {
                changes.insert(key.to_owned(), change(Value::Null, json!(count)));
            }
            write_accounting_audit(
                &caller,
                &caller.db,
                AuditInput {
                    accounting_entity_id: Some(&entity_id),
                    entity_type: "accounting_settings",
                    entity_id: &entity_id,
                    action: "posting_catch_up",
                    changes: Some(changes),
                },
            )
            .await;
        }
        Ok(ok(result.to_json()))
    }
    .await;
    reply(result, FAILED)
}

async fn find(caller: &Caller) -> Result<Option<Map<String, Value>>, DbErr> {
    let row = settings::Entity::find()
        .filter(settings::Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(to_json)
        .transpose()?;
    Ok(row.and_then(|row| row.as_object().cloned()))
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn read(caller: Caller) -> Response {
    let result = async {
        if let Some(row) = find(&caller).await? {
            return Ok(ok(Value::Object(row)));
        }
        // Made on first read.
        let at = now();
        let settings = json!({ "id": generate_id("acs"), "createdAt": at, "updatedAt": at });
        let values = T.values(settings.as_object().unwrap_or(&Map::new()));
        T.insert_raw(&caller.db, values).await?;
        Ok(created(settings))
    }
    .await;
    reply(result, "Failed to fetch accounting settings")
}

// ── PUT|PATCH / ─────────────────────────────────────────────────────────────

fn keep<T: serde::Serialize>(out: &mut Map<String, Value>, key: &str, field: Field<T>) {
    match field {
        Field::Set(value) => {
            out.insert(key.to_owned(), json!(value));
        }
        Field::Null => {
            out.insert(key.to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
}

/// `updateAccountingSettingsSchema`: Zod's output, unknown keys stripped.
fn read_body(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    keep(
        &mut out,
        "defaultEntityId",
        issues.text(body, "defaultEntityId", Presence::Nullish, None, Some(30)),
    );
    keep(
        &mut out,
        "fiscalYearStart",
        issues.whole_number(
            body,
            "fiscalYearStart",
            Presence::Optional,
            Number {
                min: Some(1.0),
                max: Some(12.0),
                ..Number::default()
            },
        ),
    );
    keep(
        &mut out,
        "accountingMethod",
        issues.choice(
            body,
            "accountingMethod",
            Presence::Optional,
            &["accrual", "cash"],
        ),
    );
    keep(
        &mut out,
        "defaultPaymentTermsDays",
        issues.whole_number(
            body,
            "defaultPaymentTermsDays",
            Presence::Optional,
            Number {
                min: Some(0.0),
                ..Number::default()
            },
        ),
    );
    let email = issues.nested(
        body,
        "emailSettings",
        Presence::Optional,
        |issues, object| {
            let mut settings = Map::new();
            keep(
                &mut settings,
                "inboxAddress",
                issues.text(object, "inboxAddress", Presence::Optional, None, None),
            );
            keep(
                &mut settings,
                "autoScanEnabled",
                issues.boolean(object, "autoScanEnabled", Presence::Optional),
            );
            keep(
                &mut settings,
                "autoCreateDraftBills",
                issues.boolean(object, "autoCreateDraftBills", Presence::Optional),
            );
            settings
        },
    );
    keep(&mut out, "emailSettings", email);
    out
}

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_body) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update accounting settings"),
    };
    reply(
        update_settings(&caller, &state, data).await,
        "Failed to update accounting settings",
    )
}

async fn update_settings(caller: &Caller, state: &BooksState, data: Map<String, Value>) -> Reply {
    let db = &caller.db;
    let Some(existing) = find(caller).await? else {
        // No settings row yet: create one.
        let id = generate_id("acs");
        let at = now();
        let mut settings = Map::new();
        settings.insert("id".to_owned(), json!(id));
        for (key, value) in &data {
            settings.insert(key.clone(), value.clone());
        }
        settings.insert("createdAt".to_owned(), json!(at));
        settings.insert("updatedAt".to_owned(), json!(at));
        T.insert_raw(db, T.values(&settings)).await?;
        write_accounting_audit(
            caller,
            db,
            AuditInput {
                accounting_entity_id: data.get("defaultEntityId").and_then(Value::as_str),
                entity_type: "accounting_settings",
                entity_id: &id,
                action: "updated",
                changes: None,
            },
        )
        .await;
        caller.publish(
            state,
            ACCOUNTING_SETTINGS_UPDATED,
            &id,
            Value::Object(settings.clone()),
        );
        return Ok(created(Value::Object(settings)));
    };
    let id = existing["id"].as_str().unwrap_or_default().to_owned();
    let mut set = data.clone();
    set.insert("updatedAt".to_owned(), json!(now()));
    T.patch_raw(db, &id, T.values(&set), false).await?;
    let changes: Map<String, Value> = data
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                change(
                    existing.get(key).cloned().unwrap_or(Value::Null),
                    value.clone(),
                ),
            )
        })
        .collect();
    let entity = data
        .get("defaultEntityId")
        .and_then(Value::as_str)
        .or_else(|| existing.get("defaultEntityId").and_then(Value::as_str));
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: entity,
            entity_type: "accounting_settings",
            entity_id: &id,
            action: "updated",
            changes: Some(changes),
        },
    )
    .await;
    let mut merged = existing.clone();
    for (key, value) in data {
        merged.insert(key, value);
    }
    caller.publish(
        state,
        ACCOUNTING_SETTINGS_UPDATED,
        &id,
        Value::Object(merged.clone()),
    );
    Ok(ok(Value::Object(merged)))
}

// ── GET|PUT|PATCH /differences ──────────────────────────────────────────────

/// The entity's differences settings and the rounding account in use.
async fn differences_answer(caller: &Caller, entity_id: &str) -> Reply {
    let (differences, rounding) =
        weldsuite_books_domain::differences::load_with_rounding(&caller.db, entity_id).await?;
    let mut answer = differences.to_json();
    answer["effectiveRoundingAccountId"] = json!(rounding);
    Ok(ok(answer))
}

async fn read_differences(caller: Caller) -> Response {
    reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Err(Refusal::bad_request("No accounting entity resolved"));
            };
            differences_answer(&caller, &entity_id).await
        }
        .await,
        "Failed to fetch the differences settings",
    )
}

/// `{ bankCostsAccountId?, paymentDiscountAccountId?, roundingAccountId?,
/// roundingCap? }`: a key set to `null` goes back to the default.
fn read_differences_body(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for key in [
        "bankCostsAccountId",
        "paymentDiscountAccountId",
        "roundingAccountId",
    ] {
        keep(
            &mut out,
            key,
            issues.text(body, key, Presence::Nullish, Some(1), Some(30)),
        );
    }
    let cap = issues.number(
        body,
        "roundingCap",
        Presence::Nullish,
        Number {
            coerce: true,
            min: Some(0.0),
            ..Number::default()
        },
    );
    match cap {
        Field::Set(cap) => {
            out.insert(
                "roundingCap".to_owned(),
                json!(weldsuite_books_domain::js::to_fixed(cap, 2)),
            );
        }
        Field::Null => {
            out.insert("roundingCap".to_owned(), Value::Null);
        }
        Field::Absent => {}
    }
    out
}

async fn update_differences(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_differences_body) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update the differences settings"),
    };
    reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Err(Refusal::bad_request("No accounting entity resolved"));
            };
            // The accounts must be this entity's.
            let accounts =
                weldsuite_books_domain::posting::load_entity_accounts(&caller.db, &entity_id)
                    .await?;
            for key in [
                "bankCostsAccountId",
                "paymentDiscountAccountId",
                "roundingAccountId",
            ] {
                if let Some(account) = data.get(key).and_then(Value::as_str)
                    && accounts.by_id(Some(account)).is_none()
                {
                    return Err(Refusal::bad_request(format!(
                        "Account {account} does not belong to this accounting entity"
                    )));
                }
            }
            let entity =
                weldsuite_books_domain::document_posting::load_entity(&caller.db, &entity_id)
                    .await
                    .map_err(|error| Refusal::Internal(error.to_string()))?;
            let before = weldsuite_books_domain::differences::Differences::of(
                entity.get("jurisdictionSettings"),
            );
            let next = weldsuite_books_domain::differences::merged(
                entity.get("jurisdictionSettings"),
                &data,
            );
            weldsuite_books_domain::differences::store(&caller.db, &entity_id, &next).await?;
            let after = weldsuite_books_domain::differences::Differences::of(Some(&next));
            let changes: Map<String, Value> = [
                (
                    "bankCostsAccountId",
                    json!(before.bank_costs_account_id),
                    json!(after.bank_costs_account_id),
                ),
                (
                    "paymentDiscountAccountId",
                    json!(before.payment_discount_account_id),
                    json!(after.payment_discount_account_id),
                ),
                (
                    "roundingAccountId",
                    json!(before.rounding_account_id),
                    json!(after.rounding_account_id),
                ),
                (
                    "roundingCap",
                    json!(before.rounding_cap),
                    json!(after.rounding_cap),
                ),
            ]
            .into_iter()
            .filter(|(_, old, new)| old != new)
            .map(|(key, old, new)| (key.to_owned(), change(old, new)))
            .collect();
            write_accounting_audit(
                &caller,
                &caller.db,
                AuditInput {
                    accounting_entity_id: Some(&entity_id),
                    entity_type: "accounting_settings",
                    entity_id: &entity_id,
                    action: "updated",
                    changes: Some(changes),
                },
            )
            .await;
            let mut event = after.to_json();
            event["entityId"] = json!(entity_id);
            caller.publish(&state, ACCOUNTING_SETTINGS_UPDATED, &entity_id, event);
            differences_answer(&caller, &entity_id).await
        }
        .await,
        "Failed to update the differences settings",
    )
}

// ── exchange rates ──────────────────────────────────────────────────────────

async fn exchange_rates(caller: Caller, State(state): State<BooksState>) -> Response {
    let locale = caller.header("accept-language").unwrap_or("en").to_owned();
    let http = caller.http(&state);
    let rates = get_exchange_rates(&state.rates, &caller.rate_scope(), http.as_ref()).await;
    ok(json!({
        "rates": rates_json(&rates),
        "currencies": supported_currencies(&locale),
        "baseCurrency": "EUR",
        "fetchedAt": now(),
    }))
}

async fn exchange_rate(
    caller: Caller,
    State(state): State<BooksState>,
    Path((from, to)): Path<(String, String)>,
) -> Response {
    let from = from.to_uppercase();
    let to = to.to_uppercase();
    let result = async {
        let http = caller.http(&state);
        match get_exchange_rate(
            &state.rates,
            &caller.rate_scope(),
            http.as_ref(),
            &from,
            &to,
            None,
        )
        .await?
        {
            Ok(rate) => Ok(ok(json!({
                "from": from,
                "to": to,
                "rate": weldsuite_books_domain::js::number_value(rate),
                "fetchedAt": now(),
            }))),
            Err(unavailable) => Err(Refusal::Internal(unavailable.0)),
        }
    }
    .await;
    reply(result, "Failed to fetch exchange rate")
}

// ── POST /inbox ─────────────────────────────────────────────────────────────

async fn inbox(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let email = match validate(&headers, &body, |issues, fields| {
        issues
            .text_with(
                fields,
                "email",
                Presence::Required,
                Text {
                    format: Some(Format::Email),
                    ..Text::default()
                },
            )
            .into_option()
    }) {
        Ok(email) => email.unwrap_or_default().to_lowercase(),
        Err(refusal) => return refusal.respond("Failed to register accounting inbox"),
    };
    let result = async {
        let Some(master) = caller.master(&state) else {
            return Err(Refusal::Internal("no master database".to_owned()));
        };
        let workspace_id = caller.workspace_id.clone();
        let account_id = format!("acct_inbox_{workspace_id}");
        let at = weldsuite_db::utc_now();
        // `on conflict (email) do update`: the address moves to this workspace.
        mail_account_registry::Entity::insert(mail_account_registry::ActiveModel {
            id: Set(generate_id("mar")),
            email: Set(email.clone()),
            workspace_id: Set(Some(workspace_id.clone())),
            account_id: Set(account_id.clone()),
            is_active: Set(true),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(mail_account_registry::Column::Email)
                .update_columns([
                    mail_account_registry::Column::WorkspaceId,
                    mail_account_registry::Column::AccountId,
                    mail_account_registry::Column::IsActive,
                    mail_account_registry::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec_without_returning(&orm(&master))
        .await?;
        if let Some(current) = find(&caller).await? {
            let id = current["id"].as_str().unwrap_or_default().to_owned();
            let old = current
                .get("emailSettings")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!({}));
            let mut next = old.as_object().cloned().unwrap_or_default();
            next.insert("inboxAddress".to_owned(), json!(email));
            next.insert("autoScanEnabled".to_owned(), json!(true));
            settings::Entity::update_many()
                .col_expr(
                    settings::Column::EmailSettings,
                    Expr::value(Value::Object(next.clone())),
                )
                .col_expr(settings::Column::UpdatedAt, Expr::value(at))
                .filter(settings::Column::Id.eq(id.as_str()))
                .exec(&orm(&caller.db))
                .await?;
            let mut changes = Map::new();
            changes.insert("emailSettings".to_owned(), change(old, Value::Object(next)));
            write_accounting_audit(
                &caller,
                &caller.db,
                AuditInput {
                    accounting_entity_id: current.get("defaultEntityId").and_then(Value::as_str),
                    entity_type: "accounting_settings",
                    entity_id: &id,
                    action: "updated",
                    changes: Some(changes),
                },
            )
            .await;
        }
        Ok(ok(json!({ "email": email, "accountId": account_id })))
    }
    .await;
    reply(result, "Failed to register accounting inbox")
}

// ── GET|POST /api/accounting-entities/:id/inbox ─────────────────────────────

/// Rust only (edition feature `books-receipts`): one inbox address per legal
/// entity. The address is registered like the workspace's (the registry maps
/// it to the workspace, and the inbound fan-out opens its tenant database),
/// and the entity it books into is kept in the workspace settings,
/// `emailSettings.entityInboxes` (`{ <entityId>: <address> }`), which the
/// fan-out reads: nothing in the master schema changes, and the account id
/// (`acct_inbox_<workspace>`, 30 characters at most) cannot hold an entity id
/// as well. The workspace's own address (`POST /inbox`) keeps working and
/// books into the default entity.
pub(crate) const ENTITY_INBOXES: &str = "entityInboxes";

/// The address an entity's documents arrive on: its own, else (for the
/// default entity) the workspace's.
async fn entity_inbox_view(caller: &Caller, entity_id: &str) -> Result<Value, DbErr> {
    let current = find(caller).await?;
    let email_settings = current
        .as_ref()
        .and_then(|row| row.get("emailSettings"))
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let own = email_settings
        .get(ENTITY_INBOXES)
        .and_then(|all| all.get(entity_id))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let default = weldsuite_legal_entities::default_entity_id_for(
        &caller.db,
        Some(weldsuite_legal_entities::LegalEntityApp::Weldbooks),
    )
    .await?;
    let is_default = default.as_deref() == Some(entity_id);
    let workspace = email_settings
        .get("inboxAddress")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let (email, shared) = match (own, is_default.then_some(workspace).flatten()) {
        (Some(own), _) => (Some(own), false),
        (None, Some(workspace)) => (Some(workspace), true),
        (None, None) => (None, false),
    };
    Ok(json!({
        "entityId": entity_id,
        "email": email,
        // The address is the workspace's, which books into the default entity.
        "workspaceAddress": shared,
        "autoScanEnabled": email_settings.get("autoScanEnabled").and_then(Value::as_bool).unwrap_or(false),
    }))
}

pub(crate) async fn entity_inbox(caller: Caller, Path(entity_id): Path<String>) -> Response {
    let result = async {
        if crate::accounting_entities::find_active(&caller, &entity_id)
            .await?
            .is_none()
        {
            return Err(Refusal::not_found("Entity", &entity_id));
        }
        Ok(ok(entity_inbox_view(&caller, &entity_id).await?))
    }
    .await;
    reply(result, "Failed to fetch the accounting inbox")
}

#[allow(clippy::too_many_lines)] // register, keep, retire the old address, audit
pub(crate) async fn register_entity_inbox(
    caller: Caller,
    State(state): State<BooksState>,
    Path(entity_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let email = match validate(&headers, &body, |issues, fields| {
        issues
            .text_with(
                fields,
                "email",
                Presence::Required,
                Text {
                    format: Some(Format::Email),
                    ..Text::default()
                },
            )
            .into_option()
    }) {
        Ok(email) => email.unwrap_or_default().to_lowercase(),
        Err(refusal) => return refusal.respond("Failed to register the accounting inbox"),
    };
    let result = async {
        if crate::accounting_entities::find_active(&caller, &entity_id)
            .await?
            .is_none()
        {
            return Err(Refusal::not_found("Entity", &entity_id));
        }
        let Some(master) = caller.master(&state) else {
            return Err(Refusal::Internal("no master database".to_owned()));
        };
        let workspace_id = caller.workspace_id.clone();
        // The settings row (made when there is none): where the entity is kept.
        let current = if let Some(row) = find(&caller).await? {
            row
        } else {
            let at = now();
            let settings = json!({ "id": generate_id("acs"), "createdAt": at, "updatedAt": at });
            T.insert_raw(
                &caller.db,
                T.values(settings.as_object().unwrap_or(&Map::new())),
            )
            .await?;
            settings.as_object().cloned().unwrap_or_default()
        };
        let id = current["id"].as_str().unwrap_or_default().to_owned();
        let old = current
            .get("emailSettings")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut next = old.as_object().cloned().unwrap_or_default();
        let mut inboxes = next
            .get(ENTITY_INBOXES)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        // An address books into one entity.
        if let Some((other, _)) = inboxes.iter().find(|(other, address)| {
            other.as_str() != entity_id && address.as_str() == Some(&email)
        }) {
            return Err(Refusal::conflict(format!(
                "That address is already the inbox of another legal entity ({other})."
            )));
        }
        let previous = inboxes
            .insert(entity_id.clone(), json!(email))
            .and_then(|v| v.as_str().map(str::to_owned));
        next.insert(ENTITY_INBOXES.to_owned(), Value::Object(inboxes));
        next.insert("autoScanEnabled".to_owned(), json!(true));
        let account_id = format!("acct_inbox_{workspace_id}");
        let at = weldsuite_db::utc_now();
        mail_account_registry::Entity::insert(mail_account_registry::ActiveModel {
            id: Set(generate_id("mar")),
            email: Set(email.clone()),
            workspace_id: Set(Some(workspace_id.clone())),
            account_id: Set(account_id.clone()),
            is_active: Set(true),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(mail_account_registry::Column::Email)
                .update_columns([
                    mail_account_registry::Column::WorkspaceId,
                    mail_account_registry::Column::AccountId,
                    mail_account_registry::Column::IsActive,
                    mail_account_registry::Column::UpdatedAt,
                ])
                .to_owned(),
        )
        .exec_without_returning(&orm(&master))
        .await?;
        // The address this entity had stops receiving.
        if let Some(previous) = previous.filter(|p| *p != email) {
            mail_account_registry::Entity::update_many()
                .col_expr(mail_account_registry::Column::IsActive, Expr::value(false))
                .col_expr(mail_account_registry::Column::UpdatedAt, Expr::value(at))
                .filter(mail_account_registry::Column::Email.eq(previous))
                .filter(mail_account_registry::Column::WorkspaceId.eq(workspace_id.as_str()))
                .filter(mail_account_registry::Column::AccountId.eq(account_id.as_str()))
                .exec(&orm(&master))
                .await?;
        }
        settings::Entity::update_many()
            .col_expr(
                settings::Column::EmailSettings,
                Expr::value(Value::Object(next.clone())),
            )
            .col_expr(settings::Column::UpdatedAt, Expr::value(at))
            .filter(settings::Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
            .await?;
        let mut changes = Map::new();
        changes.insert("emailSettings".to_owned(), change(old, Value::Object(next)));
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "accounting_settings",
                entity_id: &id,
                action: "updated",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(
            &state,
            ACCOUNTING_SETTINGS_UPDATED,
            &id,
            json!({ "id": id, "entityId": entity_id, "inboxAddress": email }),
        );
        Ok(ok(entity_inbox_view(&caller, &entity_id).await?))
    }
    .await;
    reply(result, "Failed to register the accounting inbox")
}

// ── POST /seed-workflows ────────────────────────────────────────────────────

/// The finance workflow templates (ported verbatim from the worker, Dutch
/// strings included), with `<id>` and `<now>` filled in per seed.
const TEMPLATES: &str = include_str!("../data/finance-workflow-templates.json");

async fn seed_workflows(caller: Caller) -> Response {
    let result = async {
        let existing: Option<String> = workflow_templates::Entity::find()
            .select_only()
            .column(workflow_templates::Column::Id)
            .filter(workflow_templates::Column::Category.eq("finance"))
            .into_tuple()
            .one(&orm(&caller.db))
            .await?;
        if existing.is_some() {
            return Err(Refusal::conflict(
                "Accounting workflow templates already seeded.",
            ));
        }
        let at = now();
        let templates: Vec<Value> = serde_json::from_str(TEMPLATES).unwrap_or_default();
        let rows: Vec<Map<String, Value>> = templates
            .into_iter()
            .filter_map(|template| {
                let mut row = template.as_object()?.clone();
                row.insert("id".to_owned(), json!(generate_id("wft")));
                for key in ["publishedAt", "createdAt", "updatedAt"] {
                    row.insert(key.to_owned(), json!(at));
                }
                Some(WORKFLOW_TEMPLATES.values(&row))
            })
            .collect();
        let count = rows.len();
        weldsuite_db::atomically_with(&caller.db, move |conn| {
            Box::pin(async move {
                for row in rows {
                    WORKFLOW_TEMPLATES.insert_raw(&mut *conn, row).await?;
                }
                Ok::<_, Refusal>(())
            })
        })
        .await?;
        Ok(created(json!({ "templatesCreated": count })))
    }
    .await;
    reply(result, "Failed to seed accounting workflow templates")
}

/// The per-entity inbox on the real schema (`WELDSUITE_TEST_TENANT_URL` and
/// `WELDSUITE_TEST_MASTER_URL`; the test returns early without them).
#[cfg(test)]
#[allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    reason = "test fixtures are written in SQL; one scenario read top to bottom"
)]
mod tests {
    use std::sync::Arc;

    use axum::http::HeaderValue;
    use weldsuite_events::{EntityEventPublisher, TaskTracker};
    use weldsuite_ports::{DynEventBus, RecordingEventBus};

    use super::*;

    async fn answer(response: Response) -> (u16, Value) {
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn json_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        headers
    }

    async fn entity(db: &sqlx::PgPool, default: bool) -> String {
        let id = generate_id("ent");
        sqlx::query(
            "insert into entities (id, name, jurisdiction_code, base_currency, is_active, is_default) \
             values ($1, 'Inbox test', 'NL', 'EUR', true, $2)",
        )
        .bind(&id)
        .bind(default)
        .execute(db)
        .await
        .unwrap();
        sqlx::query("insert into accounting_entity_settings (entity_id) values ($1)")
            .bind(&id)
            .execute(db)
            .await
            .unwrap();
        id
    }

    #[tokio::test]
    async fn an_entity_registers_its_own_inbox_address() {
        let (Ok(tenant_url), Ok(master_url)) = (
            std::env::var("WELDSUITE_TEST_TENANT_URL"),
            std::env::var("WELDSUITE_TEST_MASTER_URL"),
        ) else {
            eprintln!(
                "WELDSUITE_TEST_TENANT_URL / WELDSUITE_TEST_MASTER_URL are not set; skipping"
            );
            return;
        };
        let db = weldsuite_db::master_pool(&tenant_url, 2).unwrap();
        let master = weldsuite_db::master_pool(&master_url, 2).unwrap();
        sqlx::query("delete from mail_account_registry where workspace_id = 'ws_p3_inbox'")
            .execute(&master)
            .await
            .unwrap();
        sqlx::query("delete from workspaces where id = 'ws_p3_inbox'")
            .execute(&master)
            .await
            .unwrap();
        sqlx::query("insert into workspaces (id, name, slug, clerk_org_id) values ('ws_p3_inbox', 'Inbox', 'p3-inbox', 'org_p3_inbox')")
            .execute(&master)
            .await
            .unwrap();
        sqlx::query("delete from settings")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("update entities set is_default = false where is_default")
            .execute(&db)
            .await
            .unwrap();
        let (a, b) = (entity(&db, true).await, entity(&db, false).await);
        let bus = Arc::new(RecordingEventBus::new());
        let mut state = BooksState::new(EntityEventPublisher::new(
            Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
            TaskTracker::new(),
        ));
        state.master = Some(master.clone());
        let caller = |entity: &str| {
            Caller::in_process(
                db.clone(),
                "ws_p3_inbox",
                "org_p3_inbox",
                "user_p3",
                entity,
                None,
            )
        };
        let register = |entity: &str, email: &str| {
            let (caller, state) = (caller(entity), state.clone());
            let (entity, body) = (
                entity.to_owned(),
                axum::body::Bytes::from(json!({ "email": email }).to_string()),
            );
            async move {
                answer(
                    register_entity_inbox(caller, State(state), Path(entity), json_headers(), body)
                        .await,
                )
                .await
            }
        };

        // Nothing registered yet.
        let (status, out) = answer(entity_inbox(caller(&a), Path(a.clone())).await).await;
        assert_eq!(status, 200, "{out}");
        assert!(out["data"]["email"].is_null());

        let (status, out) = register(&a, "Books-A@Inbox-P3.test").await;
        assert_eq!(status, 200, "{out}");
        assert_eq!(out["data"]["email"], json!("books-a@inbox-p3.test"));
        assert_eq!(out["data"]["workspaceAddress"], json!(false));
        assert_eq!(out["data"]["autoScanEnabled"], json!(true));
        let (_, out) = answer(entity_inbox(caller(&a), Path(a.clone())).await).await;
        assert_eq!(out["data"]["email"], json!("books-a@inbox-p3.test"));
        // Kept on the settings, and registered to the workspace in the master.
        let kept: Value = sqlx::query_scalar("select email_settings from settings")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(kept[ENTITY_INBOXES][&a], json!("books-a@inbox-p3.test"));
        let registry: (String, bool) = sqlx::query_as(
            "select account_id, is_active from mail_account_registry where email = 'books-a@inbox-p3.test'",
        )
        .fetch_one(&master)
        .await
        .unwrap();
        assert_eq!(registry, ("acct_inbox_ws_p3_inbox".to_owned(), true));
        for _ in 0..200 {
            tokio::task::yield_now().await;
        }
        assert!(bus.payloads().iter().any(|p| {
            p["entityType"] == json!("accounting_settings") && p["data"]["entityId"] == json!(a)
        }));

        // Another entity gets its own address; the same one is refused.
        let (status, out) = register(&b, "books-b@inbox-p3.test").await;
        assert_eq!(status, 200, "{out}");
        let (status, out) = register(&b, "books-a@inbox-p3.test").await;
        assert_eq!(status, 409, "{out}");
        // A new address replaces the entity's old one, which stops receiving.
        let (status, _) = register(&a, "books-a2@inbox-p3.test").await;
        assert_eq!(status, 200);
        let old: bool = sqlx::query_scalar(
            "select is_active from mail_account_registry where email = 'books-a@inbox-p3.test'",
        )
        .fetch_one(&master)
        .await
        .unwrap();
        assert!(!old);
        let kept: Value = sqlx::query_scalar("select email_settings from settings")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(kept[ENTITY_INBOXES][&a], json!("books-a2@inbox-p3.test"));
        assert_eq!(kept[ENTITY_INBOXES][&b], json!("books-b@inbox-p3.test"));

        // The workspace's own address is the default entity's, until it has its own.
        sqlx::query("update settings set email_settings = jsonb_set(email_settings, '{inboxAddress}', '\"books@inbox-p3.test\"')")
            .execute(&db)
            .await
            .unwrap();
        let (_, out) = answer(entity_inbox(caller(&b), Path(b.clone())).await).await;
        assert_eq!(
            out["data"]["email"],
            json!("books-b@inbox-p3.test"),
            "its own wins"
        );
        let c = entity(&db, false).await;
        let (_, out) = answer(entity_inbox(caller(&c), Path(c.clone())).await).await;
        assert!(
            out["data"]["email"].is_null(),
            "a non-default entity without its own has none"
        );
        sqlx::query("update entities set is_default = false where id = $1")
            .bind(&a)
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("update entities set is_default = true where id = $1")
            .bind(&a)
            .execute(&db)
            .await
            .unwrap();
        let (_, out) = answer(entity_inbox(caller(&a), Path(a.clone())).await).await;
        assert_eq!(out["data"]["email"], json!("books-a2@inbox-p3.test"));
        sqlx::query("update settings set email_settings = email_settings - 'entityInboxes'")
            .execute(&db)
            .await
            .unwrap();
        let (_, out) = answer(entity_inbox(caller(&a), Path(a.clone())).await).await;
        assert_eq!(out["data"]["email"], json!("books@inbox-p3.test"));
        assert_eq!(out["data"]["workspaceAddress"], json!(true));

        // An entity that is not there, and an address that is not one.
        let (status, _) = register("ent_missing", "x@inbox-p3.test").await;
        assert_eq!(status, 404);
        let (status, _) = register(&a, "not an address").await;
        assert_eq!(status, 400);
        sqlx::query("delete from settings")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query("update entities set is_default = false where id = $1")
            .bind(&a)
            .execute(&db)
            .await
            .unwrap();
    }
}
