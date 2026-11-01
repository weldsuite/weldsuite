//! Fields, boxes on a page one signer fills in
//! (`packages/domains/sign/src/fields.ts`, `routes/envelopes/fields.ts`). The
//! editor saves the whole set at once, so the service replaces it, keeping
//! the ids of fields it already had. The same route serves drafts and
//! templates (`DraftScope`).

use std::collections::HashSet;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Number, Presence, Text};
use weldsuite_kit::{Data, generate_id};

use crate::envelopes::{
    field_dto, list_documents, list_fields, list_recipients, load_draft, load_template,
    publish_updated, touch_envelope, viewer_of,
};
use crate::templates::publish_template_updated;
use crate::{Caller, SignError, SignResult, SignState, answer, text, validate};

/// `SIGN_LIMITS.maxFields`.
const MAX_FIELDS: usize = 1000;
/// `SIGN_MIN_FIELD_SIZE`, in PDF points.
const MIN_FIELD_SIZE: f64 = 8.0;
const FIELD_TYPES: [&str; 7] = [
    "signature",
    "initials",
    "date_signed",
    "name",
    "email",
    "text",
    "checkbox",
];

/// One field as sent (`fieldInputSchema`).
struct FieldInput {
    id: Option<String>,
    document_id: String,
    recipient_id: String,
    kind: String,
    page: i64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    required: bool,
    label: Option<String>,
}

fn read_fields(headers: &HeaderMap, body: &Bytes) -> SignResult<Vec<FieldInput>> {
    let at_least = |min: f64| Number {
        min: Some(min),
        ..Number::default()
    };
    validate(headers, body, |issues, fields| {
        issues.list(
            fields,
            "fields",
            Presence::Required,
            None,
            Some(MAX_FIELDS),
            |issues, item| {
                let item = issues.object(item)?;
                let id = issues.text(item, "id", Presence::Optional, None, Some(30));
                let document_id =
                    issues.text(item, "documentId", Presence::Required, Some(1), Some(30));
                let recipient_id =
                    issues.text(item, "recipientId", Presence::Required, Some(1), Some(30));
                let kind = issues.choice(item, "type", Presence::Required, &FIELD_TYPES);
                let page = issues.integer(item, "page", Presence::Required, Some(0));
                let x = issues.number(item, "x", Presence::Required, at_least(0.0));
                let y = issues.number(item, "y", Presence::Required, at_least(0.0));
                let width =
                    issues.number(item, "width", Presence::Required, at_least(MIN_FIELD_SIZE));
                let height =
                    issues.number(item, "height", Presence::Required, at_least(MIN_FIELD_SIZE));
                let required = issues.boolean(item, "required", Presence::Required);
                let label = issues.text_with(
                    item,
                    "label",
                    Presence::Nullish,
                    Text::trimmed(None, Some(255)),
                );
                Some(FieldInput {
                    id: id.into_option(),
                    document_id: document_id.into_option()?,
                    recipient_id: recipient_id.into_option()?,
                    kind: kind.into_option()?,
                    page: page.into_option()?,
                    x: x.into_option()?,
                    y: y.into_option()?,
                    width: width.into_option()?,
                    height: height.into_option()?,
                    required: required.into_option()?,
                    label: label.into_option(),
                })
            },
        )
    })
    .map(weldsuite_kit::validation::Field::into_option)
    .map(Option::unwrap_or_default)
}

/// The first problem with a field against the envelope's documents and
/// recipients (`fieldProblem`), or `None`.
fn field_problem(field: &FieldInput, documents: &[Value], recipients: &[Value]) -> Option<String> {
    let Some(doc) = documents
        .iter()
        .find(|d| d["id"] == field.document_id.as_str())
    else {
        return Some(format!(
            "Document {} is not part of this envelope",
            field.document_id
        ));
    };
    let Some(recipient) = recipients
        .iter()
        .find(|r| r["id"] == field.recipient_id.as_str())
    else {
        return Some(format!(
            "Recipient {} is not part of this envelope",
            field.recipient_id
        ));
    };
    if recipient["role"] != "signer" {
        return Some("Copy recipients cannot have fields".to_owned());
    }
    let page = field.page + 1;
    if field.page >= doc["pageCount"].as_i64().unwrap_or(0) {
        return Some(format!("Page {page} does not exist in this document"));
    }
    let size = usize::try_from(field.page)
        .ok()
        .and_then(|i| doc["pageSizes"].get(i));
    if let Some(size) = size {
        // Half a point of slack: the editor converts from screen pixels.
        let slack = 0.5;
        let width = size["width"].as_f64().unwrap_or(0.0);
        let height = size["height"].as_f64().unwrap_or(0.0);
        if field.x + field.width > width + slack || field.y + field.height > height + slack {
            return Some(format!("A field on page {page} lies outside the page"));
        }
    }
    None
}

/// Replace the envelope's fields (`replaceFields`): upsert, then drop what
/// is gone, so a failed insert never leaves the draft without fields.
async fn replace_fields(
    db: &PgPool,
    envelope_id: &str,
    fields: Vec<FieldInput>,
) -> SignResult<Vec<Value>> {
    let documents = list_documents(db, envelope_id).await?;
    let recipients = list_recipients(db, envelope_id).await?;
    if let Some(problem) = fields
        .iter()
        .find_map(|f| field_problem(f, &documents, &recipients))
    {
        return Err(SignError::invalid(problem));
    }

    // Keep an id the client sent only when it is already one of this
    // envelope's fields (once): ids are table-wide keys.
    let existing: HashSet<String> = list_fields(db, envelope_id)
        .await?
        .iter()
        .map(|f| text(f, "id").to_owned())
        .collect();
    let mut seen = HashSet::new();
    let mut ids = Vec::with_capacity(fields.len());
    for field in &fields {
        let keep = field
            .id
            .as_ref()
            .filter(|id| existing.contains(*id) && !seen.contains(*id));
        let id = keep.cloned().unwrap_or_else(|| generate_id("sgf"));
        seen.insert(id.clone());
        ids.push(id);
    }

    if !fields.is_empty() {
        // One statement, as Drizzle's multi-row insert. Fields are listed by
        // `created_at`, so new ones are a millisecond apart in the order sent
        // (as `replaceFields` stamps them); a kept field keeps its own.
        sqlx::query(
            "insert into sign_fields
                 (id, created_at, envelope_id, document_id, recipient_id, type, page, x, y,
                  width, height, required, label)
             select u.id, $13::timestamptz + (u.n - 1) * interval '1 millisecond', $2,
                    u.document_id, u.recipient_id, u.type, u.page, u.x, u.y, u.width,
                    u.height, u.required, u.label
             from unnest($1::varchar[], $3::varchar[], $4::varchar[], $5::varchar[], $6::int[],
                         $7::float8[], $8::float8[], $9::float8[], $10::float8[], $11::bool[],
                         $12::varchar[]) with ordinality
                  as u(id, document_id, recipient_id, type, page, x, y, width, height, required,
                       label, n)
             on conflict (id) do update set
                 document_id = excluded.document_id,
                 recipient_id = excluded.recipient_id,
                 type = excluded.type,
                 page = excluded.page,
                 x = excluded.x,
                 y = excluded.y,
                 width = excluded.width,
                 height = excluded.height,
                 required = excluded.required,
                 label = excluded.label,
                 updated_at = $13::timestamptz",
        )
        .bind(&ids)
        .bind(envelope_id)
        .bind(
            fields
                .iter()
                .map(|f| f.document_id.clone())
                .collect::<Vec<_>>(),
        )
        .bind(
            fields
                .iter()
                .map(|f| f.recipient_id.clone())
                .collect::<Vec<_>>(),
        )
        .bind(fields.iter().map(|f| f.kind.clone()).collect::<Vec<_>>())
        .bind(
            fields
                .iter()
                .map(|f| i32::try_from(f.page).unwrap_or(i32::MAX))
                .collect::<Vec<_>>(),
        )
        .bind(fields.iter().map(|f| f.x).collect::<Vec<_>>())
        .bind(fields.iter().map(|f| f.y).collect::<Vec<_>>())
        .bind(fields.iter().map(|f| f.width).collect::<Vec<_>>())
        .bind(fields.iter().map(|f| f.height).collect::<Vec<_>>())
        .bind(fields.iter().map(|f| f.required).collect::<Vec<_>>())
        .bind(fields.iter().map(|f| f.label.clone()).collect::<Vec<_>>())
        .bind(crate::now())
        .execute(db)
        .await?;
    }
    sqlx::query("delete from sign_fields where envelope_id = $1 and not (id = any($2))")
        .bind(envelope_id)
        .bind(&ids)
        .execute(db)
        .await?;
    list_fields(db, envelope_id).await
}

/// `PUT /api/sign/envelopes/:id/fields`.
pub(crate) async fn replace_envelope_fields(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let fields = read_fields(&headers, &body)?;
            let viewer = viewer_of(&caller).await?;
            let envelope = load_draft(&caller.db, &id, &viewer).await?;
            let rows = replace_fields(&caller.db, text(&envelope, "id"), fields).await?;
            touch_envelope(&caller.db, text(&envelope, "id")).await?;
            publish_updated(&caller, &state, &envelope);
            Ok(Data(rows.iter().map(field_dto).collect::<Vec<_>>()).into_response())
        }
        .await,
    )
}

/// `PUT /api/sign/templates/:id/fields`.
pub(crate) async fn replace_template_fields(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let fields = read_fields(&headers, &body)?;
            let template = load_template(&caller.db, &id).await?;
            let rows = replace_fields(&caller.db, text(&template, "id"), fields).await?;
            touch_envelope(&caller.db, text(&template, "id")).await?;
            publish_template_updated(&caller, &state, &template);
            Ok(Data(rows.iter().map(field_dto).collect::<Vec<_>>()).into_response())
        }
        .await,
    )
}
