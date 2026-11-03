//! `/api/reach/mailboxes` (`routes/mailboxes`, `services/mailboxes.ts`):
//! outreach mailboxes, Mailpool inboxes on connected domains. A create is
//! billed, provisioned at Mailpool and entered in the warmup network, in that
//! order, every step after billing undone when a later one fails. Responses
//! and events never carry the logins.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_catalogs::entity_events::{
    REACH_MAILBOX_CREATED, REACH_MAILBOX_DELETED, REACH_MAILBOX_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Number, Presence, Text};
use weldsuite_kit::{Data, List, NoContent, Pagination, generate_id, random_string};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_reach_domain::access::utc_tomorrow;
use weldsuite_reach_domain::credentials::{MailServerCredentials, seal};
use weldsuite_reach_domain::mailboxes::{WarmupSource, without_credentials};
use weldsuite_reach_domain::schemas::sending;
use weldsuite_reach_domain::warmup::gate;
use weldsuite_reach_domain::warmup_pool::{self, PoolError, RegisterInput};
use weldsuite_reach_domain::{EventSink, ReachError, ReachEvent, ReachResult, int, iso, text};

use crate::account::get_or_create_settings;
use crate::billing::{BillingError, adjust_inboxes, release_inbox};
use crate::domains::mailpool_of;
use crate::mailpool::{
    Mailpool, MailpoolError, id_text, imap_credentials_of, smtp_credentials_of, upstream,
};
use crate::{Caller, ReachState, account_workspace, respond, validate, validate_query};

const STATUSES: &[&str] = &[
    "provisioning",
    "warming",
    "active",
    "paused",
    "suspended",
    "error",
    "deleting",
    "deleted",
];

/// `POOL_PAUSE_REASONS`.
pub(crate) mod pause_reasons {
    pub(crate) const USER: &str = "paused_by_user";
    pub(crate) const SUSPENDED: &str = "mailbox_suspended";
    pub(crate) const DOMAIN_ERROR: &str = "domain_error";
}

pub(crate) fn routes<Q: PermissionQueries + 'static>(
    gate: &Arc<PermissionGate<Q>>,
) -> Router<ReachState> {
    let read = || gate.require([perm::REACH_MAILBOXES_READ]);
    let update = || gate.require([perm::REACH_MAILBOXES_UPDATE]);
    Router::new()
        .route(
            "/",
            get(list)
                .route_layer(read())
                .merge(post(create).route_layer(gate.require([perm::REACH_MAILBOXES_CREATE]))),
        )
        .route(
            "/{id}",
            get(read_one)
                .route_layer(read())
                .merge(axum::routing::patch(update_one).route_layer(update()))
                .merge(
                    axum::routing::delete(delete_one)
                        .route_layer(gate.require([perm::REACH_MAILBOXES_DELETE])),
                ),
        )
        .route("/{id}/pause", post(pause).route_layer(update()))
        .route("/{id}/resume", post(resume).route_layer(update()))
}

/// `readDeps(c)`.
fn source<'a>(caller: &'a Caller, master: Option<&'a PgPool>) -> WarmupSource<'a> {
    WarmupSource {
        clerk_org_id: &caller.clerk_org_id,
        master,
    }
}

async fn list(
    State(state): State<ReachState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    let filter = match validate_query(query.as_deref(), |issues, q| {
        let domain = issues
            .text_with(
                q,
                "domainId",
                Presence::Optional,
                Text::length(Some(1), Some(30)),
            )
            .into_option();
        let status = issues
            .choice(q, "status", Presence::Optional, STATUSES)
            .into_option();
        (domain, status)
    }) {
        Ok(filter) => filter,
        Err(response) => return response,
    };
    let master = caller.master(&state);
    respond(
        weldsuite_reach_domain::mailboxes::list(
            &caller.db,
            &source(&caller, master.as_ref()),
            filter.0.as_deref(),
            filter.1.as_deref(),
        )
        .await
        .map(|items| {
            let n = items.len() as u64;
            List::new(items, Pagination::new(n, false, None)).into_response()
        }),
    )
}

async fn read_one(
    State(state): State<ReachState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let master = caller.master(&state);
    respond(
        async {
            match weldsuite_reach_domain::mailboxes::get(
                &caller.db,
                &source(&caller, master.as_ref()),
                &id,
            )
            .await?
            {
                Some(mailbox) => Ok(Data(mailbox).into_response()),
                None => {
                    Ok(weldsuite_kit::ApiError::not_found("Mailbox", Some(&id)).into_response())
                }
            }
        }
        .await,
    )
}

/// `resumeStatusFor(mailbox)`.
pub(crate) fn resume_status_for(mailbox: &Value) -> &'static str {
    match gate(
        int(mailbox, "warmupDay"),
        mailbox.get("warmupInboxRate").and_then(Value::as_f64),
        false,
    ) {
        None => "active",
        Some(_) => "warming",
    }
}

/// `requireMailbox(db, id)`.
async fn require_mailbox(db: &PgPool, id: &str) -> ReachResult<Value> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from reach_mailboxes t where t.id = $1 and t.status <> 'deleted' limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    row.map(weldsuite_db::js_row).ok_or_else(|| {
        ReachError::new(
            404,
            "NOT_FOUND",
            format!("Mailbox with ID '{id}' not found"),
        )
    })
}

/// What the pool registration needs (`PoolRegistrationDeps`).
pub(crate) struct PoolDeps<'a> {
    pub(crate) db: &'a PgPool,
    pub(crate) master: &'a PgPool,
    pub(crate) warmup_key: Option<String>,
    pub(crate) clerk_org_id: &'a str,
    pub(crate) workspace_id: &'a str,
}

/// `registerMailboxInPool(deps, mailbox, logins, timezone)`.
pub(crate) async fn register_in_pool(
    deps: &PoolDeps<'_>,
    mailbox: &Value,
    smtp: MailServerCredentials,
    imap: MailServerCredentials,
    timezone: Option<String>,
) -> ReachResult<()> {
    let timezone = match timezone {
        Some(tz) => tz,
        None => text(&get_or_create_settings(deps.db).await?, "defaultTimezone")
            .unwrap_or_default()
            .to_owned(),
    };
    warmup_pool::register(
        deps.master,
        deps.warmup_key.as_deref(),
        &RegisterInput {
            workspace_id: deps.workspace_id.to_owned(),
            clerk_org_id: deps.clerk_org_id.to_owned(),
            tenant_mailbox_id: text(mailbox, "id").unwrap_or_default().to_owned(),
            email: text(mailbox, "email").unwrap_or_default().to_owned(),
            first_name: text(mailbox, "firstName").unwrap_or_default().to_owned(),
            last_name: text(mailbox, "lastName").unwrap_or_default().to_owned(),
            mailbox_type: text(mailbox, "type").unwrap_or_default().to_owned(),
            timezone: Some(timezone),
            smtp,
            imap,
        },
    )
    .await
    .map(|_| ())
    .map_err(|error| match error {
        PoolError::Database(error) => error.into(),
        other => ReachError::unexpected(&other),
    })
}

/// The validated `createReachMailboxSchema` body.
struct CreateInput {
    domain_id: String,
    local_part: String,
    first_name: String,
    last_name: String,
    signature: Option<String>,
    kind: String,
}

fn local_part_ok(text: &str) -> bool {
    let bytes = text.as_bytes();
    let edge = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let inner = |b: u8| edge(b) || matches!(b, b'.' | b'_' | b'-');
    match bytes {
        [] => false,
        [one] => edge(*one),
        [first, middle @ .., last] => {
            edge(*first) && edge(*last) && middle.iter().all(|b| inner(*b))
        }
    }
}

async fn create(
    State(state): State<ReachState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        let domain_id = issues
            .text_with(
                body,
                "domainId",
                Presence::Required,
                Text::length(Some(1), Some(30)),
            )
            .into_option();
        let local_part = issues
            .pattern_with(
                body,
                "localPart",
                Presence::Required,
                Text {
                    trim: true,
                    lowercase: true,
                    format: None,
                    min: Some(1),
                    max: Some(64),
                },
                local_part_ok,
                "Letters, digits, dots, dashes and underscores only",
            )
            .into_option();
        let first_name = issues
            .text_with(
                body,
                "firstName",
                Presence::Required,
                Text::trimmed(Some(1), Some(100)),
            )
            .into_option();
        let last_name = issues
            .text_with(
                body,
                "lastName",
                Presence::Required,
                Text::trimmed(Some(1), Some(100)),
            )
            .into_option();
        let signature = issues
            .text_with(
                body,
                "signature",
                Presence::Optional,
                Text::length(None, Some(2000)),
            )
            .into_option();
        let kind = issues
            .choice(body, "type", Presence::Required, &["google", "shared"])
            .into_option();
        Some(CreateInput {
            domain_id: domain_id?,
            local_part: local_part?,
            first_name: first_name?,
            last_name: last_name?,
            signature,
            kind: kind?,
        })
    }) {
        Ok(Some(input)) => input,
        Ok(None) => return weldsuite_kit::ApiError::internal().into_response(),
        Err(response) => return response,
    };
    respond(
        async {
            let (workspace_id, limits) = account_workspace(&caller)?;
            let master = crate::require_master(&caller, &state)?;
            let mailpool = mailpool_of(&caller, &state)?;
            let settings = get_or_create_settings(&caller.db).await?;
            let billing_status = crate::access_of(&caller)?.billing_status.clone();
            let row = create_mailbox(
                &caller,
                &state,
                &master,
                &mailpool,
                &workspace_id,
                &limits,
                &settings,
                &billing_status,
                &input,
            )
            .await?;
            let row_safe = without_credentials(&row);
            caller.sink(&state).emit(ReachEvent::new(
                REACH_MAILBOX_CREATED,
                text(&row, "id").unwrap_or_default(),
                row_safe,
            ));
            let dto = weldsuite_reach_domain::mailboxes::get(
                &caller.db,
                &source(&caller, Some(&master)),
                text(&row, "id").unwrap_or_default(),
            )
            .await?;
            Ok((StatusCode::CREATED, Data(dto)).into_response())
        }
        .await,
    )
}

/// What a failed create takes back (`CreateUndo`).
#[derive(Default)]
struct Undo {
    mailpool_mailbox_id: Option<String>,
    tenant_row: bool,
    pool: bool,
    routes: bool,
}

#[allow(clippy::too_many_arguments)]
async fn create_mailbox(
    caller: &Caller,
    state: &ReachState,
    master: &PgPool,
    mailpool: &Mailpool,
    workspace_id: &str,
    limits: &weldsuite_reach_domain::schemas::Limits,
    settings: &Value,
    billing_status: &str,
    input: &CreateInput,
) -> ReachResult<Value> {
    let db = &caller.db;
    let now = caller.now();
    let Some(inbound_domain) = caller.env("REACH_INBOUND_DOMAIN") else {
        return Err(ReachError::new(
            503,
            "INBOUND_NOT_CONFIGURED",
            "Reply routing is not configured for this environment.",
        ));
    };
    let warmup_key = caller.env("WELDREACH_WARMUP_KEY");
    if warmup_key.is_none() {
        return Err(ReachError::new(
            503,
            "WARMUP_NOT_CONFIGURED",
            "The warmup network is not configured for this environment.",
        ));
    }
    // 1. Checks.
    let domain: Option<Value> =
        sqlx::query_scalar("select to_jsonb(t) from reach_domains t where t.id = $1 limit 1")
            .bind(&input.domain_id)
            .fetch_optional(db)
            .await?;
    let Some(domain) = domain.map(weldsuite_db::js_row) else {
        return Err(ReachError::new(
            404,
            "DOMAIN_NOT_FOUND",
            format!("Domain with ID '{}' not found", input.domain_id),
        ));
    };
    let Some(mailpool_domain_id) = text(&domain, "mailpoolDomainId")
        .filter(|_| text(&domain, "status") == Some("active"))
        .map(str::to_owned)
    else {
        return Err(ReachError::new(
            409,
            "DOMAIN_NOT_ACTIVE",
            "The domain is not active yet. Wait until it is connected.",
        ));
    };
    let existing: i64 = sqlx::query_scalar(
        "select count(*) from reach_mailboxes where status <> 'deleted' and deleted_at is null",
    )
    .fetch_one(db)
    .await?;
    if existing >= limits.max_mailboxes {
        return Err(ReachError::new(
            403,
            "MAILBOX_LIMIT_REACHED",
            "The mailbox limit for this workspace is reached.",
        )
        .with_details(json!({ "limit": limits.max_mailboxes, "current": existing })));
    }
    if billing_status == "canceled" && existing > 0 {
        return Err(ReachError::new(
            402,
            "BILLING_CANCELED",
            "The inbox subscription was cancelled. Contact support to restart billing before adding mailboxes.",
        ));
    }
    let email = format!(
        "{}@{}",
        input.local_part,
        text(&domain, "name").unwrap_or_default()
    );
    let taken: Option<String> =
        sqlx::query_scalar("select id from reach_mailboxes where email = $1 limit 1")
            .bind(&email)
            .fetch_optional(db)
            .await?;
    if taken.is_some() {
        return Err(ReachError::new(
            409,
            "MAILBOX_EXISTS",
            format!("{email} already exists. Choose another name."),
        ));
    }
    let mailbox_id = generate_id("rmbx");
    let inbound_token = random_string(24, "abcdefghijklmnopqrstuvwxyz");
    // 2. Billing.
    adjust_inboxes(caller, state, 1, &mailbox_id)
        .await
        .map_err(BillingError::into_reach)?;
    let mut undo = Undo::default();
    let result = provision(
        caller,
        master,
        mailpool,
        workspace_id,
        settings,
        input,
        &email,
        &mailbox_id,
        &inbound_token,
        &inbound_domain,
        &mailpool_domain_id,
        warmup_key,
        now,
        &caller.keyring(state),
        &mut undo,
    )
    .await;
    match result {
        Ok(row) => Ok(row),
        Err(error) => {
            rollback(
                caller,
                state,
                master,
                mailpool,
                workspace_id,
                &mailbox_id,
                &email,
                &undo,
            )
            .await;
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn provision(
    caller: &Caller,
    master: &PgPool,
    mailpool: &Mailpool,
    workspace_id: &str,
    settings: &Value,
    input: &CreateInput,
    email: &str,
    mailbox_id: &str,
    inbound_token: &str,
    inbound_domain: &str,
    mailpool_domain_id: &str,
    warmup_key: Option<String>,
    now: time::OffsetDateTime,
    keyring: &weldsuite_db::Keyring,
    undo: &mut Undo,
) -> ReachResult<Value> {
    let db = &caller.db;
    // 3. A slot.
    ensure_slot_available(mailpool, &input.kind)
        .await
        .map_err(|e| upstream(&e))?;
    // 4. The mailbox.
    let mut body = Map::new();
    body.insert("email".to_owned(), json!(email));
    body.insert("firstName".to_owned(), json!(input.first_name));
    body.insert("lastName".to_owned(), json!(input.last_name));
    body.insert("type".to_owned(), json!(input.kind));
    if let Some(signature) = &input.signature {
        body.insert("signature".to_owned(), json!(signature));
    }
    body.insert(
        "forwardTo".to_owned(),
        json!(format!("reply+{inbound_token}@{inbound_domain}")),
    );
    let created = match mailpool.create_mailbox(&Value::Object(body)).await {
        Ok(created) => created,
        Err(error) if error.status == 0 || error.status >= 500 => {
            match find_stray(mailpool, mailpool_domain_id, email).await {
                Some(stray) => stray,
                None => return Err(upstream(&error)),
            }
        }
        Err(error) => return Err(upstream(&error)),
    };
    undo.mailpool_mailbox_id = Some(id_text(&created));
    if text(&created, "status") == Some("inactive") {
        return Err(ReachError::new(
            502,
            "UPSTREAM_ERROR",
            created
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("The mailbox provider could not activate the mailbox."),
        ));
    }
    // 5. Our own records.
    let smtp = smtp_credentials_of(&created);
    let imap = imap_credentials_of(&created);
    let logins = (text(&created, "status") == Some("active") && smtp.is_some() && imap.is_some())
        .then(|| (smtp.clone(), imap.clone()));
    let sealed = |c: &Option<MailServerCredentials>| -> ReachResult<Option<String>> {
        c.as_ref()
            .map(|c| seal(keyring, c).map_err(|e| ReachError::unexpected(&e)))
            .transpose()
    };
    let (smtp_sealed, imap_sealed) = (sealed(&smtp)?, sealed(&imap)?);
    let default_cap = int(settings, "defaultMailboxDailyCap");
    let row: Result<Value, sqlx::Error> = sqlx::query_scalar(
        "insert into reach_mailboxes (id, domain_id, mailpool_mailbox_id, email, first_name, last_name, signature, type,
             status, warmup_status, smtp_credentials, imap_credentials, inbound_token, warmup_started_at, daily_cap,
             ramp_current, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15, $16, $17)
         returning to_jsonb(reach_mailboxes)",
    )
    .bind(mailbox_id)
    .bind(&input.domain_id)
    .bind(undo.mailpool_mailbox_id.as_deref())
    .bind(email)
    .bind(&input.first_name)
    .bind(&input.last_name)
    .bind(&input.signature)
    .bind(&input.kind)
    .bind(if logins.is_some() { "warming" } else { "provisioning" })
    .bind(logins.is_some().then_some("waiting"))
    .bind(&smtp_sealed)
    .bind(&imap_sealed)
    .bind(inbound_token)
    .bind(logins.is_some().then(|| iso(now)))
    .bind(i32::try_from(default_cap).unwrap_or(30))
    .bind(i32::try_from(sending::RAMP_START.min(default_cap)).unwrap_or(10))
    .bind(&caller.user_id)
    .fetch_one(db)
    .await;
    let row = match row {
        Ok(row) => weldsuite_db::js_row(row),
        Err(error) if weldsuite_db::is_unique_violation(&error) => {
            return Err(ReachError::new(
                409,
                "MAILBOX_EXISTS",
                format!("{email} already exists. Choose another name."),
            ));
        }
        Err(error) => return Err(error.into()),
    };
    undo.tenant_row = true;
    if let Some((Some(smtp), Some(imap))) = logins {
        undo.pool = true;
        let deps = PoolDeps {
            db,
            master,
            warmup_key,
            clerk_org_id: &caller.clerk_org_id,
            workspace_id,
        };
        register_in_pool(
            &deps,
            &row,
            smtp,
            imap,
            text(settings, "defaultTimezone").map(str::to_owned),
        )
        .await?;
    }
    sqlx::query(
        "insert into reach_routes (id, kind, external_id, workspace_id, clerk_org_id, tenant_entity_id, mailbox_type, status)
         values ($1, 'mailpool_mailbox', $3, $5, $6, $7, $8, 'active'), ($2, 'inbound_token', $4, $5, $6, $7, $8, 'active')",
    )
    .bind(generate_id("rrt"))
    .bind(generate_id("rrt"))
    .bind(undo.mailpool_mailbox_id.as_deref())
    .bind(inbound_token)
    .bind(workspace_id)
    .bind(&caller.clerk_org_id)
    .bind(mailbox_id)
    .bind(&input.kind)
    .execute(master)
    .await?;
    undo.routes = true;
    weldsuite_db::due_index::mark_due(
        master,
        "reach_warmup",
        &caller.workspace_id,
        utc_tomorrow(now),
    )
    .await;
    Ok(row)
}

/// `ensureSlotAvailable(client, type)`.
pub(crate) async fn ensure_slot_available(
    mailpool: &Mailpool,
    kind: &str,
) -> Result<(), MailpoolError> {
    let (mailboxes, slots) = mailpool.get_slots().await?;
    let Some(total) = slots.get(kind).and_then(Value::as_f64) else {
        return Ok(());
    };
    let used = mailboxes.get(kind).and_then(Value::as_f64).unwrap_or(0.0);
    if used < total {
        return Ok(());
    }
    mailpool.increase_slots(kind, 1).await
}

async fn find_stray(mailpool: &Mailpool, domain_id: &str, email: &str) -> Option<Value> {
    let mailboxes = mailpool.list_mailboxes(domain_id, 100, 0).await.ok()?;
    mailboxes
        .into_iter()
        .find(|m| text(m, "email").is_some_and(|e| e.to_lowercase() == email.to_lowercase()))
}

#[allow(clippy::too_many_arguments)]
async fn rollback(
    caller: &Caller,
    state: &ReachState,
    master: &PgPool,
    mailpool: &Mailpool,
    workspace_id: &str,
    mailbox_id: &str,
    email: &str,
    undo: &Undo,
) {
    let log = |what: &str, error: &dyn std::fmt::Display| {
        tracing::error!(%error, email, "[reach-mailboxes] rollback: {what} failed");
    };
    if undo.pool
        && let Err(error) = warmup_pool::remove(master, &caller.clerk_org_id, mailbox_id).await
    {
        log("warmup pool", &error);
    }
    if (undo.routes || undo.tenant_row)
        && let Err(error) = sqlx::query(
            "delete from reach_routes where workspace_id = $1 and tenant_entity_id = $2
                 and kind in ('mailpool_mailbox', 'inbound_token')",
        )
        .bind(workspace_id)
        .bind(mailbox_id)
        .execute(master)
        .await
    {
        log("master routes", &error);
    }
    if undo.tenant_row
        && let Err(error) = sqlx::query("delete from reach_mailboxes where id = $1")
            .bind(mailbox_id)
            .execute(&caller.db)
            .await
    {
        log("tenant row", &error);
    }
    if let Some(id) = &undo.mailpool_mailbox_id
        && let Err(error) = mailpool.delete_mailbox(id).await
    {
        log("Mailpool mailbox", &error.message);
    }
    release_inbox(caller, state, mailbox_id).await;
}

/// The validated `updateReachMailboxSchema` body.
#[derive(Default)]
struct UpdateInput {
    first_name: Option<String>,
    last_name: Option<String>,
    /// `Some(None)`: cleared.
    signature: Option<Option<String>>,
    daily_cap: Option<i64>,
}

async fn update_one(
    State(state): State<ReachState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, body| UpdateInput {
        first_name: issues
            .text_with(
                body,
                "firstName",
                Presence::Optional,
                Text::trimmed(Some(1), Some(100)),
            )
            .into_option(),
        last_name: issues
            .text_with(
                body,
                "lastName",
                Presence::Optional,
                Text::trimmed(Some(1), Some(100)),
            )
            .into_option(),
        signature: match issues.text_with(
            body,
            "signature",
            Presence::Nullish,
            Text::length(None, Some(2000)),
        ) {
            weldsuite_kit::validation::Field::Set(s) => Some(Some(s)),
            weldsuite_kit::validation::Field::Null => Some(None),
            weldsuite_kit::validation::Field::Absent => None,
        },
        daily_cap: issues
            .whole_number(
                body,
                "dailyCap",
                Presence::Optional,
                Number {
                    coerce: false,
                    int: true,
                    min: Some(1.0),
                    max: Some(50.0),
                },
            )
            .into_option(),
    }) {
        Ok(input) => input,
        Err(response) => return response,
    };
    respond(
        async {
            account_workspace(&caller)?;
            let master = crate::require_master(&caller, &state)?;
            let mailpool = mailpool_of(&caller, &state)?;
            let db = &caller.db;
            let row = require_mailbox(db, &id).await?;
            if text(&row, "status") == Some("deleting") {
                return Err(ReachError::new(
                    409,
                    "MAILBOX_DELETING",
                    "The mailbox is being deleted.",
                ));
            }
            let mut remote = Map::new();
            if let Some(first) = &input.first_name
                && Some(first.as_str()) != text(&row, "firstName")
            {
                remote.insert("firstName".to_owned(), json!(first));
            }
            if let Some(last) = &input.last_name
                && Some(last.as_str()) != text(&row, "lastName")
            {
                remote.insert("lastName".to_owned(), json!(last));
            }
            if let Some(signature) = &input.signature {
                let next = signature.clone().unwrap_or_default();
                if next != text(&row, "signature").unwrap_or_default() {
                    remote.insert("signature".to_owned(), json!(next));
                }
            }
            if !remote.is_empty()
                && let Some(mailpool_id) = text(&row, "mailpoolMailboxId")
            {
                mailpool
                    .update_mailbox(mailpool_id, &Value::Object(remote.clone()))
                    .await
                    .map_err(|e| upstream(&e))?;
            }
            if remote.contains_key("firstName") || remote.contains_key("lastName") {
                warmup_pool::update_profile(
                    &master,
                    &caller.clerk_org_id,
                    &id,
                    remote.get("firstName").and_then(Value::as_str),
                    remote.get("lastName").and_then(Value::as_str),
                )
                .await?;
            }
            let ramp = input
                .daily_cap
                .filter(|cap| int(&row, "rampCurrent") > *cap);
            let updated: Option<Value> = sqlx::query_scalar(
                "update reach_mailboxes set updated_at = $2::timestamptz,
                     first_name = coalesce($3, first_name), last_name = coalesce($4, last_name),
                     signature = case when $5 then $6 else signature end,
                     daily_cap = coalesce($7, daily_cap), ramp_current = coalesce($8, ramp_current)
                 where id = $1 returning to_jsonb(reach_mailboxes)",
            )
            .bind(&id)
            .bind(iso(caller.now()))
            .bind(&input.first_name)
            .bind(&input.last_name)
            .bind(input.signature.is_some())
            .bind(input.signature.clone().flatten())
            .bind(input.daily_cap.map(|n| i32::try_from(n).unwrap_or(50)))
            .bind(ramp.map(|n| i32::try_from(n).unwrap_or(50)))
            .fetch_optional(db)
            .await?;
            let row = updated.map_or(row, weldsuite_db::js_row);
            caller.sink(&state).emit(ReachEvent::new(
                REACH_MAILBOX_UPDATED,
                &id,
                without_credentials(&row),
            ));
            let dto =
                weldsuite_reach_domain::mailboxes::get(db, &source(&caller, Some(&master)), &id)
                    .await?;
            Ok(Data(dto).into_response())
        }
        .await,
    )
}

/// `pauseMailbox(deps, id)`.
pub(crate) async fn pause_mailbox(
    db: &PgPool,
    master: &PgPool,
    clerk_org_id: &str,
    id: &str,
    at: &str,
) -> ReachResult<Value> {
    let row = require_mailbox(db, id).await?;
    let status = text(&row, "status").unwrap_or_default();
    if status == "paused" {
        return Ok(row);
    }
    if status != "warming" && status != "active" {
        return Err(ReachError::new(
            409,
            "MAILBOX_NOT_PAUSABLE",
            format!("A {status} mailbox cannot be paused."),
        ));
    }
    warmup_pool::pause(master, clerk_org_id, id, pause_reasons::USER).await?;
    let updated: Option<Value> = sqlx::query_scalar(
        "update reach_mailboxes set status = 'paused', paused_reason = 'user', updated_at = $2::timestamptz
         where id = $1 returning to_jsonb(reach_mailboxes)",
    )
    .bind(id)
    .bind(at)
    .fetch_optional(db)
    .await?;
    Ok(updated.map_or(row, weldsuite_db::js_row))
}

async fn pause(
    State(state): State<ReachState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    respond(
        async {
            account_workspace(&caller)?;
            let master = crate::require_master(&caller, &state)?;
            let row = pause_mailbox(
                &caller.db,
                &master,
                &caller.clerk_org_id,
                &id,
                &iso(caller.now()),
            )
            .await?;
            caller.sink(&state).emit(ReachEvent::new(
                REACH_MAILBOX_UPDATED,
                text(&row, "id").unwrap_or(&id),
                without_credentials(&row),
            ));
            let dto = weldsuite_reach_domain::mailboxes::get(
                &caller.db,
                &source(&caller, Some(&master)),
                &id,
            )
            .await?;
            Ok(Data(dto).into_response())
        }
        .await,
    )
}

async fn resume(
    State(state): State<ReachState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    respond(
        async {
            account_workspace(&caller)?;
            let master = crate::require_master(&caller, &state)?;
            let db = &caller.db;
            let row = require_mailbox(db, &id).await?;
            let status = text(&row, "status").unwrap_or_default().to_owned();
            let row = if status == "warming" || status == "active" {
                row
            } else {
                if status != "paused" {
                    return Err(ReachError::new(
                        409,
                        "MAILBOX_NOT_RESUMABLE",
                        format!("A {status} mailbox cannot be resumed."),
                    ));
                }
                let domain_status: Option<String> =
                    sqlx::query_scalar("select status from reach_domains where id = $1 limit 1")
                        .bind(text(&row, "domainId"))
                        .fetch_optional(db)
                        .await?;
                if domain_status.as_deref() != Some("active") {
                    return Err(ReachError::new(409, "DOMAIN_NOT_ACTIVE", "The domain of this mailbox is not active."));
                }
                warmup_pool::resume(&master, &caller.clerk_org_id, &id).await?;
                let updated: Option<Value> = sqlx::query_scalar(
                    "update reach_mailboxes set status = $2, paused_reason = null, updated_at = $3::timestamptz
                     where id = $1 returning to_jsonb(reach_mailboxes)",
                )
                .bind(&id)
                .bind(resume_status_for(&row))
                .bind(iso(caller.now()))
                .fetch_optional(db)
                .await?;
                updated.map_or(row, weldsuite_db::js_row)
            };
            caller
                .sink(&state)
                .emit(ReachEvent::new(REACH_MAILBOX_UPDATED, text(&row, "id").unwrap_or(&id), without_credentials(&row)));
            let dto = weldsuite_reach_domain::mailboxes::get(db, &source(&caller, Some(&master)), &id).await?;
            Ok(Data(dto).into_response())
        }
        .await,
    )
}

async fn delete_one(
    State(state): State<ReachState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    respond(
        async {
            let (workspace_id, _) = account_workspace(&caller)?;
            let master = crate::require_master(&caller, &state)?;
            let mailpool = mailpool_of(&caller, &state)?;
            let db = &caller.db;
            let at = iso(caller.now());
            let row = require_mailbox(db, &id).await?;
            if text(&row, "status") != Some("deleting") {
                sqlx::query("update reach_mailboxes set status = 'deleting', updated_at = $2::timestamptz where id = $1")
                    .bind(&id)
                    .bind(&at)
                    .execute(db)
                    .await?;
            }
            if let Some(mailpool_id) = text(&row, "mailpoolMailboxId")
                && let Err(error) = mailpool.delete_mailbox(mailpool_id).await
                && !error.is_not_found()
            {
                sqlx::query("update reach_mailboxes set status = $2, updated_at = $3::timestamptz where id = $1")
                    .bind(&id)
                    .bind(text(&row, "status"))
                    .bind(&at)
                    .execute(db)
                    .await?;
                return Err(upstream(&error));
            }
            warmup_pool::remove(&master, &caller.clerk_org_id, &id).await?;
            sqlx::query(
                "update reach_routes set status = 'deleted', updated_at = $3::timestamptz
                 where workspace_id = $1 and tenant_entity_id = $2 and kind in ('mailpool_mailbox', 'inbound_token')",
            )
            .bind(&workspace_id)
            .bind(&id)
            .bind(&at)
            .execute(&master)
            .await?;
            sqlx::query("delete from reach_campaign_mailboxes where mailbox_id = $1")
                .bind(&id)
                .execute(db)
                .await?;
            sqlx::query(
                "update reach_enrollments set mailbox_id = null, updated_at = $2::timestamptz
                 where mailbox_id = $1 and status in ('queued', 'active', 'paused')",
            )
            .bind(&id)
            .bind(&at)
            .execute(db)
            .await?;
            let deleted: Option<Value> = sqlx::query_scalar(
                "update reach_mailboxes set status = 'deleted', deleted_at = $2::timestamptz, smtp_credentials = null,
                     imap_credentials = null, paused_reason = null, updated_at = $2::timestamptz
                 where id = $1 returning to_jsonb(reach_mailboxes)",
            )
            .bind(&id)
            .bind(&at)
            .fetch_optional(db)
            .await?;
            release_inbox(&caller, &state, &id).await;
            let deleted = deleted.map_or(row, weldsuite_db::js_row);
            caller
                .sink(&state)
                .emit(ReachEvent::new(REACH_MAILBOX_DELETED, text(&deleted, "id").unwrap_or(&id), without_credentials(&deleted)));
            Ok(NoContent.into_response())
        }
        .await,
    )
}
