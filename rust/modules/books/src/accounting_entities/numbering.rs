//! Document numbering (`GET|PATCH /:id/number-sequences`,
//! `services/accounting-number-sequences.ts`): prefix, next number and
//! padding of the entity's invoice, credit note, bill and journal sequences
//! (`entity_number_sequences`; `next_entity_number` hands the numbers out).
//!
//! The next number only moves forward. Lowering it would hand out a number
//! that is already on a document, and Dutch invoices need a unique,
//! sequential series. Raising it is how a business continues the numbering
//! of the software it came from.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::entity_context::SequenceType;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, now, ok, reply, validate};
use weldsuite_catalogs::entity_events::ACCOUNTING_ENTITY_UPDATED;
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Number, Presence};

use super::find_active;

/// `SEQUENCE_TYPES`, in the order they are listed.
const SEQUENCE_TYPES: [SequenceType; 4] = [
    SequenceType::Invoice,
    SequenceType::CreditNote,
    SequenceType::Bill,
    SequenceType::Journal,
];

/// Padding of a sequence that `next_entity_number` creates on first use.
const DEFAULT_PADDING: i64 = 4;

const NEXT_VALUE_FORWARD_ONLY: &str =
    "The next number can only move forward: lower numbers may already be in use";

/// One sequence (`NumberSequence`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Sequence {
    kind: SequenceType,
    prefix: String,
    next_value: i64,
    padding: i64,
}

impl Sequence {
    /// The field `field` (`prefix`, `nextValue` or `padding`) as JSON.
    fn get(&self, field: &str) -> Value {
        match field {
            "prefix" => json!(self.prefix),
            "nextValue" => json!(self.next_value),
            _ => json!(self.padding),
        }
    }

    /// `{ sequenceType, prefix, nextValue, padding, nextNumber }`; the
    /// number the next document gets, e.g. `INV-0042`.
    fn to_json(&self) -> Value {
        let width = usize::try_from(self.padding).unwrap_or(0);
        let digits = self.next_value.to_string();
        json!({
            "sequenceType": self.kind.as_str(),
            "prefix": self.prefix,
            "nextValue": self.next_value,
            "padding": self.padding,
            "nextNumber": format!("{}{digits:0>width$}", self.prefix),
        })
    }
}

/// `listNumberSequences(db, entityId)`: every sequence of the entity; one
/// that was never used shows the values it will start with.
async fn list_sequences(db: &PgPool, entity_id: &str) -> Result<Vec<Sequence>, sqlx::Error> {
    let rows: Vec<(String, String, i32, Option<i32>)> = sqlx::query_as(
        "select sequence_type, prefix, next_value, padding from entity_number_sequences \
         where entity_id = $1",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    Ok(SEQUENCE_TYPES
        .into_iter()
        .map(
            |kind| match rows.iter().find(|row| row.0 == kind.as_str()) {
                Some((_, prefix, next_value, padding)) => Sequence {
                    kind,
                    prefix: prefix.clone(),
                    next_value: i64::from(*next_value),
                    padding: i64::from(padding.unwrap_or(0)),
                },
                None => Sequence {
                    kind,
                    prefix: kind.default_prefix().to_owned(),
                    next_value: 1,
                    padding: DEFAULT_PADDING,
                },
            },
        )
        .collect())
}

fn sequences_json(sequences: &[Sequence]) -> Value {
    Value::Array(sequences.iter().map(Sequence::to_json).collect())
}

pub(crate) async fn list(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        if find_active(&caller, &id).await?.is_none() {
            return Err(Refusal::not_found("Entity", &id));
        }
        Ok(ok(sequences_json(&list_sequences(&caller.db, &id).await?)))
    }
    .await;
    reply(result, "Failed to load the numbering")
}

/// One update of the request (`NumberSequenceUpdate`).
struct Update {
    kind: SequenceType,
    prefix: Option<String>,
    next_value: Option<i64>,
    padding: Option<i64>,
}

fn sequence_type(name: &str) -> Option<SequenceType> {
    SEQUENCE_TYPES
        .into_iter()
        .find(|kind| kind.as_str() == name)
}

/// `/^[A-Za-z0-9 ._/-]*$/`.
fn prefix_shaped(value: &str) -> bool {
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '/' | '-'))
}

/// `numberSequencesSchema`: `{ sequences: [{ sequenceType, prefix?,
/// nextValue?, padding? }] }`, one to four, each sequence at most once.
fn read_sequences(issues: &mut Issues, body: &Map<String, Value>) -> Vec<Update> {
    // Zod runs the array's refinement unless an item failed a type check.
    let mut aborted = !matches!(body.get("sequences"), Some(Value::Array(_)));
    let mut kinds: Vec<&'static str> = Vec::new();
    let names: Vec<&str> = SEQUENCE_TYPES.iter().map(|kind| kind.as_str()).collect();
    let sequences = issues.list(
        body,
        "sequences",
        Presence::Required,
        Some(1),
        Some(SEQUENCE_TYPES.len()),
        |issues, item| {
            let Some(fields) = issues.object(item) else {
                aborted = true;
                return None;
            };
            let typed = |key: &str, ok: fn(&Value) -> bool| fields.get(key).is_none_or(ok);
            if !typed("prefix", Value::is_string)
                || !typed("nextValue", Value::is_number)
                || !typed("padding", Value::is_number)
            {
                aborted = true;
            }
            let kind = issues
                .choice(fields, "sequenceType", Presence::Required, &names)
                .into_option()
                .and_then(|name| sequence_type(&name));
            match kind {
                Some(kind) => kinds.push(kind.as_str()),
                None => aborted = true,
            }
            let prefix = issues.pattern(
                fields,
                "prefix",
                Presence::Optional,
                None,
                Some(20),
                prefix_shaped,
                "Use letters, digits, spaces and . _ / -",
            );
            let next_value = issues.whole_number(
                fields,
                "nextValue",
                Presence::Optional,
                Number {
                    min: Some(1.0),
                    max: Some(999_999_999.0),
                    ..Number::default()
                },
            );
            let padding = issues.whole_number(
                fields,
                "padding",
                Presence::Optional,
                Number {
                    min: Some(0.0),
                    max: Some(10.0),
                    ..Number::default()
                },
            );
            Some(Update {
                kind: kind?,
                prefix: prefix.into_option(),
                next_value: next_value.into_option(),
                padding: padding.into_option(),
            })
        },
    );
    let unique = kinds
        .iter()
        .enumerate()
        .all(|(at, kind)| !kinds[..at].contains(kind));
    if !aborted && !unique {
        issues.custom("sequences", "Each sequence at most once");
    }
    match sequences {
        Field::Set(sequences) => sequences,
        _ => Vec::new(),
    }
}

/// `NumberSequenceError`: a next number that would move back, with what was
/// already written when a document took a number mid-update.
struct Backwards(Map<String, Value>);

/// `updateNumberSequences(db, entityId, updates)`: apply the updates and
/// return the sequences afterwards, with what changed (for the audit log).
/// Every update is checked before anything is written; the forward-only
/// guard is repeated in each write, so a document numbered between the read
/// and the write can't be numbered twice.
async fn update_sequences(
    db: &PgPool,
    entity_id: &str,
    updates: &[Update],
) -> Result<Result<(Vec<Sequence>, Map<String, Value>), Backwards>, sqlx::Error> {
    let current = list_sequences(db, entity_id).await?;
    let mut planned = Vec::with_capacity(updates.len());
    for update in updates {
        let Some(before) = current.iter().find(|s| s.kind == update.kind) else {
            continue;
        };
        let next = Sequence {
            kind: update.kind,
            prefix: update
                .prefix
                .clone()
                .unwrap_or_else(|| before.prefix.clone()),
            next_value: update.next_value.unwrap_or(before.next_value),
            padding: update.padding.unwrap_or(before.padding),
        };
        if next.next_value < before.next_value {
            return Ok(Err(Backwards(Map::new())));
        }
        let changed: Vec<&str> = ["prefix", "nextValue", "padding"]
            .into_iter()
            .filter(|field| next.get(field) != before.get(field))
            .collect();
        planned.push((before, next, changed));
    }

    let mut changes = Map::new();
    for (before, next, changed) in planned {
        if changed.is_empty() {
            continue;
        }
        let stamp = now();
        let has = |field: &str| changed.contains(&field);
        let written: Option<String> = sqlx::query_scalar(
            "update entity_number_sequences set \
               prefix = case when $3 then $4 else prefix end, \
               next_value = case when $5 then $6 else next_value end, \
               padding = case when $7 then $8 else padding end, \
               updated_at = $9::timestamp \
             where entity_id = $1 and sequence_type = $2 and (not $5 or next_value <= $6) \
             returning id",
        )
        .bind(entity_id)
        .bind(next.kind.as_str())
        .bind(has("prefix"))
        .bind(&next.prefix)
        .bind(has("nextValue"))
        .bind(next.next_value)
        .bind(has("padding"))
        .bind(next.padding)
        .bind(&stamp)
        .fetch_optional(db)
        .await?;
        if written.is_none() {
            let inserted: Option<String> = sqlx::query_scalar(
                "insert into entity_number_sequences \
                 (id, entity_id, sequence_type, prefix, next_value, padding, created_at, updated_at) \
                 values ($1, $2, $3, $4, $5, $6, $7::timestamp, $7::timestamp) \
                 on conflict do nothing returning id",
            )
            .bind(generate_id("seq"))
            .bind(entity_id)
            .bind(next.kind.as_str())
            .bind(&next.prefix)
            .bind(next.next_value)
            .bind(next.padding)
            .bind(&stamp)
            .fetch_optional(db)
            .await?;
            // A row exists but its next number is already past the requested one.
            if inserted.is_none() {
                return Ok(Err(Backwards(changes)));
            }
        }
        for field in changed {
            changes.insert(
                format!("{}.{field}", next.kind.as_str()),
                change(before.get(field), next.get(field)),
            );
        }
    }
    Ok(Ok((list_sequences(db, entity_id).await?, changes)))
}

pub(crate) async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let updates = match validate(&headers, &body, read_sequences) {
        Ok(updates) => updates,
        Err(refusal) => return refusal.respond("Failed to update the numbering"),
    };
    reply(
        update_numbering(&caller, &state, &id, &updates).await,
        "Failed to update the numbering",
    )
}

/// The audit row and the event of a numbering change.
async fn record_changes(
    caller: &Caller,
    state: &BooksState,
    entity: &Map<String, Value>,
    changes: Map<String, Value>,
    sequences: &[Sequence],
) {
    let id = entity.get("id").and_then(Value::as_str).unwrap_or_default();
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(id),
            entity_type: "accounting_entity",
            entity_id: id,
            action: "numbering_updated",
            changes: Some(changes),
        },
    )
    .await;
    let listed: Vec<Value> = sequences
        .iter()
        .map(|s| {
            json!({
                "sequenceType": s.kind.as_str(),
                "prefix": s.prefix,
                "nextValue": s.next_value,
                "padding": s.padding,
            })
        })
        .collect();
    caller.publish(
        state,
        ACCOUNTING_ENTITY_UPDATED,
        id,
        json!({
            "id": id,
            "name": entity.get("name").cloned().unwrap_or(Value::Null),
            "numberSequences": listed,
        }),
    );
}

async fn update_numbering(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    updates: &[Update],
) -> Reply {
    let Some(entity) = find_active(caller, id).await? else {
        return Err(Refusal::not_found("Entity", id));
    };
    match update_sequences(&caller.db, id, updates).await? {
        Ok((sequences, changes)) => {
            if !changes.is_empty() {
                record_changes(caller, state, &entity, changes, &sequences).await;
            }
            Ok(ok(sequences_json(&sequences)))
        }
        Err(Backwards(changes)) => {
            // A document took a number mid-update: what was written before
            // that still gets its audit row and event.
            if !changes.is_empty() {
                let sequences = list_sequences(&caller.db, id).await?;
                record_changes(caller, state, &entity, changes, &sequences).await;
            }
            Err(Refusal::bad_request(NEXT_VALUE_FORWARD_ONLY))
        }
    }
}
