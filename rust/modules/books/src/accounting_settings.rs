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
use serde_json::{Map, Value, json};
use weldsuite_books_domain::currency::{
    get_exchange_rate, get_exchange_rates, rates_json, supported_currencies,
};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, now, ok, reply, validate,
};
use weldsuite_books_domain::tables::{SETTINGS as T, WORKFLOW_TEMPLATES};
use weldsuite_catalogs::entity_events::ACCOUNTING_SETTINGS_UPDATED;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

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
        .route("/inbox", post(inbox).route_layer(need("accounts:update")))
        .route(
            "/seed-workflows",
            post(seed_workflows).route_layer(need("accounts:create")),
        )
        .with_state(state)
}

async fn find(caller: &Caller) -> Result<Option<Map<String, Value>>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(settings),
        " from settings t where t.deleted_at is null limit 1"
    ))
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.and_then(|row| T.js(row).as_object().cloned()))
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
        let at = now();
        sqlx::query(
            "insert into mail_account_registry (id, email, workspace_id, account_id, is_active, created_at, updated_at) \
             values ($1, $2, $3, $4, true, $5::timestamp, $5::timestamp) \
             on conflict (email) do update set workspace_id = $3, account_id = $4, is_active = true, updated_at = $5::timestamp",
        )
        .bind(generate_id("mar"))
        .bind(&email)
        .bind(&workspace_id)
        .bind(&account_id)
        .bind(&at)
        .execute(&master)
        .await?;
        if let Some(current) = find(&caller).await? {
            let id = current["id"].as_str().unwrap_or_default().to_owned();
            let old = current.get("emailSettings").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!({}));
            let mut next = old.as_object().cloned().unwrap_or_default();
            next.insert("inboxAddress".to_owned(), json!(email));
            next.insert("autoScanEnabled".to_owned(), json!(true));
            sqlx::query("update settings set email_settings = $1, updated_at = $2::timestamp where id = $3")
                .bind(Value::Object(next.clone()))
                .bind(&at)
                .bind(&id)
                .execute(&caller.db)
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

// ── POST /seed-workflows ────────────────────────────────────────────────────

/// The finance workflow templates (ported verbatim from the worker, Dutch
/// strings included), with `<id>` and `<now>` filled in per seed.
const TEMPLATES: &str = include_str!("../data/finance-workflow-templates.json");

async fn seed_workflows(caller: Caller) -> Response {
    let result = async {
        let existing: Option<String> = sqlx::query_scalar(
            "select id from workflow_templates where category = 'finance' limit 1",
        )
        .fetch_optional(&caller.db)
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
                Ok::<_, sqlx::Error>(())
            })
        })
        .await?;
        Ok(created(json!({ "templatesCreated": count })))
    }
    .await;
    reply(result, "Failed to seed accounting workflow templates")
}
