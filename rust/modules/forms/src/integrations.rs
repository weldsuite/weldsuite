//! A form's integrations (`services/integrations.ts`, `form_integrations`):
//! list, create, change, remove and check their settings against the form.
//! What they do on a response is the `ProcessResponse` steps
//! ([`crate::steps`]); what a dry run would do is [`crate::integration_test`].
//!
//! Settings are read with the per-kind schema ([`parse_config`]) and then
//! checked against the form's draft definition: every question they name
//! must exist and be of a fitting type, every recalled `{{field:ref}}` /
//! `{{hidden:name}}` / `{{var:name}}` must exist, and the records they point
//! at (a CRM list, a Desk department, a Flow project, the assignee) must
//! exist. The steps act as `created_by_user_id`; whoever changes the settings
//! becomes that member, so nobody can widen what another member's access
//! writes.

use serde_json::{Map, Value, json};
use sqlx::PgPool;

use crate::common::{Ctx, FormsResult, all, forms_error, forms_error_with, iso, one, text};
use crate::engine::{FormDefinition, RecallKind, find_field, find_field_by_ref, recall_tokens};
use crate::integration_config::{
    CrmConfig, DeskConfig, FlowConfig, IntegrationConfig, parse_config,
};
use crate::members::{bare_ref, member_refs};

/// `MAX_INTEGRATIONS`: most integrations one form carries.
pub(crate) const MAX_INTEGRATIONS: usize = 20;

/// `CRM_STANDARD_FIELD_KEYS`.
const CRM_STANDARD_FIELD_KEYS: &[&str] = &[
    "firstName",
    "lastName",
    "email",
    "directPhone",
    "mobilePhone",
    "title",
    "department",
];

/// The problems found, by field, in the order first found (a later problem
/// of the same field replaces the message, as `problems[label] = …` does).
#[derive(Default)]
struct Problems(Vec<(String, String)>);

impl Problems {
    fn set(&mut self, key: &str, message: String) {
        if let Some(entry) = self.0.iter_mut().find(|(k, _)| k == key) {
            entry.1 = message;
        } else {
            self.0.push((key.to_owned(), message));
        }
    }

    fn to_json(&self) -> Value {
        let mut fields = Map::new();
        for (key, message) in &self.0 {
            fields.insert(key.clone(), Value::String(message.clone()));
        }
        Value::Object(fields)
    }
}

/// `toIntegration(row, createdBy)`.
fn to_integration(row: &Value, created_by: &Value) -> Value {
    json!({
        "id": row["id"],
        "formId": row["formId"],
        "kind": row["kind"],
        "enabled": row["enabled"],
        "config": row["config"],
        "createdBy": created_by,
        "lastError": row["lastError"],
        "createdAt": row["createdAt"],
        "updatedAt": row["updatedAt"],
    })
}

/// `listIntegrations(ctx, formId)`: oldest first.
pub(crate) async fn list_integrations(ctx: &Ctx, form_id: &str) -> FormsResult<Vec<Value>> {
    let rows = all(
        &ctx.db,
        sqlx::query_scalar(
            "select to_jsonb(i) from form_integrations i where form_id = $1 order by created_at asc",
        )
        .bind(form_id),
    )
    .await?;
    let ids: Vec<String> = rows
        .iter()
        .map(|row| text(row, "createdByUserId").to_owned())
        .collect();
    let refs = member_refs(&ctx.db, &ids).await?;
    Ok(rows
        .iter()
        .map(|row| {
            let user = text(row, "createdByUserId");
            to_integration(
                row,
                &refs.get(user).cloned().unwrap_or_else(|| bare_ref(user)),
            )
        })
        .collect())
}

/// `getIntegration(ctx, formId, id)`: 404 `Integration not found`.
pub(crate) async fn get_integration(ctx: &Ctx, form_id: &str, id: &str) -> FormsResult<Value> {
    one(
        &ctx.db,
        sqlx::query_scalar(
            "select to_jsonb(i) from form_integrations i where id = $1 and form_id = $2 limit 1",
        )
        .bind(id)
        .bind(form_id),
    )
    .await?
    .ok_or_else(|| forms_error(404, "NOT_FOUND", "Integration not found"))
}

/// `presentIntegration(ctx, row)`.
pub(crate) async fn present_integration(ctx: &Ctx, row: &Value) -> FormsResult<Value> {
    let user = text(row, "createdByUserId").to_owned();
    let mut refs = member_refs(&ctx.db, std::slice::from_ref(&user)).await?;
    Ok(to_integration(
        row,
        &refs.remove(&user).unwrap_or_else(|| bare_ref(&user)),
    ))
}

// ── Checking the settings against the form ───────────────────────────────────

fn variable_names(definition: &FormDefinition) -> Vec<String> {
    definition
        .variables
        .iter()
        .filter_map(|variable| {
            serde_json::to_value(variable)
                .ok()
                .and_then(|value| value["name"].as_str().map(str::to_owned))
        })
        .collect()
}

/// `checkTemplate(label, text, definition, problems)`.
fn check_template(
    label: &str,
    template: &str,
    definition: &FormDefinition,
    problems: &mut Problems,
) {
    for (kind, name) in recall_tokens(template) {
        match kind {
            RecallKind::Field if find_field_by_ref(definition, &name).is_none() => {
                problems.set(
                    label,
                    format!("{{{{field:{name}}}}} is not a question of this form"),
                );
            }
            RecallKind::Hidden if !definition.hidden.iter().any(|h| h.name == name) => {
                problems.set(
                    label,
                    format!("{{{{hidden:{name}}}}} is not a hidden field of this form"),
                );
            }
            RecallKind::Var if name != "score" && !variable_names(definition).contains(&name) => {
                problems.set(
                    label,
                    format!("{{{{var:{name}}}}} is not a variable of this form"),
                );
            }
            _ => {}
        }
    }
}

/// `checkFieldType(label, definition, blockId, types, problems)`.
fn check_field_type(
    label: &str,
    definition: &FormDefinition,
    block_id: Option<&str>,
    types: &[&str],
    problems: &mut Problems,
) {
    let Some(block_id) = block_id else {
        return;
    };
    match find_field(definition, block_id) {
        None => problems.set(label, "That question is not in this form".to_owned()),
        Some(field) if !types.contains(&field.kind.type_name()) => {
            problems.set(label, format!("Use a {} question", types.join(" or ")));
        }
        Some(_) => {}
    }
}

async fn custom_field_ids(db: &PgPool, entity: &str) -> FormsResult<Vec<String>> {
    Ok(
        weldsuite_core_domain::custom_field_values::definitions(db, entity)
            .await?
            .into_iter()
            .map(|definition| definition.id)
            .collect(),
    )
}

async fn check_crm(
    ctx: &Ctx,
    config: &CrmConfig,
    definition: &FormDefinition,
    problems: &mut Problems,
) -> FormsResult<()> {
    check_field_type(
        "emailFieldId",
        definition,
        Some(&config.email_field_id),
        &["email", "contact_info"],
        problems,
    );
    if config.create_company {
        check_field_type(
            "companyFieldId",
            definition,
            config.company_field_id.as_deref(),
            &["short_text", "contact_info"],
            problems,
        );
    }
    let custom = if config
        .mappings
        .iter()
        .any(|m| m.crm_field.starts_with("custom:"))
    {
        let entity = if config.target == "lead" {
            "lead"
        } else {
            "person"
        };
        custom_field_ids(&ctx.db, entity).await?
    } else {
        Vec::new()
    };
    for (i, mapping) in config.mappings.iter().enumerate() {
        let key = format!("mappings.{i}");
        let Some(field) = find_field(definition, &mapping.block_id) else {
            problems.set(&key, "That question is not in this form".to_owned());
            continue;
        };
        if let Some(part) = &mapping.part
            && !(field.kind.is_composite() && field.parts().iter().any(|p| p.name == part))
        {
            problems.set(&key, format!("{part} is not a part of that question"));
        }
        if let Some(id) = mapping.crm_field.strip_prefix("custom:") {
            if !custom.iter().any(|known| known == id) {
                problems.set(&key, "That custom field does not exist".to_owned());
            }
        } else if !CRM_STANDARD_FIELD_KEYS.contains(&mapping.crm_field.as_str()) {
            problems.set(
                &key,
                format!("{} is not a field a response can fill", mapping.crm_field),
            );
        }
    }
    if let Some(list_id) = &config.list_id {
        let kind: Option<String> = sqlx::query_scalar(
            "select kind from lists where id = $1 and deleted_at is null limit 1",
        )
        .bind(list_id)
        .fetch_optional(&ctx.db)
        .await?;
        if kind.as_deref() != Some("person") {
            problems.set("listId", "Choose a list of people".to_owned());
        }
    }
    Ok(())
}

async fn check_desk(
    ctx: &Ctx,
    config: &DeskConfig,
    definition: &FormDefinition,
    problems: &mut Problems,
) -> FormsResult<()> {
    check_field_type(
        "requesterFieldId",
        definition,
        config.requester_field_id.as_deref(),
        &["email", "contact_info"],
        problems,
    );
    check_template("subject", &config.subject, definition, problems);
    check_template("body", &config.body, definition, problems);
    if let Some(department_id) = &config.department_id {
        let active: Option<Option<bool>> = sqlx::query_scalar(
            "select is_active from helpdesk_departments where id = $1 and deleted_at is null limit 1",
        )
        .bind(department_id)
        .fetch_optional(&ctx.db)
        .await?;
        if matches!(active, None | Some(Some(false))) {
            problems.set(
                "departmentId",
                "That team does not exist or is inactive".to_owned(),
            );
        }
    }
    Ok(())
}

async fn check_flow(
    ctx: &Ctx,
    config: &FlowConfig,
    definition: &FormDefinition,
    problems: &mut Problems,
) -> FormsResult<()> {
    check_field_type(
        "dueDateFieldId",
        definition,
        config.due_date_field_id.as_deref(),
        &["date"],
        problems,
    );
    check_template("title", &config.title, definition, problems);
    check_template("description", &config.description, definition, problems);
    if let Some(project_id) = &config.project_id {
        let found: Option<String> = sqlx::query_scalar(
            "select id from projects where id = $1 and deleted_at is null limit 1",
        )
        .bind(project_id)
        .fetch_optional(&ctx.db)
        .await?;
        if found.is_none() {
            problems.set("projectId", "That project does not exist".to_owned());
        }
    }
    if let Some(user_id) = &config.assignee_user_id {
        let found: Option<String> = sqlx::query_scalar(
            "select id from workspace_members where user_id = $1 and deleted_at is null limit 1",
        )
        .bind(user_id)
        .fetch_optional(&ctx.db)
        .await?;
        if found.is_none() {
            problems.set(
                "assigneeUserId",
                "That person is not a member of this workspace".to_owned(),
            );
        }
    }
    Ok(())
}

/// `checkConfig(ctx, kind, raw, definition)`: the settings parsed with their
/// kind's schema and checked against the draft definition; 422
/// `INVALID_CONFIG` with `details.fields`.
pub(crate) async fn check_config(
    ctx: &Ctx,
    kind: &str,
    raw: &Value,
    definition: &FormDefinition,
) -> FormsResult<Value> {
    let (config, output) = match parse_config(kind, raw) {
        Ok(parsed) => parsed,
        Err(issues) => {
            let mut fields = Problems::default();
            for (path, message) in issues {
                let key = if path.is_empty() {
                    "config".to_owned()
                } else {
                    path
                };
                fields.set(&key, message);
            }
            return Err(forms_error_with(
                422,
                "INVALID_CONFIG",
                "The settings of this integration are not valid.",
                json!({ "fields": fields.to_json() }),
            ));
        }
    };
    let mut problems = Problems::default();
    match &config {
        IntegrationConfig::Crm(config) => check_crm(ctx, config, definition, &mut problems).await?,
        IntegrationConfig::Desk(config) => {
            check_desk(ctx, config, definition, &mut problems).await?;
        }
        IntegrationConfig::Flow(config) => {
            check_flow(ctx, config, definition, &mut problems).await?;
        }
    }
    if !problems.0.is_empty() {
        return Err(forms_error_with(
            422,
            "INVALID_CONFIG",
            "The settings of this integration do not fit this form.",
            json!({ "fields": problems.to_json() }),
        ));
    }
    Ok(output)
}

/// The form's draft definition, as the worker hands it to `checkConfig`.
fn draft_definition(form: &Value) -> FormsResult<FormDefinition> {
    FormDefinition::parse(&form["definition"])
        .map_err(|_| crate::common::Fail::Internal("forms: the draft does not parse".to_owned()))
}

// ── Writes ───────────────────────────────────────────────────────────────────

/// `createIntegration(ctx, form, userId, input)`.
pub(crate) async fn create_integration(
    ctx: &Ctx,
    form: &Value,
    user_id: &str,
    kind: &str,
    enabled: bool,
    raw_config: &Value,
) -> FormsResult<Value> {
    let existing: i64 =
        sqlx::query_scalar("select count(*) from form_integrations where form_id = $1")
            .bind(text(form, "id"))
            .fetch_one(&ctx.db)
            .await?;
    if usize::try_from(existing).unwrap_or(usize::MAX) >= MAX_INTEGRATIONS {
        return Err(forms_error(
            422,
            "LIMIT_REACHED",
            format!("A form can have at most {MAX_INTEGRATIONS} integrations."),
        ));
    }
    let config = check_config(ctx, kind, raw_config, &draft_definition(form)?).await?;
    let now = iso(ctx.now_ms());
    let row = one(
        &ctx.db,
        sqlx::query_scalar(
            "insert into form_integrations (id, form_id, kind, config, enabled, created_by_user_id, created_at, updated_at) \
             values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz) returning to_jsonb(form_integrations.*)",
        )
        .bind(weldsuite_kit::generate_id("fig"))
        .bind(text(form, "id"))
        .bind(kind)
        .bind(&config)
        .bind(enabled)
        .bind(user_id)
        .bind(&now),
    )
    .await?;
    row.ok_or_else(|| {
        crate::common::Fail::Internal("forms: the integration insert returned nothing".to_owned())
    })
}

/// `updateIntegration(ctx, form, row, userId, input)`.
pub(crate) async fn update_integration(
    ctx: &Ctx,
    form: &Value,
    row: &Value,
    user_id: &str,
    enabled: Option<bool>,
    raw_config: Option<&Value>,
) -> FormsResult<Value> {
    let config = match raw_config {
        Some(raw) => {
            Some(check_config(ctx, text(row, "kind"), raw, &draft_definition(form)?).await?)
        }
        None => None,
    };
    let now = iso(ctx.now_ms());
    // Whoever decides what it writes writes it with their own access; the old error is no longer true.
    let updated = one(
        &ctx.db,
        sqlx::query_scalar(
            "update form_integrations set updated_at = $2::timestamptz, \
             enabled = coalesce($3, enabled), \
             config = coalesce($4, config), \
             created_by_user_id = case when $4::jsonb is null then created_by_user_id else $5 end, \
             last_error = case when $4::jsonb is null then last_error else null end \
             where id = $1 returning to_jsonb(form_integrations.*)",
        )
        .bind(text(row, "id"))
        .bind(&now)
        .bind(enabled)
        .bind(config)
        .bind(user_id),
    )
    .await?;
    updated.ok_or_else(|| {
        crate::common::Fail::Internal("forms: the integration update returned nothing".to_owned())
    })
}

/// `deleteIntegration(ctx, row)`.
pub(crate) async fn delete_integration(ctx: &Ctx, row: &Value) -> FormsResult<()> {
    sqlx::query("delete from form_integrations where id = $1")
        .bind(text(row, "id"))
        .execute(&ctx.db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn problems_keep_the_first_position_and_the_last_message() {
        let mut problems = Problems::default();
        problems.set("subject", "a".to_owned());
        problems.set("departmentId", "b".to_owned());
        problems.set("subject", "c".to_owned());
        assert_eq!(
            problems.0,
            vec![
                ("subject".to_owned(), "c".to_owned()),
                ("departmentId".to_owned(), "b".to_owned())
            ]
        );
    }
}
