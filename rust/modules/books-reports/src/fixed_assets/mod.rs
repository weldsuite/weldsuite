//! `/api/fixed-assets` (`routes/fixed-assets/{index,schemas}.ts`): fixed
//! assets and depreciation.
//!
//! One book (`book`, GAAP) posts to the ledger month by month; the federal
//! and state books are computed on request for the return. The mid-quarter
//! test runs over the entity's federal MACRS assets, so a late-year purchase
//! can move the other assets of that year to the mid-quarter convention.
//! Permissions: `accounts:read|create|update|delete`; posting (the run and a
//! disposal) also needs `journal:create`.

mod assets;
mod books;
mod disposal;
mod reports;
mod run;
mod schedules;
mod shared;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::dates::is_iso_date;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::fiscal_year::fiscal_year_range;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, created, no_content, ok, paged, validate,
};
use weldsuite_books_domain::js::{math_round, parse_int};
use weldsuite_books_domain::reports_basis::periods::fiscal_config_of;
use weldsuite_books_domain::reports_basis::today_for;
use weldsuite_books_domain::tables::FIXED_ASSETS;
use weldsuite_catalogs::entity_events::{
    FIXED_ASSET_CREATED, FIXED_ASSET_DELETED, FIXED_ASSET_DISPOSED, FIXED_ASSET_UPDATED,
};
use weldsuite_kit::validation::{Field, Issues, Presence, Text, js_number, js_trim};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

pub use run::{EntityRun, last_completed_month_end, run_monthly_depreciation};

use assets::{AssetInput, AssetPatch, FromBillLine};
use books::{BookInput, CONVENTIONS, DEPRECIATION_METHODS, issues_json};
use shared::{Fail, money, num, opt, text};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("accounts:read")))
        .route("/", post(create).route_layer(need("accounts:create")))
        .route(
            "/register",
            get(register).route_layer(need("accounts:read")),
        )
        .route(
            "/tax-depreciation",
            get(tax_depreciation).route_layer(need("accounts:read")),
        )
        .route(
            "/mid-quarter-test",
            get(mid_quarter).route_layer(need("accounts:read")),
        )
        .route(
            "/de-minimis-check",
            post(de_minimis).route_layer(need("accounts:read")),
        )
        .route(
            "/depreciation/run",
            post(run_now).route_layer(need("journal:create")),
        )
        .route(
            "/from-bill-line",
            post(from_bill_line).route_layer(need("accounts:create")),
        )
        .route("/{id}", get(detail).route_layer(need("accounts:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("accounts:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("accounts:delete")),
        )
        .route(
            "/{id}/schedule",
            get(schedule).route_layer(need("accounts:read")),
        )
        .route(
            "/{id}/dispose",
            post(dispose)
                .route_layer(need("journal:create"))
                .route_layer(need("accounts:update")),
        )
        .with_state(state)
}

fn finish(result: Result<Response, Fail>, what: &str) -> Response {
    result.unwrap_or_else(|fail| fail.respond(what))
}

async fn audit(
    caller: &Caller,
    entity_id: &str,
    target: &str,
    action: &str,
    changes: Option<Map<String, Value>>,
) {
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(entity_id),
            entity_type: "fixed_asset",
            entity_id: target,
            action,
            changes,
        },
    )
    .await;
}

// ---------------------------------------------------------------------------
// Request bodies (`schemas.ts`)

/// Issues Zod settles after the body's synchronous checks (`zValidator`
/// parses asynchronously): the unions' (the amount fields) and the
/// refinements'.
#[derive(Default)]
struct Deferred {
    unions: Vec<Value>,
    refinements: Vec<Value>,
}

impl Deferred {
    fn settle(self, issues: &mut Issues) {
        for issue in self.unions.into_iter().chain(self.refinements) {
            issues.push_raw(issue);
        }
    }
}

fn parsed_type(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// `z.union([z.number(), z.string()…])` failing every option.
fn union_issue(path: &Value, value: Option<&Value>) -> Value {
    let received = parsed_type(value);
    let option = |expected: &str| {
        json!({ "issues": [{
            "code": "invalid_type",
            "expected": expected,
            "received": received,
            "path": path,
            "message": if received == "undefined" {
                "Required".to_owned()
            } else {
                format!("Expected {expected}, received {received}")
            },
        }], "name": "ZodError" })
    };
    json!({
        "code": "invalid_union",
        "unionErrors": [option("number"), option("string")],
        "path": path,
        "message": "Invalid input",
    })
}

fn is_decimal(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

/// A refinement on an amount: the check and its message.
type Refine = Option<(fn(f64) -> bool, &'static str)>;

fn non_negative(value: f64) -> bool {
    value >= 0.0
}

fn percent_range(value: f64) -> bool {
    (0.0..=100.0).contains(&value)
}

const NEGATIVE: Refine = Some((non_negative, "Cannot be negative"));
const PERCENT: Refine = Some((percent_range, "Use 0 to 100"));

/// `amount` (`z.union([z.number(), z.string().trim().regex(...)])
/// .transform(Number).refine(isFinite)`), with an optional refinement.
fn amount(
    issues: &Issues,
    deferred: &mut Deferred,
    body: &Map<String, Value>,
    key: &str,
    required: bool,
    refine: Refine,
) -> Option<f64> {
    let path = issues.path_of(key);
    let value = match body.get(key) {
        None if !required => return None,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(raw)) => {
            let trimmed = js_trim(raw);
            if !is_decimal(trimmed) {
                deferred.unions.push(json!({
                    "validation": "regex",
                    "code": "invalid_string",
                    "message": "Not a number",
                    "path": path,
                }));
                return None;
            }
            js_number(trimmed)
        }
        other => {
            deferred.unions.push(union_issue(&path, other));
            return None;
        }
    };
    if !value.is_finite() {
        deferred
            .refinements
            .push(json!({ "code": "custom", "message": "Not a number", "path": path }));
        return None;
    }
    if let Some((check, message)) = refine
        && !check(value)
    {
        deferred
            .refinements
            .push(json!({ "code": "custom", "message": message, "path": path }));
        return None;
    }
    Some(value)
}

fn is_date_shape(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

fn date(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
) -> Option<String> {
    issues
        .pattern(
            body,
            key,
            presence,
            None,
            None,
            is_date_shape,
            "Use YYYY-MM-DD",
        )
        .into_option()
}

fn trimmed(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    min: Option<usize>,
    max: Option<usize>,
) -> Field<String> {
    issues.text_with(body, key, presence, Text::trimmed(min, max))
}

fn optional_id(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Field<String> {
    trimmed(issues, body, key, Presence::Nullish, Some(1), Some(30))
}

fn read_book(issues: &mut Issues, deferred: &mut Deferred, item: &Value) -> Option<BookInput> {
    let fields = issues.object(item)?;
    let book = issues.choice(
        fields,
        "book",
        Presence::Required,
        &["book", "federal", "state"],
    );
    let state_code = trimmed(issues, fields, "stateCode", Presence::Nullish, None, None);
    if let Field::Set(code) = &state_code {
        issues.string_length("stateCode", 2, code.encode_utf16().count());
    }
    let method = issues.choice(fields, "method", Presence::Required, &DEPRECIATION_METHODS);
    let convention = issues.choice(fields, "convention", Presence::Optional, &CONVENTIONS);
    let recovery_years = amount(issues, deferred, fields, "recoveryYears", true, PERCENT);
    let section_179_amount = amount(
        issues,
        deferred,
        fields,
        "section179Amount",
        false,
        NEGATIVE,
    );
    let bonus_percent = amount(issues, deferred, fields, "bonusPercent", false, PERCENT);
    let posts_to_ledger = issues.boolean(fields, "postsToLedger", Presence::Optional);
    Some(BookInput {
        book: book.into_option().unwrap_or_default(),
        state_code: state_code.into_option(),
        method: method.into_option().unwrap_or_default(),
        convention: convention.into_option(),
        recovery_years: recovery_years.unwrap_or(0.0),
        section_179_amount,
        bonus_percent,
        posts_to_ledger: posts_to_ledger.into_option(),
    })
}

fn read_books(
    issues: &mut Issues,
    deferred: &mut Deferred,
    body: &Map<String, Value>,
) -> Option<Vec<BookInput>> {
    issues
        .list(
            body,
            "books",
            Presence::Optional,
            None,
            Some(12),
            |i, item| read_book(i, deferred, item),
        )
        .into_option()
}

fn useful_life(value: f64) -> bool {
    value > 0.0 && value <= 100.0
}

/// `createAssetSchema`.
fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> AssetInput {
    let mut deferred = Deferred::default();
    let nullish = Presence::Nullish;
    let name = trimmed(issues, body, "name", Presence::Required, Some(1), Some(255));
    let asset_number = trimmed(issues, body, "assetNumber", nullish, Some(1), Some(50));
    let description = issues.text(body, "description", nullish, None, Some(5000));
    let asset_class = trimmed(issues, body, "assetClass", nullish, Some(1), Some(20));
    let asset_account_id = optional_id(issues, body, "assetAccountId");
    let accumulated = optional_id(issues, body, "accumulatedDepreciationAccountId");
    let expense = optional_id(issues, body, "depreciationExpenseAccountId");
    let acquisition_date = date(issues, body, "acquisitionDate", Presence::Required);
    let placed = date(issues, body, "placedInServiceDate", Presence::Optional);
    let cost = amount(issues, &mut deferred, body, "cost", true, None);
    let salvage = amount(issues, &mut deferred, body, "salvageValue", false, None);
    let business = amount(
        issues,
        &mut deferred,
        body,
        "businessUsePercent",
        false,
        PERCENT,
    );
    let listed = issues.boolean(body, "listedProperty", Presence::Optional);
    let bill_id = optional_id(issues, body, "billId");
    let bill_item_id = optional_id(issues, body, "billItemId");
    let class_id = optional_id(issues, body, "classId");
    let location_id = optional_id(issues, body, "locationId");
    let notes = issues.text(body, "notes", nullish, None, Some(5000));
    let life = amount(
        issues,
        &mut deferred,
        body,
        "usefulLifeYears",
        false,
        Some((useful_life, "Use more than 0 and at most 100")),
    );
    let section179 = amount(
        issues,
        &mut deferred,
        body,
        "section179Amount",
        false,
        NEGATIVE,
    );
    let bonus = amount(issues, &mut deferred, body, "bonusPercent", false, PERCENT);
    let reduced = issues.boolean(body, "bonusReducedElection", Presence::Optional);
    let books = read_books(issues, &mut deferred, body);
    deferred.settle(issues);
    let acquisition_date = acquisition_date.unwrap_or_default();
    AssetInput {
        name: name.into_option().unwrap_or_default(),
        asset_number: asset_number.into_option(),
        description: description.into_option(),
        asset_class: asset_class.into_option(),
        asset_account_id: asset_account_id.into_option(),
        accumulated_depreciation_account_id: accumulated.into_option(),
        depreciation_expense_account_id: expense.into_option(),
        placed_in_service_date: placed.unwrap_or_else(|| acquisition_date.clone()),
        acquisition_date,
        cost: cost.unwrap_or(0.0),
        salvage_value: salvage,
        business_use_percent: business,
        listed_property: listed.into_option(),
        bill_id: bill_id.into_option(),
        bill_item_id: bill_item_id.into_option(),
        class_id: class_id.into_option(),
        location_id: location_id.into_option(),
        notes: notes.into_option(),
        useful_life_years: life,
        section_179_amount: section179,
        bonus_percent: bonus,
        bonus_reduced_election: reduced.into_option(),
        books,
    }
}

/// `updateAssetSchema` (every field optional).
fn read_update(issues: &mut Issues, body: &Map<String, Value>) -> AssetPatch {
    let mut deferred = Deferred::default();
    let nullish = Presence::Nullish;
    let optional = Presence::Optional;
    let name = trimmed(issues, body, "name", optional, Some(1), Some(255));
    let asset_number = trimmed(issues, body, "assetNumber", nullish, Some(1), Some(50));
    let description = issues.text(body, "description", nullish, None, Some(5000));
    let asset_class = trimmed(issues, body, "assetClass", nullish, Some(1), Some(20));
    let asset_account_id = trimmed(issues, body, "assetAccountId", optional, Some(1), Some(30));
    let accumulated = trimmed(
        issues,
        body,
        "accumulatedDepreciationAccountId",
        optional,
        Some(1),
        Some(30),
    );
    let expense = trimmed(
        issues,
        body,
        "depreciationExpenseAccountId",
        optional,
        Some(1),
        Some(30),
    );
    let acquisition_date = date(issues, body, "acquisitionDate", optional);
    let placed = date(issues, body, "placedInServiceDate", optional);
    let cost = amount(issues, &mut deferred, body, "cost", false, None);
    let salvage = amount(issues, &mut deferred, body, "salvageValue", false, None);
    let business = amount(
        issues,
        &mut deferred,
        body,
        "businessUsePercent",
        false,
        PERCENT,
    );
    let listed = issues.boolean(body, "listedProperty", optional);
    let class_id = optional_id(issues, body, "classId");
    let location_id = optional_id(issues, body, "locationId");
    let notes = issues.text(body, "notes", nullish, None, Some(5000));
    let books = read_books(issues, &mut deferred, body);
    deferred.settle(issues);
    AssetPatch {
        name: name.into(),
        asset_number: asset_number.into(),
        description: description.into(),
        asset_class: asset_class.into(),
        asset_account_id: asset_account_id.into_option(),
        accumulated_depreciation_account_id: accumulated.into_option(),
        depreciation_expense_account_id: expense.into_option(),
        acquisition_date,
        placed_in_service_date: placed,
        cost,
        salvage_value: salvage,
        business_use_percent: business,
        listed_property: listed.into_option(),
        class_id: class_id.into(),
        location_id: location_id.into(),
        notes: notes.into(),
        books,
    }
}

/// `fromBillLineSchema`.
fn read_from_bill_line(issues: &mut Issues, body: &Map<String, Value>) -> FromBillLine {
    let mut deferred = Deferred::default();
    let nullish = Presence::Nullish;
    let optional = Presence::Optional;
    let bill_item_id = trimmed(
        issues,
        body,
        "billItemId",
        Presence::Required,
        Some(1),
        Some(30),
    );
    let name = trimmed(issues, body, "name", optional, Some(1), Some(255));
    let asset_number = trimmed(issues, body, "assetNumber", nullish, Some(1), Some(50));
    let description = issues.text(body, "description", nullish, None, Some(5000));
    let asset_class = trimmed(issues, body, "assetClass", nullish, Some(1), Some(20));
    let asset_account_id = optional_id(issues, body, "assetAccountId");
    let accumulated = optional_id(issues, body, "accumulatedDepreciationAccountId");
    let expense = optional_id(issues, body, "depreciationExpenseAccountId");
    let acquisition_date = date(issues, body, "acquisitionDate", optional);
    let placed = date(issues, body, "placedInServiceDate", optional);
    let cost = amount(issues, &mut deferred, body, "cost", false, None);
    let salvage = amount(issues, &mut deferred, body, "salvageValue", false, None);
    let business = amount(
        issues,
        &mut deferred,
        body,
        "businessUsePercent",
        false,
        PERCENT,
    );
    let listed = issues.boolean(body, "listedProperty", optional);
    let class_id = optional_id(issues, body, "classId");
    let location_id = optional_id(issues, body, "locationId");
    let notes = issues.text(body, "notes", nullish, None, Some(5000));
    let life = amount(
        issues,
        &mut deferred,
        body,
        "usefulLifeYears",
        false,
        Some((useful_life, "Use more than 0 and at most 100")),
    );
    let section179 = amount(
        issues,
        &mut deferred,
        body,
        "section179Amount",
        false,
        NEGATIVE,
    );
    let bonus = amount(issues, &mut deferred, body, "bonusPercent", false, PERCENT);
    let reduced = issues.boolean(body, "bonusReducedElection", optional);
    let books = read_books(issues, &mut deferred, body);
    let reclass = issues.boolean(body, "reclass", optional);
    deferred.settle(issues);
    FromBillLine {
        bill_item_id: bill_item_id.into_option().unwrap_or_default(),
        name: name.into_option(),
        cost,
        acquisition_date,
        placed_in_service_date: placed,
        reclass: reclass.into_option().unwrap_or(false),
        rest: AssetInput {
            asset_number: asset_number.into_option(),
            description: description.into_option(),
            asset_class: asset_class.into_option(),
            asset_account_id: asset_account_id.into_option(),
            accumulated_depreciation_account_id: accumulated.into_option(),
            depreciation_expense_account_id: expense.into_option(),
            salvage_value: salvage,
            business_use_percent: business,
            listed_property: listed.into_option(),
            class_id: class_id.into_option(),
            location_id: location_id.into_option(),
            notes: notes.into_option(),
            useful_life_years: life,
            section_179_amount: section179,
            bonus_percent: bonus,
            bonus_reduced_election: reduced.into_option(),
            books,
            ..AssetInput::default()
        },
    }
}

// ---------------------------------------------------------------------------
// GET /

fn encode_cursor(created_at: &str, id: &str) -> String {
    let json = serde_json::to_string(&json!([created_at, id])).unwrap_or_default();
    weldsuite_kit::cursor::btoa(&weldsuite_kit::cursor::encode_uri_component(&json))
        .unwrap_or_default()
}

fn decode_cursor(cursor: &str) -> Option<(String, String)> {
    let text = weldsuite_kit::cursor::atob(cursor)?;
    let decoded = weldsuite_kit::cursor::decode_uri_component(&text)?;
    let parsed: Value = serde_json::from_str(&decoded).ok()?;
    match parsed.as_array().map(Vec::as_slice) {
        Some([Value::String(at), Value::String(id), ..]) => Some((at.clone(), id.clone())),
        _ => None,
    }
}

async fn list(caller: Caller) -> Response {
    finish(list_assets(&caller).await, "list fixed assets")
}

#[allow(clippy::too_many_lines)] // the route's one handler
async fn list_assets(caller: &Caller) -> Result<Response, Fail> {
    let db = &caller.db;
    let q = caller.query();
    let limit = q
        .get("limit")
        .filter(|l| !l.is_empty())
        .and_then(parse_int)
        .filter(|l| *l != 0)
        .unwrap_or(50)
        .clamp(1, 200);
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let status = q.present("status");
    let class = q.present("assetClass");
    let search = q.present("search").map(|s| format!("%{s}%"));
    let total: i64 = sqlx::query_scalar(
        "select count(*)::int8 from fixed_assets where deleted_at is null and entity_id = $1 \
         and ($2::text is null or status = $2) and ($3::text is null or asset_class = $3) \
         and ($4::text is null or (name ilike $4 or asset_number ilike $4))",
    )
    .bind(&entity_id)
    .bind(status)
    .bind(class)
    .bind(&search)
    .fetch_one(db)
    .await?;

    let cursor = match q.present("cursor") {
        Some(raw) => match decode_cursor(raw) {
            Some(decoded) => Some(decoded),
            None => return Err(shared::bad("Invalid cursor")),
        },
        None => None,
    };
    let (cursor_at, cursor_id) = cursor.map_or((None, None), |(at, id)| (Some(at), Some(id)));
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(fixed_assets),
        " from fixed_assets t where t.deleted_at is null and t.entity_id = $1 \
         and ($2::text is null or t.status = $2) and ($3::text is null or t.asset_class = $3) \
         and ($4::text is null or (t.name ilike $4 or t.asset_number ilike $4)) \
         and ($5::text is null or (t.created_at, t.id) < ($5::timestamp, $6::text)) \
         order by t.created_at desc, t.id desc limit $7"
    ))
    .bind(&entity_id)
    .bind(status)
    .bind(class)
    .bind(&search)
    .bind(&cursor_at)
    .bind(&cursor_id)
    .bind(limit + 1)
    .fetch_all(db)
    .await?;
    let mut rows = FIXED_ASSETS.js_rows(rows);
    let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    if has_more {
        rows.truncate(usize::try_from(limit).unwrap_or(0));
    }
    let ids: Vec<String> = rows.iter().map(|row| text(row, "id").to_owned()).collect();
    let books = assets::books_by_asset(db, &ids).await?;
    let posted = assets::accumulated_posted_by_asset(db, &ids).await?;
    let next = if has_more {
        rows.last()
            .map(|row| encode_cursor(text(row, "createdAt"), text(row, "id")))
    } else {
        None
    };
    let data: Vec<Value> = rows
        .into_iter()
        .map(|mut row| {
            let id = text(&row, "id").to_owned();
            let posted_cents = posted.get(&id).copied().unwrap_or(0);
            let books: Vec<Value> = books
                .get(&id)
                .map(|list| {
                    list.iter()
                        .map(|book| {
                            json!({
                                "id": book["id"],
                                "book": book["book"],
                                "stateCode": book["stateCode"],
                                "method": book["method"],
                                "convention": book["convention"],
                                "recoveryYears": book["recoveryYears"],
                                "postsToLedger": book["postsToLedger"],
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            #[allow(clippy::cast_possible_truncation)]
            let cost_cents = math_round(num(&row, "cost") * 100.0) as i64;
            row["books"] = Value::Array(books);
            row["accumulatedPosted"] = json!(money(posted_cents));
            row["netBookValuePosted"] = json!(money(cost_cents - posted_cents));
            row
        })
        .collect();
    Ok(paged(data, total, has_more, next))
}

// ---------------------------------------------------------------------------
// Reports (before /:id)

/// `q.taxYear ? parseInt : the fiscal year of today`, checked.
fn tax_year_of(caller: &Caller, entity: &Value) -> Result<i64, Fail> {
    let q = caller.query();
    #[allow(clippy::single_match_else)] // the asked year, or this fiscal year
    let year = match q.present("taxYear") {
        Some(raw) => parse_int(raw),
        None => {
            let today = today_for(opt(entity, "timezone"), caller.now_ms());
            fiscal_year_range(&fiscal_config_of(entity), &today).map(|y| y.year)
        }
    };
    match year {
        Some(year) if (1990..=2200).contains(&year) => Ok(year),
        _ => Err(shared::bad("taxYear must be a year")),
    }
}

async fn register(caller: Caller) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(shared::bad("No accounting entity resolved"));
        };
        let entity = assets::load_entity(&caller.db, &entity_id).await?;
        let q = caller.query();
        let as_of = q.present("asOf").map_or_else(
            || today_for(opt(&entity, "timezone"), caller.now_ms()),
            str::to_owned,
        );
        if !is_iso_date(&as_of) {
            return Err(shared::bad("asOf must be a date (YYYY-MM-DD)"));
        }
        let book = q.present("book").unwrap_or("book");
        if !matches!(book, "book" | "federal" | "state") {
            return Err(shared::bad("book must be 'book', 'federal' or 'state'"));
        }
        if book == "state" && q.present("stateCode").is_none() {
            return Err(shared::bad("A state register needs a stateCode"));
        }
        let report = reports::fixed_asset_register(
            &caller.db,
            &entity_id,
            &as_of,
            book,
            q.get("stateCode"),
            q.get("includeDisposed") == Some("true"),
        )
        .await?;
        Ok(ok(report))
    }
    .await;
    finish(result, "build the fixed asset register")
}

async fn tax_depreciation(caller: Caller) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(shared::bad("No accounting entity resolved"));
        };
        let entity = assets::load_entity(&caller.db, &entity_id).await?;
        let tax_year = tax_year_of(&caller, &entity)?;
        let q = caller.query();
        let book = q.present("book").unwrap_or("federal");
        if !matches!(book, "federal" | "state") {
            return Err(shared::bad("book must be 'federal' or 'state'"));
        }
        let report = reports::tax_depreciation_report(
            &caller.db,
            &entity_id,
            tax_year,
            book,
            q.get("stateCode"),
        )
        .await?;
        Ok(ok(report))
    }
    .await;
    finish(result, "build the tax depreciation report")
}

async fn mid_quarter(caller: Caller) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(shared::bad("No accounting entity resolved"));
        };
        let entity = assets::load_entity(&caller.db, &entity_id).await?;
        let tax_year = tax_year_of(&caller, &entity)?;
        Ok(ok(reports::mid_quarter_test_for(
            &caller.db, &entity_id, tax_year,
        )
        .await?))
    }
    .await;
    finish(result, "run the mid-quarter test")
}

fn read_de_minimis(issues: &mut Issues, body: &Map<String, Value>) -> (f64, bool, Option<String>) {
    let mut deferred = Deferred::default();
    let amount = amount(issues, &mut deferred, body, "amount", true, NEGATIVE);
    let has_afs = issues.boolean(body, "hasAfs", Presence::Optional);
    let date = date(issues, body, "date", Presence::Optional);
    deferred.settle(issues);
    (
        amount.unwrap_or(0.0),
        has_afs.into_option().unwrap_or(false),
        date,
    )
}

async fn de_minimis(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let (amount, has_afs, date) = match validate(&headers, &body, read_de_minimis) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to check the de minimis safe harbor"),
    };
    let result = async {
        let entity = match resolve_entity_id(&caller).await? {
            Some(id) => Some(assets::load_entity(&caller.db, &id).await?),
            None => None,
        };
        let date = date.unwrap_or_else(|| {
            today_for(
                entity.as_ref().and_then(|e| opt(e, "timezone")),
                caller.now_ms(),
            )
        });
        Ok(ok(reports::de_minimis_check(amount, has_afs, &date)))
    }
    .await;
    finish(result, "check the de minimis safe harbor")
}

// ---------------------------------------------------------------------------
// POST /depreciation/run

fn read_run(issues: &mut Issues, body: &Map<String, Value>) -> String {
    date(issues, body, "through", Presence::Required).unwrap_or_default()
}

async fn run_now(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let through = match validate(&headers, &body, read_run) {
        Ok(through) => through,
        Err(refusal) => return refusal.respond("Failed to post depreciation"),
    };
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(shared::bad("No accounting entity resolved"));
        };
        let result = run::run_depreciation(
            &caller.db,
            &run::RunArgs {
                entity_id: entity_id.clone(),
                through: through.clone(),
                user_id: Some(caller.user_id.clone()),
                ..run::RunArgs::default()
            },
        )
        .await?;
        for asset_id in &result.fully_depreciated_asset_ids {
            caller.publish(
                &state,
                FIXED_ASSET_UPDATED,
                asset_id,
                json!({ "id": asset_id, "status": "fully_depreciated" }),
            );
        }
        if result.posted.iter().any(|p| !p.already_posted) {
            let mut changes = Map::new();
            changes.insert("through".to_owned(), change(Value::Null, json!(through)));
            changes.insert(
                "total".to_owned(),
                change(
                    Value::Null,
                    weldsuite_books_domain::js::number_value(result.total_posted),
                ),
            );
            audit(
                &caller,
                &entity_id,
                &entity_id,
                "depreciation_posted",
                Some(changes),
            )
            .await;
        }
        Ok(ok(result.json()))
    }
    .await;
    finish(result, "post depreciation")
}

// ---------------------------------------------------------------------------
// POST /from-bill-line, POST /

async fn from_bill_line(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_from_bill_line) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond("Failed to create a fixed asset from a bill line"),
    };
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(shared::bad("No accounting entity resolved"));
        };
        let result =
            assets::create_from_bill_line(&caller.db, &entity_id, Some(&caller.user_id), &input)
                .await?;
        let asset = &result.created.asset;
        let asset_id = text(asset, "id").to_owned();
        audit(&caller, &entity_id, &asset_id, "created", None).await;
        caller.publish(&state, FIXED_ASSET_CREATED, &asset_id, asset.clone());
        let mut data = asset.clone();
        data["books"] = Value::Array(result.created.books.clone());
        data["issues"] = issues_json(&result.created.issues);
        data["source"] = result.source;
        Ok(created(data))
    }
    .await;
    finish(result, "create a fixed asset from a bill line")
}

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_create) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond("Failed to create the fixed asset"),
    };
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(shared::bad("No accounting entity resolved"));
        };
        let result = assets::create_fixed_asset(&caller.db, &entity_id, &input, None).await?;
        let asset_id = text(&result.asset, "id").to_owned();
        audit(&caller, &entity_id, &asset_id, "created", None).await;
        caller.publish(&state, FIXED_ASSET_CREATED, &asset_id, result.asset.clone());
        let mut data = result.asset;
        data["books"] = Value::Array(result.books);
        data["issues"] = issues_json(&result.issues);
        Ok(created(data))
    }
    .await;
    finish(result, "create the fixed asset")
}

// ---------------------------------------------------------------------------
// GET /:id, /:id/schedule

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(asset) = assets::load_asset(&caller.db, &id).await? else {
            return Ok(Refusal::not_found("Fixed asset", &id).respond(""));
        };
        Ok(ok(assets::asset_detail(&caller.db, &asset).await?))
    }
    .await;
    finish(result, "fetch the fixed asset")
}

async fn schedule(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let db = &caller.db;
        let Some(asset) = assets::load_asset(db, &id).await? else {
            return Ok(Refusal::not_found("Fixed asset", &id).respond(""));
        };
        let q = caller.query();
        let wanted = q.present("book");
        if wanted.is_some_and(|b| !matches!(b, "book" | "federal" | "state")) {
            return Err(shared::bad("book must be 'book', 'federal' or 'state'"));
        }
        let entity = assets::load_entity(db, text(&asset, "entityId")).await?;
        let context = assets::schedule_context_for(db, &entity).await?;
        let books = assets::load_books(db, &id).await?;
        let stored = assets::load_ledger_rows(db, &id, None).await?;
        let state_code = q.present("stateCode").map(str::to_uppercase);
        let schedules: Vec<Value> = books
            .iter()
            .filter(|book| {
                wanted.is_none_or(|w| {
                    text(book, "book") == w
                        && state_code
                            .as_deref()
                            .is_none_or(|s| opt(book, "stateCode") == Some(s))
                })
            })
            .map(|book| {
                let schedule = schedules::annual_schedule(&asset, book, &context);
                let mut view = json!({
                    "bookId": book["id"],
                    "book": book["book"],
                    "stateCode": book["stateCode"],
                    "method": schedule.method,
                    "convention": schedule.convention,
                    "recoveryYears": weldsuite_books_domain::js::number_value(schedule.recovery_years),
                    "postsToLedger": book["postsToLedger"],
                    "basis": schedule.basis.json(),
                    "annual": schedule.rows.iter().map(weldsuite_books_domain::depreciation::DepreciationRow::json).collect::<Vec<_>>(),
                    "issues": schedule.issues.iter().map(weldsuite_books_domain::depreciation::DepreciationIssue::json).collect::<Vec<_>>(),
                });
                if book["postsToLedger"] == json!(true) {
                    view["monthly"] = Value::Array(
                        stored
                            .iter()
                            .filter(|row| row["bookId"] == book["id"])
                            .map(|row| {
                                json!({
                                    "periodStart": row["periodStart"],
                                    "periodEnd": row["periodEnd"],
                                    "amount": row["amount"],
                                    "accumulated": row["accumulated"],
                                    "journalEntryId": row["journalEntryId"],
                                })
                            })
                            .collect(),
                    );
                }
                view
            })
            .collect();
        Ok(ok(json!({ "assetId": id, "schedules": schedules })))
    }
    .await;
    finish(result, "build the depreciation schedule")
}

// ---------------------------------------------------------------------------
// PATCH /:id, DELETE /:id

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let patch = match validate(&headers, &body, read_update) {
        Ok(patch) => patch,
        Err(refusal) => return refusal.respond("Failed to update the fixed asset"),
    };
    let result = async {
        let result = assets::update_fixed_asset(&caller.db, &id, &patch).await?;
        let entity_id = text(&result.asset, "entityId").to_owned();
        audit(
            &caller,
            &entity_id,
            &id,
            "updated",
            Some(result.changes.clone()),
        )
        .await;
        caller.publish_changes(
            &state,
            FIXED_ASSET_UPDATED,
            &id,
            result.asset.clone(),
            result.changes,
        );
        let mut data = result.asset;
        data["books"] = Value::Array(result.books);
        data["issues"] = issues_json(&result.issues);
        Ok(ok(data))
    }
    .await;
    finish(result, "update the fixed asset")
}

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let asset = assets::delete_fixed_asset(&caller.db, &id).await?;
        audit(&caller, text(&asset, "entityId"), &id, "deleted", None).await;
        caller.publish(&state, FIXED_ASSET_DELETED, &id, json!({ "id": id }));
        Ok(no_content())
    }
    .await;
    finish(result, "delete the fixed asset")
}

// ---------------------------------------------------------------------------
// POST /:id/dispose

fn read_dispose(issues: &mut Issues, body: &Map<String, Value>) -> disposal::DisposeInput {
    let mut deferred = Deferred::default();
    let date = date(issues, body, "date", Presence::Required);
    // `.default(0)`: a missing amount is 0, then refined.
    let proceeds = if body.contains_key("proceeds") {
        amount(issues, &mut deferred, body, "proceeds", true, NEGATIVE)
    } else {
        Some(0.0)
    };
    let deposit = optional_id(issues, body, "depositAccountId");
    let gain_loss = optional_id(issues, body, "gainLossAccountId");
    deferred.settle(issues);
    disposal::DisposeInput {
        date: date.unwrap_or_default(),
        proceeds: proceeds.unwrap_or(0.0),
        deposit_account_id: deposit.into_option(),
        gain_loss_account_id: gain_loss.into_option(),
    }
}

async fn dispose(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, read_dispose) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond("Failed to dispose of the fixed asset"),
    };
    let result = async {
        let result =
            disposal::dispose_fixed_asset(&caller.db, &id, Some(&caller.user_id), &input).await?;
        let entity_id = text(&result.asset, "entityId").to_owned();
        let mut changes = Map::new();
        changes.insert(
            "disposalDate".to_owned(),
            change(Value::Null, json!(input.date)),
        );
        changes.insert(
            "proceeds".to_owned(),
            change(
                Value::Null,
                weldsuite_books_domain::js::number_value(result.proceeds),
            ),
        );
        changes.insert(
            "gainOrLoss".to_owned(),
            change(
                Value::Null,
                weldsuite_books_domain::js::number_value(result.gain_or_loss),
            ),
        );
        audit(&caller, &entity_id, &id, "disposed", Some(changes)).await;
        caller.publish(&state, FIXED_ASSET_DISPOSED, &id, result.asset.clone());
        Ok(ok(result.json))
    }
    .await;
    finish(result, "dispose of the fixed asset")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimals_and_cursors() {
        assert!(is_decimal("12"));
        assert!(is_decimal("-12.50"));
        assert!(!is_decimal("12."));
        assert!(!is_decimal("1e5"));
        assert!(!is_decimal(""));
        let cursor = encode_cursor("2026-01-01T00:00:00.000Z", "fa_1");
        assert_eq!(
            decode_cursor(&cursor),
            Some(("2026-01-01T00:00:00.000Z".to_owned(), "fa_1".to_owned()))
        );
        assert!(decode_cursor("!!").is_none());
    }
}
