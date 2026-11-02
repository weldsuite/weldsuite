//! Tenant-database helpers for the guard (`outbound/correspondents.ts`): who
//! wrote to the workspace before (first contact or not), and who must not be
//! mailed again (suppressions).

use std::collections::HashSet;

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_kit::generate_id;

use super::clock::iso;

const CHUNK: usize = 100;

/// `findKnownCorrespondents(db, emails)`: the addresses (lower-cased) that
/// ever wrote to the workspace.
pub async fn find_known_correspondents(
    db: &PgPool,
    emails: &[String],
) -> Result<HashSet<String>, sqlx::Error> {
    let mut known = HashSet::new();
    for batch in emails.chunks(CHUNK) {
        let rows: Vec<String> = sqlx::query_scalar(
            "select email from mail_correspondents
             where email = any($1) and first_inbound_at is not null",
        )
        .bind(batch)
        .fetch_all(db)
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
) -> Result<(), sqlx::Error> {
    let at = iso(at_ms);
    for batch in emails.chunks(CHUNK) {
        sqlx::query(
            "insert into mail_correspondents
               (email, first_outbound_at, last_outbound_at, outbound_count, updated_at)
             select email, $2::timestamp, $2::timestamp, 1, $2::timestamp
             from unnest($1::varchar[]) as email
             on conflict (email) do update set
               first_outbound_at = coalesce(mail_correspondents.first_outbound_at, excluded.first_outbound_at),
               last_outbound_at = excluded.last_outbound_at,
               outbound_count = mail_correspondents.outbound_count + 1,
               updated_at = $2::timestamp",
        )
        .bind(batch)
        .bind(&at)
        .execute(db)
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
) -> Result<Vec<SuppressedRecipient>, sqlx::Error> {
    let mut found = Vec::new();
    for batch in emails.chunks(CHUNK) {
        let rows: Vec<(String, String)> =
            sqlx::query_as("select email, reason from mail_suppressions where email = any($1)")
                .bind(batch)
                .fetch_all(db)
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
) -> Result<(), sqlx::Error> {
    let email = crate::text::js_trim(email).to_lowercase();
    let rank: i32 = match reason {
        "complaint" => 3,
        "manual" => 2,
        _ => 1,
    };
    let now = iso(now_ms);
    sqlx::query(
        "insert into mail_suppressions
           (id, email, reason, sender_email, source, details, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7::timestamp, $7::timestamp)
         on conflict (email) do update set
           reason = case when $8 >= (case mail_suppressions.reason
                                       when 'complaint' then 3 when 'manual' then 2 else 1 end)
                         then excluded.reason else mail_suppressions.reason end,
           sender_email = coalesce(excluded.sender_email, mail_suppressions.sender_email),
           details = coalesce(excluded.details, mail_suppressions.details),
           updated_at = $7::timestamp",
    )
    .bind(generate_id("msup"))
    .bind(&email)
    .bind(reason)
    .bind(sender_email)
    .bind(source)
    .bind(details)
    .bind(&now)
    .bind(rank)
    .execute(db)
    .await?;
    Ok(())
}
