//! Telling members about responses (`services/notify.ts`,
//! `services/digest.ts`, `services/quota-notice.ts`): instant subscribers get
//! a platform notification, with the `forms.response` email when they are
//! away (the notifications crate's gate, EVT-008); daily subscribers get the
//! digest around 08:00 UTC; owners and admins get the quota notices at 80 %
//! and 100 % of the month's responses.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use time::OffsetDateTime;
use weldsuite_catalogs::permission_keys::FORM_RESPONSES_READ;
use weldsuite_db::orm;
use weldsuite_emails::forms::DigestItem;
use weldsuite_notifications::{EmailOverride, NewNotification, Notifier, create_and_deliver};
use weldsuite_schema::tenant::{
    form_access, form_responses, form_subscriptions, form_versions, notifications,
    workspace_members,
};

use crate::common::{
    Ctx, Env, FormsResult, day_of, epoch_ms, instant, js_slice, month_of, opt_text, parse_ms,
    rows_json, text,
};
use crate::creator_access::load_creator_access;
use crate::engine::FormDefinition;
use crate::mail::{
    MemberRecipient, results_url, send_digest_mail, send_quota_mail,
    send_response_notification_mail, workspace_name,
};
use crate::response_text::{answer_pairs, has_sensitive_fields};
use crate::usage::load_usage;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// The due-index kind of the daily digest.
pub(crate) const DIGEST_KIND: &str = "forms_digest";
const LISTED: u64 = 10;
const SUMMARY_CHARS: usize = 80;

/// `subscribersOf(db, env, form, mode)`: members following the form in
/// `mode` who may still read its answers, which the instant mail and the
/// digest carry: on a restricted form only the owner and its access list,
/// and anywhere only members who hold `form_responses:read` now (resolved
/// as the steps resolve an integration's creator), so a member who lost it
/// after subscribing gets nothing.
pub(crate) async fn subscribers_of(
    db: &PgPool,
    env: &Env,
    form: &Value,
    mode: &str,
) -> FormsResult<Vec<MemberRecipient>> {
    let form_id = text(form, "id");
    let orm_db = orm(db);
    let mut user_ids: Vec<String> = form_subscriptions::Entity::find()
        .select_only()
        .column(form_subscriptions::Column::UserId)
        .filter(form_subscriptions::Column::FormId.eq(form_id))
        .filter(form_subscriptions::Column::Mode.eq(mode))
        .into_tuple()
        .all(&orm_db)
        .await?;
    if !user_ids.is_empty() && text(form, "access") == "restricted" {
        let mut allowed: HashSet<String> = HashSet::new();
        allowed.insert(text(form, "ownerUserId").to_owned());
        let listed: Vec<String> = form_access::Entity::find()
            .select_only()
            .column(form_access::Column::UserId)
            .filter(form_access::Column::FormId.eq(form_id))
            .into_tuple()
            .all(&orm_db)
            .await?;
        allowed.extend(listed);
        user_ids.retain(|id| allowed.contains(id));
    }
    let mut readers = Vec::with_capacity(user_ids.len());
    for user_id in user_ids {
        if load_creator_access(db, env, &user_id)
            .await?
            .can(FORM_RESPONSES_READ, "weldforms")
        {
            readers.push(user_id);
        }
    }
    let user_ids = readers;
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }
    let members: Vec<(String, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::UserId,
            workspace_members::Column::Email,
        ])
        .filter(workspace_members::Column::UserId.is_in(user_ids))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm_db)
        .await?;
    Ok(members
        .into_iter()
        .filter_map(|(user_id, email)| {
            email
                .filter(|e| !e.is_empty())
                .map(|email| MemberRecipient { user_id, email })
        })
        .collect())
}

/// `nextDigestAt(now)`: the next 08:00 UTC after `now`.
pub(crate) fn next_digest_at(now: i64) -> i64 {
    let day = parse_ms(&format!("{}T08:00:00.000Z", day_of(now))).unwrap_or(now);
    if day > now { day } else { day + DAY_MS }
}

/// `notifySubscribers(ctx)`: one platform notification per instant
/// subscriber, and the digest marked due when anyone follows daily.
#[allow(clippy::too_many_lines, reason = "the worker's steps, in its order")]
pub(crate) async fn notify_subscribers(
    ctx: &Ctx,
    form: &Value,
    response: &Value,
    definition: &FormDefinition,
) -> FormsResult<()> {
    let now = ctx.now_ms();
    let instant = subscribers_of(&ctx.db, ctx.env(), form, "instant").await?;
    let daily = subscribers_of(&ctx.db, ctx.env(), form, "daily").await?;
    let respondent = opt_text(response, "respondentEmail");
    let answers = if has_sensitive_fields(definition) {
        None
    } else {
        Some(answer_pairs(definition, &response["answers"], false))
    };
    let form_id = text(form, "id");
    let response_id = text(response, "id");
    let title = text(form, "title");
    let action_url = format!("/weldforms/{form_id}/results?tab=responses&response={response_id}");
    let url = results_url(
        ctx.env(),
        &ctx.clerk_org_id,
        form_id,
        &format!("tab=responses&response={response_id}"),
    );
    let number = response["number"].as_i64();
    // The email goes out here, gated on what the row says (`delivered_email`).
    let notifier = Notifier {
        realtime: ctx.svc.realtime.clone(),
        presence: None,
        mail: None,
        http: None,
        apns: None,
    };
    let answers_json: Value = answers.as_ref().map_or(Value::Null, |pairs| {
        Value::Array(
            pairs
                .iter()
                .map(|qa| json!({ "question": qa.question, "answer": qa.answer }))
                .collect(),
        )
    });
    for member in &instant {
        let params = NewNotification {
            workspace_id: ctx.clerk_org_id.clone(),
            clerk_org_id: Some(ctx.clerk_org_id.clone()),
            user_id: member.user_id.clone(),
            title: format!("New response to \"{title}\""),
            body: respondent.as_deref().map_or_else(
                || "Someone answered your form.".to_owned(),
                |r| format!("From {r}"),
            ),
            category: "weldforms".to_owned(),
            notification_type: "form_response".to_owned(),
            entity_type: "form_response".to_owned(),
            entity_id: response_id.to_owned(),
            action_url: action_url.clone(),
            severity: "info".to_owned(),
            actor_type: Some("system".to_owned()),
            actor_id: None,
            exclude_email: false,
            exclude_push: false,
            exclude_in_app: false,
            data: vec![
                ("formId".to_owned(), form_id.to_owned()),
                ("responseId".to_owned(), response_id.to_owned()),
            ],
            email: Some(EmailOverride {
                template: "forms.response".to_owned(),
                props: json!({
                    "title": title,
                    "number": number,
                    "respondent": respondent,
                    "answers": answers_json,
                    "url": url,
                }),
            }),
        };
        match create_and_deliver(&ctx.db, &notifier, &params).await {
            Ok(Some(id)) => {
                let emailed: Option<bool> = notifications::Entity::find_by_id(id.as_str())
                    .select_only()
                    .column(notifications::Column::DeliveredEmail)
                    .into_tuple()
                    .one(&orm(&ctx.db))
                    .await?;
                if emailed == Some(true) {
                    send_response_notification_mail(
                        ctx,
                        &ctx.db,
                        &member.user_id,
                        form,
                        number,
                        respondent.as_deref(),
                        answers.as_deref(),
                        &url,
                    )
                    .await;
                }
            }
            Ok(None) => {}
            Err(error) => tracing::error!(
                %error,
                user = member.user_id,
                "[forms-api/notify] notifying a member failed"
            ),
        }
    }
    if !daily.is_empty()
        && let Some(master) = ctx.master.as_ref()
    {
        weldsuite_db::due_index::mark_due(
            master,
            DIGEST_KIND,
            &ctx.workspace_id,
            crate::common::instant(next_digest_at(now)),
        )
        .await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

/// When each daily subscriber of the form got their last digest.
async fn digest_marks(
    db: &DatabaseConnection,
    form_id: &str,
) -> FormsResult<HashMap<String, Option<i64>>> {
    let marks: Vec<(String, Option<OffsetDateTime>)> = form_subscriptions::Entity::find()
        .select_only()
        .columns([
            form_subscriptions::Column::UserId,
            form_subscriptions::Column::LastDigestAt,
        ])
        .filter(form_subscriptions::Column::FormId.eq(form_id))
        .filter(form_subscriptions::Column::Mode.eq("daily"))
        .into_tuple()
        .all(db)
        .await?;
    Ok(marks
        .into_iter()
        .map(|(user, at)| (user, at.map(epoch_ms)))
        .collect())
}

/// The digest's lines for `rows`: number, respondent and the first answer,
/// none of a version with sensitive questions. `versions` keeps the
/// definitions read so far.
async fn digest_items(
    db: &DatabaseConnection,
    rows: &[Value],
    versions: &mut HashMap<String, Option<FormDefinition>>,
) -> FormsResult<Vec<DigestItem>> {
    let mut listed = Vec::new();
    for row in rows {
        let version_id = text(row, "versionId").to_owned();
        if !versions.contains_key(&version_id) {
            let definition: Option<Value> = form_versions::Entity::find_by_id(version_id.as_str())
                .select_only()
                .column(form_versions::Column::Definition)
                .into_tuple()
                .one(db)
                .await?;
            if let Some(definition) = definition {
                versions.insert(version_id.clone(), FormDefinition::parse(&definition).ok());
            }
        }
        let first = versions
            .get(&version_id)
            .and_then(Option::as_ref)
            .filter(|def| !has_sensitive_fields(def))
            .and_then(|def| answer_pairs(def, &row["answers"], false).into_iter().next());
        listed.push(DigestItem {
            number: row["number"].as_i64(),
            respondent: opt_text(row, "respondentEmail"),
            summary: first.map(|qa| js_slice(&qa.answer, SUMMARY_CHARS)),
        });
    }
    Ok(listed)
}

/// `sendDueDigests(ctx, now)`: for each daily subscriber of each form, the
/// completed responses since their last digest, in one mail. How many went out.
pub(crate) async fn send_due_digests(ctx: &Ctx, now: i64) -> FormsResult<i64> {
    let db = orm(&ctx.db);
    let with_daily: Vec<String> = form_subscriptions::Entity::find()
        .select_only()
        .column(form_subscriptions::Column::FormId)
        .filter(form_subscriptions::Column::Mode.eq("daily"))
        .group_by(form_subscriptions::Column::FormId)
        .into_tuple()
        .all(&db)
        .await?;
    let mut sent = 0;
    for form_id in with_daily {
        let Some(form) = crate::access::form_row(&ctx.db, &form_id).await? else {
            continue;
        };
        let members = subscribers_of(&ctx.db, ctx.env(), &form, "daily").await?;
        if members.is_empty() {
            continue;
        }
        let marks = digest_marks(&db, &form_id).await?;
        let mut versions: HashMap<String, Option<FormDefinition>> = HashMap::new();
        for member in &members {
            let since = marks
                .get(&member.user_id)
                .copied()
                .flatten()
                .unwrap_or(now - DAY_MS);
            let window = form_responses::Entity::find()
                .filter(form_responses::Column::FormId.eq(form_id.as_str()))
                .filter(form_responses::Column::Status.eq("completed"))
                .filter(form_responses::Column::SubmittedAt.gt(instant(since)))
                .filter(form_responses::Column::SubmittedAt.lte(instant(now)));
            let total = window.clone().count(&db).await?;
            let total = i64::try_from(total).unwrap_or(i64::MAX);
            if total == 0 {
                continue;
            }
            let rows = rows_json(
                window
                    .order_by_desc(form_responses::Column::SubmittedAt)
                    .limit(LISTED)
                    .all(&db)
                    .await?,
            )?;
            let listed = digest_items(&db, &rows, &mut versions).await?;
            if send_digest_mail(ctx, &form, member, total, &listed).await? {
                sent += 1;
                form_subscriptions::Entity::update_many()
                    .col_expr(
                        form_subscriptions::Column::LastDigestAt,
                        Expr::value(instant(now)),
                    )
                    .col_expr(
                        form_subscriptions::Column::UpdatedAt,
                        Expr::value(instant(now)),
                    )
                    .filter(form_subscriptions::Column::FormId.eq(form_id.as_str()))
                    .filter(form_subscriptions::Column::UserId.eq(member.user_id.as_str()))
                    .exec(&db)
                    .await?;
            }
        }
    }
    Ok(sent)
}

// ---------------------------------------------------------------------------
// Quota notices
// ---------------------------------------------------------------------------

const QUOTA_THRESHOLDS: [u8; 2] = [80, 100];

/// `quotaNoticeKey(workspaceId, month, percent)`.
fn quota_notice_key(workspace_id: &str, month: &str, percent: u8) -> String {
    format!("forms:quota-notice:{workspace_id}:{month}:{percent}")
}

/// `adminsOf(ctx)`: active owners and admins with an address.
async fn admins_of(db: &PgPool) -> FormsResult<Vec<MemberRecipient>> {
    let rows: Vec<(String, Option<String>)> = workspace_members::Entity::find()
        .select_only()
        .columns([
            workspace_members::Column::UserId,
            workspace_members::Column::Email,
        ])
        .filter(workspace_members::Column::Role.is_in(["OWNER", "ADMIN"]))
        .filter(workspace_members::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(user_id, email)| {
            email
                .filter(|e| !e.is_empty())
                .map(|email| MemberRecipient { user_id, email })
        })
        .collect())
}

/// `sendQuotaNotices(ctx, now)`: the notice of the highest threshold reached
/// that was not sent yet this month; the lower one it skipped is marked too.
pub(crate) async fn send_quota_notices(ctx: &Ctx) -> FormsResult<Option<u8>> {
    let now = ctx.now_ms();
    let usage = load_usage(ctx, now).await?;
    let Some(limit) = usage.limit.filter(|limit| *limit > 0) else {
        return Ok(None);
    };
    let month = month_of(now);
    let mut unsent = Vec::new();
    for threshold in QUOTA_THRESHOLDS {
        if usage.used * 100 >= limit * i64::from(threshold)
            && ctx
                .svc
                .cache
                .get_boxed(&quota_notice_key(&ctx.workspace_id, &month, threshold))
                .await?
                .is_none()
        {
            unsent.push(threshold);
        }
    }
    let Some(&percent) = unsent.last() else {
        return Ok(None);
    };
    for threshold in &unsent {
        ctx.svc
            .cache
            .put_boxed(
                &quota_notice_key(&ctx.workspace_id, &month, *threshold),
                "1",
                Some(Duration::from_hours(40 * 24)),
            )
            .await?;
    }
    let name = workspace_name(ctx)
        .await?
        .unwrap_or_else(|| "WeldSuite".to_owned());
    for admin in admins_of(&ctx.db).await? {
        send_quota_mail(
            ctx,
            &admin,
            &name,
            percent,
            usage.used,
            limit,
            &usage.period_end,
        )
        .await;
    }
    Ok(Some(percent))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::iso;

    #[test]
    fn the_digest_is_due_at_eight_utc() {
        let morning = parse_ms("2026-11-10T07:45:00.000Z").unwrap_or_default();
        assert_eq!(iso(next_digest_at(morning)), "2026-11-10T08:00:00.000Z");
        let eight = parse_ms("2026-11-10T08:00:00.000Z").unwrap_or_default();
        assert_eq!(iso(next_digest_at(eight)), "2026-11-11T08:00:00.000Z");
        assert_eq!(
            quota_notice_key("ws", "2026-11", 80),
            "forms:quota-notice:ws:2026-11:80"
        );
    }
}
