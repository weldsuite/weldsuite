//! The pull request mirror, read-only for members (it is written by sync:
//! webhooks, adding a repository, Refresh): `/api/merge/pull-requests`, and
//! the links members make by hand under an issue.
//!
//! ```text
//!   GET /pull-requests      → view needs_review | mine | open | merged | closed; repositoryId, teamId, q; cursor
//!   GET /pull-requests/:id  → detail with the linked issues        (merge_pull_requests:read)
//!   POST   /issues/:id/pull-requests        → link a pull request by hand (merge_issues:update)
//!   DELETE /issues/:id/pull-requests/:prId  → remove a link             (merge_issues:update)
//! ```

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Presence, Text, js_iso_from_millis, js_number};
use weldsuite_kit::{Data, NoContent, generate_id};

use crate::db::{Row, col, like_pattern, text};
use crate::github::millis_of;
use crate::issues::{find_issue, issue_detail, limit_of};
use crate::mappers::{issue_event_data, pull_request_summary};
use crate::pr_sync::{LinkedIssue, phase_of, run_automation};
use crate::schemas::PULL_REQUEST_VIEWS;
use crate::teams::find_team;
use crate::{
    Answer, Caller, MergeState, PendingEvent, Refusal, page, publish, validate, validate_query,
};

/// `memberGithubLogin(db, userId)`: the member's own GitHub login, or none.
pub(crate) async fn member_github_login(
    db: &PgPool,
    user_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select login from merge_provider_accounts where user_id = $1 and provider = 'github' limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
}

/// `linkedIssuesByPullRequest(db, ids)`: the issues each pull request is
/// linked to (live issues only), by team key and number.
pub(crate) async fn linked_issues(
    db: &PgPool,
    pull_request_ids: &[String],
) -> Result<HashMap<String, Vec<Value>>, sqlx::Error> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    if pull_request_ids.is_empty() {
        return Ok(out);
    }
    let rows: Vec<(String, Value, String, String, bool)> = sqlx::query_as(
        "select l.pull_request_id, to_jsonb(i), t.key, l.source, l.closes \
         from merge_issue_pull_requests l \
         inner join merge_issues i on i.id = l.issue_id \
         inner join merge_teams t on t.id = i.team_id \
         where l.pull_request_id = any($1) and i.deleted_at is null \
         order by t.key, i.number",
    )
    .bind(pull_request_ids)
    .fetch_all(db)
    .await?;
    for (pull_request_id, issue, team_key, source, closes) in rows {
        let issue = js_row(issue);
        out.entry(pull_request_id).or_default().push(json!({
            "id": issue["id"],
            "key": format!("{team_key}-{}", col(&issue, "number")),
            "title": issue["title"],
            "status": issue["status"],
            "source": source,
            "closes": closes,
        }));
    }
    Ok(out)
}

/// A pull request with its repository's name and team (`PullRequestRowWithRepo`).
pub(crate) struct WithRepo {
    pub(crate) pr: Row,
    pub(crate) full_name: String,
    pub(crate) team_id: Option<String>,
}

/// `toListItems(db, rows)`: list rows with the issues each is linked to.
pub(crate) async fn to_list_items(
    db: &PgPool,
    rows: &[WithRepo],
) -> Result<Vec<Value>, sqlx::Error> {
    let ids: Vec<String> = rows.iter().map(|r| text(&r.pr, "id").to_owned()).collect();
    let mut issues = linked_issues(db, &ids).await?;
    Ok(rows
        .iter()
        .map(|row| {
            let mut item = pull_request_summary(&row.pr, &row.full_name);
            item.insert("teamId".to_owned(), json!(row.team_id));
            item.insert(
                "issues".to_owned(),
                Value::Array(issues.remove(text(&row.pr, "id")).unwrap_or_default()),
            );
            Value::Object(item)
        })
        .collect())
}

/// The conditions of a pull request query (`queryPullRequests(db, where, limit)`).
#[derive(Default)]
pub(crate) struct Filter {
    pub(crate) state: Option<&'static str>,
    pub(crate) draft: Option<bool>,
    /// `reviewRequestedFrom(login)`.
    pub(crate) review_requested_from: Option<String>,
    /// `authoredBy(userId, login)`.
    pub(crate) authored_by: Option<(String, Option<String>)>,
    pub(crate) repository_id: Option<String>,
    pub(crate) team_id: Option<String>,
    pub(crate) pattern: Option<String>,
    pub(crate) number: Option<i64>,
    pub(crate) cursor: Option<(String, String)>,
    pub(crate) checks_status: Option<&'static str>,
    pub(crate) review_decision: Option<&'static str>,
    pub(crate) merged_since: Option<String>,
}

/// Pull requests of live repositories matching `filter`, newest update first.
pub(crate) async fn query_pull_requests(
    db: &PgPool,
    filter: Filter,
    limit: i64,
) -> Result<Vec<WithRepo>, sqlx::Error> {
    let review = filter
        .review_requested_from
        .map(|login| json!([{ "kind": "user", "login": login }]));
    let (author, author_login) = match filter.authored_by {
        Some((user, login)) => (Some(user), login),
        None => (None, None),
    };
    let (cursor_at, cursor_id) = match filter.cursor {
        Some((at, id)) => (Some(at), Some(id)),
        None => (None, None),
    };
    let rows: Vec<(Value, String, Option<String>)> = sqlx::query_as(
        "select to_jsonb(p), r.full_name, r.team_id from merge_pull_requests p \
         inner join merge_repositories r on r.id = p.repository_id \
         where r.deleted_at is null \
           and ($1::text is null or p.state = $1) \
           and ($2::boolean is null or p.draft = $2) \
           and ($3::jsonb is null or p.requested_reviewers @> $3) \
           and ($4::text is null or p.author_user_id = $4 or ($5::text is not null and p.author_login = $5)) \
           and ($6::text is null or p.repository_id = $6) \
           and ($7::text is null or r.team_id = $7) \
           and ($8::text is null or p.title ilike $8 escape '\\' or p.head_ref ilike $8 escape '\\' \
                or r.full_name ilike $8 escape '\\' or ($9::int is not null and p.number = $9)) \
           and ($10::timestamptz is null or (p.provider_updated_at, p.id) < ($10::timestamptz, $11::varchar)) \
           and ($12::text is null or p.checks_status = $12) \
           and ($13::text is null or p.review_decision = $13) \
           and ($14::timestamptz is null or p.merged_at >= $14::timestamptz) \
         order by p.provider_updated_at desc, p.id desc limit $15",
    )
    .bind(filter.state)
    .bind(filter.draft)
    .bind(review)
    .bind(author)
    .bind(author_login)
    .bind(filter.repository_id)
    .bind(filter.team_id)
    .bind(filter.pattern)
    .bind(filter.number)
    .bind(cursor_at)
    .bind(cursor_id)
    .bind(filter.checks_status)
    .bind(filter.review_decision)
    .bind(filter.merged_since)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(pr, full_name, team_id)| WithRepo {
            pr: js_row(pr),
            full_name,
            team_id,
        })
        .collect())
}

/// `parseCursor(cursor)`: `<ms>|<id>`.
fn parse_cursor(cursor: Option<&str>) -> Option<(String, String)> {
    let cursor = cursor.filter(|c| !c.is_empty())?;
    let sep = cursor.find('|')?;
    if sep < 1 {
        return None;
    }
    let ms = js_number(&cursor[..sep]);
    if !ms.is_finite() {
        return None;
    }
    Some((js_iso_from_millis(ms)?, cursor[sep + 1..].to_owned()))
}

/// `listMergePullRequestsQuerySchema`, as validated.
struct ListQuery {
    view: String,
    repository_id: Option<String>,
    team_id: Option<String>,
    q: Option<String>,
    limit: i64,
    cursor: Option<String>,
}

fn list_query(query: Option<&str>) -> Result<ListQuery, Refusal> {
    validate_query(query, |issues, fields| {
        let view = issues
            .choice(fields, "view", Presence::Optional, &PULL_REQUEST_VIEWS)
            .into_option()
            .unwrap_or_else(|| "open".to_owned());
        let opt = |issues: &mut weldsuite_kit::validation::Issues, key: &str| {
            issues
                .text(fields, key, Presence::Optional, None, None)
                .into_option()
        };
        let repository_id = opt(issues, "repositoryId");
        let team_id = opt(issues, "teamId");
        let q = issues
            .text_with(
                fields,
                "q",
                Presence::Optional,
                Text::trimmed(None, Some(200)),
            )
            .into_option();
        let limit = limit_of(issues, fields);
        let cursor = opt(issues, "cursor");
        ListQuery {
            view,
            repository_id,
            team_id,
            q,
            limit,
            cursor,
        }
    })
}

/// `/^#?(\d{1,9})$/` on the trimmed search.
fn searched_number(q: &str) -> Option<i64> {
    let text = weldsuite_kit::validation::js_trim(q);
    let digits = text.strip_prefix('#').unwrap_or(text);
    (!digits.is_empty() && digits.len() <= 9 && digits.bytes().all(|b| b.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Answer {
    let query = list_query(query.as_deref())?;
    let db = &caller.db;
    let mut filter = Filter::default();
    match query.view.as_str() {
        view @ ("needs_review" | "mine") => {
            let login = member_github_login(db, &caller.user_id)
                .await?
                .filter(|l| !l.is_empty());
            filter.state = Some("open");
            if view == "needs_review" {
                let Some(login) = login else {
                    return Ok(page(Vec::new(), false, None));
                };
                filter.draft = Some(false);
                filter.review_requested_from = Some(login);
            } else {
                filter.authored_by = Some((caller.user_id.clone(), login));
            }
        }
        "merged" => filter.state = Some("merged"),
        "closed" => filter.state = Some("closed"),
        _ => filter.state = Some("open"),
    }
    let truthy = |value: Option<String>| value.filter(|v| !v.is_empty());
    filter.repository_id = truthy(query.repository_id);
    filter.team_id = truthy(query.team_id);
    if let Some(q) = truthy(query.q) {
        filter.number = searched_number(&q);
        filter.pattern = Some(like_pattern(&q));
    }
    filter.cursor = parse_cursor(query.cursor.as_deref());
    let rows = query_pull_requests(db, filter, query.limit + 1).await?;
    let limit = usize::try_from(query.limit).unwrap_or(0);
    let has_more = rows.len() > limit;
    let rows: Vec<WithRepo> = rows.into_iter().take(limit).collect();
    let cursor = if has_more {
        rows.last().and_then(|last| {
            let ms = last
                .pr
                .get("providerUpdatedAt")
                .and_then(Value::as_str)
                .and_then(millis_of)?;
            #[allow(clippy::cast_possible_truncation)]
            Some(format!("{}|{}", ms as i64, text(&last.pr, "id")))
        })
    } else {
        None
    };
    let items = to_list_items(db, &rows).await?;
    Ok(page(items, has_more, cursor))
}

/// `findPullRequest(db, id)`: a pull request of a live repository.
async fn find_pull_request(db: &PgPool, id: &str) -> Result<Option<WithRepo>, sqlx::Error> {
    let row: Option<(Value, String, Option<String>)> = sqlx::query_as(
        "select to_jsonb(p), r.full_name, r.team_id from merge_pull_requests p \
         inner join merge_repositories r on r.id = p.repository_id \
         where p.id = $1 and r.deleted_at is null limit 1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(pr, full_name, team_id)| WithRepo {
        pr: js_row(pr),
        full_name,
        team_id,
    }))
}

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Answer {
    let db = &caller.db;
    let Some(row) = find_pull_request(db, &id).await? else {
        return Err(Refusal::not_found("Pull request", Some(&id)));
    };
    let mut issues = linked_issues(db, std::slice::from_ref(&id)).await?;
    let mut detail: Map<String, Value> = pull_request_summary(&row.pr, &row.full_name);
    detail.insert("body".to_owned(), col(&row.pr, "body"));
    detail.insert("headSha".to_owned(), col(&row.pr, "headSha"));
    detail.insert("teamId".to_owned(), json!(row.team_id));
    detail.insert(
        "issues".to_owned(),
        Value::Array(issues.remove(&id).unwrap_or_default()),
    );
    detail.insert("syncedAt".to_owned(), col(&row.pr, "syncedAt"));
    Ok(Data(Value::Object(detail)).into_response())
}

// ── Manual links ────────────────────────────────────────────────────────────

/// `POST /issues/:id/pull-requests`: links by hand (source `manual`). A new
/// link runs the automation rule for the pull request's current phase.
pub(crate) async fn link(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let (pull_request_id, closes) = validate(&headers, &body, |issues, fields| {
        (
            issues
                .text(fields, "pullRequestId", Presence::Required, Some(1), None)
                .into_option()
                .unwrap_or_default(),
            issues
                .boolean(fields, "closes", Presence::Optional)
                .into_option()
                .unwrap_or(true),
        )
    })?;
    let db = &caller.db;
    let Some(issue) = find_issue(db, &id).await? else {
        return Err(Refusal::not_found("Issue", Some(&id)));
    };
    let team_key = match find_team(db, text(&issue, "teamId")).await? {
        Some(team) => text(&team, "key").to_owned(),
        None => String::new(),
    };
    let Some(target) = find_pull_request(db, &pull_request_id).await? else {
        return Err(Refusal::not_found("Pull request", Some(&pull_request_id)));
    };
    let existing: Option<String> = sqlx::query_scalar(
        "select id from merge_issue_pull_requests where issue_id = $1 and pull_request_id = $2 limit 1",
    )
    .bind(&id)
    .bind(&pull_request_id)
    .fetch_optional(db)
    .await?;
    let mut events: Vec<PendingEvent> = Vec::new();
    if let Some(link_id) = existing {
        sqlx::query("update merge_issue_pull_requests set closes = $2 where id = $1")
            .bind(&link_id)
            .bind(closes)
            .execute(db)
            .await?;
    } else {
        sqlx::query(
            "insert into merge_issue_pull_requests (id, issue_id, pull_request_id, source, closes, created_by_user_id) \
             values ($1, $2, $3, 'manual', $4, $5) on conflict do nothing",
        )
        .bind(generate_id("mip"))
        .bind(&id)
        .bind(&pull_request_id)
        .bind(closes)
        .bind(&caller.user_id)
        .execute(db)
        .await?;
        let phase = phase_of(&target.pr);
        let mut links = [LinkedIssue {
            closes,
            is_new: true,
            issue: issue.clone(),
            team_key: team_key.clone(),
        }];
        events = run_automation(db, &target.pr, Some(phase), &mut links).await?;
    }
    if events.is_empty() {
        events.push(PendingEvent::new(
            "merge_issue",
            "updated",
            &id,
            issue_event_data(&issue, &team_key, None),
        ));
    }
    publish(&state, &caller.events, events);
    let detail = issue_detail(db, &id).await?.unwrap_or(Value::Null);
    Ok(Data(detail).into_response())
}

/// `DELETE /issues/:id/pull-requests/:prId`: removes a link. An `auto` link
/// comes back when the pull request next syncs and still mentions the key.
pub(crate) async fn unlink(
    State(state): State<MergeState>,
    caller: Caller,
    Path((id, pr_id)): Path<(String, String)>,
) -> Answer {
    let db = &caller.db;
    let Some(issue) = find_issue(db, &id).await? else {
        return Err(Refusal::not_found("Issue", Some(&id)));
    };
    let removed: Vec<String> = sqlx::query_scalar(
        "delete from merge_issue_pull_requests where issue_id = $1 and pull_request_id = $2 returning id",
    )
    .bind(&id)
    .bind(&pr_id)
    .fetch_all(db)
    .await?;
    if removed.is_empty() {
        return Err(Refusal::not_found("Pull request link", Some(&pr_id)));
    }
    let team_key = match find_team(db, text(&issue, "teamId")).await? {
        Some(team) => text(&team, "key").to_owned(),
        None => String::new(),
    };
    publish(
        &state,
        &caller.events,
        vec![PendingEvent::new(
            "merge_issue",
            "updated",
            text(&issue, "id"),
            issue_event_data(&issue, &team_key, None),
        )],
    );
    Ok(NoContent.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_cursor_as_the_worker_writes_it() {
        assert_eq!(
            parse_cursor(Some("1793874000000|mpr_1")),
            Some(("2026-11-05T10:20:00.000Z".to_owned(), "mpr_1".to_owned()))
        );
        assert_eq!(parse_cursor(Some("|mpr_1")), None);
        assert_eq!(parse_cursor(Some("abc|mpr_1")), None);
        assert_eq!(parse_cursor(None), None);
    }

    #[test]
    fn a_search_for_a_number_finds_it_with_or_without_a_hash() {
        assert_eq!(searched_number("#3"), Some(3));
        assert_eq!(searched_number("12"), Some(12));
        assert_eq!(searched_number("api"), None);
    }
}
