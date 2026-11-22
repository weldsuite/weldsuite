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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Query, Refusal, Reply, created, now, now_ms, ok, paged, reply, validate,
};
use weldsuite_books_domain::vendor_tax::{
    W9_DEFAULT_EXPIRY_DAYS, W9_MAX_EXPIRY_DAYS, generate_w9_token, sha256_hex, to_w9_request_view,
    w9_event_data, w9_kv_key, w9_url,
};
use weldsuite_catalogs::entity_events::{W9_REQUEST_CREATED, W9_REQUEST_UPDATED};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Format, Number, Presence, Text};
use weldsuite_kit::{ApiError, generate_id};
use weldsuite_legal_entities::{EntityRecordGuard, EntityTable};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{companies, parties, people, w9_requests};

use crate::orm_bridge::refused;
use crate::rows::{js, js_rows, timestamp_of_millis};

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
        // A record of an entity the request may not touch answers 404
        // (per-entity access; books-api `guardEntityRecords`).
        .route_layer(
            EntityRecordGuard::table(EntityTable::new("w9_requests"), "W-9 request").layer(),
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
fn w9_where(
    entity_id: &str,
    party_id: Option<&str>,
    status: Option<&str>,
    now: time::PrimitiveDateTime,
) -> Condition {
    use w9_requests::Column;
    let mut condition = Condition::all().add(Column::EntityId.eq(entity_id));
    if let Some(party_id) = party_id {
        condition = condition.add(Column::PartyId.eq(party_id));
    }
    let pending = || Condition::all().add(Column::Status.eq("pending"));
    match status {
        None => {}
        Some("expired") => {
            condition = condition.add(
                Condition::any()
                    .add(Column::Status.eq("expired"))
                    .add(pending().add(Column::ExpiresAt.lte(now))),
            );
        }
        Some("pending") => condition = condition.add(pending().add(Column::ExpiresAt.gt(now))),
        Some(status) => condition = condition.add(Column::Status.eq(status)),
    }
    condition
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
    let now = utc_now();
    let listed = || w9_where(&entity_id, q.present("partyId"), status, now);
    let db = orm(&caller.db);
    let rows = w9_requests::Entity::find()
        .filter(listed())
        .order_by_desc(w9_requests::Column::CreatedAt)
        .limit(u64::try_from(limit).unwrap_or(0))
        .all(&db)
        .await
        .map_err(refused)?;
    let total = w9_requests::Entity::find()
        .filter(listed())
        .count(&db)
        .await
        .map_err(refused)?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let at = now_ms();
    let rows: Vec<Value> = js_rows!(rows)
        .map_err(refused)?
        .iter()
        .map(|row| to_w9_request_view(row, at))
        .collect();
    let shown = i64::try_from(rows.len()).unwrap_or(0);
    Ok(paged(rows, total, total > shown, None))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn find(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    w9_requests::Entity::find_by_id(id)
        .one(&orm(db))
        .await?
        .map(|row| js!(row))
        .transpose()
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        match find(&caller.db, &id).await.map_err(refused)? {
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
    let party: Option<(String, Option<String>, Option<String>)> = parties::Entity::find()
        .select_only()
        .columns([
            parties::Column::Id,
            parties::Column::CompanyId,
            parties::Column::PersonId,
        ])
        .filter(parties::Column::Id.eq(body.party_id.as_str()))
        .filter(parties::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await
        .map_err(refused)?;
    let Some((party_id, company_id, person_id)) = party else {
        return Err(Refusal::not_found("Contact", &body.party_id));
    };

    let mut email = body.email.clone();
    let empty = |e: &Option<String>| e.as_deref().is_none_or(str::is_empty);
    if empty(&email) && company_id.as_deref().is_some_and(|id| !id.is_empty()) {
        let found: Option<Option<String>> = companies::Entity::find()
            .select_only()
            .column(companies::Column::Email)
            .filter(companies::Column::Id.eq(company_id.as_deref()))
            .into_tuple()
            .one(&orm(db))
            .await
            .map_err(refused)?;
        email = found.flatten();
    } else if empty(&email) && person_id.as_deref().is_some_and(|id| !id.is_empty()) {
        let found: Option<Option<String>> = people::Entity::find()
            .select_only()
            .column(people::Column::Email)
            .filter(people::Column::Id.eq(person_id.as_deref()))
            .into_tuple()
            .one(&orm(db))
            .await
            .map_err(refused)?;
        email = found.flatten();
    }

    let started = now_ms();
    let now = timestamp_of_millis(started).unwrap_or_else(utc_now);
    let superseded = w9_requests::Entity::update_many()
        .col_expr(w9_requests::Column::Status, Expr::value("cancelled"))
        .col_expr(w9_requests::Column::UpdatedAt, Expr::value(now))
        .filter(w9_requests::Column::PartyId.eq(party_id.as_str()))
        .filter(w9_requests::Column::Status.eq("pending"))
        .exec_with_returning(&orm(db))
        .await
        .map_err(refused)?;
    for old in js_rows!(superseded).map_err(refused)? {
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
    let expires_at = timestamp_of_millis(expires_ms).unwrap_or(now);
    let id = generate_id("w9r");
    let row = w9_requests::Entity::insert(w9_requests::ActiveModel {
        id: Set(id.clone()),
        entity_id: Set(entity_id.clone()),
        party_id: Set(party_id.clone()),
        email: Set(email.clone()),
        token_hash: Set(hash.clone()),
        status: Set("pending".to_owned()),
        expires_at: Set(expires_at),
        requested_by: Set(caller.user().map(str::to_owned)),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await
    .map_err(refused)?;
    let row = js!(row).map_err(refused)?;

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
        let Some(row) = find(db, &id).await.map_err(refused)? else {
            return Err(Refusal::not_found("W-9 request", &id));
        };
        let status = text(&row, "status").unwrap_or_default();
        if status != "pending" {
            return Err(Refusal::conflict(format!(
                "This request is {status} and can't be cancelled"
            )));
        }
        let updated = w9_requests::Entity::update_many()
            .col_expr(w9_requests::Column::Status, Expr::value("cancelled"))
            .col_expr(w9_requests::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(w9_requests::Column::Id.eq(id.as_str()))
            .filter(w9_requests::Column::Status.eq("pending"))
            .exec_with_returning(&orm(db))
            .await
            .map_err(refused)?
            .into_iter()
            .next()
            .map(|row| js!(row))
            .transpose()
            .map_err(refused)?;
        let Some(updated) = updated else {
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
