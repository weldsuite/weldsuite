//! The webchat tables, moved here from `weldsuite-desk`'s generated `tables` (`tools/tables.mts`,
//! from the Drizzle schema and tenant snapshot 0235_snapshot.json) with their writer. Keep them
//! as the generator writes them: insert and patch statements that write a `{ column: value }`
//! object as Drizzle would (see [`crate::table`]).

#![allow(clippy::doc_markdown)]

use crate::table::{Column, Kind, Table};

/// `deskConversations` (`desk_conversations`).
pub const DESK_CONVERSATIONS: Table = Table {
    name: "desk_conversations",
    columns: &[
        Column { prop: "id", name: "id", kind: Kind::Text, default_fn: false },
        Column { prop: "createdAt", name: "created_at", kind: Kind::Date, default_fn: false },
        Column { prop: "updatedAt", name: "updated_at", kind: Kind::Date, default_fn: false },
        Column { prop: "conversationNumber", name: "conversation_number", kind: Kind::Number, default_fn: false },
        Column { prop: "title", name: "title", kind: Kind::Text, default_fn: false },
        Column { prop: "state", name: "state", kind: Kind::Text, default_fn: false },
        Column { prop: "channel", name: "channel", kind: Kind::Text, default_fn: false },
        Column { prop: "visitorId", name: "visitor_id", kind: Kind::Text, default_fn: false },
        Column { prop: "name", name: "name", kind: Kind::Text, default_fn: false },
        Column { prop: "email", name: "email", kind: Kind::Text, default_fn: false },
        Column { prop: "contactId", name: "contact_id", kind: Kind::Text, default_fn: false },
        Column { prop: "assigneeId", name: "assignee_id", kind: Kind::Text, default_fn: false },
        Column { prop: "ticketTypeId", name: "ticket_type_id", kind: Kind::Text, default_fn: false },
        Column { prop: "priority", name: "priority", kind: Kind::Text, default_fn: false },
        Column { prop: "tags", name: "tags", kind: Kind::Json, default_fn: false },
        Column { prop: "departmentId", name: "department_id", kind: Kind::Text, default_fn: false },
        Column { prop: "waitingSince", name: "waiting_since", kind: Kind::Date, default_fn: false },
        Column { prop: "lastMessageAt", name: "last_message_at", kind: Kind::Date, default_fn: false },
        Column { prop: "lastMessagePreview", name: "last_message_preview", kind: Kind::Text, default_fn: false },
        Column { prop: "rating", name: "rating", kind: Kind::Number, default_fn: false },
        Column { prop: "ratingComment", name: "rating_comment", kind: Kind::Text, default_fn: false },
        Column { prop: "ratedAt", name: "rated_at", kind: Kind::Date, default_fn: false },
        Column { prop: "externalId", name: "external_id", kind: Kind::Text, default_fn: false },
    ],
    row: "to_jsonb(t)",
    insert: "insert into \"desk_conversations\" as t (\"id\", \"created_at\", \"updated_at\", \"conversation_number\", \"title\", \"state\", \"channel\", \"visitor_id\", \"name\", \"email\", \"contact_id\", \"assignee_id\", \"ticket_type_id\", \"priority\", \"tags\", \"department_id\", \"waiting_since\", \"last_message_at\", \"last_message_preview\", \"rating\", \"rating_comment\", \"rated_at\", \"external_id\") select r.\"id\", case when $1::jsonb ? 'created_at' then r.\"created_at\" else (now())::timestamp end, case when $1::jsonb ? 'updated_at' then r.\"updated_at\" else (now())::timestamp end, r.\"conversation_number\", r.\"title\", case when $1::jsonb ? 'state' then r.\"state\" else ('open')::varchar(10) end, case when $1::jsonb ? 'channel' then r.\"channel\" else ('messenger')::varchar(20) end, r.\"visitor_id\", r.\"name\", r.\"email\", r.\"contact_id\", r.\"assignee_id\", r.\"ticket_type_id\", r.\"priority\", case when $1::jsonb ? 'tags' then r.\"tags\" else ('[]'::jsonb)::jsonb end, r.\"department_id\", r.\"waiting_since\", r.\"last_message_at\", r.\"last_message_preview\", r.\"rating\", r.\"rating_comment\", r.\"rated_at\", r.\"external_id\" from jsonb_populate_record(null::\"desk_conversations\", $1::jsonb) r returning to_jsonb(t)",
    patch: "update \"desk_conversations\" as t set \"created_at\" = case when $1::jsonb ? 'created_at' then r.\"created_at\" else t.\"created_at\" end, \"updated_at\" = case when $1::jsonb ? 'updated_at' then r.\"updated_at\" else t.\"updated_at\" end, \"conversation_number\" = case when $1::jsonb ? 'conversation_number' then r.\"conversation_number\" else t.\"conversation_number\" end, \"title\" = case when $1::jsonb ? 'title' then r.\"title\" else t.\"title\" end, \"state\" = case when $1::jsonb ? 'state' then r.\"state\" else t.\"state\" end, \"channel\" = case when $1::jsonb ? 'channel' then r.\"channel\" else t.\"channel\" end, \"visitor_id\" = case when $1::jsonb ? 'visitor_id' then r.\"visitor_id\" else t.\"visitor_id\" end, \"name\" = case when $1::jsonb ? 'name' then r.\"name\" else t.\"name\" end, \"email\" = case when $1::jsonb ? 'email' then r.\"email\" else t.\"email\" end, \"contact_id\" = case when $1::jsonb ? 'contact_id' then r.\"contact_id\" else t.\"contact_id\" end, \"assignee_id\" = case when $1::jsonb ? 'assignee_id' then r.\"assignee_id\" else t.\"assignee_id\" end, \"ticket_type_id\" = case when $1::jsonb ? 'ticket_type_id' then r.\"ticket_type_id\" else t.\"ticket_type_id\" end, \"priority\" = case when $1::jsonb ? 'priority' then r.\"priority\" else t.\"priority\" end, \"tags\" = case when $1::jsonb ? 'tags' then r.\"tags\" else t.\"tags\" end, \"department_id\" = case when $1::jsonb ? 'department_id' then r.\"department_id\" else t.\"department_id\" end, \"waiting_since\" = case when $1::jsonb ? 'waiting_since' then r.\"waiting_since\" else t.\"waiting_since\" end, \"last_message_at\" = case when $1::jsonb ? 'last_message_at' then r.\"last_message_at\" else t.\"last_message_at\" end, \"last_message_preview\" = case when $1::jsonb ? 'last_message_preview' then r.\"last_message_preview\" else t.\"last_message_preview\" end, \"rating\" = case when $1::jsonb ? 'rating' then r.\"rating\" else t.\"rating\" end, \"rating_comment\" = case when $1::jsonb ? 'rating_comment' then r.\"rating_comment\" else t.\"rating_comment\" end, \"rated_at\" = case when $1::jsonb ? 'rated_at' then r.\"rated_at\" else t.\"rated_at\" end, \"external_id\" = case when $1::jsonb ? 'external_id' then r.\"external_id\" else t.\"external_id\" end from jsonb_populate_record(null::\"desk_conversations\", $1::jsonb) r where t.id = $2 and $3::boolean is not null returning to_jsonb(t)",
    select_live: "select to_jsonb(t) from \"desk_conversations\" as t where t.id = $1 limit 1",
};

/// `deskMessages` (`desk_messages`).
pub const DESK_MESSAGES: Table = Table {
    name: "desk_messages",
    columns: &[
        Column { prop: "id", name: "id", kind: Kind::Text, default_fn: false },
        Column { prop: "createdAt", name: "created_at", kind: Kind::Date, default_fn: false },
        Column { prop: "conversationId", name: "conversation_id", kind: Kind::Text, default_fn: false },
        Column { prop: "kind", name: "kind", kind: Kind::Text, default_fn: false },
        Column { prop: "body", name: "body", kind: Kind::Text, default_fn: false },
        Column { prop: "authorType", name: "author_type", kind: Kind::Text, default_fn: false },
        Column { prop: "authorId", name: "author_id", kind: Kind::Text, default_fn: false },
        Column { prop: "attachments", name: "attachments", kind: Kind::Json, default_fn: false },
        Column { prop: "metadata", name: "metadata", kind: Kind::Json, default_fn: false },
    ],
    row: "to_jsonb(t)",
    insert: "insert into \"desk_messages\" as t (\"id\", \"created_at\", \"conversation_id\", \"kind\", \"body\", \"author_type\", \"author_id\", \"attachments\", \"metadata\") select r.\"id\", case when $1::jsonb ? 'created_at' then r.\"created_at\" else (now())::timestamp end, r.\"conversation_id\", r.\"kind\", r.\"body\", r.\"author_type\", r.\"author_id\", r.\"attachments\", r.\"metadata\" from jsonb_populate_record(null::\"desk_messages\", $1::jsonb) r returning to_jsonb(t)",
    patch: "update \"desk_messages\" as t set \"created_at\" = case when $1::jsonb ? 'created_at' then r.\"created_at\" else t.\"created_at\" end, \"conversation_id\" = case when $1::jsonb ? 'conversation_id' then r.\"conversation_id\" else t.\"conversation_id\" end, \"kind\" = case when $1::jsonb ? 'kind' then r.\"kind\" else t.\"kind\" end, \"body\" = case when $1::jsonb ? 'body' then r.\"body\" else t.\"body\" end, \"author_type\" = case when $1::jsonb ? 'author_type' then r.\"author_type\" else t.\"author_type\" end, \"author_id\" = case when $1::jsonb ? 'author_id' then r.\"author_id\" else t.\"author_id\" end, \"attachments\" = case when $1::jsonb ? 'attachments' then r.\"attachments\" else t.\"attachments\" end, \"metadata\" = case when $1::jsonb ? 'metadata' then r.\"metadata\" else t.\"metadata\" end from jsonb_populate_record(null::\"desk_messages\", $1::jsonb) r where t.id = $2 and $3::boolean is not null returning to_jsonb(t)",
    select_live: "select to_jsonb(t) from \"desk_messages\" as t where t.id = $1 limit 1",
};

/// `deskVisitors` (`desk_visitors`).
pub const DESK_VISITORS: Table = Table {
    name: "desk_visitors",
    columns: &[
        Column { prop: "id", name: "id", kind: Kind::Text, default_fn: false },
        Column { prop: "createdAt", name: "created_at", kind: Kind::Date, default_fn: false },
        Column { prop: "updatedAt", name: "updated_at", kind: Kind::Date, default_fn: false },
        Column { prop: "lastSeenAt", name: "last_seen_at", kind: Kind::Date, default_fn: false },
        Column { prop: "name", name: "name", kind: Kind::Text, default_fn: false },
        Column { prop: "email", name: "email", kind: Kind::Text, default_fn: false },
        Column { prop: "phone", name: "phone", kind: Kind::Text, default_fn: false },
        Column { prop: "widgetId", name: "widget_id", kind: Kind::Text, default_fn: false },
    ],
    row: "to_jsonb(t)",
    insert: "insert into \"desk_visitors\" as t (\"id\", \"created_at\", \"updated_at\", \"last_seen_at\", \"name\", \"email\", \"phone\", \"widget_id\") select r.\"id\", case when $1::jsonb ? 'created_at' then r.\"created_at\" else (now())::timestamp end, case when $1::jsonb ? 'updated_at' then r.\"updated_at\" else (now())::timestamp end, case when $1::jsonb ? 'last_seen_at' then r.\"last_seen_at\" else (now())::timestamp end, r.\"name\", r.\"email\", r.\"phone\", r.\"widget_id\" from jsonb_populate_record(null::\"desk_visitors\", $1::jsonb) r returning to_jsonb(t)",
    patch: "update \"desk_visitors\" as t set \"created_at\" = case when $1::jsonb ? 'created_at' then r.\"created_at\" else t.\"created_at\" end, \"updated_at\" = case when $1::jsonb ? 'updated_at' then r.\"updated_at\" else t.\"updated_at\" end, \"last_seen_at\" = case when $1::jsonb ? 'last_seen_at' then r.\"last_seen_at\" else t.\"last_seen_at\" end, \"name\" = case when $1::jsonb ? 'name' then r.\"name\" else t.\"name\" end, \"email\" = case when $1::jsonb ? 'email' then r.\"email\" else t.\"email\" end, \"phone\" = case when $1::jsonb ? 'phone' then r.\"phone\" else t.\"phone\" end, \"widget_id\" = case when $1::jsonb ? 'widget_id' then r.\"widget_id\" else t.\"widget_id\" end from jsonb_populate_record(null::\"desk_visitors\", $1::jsonb) r where t.id = $2 and $3::boolean is not null returning to_jsonb(t)",
    select_live: "select to_jsonb(t) from \"desk_visitors\" as t where t.id = $1 limit 1",
};
