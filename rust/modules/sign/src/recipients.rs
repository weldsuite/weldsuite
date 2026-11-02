//! The people on an envelope (`packages/domains/sign/src/recipients.ts`,
//! `apps/workers/sign-api/src/routes/envelopes/recipients.ts`): signers fill
//! in fields, copy recipients only get the signed PDF. Access codes are
//! stored as a keyed hash and never returned.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::envelopes::{
    load_draft, load_own_envelope, publish_updated, recipient_dto, touch_envelope, viewer_of,
};
use crate::hash::code_hash;
use crate::{Caller, SignError, SignResult, SignState, answer, sources, text, validate};

/// `SIGN_LIMITS.maxRecipients`.
pub(crate) const MAX_RECIPIENTS: i64 = 50;
pub(crate) const ROLES: [&str; 2] = ["signer", "cc"];
pub(crate) const LOCALES: [&str; 2] = ["en", "nl"];
pub(crate) const AUTH_MODES: [&str; 3] = ["link", "email_code", "access_code"];

pub(crate) const NAME: Text = Text::trimmed(Some(1), Some(255));
pub(crate) const EMAIL: Text = Text {
    trim: true,
    lowercase: true,
    format: Some(Format::Email),
    min: None,
    max: Some(320),
};

pub(crate) fn routing_order() -> Number {
    #[allow(clippy::cast_precision_loss)]
    Number {
        int: true,
        min: Some(1.0),
        max: Some(MAX_RECIPIENTS as f64),
        ..Number::default()
    }
}

/// `recipientBase`; `create` leaves role, locale, routing order and auth
/// mode optional (`createRecipientSchema`), an update every field.
struct RecipientInput {
    role: Field<String>,
    name: Field<String>,
    email: Field<String>,
    person_id: Field<String>,
    locale: Field<String>,
    routing_order: Field<i64>,
    auth_mode: Field<String>,
    access_code: Field<String>,
}

fn read_recipient(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    create: bool,
) -> RecipientInput {
    let required = if create {
        Presence::Required
    } else {
        Presence::Optional
    };
    RecipientInput {
        role: issues.choice(fields, "role", Presence::Optional, &ROLES),
        name: issues.text_with(fields, "name", required, NAME),
        email: issues.text_with(fields, "email", required, EMAIL),
        person_id: issues.text(fields, "personId", Presence::Nullish, None, Some(30)),
        locale: issues.choice(fields, "locale", Presence::Optional, &LOCALES),
        routing_order: issues.whole_number(
            fields,
            "routingOrder",
            Presence::Optional,
            routing_order(),
        ),
        auth_mode: issues.choice(fields, "authMode", Presence::Optional, &AUTH_MODES),
        access_code: issues.text_with(
            fields,
            "accessCode",
            Presence::Nullish,
            Text::trimmed(Some(4), Some(64)),
        ),
    }
}

pub(crate) async fn get_recipient(
    db: &PgPool,
    envelope_id: &str,
    recipient_id: &str,
) -> SignResult<Value> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from sign_recipients r where id = $1 and envelope_id = $2 limit 1",
    )
    .bind(recipient_id)
    .bind(envelope_id)
    .fetch_optional(db)
    .await?;
    row.map(js_row).ok_or(SignError::NotFound("Recipient"))
}

async fn assert_email_free(
    db: &PgPool,
    envelope_id: &str,
    email: &str,
    except: Option<&str>,
) -> SignResult<()> {
    let taken: Option<String> = sqlx::query_scalar(
        "select id from sign_recipients
         where envelope_id = $1 and email = $2 and ($3::text is null or id <> $3) limit 1",
    )
    .bind(envelope_id)
    .bind(email)
    .bind(except)
    .fetch_optional(db)
    .await?;
    if taken.is_some() {
        return Err(SignError::invalid(format!(
            "{email} is already a recipient of this envelope"
        )));
    }
    Ok(())
}

/// The access-code hash to store, given the auth mode and what was sent.
fn access_code_hash(
    secret: Option<&str>,
    recipient_id: &str,
    auth_mode: &str,
    access_code: Option<&str>,
    current: Option<&str>,
) -> SignResult<Option<String>> {
    if auth_mode != "access_code" {
        return Ok(None);
    }
    if let Some(code) = access_code.filter(|c| !c.is_empty()) {
        let secret =
            secret.ok_or_else(|| SignError::invalid("Access codes are not available right now"))?;
        return Ok(Some(code_hash(secret, recipient_id, code)));
    }
    if let Some(current) = current {
        return Ok(Some(current.to_owned()));
    }
    Err(SignError::invalid(
        "An access code is required for this recipient",
    ))
}

/// How many recipient rows an envelope has, and the last routing order.
pub(crate) async fn recipient_count(
    db: &PgPool,
    envelope_id: &str,
) -> SignResult<(i64, Option<i32>)> {
    Ok(sqlx::query_as(
        "select count(*), max(routing_order) from sign_recipients where envelope_id = $1",
    )
    .bind(envelope_id)
    .fetch_one(db)
    .await?)
}

/// A recipient to add (`addRecipient`'s input). `role_name` is the template
/// role this person fills, when the envelope came from one.
pub(crate) struct NewRecipient {
    pub(crate) role: Option<String>,
    pub(crate) role_name: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) email: String,
    pub(crate) person_id: Option<String>,
    pub(crate) locale: Option<String>,
    pub(crate) routing_order: Option<i64>,
    pub(crate) auth_mode: Option<String>,
    pub(crate) access_code: Option<String>,
}

/// Add a recipient (`addRecipient`): at most 50, one row per address, the
/// access code stored as a keyed hash.
pub(crate) async fn add_recipient(
    db: &PgPool,
    envelope_id: &str,
    input: NewRecipient,
    secret: Option<&str>,
) -> SignResult<Value> {
    let (existing, last) = recipient_count(db, envelope_id).await?;
    if existing >= MAX_RECIPIENTS {
        return Err(SignError::invalid(format!(
            "An envelope can have at most {MAX_RECIPIENTS} recipients"
        )));
    }
    assert_email_free(db, envelope_id, &input.email, None).await?;

    let role = input.role.unwrap_or_else(|| "signer".to_owned());
    // A copy recipient never opens the request to sign it: no identity to check.
    let auth_mode = if role == "cc" {
        "link".to_owned()
    } else {
        input.auth_mode.unwrap_or_else(|| "link".to_owned())
    };
    let id = generate_id("sgr");
    let hash = access_code_hash(secret, &id, &auth_mode, input.access_code.as_deref(), None)?;
    // New people go last; with signing order off the number is not used.
    let order = input
        .routing_order
        .unwrap_or_else(|| last.map_or(1, |n| i64::from(n) + 1));
    let row: Value = sqlx::query_scalar(
        "insert into sign_recipients
             (id, envelope_id, role, role_name, name, email, person_id, locale, routing_order,
              auth_mode, access_code_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::int, $10, $11)
         returning to_jsonb(sign_recipients)",
    )
    .bind(&id)
    .bind(envelope_id)
    .bind(&role)
    .bind(input.role_name)
    .bind(input.name)
    .bind(&input.email)
    .bind(input.person_id)
    .bind(input.locale.unwrap_or_else(|| "en".to_owned()))
    .bind(order)
    .bind(&auth_mode)
    .bind(hash)
    .fetch_one(db)
    .await?;
    Ok(js_row(row))
}

async fn update_recipient(
    db: &PgPool,
    envelope_id: &str,
    recipient_id: &str,
    input: RecipientInput,
    secret: Option<&str>,
) -> SignResult<Value> {
    let current = get_recipient(db, envelope_id, recipient_id).await?;
    if let Some(email) = input.email.as_set()
        && current["email"].as_str() != Some(email.as_str())
    {
        assert_email_free(db, envelope_id, email, Some(recipient_id)).await?;
    }
    let role = input
        .role
        .as_set()
        .cloned()
        .unwrap_or_else(|| text(&current, "role").to_owned());
    // A copy recipient never keeps an auth mode (or code).
    let auth_mode = if role == "cc" {
        "link".to_owned()
    } else {
        input
            .auth_mode
            .as_set()
            .cloned()
            .unwrap_or_else(|| text(&current, "authMode").to_owned())
    };
    let hash = access_code_hash(
        secret,
        recipient_id,
        &auth_mode,
        input.access_code.as_set().map(String::as_str),
        current["accessCodeHash"].as_str(),
    )?;
    let row: Value = sqlx::query_scalar(
        "update sign_recipients set
             role = $2,
             name = case when $3 then $4 else name end,
             email = case when $5 then $6 else email end,
             person_id = case when $7 then $8 else person_id end,
             locale = case when $9 then $10 else locale end,
             routing_order = case when $11 then $12::int else routing_order end,
             auth_mode = $13,
             access_code_hash = $14,
             updated_at = $15::timestamptz
         where id = $1
         returning to_jsonb(sign_recipients)",
    )
    .bind(recipient_id)
    .bind(&role)
    .bind(!input.name.is_absent())
    .bind(input.name.as_set())
    .bind(!input.email.is_absent())
    .bind(input.email.as_set())
    .bind(!input.person_id.is_absent())
    .bind(input.person_id.as_set())
    .bind(!input.locale.is_absent())
    .bind(input.locale.as_set())
    .bind(!input.routing_order.is_absent())
    .bind(input.routing_order.as_set())
    .bind(&auth_mode)
    .bind(hash)
    .bind(crate::now())
    .fetch_one(db)
    .await?;
    // A copy recipient fills nothing in: drop the fields they had as a signer.
    if role == "cc" && current["role"] != "cc" {
        sqlx::query("delete from sign_fields where recipient_id = $1")
            .bind(recipient_id)
            .execute(db)
            .await?;
    }
    Ok(js_row(row))
}

/// Remove a recipient (or a template role) with their fields.
pub(crate) async fn remove_recipient(
    db: &PgPool,
    envelope_id: &str,
    recipient_id: &str,
) -> SignResult<()> {
    get_recipient(db, envelope_id, recipient_id).await?;
    sqlx::query("delete from sign_fields where recipient_id = $1")
        .bind(recipient_id)
        .execute(db)
        .await?;
    sqlx::query("delete from sign_recipients where id = $1")
        .bind(recipient_id)
        .execute(db)
        .await?;
    Ok(())
}

// ── Routes ─────────────────────────────────────────────────────────────────

pub(crate) async fn create(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = validate(&headers, &body, |issues, fields| {
                read_recipient(issues, fields, true)
            })?;
            let viewer = viewer_of(&caller).await?;
            let envelope = load_draft(&caller.db, &id, &viewer).await?;
            let envelope_id = text(&envelope, "id");
            let secret = caller.session_secret(&state);
            let input = NewRecipient {
                role: input.role.into_option(),
                role_name: None,
                name: input.name.into_option(),
                email: input.email.into_option().unwrap_or_default(),
                person_id: input.person_id.into_option(),
                locale: input.locale.into_option(),
                routing_order: input.routing_order.into_option(),
                auth_mode: input.auth_mode.into_option(),
                access_code: input.access_code.into_option(),
            };
            let recipient =
                add_recipient(&caller.db, envelope_id, input, secret.as_deref()).await?;
            touch_envelope(&caller.db, envelope_id).await?;
            publish_updated(&caller, &state, &envelope);
            Ok(Created(recipient_dto(&recipient)).into_response())
        }
        .await,
    )
}

pub(crate) async fn update(
    State(state): State<SignState>,
    caller: Caller,
    Path((id, recipient_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = validate(&headers, &body, |issues, fields| {
                read_recipient(issues, fields, false)
            })?;
            let viewer = viewer_of(&caller).await?;
            let envelope = load_draft(&caller.db, &id, &viewer).await?;
            let envelope_id = text(&envelope, "id");
            let secret = caller.session_secret(&state);
            let recipient = update_recipient(
                &caller.db,
                envelope_id,
                &recipient_id,
                input,
                secret.as_deref(),
            )
            .await?;
            touch_envelope(&caller.db, envelope_id).await?;
            publish_updated(&caller, &state, &envelope);
            Ok(Data(recipient_dto(&recipient)).into_response())
        }
        .await,
    )
}

pub(crate) async fn remove(
    State(state): State<SignState>,
    caller: Caller,
    Path((id, recipient_id)): Path<(String, String)>,
) -> Response {
    answer(
        async {
            let viewer = viewer_of(&caller).await?;
            let envelope = load_draft(&caller.db, &id, &viewer).await?;
            let envelope_id = text(&envelope, "id");
            remove_recipient(&caller.db, envelope_id, &recipient_id).await?;
            touch_envelope(&caller.db, envelope_id).await?;
            publish_updated(&caller, &state, &envelope);
            Ok(NoContent.into_response())
        }
        .await,
    )
}

/// The people on the draft's CRM record, for the recipients step: none for a
/// file source or none at all, nor when the member may not read that record.
pub(crate) async fn suggestions(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let viewer = viewer_of(&caller).await?;
            let envelope = load_own_envelope(&caller.db, &id, &viewer).await?;
            let source = &envelope["source"];
            let kind = source["entityType"].as_str().unwrap_or_default();
            if source.is_null() || kind == "file" {
                return Ok(Data(Vec::<Value>::new()).into_response());
            }
            if !sources::read_permission(kind).is_some_and(|key| caller.can(key)) {
                return Ok(Data(Vec::<Value>::new()).into_response());
            }
            let rows = sources::recipient_suggestions(&caller.db, source).await?;
            Ok(Data(rows).into_response())
        }
        .await,
    )
}
