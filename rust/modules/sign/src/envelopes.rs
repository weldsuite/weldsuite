//! Envelopes, the signing request (`packages/domains/sign/src/envelopes.ts`,
//! `apps/workers/sign-api/src/routes/envelopes/{index,shared}.ts`), and the
//! activity trail (`listEvents` in `lifecycle.ts`, `events.ts`).

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use weldsuite_catalogs::entity_events::{
    SIGN_ENVELOPE_CREATED, SIGN_ENVELOPE_DELETED, SIGN_ENVELOPE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    SIGN_ENVELOPES_MANAGE, SIGN_ENVELOPES_SEND, SIGN_ENVELOPES_UPDATE, SIGN_ENVELOPES_VOID,
};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Format, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::sources;
use crate::{
    Caller, SignError, SignResult, SignState, answer, like_pattern, now, offset_page, or_else,
    text, validate, validate_query,
};

const DEFAULT_LIMIT: i64 = 50;
const FOLDERS: [&str; 6] = [
    "all",
    "action_required",
    "drafts",
    "in_progress",
    "completed",
    "closed",
];

/// `SIGN_FOLDER_STATUSES`: which statuses each folder shows.
fn folder_statuses(folder: &str) -> Option<&'static [&'static str]> {
    match folder {
        "action_required" | "in_progress" => Some(&["sent", "in_progress"]),
        "drafts" => Some(&["draft"]),
        "completed" => Some(&["completed"]),
        "closed" => Some(&["declined", "voided", "expired"]),
        _ => None,
    }
}

// ── Viewer and loading ─────────────────────────────────────────────────────

/// Who is asking, and whether they see every envelope (`SignViewer`).
pub(crate) struct Viewer {
    pub(crate) user_id: String,
    /// Lower-cased: they also see sent requests they are a recipient of.
    pub(crate) email: Option<String>,
    pub(crate) manage_all: bool,
}

/// Name and email of a member (`memberProfile`): the name falls back to the
/// email.
pub(crate) async fn member_profile(
    db: &PgPool,
    user_id: &str,
) -> SignResult<(Option<String>, Option<String>)> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "select name, email from workspace_members
         where user_id = $1 and deleted_at is null limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let (name, email) = row.unwrap_or_default();
    let name = name
        .filter(|n| !n.is_empty())
        .or_else(|| email.clone().filter(|e| !e.is_empty()));
    Ok((name, email))
}

/// `viewerOf(c)`.
pub(crate) async fn viewer_of(caller: &Caller) -> SignResult<Viewer> {
    let (_, email) = member_profile(&caller.db, &caller.user_id).await?;
    Ok(Viewer {
        user_id: caller.user_id.clone(),
        email: email.map(|e| e.to_lowercase()),
        manage_all: caller.can(SIGN_ENVELOPES_MANAGE),
    })
}

pub(crate) fn is_owner(envelope: &Value, viewer: &Viewer) -> bool {
    viewer.manage_all || text(envelope, "senderUserId") == viewer.user_id
}

/// Still collecting signatures: sent or in progress, and not past expiry.
fn is_open_request(envelope: &Value) -> bool {
    let status = text(envelope, "status");
    if status != "sent" && status != "in_progress" {
        return false;
    }
    match envelope["expiresAt"].as_str() {
        None => true,
        Some(at) => {
            OffsetDateTime::parse(at, &Rfc3339).is_ok_and(|at| at > OffsetDateTime::now_utc())
        }
    }
}

async fn find_envelope(db: &PgPool, id: &str, kind: &str) -> SignResult<Option<Value>> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(e) from sign_envelopes e
         where id = $1 and kind = $2 and deleted_at is null limit 1",
    )
    .bind(id)
    .bind(kind)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// An envelope the viewer may see, or `not_found`: their own, any with
/// `sign_envelopes:manage`, and a sent one they are a recipient of.
pub(crate) async fn load_envelope(db: &PgPool, id: &str, viewer: &Viewer) -> SignResult<Value> {
    let Some(row) = find_envelope(db, id, "envelope").await? else {
        return Err(SignError::NotFound("Envelope"));
    };
    if is_owner(&row, viewer) {
        return Ok(row);
    }
    if text(&row, "status") != "draft"
        && let Some(email) = &viewer.email
    {
        let recipient: Option<String> = sqlx::query_scalar(
            "select id from sign_recipients where envelope_id = $1 and email = $2 limit 1",
        )
        .bind(id)
        .bind(email)
        .fetch_optional(db)
        .await?;
        if recipient.is_some() {
            return Ok(row);
        }
    }
    Err(SignError::NotFound("Envelope"))
}

/// An envelope the viewer owns, for anything that changes it.
pub(crate) async fn load_own_envelope(db: &PgPool, id: &str, viewer: &Viewer) -> SignResult<Value> {
    match find_envelope(db, id, "envelope").await? {
        Some(row) if is_owner(&row, viewer) => Ok(row),
        _ => Err(SignError::NotFound("Envelope")),
    }
}

/// Same, and still a draft.
pub(crate) async fn load_draft(db: &PgPool, id: &str, viewer: &Viewer) -> SignResult<Value> {
    let row = load_own_envelope(db, id, viewer).await?;
    if text(&row, "status") != "draft" {
        return Err(SignError::not_a_draft());
    }
    Ok(row)
}

/// A live template, or `not_found` (`loadTemplate`).
pub(crate) async fn load_template(db: &PgPool, id: &str) -> SignResult<Value> {
    find_envelope(db, id, "template")
        .await?
        .ok_or(SignError::NotFound("Template"))
}

/// Bump `updated_at` after a change to anything hanging off the envelope.
pub(crate) async fn touch_envelope(db: &PgPool, id: &str) -> SignResult<()> {
    sqlx::query("update sign_envelopes set updated_at = $2::timestamptz where id = $1")
        .bind(id)
        .bind(now())
        .execute(db)
        .await?;
    Ok(())
}

/// The `sign_envelope` event payload: ids, title and status only (EVT-005).
pub(crate) fn event_data(envelope: &Value) -> Value {
    json!({
        "id": envelope["id"],
        "title": envelope["title"],
        "status": envelope["status"],
        "senderUserId": envelope["senderUserId"],
    })
}

/// `sign_envelope:updated` after a change to a draft's parts.
pub(crate) fn publish_updated(caller: &Caller, state: &SignState, envelope: &Value) {
    caller.publish(
        state,
        SIGN_ENVELOPE_UPDATED,
        text(envelope, "id"),
        &event_data(envelope),
    );
}

// ── Mapping ────────────────────────────────────────────────────────────────

fn pick(row: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter()
        .map(|key| ((*key).to_owned(), row[*key].clone()))
        .collect()
}

pub(crate) fn document_dto(row: &Value) -> Value {
    Value::Object(pick(
        row,
        &[
            "id",
            "name",
            "position",
            "sizeBytes",
            "pageCount",
            "pageSizes",
            "sha256",
            "createdAt",
        ],
    ))
}

pub(crate) fn recipient_dto(row: &Value) -> Value {
    let mut dto = pick(
        row,
        &[
            "id",
            "role",
            "roleName",
            "name",
            "email",
            "personId",
            "locale",
            "routingOrder",
            "authMode",
        ],
    );
    dto.insert(
        "hasAccessCode".to_owned(),
        json!(!row["accessCodeHash"].is_null()),
    );
    dto.extend(pick(
        row,
        &[
            "status",
            "sentAt",
            "openedAt",
            "signedAt",
            "declinedAt",
            "declineReason",
            "lastRemindedAt",
            "remindersSent",
        ],
    ));
    Value::Object(dto)
}

pub(crate) fn field_dto(row: &Value) -> Value {
    Value::Object(pick(
        row,
        &[
            "id",
            "documentId",
            "recipientId",
            "type",
            "page",
            "x",
            "y",
            "width",
            "height",
            "required",
            "label",
        ],
    ))
}

fn summary(row: &Value, document_count: i64, recipients: &[&Value]) -> Map<String, Value> {
    let signers: Vec<_> = recipients
        .iter()
        .filter(|r| r["role"] == "signer")
        .collect();
    let signed = signers.iter().filter(|r| r["status"] == "signed").count();
    let mut sorted = recipients.to_vec();
    // `Array#sort` is stable, as is `sort_by_key`.
    sorted.sort_by_key(|r| r["routingOrder"].as_i64().unwrap_or(0));
    let preview: Vec<Value> = sorted
        .iter()
        .map(|r| or_else(&r["name"], &r["email"]))
        .filter(|name| !name.is_null())
        .take(3)
        .collect();
    let mut out = pick(
        row,
        &[
            "id",
            "kind",
            "title",
            "status",
            "senderUserId",
            "senderName",
        ],
    );
    out.insert("documentCount".to_owned(), json!(document_count));
    out.insert(
        "recipients".to_owned(),
        json!({ "signers": signers.len(), "signed": signed, "cc": recipients.len() - signers.len() }),
    );
    out.insert("recipientPreview".to_owned(), Value::Array(preview));
    out.extend(pick(
        row,
        &[
            "sentAt",
            "completedAt",
            "expiresAt",
            "createdAt",
            "updatedAt",
        ],
    ));
    out
}

async fn rows(db: &PgPool, sql: &'static str, id: &str) -> SignResult<Vec<Value>> {
    let rows: Vec<Value> = sqlx::query_scalar(sql).bind(id).fetch_all(db).await?;
    Ok(rows.into_iter().map(js_row).collect())
}

pub(crate) async fn list_documents(db: &PgPool, envelope_id: &str) -> SignResult<Vec<Value>> {
    rows(
        db,
        "select to_jsonb(d) from sign_documents d where envelope_id = $1 order by position asc",
        envelope_id,
    )
    .await
}

pub(crate) async fn list_recipients(db: &PgPool, envelope_id: &str) -> SignResult<Vec<Value>> {
    rows(
        db,
        "select to_jsonb(r) from sign_recipients r where envelope_id = $1
         order by routing_order asc, created_at asc",
        envelope_id,
    )
    .await
}

pub(crate) async fn list_fields(db: &PgPool, envelope_id: &str) -> SignResult<Vec<Value>> {
    rows(
        db,
        "select to_jsonb(f) from sign_fields f where envelope_id = $1 order by created_at asc",
        envelope_id,
    )
    .await
}

/// The last filing of a completed request (`latestFiling`).
async fn latest_filing(db: &PgPool, envelope_id: &str) -> SignResult<Value> {
    let row: Option<(Option<Value>, Value)> = sqlx::query_as(
        "select details, to_jsonb(created_at) from sign_events
         where envelope_id = $1 and type = 'filed' order by created_at desc limit 1",
    )
    .bind(envelope_id)
    .fetch_optional(db)
    .await?;
    let Some((details, created_at)) = row else {
        return Ok(Value::Null);
    };
    let details = details.unwrap_or_else(|| json!({}));
    let string = |key: &str| match &details[key] {
        Value::String(s) => json!(s),
        _ => Value::Null,
    };
    let record_type = match details["recordType"].as_str() {
        Some(kind @ ("company" | "person")) => json!(kind),
        _ => Value::Null,
    };
    let filed_at = js_row(json!({ "filedAt": created_at }))["filedAt"].clone();
    Ok(json!({
        "driveFileId": string("driveFileId"),
        "driveFolderId": string("driveFolderId"),
        "recordFileId": string("recordFileId"),
        "recordType": record_type,
        "recordId": string("recordId"),
        "activityId": string("activityId"),
        "filedAt": filed_at,
    }))
}

/// What the caller holds, for the detail's action flags (`DetailAccess`).
pub(crate) struct DetailAccess {
    pub(crate) viewer: Viewer,
    pub(crate) update: bool,
    pub(crate) send: bool,
    pub(crate) void: bool,
}

/// `accessOf(c, viewer)`.
pub(crate) async fn access_of(caller: &Caller, viewer: Option<Viewer>) -> SignResult<DetailAccess> {
    let viewer = match viewer {
        Some(viewer) => viewer,
        None => viewer_of(caller).await?,
    };
    let writable = !caller.read_only;
    Ok(DetailAccess {
        viewer,
        update: writable && caller.can(SIGN_ENVELOPES_UPDATE),
        send: writable && caller.can(SIGN_ENVELOPES_SEND),
        void: writable && caller.can(SIGN_ENVELOPES_VOID),
    })
}

/// The envelope with its documents, recipients and fields (`getEnvelopeDetail`).
pub(crate) async fn envelope_detail(
    db: &PgPool,
    envelope: &Value,
    access: &DetailAccess,
) -> SignResult<Value> {
    let id = text(envelope, "id");
    let documents = list_documents(db, id).await?;
    let recipients = list_recipients(db, id).await?;
    let fields = list_fields(db, id).await?;
    let source = sources::source_dto(db, &envelope["source"]).await?;
    let filing = if text(envelope, "status") == "completed" {
        latest_filing(db, id).await?
    } else {
        Value::Null
    };

    let owner = is_owner(envelope, &access.viewer);
    let signers: Vec<&Value> = recipients
        .iter()
        .filter(|r| r["role"] == "signer")
        .collect();
    // Everyone signed: the signed PDF is on its way, nothing left to chase.
    let open = is_open_request(envelope) && !signers.iter().all(|r| r["status"] == "signed");
    let my_turn = access.viewer.email.as_deref().and_then(|email| {
        signers
            .iter()
            .find(|r| r["email"] == email && (r["status"] == "sent" || r["status"] == "opened"))
    });

    let recipient_refs: Vec<&Value> = recipients.iter().collect();
    let document_count = i64::try_from(documents.len()).unwrap_or(i64::MAX);
    let mut detail = summary(envelope, document_count, &recipient_refs);
    detail.extend(pick(
        envelope,
        &[
            "message",
            "signingOrderEnabled",
            "reminderAfterDays",
            "reminderEveryDays",
            "reminderMaxCount",
        ],
    ));
    detail.insert(
        "documents".to_owned(),
        documents.iter().map(document_dto).collect(),
    );
    detail.insert(
        "recipientList".to_owned(),
        recipients.iter().map(recipient_dto).collect(),
    );
    detail.insert("fields".to_owned(), fields.iter().map(field_dto).collect());
    detail.extend(pick(envelope, &["voidedReason", "voidedAt"]));
    detail.insert("source".to_owned(), source);
    detail.extend(pick(envelope, &["fileBackFolderId"]));
    detail.insert("filing".to_owned(), filing);
    let is_draft = text(envelope, "status") == "draft";
    detail.insert(
        "canEdit".to_owned(),
        json!(owner && access.update && is_draft),
    );
    detail.insert("isOwner".to_owned(), json!(owner));
    detail.insert("canVoid".to_owned(), json!(owner && access.void && open));
    detail.insert("canRemind".to_owned(), json!(owner && access.send && open));
    let my_signer = match (open, my_turn) {
        (true, Some(signer)) => signer["id"].clone(),
        _ => Value::Null,
    };
    detail.insert("mySignerId".to_owned(), my_signer);
    Ok(Value::Object(detail))
}

/// `detailFor(c, envelope, viewer)`.
pub(crate) async fn detail_for(
    caller: &Caller,
    envelope: &Value,
    viewer: Option<Viewer>,
) -> SignResult<Value> {
    let access = access_of(caller, viewer).await?;
    envelope_detail(&caller.db, envelope, &access).await
}

/// Add to the trail (`recordSignEvent`).
pub(crate) async fn record_event(
    db: &PgPool,
    envelope_id: &str,
    kind: &str,
    actor: (&str, Option<&str>, Option<&str>),
) -> SignResult<()> {
    sqlx::query(
        "insert into sign_events (id, envelope_id, type, actor_user_id, actor_name, actor_email)
         values ($1, $2, $3, $4, $5, $6)",
    )
    .bind(generate_id("sge"))
    .bind(envelope_id)
    .bind(kind)
    .bind(actor.0)
    .bind(actor.1)
    .bind(actor.2)
    .execute(db)
    .await?;
    Ok(())
}

// ── GET / ──────────────────────────────────────────────────────────────────

/// `listEnvelopesQuerySchema` / `listTemplatesQuerySchema`: search, limit
/// and the offset cursor.
pub(crate) fn page_query(
    issues: &mut weldsuite_kit::validation::Issues,
    query: &Map<String, Value>,
) -> (Option<String>, i64, i64) {
    let search = issues.text_with(
        query,
        "search",
        Presence::Optional,
        Text::trimmed(None, Some(255)),
    );
    let limit = issues.whole_number(
        query,
        "limit",
        Presence::Optional,
        Number {
            coerce: true,
            int: true,
            min: Some(1.0),
            max: Some(200.0),
        },
    );
    let cursor = issues.text_with(
        query,
        "cursor",
        Presence::Optional,
        Text {
            format: Some(Format::Digits),
            ..Text::default()
        },
    );
    let offset = cursor
        .into_option()
        .and_then(|c| c.parse::<i64>().ok())
        .unwrap_or(0);
    (
        search.into_option().filter(|s| !s.is_empty()),
        limit.into_option().unwrap_or(DEFAULT_LIMIT),
        offset,
    )
}

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    answer(list_envelopes(&caller, query.as_deref()).await)
}

async fn list_envelopes(caller: &Caller, query: Option<&str>) -> SignResult<Response> {
    let (folder, (search, limit, offset)) = validate_query(query, |issues, query| {
        let folder = issues.choice(query, "folder", Presence::Optional, &FOLDERS);
        (folder, page_query(issues, query))
    })?;
    let folder = folder.into_option().unwrap_or_else(|| "all".to_owned());
    let viewer = viewer_of(caller).await?;
    let statuses: Option<Vec<String>> =
        folder_statuses(&folder).map(|s| s.iter().map(|s| (*s).to_owned()).collect());
    let pattern = search.as_deref().map(like_pattern);
    let awaiting = folder == "action_required";

    // The page and the count share one WHERE; a flag turns each part off.
    let page: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(e) from sign_envelopes e
         where e.kind = 'envelope' and e.deleted_at is null
           and ($1 or e.sender_user_id = $2
                or ($3::text is not null and e.status <> 'draft'
                    and e.id in (select envelope_id from sign_recipients where email = $3)))
           and (not $4 or ($3::text is not null
                and e.id in (select envelope_id from sign_recipients
                             where email = $3 and role = 'signer' and status in ('sent', 'opened'))))
           and ($5::text[] is null or e.status = any($5))
           and ($6::text is null or e.title ilike $6)
         order by e.updated_at desc, e.id desc
         limit $7 offset $8",
    )
    .bind(viewer.manage_all)
    .bind(&viewer.user_id)
    .bind(viewer.email.as_deref())
    .bind(awaiting)
    .bind(statuses.as_deref())
    .bind(pattern.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from sign_envelopes e
         where e.kind = 'envelope' and e.deleted_at is null
           and ($1 or e.sender_user_id = $2
                or ($3::text is not null and e.status <> 'draft'
                    and e.id in (select envelope_id from sign_recipients where email = $3)))
           and (not $4 or ($3::text is not null
                and e.id in (select envelope_id from sign_recipients
                             where email = $3 and role = 'signer' and status in ('sent', 'opened'))))
           and ($5::text[] is null or e.status = any($5))
           and ($6::text is null or e.title ilike $6)",
    )
    .bind(viewer.manage_all)
    .bind(&viewer.user_id)
    .bind(viewer.email.as_deref())
    .bind(awaiting)
    .bind(statuses.as_deref())
    .bind(pattern.as_deref())
    .fetch_one(&caller.db)
    .await?;

    let page: Vec<Value> = page.into_iter().map(js_row).collect();
    let rows = summaries(&caller.db, &page).await?;
    Ok(offset_page(rows, total, offset))
}

/// The rows' document counts and recipients, then their summaries.
async fn summaries(db: &PgPool, page: &[Value]) -> SignResult<Vec<Value>> {
    if page.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = page.iter().map(|r| text(r, "id").to_owned()).collect();
    let counts: Vec<(String, i64)> = sqlx::query_as(
        "select envelope_id, count(*) from sign_documents
         where envelope_id = any($1) group by envelope_id",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let recipients: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(r) from sign_recipients r where envelope_id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?;
    let recipients: Vec<Value> = recipients.into_iter().map(js_row).collect();
    Ok(page
        .iter()
        .map(|row| {
            let id = text(row, "id");
            let count = counts
                .iter()
                .find(|(envelope, _)| envelope == id)
                .map_or(0, |(_, n)| *n);
            let mine: Vec<&Value> = recipients
                .iter()
                .filter(|r| r["envelopeId"] == id)
                .collect();
            Value::Object(summary(row, count, &mine))
        })
        .collect())
}

// ── POST / ─────────────────────────────────────────────────────────────────

const TITLE: Text = Text::trimmed(Some(1), Some(255));
const MESSAGE: Text = Text::trimmed(None, Some(5000));
const FOLDER_ID: Text = Text::length(Some(1), Some(255));

pub(crate) async fn create(
    State(state): State<SignState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(create_envelope(&state, &caller, &headers, &body).await)
}

async fn create_envelope(
    state: &SignState,
    caller: &Caller,
    headers: &HeaderMap,
    body: &Bytes,
) -> SignResult<Response> {
    let (title, message, source, folder) = validate(headers, body, |issues, fields| {
        (
            issues.text_with(fields, "title", Presence::Required, TITLE),
            issues.text_with(fields, "message", Presence::Nullish, MESSAGE),
            sources::read_source(issues, fields),
            issues.text_with(fields, "fileBackFolderId", Presence::Nullish, FOLDER_ID),
        )
    })?;
    let db = &caller.db;
    let user_id = caller.user_id.as_str();
    // A source must be a file or record the member may read; a Drive file's
    // folder becomes the signed copy's home unless the request names one.
    let checked = match source.as_set() {
        Some(source) => Some(sources::check_source(caller, source).await?),
        None => None,
    };
    check_file_back_folder(db, user_id, folder.as_set()).await?;
    let folder_id = match &folder {
        Field::Absent => checked.and_then(|c| c.folder_for_copy),
        Field::Null => None,
        Field::Set(id) => Some(id.clone()),
    };
    let (name, email) = member_profile(db, user_id).await?;
    let settings = load_sign_settings(db).await?;
    let source_json = source
        .as_set()
        .map(|s| json!({ "entityType": s.entity_type, "entityId": s.entity_id }));

    let envelope: Value = sqlx::query_scalar(
        "insert into sign_envelopes
             (id, kind, status, title, message, sender_user_id, sender_name, sender_email,
              reminder_after_days, reminder_every_days, reminder_max_count, source,
              file_back_folder_id)
         values ($1, 'envelope', 'draft', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning to_jsonb(sign_envelopes)",
    )
    .bind(generate_id("sgn"))
    .bind(title.into_option().unwrap_or_default())
    .bind(message.into_option())
    .bind(user_id)
    .bind(&name)
    .bind(&email)
    .bind(settings.after_days)
    .bind(settings.every_days)
    .bind(settings.max_count)
    .bind(source_json)
    .bind(folder_id)
    .fetch_one(db)
    .await?;
    let envelope = js_row(envelope);
    let id = text(&envelope, "id").to_owned();
    record_event(
        db,
        &id,
        "created",
        (user_id, name.as_deref(), email.as_deref()),
    )
    .await?;
    caller.publish(state, SIGN_ENVELOPE_CREATED, &id, &event_data(&envelope));
    Ok(Created(detail_for(caller, &envelope, None).await?).into_response())
}

/// A chosen folder for the signed copy must be one the member may add files to.
async fn check_file_back_folder(
    db: &PgPool,
    user_id: &str,
    folder_id: Option<&String>,
) -> SignResult<()> {
    if let Some(folder_id) = folder_id.filter(|id| !id.is_empty())
        && !sources::can_file_into(db, user_id, folder_id).await?
    {
        return Err(SignError::invalid(
            "You cannot add files to that WeldDrive folder",
        ));
    }
    Ok(())
}

/// Workspace reminder defaults for new envelopes (`loadSignSettings`).
pub(crate) struct SignDefaults {
    pub(crate) after_days: Option<i32>,
    pub(crate) every_days: Option<i32>,
    pub(crate) max_count: Option<i32>,
}

pub(crate) async fn load_sign_settings(db: &PgPool) -> SignResult<SignDefaults> {
    let row: Option<(Option<i32>, Option<i32>, Option<i32>)> = sqlx::query_as(
        "select default_reminder_after_days, default_reminder_every_days, default_reminder_max_count
         from sign_settings limit 1",
    )
    .fetch_optional(db)
    .await?;
    // `SIGN_DEFAULTS` until the workspace saves its own.
    let (after, every, max) = row.unwrap_or((Some(3), Some(3), Some(3)));
    Ok(SignDefaults {
        after_days: after,
        every_days: every,
        max_count: max,
    })
}

// ── GET /:id, PATCH /:id, DELETE /:id ──────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let viewer = viewer_of(&caller).await?;
            let envelope = load_envelope(&caller.db, &id, &viewer).await?;
            Ok(Data(detail_for(&caller, &envelope, Some(viewer)).await?).into_response())
        }
        .await,
    )
}

/// `updateEnvelopeSchema` (`templates` = its `updateTemplateSchema` subset).
pub(crate) struct EnvelopeChanges {
    title: Field<String>,
    message: Field<String>,
    signing_order: Field<bool>,
    expires_at: Field<String>,
    reminder_after: Field<i64>,
    reminder_every: Field<i64>,
    reminder_max: Field<i64>,
    pub(crate) folder: Field<String>,
}

pub(crate) fn read_changes(
    headers: &HeaderMap,
    body: &Bytes,
    templates: bool,
) -> SignResult<EnvelopeChanges> {
    let days = Number {
        int: true,
        min: Some(1.0),
        max: Some(90.0),
        ..Number::default()
    };
    validate(headers, body, |issues, fields| {
        let title = issues.text_with(fields, "title", Presence::Optional, TITLE);
        let message = issues.text_with(fields, "message", Presence::Nullish, MESSAGE);
        let signing_order = issues.boolean(fields, "signingOrderEnabled", Presence::Optional);
        let expires_at = if templates {
            Field::Absent
        } else {
            let at = Text {
                format: Some(Format::DatetimeOffset),
                ..Text::default()
            };
            issues.text_with(fields, "expiresAt", Presence::Nullish, at)
        };
        let reminder_after =
            issues.whole_number(fields, "reminderAfterDays", Presence::Nullish, days);
        let reminder_every =
            issues.whole_number(fields, "reminderEveryDays", Presence::Nullish, days);
        let max = Number {
            int: true,
            min: Some(0.0),
            max: Some(10.0),
            ..Number::default()
        };
        let reminder_max = issues.whole_number(fields, "reminderMaxCount", Presence::Nullish, max);
        let folder = if templates {
            Field::Absent
        } else {
            issues.text_with(fields, "fileBackFolderId", Presence::Nullish, FOLDER_ID)
        };
        EnvelopeChanges {
            title,
            message,
            signing_order,
            expires_at,
            reminder_after,
            reminder_every,
            reminder_max,
            folder,
        }
    })
}

/// `(set, value)` for `set col = case when set then value else col end`.
fn change<T: Clone>(field: &Field<T>) -> (bool, Option<T>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.clone())),
    }
}

/// Draft settings (`updateEnvelope`); only a draft can be changed.
pub(crate) async fn update_envelope(
    db: &PgPool,
    envelope: &Value,
    changes: &EnvelopeChanges,
) -> SignResult<Value> {
    if text(envelope, "status") != "draft" {
        return Err(SignError::not_a_draft());
    }
    let (set_title, title) = change(&changes.title);
    let (set_message, message) = change(&changes.message);
    let (set_order, order) = change(&changes.signing_order);
    let (set_expires, expires) = change(&changes.expires_at);
    let (set_after, after) = change(&changes.reminder_after);
    let (set_every, every) = change(&changes.reminder_every);
    let (set_max, max) = change(&changes.reminder_max);
    let (set_folder, folder) = change(&changes.folder);
    let row: Value = sqlx::query_scalar(
        "update sign_envelopes set
             title = case when $2 then $3 else title end,
             message = case when $4 then $5 else message end,
             signing_order_enabled = case when $6 then $7 else signing_order_enabled end,
             expires_at = case when $8 then $9::timestamptz else expires_at end,
             reminder_after_days = case when $10 then $11::int else reminder_after_days end,
             reminder_every_days = case when $12 then $13::int else reminder_every_days end,
             reminder_max_count = case when $14 then $15::int else reminder_max_count end,
             file_back_folder_id = case when $16 then $17 else file_back_folder_id end,
             updated_at = $18::timestamptz
         where id = $1
         returning to_jsonb(sign_envelopes)",
    )
    .bind(text(envelope, "id"))
    .bind(set_title)
    .bind(title)
    .bind(set_message)
    .bind(message)
    .bind(set_order)
    .bind(order)
    .bind(set_expires)
    .bind(expires)
    .bind(set_after)
    .bind(after)
    .bind(set_every)
    .bind(every)
    .bind(set_max)
    .bind(max)
    .bind(set_folder)
    .bind(folder)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

pub(crate) async fn update(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let changes = read_changes(&headers, &body, false)?;
            let viewer = viewer_of(&caller).await?;
            let envelope = load_own_envelope(&caller.db, &id, &viewer).await?;
            check_file_back_folder(&caller.db, &viewer.user_id, changes.folder.as_set()).await?;
            let updated = update_envelope(&caller.db, &envelope, &changes).await?;
            caller.publish(&state, SIGN_ENVELOPE_UPDATED, &id, &event_data(&updated));
            Ok(Data(detail_for(&caller, &updated, Some(viewer)).await?).into_response())
        }
        .await,
    )
}

/// Delete a draft and everything under it (`deleteDraft`); a draft never
/// reached anyone, so its trail goes too. The storage keys to remove.
pub(crate) async fn delete_draft(db: &PgPool, envelope: &Value) -> SignResult<Vec<String>> {
    if text(envelope, "status") != "draft" {
        return Err(SignError::not_a_draft());
    }
    let id = text(envelope, "id");
    let mut keys: Vec<String> =
        sqlx::query_scalar("select storage_key from sign_documents where envelope_id = $1")
            .bind(id)
            .fetch_all(db)
            .await?;
    let signatures: Vec<String> = sqlx::query_scalar(
        "select signature_key from sign_fields where envelope_id = $1 and signature_key is not null",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    keys.extend(signatures.into_iter().filter(|k| !k.is_empty()));
    for sql in [
        "delete from sign_fields where envelope_id = $1",
        "delete from sign_recipients where envelope_id = $1",
        "delete from sign_documents where envelope_id = $1",
        "delete from sign_events where envelope_id = $1",
        "delete from sign_envelopes where id = $1",
    ] {
        sqlx::query(sql).bind(id).execute(db).await?;
    }
    Ok(keys)
}

pub(crate) async fn remove(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let viewer = viewer_of(&caller).await?;
            let envelope = load_own_envelope(&caller.db, &id, &viewer).await?;
            let keys = delete_draft(&caller.db, &envelope).await?;
            crate::documents::delete_files_later(&caller, &state, keys);
            caller.publish(&state, SIGN_ENVELOPE_DELETED, &id, &event_data(&envelope));
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── GET /:id/events ────────────────────────────────────────────────────────

pub(crate) async fn events(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let viewer = viewer_of(&caller).await?;
            let envelope = load_own_envelope(&caller.db, &id, &viewer).await?;
            Ok(Data(list_events(&caller.db, text(&envelope, "id")).await?).into_response())
        }
        .await,
    )
}

/// The trail with recipient names (`listEvents`).
async fn list_events(db: &PgPool, envelope_id: &str) -> SignResult<Value> {
    let events = rows(
        db,
        "select to_jsonb(e) from sign_events e where envelope_id = $1
         order by created_at asc, id asc",
        envelope_id,
    )
    .await?;
    let recipients = list_recipients(db, envelope_id).await?;
    Ok(events
        .iter()
        .map(|e| {
            let recipient_name = match e["recipientId"].as_str() {
                Some(rid) => recipients
                    .iter()
                    .find(|r| r["id"] == rid)
                    .map_or(Value::Null, |r| or_else(&r["name"], &r["email"])),
                None => Value::Null,
            };
            json!({
                "id": e["id"],
                "type": e["type"],
                "recipientId": e["recipientId"],
                "recipientName": recipient_name,
                "actorName": e["actorName"],
                "actorEmail": e["actorEmail"],
                "ip": e["ip"],
                "createdAt": e["createdAt"],
                "details": e["details"],
            })
        })
        .collect())
}
