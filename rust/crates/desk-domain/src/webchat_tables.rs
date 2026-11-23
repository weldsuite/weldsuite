//! The webchat tables, moved here from `weldsuite-desk`'s generated `tables` (`tools/tables.mts`,
//! from the Drizzle schema) with their writer. Keep them as the generator writes them: Drizzle's
//! properties and kinds, and the entity whose statements write a `{ column: value }` object as
//! Drizzle would (see [`crate::table`]).

#![allow(clippy::doc_markdown)]

use crate::table::{Column, Kind, Table};
use weldsuite_db::record::JsonTable;
use weldsuite_schema::tenant;

/// `deskConversations` (`desk_conversations`).
pub const DESK_CONVERSATIONS: Table = Table {
    name: "desk_conversations",
    entity: JsonTable::of::<tenant::desk_conversations::Entity>(),
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
        Column { prop: "slaPolicyId", name: "sla_policy_id", kind: Kind::Text, default_fn: false },
        Column { prop: "slaStatus", name: "sla_status", kind: Kind::Text, default_fn: false },
        Column { prop: "slaDueAt", name: "sla_due_at", kind: Kind::Date, default_fn: false },
        Column { prop: "slaMetric", name: "sla_metric", kind: Kind::Text, default_fn: false },
        Column { prop: "firstResponseAt", name: "first_response_at", kind: Kind::Date, default_fn: false },
        Column { prop: "firstResponseSeconds", name: "first_response_seconds", kind: Kind::Number, default_fn: false },
        Column { prop: "resolvedAt", name: "resolved_at", kind: Kind::Date, default_fn: false },
        Column { prop: "resolutionSeconds", name: "resolution_seconds", kind: Kind::Number, default_fn: false },
        Column { prop: "parentConversationId", name: "parent_conversation_id", kind: Kind::Text, default_fn: false },
        Column { prop: "isMajorIncident", name: "is_major_incident", kind: Kind::Bool, default_fn: false },
        Column { prop: "mergedIntoId", name: "merged_into_id", kind: Kind::Text, default_fn: false },
        Column { prop: "impact", name: "impact", kind: Kind::Text, default_fn: false },
        Column { prop: "urgency", name: "urgency", kind: Kind::Text, default_fn: false },
        Column { prop: "language", name: "language", kind: Kind::Text, default_fn: false },
        Column { prop: "escalationCheckAt", name: "escalation_check_at", kind: Kind::Date, default_fn: false },
        Column { prop: "problemId", name: "problem_id", kind: Kind::Text, default_fn: false },
        Column { prop: "catalogItemId", name: "catalog_item_id", kind: Kind::Text, default_fn: false },
        Column { prop: "approvalStatus", name: "approval_status", kind: Kind::Text, default_fn: false },
    ],
};

/// `deskMessages` (`desk_messages`).
pub const DESK_MESSAGES: Table = Table {
    name: "desk_messages",
    entity: JsonTable::of::<tenant::desk_messages::Entity>(),
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
};

/// `deskVisitors` (`desk_visitors`).
pub const DESK_VISITORS: Table = Table {
    name: "desk_visitors",
    entity: JsonTable::of::<tenant::desk_visitors::Entity>(),
    columns: &[
        Column { prop: "id", name: "id", kind: Kind::Text, default_fn: false },
        Column { prop: "createdAt", name: "created_at", kind: Kind::Date, default_fn: false },
        Column { prop: "updatedAt", name: "updated_at", kind: Kind::Date, default_fn: false },
        Column { prop: "lastSeenAt", name: "last_seen_at", kind: Kind::Date, default_fn: false },
        Column { prop: "name", name: "name", kind: Kind::Text, default_fn: false },
        Column { prop: "email", name: "email", kind: Kind::Text, default_fn: false },
        Column { prop: "phone", name: "phone", kind: Kind::Text, default_fn: false },
        Column { prop: "widgetId", name: "widget_id", kind: Kind::Text, default_fn: false },
        Column { prop: "externalId", name: "external_id", kind: Kind::Text, default_fn: false },
        Column { prop: "verifiedEmail", name: "verified_email", kind: Kind::Text, default_fn: false },
        Column { prop: "verifiedAt", name: "verified_at", kind: Kind::Date, default_fn: false },
    ],
};
