//! "Test" on an integration (`services/integration-test.ts`): a dry run
//! against the latest completed response that writes nothing and records
//! nothing. It reads the response the way the step would, checks what the
//! integration's creator may do, and says what the step would do (the
//! ticket's subject, the task's title, whether the person exists). The
//! answer is always `{ ok, message }`; `ok: false` carries why not.

use serde_json::{Value, json};
use weldsuite_flow_domain::access::resolve_project_access;
use weldsuite_kit::validation::js_trim;

use crate::common::{Ctx, FormsResult, one, text};
use crate::creator_access::{CreatorAccess, CreatorForbidden, load_creator_access};
use crate::engine::FormDefinition;
use crate::integration_config::{crm_config, desk_config, flow_config};
use crate::integration_support::{
    TemplateContext, answer_text, email_answer, find_person_by_email, render_template,
};

fn answer(ok: bool, message: impl Into<String>) -> Value {
    json!({ "ok": ok, "message": message.into() })
}

/// What a dry run decided before its creator check could refuse it.
enum Dry {
    Answer(Value),
    Forbidden(CreatorForbidden),
}

impl From<CreatorForbidden> for Dry {
    fn from(forbidden: CreatorForbidden) -> Self {
        Self::Forbidden(forbidden)
    }
}

/// `testIntegration(ctx, row)`: `row` is the `form_integrations` row.
pub(crate) async fn test_integration(ctx: &Ctx, row: &Value) -> FormsResult<Value> {
    let Some(response) = one(
        &ctx.db,
        sqlx::query_scalar(
            "select to_jsonb(r) from form_responses r \
             where r.form_id = $1 and r.status = 'completed' order by r.submitted_at desc limit 1",
        )
        .bind(text(row, "formId")),
    )
    .await?
    else {
        return Ok(answer(
            false,
            "There is no completed response to test with yet.",
        ));
    };
    let form = one(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(f) from forms f where f.id = $1 limit 1")
            .bind(text(row, "formId")),
    )
    .await?;
    let version = one(
        &ctx.db,
        sqlx::query_scalar("select to_jsonb(v) from form_versions v where v.id = $1 limit 1")
            .bind(text(&response, "versionId")),
    )
    .await?;
    let definition = version.and_then(|v| FormDefinition::parse(&v["definition"]).ok());
    let (Some(form), Some(definition)) = (form, definition) else {
        return Ok(answer(
            false,
            "The form of the latest response could not be read.",
        ));
    };
    let prefix = format!(
        "Response #{}:",
        match &response["number"] {
            Value::Number(number) => number.to_string(),
            _ => "?".to_owned(),
        }
    );
    let access = load_creator_access(&ctx.db, ctx.env(), text(row, "createdByUserId")).await?;
    let template = TemplateContext {
        env: ctx.env(),
        form: &form,
        response: &response,
        definition: &definition,
    };
    match dry_run(ctx, row, &access, &template, &prefix).await? {
        Dry::Answer(value) => Ok(value),
        Dry::Forbidden(reason) => Ok(answer(false, reason.0)),
    }
}

/// The CRM branch of [`dry_run`].
async fn dry_run_crm(
    ctx: &Ctx,
    row: &Value,
    access: &CreatorAccess,
    template: &TemplateContext<'_>,
    prefix: &str,
) -> FormsResult<Dry> {
    let answers = &template.response["answers"];
    let definition = template.definition;
    let Some(config) = crm_config(&row["config"]) else {
        return Ok(Dry::Answer(answer(
            false,
            "The CRM integration is not set up correctly.",
        )));
    };
    let email = email_answer(definition, answers, &config.email_field_id);
    if email.is_empty() {
        return Ok(Dry::Answer(answer(
            false,
            format!("{prefix} no email address in the chosen question."),
        )));
    }
    if config.target == "lead" {
        if let Err(forbidden) = access.require("leads:create", "weldcrm", "create leads") {
            return Ok(forbidden.into());
        }
        return Ok(Dry::Answer(answer(
            true,
            format!("{prefix} would create a lead for {email}."),
        )));
    }
    let existing = find_person_by_email(&ctx.db, &email).await?;
    let checks = || -> Result<(), CreatorForbidden> {
        if existing.is_some() {
            access.require("people:update", "weldcrm", "update people")?;
        } else {
            access.require("people:create", "weldcrm", "create people")?;
        }
        if config.create_company {
            access.require("companies:create", "weldcrm", "create companies")?;
        }
        if config.list_id.is_some() {
            access.require("companies:update", "weldcrm", "add people to lists")?;
        }
        if config.log_activity {
            access.require("activities:create", "weldcrm", "log activities")?;
        }
        Ok(())
    };
    if let Err(forbidden) = checks() {
        return Ok(forbidden.into());
    }
    let filled = config
        .mappings
        .iter()
        .filter(|m| !answer_text(definition, answers, &m.block_id, m.part.as_deref()).is_empty())
        .count();
    Ok(Dry::Answer(answer(
        true,
        format!(
            "{prefix} would {} the person {email} ({filled} mapped fields).",
            if existing.is_some() {
                "update"
            } else {
                "create"
            }
        ),
    )))
}

async fn dry_run(
    ctx: &Ctx,
    row: &Value,
    access: &CreatorAccess,
    template: &TemplateContext<'_>,
    prefix: &str,
) -> FormsResult<Dry> {
    match text(row, "kind") {
        "crm" => dry_run_crm(ctx, row, access, template, prefix).await,
        "desk" => {
            let Some(config) = desk_config(&row["config"]) else {
                return Ok(Dry::Answer(answer(
                    false,
                    "The Desk integration is not set up correctly.",
                )));
            };
            if let Err(forbidden) = access.require("tickets:create", "welddesk", "open tickets") {
                return Ok(forbidden.into());
            }
            Ok(Dry::Answer(answer(
                true,
                format!(
                    "{prefix} would open the ticket \"{}\".",
                    js_trim(&render_template(&config.subject, template))
                ),
            )))
        }
        _ => {
            let Some(config) = flow_config(&row["config"]) else {
                return Ok(Dry::Answer(answer(
                    false,
                    "The Flow integration is not set up correctly.",
                )));
            };
            if let Err(forbidden) = access.require("tasks:create", "weldflow", "create tasks") {
                return Ok(forbidden.into());
            }
            if let Some(project_id) = &config.project_id {
                let project = resolve_project_access(
                    &ctx.db,
                    Some(text(row, "createdByUserId")),
                    access.can("projects:scope:all", "weldflow"),
                    project_id,
                )
                .await?;
                if !project.can_write {
                    return Ok(Dry::Forbidden(CreatorForbidden(
                        "The member who set up this integration does not have write access to the project"
                            .to_owned(),
                    )));
                }
            }
            Ok(Dry::Answer(answer(
                true,
                format!(
                    "{prefix} would create the task \"{}\".",
                    js_trim(&render_template(&config.title, template))
                ),
            )))
        }
    }
}
