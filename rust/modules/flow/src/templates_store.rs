//! Project templates, the database side (`services/project-templates.ts`):
//! a template this person may see, how many projects each made, reading a
//! project into a blueprint source, writing a planned project in one batch,
//! and the events of a new project. The rules are
//! `weldsuite_flow_domain::project_templates`.

use std::collections::HashMap;

use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect, Select};
use serde_json::{Value, json};
use sqlx::postgres::PgArguments;
use sqlx::query::Query;
use weldsuite_catalogs::entity_events::{
    PROJECT_CREATED, PROJECT_DELIVERABLE_CREATED, PROJECT_MEMBER_ADDED, PROJECT_MILESTONE_CREATED,
    PROJECT_PHASE_CREATED, PROJECT_PIPELINE_STAGE_CREATED, PROJECT_RAID_ITEM_CREATED,
    PROJECT_TASK_CREATED, TASK_DEPENDENCY_CREATED,
};
use weldsuite_db::{PgPool, orm};
use weldsuite_flow_domain::analytics::task_analytics_payload;
use weldsuite_flow_domain::blueprint::{Json, summarize_stored_blueprint};
use weldsuite_flow_domain::project_templates::{BlueprintSource, InstantiatePlan, read_blueprint};
use weldsuite_flow_domain::raid::raid_event_data;
use weldsuite_schema::tenant::{
    milestones, project_deliverables, project_members, project_phases, project_pipeline_stages,
    project_raid_items, project_templates, projects, task_dependencies, tasks,
};

use crate::tasks::row_json;
use crate::{Caller, FlowState};

/// A live template, by id (the caller checks who may see it).
pub(crate) async fn find_template(
    db: &PgPool,
    id: &str,
    live_only: bool,
) -> Result<Option<Value>, DbErr> {
    let mut select = project_templates::Entity::find_by_id(id.to_owned());
    if live_only {
        select = select.filter(project_templates::Column::DeletedAt.is_null());
    }
    select.one(&orm(db)).await?.map(row_json).transpose()
}

/// `findVisibleTemplate`: a live template this person may see: a shared one, or their own.
pub(crate) async fn find_visible_template(
    db: &PgPool,
    id: &str,
    user_id: &str,
) -> Result<Option<Value>, DbErr> {
    Ok(find_template(db, id, true)
        .await?
        .filter(|row| row.flag("shared") || row.text("createdBy") == Some(user_id)))
}

/// `usageCounts`: how many live projects were created from each template.
pub(crate) async fn usage_counts(
    db: &PgPool,
    template_ids: &[String],
) -> Result<HashMap<String, i64>, DbErr> {
    let mut usage: HashMap<String, i64> = template_ids.iter().map(|id| (id.clone(), 0)).collect();
    if template_ids.is_empty() {
        return Ok(usage);
    }
    // `settings->>'templateId'`.
    let template_id = || PgExpr::cast_json_field(Expr::col(projects::Column::Settings), "templateId");
    let rows: Vec<(String, i64)> = projects::Entity::find()
        .select_only()
        .column_as(template_id(), "template_id")
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
        .filter(projects::Column::DeletedAt.is_null())
        .filter(sea_orm::ExprTrait::is_in(
            template_id(),
            template_ids.iter().map(String::as_str),
        ))
        .group_by(template_id())
        .into_tuple()
        .all(&orm(db))
        .await?;
    usage.extend(rows);
    Ok(usage)
}

/// A template as the list answers it: a summary of the blueprint, not the blueprint.
pub(crate) fn present_template(row: &Value, usage_count: i64) -> Value {
    json!({
        "id": row.at("id"),
        "name": row.at("name"),
        "description": row.at("description"),
        "shared": row.at("shared"),
        "sourceProjectId": row.at("sourceProjectId"),
        "createdBy": row.at("createdBy"),
        "createdAt": row.at("createdAt"),
        "updatedAt": row.at("updatedAt"),
        "summary": summarize_stored_blueprint(row.at("blueprint")),
        "usageCount": usage_count,
    })
}

/// A template with its blueprint, or `None` when the stored blueprint is not valid any more.
pub(crate) fn present_template_detail(row: &Value, usage_count: i64) -> Option<Value> {
    let blueprint = read_blueprint(row.at("blueprint")).ok()?;
    let mut detail = present_template(row, usage_count);
    detail["blueprint"] = blueprint;
    Some(detail)
}

/// The payload of a `project_template` event.
pub(crate) fn template_event_data(row: &Value) -> Value {
    json!({
        "id": row.at("id"),
        "name": row.at("name"),
        "shared": row.at("shared"),
        "sourceProjectId": row.at("sourceProjectId"),
    })
}

/// The template with its blueprint and use count, as the detail routes answer it.
pub(crate) async fn detail_of(db: &PgPool, row: &Value) -> Result<Option<Value>, DbErr> {
    let id = row.text("id").unwrap_or_default().to_owned();
    let usage = usage_counts(db, std::slice::from_ref(&id)).await?;
    Ok(present_template_detail(
        row,
        usage.get(&id).copied().unwrap_or(0),
    ))
}

// ── Save as template ────────────────────────────────────────────────────────

/// The rows of `select`, as Drizzle returns them.
async fn rows_of<E>(db: &PgPool, select: Select<E>) -> Result<Vec<Value>, DbErr>
where
    E: EntityTrait,
    E::Model: serde::Serialize,
{
    select
        .all(&orm(db))
        .await?
        .into_iter()
        .map(row_json)
        .collect()
}

/// `loadBlueprintSource`: every live row a blueprint of the project is built from.
pub(crate) async fn load_blueprint_source(
    db: &PgPool,
    project: &Value,
) -> Result<BlueprintSource, DbErr> {
    let id = project.text("id").unwrap_or_default();
    Ok(BlueprintSource {
        project: project.clone(),
        members: {
            use project_members::Column;
            rows_of(
                db,
                project_members::Entity::find()
                    .filter(Column::ProjectId.eq(id))
                    .filter(Column::IsActive.eq(true))
                    .filter(Column::DeletedAt.is_null()),
            )
            .await?
        },
        stages: {
            use project_pipeline_stages::Column;
            rows_of(
                db,
                project_pipeline_stages::Entity::find()
                    .filter(Column::ProjectId.eq(id))
                    .filter(Column::DeletedAt.is_null())
                    .order_by_asc(Column::Position),
            )
            .await?
        },
        phases: {
            use project_phases::Column;
            rows_of(
                db,
                project_phases::Entity::find()
                    .filter(Column::ProjectId.eq(id))
                    .filter(Column::DeletedAt.is_null()),
            )
            .await?
        },
        milestones: {
            use milestones::Column;
            rows_of(
                db,
                milestones::Entity::find()
                    .filter(Column::ProjectId.eq(id))
                    .filter(Column::DeletedAt.is_null()),
            )
            .await?
        },
        deliverables: {
            use project_deliverables::Column;
            rows_of(
                db,
                project_deliverables::Entity::find()
                    .filter(Column::ProjectId.eq(id))
                    .filter(Column::DeletedAt.is_null()),
            )
            .await?
        },
        tasks: {
            use tasks::Column;
            rows_of(
                db,
                tasks::Entity::find()
                    .filter(Column::ProjectId.eq(id))
                    .filter(Column::DeletedAt.is_null()),
            )
            .await?
        },
        dependencies: rows_of(
            db,
            task_dependencies::Entity::find()
                .filter(task_dependencies::Column::ProjectId.eq(id)),
        )
        .await?,
        raid_items: {
            use project_raid_items::Column;
            rows_of(
                db,
                project_raid_items::Entity::find()
                    .filter(Column::ProjectId.eq(id))
                    .filter(Column::DeletedAt.is_null()),
            )
            .await?
        },
    })
}

// ── Create project ──────────────────────────────────────────────────────────

/// A plan's rows with `camelCase` keys as `snake_case` columns.
fn snake_rows(rows: &[Value]) -> Value {
    let snake = |key: &str| {
        let mut out = String::with_capacity(key.len() + 2);
        for c in key.chars() {
            if c.is_ascii_uppercase() {
                out.push('_');
                out.push(c.to_ascii_lowercase());
            } else {
                out.push(c);
            }
        }
        out
    };
    Value::Array(
        rows.iter()
            .map(|row| {
                Value::Object(
                    row.as_object()
                        .into_iter()
                        .flatten()
                        .map(|(key, value)| (snake(key), value.clone()))
                        .collect(),
                )
            })
            .collect(),
    )
}

/// `insert into <table> (cols) select cols from jsonb_populate_recordset(…, $1)`.
macro_rules! populate {
    ($table:literal, $cols:literal) => {
        concat!(
            "insert into ",
            $table,
            " (",
            $cols,
            ") select ",
            $cols,
            " from jsonb_populate_recordset(null::",
            $table,
            ", $1)"
        )
    };
}

const PROJECT_SQL: &str = populate!(
    "projects",
    "id, name, status, customer_id, project_manager_id, start_date, end_date, type, methodology, \
     priority, visibility, color, icon, budget_currency, billing_method, is_billable, track_time, \
     settings, created_at, updated_at"
);
const MEMBER_SQL: &str = populate!(
    "project_members",
    "id, project_id, user_id, role, is_active, joined_at, created_at, updated_at"
);
const SEQUENCE_SQL: &str = populate!(
    "task_number_sequences",
    "id, scope, prefix, next_value, created_at, updated_at"
);
const STAGE_SQL: &str = populate!(
    "project_pipeline_stages",
    "id, project_id, name, color, position, system_status, created_at, updated_at"
);
const MILESTONE_SQL: &str = populate!(
    "milestones",
    "id, project_id, name, description, due_date, status, progress, owner_id, is_key_milestone, \
     created_at, updated_at"
);
const PHASE_SQL: &str = populate!(
    "project_phases",
    "id, project_id, position, name, planned_start, planned_end, status, gate_criteria, \
     created_by, created_at, updated_at"
);
const DELIVERABLE_SQL: &str = populate!(
    "project_deliverables",
    "id, project_id, number, title, description, owner_id, status, planned_start, planned_end, \
     acceptance_criteria, position, client_visible, created_by, created_at, updated_at"
);
const TASK_SQL: &str = populate!(
    "tasks",
    "id, number, project_id, title, description, status, stage_id, priority, type, assignee_id, \
     assignee_ids, reporter_id, parent_task_id, milestone_id, deliverable_id, start_date, \
     due_date, estimated_hours, story_points, labels, tags, is_billable, depends_on, blocks, \
     position, progress, created_at, updated_at"
);
const DEPENDENCY_SQL: &str = populate!(
    "task_dependencies",
    "id, project_id, predecessor_id, successor_id, type, lag_days, created_by, created_at, \
     updated_at"
);
const RAID_SQL: &str = populate!(
    "project_raid_items",
    "id, project_id, kind, number, title, description, status, category, owner_id, closed_at, \
     custom_fields, created_by, created_at, updated_at, due_at, probability, impact, strategy, \
     \"trigger\", cost_impact, schedule_impact_days, review_interval_days, confidence, if_wrong, \
     severity, direction, party_type, party_name"
);
const ASSESSMENT_SQL: &str = populate!(
    "project_raid_assessments",
    "id, item_id, project_id, probability, impact, residual_probability, residual_impact, note, \
     assessed_by, assessed_at"
);

/// The statements that write a planned project, in the order its foreign keys
/// need them (`planStatements`): the project first, tasks before their
/// dependencies, register items before their assessments. Run them with
/// `atomically`: the project is there whole or not at all.
#[allow(
    clippy::disallowed_methods,
    reason = "bulk inserts: each table's planned rows in one `insert … select … from \
              jsonb_populate_recordset`, Postgres converting the values to the columns' types"
)]
pub(crate) fn plan_statements(
    plan: &InstantiatePlan,
) -> Vec<Query<'static, sqlx::Postgres, PgArguments>> {
    let one = [plan.project.clone()];
    let lists: [(&'static str, &[Value]); 11] = [
        (PROJECT_SQL, &one),
        (MEMBER_SQL, &plan.members),
        (SEQUENCE_SQL, &plan.sequences),
        (STAGE_SQL, &plan.stages),
        (MILESTONE_SQL, &plan.milestones),
        (PHASE_SQL, &plan.phases),
        (DELIVERABLE_SQL, &plan.deliverables),
        (TASK_SQL, &plan.tasks),
        (DEPENDENCY_SQL, &plan.dependencies),
        (RAID_SQL, &plan.raid_items),
        (ASSESSMENT_SQL, &plan.assessments),
    ];
    lists
        .into_iter()
        .filter(|(_, rows)| !rows.is_empty())
        .map(|(sql, rows)| sqlx::query(sql).bind(snake_rows(rows)))
        .collect()
}

/// Publish the `created` events of a new project, in the order its rows were
/// written (`publishPlannedEvents`): the project, its members, stages,
/// milestones, phases, deliverables, tasks, dependencies and register items.
pub(crate) async fn publish_planned_events(
    state: &FlowState,
    caller: &Caller,
    plan: &InstantiatePlan,
) -> Result<(), DbErr> {
    let project_id = plan.project_id.as_str();
    if let Some(fields) = plan.project.as_object() {
        caller.publish(
            state,
            PROJECT_CREATED,
            project_id,
            &crate::projects::analytics_payload(fields),
        );
    }
    let publish = |event, rows: &[Value], data: &dyn Fn(&Value) -> Value| {
        for row in rows {
            caller.publish(state, event, row.text("id").unwrap_or_default(), &data(row));
        }
    };
    let pick = |row: &Value, keys: &[&str]| {
        Value::Object(
            keys.iter()
                .map(|key| ((*key).to_owned(), row.at(key).clone()))
                .collect(),
        )
    };
    publish(PROJECT_MEMBER_ADDED, &plan.members, &|r| {
        pick(r, &["id", "projectId", "userId", "role"])
    });
    publish(PROJECT_PIPELINE_STAGE_CREATED, &plan.stages, &|r| {
        pick(r, &["id", "projectId", "name"])
    });
    publish(
        PROJECT_MILESTONE_CREATED,
        &plan.milestones,
        &|r| json!({ "id": r.at("id"), "projectId": r.at("projectId"), "name": r.at("name"), "status": "pending" }),
    );
    publish(PROJECT_PHASE_CREATED, &plan.phases, &|r| {
        pick(r, &["id", "projectId", "name", "position", "status"])
    });
    publish(PROJECT_DELIVERABLE_CREATED, &plan.deliverables, &|r| {
        json!({
            "id": r.at("id"), "projectId": r.at("projectId"), "number": r.at("number"),
            "code": format!("D{}", r.int("number").unwrap_or(0)), "title": r.at("title"),
            "status": r.at("status"),
        })
    });
    let now_ms = crate::now_ms();
    publish(PROJECT_TASK_CREATED, &plan.tasks, &|r| {
        task_analytics_payload(r, &json!({ "projectId": project_id }), now_ms)
    });
    publish(TASK_DEPENDENCY_CREATED, &plan.dependencies, &|r| {
        pick(
            r,
            &[
                "id",
                "projectId",
                "predecessorId",
                "successorId",
                "type",
                "lagDays",
            ],
        )
    });
    if !plan.raid_items.is_empty() {
        // The register events carry whole rows (score, band), so read them back as the database stored them.
        let stored = rows_of(
            &caller.db,
            project_raid_items::Entity::find()
                .filter(project_raid_items::Column::ProjectId.eq(project_id)),
        )
        .await?;
        let by_id: HashMap<String, Value> = stored
            .into_iter()
            .map(|row| (row.text("id").unwrap_or_default().to_owned(), row))
            .collect();
        for planned in &plan.raid_items {
            let id = planned.text("id").unwrap_or_default();
            if let Some(row) = by_id.get(id) {
                caller.publish(state, PROJECT_RAID_ITEM_CREATED, id, &raid_event_data(row));
            }
        }
    }
    Ok(())
}
