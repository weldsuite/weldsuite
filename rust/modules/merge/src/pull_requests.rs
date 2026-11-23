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
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter, QueryOrder,
    QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::validation::{Presence, Text, js_iso_from_millis, js_number};
use weldsuite_kit::{Data, NoContent, generate_id};
use weldsuite_schema::tenant::{
    merge_issue_pull_requests, merge_issues, merge_provider_accounts, merge_pull_requests,
    merge_repositories, merge_teams,
};

use crate::db::{Row, col, ilike, instant, json_row, like_pattern, now_at, text};
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
) -> Result<Option<String>, DbErr> {
    merge_provider_accounts::Entity::find()
        .select_only()
        .column(merge_provider_accounts::Column::Login)
        .filter(merge_provider_accounts::Column::UserId.eq(user_id))
        .filter(merge_provider_accounts::Column::Provider.eq("github"))
        .into_tuple::<String>()
        .one(&orm(db))
        .await
}

/// An issue a pull request is linked to: the link and what the list shows
/// of the issue (`l.pull_request_id, to_jsonb(i), t.key, l.source, l.closes`).
#[derive(Debug, FromQueryResult)]
struct IssueLink {
    pull_request_id: String,
    issue_id: String,
    number: i32,
    title: String,
    status: String,
    team_key: String,
    source: String,
    closes: bool,
}

/// `linkedIssuesByPullRequest(db, ids)`: the issues each pull request is
/// linked to (live issues only), by team key and number.
pub(crate) async fn linked_issues(
    db: &PgPool,
    pull_request_ids: &[String],
) -> Result<HashMap<String, Vec<Value>>, DbErr> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    if pull_request_ids.is_empty() {
        return Ok(out);
    }
    let rows = merge_issue_pull_requests::Entity::find()
        .select_only()
        .column(merge_issue_pull_requests::Column::PullRequestId)
        .column_as(merge_issues::Column::Id, "issue_id")
        .column(merge_issues::Column::Number)
        .column(merge_issues::Column::Title)
        .column(merge_issues::Column::Status)
        .column_as(merge_teams::Column::Key, "team_key")
        .column(merge_issue_pull_requests::Column::Source)
        .column(merge_issue_pull_requests::Column::Closes)
        .join(
            JoinType::InnerJoin,
            merge_issue_pull_requests::Entity::belongs_to(merge_issues::Entity)
                .from(merge_issue_pull_requests::Column::IssueId)
                .to(merge_issues::Column::Id)
                .into(),
        )
        .join(
            JoinType::InnerJoin,
            merge_issues::Entity::belongs_to(merge_teams::Entity)
                .from(merge_issues::Column::TeamId)
                .to(merge_teams::Column::Id)
                .into(),
        )
        .filter(
            merge_issue_pull_requests::Column::PullRequestId
                .is_in(pull_request_ids.iter().map(String::as_str)),
        )
        .filter(merge_issue_pull_requests::Column::DismissedAt.is_null())
        .filter(merge_issues::Column::DeletedAt.is_null())
        .order_by_asc(merge_teams::Column::Key)
        .order_by_asc(merge_issues::Column::Number)
        .into_model::<IssueLink>()
        .all(&orm(db))
        .await?;
    for link in rows {
        out.entry(link.pull_request_id).or_default().push(json!({
            "id": link.issue_id,
            "key": format!("{}-{}", link.team_key, link.number),
            "title": link.title,
            "status": link.status,
            "source": link.source,
            "closes": link.closes,
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
pub(crate) async fn to_list_items(db: &PgPool, rows: &[WithRepo]) -> Result<Vec<Value>, DbErr> {
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
    pub(crate) merged_since: Option<OffsetDateTime>,
}

/// A pull request with its repository's name and team, as selected.
#[derive(Debug, FromQueryResult)]
struct PullRequestWithRepo {
    #[sea_orm(nested)]
    pr: merge_pull_requests::Model,
    full_name: String,
    team_id: Option<String>,
}

impl PullRequestWithRepo {
    /// `select to_jsonb(p), r.full_name, r.team_id from merge_pull_requests p
    /// inner join merge_repositories r on r.id = p.repository_id where
    /// r.deleted_at is null`.
    fn query() -> sea_orm::Select<merge_pull_requests::Entity> {
        merge_pull_requests::Entity::find()
            .column_as(merge_repositories::Column::FullName, "full_name")
            .column_as(merge_repositories::Column::TeamId, "team_id")
            .join(JoinType::InnerJoin, pull_request_repository())
            .filter(merge_repositories::Column::DeletedAt.is_null())
    }

    fn into_row(self) -> Result<WithRepo, DbErr> {
        Ok(WithRepo {
            pr: json_row(serde_json::to_value(self.pr))?,
            full_name: self.full_name,
            team_id: self.team_id,
        })
    }
}

/// `pull_request.repository_id = repository.id`.
fn pull_request_repository() -> RelationDef {
    merge_pull_requests::Entity::belongs_to(merge_repositories::Entity)
        .from(merge_pull_requests::Column::RepositoryId)
        .to(merge_repositories::Column::Id)
        .into()
}

/// Pull requests of live repositories matching `filter`, newest update first.
pub(crate) async fn query_pull_requests(
    db: &PgPool,
    filter: Filter,
    limit: i64,
) -> Result<Vec<WithRepo>, DbErr> {
    let mut select = PullRequestWithRepo::query();
    if let Some(state) = filter.state {
        select = select.filter(merge_pull_requests::Column::State.eq(state));
    }
    if let Some(draft) = filter.draft {
        select = select.filter(merge_pull_requests::Column::Draft.eq(draft));
    }
    if let Some(login) = filter.review_requested_from {
        select = select.filter(sea_orm::sea_query::extension::postgres::PgExpr::contains(
            merge_pull_requests::Column::RequestedReviewers.into_expr(),
            json!([{ "kind": "user", "login": login }]),
        ));
    }
    if let Some((user_id, login)) = filter.authored_by {
        let mut authored =
            Condition::any().add(merge_pull_requests::Column::AuthorUserId.eq(user_id));
        if let Some(login) = login {
            authored = authored.add(merge_pull_requests::Column::AuthorLogin.eq(login));
        }
        select = select.filter(authored);
    }
    if let Some(repository_id) = filter.repository_id {
        select = select.filter(merge_pull_requests::Column::RepositoryId.eq(repository_id));
    }
    if let Some(team_id) = filter.team_id {
        select = select.filter(merge_repositories::Column::TeamId.eq(team_id));
    }
    if let Some(pattern) = filter.pattern {
        let mut search = Condition::any()
            .add(ilike(merge_pull_requests::Column::Title, &pattern))
            .add(ilike(merge_pull_requests::Column::HeadRef, &pattern))
            .add(ilike(merge_repositories::Column::FullName, &pattern));
        if let Some(number) = filter.number {
            search = search.add(merge_pull_requests::Column::Number.eq(number));
        }
        select = select.filter(search);
    }
    if let Some((at, id)) = filter.cursor {
        // `(provider_updated_at, id) < ($at, $id)`.
        select = select.filter(sea_orm::ExprTrait::lt(
            Expr::tuple([
                merge_pull_requests::Column::ProviderUpdatedAt.into_expr(),
                merge_pull_requests::Column::Id.into_expr(),
            ]),
            Expr::tuple([Expr::value(instant(&at)?), Expr::value(id)]),
        ));
    }
    if let Some(status) = filter.checks_status {
        select = select.filter(merge_pull_requests::Column::ChecksStatus.eq(status));
    }
    if let Some(decision) = filter.review_decision {
        select = select.filter(merge_pull_requests::Column::ReviewDecision.eq(decision));
    }
    if let Some(since) = filter.merged_since {
        select = select.filter(merge_pull_requests::Column::MergedAt.gte(since));
    }
    select
        .order_by_desc(merge_pull_requests::Column::ProviderUpdatedAt)
        .order_by_desc(merge_pull_requests::Column::Id)
        .limit(u64::try_from(limit).unwrap_or(0))
        .into_model::<PullRequestWithRepo>()
        .all(&orm(db))
        .await?
        .into_iter()
        .map(PullRequestWithRepo::into_row)
        .collect()
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
pub(crate) struct ListQuery {
    view: String,
    repository_id: Option<String>,
    team_id: Option<String>,
    q: Option<String>,
    limit: i64,
    cursor: Option<String>,
}

/// `listMergePullRequestsQuerySchema` read from `fields` (a query string's
/// values, or a WeldAgent tool's input).
pub(crate) fn read_list_query(
    issues: &mut weldsuite_kit::validation::Issues,
    fields: &Map<String, Value>,
) -> ListQuery {
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
}

fn list_query(query: Option<&str>) -> Result<ListQuery, Refusal> {
    validate_query(query, read_list_query)
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
    let (items, has_more, cursor) = list_pull_requests(&caller.db, query, &caller.user_id).await?;
    Ok(page(items, has_more, cursor))
}

/// `listPullRequests(db, query, userId)`: the page's items, whether there
/// is more, and the next cursor.
pub(crate) async fn list_pull_requests(
    db: &PgPool,
    query: ListQuery,
    user_id: &str,
) -> Result<(Vec<Value>, bool, Option<String>), DbErr> {
    let mut filter = Filter::default();
    match query.view.as_str() {
        view @ ("needs_review" | "mine") => {
            let login = member_github_login(db, user_id)
                .await?
                .filter(|l| !l.is_empty());
            filter.state = Some("open");
            if view == "needs_review" {
                let Some(login) = login else {
                    return Ok((Vec::new(), false, None));
                };
                filter.draft = Some(false);
                filter.review_requested_from = Some(login);
            } else {
                filter.authored_by = Some((user_id.to_owned(), login));
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
    Ok((items, has_more, cursor))
}

/// `findPullRequest(db, id)`: a pull request of a live repository.
async fn find_pull_request(db: &PgPool, id: &str) -> Result<Option<WithRepo>, DbErr> {
    PullRequestWithRepo::query()
        .filter(merge_pull_requests::Column::Id.eq(id))
        .into_model::<PullRequestWithRepo>()
        .one(&orm(db))
        .await?
        .map(PullRequestWithRepo::into_row)
        .transpose()
}

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Answer {
    match pull_request_detail(&caller.db, &id).await? {
        Some(detail) => Ok(Data(detail).into_response()),
        None => Err(Refusal::not_found("Pull request", Some(&id))),
    }
}

/// `getPullRequestDetail(db, id)`: a pull request of a live repository with
/// the issues it is linked to.
pub(crate) async fn pull_request_detail(db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
    let Some(row) = find_pull_request(db, id).await? else {
        return Ok(None);
    };
    let mut issues = linked_issues(db, &[id.to_owned()]).await?;
    let mut detail: Map<String, Value> = pull_request_summary(&row.pr, &row.full_name);
    detail.insert("body".to_owned(), col(&row.pr, "body"));
    detail.insert("headSha".to_owned(), col(&row.pr, "headSha"));
    detail.insert("teamId".to_owned(), json!(row.team_id));
    detail.insert(
        "issues".to_owned(),
        Value::Array(issues.remove(id).unwrap_or_default()),
    );
    detail.insert("syncedAt".to_owned(), col(&row.pr, "syncedAt"));
    Ok(Some(Value::Object(detail)))
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
    let orm_db = orm(db);
    let existing = merge_issue_pull_requests::Entity::find()
        .select_only()
        .column(merge_issue_pull_requests::Column::Id)
        .column(merge_issue_pull_requests::Column::DismissedAt)
        .filter(merge_issue_pull_requests::Column::IssueId.eq(&id))
        .filter(merge_issue_pull_requests::Column::PullRequestId.eq(&pull_request_id))
        .into_tuple::<(String, Option<OffsetDateTime>)>()
        .one(&orm_db)
        .await?
        .map(|(link_id, dismissed_at)| (link_id, dismissed_at.is_some()));
    let mut events: Vec<PendingEvent> = Vec::new();
    if let Some((link_id, true)) = &existing {
        // A dismissed automatic link, linked again by hand: it is a manual link now, and new.
        merge_issue_pull_requests::Entity::update_many()
            .col_expr(
                merge_issue_pull_requests::Column::Source,
                Expr::value("manual"),
            )
            .col_expr(
                merge_issue_pull_requests::Column::Closes,
                Expr::value(closes),
            )
            .col_expr(
                merge_issue_pull_requests::Column::DismissedAt,
                Expr::value(Option::<OffsetDateTime>::None),
            )
            .col_expr(
                merge_issue_pull_requests::Column::CreatedByUserId,
                Expr::value(caller.user_id.clone()),
            )
            .filter(merge_issue_pull_requests::Column::Id.eq(link_id))
            .exec(&orm_db)
            .await?;
        let phase = phase_of(&target.pr);
        let mut links = [LinkedIssue {
            closes,
            is_new: true,
            issue: issue.clone(),
            team_key: team_key.clone(),
        }];
        events = run_automation(db, &target.pr, Some(phase), &mut links, None).await?;
    } else if let Some((link_id, false)) = existing {
        merge_issue_pull_requests::Entity::update_many()
            .col_expr(
                merge_issue_pull_requests::Column::Closes,
                Expr::value(closes),
            )
            .filter(merge_issue_pull_requests::Column::Id.eq(link_id))
            .exec(&orm_db)
            .await?;
    } else {
        merge_issue_pull_requests::Entity::insert(merge_issue_pull_requests::ActiveModel {
            id: Set(generate_id("mip")),
            issue_id: Set(id.clone()),
            pull_request_id: Set(pull_request_id.clone()),
            source: Set("manual".to_owned()),
            closes: Set(closes),
            created_by_user_id: Set(Some(caller.user_id.clone())),
            ..Default::default()
        })
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_without_returning(&orm_db)
        .await?;
        let phase = phase_of(&target.pr);
        let mut links = [LinkedIssue {
            closes,
            is_new: true,
            issue: issue.clone(),
            team_key: team_key.clone(),
        }];
        events = run_automation(db, &target.pr, Some(phase), &mut links, None).await?;
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
    let detail = crate::record_links::visible_detail(&caller, detail).await?;
    Ok(Data(detail).into_response())
}

/// `DELETE /issues/:id/pull-requests/:prId`: removes a link. A manual link
/// is deleted; an `auto` link is kept with `dismissed_at` set instead, so it
/// stays removed: sync skips dismissed pairs even while the pull request
/// still mentions the key.
pub(crate) async fn unlink(
    State(state): State<MergeState>,
    caller: Caller,
    Path((id, pr_id)): Path<(String, String)>,
) -> Answer {
    let db = &caller.db;
    let Some(issue) = find_issue(db, &id).await? else {
        return Err(Refusal::not_found("Issue", Some(&id)));
    };
    let orm_db = orm(db);
    let (_, at) = now_at();
    let mut removed = merge_issue_pull_requests::Entity::update_many()
        .col_expr(
            merge_issue_pull_requests::Column::DismissedAt,
            Expr::value(at),
        )
        .filter(merge_issue_pull_requests::Column::IssueId.eq(&id))
        .filter(merge_issue_pull_requests::Column::PullRequestId.eq(&pr_id))
        .filter(merge_issue_pull_requests::Column::DismissedAt.is_null())
        .filter(merge_issue_pull_requests::Column::Source.eq("auto"))
        .exec(&orm_db)
        .await?
        .rows_affected;
    if removed == 0 {
        removed = merge_issue_pull_requests::Entity::delete_many()
            .filter(merge_issue_pull_requests::Column::IssueId.eq(&id))
            .filter(merge_issue_pull_requests::Column::PullRequestId.eq(&pr_id))
            .filter(merge_issue_pull_requests::Column::DismissedAt.is_null())
            .filter(merge_issue_pull_requests::Column::Source.eq("manual"))
            .exec(&orm_db)
            .await?
            .rows_affected;
    }
    if removed == 0 {
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
