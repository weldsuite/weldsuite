//! Envelopes, the signing request (`packages/domains/sign/src/envelopes.ts`,
//! `apps/workers/sign-api/src/routes/envelopes/{index,shared}.ts`), and the
//! activity trail (`listEvents` in `lifecycle.ts`, `events.ts`).

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Query, SelectStatement};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde::Serialize;
use serde_json::{Map, Value, json};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use weldsuite_catalogs::entity_events::{
    SIGN_ENVELOPE_CREATED, SIGN_ENVELOPE_DELETED, SIGN_ENVELOPE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    SIGN_ENVELOPES_MANAGE, SIGN_ENVELOPES_SEND, SIGN_ENVELOPES_UPDATE, SIGN_ENVELOPES_VOID,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::{Field, Format, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{
    sign_documents, sign_envelopes, sign_events, sign_fields, sign_recipients, sign_settings,
    workspace_members,
};

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

// ── Rows ───────────────────────────────────────────────────────────────────

/// An entity row as Drizzle returns it: the entity serializes as Drizzle did.
pub(crate) fn row_json<M: Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// Entity rows as Drizzle returns them.
pub(crate) fn json_rows<M: Serialize>(rows: Vec<M>) -> SignResult<Vec<Value>> {
    Ok(rows.into_iter().map(row_json).collect::<Result<_, _>>()?)
}

/// The first row an `update … returning` gave back; none is the error
/// `fetch_one` raised (a 500).
pub(crate) fn returned<M>(rows: Vec<M>, table: &str) -> Result<M, DbErr> {
    rows.into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound(table.to_owned()))
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
    let row: Option<(Option<String>, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::Name,
            workspace_members::Column::Email,
        ])
        .filter(workspace_members::Column::UserId.eq(user_id))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
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
pub(crate) fn is_open_request(envelope: &Value) -> bool {
    is_open_request_at(envelope, OffsetDateTime::now_utc())
}

/// [`is_open_request`] at `now` (`isOpenRequest(envelope, now)`).
pub(crate) fn is_open_request_at(envelope: &Value, now: OffsetDateTime) -> bool {
    let status = text(envelope, "status");
    if status != "sent" && status != "in_progress" {
        return false;
    }
    match envelope["expiresAt"].as_str() {
        None => true,
        Some(at) => OffsetDateTime::parse(at, &Rfc3339).is_ok_and(|at| at > now),
    }
}

async fn find_envelope(db: &PgPool, id: &str, kind: &str) -> SignResult<Option<Value>> {
    let row = sign_envelopes::Entity::find()
        .filter(sign_envelopes::Column::Id.eq(id))
        .filter(sign_envelopes::Column::Kind.eq(kind))
        .filter(sign_envelopes::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(row.map(row_json).transpose()?)
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
        let recipient: Option<String> = sign_recipients::Entity::find()
            .select_only()
            .column(sign_recipients::Column::Id)
            .filter(sign_recipients::Column::EnvelopeId.eq(id))
            .filter(sign_recipients::Column::Email.eq(email.as_str()))
            .into_tuple()
            .one(&orm(db))
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
    sign_envelopes::Entity::update_many()
        .col_expr(sign_envelopes::Column::UpdatedAt, Expr::value(now()))
        .filter(sign_envelopes::Column::Id.eq(id))
        .exec(&orm(db))
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

/// The envelope's documents in order, as rows.
pub(crate) async fn document_rows(
    db: &PgPool,
    envelope_id: &str,
) -> SignResult<Vec<sign_documents::Model>> {
    Ok(sign_documents::Entity::find()
        .filter(sign_documents::Column::EnvelopeId.eq(envelope_id))
        .order_by_asc(sign_documents::Column::Position)
        .all(&orm(db))
        .await?)
}

pub(crate) async fn list_documents(db: &PgPool, envelope_id: &str) -> SignResult<Vec<Value>> {
    json_rows(document_rows(db, envelope_id).await?)
}

pub(crate) async fn list_recipients(db: &PgPool, envelope_id: &str) -> SignResult<Vec<Value>> {
    let rows = sign_recipients::Entity::find()
        .filter(sign_recipients::Column::EnvelopeId.eq(envelope_id))
        .order_by_asc(sign_recipients::Column::RoutingOrder)
        .order_by_asc(sign_recipients::Column::CreatedAt)
        .all(&orm(db))
        .await?;
    json_rows(rows)
}

/// The envelope's fields, oldest first, as rows.
pub(crate) async fn field_rows(
    db: &PgPool,
    envelope_id: &str,
) -> SignResult<Vec<sign_fields::Model>> {
    Ok(sign_fields::Entity::find()
        .filter(sign_fields::Column::EnvelopeId.eq(envelope_id))
        .order_by_asc(sign_fields::Column::CreatedAt)
        .all(&orm(db))
        .await?)
}

pub(crate) async fn list_fields(db: &PgPool, envelope_id: &str) -> SignResult<Vec<Value>> {
    json_rows(field_rows(db, envelope_id).await?)
}

/// The last filing of a completed request (`latestFiling`).
pub(crate) async fn latest_filing(db: &PgPool, envelope_id: &str) -> SignResult<Value> {
    let row: Option<(Option<Value>, OffsetDateTime)> = sign_events::Entity::find()
        .select_only()
        .columns([sign_events::Column::Details, sign_events::Column::CreatedAt])
        .filter(sign_events::Column::EnvelopeId.eq(envelope_id))
        .filter(sign_events::Column::Type.eq("filed"))
        .order_by_desc(sign_events::Column::CreatedAt)
        .into_tuple()
        .one(&orm(db))
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
    let filed_at = iso_timestamp(created_at);
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
    sign_events::Entity::insert(sign_events::ActiveModel {
        id: Set(generate_id("sge")),
        envelope_id: Set(envelope_id.to_owned()),
        type_: Set(kind.to_owned()),
        actor_user_id: Set(Some(actor.0.to_owned())),
        actor_name: Set(actor.1.map(str::to_owned)),
        actor_email: Set(actor.2.map(str::to_owned)),
        ..Default::default()
    })
    .exec_without_returning(&orm(db))
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
    let pattern = search.as_deref().map(like_pattern);
    let awaiting = folder == "action_required";

    // The page and the count share one WHERE.
    let Some(condition) = list_condition(
        &viewer,
        awaiting,
        folder_statuses(&folder),
        pattern.as_deref(),
    ) else {
        return Ok(offset_page(Vec::new(), 0, offset));
    };
    let db = &orm(&caller.db);
    let page = sign_envelopes::Entity::find()
        .filter(condition.clone())
        .order_by_desc(sign_envelopes::Column::UpdatedAt)
        .order_by_desc(sign_envelopes::Column::Id)
        .limit(u64::try_from(limit).unwrap_or(0))
        .offset(u64::try_from(offset).unwrap_or(0))
        .all(db)
        .await?;
    let total = sign_envelopes::Entity::find()
        .filter(condition)
        .count(db)
        .await?;

    let page = json_rows(page)?;
    let rows = summaries(&caller.db, &page).await?;
    Ok(offset_page(
        rows,
        i64::try_from(total).unwrap_or(i64::MAX),
        offset,
    ))
}

/// The listing's WHERE: live envelopes the viewer sees (all of them with
/// `manage_all`, else their own and the sent ones they are a recipient of),
/// in the folder (`action_required`: their turn to sign), matching the
/// search. `None` when nothing can match: their turn, without an email.
fn list_condition(
    viewer: &Viewer,
    awaiting: bool,
    statuses: Option<&[&str]>,
    pattern: Option<&str>,
) -> Option<Condition> {
    let email = viewer.email.as_deref();
    let mut condition = Condition::all()
        .add(sign_envelopes::Column::Kind.eq("envelope"))
        .add(sign_envelopes::Column::DeletedAt.is_null());
    if !viewer.manage_all {
        let mut visible =
            Condition::any().add(sign_envelopes::Column::SenderUserId.eq(viewer.user_id.as_str()));
        if let Some(email) = email {
            visible = visible.add(
                Condition::all()
                    .add(sign_envelopes::Column::Status.ne("draft"))
                    .add(sign_envelopes::Column::Id.in_subquery(envelopes_of(email, false))),
            );
        }
        condition = condition.add(visible);
    }
    if awaiting {
        condition =
            condition.add(sign_envelopes::Column::Id.in_subquery(envelopes_of(email?, true)));
    }
    if let Some(statuses) = statuses {
        condition = condition.add(sign_envelopes::Column::Status.is_in(statuses.iter().copied()));
    }
    if let Some(pattern) = pattern {
        condition = condition.add(sign_envelopes::Column::Title.ilike(pattern));
    }
    Some(condition)
}

/// `select envelope_id from sign_recipients where email = …`; with
/// `awaiting`, only where it is that signer's turn.
fn envelopes_of(email: &str, awaiting: bool) -> SelectStatement {
    let mut query = Query::select();
    query
        .column(sign_recipients::Column::EnvelopeId)
        .from(sign_recipients::Entity)
        .and_where(sign_recipients::Column::Email.eq(email));
    if awaiting {
        query
            .and_where(sign_recipients::Column::Role.eq("signer"))
            .and_where(sign_recipients::Column::Status.is_in(["sent", "opened"]));
    }
    query
}

/// The rows' document counts and recipients, then their summaries.
async fn summaries(db: &PgPool, page: &[Value]) -> SignResult<Vec<Value>> {
    if page.is_empty() {
        return Ok(Vec::new());
    }
    let db = &orm(db);
    let ids: Vec<&str> = page.iter().map(|r| text(r, "id")).collect();
    let counts: Vec<(String, i64)> = sign_documents::Entity::find()
        .select_only()
        .column(sign_documents::Column::EnvelopeId)
        .column_as(sign_documents::Column::Id.count(), "count")
        .filter(sign_documents::Column::EnvelopeId.is_in(ids.iter().copied()))
        .group_by(sign_documents::Column::EnvelopeId)
        .into_tuple()
        .all(db)
        .await?;
    let recipients = sign_recipients::Entity::find()
        .filter(sign_recipients::Column::EnvelopeId.is_in(ids.iter().copied()))
        .all(db)
        .await?;
    let recipients = json_rows(recipients)?;
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

    let envelope = sign_envelopes::Entity::insert(sign_envelopes::ActiveModel {
        id: Set(generate_id("sgn")),
        kind: Set("envelope".to_owned()),
        status: Set("draft".to_owned()),
        title: Set(title.into_option().unwrap_or_default()),
        message: Set(message.into_option()),
        sender_user_id: Set(user_id.to_owned()),
        sender_name: Set(name.clone()),
        sender_email: Set(email.clone()),
        reminder_after_days: Set(settings.after_days),
        reminder_every_days: Set(settings.every_days),
        reminder_max_count: Set(settings.max_count),
        source: Set(source_json),
        file_back_folder_id: Set(folder_id),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    let envelope = row_json(envelope)?;
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

/// `sign_settings` defaults: expiry, reminder delay, interval, maximum.
type SettingsRow = (Option<i32>, Option<i32>, Option<i32>, Option<i32>);

/// Workspace defaults for new envelopes (`loadSignSettings`).
pub(crate) struct SignDefaults {
    /// Days a sent request stays open when the sender picks no date.
    pub(crate) expiry_days: Option<i32>,
    pub(crate) after_days: Option<i32>,
    pub(crate) every_days: Option<i32>,
    pub(crate) max_count: Option<i32>,
}

pub(crate) async fn load_sign_settings(db: &PgPool) -> SignResult<SignDefaults> {
    let row: Option<SettingsRow> = sign_settings::Entity::find()
        .select_only()
        .columns([
            sign_settings::Column::DefaultExpiryDays,
            sign_settings::Column::DefaultReminderAfterDays,
            sign_settings::Column::DefaultReminderEveryDays,
            sign_settings::Column::DefaultReminderMaxCount,
        ])
        .into_tuple()
        .one(&orm(db))
        .await?;
    // `SIGN_DEFAULTS` until the workspace saves its own.
    let (expiry, after, every, max) = row.unwrap_or((Some(30), Some(3), Some(3), Some(3)));
    Ok(SignDefaults {
        expiry_days: expiry,
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

/// What a field the body sent writes (`set col = case when $set then $value
/// else col end`): `None` when it was left out, so the column keeps its
/// value; a null for an explicit null.
pub(crate) fn sent<T, V>(field: &Field<T>, to: impl FnOnce(&T) -> V) -> Option<sea_orm::Value>
where
    Option<V>: Into<sea_orm::Value>,
{
    match field {
        Field::Absent => None,
        Field::Null => Some(None::<V>.into()),
        Field::Set(value) => Some(Some(to(value)).into()),
    }
}

/// A number the schema bounds, as the `int` column takes it (`$n::int`).
pub(crate) fn int(n: i64) -> i32 {
    i32::try_from(n).unwrap_or(i32::MAX)
}

/// `$n::timestamptz` for a value `Format::DatetimeOffset` let through
/// (`YYYY-MM-DDTHH:MM[:SS[.fraction]]`, then `Z` or `±HH[:]MM`), read as
/// Postgres reads it: the fraction rounded to the microsecond.
fn offset_datetime(text: &str) -> Option<OffsetDateTime> {
    let (date_time, offset) = if let Some(date_time) = text.strip_suffix('Z') {
        (date_time, "Z".to_owned())
    } else {
        let (date_time, offset) = text.split_at(text.rfind(['+', '-'])?);
        let offset = if offset.len() == 5 {
            format!("{}:{}", &offset[..3], &offset[3..])
        } else {
            offset.to_owned()
        };
        (date_time, offset)
    };
    let time = date_time.split_once('T')?.1;
    let seconds = if time.matches(':').count() == 1 {
        ":00"
    } else {
        ""
    };
    let at = OffsetDateTime::parse(&format!("{date_time}{seconds}{offset}"), &Rfc3339).ok()?;
    let nanos = at.nanosecond() % 1000;
    let at = at - Duration::nanoseconds(i64::from(nanos));
    Some(if nanos >= 500 {
        at + Duration::microseconds(1)
    } else {
        at
    })
}

/// Draft settings (`updateEnvelope`); only a draft can be changed.
pub(crate) async fn update_envelope(
    db: &PgPool,
    envelope: &Value,
    changes: &EnvelopeChanges,
) -> SignResult<Value> {
    use sign_envelopes::Column;
    if text(envelope, "status") != "draft" {
        return Err(SignError::not_a_draft());
    }
    let expires = match &changes.expires_at {
        Field::Set(at) => Some(
            Some(
                offset_datetime(at)
                    .ok_or_else(|| SignError::Internal(format!("sign: unreadable expiry {at}")))?,
            )
            .into(),
        ),
        other => sent(other, |_| OffsetDateTime::UNIX_EPOCH),
    };
    let values: [(Column, Option<sea_orm::Value>); 9] = [
        (Column::Title, sent(&changes.title, Clone::clone)),
        (Column::Message, sent(&changes.message, Clone::clone)),
        (
            Column::SigningOrderEnabled,
            sent(&changes.signing_order, |on| *on),
        ),
        (Column::ExpiresAt, expires),
        (
            Column::ReminderAfterDays,
            sent(&changes.reminder_after, |n| int(*n)),
        ),
        (
            Column::ReminderEveryDays,
            sent(&changes.reminder_every, |n| int(*n)),
        ),
        (
            Column::ReminderMaxCount,
            sent(&changes.reminder_max, |n| int(*n)),
        ),
        (
            Column::FileBackFolderId,
            sent(&changes.folder, Clone::clone),
        ),
        (Column::UpdatedAt, Some(now().into())),
    ];
    let update = values.into_iter().fold(
        sign_envelopes::Entity::update_many(),
        |update, (column, value)| match value {
            Some(value) => update.col_expr(column, Expr::value(value)),
            None => update,
        },
    );
    let rows = update
        .filter(Column::Id.eq(text(envelope, "id")))
        .exec_with_returning(&orm(db))
        .await?;
    Ok(row_json(returned(rows, "sign_envelopes")?)?)
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
    let db = &orm(db);
    let mut keys: Vec<String> = sign_documents::Entity::find()
        .select_only()
        .column(sign_documents::Column::StorageKey)
        .filter(sign_documents::Column::EnvelopeId.eq(id))
        .into_tuple()
        .all(db)
        .await?;
    let signatures: Vec<String> = sign_fields::Entity::find()
        .select_only()
        .column(sign_fields::Column::SignatureKey)
        .filter(sign_fields::Column::EnvelopeId.eq(id))
        .filter(sign_fields::Column::SignatureKey.is_not_null())
        .into_tuple()
        .all(db)
        .await?;
    keys.extend(signatures.into_iter().filter(|k| !k.is_empty()));
    sign_fields::Entity::delete_many()
        .filter(sign_fields::Column::EnvelopeId.eq(id))
        .exec(db)
        .await?;
    sign_recipients::Entity::delete_many()
        .filter(sign_recipients::Column::EnvelopeId.eq(id))
        .exec(db)
        .await?;
    sign_documents::Entity::delete_many()
        .filter(sign_documents::Column::EnvelopeId.eq(id))
        .exec(db)
        .await?;
    sign_events::Entity::delete_many()
        .filter(sign_events::Column::EnvelopeId.eq(id))
        .exec(db)
        .await?;
    sign_envelopes::Entity::delete_many()
        .filter(sign_envelopes::Column::Id.eq(id))
        .exec(db)
        .await?;
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
    let events = sign_events::Entity::find()
        .filter(sign_events::Column::EnvelopeId.eq(envelope_id))
        .order_by_asc(sign_events::Column::CreatedAt)
        .order_by_asc(sign_events::Column::Id)
        .all(&orm(db))
        .await?;
    let events = json_rows(events)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// What `'…'::timestamptz` makes of the expiry forms the schema lets through.
    #[test]
    fn expiries_read_like_postgres() {
        let at = |text: &str| offset_datetime(text).map(iso_timestamp);
        assert_eq!(
            at("2026-10-29T07:00:00Z").as_deref(),
            Some("2026-10-29T07:00:00.000Z")
        );
        assert_eq!(
            at("2026-10-29T07:00Z").as_deref(),
            Some("2026-10-29T07:00:00.000Z")
        );
        assert_eq!(
            at("2026-10-29T07:00:00.123+02:00").as_deref(),
            Some("2026-10-29T05:00:00.123Z")
        );
        assert_eq!(
            at("2026-10-29T07:00:00-0530").as_deref(),
            Some("2026-10-29T12:30:00.000Z")
        );
        // Microseconds, rounded: `.1239996` is `.124000`.
        assert_eq!(
            at("2026-10-29T07:00:00.1239996Z").as_deref(),
            Some("2026-10-29T07:00:00.124Z")
        );
        assert_eq!(at("2026-10-29"), None);
    }
}
