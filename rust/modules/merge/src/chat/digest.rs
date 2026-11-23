//! The WeldChat daily digest (`services/chat/digest.ts` and
//! `cron/digest-sweep.ts`).
//!
//! One subscription's digest: open pull requests waiting for a review, pull
//! requests with failing checks, and issues done in the last day, limited to
//! the subscription's team or repository. A quiet day (all three empty)
//! posts nothing.
//!
//! The sweep never wakes idle tenant databases (ADR DATA-008): timing lives
//! in the master `workspace_due_index` (kind `merge_digest`, keyed by
//! `workspaces.id`; Global keeps the schedule-index D1 keyed by the Clerk org
//! id). Creating or changing a subscription with `daily_digest` marks the
//! workspace due at its next `digest_hour`; each tick reads only the index,
//! opens the workspaces that are due, posts the digests whose hour it is and
//! re-arms the workspace for the next hour any of its digests is due (or
//! drops the row). `weldsuite cron merge-digest-sweep` runs it hourly (`0 * * * *`).

use sea_orm::{
    ColumnTrait, Condition, DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::due_index::{SweepResult, run_sweep};
use weldsuite_db::{PgPool, Tenant, orm};
use weldsuite_schema::tenant::{merge_issues, merge_pull_requests, merge_repositories, merge_teams};

use crate::chat::post::post_card;
use crate::chat::subscriptions::{DIGEST_KIND, digest_subscriptions, next_digest_at};
use crate::db::{Row, int, millis, text};
use crate::hooks::HookContext;
use crate::{MergeState, Overrides, system_events};

/// Most lines one list shows; the rest is counted.
const MAX_LINES: usize = 10;

/// Workspaces one tick opens; the rest stay due for the next tick.
const WORKSPACES_PER_RUN: i64 = 500;

/// A workspace that failed (a database hiccup, a broken tenant) is retried
/// after this.
const RETRY_AFTER_MINUTES: i64 = 15;

/// One line of a digest list.
struct Line {
    label: String,
    title: String,
}

/// The extra condition of a pull request list.
#[derive(Clone, Copy)]
enum PullRequestList {
    WaitingForReview,
    ChecksFailing,
}

async fn open_pull_requests(
    db: &PgPool,
    sub: &Row,
    list: PullRequestList,
) -> Result<Vec<Line>, DbErr> {
    let condition = match list {
        PullRequestList::WaitingForReview => Condition::all()
            .add(merge_pull_requests::Column::Draft.eq(false))
            .add(
                Condition::any()
                    .add(merge_pull_requests::Column::ReviewDecision.is_null())
                    .add(merge_pull_requests::Column::ReviewDecision.eq("review_required")),
            ),
        PullRequestList::ChecksFailing => {
            Condition::all().add(merge_pull_requests::Column::ChecksStatus.eq("failure"))
        }
    };
    let mut select = merge_pull_requests::Entity::find()
        .select_only()
        .column(merge_pull_requests::Column::Number)
        .column(merge_pull_requests::Column::Title)
        .column(merge_repositories::Column::FullName)
        .join(
            JoinType::InnerJoin,
            merge_pull_requests::Entity::belongs_to(merge_repositories::Entity)
                .from(merge_pull_requests::Column::RepositoryId)
                .to(merge_repositories::Column::Id)
                .into(),
        )
        .filter(merge_pull_requests::Column::State.eq("open"))
        .filter(merge_repositories::Column::DeletedAt.is_null())
        .filter(condition);
    if let Some(repository_id) = non_empty(sub, "repositoryId") {
        select = select.filter(merge_pull_requests::Column::RepositoryId.eq(repository_id));
    }
    if let Some(team_id) = non_empty(sub, "teamId") {
        select = select.filter(merge_repositories::Column::TeamId.eq(team_id));
    }
    let rows: Vec<(i32, String, String)> = select
        .order_by_desc(merge_pull_requests::Column::ProviderUpdatedAt)
        .order_by_desc(merge_pull_requests::Column::Number)
        .order_by_desc(merge_pull_requests::Column::Id)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(number, title, full_name)| Line {
            label: format!("{full_name}#{number}"),
            title,
        })
        .collect())
}

fn non_empty(row: &Row, key: &str) -> Option<String> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

async fn done_issues(
    db: &PgPool,
    sub: &Row,
    since: OffsetDateTime,
) -> Result<Vec<Line>, DbErr> {
    // Issues belong to a team, not a repository: a repository subscription has none.
    if non_empty(sub, "repositoryId").is_some() {
        return Ok(Vec::new());
    }
    let mut select = merge_issues::Entity::find()
        .select_only()
        .column(merge_issues::Column::Number)
        .column(merge_issues::Column::Title)
        .column(merge_teams::Column::Key)
        .join(
            JoinType::InnerJoin,
            merge_issues::Entity::belongs_to(merge_teams::Entity)
                .from(merge_issues::Column::TeamId)
                .to(merge_teams::Column::Id)
                .into(),
        )
        .filter(merge_issues::Column::Status.eq("done"))
        .filter(merge_issues::Column::DeletedAt.is_null())
        .filter(merge_teams::Column::DeletedAt.is_null())
        .filter(merge_issues::Column::CompletedAt.gte(since));
    if let Some(team_id) = non_empty(sub, "teamId") {
        select = select.filter(merge_issues::Column::TeamId.eq(team_id));
    }
    let rows: Vec<(i32, String, String)> = select
        .order_by_desc(merge_issues::Column::CompletedAt)
        .order_by_desc(merge_issues::Column::Number)
        .order_by_desc(merge_issues::Column::Id)
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .map(|(number, title, key)| Line {
            label: format!("{key}-{number}"),
            title,
        })
        .collect())
}

fn section(heading: &str, lines: &[Line]) -> Option<String> {
    if lines.is_empty() {
        return None;
    }
    let mut shown: Vec<String> = lines
        .iter()
        .take(MAX_LINES)
        .map(|l| format!("- {} {}", l.label, l.title))
        .collect();
    if lines.len() > MAX_LINES {
        shown.push(format!("- and {} more", lines.len() - MAX_LINES));
    }
    Some(format!("{heading} ({})\n{}", lines.len(), shown.join("\n")))
}

/// `buildDigest(db, sub, now)`: the digest's text, or `None` on a quiet day.
pub(crate) async fn build_digest(
    db: &PgPool,
    sub: &Row,
    now: OffsetDateTime,
) -> Result<Option<String>, DbErr> {
    let waiting = open_pull_requests(db, sub, PullRequestList::WaitingForReview).await?;
    let failing = open_pull_requests(db, sub, PullRequestList::ChecksFailing).await?;
    let done = done_issues(db, sub, millis(now - time::Duration::days(1))).await?;
    let sections: Vec<String> = [
        section("Waiting for review", &waiting),
        section("Checks failing", &failing),
        section("Done in the last day", &done),
    ]
    .into_iter()
    .flatten()
    .collect();
    if sections.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "WeldMerge daily digest\n\n{}",
        sections.join("\n\n")
    )))
}

/// `processWorkspace(env, clerkOrgId, now)`: posts the digests due at `now`
/// for one workspace; when it is next due (`None`: no digests left).
async fn process_workspace(
    state: &MergeState,
    tenant: Tenant,
    now: OffsetDateTime,
) -> Result<Option<OffsetDateTime>, String> {
    let db = tenant.db.clone();
    let subscriptions = digest_subscriptions(&db)
        .await
        .map_err(|error| error.to_string())?;
    let ctx = HookContext {
        db: db.clone(),
        state: state.clone(),
        overrides: Overrides::default(),
        user_id: "system".to_owned(),
        workspace_id: tenant.workspace_id.clone(),
        clerk_org_id: tenant.clerk_org_id.clone(),
        events: system_events(&tenant),
    };
    let hour = i64::from(now.to_offset(time::UtcOffset::UTC).hour());
    let mut next: Option<OffsetDateTime> = None;
    for sub in &subscriptions {
        let digest_hour = int(sub, "digestHour");
        if digest_hour == hour {
            // Not retried: a retry would post the other subscriptions' digests twice.
            match build_digest(&db, sub, now).await {
                Ok(Some(content)) => {
                    if let Err(error) = post_card(
                        &ctx,
                        text(sub, "channelId"),
                        &content,
                        json!({ "kind": "daily_digest" }),
                    )
                    .await
                    {
                        tracing::error!(
                            subscription = text(sub, "id"),
                            ?error,
                            "[MergeDigest] subscription failed"
                        );
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    tracing::error!(subscription = text(sub, "id"), %error, "[MergeDigest] subscription failed");
                }
            }
        }
        let at = next_digest_at(digest_hour, now);
        if next.is_none_or(|current| at < current) {
            next = Some(at);
        }
    }
    Ok(next)
}

/// One tick of the daily digest sweep (`runDigestSweep`): the workspaces the
/// `merge_digest` index says are due, opened through `state.tenants`.
pub async fn run_digest_sweep(
    state: &MergeState,
    master: &PgPool,
    now: OffsetDateTime,
) -> SweepResult {
    let Some(tenants) = state.tenants.clone() else {
        tracing::warn!("[MergeDigest] no tenant resolver; skipping tick");
        return SweepResult::default();
    };
    let result = run_sweep(
        master,
        DIGEST_KIND,
        now,
        WORKSPACES_PER_RUN,
        Some(time::Duration::minutes(RETRY_AFTER_MINUTES)),
        |workspace_id, at| {
            let tenants = tenants.clone();
            async move {
                let tenant = tenants(workspace_id).await?;
                if tenant.suspended {
                    return Ok(None);
                }
                process_workspace(state, tenant, at).await
            }
        },
    )
    .await;
    tracing::info!(
        due = result.due,
        processed = result.processed,
        failed = result.failed,
        "[MergeDigest] Done"
    );
    result
}

/// A digest subscription row in a test.
#[cfg(test)]
fn sub_row(value: Value) -> Row {
    weldsuite_db::js_row(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(n: usize) -> Vec<Line> {
        (1..=n)
            .map(|i| Line {
                label: format!("acme/web#{i}"),
                title: format!("PR {i}"),
            })
            .collect()
    }

    #[test]
    fn a_section_shows_ten_lines_and_counts_the_rest() {
        assert_eq!(section("Waiting for review", &[]), None);
        assert_eq!(
            section("Waiting for review", &lines(1)).as_deref(),
            Some("Waiting for review (1)\n- acme/web#1 PR 1")
        );
        let long = section("Checks failing", &lines(12)).unwrap_or_default();
        assert!(long.starts_with("Checks failing (12)\n- acme/web#1 PR 1"));
        assert!(long.ends_with("- acme/web#10 PR 10\n- and 2 more"));
    }

    #[test]
    fn a_repository_subscription_hears_about_no_issues() {
        let sub = sub_row(json!({ "repositoryId": "mrp_1", "teamId": null }));
        assert_eq!(non_empty(&sub, "repositoryId").as_deref(), Some("mrp_1"));
        assert_eq!(non_empty(&sub, "teamId"), None);
    }
}
