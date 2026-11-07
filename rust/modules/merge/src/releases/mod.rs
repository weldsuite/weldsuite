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
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_kit::{Created, Data, NoContent, generate_id};

use crate::connections::find_connection;
use crate::db::{Row, col, opt_text, rows_of, text};
use crate::github_client::{GithubClient, encode_uri_component};
use crate::issues::{diff_fields, hydrate_issues, limit_of};
use crate::mappers::pull_request_summary;
use crate::record_links::TitleAccess;
use crate::schemas::nothing_to_update;
use crate::teams::find_team;
use crate::{
    Answer, Caller, MergeState, PendingEvent, Refusal, now, page, publish, validate, validate_query,
};

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

/// `findRelease(db, id)`: a live release.
pub(crate) async fn find_release(db: &PgPool, id: &str) -> Result<Option<Row>, sqlx::Error> {
    crate::db::one_by_id(
        db,
        "select to_jsonb(r) from merge_releases r where r.id = $1 and r.deleted_at is null limit 1",
        id,
    )
    .await
}

/// `hydrateReleases(db, rows)`.
async fn hydrate_releases(db: &PgPool, rows: &[Row]) -> Result<Vec<Value>, sqlx::Error> {
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
    // Deleted repositories too: a release keeps its repository's name.
    let names: HashMap<String, String> =
        sqlx::query_as("select id, full_name from merge_repositories where id = any($1)")
            .bind(&repository_ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect();
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let counts: HashMap<String, i64> = sqlx::query_as::<_, (String, i32)>(
        "select release_id, count(*)::int from merge_release_pull_requests \
         where release_id = any($1) group by release_id",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|(id, count)| (id, i64::from(count)))
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

async fn one_release_dto(db: &PgPool, row: &Row) -> Result<Value, sqlx::Error> {
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

/// `releaseContents(db, releaseId)`.
async fn release_contents(db: &PgPool, release_id: &str) -> Result<Contents, sqlx::Error> {
    let prs: Vec<(Value, String)> = sqlx::query_as(
        "select to_jsonb(p), r.full_name from merge_release_pull_requests rp \
         inner join merge_pull_requests p on p.id = rp.pull_request_id \
         inner join merge_repositories r on r.id = p.repository_id \
         where rp.release_id = $1 \
         order by p.merged_at desc, p.id desc",
    )
    .bind(release_id)
    .fetch_all(db)
    .await?;
    let pull_requests: Vec<(Row, String)> = prs
        .into_iter()
        .map(|(pr, full_name)| (js_row(pr), full_name))
        .collect();
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
    let issue_rows = rows_of(
        sqlx::query_scalar(
            "select distinct to_jsonb(i) from merge_issue_pull_requests l \
             inner join merge_issues i on i.id = l.issue_id \
             where l.pull_request_id = any($1) and l.dismissed_at is null and i.deleted_at is null",
        )
        .bind(&pr_ids)
        .fetch_all(db)
        .await?,
    );
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
async fn desk_tickets_of(db: &PgPool, issues: &[Value]) -> Result<Vec<Value>, sqlx::Error> {
    if issues.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = issues.iter().map(|i| text(i, "id").to_owned()).collect();
    let keys: HashMap<String, String> = issues
        .iter()
        .map(|i| (text(i, "id").to_owned(), text(i, "key").to_owned()))
        .collect();
    let links = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(l) from merge_record_links l \
             where l.issue_id = any($1) and l.record_type = 'desk_ticket'",
        )
        .bind(&ids)
        .fetch_all(db)
        .await?,
    );
    let mut tickets: Vec<(String, String, Value)> = links
        .iter()
        .map(|link| {
            let issue_key = keys.get(text(link, "issueId")).cloned().unwrap_or_default();
            let ticket_id = text(link, "recordId").to_owned();
            let ticket = json!({
                "ticketId": ticket_id,
                "title": col(link, "title"),
                "issueId": col(link, "issueId"),
                "issueKey": issue_key,
            });
            (issue_key, ticket_id, ticket)
        })
        .collect();
    tickets.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
    Ok(tickets.into_iter().map(|(_, _, ticket)| ticket).collect())
}

/// `detailOf(c, row)`: `getReleaseDetail(db, row)`, with a desk ticket's
/// subject only for a caller with `tickets:read` (`withVisibleTitles`).
async fn release_detail(caller: &Caller, row: &Row) -> Result<Value, sqlx::Error> {
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
async fn shipped_event_data(db: &PgPool, row: &Row) -> Result<Value, sqlx::Error> {
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
async fn find_live_repository(db: &PgPool, id: &str) -> Result<Option<Row>, sqlx::Error> {
    crate::db::one_by_id(
        db,
        "select to_jsonb(r) from merge_repositories r where r.id = $1 and r.deleted_at is null limit 1",
        id,
    )
    .await
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
    let rows = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(r) from merge_releases r where r.deleted_at is null \
             and ($1::text is null or r.team_id = $1) \
             and ($2::text is null or r.repository_id = $2) \
             and ($3::text is null or r.status = $3) \
             and ($4::text is null or r.id < $4) \
             order by r.id desc limit $5",
        )
        .bind(team_id)
        .bind(repository_id)
        .bind(status)
        .bind(cursor)
        .bind(limit + 1)
        .fetch_all(db)
        .await?,
    );
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
    let now = now();
    let row: Value = sqlx::query_scalar(
        "insert into merge_releases (id, team_id, repository_id, name, version, base_ref, head_ref, notes, \
           created_by_user_id, created_at, updated_at) \
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz) \
         returning to_jsonb(merge_releases.*)",
    )
    .bind(generate_id("mrl"))
    .bind(&team_id)
    .bind(&repository_id)
    .bind(&name)
    .bind(trimmed_or_null(version))
    .bind(trimmed_or_null(base_ref))
    .bind(trimmed_or_null(head_ref))
    .bind(notes.into_option())
    .bind(&caller.user_id)
    .bind(&now)
    .fetch_one(db)
    .await?;
    let release = js_row(row);
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
    let row: Value = sqlx::query_scalar(
        "update merge_releases set updated_at = $2::timestamptz, \
           name = case when $3::text is null then name else $3 end, \
           version = case when $4 then $5 else version end, \
           base_ref = case when $6 then $7 else base_ref end, \
           head_ref = case when $8 then $9 else head_ref end, \
           notes = case when $10 then $11 else notes end \
         where id = $1 returning to_jsonb(merge_releases.*)",
    )
    .bind(&id)
    .bind(now())
    .bind(name.into_option())
    .bind(set_version)
    .bind(version)
    .bind(set_base)
    .bind(base_ref)
    .bind(set_head)
    .bind(head_ref)
    .bind(set_notes)
    .bind(notes)
    .fetch_one(db)
    .await?;
    let release = js_row(row);
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
    let now = now();
    let row: Option<Value> = sqlx::query_scalar(
        "update merge_releases set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1 and deleted_at is null returning to_jsonb(merge_releases.*)",
    )
    .bind(&id)
    .bind(&now)
    .fetch_optional(&caller.db)
    .await?;
    let Some(release) = row.map(js_row) else {
        return Err(Refusal::not_found("Release", Some(&id)));
    };
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
const FALLBACK_CAP: i64 = 200;

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
) -> Result<Vec<Row>, sqlx::Error> {
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
    Ok(rows_of(
        sqlx::query_scalar(
            "select to_jsonb(p) from merge_pull_requests p \
             where p.repository_id = $1 and p.state = 'merged' \
               and (p.head_sha = any($2) or ($3::int[] is not null and p.number = any($3))) \
             order by p.merged_at desc, p.id desc",
        )
        .bind(repository_id)
        .bind(&shas)
        .bind((!numbers.is_empty()).then_some(&numbers))
        .fetch_all(db)
        .await?,
    ))
}

/// `mergedSince(db, release)`: merged since the previous shipped release of
/// the repository (all of them, newest 200, when there is none).
async fn merged_since(db: &PgPool, release: &Row) -> Result<Vec<Row>, sqlx::Error> {
    let since: Option<Option<Value>> = sqlx::query_scalar(
        "select to_jsonb(r.shipped_at) from merge_releases r \
         where r.repository_id = $1 and r.status = 'shipped' and r.deleted_at is null and r.id <> $2 \
         order by r.shipped_at desc limit 1",
    )
    .bind(text(release, "repositoryId"))
    .bind(text(release, "id"))
    .fetch_optional(db)
    .await?;
    let since = since.flatten().and_then(|v| v.as_str().map(str::to_owned));
    Ok(rows_of(
        sqlx::query_scalar(
            "select to_jsonb(p) from merge_pull_requests p \
             where p.repository_id = $1 and p.state = 'merged' \
               and ($2::timestamptz is null or p.merged_at > $2::timestamptz) \
             order by p.merged_at desc, p.id desc limit $3",
        )
        .bind(text(release, "repositoryId"))
        .bind(since)
        .bind(FALLBACK_CAP)
        .fetch_all(db)
        .await?,
    ))
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

    sqlx::query("delete from merge_release_pull_requests where release_id = $1")
        .bind(&id)
        .execute(db)
        .await?;
    let pr_ids: Vec<String> = pull_requests
        .iter()
        .map(|p| text(p, "id").to_owned())
        .collect();
    if !pr_ids.is_empty() {
        let ids: Vec<String> = pr_ids.iter().map(|_| generate_id("mrr")).collect();
        sqlx::query(
            "insert into merge_release_pull_requests (id, release_id, pull_request_id, created_at) \
             select l.id, $2, l.pull_request_id, $4::timestamptz \
             from unnest($1::varchar[], $3::varchar[]) as l(id, pull_request_id) \
             on conflict do nothing",
        )
        .bind(&ids)
        .bind(&id)
        .bind(&pr_ids)
        .bind(now())
        .execute(db)
        .await?;
    }
    let row: Value = sqlx::query_scalar(
        "update merge_releases set updated_at = $2::timestamptz where id = $1 \
         returning to_jsonb(merge_releases.*)",
    )
    .bind(&id)
    .bind(now())
    .fetch_one(db)
    .await?;
    let updated = js_row(row);
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
    let now = now();
    let row: Option<Value> = sqlx::query_scalar(
        "update merge_releases set status = 'shipped', shipped_at = $2::timestamptz, \
           updated_at = $2::timestamptz \
         where id = $1 and status = 'draft' and deleted_at is null \
         returning to_jsonb(merge_releases.*)",
    )
    .bind(&id)
    .bind(&now)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Err(Refusal::conflict("The release is already shipped"));
    };
    let shipped = js_row(row);
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
