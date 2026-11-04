//! Capacity queries shared by `/api/capacity` and `/api/project-requests`
//! (`services/capacity.ts`): the rows of bookings, resource requests and
//! profiles as Drizzle reads them, the load of a range of weeks, and the names
//! of projects the caller may see. The rules are
//! `weldsuite_flow_domain::capacity`.

use std::collections::HashMap;

use serde_json::Value;
use weldsuite_db::{PgPool, js_row};
use weldsuite_flow_domain::capacity::{
    CapacityBooking, CapacityInput, CapacityLoad, CapacityProfile, CapacityRange, CapacityTask,
    OTHER_PROJECT_NAME, collect_members, compute_capacity,
};
use weldsuite_flow_domain::js::numeric;

use crate::Caller;

/// A `resource_bookings` row.
macro_rules! booking_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object('hours_per_week', ",
            $a,
            ".hours_per_week::text))"
        )
    };
}

/// A `resource_requests` row.
macro_rules! resource_request_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object('hours_per_week', ",
            $a,
            ".hours_per_week::text))"
        )
    };
}

/// A `flow_member_profiles` row.
macro_rules! profile_json {
    ($a:literal) => {
        concat!(
            "(to_jsonb(",
            $a,
            ") || jsonb_build_object('weekly_hours', ",
            $a,
            ".weekly_hours::text))"
        )
    };
}

pub(crate) use {booking_json, profile_json, resource_request_json};

/// `findBooking(db, id)`: a live booking.
pub(crate) async fn find_booking(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        booking_json!("b"),
        " from resource_bookings b where b.id = $1 and b.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `findResourceRequest(db, id)`: a live resource request.
pub(crate) async fn find_resource_request(
    db: &PgPool,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        resource_request_json!("r"),
        " from resource_requests r where r.id = $1 and r.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `findProfile(db, memberId)`.
pub(crate) async fn find_profile(
    db: &PgPool,
    member_id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        profile_json!("p"),
        " from flow_member_profiles p where p.member_id = $1 limit 1"
    ))
    .bind(member_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `Number(text)` of a `numeric` column's text.
fn hours_of(text: &str) -> f64 {
    numeric(&Value::String(text.to_owned()))
}

/// A booking as the load query reads it.
type BookingRow = (
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    bool,
);
/// An open task as the load query reads it.
type TaskRow = (
    String,
    Option<String>,
    Option<Value>,
    Option<String>,
    Option<String>,
    String,
);

/// `loadCapacity(db, range, options)`: the load of every member over a range
/// of weeks. Bookings overlapping it (tentative ones only when asked for; one
/// held for a deleted or rejected request, or on a deleted project, counts for
/// nothing), open tasks with an estimate, and the members to list (profiles,
/// bookings, task assignees and the people on current projects).
#[allow(clippy::too_many_lines)]
pub(crate) async fn load_capacity(
    db: &PgPool,
    range: &CapacityRange,
    include_tentative: bool,
    skill: Option<&str>,
) -> Result<CapacityLoad, sqlx::Error> {
    let booking_rows: Vec<BookingRow> = sqlx::query_as(
        "select b.member_id, b.project_id, b.request_id,
                    to_char(b.starts_on, 'YYYY-MM-DD'), to_char(b.ends_on, 'YYYY-MM-DD'),
                    b.hours_per_week::text, b.tentative
             from resource_bookings b
             left join projects p on p.id = b.project_id
             left join project_requests r on r.id = b.request_id
             where b.deleted_at is null
               and b.starts_on <= $2::date and b.ends_on >= $1::date
               and (b.project_id is null or p.deleted_at is null)
               and (b.request_id is null or (r.deleted_at is null and r.status <> 'rejected'))
               and ($3::bool or b.tentative = false)
             order by b.starts_on, b.id",
    )
    .bind(&range.from)
    .bind(&range.to)
    .bind(include_tentative)
    .fetch_all(db)
    .await?;

    let task_rows: Vec<TaskRow> = sqlx::query_as(
        "select t.project_id, t.assignee_id, t.assignee_ids,
                    to_char(t.start_date, 'YYYY-MM-DD'), to_char(t.due_date, 'YYYY-MM-DD'),
                    t.estimated_hours::text
             from tasks t
             inner join projects p on p.id = t.project_id
             where t.deleted_at is null and p.deleted_at is null and t.project_id is not null
               and t.status not in ('done', 'cancelled')
               and t.estimated_hours > 0
               and (t.assignee_id is not null
                    or (case when jsonb_typeof(t.assignee_ids) = 'array'
                             then jsonb_array_length(t.assignee_ids) else 0 end) > 0)
               and least(t.start_date, t.due_date)::date <= $2::date
               and greatest(t.start_date, t.due_date)::date >= $1::date
             order by t.id",
    )
    .bind(&range.from)
    .bind(&range.to)
    .fetch_all(db)
    .await?;

    let profile_rows: Vec<(String, String, Value)> = sqlx::query_as(
        "select member_id, weekly_hours::text, skills from flow_member_profiles order by member_id",
    )
    .fetch_all(db)
    .await?;

    let members: Vec<String> = sqlx::query_scalar(
        "select distinct pm.user_id
         from project_members pm
         inner join projects p on p.id = pm.project_id
         where pm.is_active = true and pm.deleted_at is null and p.deleted_at is null
           and p.status in ('Planning', 'Active', 'On Hold')",
    )
    .fetch_all(db)
    .await?;
    let managers: Vec<String> = sqlx::query_scalar(
        "select distinct project_manager_id from projects
         where deleted_at is null and project_manager_id is not null
           and status in ('Planning', 'Active', 'On Hold')",
    )
    .fetch_all(db)
    .await?;

    let bookings: Vec<CapacityBooking> = booking_rows
        .into_iter()
        .map(
            |(member_id, project_id, request_id, starts_on, ends_on, hours, tentative)| {
                CapacityBooking {
                    member_id,
                    project_id,
                    request_id,
                    starts_on,
                    ends_on,
                    hours_per_week: hours_of(&hours),
                    tentative,
                }
            },
        )
        .collect();
    let tasks: Vec<CapacityTask> = task_rows
        .into_iter()
        .map(
            |(project_id, assignee_id, assignee_ids, starts_on, due_on, hours)| CapacityTask {
                project_id,
                assignee_id,
                assignee_ids: assignee_ids.and_then(|ids| {
                    ids.as_array().map(|list| {
                        list.iter()
                            .filter_map(|id| id.as_str().map(str::to_owned))
                            .collect()
                    })
                }),
                starts_on,
                due_on,
                estimated_hours: hours_of(&hours),
            },
        )
        .collect();
    let profiles: Vec<CapacityProfile> = profile_rows
        .into_iter()
        .map(|(member_id, hours, skills)| CapacityProfile {
            member_id,
            weekly_hours: hours_of(&hours),
            skills: skills
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(|s| s.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect();
    let people: Vec<String> = members.into_iter().chain(managers).collect();
    let listed = collect_members(&profiles, &bookings, &tasks, &people);
    Ok(compute_capacity(&CapacityInput {
        from: &range.from,
        weeks: usize::try_from(range.weeks).unwrap_or(0),
        members: &listed,
        bookings: &bookings,
        tasks: &tasks,
        include_tentative,
        skill,
    }))
}

/// What the caller may know of a project: its name, or "Other project".
#[derive(Debug, Clone)]
pub(crate) struct ProjectLabel {
    pub(crate) name: String,
    pub(crate) accessible: bool,
}

/// `projectLabels(c, projectIds)`: the names of projects the caller may see,
/// "Other project" for the rest (the membership boundary holds for the
/// portfolio too).
pub(crate) async fn project_labels(
    caller: &Caller,
    project_ids: &[String],
) -> Result<HashMap<String, ProjectLabel>, sqlx::Error> {
    let mut ids: Vec<String> = project_ids.to_vec();
    ids.sort();
    ids.dedup();
    let mut labels = HashMap::new();
    if ids.is_empty() {
        return Ok(labels);
    }
    let rows: Vec<(String, String)> =
        sqlx::query_as("select id, name from projects where id = any($1) and deleted_at is null")
            .bind(&ids)
            .fetch_all(&caller.db)
            .await?;
    let accessible = caller.accessible_project_ids().await?;
    for (id, name) in rows {
        let may_access = accessible
            .as_ref()
            .is_none_or(|allowed| allowed.contains(&id));
        labels.insert(
            id,
            ProjectLabel {
                name: if may_access {
                    name
                } else {
                    OTHER_PROJECT_NAME.to_owned()
                },
                accessible: may_access,
            },
        );
    }
    Ok(labels)
}

/// `labelOf(labels, projectId)`: "Other project" for one that is missing or off-limits.
pub(crate) fn label_of(labels: &HashMap<String, ProjectLabel>, project_id: &str) -> ProjectLabel {
    labels.get(project_id).cloned().unwrap_or(ProjectLabel {
        name: OTHER_PROJECT_NAME.to_owned(),
        accessible: false,
    })
}
