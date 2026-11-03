//! GitHub Projects (v2) over GraphQL and issues over REST
//! (`github/projects.ts`), plus the Status option ↔ stage mapping.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use super::auth::USER_AGENT;
use super::queries;

const GITHUB_GRAPHQL_URL: &str = "https://api.github.com/graphql";

fn github_request(method: &str, url: String, token: &str, body: &Value) -> HttpRequest {
    HttpRequest {
        method: method.to_owned(),
        url,
        headers: vec![
            (
                "Accept".to_owned(),
                "application/vnd.github+json".to_owned(),
            ),
            ("X-GitHub-Api-Version".to_owned(), "2022-11-28".to_owned()),
            ("User-Agent".to_owned(), USER_AGENT.to_owned()),
            ("Authorization".to_owned(), format!("Bearer {token}")),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ],
        body: Some(body.to_string().into_bytes()),
    }
}

/// `githubGraphql(token, query, variables)`: the response's `data`.
async fn graphql(
    http: Option<&OutboundHttp>,
    token: &str,
    query: &str,
    variables: Value,
) -> Result<Value, String> {
    let http = http.ok_or("fetch failed")?;
    let body = json!({ "query": query, "variables": variables });
    let response = http
        .send(github_request(
            "POST",
            GITHUB_GRAPHQL_URL.to_owned(),
            token,
            &body,
        ))
        .await
        .map_err(|e| e.to_string())?;
    if response.status == 429 {
        return Err("GitHub secondary rate limit (429) on GraphQL".to_owned());
    }
    if !response.ok() {
        return Err(format!(
            "GitHub GraphQL request failed ({}): {}",
            response.status,
            response.text()
        ));
    }
    let json = response.json();
    if let Some(errors) = json
        .get("errors")
        .and_then(Value::as_array)
        .filter(|e| !e.is_empty())
    {
        let messages: Vec<String> = errors
            .iter()
            .map(|e| match e.get("message") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
                None => "undefined".to_owned(),
            })
            .collect();
        return Err(format!("GitHub GraphQL errors: {}", messages.join("; ")));
    }
    match json.get("data") {
        Some(data) if !data.is_null() && data != &Value::Bool(false) => Ok(data.clone()),
        _ => Err("GitHub GraphQL response missing data".to_owned()),
    }
}

/// `ProjectItemIssue`: one Project item that is an issue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItemIssue {
    pub item_node_id: String,
    pub status_option_id: Option<String>,
    pub status_option_name: Option<String>,
    pub issue_node_id: String,
    pub number: i64,
    pub title: String,
    pub body: Option<String>,
    pub state: String,
    pub state_reason: Option<String>,
    pub updated_at: String,
    pub url: String,
    pub labels: Vec<String>,
    pub repo_id: Option<i64>,
    pub repo_full_name: Option<String>,
}

/// One page of a Project's items.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemsPage {
    pub items: Vec<ProjectItemIssue>,
    pub has_next_page: bool,
    pub end_cursor: Option<String>,
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

/// `fetchProjectItemsPage(token, projectNodeId, cursor)`.
pub async fn fetch_project_items_page(
    http: Option<&OutboundHttp>,
    token: &str,
    project_node_id: &str,
    cursor: Option<&str>,
) -> Result<ItemsPage, String> {
    let data = graphql(
        http,
        token,
        queries::PROJECT_ITEMS_QUERY,
        json!({ "id": project_node_id, "cursor": cursor }),
    )
    .await?;
    let Some(connection) = data
        .get("node")
        .and_then(|node| node.get("items"))
        .filter(|items| items.is_object())
    else {
        tracing::info!(
            "[GithubProjectSync] fetchProjectItemsPage: node is NULL for project {project_node_id} (App can't read this Project — check org Projects permission / project ownership)"
        );
        return Ok(ItemsPage {
            items: Vec::new(),
            has_next_page: false,
            end_cursor: None,
        });
    };
    let nodes = connection
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut items = Vec::new();
    for node in &nodes {
        let content = node.get("content").filter(|c| c.is_object());
        let Some(content) = content else { continue };
        if content.get("__typename").and_then(Value::as_str) != Some("Issue") {
            continue;
        }
        let (Some(id), Some(number)) = (
            content.get("id").filter(|v| !v.is_null()),
            content.get("number").and_then(Value::as_i64),
        ) else {
            continue;
        };
        let field = node.get("fieldValueByName").filter(|f| f.is_object());
        let repository = content.get("repository").filter(|r| r.is_object());
        items.push(ProjectItemIssue {
            item_node_id: text(node.get("id")).unwrap_or_default(),
            status_option_id: field.and_then(|f| text(f.get("optionId"))),
            status_option_name: field.and_then(|f| text(f.get("name"))),
            issue_node_id: id.as_str().map_or_else(|| id.to_string(), str::to_owned),
            number,
            title: text(content.get("title")).unwrap_or_default(),
            body: text(content.get("body")),
            state: text(content.get("state")).unwrap_or_else(|| "OPEN".to_owned()),
            state_reason: text(content.get("stateReason")),
            updated_at: text(content.get("updatedAt"))
                .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_owned()),
            url: text(content.get("url")).unwrap_or_default(),
            labels: content
                .get("labels")
                .and_then(|l| l.get("nodes"))
                .and_then(Value::as_array)
                .map(|nodes| {
                    nodes
                        .iter()
                        .map(|l| text(l.get("name")).unwrap_or_default())
                        .collect()
                })
                .unwrap_or_default(),
            repo_id: repository
                .and_then(|r| r.get("databaseId"))
                .and_then(Value::as_i64),
            repo_full_name: repository.and_then(|r| text(r.get("nameWithOwner"))),
        });
    }
    let page_info = connection.get("pageInfo");
    Ok(ItemsPage {
        items,
        has_next_page: page_info
            .and_then(|p| p.get("hasNextPage"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        end_cursor: page_info.and_then(|p| text(p.get("endCursor"))),
    })
}

/// `updateProjectItemStatus(...)`: the item's Status single-select.
pub async fn update_project_item_status(
    http: Option<&OutboundHttp>,
    token: &str,
    project_node_id: &str,
    item_node_id: &str,
    status_field_id: &str,
    option_id: &str,
) -> Result<(), String> {
    graphql(
        http,
        token,
        queries::UPDATE_ITEM_STATUS_MUTATION,
        json!({
            "projectId": project_node_id,
            "itemId": item_node_id,
            "fieldId": status_field_id,
            "optionId": option_id,
        }),
    )
    .await
    .map(|_| ())
}

/// `addIssueToProject(...)`: the new item's node id.
pub async fn add_issue_to_project(
    http: Option<&OutboundHttp>,
    token: &str,
    project_node_id: &str,
    issue_node_id: &str,
) -> Result<String, String> {
    let data = graphql(
        http,
        token,
        queries::ADD_ITEM_MUTATION,
        json!({ "projectId": project_node_id, "contentId": issue_node_id }),
    )
    .await?;
    data.get("addProjectV2ItemById")
        .and_then(|r| r.get("item"))
        .and_then(|i| i.get("id"))
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "addProjectV2ItemById returned no item id".to_owned())
}

/// The REST issue `createIssue` answers with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RestIssue {
    pub number: i64,
    pub node_id: String,
    pub updated_at: String,
}

/// `createIssue(token, repoFullName, input)`.
pub async fn create_issue(
    http: Option<&OutboundHttp>,
    token: &str,
    repo_full_name: &str,
    title: &str,
    body: Option<&str>,
    labels: Option<&[String]>,
) -> Result<RestIssue, String> {
    let mut payload = Map::new();
    payload.insert("title".to_owned(), json!(title));
    if let Some(body) = body.filter(|b| !b.is_empty()) {
        payload.insert("body".to_owned(), json!(body));
    }
    if let Some(labels) = labels.filter(|l| !l.is_empty()) {
        payload.insert("labels".to_owned(), json!(labels));
    }
    let http = http.ok_or("fetch failed")?;
    let response = http
        .send(github_request(
            "POST",
            format!("https://api.github.com/repos/{repo_full_name}/issues"),
            token,
            &Value::Object(payload),
        ))
        .await
        .map_err(|e| e.to_string())?;
    if response.status == 429 {
        return Err("GitHub secondary rate limit (429)".to_owned());
    }
    if !response.ok() {
        return Err(format!(
            "GitHub REST error ({}): {}",
            response.status,
            response.text()
        ));
    }
    let json = response.json();
    Ok(RestIssue {
        number: json
            .get("number")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        node_id: text(json.get("node_id")).unwrap_or_default(),
        updated_at: text(json.get("updated_at")).unwrap_or_default(),
    })
}

fn now_iso() -> String {
    weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc())
}

/// The `updatedAt` a mutation answers with, or now.
fn updated_at(data: &Value, mutation: &str) -> String {
    data.get(mutation)
        .and_then(|r| r.get("issue"))
        .and_then(|i| i.get("updatedAt"))
        .and_then(Value::as_str)
        .map_or_else(now_iso, str::to_owned)
}

/// `updateIssueFields(token, issueNodeId, { title, body })`.
pub async fn update_issue_fields(
    http: Option<&OutboundHttp>,
    token: &str,
    issue_node_id: &str,
    title: Option<&str>,
    body: Option<&str>,
) -> Result<String, String> {
    let data = graphql(
        http,
        token,
        queries::UPDATE_ISSUE_MUTATION,
        json!({ "id": issue_node_id, "title": title, "body": body }),
    )
    .await?;
    Ok(updated_at(&data, "updateIssue"))
}

/// `closeIssue(token, issueNodeId, reason)`.
pub async fn close_issue(
    http: Option<&OutboundHttp>,
    token: &str,
    issue_node_id: &str,
    reason: &str,
) -> Result<String, String> {
    let data = graphql(
        http,
        token,
        queries::CLOSE_ISSUE_MUTATION,
        json!({ "id": issue_node_id, "reason": reason }),
    )
    .await?;
    Ok(updated_at(&data, "closeIssue"))
}

/// `reopenIssue(token, issueNodeId)`.
pub async fn reopen_issue(
    http: Option<&OutboundHttp>,
    token: &str,
    issue_node_id: &str,
) -> Result<String, String> {
    let data = graphql(
        http,
        token,
        queries::REOPEN_ISSUE_MUTATION,
        json!({ "id": issue_node_id }),
    )
    .await?;
    Ok(updated_at(&data, "reopenIssue"))
}

/// `StatusOptionMapping`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOptionMapping {
    #[serde(default)]
    pub github_option_id: Option<String>,
    #[serde(default)]
    pub github_option_name: Option<String>,
    #[serde(default)]
    pub stage_id: Option<String>,
}

/// The link's `status_option_map` jsonb: entries it cannot read are left out.
pub fn status_option_map(value: Option<&Value>) -> Option<Vec<StatusOptionMapping>> {
    let entries = value?.as_array()?;
    Some(
        entries
            .iter()
            .filter_map(|entry| serde_json::from_value(entry.clone()).ok())
            .collect(),
    )
}

/// `stageIdForStatusOption(map, optionId)`.
pub fn stage_id_for_status_option(
    map: Option<&[StatusOptionMapping]>,
    option_id: Option<&str>,
) -> Option<String> {
    let (map, option_id) = (map?, option_id.filter(|o| !o.is_empty())?);
    map.iter()
        .find(|m| m.github_option_id.as_deref() == Some(option_id))?
        .stage_id
        .clone()
}

/// `statusOptionForStageId(map, stageId)`.
pub fn status_option_for_stage_id(
    map: Option<&[StatusOptionMapping]>,
    stage_id: Option<&str>,
) -> Option<String> {
    let (map, stage_id) = (map?, stage_id.filter(|s| !s.is_empty())?);
    map.iter()
        .find(|m| m.stage_id.as_deref() == Some(stage_id))?
        .github_option_id
        .clone()
}

/// `taskStatusFromIssueState(state, stateReason)`.
pub fn task_status_from_issue_state(state: &str, state_reason: Option<&str>) -> &'static str {
    if state == "OPEN" {
        "todo"
    } else if state_reason == Some("NOT_PLANNED") {
        "cancelled"
    } else {
        "done"
    }
}
