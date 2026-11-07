//! Issues, WeldMerge's own records (ADR MERGE-003), keyed `<team key>-<number>`:
//! `/api/merge/issues`.
//!
//! ```text
//!   GET    /          → list (teamId, status csv, assignee me|none|<user>, cycleId, labelId, parentIssueId, q; cursor)
//!   GET    /:idOrKey  → detail by id or key (PLAT-209), with linked pull requests and sub-issues
//!   POST   /          → new issue; the team's next number is allocated with the insert
//!   PATCH  /:id       → edit (never the team); status changes keep started/completed timestamps;
//!                       a new `agentId` must be an active agent the caller could use, else 422 `invalid_agent`
//!   DELETE /:id       → soft delete
//! ```
//!
//! Permissions: `merge_issues:read | create | update | delete`. Comments are in
//! [`crate::comments`], pull request links in [`crate::pull_requests`].

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_chat_domain::agents::{AgentAccess, AgentViewer, can_access_agent};
use weldsuite_db::PgPool;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};

use crate::automation::{StatusTimestamps, status_timestamps};
use crate::db::{Row, col, like_pattern, one_by_id, opt_text, rows_of, text};
use crate::keys::parse_issue_key;
use crate::labels::count_usable;
use crate::mappers::{
    issue_dto, issue_event_data, pull_request_summary, record_link_dto, record_link_event_data,
};
use crate::record_links::{RecordLinkInput, insert_record_links, list_record_links, read_link};
use crate::schemas::{ISSUE_STATUSES, date_only, nothing_to_update, priority};
use crate::teams::find_team;
use crate::{
    Answer, Caller, MergeState, PendingEvent, Refusal, now, page, publish, validate, validate_query,
};

// ── Reading ─────────────────────────────────────────────────────────────────

/// `hydrateIssues(db, rows)`: issue rows to DTOs, with the team key and the
/// linked pull request count.
pub(crate) async fn hydrate_issues(db: &PgPool, rows: &[Row]) -> Result<Vec<Value>, sqlx::Error> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut team_ids: Vec<String> = Vec::new();
    for row in rows {
        let team = text(row, "teamId").to_owned();
        if !team_ids.contains(&team) {
            team_ids.push(team);
        }
    }
    let keys: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("select id, key from merge_teams where id = any($1)")
            .bind(&team_ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .collect();
    let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
    let counts: HashMap<String, i64> = sqlx::query_as::<_, (String, i32)>(
        "select issue_id, count(*)::int from merge_issue_pull_requests \
         where issue_id = any($1) and dismissed_at is null group by issue_id",
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
            let key = keys.get(text(row, "teamId")).map_or("", String::as_str);
            issue_dto(row, key, counts.get(text(row, "id")).copied().unwrap_or(0))
        })
        .collect())
}

/// One issue as a DTO.
pub(crate) async fn one_dto(db: &PgPool, row: &Row) -> Result<Value, sqlx::Error> {
    Ok(hydrate_issues(db, std::slice::from_ref(row))
        .await?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

/// `findIssue(db, id)`: a live issue.
pub(crate) async fn find_issue(db: &PgPool, id: &str) -> Result<Option<Row>, sqlx::Error> {
    one_by_id(
        db,
        "select to_jsonb(i) from merge_issues i where i.id = $1 and i.deleted_at is null limit 1",
        id,
    )
    .await
}

/// `findIssueByIdOrKey(db, idOrKey)`: by id, or by key (`PLAT-209`).
pub(crate) async fn find_issue_by_id_or_key(
    db: &PgPool,
    id_or_key: &str,
) -> Result<Option<Row>, sqlx::Error> {
    let Some(key) = parse_issue_key(id_or_key) else {
        return find_issue(db, id_or_key).await;
    };
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(i) from merge_issues i inner join merge_teams t on t.id = i.team_id \
         where t.key = $1 and t.deleted_at is null and i.number = $2 and i.deleted_at is null limit 1",
    )
    .bind(&key.team_key)
    .bind(key.number)
    .fetch_optional(db)
    .await?;
    Ok(row.map(weldsuite_db::js_row))
}

/// `getIssueDetail(db, idOrKey)`.
pub(crate) async fn issue_detail(
    db: &PgPool,
    id_or_key: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(row) = find_issue_by_id_or_key(db, id_or_key).await? else {
        return Ok(None);
    };
    let id = text(&row, "id").to_owned();
    let sub_rows = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(i) from merge_issues i where i.parent_issue_id = $1 and i.deleted_at is null \
             order by i.number asc",
        )
        .bind(&id)
        .fetch_all(db)
        .await?,
    );
    let base = one_dto(db, &row).await?;
    let sub_issues = hydrate_issues(db, &sub_rows).await?;
    let linked: Vec<(Value, String, String, bool)> = sqlx::query_as(
        "select to_jsonb(p), r.full_name, l.source, l.closes from merge_issue_pull_requests l \
         inner join merge_pull_requests p on p.id = l.pull_request_id \
         inner join merge_repositories r on r.id = p.repository_id \
         where l.issue_id = $1 and l.dismissed_at is null and r.deleted_at is null \
         order by p.provider_updated_at desc, p.id desc",
    )
    .bind(&id)
    .fetch_all(db)
    .await?;
    // The provider issue it syncs with, and the records it is linked to.
    let external: Option<(Value, String)> = sqlx::query_as(
        "select to_jsonb(x), r.full_name from merge_external_issues x \
         inner join merge_repositories r on r.id = x.repository_id \
         where x.issue_id = $1 limit 1",
    )
    .bind(&id)
    .fetch_optional(db)
    .await?;
    let external = external.map_or(Value::Null, |(link, full_name)| {
        let link = weldsuite_db::js_row(link);
        json!({
            "provider": col(&link, "provider"),
            "number": col(&link, "number"),
            "url": col(&link, "url"),
            "state": col(&link, "state"),
            "repositoryId": col(&link, "repositoryId"),
            "repositoryFullName": full_name,
        })
    });
    let record_links: Vec<Value> = list_record_links(db, &id)
        .await?
        .iter()
        .map(record_link_dto)
        .collect();
    let pull_requests: Vec<Value> = linked
        .into_iter()
        .map(|(pr, full_name, source, closes)| {
            let mut summary = pull_request_summary(&weldsuite_db::js_row(pr), &full_name);
            summary.insert(
                "link".to_owned(),
                json!({ "source": source, "closes": closes }),
            );
            Value::Object(summary)
        })
        .collect();
    let mut detail = match base {
        Value::Object(fields) => fields,
        _ => Map::new(),
    };
    detail.insert("external".to_owned(), external);
    detail.insert("recordLinks".to_owned(), Value::Array(record_links));
    detail.insert("pullRequests".to_owned(), Value::Array(pull_requests));
    detail.insert("subIssues".to_owned(), Value::Array(sub_issues));
    Ok(Some(Value::Object(detail)))
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// `listMergeIssuesQuerySchema`, as validated.
pub(crate) struct ListQuery {
    team_id: Option<String>,
    status: Vec<String>,
    assignee: Option<String>,
    cycle_id: Option<String>,
    label_id: Option<String>,
    parent_issue_id: Option<String>,
    q: Option<String>,
    limit: i64,
    cursor: Option<String>,
}

/// `z.coerce.number().int().min(1).max(200).default(50)`.
pub(crate) fn limit_of(issues: &mut Issues, fields: &Map<String, Value>) -> i64 {
    let rules = Number {
        coerce: true,
        int: true,
        min: Some(1.0),
        max: Some(200.0),
    };
    #[allow(clippy::cast_possible_truncation)]
    match issues.number(fields, "limit", Presence::Optional, rules) {
        Field::Set(limit) => limit as i64,
        _ => 50,
    }
}

/// `csv(z.enum(MERGE_ISSUE_STATUSES))`: a comma-separated list, each item
/// trimmed and empty ones dropped, then checked as an enum. The pipe settles
/// after the query's synchronous checks, so its issues are read last.
fn statuses(issues: &mut Issues, raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Vec::new();
    };
    let items: Vec<Value> = raw
        .split(',')
        .map(|s| weldsuite_kit::validation::js_trim(s).to_owned())
        .filter(|s| !s.is_empty())
        .map(Value::String)
        .collect();
    let mut holder = Map::new();
    holder.insert("status".to_owned(), Value::Array(items));
    issues
        .list(
            &holder,
            "status",
            Presence::Required,
            None,
            None,
            |issues, item| issues.item_choice(item, &ISSUE_STATUSES),
        )
        .into_option()
        .unwrap_or_default()
}

/// `listMergeIssuesQuerySchema` read from `fields` (a query string's values,
/// or a WeldAgent tool's input).
pub(crate) fn read_list_query(issues: &mut Issues, fields: &Map<String, Value>) -> ListQuery {
    let opt = |issues: &mut Issues, key: &str| {
        issues
            .text(fields, key, Presence::Optional, None, None)
            .into_option()
    };
    let team_id = opt(issues, "teamId");
    let status_raw = opt(issues, "status");
    let assignee = opt(issues, "assignee");
    let cycle_id = opt(issues, "cycleId");
    let label_id = opt(issues, "labelId");
    let parent_issue_id = opt(issues, "parentIssueId");
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
    let status = statuses(issues, status_raw.as_deref());
    ListQuery {
        team_id,
        status,
        assignee,
        cycle_id,
        label_id,
        parent_issue_id,
        q,
        limit,
        cursor,
    }
}

fn list_query(query: Option<&str>) -> Result<ListQuery, Refusal> {
    validate_query(query, read_list_query)
}

/// A page of issue rows (`listIssues`'s result).
pub(crate) struct IssuePage {
    pub(crate) rows: Vec<Row>,
    pub(crate) has_more: bool,
    pub(crate) cursor: Option<String>,
}

/// Newest first (by id, which leads with the creation time); the cursor is
/// the last id of the page.
pub(crate) async fn list(caller: Caller, RawQuery(query): RawQuery) -> Answer {
    let query = list_query(query.as_deref())?;
    let db = &caller.db;
    let found = list_issues(db, &query, &caller.user_id).await?;
    let dtos = hydrate_issues(db, &found.rows).await?;
    Ok(page(dtos, found.has_more, found.cursor))
}

/// `listIssues(db, query, userId)`.
pub(crate) async fn list_issues(
    db: &PgPool,
    query: &ListQuery,
    user_id: &str,
) -> Result<IssuePage, sqlx::Error> {
    let truthy = |value: &Option<String>| value.clone().filter(|v| !v.is_empty());
    let (unassigned, assignee) = match query.assignee.as_deref() {
        Some("none") => (true, None),
        Some("me") => (false, Some(user_id.to_owned())),
        Some(other) if !other.is_empty() => (false, Some(other.to_owned())),
        _ => (false, None),
    };
    let q = truthy(&query.q);
    // An exact key (`PLAT-209`) also finds the issue by its team and number.
    let mut key_team: Option<String> = None;
    let mut key_number: Option<i64> = None;
    if let Some(key) = q.as_deref().and_then(parse_issue_key) {
        key_team = sqlx::query_scalar(
            "select id from merge_teams where key = $1 and deleted_at is null limit 1",
        )
        .bind(&key.team_key)
        .fetch_optional(db)
        .await?;
        key_number = key_team.as_ref().map(|_| key.number);
    }
    let label = truthy(&query.label_id).map(|label| json!([label]));
    let statuses = (!query.status.is_empty()).then(|| query.status.clone());
    let rows = rows_of(
        sqlx::query_scalar(
            "select to_jsonb(i) from merge_issues i where i.deleted_at is null \
             and ($1::text is null or i.team_id = $1) \
             and ($2::text[] is null or i.status = any($2)) \
             and (not $3 or i.assignee_user_id is null) \
             and ($4::text is null or i.assignee_user_id = $4) \
             and ($5::text is null or i.cycle_id = $5) \
             and ($6::jsonb is null or i.label_ids @> $6) \
             and ($7::text is null or i.parent_issue_id = $7) \
             and ($8::text is null or i.title ilike $8 escape '\\' \
                  or ($9::text is not null and i.team_id = $9 and i.number = $10)) \
             and ($11::text is null or i.id < $11) \
             order by i.id desc limit $12",
        )
        .bind(truthy(&query.team_id))
        .bind(statuses)
        .bind(unassigned)
        .bind(assignee)
        .bind(truthy(&query.cycle_id))
        .bind(label)
        .bind(truthy(&query.parent_issue_id))
        .bind(q.as_deref().map(like_pattern))
        .bind(key_team)
        .bind(key_number)
        .bind(truthy(&query.cursor))
        .bind(query.limit + 1)
        .fetch_all(db)
        .await?,
    );
    let limit = usize::try_from(query.limit).unwrap_or(0);
    let has_more = rows.len() > limit;
    let page_rows: Vec<Row> = rows.into_iter().take(limit).collect();
    let cursor = has_more
        .then(|| page_rows.last().map(|r| text(r, "id").to_owned()))
        .flatten();
    Ok(IssuePage {
        rows: page_rows,
        has_more,
        cursor,
    })
}

// ── GET /:idOrKey ───────────────────────────────────────────────────────────

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Answer {
    match issue_detail(&caller.db, &id).await? {
        Some(detail) => {
            Ok(Data(crate::record_links::visible_detail(&caller, detail).await?).into_response())
        }
        None => Err(Refusal::not_found("Issue", Some(&id))),
    }
}

// ── Validation of references ────────────────────────────────────────────────

/// Why a reference was refused (`IssueRefFailure`).
#[derive(Debug, Clone, Copy)]
pub(crate) enum RefFailure {
    Cycle,
    Parent,
    Labels,
}

impl RefFailure {
    /// The route's 400 message, and an internal caller's `refMessage`.
    pub(crate) const fn message(self) -> &'static str {
        match self {
            Self::Cycle => "The cycle does not exist or belongs to another team",
            Self::Parent => {
                "The parent issue must be another issue of the same team, and not one of its own sub-issues"
            }
            Self::Labels => "A label does not exist or belongs to another team",
        }
    }

    fn refusal(self) -> Refusal {
        Refusal::bad_request(self.message())
    }
}

/// `validateRefs(db, teamId, refs)`: cycle, parent and labels must belong to
/// the issue's team (labels may also be workspace-wide).
async fn validate_refs(
    db: &PgPool,
    team_id: &str,
    cycle_id: Option<&str>,
    parent_issue_id: Option<&str>,
    label_ids: Option<&[String]>,
    self_id: Option<&str>,
) -> Result<Option<RefFailure>, sqlx::Error> {
    if let Some(cycle) = cycle_id.filter(|c| !c.is_empty()) {
        let found: Option<String> = sqlx::query_scalar(
            "select id from merge_cycles where id = $1 and team_id = $2 and deleted_at is null limit 1",
        )
        .bind(cycle)
        .bind(team_id)
        .fetch_optional(db)
        .await?;
        if found.is_none() {
            return Ok(Some(RefFailure::Cycle));
        }
    }
    if let Some(parent_id) = parent_issue_id.filter(|p| !p.is_empty()) {
        if self_id == Some(parent_id) {
            return Ok(Some(RefFailure::Parent));
        }
        let Some(parent) = find_issue(db, parent_id).await? else {
            return Ok(Some(RefFailure::Parent));
        };
        if text(&parent, "teamId") != team_id {
            return Ok(Some(RefFailure::Parent));
        }
        // Walk up: the issue must not be one of its own ancestors.
        if let Some(self_id) = self_id {
            let mut cursor = opt_text(&parent, "parentIssueId").filter(|c| !c.is_empty());
            let mut depth = 0;
            while let Some(current) = cursor {
                if depth >= 50 {
                    break;
                }
                if current == self_id {
                    return Ok(Some(RefFailure::Parent));
                }
                cursor = find_issue(db, &current)
                    .await?
                    .and_then(|next| opt_text(&next, "parentIssueId"))
                    .filter(|c| !c.is_empty());
                depth += 1;
            }
        }
    }
    if let Some(labels) = label_ids.filter(|l| !l.is_empty()) {
        let unique = unique(labels);
        if count_usable(db, &unique, team_id).await? != unique.len() {
            return Ok(Some(RefFailure::Labels));
        }
    }
    Ok(None)
}

/// `[...new Set(items)]`.
fn unique(items: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        if !out.contains(item) {
            out.push(item.clone());
        }
    }
    out
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// The fields `createMergeIssueSchema` and `updateMergeIssueSchema` share.
pub(crate) struct IssueInput {
    team_id: Field<String>,
    title: Field<String>,
    description: Field<String>,
    status: Field<String>,
    priority: Field<i64>,
    assignee_user_id: Field<String>,
    cycle_id: Field<String>,
    parent_issue_id: Field<String>,
    label_ids: Field<Vec<String>>,
    estimate: Field<i64>,
    due_date: Field<String>,
    flow_project_id: Field<String>,
    /// `updateMergeIssueSchema` only.
    agent_id: Field<String>,
    sort_order: Field<f64>,
    /// `createMergeIssueSchema` only: records to link the new issue to.
    links: Vec<RecordLinkInput>,
}

/// `createMergeIssueSchema` (`partial` false) or `updateMergeIssueSchema`.
impl IssueInput {
    /// Whether the input names an agent (`input.agentId` truthy): the
    /// assigner then matters.
    pub(crate) fn names_agent(&self) -> bool {
        self.agent_id
            .as_set()
            .is_some_and(|agent| !agent.is_empty())
    }
}

fn issue_input(headers: &HeaderMap, body: &Bytes, partial: bool) -> Result<IssueInput, Refusal> {
    validate(headers, body, |issues, fields| {
        read_issue_input(issues, fields, partial)
    })
}

/// `createMergeIssueSchema` (`partial` false) or `updateMergeIssueSchema`
/// read from `fields` (a body, or an internal caller's input).
pub(crate) fn read_issue_input(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    partial: bool,
) -> IssueInput {
    {
        let start = issues.count();
        let (required, nullish) = if partial {
            (Presence::Optional, Presence::Nullish)
        } else {
            (Presence::Required, Presence::Nullish)
        };
        let team_id = if partial {
            Field::Absent
        } else {
            issues.text(fields, "teamId", Presence::Required, Some(1), None)
        };
        let title = issues.text_with(fields, "title", required, Text::trimmed(Some(1), Some(500)));
        let description = issues.text(fields, "description", nullish, None, Some(100_000));
        let status = issues.choice(fields, "status", Presence::Optional, &ISSUE_STATUSES);
        let (priority, priority_issue) = priority(issues, fields);
        let assignee_user_id = issues.text(fields, "assigneeUserId", nullish, None, None);
        let cycle_id = issues.text(fields, "cycleId", nullish, None, None);
        let parent_issue_id = issues.text(fields, "parentIssueId", nullish, None, None);
        let label_ids = issues.list(
            fields,
            "labelIds",
            Presence::Optional,
            None,
            Some(20),
            |issues, item| issues.item_text(item, Text::default()),
        );
        let estimate = issues.whole_number(
            fields,
            "estimate",
            nullish,
            Number {
                min: Some(0.0),
                max: Some(1000.0),
                ..Number::default()
            },
        );
        let due_date = date_only(issues, fields, "dueDate", nullish);
        let flow_project_id = issues.text(fields, "flowProjectId", nullish, None, None);
        // `.partial()` makes the nullable `agentId` optional too.
        let agent_id = if partial {
            issues.text(fields, "agentId", Presence::Nullish, None, Some(30))
        } else {
            Field::Absent
        };
        let sort_order = if partial {
            issues.number(fields, "sortOrder", Presence::Optional, Number::default())
        } else {
            Field::Absent
        };
        let links = if partial {
            Vec::new()
        } else {
            issues
                .list(
                    fields,
                    "links",
                    Presence::Optional,
                    None,
                    Some(20),
                    read_link,
                )
                .into_option()
                .unwrap_or_default()
        };
        // The literal union settles after the synchronous checks.
        if let Some(issue) = priority_issue {
            issues.push_raw(issue);
        }
        if partial {
            nothing_to_update(
                issues,
                start,
                fields,
                &[
                    "title",
                    "description",
                    "status",
                    "priority",
                    "assigneeUserId",
                    "cycleId",
                    "parentIssueId",
                    "labelIds",
                    "estimate",
                    "dueDate",
                    "flowProjectId",
                    "agentId",
                    "sortOrder",
                ],
            );
        }
        IssueInput {
            team_id,
            title,
            description,
            status,
            priority,
            assignee_user_id,
            cycle_id,
            parent_issue_id,
            label_ids,
            estimate,
            due_date,
            flow_project_id,
            agent_id,
            sort_order,
            links,
        }
    }
}

/// The status timestamps of a row.
pub(crate) fn timestamps_of(row: &Row) -> StatusTimestamps {
    StatusTimestamps {
        started_at: opt_text(row, "startedAt"),
        completed_at: opt_text(row, "completedAt"),
        canceled_at: opt_text(row, "canceledAt"),
    }
}

pub(crate) fn issue_event(row: &Row, team_key: &str, action: &'static str) -> PendingEvent {
    PendingEvent::new(
        "merge_issue",
        action,
        text(row, "id"),
        issue_event_data(row, team_key, None),
    )
}

/// Why an issue was not created (`IssueCreateResult`'s failure).
#[derive(Debug, Clone, Copy)]
pub(crate) enum CreateFailure {
    TeamNotFound,
    Ref(RefFailure),
}

/// A created issue, its team and the records it was linked to.
pub(crate) struct CreatedIssue {
    pub(crate) issue: Row,
    pub(crate) team: Row,
    pub(crate) links: Vec<Row>,
}

impl CreatedIssue {
    /// `merge_issue` created, then `merge_record_link` created per link.
    pub(crate) fn events(&self) -> Vec<PendingEvent> {
        let mut events = vec![issue_event(&self.issue, text(&self.team, "key"), "created")];
        events.extend(self.links.iter().map(|link| {
            PendingEvent::new(
                "merge_record_link",
                "created",
                text(link, "id"),
                record_link_event_data(link),
            )
        }));
        events
    }
}

/// `POST /`: the route around [`create_issue`].
pub(crate) async fn create(
    State(state): State<MergeState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = issue_input(&headers, &body, false)?;
    let db = &caller.db;
    let created = match create_issue(db, input, &caller.user_id).await? {
        Ok(created) => created,
        Err(CreateFailure::TeamNotFound) => return Err(Refusal::not_found("Team", None)),
        Err(CreateFailure::Ref(failure)) => return Err(failure.refusal()),
    };
    publish(&state, &caller.events, created.events());
    crate::hooks::after_issue_created(
        &caller.hook_context(&state),
        &created.issue,
        text(&created.team, "key"),
    )
    .await;
    Ok(Created(one_dto(db, &created.issue).await?).into_response())
}

/// `createIssue(db, input, userId)`. One statement takes the team's next
/// number and inserts the issue, so the allocation and the row commit
/// together: a failed insert hands no number out, and concurrent creates
/// never share one.
pub(crate) async fn create_issue(
    db: &PgPool,
    input: IssueInput,
    user_id: &str,
) -> Result<Result<CreatedIssue, CreateFailure>, sqlx::Error> {
    let team_id = input.team_id.into_option().unwrap_or_default();
    let Some(team) = find_team(db, &team_id).await? else {
        return Ok(Err(CreateFailure::TeamNotFound));
    };
    let label_ids = unique(&input.label_ids.into_option().unwrap_or_default());
    let cycle_id = input.cycle_id.into_option();
    let parent_issue_id = input.parent_issue_id.into_option();
    if let Some(failure) = validate_refs(
        db,
        text(&team, "id"),
        cycle_id.as_deref(),
        parent_issue_id.as_deref(),
        Some(&label_ids),
        None,
    )
    .await?
    {
        return Ok(Err(CreateFailure::Ref(failure)));
    }
    let now = now();
    let status = input
        .status
        .into_option()
        .unwrap_or_else(|| "backlog".to_owned());
    let stamps = status_timestamps(&status, &StatusTimestamps::default(), &now);
    let id = generate_id("mis");
    let inserted: Vec<String> = sqlx::query_scalar(
        "with next as ( \
           update merge_teams set issue_counter = issue_counter + 1 \
           where id = $1::varchar and deleted_at is null \
           returning issue_counter \
         ) \
         insert into merge_issues ( \
           id, team_id, number, title, description, status, priority, assignee_user_id, creator_user_id, \
           cycle_id, parent_issue_id, label_ids, estimate, due_date, flow_project_id, sort_order, \
           started_at, completed_at, canceled_at, created_at, updated_at \
         ) \
         select $2::varchar, $1::varchar, next.issue_counter, $3::varchar, $4::text, $5::varchar, $6::int, \
           $7::varchar, $8::varchar, $9::varchar, $10::varchar, $11::jsonb, $12::int, $13::date, \
           $14::varchar, 0::double precision, \
           $15::timestamptz, $16::timestamptz, $17::timestamptz, $18::timestamptz, $18::timestamptz \
         from next returning id",
    )
    .bind(text(&team, "id"))
    .bind(&id)
    .bind(input.title.into_option().unwrap_or_default())
    .bind(input.description.into_option())
    .bind(&status)
    .bind(input.priority.into_option().unwrap_or(0))
    .bind(input.assignee_user_id.into_option())
    .bind(user_id)
    .bind(cycle_id)
    .bind(parent_issue_id)
    .bind(json!(label_ids))
    .bind(input.estimate.into_option())
    .bind(input.due_date.into_option())
    .bind(input.flow_project_id.into_option())
    .bind(stamps.started_at)
    .bind(stamps.completed_at)
    .bind(stamps.canceled_at)
    .bind(&now)
    .fetch_all(db)
    .await?;
    if inserted.is_empty() {
        return Ok(Err(CreateFailure::TeamNotFound));
    }
    let Some(issue) = find_issue(db, &id).await? else {
        return Ok(Err(CreateFailure::TeamNotFound));
    };
    let links = insert_record_links(db, &id, &input.links, Some(user_id)).await?;
    Ok(Ok(CreatedIssue { issue, team, links }))
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

/// `ISSUE_CHANGE_FIELDS`: what an update's `changes` compares.
pub(crate) const ISSUE_CHANGE_FIELDS: [&str; 12] = [
    "title",
    "description",
    "status",
    "priority",
    "assigneeUserId",
    "cycleId",
    "parentIssueId",
    "labelIds",
    "estimate",
    "dueDate",
    "flowProjectId",
    "agentId",
];

/// `diffFields(before, after, fields)`: the fields whose JSON differs, as
/// an entity event's `changes` (none when nothing did).
pub(crate) fn diff_fields(
    before: &Row,
    after: &Row,
    fields: &[&str],
) -> Option<Map<String, Value>> {
    let mut out = Map::new();
    for field in fields {
        let (old, new) = (col(before, field), col(after, field));
        #[allow(clippy::cmp_owned)] // `JSON.stringify` equality, as `diffFields` compares
        let differs = old.to_string() != new.to_string();
        if differs {
            out.insert((*field).to_owned(), json!({ "old": old, "new": new }));
        }
    }
    (!out.is_empty()).then_some(out)
}

/// A nullable field of a patch: `(set, value)`.
fn patch<T: Clone>(field: &Field<T>) -> (bool, Option<T>) {
    match field {
        Field::Absent => (false, None),
        Field::Null => (true, None),
        Field::Set(value) => (true, Some(value.clone())),
    }
}

/// A team's key, deleted or not (`select key from merge_teams where id`).
pub(crate) async fn team_key_of(db: &PgPool, team_id: &str) -> Result<String, sqlx::Error> {
    let key: Option<String> =
        sqlx::query_scalar("select key from merge_teams where id = $1 limit 1")
            .bind(team_id)
            .fetch_optional(db)
            .await?;
    Ok(key.unwrap_or_default())
}

/// Why an issue was not updated (`IssueUpdateResult`'s failure).
#[derive(Debug, Clone, Copy)]
pub(crate) enum UpdateFailure {
    NotFound,
    Ref(RefFailure),
    /// `agent_invalid`: a new agent that does not exist, is not active, or
    /// the assigner could not use.
    Agent,
}

/// What the route answers an `agent_invalid` with (422 `invalid_agent`).
pub(crate) const AGENT_INVALID_MESSAGE: &str =
    "The agent does not exist, is not active, or you cannot use it";

/// `AgentAssigner`: who assigns an issue to an agent, as an agent viewer
/// (`weldagent:manage` reaches every agent), and whether they hold
/// `weldagent:use`.
#[derive(Debug, Clone)]
pub(crate) struct AgentAssigner {
    pub(crate) viewer: AgentViewer,
    pub(crate) can_use: bool,
}

impl AgentAssigner {
    /// The request's member (`hasContextPermission`).
    pub(crate) fn of_caller(caller: &Caller) -> Self {
        Self {
            viewer: AgentViewer {
                user_id: caller.user_id.clone(),
                can_manage_all: caller.can("weldagent:manage"),
            },
            can_use: caller.can("weldagent:use"),
        }
    }
}

/// `canAssignAgent(db, agentId, assigner)`: the agent exists, is `active`,
/// and the assigner could use it themselves (`weldagent:use` and
/// `canAccessAgent`). Assigning runs the agent with the issue as its task.
pub(crate) async fn can_assign_agent(
    db: &PgPool,
    agent_id: &str,
    assigner: &AgentAssigner,
) -> Result<bool, sqlx::Error> {
    if !assigner.can_use {
        return Ok(false);
    }
    let agent: Option<(String, Option<String>, String, String)> = sqlx::query_as(
        "select id, owner_id, visibility, status from weldagent_agents \
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(agent_id)
    .fetch_optional(db)
    .await?;
    let Some((id, owner_id, visibility, status)) = agent else {
        return Ok(false);
    };
    if status != "active" {
        return Ok(false);
    }
    can_access_agent(
        db,
        &AgentAccess {
            id: &id,
            owner_id: owner_id.as_deref(),
            visibility: &visibility,
        },
        &assigner.viewer,
    )
    .await
}

/// An updated issue: the rows around the change and the team's key.
pub(crate) struct UpdatedIssue {
    pub(crate) before: Row,
    pub(crate) issue: Row,
    pub(crate) team_key: String,
}

impl UpdatedIssue {
    /// `merge_issue` updated, and `agent_assigned` too when an agent was
    /// newly assigned (agent-api runs that agent with the issue as its task).
    pub(crate) fn events(&self) -> Vec<PendingEvent> {
        let changes = diff_fields(&self.before, &self.issue, &ISSUE_CHANGE_FIELDS);
        let mut events =
            vec![issue_event(&self.issue, &self.team_key, "updated").with_changes(changes.clone())];
        let agent = self
            .issue
            .get("agentId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty());
        if let Some(agent) = agent
            && Some(agent) != self.before.get("agentId").and_then(Value::as_str)
        {
            events.push(
                issue_event(&self.issue, &self.team_key, "agent_assigned").with_changes(changes),
            );
        }
        events
    }
}

/// `PATCH /:id`: the route around [`update_issue`].
pub(crate) async fn update(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = issue_input(&headers, &body, true)?;
    let db = &caller.db;
    let assigner = AgentAssigner::of_caller(&caller);
    let updated = match update_issue(db, &id, &input, Some(&assigner)).await? {
        Ok(updated) => updated,
        Err(UpdateFailure::NotFound) => return Err(Refusal::not_found("Issue", Some(&id))),
        Err(UpdateFailure::Ref(failure)) => return Err(failure.refusal()),
        // Assigning runs the agent with the issue as its task: only an agent the caller could use.
        Err(UpdateFailure::Agent) => {
            return Err(ApiError::new(
                http::StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_agent",
                AGENT_INVALID_MESSAGE,
            )
            .into());
        }
    };
    publish(&state, &caller.events, updated.events());
    crate::hooks::after_issue_updated(
        &caller.hook_context(&state),
        &updated.before,
        &updated.issue,
        &updated.team_key,
    )
    .await;
    Ok(Data(one_dto(db, &updated.issue).await?).into_response())
}

/// `updateIssue(db, id, input, assigner)`. A new agent (one the issue does
/// not have yet) needs [`can_assign_agent`]; without an assigner (issue
/// sync) it is refused. Unassigning, or the agent the issue has, needs nothing.
pub(crate) async fn update_issue(
    db: &PgPool,
    id: &str,
    input: &IssueInput,
    agent_assigner: Option<&AgentAssigner>,
) -> Result<Result<UpdatedIssue, UpdateFailure>, sqlx::Error> {
    let Some(before) = find_issue(db, id).await? else {
        return Ok(Err(UpdateFailure::NotFound));
    };
    let label_ids = input.label_ids.as_set().map(|ids| unique(ids));
    if let Some(failure) = validate_refs(
        db,
        text(&before, "teamId"),
        input.cycle_id.as_set().map(String::as_str),
        input.parent_issue_id.as_set().map(String::as_str),
        label_ids.as_deref(),
        Some(id),
    )
    .await?
    {
        return Ok(Err(UpdateFailure::Ref(failure)));
    }
    if let Some(agent_id) = input.agent_id.as_set().filter(|agent| !agent.is_empty())
        && Some(agent_id.as_str()) != before.get("agentId").and_then(Value::as_str)
    {
        let allowed = match agent_assigner {
            Some(agent_assigner) => can_assign_agent(db, agent_id, agent_assigner).await?,
            None => false,
        };
        if !allowed {
            return Ok(Err(UpdateFailure::Agent));
        }
    }
    let now = now();
    let (set_description, description) = patch(&input.description);
    let (set_assignee, assignee) = patch(&input.assignee_user_id);
    let (set_cycle, cycle) = patch(&input.cycle_id);
    let (set_parent, parent) = patch(&input.parent_issue_id);
    let (set_estimate, estimate) = patch(&input.estimate);
    let (set_due, due) = patch(&input.due_date);
    let (set_flow, flow) = patch(&input.flow_project_id);
    let (set_agent, agent) = patch(&input.agent_id);
    // The status, with its timestamps, only when it changes.
    let status = input
        .status
        .as_set()
        .filter(|status| status.as_str() != text(&before, "status"))
        .cloned();
    let stamps = status
        .as_deref()
        .map(|status| status_timestamps(status, &timestamps_of(&before), &now));
    let row: Value = sqlx::query_scalar(
        "update merge_issues set updated_at = $2::timestamptz, \
           title = case when $3::text is null then title else $3 end, \
           description = case when $4 then $5 else description end, \
           priority = case when $6::int is null then priority else $6 end, \
           assignee_user_id = case when $7 then $8 else assignee_user_id end, \
           cycle_id = case when $9 then $10 else cycle_id end, \
           parent_issue_id = case when $11 then $12 else parent_issue_id end, \
           label_ids = case when $13::jsonb is null then label_ids else $13 end, \
           estimate = case when $14 then $15::int else estimate end, \
           due_date = case when $16 then $17::date else due_date end, \
           flow_project_id = case when $18 then $19 else flow_project_id end, \
           sort_order = case when $20::double precision is null then sort_order else $20 end, \
           status = case when $21::text is null then status else $21 end, \
           started_at = case when $21::text is null then started_at else $22::timestamptz end, \
           completed_at = case when $21::text is null then completed_at else $23::timestamptz end, \
           canceled_at = case when $21::text is null then canceled_at else $24::timestamptz end, \
           agent_id = case when $25 then $26 else agent_id end \
         where id = $1 returning to_jsonb(merge_issues.*)",
    )
    .bind(id)
    .bind(&now)
    .bind(input.title.as_set().cloned())
    .bind(set_description)
    .bind(description)
    .bind(input.priority.as_set().copied())
    .bind(set_assignee)
    .bind(assignee)
    .bind(set_cycle)
    .bind(cycle)
    .bind(set_parent)
    .bind(parent)
    .bind(label_ids.map(|ids| json!(ids)))
    .bind(set_estimate)
    .bind(estimate)
    .bind(set_due)
    .bind(due)
    .bind(set_flow)
    .bind(flow)
    .bind(input.sort_order.as_set().copied())
    .bind(&status)
    .bind(stamps.as_ref().and_then(|s| s.started_at.clone()))
    .bind(stamps.as_ref().and_then(|s| s.completed_at.clone()))
    .bind(stamps.as_ref().and_then(|s| s.canceled_at.clone()))
    .bind(set_agent)
    .bind(agent)
    .fetch_one(db)
    .await?;
    let issue = weldsuite_db::js_row(row);
    let team_key = team_key_of(db, text(&before, "teamId")).await?;
    Ok(Ok(UpdatedIssue {
        before,
        issue,
        team_key,
    }))
}

/// `moveIssueStatus(db, issue, status)`: an ordinary status update
/// (timestamps included) on behalf of a pull request's automation.
pub(crate) async fn move_issue_status(
    db: &PgPool,
    issue: &Row,
    status: &str,
) -> Result<Row, sqlx::Error> {
    let now = now();
    let stamps = status_timestamps(status, &timestamps_of(issue), &now);
    let row: Value = sqlx::query_scalar(
        "update merge_issues set status = $2, started_at = $3::timestamptz, \
           completed_at = $4::timestamptz, canceled_at = $5::timestamptz, updated_at = $6::timestamptz \
         where id = $1 returning to_jsonb(merge_issues.*)",
    )
    .bind(text(issue, "id"))
    .bind(status)
    .bind(stamps.started_at)
    .bind(stamps.completed_at)
    .bind(stamps.canceled_at)
    .bind(&now)
    .fetch_one(db)
    .await?;
    Ok(weldsuite_db::js_row(row))
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

/// Soft delete; sub-issues lose their parent.
pub(crate) async fn remove(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Answer {
    let db = &caller.db;
    let Some(existing) = find_issue(db, &id).await? else {
        return Err(Refusal::not_found("Issue", Some(&id)));
    };
    let now = now();
    sqlx::query(
        "update merge_issues set parent_issue_id = null, updated_at = $2::timestamptz \
         where parent_issue_id = $1",
    )
    .bind(&id)
    .bind(&now)
    .execute(db)
    .await?;
    let row: Value = sqlx::query_scalar(
        "update merge_issues set deleted_at = $2::timestamptz, updated_at = $2::timestamptz \
         where id = $1 returning to_jsonb(merge_issues.*)",
    )
    .bind(&id)
    .bind(&now)
    .fetch_one(db)
    .await?;
    let issue = weldsuite_db::js_row(row);
    let team_key = team_key_of(db, text(&existing, "teamId")).await?;
    publish(
        &state,
        &caller.events,
        vec![issue_event(&issue, &team_key, "deleted")],
    );
    Ok(NoContent.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_compare_json_and_leave_equal_fields_out() {
        let before = json!({ "title": "A", "labelIds": ["x"], "priority": 0 });
        let after = json!({ "title": "B", "labelIds": ["x"], "priority": 1 });
        let changes =
            diff_fields(&before, &after, &["title", "labelIds", "priority"]).unwrap_or_default();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes["title"], json!({ "old": "A", "new": "B" }));
        assert!(diff_fields(&before, &before, &["title"]).is_none());
    }

    #[test]
    fn unique_keeps_the_first_of_each() {
        let items = ["b", "a", "b"].map(str::to_owned);
        assert_eq!(unique(&items), ["b", "a"]);
    }
}
