//! Record links (`services/record-links.ts`, routes `issues/links.ts` and
//! `record-links`): what a ticket, a company or a chat channel shows of
//! WeldMerge.
//!
//! ```text
//!   GET    /issues/:id/links          → the records the issue is linked to      (merge_issues:read)
//!   POST   /issues/:id/links          → link a ticket, company or chat channel   (merge_issues:update)
//!   DELETE /issues/:id/links/:linkId  → remove a link                            (merge_issues:update)
//!   GET    /record-links?recordType=&recordId=
//!                                     → the issues a record is linked to, each with its status,
//!                                       team key and the shipped release (if any) (merge_issues:read)
//! ```
//!
//! Creating links is [`insert_record_links`], which also backs `POST /issues`
//! with `links[]`. Events: `merge_record_link` created | deleted.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use http::HeaderMap;
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DbErr, EntityTrait, FromQueryResult, JoinType, QueryFilter,
    QueryOrder, QuerySelect, RelationDef,
};
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::{COMPANIES_READ, TICKETS_READ};
use weldsuite_chat_domain::access::{Can, can_access_channel};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{Created, NoContent, generate_id};
use weldsuite_schema::tenant::{
    merge_issue_pull_requests, merge_issues, merge_record_links, merge_release_pull_requests,
    merge_releases, merge_teams,
};

use crate::db::{Row, json_row, text};
use crate::github::millis_of;
use crate::issues::find_issue;
use crate::mappers::{record_link_dto, record_link_event_data};
use crate::{Answer, Caller, MergeState, PendingEvent, Refusal, all, publish, validate};

/// `MERGE_RECORD_TYPES`.
pub(crate) const RECORD_TYPES: [&str; 3] = ["desk_ticket", "crm_company", "chat_channel"];

/// `createMergeRecordLinkSchema`, as validated.
#[derive(Debug, Clone)]
pub(crate) struct RecordLinkInput {
    pub(crate) record_type: String,
    pub(crate) record_id: String,
    pub(crate) title: Option<String>,
}

/// `createMergeRecordLinkSchema` read from `fields`.
pub(crate) fn read_link_fields(
    issues: &mut Issues,
    fields: &Map<String, Value>,
) -> Option<RecordLinkInput> {
    let before = issues.count();
    let record_type = issues
        .choice(fields, "recordType", Presence::Required, &RECORD_TYPES)
        .into_option();
    let record_id = issues
        .text(fields, "recordId", Presence::Required, Some(1), Some(255))
        .into_option();
    let title = issues
        .text_with(
            fields,
            "title",
            Presence::Nullish,
            Text::trimmed(None, Some(500)),
        )
        .into_option();
    if issues.count() > before {
        return None;
    }
    Some(RecordLinkInput {
        record_type: record_type?,
        record_id: record_id?,
        title,
    })
}

/// One item of `links[]` (`z.array(createMergeRecordLinkSchema)`).
pub(crate) fn read_link(issues: &mut Issues, item: &Value) -> Option<RecordLinkInput> {
    let fields = issues.object(item)?;
    read_link_fields(issues, fields)
}

/// `insertRecordLinks(db, issueId, links, userId)`: a repeated record is
/// stored once (the first mention wins: it may carry the title), and a record
/// the issue is already linked to is skipped (`onConflictDoNothing`). The
/// rows inserted.
pub(crate) async fn insert_record_links(
    db: &PgPool,
    issue_id: &str,
    links: &[RecordLinkInput],
    user_id: Option<&str>,
) -> Result<Vec<Row>, DbErr> {
    if links.is_empty() {
        return Ok(Vec::new());
    }
    let mut unique: Vec<&RecordLinkInput> = Vec::new();
    for link in links {
        if !unique
            .iter()
            .any(|u| u.record_type == link.record_type && u.record_id == link.record_id)
        {
            unique.push(link);
        }
    }
    let at = utc_now().assume_utc();
    let ids: Vec<String> = unique.iter().map(|_| generate_id("mrk")).collect();
    let models = unique
        .iter()
        .zip(&ids)
        .map(|(link, id)| merge_record_links::ActiveModel {
            id: Set(id.clone()),
            issue_id: Set(issue_id.to_owned()),
            record_type: Set(link.record_type.clone()),
            record_id: Set(link.record_id.clone()),
            // `l.title?.trim() || null`
            title: Set(link
                .title
                .as_deref()
                .map(weldsuite_kit::validation::js_trim)
                .filter(|t| !t.is_empty())
                .map(str::to_owned)),
            created_by_user_id: Set(user_id.map(str::to_owned)),
            created_at: Set(at),
        });
    let inserted = merge_record_links::Entity::insert_many(models)
        .on_conflict(OnConflict::new().do_nothing().to_owned())
        .exec_with_returning(&orm(db))
        .await?;
    let mut rows = inserted
        .into_iter()
        .map(|link| json_row(serde_json::to_value(link)))
        .collect::<Result<Vec<Row>, DbErr>>()?;
    // In the order they were given.
    rows.sort_by_key(|row| {
        ids.iter()
            .position(|id| id == text(row, "id"))
            .unwrap_or(usize::MAX)
    });
    Ok(rows)
}

/// `listRecordLinks(db, issueId)`: oldest first.
pub(crate) async fn list_record_links(db: &PgPool, issue_id: &str) -> Result<Vec<Row>, DbErr> {
    merge_record_links::Entity::find()
        .filter(merge_record_links::Column::IssueId.eq(issue_id))
        .order_by_asc(merge_record_links::Column::CreatedAt)
        .order_by_asc(merge_record_links::Column::Id)
        .all(&orm(db))
        .await?
        .into_iter()
        .map(|link| json_row(serde_json::to_value(link)))
        .collect()
}

/// `recordTitleAccess(db, userId, can)`: a link's stored title is the
/// record's (a ticket subject, a company name, a channel name), not
/// WeldMerge's, so `merge_issues:read` alone does not show it. The caller
/// sees it with the linked module's read permission (`tickets:read`,
/// `companies:read`), or for a chat channel when they may read the channel
/// (`canAccessChannel`). Answers are kept for the request.
pub(crate) struct TitleAccess<'a> {
    db: &'a PgPool,
    user_id: &'a str,
    can: Can<'a>,
    answers: HashMap<String, bool>,
}

impl<'a> TitleAccess<'a> {
    /// `titleAccess(c)`: for the request's caller, with its permissions.
    pub(crate) fn of(caller: &'a Caller) -> Self {
        Self {
            db: &caller.db,
            user_id: &caller.user_id,
            can: Can::Context(&caller.permissions),
            answers: HashMap::new(),
        }
    }

    /// `recordTitleAccess(db, userId, userPermissionCheck(db, userId))`: for
    /// a member an internal call acts for, with their permissions as they
    /// are now.
    pub(crate) fn for_member(db: &'a PgPool, user_id: &'a str) -> Self {
        Self {
            db,
            user_id,
            can: Can::user(db, user_id),
            answers: HashMap::new(),
        }
    }

    /// Whether the caller may read the record's title.
    pub(crate) async fn visible(
        &mut self,
        record_type: &str,
        record_id: &str,
    ) -> Result<bool, DbErr> {
        let key = if record_type == "chat_channel" {
            format!("chat_channel:{record_id}")
        } else {
            record_type.to_owned()
        };
        if let Some(answer) = self.answers.get(&key) {
            return Ok(*answer);
        }
        let answer = match record_type {
            "chat_channel" => {
                can_access_channel(self.db, record_id, self.user_id, Some(&self.can)).await?
            }
            "desk_ticket" => self.can.can(TICKETS_READ).await?,
            "crm_company" => self.can.can(COMPANIES_READ).await?,
            _ => false,
        };
        self.answers.insert(key, answer);
        Ok(answer)
    }

    /// `withVisibleTitles(access, links)`: `title` null on each link DTO
    /// (`recordType`, `recordId`, `title`) whose record the caller may not read.
    pub(crate) async fn hide_titles(&mut self, links: &mut [Value]) -> Result<(), DbErr> {
        for link in links.iter_mut() {
            if link.get("title").is_none_or(Value::is_null) {
                continue;
            }
            let (record_type, record_id) = (
                text(link, "recordType").to_owned(),
                text(link, "recordId").to_owned(),
            );
            if !self.visible(&record_type, &record_id).await? {
                link["title"] = Value::Null;
            }
        }
        Ok(())
    }
}

/// `visibleDetail(c, detail)`: an issue detail with the linked records'
/// titles the caller may not read left out.
pub(crate) async fn visible_detail(caller: &Caller, mut detail: Value) -> Result<Value, DbErr> {
    if let Some(links) = detail.get_mut("recordLinks").and_then(Value::as_array_mut) {
        TitleAccess::of(caller).hide_titles(links).await?;
    }
    Ok(detail)
}

fn link_event(row: &Row, action: &'static str) -> PendingEvent {
    PendingEvent::new(
        "merge_record_link",
        action,
        text(row, "id"),
        record_link_event_data(row),
    )
}

/// `GET /issues/:id/links`.
pub(crate) async fn list(caller: Caller, Path(id): Path<String>) -> Answer {
    if find_issue(&caller.db, &id).await?.is_none() {
        return Err(Refusal::not_found("Issue", Some(&id)));
    }
    let rows = list_record_links(&caller.db, &id).await?;
    let mut links: Vec<Value> = rows.iter().map(record_link_dto).collect();
    TitleAccess::of(&caller).hide_titles(&mut links).await?;
    Ok(all(links))
}

/// `POST /issues/:id/links`.
pub(crate) async fn create(
    State(state): State<MergeState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Answer {
    let input = validate(&headers, &body, read_link_fields)?;
    let Some(input) = input else {
        return Err(Refusal::bad_request("Invalid request body"));
    };
    if find_issue(&caller.db, &id).await?.is_none() {
        return Err(Refusal::not_found("Issue", Some(&id)));
    }
    let inserted = insert_record_links(&caller.db, &id, &[input], Some(&caller.user_id)).await?;
    let Some(link) = inserted.into_iter().next() else {
        return Err(Refusal::conflict(
            "The issue is already linked to this record",
        ));
    };
    publish(&state, &caller.events, vec![link_event(&link, "created")]);
    Ok(Created(record_link_dto(&link)).into_response())
}

/// `DELETE /issues/:id/links/:linkId`.
pub(crate) async fn remove(
    State(state): State<MergeState>,
    caller: Caller,
    Path((id, link_id)): Path<(String, String)>,
) -> Answer {
    let db = &caller.db;
    if find_issue(db, &id).await?.is_none() {
        return Err(Refusal::not_found("Issue", Some(&id)));
    }
    let link = merge_record_links::Entity::find()
        .filter(merge_record_links::Column::Id.eq(&link_id))
        .filter(merge_record_links::Column::IssueId.eq(&id))
        .one(&orm(db))
        .await?;
    let Some(link) = link else {
        return Err(Refusal::not_found("Link", Some(&link_id)));
    };
    merge_record_links::Entity::delete_by_id(link_id.clone())
        .exec(&orm(db))
        .await?;
    let link = json_row(serde_json::to_value(link))?;
    publish(&state, &caller.events, vec![link_event(&link, "deleted")]);
    Ok(NoContent.into_response())
}

/// A release with the issue whose pull request it carries.
#[derive(FromQueryResult)]
struct ShippedRelease {
    #[sea_orm(nested)]
    release: merge_releases::Model,
    link_issue_id: String,
}

/// `shippedReleases(db, issueIds)`: for each issue, the latest shipped release
/// (not deleted) that carries one of its pull requests.
async fn shipped_releases(
    db: &PgPool,
    issue_ids: &[String],
) -> Result<HashMap<String, Value>, DbErr> {
    let mut best: HashMap<String, (f64, String, Value)> = HashMap::new();
    if issue_ids.is_empty() {
        return Ok(HashMap::new());
    }
    // `merge_releases r` ⋈ `merge_release_pull_requests rp` ⋈ `merge_issue_pull_requests l`.
    let release_pull_requests: RelationDef =
        merge_releases::Entity::belongs_to(merge_release_pull_requests::Entity)
            .from(merge_releases::Column::Id)
            .to(merge_release_pull_requests::Column::ReleaseId)
            .into();
    let issue_links: RelationDef =
        merge_release_pull_requests::Entity::belongs_to(merge_issue_pull_requests::Entity)
            .from(merge_release_pull_requests::Column::PullRequestId)
            .to(merge_issue_pull_requests::Column::PullRequestId)
            .into();
    let rows = merge_releases::Entity::find()
        .column_as(merge_issue_pull_requests::Column::IssueId, "link_issue_id")
        .join(JoinType::InnerJoin, release_pull_requests)
        .join(JoinType::InnerJoin, issue_links)
        .filter(merge_issue_pull_requests::Column::IssueId.is_in(issue_ids))
        .filter(merge_issue_pull_requests::Column::DismissedAt.is_null())
        .filter(merge_releases::Column::Status.eq("shipped"))
        .filter(merge_releases::Column::DeletedAt.is_null())
        .into_model::<ShippedRelease>()
        .all(&orm(db))
        .await?;
    for ShippedRelease {
        release,
        link_issue_id: issue_id,
    } in rows
    {
        let release = json_row(serde_json::to_value(release))?;
        let shipped_at = release.get("shippedAt").cloned().unwrap_or(Value::Null);
        let at = shipped_at.as_str().and_then(millis_of).unwrap_or(0.0);
        let id = text(&release, "id").to_owned();
        let better = match best.get(&issue_id) {
            None => true,
            Some((current_at, current_id, _)) => {
                at > *current_at || ((at - *current_at).abs() < f64::EPSILON && id > *current_id)
            }
        };
        if better {
            let summary = json!({
                "id": id,
                "name": release.get("name").cloned().unwrap_or(Value::Null),
                "version": release.get("version").cloned().unwrap_or(Value::Null),
                "shippedAt": shipped_at,
            });
            best.insert(issue_id, (at, id, summary));
        }
    }
    Ok(best
        .into_iter()
        .map(|(issue_id, (_, _, release))| (issue_id, release))
        .collect())
}

/// A record's link with what the list shows of its issue and team.
#[derive(FromQueryResult)]
struct LinkedIssue {
    #[sea_orm(nested)]
    link: merge_record_links::Model,
    issue_number: i32,
    issue_title: String,
    issue_status: String,
    issue_team_id: String,
    team_key: String,
}

/// `listLinkedIssues(db, recordType, recordId)`: newest link first, each with
/// the release that shipped it (if any).
pub(crate) async fn list_linked_issues(
    db: &PgPool,
    record_type: &str,
    record_id: &str,
) -> Result<Vec<Value>, DbErr> {
    let issue: RelationDef = merge_record_links::Entity::belongs_to(merge_issues::Entity)
        .from(merge_record_links::Column::IssueId)
        .to(merge_issues::Column::Id)
        .into();
    let team: RelationDef = merge_issues::Entity::belongs_to(merge_teams::Entity)
        .from(merge_issues::Column::TeamId)
        .to(merge_teams::Column::Id)
        .into();
    let rows = merge_record_links::Entity::find()
        .column_as(merge_issues::Column::Number, "issue_number")
        .column_as(merge_issues::Column::Title, "issue_title")
        .column_as(merge_issues::Column::Status, "issue_status")
        .column_as(merge_issues::Column::TeamId, "issue_team_id")
        .column_as(merge_teams::Column::Key, "team_key")
        .join(JoinType::InnerJoin, issue)
        .join(JoinType::InnerJoin, team)
        .filter(merge_record_links::Column::RecordType.eq(record_type))
        .filter(merge_record_links::Column::RecordId.eq(record_id))
        .filter(merge_issues::Column::DeletedAt.is_null())
        .filter(merge_teams::Column::DeletedAt.is_null())
        .order_by_desc(merge_record_links::Column::CreatedAt)
        .order_by_desc(merge_record_links::Column::Id)
        .into_model::<LinkedIssue>()
        .all(&orm(db))
        .await?;
    let issue_ids: Vec<String> = rows.iter().map(|row| row.link.issue_id.clone()).collect();
    let releases = shipped_releases(db, &issue_ids).await?;
    rows.into_iter()
        .map(|row| {
            let issue_id = row.link.issue_id.clone();
            let team_key = row.team_key;
            Ok(json!({
                "link": record_link_dto(&json_row(serde_json::to_value(row.link))?),
                "issue": {
                    "id": issue_id,
                    "key": format!("{team_key}-{}", row.issue_number),
                    "title": row.issue_title,
                    "status": row.issue_status,
                    "teamId": row.issue_team_id,
                    "teamKey": team_key,
                },
                "release": releases.get(&issue_id).cloned().unwrap_or(Value::Null),
            }))
        })
        .collect()
}

/// `GET /record-links?recordType=&recordId=`.
pub(crate) async fn lookup(caller: Caller, RawQuery(query): RawQuery) -> Answer {
    let (record_type, record_id) = crate::validate_query(query.as_deref(), |issues, fields| {
        let record_type = issues
            .choice(fields, "recordType", Presence::Required, &RECORD_TYPES)
            .into_option()
            .unwrap_or_default();
        let record_id = issues
            .text(fields, "recordId", Presence::Required, Some(1), None)
            .into_option()
            .unwrap_or_default();
        (record_type, record_id)
    })?;
    let mut rows = list_linked_issues(&caller.db, &record_type, &record_id).await?;
    // The record's own title only for a caller who may read the record.
    if !rows.is_empty()
        && !TitleAccess::of(&caller)
            .visible(&record_type, &record_id)
            .await?
    {
        for row in &mut rows {
            row["link"]["title"] = Value::Null;
        }
    }
    Ok(all(rows))
}
