//! The service catalogue's tables, copied from `weldsuite-desk`'s generated `tables`
//! (`tools/tables.mts`, from the Drizzle schema and tenant snapshot 0252_snapshot.json) for their
//! writer, [`crate::catalog`]. Keep them as the generator writes them: insert and patch
//! statements that write a `{ column: value }` object as Drizzle would (see [`crate::table`]).

#![allow(clippy::doc_markdown)]

use crate::table::{Column, Kind, Table};

/// `deskCatalogItems` (`desk_catalog_items`).
pub const DESK_CATALOG_ITEMS: Table = Table {
    name: "desk_catalog_items",
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
    row: "to_jsonb(t)",
    insert: "insert into \"desk_catalog_items\" as t (\"id\", \"created_at\", \"updated_at\", \"name\", \"summary\", \"description\", \"category\", \"icon\", \"ticket_type_id\", \"department_id\", \"priority\", \"delivery_estimate\", \"approval_steps\", \"fulfilment_tasks\", \"audience_company_ids\", \"is_active\", \"sort_order\", \"created_by_id\") select r.\"id\", case when $1::jsonb ? 'created_at' then r.\"created_at\" else (now())::timestamp end, case when $1::jsonb ? 'updated_at' then r.\"updated_at\" else (now())::timestamp end, r.\"name\", r.\"summary\", r.\"description\", r.\"category\", r.\"icon\", r.\"ticket_type_id\", r.\"department_id\", r.\"priority\", r.\"delivery_estimate\", case when $1::jsonb ? 'approval_steps' then r.\"approval_steps\" else ('[]'::jsonb)::jsonb end, case when $1::jsonb ? 'fulfilment_tasks' then r.\"fulfilment_tasks\" else ('[]'::jsonb)::jsonb end, case when $1::jsonb ? 'audience_company_ids' then r.\"audience_company_ids\" else ('[]'::jsonb)::jsonb end, case when $1::jsonb ? 'is_active' then r.\"is_active\" else (true)::boolean end, case when $1::jsonb ? 'sort_order' then r.\"sort_order\" else (0)::integer end, r.\"created_by_id\" from jsonb_populate_record(null::\"desk_catalog_items\", $1::jsonb) r returning to_jsonb(t)",
    patch: "update \"desk_catalog_items\" as t set \"created_at\" = case when $1::jsonb ? 'created_at' then r.\"created_at\" else t.\"created_at\" end, \"updated_at\" = case when $1::jsonb ? 'updated_at' then r.\"updated_at\" else t.\"updated_at\" end, \"name\" = case when $1::jsonb ? 'name' then r.\"name\" else t.\"name\" end, \"summary\" = case when $1::jsonb ? 'summary' then r.\"summary\" else t.\"summary\" end, \"description\" = case when $1::jsonb ? 'description' then r.\"description\" else t.\"description\" end, \"category\" = case when $1::jsonb ? 'category' then r.\"category\" else t.\"category\" end, \"icon\" = case when $1::jsonb ? 'icon' then r.\"icon\" else t.\"icon\" end, \"ticket_type_id\" = case when $1::jsonb ? 'ticket_type_id' then r.\"ticket_type_id\" else t.\"ticket_type_id\" end, \"department_id\" = case when $1::jsonb ? 'department_id' then r.\"department_id\" else t.\"department_id\" end, \"priority\" = case when $1::jsonb ? 'priority' then r.\"priority\" else t.\"priority\" end, \"delivery_estimate\" = case when $1::jsonb ? 'delivery_estimate' then r.\"delivery_estimate\" else t.\"delivery_estimate\" end, \"approval_steps\" = case when $1::jsonb ? 'approval_steps' then r.\"approval_steps\" else t.\"approval_steps\" end, \"fulfilment_tasks\" = case when $1::jsonb ? 'fulfilment_tasks' then r.\"fulfilment_tasks\" else t.\"fulfilment_tasks\" end, \"audience_company_ids\" = case when $1::jsonb ? 'audience_company_ids' then r.\"audience_company_ids\" else t.\"audience_company_ids\" end, \"is_active\" = case when $1::jsonb ? 'is_active' then r.\"is_active\" else t.\"is_active\" end, \"sort_order\" = case when $1::jsonb ? 'sort_order' then r.\"sort_order\" else t.\"sort_order\" end, \"created_by_id\" = case when $1::jsonb ? 'created_by_id' then r.\"created_by_id\" else t.\"created_by_id\" end from jsonb_populate_record(null::\"desk_catalog_items\", $1::jsonb) r where t.id = $2 and $3::boolean is not null returning to_jsonb(t)",
    select_live: "select to_jsonb(t) from \"desk_catalog_items\" as t where t.id = $1 limit 1",
};

/// `deskRequestApprovals` (`desk_request_approvals`).
pub const DESK_REQUEST_APPROVALS: Table = Table {
    name: "desk_request_approvals",
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
    row: "to_jsonb(t)",
    insert: "insert into \"desk_request_approvals\" as t (\"id\", \"created_at\", \"updated_at\", \"conversation_id\", \"catalog_item_id\", \"step_index\", \"step_name\", \"approver_id\", \"status\", \"decided_at\", \"decided_by_id\", \"comment\") select r.\"id\", case when $1::jsonb ? 'created_at' then r.\"created_at\" else (now())::timestamp end, case when $1::jsonb ? 'updated_at' then r.\"updated_at\" else (now())::timestamp end, r.\"conversation_id\", r.\"catalog_item_id\", r.\"step_index\", r.\"step_name\", r.\"approver_id\", case when $1::jsonb ? 'status' then r.\"status\" else ('waiting')::varchar(10) end, r.\"decided_at\", r.\"decided_by_id\", r.\"comment\" from jsonb_populate_record(null::\"desk_request_approvals\", $1::jsonb) r returning to_jsonb(t)",
    patch: "update \"desk_request_approvals\" as t set \"created_at\" = case when $1::jsonb ? 'created_at' then r.\"created_at\" else t.\"created_at\" end, \"updated_at\" = case when $1::jsonb ? 'updated_at' then r.\"updated_at\" else t.\"updated_at\" end, \"conversation_id\" = case when $1::jsonb ? 'conversation_id' then r.\"conversation_id\" else t.\"conversation_id\" end, \"catalog_item_id\" = case when $1::jsonb ? 'catalog_item_id' then r.\"catalog_item_id\" else t.\"catalog_item_id\" end, \"step_index\" = case when $1::jsonb ? 'step_index' then r.\"step_index\" else t.\"step_index\" end, \"step_name\" = case when $1::jsonb ? 'step_name' then r.\"step_name\" else t.\"step_name\" end, \"approver_id\" = case when $1::jsonb ? 'approver_id' then r.\"approver_id\" else t.\"approver_id\" end, \"status\" = case when $1::jsonb ? 'status' then r.\"status\" else t.\"status\" end, \"decided_at\" = case when $1::jsonb ? 'decided_at' then r.\"decided_at\" else t.\"decided_at\" end, \"decided_by_id\" = case when $1::jsonb ? 'decided_by_id' then r.\"decided_by_id\" else t.\"decided_by_id\" end, \"comment\" = case when $1::jsonb ? 'comment' then r.\"comment\" else t.\"comment\" end from jsonb_populate_record(null::\"desk_request_approvals\", $1::jsonb) r where t.id = $2 and $3::boolean is not null returning to_jsonb(t)",
    select_live: "select to_jsonb(t) from \"desk_request_approvals\" as t where t.id = $1 limit 1",
};
