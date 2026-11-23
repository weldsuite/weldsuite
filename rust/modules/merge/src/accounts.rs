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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Field, Presence, Text, js_trim};
use weldsuite_kit::{ApiError, Data, generate_id};
use weldsuite_schema::tenant::{merge_provider_accounts, merge_pull_requests};

use crate::db::{is_unique_violation, json_rows, now_at, opt_text, text};
use crate::mappers::provider_account_dto;
use crate::oauth::claim_authored_pull_requests;
use crate::{Answer, Caller, Refusal, validate};

const TAKEN: &str = "This GitHub username is already linked to another member";
const VERIFIED: &str =
    "Your GitHub account is linked through GitHub; unlink it before typing a different username";

/// `listAccounts(db, userId)`: every account the member linked (typed logins
/// and OAuth links), without credentials; `github` is the typed GitHub login.
pub(crate) async fn list_accounts(db: &PgPool, user_id: &str) -> Result<Value, DbErr> {
    let rows = json_rows(
        merge_provider_accounts::Entity::find()
            .filter(merge_provider_accounts::Column::UserId.eq(user_id))
            .order_by_asc(merge_provider_accounts::Column::Provider)
            .order_by_asc(merge_provider_accounts::Column::CreatedAt)
            .all(&orm(db))
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )?;
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
) -> Result<SetLogin, DbErr> {
    let login = raw
        .map(|r| js_trim(r).to_lowercase())
        .filter(|l| !l.is_empty());
    let orm_db = orm(db);
    let Some(login) = login else {
        merge_provider_accounts::Entity::delete_many()
            .filter(merge_provider_accounts::Column::UserId.eq(user_id))
            .filter(merge_provider_accounts::Column::Provider.eq("github"))
            .exec(&orm_db)
            .await?;
        merge_pull_requests::Entity::update_many()
            .col_expr(
                merge_pull_requests::Column::AuthorUserId,
                Expr::value(Option::<String>::None),
            )
            .filter(merge_pull_requests::Column::AuthorUserId.eq(user_id))
            .filter(merge_pull_requests::Column::Provider.eq("github"))
            .exec(&orm_db)
            .await?;
        return Ok(SetLogin::Saved);
    };
    let mine = merge_provider_accounts::Entity::find()
        .select_only()
        .column(merge_provider_accounts::Column::Id)
        .column(merge_provider_accounts::Column::Login)
        .column(merge_provider_accounts::Column::VerifiedAt)
        .filter(merge_provider_accounts::Column::UserId.eq(user_id))
        .filter(merge_provider_accounts::Column::Provider.eq("github"))
        .into_tuple::<(String, String, Option<OffsetDateTime>)>()
        .one(&orm_db)
        .await?;
    if mine
        .as_ref()
        .is_some_and(|(_, current, verified)| verified.is_some() && *current != login)
    {
        return Ok(SetLogin::Verified);
    }
    let holder = merge_provider_accounts::Entity::find()
        .select_only()
        .column(merge_provider_accounts::Column::UserId)
        .filter(merge_provider_accounts::Column::Provider.eq("github"))
        .filter(merge_provider_accounts::Column::Login.eq(&login))
        .into_tuple::<String>()
        .one(&orm_db)
        .await?;
    if holder.is_some_and(|holder| holder != user_id) {
        return Ok(SetLogin::Taken);
    }
    let (_, at) = now_at();
    let written = match mine {
        Some((id, _, _)) => merge_provider_accounts::Entity::update_many()
            .col_expr(
                merge_provider_accounts::Column::Login,
                Expr::value(login.clone()),
            )
            .col_expr(merge_provider_accounts::Column::UpdatedAt, Expr::value(at))
            .filter(merge_provider_accounts::Column::Id.eq(id))
            .exec(&orm_db)
            .await
            .map(|_| ()),
        None => merge_provider_accounts::Entity::insert(merge_provider_accounts::ActiveModel {
            id: Set(generate_id("mpa")),
            user_id: Set(user_id.to_owned()),
            provider: Set("github".to_owned()),
            login: Set(login.clone()),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        })
        .exec_without_returning(&orm_db)
        .await
        .map(|_| ()),
    };
    match written {
        Ok(()) => {}
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
