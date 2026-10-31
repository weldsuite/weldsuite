//! Expense declarations and their receipts (`routes/weldhr/declarations.ts`,
//! `services/weldhr/declarations.ts`):
//!
//! ```text
//! pending → approved → paid
//!         ↘ rejected
//! pending / approved → cancelled
//! ```
//!
//! The receipt is one private object per declaration in hr-api's `STORAGE`
//! bucket, under the workspace prefix; it is only ever streamed back through
//! the routes.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{FromRequest, Multipart, Path, RawQuery, Request, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    HR_DECLARATION_APPROVED, HR_DECLARATION_CREATED, HR_DECLARATION_DELETED, HR_DECLARATION_PAID,
    HR_DECLARATION_REJECTED, HR_DECLARATION_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    DECLARATIONS_APPROVE, DECLARATIONS_CREATE, DECLARATIONS_DELETE, DECLARATIONS_READ,
    DECLARATIONS_UPDATE,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynFileStore, PutOptions};

use crate::employees::{display_name_of, require_employee};
use crate::fields::{Fields, id, iso_date};
use crate::{
    Caller, HrError, HrResult, HrState, add_days, hr_json, js_number, js_round, js_to_fixed,
    member_names, now, query_date, query_text, query_values, text, today_iso,
};

const CATEGORIES: [&str; 6] = ["travel", "meals", "accommodation", "equipment", "training", "other"];
const CURRENCIES: [&str; 3] = ["EUR", "USD", "GBP"];
const RECEIPT_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const RECEIPT_MAX_BYTES: usize = 10 * 1024 * 1024;

/// The routes, relative to `/api/weldhr`.
pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let approve = || gate.require([DECLARATIONS_APPROVE]);
    Router::new()
        .route("/declarations", get(list).route_layer(gate.require([DECLARATIONS_READ])))
        .route("/declarations", post(create).route_layer(gate.require([DECLARATIONS_CREATE])))
        .route("/declarations/{id}", patch(update).route_layer(gate.require([DECLARATIONS_UPDATE])))
        .route("/declarations/{id}/review", post(review).route_layer(approve()))
        .route("/declarations/{id}/pay", post(pay).route_layer(approve()))
        .route("/declarations/{id}/cancel", post(cancel).route_layer(gate.require([DECLARATIONS_UPDATE])))
        .route("/declarations/{id}", delete(remove).route_layer(gate.require([DECLARATIONS_DELETE])))
        .route(
            "/declarations/{id}/receipt",
            post(upload_receipt).route_layer(gate.require([DECLARATIONS_CREATE, DECLARATIONS_UPDATE])),
        )
        .route(
            "/declarations/{id}/receipt",
            get(download_receipt).route_layer(gate.require([DECLARATIONS_READ])),
        )
}

/// `toPublicDeclaration(row)`: the amount as a number, `hasReceipt` instead
/// of the storage key.
pub(crate) fn to_public_declaration(row: &Value) -> Value {
    let mut out = row.clone();
    if let Some(map) = out.as_object_mut() {
        let key = map.remove("receiptFileKey");
        let has_receipt = matches!(key, Some(Value::String(ref k)) if !k.is_empty());
        let amount = match map.get("amount") {
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            Some(Value::String(s)) => crate::js_number_of(s),
            _ => f64::NAN,
        };
        map.insert("amount".to_owned(), js_number(amount));
        map.insert("hasReceipt".to_owned(), Value::Bool(has_receipt));
    }
    out
}

/// "Not in the future", with a day of slack for clients east of UTC.
fn assert_expense_date(expense_date: &str) -> Result<(), HrError> {
    if expense_date > add_days(&today_iso(), 1).as_str() {
        return Err(HrError::validation("The expense date cannot be in the future"));
    }
    Ok(())
}

/// `requireDeclaration(db, id, onlyEmployeeId?)`.
pub(crate) async fn require_declaration(db: &PgPool, id: &str, only_employee_id: Option<&str>) -> Result<Value, HrError> {
    let row: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from hr_declarations t where t.id = $1 limit 1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    match row.map(js_row) {
        Some(row) if only_employee_id.is_none_or(|only| row["employeeId"] == only) => Ok(row),
        _ => Err(HrError::not_found("Declaration", id)),
    }
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let split = |key: &str| -> Option<Vec<String>> {
        query_text(&q, key).map(|v| v.split(',').map(str::to_owned).collect())
    };
    let rows: Vec<(Value, Value)> = sqlx::query_as(
        "select to_jsonb(d), jsonb_build_object('firstName', e.first_name, 'lastName', e.last_name,
             'preferredName', e.preferred_name)
         from hr_declarations d join hr_employees e on e.id = d.employee_id
         where e.deleted_at is null
           and ($1::text is null or d.employee_id = $1)
           and ($2::text[] is null or d.status = any($2))
           and ($3::text[] is null or d.category = any($3))
           and ($4::text is null or d.expense_date >= $4::date)
           and ($5::text is null or d.expense_date <= $5::date)
         order by d.expense_date desc, d.created_at desc
         limit 1000",
    )
    .bind(query_text(&q, "employeeId"))
    .bind(split("status"))
    .bind(split("category"))
    .bind(query_date(&q, "from"))
    .bind(query_date(&q, "to"))
    .fetch_all(&caller.db)
    .await?;
    let reviewers: Vec<Option<&str>> = rows.iter().map(|(d, _)| d["reviewed_by"].as_str()).collect();
    let names = member_names(&caller.db, &reviewers).await?;
    let data: Vec<Value> = rows
        .into_iter()
        .map(|(declaration, employee)| {
            let declaration = js_row(declaration);
            let reviewer = declaration["reviewedBy"]
                .as_str()
                .filter(|r| !r.is_empty())
                .and_then(|r| names.get(r).cloned());
            let mut row = to_public_declaration(&declaration);
            if let Some(map) = row.as_object_mut() {
                map.insert("employeeName".to_owned(), json!(display_name_of(&employee)));
                map.insert("reviewedByName".to_owned(), json!(reviewer));
            }
            row
        })
        .collect();
    Ok(Data(data).into_response())
}

/// `declarationFields`, read with `partial` for the update schema.
struct DeclarationFields {
    expense_date: Field<String>,
    category: Field<String>,
    description: Field<String>,
    amount: Field<f64>,
    currency: Field<String>,
}

/// `declarationAmount`: positive, at most a million, at most two decimals.
fn amount(issues: &mut Issues, fields: &Fields, presence: Presence) -> Field<f64> {
    let field = issues.number(fields, "amount", presence, Number { coerce: false, int: false, min: None, max: None });
    let Field::Set(value) = field else {
        return field;
    };
    let mut ok = true;
    if value <= 0.0 {
        let path = issues.path_of("amount");
        issues.push_issue(
            "amount",
            json!({ "code": "too_small", "minimum": 0, "type": "number", "inclusive": false,
                    "exact": false, "message": "Number must be greater than 0", "path": path }),
        );
        ok = false;
    }
    if value > 1_000_000.0 {
        let path = issues.path_of("amount");
        issues.push_issue(
            "amount",
            json!({ "code": "too_big", "maximum": 1_000_000, "type": "number", "inclusive": true,
                    "exact": false, "message": "Number must be less than or equal to 1000000", "path": path }),
        );
        ok = false;
    }
    if ok { Field::Set(value) } else { Field::Absent }
}

/// The two-decimals refinement, settled after the other fields.
fn amount_refine(issues: &mut Issues, fields: &Fields) {
    if let Some(Value::Number(n)) = fields.get("amount") {
        let value = n.as_f64().unwrap_or(f64::NAN);
        if !((value * 100.0 - js_round(value * 100.0)).abs() < 1e-6) {
            issues.custom("amount", "Use at most two decimals");
        }
    }
}

fn declaration_fields(issues: &mut Issues, fields: &Fields, partial: bool) -> DeclarationFields {
    let required = if partial { Presence::Optional } else { Presence::Required };
    let out = DeclarationFields {
        expense_date: iso_date(issues, fields, "expenseDate", required),
        category: issues.choice(fields, "category", required, &CATEGORIES),
        description: issues.text_with(fields, "description", required, Text::trimmed(Some(1), Some(2000))),
        amount: amount(issues, fields, required),
        currency: issues.choice(fields, "currency", Presence::Optional, &CURRENCIES),
    };
    out
}

/// `createDeclaration(db, input, submittedBy)`.
pub(crate) async fn create_declaration(
    db: &PgPool,
    employee_id: &str,
    fields: &DeclarationInput,
    submitted_by: &str,
) -> Result<Value, HrError> {
    assert_expense_date(&fields.expense_date)?;
    require_employee(db, employee_id).await?;
    let row: Value = sqlx::query_scalar(
        "insert into hr_declarations
             (id, employee_id, expense_date, category, description, amount, currency, status, submitted_by)
         values ($1, $2, $3::date, $4, $5, $6::numeric, $7, 'pending', $8)
         returning to_jsonb(hr_declarations)",
    )
    .bind(generate_id("hrdcl"))
    .bind(employee_id)
    .bind(&fields.expense_date)
    .bind(&fields.category)
    .bind(&fields.description)
    .bind(js_to_fixed(fields.amount, 2))
    .bind(fields.currency.as_deref().unwrap_or("EUR"))
    .bind(submitted_by)
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

/// A complete declaration (`declarationFields` with every field present).
pub(crate) struct DeclarationInput {
    pub(crate) expense_date: String,
    pub(crate) category: String,
    pub(crate) description: String,
    pub(crate) amount: f64,
    pub(crate) currency: Option<String>,
}

/// `hrSelfDeclarationSchema` (or the create schema with `employeeId` first).
pub(crate) fn declaration_body(
    headers: &HeaderMap,
    body: &Bytes,
    with_employee: bool,
) -> Result<(Option<String>, DeclarationInput), HrError> {
    hr_json(headers, body, |issues, fields| {
        let employee = if with_employee {
            id(issues, fields, "employeeId", Presence::Required).into_option()
        } else {
            None
        };
        let read = declaration_fields(issues, fields, false);
        amount_refine(issues, fields);
        (
            employee,
            DeclarationInput {
                expense_date: read.expense_date.into_option().unwrap_or_default(),
                category: read.category.into_option().unwrap_or_default(),
                description: read.description.into_option().unwrap_or_default(),
                amount: read.amount.into_option().unwrap_or_default(),
                currency: read.currency.into_option(),
            },
        )
    })
}

/// The `hr_declaration` event data: `{ id, employeeId, status }`.
fn emit(caller: &Caller, state: &HrState, event: weldsuite_catalogs::entity_events::EventName, row: &Value) {
    caller.emit(
        state,
        event,
        text(row, "id"),
        &[
            ("employeeId", Some(row["employeeId"].clone())),
            ("status", Some(row["status"].clone())),
        ],
    );
}

async fn create(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let (employee, input) = declaration_body(&headers, &body, true)?;
    let row = create_declaration(&caller.db, &employee.unwrap_or_default(), &input, &caller.user_id).await?;
    emit(&caller, &state, HR_DECLARATION_CREATED, &row);
    Ok(Created(to_public_declaration(&row)).into_response())
}

async fn update(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = hr_json(&headers, &body, |issues, fields| {
        let read = declaration_fields(issues, fields, true);
        amount_refine(issues, fields);
        read
    })?;
    let db = &caller.db;
    let existing = require_declaration(db, &id, None).await?;
    if existing["status"] != "pending" {
        return Err(HrError::conflict(format!(
            "This declaration is already {} and can no longer be changed",
            text(&existing, "status")
        )));
    }
    if let Some(date) = input.expense_date.as_set().filter(|d| !d.is_empty()) {
        assert_expense_date(date)?;
    }
    let row: Value = sqlx::query_scalar(
        "update hr_declarations set
             expense_date = coalesce($2::date, expense_date),
             category = coalesce($3, category),
             description = coalesce($4, description),
             amount = coalesce($5::numeric, amount),
             currency = coalesce($6, currency),
             updated_at = $7::timestamp
         where id = $1 returning to_jsonb(hr_declarations)",
    )
    .bind(&id)
    .bind(input.expense_date.as_set())
    .bind(input.category.as_set())
    .bind(input.description.as_set())
    .bind(input.amount.as_set().map(|a| js_to_fixed(*a, 2)))
    .bind(input.currency.as_set())
    .bind(now())
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    emit(&caller, &state, HR_DECLARATION_UPDATED, &row);
    Ok(Data(to_public_declaration(&row)).into_response())
}

async fn review(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let (decision, note) = hr_json(&headers, &body, |issues, fields| {
        (
            issues.choice(fields, "decision", Presence::Required, &["approved", "rejected"]),
            issues.text(fields, "note", Presence::Nullish, None, Some(2000)),
        )
    })?;
    let db = &caller.db;
    let existing = require_declaration(db, &id, None).await?;
    if existing["status"] != "pending" {
        return Err(HrError::conflict(format!(
            "This declaration is already {}",
            text(&existing, "status")
        )));
    }
    let row: Value = sqlx::query_scalar(
        "update hr_declarations set status = $2, review_note = $3, reviewed_by = $4,
             reviewed_at = $5::timestamp, updated_at = $5::timestamp
         where id = $1 returning to_jsonb(hr_declarations)",
    )
    .bind(&id)
    .bind(decision.as_set())
    .bind(note.as_set())
    .bind(&caller.user_id)
    .bind(now())
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    let event = if row["status"] == "approved" {
        HR_DECLARATION_APPROVED
    } else {
        HR_DECLARATION_REJECTED
    };
    emit(&caller, &state, event, &row);
    Ok(Data(to_public_declaration(&row)).into_response())
}

async fn pay(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let db = &caller.db;
    let existing = require_declaration(db, &id, None).await?;
    if existing["status"] != "approved" {
        return Err(HrError::conflict("Only an approved declaration can be marked as paid"));
    }
    let row: Value = sqlx::query_scalar(
        "update hr_declarations set status = 'paid', paid_by = $2, paid_at = $3::timestamp,
             updated_at = $3::timestamp
         where id = $1 returning to_jsonb(hr_declarations)",
    )
    .bind(&id)
    .bind(&caller.user_id)
    .bind(now())
    .fetch_one(db)
    .await?;
    let row = js_row(row);
    emit(&caller, &state, HR_DECLARATION_PAID, &row);
    Ok(Data(to_public_declaration(&row)).into_response())
}

/// `cancelDeclaration(db, id, onlyEmployeeId?)`.
pub(crate) async fn cancel_declaration(db: &PgPool, id: &str, only_employee_id: Option<&str>) -> Result<Value, HrError> {
    let existing = require_declaration(db, id, only_employee_id).await?;
    let status = text(&existing, "status");
    let cancellable = if only_employee_id.is_some() {
        status == "pending"
    } else {
        status == "pending" || status == "approved"
    };
    if !cancellable {
        return Err(HrError::conflict(format!("This declaration is already {status}")));
    }
    let row: Value = sqlx::query_scalar(
        "update hr_declarations set status = 'cancelled', updated_at = $2::timestamp
         where id = $1 returning to_jsonb(hr_declarations)",
    )
    .bind(id)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

async fn cancel(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let row = cancel_declaration(&caller.db, &id, None).await?;
    emit(&caller, &state, HR_DECLARATION_UPDATED, &row);
    Ok(Data(to_public_declaration(&row)).into_response())
}

async fn remove(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let existing = require_declaration(&caller.db, &id, None).await?;
    sqlx::query("delete from hr_declarations where id = $1")
        .bind(&id)
        .execute(&caller.db)
        .await?;
    if let Some(key) = existing["receiptFileKey"].as_str().filter(|k| !k.is_empty()) {
        let storage = receipt_bucket(&caller, &state)?;
        let key = key.to_owned();
        state.events.tracker().spawn(async move {
            if let Err(error) = storage.delete_boxed(&key).await {
                tracing::error!(%error, "hr: deleting a receipt failed");
            }
        });
    }
    caller.emit(
        &state,
        HR_DECLARATION_DELETED,
        text(&existing, "id"),
        &[("employeeId", Some(existing["employeeId"].clone()))],
    );
    Ok(NoContent.into_response())
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/// `receiptBucket(c)`: a missing binding is a deploy error (500).
pub(crate) fn receipt_bucket(caller: &Caller, state: &HrState) -> Result<Arc<dyn DynFileStore>, HrError> {
    caller
        .storage(state)
        .ok_or_else(|| HrError::internal("hr-api is missing its STORAGE (R2) binding"))
}

/// `safeFileName(name)`: characters outside `[a-zA-Z0-9.\-_]` become `_`
/// (one per UTF-16 unit, as the regex replaces), the last 120 kept.
fn safe_file_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('_');
            }
        }
    }
    let cleaned = if out.len() > 120 {
        out[out.len() - 120..].to_owned()
    } else {
        out
    };
    if cleaned.is_empty() {
        "receipt".to_owned()
    } else {
        cleaned
    }
}

/// An uploaded `file` part: name, type and bytes.
pub(crate) struct UploadedFile {
    name: String,
    content_type: String,
    bytes: Vec<u8>,
}

/// `receiptFileFrom(await c.req.parseBody())`: the multipart `file` part
/// (the last one, as Hono keeps it), or the 400.
pub(crate) async fn receipt_file_from(request: Request) -> Result<UploadedFile, HrError> {
    let missing = || HrError::validation("Send the receipt as a multipart \"file\" field");
    let Ok(mut multipart) = Multipart::from_request(request, &()).await else {
        return Err(missing());
    };
    let mut found: Option<Option<UploadedFile>> = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() != Some("file") {
            continue;
        }
        // `FormData` escapes `"`, CR and LF in a part's file name as %22,
        // %0D and %0A; the worker's parser reads them back.
        let name = field
            .file_name()
            .map(|n| n.replace("%22", "\"").replace("%0D", "\r").replace("%0A", "\n"));
        let content_type = field.content_type().unwrap_or_default().to_owned();
        let bytes = field.bytes().await.map_err(|_| missing())?;
        found = Some(name.map(|name| UploadedFile {
            name,
            content_type,
            bytes: bytes.to_vec(),
        }));
    }
    found.flatten().ok_or_else(missing)
}

/// `attachDeclarationReceipt(db, bucket, workspaceId, id, file, onlyEmployeeId?)`.
pub(crate) async fn attach_declaration_receipt(
    caller: &Caller,
    storage: &Arc<dyn DynFileStore>,
    id: &str,
    file: UploadedFile,
    only_employee_id: Option<&str>,
) -> Result<Value, HrError> {
    let db = &caller.db;
    let existing = require_declaration(db, id, only_employee_id).await?;
    if existing["status"] != "pending" {
        return Err(HrError::conflict(format!(
            "This declaration is already {} and its receipt can no longer be changed",
            text(&existing, "status")
        )));
    }
    if !RECEIPT_TYPES.contains(&file.content_type.as_str()) {
        return Err(HrError::validation("A receipt must be a JPEG, PNG or WebP image, or a PDF"));
    }
    if file.bytes.is_empty() {
        return Err(HrError::validation("The receipt file is empty"));
    }
    if file.bytes.len() > RECEIPT_MAX_BYTES {
        return Err(HrError::validation("A receipt can be at most 10 MB"));
    }
    let file_name = safe_file_name(&file.name);
    let random = hex_random();
    let key = format!(
        "workspaces/{}/hr/declarations/{id}/{random}/{file_name}",
        caller.clerk_org_id
    );
    let size = i32::try_from(file.bytes.len()).unwrap_or(i32::MAX);
    storage
        .put_boxed(&key, file.bytes, &PutOptions::content_type(file.content_type.clone()))
        .await
        .map_err(|error| HrError::internal(error.to_string()))?;
    let row: Value = sqlx::query_scalar(
        "update hr_declarations set receipt_file_key = $2, receipt_file_name = $3,
             receipt_content_type = $4, receipt_size = $5, updated_at = $6::timestamp
         where id = $1 returning to_jsonb(hr_declarations)",
    )
    .bind(id)
    .bind(&key)
    .bind(&file_name)
    .bind(&file.content_type)
    .bind(size)
    .bind(now())
    .fetch_one(db)
    .await?;
    if let Some(old) = existing["receiptFileKey"].as_str().filter(|k| !k.is_empty()) {
        storage
            .delete_boxed(old)
            .await
            .map_err(|error| HrError::internal(error.to_string()))?;
    }
    Ok(js_row(row))
}

/// 16 random bytes in hex (`crypto.randomUUID()` without its dashes).
fn hex_random() -> String {
    let token = weldsuite_kit::random_string(32, "0123456789abcdef");
    token
}

/// `loadDeclarationReceipt(…)` and `receiptResponse(…)`: the stored file,
/// streamed with its type, or a 404.
pub(crate) async fn receipt_response(
    caller: &Caller,
    storage: &Arc<dyn DynFileStore>,
    id: &str,
    only_employee_id: Option<&str>,
) -> HrResult {
    let row = require_declaration(&caller.db, id, only_employee_id).await?;
    let prefix = format!("workspaces/{}/hr/declarations/", caller.clerk_org_id);
    let Some(key) = row["receiptFileKey"]
        .as_str()
        .filter(|k| !k.is_empty() && k.starts_with(&prefix))
    else {
        return Err(HrError::not_found("Receipt", id));
    };
    let object = storage
        .get_boxed(key)
        .await
        .map_err(|error| HrError::internal(error.to_string()))?;
    let Some(object) = object else {
        return Err(HrError::not_found("Receipt", id));
    };
    let file_name = row["receiptFileName"].as_str().unwrap_or("receipt").replace('"', "");
    let content_type = row["receiptContentType"]
        .as_str()
        .unwrap_or("application/octet-stream")
        .to_owned();
    let response = Response::builder()
        .status(200)
        .header("content-type", content_type)
        .header("content-disposition", format!("inline; filename=\"{file_name}\""))
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(object.bytes))
        .map_err(|error| HrError::internal(error.to_string()))?;
    Ok(response)
}

async fn upload_receipt(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    request: Request,
) -> HrResult {
    let file = receipt_file_from(request).await?;
    let storage = receipt_bucket(&caller, &state)?;
    let row = attach_declaration_receipt(&caller, &storage, &id, file, None).await?;
    emit(&caller, &state, HR_DECLARATION_UPDATED, &row);
    Ok(Data(to_public_declaration(&row)).into_response())
}

async fn download_receipt(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let storage = receipt_bucket(&caller, &state)?;
    receipt_response(&caller, &storage, &id, None).await
}

/// `employeeDeclarations(db, employeeId)`: the employee's own declarations
/// and what is still open, per currency.
pub(crate) async fn employee_declarations(db: &PgPool, employee_id: &str) -> Result<Value, HrError> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from hr_declarations t where t.employee_id = $1
         order by t.expense_date desc, t.created_at desc limit 500",
    )
    .bind(employee_id)
    .fetch_all(db)
    .await?;
    let declarations: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let d = to_public_declaration(&js_row(row));
            json!({
                "id": d["id"],
                "expenseDate": d["expenseDate"],
                "category": d["category"],
                "description": d["description"],
                "amount": d["amount"],
                "currency": d["currency"],
                "status": d["status"],
                "hasReceipt": d["hasReceipt"],
                "receiptFileName": d["receiptFileName"],
                "reviewNote": d["reviewNote"],
                "reviewedAt": d["reviewedAt"],
                "paidAt": d["paidAt"],
                "createdAt": d["createdAt"],
            })
        })
        .collect();
    // Per currency, in first-seen order; amounts in different currencies are never added.
    let mut totals: Vec<(String, f64, f64)> = Vec::new();
    for d in &declarations {
        let status = text(d, "status");
        if status != "pending" && status != "approved" {
            continue;
        }
        let currency = text(d, "currency").to_owned();
        let amount = d["amount"].as_f64().unwrap_or(f64::NAN);
        let index = match totals.iter().position(|(c, _, _)| *c == currency) {
            Some(index) => index,
            None => {
                totals.push((currency, 0.0, 0.0));
                totals.len() - 1
            }
        };
        let entry = &mut totals[index];
        if status == "pending" {
            entry.1 = js_round((entry.1 + amount) * 100.0) / 100.0;
        } else {
            entry.2 = js_round((entry.2 + amount) * 100.0) / 100.0;
        }
    }
    let open: Vec<Value> = totals
        .into_iter()
        .map(|(currency, pending, approved)| {
            let mut entry = Map::new();
            entry.insert("currency".to_owned(), json!(currency));
            entry.insert("pending".to_owned(), js_number(pending));
            entry.insert("approved".to_owned(), js_number(approved));
            Value::Object(entry)
        })
        .collect();
    Ok(json!({ "declarations": declarations, "open": open }))
}
