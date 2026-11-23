//! `/api/mail-accounts` (`routes/mail-accounts/index.ts`): the workspace's
//! mailboxes (list, detail, labels, create with the system labels and the
//! master registry entry, settings, access, sync, delete) and
//! `POST /:id/send`, which composes and sends a new email from the account
//! and keeps a SENT copy. `postgres` mode only (MAIL-010): the KV mailbox
//! directory is bumped after each change for the object modes' sake.

use std::sync::Arc;

use axum::Extension;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::HeaderMap;
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ActiveEnum, ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait,
    QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    EMAIL_EMAIL_SENT, MAIL_ACCOUNT_CREATED, MAIL_ACCOUNT_DELETED, MAIL_ACCOUNT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ACCOUNTS_CREATE, ACCOUNTS_DELETE, ACCOUNTS_READ, ACCOUNTS_UPDATE, MESSAGES_CREATE,
};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text, json_body};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::access::{
    AccountAccess, can_manage_account, check_account_access, check_account_manage_access,
    has_access_to_account, is_admin_or_owner,
};
use weldsuite_mail_domain::outbound::limits::{SHARED_WELDMAIL_APEXES, is_shared_weldmail_domain};
use weldsuite_mail_domain::send::{SendInput, SendOptions, send_and_persist};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::master::{mail_account_registry as registry, workspaces};
use weldsuite_schema::tenant::enums::{
    MailAccountStatus, MailAuthType, MailDomainDnsStatus, MailProvider, MailSyncStatus,
};
use weldsuite_schema::tenant::{
    domains, mail_accounts, mail_domains, mail_labels, workspace_members,
};

use crate::routes::mail_drafts::to_millis;
use crate::send::{
    EMAIL, RequestDoh, SendContext, attachments, emails, optional_text, send_error_response,
};
use crate::util::{
    MailError, MailResult, answer, bump_mailbox_directory, list_response, page, strings, validate,
    validate_query,
};
use crate::{Caller, MailState};

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([ACCOUNTS_READ]);
    let update = || gate.require([ACCOUNTS_UPDATE]);
    Router::new()
        .route("/mail-accounts", get(list).route_layer(read()))
        .route(
            "/mail-accounts",
            post(create).route_layer(gate.require([ACCOUNTS_CREATE])),
        )
        .route("/mail-accounts/stats", get(stats).route_layer(read()))
        .route(
            "/mail-accounts/setup/labels",
            get(setup_labels).route_layer(read()),
        )
        .route(
            "/mail-accounts/{id}/labels",
            get(labels).route_layer(read()),
        )
        .route("/mail-accounts/{id}", get(detail).route_layer(read()))
        .route(
            "/mail-accounts/{id}",
            patch(update_account)
                .put(update_account)
                .route_layer(update()),
        )
        .route(
            "/mail-accounts/{id}",
            axum::routing::delete(remove).route_layer(gate.require([ACCOUNTS_DELETE])),
        )
        .route(
            "/mail-accounts/{id}/sync",
            patch(trigger_sync).route_layer(update()),
        )
        .route(
            "/mail-accounts/{id}/assign-users",
            patch(assign_users).route_layer(update()),
        )
        .route(
            "/mail-accounts/{id}/send",
            post(send).route_layer(gate.require([MESSAGES_CREATE])),
        )
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// The columns safe to send to the browser (`publicAccountColumns`): every
/// column but the credentials and `provider_config`.
fn public_account(account: mail_accounts::Model) -> Result<Value, DbErr> {
    let mut row = serde_json::to_value(account).map_err(|error| DbErr::Json(error.to_string()))?;
    if let Value::Object(fields) = &mut row {
        for key in [
            "accessToken",
            "refreshToken",
            "apiKey",
            "passwordHash",
            "providerConfig",
        ] {
            fields.remove(key);
        }
    }
    Ok(row)
}

/// The mailboxes `user_id` may open (ADR MAIL-003): shared ones, those
/// assigned to them, and for an admin the ones assigned to nobody
/// (`coalesce(assigned_user_ids, '[]') in ('[]', 'null')`).
fn visible_to(user_id: &str, admin: bool) -> Condition {
    use sea_orm::ExprTrait as _;
    let assigned = || Expr::col(mail_accounts::Column::AssignedUserIds);
    let mut visible = Condition::any()
        .add(mail_accounts::Column::IsShared.eq(true))
        .add(sea_orm::sea_query::extension::postgres::PgExpr::contains(
            assigned(),
            Expr::value(json!([user_id])),
        ));
    if admin {
        visible = visible.add(
            Expr::from(Func::coalesce([assigned(), Expr::value(json!([]))]))
                .is_in([json!([]), Value::Null]),
        );
    }
    visible
}

/// The list's filters: the caller's mailboxes unless `scoped` is off,
/// `search` in the name or address (`like`), `status`, `provider`.
fn list_scope(
    caller: &Caller,
    scoped: bool,
    admin: bool,
    search: Option<&str>,
    status: Option<&str>,
    provider: Option<&str>,
) -> Result<Condition, DbErr> {
    let mut scope = Condition::all().add(mail_accounts::Column::DeletedAt.is_null());
    if scoped {
        scope = scope.add(visible_to(&caller.user_id, admin));
    }
    if let Some(search) = search {
        scope = scope.add(
            Condition::any()
                .add(mail_accounts::Column::Name.like(search))
                .add(mail_accounts::Column::Email.like(search)),
        );
    }
    // Any text: one that is no status (or provider) fails as the cast did.
    if let Some(status) = status {
        let status = MailAccountStatus::try_from_value(&status.to_owned())?;
        scope = scope.add(mail_accounts::Column::Status.eq(status));
    }
    if let Some(provider) = provider {
        let provider = MailProvider::try_from_value(&provider.to_owned())?;
        scope = scope.add(mail_accounts::Column::Provider.eq(provider));
    }
    Ok(scope)
}

/// `listMailAccounts`' page (`limit + 1` rows after the cursor) and total.
async fn list_page(
    caller: &Caller,
    scope: Condition,
    limit: i64,
    cursor: Option<&str>,
) -> Result<(Vec<Value>, i64), DbErr> {
    let db = orm(&caller.db);
    let cursor_row: Option<(PrimitiveDateTime, String)> = match cursor.filter(|c| !c.is_empty()) {
        Some(cursor) => {
            mail_accounts::Entity::find_by_id(cursor.to_owned())
                .select_only()
                .columns([mail_accounts::Column::CreatedAt, mail_accounts::Column::Id])
                .into_tuple()
                .one(&db)
                .await?
        }
        None => None,
    };
    let mut page_scope = scope.clone();
    if let Some((at, id)) = cursor_row {
        let at = to_millis(at);
        page_scope = page_scope.add(
            Condition::any()
                .add(mail_accounts::Column::CreatedAt.lt(at))
                .add(
                    Condition::all()
                        .add(mail_accounts::Column::CreatedAt.eq(at))
                        .add(mail_accounts::Column::Id.lt(id)),
                ),
        );
    }
    let rows = mail_accounts::Entity::find()
        .filter(page_scope)
        .order_by_desc(mail_accounts::Column::CreatedAt)
        .order_by_desc(mail_accounts::Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&db)
        .await?;
    let total = mail_accounts::Entity::find()
        .filter(scope)
        .count(&db)
        .await?;
    let rows = rows
        .into_iter()
        .map(public_account)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((rows, i64::try_from(total).unwrap_or(i64::MAX)))
}

/// The live mailbox `id`, if there is one.
async fn live_account_id(caller: &Caller, id: &str) -> Result<Option<String>, DbErr> {
    mail_accounts::Entity::find_by_id(id.to_owned())
        .select_only()
        .column(mail_accounts::Column::Id)
        .filter(mail_accounts::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await
}

/// `GET /` (`listMailAccounts`): the mailboxes the caller may open, or
/// every one for an admin's `scope=manage`.
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let filters = validate_query(raw.as_deref(), |issues, q| {
        let limit = issues.number(
            q,
            "limit",
            Presence::Optional,
            Number {
                coerce: true,
                min: Some(1.0),
                max: Some(100.0),
                ..Number::default()
            },
        );
        let cursor = issues.text(q, "cursor", Presence::Optional, None, None);
        let search = issues.text(q, "search", Presence::Optional, None, None);
        let status = issues.text(q, "status", Presence::Optional, None, None);
        let provider = issues.text(q, "provider", Presence::Optional, None, None);
        let scope = issues.choice(q, "scope", Presence::Optional, &["manage"]);
        (
            limit.into_option(),
            cursor.into_option(),
            search.into_option(),
            status.into_option(),
            provider.into_option(),
            scope.into_option(),
        )
    });
    let (limit, cursor, search, status, provider, scope) = match filters {
        Ok(filters) => filters,
        Err(error) => return error.respond(""),
    };
    let result = async {
        #[allow(clippy::cast_possible_truncation)]
        let limit = limit.unwrap_or(25.0).min(100.0).ceil() as i64;
        let admin = is_admin_or_owner(&caller.db, &caller.user_id).await?;
        let scoped = !(admin && scope.as_deref() == Some("manage"));
        let search = search.filter(|s| !s.is_empty()).map(|s| format!("%{s}%"));
        let status = status.filter(|s| !s.is_empty());
        let provider = provider.filter(|s| !s.is_empty());
        let scope = list_scope(
            &caller,
            scoped,
            admin,
            search.as_deref(),
            status.as_deref(),
            provider.as_deref(),
        )?;
        let (rows, total) = list_page(&caller, scope, limit, cursor.as_deref()).await?;
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, total, has_more, next))
    }
    .await;
    answer(result, "Failed to list mail accounts")
}

/// `GET /stats` (`getMailAccountStats`).
async fn stats(caller: Caller) -> Response {
    let result = async {
        // `count(*) filter (where status = …)`: COUNT skips the CASE's nulls.
        let with = |status: MailAccountStatus| {
            Expr::from(Func::count(Expr::case(
                mail_accounts::Column::Status.eq(status),
                1,
            )))
        };
        let counts: Option<(i64, i64, i64, i64)> = mail_accounts::Entity::find()
            .select_only()
            .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "total")
            .column_as(with(MailAccountStatus::Active), "active")
            .column_as(with(MailAccountStatus::Inactive), "inactive")
            .column_as(with(MailAccountStatus::Error), "error")
            .filter(mail_accounts::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&caller.db))
            .await?;
        let (total, active, inactive, error) = counts.unwrap_or_default();
        Ok(Data(json!({
            "total": total,
            "active": active,
            "inactive": inactive,
            "error": error,
        }))
        .into_response())
    }
    .await;
    answer(result, "Failed to fetch mail account stats")
}

/// `GET /setup/labels`: the system-label catalogue of the setup wizard.
async fn setup_labels() -> Response {
    let labels: Vec<Value> = [
        ("INBOX", "Inbox"),
        ("SENT", "Sent"),
        ("DRAFTS", "Drafts"),
        ("TRASH", "Trash"),
        ("SPAM", "Spam"),
        ("STARRED", "Starred"),
        ("IMPORTANT", "Important"),
        ("ARCHIVE", "Archive"),
        ("PROMOTIONS", "Promotions"),
    ]
    .into_iter()
    .map(|(id, name)| json!({ "id": id, "name": name, "type": "system" }))
    .collect();
    Data(labels).into_response()
}

/// `GET /:id/labels` (`getMailAccountLabels`): every label row of a mailbox
/// the caller may open.
async fn labels(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        if !check_account_access(&caller.db, &id, &caller.user_id).await? {
            return Err(MailError::not_found("Mail account", Some(&id)));
        }
        if live_account_id(&caller, &id).await?.is_none() {
            return Err(MailError::not_found("Mail account", Some(&id)));
        }
        let rows = mail_labels::Entity::find()
            .filter(mail_labels::Column::AccountId.eq(&id))
            .all(&orm(&caller.db))
            .await?;
        let rows = rows
            .into_iter()
            .map(|row| serde_json::to_value(row).map_err(|error| DbErr::Json(error.to_string())))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Data(rows).into_response())
    }
    .await;
    answer(result, "Failed to fetch mail account labels")
}

/// `GET /:id` (`getMailAccount`).
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let row = mail_accounts::Entity::find_by_id(id.clone())
            .filter(mail_accounts::Column::DeletedAt.is_null())
            .one(&orm(&caller.db))
            .await?
            .map(public_account)
            .transpose()?;
        let Some(row) = row else {
            return Err(MailError::not_found("Mail account", Some(&id)));
        };
        let admin = is_admin_or_owner(&caller.db, &caller.user_id).await?;
        if !has_access_to_account(&access_of(&row), &caller.user_id, admin) {
            return Err(MailError::not_found("Mail account", Some(&id)));
        }
        Ok(Data(row).into_response())
    }
    .await;
    answer(result, "Failed to fetch mail account")
}

/// The access fields of an account row.
fn access_of(row: &Value) -> AccountAccess {
    AccountAccess {
        is_shared: row["isShared"].as_bool().unwrap_or(false),
        assigned_user_ids: strings(&row["assignedUserIds"]),
    }
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

const PROVIDERS: [&str; 11] = [
    "gmail",
    "outlook",
    "office365",
    "exchange",
    "imap",
    "yahoo",
    "mailcow",
    "resend",
    "smtp",
    "cloudflare",
    "custom",
];

/// `MAILBOX_DAILY_SEND_LIMIT_MAX`.
const DAILY_SEND_LIMIT_MAX: f64 = 2_000.0;

/// `createBody` / `updateBody` (`createBody.partial()`): every field as
/// given, in the schema's order, defaults not applied.
#[derive(Debug, Default)]
struct AccountInput {
    fields: Map<String, Value>,
}

impl AccountInput {
    fn text(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(Value::as_str)
    }

    fn flag(&self, key: &str) -> Option<bool> {
        self.fields.get(key).and_then(Value::as_bool)
    }

    fn int(&self, key: &str) -> Option<i64> {
        self.fields.get(key).and_then(Value::as_i64)
    }

    fn json(&self, key: &str) -> Option<Value> {
        self.fields.get(key).cloned()
    }
}

/// Read `createBody` (`partial` = false, `name` and `email` required) or
/// `updateBody`.
#[allow(clippy::too_many_lines)] // one reader per schema field, in order
fn read_account(issues: &mut Issues, body: &Map<String, Value>, partial: bool) -> AccountInput {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    let mut put = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    };
    put(
        "name",
        issues
            .text(body, "name", required, Some(1), Some(255))
            .into_option()
            .map(Value::String),
    );
    put(
        "email",
        issues
            .text_with(
                body,
                "email",
                required,
                Text {
                    format: Some(Format::Email),
                    max: Some(255),
                    ..Text::default()
                },
            )
            .into_option()
            .map(Value::String),
    );
    put(
        "displayName",
        issues
            .text(body, "displayName", Presence::Optional, None, Some(255))
            .into_option()
            .map(Value::String),
    );
    put(
        "provider",
        issues
            .choice(body, "provider", Presence::Optional, &PROVIDERS)
            .into_option()
            .map(Value::String),
    );
    put(
        "authType",
        issues
            .choice(
                body,
                "authType",
                Presence::Optional,
                &["oauth2", "password", "api_key"],
            )
            .into_option()
            .map(Value::String),
    );
    let int = |issues: &mut Issues, key: &str, min: Option<f64>, max: Option<f64>| {
        issues
            .whole_number(
                body,
                key,
                Presence::Optional,
                Number {
                    int: true,
                    min,
                    max,
                    ..Number::default()
                },
            )
            .into_option()
            .map(Value::from)
    };
    let flag = |issues: &mut Issues, key: &str| {
        issues
            .boolean(body, key, Presence::Optional)
            .into_option()
            .map(Value::Bool)
    };
    let text = |issues: &mut Issues, key: &str, max: Option<usize>| {
        issues
            .text(body, key, Presence::Optional, None, max)
            .into_option()
            .map(Value::String)
    };
    put("imapHost", text(issues, "imapHost", Some(255)));
    put("imapPort", int(issues, "imapPort", None, None));
    put("imapSecure", flag(issues, "imapSecure"));
    put("smtpHost", text(issues, "smtpHost", Some(255)));
    put("smtpPort", int(issues, "smtpPort", None, None));
    put("smtpSecure", flag(issues, "smtpSecure"));
    put("syncEnabled", flag(issues, "syncEnabled"));
    put("syncFrequency", int(issues, "syncFrequency", None, None));
    put("signature", text(issues, "signature", None));
    put(
        "dailySendLimit",
        int(
            issues,
            "dailySendLimit",
            Some(1.0),
            Some(DAILY_SEND_LIMIT_MAX),
        ),
    );
    put("isDefault", flag(issues, "isDefault"));
    put("isShared", flag(issues, "isShared"));
    put(
        "assignedUserIds",
        issues
            .list(
                body,
                "assignedUserIds",
                Presence::Optional,
                None,
                None,
                |issues, item| issues.item_text(item, Text::default()),
            )
            .into_option()
            .map(|ids| json!(ids)),
    );
    let ai = issues.nested(body, "aiSettings", Presence::Optional, |issues, ai| {
        let mut settings = Map::new();
        if let Some(v) = issues
            .text(
                ai,
                "customInstructions",
                Presence::Optional,
                None,
                Some(2000),
            )
            .into_option()
        {
            settings.insert("customInstructions".into(), Value::String(v));
        }
        if let Some(v) = issues
            .choice(
                ai,
                "defaultTone",
                Presence::Optional,
                &["professional", "friendly", "casual"],
            )
            .into_option()
        {
            settings.insert("defaultTone".into(), Value::String(v));
        }
        if let Some(v) = issues
            .choice(
                ai,
                "defaultLength",
                Presence::Optional,
                &["short", "medium", "long"],
            )
            .into_option()
        {
            settings.insert("defaultLength".into(), Value::String(v));
        }
        if let Some(v) = issues
            .text(ai, "modelPreference", Presence::Optional, None, Some(100))
            .into_option()
        {
            settings.insert("modelPreference".into(), Value::String(v));
        }
        Value::Object(settings)
    });
    put("aiSettings", ai.into_option());
    AccountInput { fields: out }
}

/// The system labels a new mailbox starts with (`SYSTEM_LABEL_SEEDS`).
const SYSTEM_LABEL_SEEDS: [(&str, &str); 11] = [
    ("Inbox", "INBOX"),
    ("Sent", "SENT"),
    ("Drafts", "DRAFTS"),
    ("Trash", "TRASH"),
    ("Spam", "SPAM"),
    ("Starred", "STARRED"),
    ("Important", "IMPORTANT"),
    ("Archive", "ARCHIVE"),
    ("Snoozed", "SNOOZED"),
    ("Scheduled", "SCHEDULED"),
    ("Promotions", "PROMOTIONS"),
];

/// A new mailbox's system labels ([`SYSTEM_LABEL_SEEDS`]), in their order.
pub(crate) async fn seed_system_labels(
    db: &PgPool,
    account_id: &str,
    at: PrimitiveDateTime,
) -> Result<(), DbErr> {
    let labels = SYSTEM_LABEL_SEEDS
        .iter()
        .map(|(name, slug)| mail_labels::ActiveModel {
            id: Set(generate_id("label")),
            account_id: Set(account_id.to_owned()),
            name: Set((*name).to_owned()),
            slug: Set(Some((*slug).to_owned())),
            is_system: Set(Some(true)),
            message_count: Set(0),
            created_at: Set(at),
            updated_at: Set(at),
            ..Default::default()
        });
    // One statement, the rows in their order.
    mail_labels::Entity::insert_many(labels)
        .exec_without_returning(&orm(db))
        .await?;
    Ok(())
}

/// `MailAccountError` with its HTTP mapping (`mapMailAccountError`).
fn bad_request(message: &str) -> MailError {
    MailError::bad_request(message)
}

/// `assertWeldmailDomainAllowed`: no account straight on a WeldMail apex,
/// and a WeldMail subdomain only the workspace's own.
async fn assert_weldmail_domain_allowed(
    state: &MailState,
    caller: &Caller,
    org: &str,
    domain: &str,
) -> MailResult<()> {
    let bare = SHARED_WELDMAIL_APEXES.contains(&domain)
        || domain == "test.weldmail.com"
        || domain == "preview.weldmail.com";
    if bare {
        return Err(bad_request(
            "Cannot create accounts directly on WeldMail domains. Use the WeldMail address flow instead.",
        ));
    }
    if !is_shared_weldmail_domain(domain) {
        return Ok(());
    }
    let Some(master) = caller.bindings.master(state) else {
        tracing::error!("[mail-accounts] no master database for the WeldMail domain check");
        return Err(MailError::api(
            ApiError::internal().with_message("Failed to create mail account"),
        ));
    };
    let slug: Option<String> = workspace_of(&master, org, workspaces::Column::Slug).await?;
    let apex = caller
        .bindings
        .env_value(state, "WELDMAIL_DOMAIN")
        .filter(|apex| !apex.is_empty())
        .unwrap_or("weldmail.com");
    let allowed = slug.map(|slug| format!("{slug}.{apex}"));
    if allowed.as_deref() != Some(domain) {
        return Err(MailError::forbidden(
            "You can only create WeldMail accounts on your own workspace domain. Use the WeldMail address flow instead.",
        ));
    }
    Ok(())
}

/// A column of the master workspace `org` names (its id or Clerk org id).
async fn workspace_of(
    master: &PgPool,
    org: &str,
    column: workspaces::Column,
) -> Result<Option<String>, DbErr> {
    workspaces::Entity::find()
        .select_only()
        .column(column)
        .filter(
            Condition::any()
                .add(workspaces::Column::Id.eq(org))
                .add(workspaces::Column::ClerkOrgId.eq(org)),
        )
        .into_tuple()
        .one(&orm(master))
        .await
}

/// `ensureManagedDomain`: the domain must be a WeldMail mail domain already,
/// or a WeldHost domain (then it is recorded as one). On Kubernetes there is
/// no Cloudflare Email Routing to re-assert (MAIL-010). With a `MailDomains`
/// adapter (the deployment offers custom domains) the domain must be a
/// verified mail domain or an active WeldHost domain, which is registered
/// with the adapter (`mail_domains::ensure_provisioned`); without one, as in
/// the conformance builds, the worker's checks apply as they are.
async fn ensure_managed_domain(
    state: &MailState,
    caller: &Caller,
    domain: &str,
    at: OffsetDateTime,
) -> MailResult<()> {
    if let Some(adapter) = &state.domains {
        return super::mail_domains::ensure_provisioned(
            state,
            caller,
            adapter.as_ref(),
            domain,
            at,
        )
        .await;
    }
    let managed: Option<String> = mail_domains::Entity::find()
        .select_only()
        .column(mail_domains::Column::Id)
        .filter(mail_domains::Column::DomainName.eq(domain))
        .filter(mail_domains::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    if managed.is_some() {
        return Ok(());
    }
    let host: Option<String> = domains::Entity::find()
        .select_only()
        .column(domains::Column::Id)
        .filter(domains::Column::FullDomain.eq(domain))
        .filter(domains::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(&caller.db))
        .await?;
    if host.is_none() {
        return Err(bad_request(&format!(
            "Add {domain} in WeldHost › Domains before creating an email account on it."
        )));
    }
    let at = utc_timestamp(at);
    let cloudflare = || Set(Some("cloudflare".to_owned()));
    mail_domains::Entity::insert(mail_domains::ActiveModel {
        id: Set(generate_id("mdom")),
        domain_name: Set(domain.to_owned()),
        is_active: Set(true),
        is_primary: Set(Some(false)),
        mail_provider: cloudflare(),
        send_provider: cloudflare(),
        receive_provider: cloudflare(),
        dns_status: Set(Some(MailDomainDnsStatus::Verified)),
        cloudflare_routing_enabled: Set(Some(true)),
        max_email_accounts: Set(Some(100)),
        current_email_accounts: Set(Some(0)),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
    .await?;
    Ok(())
}

/// `registerInMasterRegistry`: the address in the master
/// `mail_account_registry`, so inbound mail finds the workspace. Best
/// effort, as in TypeScript.
async fn register_in_master_registry(
    state: &MailState,
    caller: &Caller,
    org: &str,
    account_id: &str,
    email: &str,
) {
    let Some(master) = caller.bindings.master(state) else {
        tracing::error!(
            "[mail-accounts] master registry upsert failed for {email}: no master database"
        );
        return;
    };
    let run = async {
        let workspace = workspace_of(&master, org, workspaces::Column::Id).await?;
        let Some(workspace) = workspace else {
            tracing::warn!("[mail-accounts] no workspace for orgId {org}; skipping registry");
            return Ok::<(), DbErr>(());
        };
        super::mail_domains::upsert_registry(
            &master,
            email.to_owned(),
            &workspace,
            account_id,
            utc_now(),
        )
        .await
    };
    if let Err(error) = run.await {
        tracing::error!(%error, "[mail-accounts] master registry upsert failed for {email}");
    }
}

/// `POST /` (`createMailAccount`).
#[allow(clippy::too_many_lines)] // the TypeScript create flow, step by step
async fn create(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_account(issues, body, false)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.into_response(),
    };
    let result = async {
        let email = data.text("email").unwrap_or_default().to_owned();
        let name = data.text("name").unwrap_or_default().to_owned();
        let domain = email
            .split('@')
            .nth(1)
            .filter(|d| !d.is_empty())
            .map(str::to_lowercase);
        let Some(domain) = domain else {
            return Err(bad_request("Invalid email address"));
        };
        assert_weldmail_domain_allowed(&state, &caller, &org, &domain).await?;

        let existing: Option<String> = mail_accounts::Entity::find()
            .select_only()
            .column(mail_accounts::Column::Id)
            .filter(mail_accounts::Column::Email.eq(&email))
            .filter(mail_accounts::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&caller.db))
            .await?;
        if let Some(existing) = existing {
            return Err(MailError::conflict(format!(
                "An account for {email} already exists ({existing}). Delete it first or edit the existing account."
            )));
        }

        let id = generate_id("mail");
        let at = OffsetDateTime::now_utc();
        let is_shared = data.flag("isShared").unwrap_or(true);
        let chosen: Option<Vec<String>> = data.json("assignedUserIds").map(|v| strings(&v));
        let assigned = if is_shared || caller.user_id.is_empty() {
            chosen
        } else {
            let creator_is_admin = is_admin_or_owner(&caller.db, &caller.user_id).await?;
            let chosen = chosen.unwrap_or_default();
            if creator_is_admin && !chosen.is_empty() {
                Some(chosen)
            } else {
                let mut ids = chosen;
                if !ids.contains(&caller.user_id) {
                    ids.push(caller.user_id.clone());
                }
                Some(ids)
            }
        };

        ensure_managed_domain(&state, &caller, &domain, at).await?;

        if data.flag("isDefault") == Some(true) {
            clear_default(&caller).await?;
        }
        let provider = data.text("provider").unwrap_or("imap").to_owned();
        let at = utc_timestamp(at);
        insert_account(&caller, &data, &id, &name, &email, is_shared, assigned, at).await?;

        seed_system_labels(&caller.db, &id, at).await?;

        register_in_master_registry(&state, &caller, &org, &id, &email).await;
        bump_mailbox_directory(&caller, &state).await;
        caller.publish(
            &state,
            MAIL_ACCOUNT_CREATED,
            &id,
            &json!({ "id": id, "email": email, "provider": provider, "status": "active" }),
        );
        Ok(Created(json!({ "id": id, "name": name, "email": email })).into_response())
    }
    .await;
    answer(result, "Failed to create mail account")
}

/// `update(mailAccounts).set({ isDefault: false })` of every live mailbox.
async fn clear_default(caller: &Caller) -> Result<(), DbErr> {
    mail_accounts::Entity::update_many()
        .col_expr(mail_accounts::Column::IsDefault, Expr::value(false))
        .filter(mail_accounts::Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

/// An `integer` column's value: what Postgres refuses ("out of range")
/// stays the route's 500.
fn int_column(value: Option<i64>, column: &str) -> Result<Option<i32>, DbErr> {
    value
        .map(|value| {
            i32::try_from(value)
                .map_err(|_| DbErr::Custom(format!("{column}: integer out of range")))
        })
        .transpose()
}

/// `createMailAccount`'s insert: the body's fields with the schema's
/// defaults, `active`.
#[allow(clippy::too_many_arguments)] // the row's fields the route worked out
async fn insert_account(
    caller: &Caller,
    data: &AccountInput,
    id: &str,
    name: &str,
    email: &str,
    is_shared: bool,
    assigned: Option<Vec<String>>,
    at: PrimitiveDateTime,
) -> Result<(), DbErr> {
    let text = |key: &str| data.text(key).map(str::to_owned);
    mail_accounts::Entity::insert(mail_accounts::ActiveModel {
        id: Set(id.to_owned()),
        name: Set(name.to_owned()),
        email: Set(email.to_owned()),
        display_name: Set(text("displayName")),
        provider: Set(MailProvider::try_from_value(
            &data.text("provider").unwrap_or("imap").to_owned(),
        )?),
        auth_type: Set(MailAuthType::try_from_value(
            &data.text("authType").unwrap_or("password").to_owned(),
        )?),
        imap_host: Set(text("imapHost")),
        imap_port: Set(int_column(data.int("imapPort"), "imap_port")?),
        imap_secure: Set(Some(data.flag("imapSecure").unwrap_or(true))),
        smtp_host: Set(text("smtpHost")),
        smtp_port: Set(int_column(data.int("smtpPort"), "smtp_port")?),
        smtp_secure: Set(Some(data.flag("smtpSecure").unwrap_or(true))),
        sync_enabled: Set(data.flag("syncEnabled").unwrap_or(true)),
        sync_frequency: Set(int_column(
            Some(data.int("syncFrequency").unwrap_or(5)),
            "sync_frequency",
        )?),
        signature: Set(text("signature")),
        daily_send_limit: Set(int_column(
            Some(data.int("dailySendLimit").unwrap_or(500)),
            "daily_send_limit",
        )?),
        is_default: Set(Some(data.flag("isDefault").unwrap_or(false))),
        is_shared: Set(Some(is_shared)),
        assigned_user_ids: Set(assigned.map(|ids| json!(ids))),
        status: Set(MailAccountStatus::Active),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_without_returning(&orm(&caller.db))
    .await?;
    Ok(())
}

/// `updateMailAccount`'s write: the fields the body sent, and `updatedAt`,
/// on the live mailbox.
async fn write_update(caller: &Caller, id: &str, data: &AccountInput) -> Result<(), DbErr> {
    let mut update = mail_accounts::Entity::update_many()
        .col_expr(mail_accounts::Column::UpdatedAt, Expr::value(utc_now()));
    for (key, column) in [
        ("name", mail_accounts::Column::Name),
        ("email", mail_accounts::Column::Email),
        ("displayName", mail_accounts::Column::DisplayName),
        ("imapHost", mail_accounts::Column::ImapHost),
        ("smtpHost", mail_accounts::Column::SmtpHost),
        ("signature", mail_accounts::Column::Signature),
    ] {
        if let Some(value) = data.text(key) {
            update = update.col_expr(column, Expr::value(value.to_owned()));
        }
    }
    if let Some(provider) = data.text("provider") {
        let provider = MailProvider::try_from_value(&provider.to_owned())?;
        update = update.col_expr(
            mail_accounts::Column::Provider,
            mail_accounts::Column::Provider.save_as(Expr::value(provider)),
        );
    }
    if let Some(auth) = data.text("authType") {
        let auth = MailAuthType::try_from_value(&auth.to_owned())?;
        update = update.col_expr(
            mail_accounts::Column::AuthType,
            mail_accounts::Column::AuthType.save_as(Expr::value(auth)),
        );
    }
    for (key, column) in [
        ("imapPort", mail_accounts::Column::ImapPort),
        ("smtpPort", mail_accounts::Column::SmtpPort),
        ("syncFrequency", mail_accounts::Column::SyncFrequency),
        ("dailySendLimit", mail_accounts::Column::DailySendLimit),
    ] {
        if let Some(value) = data.int(key) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    for (key, column) in [
        ("imapSecure", mail_accounts::Column::ImapSecure),
        ("smtpSecure", mail_accounts::Column::SmtpSecure),
        ("syncEnabled", mail_accounts::Column::SyncEnabled),
        ("isDefault", mail_accounts::Column::IsDefault),
        ("isShared", mail_accounts::Column::IsShared),
    ] {
        if let Some(value) = data.flag(key) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    for (key, column) in [
        ("assignedUserIds", mail_accounts::Column::AssignedUserIds),
        ("aiSettings", mail_accounts::Column::AiSettings),
    ] {
        if let Some(value) = data.json(key) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    update
        .filter(mail_accounts::Column::Id.eq(id))
        .filter(mail_accounts::Column::DeletedAt.is_null())
        .exec(&orm(&caller.db))
        .await?;
    Ok(())
}

/// `PUT|PATCH /:id` (`updateMailAccount`): the given fields; the answer is
/// `{ id, ...data }`.
async fn update_account(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        read_account(issues, body, true)
    }) {
        Ok(data) => data,
        Err(error) => return error.respond(""),
    };
    match check_account_manage_access(&caller.db, &id, &caller.user_id).await {
        Ok(true) => {}
        Ok(false) => return ApiError::not_found("Mail account", Some(&id)).into_response(),
        Err(error) => return crate::util::unhandled(error.into()),
    }
    let result = async {
        if live_account_id(&caller, &id).await?.is_none() {
            return Err(MailError::not_found("Mail account", Some(&id)));
        }
        if data.flag("isDefault") == Some(true) {
            clear_default(&caller).await?;
        }
        write_update(&caller, &id, &data).await?;
        let (_, _, email, provider, status) = account_identity(&caller, &id, false)
            .await?
            .ok_or_else(|| DbErr::RecordNotFound(format!("mail account {id}")))?;
        bump_mailbox_directory(&caller, &state).await;
        caller.publish(
            &state,
            MAIL_ACCOUNT_UPDATED,
            &id,
            &json!({ "id": id, "email": email, "provider": provider, "status": status }),
        );
        let mut answer = Map::new();
        answer.insert("id".into(), Value::String(id.clone()));
        answer.extend(data.fields.clone());
        Ok(Data(Value::Object(answer)).into_response())
    }
    .await;
    answer(result, "Failed to update mail account")
}

/// `PATCH /:id/sync` (`triggerAccountSync`): marks the mailbox syncing.
async fn trigger_sync(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let row: Option<(Option<bool>, Option<Value>)> =
            mail_accounts::Entity::find_by_id(id.clone())
                .select_only()
                .columns([
                    mail_accounts::Column::IsShared,
                    mail_accounts::Column::AssignedUserIds,
                ])
                .filter(mail_accounts::Column::DeletedAt.is_null())
                .into_tuple()
                .one(&orm(&caller.db))
                .await?;
        let Some((is_shared, assigned)) = row else {
            return Err(MailError::not_found("Mail account", Some(&id)));
        };
        let account = AccountAccess {
            is_shared: is_shared.unwrap_or(false),
            assigned_user_ids: assigned.as_ref().map(strings).unwrap_or_default(),
        };
        let admin = is_admin_or_owner(&caller.db, &caller.user_id).await?;
        if !has_access_to_account(&account, &caller.user_id, admin) {
            return Err(MailError::not_found("Mail account", Some(&id)));
        }
        mail_accounts::Entity::update_many()
            .col_expr(
                mail_accounts::Column::SyncStatus,
                mail_accounts::Column::SyncStatus.save_as(Expr::value(MailSyncStatus::Syncing)),
            )
            .col_expr(mail_accounts::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(mail_accounts::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        bump_mailbox_directory(&caller, &state).await;
        Ok(Data(json!({ "id": id, "syncStatus": "syncing" })).into_response())
    }
    .await;
    answer(result, "Failed to trigger sync")
}

/// `PATCH /:id/assign-users` (`assignMailAccountUsers`): admins only.
async fn assign_users(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let is_shared = issues.boolean(body, "isShared", Presence::Required);
        let ids = issues.list(
            body,
            "assignedUserIds",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::default()),
        );
        (
            is_shared.into_option().unwrap_or(false),
            ids.into_option().unwrap_or_default(),
        )
    });
    let (is_shared, ids) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        if !is_admin_or_owner(&caller.db, &caller.user_id).await? {
            return Err(MailError::forbidden(
                "Only admins and owners can manage account access",
            ));
        }
        if live_account_id(&caller, &id).await?.is_none() {
            return Err(MailError::not_found("Mail account", None));
        }
        if !ids.is_empty() {
            let members: Vec<String> = workspace_members::Entity::find()
                .select_only()
                .column(workspace_members::Column::UserId)
                .filter(workspace_members::Column::DeletedAt.is_null())
                .into_tuple()
                .all(&orm(&caller.db))
                .await?;
            let invalid: Vec<&String> = ids.iter().filter(|u| !members.contains(u)).collect();
            if !invalid.is_empty() {
                let list: Vec<&str> = invalid.iter().map(|s| s.as_str()).collect();
                return Err(bad_request(&format!(
                    "Invalid user IDs: {}",
                    list.join(", ")
                )));
            }
        }
        let assigned = if is_shared { None } else { Some(json!(ids)) };
        mail_accounts::Entity::update_many()
            .col_expr(mail_accounts::Column::IsShared, Expr::value(is_shared))
            .col_expr(
                mail_accounts::Column::AssignedUserIds,
                Expr::value(assigned),
            )
            .col_expr(mail_accounts::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(mail_accounts::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        let (shared, assigned, email, provider, status) = account_identity(&caller, &id, false)
            .await?
            .ok_or_else(|| DbErr::RecordNotFound(format!("mail account {id}")))?;
        bump_mailbox_directory(&caller, &state).await;
        caller.publish(
            &state,
            MAIL_ACCOUNT_UPDATED,
            &id,
            &json!({ "id": id, "email": email, "provider": provider, "status": status }),
        );
        Ok(Data(json!({
            "id": id,
            "isShared": shared,
            "assignedUserIds": assigned.filter(|v| !v.is_null()).unwrap_or_else(|| json!([])),
        }))
        .into_response())
    }
    .await;
    answer(result, "Failed to assign users")
}

/// A mailbox's access fields with its email, provider and status.
type AccountIdentity = (Option<bool>, Option<Value>, String, String, String);

/// The mailbox `id`'s [`AccountIdentity`]; `live` keeps it to a live one.
async fn account_identity(
    caller: &Caller,
    id: &str,
    live: bool,
) -> Result<Option<AccountIdentity>, DbErr> {
    /// The columns as stored: the provider and status enums.
    type Row = (
        Option<bool>,
        Option<Value>,
        String,
        MailProvider,
        MailAccountStatus,
    );
    let mut find = mail_accounts::Entity::find_by_id(id.to_owned())
        .select_only()
        .columns([
            mail_accounts::Column::IsShared,
            mail_accounts::Column::AssignedUserIds,
            mail_accounts::Column::Email,
            mail_accounts::Column::Provider,
            mail_accounts::Column::Status,
        ]);
    if live {
        find = find.filter(mail_accounts::Column::DeletedAt.is_null());
    }
    let row: Option<Row> = find.into_tuple().one(&orm(&caller.db)).await?;
    Ok(row.map(|(shared, assigned, email, provider, status)| {
        (
            shared,
            assigned,
            email,
            provider.to_value(),
            status.to_value(),
        )
    }))
}

/// `DELETE /:id` (`deleteMailAccount`): a soft delete by someone who may
/// manage the mailbox; a catch-all pointing at it is switched off.
async fn remove(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let row = account_identity(&caller, &id, true).await?;
        let Some((is_shared, assigned, email, provider, status)) = row else {
            return Err(MailError::not_found("Mail account", Some(&id)));
        };
        let account = AccountAccess {
            is_shared: is_shared.unwrap_or(false),
            assigned_user_ids: assigned.as_ref().map(strings).unwrap_or_default(),
        };
        let admin = is_admin_or_owner(&caller.db, &caller.user_id).await?;
        if !can_manage_account(&account, &caller.user_id, admin) {
            return Err(MailError::not_found("Mail account", Some(&id)));
        }
        let at = utc_now();
        mail_accounts::Entity::update_many()
            .col_expr(mail_accounts::Column::DeletedAt, Expr::value(at))
            .col_expr(mail_accounts::Column::UpdatedAt, Expr::value(at))
            .filter(mail_accounts::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        clear_catch_all_for_account(&state, &caller, &id).await?;
        bump_mailbox_directory(&caller, &state).await;
        caller.publish(
            &state,
            MAIL_ACCOUNT_DELETED,
            &id,
            &json!({ "id": id, "email": email, "provider": provider, "status": status }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete mail account")
}

/// `clearCatchAllForAccount(env, db, accountId)`: domains catching all their
/// mail into this mailbox stop doing so, and their `*@domain` registry
/// sentinels are deactivated.
pub(crate) async fn clear_catch_all_for_account(
    state: &MailState,
    caller: &Caller,
    account_id: &str,
) -> MailResult<()> {
    let domains: Vec<String> = mail_domains::Entity::find()
        .select_only()
        .column(mail_domains::Column::DomainName)
        .filter(mail_domains::Column::CatchAllAccountId.eq(account_id))
        .filter(mail_domains::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    if domains.is_empty() {
        return Ok(());
    }
    let at = utc_now();
    mail_domains::Entity::update_many()
        .col_expr(mail_domains::Column::CatchAllEnabled, Expr::value(false))
        .col_expr(
            mail_domains::Column::CatchAllAccountId,
            Expr::value(Option::<String>::None),
        )
        .col_expr(mail_domains::Column::UpdatedAt, Expr::value(at))
        .filter(mail_domains::Column::CatchAllAccountId.eq(account_id))
        .exec(&orm(&caller.db))
        .await?;
    let Some(master) = caller.bindings.master(state) else {
        tracing::error!("[mail-domains] no master database to deactivate the catch-all sentinel");
        return Err(MailError::api(
            ApiError::internal().with_message("Failed to delete mail account"),
        ));
    };
    for domain in domains {
        registry::Entity::update_many()
            .col_expr(registry::Column::IsActive, Expr::value(false))
            .col_expr(registry::Column::UpdatedAt, Expr::value(at))
            .filter(registry::Column::Email.eq(format!("*@{}", domain.to_lowercase())))
            .exec(&orm(&master))
            .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/// `sendBody`.
fn read_send_body(headers: &HeaderMap, body: &Bytes) -> Result<SendInput, Response> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok());
    let value = json_body(content_type, body).map_err(IntoResponse::into_response)?;
    let mut issues = Issues::default();
    let Some(object) = issues.object(&value) else {
        return Err(issues.finish().err().map_or_else(
            || weldsuite_kit::ApiError::internal().into_response(),
            IntoResponse::into_response,
        ));
    };
    let to = emails(&mut issues, object, "to", Presence::Required, Some(1));
    let cc = emails(&mut issues, object, "cc", Presence::Optional, None);
    let bcc = emails(&mut issues, object, "bcc", Presence::Optional, None);
    let subject = issues.text(object, "subject", Presence::Optional, None, None);
    let text = issues.text(object, "body", Presence::Optional, None, None);
    let html = issues.text(object, "htmlBody", Presence::Optional, None, None);
    let reply_to = issues.text_with(object, "replyTo", Presence::Optional, EMAIL);
    let in_reply_to = issues.text(object, "inReplyTo", Presence::Optional, None, None);
    let references = issues
        .list(
            object,
            "references",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::length(None, None)),
        )
        .into_option();
    issues.choice(
        object,
        "importance",
        Presence::Optional,
        &["low", "normal", "high"],
    );
    let files = attachments(&mut issues, object);
    let key = issues.text(
        object,
        "idempotencyKey",
        Presence::Optional,
        Some(1),
        Some(64),
    );
    issues.finish().map_err(IntoResponse::into_response)?;
    Ok(SendInput {
        to: to.unwrap_or_default(),
        cc,
        bcc,
        // `.default('(No subject)')`.
        subject: Some(optional_text(subject).unwrap_or_else(|| "(No subject)".to_owned())),
        body: optional_text(text),
        html_body: optional_text(html),
        reply_to: optional_text(reply_to),
        in_reply_to: optional_text(in_reply_to),
        references,
        attachments: files,
        idempotency_key: optional_text(key),
    })
}

/// `emailEventData(db, data)`: the content only for a shared mailbox.
pub(crate) async fn email_event_data(caller: &Caller, account_id: &str, mut data: Value) -> Value {
    let shared = match weldsuite_mail_domain::access::load_access_fields(&caller.db, account_id)
        .await
    {
        Ok(fields) => fields.is_some_and(|f| f.is_shared),
        Err(error) => {
            tracing::error!(%error, "[mail/access] Could not resolve account for email event, dropping content");
            false
        }
    };
    if !shared {
        data["subject"] = Value::Null;
        data["from"] = Value::Null;
        data["to"] = Value::Null;
    }
    data
}

/// `POST /:id/send`.
async fn send(
    State(state): State<MailState>,
    caller: Caller,
    doh: Option<Extension<RequestDoh>>,
    Path(account_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match read_send_body(&headers, &body) {
        Ok(data) => data,
        Err(response) => return response,
    };
    let org = match caller.org() {
        Ok(org) => org.to_owned(),
        Err(error) => return error.into_response(),
    };
    let doh = doh
        .map(|d| Arc::clone(&d.0.0))
        .or_else(|| state.doh.clone());
    let context = SendContext::new(&state, &caller, doh);
    let options = SendOptions::default();
    let result = send_and_persist(
        &context.deps(&caller),
        &org,
        &caller.user_id,
        &account_id,
        &data,
        &options,
    )
    .await;
    match result {
        Ok(result) => {
            let event = email_event_data(
                &caller,
                &result.account_id,
                json!({
                    "id": result.message_id,
                    "accountId": result.account_id,
                    "subject": result.subject,
                    "from": null,
                    "to": data.to,
                }),
            )
            .await;
            caller.publish(&state, EMAIL_EMAIL_SENT, &result.message_id, &event);
            Data(json!({
                "messageId": result.message_id,
                "smtpMessageId": result.smtp_message_id,
                "pendingVerification": result.pending_verification,
                "message": if result.pending_verification {
                    "Send is pending recipient verification"
                } else {
                    "Email sent successfully"
                },
            }))
            .into_response()
        }
        Err(error) => send_error_response(error, "Mail account", None, "Failed to send email"),
    }
}
