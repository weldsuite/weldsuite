//! `/api/custom-objects/templates`: ready-made object types
//! (`routes/custom-object-templates`, definitions in
//! `services/custom-object-templates.ts`). Listing needs `weldobjects:read`
//! or `weldobjects:manage`; installing is creating an object, so it needs
//! `weldobjects:manage`.
//!
//! An install writes the object, its fields and its relationships in one
//! transaction and publishes the events the object, field and relationship
//! routes publish. A slug already taken answers 409, with the live object in
//! `details`.

use std::sync::Arc;

use axum::Router;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use sea_orm::{ActiveValue::Set, ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_catalogs::entity_events::CUSTOM_FIELD_CREATED;
use weldsuite_catalogs::permission_keys::{WELDOBJECTS_MANAGE, WELDOBJECTS_READ};
use weldsuite_db::{OrmConn, orm, utc_now};
use weldsuite_kit::{ApiError, Created, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{custom_field_definitions, custom_object_links, custom_objects};

use crate::{Answer, Caller, CoreObjectsState, Refusal, all, answer, json_row};

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreObjectsState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/templates",
            get(list).route_layer(gate.require([WELDOBJECTS_READ, WELDOBJECTS_MANAGE])),
        )
        .route(
            "/templates/{key}",
            post(install).route_layer(gate.require([WELDOBJECTS_MANAGE])),
        )
}

/// A template's field (`TemplateField`).
struct TemplateField {
    slug: &'static str,
    name: &'static str,
    field_type: &'static str,
    required: bool,
    /// `(value, label)` pairs of a select field.
    options: &'static [(&'static str, &'static str)],
}

/// A template's relationship (`TemplateLink`).
struct TemplateLink {
    slug: &'static str,
    target_entity_key: &'static str,
    cardinality: &'static str,
    source_label: &'static str,
    target_label: &'static str,
    on_delete: &'static str,
}

/// `CustomObjectTemplateDefinition`.
struct Template {
    key: &'static str,
    slug: &'static str,
    label_singular: &'static str,
    label_plural: &'static str,
    description: &'static str,
    icon: &'static str,
    enable_events: bool,
    enable_search: bool,
    title_field: &'static str,
    fields: &'static [TemplateField],
    links: &'static [TemplateLink],
}

const fn field(
    slug: &'static str,
    name: &'static str,
    field_type: &'static str,
    required: bool,
) -> TemplateField {
    TemplateField {
        slug,
        name,
        field_type,
        required,
        options: &[],
    }
}

/// Equipment and licences, who has them, and the tickets about them.
const ASSET: Template = Template {
    key: "asset",
    slug: "asset",
    label_singular: "Asset",
    label_plural: "Assets",
    description: "Equipment and software licences, who has them and the tickets about them.",
    icon: "Laptop",
    enable_events: true,
    enable_search: true,
    title_field: "name",
    fields: &[
        field("name", "Name", "text", true),
        TemplateField {
            slug: "asset_type",
            name: "Asset type",
            field_type: "single_select",
            required: false,
            options: &[
                ("laptop", "Laptop"),
                ("desktop", "Desktop"),
                ("monitor", "Monitor"),
                ("phone", "Phone"),
                ("tablet", "Tablet"),
                ("server", "Server"),
                ("network_device", "Network device"),
                ("printer", "Printer"),
                ("software_licence", "Software licence"),
                ("other", "Other"),
            ],
        },
        field("serial_number", "Serial number", "text", false),
        field("location", "Location", "text", false),
        field("warranty_until", "Warranty until", "date", false),
        field("purchase_date", "Purchase date", "date", false),
        field("supplier", "Supplier", "text", false),
        TemplateField {
            slug: "status",
            name: "Status",
            field_type: "single_select",
            required: false,
            options: &[
                ("in_use", "In use"),
                ("in_stock", "In stock"),
                ("in_repair", "In repair"),
                ("retired", "Retired"),
                ("lost", "Lost"),
            ],
        },
        field("notes", "Notes", "textarea", false),
    ],
    links: &[
        TemplateLink {
            slug: "owner",
            target_entity_key: "person",
            cardinality: "many_to_one",
            source_label: "Assets",
            target_label: "Owner",
            on_delete: "set_null",
        },
        TemplateLink {
            slug: "tickets",
            target_entity_key: "conversation",
            cardinality: "many_to_many",
            source_label: "Assets",
            target_label: "Tickets",
            on_delete: "set_null",
        },
    ],
};

const TEMPLATES: &[&Template] = &[&ASSET];

/// The `options` JSON of a select field, `None` for the others.
fn options_json(field: &TemplateField) -> Option<Value> {
    (!field.options.is_empty()).then(|| {
        Value::Array(
            field
                .options
                .iter()
                .map(|(value, label)| json!({ "label": label, "value": value }))
                .collect(),
        )
    })
}

async fn list(caller: Caller) -> Response {
    let result: Answer = async {
        let live: Vec<(String, String)> = custom_objects::Entity::find()
            .select_only()
            .columns([custom_objects::Column::Slug, custom_objects::Column::Id])
            .filter(custom_objects::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(&caller.db))
            .await?;
        let rows = TEMPLATES
            .iter()
            .map(|template| {
                let object_id = live
                    .iter()
                    .find(|(slug, _)| slug == template.slug)
                    .map(|(_, id)| id.clone());
                json!({
                    "key": template.key,
                    "slug": template.slug,
                    "labelSingular": template.label_singular,
                    "labelPlural": template.label_plural,
                    "description": template.description,
                    "icon": template.icon,
                    "fieldCount": template.fields.len(),
                    "linkCount": template.links.len(),
                    "installed": object_id.is_some(),
                    "objectId": object_id,
                })
            })
            .collect();
        Ok(all(rows))
    }
    .await;
    answer(result, "Failed to list object templates")
}

#[allow(clippy::too_many_lines)]
async fn install(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path(key): Path<String>,
) -> Response {
    let Some(template) = TEMPLATES.iter().find(|t| t.key == key) else {
        return ApiError::not_found("Object template", Some(&key)).into_response();
    };
    let taken = format!(
        "A custom object with the name '{}' already exists",
        template.slug
    );
    let result: Answer = async {
        let db = &orm(&caller.db);
        let existing = custom_objects::Entity::find()
            .filter(custom_objects::Column::Slug.eq(template.slug))
            .one(db)
            .await?;
        if let Some(existing) = existing {
            if existing.deleted_at.is_some() {
                return Err(Refusal::conflict(format!(
                    "The name '{}' belonged to a deleted object and cannot be reused",
                    template.slug
                )));
            }
            return Err(ApiError::conflict(taken.clone())
                .with_details(json_row(existing)?)
                .into());
        }

        let entity_key = format!("co_{}", template.slug);
        let object_id = generate_id("cobj");
        let field_ids: Vec<String> = template
            .fields
            .iter()
            .map(|_| generate_id("cfld"))
            .collect();
        let link_ids: Vec<String> = template.links.iter().map(|_| generate_id("colk")).collect();
        let title_field_id = template
            .fields
            .iter()
            .position(|f| f.slug == template.title_field)
            .map(|index| field_ids[index].clone());
        let rows = template_rows(
            template,
            Ids {
                object: &object_id,
                entity_key: &entity_key,
                title_field: title_field_id,
                fields: &field_ids,
                links: &link_ids,
            },
            &caller.user_id,
            utc_now(),
        );
        if let Err(refused) = install_rows(&caller.db, rows).await {
            // Two installs racing past the check: the unique index decides.
            if let Refusal::Database(error) = &refused
                && weldsuite_db::is_unique_violation(error)
            {
                return Err(Refusal::conflict(taken.clone()));
            }
            return Err(refused);
        }

        let created = custom_objects::Entity::find_by_id(object_id.as_str())
            .one(db)
            .await?;
        let Some(created) = created else {
            return Err(ApiError::internal()
                .with_message("Failed to install object template")
                .into());
        };

        caller.publish(
            &state,
            CUSTOM_FIELD_CREATED,
            &object_id,
            &json!({
                "id": object_id,
                "kind": "custom_object",
                "template": template.key,
                "slug": template.slug,
                "labelSingular": template.label_singular,
                "labelPlural": template.label_plural,
                "description": template.description,
                "icon": template.icon,
                "status": "active",
                "enableEvents": template.enable_events,
                "enableSearch": template.enable_search,
            }),
        );
        for (index, (field, id)) in template.fields.iter().zip(&field_ids).enumerate() {
            let mut data = Map::new();
            data.insert("id".to_owned(), json!(id));
            data.insert("entityType".to_owned(), json!(entity_key));
            data.insert("name".to_owned(), json!(field.name));
            data.insert("slug".to_owned(), json!(field.slug));
            data.insert("fieldType".to_owned(), json!(field.field_type));
            if let Some(options) = options_json(field) {
                data.insert("options".to_owned(), options);
            }
            data.insert("required".to_owned(), json!(field.required));
            data.insert("sortOrder".to_owned(), json!(index));
            caller.publish(&state, CUSTOM_FIELD_CREATED, id, &Value::Object(data));
        }
        for (link, id) in template.links.iter().zip(&link_ids) {
            caller.publish(
                &state,
                CUSTOM_FIELD_CREATED,
                id,
                &json!({
                    "id": id,
                    "kind": "custom_object_link",
                    "objectId": object_id,
                    "slug": link.slug,
                    "targetEntityKey": link.target_entity_key,
                    "cardinality": link.cardinality,
                    "sourceLabel": link.source_label,
                    "targetLabel": link.target_label,
                    "onDelete": link.on_delete,
                }),
            );
        }
        Ok(Created(json_row(created)?).into_response())
    }
    .await;
    answer(result, "Failed to install object template")
}

/// The ids an install writes its rows under.
struct Ids<'a> {
    object: &'a str,
    entity_key: &'a str,
    title_field: Option<String>,
    fields: &'a [String],
    links: &'a [String],
}

/// What an install writes: the object, its fields, its relationships.
struct TemplateRows {
    object: custom_objects::ActiveModel,
    fields: Vec<custom_field_definitions::ActiveModel>,
    links: Vec<custom_object_links::ActiveModel>,
}

fn template_rows(
    template: &Template,
    ids: Ids<'_>,
    user_id: &str,
    now: PrimitiveDateTime,
) -> TemplateRows {
    let object = custom_objects::ActiveModel {
        id: Set(ids.object.to_owned()),
        slug: Set(template.slug.to_owned()),
        entity_key: Set(ids.entity_key.to_owned()),
        label_singular: Set(template.label_singular.to_owned()),
        label_plural: Set(template.label_plural.to_owned()),
        description: Set(Some(template.description.to_owned())),
        icon: Set(template.icon.to_owned()),
        title_field_id: Set(ids.title_field),
        status: Set("active".to_owned()),
        enable_events: Set(template.enable_events),
        enable_search: Set(template.enable_search),
        enable_agent_tools: Set(false),
        enable_external_api: Set(false),
        list_config: Set(json!({})),
        sort_order: Set(0),
        created_by: Set(Some(user_id.to_owned())),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    };
    let fields = template
        .fields
        .iter()
        .zip(ids.fields)
        .enumerate()
        .map(
            |(index, (field, id))| custom_field_definitions::ActiveModel {
                id: Set(id.clone()),
                entity_type: Set(ids.entity_key.to_owned()),
                name: Set(field.name.to_owned()),
                slug: Set(field.slug.to_owned()),
                field_type: Set(field.field_type.to_owned()),
                options: Set(options_json(field)),
                required: Set(Some(field.required)),
                sort_order: Set(Some(i32::try_from(index).unwrap_or(i32::MAX))),
                created_at: Set(now),
                updated_at: Set(now),
                ..Default::default()
            },
        )
        .collect();
    let links = template
        .links
        .iter()
        .zip(ids.links)
        .enumerate()
        .map(|(index, (link, id))| custom_object_links::ActiveModel {
            id: Set(id.clone()),
            slug: Set(link.slug.to_owned()),
            source_entity_key: Set(ids.entity_key.to_owned()),
            target_entity_key: Set(link.target_entity_key.to_owned()),
            cardinality: Set(link.cardinality.to_owned()),
            source_label: Set(link.source_label.to_owned()),
            target_label: Set(link.target_label.to_owned()),
            on_delete: Set(link.on_delete.to_owned()),
            required: Set(false),
            sort_order: Set(i32::try_from(index).unwrap_or(i32::MAX)),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        })
        .collect();
    TemplateRows {
        object,
        fields,
        links,
    }
}

/// The object, then each field, then each relationship, in one
/// transaction.
async fn install_rows(db: &weldsuite_db::PgPool, rows: TemplateRows) -> Result<(), Refusal> {
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            custom_objects::Entity::insert(rows.object)
                .exec_without_returning(&tx)
                .await?;
            for field in rows.fields {
                custom_field_definitions::Entity::insert(field)
                    .exec_without_returning(&tx)
                    .await?;
            }
            for link in rows.links {
                custom_object_links::Entity::insert(link)
                    .exec_without_returning(&tx)
                    .await?;
            }
            Ok::<_, Refusal>(())
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_asset_template_is_titled_by_a_field_it_has() {
        for template in TEMPLATES {
            assert!(
                template
                    .fields
                    .iter()
                    .any(|f| f.slug == template.title_field && f.field_type == "text")
            );
        }
    }

    #[test]
    fn select_fields_carry_their_options() {
        let field = |slug: &str| {
            ASSET
                .fields
                .iter()
                .find(|f| f.slug == slug)
                .expect("the asset template has the field")
        };
        assert_eq!(
            options_json(field("status")).map(|options| options[0].clone()),
            Some(json!({ "label": "In use", "value": "in_use" }))
        );
        assert!(options_json(field("name")).is_none());
    }
}
