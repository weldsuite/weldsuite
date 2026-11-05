//! The member's own provider logins: `/api/merge/accounts/me`. "Needs your
//! review" and "yours" match on them.
//!
//! ```text
//!   GET /me → { github }
//!   PUT /me → set (or, empty, remove) the GitHub login; 409 when another member holds it
//! ```
//!
//! Permission: `merge_pull_requests:read`. A member edits only their own
//! logins. There is no entity event: a login is not a catalogued entity.

use axum::body::Bytes;
use axum::response::IntoResponse;
use http::HeaderMap;
use serde_json::json;
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Presence, Text, js_trim};
use weldsuite_kit::{Data, generate_id};

use crate::db::is_unique_violation;
use crate::pull_requests::member_github_login;
use crate::{Answer, Caller, Refusal, now, validate};

const TAKEN: &str = "This GitHub username is already linked to another member";

pub(crate) async fn read(caller: Caller) -> Answer {
    let login = member_github_login(&caller.db, &caller.user_id).await?;
    Ok(Data(json!({ "github": login })).into_response())
}

/// `/^$|^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/`.
fn is_github_login(text: &str) -> bool {
    text.is_empty()
        || (text.len() <= 39
            && text
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphanumeric())
            && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

pub(crate) async fn update(caller: Caller, headers: HeaderMap, body: Bytes) -> Answer {
    let github = validate(&headers, &body, |issues, fields| {
        issues.pattern_with(
            fields,
            "github",
            Presence::Nullish,
            Text {
                trim: true,
                max: Some(39),
                ..Text::default()
            },
            is_github_login,
            "Not a valid GitHub username",
        )
    })?;
    let db = &caller.db;
    if github.is_absent() {
        return read(caller).await;
    }
    let raw = match github {
        Field::Set(text) => Some(text),
        _ => None,
    };
    match set_github_login(db, &caller.user_id, raw.as_deref()).await? {
        Some(login) => Ok(Data(json!({ "github": login })).into_response()),
        None => Err(Refusal::conflict(TAKEN)),
    }
}

/// `setGithubLogin(db, userId, raw)`: saves (or, with an empty login,
/// removes) the member's GitHub login, stored lower-case, and matches the
/// pull requests that login authored to the member. `None`: another member
/// holds the login.
async fn set_github_login(
    db: &PgPool,
    user_id: &str,
    raw: Option<&str>,
) -> Result<Option<Option<String>>, sqlx::Error> {
    let login = raw
        .map(|r| js_trim(r).to_lowercase())
        .filter(|l| !l.is_empty());
    let Some(login) = login else {
        sqlx::query(
            "delete from merge_provider_accounts where user_id = $1 and provider = 'github'",
        )
        .bind(user_id)
        .execute(db)
        .await?;
        sqlx::query(
            "update merge_pull_requests set author_user_id = null where author_user_id = $1",
        )
        .bind(user_id)
        .execute(db)
        .await?;
        return Ok(Some(None));
    };
    let holder: Option<String> = sqlx::query_scalar(
        "select user_id from merge_provider_accounts where provider = 'github' and login = $1 limit 1",
    )
    .bind(&login)
    .fetch_optional(db)
    .await?;
    if holder.is_some_and(|holder| holder != user_id) {
        return Ok(None);
    }
    let now = now();
    let mine: Option<String> = sqlx::query_scalar(
        "select id from merge_provider_accounts where user_id = $1 and provider = 'github' limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    let written = match mine {
        Some(id) => {
            sqlx::query("update merge_provider_accounts set login = $2, updated_at = $3::timestamptz where id = $1")
                .bind(&id)
                .bind(&login)
                .bind(&now)
                .execute(db)
                .await
        }
        None => {
            sqlx::query(
                "insert into merge_provider_accounts (id, user_id, provider, login, created_at, updated_at) \
                 values ($1, $2, 'github', $3, $4::timestamptz, $4::timestamptz)",
            )
            .bind(generate_id("mpa"))
            .bind(user_id)
            .bind(&login)
            .bind(&now)
            .execute(db)
            .await
        }
    };
    match written {
        Ok(_) => {}
        Err(error) if is_unique_violation(&error) => return Ok(None),
        Err(error) => return Err(error),
    }
    // Pull requests the member no longer owns (an old login), then the ones
    // the new login authored.
    sqlx::query(
        "update merge_pull_requests set author_user_id = null \
         where author_user_id = $1 and author_login <> $2",
    )
    .bind(user_id)
    .bind(&login)
    .execute(db)
    .await?;
    sqlx::query(
        "update merge_pull_requests set author_user_id = $1 \
         where author_login = $2 and author_user_id is null",
    )
    .bind(user_id)
    .bind(&login)
    .execute(db)
    .await?;
    Ok(Some(Some(login)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_logins_are_letters_digits_and_hyphens() {
        assert!(is_github_login(""));
        assert!(is_github_login("alice-gh"));
        assert!(!is_github_login("-leading"));
        assert!(!is_github_login("has space"));
        assert!(!is_github_login("emoji🙂"));
        assert!(!is_github_login(&"a".repeat(40)));
    }
}
