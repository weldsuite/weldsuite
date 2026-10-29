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
    SIGN_ENVELOPE_CREATED, SIGN_TEMPLATE_CREATED, SIGN_TEMPLATE_DELETED, SIGN_TEMPLATE_UPDATED,
};
use weldsuite_catalogs::permission_keys::SIGN_TEMPLATES_UPDATE;
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::envelopes::{
    DetailAccess, Viewer, delete_draft, detail_for, envelope_detail,
    event_data as envelope_event_data, list_documents, list_fields, list_recipients,
    load_sign_settings, load_template, member_profile, page_query, read_changes, recipient_dto,
    record_event, touch_envelope, update_envelope,
};
use crate::recipients::{
    AUTH_MODES, EMAIL, LOCALES, MAX_RECIPIENTS, NAME, NewRecipient, ROLES, add_recipient,
    get_recipient, recipient_count, remove_recipient, routing_order,
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
            crate::documents::delete_files_later(&caller, &state, keys);
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

// ── POST /:id/use ──────────────────────────────────────────────────────────

/// The person who fills one role (`templateRecipientSchema`).
struct RolePerson {
    role_id: String,
    name: String,
    email: String,
    person_id: Option<String>,
    locale: Option<String>,
    auth_mode: Option<String>,
    access_code: Option<String>,
}

/// `useTemplateSchema`: title, message and one person per role.
fn read_use(
    issues: &mut Issues,
    fields: &Map<String, Value>,
) -> (Field<String>, Field<String>, Vec<RolePerson>) {
    let title = issues.text_with(
        fields,
        "title",
        Presence::Optional,
        Text::trimmed(Some(1), Some(255)),
    );
    let message = issues.text_with(
        fields,
        "message",
        Presence::Nullish,
        Text::trimmed(None, Some(5000)),
    );
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    let max = Some(MAX_RECIPIENTS as usize);
    let people = issues.list(
        fields,
        "recipients",
        Presence::Required,
        Some(1),
        max,
        |issues, item| {
            let item = issues.object(item)?;
            let role_id = issues.text(item, "roleId", Presence::Required, Some(1), Some(30));
            let name = issues.text_with(item, "name", Presence::Required, NAME);
            let email = issues.text_with(item, "email", Presence::Required, EMAIL);
            let person_id = issues.text(item, "personId", Presence::Nullish, None, Some(30));
            let locale = issues.choice(item, "locale", Presence::Optional, &LOCALES);
            let auth_mode = issues.choice(item, "authMode", Presence::Optional, &AUTH_MODES);
            let access_code = issues.text_with(
                item,
                "accessCode",
                Presence::Nullish,
                Text::trimmed(Some(4), Some(64)),
            );
            Some(RolePerson {
                role_id: role_id.into_option()?,
                name: name.into_option()?,
                email: email.into_option()?,
                person_id: person_id.into_option(),
                locale: locale.into_option(),
                auth_mode: auth_mode.into_option(),
                access_code: access_code.into_option(),
            })
        },
    );
    (title, message, people.into_option().unwrap_or_default())
}

/// A copy recipient signs nothing and opens the request by link alone.
fn auth_mode_for(role: &Value, person: &RolePerson) -> String {
    if role["role"] == "cc" {
        "link".to_owned()
    } else {
        person
            .auth_mode
            .clone()
            .unwrap_or_else(|| text(role, "authMode").to_owned())
    }
}

/// Who fills each role (`peopleByRole`): every role once, no stray roles, no
/// address twice, codes where needed.
fn check_people(roles: &[Value], people: &[RolePerson]) -> SignResult<()> {
    let mut role_ids: Vec<&str> = people.iter().map(|p| p.role_id.as_str()).collect();
    role_ids.sort_unstable();
    role_ids.dedup();
    if role_ids.len() != people.len() {
        return Err(SignError::invalid("Each role can be filled once"));
    }
    for person in people {
        if !roles.iter().any(|r| r["id"] == person.role_id.as_str()) {
            return Err(SignError::invalid(format!(
                "Role {} is not part of this template",
                person.role_id
            )));
        }
    }
    let mut emails: Vec<&str> = Vec::new();
    for role in roles {
        let role_name = text(role, "roleName");
        let Some(person) = people.iter().find(|p| role["id"] == p.role_id.as_str()) else {
            return Err(SignError::invalid(format!("Fill the role {role_name}")));
        };
        if emails.contains(&person.email.as_str()) {
            return Err(SignError::invalid(format!(
                "{} fills more than one role",
                person.email
            )));
        }
        emails.push(&person.email);
        if auth_mode_for(role, person) == "access_code" && person.access_code.is_none() {
            return Err(SignError::invalid(format!(
                "{role_name} needs an access code"
            )));
        }
    }
    Ok(())
}

/// A new draft request from a template, with a person in every role
/// (`useTemplate`). Fails as a whole: anything already written is removed.
pub(crate) async fn use_template(
    State(state): State<SignState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let (title, message, people) = validate(&headers, &body, read_use)?;
            // The PDFs are copied under workspaces/<org>/…, keyed by the Clerk org id.
            let Some(org_id) = caller.clerk_org_id.clone() else {
                return Ok(weldsuite_kit::ApiError::org_required().into_response());
            };
            let db = &caller.db;
            let template = load_template(db, &id).await?;
            let template_id = text(&template, "id").to_owned();
            let roles = list_recipients(db, &template_id).await?;
            check_people(&roles, &people)?;

            let (name, email) = member_profile(db, &caller.user_id).await?;
            let title = title
                .into_option()
                .unwrap_or_else(|| text(&template, "title").to_owned());
            let message = match message {
                Field::Absent => template["message"].as_str().map(str::to_owned),
                other => other.into_option(),
            };
            let draft: Value = sqlx::query_scalar(
                "insert into sign_envelopes
                     (id, kind, status, title, message, sender_user_id, sender_name, sender_email)
                 values ($1, 'envelope', 'draft', $2, $3, $4, $5, $6)
                 returning to_jsonb(sign_envelopes)",
            )
            .bind(generate_id("sgn"))
            .bind(&title)
            .bind(message)
            .bind(&caller.user_id)
            .bind(&name)
            .bind(&email)
            .fetch_one(db)
            .await?;
            let draft = js_row(draft);
            let draft_id = text(&draft, "id").to_owned();
            record_event(
                db,
                &draft_id,
                "created",
                (&caller.user_id, name.as_deref(), email.as_deref()),
            )
            .await?;

            let mut written = Vec::new();
            let target = Draft {
                template: &template,
                roles: &roles,
                people: &people,
                org_id: &org_id,
                id: &draft_id,
            };
            if let Err(error) = fill_draft(&caller, &state, &target, &mut written).await {
                // Leave nothing half made: the draft, its rows and the files copied so far.
                let _ = delete_draft(db, &draft).await;
                crate::documents::delete_files_later(&caller, &state, written);
                return Err(error);
            }

            let row: Value =
                sqlx::query_scalar("select to_jsonb(e) from sign_envelopes e where id = $1")
                    .bind(&draft_id)
                    .fetch_one(db)
                    .await?;
            let row = js_row(row);
            let mut data = envelope_event_data(&row);
            data["templateId"] = json!(template_id);
            caller.publish(&state, SIGN_ENVELOPE_CREATED, &draft_id, &data);
            Ok(Created(detail_for(&caller, &row, None).await?).into_response())
        }
        .await,
    )
}

/// What a template is copied into.
struct Draft<'a> {
    template: &'a Value,
    roles: &'a [Value],
    people: &'a [RolePerson],
    org_id: &'a str,
    id: &'a str,
}

/// The template's settings, PDFs, roles (as people) and fields on the draft.
async fn fill_draft(
    caller: &Caller,
    state: &SignState,
    draft: &Draft<'_>,
    written: &mut Vec<String>,
) -> SignResult<()> {
    let db = &caller.db;
    let template = draft.template;
    let template_id = text(template, "id");
    sqlx::query(
        "update sign_envelopes set template_id = $2, signing_order_enabled = $3,
             reminder_after_days = $4::int, reminder_every_days = $5::int,
             reminder_max_count = $6::int
         where id = $1",
    )
    .bind(draft.id)
    .bind(template_id)
    .bind(template["signingOrderEnabled"] == true)
    .bind(template["reminderAfterDays"].as_i64())
    .bind(template["reminderEveryDays"].as_i64())
    .bind(template["reminderMaxCount"].as_i64())
    .execute(db)
    .await?;

    let document_ids = copy_documents(caller, state, draft, written).await?;

    let recipient_ids = add_people(caller, state, draft).await?;

    let fields = list_fields(db, template_id).await?;
    if fields.is_empty() {
        return Ok(());
    }
    let lookup = |pairs: &[(String, String)], old: &str| {
        pairs
            .iter()
            .find(|(from, _)| from == old)
            .map(|(_, to)| to.clone())
    };
    let ids: Vec<String> = fields.iter().map(|_| generate_id("sgf")).collect();
    let document_refs: Vec<Option<String>> = fields
        .iter()
        .map(|f| lookup(&document_ids, text(f, "documentId")))
        .collect();
    let recipient_refs: Vec<Option<String>> = fields
        .iter()
        .map(|f| lookup(&recipient_ids, text(f, "recipientId")))
        .collect();
    let boxes: Vec<Value> = fields
        .iter()
        .map(|f| {
            json!({
                "type": f["type"], "page": f["page"], "x": f["x"], "y": f["y"],
                "width": f["width"], "height": f["height"], "required": f["required"],
                "label": f["label"],
            })
        })
        .collect();
    // One statement, as Drizzle's multi-row insert.
    sqlx::query(
        "insert into sign_fields
             (id, envelope_id, document_id, recipient_id, type, page, x, y, width, height,
              required, label)
         select u.id, $2, u.document_id, u.recipient_id, u.f->>'type', (u.f->>'page')::int,
                (u.f->>'x')::real, (u.f->>'y')::real, (u.f->>'width')::real,
                (u.f->>'height')::real, (u.f->>'required')::boolean, u.f->>'label'
         from unnest($1::varchar[], $3::varchar[], $4::varchar[], $5::jsonb[])
              as u(id, document_id, recipient_id, f)",
    )
    .bind(&ids)
    .bind(draft.id)
    .bind(&document_refs)
    .bind(&recipient_refs)
    .bind(&boxes)
    .execute(db)
    .await?;
    Ok(())
}

/// One recipient per role, with the person given for it; the new recipient
/// id per role id.
async fn add_people(
    caller: &Caller,
    state: &SignState,
    draft: &Draft<'_>,
) -> SignResult<Vec<(String, String)>> {
    let db = &caller.db;
    let secret = caller.session_secret(state);
    let mut recipient_ids: Vec<(String, String)> = Vec::new();
    for role in draft.roles {
        let Some(person) = draft
            .people
            .iter()
            .find(|p| role["id"] == p.role_id.as_str())
        else {
            continue;
        };
        let cc = role["role"] == "cc";
        let locale = person
            .locale
            .clone()
            .unwrap_or_else(|| if role["locale"] == "nl" { "nl" } else { "en" }.to_owned());
        let recipient = add_recipient(
            db,
            draft.id,
            NewRecipient {
                role: role["role"].as_str().map(str::to_owned),
                role_name: role["roleName"].as_str().map(str::to_owned),
                name: Some(person.name.clone()),
                email: person.email.clone(),
                person_id: person.person_id.clone(),
                locale: Some(locale),
                routing_order: role["routingOrder"].as_i64(),
                auth_mode: Some(auth_mode_for(role, person)),
                access_code: if cc { None } else { person.access_code.clone() },
            },
            secret.as_deref(),
        )
        .await?;
        recipient_ids.push((
            text(role, "id").to_owned(),
            text(&recipient, "id").to_owned(),
        ));
    }

    Ok(recipient_ids)
}

/// Copy the template's PDFs to the draft's own keys (`copyDocuments`), so
/// deleting either never touches the other. The new id per template document.
async fn copy_documents(
    caller: &Caller,
    state: &SignState,
    draft: &Draft<'_>,
    written: &mut Vec<String>,
) -> SignResult<Vec<(String, String)>> {
    let docs = list_documents(&caller.db, text(draft.template, "id")).await?;
    if docs.is_empty() {
        return Err(SignError::invalid("This template has no documents"));
    }
    let files = caller
        .files(state)
        .ok_or_else(|| SignError::Internal("no file store configured (S3_ENDPOINT)".to_owned()))?;
    let mut ids = Vec::with_capacity(docs.len());
    for doc in &docs {
        let object = files
            .private
            .get_boxed(text(doc, "storageKey"))
            .await
            .map_err(|e| SignError::Internal(format!("file store: {e}")))?
            .ok_or_else(|| {
                SignError::Internal(format!(
                    "The file of template document {} is missing",
                    text(doc, "id")
                ))
            })?;
        let id = generate_id("sgd");
        let key = crate::documents::document_key(draft.org_id, draft.id, &id);
        let options = weldsuite_ports::PutOptions::content_type("application/pdf")
            .with_metadata("sha256", text(doc, "sha256"));
        files
            .private
            .put_boxed(&key, object.bytes, &options)
            .await
            .map_err(|e| SignError::Internal(format!("file store: {e}")))?;
        written.push(key.clone());
        sqlx::query(
            "insert into sign_documents
                 (id, envelope_id, name, position, storage_key, size_bytes, page_count,
                  page_sizes, sha256)
             values ($1, $2, $3, $4::int, $5, $6::int, $7::int, $8, $9)",
        )
        .bind(&id)
        .bind(draft.id)
        .bind(text(doc, "name"))
        .bind(doc["position"].as_i64())
        .bind(&key)
        .bind(doc["sizeBytes"].as_i64())
        .bind(doc["pageCount"].as_i64())
        .bind(&doc["pageSizes"])
        .bind(text(doc, "sha256"))
        .execute(&caller.db)
        .await?;
        ids.push((text(doc, "id").to_owned(), id));
    }
    Ok(ids)
}
