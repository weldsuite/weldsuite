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
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, EntityTrait, FromQueryResult, JoinType, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    HR_DECLARATION_APPROVED, HR_DECLARATION_CREATED, HR_DECLARATION_DELETED, HR_DECLARATION_PAID,
    HR_DECLARATION_REJECTED, HR_DECLARATION_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    DECLARATIONS_APPROVE, DECLARATIONS_CREATE, DECLARATIONS_DELETE, DECLARATIONS_READ,
    DECLARATIONS_UPDATE,
};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::{DynFileStore, PutOptions};
use weldsuite_schema::tenant::{hr_declarations as declarations, hr_employees, projects};

use crate::employees::{display_name, no_row, pg_date, require_employee, to_json};
use crate::entity_scope::{guard, via_employee};
use crate::fields::{Fields, id, iso_date};
use crate::{
    Caller, HrError, HrResult, HrState, add_days, hr_json, js_number, js_round, js_to_fixed,
    member_names, query_date, query_text, query_values, text, today_iso,
};

/// `amount.toFixed(2)` bound as `$n::numeric`: the exact decimal the route
/// writes (a value Postgres can't read fails the statement, a 500).
fn numeric_amount(amount: f64) -> Result<BigDecimal, HrError> {
    let text = js_to_fixed(amount, 2);
    text.parse().map_err(|_| {
        HrError::Database(sea_orm::DbErr::Custom(format!(
            "invalid input syntax for type numeric: \"{text}\""
        )))
    })
}

/// `update hr_declarations set … where id = $1 returning *`: the changed row.
async fn update_declaration(
    db: &PgPool,
    id: &str,
    update: sea_orm::UpdateMany<declarations::Entity>,
) -> Result<Value, HrError> {
    let row = update
        .filter(declarations::Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await?
        .pop()
        .ok_or_else(|| no_row("hr_declarations"))?;
    to_json(row)
}

const CATEGORIES: [&str; 6] = [
    "travel",
    "meals",
    "accommodation",
    "equipment",
    "training",
    "other",
];
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
        .route(
            "/declarations",
            get(list).route_layer(gate.require([DECLARATIONS_READ])),
        )
        .route(
            "/declarations",
            post(create).route_layer(gate.require([DECLARATIONS_CREATE])),
        )
        .route(
            "/declarations/{id}",
            patch(update).route_layer(gate.require([DECLARATIONS_UPDATE])),
        )
        .route(
            "/declarations/{id}/review",
            post(review).route_layer(approve()),
        )
        .route("/declarations/{id}/pay", post(pay).route_layer(approve()))
        .route(
            "/declarations/{id}/cancel",
            post(cancel).route_layer(gate.require([DECLARATIONS_UPDATE])),
        )
        .route(
            "/declarations/{id}",
            delete(remove).route_layer(gate.require([DECLARATIONS_DELETE])),
        )
        .route(
            "/declarations/{id}/receipt",
            post(upload_receipt)
                .route_layer(gate.require([DECLARATIONS_CREATE, DECLARATIONS_UPDATE])),
        )
        .route(
            "/declarations/{id}/receipt",
            get(download_receipt).route_layer(gate.require([DECLARATIONS_READ])),
        )
        .route_layer(guard(
            "/declarations",
            "Declaration",
            via_employee!("hr_declarations"),
        ))
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
        return Err(HrError::validation(
            "The expense date cannot be in the future",
        ));
    }
    Ok(())
}

/// `requireDeclaration(db, id, onlyEmployeeId?)`.
pub(crate) async fn require_declaration(
    db: &PgPool,
    id: &str,
    only_employee_id: Option<&str>,
) -> Result<Value, HrError> {
    let row = declarations::Entity::find_by_id(id.to_owned())
        .one(&orm(db))
        .await?
        .map(to_json)
        .transpose()?;
    match row {
        Some(row) if only_employee_id.is_none_or(|only| row["employeeId"] == only) => Ok(row),
        _ => Err(HrError::not_found("Declaration", id)),
    }
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> HrResult {
    let q = query_values(query.as_deref());
    let split = |key: &str| -> Option<Vec<String>> {
        query_text(&q, key).map(|v| v.split(',').map(str::to_owned).collect())
    };
    let scope = caller.scope().await?;
    let mut select = declarations::Entity::find()
        .column_as(hr_employees::Column::FirstName, "employee_first_name")
        .column_as(hr_employees::Column::LastName, "employee_last_name")
        .column_as(hr_employees::Column::PreferredName, "employee_preferred_name")
        .join(
            JoinType::InnerJoin,
            declarations::Entity::belongs_to(hr_employees::Entity)
                .from(declarations::Column::EmployeeId)
                .to(hr_employees::Column::Id)
                .into(),
        )
        .filter(hr_employees::Column::DeletedAt.is_null());
    if let Some(employee_id) = query_text(&q, "employeeId") {
        select = select.filter(declarations::Column::EmployeeId.eq(employee_id));
    }
    if let Some(statuses) = split("status") {
        select = select.filter(declarations::Column::Status.is_in(statuses));
    }
    if let Some(categories) = split("category") {
        select = select.filter(declarations::Column::Category.is_in(categories));
    }
    if let Some(from) = query_date(&q, "from") {
        select = select.filter(declarations::Column::ExpenseDate.gte(pg_date(&from)?));
    }
    if let Some(to) = query_date(&q, "to") {
        select = select.filter(declarations::Column::ExpenseDate.lte(pg_date(&to)?));
    }
    let rows: Vec<DeclarationWithEmployee> = select
        .filter(scope.condition(hr_employees::Column::LegalEntityId))
        .order_by_desc(declarations::Column::ExpenseDate)
        .order_by_desc(declarations::Column::CreatedAt)
        .limit(1000)
        .into_model()
        .all(&orm(&caller.db))
        .await?;
    let reviewers: Vec<Option<&str>> = rows
        .iter()
        .map(|row| row.declaration.reviewed_by.as_deref())
        .collect();
    let names = member_names(&caller.db, &reviewers).await?;
    let data: Vec<Value> = rows
        .iter()
        .map(|row| {
            let declaration = to_json(&row.declaration)?;
            let reviewer = declaration["reviewedBy"]
                .as_str()
                .filter(|r| !r.is_empty())
                .and_then(|r| names.get(r).cloned());
            let mut out = to_public_declaration(&declaration);
            if let Some(map) = out.as_object_mut() {
                map.insert(
                    "employeeName".to_owned(),
                    json!(display_name(
                        &row.employee_first_name,
                        &row.employee_last_name,
                        row.employee_preferred_name.as_deref(),
                    )),
                );
                map.insert("reviewedByName".to_owned(), json!(reviewer));
            }
            Ok(out)
        })
        .collect::<Result<_, HrError>>()?;
    Ok(Data(data).into_response())
}

/// A declaration of the list with its employee's name.
#[derive(Debug, FromQueryResult)]
struct DeclarationWithEmployee {
    #[sea_orm(nested)]
    declaration: declarations::Model,
    employee_first_name: String,
    employee_last_name: String,
    employee_preferred_name: Option<String>,
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
    let field = issues.number(
        fields,
        "amount",
        presence,
        Number {
            coerce: false,
            int: false,
            min: None,
            max: None,
        },
    );
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
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };

    DeclarationFields {
        expense_date: iso_date(issues, fields, "expenseDate", required),
        category: issues.choice(fields, "category", required, &CATEGORIES),
        description: issues.text_with(
            fields,
            "description",
            required,
            Text::trimmed(Some(1), Some(2000)),
        ),
        amount: amount(issues, fields, required),
        currency: issues.choice(fields, "currency", Presence::Optional, &CURRENCIES),
    }
}

/// `assertProjectExists(db, projectId)`: the project of a declaration
/// (FLOW-019) must be a live `WeldFlow` project of this workspace. It belongs
/// to another module, so the column has no foreign key and this is the only
/// check; a deleted project does not count.
async fn assert_project_exists(db: &PgPool, project_id: Option<&str>) -> Result<(), HrError> {
    let Some(project_id) = project_id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let found: Option<String> = projects::Entity::find()
        .select_only()
        .column(projects::Column::Id)
        .filter(projects::Column::Id.eq(project_id))
        .filter(projects::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if found.is_none() {
        return Err(HrError::validation(format!(
            "Project {project_id} does not exist"
        )));
    }
    Ok(())
}

/// `declarationProject`: `projectId`, `z.string().min(1).max(255).nullable().optional()`.
fn project_field(issues: &mut Issues, fields: &Fields) -> Field<String> {
    issues.text(fields, "projectId", Presence::Nullish, Some(1), Some(255))
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
    assert_project_exists(db, fields.project_id.as_deref()).await?;
    let row = declarations::Entity::insert(declarations::ActiveModel {
        id: Set(generate_id("hrdcl")),
        employee_id: Set(employee_id.to_owned()),
        expense_date: Set(pg_date(&fields.expense_date)?),
        category: Set(fields.category.clone()),
        description: Set(fields.description.clone()),
        amount: Set(numeric_amount(fields.amount)?),
        currency: Set(fields.currency.as_deref().unwrap_or("EUR").to_owned()),
        project_id: Set(fields
            .project_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .map(str::to_owned)),
        status: Set("pending".to_owned()),
        submitted_by: Set(Some(submitted_by.to_owned())),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    to_json(row)
}

/// A complete declaration (`declarationFields` with every field present).
pub(crate) struct DeclarationInput {
    pub(crate) expense_date: String,
    pub(crate) category: String,
    pub(crate) description: String,
    pub(crate) amount: f64,
    pub(crate) currency: Option<String>,
    /// The `WeldFlow` project the expense counts toward (FLOW-019). Back
    /// office only: a claim filed in My HR has none.
    pub(crate) project_id: Option<String>,
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
        // The back office's schema has the project; `hrSelfDeclarationSchema` strips it.
        let project = if with_employee {
            project_field(issues, fields).into_option()
        } else {
            None
        };
        amount_refine(issues, fields);
        (
            employee,
            DeclarationInput {
                expense_date: read.expense_date.into_option().unwrap_or_default(),
                category: read.category.into_option().unwrap_or_default(),
                description: read.description.into_option().unwrap_or_default(),
                amount: read.amount.into_option().unwrap_or_default(),
                currency: read.currency.into_option(),
                project_id: project,
            },
        )
    })
}

/// The `hr_declaration` event data: `{ id, employeeId, status }`.
fn emit(
    caller: &Caller,
    state: &HrState,
    event: weldsuite_catalogs::entity_events::EventName,
    row: &Value,
) {
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

async fn create(
    State(state): State<HrState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let (employee, input) = declaration_body(&headers, &body, true)?;
    caller.assert_employee_visible(employee.as_deref()).await?;
    let row = create_declaration(
        &caller.db,
        &employee.unwrap_or_default(),
        &input,
        &caller.user_id,
    )
    .await?;
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
    let (input, project) = hr_json(&headers, &body, |issues, fields| {
        let read = declaration_fields(issues, fields, true);
        let project = project_field(issues, fields);
        amount_refine(issues, fields);
        (read, project)
    })?;
    let db = &caller.db;
    let existing = require_declaration(db, &id, None).await?;
    // Only the project tag moves no money: HR can set it until the
    // declaration is rejected or cancelled.
    let only_project = !project.is_absent()
        && input.expense_date.is_absent()
        && input.category.is_absent()
        && input.description.is_absent()
        && input.amount.is_absent()
        && input.currency.is_absent();
    let status = text(&existing, "status");
    let editable =
        status == "pending" || (only_project && (status == "approved" || status == "paid"));
    if !editable {
        return Err(HrError::conflict(format!(
            "This declaration is already {status} and can no longer be changed"
        )));
    }
    if let Some(date) = input.expense_date.as_set().filter(|d| !d.is_empty()) {
        assert_expense_date(date)?;
    }
    assert_project_exists(db, project.as_set().map(String::as_str)).await?;
    // `coalesce($n, column)`: only what the body sent changes.
    let mut update = declarations::Entity::update_many();
    if let Some(date) = input.expense_date.as_set() {
        update = update.col_expr(
            declarations::Column::ExpenseDate,
            Expr::value(pg_date(date)?),
        );
    }
    if let Some(category) = input.category.as_set() {
        update = update.col_expr(declarations::Column::Category, Expr::value(category));
    }
    if let Some(description) = input.description.as_set() {
        update = update.col_expr(
            declarations::Column::Description,
            Expr::value(description),
        );
    }
    if let Some(amount) = input.amount.as_set() {
        update = update.col_expr(
            declarations::Column::Amount,
            Expr::value(numeric_amount(*amount)?),
        );
    }
    if let Some(currency) = input.currency.as_set() {
        update = update.col_expr(declarations::Column::Currency, Expr::value(currency));
    }
    if !project.is_absent() {
        update = update.col_expr(
            declarations::Column::ProjectId,
            Expr::value(project.as_set().cloned()),
        );
    }
    let update = update.col_expr(declarations::Column::UpdatedAt, Expr::value(utc_now()));
    let row = update_declaration(db, &id, update).await?;
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
            issues.choice(
                fields,
                "decision",
                Presence::Required,
                &["approved", "rejected"],
            ),
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
    let now = utc_now();
    let update = declarations::Entity::update_many()
        .col_expr(
            declarations::Column::Status,
            Expr::value(decision.as_set().cloned()),
        )
        .col_expr(
            declarations::Column::ReviewNote,
            Expr::value(note.as_set().cloned()),
        )
        .col_expr(
            declarations::Column::ReviewedBy,
            Expr::value(caller.user_id.as_str()),
        )
        .col_expr(declarations::Column::ReviewedAt, Expr::value(now))
        .col_expr(declarations::Column::UpdatedAt, Expr::value(now));
    let row = update_declaration(db, &id, update).await?;
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
        return Err(HrError::conflict(
            "Only an approved declaration can be marked as paid",
        ));
    }
    let now = utc_now();
    let update = declarations::Entity::update_many()
        .col_expr(declarations::Column::Status, Expr::value("paid"))
        .col_expr(
            declarations::Column::PaidBy,
            Expr::value(caller.user_id.as_str()),
        )
        .col_expr(declarations::Column::PaidAt, Expr::value(now))
        .col_expr(declarations::Column::UpdatedAt, Expr::value(now));
    let row = update_declaration(db, &id, update).await?;
    emit(&caller, &state, HR_DECLARATION_PAID, &row);
    Ok(Data(to_public_declaration(&row)).into_response())
}

/// `cancelDeclaration(db, id, onlyEmployeeId?)`.
pub(crate) async fn cancel_declaration(
    db: &PgPool,
    id: &str,
    only_employee_id: Option<&str>,
) -> Result<Value, HrError> {
    let existing = require_declaration(db, id, only_employee_id).await?;
    let status = text(&existing, "status");
    let cancellable = if only_employee_id.is_some() {
        status == "pending"
    } else {
        status == "pending" || status == "approved"
    };
    if !cancellable {
        return Err(HrError::conflict(format!(
            "This declaration is already {status}"
        )));
    }
    let update = declarations::Entity::update_many()
        .col_expr(declarations::Column::Status, Expr::value("cancelled"))
        .col_expr(declarations::Column::UpdatedAt, Expr::value(utc_now()));
    update_declaration(db, id, update).await
}

async fn cancel(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let row = cancel_declaration(&caller.db, &id, None).await?;
    emit(&caller, &state, HR_DECLARATION_UPDATED, &row);
    Ok(Data(to_public_declaration(&row)).into_response())
}

async fn remove(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let existing = require_declaration(&caller.db, &id, None).await?;
    declarations::Entity::delete_by_id(id.clone())
        .exec(&orm(&caller.db))
        .await?;
    if let Some(key) = existing["receiptFileKey"]
        .as_str()
        .filter(|k| !k.is_empty())
    {
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
pub(crate) fn receipt_bucket(
    caller: &Caller,
    state: &HrState,
) -> Result<Arc<dyn DynFileStore>, HrError> {
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
        let name = field.file_name().map(|n| {
            n.replace("%22", "\"")
                .replace("%0D", "\r")
                .replace("%0A", "\n")
        });
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
        return Err(HrError::validation(
            "A receipt must be a JPEG, PNG or WebP image, or a PDF",
        ));
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
        .put_boxed(
            &key,
            file.bytes,
            &PutOptions::content_type(file.content_type.clone()),
        )
        .await
        .map_err(|error| HrError::internal(error.to_string()))?;
    let update = declarations::Entity::update_many()
        .col_expr(
            declarations::Column::ReceiptFileKey,
            Expr::value(key.as_str()),
        )
        .col_expr(
            declarations::Column::ReceiptFileName,
            Expr::value(file_name.as_str()),
        )
        .col_expr(
            declarations::Column::ReceiptContentType,
            Expr::value(file.content_type.as_str()),
        )
        .col_expr(declarations::Column::ReceiptSize, Expr::value(size))
        .col_expr(declarations::Column::UpdatedAt, Expr::value(utc_now()));
    let row = update_declaration(db, id, update).await?;
    if let Some(old) = existing["receiptFileKey"]
        .as_str()
        .filter(|k| !k.is_empty())
    {
        storage
            .delete_boxed(old)
            .await
            .map_err(|error| HrError::internal(error.to_string()))?;
    }
    Ok(row)
}

/// 16 random bytes in hex (`crypto.randomUUID()` without its dashes).
fn hex_random() -> String {
    weldsuite_kit::random_string(32, "0123456789abcdef")
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
    let file_name = row["receiptFileName"]
        .as_str()
        .unwrap_or("receipt")
        .replace('"', "");
    let content_type = row["receiptContentType"]
        .as_str()
        .unwrap_or("application/octet-stream")
        .to_owned();
    let response = Response::builder()
        .status(200)
        .header("content-type", content_type)
        .header(
            "content-disposition",
            format!("inline; filename=\"{file_name}\""),
        )
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

async fn download_receipt(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
) -> HrResult {
    let storage = receipt_bucket(&caller, &state)?;
    receipt_response(&caller, &storage, &id, None).await
}

/// `employeeDeclarations(db, employeeId)`: the employee's own declarations
/// and what is still open, per currency.
pub(crate) async fn employee_declarations(
    db: &PgPool,
    employee_id: &str,
) -> Result<Value, HrError> {
    let rows = declarations::Entity::find()
        .filter(declarations::Column::EmployeeId.eq(employee_id))
        .order_by_desc(declarations::Column::ExpenseDate)
        .order_by_desc(declarations::Column::CreatedAt)
        .limit(500)
        .all(&orm(db))
        .await?;
    let rows: Vec<Value> = rows.into_iter().map(to_json).collect::<Result<_, _>>()?;
    let declarations: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let d = to_public_declaration(&row);
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
        let index = if let Some(index) = totals.iter().position(|(c, _, _)| *c == currency) {
            index
        } else {
            totals.push((currency, 0.0, 0.0));
            totals.len() - 1
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
