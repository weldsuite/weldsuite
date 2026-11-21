//! The service catalogue's tables, copied from `weldsuite-desk`'s generated `tables`
//! (`tools/tables.mts`, from the Drizzle schema) for their writer, [`crate::catalog`]. Keep them
//! as the generator writes them: Drizzle's properties and kinds, and the entity whose statements
//! write a `{ column: value }` object as Drizzle would (see [`crate::table`]).

#![allow(clippy::doc_markdown)]

use crate::table::{Column, Kind, Table};
use weldsuite_db::record::JsonTable;
use weldsuite_schema::tenant;

/// `deskCatalogItems` (`desk_catalog_items`).
pub const DESK_CATALOG_ITEMS: Table = Table {
    name: "desk_catalog_items",
    entity: JsonTable::of::<tenant::desk_catalog_items::Entity>(),
    columns: &[
        Column { prop: "id", name: "id", kind: Kind::Text, default_fn: false },
        Column { prop: "createdAt", name: "created_at", kind: Kind::Date, default_fn: false },
        Column { prop: "updatedAt", name: "updated_at", kind: Kind::Date, default_fn: false },
        Column { prop: "name", name: "name", kind: Kind::Text, default_fn: false },
        Column { prop: "summary", name: "summary", kind: Kind::Text, default_fn: false },
        Column { prop: "description", name: "description", kind: Kind::Text, default_fn: false },
        Column { prop: "category", name: "category", kind: Kind::Text, default_fn: false },
        Column { prop: "icon", name: "icon", kind: Kind::Text, default_fn: false },
        Column { prop: "ticketTypeId", name: "ticket_type_id", kind: Kind::Text, default_fn: false },
        Column { prop: "departmentId", name: "department_id", kind: Kind::Text, default_fn: false },
        Column { prop: "priority", name: "priority", kind: Kind::Text, default_fn: false },
        Column { prop: "deliveryEstimate", name: "delivery_estimate", kind: Kind::Text, default_fn: false },
        Column { prop: "approvalSteps", name: "approval_steps", kind: Kind::Json, default_fn: false },
        Column { prop: "fulfilmentTasks", name: "fulfilment_tasks", kind: Kind::Json, default_fn: false },
        Column { prop: "audienceCompanyIds", name: "audience_company_ids", kind: Kind::Json, default_fn: false },
        Column { prop: "isActive", name: "is_active", kind: Kind::Bool, default_fn: false },
        Column { prop: "sortOrder", name: "sort_order", kind: Kind::Number, default_fn: false },
        Column { prop: "createdById", name: "created_by_id", kind: Kind::Text, default_fn: false },
    ],
};

/// `deskRequestApprovals` (`desk_request_approvals`).
pub const DESK_REQUEST_APPROVALS: Table = Table {
    name: "desk_request_approvals",
    entity: JsonTable::of::<tenant::desk_request_approvals::Entity>(),
    columns: &[
        Column { prop: "id", name: "id", kind: Kind::Text, default_fn: false },
        Column { prop: "createdAt", name: "created_at", kind: Kind::Date, default_fn: false },
        Column { prop: "updatedAt", name: "updated_at", kind: Kind::Date, default_fn: false },
        Column { prop: "conversationId", name: "conversation_id", kind: Kind::Text, default_fn: false },
        Column { prop: "catalogItemId", name: "catalog_item_id", kind: Kind::Text, default_fn: false },
        Column { prop: "stepIndex", name: "step_index", kind: Kind::Number, default_fn: false },
        Column { prop: "stepName", name: "step_name", kind: Kind::Text, default_fn: false },
        Column { prop: "approverId", name: "approver_id", kind: Kind::Text, default_fn: false },
        Column { prop: "status", name: "status", kind: Kind::Text, default_fn: false },
        Column { prop: "decidedAt", name: "decided_at", kind: Kind::Date, default_fn: false },
        Column { prop: "decidedById", name: "decided_by_id", kind: Kind::Text, default_fn: false },
        Column { prop: "comment", name: "comment", kind: Kind::Text, default_fn: false },
    ],
};
