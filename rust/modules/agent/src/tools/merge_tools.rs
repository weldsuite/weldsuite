//! The WeldMerge tools (`merge-tools.ts`): issues, pull requests and a draft
//! pull request an agent can open.
//!
//! The data lives in the merge module, so each tool calls its in-process
//! `agent_tool` (`weldsuite_merge::agent_tool`, the twin of merge-api's
//! `MergeInternal.agentTool`) through [`super::modules`]. The call acts for the
//! person the agent works for: the module checks that member's WeldMerge
//! permissions as they are now, on top of the agent's own grants, which decided
//! whether the tool was offered at all. The writes publish the same entity
//! events the member routes do, marked `triggeredByAgentId`.

use serde_json::{Value, json};

use super::{ToolContext, ToolError, ToolSpec, modules};

const UNAVAILABLE: &str = "WeldMerge is not available to agents here";
/// `MERGE_ISSUE_STATUSES`.
const STATUSES: [&str; 6] = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "canceled",
];

fn issue_ref() -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": 255, "description": "The issue id, or its key such as PLAT-209" })
}

fn priority() -> Value {
    json!({ "type": "integer", "minimum": 0, "maximum": 4, "description": "0 none, 1 urgent, 2 high, 3 medium, 4 low" })
}

#[allow(clippy::too_many_lines)] // one literal per tool
pub(super) fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            id: "merge.list_issues",
            name: "merge_list_issues",
            description: "List WeldMerge issues, newest first, optionally by team, status, assignee or text.",
            required_permissions: &["merge_issues:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "teamId": { "type": "string", "maxLength": 255 },
                    "status": { "type": "array", "maxItems": 6, "items": { "type": "string", "enum": STATUSES },
                        "description": "Only issues in these statuses" },
                    "assignee": { "type": "string", "maxLength": 255, "description": "A user id, \"me\" or \"none\" for unassigned" },
                    "q": { "type": "string", "maxLength": 200, "description": "Part of the title, or a key such as PLAT-209" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
                },
            }),
        },
        ToolSpec {
            id: "merge.get_issue",
            name: "merge_get_issue",
            description: "Read one WeldMerge issue with its comments, linked pull requests, sub-issues and linked records.",
            required_permissions: &["merge_issues:read"],
            parameters: json!({
                "type": "object",
                "properties": { "issue": issue_ref() },
                "required": ["issue"],
            }),
        },
        ToolSpec {
            id: "merge.create_issue",
            name: "merge_create_issue",
            description: "Create a WeldMerge issue in a team.",
            required_permissions: &["merge_issues:create"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "teamId": { "type": "string", "minLength": 1, "maxLength": 255, "description": "The WeldMerge team the issue belongs to" },
                    "title": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "description": { "type": "string", "maxLength": 100_000 },
                    "status": { "type": "string", "enum": STATUSES, "description": "Default backlog" },
                    "priority": priority(),
                    "assigneeUserId": { "type": "string", "maxLength": 255 },
                    "labelIds": { "type": "array", "maxItems": 20, "items": { "type": "string" } },
                    "dueDate": { "type": "string", "maxLength": 10, "description": "YYYY-MM-DD" },
                },
                "required": ["teamId", "title"],
            }),
        },
        ToolSpec {
            id: "merge.update_issue",
            name: "merge_update_issue",
            description: "Change a WeldMerge issue: title, description, status, priority, assignee, or hand it to an agent.",
            required_permissions: &["merge_issues:update"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "issue": issue_ref(),
                    "title": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "description": { "type": ["string", "null"], "maxLength": 100_000 },
                    "status": { "type": "string", "enum": STATUSES },
                    "priority": priority(),
                    "assigneeUserId": { "type": ["string", "null"], "maxLength": 255 },
                    "agentId": { "type": ["string", "null"], "maxLength": 30,
                        "description": "Assign the issue to a WeldAgent agent (it starts working on it); null unassigns" },
                },
                "required": ["issue"],
            }),
        },
        ToolSpec {
            id: "merge.comment_on_issue",
            name: "merge_comment_on_issue",
            description: "Add a comment to a WeldMerge issue (it is posted as the person you work for).",
            required_permissions: &["merge_issues:update"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "issue": issue_ref(),
                    "body": { "type": "string", "minLength": 1, "maxLength": 50_000 },
                },
                "required": ["issue", "body"],
            }),
        },
        ToolSpec {
            id: "merge.list_pull_requests",
            name: "merge_list_pull_requests",
            description: "List WeldMerge pull requests (open by default) across the connected repositories, with the issues they are linked to.",
            required_permissions: &["merge_pull_requests:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "view": { "type": "string", "enum": ["needs_review", "mine", "open", "merged", "closed"], "description": "Default open" },
                    "repositoryId": { "type": "string", "maxLength": 255 },
                    "teamId": { "type": "string", "maxLength": 255 },
                    "q": { "type": "string", "maxLength": 200, "description": "Part of the title or branch, or the number such as #123" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
                },
            }),
        },
        ToolSpec {
            id: "merge.get_pull_request",
            name: "merge_get_pull_request",
            description: "Read one pull request: description, branch, state and the issues linked to it.",
            required_permissions: &["merge_pull_requests:read"],
            parameters: json!({
                "type": "object",
                "properties": { "pullRequestId": { "type": "string", "minLength": 1, "maxLength": 255 } },
                "required": ["pullRequestId"],
            }),
        },
        ToolSpec {
            id: "merge.open_draft_pull_request",
            name: "merge_open_draft_pull_request",
            description: "Commit the given files to a NEW branch of a connected GitHub repository and open a DRAFT pull request for them. \
                Nothing is merged: a person reviews it and marks it ready. GitHub repositories only.",
            required_permissions: &["merge_pull_requests:review", "merge_connections:read"],
            parameters: json!({
                "type": "object",
                "properties": {
                    "repositoryId": { "type": "string", "minLength": 1, "maxLength": 255,
                        "description": "A connected GitHub repository (see merge_list_pull_requests)" },
                    "title": { "type": "string", "minLength": 1, "maxLength": 1000 },
                    "body": { "type": "string", "maxLength": 65_000 },
                    "branch": { "type": "string", "minLength": 1, "maxLength": 250,
                        "description": "The new branch to commit to, e.g. agent/plat-209-fix-tabs" },
                    "baseBranch": { "type": "string", "maxLength": 250, "description": "Default: the repository default branch" },
                    "commitMessage": { "type": "string", "minLength": 1, "maxLength": 1000 },
                    "files": { "type": "array", "minItems": 1, "maxItems": 50,
                        "description": "Files to add or replace; each is committed in full",
                        "items": { "type": "object",
                            "properties": {
                                "path": { "type": "string", "minLength": 1, "maxLength": 1000 },
                                "content": { "type": "string", "maxLength": 1_000_000, "description": "The whole new content of the file" },
                            },
                            "required": ["path", "content"] } },
                    "issueKey": { "type": "string", "maxLength": 50,
                        "description": "The WeldMerge issue this work is for (PLAT-209): linked to the pull request" },
                },
                "required": ["repositoryId", "title", "branch", "commitMessage", "files"],
            }),
        },
    ]
}

/// `call(ctx, tool, input)`: the tool's result, or merge's refusal as an error
/// the agent can read. An answer without a result is `{ ok: true }`.
pub(super) async fn execute(ctx: &ToolContext, id: &str, args: &Value) -> Result<Value, ToolError> {
    let name = specs()
        .into_iter()
        .find(|spec| spec.id == id)
        .map(|spec| spec.name)
        .ok_or_else(|| ToolError::UnknownTool(id.to_owned()))?;
    let answer = modules::call(ctx, "merge", name, None, args.clone(), UNAVAILABLE).await;
    Ok(if answer.is_null() {
        json!({ "ok": true })
    } else {
        answer
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::schema;

    fn spec(name: &str) -> ToolSpec {
        specs().into_iter().find(|s| s.name == name).unwrap()
    }

    #[test]
    fn an_issue_update_may_clear_fields_with_null() {
        let update = spec("merge_update_issue");
        let ok = schema::validate(
            &update.parameters,
            &json!({ "issue": "PLAT-1", "assigneeUserId": null, "agentId": "agt_1", "priority": 2 }),
        )
        .unwrap();
        assert_eq!(ok["assigneeUserId"], Value::Null);
        assert_eq!(ok["agentId"], "agt_1");
        assert!(
            schema::validate(&update.parameters, &json!({ "issue": "x", "priority": 5 })).is_err()
        );
        assert!(
            schema::validate(
                &update.parameters,
                &json!({ "issue": "x", "status": "open" })
            )
            .is_err()
        );
    }

    #[test]
    fn the_draft_pull_request_needs_files_and_both_grants() {
        let draft = spec("merge_open_draft_pull_request");
        assert_eq!(
            draft.required_permissions,
            &["merge_pull_requests:review", "merge_connections:read"]
        );
        assert!(schema::validate(&draft.parameters, &json!({ "repositoryId": "r", "title": "t", "branch": "b", "commitMessage": "m", "files": [] })).is_err());
        assert!(
            schema::validate(
                &draft.parameters,
                &json!({ "repositoryId": "r", "title": "t", "branch": "b", "commitMessage": "m",
            "files": [{ "path": "a.txt", "content": "x" }] })
            )
            .is_ok()
        );
    }

    #[test]
    fn issue_lists_take_statuses_as_a_list() {
        let list = spec("merge_list_issues");
        assert!(schema::validate(&list.parameters, &json!({ "status": ["todo", "done"] })).is_ok());
        assert!(schema::validate(&list.parameters, &json!({ "status": ["nope"] })).is_err());
    }
}
