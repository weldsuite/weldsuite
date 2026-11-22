//! Invitations (`services/invitations.ts`): a personal link per person
//! (members, CRM people, a CRM list, pasted addresses), their status,
//! reminders by hand and automatic, and revoke.
//!
//! A link is `<portal>/i/<publicId>.<token>`; the token is 32 random bytes and
//! only its SHA-256 is kept, in the master `form_invitation_registry` (which
//! the respondent session reads). A reminder mints a fresh token, since the
//! first cannot be recovered from its hash; every token of an invitation stays
//! valid until it is revoked or completed. The outbound guard checks a whole
//! batch before anything is written; a refusal sends nothing.
//!
//! Each invitation's reminder schedule (`afterDays`, `everyDays`, `maxCount`)
//! is fixed when it is sent, from the request or the workspace defaults, and
//! kept on its row (`reminder_*` columns; `maxCount` 0 = no automatic
//! reminders).

use std::collections::{HashMap, HashSet};

use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, JoinType, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, RelationDef,
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_db::orm;
use weldsuite_schema::master::form_invitation_registry;
use weldsuite_schema::tenant::{
    form_invitations, form_responses, form_settings, form_versions, list_members, lists, people,
    workspace_members,
};

use crate::common::{
    Ctx, Fail, FormsResult, epoch_ms, forms_error, instant, int, not_found, opt_text, parse_ms,
    row_json, rows_json, text,
};
use crate::crypto::{random_bytes, sha256_hex};
use crate::engine::FormDefinition;
use crate::engine::answers::is_valid_email;
use crate::mail::{
    InviteMail, Reserved, guard_of, invitation_url, reserve_outbound_mail, send_invitation_mails,
    settle_outbound_mail,
};
use crate::members::member_ref;
use crate::model::FormSettings;
use crate::usage::load_usage;

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;
/// After the guard refuses a reminder, or its mail could not be sent, the
/// sweep tries again later.
const REFUSED_RETRY_MS: i64 = 6 * HOUR_MS;
/// `FORM_LIMITS.maxInvitationsPerBatch`.
pub(crate) const MAX_INVITATIONS_PER_BATCH: usize = 500;

/// The due-index kind of the automatic reminders.
pub(crate) const REMINDERS_KIND: &str = "forms_reminders";

const REFUSED_MESSAGE: &str =
    "Your workspace cannot send these emails right now. Nothing was sent.";

/// The statuses of an invitation that can still be answered (and reminded).
const OPEN_STATUSES: [&str; 3] = ["sent", "opened", "started"];

/// `toInvitationDto(row)`.
pub(crate) fn to_invitation_dto(row: &Value) -> Value {
    json!({
        "id": row["id"],
        "formId": row["formId"],
        "email": row["email"],
        "name": row["name"],
        "personId": row["personId"],
        "userId": row["userId"],
        "locale": row["locale"],
        "status": row["status"],
        "remindersSent": row["remindersSent"],
        "responseId": row["responseId"],
        "sentAt": row["sentAt"],
        "openedAt": row["openedAt"],
        "startedAt": row["startedAt"],
        "completedAt": row["completedAt"],
        "lastRemindedAt": row["lastRemindedAt"],
        "nextReminderAt": row["nextReminderAt"],
        "revokedAt": row["revokedAt"],
        "createdAt": row["createdAt"],
    })
}

/// The entity event's data (`{ id, formId, email, personId }`, `reminder: true` for reminders).
pub(crate) fn event_data(row: &Value, reminder: bool) -> Value {
    let mut data = json!({
        "id": row["id"],
        "formId": row["formId"],
        "email": row["email"],
        "personId": row["personId"],
    });
    if reminder {
        data["reminder"] = Value::Bool(true);
    }
    data
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/// `newInvitationToken()`: 32 random bytes as 64 hex characters.
fn new_invitation_token() -> String {
    hex::encode(random_bytes::<32>())
}

async fn register_token(
    ctx: &Ctx,
    form_id: &str,
    invitation_id: &str,
    token: &str,
) -> FormsResult<()> {
    form_invitation_registry::Entity::insert(form_invitation_registry::ActiveModel {
        id: Set(weldsuite_kit::generate_id("fir")),
        token_hash: Set(sha256_hex(token.as_bytes())),
        workspace_id: Set(ctx.workspace_id.clone()),
        clerk_org_id: Set(ctx.clerk_org_id.clone()),
        form_id: Set(form_id.to_owned()),
        invitation_id: Set(invitation_id.to_owned()),
        ..Default::default()
    })
    .exec_without_returning(&orm(ctx.master()?))
    .await?;
    Ok(())
}

/// `forgetTokens(ctx, tokens)`: takes tokens out of the registry again,
/// their links were never sent.
async fn forget_tokens(ctx: &Ctx, tokens: &[&String]) -> FormsResult<()> {
    if tokens.is_empty() {
        return Ok(());
    }
    let hashes: Vec<String> = tokens
        .iter()
        .map(|token| sha256_hex(token.as_bytes()))
        .collect();
    form_invitation_registry::Entity::delete_many()
        .filter(form_invitation_registry::Column::WorkspaceId.eq(ctx.workspace_id.as_str()))
        .filter(form_invitation_registry::Column::TokenHash.is_in(hashes))
        .exec(&orm(ctx.master()?))
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Reminder schedule
// ---------------------------------------------------------------------------

/// `ReminderPlan`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ReminderPlan {
    pub(crate) after_days: i64,
    pub(crate) every_days: i64,
    pub(crate) max_count: i64,
}

/// `workspaceReminderPlan(ctx)`: the workspace defaults, or `None` when it
/// has no automatic reminders.
pub(crate) async fn workspace_reminder_plan(ctx: &Ctx) -> FormsResult<Option<ReminderPlan>> {
    let row: Option<(Option<i32>, Option<i32>, i32)> = form_settings::Entity::find()
        .select_only()
        .columns([
            form_settings::Column::ReminderAfterDays,
            form_settings::Column::ReminderEveryDays,
            form_settings::Column::ReminderMaxCount,
        ])
        .into_tuple()
        .one(&orm(&ctx.db))
        .await?;
    Ok(match row {
        Some((Some(after), every, max)) if after != 0 && max > 0 => Some(ReminderPlan {
            after_days: i64::from(after),
            every_days: i64::from(every.unwrap_or(after)),
            max_count: i64::from(max),
        }),
        _ => None,
    })
}

/// `planOf(row)`: the schedule an invitation was sent with.
fn plan_of(row: &Value) -> Option<ReminderPlan> {
    let max = int(row, "reminderMaxCount");
    let after = row["reminderAfterDays"].as_i64().filter(|a| *a != 0)?;
    if max <= 0 {
        return None;
    }
    Some(ReminderPlan {
        after_days: after,
        every_days: row["reminderEveryDays"].as_i64().unwrap_or(after),
        max_count: max,
    })
}

/// `reminders` in the request: absent (the workspace defaults), `null` (none) or set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RemindersInput {
    Default,
    None,
    Set(ReminderPlan),
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/// `createFormInvitationsSchema`'s `recipients`.
#[derive(Debug, Clone, Default)]
pub(crate) struct Recipients {
    pub(crate) emails: Vec<(String, Option<String>)>,
    pub(crate) user_ids: Vec<String>,
    pub(crate) person_ids: Vec<String>,
    pub(crate) list_id: Option<String>,
}

/// `createFormInvitationsSchema`.
#[derive(Debug, Clone)]
pub(crate) struct CreateInvitations {
    pub(crate) recipients: Recipients,
    pub(crate) subject: Option<String>,
    pub(crate) message: Option<String>,
    pub(crate) locale: Option<String>,
    pub(crate) reminders: RemindersInput,
}

struct Candidate {
    email: String,
    name: Option<String>,
    person_id: Option<String>,
    user_id: Option<String>,
}

fn skip(email: &str, reason: &str) -> Value {
    json!({ "email": email, "reason": reason })
}

/// A person's id, email and display name.
type PersonRow = (String, Option<String>, Option<String>);

/// `innerJoin(people, eq(people.id, listMembers.entityId))`.
fn member_person() -> RelationDef {
    list_members::Entity::belongs_to(people::Entity)
        .from(list_members::Column::EntityId)
        .to(people::Column::Id)
        .into()
}

/// The people on a static list of people; 404 / 422 for any other list.
async fn list_people_of(ctx: &Ctx, list_id: &str) -> FormsResult<Vec<PersonRow>> {
    let db = orm(&ctx.db);
    let list: Option<(String, String)> = lists::Entity::find_by_id(list_id)
        .select_only()
        .columns([lists::Column::Kind, lists::Column::Type])
        .filter(lists::Column::DeletedAt.is_null())
        .into_tuple()
        .one(&db)
        .await?;
    let Some((kind, list_type)) = list else {
        return Err(not_found("List"));
    };
    if kind != "person" {
        return Err(forms_error(
            422,
            "LIST_NOT_PEOPLE",
            "Pick a list of people.",
        ));
    }
    if list_type != "static" {
        return Err(forms_error(
            422,
            "LIST_NOT_STATIC",
            "Smart lists cannot be used here yet. Pick a list you fill by hand.",
        ));
    }
    Ok(list_members::Entity::find()
        .select_only()
        .columns([
            people::Column::Id,
            people::Column::Email,
            people::Column::DisplayName,
        ])
        .join(JoinType::InnerJoin, member_person())
        .filter(list_members::Column::ListId.eq(list_id))
        .filter(people::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&db)
        .await?)
}

async fn resolve_recipients(
    ctx: &Ctx,
    recipients: &Recipients,
) -> FormsResult<(Vec<Candidate>, Vec<Value>)> {
    let mut candidates = Vec::new();
    let mut skipped = Vec::new();
    for (email, name) in &recipients.emails {
        candidates.push(Candidate {
            email: email.clone(),
            name: name.clone(),
            person_id: None,
            user_id: None,
        });
    }
    if !recipients.user_ids.is_empty() {
        let rows: Vec<(String, Option<String>, Option<String>)> = workspace_members::Entity::find()
            .select_only()
            .columns([
                workspace_members::Column::UserId,
                workspace_members::Column::Email,
                workspace_members::Column::Name,
            ])
            .filter(
                workspace_members::Column::UserId
                    .is_in(recipients.user_ids.iter().map(String::as_str)),
            )
            .filter(workspace_members::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(&ctx.db))
            .await?;
        let by_id: HashMap<String, (Option<String>, Option<String>)> = rows
            .into_iter()
            .map(|(id, email, name)| (id, (email, name)))
            .collect();
        for id in &recipients.user_ids {
            match by_id.get(id) {
                Some((Some(email), name)) if !email.is_empty() => candidates.push(Candidate {
                    email: email.clone(),
                    name: name.clone(),
                    person_id: None,
                    user_id: Some(id.clone()),
                }),
                _ => skipped.push(skip(id, "no_email")),
            }
        }
    }
    let mut list_people: Vec<PersonRow> = Vec::new();
    if let Some(list_id) = &recipients.list_id {
        list_people = list_people_of(ctx, list_id).await?;
    }
    if !recipients.person_ids.is_empty() {
        let rows: Vec<PersonRow> = people::Entity::find()
            .select_only()
            .columns([
                people::Column::Id,
                people::Column::Email,
                people::Column::DisplayName,
            ])
            .filter(people::Column::Id.is_in(recipients.person_ids.iter().map(String::as_str)))
            .filter(people::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(&ctx.db))
            .await?;
        let by_id: HashMap<String, PersonRow> =
            rows.into_iter().map(|row| (row.0.clone(), row)).collect();
        for id in &recipients.person_ids {
            match by_id.get(id) {
                Some(row) => list_people.push(row.clone()),
                None => skipped.push(skip(id, "no_email")),
            }
        }
    }
    for (id, email, name) in list_people {
        let name = name.filter(|n| !n.is_empty());
        match email.filter(|e| !e.is_empty()) {
            None => skipped.push(skip(name.as_deref().unwrap_or(&id), "no_email")),
            Some(email) => candidates.push(Candidate {
                email,
                name,
                person_id: Some(id),
                user_id: None,
            }),
        }
    }
    Ok((candidates, skipped))
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/// `CreatedInvitations`.
pub(crate) struct CreatedInvitations {
    pub(crate) result: Value,
    pub(crate) created: Vec<Value>,
    /// Earliest automatic reminder, to mark the workspace due.
    pub(crate) next_reminder_at: Option<i64>,
}

fn settings_of(form: &Value) -> FormSettings {
    FormSettings::parse(&form["settings"])
}

/// `new Date(closesAt) <= now`, an unparsable date never closing.
fn closed_by_date(settings: &FormSettings, now_ms: i64) -> bool {
    settings
        .closes_at
        .as_deref()
        .and_then(parse_ms)
        .is_some_and(|at| at <= now_ms)
}

/// `assertInvitable(form, now)`: 409 unless published (with a public link) and open.
fn assert_invitable(form: &Value, now_ms: i64) -> FormsResult<()> {
    if text(form, "status") != "published" || form["publicId"].as_str().is_none() {
        return Err(forms_error(
            409,
            "FORM_NOT_LIVE",
            "Publish the form before inviting people.",
        ));
    }
    if closed_by_date(&settings_of(form), now_ms) {
        return Err(forms_error(
            409,
            "FORM_CLOSED",
            "The form is past its close date.",
        ));
    }
    Ok(())
}

async fn rows_by_ids(ctx: &Ctx, ids: &[String], ordered: bool) -> FormsResult<Vec<Value>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut find = form_invitations::Entity::find()
        .filter(form_invitations::Column::Id.is_in(ids.iter().map(String::as_str)));
    if ordered {
        find = find.order_by_asc(form_invitations::Column::CreatedAt);
    }
    rows_json(find.all(&orm(&ctx.db)).await?)
}

/// `createInvitations(ctx, form, userId, input)`.
#[allow(clippy::too_many_lines, reason = "the worker's steps, in its order")]
pub(crate) async fn create_invitations(
    ctx: &Ctx,
    form: &Value,
    user_id: &str,
    input: &CreateInvitations,
) -> FormsResult<CreatedInvitations> {
    let now = ctx.now_ms();
    assert_invitable(form, now)?;
    if load_usage(ctx, now).await?.over_quota() {
        return Err(forms_error(
            409,
            "OVER_QUOTA",
            "This workspace used its monthly response quota, so the form is not accepting responses.",
        ));
    }
    let (candidates, mut skipped) = resolve_recipients(ctx, &input.recipients).await?;
    if candidates.len() + skipped.len() > MAX_INVITATIONS_PER_BATCH {
        return Err(forms_error(
            422,
            "TOO_MANY_RECIPIENTS",
            format!("At most {MAX_INVITATIONS_PER_BATCH} people can be invited at once."),
        ));
    }
    let form_id = text(form, "id").to_owned();
    let db = orm(&ctx.db);
    let existing: Vec<(String, String)> = form_invitations::Entity::find()
        .select_only()
        .columns([form_invitations::Column::Email, form_invitations::Column::Status])
        .filter(form_invitations::Column::FormId.eq(form_id.as_str()))
        .filter(form_invitations::Column::Status.ne("revoked"))
        .into_tuple()
        .all(&db)
        .await?;
    let known: HashMap<String, String> = existing
        .into_iter()
        .map(|(email, status)| (email.to_lowercase(), status))
        .collect();
    let answered: HashSet<String> = if settings_of(form).one_per_respondent {
        form_responses::Entity::find()
            .select_only()
            .column(form_responses::Column::RespondentEmail)
            .filter(form_responses::Column::FormId.eq(form_id.as_str()))
            .filter(form_responses::Column::Status.eq("completed"))
            .into_tuple::<Option<String>>()
            .all(&db)
            .await?
            .into_iter()
        .flatten()
        .filter(|e| !e.is_empty())
        .map(|e| e.to_lowercase())
        .collect()
    } else {
        HashSet::new()
    };

    let mut fresh: Vec<Candidate> = Vec::new();
    let mut seen = HashSet::new();
    for candidate in candidates {
        let email = weldsuite_kit::validation::js_trim(&candidate.email).to_lowercase();
        if !is_valid_email(&email) {
            skipped.push(skip(&candidate.email, "invalid"));
        } else if known.get(&email).map(String::as_str) == Some("completed")
            || answered.contains(&email)
        {
            skipped.push(skip(&email, "already_responded"));
        } else if known.contains_key(&email) || seen.contains(&email) {
            skipped.push(skip(&email, "duplicate"));
        } else {
            seen.insert(email.clone());
            fresh.push(Candidate { email, ..candidate });
        }
    }
    if fresh.is_empty() {
        return Ok(CreatedInvitations {
            result: json!({ "created": 0, "skipped": skipped }),
            created: Vec::new(),
            next_reminder_at: None,
        });
    }

    let language = match form["publishedVersionId"].as_str() {
        Some(version) => form_versions::Entity::find_by_id(version)
            .select_only()
            .column(form_versions::Column::Definition)
            .into_tuple::<Value>()
            .one(&db)
            .await?
            .and_then(|definition| FormDefinition::parse(&definition).ok())
        .and_then(|definition| {
            serde_json::to_value(definition.presentation.language)
                .ok()
                .and_then(|language| language.as_str().map(str::to_owned))
        }),
        None => None,
    };
    let locale = input
        .locale
        .clone()
        .or(language)
        .unwrap_or_else(|| "en".to_owned());

    // The guard decides on the whole batch before anything is written.
    let guard = guard_of(ctx);
    let reservation = match reserve_outbound_mail(
        ctx,
        &guard,
        fresh.iter().map(|c| c.email.clone()).collect(),
        fresh
            .iter()
            .filter_map(|c| c.name.clone())
            .filter(|n| !n.is_empty())
            .collect(),
        input.subject.as_deref().unwrap_or(text(form, "title")),
        input.message.as_deref(),
    )
    .await
    {
        Reserved::Refused => return Err(forms_error(422, "EMAIL_REFUSED", REFUSED_MESSAGE)),
        Reserved::Go(reservation) => reservation,
    };

    let plan = match input.reminders {
        RemindersInput::Default => workspace_reminder_plan(ctx).await?,
        RemindersInput::None => None,
        RemindersInput::Set(plan) => (plan.max_count > 0).then_some(plan),
    };
    let ids: Vec<String> = fresh
        .iter()
        .map(|_| weldsuite_kit::generate_id("fin"))
        .collect();
    let tokens: Vec<String> = fresh.iter().map(|_| new_invitation_token()).collect();
    insert_invitations(ctx, &form_id, user_id, &locale, input, plan, &fresh, &ids).await?;
    for (id, token) in ids.iter().zip(&tokens) {
        register_token(ctx, &form_id, id, token).await?;
    }

    let public_id = text(form, "publicId");
    let mails: Vec<InviteMail> = fresh
        .iter()
        .zip(&tokens)
        .map(|(candidate, token)| InviteMail {
            email: candidate.email.clone(),
            name: candidate.name.clone(),
            locale: locale.clone(),
            url: invitation_url(ctx.env(), public_id, token),
            subject: input.subject.clone(),
            message: input.message.clone(),
        })
        .collect();
    let sender = member_ref(ctx, user_id).await?;
    let settings = settings_of(form);
    let sent = send_invitation_mails(
        ctx,
        &guard,
        form,
        sender["email"].as_str(),
        settings.closes_at.as_deref(),
        &mails,
        false,
        Some(&reservation),
    )
    .await?;
    let sent_to: HashSet<String> = sent.iter().map(|e| e.to_lowercase()).collect();

    let next = plan.map(|plan| now + plan.after_days * DAY_MS);
    let mut ok = Vec::new();
    let mut failed = Vec::new();
    for (id, candidate) in ids.iter().zip(&fresh) {
        if sent_to.contains(&candidate.email) {
            ok.push(id.clone());
        } else {
            failed.push((id.clone(), candidate.email.clone()));
        }
    }
    if !ok.is_empty() {
        form_invitations::Entity::update_many()
            .col_expr(form_invitations::Column::SentAt, Expr::value(instant(now)))
            .col_expr(
                form_invitations::Column::NextReminderAt,
                Expr::value(next.map(instant)),
            )
            .col_expr(form_invitations::Column::UpdatedAt, Expr::value(instant(now)))
            .filter(form_invitations::Column::Id.is_in(ok.iter().map(String::as_str)))
            .exec(&db)
            .await?;
    }
    if !failed.is_empty() {
        // The mail did not go out: the person is not invited, so no half-made invitation is left.
        let failed_ids: Vec<&str> = failed.iter().map(|(id, _)| id.as_str()).collect();
        form_invitations::Entity::delete_many()
            .filter(form_invitations::Column::Id.is_in(failed_ids.clone()))
            .exec(&db)
            .await?;
        form_invitation_registry::Entity::delete_many()
            .filter(form_invitation_registry::Column::WorkspaceId.eq(ctx.workspace_id.as_str()))
            .filter(form_invitation_registry::Column::InvitationId.is_in(failed_ids))
            .exec(&orm(ctx.master()?))
            .await?;
        for (_, email) in &failed {
            skipped.push(skip(email, "invalid"));
        }
    }
    let created = rows_by_ids(ctx, &ok, true).await?;
    Ok(CreatedInvitations {
        result: json!({ "created": created.len(), "skipped": skipped }),
        next_reminder_at: if created.is_empty() { None } else { next },
        created,
    })
}

#[allow(clippy::too_many_arguments, reason = "one insert of the batch")]
async fn insert_invitations(
    ctx: &Ctx,
    form_id: &str,
    user_id: &str,
    locale: &str,
    input: &CreateInvitations,
    plan: Option<ReminderPlan>,
    fresh: &[Candidate],
    ids: &[String],
) -> FormsResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let days = |n: i64| i32::try_from(n).unwrap_or(i32::MAX);
    let rows = ids
        .iter()
        .zip(fresh)
        .map(|(id, candidate)| form_invitations::ActiveModel {
            id: Set(id.clone()),
            form_id: Set(form_id.to_owned()),
            email: Set(candidate.email.clone()),
            name: Set(candidate.name.clone()),
            person_id: Set(candidate.person_id.clone()),
            user_id: Set(candidate.user_id.clone()),
            locale: Set(locale.to_owned()),
            status: Set("sent".to_owned()),
            subject: Set(input.subject.clone()),
            message: Set(input.message.clone()),
            reminder_after_days: Set(plan.map(|p| days(p.after_days))),
            reminder_every_days: Set(plan.map(|p| days(p.every_days))),
            reminder_max_count: Set(plan.map_or(0, |p| days(p.max_count))),
            invited_by_user_id: Set(user_id.to_owned()),
            ..Default::default()
        });
    form_invitations::Entity::insert_many(rows)
        .exec_without_returning(&orm(&ctx.db))
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// List, stats
// ---------------------------------------------------------------------------

/// `listFormInvitationsQuerySchema`.
#[derive(Debug, Clone, Default)]
pub(crate) struct ListInvitations {
    pub(crate) status: Option<String>,
    pub(crate) q: Option<String>,
    pub(crate) cursor: Option<String>,
    pub(crate) limit: Option<i64>,
}

fn like_pattern(text: &str) -> String {
    let mut out = String::from("%");
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// `Number(cursor) || 0`, at least 0.
fn offset_of(cursor: Option<&str>) -> i64 {
    cursor
        .map(weldsuite_kit::validation::js_number)
        .filter(|n| n.is_finite())
        .map_or(0, |n| {
            #[allow(clippy::cast_possible_truncation)]
            let n = n.trunc() as i64;
            n.max(0)
        })
}

/// `listInvitations(ctx, formId, query)`: rows, total and the next cursor.
pub(crate) async fn list_invitations(
    ctx: &Ctx,
    form_id: &str,
    query: &ListInvitations,
) -> FormsResult<(Vec<Value>, i64, Option<String>)> {
    let q = query
        .q
        .as_deref()
        .map(weldsuite_kit::validation::js_trim)
        .filter(|q| !q.is_empty())
        .map(like_pattern);
    let limit = query.limit.unwrap_or(50);
    let offset = offset_of(query.cursor.as_deref());
    let mut condition = Condition::all().add(form_invitations::Column::FormId.eq(form_id));
    if let Some(status) = query.status.as_deref() {
        condition = condition.add(form_invitations::Column::Status.eq(status));
    }
    if let Some(q) = q {
        condition = condition.add(
            Condition::any()
                .add(form_invitations::Column::Email.ilike(q.clone()))
                .add(form_invitations::Column::Name.ilike(q)),
        );
    }
    let db = orm(&ctx.db);
    let rows = rows_json(
        form_invitations::Entity::find()
            .filter(condition.clone())
            .order_by_desc(form_invitations::Column::CreatedAt)
            .order_by_desc(form_invitations::Column::Id)
            .limit(u64::try_from(limit).unwrap_or(0))
            .offset(u64::try_from(offset).unwrap_or(0))
            .all(&db)
            .await?,
    )?;
    let total = form_invitations::Entity::find()
        .filter(condition)
        .count(&db)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let next = offset + i64::try_from(rows.len()).unwrap_or_default();
    Ok((
        rows.iter().map(to_invitation_dto).collect(),
        total,
        (next < total).then(|| next.to_string()),
    ))
}

/// `invitationStats(ctx, formId)`.
pub(crate) async fn invitation_stats(ctx: &Ctx, form_id: &str) -> FormsResult<Value> {
    let rows: Vec<(String, i64)> = form_invitations::Entity::find()
        .select_only()
        .column(form_invitations::Column::Status)
        .column_as(form_invitations::Column::Id.count(), "count")
        .filter(form_invitations::Column::FormId.eq(form_id))
        .group_by(form_invitations::Column::Status)
        .into_tuple()
        .all(&orm(&ctx.db))
        .await?;
    let by: HashMap<String, i64> = rows.into_iter().collect();
    let get = |status: &str| by.get(status).copied().unwrap_or(0);
    let (sent, opened, started, completed, revoked) = (
        get("sent"),
        get("opened"),
        get("started"),
        get("completed"),
        get("revoked"),
    );
    Ok(json!({
        "total": sent + opened + started + completed + revoked,
        "sent": sent,
        "opened": opened,
        "started": started,
        "completed": completed,
        "revoked": revoked,
    }))
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/// `RemindOutcome`.
pub(crate) struct RemindOutcome {
    pub(crate) reminded: Vec<Value>,
    /// Earliest next automatic reminder among those reminded.
    pub(crate) next_reminder_at: Option<i64>,
}

fn ms_of(row: &Value, key: &str) -> Option<i64> {
    row[key].as_str().and_then(parse_ms)
}

/// `remindBatch(ctx, form, rows, { replyToUserId, now })`: a fresh link
/// each, the guard checked on the batch, the counters and the next reminder
/// updated. `reply_to`: the member who asked, or each invitation's inviter.
#[allow(clippy::too_many_lines, reason = "the worker's steps, in its order")]
async fn remind_batch(
    ctx: &Ctx,
    form: &Value,
    rows: &[Value],
    reply_to: Option<&str>,
    now: i64,
) -> FormsResult<(RemindOutcome, bool)> {
    if rows.is_empty() {
        return Ok((
            RemindOutcome {
                reminded: Vec::new(),
                next_reminder_at: None,
            },
            false,
        ));
    }
    let guard = guard_of(ctx);
    let reservation = match reserve_outbound_mail(
        ctx,
        &guard,
        rows.iter().map(|r| text(r, "email").to_owned()).collect(),
        rows.iter()
            .filter_map(|r| opt_text(r, "name"))
            .filter(|n| !n.is_empty())
            .collect(),
        text(form, "title"),
        None,
    )
    .await
    {
        Reserved::Refused => {
            return Ok((
                RemindOutcome {
                    reminded: Vec::new(),
                    next_reminder_at: None,
                },
                true,
            ));
        }
        Reserved::Go(reservation) => reservation,
    };
    let form_id = text(form, "id");
    let tokens: Vec<String> = rows.iter().map(|_| new_invitation_token()).collect();
    for (row, token) in rows.iter().zip(&tokens) {
        register_token(ctx, form_id, text(row, "id"), token).await?;
    }
    // One mail call per sender, so Reply-To is the person who invited.
    let mut groups: Vec<(String, Vec<(&Value, &String)>)> = Vec::new();
    for (row, token) in rows.iter().zip(&tokens) {
        let key = reply_to.map_or_else(|| text(row, "invitedByUserId").to_owned(), str::to_owned);
        match groups.iter_mut().find(|(sender, _)| *sender == key) {
            Some((_, group)) => group.push((row, token)),
            None => groups.push((key, vec![(row, token)])),
        }
    }
    let settings = settings_of(form);
    let public_id = text(form, "publicId");
    let mut sent_to = HashSet::new();
    for (sender, group) in &groups {
        let mails: Vec<InviteMail> = group
            .iter()
            .map(|(row, token)| InviteMail {
                email: text(row, "email").to_owned(),
                name: opt_text(row, "name"),
                locale: text(row, "locale").to_owned(),
                url: invitation_url(ctx.env(), public_id, token),
                subject: opt_text(row, "subject"),
                message: opt_text(row, "message"),
            })
            .collect();
        let sender = member_ref(ctx, sender).await?;
        let sent = send_invitation_mails(
            ctx,
            &guard,
            form,
            sender["email"].as_str(),
            settings.closes_at.as_deref(),
            &mails,
            true,
            None,
        )
        .await?;
        sent_to.extend(sent.iter().map(|e| e.to_lowercase()));
    }
    // The batch was reserved once, here, and is settled once.
    let sent: Vec<&Value> = rows
        .iter()
        .filter(|r| sent_to.contains(&text(r, "email").to_lowercase()))
        .collect();
    let sent_emails: Vec<String> = sent.iter().map(|r| text(r, "email").to_owned()).collect();
    settle_outbound_mail(ctx, &guard, &reservation, &sent_emails, rows.len()).await;
    // A link whose mail did not go out is not kept: nobody has it, and a
    // retry mints its own.
    let unsent: Vec<&String> = rows
        .iter()
        .zip(&tokens)
        .filter(|(row, _)| !sent_to.contains(&text(row, "email").to_lowercase()))
        .map(|(_, token)| token)
        .collect();
    forget_tokens(ctx, &unsent).await?;

    let mut next_any: Option<i64> = None;
    for row in &sent {
        let count = int(row, "remindersSent") + 1;
        let next = plan_of(row)
            .filter(|plan| count < plan.max_count)
            .map(|plan| now + plan.every_days * DAY_MS);
        form_invitations::Entity::update_many()
            .col_expr(
                form_invitations::Column::RemindersSent,
                Expr::value(i32::try_from(count).unwrap_or(i32::MAX)),
            )
            .col_expr(
                form_invitations::Column::LastRemindedAt,
                Expr::value(instant(now)),
            )
            .col_expr(
                form_invitations::Column::NextReminderAt,
                Expr::value(next.map(instant)),
            )
            .col_expr(form_invitations::Column::UpdatedAt, Expr::value(instant(now)))
            .filter(form_invitations::Column::Id.eq(text(row, "id")))
            .exec(&orm(&ctx.db))
            .await?;
        if let Some(next) = next
            && next_any.is_none_or(|any| next < any)
        {
            next_any = Some(next);
        }
    }
    let ids: Vec<String> = sent.iter().map(|r| text(r, "id").to_owned()).collect();
    let updated = rows_by_ids(ctx, &ids, false).await?;
    Ok((
        RemindOutcome {
            reminded: updated,
            next_reminder_at: next_any,
        },
        false,
    ))
}

/// `remindInvitations(ctx, form, userId, invitationIds)`: everyone who has
/// not answered (or the given ones); anyone emailed in the last hour is
/// skipped. 409 when the form no longer takes responses.
pub(crate) async fn remind_invitations(
    ctx: &Ctx,
    form: &Value,
    user_id: &str,
    invitation_ids: Option<&[String]>,
) -> FormsResult<(RemindOutcome, Value)> {
    let now = ctx.now_ms();
    assert_invitable(form, now)?;
    let mut find = form_invitations::Entity::find()
        .filter(form_invitations::Column::FormId.eq(text(form, "id")))
        .filter(form_invitations::Column::Status.is_in(OPEN_STATUSES));
    if let Some(ids) = invitation_ids.filter(|ids| !ids.is_empty()) {
        find = find.filter(form_invitations::Column::Id.is_in(ids.iter().map(String::as_str)));
    }
    let rows = rows_json(
        find.order_by_asc(form_invitations::Column::CreatedAt)
            .all(&orm(&ctx.db))
            .await?,
    )?;
    let cutoff = now - HOUR_MS;
    let due: Vec<Value> = rows
        .iter()
        .filter(|r| {
            ms_of(r, "lastRemindedAt")
                .or_else(|| ms_of(r, "sentAt"))
                .or_else(|| ms_of(r, "createdAt"))
                .is_some_and(|at| at <= cutoff)
        })
        .cloned()
        .collect();
    let (outcome, refused) = remind_batch(ctx, form, &due, Some(user_id), now).await?;
    if refused {
        return Err(forms_error(422, "EMAIL_REFUSED", REFUSED_MESSAGE));
    }
    let skipped = rows.len() - outcome.reminded.len();
    let result = json!({ "reminded": outcome.reminded.len(), "skipped": skipped });
    Ok((outcome, result))
}

/// `revokeInvitation(ctx, formId, invitationId)`: every link of it stops
/// working. 409 when the person already completed.
pub(crate) async fn revoke_invitation(
    ctx: &Ctx,
    form_id: &str,
    invitation_id: &str,
) -> FormsResult<Value> {
    let now = ctx.now_ms();
    let db = orm(&ctx.db);
    let Some(row) = form_invitations::Entity::find_by_id(invitation_id)
        .filter(form_invitations::Column::FormId.eq(form_id))
        .one(&db)
        .await?
        .map(row_json)
        .transpose()?
    else {
        return Err(not_found("Invitation"));
    };
    match text(&row, "status") {
        "completed" => {
            return Err(forms_error(
                409,
                "ALREADY_COMPLETED",
                "This person already completed the form.",
            ));
        }
        "revoked" => return Ok(row),
        _ => {}
    }
    let updated = form_invitations::Entity::update_many()
        .col_expr(form_invitations::Column::Status, Expr::value("revoked"))
        .col_expr(form_invitations::Column::RevokedAt, Expr::value(instant(now)))
        .col_expr(
            form_invitations::Column::NextReminderAt,
            Expr::value(Option::<OffsetDateTime>::None),
        )
        .col_expr(form_invitations::Column::UpdatedAt, Expr::value(instant(now)))
        .filter(form_invitations::Column::Id.eq(text(&row, "id")))
        .exec_with_returning(&db)
        .await?
        .into_iter()
        .next()
        .map(row_json)
        .transpose()?
        .ok_or_else(|| Fail::Internal("forms: the revoke returned nothing".to_owned()))?;
    form_invitation_registry::Entity::update_many()
        .col_expr(
            form_invitation_registry::Column::RevokedAt,
            Expr::value(instant(now)),
        )
        .filter(form_invitation_registry::Column::WorkspaceId.eq(ctx.workspace_id.as_str()))
        .filter(form_invitation_registry::Column::InvitationId.eq(text(&row, "id")))
        .filter(form_invitation_registry::Column::RevokedAt.is_null())
        .exec(&orm(ctx.master()?))
        .await?;
    Ok(updated)
}

// ---------------------------------------------------------------------------
// The sweep: automatic reminders
// ---------------------------------------------------------------------------

/// `takesResponses(form, now)`: published, with a link, before its close date.
fn takes_responses(form: &Value, now: i64) -> bool {
    text(form, "status") == "published"
        && form["publicId"].as_str().is_some_and(|id| !id.is_empty())
        && !closed_by_date(&settings_of(form), now)
}

/// `sendDueReminders(ctx, now)`: the reminders due in this workspace, and
/// when the next one is. Never after the form's close date or once the
/// person completed.
pub(crate) async fn send_due_reminders(
    ctx: &Ctx,
    now: i64,
) -> FormsResult<(Vec<Value>, Option<i64>)> {
    let db = orm(&ctx.db);
    let due = rows_json(
        form_invitations::Entity::find()
            .filter(form_invitations::Column::Status.is_in(OPEN_STATUSES))
            .filter(form_invitations::Column::NextReminderAt.lte(instant(now)))
            .order_by_asc(form_invitations::Column::NextReminderAt)
            .all(&db)
            .await?,
    )?;
    let mut by_form: Vec<(String, Vec<Value>)> = Vec::new();
    for row in due {
        let form_id = text(&row, "formId").to_owned();
        match by_form.iter_mut().find(|(id, _)| *id == form_id) {
            Some((_, rows)) => rows.push(row),
            None => by_form.push((form_id, vec![row])),
        }
    }
    let mut reminded = Vec::new();
    for (form_id, rows) in by_form {
        let ids: Vec<String> = rows.iter().map(|r| text(r, "id").to_owned()).collect();
        let form = crate::access::form_row(&ctx.db, &form_id).await?;
        let Some(form) = form.filter(|form| takes_responses(form, now)) else {
            form_invitations::Entity::update_many()
                .col_expr(
                    form_invitations::Column::NextReminderAt,
                    Expr::value(Option::<OffsetDateTime>::None),
                )
                .col_expr(form_invitations::Column::UpdatedAt, Expr::value(instant(now)))
                .filter(form_invitations::Column::Id.is_in(ids.iter().map(String::as_str)))
                .exec(&db)
                .await?;
            continue;
        };
        let (outcome, _) = remind_batch(ctx, &form, &rows, None, now).await?;
        // Refused by the guard or not sent (the provider said no, or no
        // transport): tried again later, not on every tick, and with nothing
        // kept from this attempt.
        let done: HashSet<&str> = outcome.reminded.iter().map(|r| text(r, "id")).collect();
        let unsent: Vec<&String> = ids
            .iter()
            .filter(|id| !done.contains(id.as_str()))
            .collect();
        if !unsent.is_empty() {
            form_invitations::Entity::update_many()
                .col_expr(
                    form_invitations::Column::NextReminderAt,
                    Expr::value(instant(now + REFUSED_RETRY_MS)),
                )
                .col_expr(form_invitations::Column::UpdatedAt, Expr::value(instant(now)))
                .filter(form_invitations::Column::Id.is_in(unsent.into_iter().map(String::as_str)))
                .exec(&db)
                .await?;
        }
        reminded.extend(outcome.reminded);
    }
    let upcoming: Option<OffsetDateTime> = form_invitations::Entity::find()
        .select_only()
        .column_as(form_invitations::Column::NextReminderAt.min(), "min")
        .filter(form_invitations::Column::Status.is_in(OPEN_STATUSES))
        .filter(form_invitations::Column::NextReminderAt.is_not_null())
        .into_tuple::<Option<OffsetDateTime>>()
        .one(&db)
        .await?
        .flatten();
    Ok((reminded, upcoming.map(epoch_ms)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_and_patterns() {
        let row =
            json!({ "reminderAfterDays": 3, "reminderEveryDays": null, "reminderMaxCount": 2 });
        assert_eq!(
            plan_of(&row),
            Some(ReminderPlan {
                after_days: 3,
                every_days: 3,
                max_count: 2
            })
        );
        assert_eq!(
            plan_of(&json!({ "reminderAfterDays": 3, "reminderMaxCount": 0 })),
            None
        );
        assert_eq!(like_pattern("50%_a\\"), "%50\\%\\_a\\\\%");
        assert_eq!(offset_of(Some("3")), 3);
        assert_eq!(offset_of(Some("x")), 0);
        assert_eq!(offset_of(Some("-2")), 0);
        assert_eq!(new_invitation_token().len(), 64);
    }
}
