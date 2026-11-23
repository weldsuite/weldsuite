//! The problem table, copied from `weldsuite-desk`'s generated `tables` (`tools/tables.mts`,
//! from the Drizzle schema) for its writer, [`crate::problems`]. Keep it as the generator writes
//! it: Drizzle's properties and kinds, and the entity whose statements write a
//! `{ column: value }` object as Drizzle would (see [`crate::table`]).

#![allow(clippy::doc_markdown)]

use crate::table::{Column, Kind, Table};
use weldsuite_db::record::JsonTable;
use weldsuite_schema::tenant;

/// `deskProblems` (`desk_problems`).
pub const DESK_PROBLEMS: Table = Table {
    name: "desk_problems",
    entity: JsonTable::of::<tenant::desk_problems::Entity>(),
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
};
