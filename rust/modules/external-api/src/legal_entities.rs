//! Legal entities on the public API (`routes/v1/legal-entities/index.ts`):
//! `GET /v1/legal-entities` and `GET /v1/legal-entities/:id`, scope
//! `legal_entities:read`. Read-only.
//!
//! The companies of the workspace (`docs/plans/legal-entities.md`) with their
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
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::Issues;

use crate::ExternalApiState;
use crate::crud::{Answer, Caller, ok};
use crate::list::{ListQuery, list_rows, list_sql};
use crate::session::{ApiSession, not_found, unauthorized};
use crate::simple::scoped;

const READ_SCOPE: &str = "legal_entities:read";

/// The columns an entity is answered from: never the ciphertext ones.
macro_rules! entity_row {
    () => {
        "jsonb_build_object('id', t.id, 'name', t.name, 'legal_name', t.legal_name, 'dba', t.dba, \
         'entity_type', t.entity_type, 'jurisdiction_code', t.jurisdiction_code, \
         'base_currency', t.base_currency, 'locale', t.locale, 'timezone', t.timezone, \
         'address', t.address, 'contact', t.contact, 'branding', t.branding, \
         'fiscal_year_start', t.fiscal_year_start, 'is_default', t.is_default, \
         'is_active', t.is_active, 'created_at', t.created_at, 'updated_at', t.updated_at)"
    };
}

/// The page of ids; the rows are read with [`entity_row!`] after.
const LIST: (&str, &str) = list_sql!(
    "entities",
    "jsonb_build_object('id', t.id)",
    "t.deleted_at is null"
);

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

async fn load_children(db: &PgPool, ids: &[String]) -> Result<Children, sqlx::Error> {
    let mut children = Children {
        registrations: HashMap::new(),
        bank_accounts: HashMap::new(),
    };
    if ids.is_empty() {
        return Ok(children);
    }
    let registrations: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', t.id, 'entity_id', t.entity_id, 'type', t.type,
                'number', t.number, 'country', t.country, 'region', t.region, 'label', t.label,
                'valid_from', t.valid_from, 'valid_to', t.valid_to, 'is_primary', t.is_primary)
         from legal_entity_registrations t
         where t.entity_id = any($1) and t.deleted_at is null
         order by t.created_at asc",
    )
    .bind(ids)
    .fetch_all(db)
    .await?;
    for row in registrations {
        let Value::Object(row) = js_row(row) else {
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
    let accounts: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', t.id, 'entity_id', t.entity_id, 'name', t.name,
                'account_holder_name', t.account_holder_name, 'iban', t.iban, 'bic', t.bic,
                'bank_name', t.bank_name, 'currency', t.currency, 'account_type', t.account_type,
                'is_default', t.is_default, 'is_active', t.is_active)
         from bank_accounts t
         where t.entity_id = any($1) and t.deleted_at is null
         order by t.created_at asc",
    )
    .bind(ids)
    .fetch_all(db)
    .await?;
    for row in accounts {
        let Value::Object(row) = js_row(row) else {
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
    let mut page = list_rows(&caller.db, LIST, &query, &json!({})).await?;
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

/// The entities of a page, by id, as Drizzle reads their columns.
async fn load_entities(db: &PgPool, ids: &[String]) -> Result<HashMap<String, Value>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        entity_row!(),
        " from entities t where t.id = any($1)"
    ))
    .bind(ids)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(js_row)
        .filter_map(|row| Some((row.get("id")?.as_str()?.to_owned(), row)))
        .collect())
}

/// `GET /:id`: a live entity.
async fn detail(caller: Caller, Path(id): Path<String>) -> Answer {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        entity_row!(),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(&id)
    .fetch_optional(&caller.db)
    .await?;
    let Some(row) = row.map(js_row) else {
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
