//! The pull request mirror (`services/pr-sync.ts`): one function every sync
//! path uses (a webhook, adding a repository, Refresh). It upserts the row,
//! finds issue keys, creates the `auto` links and, when asked, runs the
//! automation rules ([`crate::automation`]).

use std::collections::{HashMap, HashSet};

use sea_orm::ActiveValue::{Set, Unchanged};
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::generate_id;
use weldsuite_schema::tenant::{
    merge_issue_pull_requests, merge_issues, merge_provider_accounts, merge_pull_requests,
    merge_teams,
};

use crate::automation::{
    PullRequestPhase, issue_status_for_pull_request, pull_request_phase, should_evaluate_link,
};
use crate::db::{
    Row, col, flag, instant_opt, int4, is_unique_violation, json_row, json_rows, now_at, opt_text,
    required, text,
};
use crate::github::{
    MirrorFields, is_not_older, map_github_pull_request, merge_mirror_update, millis_of,
};
use crate::hooks::{HookContext, after_issue_updated, after_pull_request_synced};
use crate::issues::move_issue_status;
use crate::keys::find_issue_key_mentions;
use crate::mappers::{issue_event_data, pull_request_event_data};
use crate::{MergeError, PendingEvent};

/// A pull request's link to an issue, with the issue (`LinkedIssue`).
#[derive(Debug, Clone)]
pub(crate) struct LinkedIssue {
    pub(crate) closes: bool,
    pub(crate) is_new: bool,
    pub(crate) issue: Row,
    pub(crate) team_key: String,
}

/// The phase of a mirrored pull request row.
pub(crate) fn phase_of(row: &Row) -> PullRequestPhase {
    pull_request_phase(text(row, "state"), flag(row, "draft"))
}

/// A pull request mirror row as the services read it.
pub(crate) fn mirror_row(pr: merge_pull_requests::Model) -> Result<Row, DbErr> {
    json_row(serde_json::to_value(pr))
}

/// `findPullRequestByNumber`: the mirror of a repository's pull request.
pub(crate) async fn mirror_by_number(
    db: &PgPool,
    repository_id: &str,
    number: i64,
) -> Result<Option<Row>, DbErr> {
    merge_pull_requests::Entity::find()
        .filter(merge_pull_requests::Column::RepositoryId.eq(repository_id))
        .filter(merge_pull_requests::Column::Number.eq(number))
        .one(&orm(db))
        .await?
        .map(mirror_row)
        .transpose()
}

/// A repository's open mirrors at a head commit; with `numbers`, only those
/// pull requests.
pub(crate) async fn open_mirrors_at(
    db: &PgPool,
    repository_id: &str,
    head_sha: &str,
    numbers: &[i32],
) -> Result<Vec<Row>, DbErr> {
    let mut select = merge_pull_requests::Entity::find()
        .filter(merge_pull_requests::Column::RepositoryId.eq(repository_id))
        .filter(merge_pull_requests::Column::HeadSha.eq(head_sha))
        .filter(merge_pull_requests::Column::State.eq("open"));
    if !numbers.is_empty() {
        select = select.filter(merge_pull_requests::Column::Number.is_in(numbers.iter().copied()));
    }
    json_rows(
        select
            .all(&orm(db))
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )
}

/// What a review or check event changes on a mirror (`review_decision` or
/// `checks_status`), with `synced_at` and `updated_at`; the row as written.
pub(crate) async fn set_mirror_status(
    db: &PgPool,
    pr_id: &str,
    column: merge_pull_requests::Column,
    value: Option<&str>,
) -> Result<Row, DbErr> {
    let (_, at) = now_at();
    let updated = merge_pull_requests::Entity::update_many()
        .col_expr(column, Expr::value(value.map(str::to_owned)))
        .col_expr(merge_pull_requests::Column::SyncedAt, Expr::value(at))
        .col_expr(merge_pull_requests::Column::UpdatedAt, Expr::value(at))
        .filter(merge_pull_requests::Column::Id.eq(pr_id))
        .exec_with_returning(&orm(db))
        .await?;
    mirror_row(updated.into_iter().next().ok_or(DbErr::RecordNotUpdated)?)
}

/// A mentioned issue with its team's key (`to_jsonb(i), t.key`).
#[derive(Debug, FromQueryResult)]
struct KeyedIssue {
    #[sea_orm(nested)]
    issue: merge_issues::Model,
    team_key: String,
}

/// A live issue linked to a pull request (`to_jsonb(l), to_jsonb(i), t.key`).
#[derive(Debug, FromQueryResult)]
struct LinkRow {
    #[sea_orm(nested)]
    issue: merge_issues::Model,
    link_id: String,
    link_closes: bool,
    team_key: String,
}

/// `issue.team_id = team.id`.
fn issue_team() -> sea_orm::RelationDef {
    merge_issues::Entity::belongs_to(merge_teams::Entity)
        .from(merge_issues::Column::TeamId)
        .to(merge_teams::Column::Id)
        .into()
}

fn link_row(link: merge_issue_pull_requests::Model) -> Result<Row, DbErr> {
    json_row(serde_json::to_value(link))
}

/// `syncAutoLinks(db, pr)`: the existing links, plus new `auto` links for
/// the issue keys the pull request mentions.
async fn sync_auto_links(db: &PgPool, pr: &Row) -> Result<(Vec<LinkedIssue>, usize), DbErr> {
    let pr_id = text(pr, "id").to_owned();
    let mentions = find_issue_key_mentions(
        pr.get("headRef").and_then(Value::as_str),
        pr.get("title").and_then(Value::as_str),
        pr.get("body").and_then(Value::as_str),
    );
    let orm_db = orm(db);
    let existing = json_rows(
        merge_issue_pull_requests::Entity::find()
            .filter(merge_issue_pull_requests::Column::PullRequestId.eq(&pr_id))
            .all(&orm_db)
            .await?
            .into_iter()
            .map(serde_json::to_value),
    )?;
    let mut by_issue: HashMap<String, Row> = existing
        .into_iter()
        .map(|link| (text(&link, "issueId").to_owned(), link))
        .collect();
    let mut created: HashSet<String> = HashSet::new();

    if !mentions.is_empty() {
        let mut team_keys: Vec<String> = Vec::new();
        let mut numbers: Vec<i64> = Vec::new();
        for mention in &mentions {
            if !team_keys.contains(&mention.team_key) {
                team_keys.push(mention.team_key.clone());
            }
            if !numbers.contains(&mention.number) {
                numbers.push(mention.number);
            }
        }
        let candidates: Vec<(Row, String)> = merge_issues::Entity::find()
            .column_as(merge_teams::Column::Key, "team_key")
            .join(JoinType::InnerJoin, issue_team())
            .filter(merge_teams::Column::Key.is_in(team_keys))
            .filter(merge_issues::Column::Number.is_in(numbers))
            .filter(merge_teams::Column::DeletedAt.is_null())
            .filter(merge_issues::Column::DeletedAt.is_null())
            .into_model::<KeyedIssue>()
            .all(&orm_db)
            .await?
            .into_iter()
            .map(|hit| Ok((json_row(serde_json::to_value(hit.issue))?, hit.team_key)))
            .collect::<Result<_, DbErr>>()?;
        for mention in &mentions {
            let Some((hit, _)) = candidates.iter().find(|(issue, key)| {
                *key == mention.team_key
                    && issue.get("number").and_then(Value::as_i64) == Some(mention.number)
            }) else {
                continue;
            };
            let issue_id = text(hit, "id").to_owned();
            match by_issue.get(&issue_id) {
                // A removed automatic link stays removed: the pair is not linked again.
                Some(link) if !link.get("dismissedAt").is_none_or(Value::is_null) => {}
                None => {
                    // `on conflict do nothing`: a link another delivery made wins.
                    let inserted = merge_issue_pull_requests::Entity::insert(
                        merge_issue_pull_requests::ActiveModel {
                            id: Set(generate_id("mip")),
                            issue_id: Set(issue_id.clone()),
                            pull_request_id: Set(pr_id.clone()),
                            source: Set("auto".to_owned()),
                            closes: Set(mention.closes),
                            ..Default::default()
                        },
                    )
                    .on_conflict(OnConflict::new().do_nothing().to_owned())
                    .exec_with_returning_many(&orm_db)
                    .await?;
                    if let Some(link) = inserted.into_iter().next() {
                        let link = link_row(link)?;
                        created.insert(text(&link, "id").to_owned());
                        by_issue.insert(issue_id, link);
                    }
                }
                Some(link)
                    if text(link, "source") == "auto" && flag(link, "closes") != mention.closes =>
                {
                    let updated = merge_issue_pull_requests::ActiveModel {
                        id: Unchanged(text(link, "id").to_owned()),
                        closes: Set(mention.closes),
                        ..Default::default()
                    }
                    .update(&orm_db)
                    .await?;
                    by_issue.insert(issue_id, link_row(updated)?);
                }
                Some(_) => {}
            }
        }
    }

    let links = load_links(db, &pr_id, &created).await?;
    Ok((links, created.len()))
}

/// `loadLinks(db, pullRequestId, newIds)`: the links of live issues.
async fn load_links(
    db: &PgPool,
    pull_request_id: &str,
    new_ids: &HashSet<String>,
) -> Result<Vec<LinkedIssue>, DbErr> {
    merge_issues::Entity::find()
        .column_as(merge_issue_pull_requests::Column::Id, "link_id")
        .column_as(merge_issue_pull_requests::Column::Closes, "link_closes")
        .column_as(merge_teams::Column::Key, "team_key")
        .join(
            JoinType::InnerJoin,
            merge_issues::Entity::belongs_to(merge_issue_pull_requests::Entity)
                .from(merge_issues::Column::Id)
                .to(merge_issue_pull_requests::Column::IssueId)
                .into(),
        )
        .join(JoinType::InnerJoin, issue_team())
        .filter(merge_issue_pull_requests::Column::PullRequestId.eq(pull_request_id))
        .filter(merge_issue_pull_requests::Column::DismissedAt.is_null())
        .filter(merge_issues::Column::DeletedAt.is_null())
        .into_model::<LinkRow>()
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|row| {
            Ok(LinkedIssue {
                closes: row.link_closes,
                is_new: new_ids.contains(&row.link_id),
                issue: json_row(serde_json::to_value(row.issue))?,
                team_key: row.team_key,
            })
        })
        .collect()
}

/// `runAutomation(db, pr, previous, links, hooks?)`: applies the rules to
/// linked issues; the issue events (by the caller's actor). Webhook-driven
/// syncs pass `hooks`: the issue sync pushes the status the pull request
/// moved the issue to.
pub(crate) async fn run_automation(
    db: &PgPool,
    pr: &Row,
    previous: Option<PullRequestPhase>,
    links: &mut [LinkedIssue],
    hooks: Option<&HookContext>,
) -> Result<Vec<PendingEvent>, DbErr> {
    let next = phase_of(pr);
    let mut events = Vec::new();
    for link in links.iter_mut() {
        if !should_evaluate_link(previous, next, link.is_new) {
            continue;
        }
        let Some(target) =
            issue_status_for_pull_request(text(&link.issue, "status"), next, link.closes)
        else {
            continue;
        };
        let moved = move_issue_status(db, &link.issue, target).await?;
        let mut changes = Map::new();
        changes.insert(
            "status".to_owned(),
            json!({ "old": link.issue["status"], "new": moved["status"] }),
        );
        events.push(
            PendingEvent::new(
                "merge_issue",
                "updated",
                text(&moved, "id"),
                issue_event_data(&moved, &link.team_key, Some(text(pr, "id"))),
            )
            .with_changes(Some(changes)),
        );
        if let Some(hooks) = hooks {
            after_issue_updated(hooks, &link.issue, &moved, &link.team_key).await;
        }
        link.issue = moved;
    }
    Ok(events)
}

/// `pullRequestEvents(pr, previous, issueIds, changes, transitions)`: created
/// or updated, plus merged or closed when the phase turned that way (not for
/// a backfill, which reads history rather than news).
fn pull_request_events(
    pr: &Row,
    previous: Option<PullRequestPhase>,
    issue_ids: &[String],
    changes: Option<Map<String, Value>>,
    transitions: bool,
) -> Vec<PendingEvent> {
    let id = text(pr, "id");
    let data = pull_request_event_data(pr, issue_ids);
    let action = if previous.is_none() {
        "created"
    } else {
        "updated"
    };
    let mut events = vec![
        PendingEvent::new("merge_pull_request", action, id, data.clone()).with_changes(changes),
    ];
    if !transitions {
        return events;
    }
    let next = phase_of(pr);
    if next == PullRequestPhase::Merged && previous != Some(PullRequestPhase::Merged) {
        events.push(PendingEvent::new("merge_pull_request", "merged", id, data));
    } else if next == PullRequestPhase::Closed && previous != Some(PullRequestPhase::Closed) {
        events.push(PendingEvent::new("merge_pull_request", "closed", id, data));
    }
    events
}

/// What an upsert did (`UpsertOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpsertStatus {
    Created,
    Updated,
    Unchanged,
    Stale,
}

pub(crate) struct UpsertOutcome {
    pub(crate) status: UpsertStatus,
    pub(crate) links_created: usize,
    pub(crate) events: Vec<PendingEvent>,
}

/// Member columns of a pull request, from the logins members entered.
async fn match_members(
    db: &PgPool,
    provider: &str,
    logins: &[String],
) -> Result<HashMap<String, String>, DbErr> {
    let mut unique: Vec<String> = Vec::new();
    for login in logins.iter().filter(|l| !l.is_empty()) {
        if !unique.contains(login) {
            unique.push(login.clone());
        }
    }
    if unique.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, String)> = merge_provider_accounts::Entity::find()
        .select_only()
        .column(merge_provider_accounts::Column::Login)
        .column(merge_provider_accounts::Column::UserId)
        .filter(merge_provider_accounts::Column::Provider.eq(provider))
        .filter(merge_provider_accounts::Column::Login.is_in(unique))
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows.into_iter().collect())
}

fn opt_str(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn opt_int(value: &Value) -> Option<i64> {
    value.as_i64()
}

/// The line counts (`$n::int`) and the provider's times of a mirror being
/// written. A `not null` time the provider gave no valid value for is
/// Postgres's refusal, as before.
fn set_counts_and_times(
    mirror: &mut merge_pull_requests::ActiveModel,
    fields: &MirrorFields,
) -> Result<(), DbErr> {
    let count = |value: &Value| opt_int(value).map(int4).transpose();
    mirror.additions = Set(count(&fields.additions)?);
    mirror.deletions = Set(count(&fields.deletions)?);
    mirror.changed_files = Set(count(&fields.changed_files)?);
    mirror.provider_created_at = Set(required(
        instant_opt(fields.provider_created_at.as_deref())?,
        "provider_created_at",
    )?);
    mirror.provider_updated_at = Set(required(
        instant_opt(fields.provider_updated_at.as_deref())?,
        "provider_updated_at",
    )?);
    mirror.merged_at = Set(instant_opt(fields.merged_at.as_deref())?);
    mirror.closed_at = Set(instant_opt(fields.closed_at.as_deref())?);
    Ok(())
}

/// `upsertPullRequest(db, repository, github, options)`: a GitHub pull request
/// payload, mapped, then mirrored.
pub(crate) async fn upsert_pull_request(
    db: &PgPool,
    repository: &Row,
    github: &Value,
    automate: bool,
    skip_unchanged: bool,
    hooks: Option<&HookContext>,
) -> Result<UpsertOutcome, MergeError> {
    upsert_mirror(
        db,
        repository,
        map_github_pull_request(github),
        automate,
        skip_unchanged,
        hooks,
    )
    .await
}

/// `upsertMirror(db, repository, fields, { automate, skipUnchanged, hooks })`:
/// mirrors a pull request already mapped to [`MirrorFields`] (every
/// provider's mapper ends here). Webhook-driven syncs pass `hooks`: the area
/// hooks run after the write; a backfill leaves it out.
///
/// Providers send several deliveries for one change (GitHub: `opened`,
/// `review_requested` and `labeled` together): when another delivery
/// inserted the pull request between the read and the insert,
/// `(repository_id, number)` refuses the second insert, and the mirror is
/// read again and takes the update path (or is stale) like any later
/// delivery.
pub(crate) async fn upsert_mirror(
    db: &PgPool,
    repository: &Row,
    fields: MirrorFields,
    automate: bool,
    skip_unchanged: bool,
    hooks: Option<&HookContext>,
) -> Result<UpsertOutcome, MergeError> {
    let first = upsert_mirror_once(
        db,
        repository,
        fields.clone(),
        automate,
        skip_unchanged,
        hooks,
        true,
    )
    .await?;
    if let Some(outcome) = first {
        return Ok(outcome);
    }
    upsert_mirror_once(
        db,
        repository,
        fields,
        automate,
        skip_unchanged,
        hooks,
        false,
    )
    .await?
    .ok_or_else(|| MergeError::Unexpected("the pull request mirror raced twice".to_owned()))
}

/// One pass of [`upsert_mirror`]: `None` when `retry_on_race` and another
/// delivery inserted the pull request first.
async fn upsert_mirror_once(
    db: &PgPool,
    repository: &Row,
    fields: MirrorFields,
    automate: bool,
    skip_unchanged: bool,
    hooks: Option<&HookContext>,
    retry_on_race: bool,
) -> Result<Option<UpsertOutcome>, MergeError> {
    let number = fields
        .number
        .as_i64()
        .ok_or_else(|| MergeError::Unexpected("a pull request without a number".to_owned()))?;
    let existing = mirror_by_number(db, text(repository, "id"), number).await?;

    if let Some(stored) = &existing
        && !is_not_older(
            fields.provider_updated_at.as_deref(),
            stored.get("providerUpdatedAt").and_then(Value::as_str),
        )
    {
        return Ok(Some(UpsertOutcome {
            status: UpsertStatus::Stale,
            links_created: 0,
            events: Vec::new(),
        }));
    }

    let unchanged = skip_unchanged
        && existing.as_ref().is_some_and(|stored| {
            let stored_ms = stored
                .get("providerUpdatedAt")
                .and_then(Value::as_str)
                .and_then(millis_of);
            let incoming_ms = fields.provider_updated_at.as_deref().and_then(millis_of);
            stored_ms.is_some() && stored_ms == incoming_ms && text(stored, "state") == fields.state
        });
    let previous = existing.as_ref().map(phase_of);

    let row = if unchanged {
        existing.clone().unwrap_or(Value::Null)
    } else {
        let mut logins = vec![fields.author_login.clone().unwrap_or_default()];
        for reviewer in &fields.requested_reviewers {
            if reviewer["kind"] == "user"
                && let Some(login) = reviewer.get("login").and_then(Value::as_str)
            {
                logins.push(login.to_owned());
            }
        }
        let members = match_members(db, text(repository, "provider"), &logins).await?;
        let reviewers: Vec<Value> = fields
            .requested_reviewers
            .iter()
            .map(|reviewer| {
                if reviewer["kind"] != "user" {
                    return reviewer.clone();
                }
                let mut user = reviewer.clone();
                let user_id = reviewer
                    .get("login")
                    .and_then(Value::as_str)
                    .and_then(|login| members.get(login))
                    .map_or(Value::Null, |id| json!(id));
                if let Some(fields) = user.as_object_mut() {
                    fields.insert("userId".to_owned(), user_id);
                }
                user
            })
            .collect();
        let author_user_id = fields
            .author_login
            .as_ref()
            .filter(|l| !l.is_empty())
            .and_then(|login| members.get(login).cloned());
        let (_, at) = now_at();
        let title = opt_str(&fields.title)
            .ok_or_else(|| MergeError::Unexpected("a pull request without a title".to_owned()))?;
        let url = opt_str(&fields.url)
            .ok_or_else(|| MergeError::Unexpected("a pull request without a URL".to_owned()))?;
        let orm_db = orm(db);
        if let Some(stored) = &existing {
            let merged = merge_mirror_update(
                fields.clone(),
                &col(stored, "additions"),
                &col(stored, "deletions"),
                &col(stored, "changedFiles"),
            );
            // A new head commit starts new checks; reviews carry over until the next review event.
            let checks_status = if merged.head_sha == col(stored, "headSha") {
                opt_text(stored, "checksStatus")
            } else {
                None
            };
            let mut mirror = merge_pull_requests::ActiveModel {
                id: Unchanged(text(stored, "id").to_owned()),
                title: Set(title),
                body: Set(opt_str(&merged.body)),
                state: Set(merged.state.to_owned()),
                draft: Set(merged.draft),
                url: Set(url),
                author_login: Set(merged.author_login.clone()),
                author_avatar_url: Set(opt_str(&merged.author_avatar_url)),
                author_user_id: Set(author_user_id),
                head_ref: Set(opt_str(&merged.head_ref)),
                base_ref: Set(opt_str(&merged.base_ref)),
                head_sha: Set(opt_str(&merged.head_sha)),
                checks_status: Set(checks_status),
                requested_reviewers: Set(Value::Array(reviewers)),
                labels: Set(Value::Array(merged.labels.clone())),
                synced_at: Set(at),
                updated_at: Set(at),
                ..Default::default()
            };
            set_counts_and_times(&mut mirror, &merged)?;
            mirror_row(mirror.update(&orm_db).await?)?
        } else {
            let mut mirror = merge_pull_requests::ActiveModel {
                id: Set(generate_id("mpr")),
                repository_id: Set(text(repository, "id").to_owned()),
                provider: Set(text(repository, "provider").to_owned()),
                external_id: Set(fields.external_id.clone()),
                number: Set(int4(number)?),
                title: Set(title),
                body: Set(opt_str(&fields.body)),
                state: Set(fields.state.to_owned()),
                draft: Set(fields.draft),
                url: Set(url),
                author_login: Set(fields.author_login.clone()),
                author_avatar_url: Set(opt_str(&fields.author_avatar_url)),
                author_user_id: Set(author_user_id),
                head_ref: Set(opt_str(&fields.head_ref)),
                base_ref: Set(opt_str(&fields.base_ref)),
                head_sha: Set(opt_str(&fields.head_sha)),
                requested_reviewers: Set(Value::Array(reviewers)),
                labels: Set(Value::Array(fields.labels.clone())),
                synced_at: Set(at),
                created_at: Set(at),
                updated_at: Set(at),
                ..Default::default()
            };
            set_counts_and_times(&mut mirror, &fields)?;
            let inserted = merge_pull_requests::Entity::insert(mirror)
                .exec_with_returning(&orm_db)
                .await;
            match inserted {
                Ok(inserted) => mirror_row(inserted)?,
                Err(error) if retry_on_race && is_unique_violation(&error) => {
                    return Ok(None);
                }
                Err(error) => return Err(error.into()),
            }
        }
    };

    let (mut links, created) = sync_auto_links(db, &row).await?;
    let mut events = Vec::new();
    if automate {
        events.extend(run_automation(db, &row, previous, &mut links, hooks).await?);
    }
    if !unchanged {
        let issue_ids: Vec<String> = links
            .iter()
            .map(|l| text(&l.issue, "id").to_owned())
            .collect();
        let changes = existing.as_ref().and_then(|stored| {
            (text(stored, "state") != text(&row, "state")).then(|| {
                let mut changes = Map::new();
                changes.insert(
                    "state".to_owned(),
                    json!({ "old": stored["state"], "new": row["state"] }),
                );
                changes
            })
        });
        let mut first = pull_request_events(&row, previous, &issue_ids, changes, automate);
        first.extend(events);
        events = first;
        if let Some(hooks) = hooks {
            after_pull_request_synced(hooks, existing.as_ref(), &row, &events).await;
        }
    }
    Ok(Some(UpsertOutcome {
        status: if unchanged {
            UpsertStatus::Unchanged
        } else if existing.is_some() {
            UpsertStatus::Updated
        } else {
            UpsertStatus::Created
        },
        links_created: created,
        events,
    }))
}
