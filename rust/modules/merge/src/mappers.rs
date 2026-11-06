//! Row to DTO mappers (`services/mappers.ts`): the output shapes are the Zod
//! DTOs in `@weldsuite/app-api-client/schemas/weldmerge`.

use serde_json::{Map, Value, json};

use crate::db::{Row, col};

/// `teamDto(row, openIssueCount)`.
pub(crate) fn team_dto(row: &Row, open_issue_count: i64) -> Value {
    json!({
        "id": col(row, "id"),
        "key": col(row, "key"),
        "name": col(row, "name"),
        "description": col(row, "description"),
        "color": col(row, "color"),
        "openIssueCount": open_issue_count,
        "createdAt": col(row, "createdAt"),
        "updatedAt": col(row, "updatedAt"),
    })
}

/// `labelDto(row)`.
pub(crate) fn label_dto(row: &Row) -> Value {
    json!({
        "id": col(row, "id"),
        "teamId": col(row, "teamId"),
        "name": col(row, "name"),
        "color": col(row, "color"),
    })
}

/// `cycleDto(row, issueCount, completedIssueCount)`.
pub(crate) fn cycle_dto(row: &Row, issue_count: i64, completed_issue_count: i64) -> Value {
    json!({
        "id": col(row, "id"),
        "teamId": col(row, "teamId"),
        "number": col(row, "number"),
        "name": col(row, "name"),
        "startsAt": col(row, "startsAt"),
        "endsAt": col(row, "endsAt"),
        "issueCount": issue_count,
        "completedIssueCount": completed_issue_count,
    })
}

/// `row.labelIds ?? []`.
fn label_ids(row: &Row) -> Value {
    match row.get("labelIds") {
        None | Some(Value::Null) => json!([]),
        Some(ids) => ids.clone(),
    }
}

/// `issueDto(row, teamKey, pullRequestCount)`.
pub(crate) fn issue_dto(row: &Row, team_key: &str, pull_request_count: i64) -> Value {
    json!({
        "id": col(row, "id"),
        "teamId": col(row, "teamId"),
        "teamKey": team_key,
        "number": col(row, "number"),
        "key": format!("{team_key}-{}", col(row, "number")),
        "title": col(row, "title"),
        "description": col(row, "description"),
        "status": col(row, "status"),
        "priority": col(row, "priority"),
        "assigneeUserId": col(row, "assigneeUserId"),
        "creatorUserId": col(row, "creatorUserId"),
        "cycleId": col(row, "cycleId"),
        "parentIssueId": col(row, "parentIssueId"),
        "labelIds": label_ids(row),
        "estimate": col(row, "estimate"),
        "dueDate": col(row, "dueDate"),
        "flowProjectId": col(row, "flowProjectId"),
        "agentId": col(row, "agentId"),
        "sortOrder": col(row, "sortOrder"),
        "pullRequestCount": pull_request_count,
        "startedAt": col(row, "startedAt"),
        "completedAt": col(row, "completedAt"),
        "canceledAt": col(row, "canceledAt"),
        "createdAt": col(row, "createdAt"),
        "updatedAt": col(row, "updatedAt"),
    })
}

/// `commentDto(row)`.
pub(crate) fn comment_dto(row: &Row) -> Value {
    json!({
        "id": col(row, "id"),
        "issueId": col(row, "issueId"),
        "authorUserId": col(row, "authorUserId"),
        "body": col(row, "body"),
        "source": col(row, "source"),
        "externalAuthorLogin": col(row, "externalAuthorLogin"),
        "externalAuthorAvatarUrl": col(row, "externalAuthorAvatarUrl"),
        "createdAt": col(row, "createdAt"),
        "updatedAt": col(row, "updatedAt"),
    })
}

/// `providerAccountDto(row)`: a linked account for the member; the token and
/// its expiry never leave the backend.
pub(crate) fn provider_account_dto(row: &Row) -> Value {
    json!({
        "id": col(row, "id"),
        "provider": col(row, "provider"),
        "host": col(row, "host"),
        "login": col(row, "login"),
        "verified": !col(row, "verifiedAt").is_null(),
        "avatarUrl": col(row, "avatarUrl"),
        "displayName": col(row, "displayName"),
    })
}

/// `connectionDto(row, repositoryCount)`.
pub(crate) fn connection_dto(row: &Row, repository_count: i64) -> Value {
    json!({
        "id": col(row, "id"),
        "provider": col(row, "provider"),
        "externalAccountId": col(row, "externalAccountId"),
        "accountLogin": col(row, "accountLogin"),
        "accountType": col(row, "accountType"),
        "host": col(row, "host"),
        "status": col(row, "status"),
        "credentialsExpireAt": col(row, "credentialsExpireAt"),
        "oauthUserLogin": col(row, "oauthUserLogin"),
        "repositoryCount": repository_count,
        "createdAt": col(row, "createdAt"),
    })
}

/// `repositoryDto(row, openPullRequestCount)`.
pub(crate) fn repository_dto(row: &Row, open_pull_request_count: i64) -> Value {
    json!({
        "id": col(row, "id"),
        "connectionId": col(row, "connectionId"),
        "provider": col(row, "provider"),
        "externalId": col(row, "externalId"),
        "fullName": col(row, "fullName"),
        "defaultBranch": col(row, "defaultBranch"),
        "private": col(row, "private"),
        "url": col(row, "url"),
        "teamId": col(row, "teamId"),
        "issueSync": col(row, "issueSync"),
        "prSync": col(row, "prSync"),
        "externalProject": col(row, "externalProject"),
        "openPullRequestCount": open_pull_request_count,
        "lastSyncedAt": col(row, "lastSyncedAt"),
        "createdAt": col(row, "createdAt"),
    })
}

/// `row.x ?? []` for a jsonb list column.
fn list_column(row: &Row, key: &str) -> Value {
    match row.get(key) {
        None | Some(Value::Null) => json!([]),
        Some(items) => items.clone(),
    }
}

/// `pullRequestSummary(row, repositoryFullName)`, as an object to extend.
pub(crate) fn pull_request_summary(row: &Row, repository_full_name: &str) -> Map<String, Value> {
    let summary = json!({
        "id": col(row, "id"),
        "repositoryId": col(row, "repositoryId"),
        "repositoryFullName": repository_full_name,
        "provider": col(row, "provider"),
        "number": col(row, "number"),
        "title": col(row, "title"),
        "state": col(row, "state"),
        "draft": col(row, "draft"),
        "url": col(row, "url"),
        "authorLogin": col(row, "authorLogin"),
        "authorAvatarUrl": col(row, "authorAvatarUrl"),
        "authorUserId": col(row, "authorUserId"),
        "headRef": col(row, "headRef"),
        "baseRef": col(row, "baseRef"),
        "additions": col(row, "additions"),
        "deletions": col(row, "deletions"),
        "changedFiles": col(row, "changedFiles"),
        "checksStatus": col(row, "checksStatus"),
        "reviewDecision": col(row, "reviewDecision"),
        "requestedReviewers": list_column(row, "requestedReviewers"),
        "labels": list_column(row, "labels"),
        "providerCreatedAt": col(row, "providerCreatedAt"),
        "providerUpdatedAt": col(row, "providerUpdatedAt"),
        "mergedAt": col(row, "mergedAt"),
        "closedAt": col(row, "closedAt"),
    });
    match summary {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `issueEventData(row, teamKey, movedByPullRequestId?)`: what an issue's
/// entity event carries.
pub(crate) fn issue_event_data(
    row: &Row,
    team_key: &str,
    moved_by_pull_request_id: Option<&str>,
) -> Value {
    let mut data = json!({
        "id": col(row, "id"),
        "teamId": col(row, "teamId"),
        "key": format!("{team_key}-{}", col(row, "number")),
        "title": col(row, "title"),
        "status": col(row, "status"),
        "priority": col(row, "priority"),
        "assigneeUserId": col(row, "assigneeUserId"),
    });
    if let Some(fields) = data.as_object_mut() {
        // `...(row.agentId ? { agentId: row.agentId } : {})`
        if let Some(agent) = row
            .get("agentId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            fields.insert("agentId".to_owned(), json!(agent));
        }
        if let Some(pr) = moved_by_pull_request_id.filter(|id| !id.is_empty()) {
            fields.insert("movedByPullRequestId".to_owned(), json!(pr));
        }
    }
    data
}

/// `recordLinkDto(row)`.
pub(crate) fn record_link_dto(row: &Row) -> Value {
    json!({
        "id": col(row, "id"),
        "issueId": col(row, "issueId"),
        "recordType": col(row, "recordType"),
        "recordId": col(row, "recordId"),
        "title": col(row, "title"),
        "createdAt": col(row, "createdAt"),
    })
}

/// `recordLinkEventData(row)`: what a record link's entity event carries.
pub(crate) fn record_link_event_data(row: &Row) -> Value {
    json!({
        "id": col(row, "id"),
        "issueId": col(row, "issueId"),
        "recordType": col(row, "recordType"),
        "recordId": col(row, "recordId"),
    })
}

/// `repositoryEventData(row)`.
pub(crate) fn repository_event_data(row: &Row) -> Value {
    json!({
        "id": col(row, "id"),
        "connectionId": col(row, "connectionId"),
        "provider": col(row, "provider"),
        "fullName": col(row, "fullName"),
        "teamId": col(row, "teamId"),
    })
}

/// `connectionEventData(row)`: the provider and account login only, never
/// credentials.
pub(crate) fn connection_event_data(row: &Row) -> Value {
    json!({
        "id": col(row, "id"),
        "provider": col(row, "provider"),
        "accountLogin": col(row, "accountLogin"),
        "status": col(row, "status"),
    })
}

/// `pullRequestEventData(pr, issueIds)`.
pub(crate) fn pull_request_event_data(row: &Row, issue_ids: &[String]) -> Value {
    json!({
        "id": col(row, "id"),
        "repositoryId": col(row, "repositoryId"),
        "provider": col(row, "provider"),
        "number": col(row, "number"),
        "title": col(row, "title"),
        "state": col(row, "state"),
        "draft": col(row, "draft"),
        "url": col(row, "url"),
        "authorLogin": col(row, "authorLogin"),
        "issueIds": issue_ids,
    })
}
