//! `/api/w9-requests` (`routes/w9-requests/index.ts`): online W-9 requests,
//! the link a vendor opens to fill in their W-9 (the public form is
//! [`crate::public_w9`]). Only the token's hash is stored; the workspace
//! cache maps `w9:<hash>` to `{ orgId, requestId }` until the request is
//! completed, cancelled or expires.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, now, now_ms, ok, paged, reply, validate,
};
use weldsuite_books_domain::tables::W9_REQUESTS;
use weldsuite_books_domain::vendor_tax::{
    W9_DEFAULT_EXPIRY_DAYS, W9_MAX_EXPIRY_DAYS, generate_w9_token, sha256_hex, to_w9_request_view,
    w9_event_data, w9_kv_key, w9_url,
};
use weldsuite_catalogs::entity_events::{W9_REQUEST_CREATED, W9_REQUEST_UPDATED};
use weldsuite_kit::validation::{Field, Format, Number, Presence, Text};
use weldsuite_kit::{ApiError, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |keys: &[&str]| gate.require(keys.iter().map(|k| (*k).to_owned()));
    Router::new()
        .route(
            "/",
            get(list).route_layer(need(&["suppliers:read", "taxes:read"])),
        )
        .route(
            "/",
            post(create).route_layer(need(&["suppliers:update", "taxes:create"])),
        )
        .route(
            "/{id}",
            get(detail).route_layer(need(&["suppliers:read", "taxes:read"])),
        )
        .route(
            "/{id}/cancel",
            post(cancel).route_layer(need(&["suppliers:update", "taxes:update"])),
        )
        .with_state(state)
}

/// The cache entry of a token, removed (`WORKSPACE_CACHE.delete`).
async fn forget_token(caller: &Caller, state: &BooksState, hash: &str) -> Result<(), Refusal> {
    let Some(cache) = caller.cache(state) else {
        return Err(Refusal::Internal("WORKSPACE_CACHE is not bound".to_owned()));
    };
    cache
        .delete_boxed(&w9_kv_key(hash))
        .await
        .map_err(|error| Refusal::Internal(format!("{error:?}")))
}

fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let q = Query::parse(raw.as_deref());
    reply(
        list_requests(&caller, &q).await,
        "Failed to fetch W-9 requests",
    )
}

/// The list filters: entity, `?partyId=`, `?status=` (`expired` is also a pending
/// request past its date).
macro_rules! w9_where {
    () => {
        "t.entity_id = $1 and ($2::text is null or t.party_id = $2) and ($3::text is null \n         or ($3 = 'expired' and (t.status = 'expired' or (t.status = 'pending' and t.expires_at <= $4::timestamp))) \n         or ($3 = 'pending' and t.status = 'pending' and t.expires_at > $4::timestamp) \n         or ($3 not in ('expired', 'pending') and t.status = $3))"
    };
}

async fn list_requests(caller: &Caller, q: &Query) -> Reply {
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    // `Number.parseInt(q.limit || '50', 10) || 50`, between 1 and 100.
    let limit = q
        .present("limit")
        .and_then(weldsuite_books_domain::js::parse_int)
        .filter(|n| *n != 0)
        .unwrap_or(50)
        .clamp(1, 100);
    let status = q
        .present("status")
        .filter(|s| ["pending", "completed", "expired", "cancelled"].contains(s));
    let now = now();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(w9_requests),
        " from w9_requests t where ",
        w9_where!(),
        " order by t.created_at desc limit $5"
    ))
    .bind(&entity_id)
    .bind(q.present("partyId"))
    .bind(status)
    .bind(&now)
    .bind(limit)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*)::bigint from w9_requests t where ",
        w9_where!()
    ))
    .bind(&entity_id)
    .bind(q.present("partyId"))
    .bind(status)
    .bind(&now)
    .fetch_one(&caller.db)
    .await?;
    let at = now_ms();
    let rows: Vec<Value> = W9_REQUESTS
        .js_rows(rows)
        .iter()
        .map(|row| to_w9_request_view(row, at))
        .collect();
    let shown = i64::try_from(rows.len()).unwrap_or(0);
    Ok(paged(rows, total, total > shown, None))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn find(db: &sqlx::PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(w9_requests),
        " from w9_requests t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| W9_REQUESTS.js(row)))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        match find(&caller.db, &id).await? {
            Some(row) => Ok(ok(to_w9_request_view(&row, now_ms()))),
            None => Err(Refusal::not_found("W-9 request", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch the W-9 request")
}

// ── POST / ──────────────────────────────────────────────────────────────────

struct CreateBody {
    party_id: String,
    email: Option<String>,
    expires_in_days: i64,
}

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let body = match validate(&headers, &raw, |issues, body| {
        let party_id = issues.text(body, "partyId", Presence::Required, Some(1), Some(30));
        let email = issues.text_with(
            body,
            "email",
            Presence::Optional,
            Text {
                trim: true,
                format: Some(Format::Email),
                max: Some(255),
                ..Text::default()
            },
        );
        let days = issues.whole_number(
            body,
            "expiresInDays",
            Presence::Optional,
            Number {
                min: Some(1.0),
                #[allow(clippy::cast_precision_loss)]
                max: Some(W9_MAX_EXPIRY_DAYS as f64),
                ..Number::default()
            },
        );
        CreateBody {
            party_id: party_id.into_option().unwrap_or_default(),
            email: email.into_option(),
            expires_in_days: match days {
                Field::Set(days) => days,
                _ => W9_DEFAULT_EXPIRY_DAYS,
            },
        }
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(""),
    };
    let Some(org_id) = caller.org_id.clone() else {
        return Refusal::from(ApiError::org_required()).respond("");
    };
    reply(
        create_request(&caller, &state, &org_id, body).await,
        "Failed to create the W-9 request",
    )
}

#[allow(clippy::too_many_lines)] // the route's steps, as TypeScript has them
async fn create_request(
    caller: &Caller,
    state: &BooksState,
    org_id: &str,
    body: CreateBody,
) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let party: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "select id, company_id, person_id from parties where id = $1 and deleted_at is null limit 1",
    )
    .bind(&body.party_id)
    .fetch_optional(db)
    .await?;
    let Some((party_id, company_id, person_id)) = party else {
        return Err(Refusal::not_found("Contact", &body.party_id));
    };

    let mut email = body.email.clone();
    let empty = |e: &Option<String>| e.as_deref().is_none_or(str::is_empty);
    if empty(&email) && company_id.as_deref().is_some_and(|id| !id.is_empty()) {
        let found: Option<Option<String>> =
            sqlx::query_scalar("select email from companies where id = $1 limit 1")
                .bind(&company_id)
                .fetch_optional(db)
                .await?;
        email = found.flatten();
    } else if empty(&email) && person_id.as_deref().is_some_and(|id| !id.is_empty()) {
        let found: Option<Option<String>> =
            sqlx::query_scalar("select email from people where id = $1 limit 1")
                .bind(&person_id)
                .fetch_optional(db)
                .await?;
        email = found.flatten();
    }

    let started = now_ms();
    let now = weldsuite_books_domain::js::iso_from_millis(started).unwrap_or_else(now);
    let superseded: Vec<Value> = sqlx::query_scalar(concat!(
        "update w9_requests t set status = 'cancelled', updated_at = $2::timestamp \
         where t.party_id = $1 and t.status = 'pending' returning ",
        weldsuite_books_domain::books_row!(w9_requests)
    ))
    .bind(&party_id)
    .bind(&now)
    .fetch_all(db)
    .await?;
    for old in W9_REQUESTS.js_rows(superseded) {
        forget_token(caller, state, text(&old, "tokenHash").unwrap_or_default()).await?;
        let id = text(&old, "id").unwrap_or_default().to_owned();
        caller.publish(
            state,
            W9_REQUEST_UPDATED,
            &id,
            w9_event_data(&old, Map::new()),
        );
    }

    let token = generate_w9_token();
    let hash = sha256_hex(&token);
    let expires_ms = started + body.expires_in_days * 86_400_000;
    let expires_at =
        weldsuite_books_domain::js::iso_from_millis(expires_ms).unwrap_or_else(|| now.clone());
    let id = generate_id("w9r");
    let row: Value = sqlx::query_scalar(concat!(
        "insert into w9_requests as t (id, entity_id, party_id, email, token_hash, status, expires_at, requested_by, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, 'pending', $6::timestamp, $7, $8::timestamp, $8::timestamp) returning ",
        weldsuite_books_domain::books_row!(w9_requests)
    ))
    .bind(&id)
    .bind(&entity_id)
    .bind(&party_id)
    .bind(&email)
    .bind(&hash)
    .bind(&expires_at)
    .bind(caller.user())
    .bind(&now)
    .fetch_one(db)
    .await?;
    let row = W9_REQUESTS.js(row);

    let Some(cache) = caller.cache(state) else {
        return Err(Refusal::Internal("WORKSPACE_CACHE is not bound".to_owned()));
    };
    let entry = json!({ "orgId": org_id, "requestId": id }).to_string();
    // KV needs at least 60 seconds.
    let ttl = ((expires_ms - started) / 1000).max(60);
    cache
        .put_boxed(
            &w9_kv_key(&hash),
            &entry,
            Some(Duration::from_secs(u64::try_from(ttl).unwrap_or(60))),
        )
        .await
        .map_err(|error| Refusal::Internal(format!("{error:?}")))?;

    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "w9_request",
            entity_id: &id,
            action: "created",
            changes: None,
        },
    )
    .await;
    caller.publish(
        state,
        W9_REQUEST_CREATED,
        &id,
        w9_event_data(&row, Map::new()),
    );
    Ok(created(json!({
        "request": to_w9_request_view(&row, now_ms()),
        "url": w9_url(caller.env(state, "PLATFORM_URL"), &token),
        "emailSent": false,
    })))
}

// ── POST /:id/cancel ────────────────────────────────────────────────────────

async fn cancel(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Reply = async {
        let db = &caller.db;
        let Some(row) = find(db, &id).await? else {
            return Err(Refusal::not_found("W-9 request", &id));
        };
        let status = text(&row, "status").unwrap_or_default();
        if status != "pending" {
            return Err(Refusal::conflict(format!(
                "This request is {status} and can't be cancelled"
            )));
        }
        let updated: Option<Value> = sqlx::query_scalar(concat!(
            "update w9_requests t set status = 'cancelled', updated_at = $2::timestamp \
             where t.id = $1 and t.status = 'pending' returning ",
            weldsuite_books_domain::books_row!(w9_requests)
        ))
        .bind(&id)
        .bind(now())
        .fetch_optional(db)
        .await?;
        let Some(updated) = updated.map(|row| W9_REQUESTS.js(row)) else {
            return Err(Refusal::conflict("This request is no longer pending"));
        };
        forget_token(&caller, &state, text(&row, "tokenHash").unwrap_or_default()).await?;
        write_accounting_audit(
            &caller,
            db,
            AuditInput {
                accounting_entity_id: text(&row, "entityId"),
                entity_type: "w9_request",
                entity_id: &id,
                action: "cancelled",
                changes: None,
            },
        )
        .await;
        caller.publish(
            &state,
            W9_REQUEST_UPDATED,
            &id,
            w9_event_data(&updated, Map::new()),
        );
        Ok(ok(to_w9_request_view(&updated, now_ms())))
    }
    .await;
    reply(result, "Failed to cancel the W-9 request")
}
