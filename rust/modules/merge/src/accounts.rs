//! The member's own provider logins: `/api/merge/accounts/me`. "Needs your
//! review" and "yours" match on them.
//!
//! ```text
//!   GET /me → { github, accounts } (accounts: every linked account, never a token)
//!   PUT /me → set (or, empty, remove) the GitHub login; 409 when another member holds it,
//!             409 `account_verified` for a different login while an OAuth-verified link exists
//! ```
//!
//! Permission: `merge_pull_requests:read`. A member edits only their own
//! logins. There is no entity event: a login is not a catalogued entity.

use axum::body::Bytes;
use axum::response::IntoResponse;
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Presence, Text, js_trim};
use weldsuite_kit::{ApiError, Data, generate_id};

use crate::db::{is_unique_violation, opt_text, rows_of, text};
use crate::mappers::provider_account_dto;
use crate::oauth::claim_authored_pull_requests;
use crate::{Answer, Caller, Refusal, now, validate};

const TAKEN: &str = "This GitHub username is already linked to another member";
const VERIFIED: &str =
    "Your GitHub account is linked through GitHub; unlink it before typing a different username";

/// `listAccounts(db, userId)`: every account the member linked (typed logins
/// and OAuth links), without credentials; `github` is the typed GitHub login.
pub(crate) async fn list_accounts(db: &PgPool, user_id: &str) -> Result<Value, sqlx::Error> {
    let rows = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(a) from merge_provider_accounts a where a.user_id = $1 \
             order by a.provider asc, a.created_at asc",
        )
        .bind(user_id)
        .fetch_all(db)
        .await?,
    );
    let github = rows
        .iter()
        .find(|r| {
            text(r, "provider") == "github" && opt_text(r, "host").is_none_or(|h| h.is_empty())
        })
        .and_then(|r| opt_text(r, "login"));
    Ok(
        json!({ "github": github, "accounts": rows.iter().map(provider_account_dto).collect::<Vec<_>>() }),
    )
}

pub(crate) async fn read(caller: Caller) -> Answer {
    Ok(Data(list_accounts(&caller.db, &caller.user_id).await?).into_response())
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
        SetLogin::Saved => Ok(Data(list_accounts(db, &caller.user_id).await?).into_response()),
        SetLogin::Taken => Err(Refusal::conflict(TAKEN)),
        SetLogin::Verified => {
            Err(ApiError::new(StatusCode::CONFLICT, "account_verified", VERIFIED).into())
        }
    }
}

/// `SetLoginResult`.
enum SetLogin {
    Saved,
    /// `login_taken`: another member holds the login.
    Taken,
    /// `account_verified`: a different login while an OAuth-verified link exists.
    Verified,
}

/// `setGithubLogin(db, userId, raw)`: saves (or, with an empty login,
/// removes) the member's GitHub login, stored lower-case, and matches the
/// GitHub pull requests that login authored to the member. A login GitHub
/// vouched for (an OAuth link, `verified_at` set) is not overwritten by a
/// typed one: a different login is `Verified`, so the member unlinks first
/// and the link's token never outlives its login. Removing it (an empty
/// login) drops the link with it.
async fn set_github_login(
    db: &PgPool,
    user_id: &str,
    raw: Option<&str>,
) -> Result<SetLogin, sqlx::Error> {
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
            "update merge_pull_requests set author_user_id = null \
             where author_user_id = $1 and provider = 'github'",
        )
        .bind(user_id)
        .execute(db)
        .await?;
        return Ok(SetLogin::Saved);
    };
    let mine: Option<(String, String, bool)> = sqlx::query_as(
        "select id, login, verified_at is not null from merge_provider_accounts \
         where user_id = $1 and provider = 'github' limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?;
    if mine
        .as_ref()
        .is_some_and(|(_, current, verified)| *verified && *current != login)
    {
        return Ok(SetLogin::Verified);
    }
    let holder: Option<String> = sqlx::query_scalar(
        "select user_id from merge_provider_accounts where provider = 'github' and login = $1 limit 1",
    )
    .bind(&login)
    .fetch_optional(db)
    .await?;
    if holder.is_some_and(|holder| holder != user_id) {
        return Ok(SetLogin::Taken);
    }
    let now = now();
    let written = match mine {
        Some((id, _, _)) => {
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
        Err(error) if is_unique_violation(&error) => return Ok(SetLogin::Taken),
        Err(error) => return Err(error),
    }
    // GitHub pull requests the member no longer owns (an old login), then
    // the ones the new login authored.
    claim_authored_pull_requests(db, user_id, "github", &login).await?;
    Ok(SetLogin::Saved)
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
