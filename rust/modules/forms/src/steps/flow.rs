//! Step `flow` (`workflows/steps/flow.ts`, ADR FORMS-006): per enabled
//! `flow` integration, as the member who set it up: a task in the chosen
//! project (or a personal task of the assignee) with a title and
//! description from recall templates, an assignee, a due date from a date
//! question, labels, and the response's uploads attached as files of the
//! task.
//!
//! Written through `weldsuite_flow_domain::tasks` (numbering, stage,
//! position), the same writer flow-api and WeldConnect use. The task is
//! remembered on the action row as soon as it exists, so a retry after a
//! later failure (the attachments) goes on with the same task; an edit of
//! the response leaves it as it is.

use std::collections::HashSet;

use serde_json::{Map, Value, json};
use weldsuite_core_domain::files::{NewFile, create_file};
use weldsuite_flow_domain::access::resolve_project_access;
use weldsuite_flow_domain::analytics::task_analytics_payload;
use weldsuite_flow_domain::tasks::create_task;
use weldsuite_kit::validation::js_trim;
use weldsuite_ports::{BoxFuture, PutOptions};

use crate::common::{iso, js_slice, text};
use crate::creator_access::{CreatorForbidden, load_creator_access};
use crate::integration_config::{FlowConfig, flow_config};
use crate::integration_support::{
    StepFail, TemplateContext, answer_text, emit_record_event, number_text, random_uuid,
    read_response_file, recorded_entity, remember_entity, render_template, safe_file_name,
};
use crate::process::{ProcessContext, ProcessStep, StepKind, StepResult};

pub(crate) struct FlowStep;

impl ProcessStep for FlowStep {
    fn name(&self) -> &'static str {
        "flow"
    }

    fn kind(&self) -> StepKind {
        StepKind::Integration("flow")
    }

    fn run<'a>(
        &'a self,
        ctx: &'a ProcessContext,
        integration: Option<&'a Value>,
    ) -> BoxFuture<'a, Result<StepResult, String>> {
        Box::pin(async move {
            let Some(integration) = integration else {
                return Err("forms: the Flow step runs per integration".to_owned());
            };
            run_flow_step(ctx, integration).await
        })
    }
}

/// `attachFiles(ctx, taskId, userId)`: the response's uploads as files of
/// the task, each copied once (a retry finds the copies it made).
async fn attach_files(ctx: &ProcessContext, task_id: &str, user_id: &str) -> Result<(), StepFail> {
    let made: Vec<Option<String>> = sqlx::query_scalar(
        "select metadata->>'formResponseFileId' from files where entity_type = 'task' and entity_id = $1",
    )
    .bind(task_id)
    .fetch_all(&ctx.db)
    .await?;
    let done: HashSet<String> = made.into_iter().flatten().collect();
    for file in &ctx.files {
        let file_id = text(file, "id");
        if done.contains(file_id) {
            continue;
        }
        let Some(body) = read_response_file(&ctx.ctx, file).await? else {
            continue;
        };
        let Some(files) = ctx.ctx.svc.files.as_ref() else {
            continue;
        };
        let name = safe_file_name(text(file, "name"));
        // A copy of its own, under the task: deleting the response never breaks the task, nor the other way round.
        let key = format!(
            "workspaces/{}/tasks/{task_id}/{}/{name}",
            ctx.params.clerk_org_id,
            random_uuid()
        );
        let content_type = text(file, "contentType");
        files
            .private
            .put_boxed(&key, body, &PutOptions::content_type(content_type))
            .await
            .map_err(|error| StepFail::Error(error.to_string()))?;
        let new_file = NewFile {
            file_name: text(file, "name").to_owned(),
            mime_type: content_type.to_owned(),
            file_size: file["sizeBytes"].as_i64().unwrap_or_default(),
            storage_path: key.clone(),
            file_key: Some(key),
            bucket: Some("private".to_owned()),
            entity_type: Some("task".to_owned()),
            entity_id: Some(task_id.to_owned()),
            uploaded_by_id: user_id.to_owned(),
            metadata: Some(json!({
                "formResponseFileId": file_id,
                "formId": text(&ctx.form, "id"),
                "responseId": text(&ctx.response, "id"),
            })),
            ..NewFile::default()
        };
        create_file(&ctx.db, &new_file, &iso(ctx.ctx.now_ms())).await?;
    }
    Ok(())
}

/// `runFlowStep(ctx, integration)`.
pub(crate) async fn run_flow_step(
    ctx: &ProcessContext,
    integration: &Value,
) -> Result<StepResult, String> {
    let Some(config) = flow_config(&integration["config"]) else {
        return Ok(StepResult::Skipped(
            "The Flow integration is not set up correctly".to_owned(),
        ));
    };
    match flow_body(ctx, integration, &config).await {
        Ok(result) => Ok(result),
        Err(StepFail::Forbidden(reason)) => Ok(StepResult::Skipped(reason.0)),
        Err(StepFail::Error(message)) => Err(message),
    }
}

fn done(task_id: String) -> StepResult {
    StepResult::Done {
        entity_type: Some("task".to_owned()),
        entity_id: Some(task_id),
    }
}

/// `/^\d{4}-\d{2}-\d{2}$/`.
fn is_day(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
}

#[allow(clippy::too_many_lines, reason = "the worker's steps, in its order")]
async fn flow_body(
    ctx: &ProcessContext,
    integration: &Value,
    config: &FlowConfig,
) -> Result<StepResult, StepFail> {
    let user_id = text(integration, "createdByUserId");
    let response_id = text(&ctx.response, "id");
    let integration_id = text(integration, "id");
    let recorded = recorded_entity(&ctx.db, response_id, integration_id).await?;
    let known = match recorded {
        Some((kind, id)) if kind == "task" => {
            let exists: Option<String> =
                sqlx::query_scalar("select id from tasks where id = $1 limit 1")
                    .bind(&id)
                    .fetch_optional(&ctx.db)
                    .await?;
            exists.map(|_| id)
        }
        _ => None,
    };
    // An edited response leaves the task as the team found it.
    if let Some(known) = &known
        && ctx.params.mode == "update"
    {
        return Ok(done(known.clone()));
    }

    let access = load_creator_access(&ctx.db, ctx.ctx.env(), user_id).await?;
    if let Some(known) = known {
        // Resumed after a failure: only what is missing (the attachments) is still to do.
        if config.attach_files {
            attach_files(ctx, &known, user_id).await?;
        }
        return Ok(done(known));
    }
    access.require("tasks:create", "weldflow", "create tasks")?;
    if let Some(project_id) = &config.project_id {
        let project = resolve_project_access(
            &ctx.db,
            Some(user_id),
            access.can("projects:scope:all", "weldflow"),
            project_id,
        )
        .await?;
        if project.deleted {
            return Ok(StepResult::Skipped(
                "The project of this integration no longer exists".to_owned(),
            ));
        }
        if !project.can_write {
            return Err(StepFail::Forbidden(CreatorForbidden(
                "The member who set up this integration does not have write access to the project"
                    .to_owned(),
            )));
        }
    }

    let template = TemplateContext {
        env: ctx.ctx.env(),
        form: &ctx.form,
        response: &ctx.response,
        definition: &ctx.definition,
    };
    let fallback = js_trim(&format!(
        "{} #{}",
        text(&ctx.form, "title"),
        number_text(&ctx.response)
    ))
    .to_owned();
    let title = Some(js_trim(&render_template(&config.title, &template)).to_owned())
        .filter(|t| !t.is_empty())
        .unwrap_or(fallback);
    let description = js_trim(&render_template(&config.description, &template)).to_owned();
    let due = config
        .due_date_field_id
        .as_deref()
        .map_or_else(String::new, |id| {
            answer_text(&ctx.definition, &ctx.response["answers"], id, None)
        });
    // A personal task belongs to someone: the assignee, else the member who set the integration up.
    let assignee = config
        .assignee_user_id
        .clone()
        .or_else(|| config.project_id.is_none().then(|| user_id.to_owned()));

    let mut data = Map::new();
    data.insert("title".to_owned(), json!(js_slice(&title, 500)));
    if !description.is_empty() {
        data.insert("description".to_owned(), json!(description));
    }
    if let Some(assignee) = assignee {
        data.insert("assigneeId".to_owned(), json!(assignee));
    }
    if is_day(&due) {
        data.insert("dueDate".to_owned(), json!(due));
    }
    if !config.labels.is_empty() {
        data.insert("labels".to_owned(), json!(config.labels));
    }
    data.insert("sourceType".to_owned(), json!("form_response"));
    data.insert("sourceId".to_owned(), json!(response_id));
    let created = create_task(&ctx.db, &data, config.project_id.as_deref(), user_id)
        .await
        .map_err(|error| StepFail::Error(error.to_string()))?;
    let task_id = text(&created.row, "id").to_owned();
    remember_entity(&ctx.db, response_id, integration_id, "task", &task_id).await?;
    let overrides = json!({ "projectId": config.project_id });
    emit_record_event(
        &ctx.ctx,
        user_id,
        "project_task",
        "created",
        &task_id,
        &task_analytics_payload(&created.row, &overrides, ctx.ctx.now_ms()),
    )
    .await;
    if config.attach_files {
        attach_files(ctx, &task_id, user_id).await?;
    }
    Ok(done(task_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_dates_are_whole_days() {
        assert!(is_day("2026-12-01"));
        assert!(!is_day("2026-12-1"));
        assert!(!is_day("2026-12-01T00:00"));
    }
}
