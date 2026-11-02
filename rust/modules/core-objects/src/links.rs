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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events::{
    CUSTOM_FIELD_CREATED, CUSTOM_FIELD_DELETED, CUSTOM_FIELD_UPDATED,
};
use weldsuite_catalogs::permission_keys::{WELDOBJECTS_MANAGE, WELDOBJECTS_READ};
use weldsuite_db::PgPool;
use weldsuite_events::EventType;
use weldsuite_kit::validation::{Field, Number, Presence};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::objects::{CustomObject, field_json, is_lower_slug, object_by_id};
use crate::records::{Action, ObjectAccess, get_record, require_object};
use crate::targets::{self, Resolved};
use crate::{
    Answer, Caller, CoreObjectsState, Refusal, Rejected, STAMPS, answer, change, now, row, validate,
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
    fn from_row(raw: Value) -> Self {
        let row = row(raw, &STAMPS);
        let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
        Self {
            id: text("id"),
            slug: text("slug"),
            source_entity_key: text("sourceEntityKey"),
            target_entity_key: text("targetEntityKey"),
            cardinality: text("cardinality"),
            source_label: text("sourceLabel"),
            target_label: text("targetLabel"),
            row,
        }
    }
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
async fn links_for_object(db: &PgPool, entity_key: &str) -> Result<Vec<Link>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from custom_object_links l
          where source_entity_key = $1 and deleted_at is null
          order by sort_order asc, target_label asc",
    )
    .bind(entity_key)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Link::from_row).collect())
}

/// `getLinkBySlug`.
async fn link_by_slug(
    db: &PgPool,
    source_entity_key: &str,
    slug: &str,
) -> Result<Option<Link>, sqlx::Error> {
    let raw: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from custom_object_links l
          where source_entity_key = $1 and slug = $2 and deleted_at is null limit 1",
    )
    .bind(source_entity_key)
    .bind(slug)
    .fetch_optional(db)
    .await?;
    Ok(raw.map(Link::from_row))
}

/// `findRestrictingLinks`: source labels of `restrict` links pointing at
/// `entity_key` that still hold edges.
pub(crate) async fn find_restricting_links(
    db: &PgPool,
    entity_key: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let restricting: Vec<(String, String)> = sqlx::query_as(
        "select id, source_label from custom_object_links
          where target_entity_key = $1 and on_delete = 'restrict' and deleted_at is null",
    )
    .bind(entity_key)
    .fetch_all(db)
    .await?;
    if restricting.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = restricting.iter().map(|(id, _)| id.clone()).collect();
    let with_edges: Vec<String> = sqlx::query_scalar(
        "select link_id from custom_object_relations where link_id = any($1) group by link_id",
    )
    .bind(&ids)
    .fetch_all(db)
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
) -> Result<CascadePlan, sqlx::Error> {
    let mut plan = CascadePlan {
        cascaded_record_ids: Vec::new(),
        blocked_by: Vec::new(),
    };
    let edges: Vec<(String, String)> = sqlx::query_as(
        "select link_id, source_id from custom_object_relations where target_entity_key = $1 and target_id = $2",
    )
    .bind(entity_key)
    .bind(id)
    .fetch_all(db)
    .await?;
    if edges.is_empty() {
        return Ok(plan);
    }
    let link_ids = unique(edges.iter().map(|(link, _)| link.clone()));
    let links: Vec<(String, String, String)> = sqlx::query_as(
        "select id, on_delete, source_label from custom_object_links where id = any($1) and deleted_at is null",
    )
    .bind(&link_ids)
    .fetch_all(db)
    .await?;
    let by_id: HashMap<String, (String, String)> = links
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
async fn valid_target(db: &PgPool, target_entity_key: &str) -> Result<bool, sqlx::Error> {
    if targets::builtin(target_entity_key).is_some() {
        return Ok(true);
    }
    let found: Option<String> = sqlx::query_scalar(
        "select id from custom_objects where entity_key = $1 and deleted_at is null limit 1",
    )
    .bind(target_entity_key)
    .fetch_optional(db)
    .await?;
    Ok(found.is_some())
}

/// `listRelated`: what a source record is linked to through one link, with
/// targets that no longer resolve left out.
async fn list_related(
    db: &PgPool,
    link: &Link,
    source_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let edges: Vec<(String, String)> = sqlx::query_as(
        "select id, target_id from custom_object_relations
          where link_id = $1 and source_id = $2
          order by sort_order asc, created_at asc",
    )
    .bind(&link.id)
    .bind(source_id)
    .fetch_all(db)
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
) -> Result<HashMap<String, Resolved>, sqlx::Error> {
    let mut out = HashMap::new();
    let slug: Option<String> = sqlx::query_scalar(
        "select slug from custom_objects where entity_key = $1 and deleted_at is null limit 1",
    )
    .bind(entity_key)
    .fetch_optional(db)
    .await?;
    let Some(slug) = slug else {
        return Ok(out);
    };
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "select id, title from custom_object_records
          where entity_key = $1 and id = any($2) and deleted_at is null",
    )
    .bind(entity_key)
    .bind(ids)
    .fetch_all(db)
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
) -> Result<Result<(), CardinalityError>, sqlx::Error> {
    if link.cardinality == "one_to_one" {
        let taken: Option<String> = sqlx::query_scalar(
            "select source_id from custom_object_relations where link_id = $1 and target_id = $2 limit 1",
        )
        .bind(&link.id)
        .bind(target_id)
        .fetch_optional(db)
        .await?;
        if taken.is_some_and(|taken| taken != source_id) {
            return Ok(Err(CardinalityError(format!(
                "This {} is already linked to another record and the relationship is one-to-one",
                link.target_label.to_lowercase()
            ))));
        }
    }
    let existing: Option<String> = sqlx::query_scalar(
        "select id from custom_object_relations where link_id = $1 and source_id = $2 and target_id = $3 limit 1",
    )
    .bind(&link.id)
    .bind(source_id)
    .bind(target_id)
    .fetch_optional(db)
    .await?;
    if existing.is_some() {
        return Ok(Ok(()));
    }
    let to_one = matches!(link.cardinality.as_str(), "one_to_one" | "many_to_one");
    let mut statements = Vec::new();
    if to_one {
        statements.push(
            sqlx::query(
                "delete from custom_object_relations where link_id = $1 and source_id = $2",
            )
            .bind(&link.id)
            .bind(source_id),
        );
    }
    statements.push(
        sqlx::query(
            "insert into custom_object_relations
                 (id, link_id, source_entity_key, source_id, target_entity_key, target_id, created_by, created_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8::timestamp)",
        )
        .bind(generate_id("corl"))
        .bind(&link.id)
        .bind(&link.source_entity_key)
        .bind(source_id)
        .bind(&link.target_entity_key)
        .bind(target_id)
        .bind(user_id)
        .bind(now()),
    );
    weldsuite_db::atomically(db, statements).await?;
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
        let objects: Vec<(String, String)> = sqlx::query_as(
            "select entity_key, label_plural from custom_objects where deleted_at is null",
        )
        .fetch_all(&caller.db)
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
        sqlx::query(
            "insert into custom_object_links
                 (id, slug, source_entity_key, target_entity_key, cardinality, source_label, target_label,
                  on_delete, required, sort_order, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::int, $11::timestamp, $11::timestamp)",
        )
        .bind(&link_id)
        .bind(&input.slug)
        .bind(&object.entity_key)
        .bind(&input.target_entity_key)
        .bind(&input.cardinality)
        .bind(input.source_label.as_set())
        .bind(input.target_label.as_set())
        .bind(input.on_delete.as_set().map_or("set_null", String::as_str))
        .bind(input.required.as_set().copied().unwrap_or(false))
        .bind(input.sort_order.as_set().copied().unwrap_or(0))
        .bind(now())
        .execute(db)
        .await?;
        let created: Option<Value> = sqlx::query_scalar("select to_jsonb(l) from custom_object_links l where id = $1 limit 1")
            .bind(&link_id)
            .fetch_optional(db)
            .await?;
        let mut data = Map::new();
        data.insert("id".to_owned(), json!(link_id));
        data.insert("kind".to_owned(), json!("custom_object_link"));
        data.insert("objectId".to_owned(), json!(object.id));
        data.extend(input.data);
        caller.publish(&state, CUSTOM_FIELD_CREATED, &link_id, &Value::Object(data));
        Ok(Created(created.map_or(Value::Null, |c| row(c, &STAMPS))).into_response())
    }
    .await;
    answer(result, "Failed to create relationship")
}

/// The link `:linkId` of the object `:id` (404 for either).
async fn scoped_link(db: &PgPool, object_id: &str, link_id: &str) -> Result<Link, Refusal> {
    let object = object_by_id(db, object_id)
        .await?
        .ok_or_else(|| Refusal::not_found("Custom object", object_id))?;
    let raw: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from custom_object_links l
          where id = $1 and source_entity_key = $2 and deleted_at is null limit 1",
    )
    .bind(link_id)
    .bind(&object.entity_key)
    .fetch_optional(db)
    .await?;
    raw.map(Link::from_row)
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
        let (set_source, source) = change(&input.source_label);
        let (set_target, target) = change(&input.target_label);
        let (set_rule, rule) = change(&input.on_delete);
        let (set_required, required) = change(&input.required);
        let (set_order, order) = change(&input.sort_order);
        sqlx::query(
            "update custom_object_links set
                 source_label = case when $2 then $3 else source_label end,
                 target_label = case when $4 then $5 else target_label end,
                 on_delete = case when $6 then $7 else on_delete end,
                 required = case when $8 then $9 else required end,
                 sort_order = case when $10 then $11::int else sort_order end,
                 updated_at = $12::timestamp
             where id = $1",
        )
        .bind(&link_id)
        .bind(set_source)
        .bind(source)
        .bind(set_target)
        .bind(target)
        .bind(set_rule)
        .bind(rule)
        .bind(set_required)
        .bind(required)
        .bind(set_order)
        .bind(order)
        .bind(now())
        .execute(db)
        .await?;
        let updated: Option<Value> = sqlx::query_scalar(
            "select to_jsonb(l) from custom_object_links l where id = $1 limit 1",
        )
        .bind(&link_id)
        .fetch_optional(db)
        .await?;
        let mut data = Map::new();
        data.insert("id".to_owned(), json!(link_id));
        data.insert("kind".to_owned(), json!("custom_object_link"));
        data.extend(input.data);
        caller.publish(&state, CUSTOM_FIELD_UPDATED, &link_id, &Value::Object(data));
        Ok(Data(updated.map_or(Value::Null, |u| row(u, &STAMPS))).into_response())
    }
    .await;
    answer(result, "Failed to update relationship")
}

async fn delete_link(
    State(state): State<CoreObjectsState>,
    caller: Caller,
    Path((object_id, link_id)): Path<(String, String)>,
) -> Response {
    let result: Answer = async {
        let db = &caller.db;
        let link = scoped_link(db, &object_id, &link_id).await?;
        let now = now();
        weldsuite_db::atomically(
            db,
            [
                sqlx::query("delete from custom_object_relations where link_id = $1").bind(&link_id),
                sqlx::query(
                    "update custom_object_links set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
                )
                .bind(&link_id)
                .bind(&now),
            ],
        )
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
        sqlx::query("delete from custom_object_relations where link_id = $1 and source_id = $2 and target_id = $3")
            .bind(&link.id)
            .bind(&record_id)
            .bind(&target_id)
            .execute(&caller.db)
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
) -> Result<Vec<(String, Value)>, sqlx::Error> {
    let edges: Vec<(String, String, String)> = sqlx::query_as(
        "select id, link_id, source_id from custom_object_relations where target_entity_key = $1 and target_id = $2",
    )
    .bind(target_entity_key)
    .bind(target_id)
    .fetch_all(db)
    .await?;
    if edges.is_empty() {
        return Ok(Vec::new());
    }
    let link_ids = unique(edges.iter().map(|(_, link, _)| link.clone()));
    let links: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from custom_object_links l where id = any($1) and deleted_at is null",
    )
    .bind(&link_ids)
    .fetch_all(db)
    .await?;
    let links: HashMap<String, Link> = links
        .into_iter()
        .map(Link::from_row)
        .map(|l| (l.id.clone(), l))
        .collect();
    let source_keys = unique(links.values().map(|l| l.source_entity_key.clone()));
    let objects: Vec<(String, String, String)> = if source_keys.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "select entity_key, slug, label_plural from custom_objects where entity_key = any($1) and deleted_at is null",
        )
        .bind(&source_keys)
        .fetch_all(db)
        .await?
    };
    let objects: HashMap<String, (String, String)> = objects
        .into_iter()
        .map(|(key, slug, label)| (key, (slug, label)))
        .collect();
    let source_ids = unique(edges.iter().map(|(_, _, source)| source.clone()));
    let records: Vec<(String, Option<String>)> = sqlx::query_as(
        "select id, title from custom_object_records where id = any($1) and deleted_at is null",
    )
    .bind(&source_ids)
    .fetch_all(db)
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
