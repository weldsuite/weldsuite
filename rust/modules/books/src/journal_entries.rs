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
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::{
    SequenceType, next_entity_number, resolve_entity_base_currency, resolve_entity_id,
};
use weldsuite_books_domain::guards::{
    AuditInput, GuardError, PostingCheck, PostingLockKind, assert_posting_allowed, change,
    write_accounting_audit,
};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, no_content, now, ok, paged, reply, validate,
};
use weldsuite_books_domain::js::{parse_float, parse_int, to_fixed};
use weldsuite_books_domain::posting::{
    PostError, ReverseArgs, assert_dimensions_belong_to_entity, post_draft_journal_entry,
    reverse_journal_entry,
};
use weldsuite_books_domain::tables::{JOURNAL_ENTRIES, JOURNAL_LINES};
use weldsuite_catalogs::entity_events::{
    JOURNAL_ENTRY_CREATED, JOURNAL_ENTRY_DELETED, JOURNAL_ENTRY_UPDATED,
};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Number, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

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

/// `Number.parseInt(q[key] || fallback, 10)`.
fn int_or(q: &Query, key: &str, fallback: i64) -> Option<i64> {
    parse_int(q.present(key).unwrap_or(&fallback.to_string()))
}

async fn list_entries(caller: &Caller, q: &Query) -> Reply {
    let page = int_or(q, "page", 1).map(|n| n.max(1));
    let page_size = int_or(q, "pageSize", 25).map(|n| n.clamp(1, 100));
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    // `new Date(q.from)`: an invalid date makes the statement throw.
    let from = match q.present("from") {
        Some(raw) => Some(
            weldsuite_books_domain::js::js_date(raw)
                .ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?,
        ),
        None => None,
    };
    let to = match q.present("to") {
        Some(raw) => Some(
            weldsuite_books_domain::js::js_date(raw)
                .ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?,
        ),
        None => None,
    };
    let (Some(page), Some(page_size)) = (page, page_size) else {
        return Err(Refusal::Internal("page is NaN".to_owned()));
    };
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(journal_entries),
        " from journal_entries t where t.deleted_at is null and t.entity_id = $1 \
         and ($2::text is null or t.status = $2) and ($3::text is null or t.source_type = $3) \
         and ($4::timestamp is null or t.date >= $4::timestamp) \
         and ($5::timestamp is null or t.date <= $5::timestamp) \
         order by t.date desc, t.id desc limit $6 offset $7"
    ))
    .bind(&entity_id)
    .bind(q.present("status"))
    .bind(q.present("sourceType"))
    .bind(&from)
    .bind(&to)
    .bind(page_size)
    .bind((page - 1) * page_size)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*)::int8 from journal_entries t where t.deleted_at is null and t.entity_id = $1 \
         and ($2::text is null or t.status = $2) and ($3::text is null or t.source_type = $3) \
         and ($4::timestamp is null or t.date >= $4::timestamp) \
         and ($5::timestamp is null or t.date <= $5::timestamp)",
    )
    .bind(&entity_id)
    .bind(q.present("status"))
    .bind(q.present("sourceType"))
    .bind(&from)
    .bind(&to)
    .fetch_one(&caller.db)
    .await?;
    Ok(paged(
        JOURNAL_ENTRIES.js_rows(rows),
        total,
        page * page_size < total,
        None,
    ))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn find_entry(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(journal_entries),
        " from journal_entries t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|row| JOURNAL_ENTRIES.js(row)))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(mut entry) = find_entry(&caller, &id).await? else {
            return Err(Refusal::not_found("Journal entry", &id));
        };
        let lines: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(journal_lines),
            " from journal_lines t where t.journal_entry_id = $1 and t.deleted_at is null \
             order by t.sort_order"
        ))
        .bind(&id)
        .fetch_all(&caller.db)
        .await?;
        entry["lines"] = Value::Array(JOURNAL_LINES.js_rows(lines));
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

    let entry_number = next_entity_number(db, &entity_id, SequenceType::Journal)
        .await?
        .formatted;
    let entry_id = generate_id("je");
    let at = now();
    let currency = resolve_entity_base_currency(db, &entity_id).await?;
    // `new Date(data.date)`: Drizzle's `toISOString()` throws on an invalid date.
    let date = weldsuite_books_domain::js::js_date(&data.date)
        .ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?;

    let mut entry = Map::new();
    for (key, value) in [
        ("id", json!(entry_id)),
        ("entityId", json!(entity_id)),
        ("entryNumber", json!(entry_number)),
        ("date", json!(date)),
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
            Ok::<_, sqlx::Error>(())
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
    if let Some(date) = data.get("date").and_then(Value::as_str) {
        let date = weldsuite_books_domain::js::js_date(date)
            .ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))?;
        JOURNAL_ENTRIES.set(&mut values, "date", json!(date));
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
        let exists: Option<String> = sqlx::query_scalar(
            "select id from journal_entries where id = $1 and deleted_at is null limit 1",
        )
        .bind(&id)
        .fetch_optional(db)
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
        let at = now();
        sqlx::query(
            "update journal_entries set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2",
        )
        .bind(&at)
        .bind(&id)
        .execute(db)
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
