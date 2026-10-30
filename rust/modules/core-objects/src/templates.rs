//! `/api/object-templates`: named field sets for create forms
//! (`routes/object-templates`), read with `companies:read` and managed with
//! `companies:update`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    OBJECT_TEMPLATE_CREATED, OBJECT_TEMPLATE_DELETED, OBJECT_TEMPLATE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{COMPANIES_READ, COMPANIES_UPDATE};
use weldsuite_kit::validation::{Field, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::objects::is_lower_slug;
use crate::{
    Answer, Caller, CoreObjectsState, Refusal, Rejected, STAMPS, all, answer, change, now,
    query_param, row, validate,
};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreObjectsState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([COMPANIES_READ]);
    let update = || gate.require([COMPANIES_UPDATE]);
    Router::new()
        .route("/", get(list).route_layer(read()))
        .route("/", post(create).route_layer(update()))
        .route("/{id}", get(detail).route_layer(read()))
        .route("/{id}", patch(edit).route_layer(update()))
        .route("/{id}", delete(remove).route_layer(update()))
}

/// `^[a-z0-9_-]+$`.
fn is_template_slug(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

async fn list(caller: Caller, RawQuery(query): RawQuery) -> Response {
    // Any slug-shaped entity type; anything else is ignored, not refused.
    let entity_type = query_param(query.as_deref(), "entityType").filter(|t| is_lower_slug(t));
    let result: Answer = async {
        let rows: Vec<Value> = sqlx::query_scalar(
            "select to_jsonb(t) from object_templates t
              where deleted_at is null and ($1::text is null or entity_type = $1)
              order by sort_order asc, name asc",
        )
        .bind(entity_type)
        .fetch_all(&caller.db)
        .await?;
        Ok(all(rows.into_iter().map(|r| row(r, &STAMPS)).collect()))
    }
    .await;
    answer(result, "Failed to list object templates")
}

async fn fetch(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let raw: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from object_templates t where id = $1 and deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(raw.map(|r| row(r, &STAMPS)))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Answer = async {
        let template = fetch(&caller, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("CRM template", &id))?;
        Ok(Data(template).into_response())
    }
    .await;
    answer(result, "Failed to fetch CRM template")
}

/// `createObjectTemplateSchema`, or its `.partial().omit({ entityType })`.
struct TemplateInput {
    entity_type: Field<String>,
    name: Field<String>,
    slug: Field<String>,
    description: Field<String>,
    fields: Field<Vec<String>>,
    is_default: Field<bool>,
    sort_order: Field<i64>,
}

fn template_input(
    headers: &HeaderMap,
    body: &Bytes,
    create: bool,
) -> Result<TemplateInput, Rejected> {
    validate(headers, body, |issues, fields| {
        let required = if create {
            Presence::Required
        } else {
            Presence::Optional
        };
        let entity_type = if create {
            issues.pattern(
                fields,
                "entityType",
                Presence::Required,
                Some(1),
                Some(50),
                is_lower_slug,
                "lowercase letters, digits, underscores",
            )
        } else {
            Field::Absent
        };
        let name = issues.text(fields, "name", required, Some(1), Some(150));
        let slug = issues.pattern(
            fields,
            "slug",
            required,
            Some(1),
            Some(150),
            is_template_slug,
            "lowercase alphanumeric, dashes or underscores",
        );
        let description = issues.text(fields, "description", Presence::Optional, None, Some(500));
        let field_list = issues.list_with(
            fields,
            "fields",
            required,
            (Some(1), Some("Select at least one field")),
            None,
            |issues, item| issues.item_text(item, Text::length(Some(1), None)),
        );
        let is_default = issues.boolean(fields, "isDefault", Presence::Optional);
        let sort_order =
            issues.whole_number(fields, "sortOrder", Presence::Optional, Number::default());
        TemplateInput {
            entity_type,
            name,
            slug,
            description,
            fields: field_list,
            is_default,
            sort_order,
        }
    })
}

async fn create(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match template_input(&headers, &body, true) {
        Ok(input) => input,
        Err(invalid) => return *invalid,
    };
    let result: Answer = async {
        let id = generate_id("crmtpl");
        let created: Value = sqlx::query_scalar(
            "insert into object_templates
                 (id, entity_type, name, slug, description, fields, is_default, sort_order, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8::int, $9::timestamp, $9::timestamp)
             returning to_jsonb(object_templates)",
        )
        .bind(&id)
        .bind(input.entity_type.as_set())
        .bind(input.name.as_set())
        .bind(input.slug.as_set())
        .bind(input.description.as_set())
        .bind(json!(input.fields.as_set()))
        .bind(input.is_default.as_set().copied().unwrap_or(false))
        .bind(input.sort_order.as_set().copied().unwrap_or(0))
        .bind(now())
        .fetch_one(&caller.db)
        .await?;
        let created = row(created, &STAMPS);
        caller.publish(&state, OBJECT_TEMPLATE_CREATED, &id, &created);
        Ok(Created(created).into_response())
    }
    .await;
    answer(result, "Failed to create CRM template")
}

async fn edit(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match template_input(&headers, &body, false) {
        Ok(input) => input,
        Err(invalid) => return *invalid,
    };
    let result: Answer = async {
        fetch(&caller, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("CRM template", &id))?;
        let (set_name, name) = change(&input.name);
        let (set_slug, slug) = change(&input.slug);
        let (set_description, description) = change(&input.description);
        let (set_fields, field_list) = change(&input.fields);
        let (set_default, is_default) = change(&input.is_default);
        let (set_order, order) = change(&input.sort_order);
        let updated: Option<Value> = sqlx::query_scalar(
            "update object_templates set
                 name = case when $2 then $3 else name end,
                 slug = case when $4 then $5 else slug end,
                 description = case when $6 then $7 else description end,
                 fields = case when $8 then $9 else fields end,
                 is_default = case when $10 then $11 else is_default end,
                 sort_order = case when $12 then $13::int else sort_order end,
                 updated_at = $14::timestamp
             where id = $1 and deleted_at is null
             returning to_jsonb(object_templates)",
        )
        .bind(&id)
        .bind(set_name)
        .bind(name)
        .bind(set_slug)
        .bind(slug)
        .bind(set_description)
        .bind(description)
        .bind(set_fields)
        .bind(field_list.map(|f| json!(f)))
        .bind(set_default)
        .bind(is_default)
        .bind(set_order)
        .bind(order)
        .bind(now())
        .fetch_optional(&caller.db)
        .await?;
        let updated = updated.map_or(Value::Null, |u| row(u, &STAMPS));
        caller.publish(&state, OBJECT_TEMPLATE_UPDATED, &id, &updated);
        Ok(Data(updated).into_response())
    }
    .await;
    answer(result, "Failed to update CRM template")
}

async fn remove(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Answer = async {
        fetch(&caller, &id).await?.ok_or_else(|| Refusal::not_found("CRM template", &id))?;
        let now = now();
        sqlx::query("update object_templates set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(&now)
            .execute(&caller.db)
            .await?;
        caller.publish(&state, OBJECT_TEMPLATE_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete CRM template")
}
