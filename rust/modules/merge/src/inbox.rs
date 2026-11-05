//! The inbox: `GET /api/merge/inbox`, derived on every request (nothing
//! stored in phase 1): review requests, the member's pull requests with
//! failed checks or requested changes, issues assigned to them that changed
//! lately, and their recently merged pull requests. Newest first.
//!
//! Permission: `merge_pull_requests:read`. The assigned-issue items need
//! `merge_issues:read` as well and are left out without it.

use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::permission_keys::MERGE_ISSUES_READ;
use weldsuite_events::iso_timestamp;

use crate::db::{col, rows_of, text};
use crate::issues::hydrate_issues;
use crate::pull_requests::{Filter, member_github_login, query_pull_requests, to_list_items};
use crate::{Answer, Caller, all};

const PER_KIND: i64 = 50;
const ASSIGNED_DAYS: i64 = 14;
const MERGED_DAYS: i64 = 3;

/// One inbox entry before sorting: its id, `at`, and the item.
struct Item {
    id: String,
    at: String,
    value: Value,
}

async fn pull_request_items(
    caller: &Caller,
    kind: &str,
    filter: Filter,
    merged_at: bool,
    items: &mut Vec<Item>,
) -> Result<(), sqlx::Error> {
    let rows = query_pull_requests(&caller.db, filter, PER_KIND).await?;
    let list = to_list_items(&caller.db, &rows).await?;
    for (row, item) in rows.iter().zip(list) {
        let at = if merged_at && !col(&row.pr, "mergedAt").is_null() {
            col(&row.pr, "mergedAt")
        } else {
            col(&row.pr, "providerUpdatedAt")
        };
        let id = format!("{kind}:{}", text(&row.pr, "id"));
        let at = at.as_str().unwrap_or_default().to_owned();
        items.push(Item {
            value: json!({ "id": id, "kind": kind, "at": at, "pullRequest": item, "issue": null }),
            id,
            at,
        });
    }
    Ok(())
}

pub(crate) async fn list(caller: Caller) -> Answer {
    let now = OffsetDateTime::now_utc();
    let user_id = caller.user_id.clone();
    let login = member_github_login(&caller.db, &user_id)
        .await?
        .filter(|l| !l.is_empty());
    let mut items: Vec<Item> = Vec::new();
    let mine = || Some((user_id.clone(), login.clone()));

    if let Some(login) = &login {
        pull_request_items(
            &caller,
            "review_requested",
            Filter {
                state: Some("open"),
                draft: Some(false),
                review_requested_from: Some(login.clone()),
                ..Filter::default()
            },
            false,
            &mut items,
        )
        .await?;
    }
    pull_request_items(
        &caller,
        "checks_failed",
        Filter {
            state: Some("open"),
            authored_by: mine(),
            checks_status: Some("failure"),
            ..Filter::default()
        },
        false,
        &mut items,
    )
    .await?;
    pull_request_items(
        &caller,
        "changes_requested",
        Filter {
            state: Some("open"),
            authored_by: mine(),
            review_decision: Some("changes_requested"),
            ..Filter::default()
        },
        false,
        &mut items,
    )
    .await?;
    pull_request_items(
        &caller,
        "merged",
        Filter {
            state: Some("merged"),
            authored_by: mine(),
            merged_since: Some(iso_timestamp(now - time::Duration::days(MERGED_DAYS))),
            ..Filter::default()
        },
        true,
        &mut items,
    )
    .await?;

    if caller.can(MERGE_ISSUES_READ) {
        let rows = rows_of(
            sqlx::query_scalar(
                "select to_jsonb(i) from merge_issues i \
                 where i.assignee_user_id = $1 and i.deleted_at is null and i.updated_at >= $2::timestamptz \
                 order by i.updated_at desc, i.id desc limit $3",
            )
            .bind(&user_id)
            .bind(iso_timestamp(now - time::Duration::days(ASSIGNED_DAYS)))
            .bind(PER_KIND)
            .fetch_all(&caller.db)
            .await?,
        );
        let issues = hydrate_issues(&caller.db, &rows).await?;
        for (row, issue) in rows.iter().zip(issues) {
            let id = format!("assigned:{}", text(row, "id"));
            let at = text(row, "updatedAt").to_owned();
            items.push(Item {
                value: json!({ "id": id, "kind": "assigned", "at": at, "pullRequest": null, "issue": issue }),
                id,
                at,
            });
        }
    }

    // Newest first; the id breaks ties so the order is stable.
    items.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.id.cmp(&a.id)));
    Ok(all(items.into_iter().map(|item| item.value).collect()))
}
