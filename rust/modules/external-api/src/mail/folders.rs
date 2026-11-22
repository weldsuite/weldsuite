//! `/v1/mail-folders` (`routes/v1/mail-folders/index.ts`): a mailbox's
//! folder tree. System folders can be recoloured, repositioned or hidden,
//! but not renamed, moved or deleted: their identity is what provider sync
//! matches on. Custom folders are free.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    MAIL_FOLDER_CREATED, MAIL_FOLDER_DELETED, MAIL_FOLDER_UPDATED,
};
use weldsuite_mail_domain::access::{can_open_account, principal_account_ids};
use weldsuite_mail_domain::folders::{
    FolderPatch, MailFolderError, NewFolder, create_folder, get_folder, list_folders,
    soft_delete_folder, update_folder,
};

use super::schemas::{CREATE_FOLDER, LIST_FOLDERS, UPDATE_FOLDER};
use super::{MailCaller, opt_text};
use crate::ExternalApiState;
use crate::crud::{Answer, Fail, created, no_content, ok};
use crate::list::Page;
use crate::session::{bad_request, conflict, database_error, not_found};
use crate::zod;

type S = State<ExternalApiState>;

const PARENT_ELSEWHERE: &str = "parentId must be a folder of the same mail account";

/// The folder when it is in a mailbox the caller may open.
async fn reachable_or_404(mail: &MailCaller, id: &str) -> Result<Value, Fail> {
    if let Some(folder) = get_folder(mail.db(), id).await? {
        let account = folder["accountId"].as_str().unwrap_or_default();
        if can_open_account(mail.db(), account, &mail.principal).await? {
            return Ok(folder);
        }
    }
    Err(not_found("MailFolder", id).into())
}

/// `parentIsValid(c, parentId, accountId)`: a parent in the same mailbox.
async fn parent_is_valid(
    mail: &MailCaller,
    parent: Option<&str>,
    account: &str,
) -> Result<bool, Fail> {
    let Some(parent) = parent.filter(|p| !p.is_empty()) else {
        return Ok(true);
    };
    Ok(get_folder(mail.db(), parent)
        .await?
        .is_some_and(|row| row["accountId"].as_str() == Some(account)))
}

/// `folderErrorResponse(c, err, id)`.
fn folder_error(error: MailFolderError, id: &str) -> Fail {
    match error {
        MailFolderError::NotFound => not_found("MailFolder", id).into(),
        MailFolderError::SystemFolderImmutable(message) => conflict(message).into(),
        MailFolderError::Db(error) => database_error(&error).into(),
    }
}

/// The fields of a folder event.
fn event(row: &Value, id: &str) -> Value {
    json!({ "id": id, "accountId": row["accountId"], "name": row["name"], "type": row["type"] })
}

/// `GET /`.
pub(super) async fn list(mail: MailCaller, RawQuery(raw): RawQuery) -> Answer {
    let q = zod::query(&LIST_FOLDERS, raw.as_deref())?;
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
    let rows = list_folders(mail.db(), account, accessible.as_deref()).await?;
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

/// `POST /`: a custom folder.
pub(super) async fn create(
    State(state): S,
    mail: MailCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let parsed = zod::json(&CREATE_FOLDER, &headers, &body)?;
    let account = parsed.text("accountId").unwrap_or_default().to_owned();
    if !can_open_account(mail.db(), &account, &mail.principal).await? {
        return Err(not_found("MailAccount", &account).into());
    }
    let parent = opt_text(&parsed, "parentId");
    if !parent_is_valid(&mail, parent.as_deref(), &account).await? {
        return Err(bad_request(PARENT_ELSEWHERE).into());
    }
    let input = NewFolder {
        account_id: account,
        name: opt_text(&parsed, "name").unwrap_or_default(),
        parent_id: parent,
        path: opt_text(&parsed, "path"),
        color: opt_text(&parsed, "color"),
        icon: opt_text(&parsed, "icon"),
        position: parsed.get("position").and_then(Value::as_i64),
    };
    let row = create_folder(mail.db(), &input).await?;
    let id = row["id"].as_str().unwrap_or_default().to_owned();
    mail.caller
        .publish(&state.events, MAIL_FOLDER_CREATED, &id, event(&row, &id));
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
    let parsed = zod::json(&UPDATE_FOLDER, &headers, &body)?;
    let folder = reachable_or_404(&mail, &id).await?;
    let parent = opt_text(&parsed, "parentId");
    let account = folder["accountId"].as_str().unwrap_or_default();
    if !parent_is_valid(&mail, parent.as_deref(), account).await? {
        return Err(bad_request(PARENT_ELSEWHERE).into());
    }
    let patch = FolderPatch {
        name: opt_text(&parsed, "name"),
        parent_id: parent,
        path: opt_text(&parsed, "path"),
        color: opt_text(&parsed, "color"),
        icon: opt_text(&parsed, "icon"),
        position: parsed.get("position").and_then(Value::as_i64),
    };
    let after = update_folder(mail.db(), &id, &patch)
        .await
        .map_err(|error| folder_error(error, &id))?;
    mail.caller
        .publish(&state.events, MAIL_FOLDER_UPDATED, &id, event(&after, &id));
    ok(after)
}

/// `DELETE /:id`.
pub(super) async fn remove(State(state): S, mail: MailCaller, Path(id): Path<String>) -> Answer {
    reachable_or_404(&mail, &id).await?;
    let deleted = soft_delete_folder(mail.db(), &id)
        .await
        .map_err(|error| folder_error(error, &id))?;
    let Some(deleted) = deleted else {
        return Err(not_found("MailFolder", &id).into());
    };
    mail.caller.publish(
        &state.events,
        MAIL_FOLDER_DELETED,
        &id,
        event(&deleted, &id),
    );
    no_content()
}
