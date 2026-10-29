//! Calendar attendee mail (`services/calendar-mail.ts`): invite, update,
//! reschedule, cancellation, removal and "on again", one message per
//! attendee with the event as an ICS attachment, each batch through the
//! outbound mail guard first (source `calendar`).
//!
//! The lookups (organizer, members, languages) are here; the sending waits
//! on the outbound guard (`weldsuite_mail_domain::outbound`), which the
//! Mail-outbound workstream is adding.

use std::collections::HashMap;

use serde_json::Value;
use weldsuite_db::PgPool;

use crate::js::valid_zone;
use crate::{CalendarState, Caller, text};

/// What kind of message (`CalendarEventKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MailKind {
    Invite,
    Update,
    Reschedule,
    Cancel,
    Removed,
    Restored,
}

/// The organizer as the mails show them (`OrganizerInfo`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OrganizerInfo {
    pub(crate) name: String,
    pub(crate) email: String,
    /// Their preferred IANA zone, when valid.
    pub(crate) timezone: Option<String>,
}

/// An attendee as stored or sent (`AttendeeLike`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct Attendee {
    pub(crate) email: Option<String>,
    pub(crate) name: Option<String>,
}

/// The attendees of a stored event (`attendees` jsonb).
pub(crate) fn attendees_of(value: &Value) -> Vec<Attendee> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| Attendee {
                    email: item["email"].as_str().map(str::to_owned),
                    name: item["name"].as_str().map(str::to_owned),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The event fields the mails need (`CalendarMailEvent`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct MailEvent {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) description: Option<String>,
    pub(crate) location: Option<String>,
    pub(crate) start_time: Option<String>,
    pub(crate) end_time: Option<String>,
    pub(crate) meeting_url: Option<String>,
    pub(crate) timezone: Option<String>,
    pub(crate) all_day: Option<bool>,
}

impl MailEvent {
    /// `mailEventFromRow`.
    pub(crate) fn from_row(row: &Value) -> Self {
        let string = |key: &str| row[key].as_str().map(str::to_owned);
        Self {
            id: text(row, "id").to_owned(),
            title: text(row, "title").to_owned(),
            description: string("description"),
            location: string("location"),
            start_time: string("startTime"),
            end_time: string("endTime"),
            meeting_url: string("meetingUrl"),
            timezone: string("timezone"),
            all_day: row["allDay"].as_bool(),
        }
    }
}

/// A member's preferred mail language (`MemberMailInfo`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct MemberMailInfo {
    pub(crate) language: Option<String>,
}

/// `SendOptions` (the outbound context is the [`MailContext`]).
#[derive(Debug, Clone)]
pub(crate) struct SendOptions {
    pub(crate) kind: MailKind,
    pub(crate) event: MailEvent,
    pub(crate) attendees: Vec<Attendee>,
    pub(crate) organizer: OrganizerInfo,
    pub(crate) sequence: Option<i64>,
    pub(crate) old_start_time: Option<String>,
    pub(crate) old_end_time: Option<String>,
    pub(crate) member_emails: HashMap<String, MemberMailInfo>,
    pub(crate) workspace_language: Option<String>,
}

/// What a batch of mail needs from the request: the tenant database, the
/// workspace's Clerk org id and the worker's env.
#[derive(Clone)]
pub(crate) struct MailContext {
    pub(crate) db: PgPool,
    pub(crate) clerk_org_id: String,
    pub(crate) environment: Option<String>,
    pub(crate) app_url: Option<String>,
}

impl MailContext {
    pub(crate) fn of(state: &CalendarState, caller: &Caller) -> Self {
        Self {
            db: caller.db.clone(),
            clerk_org_id: caller.clerk_org_id.clone().unwrap_or_default(),
            environment: caller.env(state, "ENVIRONMENT"),
            app_url: caller.env(state, "APP_URL"),
        }
    }
}

/// `nextIcsSequence()`: seconds since the epoch, so every revision of an
/// event outranks the one before.
pub(crate) fn next_ics_sequence() -> i64 {
    crate::js::now_ms().div_euclid(1000)
}

/// Whether the worker has a mail transport (`workerTransport(c.env)`): mail
/// goes out once the outbound guard is wired in; until then nothing is sent.
pub(crate) fn has_transport(_state: &CalendarState) -> bool {
    false
}

/// The organizer's name, email and preferred zone (`getOrganizerInfo`).
pub(crate) async fn organizer_info(db: &PgPool, user_id: &str) -> OrganizerInfo {
    let member: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select name, email from workspace_members where user_id = $1 limit 1")
            .bind(user_id)
            .fetch_optional(db)
            .await
            .unwrap_or_else(|error| {
                tracing::error!(%error, "[calendar-api/calendar-mail] organizer lookup failed");
                None
            });
    let timezone = match sqlx::query_scalar::<_, Option<String>>(
        "select timezone from user_preferences where user_id = $1 limit 1",
    )
    .bind(user_id)
    .fetch_optional(db)
    .await
    {
        Ok(zone) => valid_zone(zone.flatten().as_deref()),
        Err(error) => {
            tracing::error!(%error, "[calendar-api/calendar-mail] organizer timezone lookup failed");
            None
        }
    };
    let (name, email) = member.unwrap_or((None, None));
    OrganizerInfo {
        name: name.unwrap_or_else(|| "Someone".to_owned()),
        email: email.unwrap_or_default(),
        timezone,
    }
}

/// The active internal members among `emails`, with their language
/// (`getMemberEmails`).
pub(crate) async fn member_emails(
    db: &PgPool,
    emails: &[String],
) -> HashMap<String, MemberMailInfo> {
    let mut lowered: Vec<String> = Vec::new();
    for email in emails {
        let email = email.trim().to_lowercase();
        if !email.is_empty() && !lowered.contains(&email) {
            lowered.push(email);
        }
    }
    if lowered.is_empty() {
        return HashMap::new();
    }
    let rows: Result<Vec<(Option<String>, Option<String>)>, _> = sqlx::query_as(
        "select m.email, p.language from workspace_members m
         left join user_preferences p on p.user_id = m.user_id
         where lower(m.email) = any($1) and m.deleted_at is null
           and m.status = 'ACTIVE' and m.member_type = 'INTERNAL'",
    )
    .bind(&lowered)
    .fetch_all(db)
    .await;
    match rows {
        Ok(rows) => {
            let mut members = HashMap::new();
            for (email, language) in rows {
                let email = email.unwrap_or_default().to_lowercase();
                if !email.is_empty() {
                    members.insert(email, MemberMailInfo { language });
                }
            }
            members
        }
        Err(error) => {
            tracing::error!(%error, "[calendar-api/calendar-mail] member lookup failed");
            HashMap::new()
        }
    }
}

/// The workspace's mail language (`getWorkspaceLanguage`).
pub(crate) async fn workspace_language(db: &PgPool) -> Option<String> {
    match sqlx::query_scalar::<_, Option<String>>("select language from workspace_settings limit 1")
        .fetch_optional(db)
        .await
    {
        Ok(language) => language.flatten(),
        Err(error) => {
            tracing::error!(%error, "[calendar-api/calendar-mail] workspace language lookup failed");
            None
        }
    }
}

/// `sendCalendarEventEmails`. Waits on the outbound guard: until it is wired
/// in, nothing is sent.
pub(crate) async fn send_calendar_event_emails(context: &MailContext, options: SendOptions) {
    let _ = (context, options);
}

/// `queueMail`: look up members and the workspace language, then send, in
/// the background. Nothing without a transport or attendees.
pub(crate) fn queue(state: &CalendarState, caller: &Caller, options: SendOptions) {
    if !has_transport(state) || options.attendees.is_empty() {
        return;
    }
    let context = MailContext::of(state, caller);
    state.events.tracker().spawn(async move {
        let emails: Vec<String> = options
            .attendees
            .iter()
            .map(|a| a.email.clone().unwrap_or_default())
            .collect();
        let member_emails = member_emails(&context.db, &emails).await;
        let workspace_language = workspace_language(&context.db).await;
        send_calendar_event_emails(
            &context,
            SendOptions {
                member_emails,
                workspace_language,
                ..options
            },
        )
        .await;
    });
}
