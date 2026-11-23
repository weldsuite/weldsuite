//! Legal entities on the public API (`routes/v1/legal-entities/index.ts`):
//! `GET /v1/legal-entities` and `GET /v1/legal-entities/:id`, scope
//! `legal_entities:read`. Read-only.
//!
//! The companies of the workspace (`weldsuite-documentation/plans/legal-entities.md`) with their
//! registrations and bank accounts. Bank accounts carry no account number at
//! all (nor routing number), and the IBAN is masked to its last four
//! characters; no ciphertext column is ever selected. Per-entity access is a
//! platform member concept: API keys have no entity allow-list yet, so a key
//! sees every entity.
//!
//! Creating and changing entities happens in the platform (Settings → Legal
//! entities); every write answers 405. `/v1/accounting-entities` is the
//! WeldBooks view of the same table and is unchanged.

use std::collections::HashMap;

use axum::Router;
use axum::extract::{Path, RawQuery, Request};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodRouter, get};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, QueryFilter,
    QueryOrder, QuerySelect, QueryTrait,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_db::record::count_statement;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::Issues;
use weldsuite_schema::tenant::{bank_accounts, entities, legal_entity_registrations};

use crate::ExternalApiState;
use crate::crud::{Answer, Caller, ok};
use crate::list::{ListQuery, Page, page_statement};
use crate::session::{ApiSession, database_error, not_found, unauthorized};
use crate::simple::scoped;

const READ_SCOPE: &str = "legal_entities:read";

/// The columns an entity is answered from: never the ciphertext ones.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntityRow {
    id: String,
    name: String,
    legal_name: Option<String>,
    dba: Option<String>,
    entity_type: Option<String>,
    jurisdiction_code: String,
    base_currency: String,
    locale: String,
    timezone: Option<String>,
    address: Option<Value>,
    contact: Option<Value>,
    branding: Option<Value>,
    fiscal_year_start: Option<i32>,
    is_default: Option<bool>,
    is_active: Option<bool>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    created_at: PrimitiveDateTime,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    updated_at: PrimitiveDateTime,
}

/// `select <the answered columns> from entities`.
fn entity_rows() -> sea_orm::Select<entities::Entity> {
    use entities::Column;
    entities::Entity::find().select_only().columns([
        Column::Id,
        Column::Name,
        Column::LegalName,
        Column::Dba,
        Column::EntityType,
        Column::JurisdictionCode,
        Column::BaseCurrency,
        Column::Locale,
        Column::Timezone,
        Column::Address,
        Column::Contact,
        Column::Branding,
        Column::FiscalYearStart,
        Column::IsDefault,
        Column::IsActive,
        Column::CreatedAt,
        Column::UpdatedAt,
    ])
}

/// A bank account's answered columns: the account number (encrypted or
/// not) is never selected.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountRow {
    id: String,
    entity_id: String,
    name: String,
    account_holder_name: Option<String>,
    iban: Option<String>,
    bic: Option<String>,
    bank_name: Option<String>,
    currency: Option<String>,
    account_type: Option<String>,
    is_default: Option<bool>,
    is_active: Option<bool>,
}

/// A row as the JSON the answer is built from.
fn to_json<T: Serialize>(row: T) -> Result<Value, DbErr> {
    serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string()))
}

/// The worker's routes.
pub(crate) fn routes(router: Router<ExternalApiState>) -> Router<ExternalApiState> {
    router
        .route(
            "/legal-entities",
            scoped(get(list), READ_SCOPE).merge(writes()),
        )
        .route(
            "/legal-entities/{id}",
            scoped(get(detail), READ_SCOPE).merge(writes()),
        )
        .route("/legal-entities/{id}/{*rest}", writes())
}

/// `maskIban`: the IBAN with everything but the last four characters hidden.
fn mask_iban(iban: Option<&str>) -> Value {
    let Some(iban) = iban.filter(|iban| !iban.is_empty()) else {
        return Value::Null;
    };
    // `iban.replaceAll(/\s/g, '')`, counted in UTF-16 code units.
    let compact: Vec<u16> = iban
        .chars()
        .filter(|c| !(*c != '\u{85}' && (c.is_whitespace() || *c == '\u{feff}')))
        .collect::<String>()
        .encode_utf16()
        .collect();
    if compact.len() <= 4 {
        return Value::String(String::from_utf16_lossy(&compact));
    }
    let hidden = compact.len() - 4;
    let tail = String::from_utf16_lossy(compact.get(hidden..).unwrap_or_default());
    Value::String(format!("{}{tail}", "*".repeat(hidden)))
}

/// `row.x ?? null`.
fn or_null(row: &Map<String, Value>, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

/// JavaScript truthiness of a stored value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `Boolean(row.isDefault)`, `row.isActive !== false`.
fn is_default(row: &Map<String, Value>) -> bool {
    row.get("isDefault").is_some_and(truthy)
}

fn is_active(row: &Map<String, Value>) -> bool {
    row.get("isActive") != Some(&Value::Bool(false))
}

/// Registrations and bank accounts of these entities, keyed by entity id
/// (`loadChildren`).
struct Children {
    registrations: HashMap<String, Vec<Value>>,
    bank_accounts: HashMap<String, Vec<Value>>,
}

async fn load_children(db: &PgPool, ids: &[String]) -> Result<Children, DbErr> {
    let mut children = Children {
        registrations: HashMap::new(),
        bank_accounts: HashMap::new(),
    };
    if ids.is_empty() {
        return Ok(children);
    }
    let db = orm(db);
    let registrations = legal_entity_registrations::Entity::find()
        .filter(legal_entity_registrations::Column::EntityId.is_in(ids.iter().cloned()))
        .filter(legal_entity_registrations::Column::DeletedAt.is_null())
        .order_by_asc(legal_entity_registrations::Column::CreatedAt)
        .all(&db)
        .await?;
    for row in registrations {
        let Value::Object(row) = to_json(row)? else {
            continue;
        };
        let entity_id = row
            .get("entityId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let public = json!({
            "id": or_null(&row, "id"),
            "type": or_null(&row, "type"),
            "number": or_null(&row, "number"),
            "country": or_null(&row, "country"),
            "region": or_null(&row, "region"),
            "label": or_null(&row, "label"),
            "validFrom": or_null(&row, "validFrom"),
            "validTo": or_null(&row, "validTo"),
            "isPrimary": or_null(&row, "isPrimary"),
        });
        children
            .registrations
            .entry(entity_id)
            .or_default()
            .push(public);
    }

    // Explicit columns: the account number (encrypted or not) is never selected.
    let accounts: Vec<AccountRow> = {
        use bank_accounts::Column;
        bank_accounts::Entity::find()
            .select_only()
            .columns([
                Column::Id,
                Column::EntityId,
                Column::Name,
                Column::AccountHolderName,
                Column::Iban,
                Column::Bic,
                Column::BankName,
                Column::Currency,
                Column::AccountType,
                Column::IsDefault,
                Column::IsActive,
            ])
            .filter(Column::EntityId.is_in(ids.iter().cloned()))
            .filter(Column::DeletedAt.is_null())
            .order_by_asc(Column::CreatedAt)
            .into_model()
            .all(&db)
            .await?
    };
    for row in accounts {
        let Value::Object(row) = to_json(row)? else {
            continue;
        };
        let entity_id = row
            .get("entityId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let public = json!({
            "id": or_null(&row, "id"),
            "name": or_null(&row, "name"),
            "accountHolderName": or_null(&row, "accountHolderName"),
            "ibanMasked": mask_iban(row.get("iban").and_then(Value::as_str)),
            "bic": or_null(&row, "bic"),
            "bankName": or_null(&row, "bankName"),
            "currency": or_null(&row, "currency"),
            "accountType": or_null(&row, "accountType"),
            "isDefault": is_default(&row),
            "isActive": is_active(&row),
        });
        children
            .bank_accounts
            .entry(entity_id)
            .or_default()
            .push(public);
    }
    Ok(children)
}

/// `toPublic(row, children)`.
fn to_public(row: &Value, children: &Children) -> Value {
    let Value::Object(row) = row else {
        return Value::Null;
    };
    let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
    // `{ logoUrl, primaryColor, accentColor }` of a set branding (keys it
    // leaves out stay out), else null.
    let branding = match row.get("branding") {
        Some(branding) if truthy(branding) => {
            let mut view = Map::new();
            if let Value::Object(stored) = branding {
                for key in ["logoUrl", "primaryColor", "accentColor"] {
                    if let Some(value) = stored.get(key) {
                        view.insert(key.to_owned(), value.clone());
                    }
                }
            }
            Value::Object(view)
        }
        _ => Value::Null,
    };
    json!({
        "id": or_null(row, "id"),
        "name": or_null(row, "name"),
        "legalName": or_null(row, "legalName"),
        "tradingName": or_null(row, "dba"),
        "legalForm": or_null(row, "entityType"),
        "jurisdictionCode": or_null(row, "jurisdictionCode"),
        "baseCurrency": or_null(row, "baseCurrency"),
        "locale": or_null(row, "locale"),
        "timezone": or_null(row, "timezone"),
        "address": or_null(row, "address"),
        "contact": or_null(row, "contact"),
        "branding": branding,
        "fiscalYearStart": or_null(row, "fiscalYearStart"),
        "isDefault": is_default(row),
        "isActive": is_active(row),
        "registrations": children.registrations.get(id).cloned().unwrap_or_default(),
        "bankAccounts": children.bank_accounts.get(id).cloned().unwrap_or_default(),
        "createdAt": or_null(row, "createdAt"),
        "updatedAt": or_null(row, "updatedAt"),
    })
}

fn row_ids(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

/// `GET /`: newest first, cursor-paged.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Answer {
    let mut issues = Issues::default();
    let query = ListQuery::read(&mut issues, raw.as_deref());
    if let Err(invalid) = issues.finish() {
        return Ok(invalid.into_response());
    }
    let mut page = page_of_ids(&caller.db, &query).await?;
    let ids = row_ids(&page.rows);
    let rows = load_entities(&caller.db, &ids).await?;
    let children = load_children(&caller.db, &ids).await?;
    page.rows = ids
        .iter()
        .filter_map(|id| rows.get(id))
        .map(|row| to_public(row, &children))
        .collect();
    Ok(page.respond())
}

/// One page of the live entities' ids, newest first, and their count.
async fn page_of_ids(db: &PgPool, query: &ListQuery) -> Result<Page, ApiError> {
    let read = async {
        let db = orm(db);
        let ids = entities::Entity::find()
            .select_only()
            .column(entities::Column::Id)
            .into_query();
        let live = Condition::all().add(entities::Column::DeletedAt.is_null());
        let page = page_statement(ids.clone(), "entities", live.clone(), query);
        let rows: Vec<Value> = db
            .query_all(&page)
            .await?
            .iter()
            .map(|row| row.try_get::<String>("", "id").map(|id| json!({ "id": id })))
            .collect::<Result<_, _>>()?;
        let mut counted = ids;
        counted.cond_where(live);
        let total: i64 = db
            .query_one_raw(count_statement(&counted))
            .await?
            .ok_or_else(|| DbErr::RecordNotFound("count".to_owned()))?
            .try_get("", "count")?;
        Ok::<_, DbErr>(Page::of(rows, total, query.limit))
    };
    read.await.map_err(|error| database_error(&error))
}

/// The entities of a page, by id, as Drizzle reads their columns.
async fn load_entities(db: &PgPool, ids: &[String]) -> Result<HashMap<String, Value>, DbErr> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<EntityRow> = entity_rows()
        .filter(entities::Column::Id.is_in(ids.iter().cloned()))
        .into_model()
        .all(&orm(db))
        .await?;
    rows.into_iter()
        .map(|row| Ok((row.id.clone(), to_json(row)?)))
        .collect()
}

/// `GET /:id`: a live entity.
async fn detail(caller: Caller, Path(id): Path<String>) -> Answer {
    let row: Option<EntityRow> = entity_rows()
        .filter(entities::Column::Id.eq(id.as_str()))
        .filter(entities::Column::DeletedAt.is_null())
        .into_model()
        .one(&orm(&caller.db))
        .await?;
    let Some(row) = row.map(to_json).transpose()? else {
        return Err(not_found("Legal entity", &id).into());
    };
    let children = load_children(&caller.db, &row_ids(std::slice::from_ref(&row))).await?;
    ok(to_public(&row, &children))
}

/// Writes belong in the platform. Still 401 without a session, like the
/// other read-only resources.
fn reject_writes(request: &Request) -> Response {
    if request.extensions().get::<ApiSession>().is_none() {
        return unauthorized("Unauthorized").into_response();
    }
    let body = json!({
        "error": {
            "code": "METHOD_NOT_ALLOWED",
            "message": "The legal entities resource is read-only through the public API. Create and change legal entities in WeldSuite (Settings > Legal entities).",
        }
    });
    let mut response = (StatusCode::METHOD_NOT_ALLOWED, axum::Json(body)).into_response();
    response.headers_mut().insert(
        http::header::ALLOW,
        http::HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    response
}

fn writes() -> MethodRouter<ExternalApiState> {
    let reject = |request: Request| async move { reject_writes(&request) };
    axum::routing::post(reject)
        .put(reject)
        .patch(reject)
        .delete(reject)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_iban_keeps_only_its_last_four_characters() {
        assert_eq!(
            mask_iban(Some("NL91 ABNA 0417 1643 00")),
            json!("**************4300")
        );
        assert_eq!(mask_iban(Some("NL91")), json!("NL91"));
        assert_eq!(mask_iban(None), Value::Null);
        assert_eq!(mask_iban(Some("")), Value::Null);
    }

    #[test]
    fn the_public_shape_masks_and_maps_the_row() {
        let row = json!({
            "id": "ent_1",
            "name": "Acme",
            "dba": "Acme Trading",
            "branding": { "logoUrl": "https://x/l.png", "footerText": "hidden" },
            "isDefault": true,
            "isActive": null,
        });
        let children = Children {
            registrations: HashMap::new(),
            bank_accounts: HashMap::new(),
        };
        let public = to_public(&row, &children);
        assert_eq!(public["tradingName"], "Acme Trading");
        assert_eq!(public["branding"], json!({ "logoUrl": "https://x/l.png" }));
        assert_eq!(public["isActive"], true);
        assert_eq!(public["registrations"], json!([]));
        assert_eq!(public["legalForm"], Value::Null);
    }
}
