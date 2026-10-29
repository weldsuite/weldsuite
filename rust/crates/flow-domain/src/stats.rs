//! Project and milestone statistics, computed on read
//! (`@weldsuite/flow-domain/project-stats`). The stored counters are never
//! maintained, so readers derive them and overlay them on the row under the
//! same keys: `progress` / `actualHours` as numeric strings, counters as
//! integers.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use sqlx::PgPool;

use crate::js::{math_round, to_fixed};

/// One project's computed stats.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectStats {
    pub total_tasks: i64,
    pub completed_tasks: i64,
    pub open_tasks: i64,
    pub total_milestones: i64,
    pub completed_milestones: i64,
    pub progress: String,
    pub actual_hours: String,
}

impl ProjectStats {
    /// `EMPTY_PROJECT_STATS`.
    pub fn empty() -> Self {
        Self {
            total_tasks: 0,
            completed_tasks: 0,
            open_tasks: 0,
            total_milestones: 0,
            completed_milestones: 0,
            progress: "0.00".to_owned(),
            actual_hours: "0.00".to_owned(),
        }
    }

    fn overlay(&self, row: &mut Map<String, Value>) {
        row.insert("totalTasks".into(), json!(self.total_tasks));
        row.insert("completedTasks".into(), json!(self.completed_tasks));
        row.insert("openTasks".into(), json!(self.open_tasks));
        row.insert("totalMilestones".into(), json!(self.total_milestones));
        row.insert(
            "completedMilestones".into(),
            json!(self.completed_milestones),
        );
        row.insert("progress".into(), json!(self.progress));
        row.insert("actualHours".into(), json!(self.actual_hours));
    }
}

/// One milestone's computed task counters and progress.
#[derive(Debug, Clone, PartialEq)]
pub struct MilestoneStats {
    pub total_tasks: i64,
    pub completed_tasks: i64,
    pub progress: String,
}

/// completed / countable * 100, 2 decimals; `0.00` when nothing counts.
#[allow(clippy::cast_precision_loss)]
fn percent(completed: i64, countable: i64) -> String {
    if countable <= 0 {
        return "0.00".to_owned();
    }
    to_fixed((completed as f64 / countable as f64) * 100.0, 2)
}

/// Minutes to a 2-decimal hours string (`minutesToHours`).
fn minutes_to_hours(minutes: Option<f64>) -> String {
    let value = minutes.unwrap_or(0.0);
    if !value.is_finite() || value <= 0.0 {
        return "0.00".to_owned();
    }
    to_fixed(math_round((value / 60.0) * 100.0) / 100.0, 2)
}

fn unique(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !id.is_empty() && !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// `getProjectStats`: every requested id is present.
pub async fn project_stats(
    db: &PgPool,
    project_ids: &[String],
) -> Result<HashMap<String, ProjectStats>, sqlx::Error> {
    let ids = unique(project_ids);
    let mut result = HashMap::new();
    if ids.is_empty() {
        return Ok(result);
    }
    let tasks: Vec<(Option<String>, i32, i32, i32)> = sqlx::query_as(
        "select project_id, count(*)::int,
                (count(*) filter (where status = 'done'))::int,
                (count(*) filter (where status = 'cancelled'))::int
         from tasks where project_id = any($1) and deleted_at is null
         group by project_id",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let milestones: Vec<(Option<String>, i32, i32)> = sqlx::query_as(
        "select project_id, count(*)::int,
                (count(*) filter (where status = 'completed'))::int
         from milestones where project_id = any($1) and deleted_at is null
         group by project_id",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let minutes: Vec<(Option<String>, Option<f64>)> = sqlx::query_as(
        "select project_id, sum(duration)::float8
         from time_entries
         where project_id = any($1) and deleted_at is null and status <> 'rejected'
         group by project_id",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    for id in ids {
        let task = tasks.iter().find(|t| t.0.as_deref() == Some(id.as_str()));
        let milestone = milestones
            .iter()
            .find(|m| m.0.as_deref() == Some(id.as_str()));
        let total = i64::from(task.map_or(0, |t| t.1));
        let completed = i64::from(task.map_or(0, |t| t.2));
        let cancelled = i64::from(task.map_or(0, |t| t.3));
        let hours = minutes
            .iter()
            .find(|m| m.0.as_deref() == Some(id.as_str()))
            .and_then(|m| m.1);
        result.insert(
            id,
            ProjectStats {
                total_tasks: total,
                completed_tasks: completed,
                open_tasks: (total - completed - cancelled).max(0),
                total_milestones: i64::from(milestone.map_or(0, |m| m.1)),
                completed_milestones: i64::from(milestone.map_or(0, |m| m.2)),
                progress: percent(completed, total - cancelled),
                actual_hours: minutes_to_hours(hours),
            },
        );
    }
    Ok(result)
}

/// `withProjectStats`: rows with the computed stats over the stored columns.
pub fn with_project_stats(rows: Vec<Value>, stats: &HashMap<String, ProjectStats>) -> Vec<Value> {
    let empty = ProjectStats::empty();
    rows.into_iter()
        .map(|row| match row {
            Value::Object(mut map) => {
                let id = map.get("id").and_then(Value::as_str).unwrap_or_default();
                stats.get(id).unwrap_or(&empty).overlay(&mut map);
                Value::Object(map)
            }
            other => other,
        })
        .collect()
}

/// `getMilestoneStats` over `(id, status)` pairs: every one is present.
pub async fn milestone_stats(
    db: &PgPool,
    milestones: &[(String, Option<String>)],
) -> Result<HashMap<String, MilestoneStats>, sqlx::Error> {
    let mut status_by_id: Vec<(String, Option<String>)> = Vec::new();
    for (id, status) in milestones {
        if id.is_empty() {
            continue;
        }
        if let Some(entry) = status_by_id.iter_mut().find(|(seen, _)| seen == id) {
            entry.1.clone_from(status);
        } else {
            status_by_id.push((id.clone(), status.clone()));
        }
    }
    let mut result = HashMap::new();
    if status_by_id.is_empty() {
        return Ok(result);
    }
    let ids: Vec<String> = status_by_id.iter().map(|(id, _)| id.clone()).collect();
    let rows: Vec<(Option<String>, i32, i32, i32)> = sqlx::query_as(
        "select milestone_id, count(*)::int,
                (count(*) filter (where status = 'done'))::int,
                (count(*) filter (where status = 'cancelled'))::int
         from tasks
         where milestone_id = any($1) and milestone_id is not null and deleted_at is null
         group by milestone_id",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?;
    for (id, status) in status_by_id {
        let row = rows.iter().find(|r| r.0.as_deref() == Some(id.as_str()));
        let total = i64::from(row.map_or(0, |r| r.1));
        let completed = i64::from(row.map_or(0, |r| r.2));
        let cancelled = i64::from(row.map_or(0, |r| r.3));
        let countable = total - cancelled;
        let progress = if countable > 0 {
            percent(completed, countable)
        } else if status.as_deref() == Some("completed") {
            "100.00".to_owned()
        } else {
            "0.00".to_owned()
        };
        result.insert(
            id,
            MilestoneStats {
                total_tasks: total,
                completed_tasks: completed,
                progress,
            },
        );
    }
    Ok(result)
}

/// The `(id, status)` pairs of milestone rows, for [`milestone_stats`].
pub fn milestone_refs(rows: &[Value]) -> Vec<(String, Option<String>)> {
    rows.iter()
        .map(|row| {
            (
                row["id"].as_str().unwrap_or_default().to_owned(),
                row["status"].as_str().map(str::to_owned),
            )
        })
        .collect()
}

/// `withMilestoneStats`.
pub fn with_milestone_stats(
    rows: Vec<Value>,
    stats: &HashMap<String, MilestoneStats>,
) -> Vec<Value> {
    rows.into_iter()
        .map(|row| match row {
            Value::Object(mut map) => {
                let id = map.get("id").and_then(Value::as_str).unwrap_or_default();
                let (total, completed, progress) = stats.get(id).map_or_else(
                    || (0, 0, "0.00".to_owned()),
                    |s| (s.total_tasks, s.completed_tasks, s.progress.clone()),
                );
                map.insert("totalTasks".into(), json!(total));
                map.insert("completedTasks".into(), json!(completed));
                map.insert("progress".into(), json!(progress));
                Value::Object(map)
            }
            other => other,
        })
        .collect()
}
