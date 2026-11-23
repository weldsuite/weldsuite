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
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QueryTrait,
};
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    OBJECT_TEMPLATE_CREATED, OBJECT_TEMPLATE_DELETED, OBJECT_TEMPLATE_UPDATED,
};
use weldsuite_catalogs::permission_keys::{COMPANIES_READ, COMPANIES_UPDATE};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Number, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::object_templates::{self, Column, Entity};

use crate::objects::is_lower_slug;
use crate::{
    Answer, Caller, CoreObjectsState, Refusal, Rejected, all, answer, change, int4, json_row,
    query_param, validate,
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
        let rows = Entity::find()
            .filter(Column::DeletedAt.is_null())
            .apply_if(entity_type, |query, entity_type| {
                query.filter(Column::EntityType.eq(entity_type))
            })
            .order_by_asc(Column::SortOrder)
            .order_by_asc(Column::Name)
            .all(&orm(&caller.db))
            .await?;
        let rows = rows.into_iter().map(json_row).collect::<Result<_, _>>()?;
        Ok(all(rows))
    }
    .await;
    answer(result, "Failed to list object templates")
}

async fn fetch(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let template = Entity::find()
        .filter(Column::Id.eq(id))
        .filter(Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    template.map(json_row).transpose()
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Answer = async {
        let template = fetch(&caller.db, &id)
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
        let now = utc_now();
        let created = Entity::insert(object_templates::ActiveModel {
            id: Set(id.clone()),
            entity_type: Set(input.entity_type.as_set().cloned().unwrap_or_default()),
            name: Set(input.name.as_set().cloned().unwrap_or_default()),
            slug: Set(input.slug.as_set().cloned().unwrap_or_default()),
            description: Set(input.description.as_set().cloned()),
            fields: Set(json!(input.fields.as_set())),
            is_default: Set(input.is_default.as_set().copied().unwrap_or(false)),
            sort_order: Set(int4(input.sort_order.as_set().copied().unwrap_or(0))?),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .exec_with_returning(&orm(&caller.db))
        .await?;
        let created = json_row(created)?;
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
        fetch(&caller.db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("CRM template", &id))?;
        let mut update = Entity::update_many();
        if let (true, name) = change(&input.name) {
            update = update.col_expr(Column::Name, Expr::value(name));
        }
        if let (true, slug) = change(&input.slug) {
            update = update.col_expr(Column::Slug, Expr::value(slug));
        }
        if let (true, description) = change(&input.description) {
            update = update.col_expr(Column::Description, Expr::value(description));
        }
        if let (true, field_list) = change(&input.fields) {
            update = update.col_expr(Column::Fields, Expr::value(field_list.map(|f| json!(f))));
        }
        if let (true, is_default) = change(&input.is_default) {
            update = update.col_expr(Column::IsDefault, Expr::value(is_default));
        }
        if let (true, order) = change(&input.sort_order) {
            update = update.col_expr(Column::SortOrder, Expr::value(order.map(int4).transpose()?));
        }
        let updated = update
            .col_expr(Column::UpdatedAt, Expr::value(utc_now()))
            .filter(Column::Id.eq(&id))
            .filter(Column::DeletedAt.is_null())
            .exec_with_returning(&orm(&caller.db))
            .await?;
        let updated = updated
            .into_iter()
            .next()
            .map_or(Ok(Value::Null), json_row)?;
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
        fetch(&caller.db, &id).await?.ok_or_else(|| Refusal::not_found("CRM template", &id))?;
        let now = utc_now();
        Entity::update_many()
            .col_expr(Column::DeletedAt, Expr::value(now))
            .col_expr(Column::UpdatedAt, Expr::value(now))
            .filter(Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        caller.publish(&state, OBJECT_TEMPLATE_DELETED, &id, &json!({ "id": id }));
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete CRM template")
}
