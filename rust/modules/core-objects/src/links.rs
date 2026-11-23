//! Relationships (`routes/custom-object-links` and
//! `services/custom-object-links.ts`): definitions under
//! `/api/custom-objects/:id/links` (`weldobjects:manage`), traversal under
//! `/api/objects/:slug/records/:id/links` (`weldobjects:<slug>:read|update`)
//! and the reverse lookup under `/api/related` (`weldobjects:read`).
//!
//! Edges for every cardinality share `custom_object_relations`; the to-one
//! rules live in [`attach`], the only place an edge is created.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CUSTOM_FIELD_CREATED, CUSTOM_FIELD_DELETED, CUSTOM_FIELD_UPDATED,
};
use weldsuite_catalogs::permission_keys::{WELDOBJECTS_MANAGE, WELDOBJECTS_READ};
use weldsuite_db::{OrmConn, PgPool, orm, utc_now};
use weldsuite_events::EventType;
use weldsuite_kit::validation::{Field, Number, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    custom_object_links as links, custom_object_records as records,
    custom_object_relations as relations, custom_objects as objects,
};

use crate::objects::{CustomObject, field_json, is_lower_slug, object_by_id};
use crate::records::{Action, ObjectAccess, get_record, require_object};
use crate::targets::{self, Resolved};
use crate::{
    Answer, Caller, CoreObjectsState, Refusal, Rejected, answer, change, int4, json_row, validate,
};

const CARDINALITIES: [&str; 4] = ["one_to_one", "one_to_many", "many_to_one", "many_to_many"];
const ON_DELETE: [&str; 3] = ["restrict", "cascade", "set_null"];

/// A live `custom_object_links` row.
#[derive(Debug, Clone)]
pub(crate) struct Link {
    pub(crate) id: String,
    pub(crate) slug: String,
    pub(crate) source_entity_key: String,
    pub(crate) target_entity_key: String,
    pub(crate) cardinality: String,
    pub(crate) source_label: String,
    pub(crate) target_label: String,
    pub(crate) row: Value,
}

impl Link {
    fn from_model(model: links::Model) -> Result<Self, DbErr> {
        let row = json_row(&model)?;
        Ok(Self {
            id: model.id,
            slug: model.slug,
            source_entity_key: model.source_entity_key,
            target_entity_key: model.target_entity_key,
            cardinality: model.cardinality,
            source_label: model.source_label,
            target_label: model.target_label,
            row,
        })
    }

    fn from_models(models: Vec<links::Model>) -> Result<Vec<Self>, DbErr> {
        models.into_iter().map(Self::from_model).collect()
    }
}

/// The link with this id, deleted or not, as Drizzle returns it.
async fn link_row(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let link = links::Entity::find_by_id(id).one(&orm(db)).await?;
    link.map(json_row).transpose()
}

pub(crate) fn definition_router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreObjectsState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([WELDOBJECTS_READ, WELDOBJECTS_MANAGE]);
    let manage = || gate.require([WELDOBJECTS_MANAGE]);
    Router::new()
        .route("/link-targets", get(link_targets).route_layer(manage()))
        .route("/{id}/links", get(list_links).route_layer(read()))
        .route("/{id}/links", post(create_link).route_layer(manage()))
        .route(
            "/{id}/links/{link_id}",
            put(update_link).route_layer(manage()),
        )
        .route(
            "/{id}/links/{link_id}",
            delete(delete_link).route_layer(manage()),
        )
}

pub(crate) fn traversal_router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreObjectsState>
where
    Q: PermissionQueries + 'static,
{
    // The per-object permission is checked in the handler (`requireCustomObject`).
    let resolve = || gate.resolve();
    Router::new()
        .route(
            "/{slug}/records/{id}/links",
            get(panels).route_layer(resolve()),
        )
        .route(
            "/{slug}/records/{id}/links/{link_slug}",
            get(related).route_layer(resolve()),
        )
        .route(
            "/{slug}/records/{id}/links/{link_slug}/{target_id}",
            post(attach_route)
                .delete(detach_route)
                .route_layer(resolve()),
        )
}

pub(crate) fn reverse_router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CoreObjectsState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route(
        "/{entity_type}/{entity_id}/custom-objects",
        get(reverse).route_layer(gate.require([WELDOBJECTS_READ])),
    )
}

// ── services ───────────────────────────────────────────────────────────────

/// `listLinksForObject`.
async fn links_for_object(db: &PgPool, entity_key: &str) -> Result<Vec<Link>, DbErr> {
    let rows = links::Entity::find()
        .filter(links::Column::SourceEntityKey.eq(entity_key))
        .filter(links::Column::DeletedAt.is_null())
        .order_by_asc(links::Column::SortOrder)
        .order_by_asc(links::Column::TargetLabel)
        .all(&orm(db))
        .await?;
    Link::from_models(rows)
}

/// `getLinkBySlug`.
async fn link_by_slug(
    db: &PgPool,
    source_entity_key: &str,
    slug: &str,
) -> Result<Option<Link>, DbErr> {
    let link = links::Entity::find()
        .filter(links::Column::SourceEntityKey.eq(source_entity_key))
        .filter(links::Column::Slug.eq(slug))
        .filter(links::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    link.map(Link::from_model).transpose()
}

/// `findRestrictingLinks`: source labels of `restrict` links pointing at
/// `entity_key` that still hold edges.
pub(crate) async fn find_restricting_links(
    db: &PgPool,
    entity_key: &str,
) -> Result<Vec<String>, DbErr> {
    let db = &orm(db);
    let restricting: Vec<(String, String)> = links::Entity::find()
        .select_only()
        .columns([links::Column::Id, links::Column::SourceLabel])
        .filter(links::Column::TargetEntityKey.eq(entity_key))
        .filter(links::Column::OnDelete.eq("restrict"))
        .filter(links::Column::DeletedAt.is_null())
        .into_tuple()
        .all(db)
        .await?;
    if restricting.is_empty() {
        return Ok(Vec::new());
    }
    let ids = restricting.iter().map(|(id, _)| id.as_str());
    let with_edges: Vec<String> = relations::Entity::find()
        .select_only()
        .column(relations::Column::LinkId)
        .filter(relations::Column::LinkId.is_in(ids))
        .group_by(relations::Column::LinkId)
        .into_tuple()
        .all(db)
        .await?;
    let blocking: HashSet<String> = with_edges.into_iter().collect();
    Ok(restricting
        .into_iter()
        .filter(|(id, _)| blocking.contains(id))
        .map(|(_, label)| label)
        .collect())
}

/// What deleting a target would do to the records linked to it
/// (`applyTargetDeleteCascade(…, { dryRun: true })`).
pub(crate) struct CascadePlan {
    pub(crate) cascaded_record_ids: Vec<String>,
    pub(crate) blocked_by: Vec<String>,
}

pub(crate) async fn plan_target_delete(
    db: &PgPool,
    entity_key: &str,
    id: &str,
) -> Result<CascadePlan, DbErr> {
    let db = &orm(db);
    let mut plan = CascadePlan {
        cascaded_record_ids: Vec::new(),
        blocked_by: Vec::new(),
    };
    let edges: Vec<(String, String)> = relations::Entity::find()
        .select_only()
        .columns([relations::Column::LinkId, relations::Column::SourceId])
        .filter(relations::Column::TargetEntityKey.eq(entity_key))
        .filter(relations::Column::TargetId.eq(id))
        .into_tuple()
        .all(db)
        .await?;
    if edges.is_empty() {
        return Ok(plan);
    }
    let link_ids = unique(edges.iter().map(|(link, _)| link.clone()));
    let rules: Vec<(String, String, String)> = links::Entity::find()
        .select_only()
        .columns([
            links::Column::Id,
            links::Column::OnDelete,
            links::Column::SourceLabel,
        ])
        .filter(links::Column::Id.is_in(link_ids))
        .filter(links::Column::DeletedAt.is_null())
        .into_tuple()
        .all(db)
        .await?;
    let by_id: HashMap<String, (String, String)> = rules
        .into_iter()
        .map(|(id, rule, label)| (id, (rule, label)))
        .collect();
    for (link_id, source_id) in edges {
        let Some((rule, label)) = by_id.get(&link_id) else {
            continue;
        };
        if rule == "restrict" {
            if !plan.blocked_by.contains(label) {
                plan.blocked_by.push(label.clone());
            }
        } else if rule == "cascade" {
            plan.cascaded_record_ids.push(source_id);
        }
    }
    Ok(plan)
}

/// Distinct values in first-seen order (`[...new Set(xs)]`).
fn unique(values: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values.filter(|v| seen.insert(v.clone())).collect()
}

/// `assertValidTarget`: a built-in on the allow-list, or a live object.
async fn valid_target(db: &PgPool, target_entity_key: &str) -> Result<bool, DbErr> {
    if targets::builtin(target_entity_key).is_some() {
        return Ok(true);
    }
    let found: Option<String> = objects::Entity::find()
        .select_only()
        .column(objects::Column::Id)
        .filter(objects::Column::EntityKey.eq(target_entity_key))
        .filter(objects::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(found.is_some())
}

/// `listRelated`: what a source record is linked to through one link, with
/// targets that no longer resolve left out.
async fn list_related(db: &PgPool, link: &Link, source_id: &str) -> Result<Vec<Value>, DbErr> {
    let edges: Vec<(String, String)> = relations::Entity::find()
        .select_only()
        .columns([relations::Column::Id, relations::Column::TargetId])
        .filter(relations::Column::LinkId.eq(&link.id))
        .filter(relations::Column::SourceId.eq(source_id))
        .order_by_asc(relations::Column::SortOrder)
        .order_by_asc(relations::Column::CreatedAt)
        .into_tuple()
        .all(&orm(db))
        .await?;
    if edges.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = edges.iter().map(|(_, target)| target.clone()).collect();
    let resolved = if link.target_entity_key.starts_with("co_") {
        resolve_custom_object_targets(db, &link.target_entity_key, &ids).await?
    } else {
        targets::resolve_builtin(db, &link.target_entity_key, &ids).await?
    };
    Ok(edges
        .into_iter()
        .filter_map(|(edge_id, target_id)| {
            resolved.get(&target_id).map(|target| {
                json!({
                    "id": target.id,
                    "entityType": target.entity_type,
                    "title": target.title,
                    "href": target.href,
                    "relationId": edge_id,
                })
            })
        })
        .collect())
}

/// Custom object records by id, through their denormalised title.
async fn resolve_custom_object_targets(
    db: &PgPool,
    entity_key: &str,
    ids: &[String],
) -> Result<HashMap<String, Resolved>, DbErr> {
    let db = &orm(db);
    let mut out = HashMap::new();
    let slug: Option<String> = objects::Entity::find()
        .select_only()
        .column(objects::Column::Slug)
        .filter(objects::Column::EntityKey.eq(entity_key))
        .filter(objects::Column::DeletedAt.is_null())
        .into_tuple()
        .one(db)
        .await?;
    let Some(slug) = slug else {
        return Ok(out);
    };
    let rows: Vec<(String, Option<String>)> = records::Entity::find()
        .select_only()
        .columns([records::Column::Id, records::Column::Title])
        .filter(records::Column::EntityKey.eq(entity_key))
        .filter(records::Column::Id.is_in(ids.iter().map(String::as_str)))
        .filter(records::Column::DeletedAt.is_null())
        .into_tuple()
        .all(db)
        .await?;
    for (id, title) in rows {
        out.insert(
            id.clone(),
            Resolved {
                title: title.unwrap_or_else(|| id.clone()),
                href: format!("/objects/{slug}/{id}"),
                entity_type: entity_key.to_owned(),
                id,
            },
        );
    }
    Ok(out)
}

/// `LinkCardinalityError`: the one-to-one target is taken (409).
struct CardinalityError(String);

/// `attach`: create the edge, replacing the source's previous one on a
/// to-one link; a repeat is a no-op.
async fn attach(
    db: &PgPool,
    link: &Link,
    source_id: &str,
    target_id: &str,
    user_id: &str,
) -> Result<Result<(), CardinalityError>, Refusal> {
    use relations::Column;
    let conn = orm(db);
    if link.cardinality == "one_to_one" {
        let taken: Option<String> = relations::Entity::find()
            .select_only()
            .column(Column::SourceId)
            .filter(Column::LinkId.eq(&link.id))
            .filter(Column::TargetId.eq(target_id))
            .into_tuple()
            .one(&conn)
            .await?;
        if taken.is_some_and(|taken| taken != source_id) {
            return Ok(Err(CardinalityError(format!(
                "This {} is already linked to another record and the relationship is one-to-one",
                link.target_label.to_lowercase()
            ))));
        }
    }
    let existing: Option<String> = relations::Entity::find()
        .select_only()
        .column(Column::Id)
        .filter(Column::LinkId.eq(&link.id))
        .filter(Column::SourceId.eq(source_id))
        .filter(Column::TargetId.eq(target_id))
        .into_tuple()
        .one(&conn)
        .await?;
    if existing.is_some() {
        return Ok(Ok(()));
    }
    let to_one = matches!(link.cardinality.as_str(), "one_to_one" | "many_to_one");
    // The source's previous edge goes in the same unit as the new one.
    let replaced = to_one.then(|| {
        relations::Entity::delete_many()
            .filter(Column::LinkId.eq(&link.id))
            .filter(Column::SourceId.eq(source_id))
    });
    let edge = relations::Entity::insert(relations::ActiveModel {
        id: Set(generate_id("corl")),
        link_id: Set(link.id.clone()),
        source_entity_key: Set(link.source_entity_key.clone()),
        source_id: Set(source_id.to_owned()),
        target_entity_key: Set(link.target_entity_key.clone()),
        target_id: Set(target_id.to_owned()),
        created_by: Set(Some(user_id.to_owned())),
        created_at: Set(utc_now()),
        ..Default::default()
    });
    weldsuite_db::atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            if let Some(replaced) = replaced {
                replaced.exec(&tx).await?;
            }
            edge.exec_without_returning(&tx).await?;
            Ok::<_, Refusal>(())
        })
    })
    .await?;
    Ok(Ok(()))
}

/// `canReadTarget`: an unknown target type denies.
fn can_read_target(caller: &Caller, target_entity_key: &str) -> bool {
    targets::read_permission(target_entity_key).is_some_and(|key| caller.can(&key))
}

/// `co_<slug>:updated` for a record whose relationships changed, when the
/// object publishes events.
fn emit_source_updated(
    state: &CoreObjectsState,
    caller: &Caller,
    object: &CustomObject,
    record_id: &str,
    detail: &Value,
) {
    if !object.enable_events {
        return;
    }
    match EventType::custom_object(&object.entity_key, "updated") {
        Ok(event) => caller.publish(
            state,
            event,
            record_id,
            &json!({ "id": record_id, "relationship": detail }),
        ),
        Err(error) => tracing::error!(%error, "core objects: not a custom object key"),
    }
}

// ── definitions ────────────────────────────────────────────────────────────

async fn link_targets(caller: Caller) -> Response {
    let result: Answer = async {
        let mut data: Vec<Value> = targets::TARGETS
            .iter()
            .map(|t| json!({ "entityType": t.entity_type, "label": t.label, "kind": "builtin" }))
            .collect();
        let objects: Vec<(String, String)> = objects::Entity::find()
            .select_only()
            .columns([objects::Column::EntityKey, objects::Column::LabelPlural])
            .filter(objects::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(&caller.db))
            .await?;
        data.extend(
            objects
                .into_iter()
                .map(|(key, label)| json!({ "entityType": key, "label": label, "kind": "custom" })),
        );
        Ok(Data(data).into_response())
    }
    .await;
    answer(result, "Failed to list link targets")
}

async fn list_links(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Answer = async {
        let object = object_by_id(&caller.db, &id)
            .await?
            .ok_or_else(|| Refusal::not_found("Custom object", &id))?;
        let links = links_for_object(&caller.db, &object.entity_key).await?;
        Ok(Data(links.into_iter().map(|l| l.row).collect::<Vec<_>>()).into_response())
    }
    .await;
    answer(result, "Failed to list relationships")
}

/// `createCustomObjectLinkSchema` / `updateCustomObjectLinkSchema`.
struct LinkInput {
    data: Map<String, Value>,
    slug: String,
    target_entity_key: String,
    cardinality: String,
    source_label: Field<String>,
    target_label: Field<String>,
    on_delete: Field<String>,
    required: Field<bool>,
    sort_order: Field<i64>,
}

fn link_input(headers: &HeaderMap, body: &Bytes, create: bool) -> Result<LinkInput, Rejected> {
    validate(headers, body, |issues, fields| {
        let mut data = Map::new();
        let (mut slug, mut target_entity_key, mut cardinality) =
            (String::new(), String::new(), String::new());
        let mut target_unlinkable = false;
        if create {
            slug = issues
                .pattern(
                    fields,
                    "slug",
                    Presence::Required,
                    Some(1),
                    Some(50),
                    is_lower_slug,
                    "Slug must be lowercase alphanumeric with underscores",
                )
                .into_option()
                .unwrap_or_default();
            let target = issues.text(
                fields,
                "targetEntityKey",
                Presence::Required,
                Some(1),
                Some(30),
            );
            // The refinement's issue comes after the body's other issues.
            target_unlinkable = matches!(fields.get("targetEntityKey"), Some(Value::String(text))
                if targets::builtin(text).is_none() && !text.strip_prefix("co_").is_some_and(is_lower_slug));
            target_entity_key = target.into_option().unwrap_or_default();
            cardinality = issues
                .choice(fields, "cardinality", Presence::Required, &CARDINALITIES)
                .into_option()
                .unwrap_or_default();
            data.insert("slug".to_owned(), json!(slug));
            data.insert("targetEntityKey".to_owned(), json!(target_entity_key));
            data.insert("cardinality".to_owned(), json!(cardinality));
        }
        let label = if create {
            Presence::Required
        } else {
            Presence::Optional
        };
        let source_label = issues.text(fields, "sourceLabel", label, Some(1), Some(100));
        let target_label = issues.text(fields, "targetLabel", label, Some(1), Some(100));
        let on_delete = issues.choice(fields, "onDelete", Presence::Optional, &ON_DELETE);
        let required = issues.boolean(fields, "required", Presence::Optional);
        let sort_order =
            issues.whole_number(fields, "sortOrder", Presence::Optional, Number::default());
        if target_unlinkable {
            issues.custom(
                "targetEntityKey",
                "Target must be a supported built-in entity or a custom object key",
            );
        }
        for (key, value) in [
            ("sourceLabel", field_json(&source_label)),
            ("targetLabel", field_json(&target_label)),
            ("onDelete", field_json(&on_delete)),
            ("required", field_json(&required)),
            ("sortOrder", field_json(&sort_order)),
        ] {
            if let Some(value) = value {
                data.insert(key.to_owned(), value);
            }
        }
        LinkInput {
            data,
            slug,
            target_entity_key,
            cardinality,
            source_label,
            target_label,
            on_delete,
            required,
            sort_order,
        }
    })
}

async fn create_link(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match link_input(&headers, &body, true) {
        Ok(input) => input,
        Err(invalid) => return *invalid,
    };
    let result: Answer = async {
        let db = &caller.db;
        let object = object_by_id(db, &id).await?.ok_or_else(|| Refusal::not_found("Custom object", &id))?;
        if !valid_target(db, &input.target_entity_key).await? {
            return Err(Refusal::bad_request(format!(
                "'{}' is not a linkable entity — it is neither a supported built-in nor an existing custom object",
                input.target_entity_key
            )));
        }
        if link_by_slug(db, &object.entity_key, &input.slug).await?.is_some() {
            return Err(Refusal::conflict(format!(
                "A relationship named '{}' already exists on this object",
                input.slug
            )));
        }
        let link_id = generate_id("colk");
        links::Entity::insert(new_link(&link_id, &object.entity_key, &input)?)
            .exec_without_returning(&orm(db))
            .await?;
        let created = link_row(db, &link_id).await?;
        let mut data = Map::new();
        data.insert("id".to_owned(), json!(link_id));
        data.insert("kind".to_owned(), json!("custom_object_link"));
        data.insert("objectId".to_owned(), json!(object.id));
        data.extend(input.data);
        caller.publish(&state, CUSTOM_FIELD_CREATED, &link_id, &Value::Object(data));
        Ok(Created(created.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, "Failed to create relationship")
}

/// The row a `POST` inserts: what the body set, the schema's defaults for
/// the rest.
fn new_link(
    id: &str,
    source_entity_key: &str,
    input: &LinkInput,
) -> Result<links::ActiveModel, DbErr> {
    let now = utc_now();
    Ok(links::ActiveModel {
        id: Set(id.to_owned()),
        slug: Set(input.slug.clone()),
        source_entity_key: Set(source_entity_key.to_owned()),
        target_entity_key: Set(input.target_entity_key.clone()),
        cardinality: Set(input.cardinality.clone()),
        source_label: Set(input.source_label.as_set().cloned().unwrap_or_default()),
        target_label: Set(input.target_label.as_set().cloned().unwrap_or_default()),
        on_delete: Set(input
            .on_delete
            .as_set()
            .cloned()
            .unwrap_or_else(|| "set_null".to_owned())),
        required: Set(input.required.as_set().copied().unwrap_or(false)),
        sort_order: Set(int4(input.sort_order.as_set().copied().unwrap_or(0))?),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    })
}

/// The link `:linkId` of the object `:id` (404 for either).
async fn scoped_link(db: &PgPool, object_id: &str, link_id: &str) -> Result<Link, Refusal> {
    let object = object_by_id(db, object_id)
        .await?
        .ok_or_else(|| Refusal::not_found("Custom object", object_id))?;
    let link = links::Entity::find()
        .filter(links::Column::Id.eq(link_id))
        .filter(links::Column::SourceEntityKey.eq(&object.entity_key))
        .filter(links::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    link.map(Link::from_model)
        .transpose()?
        .ok_or_else(|| Refusal::not_found("Relationship", link_id))
}

async fn update_link(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path((object_id, link_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match link_input(&headers, &body, false) {
        Ok(input) => input,
        Err(invalid) => return *invalid,
    };
    let result: Answer = async {
        let db = &caller.db;
        scoped_link(db, &object_id, &link_id).await?;
        link_update(&input)?
            .col_expr(links::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(links::Column::Id.eq(&link_id))
            .exec(&orm(db))
            .await?;
        let updated = link_row(db, &link_id).await?;
        let mut data = Map::new();
        data.insert("id".to_owned(), json!(link_id));
        data.insert("kind".to_owned(), json!("custom_object_link"));
        data.extend(input.data);
        caller.publish(&state, CUSTOM_FIELD_UPDATED, &link_id, &Value::Object(data));
        Ok(Data(updated.unwrap_or(Value::Null)).into_response())
    }
    .await;
    answer(result, "Failed to update relationship")
}

/// The columns a `PUT` sets: only the fields the body sent.
fn link_update(input: &LinkInput) -> Result<sea_orm::UpdateMany<links::Entity>, DbErr> {
    let mut update = links::Entity::update_many();
    for (column, field) in [
        (links::Column::SourceLabel, &input.source_label),
        (links::Column::TargetLabel, &input.target_label),
        (links::Column::OnDelete, &input.on_delete),
    ] {
        if let (true, value) = change(field) {
            update = update.col_expr(column, Expr::value(value));
        }
    }
    if let (true, required) = change(&input.required) {
        update = update.col_expr(links::Column::Required, Expr::value(required));
    }
    if let (true, order) = change(&input.sort_order) {
        let order = order.map(int4).transpose()?;
        update = update.col_expr(links::Column::SortOrder, Expr::value(order));
    }
    Ok(update)
}

async fn delete_link(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path((object_id, link_id)): Path<(String, String)>,
) -> Response {
    let result: Answer = async {
        let db = &caller.db;
        let link = scoped_link(db, &object_id, &link_id).await?;
        let now = utc_now();
        let edges = relations::Entity::delete_many().filter(relations::Column::LinkId.eq(&link_id));
        let definition = links::Entity::update_many()
            .col_expr(links::Column::DeletedAt, Expr::value(now))
            .col_expr(links::Column::UpdatedAt, Expr::value(now))
            .filter(links::Column::Id.eq(&link_id));
        weldsuite_db::atomically_with(db, |tx| {
            Box::pin(async move {
                let tx = OrmConn::new(tx);
                edges.exec(&tx).await?;
                definition.exec(&tx).await?;
                Ok::<_, Refusal>(())
            })
        })
        .await?;
        caller.publish(
            &state,
            CUSTOM_FIELD_DELETED,
            &link_id,
            &json!({ "id": link_id, "kind": "custom_object_link", "slug": link.slug }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to delete relationship")
}

// ── traversal ──────────────────────────────────────────────────────────────

async fn panels(caller: Caller, Path((slug, record_id)): Path<(String, String)>) -> Response {
    let access = match require_object(&caller, &slug, Action::Read).await {
        Ok(access) => access,
        Err(refused) => return *refused,
    };
    let result: Answer = async {
        let ObjectAccess { object, scope } = &access;
        get_record(&caller.db, object, &record_id, scope.as_deref())
            .await?
            .ok_or_else(|| Refusal::not_found(&object.label_singular, &record_id))?;
        let readable: Vec<Link> = links_for_object(&caller.db, &object.entity_key)
            .await?
            .into_iter()
            .filter(|link| can_read_target(&caller, &link.target_entity_key))
            .collect();
        let mut panels = Vec::with_capacity(readable.len());
        for link in &readable {
            panels.push(json!({
                "linkId": link.id,
                "linkSlug": link.slug,
                "label": link.target_label,
                "cardinality": link.cardinality,
                "targetEntityKey": link.target_entity_key,
                "records": list_related(&caller.db, link, &record_id).await?,
            }));
        }
        Ok(Data(panels).into_response())
    }
    .await;
    answer(result, "Failed to load related records")
}

/// The record and the link a traversal route names (404 for either).
async fn record_link(
    caller: &Caller,
    access: &ObjectAccess,
    record_id: &str,
    link_slug: &str,
) -> Result<Link, Refusal> {
    let object = &access.object;
    get_record(&caller.db, object, record_id, access.scope.as_deref())
        .await?
        .ok_or_else(|| Refusal::not_found(&object.label_singular, record_id))?;
    link_by_slug(&caller.db, &object.entity_key, link_slug)
        .await?
        .ok_or_else(|| Refusal::not_found("Relationship", link_slug))
}

async fn related(
    caller: Caller,
    Path((slug, record_id, link_slug)): Path<(String, String, String)>,
) -> Response {
    let access = match require_object(&caller, &slug, Action::Read).await {
        Ok(access) => access,
        Err(refused) => return *refused,
    };
    let result: Answer = async {
        let link = record_link(&caller, &access, &record_id, &link_slug).await?;
        if !can_read_target(&caller, &link.target_entity_key) {
            return Err(Refusal::forbidden(format!(
                "You do not have permission to view {}",
                link.target_label.to_lowercase()
            )));
        }
        Ok(Data(list_related(&caller.db, &link, &record_id).await?).into_response())
    }
    .await;
    answer(result, "Failed to load related records")
}

async fn attach_route(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path((slug, record_id, link_slug, target_id)): Path<(String, String, String, String)>,
) -> Response {
    let access = match require_object(&caller, &slug, Action::Update).await {
        Ok(access) => access,
        Err(refused) => return *refused,
    };
    let result: Answer = async {
        let link = record_link(&caller, &access, &record_id, &link_slug).await?;
        if !can_read_target(&caller, &link.target_entity_key) {
            return Err(Refusal::forbidden(format!(
                "You do not have permission to link {}",
                link.target_label.to_lowercase()
            )));
        }
        if let Err(CardinalityError(message)) =
            attach(&caller.db, &link, &record_id, &target_id, &caller.user_id).await?
        {
            return Err(Refusal::conflict(message));
        }
        emit_source_updated(
            &state,
            &caller,
            &access.object,
            &record_id,
            &json!({
                "link": link.slug,
                "action": "attached",
                "targetEntityKey": link.target_entity_key,
                "targetId": target_id,
            }),
        );
        Ok(Created(list_related(&caller.db, &link, &record_id).await?).into_response())
    }
    .await;
    answer(result, "Failed to link records")
}

async fn detach_route(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path((slug, record_id, link_slug, target_id)): Path<(String, String, String, String)>,
) -> Response {
    let access = match require_object(&caller, &slug, Action::Update).await {
        Ok(access) => access,
        Err(refused) => return *refused,
    };
    let result: Answer = async {
        let link = record_link(&caller, &access, &record_id, &link_slug).await?;
        relations::Entity::delete_many()
            .filter(relations::Column::LinkId.eq(&link.id))
            .filter(relations::Column::SourceId.eq(&record_id))
            .filter(relations::Column::TargetId.eq(&target_id))
            .exec(&orm(&caller.db))
            .await?;
        emit_source_updated(
            &state,
            &caller,
            &access.object,
            &record_id,
            &json!({
                "link": link.slug,
                "action": "detached",
                "targetEntityKey": link.target_entity_key,
                "targetId": target_id,
            }),
        );
        Ok(NoContent.into_response())
    }
    .await;
    answer(result, "Failed to unlink records")
}

// ── reverse lookup ─────────────────────────────────────────────────────────

/// `listReversePanels`: every custom object record linked to a record,
/// grouped by link, in the order the edges come.
async fn reverse_panels(
    db: &PgPool,
    target_entity_key: &str,
    target_id: &str,
) -> Result<Vec<(String, Value)>, DbErr> {
    let db = &orm(db);
    let edges: Vec<(String, String, String)> = relations::Entity::find()
        .select_only()
        .columns([
            relations::Column::Id,
            relations::Column::LinkId,
            relations::Column::SourceId,
        ])
        .filter(relations::Column::TargetEntityKey.eq(target_entity_key))
        .filter(relations::Column::TargetId.eq(target_id))
        .into_tuple()
        .all(db)
        .await?;
    if edges.is_empty() {
        return Ok(Vec::new());
    }
    let link_ids = unique(edges.iter().map(|(_, link, _)| link.clone()));
    let live_links = links::Entity::find()
        .filter(links::Column::Id.is_in(link_ids))
        .filter(links::Column::DeletedAt.is_null())
        .all(db)
        .await?;
    let links: HashMap<String, Link> = Link::from_models(live_links)?
        .into_iter()
        .map(|l| (l.id.clone(), l))
        .collect();
    let source_keys = unique(links.values().map(|l| l.source_entity_key.clone()));
    let objects: Vec<(String, String, String)> = if source_keys.is_empty() {
        Vec::new()
    } else {
        objects::Entity::find()
            .select_only()
            .columns([
                objects::Column::EntityKey,
                objects::Column::Slug,
                objects::Column::LabelPlural,
            ])
            .filter(objects::Column::EntityKey.is_in(source_keys))
            .filter(objects::Column::DeletedAt.is_null())
            .into_tuple()
            .all(db)
            .await?
    };
    let objects: HashMap<String, (String, String)> = objects
        .into_iter()
        .map(|(key, slug, label)| (key, (slug, label)))
        .collect();
    let source_ids = unique(edges.iter().map(|(_, _, source)| source.clone()));
    let records: Vec<(String, Option<String>)> = records::Entity::find()
        .select_only()
        .columns([records::Column::Id, records::Column::Title])
        .filter(records::Column::Id.is_in(source_ids))
        .filter(records::Column::DeletedAt.is_null())
        .into_tuple()
        .all(db)
        .await?;
    let records: HashMap<String, Option<String>> = records.into_iter().collect();

    let mut panels: Vec<(String, Value)> = Vec::new();
    for (edge_id, link_id, source_id) in edges {
        let Some(link) = links.get(&link_id) else {
            continue;
        };
        let Some((slug, label_plural)) = objects.get(&link.source_entity_key) else {
            continue;
        };
        let Some(title) = records.get(&source_id) else {
            continue;
        };
        let entry = json!({
            "id": source_id,
            "title": title.clone().unwrap_or_else(|| source_id.clone()),
            "href": format!("/objects/{slug}/{source_id}"),
            "relationId": edge_id,
        });
        if let Some((_, panel)) = panels.iter_mut().find(|(id, _)| *id == link.id) {
            if let Some(list) = panel["records"].as_array_mut() {
                list.push(entry);
            }
        } else {
            panels.push((
                link.id.clone(),
                json!({
                    "linkId": link.id,
                    "linkSlug": link.slug,
                    "label": link.source_label,
                    "objectSlug": slug,
                    "objectLabelPlural": label_plural,
                    "records": [entry],
                }),
            ));
        }
    }
    Ok(panels)
}

async fn reverse(
    caller: Caller,
    Path((entity_type, entity_id)): Path<(String, String)>,
) -> Response {
    let result: Answer = async {
        let panels = reverse_panels(&caller.db, &entity_type, &entity_id).await?;
        let visible: Vec<Value> = panels
            .into_iter()
            .map(|(_, panel)| panel)
            .filter(|panel| {
                let slug = panel["objectSlug"].as_str().unwrap_or_default();
                can_read_target(&caller, &format!("co_{slug}"))
            })
            .collect();
        Ok(Data(visible).into_response())
    }
    .await;
    answer(result, "Failed to load related custom object records")
}
