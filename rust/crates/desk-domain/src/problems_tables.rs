//! The problem table, copied from `weldsuite-desk`'s generated `tables` (`tools/tables.mts`,
//! from the Drizzle schema and tenant snapshot 0252_snapshot.json) for its writer,
//! [`crate::problems`]. Keep it as the generator writes it: insert and patch statements that
//! write a `{ column: value }` object as Drizzle would (see [`crate::table`]).

#![allow(clippy::doc_markdown)]

use crate::table::{Column, Kind, Table};

/// `deskProblems` (`desk_problems`).
pub const DESK_PROBLEMS: Table = Table {
    name: "desk_problems",
    columns: &[
        Column { prop: "id", name: "id", kind: Kind::Text, default_fn: false },
        Column { prop: "createdAt", name: "created_at", kind: Kind::Date, default_fn: false },
        Column { prop: "updatedAt", name: "updated_at", kind: Kind::Date, default_fn: false },
        Column { prop: "problemNumber", name: "problem_number", kind: Kind::Number, default_fn: false },
        Column { prop: "title", name: "title", kind: Kind::Text, default_fn: false },
        Column { prop: "description", name: "description", kind: Kind::Text, default_fn: false },
        Column { prop: "status", name: "status", kind: Kind::Text, default_fn: false },
        Column { prop: "priority", name: "priority", kind: Kind::Text, default_fn: false },
        Column { prop: "rootCause", name: "root_cause", kind: Kind::Text, default_fn: false },
        Column { prop: "workaround", name: "workaround", kind: Kind::Text, default_fn: false },
        Column { prop: "resolution", name: "resolution", kind: Kind::Text, default_fn: false },
        Column { prop: "assigneeId", name: "assignee_id", kind: Kind::Text, default_fn: false },
        Column { prop: "departmentId", name: "department_id", kind: Kind::Text, default_fn: false },
        Column { prop: "articleId", name: "article_id", kind: Kind::Text, default_fn: false },
        Column { prop: "knownErrorAt", name: "known_error_at", kind: Kind::Date, default_fn: false },
        Column { prop: "resolvedAt", name: "resolved_at", kind: Kind::Date, default_fn: false },
        Column { prop: "closedAt", name: "closed_at", kind: Kind::Date, default_fn: false },
        Column { prop: "createdById", name: "created_by_id", kind: Kind::Text, default_fn: false },
    ],
    row: "to_jsonb(t)",
    insert: "insert into \"desk_problems\" as t (\"id\", \"created_at\", \"updated_at\", \"problem_number\", \"title\", \"description\", \"status\", \"priority\", \"root_cause\", \"workaround\", \"resolution\", \"assignee_id\", \"department_id\", \"article_id\", \"known_error_at\", \"resolved_at\", \"closed_at\", \"created_by_id\") select r.\"id\", case when $1::jsonb ? 'created_at' then r.\"created_at\" else (now())::timestamp end, case when $1::jsonb ? 'updated_at' then r.\"updated_at\" else (now())::timestamp end, r.\"problem_number\", r.\"title\", r.\"description\", case when $1::jsonb ? 'status' then r.\"status\" else ('open')::varchar(20) end, r.\"priority\", r.\"root_cause\", r.\"workaround\", r.\"resolution\", r.\"assignee_id\", r.\"department_id\", r.\"article_id\", r.\"known_error_at\", r.\"resolved_at\", r.\"closed_at\", r.\"created_by_id\" from jsonb_populate_record(null::\"desk_problems\", $1::jsonb) r returning to_jsonb(t)",
    patch: "update \"desk_problems\" as t set \"created_at\" = case when $1::jsonb ? 'created_at' then r.\"created_at\" else t.\"created_at\" end, \"updated_at\" = case when $1::jsonb ? 'updated_at' then r.\"updated_at\" else t.\"updated_at\" end, \"problem_number\" = case when $1::jsonb ? 'problem_number' then r.\"problem_number\" else t.\"problem_number\" end, \"title\" = case when $1::jsonb ? 'title' then r.\"title\" else t.\"title\" end, \"description\" = case when $1::jsonb ? 'description' then r.\"description\" else t.\"description\" end, \"status\" = case when $1::jsonb ? 'status' then r.\"status\" else t.\"status\" end, \"priority\" = case when $1::jsonb ? 'priority' then r.\"priority\" else t.\"priority\" end, \"root_cause\" = case when $1::jsonb ? 'root_cause' then r.\"root_cause\" else t.\"root_cause\" end, \"workaround\" = case when $1::jsonb ? 'workaround' then r.\"workaround\" else t.\"workaround\" end, \"resolution\" = case when $1::jsonb ? 'resolution' then r.\"resolution\" else t.\"resolution\" end, \"assignee_id\" = case when $1::jsonb ? 'assignee_id' then r.\"assignee_id\" else t.\"assignee_id\" end, \"department_id\" = case when $1::jsonb ? 'department_id' then r.\"department_id\" else t.\"department_id\" end, \"article_id\" = case when $1::jsonb ? 'article_id' then r.\"article_id\" else t.\"article_id\" end, \"known_error_at\" = case when $1::jsonb ? 'known_error_at' then r.\"known_error_at\" else t.\"known_error_at\" end, \"resolved_at\" = case when $1::jsonb ? 'resolved_at' then r.\"resolved_at\" else t.\"resolved_at\" end, \"closed_at\" = case when $1::jsonb ? 'closed_at' then r.\"closed_at\" else t.\"closed_at\" end, \"created_by_id\" = case when $1::jsonb ? 'created_by_id' then r.\"created_by_id\" else t.\"created_by_id\" end from jsonb_populate_record(null::\"desk_problems\", $1::jsonb) r where t.id = $2 and $3::boolean is not null returning to_jsonb(t)",
    select_live: "select to_jsonb(t) from \"desk_problems\" as t where t.id = $1 limit 1",
};
