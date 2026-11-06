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
use serde_json::{Map, Value, json};
use weldsuite_catalogs::permission_keys::{COMPANIES_READ, TICKETS_READ};
use weldsuite_chat_domain::access::{Can, can_access_channel};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Issues, Presence, Text};
use weldsuite_kit::{Created, NoContent, generate_id};

use crate::db::{Row, rows_of, text};
use crate::github::millis_of;
use crate::issues::find_issue;
use crate::mappers::{record_link_dto, record_link_event_data};
use crate::{Answer, Caller, MergeState, PendingEvent, Refusal, all, now, publish, validate};

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
/// the issue is already linked to is skipped. The rows inserted.
pub(crate) async fn insert_record_links(
    db: &PgPool,
    issue_id: &str,
    links: &[RecordLinkInput],
    user_id: Option<&str>,
) -> Result<Vec<Row>, sqlx::Error> {
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
    let now = now();
    let ids: Vec<String> = unique.iter().map(|_| generate_id("mrk")).collect();
    let types: Vec<String> = unique.iter().map(|l| l.record_type.clone()).collect();
    let records: Vec<String> = unique.iter().map(|l| l.record_id.clone()).collect();
    // `l.title?.trim() || null`
    let titles: Vec<Option<String>> = unique
        .iter()
        .map(|l| {
            l.title
                .as_deref()
                .map(weldsuite_kit::validation::js_trim)
                .filter(|t| !t.is_empty())
                .map(str::to_owned)
        })
        .collect();
    let rows: Vec<Value> = sqlx::query_scalar(
        "insert into merge_record_links (id, issue_id, record_type, record_id, title, created_by_user_id, created_at) \
         select l.id, $2, l.record_type, l.record_id, l.title, $3, $4::timestamptz \
         from unnest($1::varchar[], $5::varchar[], $6::varchar[], $7::varchar[]) \
           with ordinality as l(id, record_type, record_id, title, n) \
         order by l.n \
         on conflict do nothing returning to_jsonb(merge_record_links.*)",
    )
    .bind(&ids)
    .bind(issue_id)
    .bind(user_id)
    .bind(&now)
    .bind(&types)
    .bind(&records)
    .bind(&titles)
    .fetch_all(db)
    .await?;
    let mut rows = rows_of(rows);
    // In the order they were given.
    rows.sort_by_key(|row| {
        ids.iter()
            .position(|id| id == text(row, "id"))
            .unwrap_or(usize::MAX)
    });
    Ok(rows)
}

/// `listRecordLinks(db, issueId)`: oldest first.
pub(crate) async fn list_record_links(
    db: &PgPool,
    issue_id: &str,
) -> Result<Vec<Row>, sqlx::Error> {
    Ok(rows_of(
        sqlx::query_scalar(
            "select to_jsonb(l) from merge_record_links l where l.issue_id = $1 \
             order by l.created_at asc, l.id asc",
        )
        .bind(issue_id)
        .fetch_all(db)
        .await?,
    ))
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
    ) -> Result<bool, sqlx::Error> {
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
    pub(crate) async fn hide_titles(&mut self, links: &mut [Value]) -> Result<(), sqlx::Error> {
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
pub(crate) async fn visible_detail(
    caller: &Caller,
    mut detail: Value,
) -> Result<Value, sqlx::Error> {
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
    let link: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(l) from merge_record_links l where l.id = $1 and l.issue_id = $2 limit 1",
    )
    .bind(&link_id)
    .bind(&id)
    .fetch_optional(db)
    .await?;
    let Some(link) = link.map(js_row) else {
        return Err(Refusal::not_found("Link", Some(&link_id)));
    };
    sqlx::query("delete from merge_record_links where id = $1")
        .bind(&link_id)
        .execute(db)
        .await?;
    publish(&state, &caller.events, vec![link_event(&link, "deleted")]);
    Ok(NoContent.into_response())
}

/// `shippedReleases(db, issueIds)`: for each issue, the latest shipped release
/// (not deleted) that carries one of its pull requests.
async fn shipped_releases(
    db: &PgPool,
    issue_ids: &[String],
) -> Result<HashMap<String, Value>, sqlx::Error> {
    let mut best: HashMap<String, (f64, String, Value)> = HashMap::new();
    if issue_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "select l.issue_id, to_jsonb(r) from merge_issue_pull_requests l \
         inner join merge_release_pull_requests rp on rp.pull_request_id = l.pull_request_id \
         inner join merge_releases r on r.id = rp.release_id \
         where l.issue_id = any($1) and l.dismissed_at is null \
           and r.status = 'shipped' and r.deleted_at is null",
    )
    .bind(issue_ids)
    .fetch_all(db)
    .await?;
    for (issue_id, release) in rows {
        let release = js_row(release);
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

/// `listLinkedIssues(db, recordType, recordId)`: newest link first, each with
/// the release that shipped it (if any).
pub(crate) async fn list_linked_issues(
    db: &PgPool,
    record_type: &str,
    record_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<(Value, Value, String)> = sqlx::query_as(
        "select to_jsonb(l), to_jsonb(i), t.key from merge_record_links l \
         inner join merge_issues i on i.id = l.issue_id \
         inner join merge_teams t on t.id = i.team_id \
         where l.record_type = $1 and l.record_id = $2 \
           and i.deleted_at is null and t.deleted_at is null \
         order by l.created_at desc, l.id desc",
    )
    .bind(record_type)
    .bind(record_id)
    .fetch_all(db)
    .await?;
    let rows: Vec<(Row, Row, String)> = rows
        .into_iter()
        .map(|(link, issue, key)| (js_row(link), js_row(issue), key))
        .collect();
    let issue_ids: Vec<String> = rows
        .iter()
        .map(|(_, issue, _)| text(issue, "id").to_owned())
        .collect();
    let releases = shipped_releases(db, &issue_ids).await?;
    Ok(rows
        .iter()
        .map(|(link, issue, team_key)| {
            json!({
                "link": record_link_dto(link),
                "issue": {
                    "id": issue["id"],
                    "key": format!("{team_key}-{}", issue["number"]),
                    "title": issue["title"],
                    "status": issue["status"],
                    "teamId": issue["teamId"],
                    "teamKey": team_key,
                },
                "release": releases.get(text(issue, "id")).cloned().unwrap_or(Value::Null),
            })
        })
        .collect())
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
