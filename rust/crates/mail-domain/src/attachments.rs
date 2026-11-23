//! A message's files as the public API reads them: the store's
//! `listAttachments` and `locateAttachment` in `postgres` mode
//! (`listAttachmentsForMessage`, `PostgresWorkspaceMailStore.locateAttachment`)
//! and `publicAttachment`, the metadata a caller may see.

use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter, QuerySelect,
};
use serde_json::{Map, Value};
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::{mail_attachments, mail_messages};

/// What the public API reads of an attachment row.
#[derive(Debug, Clone, FromQueryResult, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRow {
    pub id: String,
    pub message_id: String,
    pub file_name: String,
    pub content_type: Option<String>,
    pub size: i32,
    pub is_inline: Option<bool>,
    pub content_id: Option<String>,
    #[serde(with = "weldsuite_schema::js::timestamp")]
    pub created_at: time::PrimitiveDateTime,
    #[serde(skip)]
    pub storage_path: Option<String>,
    /// The virus scan's verdict (`scan_status`, EU and self-hosted only),
    /// read through `to_jsonb`: Global's schema has no such column.
    #[serde(skip)]
    pub scan_status: Option<String>,
}

/// The keys `publicAttachment(row)` keeps, in its order.
const PUBLIC_KEYS: [&str; 8] = [
    "id",
    "messageId",
    "fileName",
    "contentType",
    "size",
    "isInline",
    "contentId",
    "createdAt",
];

impl AttachmentRow {
    /// `publicAttachment(row)`: its metadata. Never the storage path or a
    /// download URL.
    pub fn public(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// `publicAttachment(row)` of a row as `to_jsonb` read it (a message's
/// `attachments`).
pub fn public_attachment(row: &Value) -> Value {
    let mut out = Map::new();
    for key in PUBLIC_KEYS {
        out.insert(key.to_owned(), row.get(key).cloned().unwrap_or(Value::Null));
    }
    Value::Object(out)
}

fn select() -> sea_orm::Select<mail_attachments::Entity> {
    use mail_attachments::Column;
    mail_attachments::Entity::find()
        .select_only()
        .columns([
            Column::Id,
            Column::MessageId,
            Column::FileName,
            Column::ContentType,
            Column::Size,
            Column::IsInline,
            Column::ContentId,
            Column::CreatedAt,
            Column::StoragePath,
        ])
        .expr_as(
            Expr::cust("to_jsonb(\"mail_attachments\") ->> 'scan_status'"),
            "scan_status",
        )
}

/// `listAttachmentsForMessage(db, messageId)`: the message's live files, in
/// the database's order.
pub async fn list_for_message(db: &PgPool, message_id: &str) -> Result<Vec<AttachmentRow>, DbErr> {
    select()
        .filter(mail_attachments::Column::MessageId.eq(message_id))
        .filter(mail_attachments::Column::DeletedAt.is_null())
        .into_model()
        .all(&orm(db))
        .await
}

/// An attachment's live message's mailbox, through the join.
#[derive(Debug, FromQueryResult)]
struct Owner {
    account_id: String,
}

/// `locateAttachment(id, accountIds)`: the file and its mailbox, when it is
/// live, its message is live, and the message is in one of `account_ids`.
pub async fn locate_attachment(
    db: &PgPool,
    id: &str,
    account_ids: &[String],
) -> Result<Option<(String, AttachmentRow)>, DbErr> {
    if account_ids.is_empty() {
        return Ok(None);
    }
    let conn = orm(db);
    let owner: Option<Owner> = mail_attachments::Entity::find()
        .select_only()
        .column_as(mail_messages::Column::AccountId, "account_id")
        .join(
            JoinType::InnerJoin,
            mail_attachments::Entity::belongs_to(mail_messages::Entity)
                .from(mail_attachments::Column::MessageId)
                .to(mail_messages::Column::Id)
                .into(),
        )
        .filter(mail_attachments::Column::Id.eq(id))
        .filter(mail_attachments::Column::DeletedAt.is_null())
        .filter(mail_messages::Column::DeletedAt.is_null())
        .filter(mail_messages::Column::AccountId.is_in(account_ids.iter().map(String::as_str)))
        .into_model()
        .one(&conn)
        .await?;
    let Some(owner) = owner else { return Ok(None) };
    let row = select()
        .filter(mail_attachments::Column::Id.eq(id))
        .into_model()
        .one(&conn)
        .await?;
    Ok(row.map(|row| (owner.account_id, row)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn public_attachments_keep_the_metadata_only() {
        let row = json!({
            "id": "att_1", "messageId": "msg_1", "fileName": "a.pdf", "contentType": "application/pdf",
            "size": 3, "isInline": false, "contentId": null, "createdAt": "2026-01-01T00:00:00.000Z",
            "storagePath": "workspaces/org/a.pdf", "downloadUrl": "https://x", "deletedAt": null,
        });
        let public = public_attachment(&row);
        assert_eq!(public.as_object().map(Map::len), Some(8));
        assert!(public.get("storagePath").is_none());
        assert_eq!(public["fileName"], "a.pdf");
    }
}
