//! The pull request mirror (`services/pr-sync.ts`): one function every sync
//! path uses (a webhook, adding a repository, Refresh). It upserts the row,
//! finds issue keys, creates the `auto` links and, when asked, runs the
//! automation rules ([`crate::automation`]).

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::generate_id;

use crate::automation::{
    PullRequestPhase, issue_status_for_pull_request, pull_request_phase, should_evaluate_link,
};
use crate::db::{Row, col, flag, opt_text, text};
use crate::github::{
    MirrorFields, is_not_older, map_github_pull_request, merge_mirror_update, millis_of,
};
use crate::hooks::{HookContext, after_issue_updated, after_pull_request_synced};
use crate::issues::move_issue_status;
use crate::keys::find_issue_key_mentions;
use crate::mappers::{issue_event_data, pull_request_event_data};
use crate::{MergeError, PendingEvent, now};

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

/// `syncAutoLinks(db, pr)`: the existing links, plus new `auto` links for
/// the issue keys the pull request mentions.
async fn sync_auto_links(db: &PgPool, pr: &Row) -> Result<(Vec<LinkedIssue>, usize), sqlx::Error> {
    let pr_id = text(pr, "id").to_owned();
    let mentions = find_issue_key_mentions(
        pr.get("headRef").and_then(Value::as_str),
        pr.get("title").and_then(Value::as_str),
        pr.get("body").and_then(Value::as_str),
    );
    let existing: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from merge_issue_pull_requests l where l.pull_request_id = $1",
    )
    .bind(&pr_id)
    .fetch_all(db)
    .await?;
    let mut by_issue: HashMap<String, Row> = existing
        .into_iter()
        .map(js_row)
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
        let candidates: Vec<(Value, String)> = sqlx::query_as(
            "select to_jsonb(i), t.key from merge_issues i inner join merge_teams t on t.id = i.team_id \
             where t.key = any($1) and i.number = any($2) and t.deleted_at is null and i.deleted_at is null",
        )
        .bind(&team_keys)
        .bind(&numbers)
        .fetch_all(db)
        .await?;
        let candidates: Vec<(Row, String)> = candidates
            .into_iter()
            .map(|(issue, key)| (js_row(issue), key))
            .collect();
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
                    let inserted: Option<Value> = sqlx::query_scalar(
                        "insert into merge_issue_pull_requests (id, issue_id, pull_request_id, source, closes) \
                         values ($1, $2, $3, 'auto', $4) on conflict do nothing \
                         returning to_jsonb(merge_issue_pull_requests.*)",
                    )
                    .bind(generate_id("mip"))
                    .bind(&issue_id)
                    .bind(&pr_id)
                    .bind(mention.closes)
                    .fetch_optional(db)
                    .await?;
                    if let Some(link) = inserted.map(js_row) {
                        created.insert(text(&link, "id").to_owned());
                        by_issue.insert(issue_id, link);
                    }
                }
                Some(link)
                    if text(link, "source") == "auto" && flag(link, "closes") != mention.closes =>
                {
                    let updated: Value = sqlx::query_scalar(
                        "update merge_issue_pull_requests set closes = $2 where id = $1 \
                         returning to_jsonb(merge_issue_pull_requests.*)",
                    )
                    .bind(text(link, "id"))
                    .bind(mention.closes)
                    .fetch_one(db)
                    .await?;
                    by_issue.insert(issue_id, js_row(updated));
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
) -> Result<Vec<LinkedIssue>, sqlx::Error> {
    let rows: Vec<(Value, Value, String)> = sqlx::query_as(
        "select to_jsonb(l), to_jsonb(i), t.key from merge_issue_pull_requests l \
         inner join merge_issues i on i.id = l.issue_id \
         inner join merge_teams t on t.id = i.team_id \
         where l.pull_request_id = $1 and l.dismissed_at is null and i.deleted_at is null",
    )
    .bind(pull_request_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(link, issue, team_key)| {
            let link = js_row(link);
            LinkedIssue {
                closes: flag(&link, "closes"),
                is_new: new_ids.contains(text(&link, "id")),
                issue: js_row(issue),
                team_key,
            }
        })
        .collect())
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
) -> Result<Vec<PendingEvent>, sqlx::Error> {
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
) -> Result<HashMap<String, String>, sqlx::Error> {
    let mut unique: Vec<String> = Vec::new();
    for login in logins.iter().filter(|l| !l.is_empty()) {
        if !unique.contains(login) {
            unique.push(login.clone());
        }
    }
    if unique.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, String)> = sqlx::query_as(
        "select login, user_id from merge_provider_accounts where provider = $2 and login = any($1)",
    )
    .bind(&unique)
    .bind(provider)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

fn opt_str(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn opt_int(value: &Value) -> Option<i64> {
    value.as_i64()
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
pub(crate) async fn upsert_mirror(
    db: &PgPool,
    repository: &Row,
    fields: MirrorFields,
    automate: bool,
    skip_unchanged: bool,
    hooks: Option<&HookContext>,
) -> Result<UpsertOutcome, MergeError> {
    let number = fields
        .number
        .as_i64()
        .ok_or_else(|| MergeError::Unexpected("a pull request without a number".to_owned()))?;
    let existing: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(p) from merge_pull_requests p where p.repository_id = $1 and p.number = $2 limit 1",
    )
    .bind(text(repository, "id"))
    .bind(number)
    .fetch_optional(db)
    .await?;
    let existing = existing.map(js_row);

    if let Some(stored) = &existing
        && !is_not_older(
            fields.provider_updated_at.as_deref(),
            stored.get("providerUpdatedAt").and_then(Value::as_str),
        )
    {
        return Ok(UpsertOutcome {
            status: UpsertStatus::Stale,
            links_created: 0,
            events: Vec::new(),
        });
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
        let now = now();
        let title = opt_str(&fields.title)
            .ok_or_else(|| MergeError::Unexpected("a pull request without a title".to_owned()))?;
        let url = opt_str(&fields.url)
            .ok_or_else(|| MergeError::Unexpected("a pull request without a URL".to_owned()))?;
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
            let updated: Value = sqlx::query_scalar(
                "update merge_pull_requests set title = $2, body = $3, state = $4, draft = $5, url = $6, \
                   author_login = $7, author_avatar_url = $8, author_user_id = $9, head_ref = $10, \
                   base_ref = $11, head_sha = $12, additions = $13::int, deletions = $14::int, \
                   changed_files = $15::int, checks_status = $16, requested_reviewers = $17, labels = $18, \
                   provider_created_at = $19::timestamptz, provider_updated_at = $20::timestamptz, \
                   merged_at = $21::timestamptz, closed_at = $22::timestamptz, \
                   synced_at = $23::timestamptz, updated_at = $23::timestamptz \
                 where id = $1 returning to_jsonb(merge_pull_requests.*)",
            )
            .bind(text(stored, "id"))
            .bind(&title)
            .bind(opt_str(&merged.body))
            .bind(merged.state)
            .bind(merged.draft)
            .bind(&url)
            .bind(&merged.author_login)
            .bind(opt_str(&merged.author_avatar_url))
            .bind(&author_user_id)
            .bind(opt_str(&merged.head_ref))
            .bind(opt_str(&merged.base_ref))
            .bind(opt_str(&merged.head_sha))
            .bind(opt_int(&merged.additions))
            .bind(opt_int(&merged.deletions))
            .bind(opt_int(&merged.changed_files))
            .bind(checks_status)
            .bind(Value::Array(reviewers))
            .bind(Value::Array(merged.labels.clone()))
            .bind(&merged.provider_created_at)
            .bind(&merged.provider_updated_at)
            .bind(&merged.merged_at)
            .bind(&merged.closed_at)
            .bind(&now)
            .fetch_one(db)
            .await?;
            js_row(updated)
        } else {
            let inserted: Value = sqlx::query_scalar(
                "insert into merge_pull_requests ( \
                   id, repository_id, provider, external_id, number, title, body, state, draft, url, \
                   author_login, author_avatar_url, author_user_id, head_ref, base_ref, head_sha, \
                   additions, deletions, changed_files, requested_reviewers, labels, \
                   provider_created_at, provider_updated_at, merged_at, closed_at, \
                   synced_at, created_at, updated_at \
                 ) values ( \
                   $1, $2, $26, $3, $4::int, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, \
                   $16::int, $17::int, $18::int, $19, $20, $21::timestamptz, $22::timestamptz, \
                   $23::timestamptz, $24::timestamptz, $25::timestamptz, $25::timestamptz, $25::timestamptz \
                 ) returning to_jsonb(merge_pull_requests.*)",
            )
            .bind(generate_id("mpr"))
            .bind(text(repository, "id"))
            .bind(&fields.external_id)
            .bind(number)
            .bind(&title)
            .bind(opt_str(&fields.body))
            .bind(fields.state)
            .bind(fields.draft)
            .bind(&url)
            .bind(&fields.author_login)
            .bind(opt_str(&fields.author_avatar_url))
            .bind(&author_user_id)
            .bind(opt_str(&fields.head_ref))
            .bind(opt_str(&fields.base_ref))
            .bind(opt_str(&fields.head_sha))
            .bind(opt_int(&fields.additions))
            .bind(opt_int(&fields.deletions))
            .bind(opt_int(&fields.changed_files))
            .bind(Value::Array(reviewers))
            .bind(Value::Array(fields.labels.clone()))
            .bind(&fields.provider_created_at)
            .bind(&fields.provider_updated_at)
            .bind(&fields.merged_at)
            .bind(&fields.closed_at)
            .bind(&now)
            .bind(text(repository, "provider"))
            .fetch_one(db)
            .await?;
            js_row(inserted)
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
    Ok(UpsertOutcome {
        status: if unchanged {
            UpsertStatus::Unchanged
        } else if existing.is_some() {
            UpsertStatus::Updated
        } else {
            UpsertStatus::Created
        },
        links_created: created,
        events,
    })
}
