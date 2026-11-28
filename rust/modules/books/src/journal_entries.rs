//! `/api/journal-entries` (`routes/journal-entries/index.ts`): manual journal
//! entries. Created as drafts; only drafts are edited or deleted; posting
//! (draft → posted) and reversing go through the posting engine
//! ([`weldsuite_books_domain::posting`]), which applies balances and the tax
//! ledger in one transaction. Closed periods and lock dates are refused.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::sea_query::extension::postgres as pg;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_books_domain::entity_context::{
    SequenceType, next_entity_number, resolve_entity_base_currency, resolve_entity_id,
};
use weldsuite_books_domain::guards::{
    AuditInput, GuardError, PostingCheck, PostingLockKind, assert_posting_allowed, change,
    write_accounting_audit,
};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, json_of, no_content, now, ok, paged, reply,
    validate,
};
use weldsuite_books_domain::js::{parse_float, parse_int, to_fixed};
use weldsuite_books_domain::posting::{
    PostError, ReverseArgs, assert_accounts_active, assert_dimensions_belong_to_entity,
    assert_projects_exist, post_draft_journal_entry, reverse_journal_entry,
};
use weldsuite_books_domain::tables::{JOURNAL_ENTRIES, JOURNAL_LINES};
use weldsuite_catalogs::entity_events::{
    JOURNAL_ENTRY_CREATED, JOURNAL_ENTRY_DELETED, JOURNAL_ENTRY_REVIEWED, JOURNAL_ENTRY_UNREVIEWED,
    JOURNAL_ENTRY_UPDATED,
};
use weldsuite_db::orm;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::journal_entries::{self, Column};
use weldsuite_schema::tenant::journal_lines;

use crate::orm_bridge::to_json;

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("journal:read")))
        .route("/", post(create).route_layer(need("journal:create")))
        .route("/{id}", get(detail).route_layer(need("journal:read")))
        .route(
            "/{id}",
            axum::routing::patch(update).route_layer(need("journal:update")),
        )
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("journal:delete")),
        )
        .route(
            "/{id}/post",
            post(post_entry).route_layer(need("journal:update")),
        )
        .route(
            "/{id}/reverse",
            post(reverse_entry).route_layer(need("journal:create")),
        )
        // Rust only (edition feature `books-questions`, M6): the accountant's
        // review mark.
        .route(
            "/{id}/review",
            post(review_entry)
                .delete(unreview_entry)
                .route_layer(need("journal:update")),
        )
        .route(
            "/review-bulk",
            post(review_bulk).route_layer(need("journal:update")),
        )
        .with_state(state)
}

/// A route's posting failure: `ClosedPeriodError | LockedPeriodError |
/// PostingError` are the user's (400 with the message), anything else the
/// route's 500.
fn posting_refusal(error: PostError) -> Refusal {
    match error.user_message() {
        Some(message) => Refusal::bad_request(message),
        None => match error {
            PostError::Database(error) => Refusal::Database(error),
            other => Refusal::Internal(other.to_string()),
        },
    }
}

fn guard_refusal(error: GuardError) -> Refusal {
    match error {
        GuardError::Database(error) => Refusal::Database(error),
        other => Refusal::bad_request(other.to_string()),
    }
}

/// One line of `createJournalEntrySchema`, as Zod outputs it.
struct LineInput {
    account_id: String,
    description: Option<String>,
    /// `.default('0')`.
    debit: String,
    credit: String,
    tax_rate_id: Option<String>,
    tax_amount: Option<String>,
    contact_id: Option<String>,
    sort_order: Option<f64>,
    class_id: Option<String>,
    location_id: Option<String>,
    /// The `WeldFlow` project the line's cost belongs to (FLOW-019).
    project_id: Option<String>,
}

struct CreateInput {
    date: String,
    description: Option<String>,
    reference: Option<String>,
    lines: Vec<LineInput>,
}

fn read_line(issues: &mut Issues, item: &Value) -> Option<LineInput> {
    let fields = issues.object(item)?;
    let account_id = issues.text(fields, "accountId", Presence::Required, Some(1), None);
    let description = issues.text(fields, "description", Presence::Optional, None, None);
    let debit = issues.text(fields, "debit", Presence::Optional, None, None);
    let credit = issues.text(fields, "credit", Presence::Optional, None, None);
    let tax_rate_id = issues.text(fields, "taxRateId", Presence::Optional, None, None);
    let tax_amount = issues.text(fields, "taxAmount", Presence::Optional, None, None);
    let contact_id = issues.text(fields, "contactId", Presence::Optional, None, None);
    let sort_order = issues.number(fields, "sortOrder", Presence::Optional, Number::default());
    let class_id = issues.text(fields, "classId", Presence::Nullish, None, Some(30));
    let location_id = issues.text(fields, "locationId", Presence::Nullish, None, Some(30));
    let project_id = issues.text(fields, "projectId", Presence::Nullish, None, Some(255));
    Some(LineInput {
        account_id: account_id.into_option()?,
        description: description.into_option(),
        debit: debit.into_option().unwrap_or_else(|| "0".to_owned()),
        credit: credit.into_option().unwrap_or_else(|| "0".to_owned()),
        tax_rate_id: tax_rate_id.into_option(),
        tax_amount: tax_amount.into_option(),
        contact_id: contact_id.into_option(),
        sort_order: sort_order.into_option(),
        class_id: class_id.into_option(),
        location_id: location_id.into_option(),
        project_id: project_id.into_option(),
    })
}

fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> Option<CreateInput> {
    let date = issues.text(body, "date", Presence::Required, None, None);
    let description = issues.text(body, "description", Presence::Optional, None, None);
    let reference = issues.text(body, "reference", Presence::Optional, None, Some(255));
    let lines = issues.list(body, "lines", Presence::Required, Some(2), None, read_line);
    Some(CreateInput {
        date: date.into_option()?,
        description: description.into_option(),
        reference: reference.into_option(),
        lines: lines.into_option()?,
    })
}

/// `x || null`: an empty string is null.
fn or_null(value: Option<&String>) -> Value {
    value
        .filter(|v| !v.is_empty())
        .map_or(Value::Null, |v| json!(v))
}

/// `x || fallback`.
fn or_text<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() { fallback } else { value }
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        list_entries(&caller, &q).await,
        "Failed to list journal entries",
    )
}

/// `new Date(text)` as its `toISOString()` was bound to a `$n::timestamp`:
/// UTC, to the millisecond. `None` for an invalid date (Drizzle's
/// `toISOString()` throws) and for a year Postgres refused to read back (0,
/// or past 9999), both the route's 500.
fn js_moment(text: &str) -> Option<PrimitiveDateTime> {
    weldsuite_books_domain::js::js_date(text)?;
    let millis = weldsuite_books_domain::js::js_date_millis(text)?;
    let at = OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()?;
    (at.year() >= 1).then(|| weldsuite_db::utc_timestamp(at))
}

/// `Number.parseInt(q[key] || fallback, 10)`.
fn int_or(q: &Query, key: &str, fallback: i64) -> Option<i64> {
    parse_int(q.present(key).unwrap_or(&fallback.to_string()))
}

/// `%text%` for an `ILIKE`, with the characters `LIKE` reads as wildcards taken literally.
fn like_pattern(text: &str) -> String {
    let mut pattern = String::with_capacity(text.len() + 2);
    pattern.push('%');
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    pattern
}

async fn list_entries(caller: &Caller, q: &Query) -> Reply {
    let page = int_or(q, "page", 1).map(|n| n.max(1));
    let page_size = int_or(q, "pageSize", 25).map(|n| n.clamp(1, 100));
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    // `new Date(q.from)`: an invalid date makes the statement throw.
    let from = match q.present("from") {
        Some(raw) => {
            Some(js_moment(raw).ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?)
        }
        None => None,
    };
    let to = match q.present("to") {
        Some(raw) => {
            Some(js_moment(raw).ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?)
        }
        None => None,
    };
    let (Some(page), Some(page_size)) = (page, page_size) else {
        return Err(Refusal::Internal("page is NaN".to_owned()));
    };
    // A negative `limit` or `offset` is Postgres's error: the route's 500.
    let (Ok(limit), Ok(offset)) = (
        u64::try_from(page_size),
        u64::try_from((page - 1) * page_size),
    ) else {
        return Err(Refusal::Internal("OFFSET must not be negative".to_owned()));
    };
    let mut filters = Condition::all()
        .add(Column::DeletedAt.is_null())
        .add(Column::EntityId.eq(entity_id.as_str()));
    if let Some(status) = q.present("status") {
        filters = filters.add(Column::Status.eq(status));
    }
    if let Some(source) = q.present("sourceType") {
        filters = filters.add(Column::SourceType.eq(source));
    }
    // `search`: part of the entry number, the reference or the description.
    if let Some(search) = q.present("search") {
        let pattern = like_pattern(search);
        filters = filters.add(
            Condition::any()
                .add(pg::PgExpr::ilike(
                    Expr::col((journal_entries::Entity, Column::EntryNumber)),
                    pattern.as_str(),
                ))
                .add(pg::PgExpr::ilike(
                    Expr::col((journal_entries::Entity, Column::Reference)),
                    pattern.as_str(),
                ))
                .add(pg::PgExpr::ilike(
                    Expr::col((journal_entries::Entity, Column::Description)),
                    pattern.as_str(),
                )),
        );
    }
    if let Some(from) = from {
        filters = filters.add(Column::Date.gte(from));
    }
    if let Some(to) = to {
        filters = filters.add(Column::Date.lte(to));
    }
    let db = orm(&caller.db);
    let rows = journal_entries::Entity::find()
        .filter(filters.clone())
        .order_by_desc(Column::Date)
        .order_by_desc(Column::Id)
        .limit(limit)
        .offset(offset)
        .all(&db)
        .await?;
    let total = journal_entries::Entity::find()
        .filter(filters)
        .count(&db)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let rows = rows
        .into_iter()
        .map(to_json)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(paged(rows, total, page * page_size < total, None))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn find_entry(caller: &Caller, id: &str) -> Result<Option<Value>, DbErr> {
    journal_entries::Entity::find()
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .one(&orm(&caller.db))
        .await?
        .map(to_json)
        .transpose()
}

/// The entry's live lines, by `sortOrder`.
async fn entry_lines(caller: &Caller, id: &str) -> Result<Vec<Value>, DbErr> {
    journal_lines::Entity::find()
        .filter(journal_lines::Column::JournalEntryId.eq(id))
        .filter(journal_lines::Column::DeletedAt.is_null())
        .order_by_asc(journal_lines::Column::SortOrder)
        .all(&orm(&caller.db))
        .await?
        .into_iter()
        .map(to_json)
        .collect()
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(mut entry) = find_entry(&caller, &id).await? else {
            return Err(Refusal::not_found("Journal entry", &id));
        };
        let lines = entry_lines(&caller, &id).await?;
        entry["lines"] = Value::Array(lines);
        Ok(ok(entry))
    }
    .await;
    reply(result, "Failed to fetch journal entry")
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_create) {
        Ok(Some(data)) => data,
        Ok(None) => {
            return Refusal::Internal("unreadable body".to_owned())
                .respond("Failed to create journal entry");
        }
        Err(refusal) => return refusal.respond("Failed to create journal entry"),
    };
    // `sumLines`: `Number.parseFloat(line.debit || '0')`.
    let (total_debit, total_credit) = data.lines.iter().fold((0.0, 0.0), |(d, c), line| {
        (
            d + parse_float(or_text(&line.debit, "0")),
            c + parse_float(or_text(&line.credit, "0")),
        )
    });
    if (total_debit - total_credit).abs() > 0.01 {
        return Refusal::bad_request(format!(
            "Journal entry is not balanced. Total debit: {}, total credit: {}",
            to_fixed(total_debit, 2),
            to_fixed(total_credit, 2)
        ))
        .respond("Failed to create journal entry");
    }
    reply(
        create_entry(&caller, &state, data, total_debit, total_credit).await,
        "Failed to create journal entry",
    )
}

#[allow(clippy::too_many_lines)] // the worker's steps, in its order
async fn create_entry(
    caller: &Caller,
    state: &BooksState,
    data: CreateInput,
    total_debit: f64,
    total_credit: f64,
) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    assert_posting_allowed(
        db,
        PostingCheck {
            entity_id: &entity_id,
            date: &data.date,
            kind: PostingLockKind::General,
            affects_tax: data
                .lines
                .iter()
                .any(|l| l.tax_rate_id.as_deref().is_some_and(|id| !id.is_empty())),
            user_id: Some(&caller.user_id),
        },
    )
    .await
    .map_err(guard_refusal)?;
    let dims: Vec<(Option<String>, Option<String>)> = data
        .lines
        .iter()
        .map(|l| (l.class_id.clone(), l.location_id.clone()))
        .collect();
    assert_dimensions_belong_to_entity(db, &entity_id, &dims)
        .await
        .map_err(posting_refusal)?;
    assert_projects_exist(db, data.lines.iter().map(|l| l.project_id.clone()))
        .await
        .map_err(posting_refusal)?;
    assert_accounts_active(
        db,
        &entity_id,
        data.lines.iter().map(|l| l.account_id.clone()),
    )
    .await
    .map_err(posting_refusal)?;

    let entry_number = next_entity_number(db, &entity_id, SequenceType::Journal)
        .await?
        .formatted;
    let entry_id = generate_id("je");
    let at = now();
    let currency = resolve_entity_base_currency(db, &entity_id).await?;
    // `new Date(data.date)`: Drizzle's `toISOString()` throws on an invalid date.
    let entry_date = weldsuite_books_domain::js::js_date(&data.date)
        .ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?;

    let mut entry = Map::new();
    for (key, value) in [
        ("id", json!(entry_id)),
        ("entityId", json!(entity_id)),
        ("entryNumber", json!(entry_number)),
        ("date", json!(entry_date)),
        ("status", json!("draft")),
        ("description", or_null(data.description.as_ref())),
        ("reference", or_null(data.reference.as_ref())),
        ("totalDebit", json!(to_fixed(total_debit, 2))),
        ("totalCredit", json!(to_fixed(total_credit, 2))),
        ("sourceType", json!("manual")),
        ("isAutomatic", json!(false)),
        ("createdBy", json!(caller.user_id)),
        ("createdAt", json!(at)),
        ("updatedAt", json!(at)),
    ] {
        entry.insert(key.to_owned(), value);
    }
    let records: Vec<Map<String, Value>> = data
        .lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            let mut record = Map::new();
            for (key, value) in [
                ("id", json!(generate_id("jl"))),
                ("entityId", json!(entity_id)),
                ("journalEntryId", json!(entry_id)),
                ("accountId", json!(line.account_id)),
                ("description", or_null(line.description.as_ref())),
                ("debit", json!(or_text(&line.debit, "0"))),
                ("credit", json!(or_text(&line.credit, "0"))),
                ("taxRateId", or_null(line.tax_rate_id.as_ref())),
                ("taxAmount", or_null(line.tax_amount.as_ref())),
                ("contactId", or_null(line.contact_id.as_ref())),
                ("currency", json!(currency)),
                ("classId", or_null(line.class_id.as_ref())),
                ("locationId", or_null(line.location_id.as_ref())),
                ("projectId", or_null(line.project_id.as_ref())),
                (
                    "sortOrder",
                    line.sort_order
                        .map_or_else(|| json!(index), weldsuite_books_domain::js::number_value),
                ),
                ("createdAt", json!(at)),
                ("updatedAt", json!(at)),
            ] {
                record.insert(key.to_owned(), value);
            }
            record
        })
        .collect();

    // Header and lines land together or not at all.
    let entry_values = JOURNAL_ENTRIES.values(&entry);
    let line_values: Vec<Map<String, Value>> =
        records.iter().map(|r| JOURNAL_LINES.values(r)).collect();
    weldsuite_db::atomically_with(db, move |conn| {
        Box::pin(async move {
            JOURNAL_ENTRIES.insert_raw(&mut *conn, entry_values).await?;
            for values in line_values {
                JOURNAL_LINES.insert_raw(&mut *conn, values).await?;
            }
            Ok::<_, Refusal>(())
        })
    })
    .await?;

    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "journal_entry",
            entity_id: &entry_id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(
        state,
        JOURNAL_ENTRY_CREATED,
        &entry_id,
        json!({ "id": entry_id, "entityId": entity_id, "entryNumber": entry_number, "status": "draft", "currency": currency }),
    );
    Ok(created(json!({
        "id": entry_id,
        "entryNumber": entry_number,
        "lines": records,
    })))
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

fn read_update(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    if let Field::Set(date) = issues.text(body, "date", Presence::Optional, None, None) {
        out.insert("date".to_owned(), json!(date));
    }
    if let Field::Set(description) =
        issues.text(body, "description", Presence::Optional, None, None)
    {
        out.insert("description".to_owned(), json!(description));
    }
    if let Field::Set(reference) =
        issues.text(body, "reference", Presence::Optional, None, Some(255))
    {
        out.insert("reference".to_owned(), json!(reference));
    }
    out
}

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_update) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update journal entry"),
    };
    reply(
        update_entry(&caller, &state, &id, data).await,
        "Failed to update journal entry",
    )
}

async fn update_entry(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    data: Map<String, Value>,
) -> Reply {
    let db = &caller.db;
    let Some(existing) = find_entry(caller, id).await? else {
        return Err(Refusal::not_found("Journal entry", id));
    };
    if existing["status"].as_str() != Some("draft") {
        return Err(Refusal::bad_request(
            "Posted journal entries are immutable — create a reversal via POST /:id/reverse instead",
        ));
    }
    let entity_id = existing["entityId"].as_str().unwrap_or_default().to_owned();
    if let Some(date) = data
        .get("date")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
    {
        assert_posting_allowed(
            db,
            PostingCheck {
                entity_id: &entity_id,
                date,
                kind: PostingLockKind::General,
                affects_tax: false,
                user_id: Some(&caller.user_id),
            },
        )
        .await
        .map_err(guard_refusal)?;
    }
    let mut values = Map::new();
    JOURNAL_ENTRIES.set(&mut values, "updatedAt", json!(now()));
    if let Some(given) = data.get("date").and_then(Value::as_str) {
        let entry_date = weldsuite_books_domain::js::js_date(given)
            .ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?;
        JOURNAL_ENTRIES.set(&mut values, "date", json!(entry_date));
    }
    for key in ["description", "reference"] {
        if let Some(value) = data.get(key) {
            JOURNAL_ENTRIES.set(&mut values, key, value.clone());
        }
    }
    JOURNAL_ENTRIES.patch_raw(db, id, values, true).await?;

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
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "journal_entry",
            entity_id: id,
            action: "updated",
            changes: Some(changes),
        },
    )
    .await;
    let currency = resolve_entity_base_currency(db, &entity_id).await?;
    caller.publish(
        state,
        JOURNAL_ENTRY_UPDATED,
        id,
        json!({
            "id": id,
            "entityId": entity_id,
            "entryNumber": existing["entryNumber"],
            "status": existing["status"],
            "currency": currency,
        }),
    );
    Ok(ok(json!({ "id": id })))
}

// ── POST /:id/post ──────────────────────────────────────────────────────────

async fn post_entry(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let db = &caller.db;
        let exists: Option<String> = journal_entries::Entity::find()
            .select_only()
            .column(Column::Id)
            .filter(Column::Id.eq(id.as_str()))
            .filter(Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(db))
            .await?;
        if exists.is_none() {
            return Err(Refusal::not_found("Journal entry", &id));
        }
        let entry = post_draft_journal_entry(db, &id, Some(&caller.user_id))
            .await
            .map_err(posting_refusal)?;
        let mut changes = Map::new();
        changes.insert("status".to_owned(), change(json!("draft"), json!("posted")));
        write_accounting_audit(
            &caller,
            db,
            AuditInput {
                accounting_entity_id: entry["entityId"].as_str(),
                entity_type: "journal_entry",
                entity_id: &id,
                action: "posted",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(&state, JOURNAL_ENTRY_UPDATED, &id, entry.clone());
        Ok(ok(entry))
    }
    .await;
    reply(result, "Failed to post journal entry")
}

// ── Review marks (Rust only, edition feature `books-questions`, M6) ─────────
//
// The accountant marks a booking as reviewed (`reviewed_at`, `reviewed_by`).
// The mark is an annotation, not a ledger change: a posted entry stays
// immutable, `updated_at` is not touched, and a closed period or a lock date
// does not stop it. Marking an entry that is marked, or unmarking one that is
// not, changes nothing and publishes nothing.

/// The live entries of the request's entity among `ids`.
async fn entries_of_entity(
    caller: &Caller,
    entity_id: &str,
    ids: &[String],
) -> Result<Vec<journal_entries::Model>, DbErr> {
    journal_entries::Entity::find()
        .filter(Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::DeletedAt.is_null())
        .all(&orm(&caller.db))
        .await
}

/// Mark (`reviewed`) or unmark `entry` as `caller`, with the audit row and
/// the event. `false` when it was already so.
async fn set_review(
    caller: &Caller,
    state: &BooksState,
    entry: &journal_entries::Model,
    reviewed: bool,
) -> Result<bool, DbErr> {
    if entry.reviewed_at.is_some() == reviewed {
        return Ok(false);
    }
    let (at, by) = if reviewed {
        (Some(weldsuite_db::utc_now()), Some(caller.user_id.clone()))
    } else {
        (None, None)
    };
    // Guarded on the old state, so two marks at once publish once.
    let updated = journal_entries::Entity::update_many()
        .col_expr(Column::ReviewedAt, Expr::value(at))
        .col_expr(Column::ReviewedBy, Expr::value(by))
        .filter(Column::Id.eq(entry.id.as_str()))
        .filter(if reviewed {
            Column::ReviewedAt.is_null()
        } else {
            Column::ReviewedAt.is_not_null()
        })
        .exec(&orm(&caller.db))
        .await?
        .rows_affected;
    if updated == 0 {
        return Ok(false);
    }
    let mut changes = Map::new();
    changes.insert(
        "reviewed".to_owned(),
        change(json!(!reviewed), json!(reviewed)),
    );
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(entry.entity_id.as_str()),
            entity_type: "journal_entry",
            entity_id: &entry.id,
            action: if reviewed { "reviewed" } else { "unreviewed" },
            changes: Some(changes),
        },
    )
    .await;
    caller.publish(
        state,
        if reviewed {
            JOURNAL_ENTRY_REVIEWED
        } else {
            JOURNAL_ENTRY_UNREVIEWED
        },
        &entry.id,
        json!({
            "id": entry.id,
            "entityId": entry.entity_id,
            "entryNumber": entry.entry_number,
            "reviewedBy": caller.user_id,
        }),
    );
    Ok(true)
}

async fn review_entry(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        review_one(&caller, &state, &id, true).await,
        "Failed to mark the journal entry as reviewed",
    )
}

async fn unreview_entry(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        review_one(&caller, &state, &id, false).await,
        "Failed to remove the review mark",
    )
}

async fn review_one(caller: &Caller, state: &BooksState, id: &str, reviewed: bool) -> Reply {
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let ids = [id.to_owned()];
    let Some(entry) = entries_of_entity(caller, &entity_id, &ids)
        .await?
        .into_iter()
        .next()
    else {
        return Err(Refusal::not_found("Journal entry", id));
    };
    set_review(caller, state, &entry, reviewed).await?;
    let Some(entry) = find_entry(caller, id).await? else {
        return Err(Refusal::not_found("Journal entry", id));
    };
    Ok(ok(entry))
}

/// `POST /review-bulk` `{ ids }`: `{ reviewed: [ids marked now], skipped:
/// [ids that were marked already, are unknown or belong to another entity] }`.
async fn review_bulk(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let body = json_of(&headers, &body)?;
        let list = body
            .get("ids")
            .and_then(Value::as_array)
            .ok_or_else(|| Refusal::bad_request("ids is required"))?;
        if list.is_empty() || list.len() > 200 {
            return Err(Refusal::bad_request("ids must hold 1 to 200 ids"));
        }
        let mut ids: Vec<String> = Vec::new();
        for id in list {
            let id = id
                .as_str()
                .filter(|i| !i.is_empty() && i.len() <= 30)
                .ok_or_else(|| Refusal::bad_request("ids must hold journal entry ids"))?;
            if !ids.iter().any(|i| i == id) {
                ids.push(id.to_owned());
            }
        }
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let entries = entries_of_entity(&caller, &entity_id, &ids).await?;
        let mut reviewed: Vec<String> = Vec::new();
        for entry in &entries {
            if set_review(&caller, &state, entry, true).await? {
                reviewed.push(entry.id.clone());
            }
        }
        let skipped: Vec<String> = ids
            .into_iter()
            .filter(|id| !reviewed.contains(id))
            .collect();
        Ok(ok(json!({ "reviewed": reviewed, "skipped": skipped })))
    }
    .await;
    reply(result, "Failed to mark the journal entries as reviewed")
}

// ── POST /:id/reverse ───────────────────────────────────────────────────────

async fn reverse_entry(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let db = &caller.db;
        let Some(entry) = find_entry(&caller, &id).await? else {
            return Err(Refusal::not_found("Journal entry", &id));
        };
        let source_type = entry["sourceType"].as_str().filter(|s| !s.is_empty());
        let automatic = entry["isAutomatic"].as_bool().unwrap_or(false);
        let source_id = entry["sourceId"].as_str().filter(|s| !s.is_empty());
        if automatic
            && let Some(source_type) = source_type
            && source_type != "manual"
            && source_id.is_some()
        {
            // A document's entry is reversed through its document.
            return Err(Refusal::bad_request(format!(
                "This entry was posted by a {}. Correct it through that document instead.",
                source_type.replacen('_', " ", 1)
            )));
        }
        let reversal = reverse_journal_entry(
            db,
            ReverseArgs {
                entry_id: id.clone(),
                date: now(),
                created_by: Some(caller.user_id.clone()),
                ..ReverseArgs::default()
            },
        )
        .await
        .map_err(posting_refusal)?;
        let mut changes = Map::new();
        changes.insert(
            "status".to_owned(),
            change(json!("posted"), json!("reversed")),
        );
        changes.insert(
            "reversedById".to_owned(),
            change(Value::Null, json!(reversal.journal_entry_id)),
        );
        write_accounting_audit(
            &caller,
            db,
            AuditInput {
                accounting_entity_id: entry["entityId"].as_str(),
                entity_type: "journal_entry",
                entity_id: &id,
                action: "reversed",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(
            &state,
            JOURNAL_ENTRY_UPDATED,
            &id,
            json!({ "id": id, "status": "reversed", "reversedById": reversal.journal_entry_id }),
        );
        Ok(created(json!({
            "id": reversal.journal_entry_id,
            "entryNumber": reversal.entry_number,
        })))
    }
    .await;
    reply(result, "Failed to reverse journal entry")
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let db = &caller.db;
        let Some(existing) = find_entry(&caller, &id).await? else {
            return Err(Refusal::not_found("Journal entry", &id));
        };
        if existing["status"].as_str() != Some("draft") {
            return Err(Refusal::bad_request(
                "Posted journal entries cannot be deleted — create a reversal via POST /:id/reverse instead",
            ));
        }
        let at = weldsuite_db::utc_now();
        journal_entries::Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(at))
            .col_expr(Column::UpdatedAt, Expr::value(at))
            .filter(Column::Id.eq(id.as_str()))
            .exec(&orm(db))
            .await?;
        write_accounting_audit(
            &caller,
            db,
            AuditInput {
                accounting_entity_id: existing["entityId"].as_str(),
                entity_type: "journal_entry",
                entity_id: &id,
                action: "deleted",
                changes: None,
            },
        )
        .await;
        caller.publish(&state, JOURNAL_ENTRY_DELETED, &id, json!({ "id": id }));
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to delete journal entry")
}

#[cfg(test)]
mod tests {
    use super::like_pattern;

    #[test]
    fn a_search_is_the_text_between_two_wildcards() {
        assert_eq!(like_pattern("rent"), "%rent%");
    }

    #[test]
    fn like_wildcards_in_the_text_are_taken_literally() {
        assert_eq!(like_pattern("100%"), "%100\\%%");
        assert_eq!(like_pattern("R_1"), "%R\\_1%");
        assert_eq!(like_pattern("a\\b"), "%a\\\\b%");
    }
}

/// The review marks (M6) against the real tenant schema
/// (`WELDSUITE_TEST_TENANT_URL`, built by `scripts/rust-test-db.ts`; each test
/// returns early without it).
#[cfg(test)]
#[allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::assert_is_empty,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]
mod review_tests {
    use std::sync::Arc;

    use sqlx::PgPool;
    use weldsuite_events::{EntityEventPublisher, TaskTracker};
    use weldsuite_ports::{DynEventBus, RecordingEventBus};

    use super::*;

    struct World {
        db: PgPool,
        state: BooksState,
        bus: Arc<RecordingEventBus>,
    }

    impl World {
        fn new() -> Option<Self> {
            let Ok(url) = std::env::var("WELDSUITE_TEST_TENANT_URL") else {
                eprintln!("WELDSUITE_TEST_TENANT_URL is not set; skipping");
                return None;
            };
            let db = weldsuite_db::master_pool(&url, 2).unwrap();
            let bus = Arc::new(RecordingEventBus::new());
            let state = BooksState::new(EntityEventPublisher::new(
                Some(Arc::clone(&bus) as Arc<dyn DynEventBus>),
                TaskTracker::new(),
            ));
            Some(Self { db, state, bus })
        }

        fn caller(&self, entity: &str) -> Caller {
            Caller::in_process(
                self.db.clone(),
                "ws_review_test",
                "ws_review_test",
                "user_reviewer",
                entity,
                None,
            )
        }

        async fn actions(&self) -> Vec<String> {
            for _ in 0..200 {
                tokio::task::yield_now().await;
            }
            let actions = self
                .bus
                .payloads()
                .into_iter()
                .map(|payload| {
                    format!(
                        "{}.{}",
                        payload["entityType"].as_str().unwrap_or_default(),
                        payload["action"].as_str().unwrap_or_default()
                    )
                })
                .collect();
            self.bus.clear();
            actions
        }
    }

    async fn entity(db: &PgPool) -> String {
        let id = weldsuite_kit::generate_id("ent");
        sqlx::query(
            "insert into entities (id, name, jurisdiction_code, base_currency, is_active) \
             values ($1, 'Review marks', 'NL', 'EUR', true)",
        )
        .bind(&id)
        .execute(db)
        .await
        .unwrap();
        id
    }

    async fn entry(db: &PgPool, entity: &str, status: &str) -> String {
        let id = weldsuite_kit::generate_id("je");
        sqlx::query(
            "insert into journal_entries (id, entity_id, entry_number, date, status, is_automatic) \
             values ($1, $2, $1, now(), $3, true)",
        )
        .bind(&id)
        .bind(entity)
        .bind(status)
        .execute(db)
        .await
        .unwrap();
        id
    }

    async fn answer(reply: Reply) -> (u16, Value) {
        let response = reply.unwrap_or_else(|refusal| refusal.respond("Failed"));
        let status = response.status().as_u16();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    #[tokio::test]
    async fn a_mark_names_who_and_when_and_leaves_the_entry_alone() {
        let Some(world) = World::new() else { return };
        let entity = entity(&world.db).await;
        let id = entry(&world.db, &entity, "posted").await;
        let caller = world.caller(&entity);

        let (status, body) = answer(review_one(&caller, &world.state, &id, true).await).await;
        assert_eq!(status, 200);
        assert_eq!(body["data"]["reviewedBy"], "user_reviewer");
        assert!(body["data"]["reviewedAt"].is_string());
        // A review is not a change of the entry.
        let unchanged: (bool,) =
            sqlx::query_as("select updated_at = created_at from journal_entries where id = $1")
                .bind(&id)
                .fetch_one(&world.db)
                .await
                .unwrap();
        assert!(unchanged.0);
        assert_eq!(world.actions().await, ["journal_entry.reviewed"]);

        // Again: nothing changes and nothing is published.
        let (status, again) = answer(review_one(&caller, &world.state, &id, true).await).await;
        assert_eq!(status, 200);
        assert_eq!(again["data"]["reviewedAt"], body["data"]["reviewedAt"]);
        assert!(world.actions().await.is_empty());

        // Removing the mark takes both columns out of the JSON again.
        let (_, cleared) = answer(review_one(&caller, &world.state, &id, false).await).await;
        assert!(cleared["data"].get("reviewedAt").is_none());
        assert!(cleared["data"].get("reviewedBy").is_none());
        assert_eq!(world.actions().await, ["journal_entry.unreviewed"]);
        let (_, nothing) = answer(review_one(&caller, &world.state, &id, false).await).await;
        assert!(nothing["data"].get("reviewedAt").is_none());
        assert!(world.actions().await.is_empty());

        let audit: (i64,) = sqlx::query_as(
            "select count(*) from audit_log where entity_id = $1 \
             and action in ('reviewed', 'unreviewed')",
        )
        .bind(&id)
        .fetch_one(&world.db)
        .await
        .unwrap();
        assert_eq!(audit.0, 2);
    }

    #[tokio::test]
    async fn an_entry_of_another_entity_is_not_found() {
        let Some(world) = World::new() else { return };
        let mine = entity(&world.db).await;
        let other = entity(&world.db).await;
        let theirs = entry(&world.db, &other, "posted").await;
        let caller = world.caller(&mine);
        let (status, _) = answer(review_one(&caller, &world.state, &theirs, true).await).await;
        assert_eq!(status, 404);
        let (status, _) = answer(review_one(&caller, &world.state, "je_missing", true).await).await;
        assert_eq!(status, 404);
        let marked: (bool,) =
            sqlx::query_as("select reviewed_at is not null from journal_entries where id = $1")
                .bind(&theirs)
                .fetch_one(&world.db)
                .await
                .unwrap();
        assert!(!marked.0);
    }

    #[tokio::test]
    async fn the_bulk_mark_marks_only_what_is_unmarked_in_the_entity() {
        let Some(world) = World::new() else { return };
        let mine = entity(&world.db).await;
        let other = entity(&world.db).await;
        let a = entry(&world.db, &mine, "posted").await;
        let b = entry(&world.db, &mine, "posted").await;
        let foreign = entry(&world.db, &other, "posted").await;
        let caller = world.caller(&mine);
        // `b` is marked already.
        answer(review_one(&caller, &world.state, &b, true).await).await;
        world.actions().await;

        let ids = vec![
            a.clone(),
            b,
            foreign.clone(),
            "je_missing".to_owned(),
            a.clone(),
        ];
        let entries = entries_of_entity(&caller, &mine, &ids).await.unwrap();
        let mut reviewed = Vec::new();
        for entry in &entries {
            if set_review(&caller, &world.state, entry, true)
                .await
                .unwrap()
            {
                reviewed.push(entry.id.clone());
            }
        }
        assert_eq!(reviewed, [a]);
        assert_eq!(world.actions().await, ["journal_entry.reviewed"]);
        let untouched: (bool,) =
            sqlx::query_as("select reviewed_at is not null from journal_entries where id = $1")
                .bind(&foreign)
                .fetch_one(&world.db)
                .await
                .unwrap();
        assert!(!untouched.0);
    }
}
