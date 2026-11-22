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
use sea_orm::sea_query::{Alias, Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::PrimitiveDateTime;
use weldsuite_books_domain::entity_context::{resolve_entity_base_currency, resolve_entity_id};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, no_content, now, ok, paged, reply, validate,
};
use weldsuite_books_domain::js::{parse_int, to_fixed};
use weldsuite_books_domain::jurisdictions::us;
use weldsuite_books_domain::tables::ACCOUNTS as T;
use weldsuite_catalogs::entity_events::{ACCOUNT_CREATED, ACCOUNT_DELETED, ACCOUNT_UPDATED};
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::accounts::{self, Column};
use weldsuite_schema::tenant::{entities, journal_entries, journal_lines};

use crate::entity_setup::{form_1099_box_error, form_of, tax_line_error, tax_year_of};
use crate::orm_bridge::{sqlx_error, to_json};

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
    // The account this one rolls up into; an empty string clears it, like
    // null (`z.preprocess`, older clients send "").
    let parent = match body.get("parentAccountId") {
        Some(Value::String(id)) if id.is_empty() => Field::Null,
        _ => issues.text(body, "parentAccountId", Presence::Nullish, None, Some(30)),
    };
    keep(&mut out, "parentAccountId", parent);
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

async fn find_entity(db: &PgPool, entity_id: &str) -> Result<Option<Value>, DbErr> {
    entities::Entity::find()
        .filter(entities::Column::Id.eq(entity_id))
        .filter(entities::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(to_json)
        .transpose()
}

/// The live account of the entity with `code`, if any.
async fn code_holder(db: &PgPool, entity_id: &str, code: &str) -> Result<Option<String>, DbErr> {
    accounts::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::Code.eq(code))
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `journal_lines l join journal_entries e on l.journal_entry_id = e.id`:
/// the live lines of the account on a posted or reversed entry.
fn posted_lines(account_id: &str) -> sea_orm::Select<journal_lines::Entity> {
    journal_lines::Entity::find()
        .join(
            JoinType::InnerJoin,
            journal_lines::Entity::belongs_to(journal_entries::Entity)
                .from(journal_lines::Column::JournalEntryId)
                .to(journal_entries::Column::Id)
                .into(),
        )
        .filter(journal_lines::Column::AccountId.eq(account_id))
        .filter(journal_lines::Column::DeletedAt.is_null())
        .filter(journal_entries::Column::Status.is_in(["posted", "reversed"]))
}

/// `mappingError(db, entityId, mapping)`: why a tax line or 1099 box doesn't
/// fit the entity, or `None`.
async fn mapping_error(
    db: &PgPool,
    entity_id: &str,
    data: &Map<String, Value>,
) -> Result<Option<String>, DbErr> {
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

/// `parentError(db, input)`: why `parent_id` can't be the parent of an
/// account of `kind` (`account_id` is `None` on create), as the 400's
/// message and details. The parent must be a live account of the same
/// entity and type, and not the account itself or one of its own
/// sub-accounts (a cycle would make every roll-up that walks the tree loop).
async fn parent_error(
    db: &PgPool,
    account_id: Option<&str>,
    entity_id: &str,
    kind: &str,
    parent_id: &str,
) -> Result<Option<(String, Value)>, DbErr> {
    if Some(parent_id) == account_id {
        return Ok(Some((
            "An account can not be its own parent.".to_owned(),
            json!({ "code": "PARENT_IS_SELF" }),
        )));
    }
    let accounts: Vec<(String, String, Option<String>)> = accounts::Entity::find()
        .select_only()
        .columns([Column::Id, Column::Type, Column::ParentAccountId])
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let by_id = |id: &str| accounts.iter().find(|(a, _, _)| a == id);
    let Some((_, parent_type, _)) = by_id(parent_id) else {
        return Ok(Some((
            "The parent account does not exist in this administration.".to_owned(),
            json!({ "code": "PARENT_NOT_FOUND" }),
        )));
    };
    if parent_type != kind {
        return Ok(Some((
            format!("A {kind} account can only sit under another {kind} account."),
            json!({ "code": "PARENT_TYPE_MISMATCH", "parentType": parent_type }),
        )));
    }
    // Walk up from the new parent: reaching the account means the parent is
    // one of its sub-accounts.
    if let Some(account_id) = account_id {
        let mut seen: Vec<&str> = Vec::new();
        let mut at = Some(parent_id);
        while let Some(id) = at.filter(|id| !id.is_empty() && !seen.contains(id)) {
            if id == account_id {
                return Ok(Some((
                    "An account can not sit under one of its own sub-accounts.".to_owned(),
                    json!({ "code": "PARENT_CYCLE" }),
                )));
            }
            seen.push(id);
            at = by_id(id).and_then(|(_, _, parent)| parent.as_deref());
        }
    }
    Ok(None)
}

/// Why an update no longer fits the tree: a new parent, or a new type under
/// the current parent, must still pass [`parent_error`], and an account with
/// sub-accounts keeps its type.
async fn tree_error(
    db: &PgPool,
    account: &Value,
    data: &Map<String, Value>,
) -> Result<Option<(String, Value)>, DbErr> {
    let id = account["id"].as_str().unwrap_or_default();
    let entity_id = account["entityId"].as_str().unwrap_or_default();
    let kind = data
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| account["type"].as_str())
        .unwrap_or_default();
    let type_changed = account["type"].as_str() != Some(kind);
    let parent = match data.get("parentAccountId") {
        Some(given) => given.as_str(),
        None => account["parentAccountId"].as_str(),
    };
    if let Some(parent) = parent.filter(|p| !p.is_empty())
        && (data.contains_key("parentAccountId") || type_changed)
        && let Some(refusal) = parent_error(db, Some(id), entity_id, kind, parent).await?
    {
        return Ok(Some(refusal));
    }
    if !type_changed {
        return Ok(None);
    }
    let child: Option<String> = accounts::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::ParentAccountId.eq(id))
        .filter(Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(child.map(|_| {
        (
            "Move or remove the sub-accounts before changing the type of this account.".to_owned(),
            json!({ "code": "ACCOUNT_HAS_SUB_ACCOUNTS" }),
        )
    }))
}

async fn find(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    accounts::Entity::find()
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(to_json)
        .transpose()
}

// ── GET /tax-lines ──────────────────────────────────────────────────────────

async fn tax_lines(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let Some(entity) = find_entity(&caller.db, &entity_id)
            .await
            .map_err(sqlx_error)?
        else {
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
        let rows = list_accounts(&caller.db, &entity_id, &q)
            .await
            .map_err(sqlx_error)?;
        Ok(ok(Value::Array(rows)))
    }
    .await;
    reply(result, "Failed to fetch accounts")
}

/// The entity's live accounts the query's filters keep, by code.
async fn list_accounts(db: &PgPool, entity_id: &str, q: &Query) -> Result<Vec<Value>, DbErr> {
    let mut filters = Condition::all()
        .add(Column::DeletedAt.is_null())
        .add(Column::EntityId.eq(entity_id));
    // `taxLine=none`: the revenue and expense accounts without a line.
    match q.present("taxLine") {
        Some("none") => {
            filters = filters
                .add(Column::TaxLine.is_null())
                .add(Column::Type.is_in(["revenue", "expense"]));
        }
        Some(line) => filters = filters.add(Column::TaxLine.eq(line)),
        None => {}
    }
    if let Some(kind) = q.present("type") {
        filters = filters.add(Column::Type.eq(kind));
    }
    if let Some(subtype) = q.present("subtype") {
        filters = filters.add(Column::Subtype.eq(subtype));
    }
    if let Some(active) = q.get("isActive").map(|v| v == "true") {
        filters = filters.add(Column::IsActive.eq(active));
    }
    if let Some(parent) = q.present("parentAccountId") {
        filters = filters.add(Column::ParentAccountId.eq(parent));
    }
    if let Some(search) = q.present("search").map(|s| format!("%{s}%")) {
        filters = filters.add(
            Condition::any()
                .add(Column::Code.like(search.as_str()))
                .add(Column::Name.like(search.as_str())),
        );
    }
    accounts::Entity::find()
        .filter(filters)
        .order_by_asc(Column::Code)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(to_json)
        .collect()
}

// ── GET /:id, /:id/transactions ─────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match find(&caller, &id).await.map_err(sqlx_error)? {
            Some(row) => Ok(ok(row)),
            None => Err(Refusal::not_found("Account", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch account")
}

/// One line of `GET /:id/transactions` (`jsonb_build_object` of the line and
/// its entry): the amounts as their `numeric(18, 2)` text.
#[derive(Debug, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LedgerLine {
    id: String,
    journal_entry_id: String,
    description: Option<String>,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize_option")]
    debit: Option<sea_orm::prelude::BigDecimal>,
    #[serde(serialize_with = "weldsuite_schema::js::Numeric::<2>::serialize_option")]
    credit: Option<sea_orm::prelude::BigDecimal>,
    contact_id: Option<String>,
    entry_number: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    entry_date: PrimitiveDateTime,
    entry_description: Option<String>,
    source_type: Option<String>,
}

/// A page of the account's ledger lines, newest entry first.
async fn ledger_lines(
    db: &PgPool,
    account_id: &str,
    size: u64,
    offset: u64,
) -> Result<Vec<Value>, DbErr> {
    posted_lines(account_id)
        .select_only()
        .columns([
            journal_lines::Column::Id,
            journal_lines::Column::JournalEntryId,
            journal_lines::Column::Description,
            journal_lines::Column::Debit,
            journal_lines::Column::Credit,
            journal_lines::Column::ContactId,
        ])
        .column_as(journal_entries::Column::EntryNumber, "entry_number")
        .column_as(journal_entries::Column::Date, "entry_date")
        .column_as(journal_entries::Column::Description, "entry_description")
        .column_as(journal_entries::Column::SourceType, "source_type")
        .order_by_desc(journal_entries::Column::Date)
        .limit(size)
        .offset(offset)
        .into_model::<LedgerLine>()
        .all(&orm(db))
        .await?
        .into_iter()
        .map(to_json)
        .collect()
}

async fn transactions(caller: Caller, Path(id): Path<String>, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    // `Math.max(parseInt(page || '1'), 1)`, `Math.min(Math.max(parseInt(pageSize || '25'), 1), 100)`
    let page = parse_int(q.present("page").unwrap_or("1")).map(|n| n.max(1));
    let size = parse_int(q.present("pageSize").unwrap_or("25")).map(|n| n.clamp(1, 100));
    let result = async {
        let total = posted_lines(&id)
            .count(&orm(&caller.db))
            .await
            .map_err(sqlx_error)?;
        let total = i64::try_from(total).unwrap_or(i64::MAX);
        let (Some(page), Some(size)) = (page, size) else {
            return Err(Refusal::Internal("page is NaN".to_owned()));
        };
        // A negative `limit` or `offset` is Postgres's error: the route's 500.
        let (Ok(limit), Ok(offset)) = (u64::try_from(size), u64::try_from((page - 1) * size))
        else {
            return Err(Refusal::Internal("OFFSET must not be negative".to_owned()));
        };
        let rows = ledger_lines(&caller.db, &id, limit, offset)
            .await
            .map_err(sqlx_error)?;
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
    let existing = code_holder(db, &entity_id, &code)
        .await
        .map_err(sqlx_error)?;
    if existing.is_some() {
        return Err(Refusal::conflict(format!(
            "Account code '{code}' already exists"
        )));
    }
    if let Some(message) = mapping_error(db, &entity_id, &data)
        .await
        .map_err(sqlx_error)?
    {
        return Err(Refusal::bad_request(message));
    }
    if let Some(parent) = data
        .get("parentAccountId")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    {
        let kind = data["type"].as_str().unwrap_or_default();
        if let Some((message, details)) = parent_error(db, None, &entity_id, kind, parent)
            .await
            .map_err(sqlx_error)?
        {
            return Err(Refusal::bad_request_with(message, details));
        }
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
) -> Result<Option<(String, Value)>, DbErr> {
    if account["isSystemAccount"].as_bool() == Some(true) {
        return Ok(Some((
            "A system account can not be deactivated.".to_owned(),
            json!({ "code": "ACCOUNT_IS_SYSTEM" }),
        )));
    }
    // `coalesce(sum(l.debit - l.credit), 0)::text`, read as a JS number.
    let net = {
        use sea_orm::ExprTrait as _;
        Expr::expr(Func::coalesce([
            Func::sum(
                Expr::col((journal_lines::Entity, journal_lines::Column::Debit)).sub(Expr::col((
                    journal_lines::Entity,
                    journal_lines::Column::Credit,
                ))),
            )
            .into(),
            Expr::val(0),
        ]))
        .cast_as(Alias::new("text"))
    };
    let net: Option<String> = posted_lines(account["id"].as_str().unwrap_or_default())
        .select_only()
        .expr_as(net, "net")
        .into_tuple()
        .one(&orm(db))
        .await?;
    let ledger = weldsuite_kit::validation::js_number(&net.unwrap_or_default());
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
    let Some(account) = find(caller, id).await.map_err(sqlx_error)? else {
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
        let dup = code_holder(db, &entity_id, code)
            .await
            .map_err(sqlx_error)?;
        if dup.is_some() {
            return Err(Refusal::conflict(format!(
                "Account code '{code}' already exists"
            )));
        }
    }
    if data.get("isActive") == Some(&Value::Bool(false))
        && account["isActive"] != Value::Bool(false)
        && let Some((message, details)) = deactivation_conflict(db, &account)
            .await
            .map_err(sqlx_error)?
    {
        return Err(Refusal::conflict_with(message, details));
    }
    if let Some(message) = mapping_error(db, &entity_id, &data)
        .await
        .map_err(sqlx_error)?
    {
        return Err(Refusal::bad_request(message));
    }
    if let Some((message, details)) = tree_error(db, &account, &data).await.map_err(sqlx_error)? {
        return Err(Refusal::bad_request_with(message, details));
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
        let Some(account) = find(&caller, &id).await.map_err(sqlx_error)? else {
            return Err(Refusal::not_found("Account", &id));
        };
        if account["isSystemAccount"].as_bool() == Some(true) {
            return Err(Refusal::bad_request("Cannot delete a system account"));
        }
        let count = journal_lines::Entity::find()
            .filter(journal_lines::Column::AccountId.eq(id.as_str()))
            .filter(journal_lines::Column::DeletedAt.is_null())
            .count(&orm(db))
            .await
            .map_err(sqlx_error)?;
        if count > 0 {
            return Err(Refusal::bad_request(
                "Account has bookings — deactivate it instead",
            ));
        }
        let at = weldsuite_db::utc_now();
        accounts::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(at))
            .col_expr(Column::UpdatedAt, Expr::value(at))
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(db))
            .await
            .map_err(sqlx_error)?;
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
