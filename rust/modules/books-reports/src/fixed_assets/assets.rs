//! Fixed assets (`services/fixed-assets/assets.ts`): creating, changing and
//! deleting them, with their books and the stored rows of the ledger book.
//!
//! `fixed_assets` + `fixed_asset_books` hold the asset and each book's setup;
//! `fixed_asset_depreciation` one row per month (or 4-4-5 period) of the one
//! book that posts to the ledger. Tax books are computed on demand. Once
//! anything is posted (or the asset is disposed) the financial facts freeze.

use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder,
    QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::dates::is_iso_date;
use weldsuite_books_domain::depreciation::{DepreciationSchedule, depreciation_basis};
use weldsuite_books_domain::guards::{PostingCheck, PostingLockKind, assert_posting_allowed};
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::js::{locale_compare, math_round, to_fixed};
use weldsuite_books_domain::posting::{
    EntityAccounts, PostJournalEntryInput, PostingLine, account_for_role, load_entity_accounts,
    post_journal_entry,
};
use weldsuite_books_domain::reports_basis::periods::fiscal_config_of;
use weldsuite_books_domain::tables::{FIXED_ASSET_BOOKS, FIXED_ASSETS};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{OrmConn, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    accounting_dimension_values, bill_items, bills, entities, fixed_asset_books,
    fixed_asset_depreciation, fixed_assets,
};

use super::books::{
    BookAssetFacts, BookInput, BookIssue, NormalizedBook, default_books, normalize_books,
};
use super::schedules::{
    AssetWithBook, LedgerRowInput, ScheduleContext, annual_schedule, ledger_rows,
    macrs_convention_map,
};
use super::shared::{
    Conventions, Fail, as_number, bad, conflict, default_convention, effective_convention,
    is_macrs_book, iso_day, money, not_found, num, opt, present, text, to_cents,
    to_depreciation_asset, to_depreciation_book,
};
use crate::rows::{decimal_of, js, js_rows, now_and_stamp};

/// `fixedAssets`, written from `{ column: value }` objects as Drizzle's
/// `insert` / `update` wrote them.
const ASSETS: JsonTable = JsonTable::of::<fixed_assets::Entity>();
/// `fixedAssetBooks`.
const BOOKS: JsonTable = JsonTable::of::<fixed_asset_books::Entity>();
/// `fixedAssetDepreciation`.
const DEPRECIATION: JsonTable = JsonTable::of::<fixed_asset_depreciation::Entity>();

// ---------------------------------------------------------------------------
// Loading

/// `loadEntity(db, entityId)`.
pub(crate) async fn load_entity(db: &PgPool, entity_id: &str) -> Result<Value, Fail> {
    let row = entities::Entity::find_by_id(entity_id.to_owned())
        .filter(entities::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    match row {
        Some(row) => Ok(js!(row)?),
        None => Err(not_found("Accounting entity not found")),
    }
}

/// `loadAsset(db, id)`.
pub(crate) async fn load_asset(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let row = fixed_assets::Entity::find_by_id(id.to_owned())
        .filter(fixed_assets::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    row.map(|row| js!(row)).transpose()
}

fn book_order(book: &Value) -> i64 {
    match text(book, "book") {
        "book" => 0,
        "federal" => 1,
        "state" => 2,
        _ => 9,
    }
}

/// `loadBooks(db, assetId)`: book, federal, then the states.
pub(crate) async fn load_books(db: &PgPool, asset_id: &str) -> Result<Vec<Value>, DbErr> {
    let rows = fixed_asset_books::Entity::find()
        .filter(fixed_asset_books::Column::AssetId.eq(asset_id))
        .all(&orm(db))
        .await?;
    let mut rows = js_rows!(rows)?;
    rows.sort_by(|a, b| {
        book_order(a).cmp(&book_order(b)).then_with(|| {
            locale_compare(
                opt(a, "stateCode").unwrap_or_default(),
                opt(b, "stateCode").unwrap_or_default(),
            )
        })
    });
    Ok(rows)
}

/// `loadEntityBookRows(db, entityId)`: every live asset of the entity with
/// each of its books.
pub(crate) async fn load_entity_book_rows(
    db: &PgPool,
    entity_id: &str,
) -> Result<Vec<AssetWithBook>, DbErr> {
    let rows = fixed_asset_books::Entity::find()
        .join(JoinType::InnerJoin, book_asset())
        .select_also(fixed_assets::Entity)
        .filter(fixed_assets::Column::EntityId.eq(entity_id))
        .filter(fixed_assets::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?;
    // The inner join always has the asset.
    rows.into_iter()
        .filter_map(|(book, asset)| Some((asset?, book)))
        .map(|(asset, book)| Ok((js!(asset)?, js!(book)?)))
        .collect()
}

/// `innerJoin(fixedAssets, eq(fixedAssetBooks.assetId, fixedAssets.id))`.
fn book_asset() -> RelationDef {
    fixed_asset_books::Entity::belongs_to(fixed_assets::Entity)
        .from(fixed_asset_books::Column::AssetId)
        .to(fixed_assets::Column::Id)
        .into()
}

/// `loadLedgerRows(db, assetId, bookId)`, by period.
pub(crate) async fn load_ledger_rows(
    db: &PgPool,
    asset_id: &str,
    book_id: Option<&str>,
) -> Result<Vec<Value>, DbErr> {
    let mut rows = fixed_asset_depreciation::Entity::find()
        .filter(fixed_asset_depreciation::Column::AssetId.eq(asset_id));
    if let Some(book_id) = book_id {
        rows = rows.filter(fixed_asset_depreciation::Column::BookId.eq(book_id));
    }
    let rows = rows
        .order_by_asc(fixed_asset_depreciation::Column::PeriodStart)
        .all(&orm(db))
        .await?;
    js_rows!(rows)
}

/// `hasPostedDepreciation(db, assetId)`.
async fn has_posted_depreciation(db: &PgPool, asset_id: &str) -> Result<bool, DbErr> {
    let row: Option<String> = fixed_asset_depreciation::Entity::find()
        .select_only()
        .column(fixed_asset_depreciation::Column::Id)
        .filter(fixed_asset_depreciation::Column::AssetId.eq(asset_id))
        .filter(fixed_asset_depreciation::Column::JournalEntryId.is_not_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.is_some())
}

/// `scheduleContextFor(db, entity)`.
pub(crate) async fn schedule_context_for(
    db: &PgPool,
    entity: &Value,
) -> Result<ScheduleContext, DbErr> {
    let config = fiscal_config_of(entity);
    let rows = load_entity_book_rows(db, text(entity, "id")).await?;
    let conventions = macrs_convention_map(&config, &rows);
    Ok(ScheduleContext {
        config,
        conventions,
    })
}

// ---------------------------------------------------------------------------
// Accounts and dimensions

/// `AccountIds`.
pub(crate) struct AccountIds {
    pub(crate) asset: String,
    pub(crate) accumulated: String,
    pub(crate) expense: String,
}

fn account_id(account: &Value) -> String {
    text(account, "id").to_owned()
}

/// `resolveAssetAccounts(accounts, given)`.
pub(crate) fn resolve_asset_accounts(
    accounts: &EntityAccounts,
    asset: Option<&str>,
    accumulated: Option<&str>,
    expense: Option<&str>,
) -> Result<AccountIds, Fail> {
    let pick = |id: Option<&str>, label: &str, fallback: Option<&Value>, hint: &str| {
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            if accounts.by_id(Some(id)).is_none() {
                return Err(bad(format!(
                    "{label} does not belong to this accounting entity"
                )));
            }
            return Ok(id.to_owned());
        }
        fallback.map(account_id).ok_or_else(|| {
            bad(format!(
                "Choose {hint}: this chart of accounts has no default for it. Pick one, or add it to the chart of accounts."
            ))
        })
    };
    Ok(AccountIds {
        asset: pick(
            asset,
            "assetAccountId",
            // The codes: the NL template's accounts, for entities seeded before the roles were on them.
            account_for_role(accounts, "fixed_assets", &["0200"])
                .or_else(|| accounts.by_subtype("fixed_assets"))
                .or_else(|| accounts.by_subtype("fixed_asset")),
            "a fixed asset account",
        )?,
        accumulated: pick(
            accumulated,
            "accumulatedDepreciationAccountId",
            account_for_role(accounts, "accumulated_depreciation", &["0290"]),
            "an accumulated depreciation account",
        )?,
        expense: pick(
            expense,
            "depreciationExpenseAccountId",
            account_for_role(accounts, "depreciation_expense", &["4700"])
                .or_else(|| accounts.by_subtype("depreciation")),
            "a depreciation expense account",
        )?,
    })
}

async fn assert_dimension(
    db: &PgPool,
    entity_id: &str,
    id: Option<&str>,
    dimension: &str,
) -> Result<(), Fail> {
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let row: Option<String> = accounting_dimension_values::Entity::find()
        .select_only()
        .column(accounting_dimension_values::Column::Id)
        .filter(accounting_dimension_values::Column::Id.eq(id))
        .filter(accounting_dimension_values::Column::EntityId.eq(entity_id))
        .filter(accounting_dimension_values::Column::Dimension.eq(dimension))
        .filter(accounting_dimension_values::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    if row.is_none() {
        return Err(bad(format!(
            "{dimension}Id is not a {dimension} of this accounting entity"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Input

/// `AssetInput` (create and from-bill-line).
#[derive(Debug, Clone, Default)]
pub(crate) struct AssetInput {
    pub(crate) name: String,
    pub(crate) asset_number: Option<String>,
    pub(crate) description: Option<String>,
    pub(crate) asset_class: Option<String>,
    pub(crate) asset_account_id: Option<String>,
    pub(crate) accumulated_depreciation_account_id: Option<String>,
    pub(crate) depreciation_expense_account_id: Option<String>,
    pub(crate) acquisition_date: String,
    pub(crate) placed_in_service_date: String,
    pub(crate) cost: f64,
    pub(crate) salvage_value: Option<f64>,
    pub(crate) business_use_percent: Option<f64>,
    pub(crate) listed_property: Option<bool>,
    pub(crate) bill_id: Option<String>,
    pub(crate) bill_item_id: Option<String>,
    pub(crate) class_id: Option<String>,
    pub(crate) location_id: Option<String>,
    pub(crate) notes: Option<String>,
    pub(crate) useful_life_years: Option<f64>,
    pub(crate) section_179_amount: Option<f64>,
    pub(crate) bonus_percent: Option<f64>,
    pub(crate) bonus_reduced_election: Option<bool>,
    pub(crate) books: Option<Vec<BookInput>>,
}

/// A patched field: left out, `null`, or a value.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) enum Patch<T> {
    #[default]
    Absent,
    Null,
    Set(T),
}

impl<T: Clone> Patch<T> {
    fn given(&self) -> bool {
        !matches!(self, Self::Absent)
    }

    fn set(&self) -> Option<T> {
        match self {
            Self::Set(value) => Some(value.clone()),
            _ => None,
        }
    }
}

impl<T> From<weldsuite_kit::validation::Field<T>> for Patch<T> {
    fn from(field: weldsuite_kit::validation::Field<T>) -> Self {
        use weldsuite_kit::validation::Field;
        match field {
            Field::Absent => Self::Absent,
            Field::Null => Self::Null,
            Field::Set(value) => Self::Set(value),
        }
    }
}

/// `AssetPatch`.
#[derive(Debug, Clone, Default)]
pub(crate) struct AssetPatch {
    pub(crate) name: Patch<String>,
    pub(crate) asset_number: Patch<String>,
    pub(crate) description: Patch<String>,
    pub(crate) asset_class: Patch<String>,
    pub(crate) asset_account_id: Option<String>,
    pub(crate) accumulated_depreciation_account_id: Option<String>,
    pub(crate) depreciation_expense_account_id: Option<String>,
    pub(crate) acquisition_date: Option<String>,
    pub(crate) placed_in_service_date: Option<String>,
    pub(crate) cost: Option<f64>,
    pub(crate) salvage_value: Option<f64>,
    pub(crate) business_use_percent: Option<f64>,
    pub(crate) listed_property: Option<bool>,
    pub(crate) class_id: Patch<String>,
    pub(crate) location_id: Patch<String>,
    pub(crate) notes: Patch<String>,
    pub(crate) books: Option<Vec<BookInput>>,
}

fn validate_dates(acquisition: &str, placed: &str) -> Result<(), Fail> {
    if !is_iso_date(acquisition) || !is_iso_date(placed) {
        return Err(bad(
            "acquisitionDate and placedInServiceDate must be dates (YYYY-MM-DD)",
        ));
    }
    if placed < acquisition {
        return Err(bad("placedInServiceDate cannot be before acquisitionDate"));
    }
    Ok(())
}

fn validate_amounts(cost: f64, salvage: f64, business_use: f64) -> Result<(), Fail> {
    if !cost.is_finite() || cost <= 0.0 {
        return Err(bad("cost must be greater than zero"));
    }
    if !salvage.is_finite() || salvage < 0.0 {
        return Err(bad("salvageValue cannot be negative"));
    }
    if salvage > cost {
        return Err(bad("salvageValue cannot exceed the cost"));
    }
    if !business_use.is_finite() || !(0.0..=100.0).contains(&business_use) {
        return Err(bad("businessUsePercent is 0 to 100"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Building rows

fn book_row_from(asset: &Value, input: &NormalizedBook, id: &str, at: &str) -> Value {
    json!({
        "id": id,
        "createdAt": at,
        "updatedAt": at,
        "entityId": asset["entityId"],
        "assetId": asset["id"],
        "book": input.book,
        "stateCode": input.state_code,
        "method": input.method,
        "convention": input.convention,
        "recoveryYears": to_fixed(input.recovery_years, 1),
        "section179Amount": to_fixed(input.section_179_amount, 2),
        "bonusPercent": to_fixed(input.bonus_percent, 4),
        "depreciableBasis": "0.00",
        "postsToLedger": input.posts_to_ledger,
    })
}

/// The ledger book and its rows.
pub(crate) type Ledger = Option<(Value, Vec<LedgerRowInput>)>;

/// `finishBooks(asset, books, config, conventions)`: each book's convention
/// and depreciable basis, the ledger rows, and the schedules' issues.
fn finish_books(
    asset: &Value,
    books: Vec<Value>,
    context: &ScheduleContext,
) -> (Vec<Value>, Ledger, Vec<BookIssue>) {
    let asset_id = text(asset, "id");
    let finished: Vec<Value> = books
        .into_iter()
        .map(|mut book| {
            let convention = effective_convention(&book, asset_id, &context.conventions);
            let basis = depreciation_basis(
                &to_depreciation_asset(asset, None, Some(&book)),
                &to_depreciation_book(&book, Some(&convention)),
            );
            book["convention"] = json!(convention);
            book["depreciableBasis"] = json!(to_fixed(basis.depreciable_basis, 2));
            book
        })
        .collect();
    let mut issues = Vec::new();
    for book in &finished {
        let schedule = annual_schedule(asset, book, context);
        push_schedule_issues(&mut issues, book, &schedule);
    }
    let ledger = finished
        .iter()
        .find(|book| book["postsToLedger"] == json!(true))
        .map(|book| {
            let rows = ledger_rows(asset, book, &context.config, None).rows;
            (book.clone(), rows)
        });
    (finished, ledger, issues)
}

fn push_schedule_issues(
    issues: &mut Vec<BookIssue>,
    book: &Value,
    schedule: &DepreciationSchedule,
) {
    for issue in &schedule.issues {
        issues.push(BookIssue {
            book: text(book, "book").to_owned(),
            state_code: opt(book, "stateCode").map(str::to_owned),
            severity: issue.severity.to_owned(),
            code: issue.code.to_owned(),
            message: issue.message.clone(),
        });
    }
}

/// `ledgerInsertRows(asset, book, rows, now, skipStarts)`.
fn ledger_insert_rows(
    asset: &Value,
    book: &Value,
    rows: &[LedgerRowInput],
    at: &str,
    skip_starts: &HashSet<String>,
) -> Vec<Map<String, Value>> {
    rows.iter()
        .filter(|row| to_cents(row.amount) != 0 && !skip_starts.contains(&row.period_start))
        .map(|row| {
            let values = json!({
                "id": generate_id("fad"),
                "created_at": at,
                "entity_id": asset["entityId"],
                "asset_id": asset["id"],
                "book_id": book["id"],
                "period_start": row.period_start,
                "period_end": row.period_end,
                "amount": to_fixed(row.amount, 2),
                "accumulated": to_fixed(row.accumulated, 2),
                "journal_entry_id": null,
            });
            match values {
                Value::Object(map) => map,
                _ => Map::new(),
            }
        })
        .collect()
}

async fn insert_ledger_rows<C: ConnectionTrait>(
    db: &C,
    rows: &[Map<String, Value>],
) -> Result<(), DbErr> {
    for row in rows {
        DEPRECIATION.insert(db, row.clone()).await?;
    }
    Ok(())
}

/// Delete the asset's depreciation rows: all of them, or with a book only
/// that book's unposted rows.
async fn delete_ledger_rows<C: ConnectionTrait>(
    db: &C,
    asset_id: &str,
    book_id: Option<&str>,
) -> Result<(), DbErr> {
    let mut delete = fixed_asset_depreciation::Entity::delete_many()
        .filter(fixed_asset_depreciation::Column::AssetId.eq(asset_id));
    if let Some(book_id) = book_id {
        delete = delete
            .filter(fixed_asset_depreciation::Column::BookId.eq(book_id))
            .filter(fixed_asset_depreciation::Column::JournalEntryId.is_null());
    }
    delete.exec(db).await?;
    Ok(())
}

/// `delete(fixedAssetBooks).where(eq(assetId))`.
async fn delete_books<C: ConnectionTrait>(db: &C, asset_id: &str) -> Result<(), DbErr> {
    fixed_asset_books::Entity::delete_many()
        .filter(fixed_asset_books::Column::AssetId.eq(asset_id))
        .exec(db)
        .await?;
    Ok(())
}

/// The columns of a book row, for an insert.
fn book_values(book: &Value) -> Map<String, Value> {
    let mut values = Map::new();
    if let Value::Object(fields) = book {
        for (key, value) in fields {
            if let Some(column) = FIXED_ASSET_BOOKS.column(key) {
                values.insert(column.name.to_owned(), value.clone());
            }
        }
    }
    values
}

fn asset_values(asset: &Value) -> Map<String, Value> {
    let mut values = Map::new();
    if let Value::Object(fields) = asset {
        for (key, value) in fields {
            if let Some(column) = FIXED_ASSETS.column(key) {
                values.insert(column.name.to_owned(), value.clone());
            }
        }
    }
    values
}

/// `replaceLedgerRowStatements(h, asset, book, rows, posted, now)`: swap a
/// book's unposted rows for a fresh schedule; posted rows stay.
pub(crate) async fn replace_ledger_rows(
    db: &PgPool,
    asset: &Value,
    book: &Value,
    rows: &[LedgerRowInput],
    posted: &[Value],
) -> Result<(), Fail> {
    let posted_starts: HashSet<String> = posted
        .iter()
        .map(|row| text(row, "periodStart").to_owned())
        .collect();
    let inserts = ledger_insert_rows(asset, book, rows, &now(), &posted_starts);
    let asset_id = text(asset, "id").to_owned();
    let book_id = text(book, "id").to_owned();
    weldsuite_db::atomically_with::<_, (), Fail, _>(db, move |conn| {
        Box::pin(async move {
            let tx = OrmConn::new(conn);
            delete_ledger_rows(&tx, &asset_id, Some(&book_id)).await?;
            insert_ledger_rows(&tx, &inserts).await?;
            Ok(())
        })
    })
    .await
}

/// `assertPostedMatch(posted, rows, what)`: the new schedule has to
/// reproduce every posted row.
pub(crate) fn assert_posted_match(
    posted: &[Value],
    rows: &[LedgerRowInput],
    what: &str,
) -> Result<(), Fail> {
    let by_start: HashMap<&str, &LedgerRowInput> = rows
        .iter()
        .map(|row| (row.period_start.as_str(), row))
        .collect();
    for row in posted {
        let start = text(row, "periodStart");
        let same = by_start
            .get(start)
            .is_some_and(|next| to_cents(next.amount) == to_cents(num(row, "amount")));
        if !same {
            let month: String = start.chars().take(7).collect();
            return Err(conflict(format!(
                "{what} would change depreciation already posted for {month}. Reverse the posted depreciation first, or leave this field as it is."
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Detail

/// `scheduleView(schedule)`.
pub(crate) fn schedule_view(schedule: &DepreciationSchedule) -> Value {
    json!({
        "method": schedule.method,
        "convention": schedule.convention,
        "recoveryYears": weldsuite_books_domain::js::number_value(schedule.recovery_years),
        "basis": schedule.basis.json(),
        "annual": schedule.rows.iter().map(weldsuite_books_domain::depreciation::DepreciationRow::json).collect::<Vec<_>>(),
        "issues": schedule.issues.iter().map(weldsuite_books_domain::depreciation::DepreciationIssue::json).collect::<Vec<_>>(),
    })
}

/// `assetDetail(db, asset)`: the asset with its books and schedules, the
/// stored ledger rows and what is posted.
pub(crate) async fn asset_detail(db: &PgPool, asset: &Value) -> Result<Value, Fail> {
    let entity = load_entity(db, text(asset, "entityId")).await?;
    let context = schedule_context_for(db, &entity).await?;
    let asset_id = text(asset, "id");
    let books = load_books(db, asset_id).await?;
    let rows = load_ledger_rows(db, asset_id, None).await?;
    let mut issues = Vec::new();
    let with_schedules: Vec<Value> = books
        .into_iter()
        .map(|mut book| {
            let schedule = annual_schedule(asset, &book, &context);
            push_schedule_issues(&mut issues, &book, &schedule);
            book["schedule"] = schedule_view(&schedule);
            book
        })
        .collect();
    let posted: i64 = rows
        .iter()
        .filter(|row| present(row, "journalEntryId").is_some())
        .map(|row| to_cents(num(row, "amount")))
        .sum();
    let mut detail = asset.clone();
    detail["books"] = Value::Array(with_schedules);
    detail["ledgerRows"] = Value::Array(rows);
    detail["accumulatedPosted"] = json!(money(posted));
    detail["netBookValuePosted"] = json!(money(to_cents(num(asset, "cost")) - posted));
    detail["issues"] = super::books::issues_json(&issues);
    Ok(detail)
}

// ---------------------------------------------------------------------------
// Create

/// `CreateResult`.
pub(crate) struct Created {
    pub(crate) asset: Value,
    pub(crate) books: Vec<Value>,
    pub(crate) issues: Vec<BookIssue>,
}

/// `createFixedAsset(db, { entityId, input, id })`.
#[allow(clippy::too_many_lines)] // the service's steps, in order
pub(crate) async fn create_fixed_asset(
    db: &PgPool,
    entity_id: &str,
    input: &AssetInput,
    id: Option<String>,
) -> Result<Created, Fail> {
    let entity = load_entity(db, entity_id).await?;
    let config = fiscal_config_of(&entity);
    validate_dates(&input.acquisition_date, &input.placed_in_service_date)?;
    let salvage = input.salvage_value.unwrap_or(0.0);
    let business_use = input.business_use_percent.unwrap_or(100.0);
    validate_amounts(input.cost, salvage, business_use)?;
    let name = weldsuite_kit::validation::js_trim(&input.name);
    if name.is_empty() {
        return Err(bad("name is required"));
    }

    let accounts = load_entity_accounts(db, entity_id).await?;
    let account_ids = resolve_asset_accounts(
        &accounts,
        input.asset_account_id.as_deref(),
        input.accumulated_depreciation_account_id.as_deref(),
        input.depreciation_expense_account_id.as_deref(),
    )?;
    assert_dimension(db, entity_id, input.class_id.as_deref(), "class").await?;
    assert_dimension(db, entity_id, input.location_id.as_deref(), "location").await?;

    let facts = BookAssetFacts {
        asset_class: input.asset_class.clone(),
        acquisition_date: input.acquisition_date.clone(),
        placed_in_service_date: input.placed_in_service_date.clone(),
        cost: input.cost,
        business_use_percent: business_use,
        listed_property: input.listed_property.unwrap_or(false),
        useful_life_years: input.useful_life_years,
        section_179_amount: input.section_179_amount,
        bonus_percent: input.bonus_percent,
        bonus_reduced_election: input.bonus_reduced_election.unwrap_or(false),
    };
    let requested = match &input.books {
        Some(books) if !books.is_empty() => books.clone(),
        _ => default_books(text(&entity, "jurisdictionCode"), &facts),
    };
    let (normalized, normalize_issues) = normalize_books(&requested, &facts)?;

    let at = now();
    let asset_id = id.unwrap_or_else(|| generate_id("fa"));
    let asset = json!({
        "id": asset_id,
        "createdAt": at,
        "updatedAt": at,
        "deletedAt": null,
        "entityId": entity_id,
        "assetNumber": input.asset_number,
        "name": name,
        "description": input.description,
        "assetClass": input.asset_class,
        "assetAccountId": account_ids.asset,
        "accumulatedDepreciationAccountId": account_ids.accumulated,
        "depreciationExpenseAccountId": account_ids.expense,
        "acquisitionDate": input.acquisition_date,
        "placedInServiceDate": input.placed_in_service_date,
        "cost": to_fixed(input.cost, 2),
        "salvageValue": to_fixed(salvage, 2),
        "businessUsePercent": to_fixed(business_use, 4),
        "billId": input.bill_id,
        "billItemId": input.bill_item_id,
        "status": "active",
        "disposalDate": null,
        "disposalProceeds": null,
        "disposalJournalEntryId": null,
        "classId": input.class_id,
        "locationId": input.location_id,
        "notes": input.notes,
    });
    if let Some(number) = input.asset_number.as_deref().filter(|n| !n.is_empty())
        && asset_number_taken(db, entity_id, number).await?
    {
        return Err(conflict(format!("Asset number {number} is already in use")));
    }

    let draft_books: Vec<Value> = normalized
        .iter()
        .map(|book| book_row_from(&asset, book, &generate_id("fab"), &at))
        .collect();
    let mut all = load_entity_book_rows(db, entity_id).await?;
    all.extend(draft_books.iter().map(|book| (asset.clone(), book.clone())));
    let context = ScheduleContext {
        conventions: macrs_convention_map(&config, &all),
        config,
    };
    let (books, ledger, built_issues) = finish_books(&asset, draft_books, &context);

    let ledger_inserts = ledger.as_ref().map_or_else(Vec::new, |(book, rows)| {
        ledger_insert_rows(&asset, book, rows, &at, &HashSet::new())
    });
    let asset_row = asset_values(&asset);
    let book_rows: Vec<Map<String, Value>> = books.iter().map(book_values).collect();
    weldsuite_db::atomically_with::<_, (), Fail, _>(db, move |conn| {
        Box::pin(async move {
            let tx = OrmConn::new(conn);
            ASSETS.insert(&tx, asset_row).await?;
            for book in book_rows {
                BOOKS.insert(&tx, book).await?;
            }
            insert_ledger_rows(&tx, &ledger_inserts).await?;
            Ok(())
        })
    })
    .await?;
    refresh_macrs_conventions(db, &entity).await?;

    let mut issues = normalize_issues;
    issues.extend(built_issues);
    Ok(Created {
        asset,
        books,
        issues,
    })
}

async fn asset_number_taken(db: &PgPool, entity_id: &str, number: &str) -> Result<bool, DbErr> {
    let row: Option<String> = fixed_assets::Entity::find()
        .select_only()
        .column(fixed_assets::Column::Id)
        .filter(fixed_assets::Column::EntityId.eq(entity_id))
        .filter(fixed_assets::Column::AssetNumber.eq(number))
        .filter(fixed_assets::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.is_some())
}

/// `refreshMacrsConventions(db, entity)`: store each MACRS book's convention
/// from the mid-quarter test over the entity's federal assets.
pub(crate) async fn refresh_macrs_conventions(db: &PgPool, entity: &Value) -> Result<usize, DbErr> {
    let config = fiscal_config_of(entity);
    let rows = load_entity_book_rows(db, text(entity, "id")).await?;
    let conventions: Conventions = macrs_convention_map(&config, &rows);
    let mut changed = 0;
    for (asset, book) in &rows {
        if !is_macrs_book(book) {
            continue;
        }
        let want = conventions
            .get(text(asset, "id"))
            .copied()
            .unwrap_or_else(|| {
                default_convention(text(book, "method"), num(book, "recoveryYears"))
            });
        if want == text(book, "convention") {
            continue;
        }
        fixed_asset_books::Entity::update_many()
            .col_expr(fixed_asset_books::Column::Convention, Expr::value(want))
            .col_expr(
                fixed_asset_books::Column::UpdatedAt,
                Expr::value(weldsuite_db::utc_now()),
            )
            .filter(fixed_asset_books::Column::Id.eq(text(book, "id")))
            .exec(&orm(db))
            .await?;
        changed += 1;
    }
    Ok(changed)
}

// ---------------------------------------------------------------------------
// Update

/// `UpdateResult`.
pub(crate) struct Updated {
    pub(crate) asset: Value,
    pub(crate) books: Vec<Value>,
    pub(crate) issues: Vec<BookIssue>,
    pub(crate) changes: Map<String, Value>,
}

/// `note(key, old, new)`: a change when the values differ (`!==`).
fn note(changes: &mut Map<String, Value>, key: &str, old: &Value, new: &Value) {
    if old != new {
        changes.insert(key.to_owned(), json!({ "old": old, "new": new }));
    }
}

fn patch_value(patch: &Patch<String>) -> Value {
    match patch {
        Patch::Set(value) => json!(value),
        _ => Value::Null,
    }
}

/// `updateFixedAsset(db, { assetId, patch })`.
#[allow(clippy::too_many_lines)] // the service's steps, in order
pub(crate) async fn update_fixed_asset(
    db: &PgPool,
    asset_id: &str,
    patch: &AssetPatch,
) -> Result<Updated, Fail> {
    let Some(before) = load_asset(db, asset_id).await? else {
        return Err(not_found("Fixed asset not found"));
    };
    let entity_id = text(&before, "entityId").to_owned();
    let entity = load_entity(db, &entity_id).await?;
    let config = fiscal_config_of(&entity);

    let mut changes = Map::new();
    let mut set = Map::new();
    let cosmetic: [(&str, &Patch<String>); 7] = [
        ("name", &patch.name),
        ("assetNumber", &patch.asset_number),
        ("description", &patch.description),
        ("assetClass", &patch.asset_class),
        ("classId", &patch.class_id),
        ("locationId", &patch.location_id),
        ("notes", &patch.notes),
    ];
    for (key, value) in cosmetic {
        if !value.given() {
            continue;
        }
        if key == "name"
            && weldsuite_kit::validation::js_trim(&value.set().unwrap_or_default()).is_empty()
        {
            return Err(bad("name cannot be empty"));
        }
        let new = patch_value(value);
        set.insert(key.to_owned(), new.clone());
        note(
            &mut changes,
            key,
            before.get(key).unwrap_or(&Value::Null),
            &new,
        );
    }
    if patch.class_id.given() {
        assert_dimension(db, &entity_id, patch.class_id.set().as_deref(), "class").await?;
    }
    if patch.location_id.given() {
        assert_dimension(
            db,
            &entity_id,
            patch.location_id.set().as_deref(),
            "location",
        )
        .await?;
    }
    if let Some(number) = patch.asset_number.set().filter(|n| !n.is_empty())
        && Some(number.as_str()) != opt(&before, "assetNumber")
        && asset_number_taken(db, &entity_id, &number).await?
    {
        return Err(conflict(format!("Asset number {number} is already in use")));
    }

    // Which financial fields actually change?
    let pick = |given: &Option<String>, key: &str| {
        given.clone().map_or_else(
            || before.get(key).cloned().unwrap_or(Value::Null),
            Value::String,
        )
    };
    let fixed = |given: Option<f64>, key: &str, digits: usize| {
        given.map_or_else(
            || before.get(key).cloned().unwrap_or(Value::Null),
            |value| json!(to_fixed(value, digits)),
        )
    };
    let next: [(&str, Value); 8] = [
        (
            "assetAccountId",
            pick(&patch.asset_account_id, "assetAccountId"),
        ),
        (
            "accumulatedDepreciationAccountId",
            pick(
                &patch.accumulated_depreciation_account_id,
                "accumulatedDepreciationAccountId",
            ),
        ),
        (
            "depreciationExpenseAccountId",
            pick(
                &patch.depreciation_expense_account_id,
                "depreciationExpenseAccountId",
            ),
        ),
        (
            "acquisitionDate",
            pick(&patch.acquisition_date, "acquisitionDate"),
        ),
        (
            "placedInServiceDate",
            pick(&patch.placed_in_service_date, "placedInServiceDate"),
        ),
        ("cost", fixed(patch.cost, "cost", 2)),
        (
            "salvageValue",
            fixed(patch.salvage_value, "salvageValue", 2),
        ),
        (
            "businessUsePercent",
            fixed(patch.business_use_percent, "businessUsePercent", 4),
        ),
    ];
    let numeric = |key: &str| matches!(key, "cost" | "salvageValue" | "businessUsePercent");
    #[allow(clippy::float_cmp)] // `!==` on the numbers, as TypeScript
    let financial_change = patch.books.is_some()
        || next.iter().any(|(key, value)| {
            let old = before.get(*key).unwrap_or(&Value::Null);
            if numeric(key) {
                as_number(Some(value), 0.0) != as_number(Some(old), 0.0)
            } else {
                value != old
            }
        });

    if !financial_change {
        if !set.is_empty() {
            let mut values = Map::new();
            for (key, value) in &set {
                FIXED_ASSETS.set(&mut values, key, value.clone());
            }
            FIXED_ASSETS.set(&mut values, "updatedAt", json!(now()));
            ASSETS.update(&orm(db), asset_id, values, false).await?;
        }
        let asset = load_asset(db, asset_id).await?.unwrap_or(Value::Null);
        let books = load_books(db, asset_id).await?;
        return Ok(Updated {
            asset,
            books,
            issues: Vec::new(),
            changes,
        });
    }

    if text(&before, "status") == "disposed" {
        return Err(conflict(
            "A disposed asset can only have its name, number, notes, class and location changed",
        ));
    }
    let posted: Vec<String> = fixed_asset_depreciation::Entity::find()
        .select_only()
        .column(fixed_asset_depreciation::Column::Id)
        .filter(fixed_asset_depreciation::Column::AssetId.eq(asset_id))
        .filter(fixed_asset_depreciation::Column::JournalEntryId.is_not_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    if !posted.is_empty() {
        let given: Vec<&str> = [
            ("assetAccountId", patch.asset_account_id.is_some()),
            (
                "accumulatedDepreciationAccountId",
                patch.accumulated_depreciation_account_id.is_some(),
            ),
            (
                "depreciationExpenseAccountId",
                patch.depreciation_expense_account_id.is_some(),
            ),
            ("acquisitionDate", patch.acquisition_date.is_some()),
            (
                "placedInServiceDate",
                patch.placed_in_service_date.is_some(),
            ),
            ("cost", patch.cost.is_some()),
            ("salvageValue", patch.salvage_value.is_some()),
            ("businessUsePercent", patch.business_use_percent.is_some()),
            ("books", patch.books.is_some()),
        ]
        .into_iter()
        .filter_map(|(key, given)| given.then_some(key))
        .collect();
        return Err(conflict(format!(
            "Depreciation has been posted for this asset, so {} can no longer change. Edit the name, number, notes, class or location, or dispose of the asset.",
            given.join(", ")
        )));
    }

    let next_text = |key: &str| {
        next.iter()
            .find(|(k, _)| *k == key)
            .and_then(|(_, v)| v.as_str())
            .unwrap_or_default()
            .to_owned()
    };
    let next_number = |key: &str, fallback: f64| {
        as_number(
            next.iter().find(|(k, _)| *k == key).map(|(_, v)| v),
            fallback,
        )
    };
    validate_dates(
        &next_text("acquisitionDate"),
        &next_text("placedInServiceDate"),
    )?;
    validate_amounts(
        next_number("cost", 0.0),
        next_number("salvageValue", 0.0),
        next_number("businessUsePercent", 100.0),
    )?;
    let accounts = load_entity_accounts(db, &entity_id).await?;
    let account_ids = resolve_asset_accounts(
        &accounts,
        Some(&next_text("assetAccountId")),
        Some(&next_text("accumulatedDepreciationAccountId")),
        Some(&next_text("depreciationExpenseAccountId")),
    )?;

    let (at, stamp) = now_and_stamp();
    let mut updated = before.clone();
    for (key, value) in &set {
        updated[key.as_str()] = value.clone();
    }
    for (key, value) in &next {
        updated[*key] = value.clone();
    }
    updated["assetAccountId"] = json!(account_ids.asset);
    updated["accumulatedDepreciationAccountId"] = json!(account_ids.accumulated);
    updated["depreciationExpenseAccountId"] = json!(account_ids.expense);
    updated["updatedAt"] = json!(at);
    for key in [
        "cost",
        "salvageValue",
        "businessUsePercent",
        "acquisitionDate",
        "placedInServiceDate",
        "assetAccountId",
        "accumulatedDepreciationAccountId",
        "depreciationExpenseAccountId",
    ] {
        note(
            &mut changes,
            key,
            before.get(key).unwrap_or(&Value::Null),
            updated.get(key).unwrap_or(&Value::Null),
        );
    }

    let facts = BookAssetFacts {
        asset_class: opt(&updated, "assetClass").map(str::to_owned),
        acquisition_date: text(&updated, "acquisitionDate").to_owned(),
        placed_in_service_date: text(&updated, "placedInServiceDate").to_owned(),
        cost: num(&updated, "cost"),
        business_use_percent: as_number(updated.get("businessUsePercent"), 100.0),
        listed_property: patch.listed_property.unwrap_or(false),
        ..BookAssetFacts::default()
    };

    let existing = load_books(db, asset_id).await?;
    let mut issues = Vec::new();
    let replace = patch.books.is_some();
    let draft_books = if let Some(books) = &patch.books {
        if books.is_empty() {
            return Err(bad("An asset needs at least one depreciation book"));
        }
        let (normalized, normalize_issues) = normalize_books(books, &facts)?;
        issues = normalize_issues;
        let drafts: Vec<Value> = normalized
            .iter()
            .map(|book| book_row_from(&updated, book, &generate_id("fab"), &at))
            .collect();
        changes.insert(
            "books".to_owned(),
            json!({
                "old": existing.iter().map(|b| b["book"].clone()).collect::<Vec<_>>(),
                "new": drafts.iter().map(|b| b["book"].clone()).collect::<Vec<_>>(),
            }),
        );
        drafts
    } else {
        existing
    };

    let mut all: Vec<AssetWithBook> = load_entity_book_rows(db, &entity_id)
        .await?
        .into_iter()
        .filter(|(asset, _)| text(asset, "id") != asset_id)
        .collect();
    all.extend(
        draft_books
            .iter()
            .map(|book| (updated.clone(), book.clone())),
    );
    let context = ScheduleContext {
        conventions: macrs_convention_map(&config, &all),
        config,
    };
    let (books, ledger, built_issues) = finish_books(&updated, draft_books, &context);

    let mut asset_set = Map::new();
    for (key, value) in &set {
        FIXED_ASSETS.set(&mut asset_set, key, value.clone());
    }
    for (key, value) in &next {
        FIXED_ASSETS.set(&mut asset_set, key, value.clone());
    }
    FIXED_ASSETS.set(&mut asset_set, "assetAccountId", json!(account_ids.asset));
    FIXED_ASSETS.set(
        &mut asset_set,
        "accumulatedDepreciationAccountId",
        json!(account_ids.accumulated),
    );
    FIXED_ASSETS.set(
        &mut asset_set,
        "depreciationExpenseAccountId",
        json!(account_ids.expense),
    );
    FIXED_ASSETS.set(&mut asset_set, "updatedAt", json!(at));

    let id = asset_id.to_owned();
    let book_rows: Vec<Map<String, Value>> = books.iter().map(book_values).collect();
    // The books kept as they are get their convention and basis rewritten.
    let book_updates: Vec<(String, String, sea_orm::prelude::BigDecimal)> = if replace {
        Vec::new()
    } else {
        books
            .iter()
            .map(|book| {
                Ok((
                    text(book, "id").to_owned(),
                    text(book, "convention").to_owned(),
                    // `$n::numeric` of the `toFixed(2)` text.
                    decimal_of(text(book, "depreciableBasis"))?,
                ))
            })
            .collect::<Result<_, DbErr>>()?
    };
    let ledger_inserts = ledger.as_ref().map_or_else(Vec::new, |(book, rows)| {
        ledger_insert_rows(&updated, book, rows, &at, &HashSet::new())
    });
    let ledger_book_id = ledger.as_ref().map(|(book, _)| text(book, "id").to_owned());
    weldsuite_db::atomically_with::<_, (), Fail, _>(db, move |conn| {
        Box::pin(async move {
            let tx = OrmConn::new(conn);
            ASSETS.update(&tx, &id, asset_set, false).await?;
            if replace {
                delete_ledger_rows(&tx, &id, None).await?;
                delete_books(&tx, &id).await?;
                for book in book_rows {
                    BOOKS.insert(&tx, book).await?;
                }
                insert_ledger_rows(&tx, &ledger_inserts).await?;
            } else {
                for (book_id, convention, basis) in book_updates {
                    fixed_asset_books::Entity::update_many()
                        .col_expr(
                            fixed_asset_books::Column::Convention,
                            Expr::value(convention),
                        )
                        .col_expr(
                            fixed_asset_books::Column::DepreciableBasis,
                            Expr::value(basis),
                        )
                        .col_expr(fixed_asset_books::Column::UpdatedAt, Expr::value(stamp))
                        .filter(fixed_asset_books::Column::Id.eq(book_id))
                        .exec(&tx)
                        .await?;
                }
                if let Some(book_id) = ledger_book_id {
                    delete_ledger_rows(&tx, &id, Some(&book_id)).await?;
                    insert_ledger_rows(&tx, &ledger_inserts).await?;
                }
            }
            Ok(())
        })
    })
    .await?;
    refresh_macrs_conventions(db, &entity).await?;

    issues.extend(built_issues);
    Ok(Updated {
        asset: updated,
        books,
        issues,
        changes,
    })
}

// ---------------------------------------------------------------------------
// Delete

/// `deleteFixedAsset(db, assetId)`.
pub(crate) async fn delete_fixed_asset(db: &PgPool, asset_id: &str) -> Result<Value, Fail> {
    let Some(asset) = load_asset(db, asset_id).await? else {
        return Err(not_found("Fixed asset not found"));
    };
    if text(&asset, "status") == "disposed" || present(&asset, "disposalJournalEntryId").is_some() {
        return Err(conflict(
            "A disposed asset stays on the register; it cannot be deleted",
        ));
    }
    if has_posted_depreciation(db, asset_id).await? {
        return Err(conflict(
            "Depreciation has been posted for this asset, so it cannot be deleted. Dispose of it instead.",
        ));
    }
    let at = weldsuite_db::utc_now();
    let id = asset_id.to_owned();
    weldsuite_db::atomically_with::<_, (), Fail, _>(db, move |conn| {
        Box::pin(async move {
            let tx = OrmConn::new(conn);
            delete_ledger_rows(&tx, &id, None).await?;
            delete_books(&tx, &id).await?;
            fixed_assets::Entity::update_many()
                .col_expr(fixed_assets::Column::DeletedAt, Expr::value(at))
                .col_expr(fixed_assets::Column::UpdatedAt, Expr::value(at))
                .filter(fixed_assets::Column::Id.eq(id))
                .exec(&tx)
                .await?;
            Ok(())
        })
    })
    .await?;
    let entity = load_entity(db, text(&asset, "entityId")).await?;
    refresh_macrs_conventions(db, &entity).await?;
    Ok(asset)
}

// ---------------------------------------------------------------------------
// From a bill line

/// `FromBillLineInput`: the asset fields, with the bill line, and `reclass`.
#[derive(Debug, Clone, Default)]
pub(crate) struct FromBillLine {
    pub(crate) bill_item_id: String,
    pub(crate) name: Option<String>,
    pub(crate) cost: Option<f64>,
    pub(crate) acquisition_date: Option<String>,
    pub(crate) placed_in_service_date: Option<String>,
    pub(crate) reclass: bool,
    /// The other asset fields (name, cost and dates are filled in).
    pub(crate) rest: AssetInput,
}

/// `FromBillLineResult`.
pub(crate) struct FromBill {
    pub(crate) created: Created,
    pub(crate) source: Value,
}

fn is_fixed_asset_account(account: Option<&Value>) -> bool {
    account.is_some_and(|a| {
        text(a, "type") == "asset"
            && matches!(opt(a, "subtype"), Some("fixed_asset" | "fixed_assets"))
    })
}

/// `createFixedAssetFromBillLine(db, { entityId, userId, input })`.
#[allow(clippy::too_many_lines)] // the service's steps, in order
pub(crate) async fn create_from_bill_line(
    db: &PgPool,
    entity_id: &str,
    user_id: Option<&str>,
    input: &FromBillLine,
) -> Result<FromBill, Fail> {
    let orm = orm(db);
    let line = bill_items::Entity::find()
        .filter(bill_items::Column::Id.eq(&input.bill_item_id))
        .filter(bill_items::Column::EntityId.eq(entity_id))
        .filter(bill_items::Column::DeletedAt.is_null())
        .one(&orm)
        .await?;
    let Some(line) = line.map(|row| js!(row)).transpose()? else {
        return Err(not_found("Bill line not found"));
    };
    let bill = bills::Entity::find()
        .filter(bills::Column::Id.eq(text(&line, "billId")))
        .filter(bills::Column::EntityId.eq(entity_id))
        .filter(bills::Column::DeletedAt.is_null())
        .one(&orm)
        .await?;
    let Some(bill) = bill.map(|row| js!(row)).transpose()? else {
        return Err(not_found("Bill not found"));
    };
    if text(&bill, "type") == "credit_note" {
        return Err(bad("A credit note line cannot become an asset"));
    }
    let linked: Option<String> = fixed_assets::Entity::find()
        .select_only()
        .column(fixed_assets::Column::Id)
        .filter(fixed_assets::Column::BillItemId.eq(text(&line, "id")))
        .filter(fixed_assets::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm)
        .await?;
    if linked.is_some() {
        return Err(conflict(
            "This bill line is already linked to a fixed asset",
        ));
    }

    let entity = load_entity(db, entity_id).await?;
    let accounts = load_entity_accounts(db, entity_id).await?;
    let line_account = accounts
        .by_id(present(&line, "accountId").or_else(|| opt(&bill, "expenseAccountId")))
        .cloned();
    let capitalized = is_fixed_asset_account(line_account.as_ref());

    let amount = if let Some(cost) = input.cost {
        cost
    } else {
        let net = num(&line, "lineTotal");
        let gross = if line["lineTotalWithTax"].is_null() {
            net + num(&line, "taxAmount")
        } else {
            num(&line, "lineTotalWithTax")
        };
        let document = if text(&entity, "jurisdictionCode").to_uppercase() == "US" {
            gross
        } else {
            net
        };
        let rate = as_number(bill.get("exchangeRate"), 1.0);
        let rate = if rate == 0.0 || rate.is_nan() {
            1.0
        } else {
            rate
        };
        match present(&bill, "currency") {
            Some(currency) if Some(currency) != opt(&entity, "baseCurrency") => document / rate,
            _ => document,
        }
    };
    let amount = math_round(amount * 100.0) / 100.0;

    let acquisition_date = input
        .acquisition_date
        .clone()
        .unwrap_or_else(|| iso_day(text(&bill, "issueDate")));
    if input.reclass {
        if capitalized {
            return Err(bad(
                "The bill line is already on a fixed asset account; there is nothing to reclassify",
            ));
        }
        if line_account.is_none() {
            return Err(bad("The bill line has no account to reclassify from"));
        }
        if text(&bill, "status") == "draft" || present(&bill, "journalEntryId").is_none() {
            return Err(bad(
                "The bill has not been approved, so nothing is posted to reclassify. Set the line to a fixed asset account before approving it.",
            ));
        }
        assert_posting_allowed(
            db,
            PostingCheck {
                entity_id,
                date: &acquisition_date,
                kind: PostingLockKind::General,
                affects_tax: false,
                user_id,
            },
        )
        .await?;
    }

    let asset_id = generate_id("fa");
    let mut asset_input = input.rest.clone();
    asset_input.name = input.name.clone().unwrap_or_else(|| {
        weldsuite_books_domain::js::slice_utf16(text(&line, "description"), 255)
    });
    asset_input.cost = amount;
    asset_input.acquisition_date.clone_from(&acquisition_date);
    asset_input.placed_in_service_date = input
        .placed_in_service_date
        .clone()
        .unwrap_or_else(|| acquisition_date.clone());
    if asset_input.asset_account_id.is_none() && capitalized {
        asset_input.asset_account_id = line_account.as_ref().map(account_id);
    }
    if asset_input.class_id.is_none() {
        asset_input.class_id = opt(&line, "classId").map(str::to_owned);
    }
    if asset_input.location_id.is_none() {
        asset_input.location_id = opt(&line, "locationId").map(str::to_owned);
    }
    asset_input.bill_id = Some(text(&bill, "id").to_owned());
    asset_input.bill_item_id = Some(text(&line, "id").to_owned());
    let created = create_fixed_asset(db, entity_id, &asset_input, Some(asset_id.clone())).await?;

    let mut reclass_entry: Option<String> = None;
    if input.reclass
        && let Some(account) = &line_account
    {
        let asset_name = text(&created.asset, "name");
        let bill_label = present(&bill, "billNumber").unwrap_or_else(|| text(&bill, "id"));
        let posted = post_journal_entry(
            db,
            PostJournalEntryInput {
                entity_id: entity_id.to_owned(),
                date: acquisition_date.clone(),
                description: format!("Capitalize {asset_name} (bill {bill_label})"),
                reference: opt(&bill, "billNumber").map(str::to_owned),
                source_type: "fixed_asset".to_owned(),
                source_id: Some(asset_id.clone()),
                posting_key: Some(format!("fixed_asset:{asset_id}:reclass")),
                lock_kind: Some(PostingLockKind::General),
                lines: vec![
                    PostingLine {
                        account_id: text(&created.asset, "assetAccountId").to_owned(),
                        debit: amount,
                        description: Some(format!("Capitalize {asset_name}")),
                        ..PostingLine::default()
                    },
                    PostingLine {
                        account_id: account_id(account),
                        credit: amount,
                        description: Some(format!(
                            "Reclass from {} {}",
                            text(account, "code"),
                            text(account, "name")
                        )),
                        ..PostingLine::default()
                    },
                ],
                created_by: user_id.map(str::to_owned),
                is_automatic: Some(false),
                ..PostJournalEntryInput::default()
            },
        )
        .await?;
        reclass_entry = posted.journal_entry_id;
    }

    let source = json!({
        "billId": bill["id"],
        "billItemId": line["id"],
        "lineAccountId": line_account.as_ref().map(account_id),
        "lineAccountCode": line_account.as_ref().map(|a| a["code"].clone()),
        "capitalized": capitalized,
        "reclassNeeded": !capitalized && reclass_entry.is_none(),
        "reclassJournalEntryId": reclass_entry,
    });
    Ok(FromBill { created, source })
}

// ---------------------------------------------------------------------------
// Listing

/// `accumulatedPostedByAsset(db, assetIds)`: posted cents by asset.
pub(crate) async fn accumulated_posted_by_asset(
    db: &PgPool,
    asset_ids: &[String],
) -> Result<HashMap<String, i64>, DbErr> {
    if asset_ids.is_empty() {
        return Ok(HashMap::new());
    }
    posted_cents_by_asset(&orm(db), asset_ids, None).await
}

/// Posted depreciation in cents by asset (`coalesce(sum(amount), 0)` of the
/// posted rows, grouped by asset), through `through` when given.
pub(crate) async fn posted_cents_by_asset<C: ConnectionTrait>(
    db: &C,
    asset_ids: &[String],
    through: Option<time::Date>,
) -> Result<HashMap<String, i64>, DbErr> {
    let mut sums = fixed_asset_depreciation::Entity::find()
        .select_only()
        .column(fixed_asset_depreciation::Column::AssetId)
        .column_as(
            Expr::from(Func::coalesce([
                fixed_asset_depreciation::Column::Amount.sum(),
                Expr::val(0),
            ])),
            "total",
        )
        .filter(fixed_asset_depreciation::Column::AssetId.is_in(asset_ids.iter().cloned()))
        .filter(fixed_asset_depreciation::Column::JournalEntryId.is_not_null());
    if let Some(through) = through {
        sums = sums.filter(fixed_asset_depreciation::Column::PeriodEnd.lte(through));
    }
    let rows: Vec<(String, sea_orm::prelude::BigDecimal)> = sums
        .group_by(fixed_asset_depreciation::Column::AssetId)
        .into_tuple()
        .all(db)
        .await?;
    // The sum's text read as a number, then cents (`toCents(asNumber(…))`).
    Ok(rows
        .into_iter()
        .map(|(id, total)| {
            (
                id,
                to_cents(as_number(Some(&json!(total.to_plain_string())), 0.0)),
            )
        })
        .collect())
}

/// `booksByAsset(db, assetIds)`.
pub(crate) async fn books_by_asset(
    db: &PgPool,
    asset_ids: &[String],
) -> Result<HashMap<String, Vec<Value>>, DbErr> {
    let mut result: HashMap<String, Vec<Value>> = HashMap::new();
    if asset_ids.is_empty() {
        return Ok(result);
    }
    let rows = fixed_asset_books::Entity::find()
        .filter(fixed_asset_books::Column::AssetId.is_in(asset_ids.iter().cloned()))
        .all(&orm(db))
        .await?;
    let mut rows = js_rows!(rows)?;
    rows.sort_by_key(book_order);
    for row in rows {
        result
            .entry(text(&row, "assetId").to_owned())
            .or_default()
            .push(row);
    }
    Ok(result)
}
