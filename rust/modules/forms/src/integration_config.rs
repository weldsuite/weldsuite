//! The settings of an integration, per kind
//! (`crmIntegrationConfigSchema`, `deskIntegrationConfigSchema`,
//! `flowIntegrationConfigSchema` in `@weldsuite/app-api-client/schemas/weldforms`):
//! read as Zod reads them, with its defaults, its stripping of unknown keys
//! and its issues (path and message), so a refusal says the same as the
//! worker's and the stored settings are Zod's output.

use serde_json::{Map, Value};
use weldsuite_kit::validation::{Field, Issues, Presence};

/// One answer copied onto the CRM record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CrmMapping {
    pub block_id: String,
    pub part: Option<String>,
    /// A standard field key, or `custom:<customFieldId>`.
    pub crm_field: String,
    /// `overwrite` or `fill_empty`.
    pub mode: String,
}

/// `CrmIntegrationConfig`.
#[allow(
    clippy::struct_excessive_bools,
    reason = "one flag per setting, as the schema"
)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CrmConfig {
    /// `person` or `lead`.
    pub target: String,
    pub email_field_id: String,
    pub create_company: bool,
    pub company_field_id: Option<String>,
    pub mappings: Vec<CrmMapping>,
    pub list_id: Option<String>,
    pub tags: Vec<String>,
    pub log_activity: bool,
}

/// `DeskIntegrationConfig`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeskConfig {
    pub subject: String,
    pub body: String,
    pub requester_field_id: Option<String>,
    /// `low`, `normal`, `high` or `urgent`.
    pub priority: String,
    pub tags: Vec<String>,
    pub department_id: Option<String>,
    pub attach_files: bool,
}

/// `FlowIntegrationConfig`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FlowConfig {
    pub title: String,
    pub description: String,
    /// `null`: a personal task of the assignee.
    pub project_id: Option<String>,
    pub assignee_user_id: Option<String>,
    pub due_date_field_id: Option<String>,
    pub labels: Vec<String>,
    pub attach_files: bool,
}

/// The settings of one integration, by kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IntegrationConfig {
    Crm(CrmConfig),
    Desk(DeskConfig),
    Flow(FlowConfig),
}

/// `recallTemplate`: `z.string().max(5000)`.
const TEMPLATE_MAX: usize = 5000;
const DEFAULT_TITLE: &str = "{{form:title}} #{{response:number}}";

/// The field's value, or `default` when it was left out (`.default(x)`).
fn or_default<T>(field: Field<T>, default: T) -> T {
    match field {
        Field::Set(value) => value,
        Field::Absent | Field::Null => default,
    }
}

/// `z.array(z.string().max(100)).max(20).default([])`.
fn strings(issues: &mut Issues, body: &Map<String, Value>, key: &str) -> Vec<String> {
    let list = issues.list(
        body,
        key,
        Presence::Optional,
        None,
        Some(20),
        |issues, item| {
            issues.item_text(
                item,
                weldsuite_kit::validation::Text::length(None, Some(100)),
            )
        },
    );
    or_default(list, Vec::new())
}

fn optional_text(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    max: usize,
) -> Option<String> {
    issues
        .text(body, key, Presence::Optional, None, Some(max))
        .into_option()
}

pub(crate) fn read_crm(issues: &mut Issues, body: &Map<String, Value>) -> CrmConfig {
    let target = or_default(
        issues.choice(body, "target", Presence::Optional, &["person", "lead"]),
        "person".to_owned(),
    );
    let email_field_id = issues
        .text(body, "emailFieldId", Presence::Required, None, Some(30))
        .into_option()
        .unwrap_or_default();
    let create_company = or_default(
        issues.boolean(body, "createCompany", Presence::Optional),
        false,
    );
    let company_field_id = optional_text(issues, body, "companyFieldId", 30);
    let mappings = issues.list(
        body,
        "mappings",
        Presence::Optional,
        None,
        Some(100),
        |issues, item| {
            let fields = issues.object(item)?;
            let block_id = issues
                .text(fields, "blockId", Presence::Required, None, Some(30))
                .into_option();
            let part = optional_text(issues, fields, "part", 30);
            let crm_field = issues
                .text(fields, "crmField", Presence::Required, None, Some(100))
                .into_option();
            let mode = or_default(
                issues.choice(
                    fields,
                    "mode",
                    Presence::Optional,
                    &["overwrite", "fill_empty"],
                ),
                "fill_empty".to_owned(),
            );
            Some(CrmMapping {
                block_id: block_id?,
                part,
                crm_field: crm_field?,
                mode,
            })
        },
    );
    let mappings = or_default(mappings, Vec::new());
    let list_id = optional_text(issues, body, "listId", 30);
    let tags = strings(issues, body, "tags");
    let log_activity = or_default(
        issues.boolean(body, "logActivity", Presence::Optional),
        true,
    );
    CrmConfig {
        target,
        email_field_id,
        create_company,
        company_field_id,
        mappings,
        list_id,
        tags,
        log_activity,
    }
}

pub(crate) fn read_desk(issues: &mut Issues, body: &Map<String, Value>) -> DeskConfig {
    let department_id = optional_text(issues, body, "departmentId", 30);
    let subject = or_default(
        issues.text(
            body,
            "subject",
            Presence::Optional,
            None,
            Some(TEMPLATE_MAX),
        ),
        DEFAULT_TITLE.to_owned(),
    );
    let text_body = or_default(
        issues.text(body, "body", Presence::Optional, None, Some(TEMPLATE_MAX)),
        String::new(),
    );
    let requester_field_id = optional_text(issues, body, "requesterFieldId", 30);
    let priority = or_default(
        issues.choice(
            body,
            "priority",
            Presence::Optional,
            &["low", "normal", "high", "urgent"],
        ),
        "normal".to_owned(),
    );
    let tags = strings(issues, body, "tags");
    let attach_files = or_default(
        issues.boolean(body, "attachFiles", Presence::Optional),
        true,
    );
    DeskConfig {
        subject,
        body: text_body,
        requester_field_id,
        priority,
        tags,
        department_id,
        attach_files,
    }
}

pub(crate) fn read_flow(issues: &mut Issues, body: &Map<String, Value>) -> FlowConfig {
    let project_id = issues
        .text(body, "projectId", Presence::Nullish, None, Some(30))
        .into_option();
    let title = or_default(
        issues.text(body, "title", Presence::Optional, None, Some(TEMPLATE_MAX)),
        DEFAULT_TITLE.to_owned(),
    );
    let description = or_default(
        issues.text(
            body,
            "description",
            Presence::Optional,
            None,
            Some(TEMPLATE_MAX),
        ),
        String::new(),
    );
    let assignee_user_id = optional_text(issues, body, "assigneeUserId", 255);
    let due_date_field_id = optional_text(issues, body, "dueDateFieldId", 30);
    let labels = strings(issues, body, "labels");
    let attach_files = or_default(
        issues.boolean(body, "attachFiles", Presence::Optional),
        true,
    );
    FlowConfig {
        title,
        description,
        project_id,
        assignee_user_id,
        due_date_field_id,
        labels,
        attach_files,
    }
}

fn put(out: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    out.insert(key.to_owned(), value.into());
}

fn put_some(out: &mut Map<String, Value>, key: &str, value: Option<&String>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), Value::String(value.clone()));
    }
}

impl CrmConfig {
    /// Zod's output, in the schema's key order.
    pub(crate) fn to_json(&self) -> Value {
        let mut out = Map::new();
        put(&mut out, "target", self.target.as_str());
        put(&mut out, "emailFieldId", self.email_field_id.as_str());
        put(&mut out, "createCompany", self.create_company);
        put_some(&mut out, "companyFieldId", self.company_field_id.as_ref());
        let mappings: Vec<Value> = self
            .mappings
            .iter()
            .map(|m| {
                let mut item = Map::new();
                put(&mut item, "blockId", m.block_id.as_str());
                put_some(&mut item, "part", m.part.as_ref());
                put(&mut item, "crmField", m.crm_field.as_str());
                put(&mut item, "mode", m.mode.as_str());
                Value::Object(item)
            })
            .collect();
        put(&mut out, "mappings", mappings);
        put_some(&mut out, "listId", self.list_id.as_ref());
        put(&mut out, "tags", self.tags.clone());
        put(&mut out, "logActivity", self.log_activity);
        Value::Object(out)
    }
}

impl DeskConfig {
    /// Zod's output, in the schema's key order.
    pub(crate) fn to_json(&self) -> Value {
        let mut out = Map::new();
        put_some(&mut out, "departmentId", self.department_id.as_ref());
        put(&mut out, "subject", self.subject.as_str());
        put(&mut out, "body", self.body.as_str());
        put_some(
            &mut out,
            "requesterFieldId",
            self.requester_field_id.as_ref(),
        );
        put(&mut out, "priority", self.priority.as_str());
        put(&mut out, "tags", self.tags.clone());
        put(&mut out, "attachFiles", self.attach_files);
        Value::Object(out)
    }
}

impl FlowConfig {
    /// Zod's output, in the schema's key order.
    pub(crate) fn to_json(&self) -> Value {
        let mut out = Map::new();
        put(
            &mut out,
            "projectId",
            self.project_id.clone().map_or(Value::Null, Value::String),
        );
        put(&mut out, "title", self.title.as_str());
        put(&mut out, "description", self.description.as_str());
        put_some(&mut out, "assigneeUserId", self.assignee_user_id.as_ref());
        put_some(&mut out, "dueDateFieldId", self.due_date_field_id.as_ref());
        put(&mut out, "labels", self.labels.clone());
        put(&mut out, "attachFiles", self.attach_files);
        Value::Object(out)
    }
}

impl IntegrationConfig {
    pub(crate) fn to_json(&self) -> Value {
        match self {
            Self::Crm(config) => config.to_json(),
            Self::Desk(config) => config.to_json(),
            Self::Flow(config) => config.to_json(),
        }
    }
}

/// `schema.safeParse(raw)` for the integration's `kind`: the settings and
/// Zod's output, or the issues as `(path joined with '.', message)` in
/// Zod's order (a root issue has the empty path; the worker reports it as
/// `config`). An unknown kind reads as `flow`, as the worker's lookup only
/// ever sees the three.
pub(crate) fn parse_config(
    kind: &str,
    raw: &Value,
) -> Result<(IntegrationConfig, Value), Vec<(String, String)>> {
    let mut issues = Issues::default();
    let config = issues.object(raw).map(|body| match kind {
        "crm" => IntegrationConfig::Crm(read_crm(&mut issues, body)),
        "desk" => IntegrationConfig::Desk(read_desk(&mut issues, body)),
        _ => IntegrationConfig::Flow(read_flow(&mut issues, body)),
    });
    match (issues.finish(), config) {
        (Ok(()), Some(config)) => {
            let output = config.to_json();
            Ok((config, output))
        }
        (Err(invalid), _) => Err(invalid
            .issues()
            .iter()
            .map(|issue| {
                let path = issue["path"]
                    .as_array()
                    .map(|segments| {
                        segments
                            .iter()
                            .map(|s| s.as_str().map_or_else(|| s.to_string(), str::to_owned))
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                (
                    path,
                    issue["message"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect()),
        (Ok(()), None) => Err(vec![(String::new(), "Invalid input".to_owned())]),
    }
}

/// The CRM settings of a stored integration (`crmIntegrationConfigSchema.safeParse`), `None` when they no longer parse.
pub(crate) fn crm_config(raw: &Value) -> Option<CrmConfig> {
    match parse_config("crm", raw) {
        Ok((IntegrationConfig::Crm(config), _)) => Some(config),
        _ => None,
    }
}

/// The Desk settings of a stored integration, `None` when they no longer parse.
pub(crate) fn desk_config(raw: &Value) -> Option<DeskConfig> {
    match parse_config("desk", raw) {
        Ok((IntegrationConfig::Desk(config), _)) => Some(config),
        _ => None,
    }
}

/// The Flow settings of a stored integration, `None` when they no longer parse.
pub(crate) fn flow_config(raw: &Value) -> Option<FlowConfig> {
    match parse_config("flow", raw) {
        Ok((IntegrationConfig::Flow(config), _)) => Some(config),
        _ => None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn defaults_and_output_follow_zod() {
        let (config, output) =
            parse_config("crm", &json!({ "emailFieldId": "b_email", "extra": 1 })).unwrap();
        assert!(
            matches!(config, IntegrationConfig::Crm(ref c) if c.log_activity && c.target == "person")
        );
        assert_eq!(
            output,
            json!({ "target": "person", "emailFieldId": "b_email", "createCompany": false, "mappings": [], "tags": [], "logActivity": true })
        );
        let (_, flow) = parse_config("flow", &json!({})).unwrap();
        assert_eq!(
            flow,
            json!({ "projectId": null, "title": DEFAULT_TITLE, "description": "", "labels": [], "attachFiles": true })
        );
        let (_, desk) = parse_config("desk", &json!({ "priority": "high" })).unwrap();
        assert_eq!(desk["subject"], DEFAULT_TITLE);
        assert_eq!(desk["priority"], "high");
    }

    #[test]
    fn issues_follow_zod() {
        let issues = parse_config(
            "crm",
            &json!({ "mappings": [{ "blockId": 3, "crmField": "x", "mode": "nope" }], "tags": null }),
        )
        .unwrap_err();
        assert_eq!(
            issues,
            vec![
                ("emailFieldId".to_owned(), "Required".to_owned()),
                (
                    "mappings.0.blockId".to_owned(),
                    "Expected string, received number".to_owned()
                ),
                (
                    "mappings.0.mode".to_owned(),
                    "Invalid enum value. Expected 'overwrite' | 'fill_empty', received 'nope'"
                        .to_owned()
                ),
                (
                    "tags".to_owned(),
                    "Expected array, received null".to_owned()
                ),
            ]
        );
        let mappings: Vec<Value> = (0..101)
            .map(|_| json!({ "blockId": "b", "crmField": "c" }))
            .collect();
        let limits = parse_config(
            "crm",
            &json!({ "emailFieldId": "x".repeat(31), "mappings": mappings, "target": 5 }),
        )
        .unwrap_err();
        assert_eq!(
            limits,
            vec![
                (
                    "target".to_owned(),
                    "Expected 'person' | 'lead', received number".to_owned()
                ),
                (
                    "emailFieldId".to_owned(),
                    "String must contain at most 30 character(s)".to_owned()
                ),
                (
                    "mappings".to_owned(),
                    "Array must contain at most 100 element(s)".to_owned()
                ),
            ]
        );
        let root = parse_config("desk", &json!("x")).unwrap_err();
        assert_eq!(
            root,
            vec![(String::new(), "Expected object, received string".to_owned())]
        );
    }
}
