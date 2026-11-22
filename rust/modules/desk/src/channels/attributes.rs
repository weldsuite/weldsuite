//! The conversation is the ticket: its type (`helpdesk_ticket_types`),
//! priority, impact and urgency, tags, team (`helpdesk_departments`) and the
//! type's custom fields. `getDeskAttributeOptions`
//! (`apps/workers/desk-api/src/services/desk-attributes.ts`) is here; the
//! update (`updateDeskConversationAttributes` of `@weldsuite/db/lib/desk`)
//! and the custom field read are `weldsuite_desk_domain::attributes`, which
//! the inbox routes call as the signed-in agent.

use sea_orm::sea_query::{Alias, Asterisk, Expr, Func};
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, FromQueryResult, QueryFilter, QueryOrder,
    QuerySelect, QueryTrait,
};
use serde::Serialize;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};
use weldsuite_db::{PgPool, orm, utc_timestamp};
use weldsuite_desk_domain::priority_matrix;
use weldsuite_schema::tenant::{
    custom_field_definitions, desk_conversations, helpdesk_departments, helpdesk_ticket_types,
};

pub(crate) use weldsuite_desk_domain::attributes::{
    MAX_TAG_LENGTH, MAX_TAGS, PRIORITIES, Update, UpdateError, custom_fields,
};

/// How many of the most used tags the picker suggests (`TAG_SUGGESTIONS`).
const TAG_SUGGESTIONS: u64 = 100;
/// Tags are counted over conversations active this recently (`TAG_WINDOW_DAYS`).
const TAG_WINDOW_DAYS: i32 = 90;

// ── the options ───────────────────────────────────────────────────────────────

/// An active ticket type, as the picker lists it.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketTypeOption {
    id: String,
    name: String,
    description: Option<String>,
    icon: Option<String>,
    color: Option<String>,
}

/// An active team.
#[derive(Debug, FromQueryResult, Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamOption {
    id: String,
    name: String,
}

/// A ticket custom field, `required` and `sortOrder` defaulted.
#[derive(Debug, FromQueryResult)]
struct FieldOption {
    id: String,
    ticket_type_id: Option<String>,
    slug: String,
    name: String,
    description: Option<String>,
    field_type: String,
    options: Option<Value>,
    required: Option<bool>,
    sort_order: Option<i32>,
}

/// `getDeskAttributeOptions(db)`: the active ticket types, their fields, the
/// active teams, the tags in use and the priority matrix.
pub(crate) async fn options(db: &PgPool) -> Result<Value, sea_orm::DbErr> {
    let orm = orm(db);
    let ticket_types = helpdesk_ticket_types::Entity::find()
        .select_only()
        .columns([
            helpdesk_ticket_types::Column::Id,
            helpdesk_ticket_types::Column::Name,
            helpdesk_ticket_types::Column::Description,
            helpdesk_ticket_types::Column::Icon,
            helpdesk_ticket_types::Column::Color,
        ])
        .filter(helpdesk_ticket_types::Column::DeletedAt.is_null())
        .filter(helpdesk_ticket_types::Column::IsActive.eq(true))
        .order_by_asc(helpdesk_ticket_types::Column::SortOrder)
        .order_by_asc(helpdesk_ticket_types::Column::Name)
        .into_model::<TicketTypeOption>()
        .all(&orm)
        .await?;
    let teams = helpdesk_departments::Entity::find()
        .select_only()
        .columns([
            helpdesk_departments::Column::Id,
            helpdesk_departments::Column::Name,
        ])
        .filter(helpdesk_departments::Column::DeletedAt.is_null())
        .filter(helpdesk_departments::Column::IsActive.eq(true))
        .order_by_asc(helpdesk_departments::Column::Name)
        .into_model::<TeamOption>()
        .all(&orm)
        .await?;
    let fields = custom_field_definitions::Entity::find()
        .select_only()
        .columns([
            custom_field_definitions::Column::Id,
            custom_field_definitions::Column::TicketTypeId,
            custom_field_definitions::Column::Slug,
            custom_field_definitions::Column::Name,
            custom_field_definitions::Column::Description,
            custom_field_definitions::Column::FieldType,
            custom_field_definitions::Column::Options,
            custom_field_definitions::Column::Required,
            custom_field_definitions::Column::SortOrder,
        ])
        .filter(custom_field_definitions::Column::EntityType.eq("ticket"))
        .filter(custom_field_definitions::Column::DeletedAt.is_null())
        .order_by_asc(custom_field_definitions::Column::SortOrder)
        .order_by_asc(custom_field_definitions::Column::Name)
        .into_model::<FieldOption>()
        .all(&orm)
        .await?;
    let fields: Vec<Value> = fields
        .into_iter()
        .map(|field| {
            json!({
                "id": field.id,
                "ticketTypeId": field.ticket_type_id,
                "slug": field.slug,
                "name": field.name,
                "description": field.description,
                "fieldType": field.field_type,
                "options": field.options,
                "required": field.required.unwrap_or(false),
                "sortOrder": field.sort_order.unwrap_or(0),
            })
        })
        .collect();
    let tags: Vec<Value> = tag_counts(&orm)
        .await?
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

/// The most used tags of the conversations active in the window, each with
/// its count: `select tag, count(*) from desk_conversations,
/// jsonb_array_elements_text(tags) as tag … group by tag order by count
/// desc, tag asc limit …`.
async fn tag_counts(db: &DatabaseConnection) -> Result<Vec<(String, i32)>, sea_orm::DbErr> {
    use desk_conversations::Column;
    use sea_orm::ExprTrait as _;
    let tag = Alias::new("tag");
    let since = utc_timestamp(OffsetDateTime::now_utc() - Duration::days(TAG_WINDOW_DAYS.into()));
    let mut select = desk_conversations::Entity::find()
        .select_only()
        .column_as(Expr::col(tag.clone()), "tag")
        .column_as(
            Expr::from(Func::count(Expr::col(Asterisk))).cast_as("int"),
            "count",
        )
        .filter(Column::Tags.ne(json!([])))
        .filter(
            Expr::from(Func::coalesce([
                Expr::col((desk_conversations::Entity, Column::LastMessageAt)),
                Expr::col((desk_conversations::Entity, Column::CreatedAt)),
            ]))
            .gt(since),
        )
        .group_by(Expr::col(tag.clone()))
        .order_by_desc(Expr::col(Alias::new("count")))
        .order_by_asc(Expr::col(tag.clone()))
        .limit(TAG_SUGGESTIONS);
    QueryTrait::query(&mut select).from_function(
        Func::cust("jsonb_array_elements_text")
            .arg(Expr::col((desk_conversations::Entity, Column::Tags))),
        tag,
    );
    eprintln!(
        "SQLDUMP {}",
        QueryTrait::build(&select, sea_orm::DbBackend::Postgres)
    );
    select.into_tuple().all(db).await
}

#[cfg(test)]
mod sql_probe {
    #[tokio::test]
    async fn probe() {
        let db = sea_orm::Database::connect("postgres://x:y@127.0.0.1:1/z").await;
        if let Ok(db) = db {
            let _ = super::tag_counts(&db).await;
        }
    }
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
