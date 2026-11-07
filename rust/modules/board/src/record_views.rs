//! What a record card shows (`services/records.ts`): a WeldSuite record's
//! title, a short subtitle and its status, for the cards on a board.
//!
//! A card only names a record; who may see what it says is the record's own
//! rule, applied for each viewer: the permission global search uses for the
//! type, and for WeldFlow tasks and projects the project's membership. A
//! record the viewer may not see, or that is gone, comes back as null.

use std::collections::HashSet;

use axum::body::Bytes;
use axum::response::{IntoResponse, Response};
use http::header::CACHE_CONTROL;
use http::{HeaderMap, HeaderValue};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::{
    CONTACTS_READ, OPPORTUNITIES_READ, PROJECTS_READ, PROJECTS_SCOPE_ALL, TASKS_READ, TICKETS_READ,
};
use weldsuite_db::PgPool;
use weldsuite_flow_domain::access::member_project_ids;
use weldsuite_kit::Data;
use weldsuite_kit::validation::{Presence, Text};

use crate::{Caller, Refusal, answer, validate};

/// The record kinds and the permission that lets someone see each
/// (`RECORD_PERMISSION`, global search's).
const KINDS: [(&str, &str); 6] = [
    ("task", TASKS_READ),
    ("project", PROJECTS_READ),
    ("company", CONTACTS_READ),
    ("person", CONTACTS_READ),
    ("opportunity", OPPORTUNITIES_READ),
    ("ticket", TICKETS_READ),
];

fn kind_names() -> [&'static str; 6] {
    KINDS.map(|(kind, _)| kind)
}

/// `recordKey(kind, id)`.
fn record_key(kind: &str, id: &str) -> String {
    format!("{kind}:{id}")
}

pub(crate) async fn resolve(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let refs = validate(&headers, &body, |issues, body| {
                issues
                    .list(
                        body,
                        "refs",
                        Presence::Required,
                        Some(1),
                        Some(500),
                        |issues, item| {
                            let fields = issues.object(item)?;
                            let kind = issues
                                .choice(fields, "kind", Presence::Required, &kind_names())
                                .into_option();
                            let id = issues
                                .text_with(
                                    fields,
                                    "id",
                                    Presence::Required,
                                    Text::length(Some(1), Some(255)),
                                )
                                .into_option();
                            Some((kind?, id?))
                        },
                    )
                    .into_option()
                    .unwrap_or_default()
            })?;
            let user_id = caller.user()?.to_owned();
            let kinds: HashSet<&str> = KINDS
                .iter()
                .filter(|(_, permission)| caller.can(permission))
                .map(|(kind, _)| *kind)
                .collect();
            let viewer = Viewer {
                user_id: &user_id,
                scope_all: caller.can(PROJECTS_SCOPE_ALL),
                kinds: &kinds,
            };
            let views = resolve_records(&caller.db, &viewer, &refs).await?;
            let mut response = Data(json!({ "views": views })).into_response();
            response
                .headers_mut()
                .insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
            Ok(response)
        }
        .await,
    )
}

/// A record's id and three of its text columns.
type Fields = (String, Option<String>, Option<String>, Option<String>);

struct Viewer<'a> {
    user_id: &'a str,
    /// Holds `projects:scope:all` (every live project).
    scope_all: bool,
    /// The kinds whose permission the viewer holds.
    kinds: &'a HashSet<&'static str>,
}

/// Views of `refs`, keyed `kind:id`; null for what the viewer may not see or
/// what is gone (`resolveRecords`).
#[allow(clippy::too_many_lines)] // one block per record kind, as the TypeScript
async fn resolve_records(
    db: &PgPool,
    viewer: &Viewer<'_>,
    refs: &[(String, String)],
) -> Result<Map<String, Value>, Refusal> {
    let mut out = Map::new();
    for (kind, id) in refs {
        out.insert(record_key(kind, id), Value::Null);
    }
    let ids_of = |kind: &str| -> Vec<String> {
        if !viewer.kinds.contains(kind) {
            return Vec::new();
        }
        let mut seen = HashSet::new();
        refs.iter()
            .filter(|(k, _)| k == kind)
            .filter(|(_, id)| seen.insert(id.clone()))
            .map(|(_, id)| id.clone())
            .collect()
    };
    let mut put = |kind: &str, id: &str, title: Value, subtitle: Value, status: Value| {
        out.insert(
            record_key(kind, id),
            json!({ "title": title, "subtitle": subtitle, "status": status }),
        );
    };

    let task_ids = ids_of("task");
    let project_ids = ids_of("project");
    // Tasks and projects follow the project: the projects the viewer may open (None: every live one).
    let open_projects: Option<Vec<String>> = if task_ids.is_empty() && project_ids.is_empty() {
        Some(Vec::new())
    } else if viewer.scope_all {
        None
    } else {
        Some(member_project_ids(db, viewer.user_id).await?)
    };
    let project_open = |id: Option<&str>| {
        id.is_some_and(|id| {
            open_projects
                .as_ref()
                .is_none_or(|open| open.iter().any(|p| p == id))
        })
    };

    if !task_ids.is_empty() {
        #[allow(clippy::type_complexity)] // one row of the select
        let rows: Vec<(
            String,
            Option<String>,
            Option<String>,
            Option<i32>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = sqlx::query_as(
            "select id, title, status, number, project_id, reporter_id, assignee_id
                   from tasks where id = any($1) and deleted_at is null",
        )
        .bind(&task_ids)
        .fetch_all(db)
        .await?;
        for (id, title, status, number, project_id, reporter, assignee) in rows {
            // A personal task (no project) is its reporter's and assignee's.
            let mine = reporter.as_deref() == Some(viewer.user_id)
                || assignee.as_deref() == Some(viewer.user_id);
            let visible = match project_id.as_deref() {
                Some(project) if !project.is_empty() => project_open(Some(project)),
                _ => mine,
            };
            if visible {
                let subtitle = number
                    .filter(|n| *n != 0)
                    .map_or(Value::Null, |n| json!(format!("#{n}")));
                put("task", &id, json!(title), subtitle, json!(status));
            }
        }
    }
    if !project_ids.is_empty() {
        let rows: Vec<Fields> = sqlx::query_as(
            "select id, name, status, code from projects where id = any($1) and deleted_at is null",
        )
        .bind(&project_ids)
        .fetch_all(db)
        .await?;
        for (id, name, status, code) in rows {
            if project_open(Some(&id)) {
                put("project", &id, json!(name), json!(code), json!(status));
            }
        }
    }
    let companies = ids_of("company");
    if !companies.is_empty() {
        let rows: Vec<Fields> = sqlx::query_as(
            "select id, display_name, email, status from companies
              where id = any($1) and deleted_at is null",
        )
        .bind(&companies)
        .fetch_all(db)
        .await?;
        for (id, name, email, status) in rows {
            put("company", &id, json!(name), json!(email), json!(status));
        }
    }
    let people = ids_of("person");
    if !people.is_empty() {
        let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "select id, display_name, email from people where id = any($1) and deleted_at is null",
        )
        .bind(&people)
        .fetch_all(db)
        .await?;
        for (id, name, email) in rows {
            put("person", &id, json!(name), json!(email), Value::Null);
        }
    }
    let opportunities = ids_of("opportunity");
    if !opportunities.is_empty() {
        let rows: Vec<Fields> = sqlx::query_as(
            "select id, name, amount::text, status from crm_opportunities
              where id = any($1) and deleted_at is null",
        )
        .bind(&opportunities)
        .fetch_all(db)
        .await?;
        for (id, name, amount, status) in rows {
            // `r.amount && Number(r.amount) ? String(r.amount) : null`.
            let subtitle = amount
                .filter(|a| a.trim().parse::<f64>().is_ok_and(|n| n != 0.0))
                .map_or(Value::Null, Value::String);
            put("opportunity", &id, json!(name), subtitle, json!(status));
        }
    }
    let tickets = ids_of("ticket");
    if !tickets.is_empty() {
        let rows: Vec<Fields> = sqlx::query_as(
            "select id, subject, ticket_number, status from helpdesk_tickets
              where id = any($1) and deleted_at is null",
        )
        .bind(&tickets)
        .fetch_all(db)
        .await?;
        for (id, subject, number, status) in rows {
            put("ticket", &id, json!(subject), json!(number), json!(status));
        }
    }
    Ok(out)
}
