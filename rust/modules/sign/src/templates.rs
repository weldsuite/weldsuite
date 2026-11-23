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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    SIGN_ENVELOPE_CREATED, SIGN_TEMPLATE_CREATED, SIGN_TEMPLATE_DELETED, SIGN_TEMPLATE_UPDATED,
};
use weldsuite_catalogs::permission_keys::SIGN_TEMPLATES_UPDATE;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{sign_documents, sign_envelopes, sign_fields, sign_recipients};

use crate::envelopes::{
    DetailAccess, Viewer, delete_draft, detail_for, document_rows, envelope_detail,
    event_data as envelope_event_data, field_rows, int, json_rows, list_recipients,
    load_sign_settings, load_template, member_profile, page_query, read_changes, recipient_dto,
    record_event, returned, row_json, sent, touch_envelope, update_envelope,
};
use crate::recipients::{
    AUTH_MODES, EMAIL, LOCALES, MAX_RECIPIENTS, NAME, NewRecipient, ROLES, add_recipient,
    delete_fields_of, get_recipient, recipient_count, remove_recipient, routing_order,
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
    let mut condition = Condition::all()
        .add(sign_envelopes::Column::Kind.eq("template"))
        .add(sign_envelopes::Column::DeletedAt.is_null());
    if let Some(pattern) = pattern.as_deref() {
        condition = condition.add(sign_envelopes::Column::Title.ilike(pattern));
    }
    let db = &orm(db);
    let page = sign_envelopes::Entity::find()
        .filter(condition.clone())
        .order_by_desc(sign_envelopes::Column::UpdatedAt)
        .order_by_desc(sign_envelopes::Column::Id)
        .limit(u64::try_from(limit).unwrap_or(0))
        .offset(u64::try_from(offset).unwrap_or(0))
        .all(db)
        .await?;
    let total = sign_envelopes::Entity::find()
        .filter(condition)
        .count(db)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let page = json_rows(page)?;
    if page.is_empty() {
        return Ok(offset_page(Vec::new(), total, offset));
    }

    let ids: Vec<&str> = page.iter().map(|r| text(r, "id")).collect();
    let counts: Vec<(String, i64)> = sign_documents::Entity::find()
        .select_only()
        .column(sign_documents::Column::EnvelopeId)
        .column_as(sign_documents::Column::Id.count(), "count")
        .filter(sign_documents::Column::EnvelopeId.is_in(ids.iter().copied()))
        .group_by(sign_documents::Column::EnvelopeId)
        .into_tuple()
        .all(db)
        .await?;
    let roles = sign_recipients::Entity::find()
        .filter(sign_recipients::Column::EnvelopeId.is_in(ids.iter().copied()))
        .order_by_asc(sign_recipients::Column::RoutingOrder)
        .order_by_asc(sign_recipients::Column::CreatedAt)
        .all(db)
        .await?;
    let roles = json_rows(roles)?;
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
            let template = sign_envelopes::Entity::insert(sign_envelopes::ActiveModel {
                id: Set(generate_id("sgn")),
                kind: Set("template".to_owned()),
                status: Set("draft".to_owned()),
                title: Set(title.into_option().unwrap_or_default()),
                message: Set(message.into_option()),
                sender_user_id: Set(caller.user_id.clone()),
                sender_name: Set(name),
                sender_email: Set(email),
                reminder_after_days: Set(settings.after_days),
                reminder_every_days: Set(settings.every_days),
                reminder_max_count: Set(settings.max_count),
                ..Default::default()
            })
            .exec_with_returning(&orm(db))
            .await?;
            let template = row_json(template)?;
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
    let mut query = sign_recipients::Entity::find()
        .select_only()
        .column(sign_recipients::Column::Id)
        .filter(sign_recipients::Column::EnvelopeId.eq(template_id))
        .filter(sea_orm::ExprTrait::eq(
            Expr::expr(Func::lower(Expr::col((
                sign_recipients::Entity,
                sign_recipients::Column::RoleName,
            )))),
            role_name.to_lowercase(),
        ));
    if let Some(except) = except {
        query = query.filter(sign_recipients::Column::Id.ne(except));
    }
    let taken: Option<String> = query.into_tuple().one(&orm(db)).await?;
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
            let row = sign_recipients::Entity::insert(sign_recipients::ActiveModel {
                id: Set(generate_id("sgr")),
                envelope_id: Set(template_id.to_owned()),
                role: Set(input
                    .role
                    .into_option()
                    .unwrap_or_else(|| "signer".to_owned())),
                role_name: Set(Some(role_name)),
                name: Set(input.name.into_option()),
                email: Set(input.email.into_option()),
                locale: Set(input
                    .locale
                    .into_option()
                    .unwrap_or_else(|| "en".to_owned())),
                routing_order: Set(int(order)),
                auth_mode: Set(auth_mode),
                ..Default::default()
            })
            .exec_with_returning(&orm(db))
            .await?;
            touch_envelope(db, template_id).await?;
            publish_template_updated(&caller, &state, &template);
            Ok(Created(recipient_dto(&row_json(row)?)).into_response())
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
            let row = update_role_row(db, &role_id, &role, &input, auth_mode).await?;
            // A copy role fills nothing in: drop the fields it had as a signer.
            if role == "cc" && current["role"] != "cc" {
                delete_fields_of(db, &role_id).await?;
            }
            touch_envelope(db, template_id).await?;
            publish_template_updated(&caller, &state, &template);
            Ok(Data(recipient_dto(&row)).into_response())
        }
        .await,
    )
}

/// The role's new settings: what the body sent; the auth mode only when
/// there is one (`coalesce($n, auth_mode)`).
async fn update_role_row(
    db: &PgPool,
    role_id: &str,
    role: &str,
    input: &RoleInput,
    auth_mode: Option<String>,
) -> SignResult<Value> {
    use sign_recipients::Column;
    let values: [(Column, Option<sea_orm::Value>); 8] = [
        (Column::Role, Some(role.into())),
        (
            Column::RoleName,
            sent(&input.role_name, Clone::clone),
        ),
        (Column::Name, sent(&input.name, Clone::clone)),
        (
            Column::Email,
            sent(&input.email, Clone::clone),
        ),
        (
            Column::Locale,
            sent(&input.locale, Clone::clone),
        ),
        (
            Column::RoutingOrder,
            sent(&input.routing_order, |n| int(*n)),
        ),
        (Column::AuthMode, auth_mode.map(Into::into)),
        (Column::UpdatedAt, Some(now().into())),
    ];
    let update = values.into_iter().fold(
        sign_recipients::Entity::update_many(),
        |update, (column, value)| match value {
            Some(value) => update.col_expr(column, Expr::value(value)),
            None => update,
        },
    );
    let rows = update
        .filter(Column::Id.eq(role_id))
        .exec_with_returning(&orm(db))
        .await?;
    Ok(row_json(returned(rows, "sign_recipients")?)?)
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
            let draft = sign_envelopes::Entity::insert(sign_envelopes::ActiveModel {
                id: Set(generate_id("sgn")),
                kind: Set("envelope".to_owned()),
                status: Set("draft".to_owned()),
                title: Set(title),
                message: Set(message),
                sender_user_id: Set(caller.user_id.clone()),
                sender_name: Set(name.clone()),
                sender_email: Set(email.clone()),
                ..Default::default()
            })
            .exec_with_returning(&orm(db))
            .await?;
            let draft = row_json(draft)?;
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

            let row = sign_envelopes::Entity::find_by_id(draft_id.as_str())
                .one(&orm(db))
                .await?
                .ok_or_else(|| DbErr::RecordNotFound("sign_envelopes".to_owned()))?;
            let row = row_json(row)?;
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
    let days = |key: &str| template[key].as_i64().map(int);
    sign_envelopes::Entity::update_many()
        .col_expr(sign_envelopes::Column::TemplateId, Expr::value(template_id))
        .col_expr(
            sign_envelopes::Column::SigningOrderEnabled,
            Expr::value(template["signingOrderEnabled"] == true),
        )
        .col_expr(
            sign_envelopes::Column::ReminderAfterDays,
            Expr::value(days("reminderAfterDays")),
        )
        .col_expr(
            sign_envelopes::Column::ReminderEveryDays,
            Expr::value(days("reminderEveryDays")),
        )
        .col_expr(
            sign_envelopes::Column::ReminderMaxCount,
            Expr::value(days("reminderMaxCount")),
        )
        .filter(sign_envelopes::Column::Id.eq(draft.id))
        .exec(&orm(db))
        .await?;

    let document_ids = copy_documents(caller, state, draft, written).await?;

    let recipient_ids = add_people(caller, state, draft).await?;

    let fields = field_rows(db, template_id).await?;
    if fields.is_empty() {
        return Ok(());
    }
    let lookup = |pairs: &[(String, String)], old: &str| {
        pairs
            .iter()
            .find(|(from, _)| from == old)
            .map(|(_, to)| to.clone())
            // A field of a document or role that was not copied: the insert
            // fails as the null did in SQL (`not null`), and nothing is kept.
            .ok_or_else(|| SignError::Internal(format!("sign: template field refers to {old}")))
    };
    let rows = fields
        .into_iter()
        .map(|f| {
            Ok(sign_fields::ActiveModel {
                id: Set(generate_id("sgf")),
                envelope_id: Set(draft.id.to_owned()),
                document_id: Set(lookup(&document_ids, &f.document_id)?),
                recipient_id: Set(lookup(&recipient_ids, &f.recipient_id)?),
                type_: Set(f.type_),
                page: Set(f.page),
                x: Set(f.x),
                y: Set(f.y),
                width: Set(f.width),
                height: Set(f.height),
                required: Set(f.required),
                label: Set(f.label),
                ..Default::default()
            })
        })
        .collect::<SignResult<Vec<_>>>()?;
    // One statement, as Drizzle's multi-row insert.
    sign_fields::Entity::insert_many(rows)
        .exec_without_returning(&orm(db))
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
    let docs = document_rows(&caller.db, text(draft.template, "id")).await?;
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
            .get_boxed(&doc.storage_key)
            .await
            .map_err(|e| SignError::Internal(format!("file store: {e}")))?
            .ok_or_else(|| {
                SignError::Internal(format!(
                    "The file of template document {} is missing",
                    doc.id
                ))
            })?;
        let id = generate_id("sgd");
        let key = crate::documents::document_key(draft.org_id, draft.id, &id);
        let options = weldsuite_ports::PutOptions::content_type("application/pdf")
            .with_metadata("sha256", &doc.sha256);
        files
            .private
            .put_boxed(&key, object.bytes, &options)
            .await
            .map_err(|e| SignError::Internal(format!("file store: {e}")))?;
        written.push(key.clone());
        sign_documents::Entity::insert(sign_documents::ActiveModel {
            id: Set(id.clone()),
            envelope_id: Set(draft.id.to_owned()),
            name: Set(doc.name.clone()),
            position: Set(doc.position),
            storage_key: Set(key),
            size_bytes: Set(doc.size_bytes),
            page_count: Set(doc.page_count),
            page_sizes: Set(doc.page_sizes.clone()),
            sha256: Set(doc.sha256.clone()),
            ..Default::default()
        })
        .exec_without_returning(&orm(&caller.db))
        .await?;
        ids.push((doc.id.clone(), id));
    }
    Ok(ids)
}
