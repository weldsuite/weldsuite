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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    EMAIL_EMAIL_SENT, MAIL_ACCOUNT_CREATED, MAIL_ACCOUNT_DELETED, MAIL_ACCOUNT_UPDATED,
};
use weldsuite_catalogs::permission_keys::{
    ACCOUNTS_CREATE, ACCOUNTS_DELETE, ACCOUNTS_READ, ACCOUNTS_UPDATE, MESSAGES_CREATE,
};
use weldsuite_db::js_row;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text, json_body};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_mail_domain::access::{
    AccountAccess, can_manage_account, check_account_access, check_account_manage_access,
    has_access_to_account, is_admin_or_owner,
};
use weldsuite_mail_domain::send::{SendInput, SendOptions, send_and_persist};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::send::{
    EMAIL, RequestDoh, SendContext, attachments, emails, optional_text, send_error_response,
};
use crate::util::{
    MailError, MailResult, answer, bump_mailbox_directory, list_response, now, page, strings,
    validate, validate_query,
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
macro_rules! public_account {
    () => {
        "(to_jsonb(a) - 'access_token' - 'refresh_token' - 'api_key' - 'password_hash'
           - 'provider_config')"
    };
}

/// `GET /` (`listMailAccounts`): the mailboxes the caller may open, or
/// every one for an admin's `scope=manage`.
#[allow(clippy::too_many_lines)] // the query, the list and its count
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
        let cursor_row: Option<(Option<String>, String)> =
            match cursor.as_deref().filter(|c| !c.is_empty()) {
                Some(cursor) => {
                    sqlx::query_as(
                        "select to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), id
                         from mail_accounts where id = $1 limit 1",
                    )
                    .bind(cursor)
                    .fetch_optional(&caller.db)
                    .await?
                }
                None => None,
            };
        let (cursor_at, cursor_id) = cursor_row
            .and_then(|(at, id)| at.map(|at| (at, id)))
            .unzip();
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            public_account!(),
            " from mail_accounts a
             where a.deleted_at is null
               and (not $1 or (a.is_shared = true
                    or a.assigned_user_ids @> jsonb_build_array($2::text)
                    or ($3 and coalesce(a.assigned_user_ids, '[]'::jsonb) in ('[]'::jsonb, 'null'::jsonb))))
               and ($4::text is null or (a.name like $4 or a.email like $4))
               and ($5::text is null or a.status = $5::mail_account_status)
               and ($6::text is null or a.provider = $6::mail_provider)
               and ($7::timestamp is null or (a.created_at < $7::timestamp
                    or (a.created_at = $7::timestamp and a.id < $8)))
             order by a.created_at desc, a.id desc
             limit $9"
        ))
        .bind(scoped)
        .bind(&caller.user_id)
        .bind(admin)
        .bind(&search)
        .bind(&status)
        .bind(&provider)
        .bind(&cursor_at)
        .bind(&cursor_id)
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i32 = sqlx::query_scalar(
            "select count(*)::int from mail_accounts a
             where a.deleted_at is null
               and (not $1 or (a.is_shared = true
                    or a.assigned_user_ids @> jsonb_build_array($2::text)
                    or ($3 and coalesce(a.assigned_user_ids, '[]'::jsonb) in ('[]'::jsonb, 'null'::jsonb))))
               and ($4::text is null or (a.name like $4 or a.email like $4))
               and ($5::text is null or a.status = $5::mail_account_status)
               and ($6::text is null or a.provider = $6::mail_provider)",
        )
        .bind(scoped)
        .bind(&caller.user_id)
        .bind(admin)
        .bind(&search)
        .bind(&status)
        .bind(&provider)
        .fetch_one(&caller.db)
        .await?;
        let rows = rows.into_iter().map(js_row).collect();
        let (data, has_more, next) = page(rows, limit);
        Ok(list_response(data, i64::from(total), has_more, next))
    }
    .await;
    answer(result, "Failed to list mail accounts")
}

/// `GET /stats` (`getMailAccountStats`).
async fn stats(caller: Caller) -> Response {
    let result = async {
        let (total, active, inactive, error): (i32, i32, i32, i32) = sqlx::query_as(
            "select count(*)::int,
               count(*) filter (where status = 'active')::int,
               count(*) filter (where status = 'inactive')::int,
               count(*) filter (where status = 'error')::int
             from mail_accounts where deleted_at is null",
        )
        .fetch_one(&caller.db)
        .await?;
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
        let account: Option<String> = sqlx::query_scalar(
            "select id from mail_accounts where id = $1 and deleted_at is null limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        if account.is_none() {
            return Err(MailError::not_found("Mail account", Some(&id)));
        }
        let rows: Vec<Value> =
            sqlx::query_scalar("select to_jsonb(l) from mail_labels l where l.account_id = $1")
                .bind(&id)
                .fetch_all(&caller.db)
                .await?;
        Ok(Data(rows.into_iter().map(js_row).collect::<Vec<_>>()).into_response())
    }
    .await;
    answer(result, "Failed to fetch mail account labels")
}

/// `GET /:id` (`getMailAccount`).
async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let row: Option<Value> = sqlx::query_scalar(concat!(
            "select ",
            public_account!(),
            " from mail_accounts a where a.id = $1 and a.deleted_at is null limit 1"
        ))
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        let Some(row) = row.map(js_row) else {
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

/// The shared WeldMail apexes (`SHARED_WELDMAIL_APEXES`).
const SHARED_WELDMAIL_APEXES: [&str; 2] = ["weldmail.com", "weldmail.org"];

/// `isSharedWeldMailDomain(domain)`.
fn is_shared_weldmail_domain(domain: &str) -> bool {
    let d = domain.to_lowercase();
    SHARED_WELDMAIL_APEXES
        .iter()
        .any(|apex| d == *apex || d.ends_with(&format!(".{apex}")))
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
    let slug: Option<String> = sqlx::query_scalar(
        "select slug from workspaces where id = $1 or clerk_org_id = $1 limit 1",
    )
    .bind(org)
    .fetch_optional(&master)
    .await?;
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

/// `ensureManagedDomain`: the domain must be a WeldMail mail domain already,
/// or a WeldHost domain (then it is recorded as one). On Kubernetes there is
/// no Cloudflare Email Routing to re-assert (MAIL-010): the records come from
/// the `MailDomains` port when the domain is added.
async fn ensure_managed_domain(caller: &Caller, domain: &str, at: &str) -> MailResult<()> {
    let managed: Option<String> = sqlx::query_scalar(
        "select id from mail_domains where domain_name = $1 and deleted_at is null limit 1",
    )
    .bind(domain)
    .fetch_optional(&caller.db)
    .await?;
    if managed.is_some() {
        return Ok(());
    }
    let host: Option<String> = sqlx::query_scalar(
        "select id from domains where full_domain = $1 and deleted_at is null limit 1",
    )
    .bind(domain)
    .fetch_optional(&caller.db)
    .await?;
    if host.is_none() {
        return Err(bad_request(&format!(
            "Add {domain} in WeldHost › Domains before creating an email account on it."
        )));
    }
    sqlx::query(
        "insert into mail_domains (id, domain_name, is_active, is_primary, mail_provider,
           send_provider, receive_provider, dns_status, cloudflare_routing_enabled,
           max_email_accounts, current_email_accounts, created_at, updated_at)
         values ($1, $2, true, false, 'cloudflare', 'cloudflare', 'cloudflare', 'verified', true,
           100, 0, $3::timestamp, $3::timestamp)",
    )
    .bind(generate_id("mdom"))
    .bind(domain)
    .bind(at)
    .execute(&caller.db)
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
        let workspace: Option<String> = sqlx::query_scalar(
            "select id from workspaces where id = $1 or clerk_org_id = $1 limit 1",
        )
        .bind(org)
        .fetch_optional(&master)
        .await?;
        let Some(workspace) = workspace else {
            tracing::warn!("[mail-accounts] no workspace for orgId {org}; skipping registry");
            return Ok::<(), sqlx::Error>(());
        };
        sqlx::query(
            "insert into mail_account_registry (id, email, tenant_kind, workspace_id, account_id, is_active)
             values ($1, $2, 'workspace', $3, $4, true)
             on conflict (email) do update set tenant_kind = 'workspace', workspace_id = $3,
               personal_account_id = null, account_id = $4, is_active = true,
               updated_at = $5::timestamp",
        )
        .bind(generate_id("reg"))
        .bind(email)
        .bind(&workspace)
        .bind(account_id)
        .bind(now())
        .execute(&master)
        .await?;
        Ok(())
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

        let existing: Option<String> = sqlx::query_scalar(
            "select id from mail_accounts where email = $1 and deleted_at is null limit 1",
        )
        .bind(&email)
        .fetch_optional(&caller.db)
        .await?;
        if let Some(existing) = existing {
            return Err(MailError::conflict(format!(
                "An account for {email} already exists ({existing}). Delete it first or edit the existing account."
            )));
        }

        let id = generate_id("mail");
        let at = now();
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

        ensure_managed_domain(&caller, &domain, &at).await?;

        if data.flag("isDefault") == Some(true) {
            sqlx::query("update mail_accounts set is_default = false where deleted_at is null")
                .execute(&caller.db)
                .await?;
        }
        let provider = data.text("provider").unwrap_or("imap").to_owned();
        sqlx::query(
            "insert into mail_accounts (id, name, email, display_name, provider, auth_type,
               imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
               sync_enabled, sync_frequency, signature, daily_send_limit, is_default, is_shared,
               assigned_user_ids, status, created_at, updated_at)
             values ($1, $2, $3, $4, $5::mail_provider, $6::mail_auth_type, $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, $17, $18, $19, 'active', $20::timestamp, $20::timestamp)",
        )
        .bind(&id)
        .bind(&name)
        .bind(&email)
        .bind(data.text("displayName"))
        .bind(&provider)
        .bind(data.text("authType").unwrap_or("password"))
        .bind(data.text("imapHost"))
        .bind(data.int("imapPort"))
        .bind(data.flag("imapSecure").unwrap_or(true))
        .bind(data.text("smtpHost"))
        .bind(data.int("smtpPort"))
        .bind(data.flag("smtpSecure").unwrap_or(true))
        .bind(data.flag("syncEnabled").unwrap_or(true))
        .bind(data.int("syncFrequency").unwrap_or(5))
        .bind(data.text("signature"))
        .bind(data.int("dailySendLimit").unwrap_or(500))
        .bind(data.flag("isDefault").unwrap_or(false))
        .bind(is_shared)
        .bind(assigned.map(|ids| json!(ids)))
        .bind(&at)
        .execute(&caller.db)
        .await?;

        let label_ids: Vec<String> = SYSTEM_LABEL_SEEDS
            .iter()
            .map(|_| generate_id("label"))
            .collect();
        let names: Vec<&str> = SYSTEM_LABEL_SEEDS.iter().map(|(n, _)| *n).collect();
        let slugs: Vec<&str> = SYSTEM_LABEL_SEEDS.iter().map(|(_, s)| *s).collect();
        sqlx::query(
            "insert into mail_labels (id, account_id, name, slug, is_system, message_count,
               created_at, updated_at)
             select l.id, $2, l.name, l.slug, true, 0, $5::timestamp, $5::timestamp
             from unnest($1::varchar[], $3::varchar[], $4::varchar[]) with ordinality as l(id, name, slug, ord)
             order by l.ord",
        )
        .bind(&label_ids)
        .bind(&id)
        .bind(&names)
        .bind(&slugs)
        .bind(&at)
        .execute(&caller.db)
        .await?;

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
        let before: Option<String> = sqlx::query_scalar(
            "select id from mail_accounts where id = $1 and deleted_at is null limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        if before.is_none() {
            return Err(MailError::not_found("Mail account", Some(&id)));
        }
        if data.flag("isDefault") == Some(true) {
            sqlx::query("update mail_accounts set is_default = false where deleted_at is null")
                .execute(&caller.db)
                .await?;
        }
        sqlx::query(
            "update mail_accounts set updated_at = $2::timestamp,
               name = coalesce($3, name), email = coalesce($4, email),
               display_name = coalesce($5, display_name),
               provider = coalesce($6::mail_provider, provider),
               auth_type = coalesce($7::mail_auth_type, auth_type),
               imap_host = coalesce($8, imap_host), imap_port = coalesce($9, imap_port),
               imap_secure = coalesce($10, imap_secure), smtp_host = coalesce($11, smtp_host),
               smtp_port = coalesce($12, smtp_port), smtp_secure = coalesce($13, smtp_secure),
               sync_enabled = coalesce($14, sync_enabled),
               sync_frequency = coalesce($15, sync_frequency),
               signature = coalesce($16, signature),
               daily_send_limit = coalesce($17, daily_send_limit),
               is_default = coalesce($18, is_default), is_shared = coalesce($19, is_shared),
               assigned_user_ids = coalesce($20::jsonb, assigned_user_ids),
               ai_settings = coalesce($21::jsonb, ai_settings)
             where id = $1 and deleted_at is null",
        )
        .bind(&id)
        .bind(now())
        .bind(data.text("name"))
        .bind(data.text("email"))
        .bind(data.text("displayName"))
        .bind(data.text("provider"))
        .bind(data.text("authType"))
        .bind(data.text("imapHost"))
        .bind(data.int("imapPort"))
        .bind(data.flag("imapSecure"))
        .bind(data.text("smtpHost"))
        .bind(data.int("smtpPort"))
        .bind(data.flag("smtpSecure"))
        .bind(data.flag("syncEnabled"))
        .bind(data.int("syncFrequency"))
        .bind(data.text("signature"))
        .bind(data.int("dailySendLimit"))
        .bind(data.flag("isDefault"))
        .bind(data.flag("isShared"))
        .bind(data.json("assignedUserIds"))
        .bind(data.json("aiSettings"))
        .execute(&caller.db)
        .await?;
        let after: (String, String, String) = sqlx::query_as(
            "select email, provider::text, status::text from mail_accounts where id = $1 limit 1",
        )
        .bind(&id)
        .fetch_one(&caller.db)
        .await?;
        bump_mailbox_directory(&caller, &state).await;
        caller.publish(
            &state,
            MAIL_ACCOUNT_UPDATED,
            &id,
            &json!({ "id": id, "email": after.0, "provider": after.1, "status": after.2 }),
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
        let row: Option<(Option<bool>, Option<Value>)> = sqlx::query_as(
            "select is_shared, assigned_user_ids from mail_accounts
             where id = $1 and deleted_at is null limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
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
        sqlx::query(
            "update mail_accounts set sync_status = 'syncing', updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
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
        let found: Option<String> = sqlx::query_scalar(
            "select id from mail_accounts where id = $1 and deleted_at is null limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
        if found.is_none() {
            return Err(MailError::not_found("Mail account", None));
        }
        if !ids.is_empty() {
            let members: Vec<String> = sqlx::query_scalar(
                "select user_id from workspace_members where deleted_at is null",
            )
            .fetch_all(&caller.db)
            .await?;
            let invalid: Vec<&String> = ids.iter().filter(|u| !members.contains(u)).collect();
            if !invalid.is_empty() {
                let list: Vec<&str> = invalid.iter().map(|s| s.as_str()).collect();
                return Err(bad_request(&format!("Invalid user IDs: {}", list.join(", "))));
            }
        }
        let assigned = if is_shared { None } else { Some(json!(ids)) };
        sqlx::query(
            "update mail_accounts set is_shared = $2, assigned_user_ids = $3, updated_at = $4::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(is_shared)
        .bind(assigned)
        .bind(now())
        .execute(&caller.db)
        .await?;
        let (shared, assigned, email, provider, status): (
            Option<bool>,
            Option<Value>,
            String,
            String,
            String,
        ) = sqlx::query_as(
            "select is_shared, assigned_user_ids, email, provider::text, status::text
             from mail_accounts where id = $1 limit 1",
        )
        .bind(&id)
        .fetch_one(&caller.db)
        .await?;
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

/// `DELETE /:id` (`deleteMailAccount`): a soft delete by someone who may
/// manage the mailbox; a catch-all pointing at it is switched off.
async fn remove(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let row: Option<AccountIdentity> = sqlx::query_as(
            "select is_shared, assigned_user_ids, email, provider::text, status::text
             from mail_accounts where id = $1 and deleted_at is null limit 1",
        )
        .bind(&id)
        .fetch_optional(&caller.db)
        .await?;
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
        let at = now();
        sqlx::query(
            "update mail_accounts set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&at)
        .execute(&caller.db)
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
    let domains: Vec<String> = sqlx::query_scalar(
        "select domain_name from mail_domains where catch_all_account_id = $1 and deleted_at is null",
    )
    .bind(account_id)
    .fetch_all(&caller.db)
    .await?;
    if domains.is_empty() {
        return Ok(());
    }
    let at = now();
    sqlx::query(
        "update mail_domains set catch_all_enabled = false, catch_all_account_id = null,
           updated_at = $2::timestamp
         where catch_all_account_id = $1",
    )
    .bind(account_id)
    .bind(&at)
    .execute(&caller.db)
    .await?;
    let Some(master) = caller.bindings.master(state) else {
        tracing::error!("[mail-domains] no master database to deactivate the catch-all sentinel");
        return Err(MailError::api(
            ApiError::internal().with_message("Failed to delete mail account"),
        ));
    };
    for domain in domains {
        sqlx::query(
            "update mail_account_registry set is_active = false, updated_at = $2::timestamp
             where email = $1",
        )
        .bind(format!("*@{}", domain.to_lowercase()))
        .bind(&at)
        .execute(&master)
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
