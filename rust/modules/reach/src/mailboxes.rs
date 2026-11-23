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
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QuerySelect,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events::{
    REACH_MAILBOX_CREATED, REACH_MAILBOX_DELETED, REACH_MAILBOX_UPDATED,
};
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::{orm, orm_error};
use weldsuite_kit::validation::{Number, Presence, Text};
use weldsuite_kit::{Data, List, NoContent, Pagination, generate_id, random_string};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_reach_domain::access::utc_tomorrow;
use weldsuite_reach_domain::credentials::{MailServerCredentials, seal};
use weldsuite_reach_domain::mailboxes::{WarmupSource, without_credentials};
use weldsuite_reach_domain::schemas::sending;
use weldsuite_reach_domain::warmup::gate;
use weldsuite_reach_domain::warmup_pool::{self, PoolError, RegisterInput};
use weldsuite_reach_domain::{EventSink, ReachError, ReachEvent, ReachResult, int, text};
use weldsuite_schema::master::reach_routes;
use weldsuite_schema::tenant::{
    reach_campaign_mailboxes, reach_domains, reach_enrollments, reach_mailboxes,
};

use crate::account::get_or_create_settings;
use crate::billing::{BillingError, adjust_inboxes, release_inbox};
use crate::domains::mailpool_of;
use crate::mailpool::{
    Mailpool, MailpoolError, id_text, imap_credentials_of, smtp_credentials_of, upstream,
};
use crate::{
    Caller, ReachState, account_workspace, db_error, respond, row_json, validate, validate_query,
};

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
    let row = reach_mailboxes::Entity::find_by_id(id.to_owned())
        .filter(reach_mailboxes::Column::Status.ne("deleted"))
        .one(&orm(db))
        .await
        .map_err(db_error)?
        .map(row_json)
        .transpose()?;
    row.ok_or_else(|| {
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
        PoolError::Database(error) => db_error(orm_error(error)),
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

/// The master routes of a mailbox.
const MAILBOX_ROUTE_KINDS: [&str; 2] = ["mailpool_mailbox", "inbound_token"];

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
    let domain = reach_domains::Entity::find_by_id(input.domain_id.clone())
        .one(&orm(db))
        .await
        .map_err(db_error)?
        .map(row_json)
        .transpose()?;
    let Some(domain) = domain else {
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
    let existing = live_inbox_count(db).await.map_err(db_error)?;
    if existing >= limits.max_mailboxes {
        return Err(ReachError::new(
            403,
            "MAILBOX_LIMIT_REACHED",
            "The mailbox limit for this workspace is reached.",
        )
        .with_details(json!({ "limit": limits.max_mailboxes, "current": existing })));
    }
    // With inboxes on the plan's charge, `canceled` means the plan ended:
    // plan billing refuses the inbox itself (402 `PAID_PLAN_REQUIRED`).
    if billing_status == "canceled" && existing > 0 && state.inbox_billing.is_none() {
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
    let taken: Option<String> = reach_mailboxes::Entity::find()
        .select_only()
        .column(reach_mailboxes::Column::Id)
        .filter(reach_mailboxes::Column::Email.eq(&email))
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(db_error)?;
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
    let row = reach_mailboxes::Entity::insert(reach_mailboxes::ActiveModel {
        id: Set(mailbox_id.to_owned()),
        domain_id: Set(input.domain_id.clone()),
        mailpool_mailbox_id: Set(undo.mailpool_mailbox_id.clone()),
        email: Set(email.to_owned()),
        first_name: Set(input.first_name.clone()),
        last_name: Set(input.last_name.clone()),
        signature: Set(input.signature.clone()),
        type_: Set(input.kind.clone()),
        status: Set(if logins.is_some() { "warming" } else { "provisioning" }.to_owned()),
        warmup_status: Set(logins.is_some().then(|| "waiting".to_owned())),
        smtp_credentials: Set(smtp_sealed),
        imap_credentials: Set(imap_sealed),
        inbound_token: Set(inbound_token.to_owned()),
        warmup_started_at: Set(logins.is_some().then_some(now)),
        daily_cap: Set(i32::try_from(default_cap).unwrap_or(30)),
        ramp_current: Set(i32::try_from(sending::RAMP_START.min(default_cap)).unwrap_or(10)),
        created_by: Set(Some(caller.user_id.clone())),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await;
    let row = match row {
        Ok(row) => row_json(row)?,
        Err(error) if weldsuite_db::is_unique_violation(&error) => {
            return Err(ReachError::new(
                409,
                "MAILBOX_EXISTS",
                format!("{email} already exists. Choose another name."),
            ));
        }
        Err(error) => return Err(db_error(error)),
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
    let route = |kind: &str, external_id: Option<String>| reach_routes::ActiveModel {
        id: Set(generate_id("rrt")),
        kind: Set(kind.to_owned()),
        external_id: Set(external_id.unwrap_or_default()),
        workspace_id: Set(workspace_id.to_owned()),
        clerk_org_id: Set(caller.clerk_org_id.clone()),
        tenant_entity_id: Set(mailbox_id.to_owned()),
        mailbox_type: Set(Some(input.kind.clone())),
        status: Set("active".to_owned()),
        ..Default::default()
    };
    reach_routes::Entity::insert_many([
        route("mailpool_mailbox", undo.mailpool_mailbox_id.clone()),
        route("inbound_token", Some(inbound_token.to_owned())),
    ])
    .exec_without_returning(&orm(master))
    .await
    .map_err(db_error)?;
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
        && let Err(error) = reach_routes::Entity::delete_many()
            .filter(reach_routes::Column::WorkspaceId.eq(workspace_id))
            .filter(reach_routes::Column::TenantEntityId.eq(mailbox_id))
            .filter(reach_routes::Column::Kind.is_in(MAILBOX_ROUTE_KINDS))
            .exec(&orm(master))
            .await
    {
        log("master routes", &error);
    }
    if undo.tenant_row
        && let Err(error) = reach_mailboxes::Entity::delete_by_id(mailbox_id.to_owned())
            .exec(&orm(&caller.db))
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
            let row = update_fields(db, &id, &input, ramp, caller.now())
                .await?
                .unwrap_or(row);
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

/// `update reach_mailboxes set first_name = coalesce(…), …` with the
/// fields the body sent: the row as the routes answer it, `None` when it is
/// gone.
async fn update_fields(
    db: &PgPool,
    id: &str,
    input: &UpdateInput,
    ramp: Option<i64>,
    at: OffsetDateTime,
) -> ReachResult<Option<Value>> {
    use reach_mailboxes::Column;
    let mut update =
        reach_mailboxes::Entity::update_many().col_expr(Column::UpdatedAt, Expr::value(at));
    if let Some(first) = &input.first_name {
        update = update.col_expr(Column::FirstName, Expr::value(first));
    }
    if let Some(last) = &input.last_name {
        update = update.col_expr(Column::LastName, Expr::value(last));
    }
    if let Some(signature) = &input.signature {
        update = update.col_expr(Column::Signature, Expr::value(signature.clone()));
    }
    if let Some(cap) = input.daily_cap {
        update = update.col_expr(
            Column::DailyCap,
            Expr::value(i32::try_from(cap).unwrap_or(50)),
        );
    }
    if let Some(ramp) = ramp {
        update = update.col_expr(
            Column::RampCurrent,
            Expr::value(i32::try_from(ramp).unwrap_or(50)),
        );
    }
    update
        .filter(Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await
        .map_err(db_error)?
        .into_iter()
        .next()
        .map(row_json)
        .transpose()
}

/// `pauseMailbox(deps, id)`.
pub(crate) async fn pause_mailbox(
    db: &PgPool,
    master: &PgPool,
    clerk_org_id: &str,
    id: &str,
    at: OffsetDateTime,
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
    let updated = set_status(db, id, "paused", Some("user"), at).await?;
    Ok(updated.unwrap_or(row))
}

/// `update reach_mailboxes set status, paused_reason, updated_at … returning *`:
/// the row as the routes answer it, `None` when it is gone.
async fn set_status(
    db: &PgPool,
    id: &str,
    status: &str,
    paused_reason: Option<&str>,
    at: OffsetDateTime,
) -> ReachResult<Option<Value>> {
    reach_mailboxes::Entity::update_many()
        .col_expr(reach_mailboxes::Column::Status, Expr::value(status))
        .col_expr(
            reach_mailboxes::Column::PausedReason,
            Expr::value(paused_reason.map(str::to_owned)),
        )
        .col_expr(reach_mailboxes::Column::UpdatedAt, Expr::value(at))
        .filter(reach_mailboxes::Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await
        .map_err(db_error)?
        .into_iter()
        .next()
        .map(row_json)
        .transpose()
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
                caller.now(),
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
                let domain_status: Option<String> = reach_domains::Entity::find()
                    .select_only()
                    .column(reach_domains::Column::Status)
                    .filter(reach_domains::Column::Id.eq(text(&row, "domainId")))
                    .into_tuple()
                    .one(&orm(db))
                    .await
                    .map_err(db_error)?;
                if domain_status.as_deref() != Some("active") {
                    return Err(ReachError::new(409, "DOMAIN_NOT_ACTIVE", "The domain of this mailbox is not active."));
                }
                warmup_pool::resume(&master, &caller.clerk_org_id, &id).await?;
                let updated = set_status(db, &id, resume_status_for(&row), None, caller.now()).await?;
                updated.unwrap_or(row)
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
            let at = caller.now();
            let row = require_mailbox(db, &id).await?;
            if text(&row, "status") != Some("deleting") {
                set_status_only(db, &id, Some("deleting"), at).await?;
            }
            if let Some(mailpool_id) = text(&row, "mailpoolMailboxId")
                && let Err(error) = mailpool.delete_mailbox(mailpool_id).await
                && !error.is_not_found()
            {
                set_status_only(db, &id, text(&row, "status"), at).await?;
                return Err(upstream(&error));
            }
            warmup_pool::remove(&master, &caller.clerk_org_id, &id).await?;
            reach_routes::Entity::update_many()
                .col_expr(reach_routes::Column::Status, Expr::value("deleted"))
                .col_expr(reach_routes::Column::UpdatedAt, Expr::value(at))
                .filter(reach_routes::Column::WorkspaceId.eq(&workspace_id))
                .filter(reach_routes::Column::TenantEntityId.eq(&id))
                .filter(reach_routes::Column::Kind.is_in(MAILBOX_ROUTE_KINDS))
                .exec(&orm(&master))
                .await
                .map_err(db_error)?;
            reach_campaign_mailboxes::Entity::delete_many()
                .filter(reach_campaign_mailboxes::Column::MailboxId.eq(&id))
                .exec(&orm(db))
                .await
                .map_err(db_error)?;
            reach_enrollments::Entity::update_many()
                .col_expr(reach_enrollments::Column::MailboxId, Expr::null())
                .col_expr(reach_enrollments::Column::UpdatedAt, Expr::value(at))
                .filter(reach_enrollments::Column::MailboxId.eq(&id))
                .filter(reach_enrollments::Column::Status.is_in(["queued", "active", "paused"]))
                .exec(&orm(db))
                .await
                .map_err(db_error)?;
            let deleted = reach_mailboxes::Entity::update_many()
                .col_expr(reach_mailboxes::Column::Status, Expr::value("deleted"))
                .col_expr(reach_mailboxes::Column::DeletedAt, Expr::value(at))
                .col_expr(reach_mailboxes::Column::SmtpCredentials, Expr::null())
                .col_expr(reach_mailboxes::Column::ImapCredentials, Expr::null())
                .col_expr(reach_mailboxes::Column::PausedReason, Expr::null())
                .col_expr(reach_mailboxes::Column::UpdatedAt, Expr::value(at))
                .filter(reach_mailboxes::Column::Id.eq(&id))
                .exec_with_returning(&orm(db))
                .await
                .map_err(db_error)?
                .into_iter()
                .next();
            release_inbox(&caller, &state, &id).await;
            let deleted = match deleted {
                Some(deleted) => row_json(deleted)?,
                None => row,
            };
            caller
                .sink(&state)
                .emit(ReachEvent::new(REACH_MAILBOX_DELETED, text(&deleted, "id").unwrap_or(&id), without_credentials(&deleted)));
            Ok(NoContent.into_response())
        }
        .await,
    )
}

/// A text column as `$patch::jsonb->>'key'` reads it.
fn patch_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

/// `update reach_mailboxes m set <column> = case when $patch ? '<key>' then
/// $patch->>'<key>' else m.<column> end, …, updated_at = at where m.id = id
/// returning *` (the warmup sweep's `save` and the webhook's
/// `updateMailbox`): the columns the patch names (camelCase keys), the row
/// as the routes answer it, `None` when it is gone.
pub(crate) async fn patch_mailbox(
    db: &PgPool,
    id: &str,
    patch: &Map<String, Value>,
    at: OffsetDateTime,
) -> ReachResult<Option<Value>> {
    use reach_mailboxes::Column;
    let whole = |value: &Value| value.as_i64().map(|n| i32::try_from(n).unwrap_or_default());
    let instant = |value: &Value| value.as_str().and_then(weldsuite_reach_domain::parse_iso);
    let numeric = |value: &Value| match value {
        Value::Number(n) => n.to_string().parse::<sea_orm::prelude::BigDecimal>().ok(),
        _ => None,
    };
    let mut update = reach_mailboxes::Entity::update_many();
    for (key, value) in patch {
        let (column, expr) = match key.as_str() {
            "status" => (Column::Status, Expr::value(patch_text(value))),
            "pausedReason" => (Column::PausedReason, Expr::value(patch_text(value))),
            "lastError" => (Column::LastError, Expr::value(patch_text(value))),
            "smtpCredentials" => (Column::SmtpCredentials, Expr::value(patch_text(value))),
            "imapCredentials" => (Column::ImapCredentials, Expr::value(patch_text(value))),
            "warmupStartedAt" => (Column::WarmupStartedAt, Expr::value(instant(value))),
            "warmupStatus" => (Column::WarmupStatus, Expr::value(patch_text(value))),
            "warmupDay" => (Column::WarmupDay, Expr::value(whole(value))),
            "warmupInboxRate" => (Column::WarmupInboxRate, Expr::value(numeric(value))),
            "rampCurrent" => (Column::RampCurrent, Expr::value(whole(value))),
            "rampUpdatedAt" => (Column::RampUpdatedAt, Expr::value(instant(value))),
            _ => continue,
        };
        update = update.col_expr(column, expr);
    }
    update
        .col_expr(Column::UpdatedAt, Expr::value(crate::effects::to_ms(at)))
        .filter(Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await
        .map_err(db_error)?
        .into_iter()
        .next()
        .map(row_json)
        .transpose()
}

/// `update reach_mailboxes set status = …, updated_at = … where id = …`.
async fn set_status_only(
    db: &PgPool,
    id: &str,
    status: Option<&str>,
    at: OffsetDateTime,
) -> ReachResult<()> {
    reach_mailboxes::Entity::update_many()
        .col_expr(
            reach_mailboxes::Column::Status,
            Expr::value(status.map(str::to_owned)),
        )
        .col_expr(reach_mailboxes::Column::UpdatedAt, Expr::value(at))
        .filter(reach_mailboxes::Column::Id.eq(id))
        .exec(&orm(db))
        .await
        .map_err(db_error)?;
    Ok(())
}

/// The workspace's inboxes that count (every one not deleted): what an
/// inbox subscription bills.
pub async fn live_inbox_count(db: &PgPool) -> Result<i64, DbErr> {
    let count = reach_mailboxes::Entity::find()
        .filter(reach_mailboxes::Column::Status.ne("deleted"))
        .filter(reach_mailboxes::Column::DeletedAt.is_null())
        .count(&orm(db))
        .await?;
    Ok(i64::try_from(count).unwrap_or(i64::MAX))
}
