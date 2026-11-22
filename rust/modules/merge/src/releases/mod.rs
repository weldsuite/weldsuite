//! Releases (`services/releases.ts`, routes `releases`): a named set of merged
//! pull requests of one repository, with notes.
//!
//! ```text
//!   GET    /releases                    → list (teamId, repositoryId, status; cursor)          merge_releases:read
//!   GET    /releases/:id                → detail: pull requests, issues, desk tickets          merge_releases:read
//!   POST   /releases                    → new draft release                                    merge_releases:manage
//!   PATCH  /releases/:id                → edit name, version, refs, notes                      merge_releases:manage
//!   DELETE /releases/:id                → soft delete                                          merge_releases:manage
//!   POST   /releases/:id/refresh        → re-read the merged pull requests (draft only)        merge_releases:manage
//!   POST   /releases/:id/generate-notes → notes written by the model, charged to the wallet    merge_releases:manage
//!   POST   /releases/:id/ship           → status shipped, `merge_release.shipped`, chat post   merge_releases:manage
//!   POST   /releases/:id/publish        → a WeldKnow page and/or an email with the notes       merge_releases:manage
//! ```
//!
//! Which pull requests a release holds (`refresh`):
//!   1. GitHub with both refs set: the compare API lists the commits; a
//!      merged mirror belongs to the release when its head commit is among
//!      them or a commit message names it (`Merge pull request #12 …`,
//!      `title (#12)`).
//!   2. Anything else (other providers, a release without refs, a compare
//!      GitHub does not know): the repository's pull requests merged since
//!      the previous shipped release (all of them, newest 200, when none).
//!
//! Events: `merge_release` created | updated | deleted | shipped.

mod notes;
mod publish;

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use sea_orm::sea_query::{Asterisk, Expr, Func, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType,
    QueryFilter, QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};
use weldsuite_schema::tenant::{
    merge_issue_pull_requests, merge_issues, merge_pull_requests, merge_record_links,
    merge_release_pull_requests, merge_releases, merge_repositories,
};

use crate::connections::find_connection;
use crate::db::{Row, col, opt_text, text};
use crate::github_client::{GithubClient, encode_uri_component};
use crate::issues::{diff_fields, hydrate_issues, limit_of};
use crate::mappers::pull_request_summary;
use crate::record_links::TitleAccess;
use crate::schemas::nothing_to_update;
use crate::teams::find_team;
use crate::{Answer, Caller, MergeState, PendingEvent, Refusal, page, publish, validate, validate_query};

pub(crate) use notes::generate_notes;
pub(crate) use publish::publish_release;

/// `MERGE_RELEASE_STATUSES`.
const RELEASE_STATUSES: [&str; 2] = ["draft", "shipped"];

/// `RELEASE_CHANGE_FIELDS`.
const RELEASE_CHANGE_FIELDS: [&str; 5] = ["name", "version", "baseRef", "headRef", "notes"];

// ── Mapping ─────────────────────────────────────────────────────────────────

/// `releaseDto(row, repositoryFullName, pullRequestCount)`.
fn release_dto(row: &Row, repository_full_name: &str, pull_request_count: i64) -> Value {
    json!({
        "id": col(row, "id"),
        "teamId": col(row, "teamId"),
        "repositoryId": col(row, "repositoryId"),
        "repositoryFullName": repository_full_name,
        "name": col(row, "name"),
        "version": col(row, "version"),
        "baseRef": col(row, "baseRef"),
        "headRef": col(row, "headRef"),
        "status": col(row, "status"),
        "notes": col(row, "notes"),
        "notesGeneratedAt": col(row, "notesGeneratedAt"),
        "knowledgePageId": col(row, "knowledgePageId"),
        "shippedAt": col(row, "shippedAt"),
        "pullRequestCount": pull_request_count,
        "createdByUserId": col(row, "createdByUserId"),
        "createdAt": col(row, "createdAt"),
        "updatedAt": col(row, "updatedAt"),
    })
}

/// `releaseEvent(release, action, extra, changes)`: the event data carries
/// no notes (they can be long).
fn release_event(
    row: &Row,
    action: &'static str,
    extra: &[(&str, Value)],
    changes: Option<Map<String, Value>>,
) -> PendingEvent {
    let mut data = json!({
        "id": col(row, "id"),
        "teamId": col(row, "teamId"),
        "repositoryId": col(row, "repositoryId"),
        "name": col(row, "name"),
        "version": col(row, "version"),
        "status": col(row, "status"),
    });
    if let Some(fields) = data.as_object_mut() {
        for (key, value) in extra {
            fields.insert((*key).to_owned(), value.clone());
        }
    }
    PendingEvent::new("merge_release", action, text(row, "id"), data).with_changes(changes)
}

/// `releaseTitle(release)`: the page title and the default email subject.
fn release_title(row: &Row) -> String {
    match opt_text(row, "version").filter(|v| !v.is_empty()) {
        Some(version) => format!("{} {version}", text(row, "name")),
        None => text(row, "name").to_owned(),
    }
}

// ── Reading ─────────────────────────────────────────────────────────────────

/// A row as Drizzle returned it: the entity's JSON (`serde_json::to_value`
/// of the model).
fn js(row: serde_json::Result<Value>) -> Result<Row, DbErr> {
    row.map_err(|error| DbErr::Json(error.to_string()))
}

/// The row a `.returning()` update answers with: none is the error
/// `fetch_one` raised (the route's 500).
fn returned(rows: Vec<merge_releases::Model>) -> Result<Row, DbErr> {
    let release = rows
        .into_iter()
        .next()
        .ok_or_else(|| DbErr::RecordNotFound("merge_releases".to_owned()))?;
    js(serde_json::to_value(release))
}

/// `findRelease(db, id)`: a live release.
pub(crate) async fn find_release(db: &PgPool, id: &str) -> Result<Option<Row>, DbErr> {
    merge_releases::Entity::find_by_id(id.to_owned())
        .filter(merge_releases::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(|release| js(serde_json::to_value(release)))
        .transpose()
}

/// `hydrateReleases(db, rows)`.
async fn hydrate_releases(db: &PgPool, rows: &[Row]) -> Result<Vec<Value>, DbErr> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut repository_ids: Vec<String> = Vec::new();
    for row in rows {
        let id = text(row, "repositoryId").to_owned();
        if !repository_ids.contains(&id) {
            repository_ids.push(id);
        }
    }
    let orm = orm(db);
    // Deleted repositories too: a release keeps its repository's name.
    let names: HashMap<String, String> = merge_repositories::Entity::find()
        .select_only()
        .columns([
            merge_repositories::Column::Id,
            merge_repositories::Column::FullName,
        ])
        .filter(merge_repositories::Column::Id.is_in(repository_ids))
        .into_tuple::<(String, String)>()
        .all(&orm)
        .await?
        .into_iter()
        .collect();
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let counts: HashMap<String, i64> = merge_release_pull_requests::Entity::find()
        .select_only()
        .column(merge_release_pull_requests::Column::ReleaseId)
        .column_as(Expr::from(Func::count(Expr::col(Asterisk))), "count")
        .filter(merge_release_pull_requests::Column::ReleaseId.is_in(ids))
        .group_by(merge_release_pull_requests::Column::ReleaseId)
        .into_tuple::<(String, i64)>()
        .all(&orm)
        .await?
        .into_iter()
        .collect();
    Ok(rows
        .iter()
        .map(|row| {
            release_dto(
                row,
                names
                    .get(text(row, "repositoryId"))
                    .map_or("", String::as_str),
                counts.get(text(row, "id")).copied().unwrap_or(0),
            )
        })
        .collect())
}

async fn one_release_dto(db: &PgPool, row: &Row) -> Result<Value, DbErr> {
    Ok(hydrate_releases(db, std::slice::from_ref(row))
        .await?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

/// What a release holds: its pull requests (with their repository's name),
/// the issues they link to and the desk tickets linked to those issues.
struct Contents {
    pull_requests: Vec<(Row, String)>,
    issues: Vec<Value>,
    tickets: Vec<Value>,
}

/// A release's pull request with its repository's name.
#[derive(FromQueryResult)]
struct ReleasePullRequest {
    #[sea_orm(nested)]
    pull_request: merge_pull_requests::Model,
    repository_full_name: String,
}

/// `releaseContents(db, releaseId)`.
async fn release_contents(db: &PgPool, release_id: &str) -> Result<Contents, DbErr> {
    let orm = orm(db);
    let in_release: RelationDef =
        merge_pull_requests::Entity::belongs_to(merge_release_pull_requests::Entity)
            .from(merge_pull_requests::Column::Id)
            .to(merge_release_pull_requests::Column::PullRequestId)
            .into();
    let repository: RelationDef = merge_pull_requests::Entity::belongs_to(merge_repositories::Entity)
        .from(merge_pull_requests::Column::RepositoryId)
        .to(merge_repositories::Column::Id)
        .into();
    let prs = merge_pull_requests::Entity::find()
        .column_as(merge_repositories::Column::FullName, "repository_full_name")
        .join(JoinType::InnerJoin, in_release)
        .join(JoinType::InnerJoin, repository)
        .filter(merge_release_pull_requests::Column::ReleaseId.eq(release_id))
        .order_by_desc(merge_pull_requests::Column::MergedAt)
        .order_by_desc(merge_pull_requests::Column::Id)
        .into_model::<ReleasePullRequest>()
        .all(&orm)
        .await?;
    let pull_requests: Vec<(Row, String)> = prs
        .into_iter()
        .map(|pr| {
            Ok((
                js(serde_json::to_value(pr.pull_request))?,
                pr.repository_full_name,
            ))
        })
        .collect::<Result<_, DbErr>>()?;
    if pull_requests.is_empty() {
        return Ok(Contents {
            pull_requests,
            issues: Vec::new(),
            tickets: Vec::new(),
        });
    }
    let pr_ids: Vec<String> = pull_requests
        .iter()
        .map(|(pr, _)| text(pr, "id").to_owned())
        .collect();
    let links: RelationDef = merge_issues::Entity::belongs_to(merge_issue_pull_requests::Entity)
        .from(merge_issues::Column::Id)
        .to(merge_issue_pull_requests::Column::IssueId)
        .into();
    let issue_rows = merge_issues::Entity::find()
        .distinct()
        .join(JoinType::InnerJoin, links)
        .filter(merge_issue_pull_requests::Column::PullRequestId.is_in(pr_ids))
        .filter(merge_issue_pull_requests::Column::DismissedAt.is_null())
        .filter(merge_issues::Column::DeletedAt.is_null())
        .all(&orm)
        .await?
        .into_iter()
        .map(|issue| js(serde_json::to_value(issue)))
        .collect::<Result<Vec<Row>, DbErr>>()?;
    let mut issues = hydrate_issues(db, &issue_rows).await?;
    issues.sort_by(|a, b| {
        a.get("key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(b.get("key").and_then(Value::as_str).unwrap_or_default())
    });
    let tickets = desk_tickets_of(db, &issues).await?;
    Ok(Contents {
        pull_requests,
        issues,
        tickets,
    })
}

/// `deskTicketsOf(db, issues)`.
async fn desk_tickets_of(db: &PgPool, issues: &[Value]) -> Result<Vec<Value>, DbErr> {
    if issues.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = issues.iter().map(|i| text(i, "id").to_owned()).collect();
    let keys: HashMap<String, String> = issues
        .iter()
        .map(|i| (text(i, "id").to_owned(), text(i, "key").to_owned()))
        .collect();
    let links = merge_record_links::Entity::find()
        .filter(merge_record_links::Column::IssueId.is_in(ids))
        .filter(merge_record_links::Column::RecordType.eq("desk_ticket"))
        .all(&orm(db))
        .await?;
    let mut tickets: Vec<(String, String, Value)> = links
        .into_iter()
        .map(|link| {
            let issue_key = keys.get(&link.issue_id).cloned().unwrap_or_default();
            let ticket = json!({
                "ticketId": &link.record_id,
                "title": link.title,
                "issueId": link.issue_id,
                "issueKey": &issue_key,
            });
            (issue_key, link.record_id, ticket)
        })
        .collect();
    tickets.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    Ok(tickets.into_iter().map(|(_, _, ticket)| ticket).collect())
}

/// `detailOf(c, row)`: `getReleaseDetail(db, row)`, with a desk ticket's
/// subject only for a caller with `tickets:read` (`withVisibleTitles`).
async fn release_detail(caller: &Caller, row: &Row) -> Result<Value, DbErr> {
    let db = &caller.db;
    let base = one_release_dto(db, row).await?;
    let mut contents = release_contents(db, text(row, "id")).await?;
    let mut access = TitleAccess::of(caller);
    for ticket in &mut contents.tickets {
        let ticket_id = text(ticket, "ticketId").to_owned();
        if ticket.get("title").is_some_and(|t| !t.is_null())
            && !access.visible("desk_ticket", &ticket_id).await?
        {
            ticket["title"] = Value::Null;
        }
    }
    let mut detail = match base {
        Value::Object(fields) => fields,
        _ => Map::new(),
    };
    detail.insert(
        "pullRequests".to_owned(),
        Value::Array(
            contents
                .pull_requests
                .iter()
                .map(|(pr, full_name)| Value::Object(pull_request_summary(pr, full_name)))
                .collect(),
        ),
    );
    detail.insert("issues".to_owned(), Value::Array(contents.issues));
    detail.insert("tickets".to_owned(), Value::Array(contents.tickets));
    Ok(Value::Object(detail))
}

/// `shippedEventData(db, row)`: the payload of `merge_release.shipped`.
async fn shipped_event_data(db: &PgPool, row: &Row) -> Result<Value, DbErr> {
    let contents = release_contents(db, text(row, "id")).await?;
    let mut ticket_ids: Vec<String> = Vec::new();
    for ticket in &contents.tickets {
        let id = text(ticket, "ticketId").to_owned();
        if !ticket_ids.contains(&id) {
            ticket_ids.push(id);
        }
    }
    Ok(json!({
        "releaseId": col(row, "id"),
        "name": col(row, "name"),
        "version": col(row, "version"),
        "repositoryId": col(row, "repositoryId"),
        "pullRequestIds": contents.pull_requests.iter().map(|(pr, _)| col(pr, "id")).collect::<Vec<_>>(),
        "issueIds": contents.issues.iter().map(|i| col(i, "id")).collect::<Vec<_>>(),
        "deskTicketIds": ticket_ids,
    }))
}

/// `findLiveRepository(db, id)`.
async fn find_live_repository(db: &PgPool, id: &str) -> Result<Option<Row>, DbErr> {
    merge_repositories::Entity::find_by_id(id.to_owned())
        .filter(merge_repositories::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?
        .map(|repository| js(serde_json::to_value(repository)))
        .transpose()
}

// ── GET / and GET /:id ──────────────────────────────────────────────────────

/// `GET /releases`: newest first (by id); the cursor is the page's last id.
pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Answer {
    let (team_id, repository_id, status, limit, cursor) =
        validate_query(query.as_deref(), |issues, fields| {
            let opt = |issues: &mut Issues, key: &str| {
                issues
                    .text(fields, key, Presence::Optional, None, None)
                    .into_option()
                    .filter(|v| !v.is_empty())
            };
            let team_id = opt(issues, "teamId");
            let repository_id = opt(issues, "repositoryId");
            let status = issues
                .choice(fields, "status", Presence::Optional, &RELEASE_STATUSES)
                .into_option();
            let limit = limit_of(issues, fields);
            let cursor = opt(issues, "cursor");
            (team_id, repository_id, status, limit, cursor)
        })?;
    let db = &caller.db;
    let mut select =
        merge_releases::Entity::find().filter(merge_releases::Column::DeletedAt.is_null());
    if let Some(team_id) = team_id {
        select = select.filter(merge_releases::Column::TeamId.eq(team_id));
    }
    if let Some(repository_id) = repository_id {
        select = select.filter(merge_releases::Column::RepositoryId.eq(repository_id));
    }
    if let Some(status) = status {
        select = select.filter(merge_releases::Column::Status.eq(status));
    }
    if let Some(cursor) = cursor {
        select = select.filter(merge_releases::Column::Id.lt(cursor));
    }
    let rows = select
        .order_by_desc(merge_releases::Column::Id)
        .limit(u64::try_from(limit + 1).unwrap_or(0))
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|release| js(serde_json::to_value(release)))
        .collect::<Result<Vec<Row>, DbErr>>()?;
    let size = usize::try_from(limit).unwrap_or(0);
    let has_more = rows.len() > size;
    let rows: Vec<Row> = rows.into_iter().take(size).collect();
    let next = if has_more {
        rows.last().map(|r| text(r, "id").to_owned())
    } else {
        None
    };
    let dtos = hydrate_releases(db, &rows).await?;
    Ok(page(dtos, has_more, next))
}

/// `GET /releases/:id`.
pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Answer {
    let Some(release) = find_release(&caller.db, &id).await? else {
        return Err(Refusal::not_found("Release", Some(&id)));
    };
    Ok(Data(release_detail(&caller, &release).await?).into_response())
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// `?.trim() || null` of a validated (already trimmed) text.
fn trimmed_or_null(field: Field<String>) -> Option<String> {
    field.into_option().filter(|v| !v.is_empty())
}

/// `POST /releases`.
pub(crate) async fn create(
    State(state): State<MergeState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = validate(&headers, &body, |issues, fields| {
        let team_id = issues
            .text(fields, "teamId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default();
        let repository_id = issues
            .text(fields, "repositoryId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default();
        let name = issues
            .text_with(
                fields,
                "name",
                Presence::Required,
                Text::trimmed(Some(1), Some(255)),
            )
            .into_option()
            .unwrap_or_default();
        let version = issues.text_with(
            fields,
            "version",
            Presence::Nullish,
            Text::trimmed(None, Some(100)),
        );
        let base_ref = issues.text_with(
            fields,
            "baseRef",
            Presence::Nullish,
            Text::trimmed(None, Some(500)),
        );
        let head_ref = issues.text_with(
            fields,
            "headRef",
            Presence::Nullish,
            Text::trimmed(None, Some(500)),
        );
        let notes = issues.text(fields, "notes", Presence::Nullish, None, Some(100_000));
        (
            team_id,
            repository_id,
            name,
            version,
            base_ref,
            head_ref,
            notes,
        )
    })?;
    let (team_id, repository_id, name, version, base_ref, head_ref, notes) = input;
    let db = &caller.db;
    if find_team(db, &team_id).await?.is_none() {
        return Err(Refusal::not_found("Team", None));
    }
    if find_live_repository(db, &repository_id).await?.is_none() {
        return Err(Refusal::not_found("Repository", None));
    }
    let at = utc_now().assume_utc();
    let row = merge_releases::Entity::insert(merge_releases::ActiveModel {
        id: Set(generate_id("mrl")),
        team_id: Set(team_id),
        repository_id: Set(repository_id),
        name: Set(name),
        version: Set(trimmed_or_null(version)),
        base_ref: Set(trimmed_or_null(base_ref)),
        head_ref: Set(trimmed_or_null(head_ref)),
        notes: Set(notes.into_option()),
        created_by_user_id: Set(caller.user_id.clone()),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    let release = js(serde_json::to_value(row))?;
    publish(
        &state,
        &caller.events,
        vec![release_event(&release, "created", &[], None)],
    );
    Ok(Created(release_detail(&caller, &release).await?).into_response())
}

// ── PATCH /:id and DELETE /:id ──────────────────────────────────────────────

/// A nullable text of a patch: `(set, value)`, the value `?.trim() || null`.
fn patch_text(field: &Field<String>) -> (bool, Option<String>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.clone()).filter(|v| !v.is_empty())),
    }
}

/// `PATCH /releases/:id`.
pub(crate) async fn update(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = validate(&headers, &body, |issues, fields| {
        let start = issues.count();
        let name = issues.text_with(
            fields,
            "name",
            Presence::Optional,
            Text::trimmed(Some(1), Some(255)),
        );
        let version = issues.text_with(
            fields,
            "version",
            Presence::Nullish,
            Text::trimmed(None, Some(100)),
        );
        let base_ref = issues.text_with(
            fields,
            "baseRef",
            Presence::Nullish,
            Text::trimmed(None, Some(500)),
        );
        let head_ref = issues.text_with(
            fields,
            "headRef",
            Presence::Nullish,
            Text::trimmed(None, Some(500)),
        );
        let notes = issues.text(fields, "notes", Presence::Nullish, None, Some(100_000));
        nothing_to_update(
            issues,
            start,
            fields,
            &["name", "version", "baseRef", "headRef", "notes"],
        );
        (name, version, base_ref, head_ref, notes)
    })?;
    let (name, version, base_ref, head_ref, notes) = input;
    let db = &caller.db;
    let Some(before) = find_release(db, &id).await? else {
        return Err(Refusal::not_found("Release", Some(&id)));
    };
    let (set_version, version) = patch_text(&version);
    let (set_base, base_ref) = patch_text(&base_ref);
    let (set_head, head_ref) = patch_text(&head_ref);
    let (set_notes, notes) = match &notes {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.clone())),
    };
    let mut change = merge_releases::Entity::update_many().col_expr(
        merge_releases::Column::UpdatedAt,
        Expr::value(utc_now().assume_utc()),
    );
    if let Some(name) = name.into_option() {
        change = change.col_expr(merge_releases::Column::Name, Expr::value(name));
    }
    for (set, column, value) in [
        (set_version, merge_releases::Column::Version, version),
        (set_base, merge_releases::Column::BaseRef, base_ref),
        (set_head, merge_releases::Column::HeadRef, head_ref),
        (set_notes, merge_releases::Column::Notes, notes),
    ] {
        if set {
            change = change.col_expr(column, Expr::value(value));
        }
    }
    let release = returned(
        change
            .filter(merge_releases::Column::Id.eq(&id))
            .exec_with_returning(&orm(db))
            .await?,
    )?;
    let changes = diff_fields(&before, &release, &RELEASE_CHANGE_FIELDS);
    publish(
        &state,
        &caller.events,
        vec![release_event(&release, "updated", &[], changes)],
    );
    Ok(Data(release_detail(&caller, &release).await?).into_response())
}

/// `DELETE /releases/:id`: soft delete.
pub(crate) async fn remove(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let at = utc_now().assume_utc();
    let rows = merge_releases::Entity::update_many()
        .col_expr(merge_releases::Column::DeletedAt, Expr::value(at))
        .col_expr(merge_releases::Column::UpdatedAt, Expr::value(at))
        .filter(merge_releases::Column::Id.eq(&id))
        .filter(merge_releases::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(&caller.db))
        .await?;
    let Some(release) = rows.into_iter().next() else {
        return Err(Refusal::not_found("Release", Some(&id)));
    };
    let release = js(serde_json::to_value(release))?;
    publish(
        &state,
        &caller.events,
        vec![release_event(&release, "deleted", &[], None)],
    );
    Ok(NoContent.into_response())
}

// ── POST /:id/refresh ───────────────────────────────────────────────────────

const COMPARE_PAGE: usize = 100;
const COMPARE_MAX_PAGES: usize = 5;
const FALLBACK_CAP: u64 = 200;

/// A ref as a URL path: each segment encoded, the slashes kept (`feature/x`).
fn ref_path(reference: &str) -> String {
    reference
        .split('/')
        .map(encode_uri_component)
        .collect::<Vec<_>>()
        .join("/")
}

/// `compareCommits(client, fullName, base, head)`: the commits between the
/// refs (up to 500), or `None` when GitHub does not know the compare.
async fn compare_commits(
    client: &GithubClient,
    full_name: &str,
    base: &str,
    head: &str,
) -> Result<Option<Vec<Value>>, crate::MergeError> {
    let mut out: Vec<Value> = Vec::new();
    for page in 1..=COMPARE_MAX_PAGES {
        let body = client
            .get(&format!(
                "/repos/{full_name}/compare/{}...{}?per_page={COMPARE_PAGE}&page={page}",
                ref_path(base),
                ref_path(head)
            ))
            .await?;
        let Some(body) = body else {
            return Ok(if page == 1 { None } else { Some(out) });
        };
        let commits: Vec<Value> = body
            .get("commits")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = commits.len();
        out.extend(commits);
        if count < COMPARE_PAGE {
            break;
        }
    }
    Ok(Some(out))
}

/// `pullRequestNumberOf(message)`: the pull request number a merge or squash
/// commit message names (`/^Merge pull request #(\d+)\b/`, `/\(#(\d+)\)\s*$/`
/// on its first line, trimmed), if any.
pub(crate) fn pull_request_number_of(message: Option<&str>) -> Option<i64> {
    let first = message
        .unwrap_or_default()
        .split('\n')
        .next()
        .unwrap_or_default();
    let first = weldsuite_kit::validation::js_trim(first);
    if let Some(rest) = first.strip_prefix("Merge pull request #") {
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        let after = rest[digits.len()..].chars().next();
        // `\b` after the digits: the end, or a non-word character.
        let bounded = after.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
        if !digits.is_empty() && bounded {
            return digits.parse().ok();
        }
    }
    // `\(#(\d+)\)\s*$`: the trimmed line ends with `(#<digits>)`.
    let body = first.strip_suffix(')')?;
    let open = body.rfind("(#")?;
    let digits = &body[open + 2..];
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        return digits.parse().ok();
    }
    None
}

/// `mergedByCompare(db, repositoryId, commits)`.
async fn merged_by_compare(
    db: &PgPool,
    repository_id: &str,
    commits: &[Value],
) -> Result<Vec<Row>, DbErr> {
    let shas: Vec<String> = commits.iter().map(|c| text(c, "sha").to_owned()).collect();
    let mut numbers: Vec<i64> = Vec::new();
    for commit in commits {
        let message = commit
            .get("commit")
            .and_then(|c| c.get("message"))
            .and_then(Value::as_str);
        if let Some(number) = pull_request_number_of(message)
            && !numbers.contains(&number)
        {
            numbers.push(number);
        }
    }
    if shas.is_empty() {
        return Ok(Vec::new());
    }
    // `head_sha = any(shas)`, or a number a commit message names.
    let mut named = Condition::any().add(merge_pull_requests::Column::HeadSha.is_in(shas));
    if !numbers.is_empty() {
        named = named.add(merge_pull_requests::Column::Number.is_in(numbers));
    }
    merge_pull_requests::Entity::find()
        .filter(merge_pull_requests::Column::RepositoryId.eq(repository_id))
        .filter(merge_pull_requests::Column::State.eq("merged"))
        .filter(named)
        .order_by_desc(merge_pull_requests::Column::MergedAt)
        .order_by_desc(merge_pull_requests::Column::Id)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|pr| js(serde_json::to_value(pr)))
        .collect()
}

/// `mergedSince(db, release)`: merged since the previous shipped release of
/// the repository (all of them, newest 200, when there is none).
async fn merged_since(db: &PgPool, release: &Row) -> Result<Vec<Row>, DbErr> {
    let orm = orm(db);
    let since: Option<Option<OffsetDateTime>> = merge_releases::Entity::find()
        .select_only()
        .column(merge_releases::Column::ShippedAt)
        .filter(merge_releases::Column::RepositoryId.eq(text(release, "repositoryId")))
        .filter(merge_releases::Column::Status.eq("shipped"))
        .filter(merge_releases::Column::DeletedAt.is_null())
        .filter(merge_releases::Column::Id.ne(text(release, "id")))
        .order_by_desc(merge_releases::Column::ShippedAt)
        .into_tuple()
        .one(&orm)
        .await?;
    let mut merged = merge_pull_requests::Entity::find()
        .filter(merge_pull_requests::Column::RepositoryId.eq(text(release, "repositoryId")))
        .filter(merge_pull_requests::Column::State.eq("merged"));
    if let Some(since) = since.flatten() {
        merged = merged.filter(merge_pull_requests::Column::MergedAt.gt(since));
    }
    merged
        .order_by_desc(merge_pull_requests::Column::MergedAt)
        .order_by_desc(merge_pull_requests::Column::Id)
        .limit(FALLBACK_CAP)
        .all(&orm)
        .await?
        .into_iter()
        .map(|pr| js(serde_json::to_value(pr)))
        .collect()
}

/// `POST /releases/:id/refresh`.
pub(crate) async fn refresh(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    let Some(release) = find_release(db, &id).await? else {
        return Err(Refusal::not_found("Release", Some(&id)));
    };
    if text(&release, "status") == "shipped" {
        return Err(Refusal::conflict(
            "A shipped release keeps the pull requests it shipped with",
        ));
    }
    let Some(repository) = find_live_repository(db, text(&release, "repositoryId")).await? else {
        return Err(Refusal::unprocessable(
            "The release's repository is no longer connected",
        ));
    };
    let mut found: Option<Vec<Row>> = None;
    if text(&repository, "provider") == "github" {
        let connection = find_connection(db, text(&repository, "connectionId")).await?;
        let client = connection
            .filter(|c| text(c, "status") == "active")
            .map(|c| {
                caller
                    .overrides
                    .github(&state, text(&c, "externalAccountId"))
            });
        let base = opt_text(&release, "baseRef").filter(|r| !r.is_empty());
        let head = opt_text(&release, "headRef").filter(|r| !r.is_empty());
        if let (Some(client), Some(base), Some(head)) = (client, base, head)
            && let Some(commits) =
                compare_commits(&client, text(&repository, "fullName"), &base, &head).await?
        {
            found = Some(merged_by_compare(db, text(&repository, "id"), &commits).await?);
        }
    }
    let pull_requests = match found {
        Some(found) => found,
        None => merged_since(db, &release).await?,
    };

    let orm = orm(db);
    merge_release_pull_requests::Entity::delete_many()
        .filter(merge_release_pull_requests::Column::ReleaseId.eq(&id))
        .exec(&orm)
        .await?;
    let pr_ids: Vec<String> = pull_requests
        .iter()
        .map(|p| text(p, "id").to_owned())
        .collect();
    if !pr_ids.is_empty() {
        let at = utc_now().assume_utc();
        let links = pr_ids
            .iter()
            .map(|pull_request_id| merge_release_pull_requests::ActiveModel {
                id: Set(generate_id("mrr")),
                release_id: Set(id.clone()),
                pull_request_id: Set(pull_request_id.clone()),
                created_at: Set(at),
            });
        merge_release_pull_requests::Entity::insert_many(links)
            .on_conflict(OnConflict::new().do_nothing().to_owned())
            .exec_without_returning(&orm)
            .await?;
    }
    let updated = returned(
        merge_releases::Entity::update_many()
            .col_expr(
                merge_releases::Column::UpdatedAt,
                Expr::value(utc_now().assume_utc()),
            )
            .filter(merge_releases::Column::Id.eq(&id))
            .exec_with_returning(&orm)
            .await?,
    )?;
    publish(
        &state,
        &caller.events,
        vec![release_event(
            &updated,
            "updated",
            &[("pullRequestIds", json!(pr_ids))],
            None,
        )],
    );
    Ok(Data(release_detail(&caller, &updated).await?).into_response())
}

// ── POST /:id/ship ──────────────────────────────────────────────────────────

/// `POST /releases/:id/ship`: status shipped once, `merge_release.shipped`
/// with the pull request, issue and desk ticket ids, and the chat post.
pub(crate) async fn ship(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    let Some(release) = find_release(db, &id).await? else {
        return Err(Refusal::not_found("Release", Some(&id)));
    };
    if text(&release, "status") == "shipped" {
        return Err(Refusal::conflict("The release is already shipped"));
    }
    // `markShipped(db, id)`: only a live draft ships, so a second click or a
    // concurrent request (or a delete in between) ships nothing.
    let at = utc_now().assume_utc();
    let rows = merge_releases::Entity::update_many()
        .col_expr(merge_releases::Column::Status, Expr::value("shipped"))
        .col_expr(merge_releases::Column::ShippedAt, Expr::value(at))
        .col_expr(merge_releases::Column::UpdatedAt, Expr::value(at))
        .filter(merge_releases::Column::Id.eq(&id))
        .filter(merge_releases::Column::Status.eq("draft"))
        .filter(merge_releases::Column::DeletedAt.is_null())
        .exec_with_returning(&orm(db))
        .await?;
    let Some(row) = rows.into_iter().next() else {
        return Err(Refusal::conflict("The release is already shipped"));
    };
    let shipped = js(serde_json::to_value(row))?;
    let data = shipped_event_data(db, &shipped).await?;
    publish(
        &state,
        &caller.events,
        vec![release_event(
            &shipped,
            "shipped",
            &[
                ("pullRequestIds", col(&data, "pullRequestIds")),
                ("issueIds", col(&data, "issueIds")),
                ("deskTicketIds", col(&data, "deskTicketIds")),
            ],
            None,
        )],
    );
    crate::hooks::after_release_shipped(&caller.hook_context(&state), &shipped, &data).await;
    Ok(Data(release_detail(&caller, &shipped).await?).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_merge_and_squash_commit_messages_and_nothing_else() {
        let of = |m: &str| pull_request_number_of(Some(m));
        assert_eq!(
            of("Merge pull request #12 from acme/fix\n\nTitle"),
            Some(12)
        );
        assert_eq!(of("Add search (#34)"), Some(34));
        assert_eq!(of("Add search (#34)\n\nSee #99"), Some(34));
        assert_eq!(of("Add search (#34)  "), Some(34));
        assert_eq!(of("Fix #5 in the parser"), None);
        assert_eq!(of("Merge pull request #12x"), None);
        assert_eq!(pull_request_number_of(None), None);
    }

    #[test]
    fn a_ref_keeps_its_slashes() {
        assert_eq!(ref_path("feature/a b"), "feature/a%20b");
        assert_eq!(ref_path("v1.0"), "v1.0");
    }
}
