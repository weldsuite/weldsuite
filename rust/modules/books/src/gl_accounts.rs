//! `/api/gl-accounts` (`routes/gl-accounts/index.ts`): the chart of
//! accounts. System accounts keep their code, type and side; an account
//! with bookings is deactivated, never deleted; US accounts map to a line of
//! the entity's income-tax return and a 1099 box.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::entity_context::{resolve_entity_base_currency, resolve_entity_id};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, no_content, now, ok, paged, reply, validate,
};
use weldsuite_books_domain::js::{parse_int, to_fixed};
use weldsuite_books_domain::jurisdictions::us;
use weldsuite_books_domain::tables::{ACCOUNTS as T, ENTITIES};
use weldsuite_catalogs::entity_events::{ACCOUNT_CREATED, ACCOUNT_DELETED, ACCOUNT_UPDATED};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::entity_setup::{form_1099_box_error, form_of, tax_line_error, tax_year_of};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/tax-lines",
            get(tax_lines).route_layer(need("accounts:read")),
        )
        .route("/", get(list).route_layer(need("accounts:read")))
        .route("/", post(create).route_layer(need("accounts:create")))
        .route("/{id}", get(detail).route_layer(need("accounts:read")))
        .route(
            "/{id}",
            axum::routing::patch(update)
                .put(update)
                .route_layer(need("accounts:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("accounts:delete")),
        )
        .route(
            "/{id}/transactions",
            get(transactions).route_layer(need("accounts:read")),
        )
        .with_state(state)
}

/// Ledger balances under half a cent count as zero.
const ZERO_BALANCE_EPSILON: f64 = 0.005;

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

/// `createAccountSchema` (`updateAccountSchema` is its `.partial()` plus
/// `isActive`): Zod's output, unknown keys stripped.
fn read_body(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    keep(
        &mut out,
        "code",
        issues.text(body, "code", required, Some(1), Some(20)),
    );
    keep(
        &mut out,
        "name",
        issues.text(body, "name", required, Some(1), Some(255)),
    );
    keep(
        &mut out,
        "description",
        issues.text(body, "description", Presence::Optional, None, None),
    );
    keep(
        &mut out,
        "type",
        issues.choice(
            body,
            "type",
            required,
            &["asset", "liability", "equity", "revenue", "expense"],
        ),
    );
    keep(
        &mut out,
        "subtype",
        issues.text(body, "subtype", Presence::Optional, None, Some(50)),
    );
    keep(
        &mut out,
        "parentAccountId",
        issues.text(body, "parentAccountId", Presence::Optional, None, Some(30)),
    );
    if let Field::Set(currency) = issues.text(body, "currency", Presence::Optional, None, None) {
        issues.string_length("currency", 3, currency.encode_utf16().count());
        out.insert("currency".to_owned(), json!(currency));
    }
    keep(
        &mut out,
        "normalSide",
        issues.choice(body, "normalSide", required, &["debit", "credit"]),
    );
    keep(
        &mut out,
        "defaultTaxRateId",
        issues.text(body, "defaultTaxRateId", Presence::Optional, None, Some(30)),
    );
    keep(
        &mut out,
        "openingBalance",
        issues.text(body, "openingBalance", Presence::Optional, None, None),
    );
    keep(
        &mut out,
        "taxLine",
        issues.text(body, "taxLine", Presence::Nullish, None, Some(40)),
    );
    keep(
        &mut out,
        "form1099Box",
        issues.text(body, "form1099Box", Presence::Nullish, None, Some(20)),
    );
    let meta = issues.nested(body, "metadata", Presence::Optional, |_, m| m.clone());
    keep(&mut out, "metadata", meta);
    if partial {
        keep(
            &mut out,
            "isActive",
            issues.boolean(body, "isActive", Presence::Optional),
        );
    }
    out
}

async fn find_entity(db: &PgPool, entity_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(entities),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| ENTITIES.js(row)))
}

/// `mappingError(db, entityId, mapping)`: why a tax line or 1099 box doesn't
/// fit the entity, or `None`.
async fn mapping_error(
    db: &PgPool,
    entity_id: &str,
    data: &Map<String, Value>,
) -> Result<Option<String>, sqlx::Error> {
    let tax_line = data
        .get("taxLine")
        .and_then(Value::as_str)
        .filter(|l| !l.is_empty());
    let box_code = data
        .get("form1099Box")
        .and_then(Value::as_str)
        .filter(|b| !b.is_empty());
    if tax_line.is_none() && box_code.is_none() {
        return Ok(None);
    }
    let Some(entity) = find_entity(db, entity_id).await? else {
        return Ok(Some("Accounting entity not found".to_owned()));
    };
    if let Some(line) = tax_line
        && let Some(message) =
            tax_line_error(&entity, line, tax_year_of(entity["timezone"].as_str()))
    {
        return Ok(Some(message));
    }
    if let Some(code) = box_code {
        if entity["jurisdictionCode"].as_str() != Some("US") {
            return Ok(Some(
                "1099 boxes are only available for US entities".to_owned(),
            ));
        }
        return Ok(form_1099_box_error(code));
    }
    Ok(None)
}

async fn find(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(accounts),
        " from accounts t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|row| T.js(row)))
}

// ── GET /tax-lines ──────────────────────────────────────────────────────────

async fn tax_lines(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let Some(entity) = find_entity(&caller.db, &entity_id).await? else {
            return Err(Refusal::not_found("Entity", &entity_id));
        };
        if entity["jurisdictionCode"].as_str() != Some("US") {
            return Err(Refusal::bad_request(
                "Tax lines are only available for US entities",
            ));
        }
        let year = match q.present("year") {
            Some(raw) => parse_int(raw),
            None => Some(tax_year_of(entity["timezone"].as_str())),
        };
        let Some(year) = year.filter(|y| (2000..=2100).contains(y)) else {
            return Err(Refusal::bad_request("year must be a four-digit year"));
        };
        let form = form_of(
            entity["entityType"].as_str(),
            entity["taxClassification"].as_str(),
        );
        let lines = us::tax_line_catalog(form, year);
        let mut sections: Vec<&str> = Vec::new();
        for line in lines {
            if let Some(section) = line["section"].as_str()
                && !sections.contains(&section)
            {
                sections.push(section);
            }
        }
        let sections: Vec<Value> = sections
            .into_iter()
            .map(|key| json!({ "key": key, "label": us::section_label(key) }))
            .collect();
        Ok(ok(json!({
            "form": form,
            "formLabel": us::form_label(form),
            "taxYear": year,
            "sections": sections,
            "lines": lines,
        })))
    }
    .await;
    reply(result, "Failed to fetch tax lines")
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let tax_line = q.present("taxLine");
        let search = q.present("search").map(|s| format!("%{s}%"));
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(accounts),
            " from accounts t where t.deleted_at is null and t.entity_id = $1 \
             and (case when $2::text = 'none' then t.tax_line is null and t.type in ('revenue', 'expense') \
                       when $2::text is not null then t.tax_line = $2 else true end) \
             and ($3::text is null or t.type = $3) and ($4::text is null or t.subtype = $4) \
             and ($5::boolean is null or t.is_active = $5) and ($6::text is null or t.parent_account_id = $6) \
             and ($7::text is null or (t.code like $7 or t.name like $7)) \
             order by t.code"
        ))
        .bind(&entity_id)
        .bind(tax_line)
        .bind(q.present("type"))
        .bind(q.present("subtype"))
        .bind(q.get("isActive").map(|v| v == "true"))
        .bind(q.present("parentAccountId"))
        .bind(&search)
        .fetch_all(&caller.db)
        .await?;
        Ok(ok(Value::Array(T.js_rows(rows))))
    }
    .await;
    reply(result, "Failed to fetch accounts")
}

// ── GET /:id, /:id/transactions ─────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match find(&caller, &id).await? {
            Some(row) => Ok(ok(row)),
            None => Err(Refusal::not_found("Account", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch account")
}

async fn transactions(caller: Caller, Path(id): Path<String>, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    // `Math.max(parseInt(page || '1'), 1)`, `Math.min(Math.max(parseInt(pageSize || '25'), 1), 100)`
    let page = parse_int(q.present("page").unwrap_or("1")).map(|n| n.max(1));
    let size = parse_int(q.present("pageSize").unwrap_or("25")).map(|n| n.clamp(1, 100));
    let result = async {
        let total: i64 = sqlx::query_scalar(
            "select count(*)::int8 from journal_lines l join journal_entries e on l.journal_entry_id = e.id \
             where l.account_id = $1 and l.deleted_at is null and e.status in ('posted', 'reversed')",
        )
        .bind(&id)
        .fetch_one(&caller.db)
        .await?;
        let (Some(page), Some(size)) = (page, size) else {
            return Err(Refusal::Internal("page is NaN".to_owned()));
        };
        let rows: Vec<Value> = sqlx::query_scalar(
            "select jsonb_build_object('id', l.id, 'journalEntryId', l.journal_entry_id, 'description', l.description, \
               'debit', l.debit::text, 'credit', l.credit::text, 'contactId', l.contact_id, \
               'entryNumber', e.entry_number, 'entryDate', e.date, 'entryDescription', e.description, \
               'sourceType', e.source_type) \
             from journal_lines l join journal_entries e on l.journal_entry_id = e.id \
             where l.account_id = $1 and l.deleted_at is null and e.status in ('posted', 'reversed') \
             order by e.date desc limit $2 offset $3",
        )
        .bind(&id)
        .bind(size)
        .bind((page - 1) * size)
        .fetch_all(&caller.db)
        .await?;
        let rows: Vec<Value> = rows
            .into_iter()
            .map(|mut row| {
                if let Some(at) = row["entryDate"].as_str().and_then(weldsuite_db::js_timestamp) {
                    row["entryDate"] = json!(at);
                }
                row
            })
            .collect();
        Ok(paged(rows, total, page * size < total, None))
    }
    .await;
    reply(result, "Failed to fetch account transactions")
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create account"),
    };
    reply(
        create_account(&caller, &state, data).await,
        "Failed to create account",
    )
}

async fn create_account(caller: &Caller, state: &BooksState, data: Map<String, Value>) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let code = data["code"].as_str().unwrap_or_default().to_owned();
    let existing: Option<String> = sqlx::query_scalar(
        "select id from accounts where code = $1 and entity_id = $2 and deleted_at is null limit 1",
    )
    .bind(&code)
    .bind(&entity_id)
    .fetch_optional(db)
    .await?;
    if existing.is_some() {
        return Err(Refusal::conflict(format!(
            "Account code '{code}' already exists"
        )));
    }
    if let Some(message) = mapping_error(db, &entity_id, &data).await? {
        return Err(Refusal::bad_request(message));
    }
    let currency = match data.get("currency").and_then(Value::as_str) {
        Some(currency) => currency.to_owned(),
        None => resolve_entity_base_currency(db, &entity_id).await?,
    };
    let at = now();
    let mut account = Map::new();
    account.insert("id".to_owned(), json!(generate_id("acc")));
    account.insert("entityId".to_owned(), json!(entity_id));
    for (key, value) in &data {
        account.insert(key.clone(), value.clone());
    }
    account.insert("currency".to_owned(), json!(currency));
    account.insert("isActive".to_owned(), json!(true));
    account.insert("isSystemAccount".to_owned(), json!(false));
    account.insert("currentBalance".to_owned(), json!("0"));
    account.insert("createdAt".to_owned(), json!(at));
    account.insert("updatedAt".to_owned(), json!(at));
    T.insert_raw(db, T.values(&account)).await?;
    let id = account["id"].as_str().unwrap_or_default().to_owned();
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "account",
            entity_id: &id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(state, ACCOUNT_CREATED, &id, Value::Object(account.clone()));
    Ok(created(Value::Object(account)))
}

// ── PUT|PATCH /:id ──────────────────────────────────────────────────────────

/// `deactivationConflict`: a system account, or a balance left.
async fn deactivation_conflict(
    db: &PgPool,
    account: &Value,
) -> Result<Option<(String, Value)>, sqlx::Error> {
    if account["isSystemAccount"].as_bool() == Some(true) {
        return Ok(Some((
            "A system account can not be deactivated.".to_owned(),
            json!({ "code": "ACCOUNT_IS_SYSTEM" }),
        )));
    }
    let net: String = sqlx::query_scalar(
        "select coalesce(sum(l.debit::numeric - l.credit::numeric), 0)::text from journal_lines l \
         join journal_entries e on l.journal_entry_id = e.id \
         where l.account_id = $1 and l.deleted_at is null and e.status in ('posted', 'reversed')",
    )
    .bind(account["id"].as_str().unwrap_or_default())
    .fetch_one(db)
    .await?;
    let ledger = weldsuite_kit::validation::js_number(&net);
    let current = weldsuite_books_domain::js::numeric(&account["currentBalance"]);
    if ledger.abs() < ZERO_BALANCE_EPSILON && current.abs() < ZERO_BALANCE_EPSILON {
        return Ok(None);
    }
    let balance = if ledger.abs() >= ZERO_BALANCE_EPSILON {
        ledger
    } else {
        current
    };
    let text = to_fixed(balance, 2);
    Ok(Some((
        format!(
            "This account still has a balance of {text}. Clear the balance before deactivating it."
        ),
        json!({ "code": "ACCOUNT_HAS_BALANCE", "balance": text }),
    )))
}

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_body(issues, body, true)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update account"),
    };
    reply(
        update_account(&caller, &state, &id, data).await,
        "Failed to update account",
    )
}

async fn update_account(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let Some(account) = find(caller, id).await? else {
        return Err(Refusal::not_found("Account", id));
    };
    let truthy = |key: &str| weldsuite_books_domain::js::truthy(data.get(key));
    if account["isSystemAccount"].as_bool() == Some(true)
        && (truthy("code") || truthy("type") || truthy("normalSide"))
    {
        return Err(Refusal::bad_request(
            "Cannot change code, type, or normalSide of a system account",
        ));
    }
    let entity_id = account["entityId"].as_str().unwrap_or_default().to_owned();
    if let Some(code) = data
        .get("code")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        && account["code"].as_str() != Some(code)
    {
        let dup: Option<String> = sqlx::query_scalar(
            "select id from accounts where code = $1 and entity_id = $2 and deleted_at is null limit 1",
        )
        .bind(code)
        .bind(&entity_id)
        .fetch_optional(db)
        .await?;
        if dup.is_some() {
            return Err(Refusal::conflict(format!(
                "Account code '{code}' already exists"
            )));
        }
    }
    if data.get("isActive") == Some(&Value::Bool(false))
        && account["isActive"] != Value::Bool(false)
        && let Some((message, details)) = deactivation_conflict(db, &account).await?
    {
        return Err(Refusal::conflict_with(message, details));
    }
    if let Some(message) = mapping_error(db, &entity_id, &data).await? {
        return Err(Refusal::bad_request(message));
    }
    let mut set = data.clone();
    set.insert("updatedAt".to_owned(), json!(now()));
    T.patch_raw(db, id, T.values(&set), false).await?;
    let changes: Map<String, Value> = data
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                change(
                    account.get(key).cloned().unwrap_or(Value::Null),
                    value.clone(),
                ),
            )
        })
        .collect();
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "account",
            entity_id: id,
            action: "updated",
            changes: Some(changes),
        },
    )
    .await;
    let mut merged = account.as_object().cloned().unwrap_or_default();
    for (key, value) in data {
        merged.insert(key, value);
    }
    caller.publish(state, ACCOUNT_UPDATED, id, Value::Object(merged.clone()));
    Ok(ok(Value::Object(merged)))
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let db = &caller.db;
        let Some(account) = find(&caller, &id).await? else {
            return Err(Refusal::not_found("Account", &id));
        };
        if account["isSystemAccount"].as_bool() == Some(true) {
            return Err(Refusal::bad_request("Cannot delete a system account"));
        }
        let count: i64 = sqlx::query_scalar(
            "select count(*)::int8 from journal_lines where account_id = $1 and deleted_at is null",
        )
        .bind(&id)
        .fetch_one(db)
        .await?;
        if count > 0 {
            return Err(Refusal::bad_request("Account has bookings — deactivate it instead"));
        }
        let at = now();
        sqlx::query("update accounts set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2")
            .bind(&at)
            .bind(&id)
            .execute(db)
            .await?;
        write_accounting_audit(
            &caller,
            db,
            AuditInput {
                accounting_entity_id: account["entityId"].as_str(),
                entity_type: "account",
                entity_id: &id,
                action: "deleted",
                changes: None,
            },
        )
        .await;
        caller.publish(&state, ACCOUNT_DELETED, &id, json!({ "id": id }));
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete account")
}
