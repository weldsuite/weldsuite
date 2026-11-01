//! `/api/payroll` (`routes/payroll/{index,imports,connections}.ts`): payroll
//! journal imports. Payroll itself stays in Gusto, ADP and the like;
//! WeldBooks imports each payroll's journal, one entry per payroll.
//!
//!   /imports       CSV import (summary or general-ledger shape), list, detail, reverse
//!   /connections   Gusto connection, account mapping, sync
//!   /csv-mapping   the entity's saved CSV mapping
//!   /categories    the payroll categories an account mapping can set
//!
//! The posting itself is `weldsuite_books_domain::payroll` (shared with hr's
//! in-process WeldHR import).

mod connections;
mod csv;
mod csv_import;
mod journal;
mod mapping;

use std::fmt::Write as _;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{delete, get, post, put};
use base64::Engine;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::dates::is_iso_date;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, created, ok, paged, validate};
use weldsuite_books_domain::js::parse_int;
use weldsuite_books_domain::payroll::{PAYROLL_CATEGORIES, reverse_payroll_import};
use weldsuite_books_domain::posting::{PostError, load_entity_accounts};
use weldsuite_books_domain::tables::{PAYROLL_CONNECTIONS, PAYROLL_IMPORTS};
use weldsuite_catalogs::entity_events::{
    PAYROLL_CONNECTION_CREATED, PAYROLL_CONNECTION_UPDATED, PAYROLL_IMPORT_CREATED,
    PAYROLL_IMPORT_DELETED,
};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use csv_import::{CsvImportArgs, ImportError, import_payroll_csv, problems_message};
use journal::payroll_error;
use mapping::{CsvMapping, Deferred, expand_csv_mapping, read_mapping};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/categories",
            get(categories).route_layer(need("journal:read")),
        )
        .route(
            "/csv-mapping",
            get(get_csv_mapping).route_layer(need("journal:read")),
        )
        .route(
            "/csv-mapping",
            put(put_csv_mapping).route_layer(need("journal:update")),
        )
        .route(
            "/imports",
            get(list_imports).route_layer(need("journal:read")),
        )
        .route(
            "/imports/csv",
            post(import_csv).route_layer(need("journal:create")),
        )
        .route(
            "/imports/{id}",
            get(import_detail).route_layer(need("journal:read")),
        )
        .route(
            "/imports/{id}",
            delete(reverse_import).route_layer(need("journal:delete")),
        )
        .route(
            "/connections",
            get(connections::list).route_layer(need("journal:read")),
        )
        .route(
            "/connections",
            post(connections::create).route_layer(need("journal:create")),
        )
        .route(
            "/connections/{id}/mapping",
            put(connections::set_mapping).route_layer(need("journal:update")),
        )
        .route(
            "/connections/{id}/sync",
            post(connections::sync).route_layer(need("journal:create")),
        )
        .route(
            "/connections/{id}",
            delete(connections::disconnect).route_layer(need("journal:delete")),
        )
        .with_state(state)
}

/// Why a payroll route did not succeed (`failPayroll`).
#[derive(Debug)]
pub(crate) enum Fail {
    /// `PayrollCsvValidationError`.
    Rows(Vec<(usize, String)>),
    /// `PayrollImportError`, `PostingError`, a closed or locked period, the database.
    Post(PostError),
    /// `GustoApiError`.
    Gusto { status: u16, message: String },
    /// A response the route writes itself.
    Refusal(Refusal),
}

impl From<PostError> for Fail {
    fn from(error: PostError) -> Self {
        Self::Post(error)
    }
}

impl From<sqlx::Error> for Fail {
    fn from(error: sqlx::Error) -> Self {
        Self::Post(PostError::Database(error))
    }
}

impl From<Refusal> for Fail {
    fn from(refusal: Refusal) -> Self {
        Self::Refusal(refusal)
    }
}

impl From<ImportError> for Fail {
    fn from(error: ImportError) -> Self {
        match error {
            ImportError::Rows(problems) => Self::Rows(problems),
            ImportError::Post(error) => Self::Post(error),
        }
    }
}

/// `failPayroll(c, err, what)` (and the connections' `fail`, which answers a
/// Gusto refusal first).
pub(crate) fn fail(result: Result<Response, Fail>, what: &str) -> Response {
    let refusal = match result {
        Ok(response) => return response,
        Err(Fail::Rows(problems)) => Refusal::bad_request_with(
            problems_message(&problems),
            json!({ "problems": problems.iter().map(|(row, message)| json!({ "row": row, "message": message })).collect::<Vec<_>>() }),
        ),
        Err(Fail::Gusto { status, message }) => {
            if matches!(status, 401 | 403 | 404) {
                Refusal::bad_request(message)
            } else {
                ApiError::bad_gateway().with_message(message).into()
            }
        }
        Err(Fail::Post(error)) => match error.user_message() {
            Some(message) => match (&error, message.strip_suffix(" not found")) {
                (PostError::Posting(_), Some(resource)) => {
                    ApiError::not_found(resource, None).into()
                }
                _ => Refusal::bad_request(message),
            },
            None => match error {
                PostError::Database(error) => Refusal::Database(error),
                other => Refusal::Internal(other.to_string()),
            },
        },
        Err(Fail::Refusal(refusal)) => refusal,
    };
    refusal.respond(&format!("Failed to {what}"))
}

// ── GET /categories ─────────────────────────────────────────────────────────

async fn categories() -> Response {
    ok(Value::Array(
        PAYROLL_CATEGORIES
            .iter()
            .map(|(key, label)| {
                json!({
                    "key": key,
                    "label": label,
                    "side": if ["employee_taxes", "employee_deductions", "payroll_liabilities", "net_pay"].contains(key) { "credit" } else { "debit" },
                    "required": *key == "net_pay",
                })
            })
            .collect(),
    ))
}

// ── the saved CSV mapping (the `csv` pseudo connection) ─────────────────────

async fn load_csv_connection(
    caller: &Caller,
    entity_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payroll_connections),
        " from payroll_connections t where t.entity_id = $1 and t.provider = 'csv' \
         and t.deleted_at is null limit 1"
    ))
    .bind(entity_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|row| PAYROLL_CONNECTIONS.js(row)))
}

/// `loadSavedCsvMapping(db, entityId)`.
async fn load_saved_csv_mapping(
    caller: &Caller,
    entity_id: &str,
) -> Result<Option<CsvMapping>, sqlx::Error> {
    let row = load_csv_connection(caller, entity_id).await?;
    Ok(expand_csv_mapping(
        row.as_ref().and_then(|r| r.get("accountMapping")),
    ))
}

/// `assertCsvMappingAccounts(db, entityId, mapping)`.
async fn assert_csv_mapping_accounts(
    caller: &Caller,
    entity_id: &str,
    mapping: &CsvMapping,
) -> Result<(), PostError> {
    let accounts = load_entity_accounts(&caller.db, entity_id).await?;
    for (key, account_id) in &mapping.accounts {
        if accounts.by_id(Some(account_id)).is_none() {
            return Err(payroll_error(if mapping.shape == "summary" {
                format!("The account mapped to {key} does not belong to this accounting entity")
            } else {
                format!("The account mapped to \"{key}\" does not belong to this accounting entity")
            }));
        }
    }
    Ok(())
}

/// `saveCsvMapping(db, entityId, mapping)`: the row and whether it is new.
async fn save_csv_mapping(
    caller: &Caller,
    entity_id: &str,
    mapping: &CsvMapping,
) -> Result<(Value, bool), PostError> {
    assert_csv_mapping_accounts(caller, entity_id, mapping).await?;
    let flat = mapping.flatten();
    let now = weldsuite_books_domain::http::now();
    if let Some(mut existing) = load_csv_connection(caller, entity_id).await? {
        let id = existing["id"].as_str().unwrap_or_default().to_owned();
        sqlx::query(
            "update payroll_connections set account_mapping = $1, updated_at = $2::timestamp where id = $3",
        )
        .bind(&flat)
        .bind(&now)
        .bind(&id)
        .execute(&caller.db)
        .await?;
        existing["accountMapping"] = flat;
        existing["updatedAt"] = json!(now);
        return Ok((existing, false));
    }
    let id = weldsuite_kit::generate_id("prc");
    let row = json!({
        "id": id,
        "createdAt": now,
        "updatedAt": now,
        "deletedAt": null,
        "entityId": entity_id,
        "provider": "csv",
        "providerCompanyId": null,
        "credentialsEncrypted": null,
        "accountMapping": flat,
        "status": "active",
        "lastSyncedAt": null,
        "lastError": null,
    });
    let values = PAYROLL_CONNECTIONS.values(row.as_object().expect("an object"));
    PAYROLL_CONNECTIONS.insert_raw(&caller.db, values).await?;
    Ok((row, true))
}

fn read_mapping_body(issues: &mut Issues, body: &Map<String, Value>) -> Option<CsvMapping> {
    let mut deferred = Deferred::new();
    let mapping = read_mapping(issues, body, &mut deferred);
    for (path, message) in &deferred {
        issues.custom_at(path, message);
    }
    mapping
}

async fn get_csv_mapping(caller: Caller) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Ok(ok(Value::Null));
        };
        let mapping = load_saved_csv_mapping(&caller, &entity_id).await?;
        Ok(ok(mapping.map_or(Value::Null, |m| m.json())))
    }
    .await;
    fail(result, "read the CSV mapping")
}

async fn put_csv_mapping(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mapping = match validate(&headers, &body, read_mapping_body) {
        Ok(Some(mapping)) => mapping,
        Ok(None) => {
            return Refusal::Internal("unreadable mapping".to_owned())
                .respond("Failed to save the CSV mapping");
        }
        Err(refusal) => return refusal.respond("Failed to save the CSV mapping"),
    };
    let result =
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Err(Refusal::bad_request("No accounting entity resolved").into());
            };
            let (row, created) = save_csv_mapping(&caller, &entity_id, &mapping).await?;
            let id = row["id"].as_str().unwrap_or_default().to_owned();
            let action = if created { "created" } else { "updated" };
            write_accounting_audit(
                &caller,
                &caller.db,
                AuditInput {
                    accounting_entity_id: Some(&entity_id),
                    entity_type: "payroll_connection",
                    entity_id: &id,
                    action,
                    changes: None,
                },
            )
            .await;
            caller.publish(
            &state,
            if created { PAYROLL_CONNECTION_CREATED } else { PAYROLL_CONNECTION_UPDATED },
            &id,
            json!({ "id": id, "entityId": entity_id, "provider": "csv", "status": row["status"] }),
        );
            Ok(ok(mapping.json()))
        }
        .await;
    fail(result, "save the CSV mapping")
}

// ── /imports ────────────────────────────────────────────────────────────────

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `decodeURIComponent`; `None` where it throws.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn encode_cursor(pay_date: &str, id: &str) -> String {
    let json = Value::Array(vec![json!(pay_date), json!(id)]).to_string();
    base64::engine::general_purpose::STANDARD.encode(encode_uri_component(&json))
}

fn decode_cursor(cursor: &str) -> Option<(String, String)> {
    // `atob` ignores ASCII whitespace and accepts unpadded input.
    let cleaned: String = cursor
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&cleaned)
        .or_else(|_| {
            base64::engine::general_purpose::STANDARD_NO_PAD.decode(cleaned.trim_end_matches('='))
        })
        .ok()?;
    // `atob` yields one character per byte.
    let text: String = bytes.iter().map(|b| char::from(*b)).collect();
    let decoded = decode_uri_component(&text)?;
    let parsed: Value = serde_json::from_str(&decoded).ok()?;
    match parsed.as_array().map(Vec::as_slice) {
        Some([Value::String(date), Value::String(id), ..]) => Some((date.clone(), id.clone())),
        _ => None,
    }
}

fn import_event(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "entityId": row["entityId"],
        "source": row["source"],
        "payDate": row["payDate"],
        "status": row["status"],
        "journalEntryId": row["journalEntryId"],
    })
}

async fn list_imports(caller: Caller) -> Response {
    fail(list_import_rows(&caller).await, "list payroll imports")
}

async fn list_import_rows(caller: &Caller) -> Result<Response, Fail> {
    let q = caller.query();
    let limit = parse_int(q.present("limit").unwrap_or("50"))
        .filter(|n| *n != 0)
        .unwrap_or(50)
        .clamp(1, 200);
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let status = q.present("status");
    let source = q.present("source");
    let from = q.present("from");
    if from.is_some_and(|d| !is_iso_date(d)) {
        return Err(Refusal::bad_request("from must be a date (YYYY-MM-DD)").into());
    }
    let to = q.present("to");
    if to.is_some_and(|d| !is_iso_date(d)) {
        return Err(Refusal::bad_request("to must be a date (YYYY-MM-DD)").into());
    }
    let total: i32 = sqlx::query_scalar(
        "select count(*)::int from payroll_imports where entity_id = $1 \
         and ($2::text is null or status = $2) and ($3::text is null or source = $3) \
         and ($4::date is null or pay_date >= $4::date) and ($5::date is null or pay_date <= $5::date)",
    )
    .bind(&entity_id)
    .bind(status)
    .bind(source)
    .bind(from)
    .bind(to)
    .fetch_one(&caller.db)
    .await?;
    let cursor = match q.present("cursor") {
        Some(cursor) => match decode_cursor(cursor) {
            Some(decoded) => Some(decoded),
            None => return Err(Refusal::bad_request("Invalid cursor").into()),
        },
        None => None,
    };
    let (cursor_date, cursor_id) = cursor.unzip();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payroll_imports),
        " from payroll_imports t where t.entity_id = $1 \
         and ($2::text is null or t.status = $2) and ($3::text is null or t.source = $3) \
         and ($4::date is null or t.pay_date >= $4::date) and ($5::date is null or t.pay_date <= $5::date) \
         and ($6::date is null or (t.pay_date, t.id) < ($6::date, $7)) \
         order by t.pay_date desc, t.id desc limit $8"
    ))
    .bind(&entity_id)
    .bind(status)
    .bind(source)
    .bind(from)
    .bind(to)
    .bind(cursor_date)
    .bind(cursor_id)
    .bind(limit + 1)
    .fetch_all(&caller.db)
    .await?;
    let mut rows = PAYROLL_IMPORTS.js_rows(rows);
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    if has_more {
        rows.truncate(usize::try_from(limit).unwrap_or(0));
    }
    let next = has_more.then(|| rows.last()).flatten().map(|row| {
        encode_cursor(
            row["payDate"].as_str().unwrap_or_default(),
            row["id"].as_str().unwrap_or_default(),
        )
    });
    Ok(paged(rows, i64::from(total), has_more, next))
}

/// `csvImportSchema`.
struct CsvImportBody {
    csv: String,
    mapping: Option<CsvMapping>,
    save_mapping: bool,
    period_start: Option<String>,
    period_end: Option<String>,
    source_file_name: Option<String>,
    batch_label: Option<String>,
    dry_run: bool,
}

fn read_import_body(issues: &mut Issues, body: &Map<String, Value>) -> Option<CsvImportBody> {
    let csv = issues.text_with(
        body,
        "csv",
        Presence::Required,
        Text::length(Some(1), Some(5_000_000)),
    );
    let mut deferred = Deferred::new();
    let mapping = issues.nested(body, "mapping", Presence::Optional, |issues, fields| {
        let mut inner = Deferred::new();
        let mapping = read_mapping(issues, fields, &mut inner);
        deferred.extend(inner.into_iter().map(|(mut path, message)| {
            path.insert(0, json!("mapping"));
            (path, message)
        }));
        mapping
    });
    let save_mapping = issues.boolean(body, "saveMapping", Presence::Optional);
    let day = |issues: &mut Issues, key: &str| {
        issues
            .pattern(
                body,
                key,
                Presence::Nullish,
                None,
                None,
                is_iso_shape,
                "Invalid",
            )
            .into_option()
    };
    let period_start = day(issues, "periodStart");
    let period_end = day(issues, "periodEnd");
    let source_file_name = issues
        .text(body, "sourceFileName", Presence::Nullish, None, Some(255))
        .into_option();
    let batch_label = issues
        .text(body, "batchLabel", Presence::Nullish, None, Some(100))
        .into_option();
    let dry_run = issues.boolean(body, "dryRun", Presence::Optional);
    for (path, message) in &deferred {
        issues.custom_at(path, message);
    }
    Some(CsvImportBody {
        csv: csv.into_option()?,
        mapping: match mapping {
            weldsuite_kit::validation::Field::Set(mapping) => Some(mapping?),
            _ => None,
        },
        save_mapping: save_mapping.into_option().unwrap_or(false),
        period_start,
        period_end,
        source_file_name,
        batch_label,
        dry_run: dry_run.into_option().unwrap_or(false),
    })
}

/// `/^\d{4}-\d{2}-\d{2}$/`
fn is_iso_shape(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

async fn import_csv(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_import_body) {
        Ok(Some(data)) => data,
        Ok(None) => {
            return Refusal::Internal("unreadable body".to_owned())
                .respond("Failed to import the payroll CSV");
        }
        Err(refusal) => return refusal.respond("Failed to import the payroll CSV"),
    };
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved").into());
        };
        let mapping = match &data.mapping {
            Some(mapping) => mapping.clone(),
            None => match load_saved_csv_mapping(&caller, &entity_id).await? {
                Some(mapping) => mapping,
                None => {
                    return Err(Refusal::bad_request(
                        "Send a mapping, or save one first (PUT /api/payroll/csv-mapping)",
                    )
                    .into());
                }
            },
        };
        let result = import_payroll_csv(
            &caller.db,
            CsvImportArgs {
                entity_id: &entity_id,
                user_id: Some(caller.user_id.clone()),
                csv: &data.csv,
                mapping: &mapping,
                period_start: data.period_start.clone(),
                period_end: data.period_end.clone(),
                source_file_name: data.source_file_name.clone(),
                batch_label: data.batch_label.clone(),
                dry_run: data.dry_run,
            },
        )
        .await?;
        if !data.dry_run {
            for imported in &result.imports {
                let Some(import_id) = imported.import_id.as_deref() else {
                    continue;
                };
                write_accounting_audit(
                    &caller,
                    &caller.db,
                    AuditInput {
                        accounting_entity_id: Some(&entity_id),
                        entity_type: "payroll_import",
                        entity_id: import_id,
                        action: "created",
                        changes: None,
                    },
                )
                .await;
                caller.publish(
                    &state,
                    PAYROLL_IMPORT_CREATED,
                    import_id,
                    json!({
                        "id": import_id,
                        "entityId": entity_id,
                        "source": "csv",
                        "payDate": imported.pay_date,
                        "status": "posted",
                        "journalEntryId": imported.journal_entry_id,
                    }),
                );
            }
            if data.save_mapping
                && let Some(sent) = &data.mapping
                && result.imports.len() + result.duplicates.len() > 0
            {
                let (row, created) = save_csv_mapping(&caller, &entity_id, sent).await?;
                let id = row["id"].as_str().unwrap_or_default().to_owned();
                caller.publish(
                    &state,
                    if created { PAYROLL_CONNECTION_CREATED } else { PAYROLL_CONNECTION_UPDATED },
                    &id,
                    json!({ "id": id, "entityId": entity_id, "provider": "csv", "status": row["status"] }),
                );
            }
        }
        Ok(if data.dry_run {
            ok(result.json())
        } else {
            created(result.json())
        })
    }
    .await;
    fail(result, "import the payroll CSV")
}

/// An entry line with its account: id, code, name, debit, credit, description.
type EntryLineRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// `loadImport(db, id)`.
async fn load_import(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payroll_imports),
        " from payroll_imports t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|row| PAYROLL_IMPORTS.js(row)))
}

async fn import_detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(mut row) = load_import(&caller, &id).await? else {
            return Err(Refusal::not_found("Payroll import", &id).into());
        };
        let lines: Vec<Value> = match row["journalEntryId"].as_str().filter(|e| !e.is_empty()) {
            Some(entry_id) => {
                let rows: Vec<EntryLineRow> =
                    sqlx::query_as(
                        "select jl.account_id, a.code, a.name, jl.debit::text, jl.credit::text, jl.description \
                         from journal_lines jl inner join accounts a on jl.account_id = a.id \
                         where jl.journal_entry_id = $1 order by jl.sort_order",
                    )
                    .bind(entry_id)
                    .fetch_all(&caller.db)
                    .await?;
                rows.into_iter()
                    .map(|(account_id, code, name, debit, credit, description)| {
                        json!({
                            "accountId": account_id,
                            "accountCode": code,
                            "accountName": name,
                            "debit": debit,
                            "credit": credit,
                            "description": description,
                        })
                    })
                    .collect()
            }
            None => Vec::new(),
        };
        row["lines"] = Value::Array(lines);
        Ok(ok(row))
    }
    .await;
    fail(result, "fetch the payroll import")
}

async fn reverse_import(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let date = caller
            .query()
            .get("date")
            .map(str::to_owned)
            .filter(|d| !d.is_empty());
        if date.as_deref().is_some_and(|d| !is_iso_date(d)) {
            return Err(Refusal::bad_request("date must be a date (YYYY-MM-DD)").into());
        }
        let Some(row) = load_import(&caller, &id).await? else {
            return Err(Refusal::not_found("Payroll import", &id).into());
        };
        let reversed =
            reverse_payroll_import(&caller.db, &id, Some(caller.user_id.clone()), date).await?;
        let mut changes = Map::new();
        changes.insert(
            "status".to_owned(),
            change(row["status"].clone(), json!("reversed")),
        );
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: row["entityId"].as_str(),
                entity_type: "payroll_import",
                entity_id: &id,
                action: "reversed",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(&state, PAYROLL_IMPORT_DELETED, &id, import_event(&reversed));
        Ok(ok(reversed))
    }
    .await;
    fail(result, "reverse the payroll import")
}
