//! Templates, reusable requests with named roles in place of people
//! (`packages/domains/sign/src/templates.ts`, `routes/templates/`). A
//! template is a `sign_envelopes` row of kind `template` (always a draft); a
//! role is a recipient row with `role_name` set. Templates belong to the
//! workspace: anyone with `sign_templates:read` sees them all.
//!
//! Using a template copies its PDFs, so it comes with the files port.

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    SIGN_TEMPLATE_CREATED, SIGN_TEMPLATE_DELETED, SIGN_TEMPLATE_UPDATED,
};
use weldsuite_catalogs::permission_keys::SIGN_TEMPLATES_UPDATE;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::envelopes::{
    DetailAccess, Viewer, delete_draft, delete_files_later, envelope_detail, load_sign_settings,
    load_template, member_profile, page_query, read_changes, recipient_dto, touch_envelope,
    update_envelope,
};
use crate::recipients::{
    AUTH_MODES, EMAIL, LOCALES, MAX_RECIPIENTS, NAME, ROLES, get_recipient, recipient_count,
    remove_recipient, routing_order,
};
use crate::{
    Caller, SignError, SignResult, SignState, answer, like_pattern, now, offset_page, text,
    validate, validate_query,
};

/// The `sign_template` event payload.
fn event_data(template: &Value) -> Value {
    json!({ "id": template["id"], "title": template["title"] })
}

pub(crate) fn publish_template_updated(caller: &Caller, state: &SignState, template: &Value) {
    caller.publish(
        state,
        SIGN_TEMPLATE_UPDATED,
        text(template, "id"),
        &event_data(template),
    );
}

/// The template in the editor's shape (`getTemplateDetail`): an envelope
/// detail of kind `template`, editable with `sign_templates:update`.
async fn template_detail(caller: &Caller, template: &Value) -> SignResult<Value> {
    let access = DetailAccess {
        viewer: Viewer {
            user_id: String::new(),
            email: None,
            manage_all: false,
        },
        update: false,
        send: false,
        void: false,
    };
    let mut detail = envelope_detail(&caller.db, template, &access).await?;
    let can_edit = !caller.read_only && caller.can(SIGN_TEMPLATES_UPDATE);
    if let Value::Object(fields) = &mut detail {
        fields.insert("canEdit".to_owned(), json!(can_edit));
        fields.insert("isOwner".to_owned(), json!(false));
        fields.insert("canVoid".to_owned(), json!(false));
        fields.insert("canRemind".to_owned(), json!(false));
        fields.insert("mySignerId".to_owned(), Value::Null);
    }
    Ok(detail)
}

// ── GET / ──────────────────────────────────────────────────────────────────

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    answer(list_templates(&caller.db, query.as_deref()).await)
}

async fn list_templates(db: &PgPool, query: Option<&str>) -> SignResult<Response> {
    let (search, limit, offset) = validate_query(query, page_query)?;
    let pattern = search.as_deref().map(like_pattern);
    let page: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(e) from sign_envelopes e
         where kind = 'template' and deleted_at is null and ($1::text is null or title ilike $1)
         order by updated_at desc, id desc limit $2 offset $3",
    )
    .bind(pattern.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*) from sign_envelopes
         where kind = 'template' and deleted_at is null and ($1::text is null or title ilike $1)",
    )
    .bind(pattern.as_deref())
    .fetch_one(db)
    .await?;
    let page: Vec<Value> = page.into_iter().map(js_row).collect();
    if page.is_empty() {
        return Ok(offset_page(Vec::new(), total, offset));
    }

    let ids: Vec<String> = page.iter().map(|r| text(r, "id").to_owned()).collect();
    let counts: Vec<(String, i64)> = sqlx::query_as(
        "select envelope_id, count(*) from sign_documents
         where envelope_id = any($1) group by envelope_id",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let roles: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) from sign_recipients r where envelope_id = any($1)
         order by routing_order asc, created_at asc",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let roles: Vec<Value> = roles.into_iter().map(js_row).collect();
    let rows = page
        .iter()
        .map(|row| {
            let id = text(row, "id");
            let role_summaries: Vec<Value> = roles
                .iter()
                .filter(|r| r["envelopeId"] == id)
                .map(|r| {
                    // `r.roleName ?? r.name ?? ''`
                    let name = [&r["roleName"], &r["name"]]
                        .into_iter()
                        .find(|v| !v.is_null())
                        .cloned()
                        .unwrap_or_else(|| json!(""));
                    json!({ "id": r["id"], "roleName": name, "role": r["role"] })
                })
                .collect();
            json!({
                "id": row["id"],
                "title": row["title"],
                "documentCount": counts.iter().find(|(e, _)| e == id).map_or(0, |(_, n)| *n),
                "roles": role_summaries,
                "createdByName": row["senderName"],
                "createdAt": row["createdAt"],
                "updatedAt": row["updatedAt"],
            })
        })
        .collect();
    Ok(offset_page(rows, total, offset))
}

// ── POST /, GET /:id, PATCH /:id, DELETE /:id ──────────────────────────────

pub(crate) async fn create(
    State(state): State<SignState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (title, message) = validate(&headers, &body, |issues, fields| {
                (
                    issues.text_with(
                        fields,
                        "title",
                        Presence::Required,
                        Text::trimmed(Some(1), Some(255)),
                    ),
                    issues.text_with(
                        fields,
                        "message",
                        Presence::Nullish,
                        Text::trimmed(None, Some(5000)),
                    ),
                )
            })?;
            let db = &caller.db;
            let (name, email) = member_profile(db, &caller.user_id).await?;
            let settings = load_sign_settings(db).await?;
            // On a template the sender columns record who made it.
            let template: Value = sqlx::query_scalar(
                "insert into sign_envelopes
                     (id, kind, status, title, message, sender_user_id, sender_name, sender_email,
                      reminder_after_days, reminder_every_days, reminder_max_count)
                 values ($1, 'template', 'draft', $2, $3, $4, $5, $6, $7, $8, $9)
                 returning to_jsonb(sign_envelopes)",
            )
            .bind(generate_id("sgn"))
            .bind(title.into_option().unwrap_or_default())
            .bind(message.into_option())
            .bind(&caller.user_id)
            .bind(name)
            .bind(email)
            .bind(settings.after_days)
            .bind(settings.every_days)
            .bind(settings.max_count)
            .fetch_one(db)
            .await?;
            let template = js_row(template);
            caller.publish(
                &state,
                SIGN_TEMPLATE_CREATED,
                text(&template, "id"),
                &event_data(&template),
            );
            Ok(Created(template_detail(&caller, &template).await?).into_response())
        }
        .await,
    )
}

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    answer(
        async {
            let template = load_template(&caller.db, &id).await?;
            Ok(Data(template_detail(&caller, &template).await?).into_response())
        }
        .await,
    )
}

pub(crate) async fn update(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let changes = read_changes(&headers, &body, true)?;
            let template = load_template(&caller.db, &id).await?;
            let updated = update_envelope(&caller.db, &template, &changes).await?;
            caller.publish(&state, SIGN_TEMPLATE_UPDATED, &id, &event_data(&updated));
            Ok(Data(template_detail(&caller, &updated).await?).into_response())
        }
        .await,
    )
}

pub(crate) async fn remove(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    answer(
        async {
            let template = load_template(&caller.db, &id).await?;
            let keys = delete_draft(&caller.db, &template).await?;
            delete_files_later(&keys);
            caller.publish(&state, SIGN_TEMPLATE_DELETED, &id, &event_data(&template));
            Ok(NoContent.into_response())
        }
        .await,
    )
}

// ── Roles ──────────────────────────────────────────────────────────────────

/// `roleBase`; `create` needs only the role name (`createTemplateRoleSchema`).
struct RoleInput {
    role_name: Field<String>,
    role: Field<String>,
    routing_order: Field<i64>,
    auth_mode: Field<String>,
    locale: Field<String>,
    name: Field<String>,
    email: Field<String>,
}

fn read_role(issues: &mut Issues, fields: &Map<String, Value>, create: bool) -> RoleInput {
    let name_presence = if create {
        Presence::Required
    } else {
        Presence::Optional
    };
    RoleInput {
        role_name: issues.text_with(
            fields,
            "roleName",
            name_presence,
            Text::trimmed(Some(1), Some(100)),
        ),
        role: issues.choice(fields, "role", Presence::Optional, &ROLES),
        routing_order: issues.whole_number(
            fields,
            "routingOrder",
            Presence::Optional,
            routing_order(),
        ),
        auth_mode: issues.choice(fields, "authMode", Presence::Optional, &AUTH_MODES),
        locale: issues.choice(fields, "locale", Presence::Optional, &LOCALES),
        name: issues.text_with(fields, "name", Presence::Nullish, NAME),
        email: issues.text_with(fields, "email", Presence::Nullish, EMAIL),
    }
}

async fn assert_role_name_free(
    db: &PgPool,
    template_id: &str,
    role_name: &str,
    except: Option<&str>,
) -> SignResult<()> {
    let taken: Option<String> = sqlx::query_scalar(
        "select id from sign_recipients
         where envelope_id = $1 and lower(role_name) = $2 and ($3::text is null or id <> $3)
         limit 1",
    )
    .bind(template_id)
    .bind(role_name.to_lowercase())
    .bind(except)
    .fetch_optional(db)
    .await?;
    if taken.is_some() {
        return Err(SignError::invalid(format!(
            "This template already has a role called {role_name}"
        )));
    }
    Ok(())
}

pub(crate) async fn add_role(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = validate(&headers, &body, |issues, fields| read_role(issues, fields, true))?;
            let db = &caller.db;
            let template = load_template(db, &id).await?;
            let template_id = text(&template, "id");
            let (existing, last) = recipient_count(db, template_id).await?;
            if existing >= MAX_RECIPIENTS {
                return Err(SignError::invalid(format!(
                    "A template can have at most {MAX_RECIPIENTS} roles"
                )));
            }
            let role_name = input.role_name.into_option().unwrap_or_default();
            assert_role_name_free(db, template_id, &role_name, None).await?;
            // A copy role signs nothing, so it opens by link alone; an access
            // code is asked when the template is used.
            let auth_mode = if input.role.as_set().map(String::as_str) == Some("cc") {
                "link".to_owned()
            } else {
                input.auth_mode.into_option().unwrap_or_else(|| "link".to_owned())
            };
            let order = input
                .routing_order
                .into_option()
                .unwrap_or_else(|| last.map_or(1, |n| i64::from(n) + 1));
            let row: Value = sqlx::query_scalar(
                "insert into sign_recipients
                     (id, envelope_id, role, role_name, name, email, locale, routing_order, auth_mode)
                 values ($1, $2, $3, $4, $5, $6, $7, $8::int, $9)
                 returning to_jsonb(sign_recipients)",
            )
            .bind(generate_id("sgr"))
            .bind(template_id)
            .bind(input.role.into_option().unwrap_or_else(|| "signer".to_owned()))
            .bind(&role_name)
            .bind(input.name.into_option())
            .bind(input.email.into_option())
            .bind(input.locale.into_option().unwrap_or_else(|| "en".to_owned()))
            .bind(order)
            .bind(auth_mode)
            .fetch_one(db)
            .await?;
            touch_envelope(db, template_id).await?;
            publish_template_updated(&caller, &state, &template);
            Ok(Created(recipient_dto(&js_row(row))).into_response())
        }
        .await,
    )
}

pub(crate) async fn update_role(
    State(state): State<SignState>,
    caller: Caller,
    Path((id, role_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = validate(&headers, &body, |issues, fields| {
                read_role(issues, fields, false)
            })?;
            let db = &caller.db;
            let template = load_template(db, &id).await?;
            let template_id = text(&template, "id");
            let current = get_recipient(db, template_id, &role_id).await?;
            if let Some(role_name) = input.role_name.as_set()
                && role_name.to_lowercase() != text(&current, "roleName").to_lowercase()
            {
                assert_role_name_free(db, template_id, role_name, Some(&role_id)).await?;
            }
            let role = input
                .role
                .as_set()
                .cloned()
                .unwrap_or_else(|| text(&current, "role").to_owned());
            // A copy role signs nothing, so it opens by link alone.
            let auth_mode = if role == "cc" {
                Some("link".to_owned())
            } else {
                input.auth_mode.as_set().cloned()
            };
            let row: Value = sqlx::query_scalar(
                "update sign_recipients set
                     role = $2,
                     role_name = case when $3 then $4 else role_name end,
                     name = case when $5 then $6 else name end,
                     email = case when $7 then $8 else email end,
                     locale = case when $9 then $10 else locale end,
                     routing_order = case when $11 then $12::int else routing_order end,
                     auth_mode = coalesce($13, auth_mode),
                     updated_at = $14::timestamptz
                 where id = $1
                 returning to_jsonb(sign_recipients)",
            )
            .bind(&role_id)
            .bind(&role)
            .bind(!input.role_name.is_absent())
            .bind(input.role_name.as_set())
            .bind(!input.name.is_absent())
            .bind(input.name.as_set())
            .bind(!input.email.is_absent())
            .bind(input.email.as_set())
            .bind(!input.locale.is_absent())
            .bind(input.locale.as_set())
            .bind(!input.routing_order.is_absent())
            .bind(input.routing_order.as_set())
            .bind(auth_mode)
            .bind(now())
            .fetch_one(db)
            .await?;
            // A copy role fills nothing in: drop the fields it had as a signer.
            if role == "cc" && current["role"] != "cc" {
                sqlx::query("delete from sign_fields where recipient_id = $1")
                    .bind(&role_id)
                    .execute(db)
                    .await?;
            }
            touch_envelope(db, template_id).await?;
            publish_template_updated(&caller, &state, &template);
            Ok(Data(recipient_dto(&js_row(row))).into_response())
        }
        .await,
    )
}

pub(crate) async fn remove_role(
    State(state): State<SignState>,
    caller: Caller,
    Path((id, role_id)): Path<(String, String)>,
) -> Response {
    answer(
        async {
            let template = load_template(&caller.db, &id).await?;
            let template_id = text(&template, "id");
            remove_recipient(&caller.db, template_id, &role_id).await?;
            touch_envelope(&caller.db, template_id).await?;
            publish_template_updated(&caller, &state, &template);
            Ok(NoContent.into_response())
        }
        .await,
    )
}
