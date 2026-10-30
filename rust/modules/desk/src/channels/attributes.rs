//! The conversation is the ticket: its type (`helpdesk_ticket_types`),
//! priority, tags, team (`helpdesk_departments`) and the type's custom
//! fields. `updateDeskConversationAttributes`, `getDeskConversationCustomFields`
//! and `normalizeDeskTags` of `@weldsuite/db/lib/desk`, and
//! `getDeskAttributeOptions` (`apps/workers/desk-api/src/services/desk-attributes.ts`).
//!
//! The custom field values live in `custom_field_values` under entity type
//! `desk_conversation`, read and written with the shared value code
//! (`weldsuite_core_domain::custom_field_values`) against the ticket type's
//! definitions. Every change lands on the timeline as one internal
//! `attributes_changed` event.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use weldsuite_core_domain::custom_field_values::{self as values, Definition, ValuesError};
use weldsuite_core_domain::js::{Js, as_text, js_date, slice_utf16};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, js_trim};

use super::webchat::{self, Append, AppendError};
use crate::custom_fields::ticket_field_definitions;

/// `DESK_CONVERSATION_FIELD_ENTITY`: `custom_field_values.entity_type`.
const FIELD_ENTITY: &str = "desk_conversation";

/// `DESK_PRIORITIES`.
pub(crate) const PRIORITIES: &[&str] = &["low", "medium", "high", "urgent"];
/// `DESK_MAX_TAGS`.
pub(crate) const MAX_TAGS: usize = 20;
/// `DESK_MAX_TAG_LENGTH`.
pub(crate) const MAX_TAG_LENGTH: usize = 50;

/// How many of the most used tags the picker suggests (`TAG_SUGGESTIONS`).
const TAG_SUGGESTIONS: i64 = 100;
/// Tags are counted over conversations active this recently (`TAG_WINDOW_DAYS`).
const TAG_WINDOW_DAYS: i32 = 90;

// ── the options ───────────────────────────────────────────────────────────────

/// `getDeskAttributeOptions(db)`: the active ticket types, their fields, the
/// active teams and the tags in use.
pub(crate) async fn options(db: &PgPool) -> Result<Value, sqlx::Error> {
    let ticket_types: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'name', name, 'description', description,
                                   'icon', icon, 'color', color)
           from helpdesk_ticket_types
          where deleted_at is null and is_active = true
          order by sort_order asc, name asc",
    )
    .fetch_all(db)
    .await?;
    let teams: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'name', name)
           from helpdesk_departments
          where deleted_at is null and is_active = true
          order by name asc",
    )
    .fetch_all(db)
    .await?;
    let fields: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'ticketTypeId', ticket_type_id, 'slug', slug,
                                   'name', name, 'description', description,
                                   'fieldType', field_type, 'options', options,
                                   'required', coalesce(required, false),
                                   'sortOrder', coalesce(sort_order, 0))
           from custom_field_definitions
          where entity_type = 'ticket' and deleted_at is null
          order by sort_order asc, name asc",
    )
    .fetch_all(db)
    .await?;
    let tags: Vec<(String, i32)> = sqlx::query_as(
        "select tag, count(*)::int as count
           from desk_conversations, jsonb_array_elements_text(desk_conversations.tags) as tag
          where desk_conversations.tags <> '[]'::jsonb
            and coalesce(desk_conversations.last_message_at, desk_conversations.created_at)
                > now() - make_interval(days => $1)
          group by tag
          order by count desc, tag asc
          limit $2",
    )
    .bind(TAG_WINDOW_DAYS)
    .bind(TAG_SUGGESTIONS)
    .fetch_all(db)
    .await?;
    let tags: Vec<Value> = tags
        .into_iter()
        .map(|(tag, count)| json!({ "tag": tag, "count": count }))
        .collect();
    Ok(json!({
        "ticketTypes": ticket_types,
        "teams": teams,
        "fields": fields,
        "tags": tags,
    }))
}

// ── the values ────────────────────────────────────────────────────────────────

/// The custom field values (slug → value) of `id` against `definitions`.
async fn read_values(
    db: &PgPool,
    id: &str,
    definitions: &[(Definition, String)],
) -> Result<Map<String, Value>, sqlx::Error> {
    if definitions.is_empty() {
        return Ok(Map::new());
    }
    let definitions: Vec<Definition> = definitions.iter().map(|(d, _)| d.clone()).collect();
    let mut by_entity =
        values::values_for(db, FIELD_ENTITY, &[id.to_owned()], &definitions).await?;
    Ok(by_entity.remove(id).unwrap_or_default())
}

/// `getDeskConversationCustomFields(db, conversation)`: the values for the
/// conversation's current type.
pub(crate) async fn custom_fields(
    db: &PgPool,
    conversation: &Value,
) -> Result<Map<String, Value>, sqlx::Error> {
    let definitions = ticket_field_definitions(db, conversation["ticketTypeId"].as_str()).await?;
    let id = conversation["id"].as_str().unwrap_or_default();
    read_values(db, id, &definitions).await
}

// ── the update ────────────────────────────────────────────────────────────────

/// `UpdateDeskConversationAttributesInput`: absent leaves a field alone,
/// null clears it.
pub(crate) struct Update {
    pub(crate) ticket_type_id: Field<String>,
    pub(crate) priority: Field<String>,
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) department_id: Field<String>,
    /// Slug → value, in the body's order.
    pub(crate) custom_fields: Vec<(String, Js)>,
}

/// Why the update stopped.
pub(crate) enum UpdateError {
    /// `DeskConversationNotFoundError`.
    NotFound,
    /// `DeskAttributeRejectedError`: a 400 with `{ field }`.
    Rejected {
        field: &'static str,
        message: String,
    },
    Failed(String),
}

impl From<sqlx::Error> for UpdateError {
    fn from(error: sqlx::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

/// `DeskConversationAttributesResult`.
pub(crate) struct Updated {
    pub(crate) conversation: Value,
    /// The `attributes_changed` event, or `None` when nothing changed.
    pub(crate) message: Option<Value>,
    pub(crate) custom_fields: Map<String, Value>,
}

/// `normalizeDeskTags(tags)`: spaces collapsed and trimmed, empties and
/// case-insensitive duplicates dropped, at most [`MAX_TAGS`].
pub(crate) fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in tags {
        let collapsed = webchat::collapse_whitespace(raw);
        let tag = slice_utf16(js_trim(&collapsed), MAX_TAG_LENGTH);
        let key = tag.to_lowercase();
        if tag.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(tag);
    }
    out.truncate(MAX_TAGS);
    out
}

/// `isEmptyValue(value)`: null, `''` or an empty list.
fn is_empty(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn is_empty_js(value: &Js) -> bool {
    match value {
        Js::Null => true,
        Js::String(text) => text.is_empty(),
        Js::Array(items) => items.is_empty(),
        _ => false,
    }
}

/// `sameFieldValue(def, a, b)`.
fn same_value(definition: &Definition, a: &Value, b: &Value) -> bool {
    if is_empty(a) || is_empty(b) {
        return is_empty(a) && is_empty(b);
    }
    if definition.field_type == "date" {
        // `new Date(a).getTime() === new Date(b).getTime()`: NaN never equals.
        let time = |v: &Value| js_date(&as_text(&Js::from_jsonb(v)));
        return matches!((time(a), time(b)), (Some(x), Some(y)) if x == y);
    }
    a == b
}

/// A type or team: where its rows live and how a change is named.
struct Reference {
    /// The rows of `ids` (`$1`): id, name, `is_active`, deleted.
    sql: &'static str,
    input: &'static str,
    field: &'static str,
    noun: &'static str,
}

const TICKET_TYPE: Reference = Reference {
    sql: "select id, name, is_active, deleted_at is not null from helpdesk_ticket_types where id = any($1)",
    input: "ticketTypeId",
    field: "ticketType",
    noun: "Ticket type",
};

const TEAM: Reference = Reference {
    sql: "select id, name, is_active, deleted_at is not null from helpdesk_departments where id = any($1)",
    input: "departmentId",
    field: "team",
    noun: "Team",
};

type ReferenceRow = (String, String, Option<bool>, bool);

/// `referenceChange(db, ref, from, to)`: the new id must name a usable row;
/// the change carries both names. `None` when the id doesn't change.
async fn reference_change(
    db: &PgPool,
    reference: &Reference,
    from: Option<&str>,
    to: &Field<String>,
) -> Result<Option<(Option<String>, Value)>, UpdateError> {
    let to = match to {
        Field::Absent => return Ok(None),
        Field::Null => None,
        Field::Set(id) => Some(id.as_str()),
    };
    if to == from {
        return Ok(None);
    }
    let wanted: Vec<String> = [from, to]
        .into_iter()
        .flatten()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
    let rows: Vec<ReferenceRow> = if wanted.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(reference.sql)
            .bind(&wanted)
            .fetch_all(db)
            .await?
    };
    let names: HashMap<String, (String, bool)> = rows
        .into_iter()
        .map(|(id, name, active, deleted)| (id, (name, active != Some(false) && !deleted)))
        .collect();
    if let Some(id) = to.filter(|id| !id.is_empty())
        && !names.get(id).is_some_and(|(_, usable)| *usable)
    {
        return Err(UpdateError::Rejected {
            field: reference.input,
            message: format!("{} '{id}' does not exist or is inactive", reference.noun),
        });
    }
    let name_of = |id: Option<&str>| {
        id.filter(|id| !id.is_empty())
            .and_then(|id| names.get(id))
            .map_or(Value::Null, |(name, _)| json!(name))
    };
    let change = json!({ "field": reference.field, "from": name_of(from), "to": name_of(to) });
    Ok(Some((to.map(str::to_owned), change)))
}

/// The column patch: `None` leaves a column alone.
#[derive(Default)]
struct Patch {
    #[allow(clippy::option_option)] // left alone vs cleared
    ticket_type_id: Option<Option<String>>,
    #[allow(clippy::option_option)]
    department_id: Option<Option<String>>,
    #[allow(clippy::option_option)]
    priority: Option<Option<String>>,
    tags: Option<Vec<String>>,
}

impl Patch {
    fn is_empty(&self) -> bool {
        self.ticket_type_id.is_none()
            && self.department_id.is_none()
            && self.priority.is_none()
            && self.tags.is_none()
    }
}

/// `columnChanges(db, current, input)`: type, team, priority and tags.
async fn column_changes(
    db: &PgPool,
    current: &Value,
    input: &Update,
) -> Result<(Patch, Vec<Value>), UpdateError> {
    let mut patch = Patch::default();
    let mut changes = Vec::new();
    let current_type = current["ticketTypeId"].as_str();
    if let Some((id, change)) =
        reference_change(db, &TICKET_TYPE, current_type, &input.ticket_type_id).await?
    {
        patch.ticket_type_id = Some(id);
        changes.push(change);
    }
    let current_team = current["departmentId"].as_str();
    if let Some((id, change)) =
        reference_change(db, &TEAM, current_team, &input.department_id).await?
    {
        patch.department_id = Some(id);
        changes.push(change);
    }
    let priority = match &input.priority {
        Field::Absent => None,
        Field::Null => Some(None),
        Field::Set(priority) => Some(Some(priority.clone())),
    };
    if let Some(priority) = priority
        && priority.as_deref() != current["priority"].as_str()
    {
        changes.push(json!({ "field": "priority", "from": current["priority"], "to": priority }));
        patch.priority = Some(priority);
    }
    if let Some(tags) = &input.tags {
        let tags = normalize_tags(tags);
        let before = match &current["tags"] {
            Value::Null => json!([]),
            other => other.clone(),
        };
        if before != json!(tags) {
            changes.push(json!({ "field": "tags", "from": before, "to": tags }));
            patch.tags = Some(tags);
        }
    }
    Ok((patch, changes))
}

/// `customFieldChanges(db, id, definitions, values)`: the values checked
/// against the type's definitions, and the ones that change. Nothing is
/// written yet.
async fn custom_field_changes(
    db: &PgPool,
    id: &str,
    definitions: &[(Definition, String)],
    input: &[(String, Js)],
) -> Result<(Vec<Value>, Vec<(String, Js)>), UpdateError> {
    let mut changes = Vec::new();
    let mut writes = Vec::new();
    if input.is_empty() {
        return Ok((changes, writes));
    }
    // `new Map(definitions.map(d => [d.slug, d]))`: the last of a slug wins.
    let mut by_slug: HashMap<&str, &(Definition, String)> = HashMap::new();
    for entry in definitions {
        by_slug.insert(entry.0.slug.as_str(), entry);
    }
    let unknown: Vec<&str> = input
        .iter()
        .map(|(slug, _)| slug.as_str())
        .filter(|slug| !by_slug.contains_key(slug))
        .collect();
    if !unknown.is_empty() {
        return Err(UpdateError::Rejected {
            field: "customFields",
            message: format!("Unknown field for this ticket type: {}", unknown.join(", ")),
        });
    }
    let stored = read_values(db, id, definitions).await?;
    for (slug, raw) in input {
        let Some((definition, name)) = by_slug.get(slug.as_str()) else {
            continue;
        };
        // Required is enforced by whoever closes or submits, not on every
        // edit: an agent may clear a field on the way to the right value.
        let next = if is_empty_js(raw) {
            Value::Null
        } else {
            values::coerce(definition, raw).map_err(|message| UpdateError::Rejected {
                field: "customFields",
                message,
            })?
        };
        let prev = stored.get(slug).cloned().unwrap_or(Value::Null);
        if same_value(definition, &prev, &next) {
            continue;
        }
        changes.push(json!({
            "field": "customField",
            "key": slug,
            "label": name,
            "from": prev,
            "to": next,
        }));
        writes.push((slug.clone(), Js::from_jsonb(&next)));
    }
    Ok((changes, writes))
}

/// `writeDeskCustomFields`: a value the store refuses is a 400 too.
async fn write_values(
    db: &PgPool,
    id: &str,
    definitions: &[(Definition, String)],
    writes: &[(String, Js)],
) -> Result<(), UpdateError> {
    if writes.is_empty() {
        return Ok(());
    }
    let definitions: Vec<Definition> = definitions.iter().map(|(d, _)| d.clone()).collect();
    values::set_values(db, FIELD_ENTITY, id, writes, &definitions, true, false)
        .await
        .map_err(|error| match error {
            ValuesError::Invalid(message) => UpdateError::Rejected {
                field: "customFields",
                message,
            },
            ValuesError::Database(error) => error.into(),
        })
}

/// The column patch, with `updatedAt`.
async fn write_columns(db: &PgPool, id: &str, patch: &Patch) -> Result<(), sqlx::Error> {
    if patch.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "update desk_conversations set
             ticket_type_id = case when $2 then $3 else ticket_type_id end,
             department_id = case when $4 then $5 else department_id end,
             priority = case when $6 then $7 else priority end,
             tags = case when $8 then $9::jsonb else tags end,
             updated_at = $10::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(patch.ticket_type_id.is_some())
    .bind(patch.ticket_type_id.clone().flatten())
    .bind(patch.department_id.is_some())
    .bind(patch.department_id.clone().flatten())
    .bind(patch.priority.is_some())
    .bind(patch.priority.clone().flatten())
    .bind(patch.tags.is_some())
    .bind(patch.tags.as_ref().map(|tags| json!(tags)))
    .bind(crate::now())
    .execute(db)
    .await?;
    Ok(())
}

/// `updateDeskConversationAttributes(db, input)`: checks the type and team
/// exist and are active, validates the custom field values against the
/// (new) type, writes only what changed, and appends one internal
/// `attributes_changed` event listing the changes. A call that changes
/// nothing writes nothing.
pub(crate) async fn update(
    db: &PgPool,
    conversation_id: &str,
    author_id: &str,
    input: &Update,
) -> Result<Updated, UpdateError> {
    let Some((current, _)) = webchat::get(db, conversation_id, false).await? else {
        return Err(UpdateError::NotFound);
    };
    let (patch, mut changes) = column_changes(db, &current, input).await?;

    let ticket_type_id = match &patch.ticket_type_id {
        Some(id) => id.clone(),
        None => current["ticketTypeId"].as_str().map(str::to_owned),
    };
    let definitions = ticket_field_definitions(db, ticket_type_id.as_deref()).await?;
    let (field_changes, writes) =
        custom_field_changes(db, conversation_id, &definitions, &input.custom_fields).await?;
    changes.extend(field_changes);

    if changes.is_empty() {
        let custom_fields = read_values(db, conversation_id, &definitions).await?;
        return Ok(Updated {
            conversation: current,
            message: None,
            custom_fields,
        });
    }

    write_values(db, conversation_id, &definitions, &writes).await?;
    write_columns(db, conversation_id, &patch).await?;

    let mut metadata = Map::new();
    metadata.insert("eventType".to_owned(), json!("attributes_changed"));
    metadata.insert("changes".to_owned(), Value::Array(changes));
    let appended = webchat::append_desk_message(
        db,
        Append {
            conversation_id,
            kind: "event",
            author_type: "agent",
            author_id: Some(author_id),
            body: None,
            attachments: None,
            metadata: Some(metadata),
            assignee_id: None,
        },
    )
    .await;
    let (conversation, message) = match appended {
        Ok(done) => done,
        Err(AppendError::NotFound) => return Err(UpdateError::NotFound),
        Err(AppendError::Write(error)) => return Err(UpdateError::Failed(error.to_string())),
    };
    let custom_fields = read_values(db, conversation_id, &definitions).await?;
    Ok(Updated {
        conversation,
        message: Some(message),
        custom_fields,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(list: &[&str]) -> Vec<String> {
        list.iter().map(|t| (*t).to_owned()).collect()
    }

    #[test]
    fn tags_are_trimmed_collapsed_and_deduplicated() {
        assert_eq!(
            normalize_tags(&tags(&["  Refund ", "vip", "refund", "two   words", ""])),
            tags(&["Refund", "vip", "two words"])
        );
    }

    #[test]
    fn tags_are_capped() {
        let many: Vec<String> = (0..30).map(|i| format!("t{i}")).collect();
        assert_eq!(normalize_tags(&many).len(), MAX_TAGS);
        let long = "x".repeat(80);
        assert_eq!(normalize_tags(&[long])[0].len(), MAX_TAG_LENGTH);
    }

    #[test]
    fn empty_values_match_each_other() {
        let definition = Definition {
            id: "f".into(),
            slug: "f".into(),
            field_type: "text".into(),
            options: None,
            required: false,
        };
        assert!(same_value(&definition, &Value::Null, &json!("")));
        assert!(same_value(&definition, &json!([]), &Value::Null));
        assert!(!same_value(&definition, &json!("a"), &Value::Null));
        let date = Definition {
            field_type: "date".into(),
            ..definition
        };
        assert!(same_value(
            &date,
            &json!("2026-01-01T00:00:00.000Z"),
            &json!("2026-01-01T00:00:00Z")
        ));
    }
}
