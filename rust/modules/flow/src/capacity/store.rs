//! Capacity queries shared by `/api/capacity` and `/api/project-requests`
//! (`services/capacity.ts`): the rows of bookings, resource requests and
//! profiles as Drizzle reads them, the load of a range of weeks, and the names
//! of projects the caller may see. The rules are
//! `weldsuite_flow_domain::capacity`.

use std::collections::HashMap;

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect,
    RelationDef,
};
use serde_json::Value;
use time::macros::format_description;
use time::{Date, PrimitiveDateTime};
use weldsuite_db::{PgPool, orm};
use weldsuite_flow_domain::capacity::{
    CapacityBooking, CapacityInput, CapacityLoad, CapacityProfile, CapacityRange, CapacityTask,
    OTHER_PROJECT_NAME, collect_members, compute_capacity,
};
use weldsuite_flow_domain::js::numeric;
use weldsuite_schema::tenant::{
    flow_member_profiles as profiles, project_members, project_requests, projects,
    resource_bookings as bookings, resource_requests, tasks,
};

use crate::{Caller, row_json};

/// The statuses of the projects whose people are listed.
const CURRENT_PROJECT_STATUSES: [&str; 3] = ["Planning", "Active", "On Hold"];

/// A `YYYY-MM-DD` text, as the `date` it is bound as.
pub(crate) fn date(text: &str) -> Result<Date, DbErr> {
    Date::parse(text, format_description!("[year]-[month]-[day]"))
        .map_err(|error| DbErr::Type(format!("invalid date {text:?}: {error}")))
}

/// A `date` as `to_char(d, 'YYYY-MM-DD')` writes it.
fn date_text(day: Date) -> String {
    day.format(format_description!("[year]-[month]-[day]"))
        .unwrap_or_default()
}

/// A number's text, as the `numeric` it is bound as.
pub(crate) fn decimal(text: &str) -> Result<BigDecimal, DbErr> {
    text.parse()
        .map_err(|_| DbErr::Type(format!("invalid input syntax for type numeric: {text:?}")))
}

/// `findBooking(db, id)`: a live booking.
pub(crate) async fn find_booking(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    bookings::Entity::find_by_id(id.to_owned())
        .filter(bookings::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `findResourceRequest(db, id)`: a live resource request.
pub(crate) async fn find_resource_request(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    resource_requests::Entity::find_by_id(id.to_owned())
        .filter(resource_requests::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `findProfile(db, memberId)`.
pub(crate) async fn find_profile(db: &PgPool, member_id: &str) -> Result<Option<Value>, DbErr> {
    profiles::Entity::find()
        .filter(profiles::Column::MemberId.eq(member_id))
        .one(&orm(db))
        .await?
        .map(row_json)
        .transpose()
}

/// `Number(text)` of a `numeric` column's text.
fn hours_of(text: &str) -> f64 {
    numeric(&Value::String(text.to_owned()))
}

/// `leftJoin(projects, eq(projects.id, bookings.projectId))`.
fn booking_project() -> RelationDef {
    bookings::Entity::belongs_to(projects::Entity)
        .from(bookings::Column::ProjectId)
        .to(projects::Column::Id)
        .into()
}

/// `leftJoin(projectRequests, eq(projectRequests.id, bookings.requestId))`.
fn booking_request() -> RelationDef {
    bookings::Entity::belongs_to(project_requests::Entity)
        .from(bookings::Column::RequestId)
        .to(project_requests::Column::Id)
        .into()
}

/// `innerJoin(projects, eq(projects.id, tasks.projectId))`.
fn task_project() -> RelationDef {
    tasks::Entity::belongs_to(projects::Entity)
        .from(tasks::Column::ProjectId)
        .to(projects::Column::Id)
        .into()
}

/// `innerJoin(projects, eq(projects.id, projectMembers.projectId))`.
fn member_project() -> RelationDef {
    project_members::Entity::belongs_to(projects::Entity)
        .from(project_members::Column::ProjectId)
        .to(projects::Column::Id)
        .into()
}

/// A booking as the load query reads it.
type BookingRow = (
    String,
    Option<String>,
    Option<String>,
    Date,
    Date,
    BigDecimal,
    bool,
);
/// An open task as the load query reads it.
type TaskRow = (
    Option<String>,
    Option<String>,
    Option<Value>,
    Option<PrimitiveDateTime>,
    Option<PrimitiveDateTime>,
    BigDecimal,
);

/// Bookings overlapping `from..=to` (tentative ones only when asked for);
/// one held for a deleted or rejected request, or on a deleted project,
/// counts for nothing.
async fn booking_rows(
    db: &PgPool,
    (from, to): (Date, Date),
    include_tentative: bool,
) -> Result<Vec<BookingRow>, DbErr> {
    let mut find = bookings::Entity::find()
        .select_only()
        .columns([
            bookings::Column::MemberId,
            bookings::Column::ProjectId,
            bookings::Column::RequestId,
            bookings::Column::StartsOn,
            bookings::Column::EndsOn,
            bookings::Column::HoursPerWeek,
            bookings::Column::Tentative,
        ])
        .join(JoinType::LeftJoin, booking_project())
        .join(JoinType::LeftJoin, booking_request())
        .filter(bookings::Column::DeletedAt.is_null())
        .filter(bookings::Column::StartsOn.lte(to))
        .filter(bookings::Column::EndsOn.gte(from))
        .filter(
            Condition::any()
                .add(bookings::Column::ProjectId.is_null())
                .add(projects::Column::DeletedAt.is_null()),
        )
        .filter(
            Condition::any()
                .add(bookings::Column::RequestId.is_null())
                .add(
                    Condition::all()
                        .add(project_requests::Column::DeletedAt.is_null())
                        .add(project_requests::Column::Status.ne("rejected")),
                ),
        );
    if !include_tentative {
        find = find.filter(bookings::Column::Tentative.eq(false));
    }
    find.order_by_asc(bookings::Column::StartsOn)
        .order_by_asc(bookings::Column::Id)
        .into_tuple()
        .all(&orm(db))
        .await
}

/// Open tasks on live projects with an estimate (`estimated_hours`, else the
/// duration in hours, rounded to 2) and someone assigned, whose dates touch
/// `from..=to`.
async fn task_rows(db: &PgPool, (from, to): (Date, Date)) -> Result<Vec<TaskRow>, DbErr> {
    use sea_orm::ExprTrait as _;
    let col = |column: tasks::Column| Expr::col((tasks::Entity, column));
    // `coalesce(t.estimated_hours, round(t.duration / 60.0, 2))`.
    let estimate = || {
        Expr::from(Func::coalesce([
            col(tasks::Column::EstimatedHours),
            Expr::from(Func::round_with_precision(
                col(tasks::Column::Duration).div(Expr::val(BigDecimal::from(60))),
                2,
            )),
        ]))
    };
    // `case when jsonb_typeof(assignee_ids) = 'array' then jsonb_array_length(assignee_ids) else 0 end`.
    let assignee_count: Expr = Expr::case(
        Expr::from(Func::cust("jsonb_typeof").arg(col(tasks::Column::AssigneeIds))).eq("array"),
        Func::cust("jsonb_array_length").arg(col(tasks::Column::AssigneeIds)),
    )
    .finally(0)
    .into();
    let dates = || [col(tasks::Column::StartDate), col(tasks::Column::DueDate)];
    tasks::Entity::find()
        .select_only()
        .columns([
            tasks::Column::ProjectId,
            tasks::Column::AssigneeId,
            tasks::Column::AssigneeIds,
            tasks::Column::StartDate,
            tasks::Column::DueDate,
        ])
        .column_as(estimate(), "estimate")
        .join(JoinType::InnerJoin, task_project())
        .filter(tasks::Column::DeletedAt.is_null())
        .filter(projects::Column::DeletedAt.is_null())
        .filter(tasks::Column::ProjectId.is_not_null())
        .filter(tasks::Column::Status.is_not_in(["done", "cancelled"]))
        .filter(estimate().gt(0))
        .filter(
            Condition::any()
                .add(tasks::Column::AssigneeId.is_not_null())
                .add(assignee_count.gt(0)),
        )
        .filter(Expr::from(Func::least(dates())).cast_as("date").lte(to))
        .filter(
            Expr::from(Func::greatest(dates()))
                .cast_as("date")
                .gte(from),
        )
        .order_by_asc(tasks::Column::Id)
        .into_tuple()
        .all(&orm(db))
        .await
}

/// The people on current projects: their active members, then their
/// managers.
async fn current_people(db: &PgPool) -> Result<Vec<String>, DbErr> {
    let members: Vec<String> = project_members::Entity::find()
        .select_only()
        .column(project_members::Column::UserId)
        .distinct()
        .join(JoinType::InnerJoin, member_project())
        .filter(project_members::Column::IsActive.eq(true))
        .filter(project_members::Column::DeletedAt.is_null())
        .filter(projects::Column::DeletedAt.is_null())
        .filter(projects::Column::Status.is_in(CURRENT_PROJECT_STATUSES))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let managers: Vec<String> = projects::Entity::find()
        .select_only()
        .column(projects::Column::ProjectManagerId)
        .distinct()
        .filter(projects::Column::DeletedAt.is_null())
        .filter(projects::Column::ProjectManagerId.is_not_null())
        .filter(projects::Column::Status.is_in(CURRENT_PROJECT_STATUSES))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(members.into_iter().chain(managers).collect())
}

/// `loadCapacity(db, range, options)`: the load of every member over a range
/// of weeks. Bookings overlapping it (tentative ones only when asked for; one
/// held for a deleted or rejected request, or on a deleted project, counts for
/// nothing), open tasks with an estimate, and the members to list (profiles,
/// bookings, task assignees and the people on current projects).
pub(crate) async fn load_capacity(
    db: &PgPool,
    range: &CapacityRange,
    include_tentative: bool,
    skill: Option<&str>,
) -> Result<CapacityLoad, DbErr> {
    let span = (date(&range.from)?, date(&range.to)?);
    let booking_rows = booking_rows(db, span, include_tentative).await?;
    let task_rows = task_rows(db, span).await?;

    let profile_rows: Vec<(String, BigDecimal, Value)> = profiles::Entity::find()
        .select_only()
        .columns([
            profiles::Column::MemberId,
            profiles::Column::WeeklyHours,
            profiles::Column::Skills,
        ])
        .order_by_asc(profiles::Column::MemberId)
        .into_tuple()
        .all(&orm(db))
        .await?;

    let people = current_people(db).await?;

    let bookings: Vec<CapacityBooking> = booking_rows
        .into_iter()
        .map(
            |(member_id, project_id, request_id, starts_on, ends_on, hours, tentative)| {
                CapacityBooking {
                    member_id,
                    project_id,
                    request_id,
                    starts_on: date_text(starts_on),
                    ends_on: date_text(ends_on),
                    hours_per_week: hours_of(&hours.to_plain_string()),
                    tentative,
                }
            },
        )
        .collect();
    let tasks: Vec<CapacityTask> = task_rows
        .into_iter()
        .map(
            |(project_id, assignee_id, assignee_ids, starts_on, due_on, hours)| CapacityTask {
                project_id: project_id.unwrap_or_default(),
                assignee_id,
                assignee_ids: assignee_ids.and_then(|ids| {
                    ids.as_array().map(|list| {
                        list.iter()
                            .filter_map(|id| id.as_str().map(str::to_owned))
                            .collect()
                    })
                }),
                starts_on: starts_on.map(|at| date_text(at.date())),
                due_on: due_on.map(|at| date_text(at.date())),
                estimated_hours: hours_of(&hours.to_plain_string()),
            },
        )
        .collect();
    let profiles: Vec<CapacityProfile> = profile_rows
        .into_iter()
        .map(|(member_id, hours, skills)| CapacityProfile {
            member_id,
            weekly_hours: hours_of(&hours.to_plain_string()),
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
) -> Result<HashMap<String, ProjectLabel>, DbErr> {
    let mut ids: Vec<String> = project_ids.to_vec();
    ids.sort();
    ids.dedup();
    let mut labels = HashMap::new();
    if ids.is_empty() {
        return Ok(labels);
    }
    let rows: Vec<(String, String)> = projects::Entity::find()
        .select_only()
        .columns([projects::Column::Id, projects::Column::Name])
        .filter(projects::Column::Id.is_in(&ids))
        .filter(projects::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(&caller.db))
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
