//! `/v1/mail-accounts` (`routes/v1/mail-accounts/index.ts`), read-only:
//! where a caller finds the mailboxes it can use. Creating, connecting and
//! configuring mailboxes stays in WeldMail. `canSendViaApi` says whether the
//! public API sends from the account (its address on a verified WeldMail
//! domain). Sending (`POST /:id/send`) is in [`super::sending`].

use axum::extract::{Path, RawQuery};
use axum::response::IntoResponse;
use serde_json::{Value, json};
use weldsuite_mail_domain::accounts::{
    PublicAccountFilters, get_public_mail_account, list_public_mail_accounts,
};

use super::MailCaller;
use super::schemas::LIST_ACCOUNTS;
use crate::crud::{Answer, ok};
use crate::list::Page;
use crate::session::not_found;
use crate::zod;

/// `GET /`.
pub(super) async fn list(mail: MailCaller, RawQuery(raw): RawQuery) -> Answer {
    let parsed = zod::query(&LIST_ACCOUNTS, raw.as_deref())?;
    #[allow(clippy::cast_possible_truncation)] // 1..=200
    let limit = parsed
        .get("limit")
        .and_then(Value::as_f64)
        .map(|n| n.floor() as i64);
    let filters = PublicAccountFilters {
        search: parsed.text("search").map(str::to_owned),
        status: parsed.text("status").map(str::to_owned),
        limit,
        cursor: parsed.text("cursor").map(str::to_owned),
    };
    let page = list_public_mail_accounts(mail.db(), &mail.principal, &filters).await?;
    Ok(Page {
        rows: page.data,
        total: page.total_count,
        has_more: page.has_more,
        cursor: page.cursor.map_or(Value::Null, |cursor| json!(cursor)),
    }
    .respond()
    .into_response())
}

/// `GET /:id`.
pub(super) async fn detail(mail: MailCaller, Path(id): Path<String>) -> Answer {
    match get_public_mail_account(mail.db(), &mail.principal, &id).await? {
        Some(account) => ok(account),
        None => Err(not_found("MailAccount", &id).into()),
    }
}
