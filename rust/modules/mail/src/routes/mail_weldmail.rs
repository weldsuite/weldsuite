//! `/api/mail-weldmail` (`routes/mail-weldmail/index.ts`,
//! `services/mail/weldmail.ts`; ADR MAIL-007) on the Kubernetes editions:
//! free addresses on the workspace's shared subdomain, `{slug}.{apex}`.
//!
//! The apex is `WELDMAIL_DOMAIN` and has no default here: `weldmail.com` and
//! `weldmail.org` are Global's (their MX and reputation are Cloudflare's), so
//! the EU edition uses its own domain, `weldmail.eu` (ADR MAIL-012). Unset, or
//! set to one of Global's, every route answers 503
//! `FREE_ADDRESSES_NOT_CONFIGURED`, and `/config.json` lists
//! `mail-free-addresses` as unavailable.
//!
//! Reserving an address is database work only, as on Global: the operator
//! registers the apex with the MTA once (`weldsuite mta domains add
//! <apex> --pool customer`), which signs every `{slug}.{apex}` with the apex's
//! key, and a wildcard MX and SPF record cover every workspace. Plan limits
//! (`weldMailEnabled`, `maxWeldMailAddresses`) apply as in TypeScript; a
//! workspace without a plan gets two addresses. Unlike the worker, a reserved
//! mailbox gets its system labels, as any other new mailbox does here.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use weldsuite_catalogs::permission_keys::{ACCOUNTS_CREATE, ACCOUNTS_DELETE, ACCOUNTS_READ};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::mail_accounts::seed_system_labels;
use crate::util::{MailError, MailResult, answer, bump_mailbox_directory, now, validate};
use crate::{Caller, MailState};

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([ACCOUNTS_READ]);
    Router::new()
        .route("/mail-weldmail", get(list).route_layer(read()))
        .route("/mail-weldmail/domain", get(domain).route_layer(read()))
        .route("/mail-weldmail/check", post(check).route_layer(read()))
        .route(
            "/mail-weldmail/reserve",
            post(reserve).route_layer(gate.require([ACCOUNTS_CREATE])),
        )
        .route(
            "/mail-weldmail/{id}",
            delete(release).route_layer(gate.require([ACCOUNTS_DELETE])),
        )
        .with_state(state)
}

/// Global's apexes: never a free-address domain on Kubernetes.
const GLOBAL_APEXES: [&str; 2] = ["weldmail.com", "weldmail.org"];

/// `DEFAULT_MAX_WELDMAIL_ADDRESSES` / `DEFAULT_WELDMAIL_ENABLED`.
const DEFAULT_MAX_ADDRESSES: i64 = 2;

/// `RESERVED_ADDRESSES`: never claimable.
const RESERVED_ADDRESSES: [&str; 34] = [
    "admin",
    "administrator",
    "support",
    "help",
    "info",
    "contact",
    "sales",
    "billing",
    "noreply",
    "no-reply",
    "postmaster",
    "hostmaster",
    "webmaster",
    "abuse",
    "security",
    "mailer-daemon",
    "root",
    "system",
    "mail",
    "email",
    "test",
    "dev",
    "staging",
    "prod",
    "production",
    "api",
    "www",
    "ftp",
    "smtp",
    "imap",
    "pop",
    "weld",
    "weldsuite",
    "weldmail",
];

/// Whether `apex` may carry free addresses here: set, a domain name, and not
/// one of Global's.
pub fn is_free_apex(apex: &str) -> bool {
    let apex = apex.trim().to_lowercase();
    let global = GLOBAL_APEXES
        .iter()
        .any(|g| apex == *g || apex.ends_with(&format!(".{g}")));
    !global
        && apex.contains('.')
        && apex
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// The configured apex, or 503.
fn free_apex(state: &MailState, caller: &Caller) -> MailResult<String> {
    caller
        .bindings
        .env_value(state, "WELDMAIL_DOMAIN")
        .map(|apex| apex.trim().to_lowercase())
        .filter(|apex| is_free_apex(apex))
        .ok_or_else(|| {
            MailError::api(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "FREE_ADDRESSES_NOT_CONFIGURED",
                "Free WeldMail addresses are not set up on this server",
            ))
        })
}

fn not_found(message: &str) -> MailError {
    MailError::api(ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", message))
}

/// The workspace (`workspaces.id`, slug) the caller's org names.
async fn workspace(state: &MailState, caller: &Caller) -> MailResult<(String, String)> {
    let org = caller.org()?.to_owned();
    let Some(master) = caller.bindings.master(state) else {
        tracing::error!("[mail-weldmail] no master database");
        return Err(MailError::api(ApiError::internal()));
    };
    let row: Option<(String, String)> = sqlx::query_as(
        "select id, slug from workspaces where id = $1 or clerk_org_id = $1 limit 1",
    )
    .bind(&org)
    .fetch_optional(&master)
    .await?;
    row.ok_or_else(|| not_found("Workspace not found"))
}

/// `{slug}.{apex}`.
fn domain_for(slug: &str, apex: &str) -> String {
    format!("{slug}.{apex}")
}

/// `%@<domain>` for `like`, with its wildcards escaped.
fn on_domain(domain: &str) -> String {
    let mut pattern = String::from("%@");
    for c in domain.chars() {
        if matches!(c, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern
}

/// A workspace's plan: its id, features, whether it is the default plan, and
/// its slug.
type PlanRow = (Option<String>, Option<Value>, Option<bool>, Option<String>);

/// `getLimits`: whether the plan allows free addresses, and how many (`None`
/// = unlimited). Fails open with the defaults, as in TypeScript.
async fn limits(master: &PgPool, org: &str) -> (bool, Option<i64>) {
    let row: Result<Option<PlanRow>, _> = sqlx::query_as(
        "select w.plan_id, p.features, p.is_default, p.slug from workspaces w
             left join plans p on p.id = w.plan_id
             where w.id = $1 or w.clerk_org_id = $1 limit 1",
    )
    .bind(org)
    .fetch_optional(master)
    .await;
    let defaults = (true, Some(DEFAULT_MAX_ADDRESSES));
    match row {
        Ok(Some((Some(_), Some(features), is_default, slug))) => {
            let free = is_default == Some(true) || slug.as_deref() == Some("free");
            let enabled = features["weldMailEnabled"].as_bool().unwrap_or(true);
            let max = features["maxWeldMailAddresses"]
                .as_i64()
                .or(free.then_some(DEFAULT_MAX_ADDRESSES));
            (enabled, max)
        }
        Ok(_) => defaults,
        Err(error) => {
            tracing::error!(%error, "[weldmail] plan lookup failed; using defaults");
            defaults
        }
    }
}

/// `addressSchema`: 3 to 64 letters, digits, dots, hyphens and underscores,
/// starting and ending with a letter or digit; lower-cased.
fn is_address(text: &str) -> bool {
    let bytes = text.as_bytes();
    let edge = |b: &u8| b.is_ascii_alphanumeric();
    bytes.first().is_some_and(edge)
        && bytes.last().is_some_and(edge)
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn read_address(issues: &mut Issues, body: &serde_json::Map<String, Value>) -> String {
    issues
        .pattern(
            body,
            "address",
            Presence::Required,
            Some(3),
            Some(64),
            is_address,
            "Address can only contain letters, numbers, dots, hyphens, and underscores",
        )
        .into_option()
        .unwrap_or_default()
        .to_lowercase()
}

fn is_reserved(address: &str) -> bool {
    RESERVED_ADDRESSES.contains(&address)
}

/// Whether the registry knows `email`, active or released.
async fn registered(master: &PgPool, email: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("select exists(select 1 from mail_account_registry where email = $1)")
        .bind(email)
        .fetch_one(master)
        .await
}

fn master_db(state: &MailState, caller: &Caller) -> MailResult<PgPool> {
    caller.bindings.master(state).ok_or_else(|| {
        tracing::error!("[mail-weldmail] no master database");
        MailError::api(ApiError::internal())
    })
}

/// `GET /domain`.
async fn domain(State(state): State<MailState>, caller: Caller) -> Response {
    let result = async {
        let apex = free_apex(&state, &caller)?;
        let (_, slug) = workspace(&state, &caller).await?;
        Ok(Data(json!({ "domain": domain_for(&slug, &apex) })).into_response())
    }
    .await;
    answer(result, "Failed to fetch WeldMail domain")
}

/// `POST /check` (`checkAddressAvailability`).
async fn check(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let address = match validate(&headers, &body, read_address) {
        Ok(address) => address,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let apex = free_apex(&state, &caller)?;
        if is_reserved(&address) {
            return Ok(Data(json!({ "available": false, "reason": "reserved" })).into_response());
        }
        let (_, slug) = workspace(&state, &caller).await?;
        let domain = domain_for(&slug, &apex);
        let email = format!("{address}@{domain}");
        if registered(&master_db(&state, &caller)?, &email).await? {
            return Ok(Data(json!({ "available": false, "reason": "taken" })).into_response());
        }
        Ok(Data(json!({ "available": true, "email": email, "domain": domain })).into_response())
    }
    .await;
    answer(result, "Failed to check address")
}

/// `POST /reserve` (`reserveAddress`).
async fn reserve(
    State(state): State<MailState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = validate(&headers, &body, |issues, body| {
        let address = read_address(issues, body);
        let name = issues
            .text(body, "name", Presence::Optional, Some(1), Some(255))
            .into_option();
        let display_name = issues
            .text(body, "displayName", Presence::Optional, None, Some(255))
            .into_option();
        (address, name, display_name)
    });
    let (address, name, display_name) = match input {
        Ok(input) => input,
        Err(error) => return error.respond(""),
    };
    let result = async {
        let apex = free_apex(&state, &caller)?;
        if is_reserved(&address) {
            return Err(MailError::bad_request("This address is reserved"));
        }
        let (workspace_id, slug) = workspace(&state, &caller).await?;
        let domain = domain_for(&slug, &apex);
        let email = format!("{address}@{domain}");
        let master = master_db(&state, &caller)?;
        let (enabled, max) = limits(&master, caller.org()?).await;
        if !enabled {
            return Err(MailError::forbidden(
                "WeldMail is not available on your current plan. Upgrade to enable shared email addresses.",
            ));
        }
        if registered(&master, &email).await? {
            return Err(MailError::conflict("This address is already taken"));
        }
        let existing: i64 = sqlx::query_scalar(
            "select count(*) from mail_accounts where email like $1 and deleted_at is null",
        )
        .bind(on_domain(&domain))
        .fetch_one(&caller.db)
        .await?;
        if let Some(max) = max
            && existing >= max
        {
            let plural = if max == 1 { "" } else { "es" };
            return Err(MailError::bad_request(format!(
                "You have reached your plan limit of {max} WeldMail address{plural}. Upgrade your plan to add more."
            )));
        }

        let id = generate_id("mail");
        let at = now();
        let name = name.unwrap_or_else(|| address.clone());
        let display_name = display_name.unwrap_or_else(|| name.clone());
        let is_default = existing == 0;
        let inserted = sqlx::query(
            "insert into mail_accounts (id, name, email, display_name, provider, auth_type,
               status, sync_enabled, is_default, created_at, updated_at)
             values ($1, $2, $3, $4, 'custom', 'api_key', 'active', false, $5,
               $6::timestamp, $6::timestamp)",
        )
        .bind(&id)
        .bind(&name)
        .bind(&email)
        .bind(&display_name)
        .bind(is_default)
        .bind(&at)
        .execute(&caller.db)
        .await;
        if let Err(error) = inserted {
            return Err(unique_or(error));
        }
        seed_system_labels(&caller.db, &id, &at).await?;
        let registry = sqlx::query(
            "insert into mail_account_registry (id, email, tenant_kind, workspace_id, account_id, is_active)
             values ($1, $2, 'workspace', $3, $4, true)",
        )
        .bind(generate_id("reg"))
        .bind(&email)
        .bind(&workspace_id)
        .bind(&id)
        .execute(&master)
        .await;
        if let Err(error) = registry {
            return Err(unique_or(error));
        }
        bump_mailbox_directory(&caller, &state).await;
        Ok(Created(json!({
            "id": id,
            "email": email,
            "name": name,
            "displayName": display_name,
            "isDefault": is_default,
        }))
        .into_response())
    }
    .await;
    answer(result, "Failed to reserve address")
}

/// A unique-constraint violation is the address being taken meanwhile (409).
fn unique_or(error: sqlx::Error) -> MailError {
    let unique = error
        .as_database_error()
        .and_then(sqlx::error::DatabaseError::code)
        .is_some_and(|code| code == "23505");
    if unique {
        MailError::conflict("This address is already taken")
    } else {
        MailError::Database(error)
    }
}

/// `GET /` (`listAddresses`).
async fn list(State(state): State<MailState>, caller: Caller) -> Response {
    let result = async {
        let apex = free_apex(&state, &caller)?;
        let (_, slug) = workspace(&state, &caller).await?;
        let domain = domain_for(&slug, &apex);
        let (enabled, max) = limits(&master_db(&state, &caller)?, caller.org()?).await;
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(a) from (
               select id, email, name, display_name, status, is_default, created_at
               from mail_accounts where email like $1 and deleted_at is null
               order by created_at, id) a",
        )
        .bind(on_domain(&domain))
        .fetch_all(&caller.db)
        .await?;
        let addresses: Vec<Value> = rows.into_iter().map(js_row).collect();
        Ok(Data(json!({
            "total": addresses.len(),
            "addresses": addresses,
            "limit": max,
            "enabled": enabled,
            "domain": domain,
        }))
        .into_response())
    }
    .await;
    answer(result, "Failed to list addresses")
}

/// `DELETE /:id` (`releaseAddress`): the mailbox is soft-deleted; its
/// registry row stays, inactive, so the address is never handed out again.
async fn release(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let apex = free_apex(&state, &caller)?;
        let (_, slug) = workspace(&state, &caller).await?;
        let domain = domain_for(&slug, &apex);
        let email: Option<String> = sqlx::query_scalar(
            "select email from mail_accounts
             where id = $1 and email like $2 and deleted_at is null limit 1",
        )
        .bind(&id)
        .bind(on_domain(&domain))
        .fetch_optional(&caller.db)
        .await?;
        let Some(email) = email else {
            return Err(not_found("WeldMail address not found"));
        };
        let at = now();
        sqlx::query(
            "update mail_accounts set deleted_at = $2::timestamp, status = 'inactive',
               updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&at)
        .execute(&caller.db)
        .await?;
        sqlx::query(
            "update mail_account_registry set is_active = false, updated_at = $2::timestamp
             where email = $1",
        )
        .bind(&email)
        .bind(&at)
        .execute(&master_db(&state, &caller)?)
        .await?;
        bump_mailbox_directory(&caller, &state).await;
        Ok(Data(json!({ "deleted": true, "id": id, "email": email })).into_response())
    }
    .await;
    answer(result, "Failed to release address")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_domain_that_is_not_globals_carries_free_addresses() {
        for ok in ["weldmail.eu", " WeldMail.EU ", "mail.example.eu"] {
            assert!(is_free_apex(ok), "{ok}");
        }
        for bad in [
            "",
            "weldmail.com",
            "weldmail.org",
            "test.weldmail.com",
            "localhost",
            "a b.eu",
        ] {
            assert!(!is_free_apex(bad), "{bad}");
        }
    }

    #[test]
    fn addresses_follow_the_workers_pattern() {
        for ok in ["anna", "anna.de-vries", "a_b", "x9z"] {
            assert!(is_address(ok), "{ok}");
        }
        for bad in [".anna", "anna.", "an na", "anna@x", "-ab"] {
            assert!(!is_address(bad), "{bad}");
        }
        assert!(is_reserved("postmaster") && !is_reserved("anna"));
        assert_eq!(on_domain("a_b.weldmail.eu"), "%@a\\_b.weldmail.eu");
    }
}

/// The routes on the real schema (databases built from the journaled
/// migrations by `scripts/rust-test-db.ts`, as CI does). Runs when
/// `WELDSUITE_TEST_MASTER_URL` and `WELDSUITE_TEST_TENANT_URL` are set;
/// otherwise only the database-free test runs.
#[cfg(test)]
mod db_tests {
    #![allow(clippy::too_many_lines)] // one scenario, step by step

    use std::collections::HashMap;

    use http::header::CONTENT_TYPE;
    use weldsuite_events::{EntityEventPublisher, EventContext, TaskTracker};
    use weldsuite_mail_domain::outbound::OutboundBindings;

    use super::*;
    use crate::caller::Bindings;

    fn databases() -> Option<(PgPool, PgPool)> {
        let master = std::env::var("WELDSUITE_TEST_MASTER_URL").ok()?;
        let tenant = std::env::var("WELDSUITE_TEST_TENANT_URL").ok()?;
        Some((
            weldsuite_db::master_pool(&master, 2).expect("master pool"),
            weldsuite_db::master_pool(&tenant, 2).expect("tenant pool"),
        ))
    }

    fn state(master: Option<PgPool>, free_domain: &str) -> MailState {
        MailState {
            events: EntityEventPublisher::new(None, TaskTracker::new()),
            master,
            cache: None,
            outbound: OutboundBindings::default(),
            files: None,
            jobs: None,
            system_mail: None,
            http: None,
            doh: None,
            domains: None,
            workspace_tenants: None,
            env: Arc::new(HashMap::from([(
                "WELDMAIL_DOMAIN".to_owned(),
                free_domain.to_owned(),
            )])),
        }
    }

    fn caller(tenant: &PgPool) -> Caller {
        Caller {
            db: tenant.clone(),
            user_id: "user_mwt".to_owned(),
            org_id: Some("org_mwt".to_owned()),
            workspace_id: "ws_mwt".to_owned(),
            events: EventContext::from_ids("ws_mwt", Some("org_mwt"), "user_mwt"),
            bindings: Bindings::default(),
            permissions: None,
        }
    }

    fn json_body(value: &Value) -> (HeaderMap, Bytes) {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_TYPE,
            http::HeaderValue::from_static("application/json"),
        );
        (headers, Bytes::from(value.to_string()))
    }

    async fn read(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Global's domains (and none at all) answer 503 before any query.
    #[tokio::test]
    async fn globals_domains_are_never_handed_out() {
        let offline =
            weldsuite_db::master_pool("postgres://nobody@127.0.0.1:1/none", 1).expect("lazy pool");
        for apex in ["", "weldmail.com", "acme.weldmail.org"] {
            let (status, body) =
                read(domain(State(state(None, apex)), caller(&offline)).await).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{apex}: {body}");
            assert_eq!(body["error"]["code"], "FREE_ADDRESSES_NOT_CONFIGURED");
            let (headers, bytes) = json_body(&json!({ "address": "anna" }));
            let (status, _) =
                read(reserve(State(state(None, apex)), caller(&offline), headers, bytes).await)
                    .await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{apex}");
        }
    }

    async fn clean(master: &PgPool, tenant: &PgPool) {
        sqlx::raw_sql(
            "delete from mail_labels where account_id in
               (select id from mail_accounts where email like '%@acme-mwt.weldmail.eu');
             delete from mail_accounts where email like '%@acme-mwt.weldmail.eu';",
        )
        .execute(tenant)
        .await
        .expect("clean tenant");
        sqlx::raw_sql(
            "delete from mail_account_registry where email like '%@acme-mwt.weldmail.eu';
             delete from workspaces where id = 'ws_mwt';",
        )
        .execute(master)
        .await
        .expect("clean master");
    }

    #[tokio::test]
    async fn addresses_are_checked_reserved_listed_and_released() {
        let Some((master, tenant)) = databases() else {
            eprintln!("test databases not set; skipping");
            return;
        };
        clean(&master, &tenant).await;
        sqlx::query(
            "insert into workspaces (id, name, slug, clerk_org_id)
             values ('ws_mwt', 'Acme', 'acme-mwt', 'org_mwt')",
        )
        .execute(&master)
        .await
        .expect("workspace");
        let state = state(Some(master.clone()), "weldmail.eu");
        let post = |value: Value| json_body(&value);

        let (_, body) = read(domain(State(state.clone()), caller(&tenant)).await).await;
        assert_eq!(body["data"]["domain"], "acme-mwt.weldmail.eu");

        let (headers, bytes) = post(json!({ "address": "Anna" }));
        let (_, body) =
            read(check(State(state.clone()), caller(&tenant), headers, bytes).await).await;
        assert_eq!(body["data"]["available"], true, "{body}");
        assert_eq!(body["data"]["email"], "anna@acme-mwt.weldmail.eu");
        let (headers, bytes) = post(json!({ "address": "postmaster" }));
        let (_, body) =
            read(check(State(state.clone()), caller(&tenant), headers, bytes).await).await;
        assert_eq!(body["data"]["reason"], "reserved");

        // The first address is the default, with its system labels and its
        // registry row; a workspace without a plan gets two.
        let (headers, bytes) = post(json!({ "address": "anna", "displayName": "Anna" }));
        let (status, body) =
            read(reserve(State(state.clone()), caller(&tenant), headers, bytes).await).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["data"]["isDefault"], true);
        assert_eq!(body["data"]["displayName"], "Anna");
        let anna = body["data"]["id"].as_str().expect("id").to_owned();
        let labels: i64 =
            sqlx::query_scalar("select count(*) from mail_labels where account_id = $1")
                .bind(&anna)
                .fetch_one(&tenant)
                .await
                .expect("labels");
        assert_eq!(labels, 11);
        let active: bool = sqlx::query_scalar(
            "select is_active from mail_account_registry where email = 'anna@acme-mwt.weldmail.eu'",
        )
        .fetch_one(&master)
        .await
        .expect("registry row");
        assert!(active);

        let (headers, bytes) = post(json!({ "address": "anna" }));
        let (status, _) =
            read(reserve(State(state.clone()), caller(&tenant), headers, bytes).await).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (headers, bytes) = post(json!({ "address": "bob" }));
        let (status, body) =
            read(reserve(State(state.clone()), caller(&tenant), headers, bytes).await).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["data"]["isDefault"], false);
        let (headers, bytes) = post(json!({ "address": "carl" }));
        let (status, body) =
            read(reserve(State(state.clone()), caller(&tenant), headers, bytes).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(
            body["error"]["message"]
                .as_str()
                .is_some_and(|m| m.contains("plan limit of 2"))
        );

        let (_, body) = read(list(State(state.clone()), caller(&tenant)).await).await;
        assert_eq!(body["data"]["total"], 2, "{body}");
        assert_eq!(body["data"]["limit"], 2);
        assert_eq!(body["data"]["enabled"], true);
        assert_eq!(
            body["data"]["addresses"][0]["email"],
            "anna@acme-mwt.weldmail.eu"
        );

        // Released: gone from the list, and never handed out again.
        let (status, body) =
            read(release(State(state.clone()), caller(&tenant), Path(anna.clone())).await).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["deleted"], true);
        let (_, body) = read(list(State(state.clone()), caller(&tenant)).await).await;
        assert_eq!(body["data"]["total"], 1);
        let (headers, bytes) = post(json!({ "address": "anna" }));
        let (_, body) =
            read(check(State(state.clone()), caller(&tenant), headers, bytes).await).await;
        assert_eq!(body["data"]["reason"], "taken");
        let (status, _) =
            read(release(State(state.clone()), caller(&tenant), Path(anna)).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        clean(&master, &tenant).await;
    }
}
