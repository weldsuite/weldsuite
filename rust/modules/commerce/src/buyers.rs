//! `/api/commerce-buyers` and `/api/commerce-company-settings`: the B2B
//! buyers of a company (people linked to it with a commerce role and an
//! optional per-order spend limit) and the company's approval threshold
//! (ADR COM-012). Staff manage both from the company panel; a company's own
//! admins manage their buyers through the storefront.
//!
//! The rules live in `weldsuite_commerce_domain::accounts`; this file reads
//! and validates requests, publishes the events and sends the invitation
//! (after the commit, with no connection held).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    COMMERCE_BUYER_CREATED, COMMERCE_BUYER_DELETED, COMMERCE_BUYER_INVITED, COMMERCE_BUYER_UPDATED,
    COMMERCE_COMPANY_SETTINGS_UPDATED,
};
use weldsuite_catalogs::permission_keys::{COMPANIES_READ, COMPANIES_UPDATE};
use weldsuite_commerce_domain::accounts::{self, BuyerPatch, NewBuyer};
use weldsuite_commerce_domain::money::Cents;
use weldsuite_emails::EmailLocale;
use weldsuite_emails::commerce::BuyerInvitation;
use weldsuite_kit::validation::{Field, Format, Issues, Presence, Text};
use weldsuite_kit::{Created, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::query_set;
use crate::wire::{body_or_empty, read_text, refuse};
use crate::{Caller, CommerceState, Refusal, mail, validate};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([COMPANIES_READ]);
    let update = || gate.require([COMPANIES_UPDATE]);
    // One `route` per method: `route_layer` wraps every method chained.
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(update()))
        .route("/{id}", patch(change).route_layer(update()))
        .route("/{id}", axum::routing::delete(remove).route_layer(update()))
        .route("/{id}/invite", post(invite).route_layer(update()))
}

pub(crate) fn settings_routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/{company_id}",
            get(settings).route_layer(gate.require([COMPANIES_READ])),
        )
        .route(
            "/{company_id}",
            put(set_settings).route_layer(gate.require([COMPANIES_UPDATE])),
        )
}

fn event(buyer: &Value) -> Value {
    json!({
        "id": buyer["id"],
        "personId": buyer["personId"],
        "companyId": buyer["companyId"],
        "role": buyer["role"],
        "status": buyer["status"],
    })
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to list buyers";
    let query = query.as_deref();
    let company = query_set(query, "companyId");
    let person = query_set(query, "personId");
    let found = async {
        let mut conn = caller.db.acquire().await?;
        accounts::buyers(&mut conn, company.as_deref(), person.as_deref()).await
    }
    .await;
    match found {
        Ok(list) => Data(Value::Array(list)).into_response(),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

fn read_email(issues: &mut Issues, fields: &Map<String, Value>) -> Option<String> {
    issues
        .text_with(
            fields,
            "email",
            Presence::Required,
            Text {
                trim: true,
                format: Some(Format::Email),
                max: Some(255),
                ..Text::default()
            },
        )
        .into_option()
}

/// `spendLimit` and `spendLimitCurrency`: both or neither; `null` for both
/// clears them. `None`: neither is in the body.
#[allow(
    clippy::option_option,
    reason = "a patch field: absent, null or a value"
)]
fn read_limit(issues: &mut Issues, fields: &Map<String, Value>) -> Option<Option<(Cents, String)>> {
    let amount = crate::wire::read_money(issues, fields, "spendLimit", Presence::Nullish);
    let currency = issues.text_with(
        fields,
        "spendLimitCurrency",
        Presence::Nullish,
        Text::trimmed(Some(3), Some(3)),
    );
    match (amount, currency) {
        (Field::Null, _) => Some(None),
        (Field::Set(amount), Field::Set(code)) => Some(Some((amount, code.to_ascii_uppercase()))),
        (Field::Set(_), _) => {
            issues.custom("spendLimitCurrency", "A spend limit needs its currency");
            None
        }
        (_, Field::Set(_)) => {
            issues.custom("spendLimit", "A currency needs a spend limit");
            None
        }
        (_, _) => None,
    }
}

struct Create {
    company_id: String,
    email: String,
    first_name: Option<String>,
    last_name: Option<String>,
    role: String,
    limit: Option<(Cents, String)>,
    send_invite: bool,
}

fn read_create(issues: &mut Issues, fields: &Map<String, Value>) -> Create {
    Create {
        company_id: issues
            .text_with(
                fields,
                "companyId",
                Presence::Required,
                Text::trimmed(Some(1), Some(30)),
            )
            .into_option()
            .unwrap_or_default(),
        email: read_email(issues, fields).unwrap_or_default(),
        first_name: read_text(issues, fields, "firstName", 100).into_option(),
        last_name: read_text(issues, fields, "lastName", 100).into_option(),
        role: issues
            .choice(fields, "role", Presence::Required, &accounts::ROLES)
            .into_option()
            .unwrap_or_default(),
        limit: read_limit(issues, fields).flatten(),
        send_invite: issues
            .boolean(fields, "sendInvite", Presence::Optional)
            .into_option()
            .unwrap_or(true),
    }
}

/// The shop to invite into: its name and its home (the first origin a
/// publishable key of an active B2B channel allows). No code or token.
async fn shop(db: &weldsuite_db::PgPool) -> (String, Option<String>) {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "select c.name, k.allowed_origins->>0 from commerce_channels c \
         left join commerce_channel_keys k on k.channel_id = c.id and k.kind = 'publishable' \
           and k.revoked_at is null and jsonb_typeof(k.allowed_origins) = 'array' \
           and jsonb_array_length(k.allowed_origins) > 0 \
         where c.audience = 'b2b' and c.status = 'active' and c.deleted_at is null \
         order by (k.id is null) asc, c.created_at asc, k.created_at asc limit 1",
    )
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    row.unwrap_or_else(|| ("Shop".to_owned(), None))
}

/// Send the invitation email of `buyer`.
async fn send_invite(state: &CommerceState, caller: &Caller, buyer: &Value) {
    if state.mail.is_none() {
        return;
    }
    let (shop_name, shop_url) = shop(&caller.db).await;
    let company: Option<String> =
        sqlx::query_scalar("select display_name from companies where id = $1")
            .bind(buyer["companyId"].as_str())
            .fetch_optional(&caller.db)
            .await
            .ok()
            .flatten();
    let props = BuyerInvitation {
        shop_name,
        company_name: company.unwrap_or_default(),
        inviter_name: None,
        role: buyer["role"].as_str().unwrap_or("buyer").to_owned(),
        shop_url,
    };
    mail::invitation(
        &state.mail,
        props,
        buyer["email"].as_str().unwrap_or_default(),
        EmailLocale::En,
    )
    .await;
}

async fn create(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to create buyer";
    let body = match validate(&headers, &body, read_create) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let made = async {
        let mut tx = caller.db.begin().await?;
        let buyer = accounts::create_buyer(
            &mut tx,
            &NewBuyer {
                company_id: &body.company_id,
                email: &body.email,
                first_name: body.first_name.as_deref(),
                last_name: body.last_name.as_deref(),
                role: &body.role,
                spend_limit: body.limit.as_ref().map(|(amount, _)| *amount),
                spend_limit_currency: body.limit.as_ref().map(|(_, code)| code.as_str()),
                invited_by: &caller.user_id,
            },
        )
        .await
        .map_err(refuse)?;
        tx.commit().await?;
        Ok::<_, Refusal>(buyer)
    }
    .await;
    match made {
        Ok(buyer) => {
            let id = buyer["id"].as_str().unwrap_or_default().to_owned();
            caller.publish(&state, COMMERCE_BUYER_CREATED, &id, &event(&buyer));
            if body.send_invite {
                caller.publish(&state, COMMERCE_BUYER_INVITED, &id, &event(&buyer));
                send_invite(&state, &caller, &buyer).await;
            }
            Created(buyer).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

fn read_patch(issues: &mut Issues, fields: &Map<String, Value>) -> BuyerPatch {
    BuyerPatch {
        role: issues
            .choice(fields, "role", Presence::Optional, &accounts::ROLES)
            .into_option(),
        spend_limit: read_limit(issues, fields),
        status: issues
            .choice(fields, "status", Presence::Optional, &accounts::STATUSES)
            .into_option(),
    }
}

async fn change(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update buyer";
    let (headers, body) = body_or_empty(&headers, &body);
    let patch = match validate(&headers, &body, read_patch) {
        Ok(patch) => patch,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let done = async {
        let mut tx = caller.db.begin().await?;
        let buyer = accounts::update_buyer(&mut tx, &id, &patch, false)
            .await
            .map_err(refuse)?;
        tx.commit().await?;
        Ok::<_, Refusal>(buyer)
    }
    .await;
    match done {
        Ok(buyer) => {
            caller.publish(&state, COMMERCE_BUYER_UPDATED, &id, &event(&buyer));
            Data(buyer).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn remove(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to delete buyer";
    let done = async {
        let mut tx = caller.db.begin().await?;
        let buyer = accounts::delete_buyer(&mut tx, &id, false)
            .await
            .map_err(refuse)?;
        tx.commit().await?;
        Ok::<_, Refusal>(buyer)
    }
    .await;
    match done {
        Ok(buyer) => {
            caller.publish(&state, COMMERCE_BUYER_DELETED, &id, &event(&buyer));
            StatusCode::NO_CONTENT.into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}

/// `POST /:id/invite`: the invitation again.
async fn invite(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    const FAILED: &str = "Failed to invite buyer";
    let found = async {
        let mut conn = caller.db.acquire().await?;
        accounts::buyer(&mut conn, &id).await
    }
    .await;
    match found {
        Ok(Some(buyer)) => {
            sqlx::query(
                "update commerce_buyers set invited_at = now() at time zone 'utc', \
                   updated_at = now() at time zone 'utc' where id = $1",
            )
            .bind(&id)
            .execute(&caller.db)
            .await
            .ok();
            caller.publish(&state, COMMERCE_BUYER_INVITED, &id, &event(&buyer));
            send_invite(&state, &caller, &buyer).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(None) => Refusal::not_found("Buyer", &id).respond(FAILED),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

async fn settings(caller: Caller, Path(company_id): Path<String>) -> Response {
    const FAILED: &str = "Failed to fetch company settings";
    let found = async {
        let mut conn = caller.db.acquire().await?;
        accounts::company_settings(&mut conn, &company_id)
            .await
            .map_err(refuse)
    }
    .await;
    match found {
        Ok(found) => Data(found).into_response(),
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn set_settings(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(company_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update company settings";
    let (headers, body) = body_or_empty(&headers, &body);
    let threshold = match validate(&headers, &body, |issues, fields| {
        let amount =
            crate::wire::read_money(issues, fields, "approvalThreshold", Presence::Nullish);
        let currency = issues.text_with(
            fields,
            "approvalThresholdCurrency",
            Presence::Nullish,
            Text::trimmed(Some(3), Some(3)),
        );
        match (amount, currency) {
            (Field::Set(amount), Field::Set(code)) => Some((amount, code.to_ascii_uppercase())),
            (Field::Set(_), _) => {
                issues.custom(
                    "approvalThresholdCurrency",
                    "An approval threshold needs its currency",
                );
                None
            }
            _ => None,
        }
    }) {
        Ok(threshold) => threshold,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let done = async {
        let mut tx = caller.db.begin().await?;
        let saved = accounts::set_company_settings(&mut tx, &company_id, threshold)
            .await
            .map_err(refuse)?;
        tx.commit().await?;
        Ok::<_, Refusal>(saved)
    }
    .await;
    match done {
        Ok(saved) => {
            caller.publish(
                &state,
                COMMERCE_COMPANY_SETTINGS_UPDATED,
                &company_id,
                &json!({ "companyId": company_id }),
            );
            Data(saved).into_response()
        }
        Err(refusal) => refusal.respond(FAILED),
    }
}
