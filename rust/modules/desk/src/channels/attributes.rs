//! The conversation is the ticket: its type (`helpdesk_ticket_types`),
//! priority, impact and urgency, tags, team (`helpdesk_departments`) and the
//! type's custom fields. `getDeskAttributeOptions`
//! (`apps/workers/desk-api/src/services/desk-attributes.ts`) is here; the
//! update (`updateDeskConversationAttributes` of `@weldsuite/db/lib/desk`)
//! and the custom field read are `weldsuite_desk_domain::attributes`, which
//! the inbox routes call as the signed-in agent.

use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_desk_domain::priority_matrix;

pub(crate) use weldsuite_desk_domain::attributes::{
    MAX_TAG_LENGTH, MAX_TAGS, PRIORITIES, Update, UpdateError, custom_fields,
};

/// How many of the most used tags the picker suggests (`TAG_SUGGESTIONS`).
const TAG_SUGGESTIONS: i64 = 100;
/// Tags are counted over conversations active this recently (`TAG_WINDOW_DAYS`).
const TAG_WINDOW_DAYS: i32 = 90;

// ── the options ───────────────────────────────────────────────────────────────

/// `getDeskAttributeOptions(db)`: the active ticket types, their fields, the
/// active teams, the tags in use and the priority matrix.
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
    let priority_matrix = priority_matrix::read(db).await?;
    Ok(json!({
        "ticketTypes": ticket_types,
        "teams": teams,
        "fields": fields,
        "tags": tags,
        "priorityMatrix": priority_matrix,
    }))
}

// ── the update ────────────────────────────────────────────────────────────────

/// `updateDeskConversationAttributes(db, input)` as the signed-in agent.
pub(crate) async fn update(
    db: &PgPool,
    conversation_id: &str,
    author_id: &str,
    input: &Update,
) -> Result<weldsuite_desk_domain::attributes::Updated, UpdateError> {
    weldsuite_desk_domain::attributes::update(db, conversation_id, "agent", Some(author_id), input)
        .await
}
