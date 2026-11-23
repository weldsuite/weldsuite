//! Mail drafts (`@weldsuite/mail-domain/drafts`): unsent messages on one
//! mailbox, held in `mail_drafts` until someone sends them. On Kubernetes
//! drafts live only in Postgres (MAIL-010), so these are the store's
//! `listDrafts` / `draft.*` ops too.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::{NotSet, Set},
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::mail_drafts;

fn js(model: mail_drafts::Model) -> Value {
    serde_json::to_value(model).unwrap_or(Value::Null)
}

/// One page of [`list_drafts`].
#[derive(Debug, Clone, Default)]
pub struct DraftPage {
    pub data: Vec<Value>,
    pub has_more: bool,
    pub cursor: Option<String>,
    pub total_count: i64,
}

/// `listDrafts(db, filters)`: the newest edits first, cursor-paginated by
/// id. `accessible` restricts the list to those mailboxes (an empty list is
/// none).
pub async fn list_drafts(
    db: &PgPool,
    account_id: Option<&str>,
    accessible: Option<&[String]>,
    limit: Option<i64>,
    cursor: Option<&str>,
) -> Result<DraftPage, DbErr> {
    use mail_drafts::Column;
    let limit = limit.unwrap_or(50).min(100);
    let mut conditions = Condition::all().add(Column::DeletedAt.is_null());
    if let Some(account) = account_id.filter(|a| !a.is_empty()) {
        conditions = conditions.add(Column::AccountId.eq(account));
    }
    if let Some(accessible) = accessible {
        conditions = if accessible.is_empty() {
            conditions.add(Expr::cust("false"))
        } else {
            conditions.add(Column::AccountId.is_in(accessible.iter().map(String::as_str)))
        };
    }
    let conn = orm(db);
    let mut page_conditions = conditions.clone();
    if let Some(cursor) = cursor.filter(|c| !c.is_empty()) {
        let found: Option<(time::PrimitiveDateTime, String)> = mail_drafts::Entity::find()
            .select_only()
            .column(Column::UpdatedAt)
            .column(Column::Id)
            .filter(Column::Id.eq(cursor))
            .into_tuple()
            .one(&conn)
            .await?;
        if let Some((updated_at, id)) = found {
            page_conditions = page_conditions.add(
                Condition::any().add(Column::UpdatedAt.lt(updated_at)).add(
                    Condition::all()
                        .add(Column::UpdatedAt.eq(updated_at))
                        .add(Column::Id.lt(id)),
                ),
            );
        }
    }
    let mut rows = mail_drafts::Entity::find()
        .filter(page_conditions)
        .order_by_desc(Column::UpdatedAt)
        .order_by_desc(Column::Id)
        .limit(u64::try_from(limit.max(0) + 1).unwrap_or(1))
        .all(&conn)
        .await?;
    let total = mail_drafts::Entity::find()
        .filter(conditions)
        .count(&conn)
        .await?;
    let limit = usize::try_from(limit.max(0)).unwrap_or(0);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let cursor = if has_more {
        rows.last().map(|row| row.id.clone())
    } else {
        None
    };
    Ok(DraftPage {
        data: rows.into_iter().map(js).collect(),
        has_more,
        cursor,
        total_count: i64::try_from(total).unwrap_or(i64::MAX),
    })
}

/// A live draft's row.
pub async fn draft_row(db: &PgPool, id: &str) -> Result<Option<mail_drafts::Model>, DbErr> {
    mail_drafts::Entity::find()
        .filter(mail_drafts::Column::Id.eq(id))
        .filter(mail_drafts::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await
}

/// `getDraft(db, id)`: a live draft.
pub async fn get_draft(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    Ok(draft_row(db, id).await?.map(js))
}

/// The account of a draft, deleted or not: a retried send of a draft the
/// first send deleted still finds its mailbox.
pub async fn draft_account(db: &PgPool, id: &str) -> Result<Option<String>, DbErr> {
    mail_drafts::Entity::find()
        .select_only()
        .column(mail_drafts::Column::AccountId)
        .filter(mail_drafts::Column::Id.eq(id))
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `DraftInput` (all optional for an update; `None` is left out).
#[derive(Debug, Clone, Default)]
pub struct DraftInput {
    pub account_id: Option<String>,
    pub subject: Option<String>,
    pub to: Option<Vec<String>>,
    pub cc: Option<Vec<String>>,
    pub bcc: Option<Vec<String>>,
    pub reply_to: Option<Vec<String>>,
    pub body: Option<String>,
    pub html_body: Option<String>,
    pub importance: Option<String>,
    pub labels: Option<Vec<String>>,
    pub attachment_ids: Option<Vec<String>>,
    pub in_reply_to: Option<String>,
    pub original_message_id: Option<String>,
    pub is_reply: Option<bool>,
    pub is_forward: Option<bool>,
}

/// `Set` for a field the input carries, `NotSet` (the column's default, or
/// left as it is) otherwise.
fn set<T: Into<sea_orm::Value>>(value: Option<T>) -> sea_orm::ActiveValue<Option<T>>
where
    Option<T>: Into<sea_orm::Value>,
{
    value.map_or(NotSet, |value| Set(Some(value)))
}

fn list(value: Option<&Vec<String>>) -> Option<Value> {
    value.map(|items| json!(items))
}

/// `createDraft(db, data)`: `hasAttachments` and `attachmentCount` follow
/// `attachmentIds`.
pub async fn create_draft(
    db: &PgPool,
    account_id: &str,
    data: &DraftInput,
) -> Result<Value, DbErr> {
    let id = generate_id("draft");
    let now = utc_now();
    let attachments = data.attachment_ids.as_ref().map_or(0, Vec::len);
    let conn = orm(db);
    mail_drafts::Entity::insert(mail_drafts::ActiveModel {
        id: Set(id.clone()),
        account_id: Set(account_id.to_owned()),
        subject: set(data.subject.clone()),
        to: set(list(data.to.as_ref())),
        cc: set(list(data.cc.as_ref())),
        bcc: set(list(data.bcc.as_ref())),
        reply_to: set(list(data.reply_to.as_ref())),
        body: set(data.body.clone()),
        html_body: set(data.html_body.clone()),
        importance: set(data.importance.clone()),
        labels: set(list(data.labels.as_ref())),
        has_attachments: Set(Some(attachments > 0)),
        attachment_count: Set(Some(i32::try_from(attachments).unwrap_or(i32::MAX))),
        attachment_ids: set(list(data.attachment_ids.as_ref())),
        in_reply_to: set(data.in_reply_to.clone()),
        original_message_id: set(data.original_message_id.clone()),
        is_reply: set(data.is_reply),
        is_forward: set(data.is_forward),
        last_auto_saved_at: Set(Some(now)),
        created_at: Set(now),
        updated_at: Set(now),
        deleted_at: NotSet,
    })
    .exec_without_returning(&conn)
    .await?;
    mail_drafts::Entity::find_by_id(id)
        .one(&conn)
        .await?
        .map(js)
        .ok_or_else(|| DbErr::RecordNotFound("the draft just created".to_owned()))
}

/// `updateDraft(db, id, data)`: the draft after the update, `None` when
/// there was no live draft.
pub async fn update_draft(
    db: &PgPool,
    id: &str,
    data: &DraftInput,
) -> Result<Option<Value>, DbErr> {
    use mail_drafts::Column;
    if draft_row(db, id).await?.is_none() {
        return Ok(None);
    }
    let now = utc_now();
    let mut update = mail_drafts::Entity::update_many()
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .col_expr(Column::LastAutoSavedAt, Expr::value(Some(now)))
        .filter(Column::Id.eq(id));
    let texts = [
        (Column::AccountId, &data.account_id),
        (Column::Subject, &data.subject),
        (Column::Body, &data.body),
        (Column::HtmlBody, &data.html_body),
        (Column::Importance, &data.importance),
        (Column::InReplyTo, &data.in_reply_to),
        (Column::OriginalMessageId, &data.original_message_id),
    ];
    for (column, value) in texts {
        if let Some(value) = value {
            update = update.col_expr(column, Expr::value(value.clone()));
        }
    }
    let lists = [
        (Column::To, &data.to),
        (Column::Cc, &data.cc),
        (Column::Bcc, &data.bcc),
        (Column::ReplyTo, &data.reply_to),
        (Column::Labels, &data.labels),
        (Column::AttachmentIds, &data.attachment_ids),
    ];
    for (column, value) in lists {
        if let Some(items) = value {
            update = update.col_expr(column, Expr::value(json!(items)));
        }
    }
    for (column, value) in [
        (Column::IsReply, data.is_reply),
        (Column::IsForward, data.is_forward),
    ] {
        if let Some(value) = value {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let Some(ids) = &data.attachment_ids {
        update = update
            .col_expr(Column::HasAttachments, Expr::value(!ids.is_empty()))
            .col_expr(
                Column::AttachmentCount,
                Expr::value(i32::try_from(ids.len()).unwrap_or(i32::MAX)),
            );
    }
    let conn = orm(db);
    update.exec(&conn).await?;
    Ok(mail_drafts::Entity::find_by_id(id.to_owned())
        .one(&conn)
        .await?
        .map(js))
}

/// `softDeleteDraft(db, id)`: `false` when there was no live draft.
pub async fn soft_delete_draft(db: &PgPool, id: &str) -> Result<bool, DbErr> {
    use mail_drafts::Column;
    if draft_row(db, id).await?.is_none() {
        return Ok(false);
    }
    let now = utc_now();
    mail_drafts::Entity::update_many()
        .col_expr(Column::DeletedAt, Expr::value(Some(now)))
        .col_expr(Column::UpdatedAt, Expr::value(now))
        .filter(Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(true)
}
