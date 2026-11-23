//! `/v1/mail-labels` (`routes/v1/mail-labels/index.ts`): a mailbox's user
//! labels. System folders (`INBOX`, `SENT`, `STARRED`, …) are no rows here;
//! renaming a label renames it on every message that carries it. Applying
//! labels is on `/v1/mail-messages` and `/v1/mail-threads`.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use http::HeaderMap;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    MAIL_LABEL_CREATED, MAIL_LABEL_DELETED, MAIL_LABEL_UPDATED,
};
use weldsuite_mail_domain::access::{can_open_account, principal_account_ids};
use weldsuite_mail_domain::labels::{
    CreateMailLabel, MailLabelError, UpdateMailLabel, create_mail_label, delete_mail_label,
    get_mail_label, list_mail_labels, update_mail_label,
};

use super::schemas::{CREATE_LABEL, LIST_LABELS, UPDATE_LABEL};
use super::{MailCaller, opt_strings, opt_text};
use crate::ExternalApiState;
use crate::crud::{Answer, Fail, created, no_content, ok};
use crate::list::Page;
use crate::session::{conflict, database_error, not_found, not_found_resource};
use crate::zod;

type S = State<ExternalApiState>;

/// The label when it is in a mailbox the caller may open.
async fn reachable_label(mail: &MailCaller, id: &str) -> Result<Option<Value>, Fail> {
    let Some(label) = get_mail_label(mail.db(), id).await? else {
        return Ok(None);
    };
    let account = label["accountId"].as_str().unwrap_or_default();
    if !can_open_account(mail.db(), account, &mail.principal).await? {
        return Ok(None);
    }
    Ok(Some(label))
}

async fn reachable_or_404(mail: &MailCaller, id: &str) -> Result<Value, Fail> {
    reachable_label(mail, id)
        .await?
        .ok_or_else(|| not_found("MailLabel", id).into())
}

/// `labelErrorResponse(c, err, id)`.
fn label_error(error: MailLabelError, id: Option<&str>) -> Fail {
    match error {
        MailLabelError::NotFound => match id {
            Some(id) => not_found("MailLabel", id).into(),
            None => not_found_resource("MailLabel").into(),
        },
        MailLabelError::DuplicateName(message) | MailLabelError::SystemLabelImmutable(message) => {
            conflict(message).into()
        }
        MailLabelError::Db(error) => database_error(&error).into(),
    }
}

/// The fields of a label event.
fn event(row: &Value, id: &str) -> Value {
    json!({ "id": id, "accountId": row["accountId"], "name": row["name"] })
}

/// `GET /`: one mailbox's labels, or those of every mailbox in reach
/// (`search`: a case-insensitive match on the name).
pub(super) async fn list(mail: MailCaller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_LABELS, raw.as_deref())?;
    let account = q.text("accountId");
    if let Some(account) = account
        && !can_open_account(mail.db(), account, &mail.principal).await?
    {
        return Err(not_found("MailAccount", account).into());
    }
    let accessible = match account {
        Some(_) => None,
        None => Some(principal_account_ids(mail.db(), &mail.principal).await?),
    };
    let rows = list_mail_labels(mail.db(), account, accessible.as_deref()).await?;
    let term = q
        .get("search")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let rows: Vec<Value> = match term {
        Some(term) => rows
            .into_iter()
            .filter(|row| {
                row["name"]
                    .as_str()
                    .is_some_and(|name| name.to_lowercase().contains(&term))
            })
            .collect(),
        None => rows,
    };
    let total = i64::try_from(rows.len()).unwrap_or(i64::MAX);
    Ok(axum::response::IntoResponse::into_response(
        Page {
            rows,
            total,
            has_more: false,
            cursor: Value::Null,
        }
        .respond(),
    ))
}

/// `GET /:id`.
pub(super) async fn detail(mail: MailCaller, Path(id): Path<String>) -> Answer {
    ok(reachable_or_404(&mail, &id).await?)
}

/// `POST /`.
pub(super) async fn create(
    State(state): S,
    mail: MailCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_LABEL, &headers, &body)?;
    let account = parsed.text("accountId").unwrap_or_default().to_owned();
    if !can_open_account(mail.db(), &account, &mail.principal).await? {
        return Err(not_found("MailAccount", &account).into());
    }
    let input = CreateMailLabel {
        account_id: account,
        name: opt_text(&parsed, "name").unwrap_or_default(),
        color: opt_text(&parsed, "color"),
        ai_enabled: parsed.get("aiEnabled").and_then(Value::as_bool),
        ai_keywords: opt_strings(&parsed, "aiKeywords"),
        ai_description: opt_text(&parsed, "aiDescription"),
        ai_confidence: parsed.get("aiConfidence").and_then(Value::as_i64),
    };
    let row = create_mail_label(mail.db(), &input, OffsetDateTime::now_utc())
        .await
        .map_err(|error| label_error(error, None))?;
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    mail.caller
        .publish(&state.events, MAIL_LABEL_CREATED, &id, event(&row, &id));
    created(row)
}

/// `PATCH /:id`.
pub(super) async fn update(
    State(state): S,
    mail: MailCaller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&UPDATE_LABEL, &headers, &body)?;
    reachable_or_404(&mail, &id).await?;
    let input = UpdateMailLabel {
        name: opt_text(&parsed, "name"),
        color: opt_text(&parsed, "color"),
        position: parsed.get("position").and_then(Value::as_i64),
        ai_enabled: parsed.get("aiEnabled").and_then(Value::as_bool),
        ai_keywords: opt_strings(&parsed, "aiKeywords"),
        ai_description: opt_text(&parsed, "aiDescription"),
        ai_confidence: parsed.get("aiConfidence").and_then(Value::as_i64),
    };
    let (_, after) = update_mail_label(mail.db(), &id, &input, OffsetDateTime::now_utc())
        .await
        .map_err(|error| label_error(error, Some(&id)))?;
    mail.caller
        .publish(&state.events, MAIL_LABEL_UPDATED, &id, event(&after, &id));
    ok(after)
}

/// `DELETE /:id`: the label goes from every message too.
pub(super) async fn remove(State(state): S, mail: MailCaller, Path(id): Path<String>) -> Answer {
    reachable_or_404(&mail, &id).await?;
    let deleted = delete_mail_label(mail.db(), &id, OffsetDateTime::now_utc())
        .await
        .map_err(|error| label_error(error, Some(&id)))?;
    let Some(deleted) = deleted else {
        return Err(not_found("MailLabel", &id).into());
    };
    mail.caller
        .publish(&state.events, MAIL_LABEL_DELETED, &id, event(&deleted, &id));
    no_content()
}
