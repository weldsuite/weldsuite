//! Tenant-database helpers for the guard (`outbound/correspondents.ts`): who
//! wrote to the workspace before (first contact or not), and who must not be
//! mailed again (suppressions).

use std::collections::HashSet;

use sea_orm::sea_query::{Alias, Expr, Func, OnConflict};
use sea_orm::{ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::Value;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{mail_correspondents, mail_suppressions};

use super::clock::timestamp;

const CHUNK: usize = 100;

/// `findKnownCorrespondents(db, emails)`: the addresses (lower-cased) that
/// ever wrote to the workspace.
pub async fn find_known_correspondents(
    db: &PgPool,
    emails: &[String],
) -> Result<HashSet<String>, DbErr> {
    let conn = orm(db);
    let mut known = HashSet::new();
    for batch in emails.chunks(CHUNK) {
        let rows: Vec<String> = mail_correspondents::Entity::find()
            .select_only()
            .column(mail_correspondents::Column::Email)
            .filter(mail_correspondents::Column::Email.is_in(batch))
            .filter(mail_correspondents::Column::FirstInboundAt.is_not_null())
            .into_tuple()
            .all(&conn)
            .await?;
        known.extend(rows);
    }
    Ok(known)
}

/// `recordOutboundCorrespondents(db, emails, at)`: the workspace wrote to
/// these addresses.
pub async fn record_outbound_correspondents(
    db: &PgPool,
    emails: &[String],
    at_ms: i64,
) -> Result<(), DbErr> {
    use mail_correspondents::Column;
    let at = timestamp(at_ms);
    let conn = orm(db);
    let current = |column: Column| Expr::col((mail_correspondents::Entity, column));
    for batch in emails.chunks(CHUNK) {
        let rows = batch.iter().map(|email| mail_correspondents::ActiveModel {
            email: Set(email.clone()),
            first_outbound_at: Set(Some(at)),
            last_outbound_at: Set(Some(at)),
            outbound_count: Set(1),
            updated_at: Set(at),
            ..Default::default()
        });
        // One statement per batch: the first contact kept, the count bumped.
        mail_correspondents::Entity::insert_many(rows)
            .on_conflict(
                OnConflict::column(Column::Email)
                    .value(
                        Column::FirstOutboundAt,
                        Func::coalesce([
                            current(Column::FirstOutboundAt),
                            Expr::col((Alias::new("excluded"), Column::FirstOutboundAt)),
                        ]),
                    )
                    .update_column(Column::LastOutboundAt)
                    .value(
                        Column::OutboundCount,
                        sea_orm::ExprTrait::add(current(Column::OutboundCount), 1),
                    )
                    .value(Column::UpdatedAt, Expr::val(at))
                    .to_owned(),
            )
            .exec_without_returning(&conn)
            .await?;
    }
    Ok(())
}

/// `SuppressedRecipient`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuppressedRecipient {
    pub email: String,
    /// `hard_bounce` | `complaint` | `manual`.
    pub reason: String,
}

/// `findSuppressed(db, emails)`.
pub async fn find_suppressed(
    db: &PgPool,
    emails: &[String],
) -> Result<Vec<SuppressedRecipient>, DbErr> {
    let conn = orm(db);
    let mut found = Vec::new();
    for batch in emails.chunks(CHUNK) {
        let rows: Vec<(String, String)> = mail_suppressions::Entity::find()
            .select_only()
            .columns([
                mail_suppressions::Column::Email,
                mail_suppressions::Column::Reason,
            ])
            .filter(mail_suppressions::Column::Email.is_in(batch))
            .into_tuple()
            .all(&conn)
            .await?;
        found.extend(
            rows.into_iter()
                .map(|(email, reason)| SuppressedRecipient { email, reason }),
        );
    }
    Ok(found)
}

/// `addSuppression(db, input)`: add or strengthen one; a complaint is never
/// downgraded to a bounce.
pub async fn add_suppression(
    db: &PgPool,
    email: &str,
    reason: &str,
    sender_email: Option<&str>,
    source: &str,
    details: Option<&Value>,
    now_ms: i64,
) -> Result<(), DbErr> {
    use mail_suppressions::Column;
    use sea_orm::ExprTrait as _;
    let email = crate::text::js_trim(email).to_lowercase();
    let rank: i32 = match reason {
        "complaint" => 3,
        "manual" => 2,
        _ => 1,
    };
    let now = timestamp(now_ms);
    let current = |column: Column| Expr::col((mail_suppressions::Entity, column));
    let excluded = |column: Column| Expr::col((Alias::new("excluded"), column));
    let current_rank = Expr::case(current(Column::Reason).eq("complaint"), 3)
        .case(current(Column::Reason).eq("manual"), 2)
        .finally(1);
    let row = mail_suppressions::ActiveModel {
        id: Set(generate_id("msup")),
        email: Set(email),
        reason: Set(reason.to_owned()),
        sender_email: Set(sender_email.map(str::to_owned)),
        source: Set(source.to_owned()),
        details: Set(details.cloned()),
        created_at: Set(now),
        updated_at: Set(now),
    };
    mail_suppressions::Entity::insert(row)
        .on_conflict(
            OnConflict::column(Column::Email)
                .value(
                    Column::Reason,
                    Expr::case(
                        Expr::val(rank).gte(current_rank),
                        excluded(Column::Reason),
                    )
                    .finally(current(Column::Reason)),
                )
                .value(
                    Column::SenderEmail,
                    Func::coalesce([excluded(Column::SenderEmail), current(Column::SenderEmail)]),
                )
                .value(
                    Column::Details,
                    Func::coalesce([excluded(Column::Details), current(Column::Details)]),
                )
                .value(Column::UpdatedAt, Expr::val(now))
                .to_owned(),
        )
        .exec_without_returning(&orm(db))
        .await?;
    Ok(())
}
