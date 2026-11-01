//! More plain CRUD route files ([`crate::crud`]): knowledge-base article
//! folders, ticket types, helpdesk agents, canned responses and helpdesk
//! workflows. Schemas from `@weldsuite/core-api-client/schemas/*` (all
//! `.passthrough()`).

use serde_json::{Map, Value};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};

use crate::crud::{Changed, Crud, Filter, Gates, Hook, Messages, Partial};
use crate::tables;

pub(crate) const ARTICLES: Gates = Gates {
    read: perm::ARTICLES_READ,
    create: perm::ARTICLES_CREATE,
    update: perm::ARTICLES_UPDATE,
    delete: perm::ARTICLES_DELETE,
};

pub(crate) const TICKETS: Gates = Gates {
    read: perm::TICKETS_READ,
    create: perm::TICKETS_CREATE,
    update: perm::TICKETS_UPDATE,
    delete: perm::TICKETS_DELETE,
};

const AGENTS: Gates = Gates {
    read: perm::AGENTS_READ,
    create: perm::AGENTS_CREATE,
    update: perm::AGENTS_UPDATE,
    delete: perm::AGENTS_DELETE,
};

pub(crate) const DEPARTMENTS: Gates = Gates {
    read: perm::DEPARTMENTS_READ,
    create: perm::DEPARTMENTS_CREATE,
    update: perm::DEPARTMENTS_UPDATE,
    delete: perm::DEPARTMENTS_DELETE,
};

const FOLDER_LIST: (&str, &str) = listing!("helpdesk_article_folders";
    "($2::boolean or t.parent_id = $3::text)", "($4::boolean or t.name like $5::text)";
    6, 7, 8; "$9");
const TICKET_TYPE_LIST: (&str, &str) = listing!("helpdesk_ticket_types";
    "($2::boolean or t.name like $3::text)";
    4, 5, 6; "$7");
const AGENT_LIST: (&str, &str) = listing_as!(
    "(to_jsonb(t) || jsonb_build_object('satisfaction_score', t.\"satisfaction_score\"::text))";
    "helpdesk_agents";
    "($2::boolean or t.department_id = $3::text)", "($4::boolean or t.user_id = $5::text)",
    "($6::boolean or t.status = $7::text)",
    "($8::boolean or (t.name like $9::text or t.email like $9::text))";
    10, 11, 12; "$13");
const CANNED_LIST: (&str, &str) = listing!("helpdesk_canned_responses";
    "($2::boolean or t.department_id = $3::text)", "($4::boolean or t.category = $5::text)",
    "($6::boolean or (t.name like $7::text or t.subject like $7::text))";
    8, 9, 10; "$11");
const WORKFLOW_LIST: (&str, &str) = listing_as!(
    "(to_jsonb(t) || jsonb_build_object('average_execution_time', t.\"average_execution_time\"::text))";
    "helpdesk_workflows";
    "($2::boolean or t.name like $3::text)";
    4, 5, 6; "$7");

const fn messages(
    list: &'static str,
    fetch: &'static str,
    create: &'static str,
    update: &'static str,
    delete: &'static str,
) -> Messages {
    Messages {
        list,
        fetch,
        create,
        update,
        delete,
    }
}

const OPT: Presence = Presence::Optional;
const NULLISH: Presence = Presence::Nullish;

fn string(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    min: Option<usize>,
    max: Option<usize>,
) {
    issues.text(body, key, presence, min, max);
}

/// `z.number().int()` with `presence`.
fn integer(issues: &mut Issues, body: &Map<String, Value>, key: &str, presence: Presence) {
    issues.whole_number(body, key, presence, Number::default());
}

fn folder_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "name", partial.required(), Some(1), Some(255));
    string(issues, body, "slug", OPT, None, Some(255));
    string(issues, body, "description", OPT, None, None);
    string(issues, body, "parentId", NULLISH, None, None);
    string(issues, body, "icon", OPT, None, Some(100));
    string(issues, body, "color", OPT, None, Some(50));
    integer(issues, body, "sortOrder", OPT);
    issues.boolean(body, "isPublic", OPT);
}

fn ticket_type_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "name", partial.required(), Some(1), Some(100));
    string(issues, body, "description", OPT, None, None);
    string(issues, body, "color", OPT, None, Some(50));
    string(issues, body, "icon", OPT, None, Some(100));
    issues.boolean(body, "isActive", OPT);
    integer(issues, body, "sortOrder", OPT);
}

/// `z.string().email().max(255)` with `presence`.
pub(crate) fn email(issues: &mut Issues, body: &Map<String, Value>, key: &str, presence: Presence) {
    issues.text_with(
        body,
        key,
        presence,
        Text {
            format: Some(Format::Email),
            max: Some(255),
            ..Text::default()
        },
    );
}

fn agent_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "name", partial.required(), Some(1), Some(255));
    email(issues, body, "email", partial.required());
    string(issues, body, "userId", NULLISH, None, None);
    string(issues, body, "departmentId", NULLISH, None, None);
    string(issues, body, "role", OPT, None, Some(50));
    issues.boolean(body, "isActive", OPT);
}

pub(crate) fn department_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "name", partial.required(), Some(1), Some(255));
    string(issues, body, "description", OPT, None, None);
    email(issues, body, "email", OPT);
    string(issues, body, "color", OPT, None, Some(50));
    string(issues, body, "icon", OPT, None, Some(100));
    issues.boolean(body, "isActive", OPT);
    integer(issues, body, "sortOrder", OPT);
}

fn canned_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "name", partial.required(), Some(1), Some(255));
    string(issues, body, "subject", OPT, None, Some(500));
    string(issues, body, "body", partial.required(), None, None);
    string(issues, body, "shortcut", OPT, None, Some(50));
    string(issues, body, "category", OPT, None, Some(100));
    string(issues, body, "departmentId", NULLISH, None, None);
    issues.boolean(body, "isShared", OPT);
}

fn workflow_schema(issues: &mut Issues, body: &Map<String, Value>, partial: Partial) {
    string(issues, body, "name", partial.required(), Some(1), Some(255));
    string(issues, body, "description", OPT, None, None);
    string(issues, body, "trigger", OPT, None, Some(50));
    issues.boolean(body, "isActive", OPT);
    integer(issues, body, "priority", OPT);
}

pub(crate) static ARTICLE_FOLDERS: Crud = Crud {
    table: &tables::HELPDESK_ARTICLE_FOLDERS,
    resource: "Article folder",
    id_prefix: "afld",
    gates: ARTICLES,
    messages: messages(
        "Failed to list article folders",
        "Failed to fetch article folder",
        "Failed to create article folder",
        "Failed to update article folder",
        "Failed to delete article folder",
    ),
    schema: folder_schema,
    filters: &[Filter::eq("parentId"), Filter::like("search")],
    list_sql: FOLDER_LIST.0,
    count_sql: FOLDER_LIST.1,
    slice_count: true,
    created: ev::HELPDESK_FOLDER_CREATED,
    created_fields: &["name", "parentId"],
    updated: ev::HELPDESK_FOLDER_UPDATED,
    updated_fields: &[
        Changed::UpdateOrExisting("name"),
        Changed::UpdateOrExisting("parentId"),
    ],
    deleted: ev::HELPDESK_FOLDER_DELETED,
    hook: Hook::None,
};

pub(crate) static TICKET_TYPES: Crud = Crud {
    table: &tables::HELPDESK_TICKET_TYPES,
    resource: "Ticket type",
    id_prefix: "tty",
    gates: TICKETS,
    messages: messages(
        "Failed to list ticket types",
        "Failed to fetch ticket type",
        "Failed to create ticket type",
        "Failed to update ticket type",
        "Failed to delete ticket type",
    ),
    schema: ticket_type_schema,
    filters: &[Filter::like("search")],
    list_sql: TICKET_TYPE_LIST.0,
    count_sql: TICKET_TYPE_LIST.1,
    slice_count: true,
    created: ev::HELPDESK_TICKET_TYPE_CREATED,
    created_fields: &["name"],
    updated: ev::HELPDESK_TICKET_TYPE_UPDATED,
    updated_fields: &[Changed::UpdateOrExisting("name")],
    deleted: ev::HELPDESK_TICKET_TYPE_DELETED,
    hook: Hook::TicketTypeFields,
};

pub(crate) static HELPDESK_AGENTS: Crud = Crud {
    table: &tables::HELPDESK_AGENTS,
    resource: "Agent",
    id_prefix: "hag",
    gates: AGENTS,
    messages: messages(
        "Failed to list agents",
        "Failed to fetch agent",
        "Failed to create agent",
        "Failed to update agent",
        "Failed to delete agent",
    ),
    schema: agent_schema,
    filters: &[
        Filter::eq("departmentId"),
        Filter::eq("userId"),
        Filter::eq("status"),
        Filter::like("search"),
    ],
    list_sql: AGENT_LIST.0,
    count_sql: AGENT_LIST.1,
    // The count takes the filters only, whatever the cursor.
    slice_count: false,
    created: ev::HELPDESK_AGENT_CREATED,
    created_fields: &["name", "email", "departmentId"],
    updated: ev::HELPDESK_AGENT_UPDATED,
    updated_fields: &[
        Changed::UpdateOrExisting("name"),
        Changed::UpdateOrExisting("email"),
        Changed::UpdateOrExisting("departmentId"),
    ],
    deleted: ev::HELPDESK_AGENT_DELETED,
    hook: Hook::None,
};

pub(crate) static CANNED_RESPONSES: Crud = Crud {
    table: &tables::HELPDESK_CANNED_RESPONSES,
    resource: "Canned response",
    id_prefix: "cnnd",
    gates: TICKETS,
    messages: messages(
        "Failed to list canned responses",
        "Failed to fetch canned response",
        "Failed to create canned response",
        "Failed to update canned response",
        "Failed to delete canned response",
    ),
    schema: canned_schema,
    filters: &[
        Filter::eq("departmentId"),
        Filter::eq("category"),
        Filter::like("search"),
    ],
    list_sql: CANNED_LIST.0,
    count_sql: CANNED_LIST.1,
    slice_count: true,
    created: ev::CANNED_RESPONSE_CREATED,
    created_fields: &["name", "subject", "departmentId"],
    updated: ev::CANNED_RESPONSE_UPDATED,
    updated_fields: &[
        Changed::UpdateOrExisting("name"),
        Changed::UpdateOrExisting("subject"),
        Changed::UpdateOrExisting("departmentId"),
    ],
    deleted: ev::CANNED_RESPONSE_DELETED,
    hook: Hook::None,
};

pub(crate) static WORKFLOWS: Crud = Crud {
    table: &tables::HELPDESK_WORKFLOWS,
    resource: "Workflow",
    id_prefix: "hwfl",
    gates: TICKETS,
    messages: messages(
        "Failed to list workflows",
        "Failed to fetch workflow",
        "Failed to create workflow",
        "Failed to update workflow",
        "Failed to delete workflow",
    ),
    schema: workflow_schema,
    filters: &[Filter::like("search")],
    list_sql: WORKFLOW_LIST.0,
    count_sql: WORKFLOW_LIST.1,
    slice_count: true,
    created: ev::HELPDESK_WORKFLOW_CREATED,
    created_fields: &["name"],
    updated: ev::HELPDESK_WORKFLOW_UPDATED,
    updated_fields: &[Changed::UpdateOrExisting("name")],
    deleted: ev::HELPDESK_WORKFLOW_DELETED,
    hook: Hook::None,
};

pub(crate) static DEPARTMENTS_CRUD: Crud = Crud {
    table: &tables::HELPDESK_DEPARTMENTS,
    resource: "Department",
    id_prefix: "hdep",
    gates: DEPARTMENTS,
    messages: messages(
        "Failed to list departments",
        "Failed to fetch department",
        "Failed to create department",
        "Failed to update department",
        "Failed to delete department",
    ),
    schema: department_schema,
    filters: &[],
    // Unused: the department list is its own route (`departments.rs`).
    list_sql: TICKET_TYPE_LIST.0,
    count_sql: TICKET_TYPE_LIST.1,
    slice_count: true,
    created: ev::DEPARTMENT_CREATED,
    created_fields: &["name", "email"],
    updated: ev::DEPARTMENT_UPDATED,
    updated_fields: &[
        Changed::UpdateOrExisting("name"),
        Changed::UpdateOrExisting("email"),
    ],
    deleted: ev::DEPARTMENT_DELETED,
    hook: Hook::None,
};
