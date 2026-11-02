//! Calendar attendee mail (`services/calendar-mail.ts`): invite, update,
//! reschedule, cancellation, removal and "on again", one message per
//! attendee with the event as an ICS attachment, each batch through the
//! outbound mail guard first (source `calendar`).
//!
//! The messages are `weldsuite_emails`' `calendar.event` with an `.ics`
//! (`weldsuite_emails::ics`), sent through the worker's `SEND_EMAIL`
//! (the `MailTransport` of the outbound bindings) after the guard
//! (`weldsuite_mail_domain::outbound`) reserved the batch.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use weldsuite_db::PgPool;
use weldsuite_emails::calendar::{CalendarEventEmail, CalendarEventKind};
use weldsuite_emails::ics::{IcsEvent, IcsPerson, IcsTime, ics_attachment};
use weldsuite_emails::{EmailBrand, EmailLocale, EndTime};
use weldsuite_mail_domain::outbound::guard::{
    CheckOutboundInput, OutboundReservation, SubjectInput, check_outbound, commit_outbound,
    release_outbound,
};
use weldsuite_mail_domain::outbound::transmit::{SendEmailParams, send_email};
use weldsuite_mail_domain::outbound::{MimeAttachment, OutboundBindings, OutboundKind};
use weldsuite_ports::DynCache;

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
/// workspace's Clerk org id, the worker's env and its outbound bindings.
#[derive(Clone)]
pub(crate) struct MailContext {
    pub(crate) db: PgPool,
    pub(crate) clerk_org_id: String,
    pub(crate) environment: Option<String>,
    pub(crate) app_url: Option<String>,
    /// `SYSTEM_EMAIL_FROM` (`withFromAddress`).
    pub(crate) from_override: Option<String>,
    pub(crate) bindings: OutboundBindings,
    pub(crate) master: Option<PgPool>,
    pub(crate) cache: Option<Arc<dyn DynCache>>,
}

impl MailContext {
    pub(crate) fn of(state: &CalendarState, caller: &Caller) -> Self {
        Self {
            db: caller.db.clone(),
            clerk_org_id: caller.clerk_org_id.clone().unwrap_or_default(),
            environment: caller.env(state, "ENVIRONMENT"),
            app_url: caller.env(state, "APP_URL"),
            from_override: caller.env(state, "SYSTEM_EMAIL_FROM"),
            bindings: caller.outbound(state),
            master: caller.master(state),
            cache: state.cache.clone(),
        }
    }
}

/// `nextIcsSequence()`: seconds since the epoch, so every revision of an
/// event outranks the one before.
pub(crate) fn next_ics_sequence() -> i64 {
    crate::js::now_ms().div_euclid(1000)
}

/// Whether the worker has a mail transport (`workerTransport(c.env)`): its
/// `SEND_EMAIL`.
pub(crate) fn has_transport(state: &CalendarState, caller: &Caller) -> bool {
    caller.outbound(state).transport.is_some()
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

/// WeldSuite's own sending address for system mail.
const SYSTEM_SENDER: &str = "notifications@mail.weldsuite.org";

/// `getPlatformUrl(environment)`.
fn platform_url(environment: Option<&str>) -> &'static str {
    match environment {
        Some("development") => "http://localhost:3000",
        Some("test") => "https://app-test.weldsuite.org",
        Some("preview") => "https://app-preview.weldsuite.org",
        _ => "https://app.weldsuite.org",
    }
}

/// `encodeURIComponent`.
fn encode_component(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `eventUrlFor(env, clerkOrgId)`: the authenticated calendar in the event's
/// workspace (`workspaceAppUrl(…, '/weldcalendar')`).
fn event_url_for(context: &MailContext) -> String {
    let override_url = context
        .app_url
        .as_deref()
        .map(|url| url.trim().trim_end_matches('/'))
        .filter(|url| !url.is_empty());
    let base = override_url
        .unwrap_or_else(|| platform_url(context.environment.as_deref()))
        .trim()
        .trim_end_matches('/');
    if context.clerk_org_id.is_empty() {
        format!("{base}/weldcalendar")
    } else {
        format!(
            "{base}/w/{}/weldcalendar",
            encode_component(&context.clerk_org_id)
        )
    }
}

/// The zone the mail shows times in: the event's, the organizer's, UTC
/// (`mailTimeZone`).
fn mail_time_zone(event: &MailEvent, organizer: &OrganizerInfo) -> String {
    valid_zone(event.timezone.as_deref())
        .or_else(|| valid_zone(organizer.timezone.as_deref()))
        .unwrap_or_else(|| "UTC".to_owned())
}

fn template_kind(kind: MailKind) -> CalendarEventKind {
    match kind {
        MailKind::Invite => CalendarEventKind::Invite,
        MailKind::Update => CalendarEventKind::Update,
        MailKind::Reschedule => CalendarEventKind::Reschedule,
        MailKind::Cancel => CalendarEventKind::Cancel,
        MailKind::Removed => CalendarEventKind::Removed,
        MailKind::Restored => CalendarEventKind::Restored,
    }
}

/// `new Date(value)` for the `.ics`: absent, `''`, unreadable or an instant.
fn ics_time(value: Option<&str>) -> IcsTime {
    match value {
        None => IcsTime::Missing,
        Some("") => IcsTime::Empty,
        Some(text) => crate::js::parse_date(text).map_or(IcsTime::Invalid, IcsTime::At),
    }
}

/// `new Date(value)` for `formatWhen`'s end: none for absent or `''`.
fn end_time(value: Option<&str>) -> EndTime {
    match value {
        None | Some("") => EndTime::None,
        Some(text) => crate::js::parse_date(text).map_or(EndTime::Invalid, EndTime::At),
    }
}

/// What every message of one batch shares (`BatchMail`).
struct Batch {
    app_url: String,
    method: &'static str,
    meeting_url: Option<String>,
    zone: String,
    sequence: i64,
}

/// Mail one attendee their copy, with the `.ics` (`sendAttendeeMail`).
async fn send_attendee_mail(
    context: &MailContext,
    transport: &dyn weldsuite_ports::MailTransport,
    options: &SendOptions,
    batch: &Batch,
    email: &str,
) -> Result<(), String> {
    let kind = template_kind(options.kind);
    let ended = kind.is_ended();
    let event = &options.event;
    let organizer = &options.organizer;
    let member = options.member_emails.get(&email.to_lowercase());
    let event_url = (!ended && member.is_some()).then(|| batch.app_url.clone());
    let locale = EmailLocale::resolve([
        member.and_then(|m| m.language.as_deref()),
        options.workspace_language.as_deref(),
    ]);
    let ics = IcsEvent {
        uid: format!("{}@weldsuite.org", event.id),
        method: batch.method.to_owned(),
        sequence: batch.sequence,
        title: event.title.clone(),
        description: event.description.clone(),
        location: event.location.clone(),
        start: ics_time(event.start_time.as_deref()),
        end: ics_time(event.end_time.as_deref()),
        all_day: event.all_day.unwrap_or(false),
        timezone: Some(batch.zone.clone()),
        organizer: (!organizer.email.is_empty()).then(|| IcsPerson {
            email: organizer.email.clone(),
            name: Some(organizer.name.clone()),
        }),
        attendees: vec![IcsPerson {
            email: email.to_owned(),
            name: None,
        }],
        url: batch.meeting_url.clone().or_else(|| event_url.clone()),
        meeting_url: batch.meeting_url.clone(),
        product: "WeldCalendar".to_owned(),
    };
    let attachment = ics_attachment(&ics, crate::js::now_ms()).map_err(|e| e.to_string())?;
    let start = event
        .start_time
        .as_deref()
        .and_then(crate::js::parse_date)
        .ok_or_else(|| "RangeError: Invalid time value".to_owned())?;
    let rendered = weldsuite_emails::calendar::event(
        locale,
        &EmailBrand::weldsuite("WeldCalendar"),
        &CalendarEventEmail {
            kind,
            organizer_name: organizer.name.clone(),
            title: event.title.clone(),
            description: event.description.clone(),
            start,
            end: end_time(event.end_time.as_deref()),
            old_start: options
                .old_start_time
                .as_deref()
                .and_then(crate::js::parse_date),
            old_end: end_time(options.old_end_time.as_deref()),
            location: event.location.clone(),
            timezone: Some(batch.zone.clone()),
            all_day: event.all_day.unwrap_or(false),
            meeting_url: batch.meeting_url.clone(),
            event_url,
        },
    )
    .map_err(|e| e.to_string())?;
    let address = context
        .from_override
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .unwrap_or(SYSTEM_SENDER);
    let params = SendEmailParams {
        from: format!("WeldCalendar <{address}>"),
        to: vec![email.to_owned()],
        subject: rendered.subject,
        text: Some(rendered.text),
        html: Some(rendered.html),
        reply_to: (!organizer.email.is_empty()).then(|| organizer.email.clone()),
        attachments: vec![MimeAttachment {
            filename: attachment.filename,
            content_type: Some(attachment.content_type),
            content: attachment.content,
            cid: None,
        }],
        ..SendEmailParams::default()
    };
    send_email(transport, &params)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Ask the guard once for the whole batch (`reserveBatch`): `Err` when it
/// refused (nothing is sent).
async fn reserve_batch(
    context: &MailContext,
    options: &SendOptions,
    recipients: &[&Attendee],
) -> Result<OutboundReservation, ()> {
    let guard = context
        .bindings
        .guard(context.master.clone(), context.cache.clone());
    let mut input = CheckOutboundInput::new(
        SubjectInput::Workspace {
            clerk_org_id: context.clerk_org_id.clone(),
            workspace_id: None,
        },
        "calendar",
        OutboundKind::NewThread,
        SYSTEM_SENDER,
        recipients
            .iter()
            .map(|a| a.email.clone().unwrap_or_default())
            .collect(),
    );
    input.system_sender = true;
    input.subject_line = Some(options.event.title.clone());
    input.text.clone_from(&options.event.description);
    input.recipient_names = recipients
        .iter()
        .filter_map(|a| a.name.clone())
        .filter(|name| !name.is_empty())
        .collect();
    check_outbound(&guard, Some(&context.db), &input)
        .await
        .map_err(|denied| {
            tracing::warn!(
                "[calendar-api/calendar-mail] {:?} mail for event {} not sent: the outbound guard refused ({:?})",
                options.kind,
                options.event.id,
                denied.code()
            );
        })
}

/// `sendCalendarEventEmails`: one message per attendee (never the
/// organizer), after the guard reserved the batch; each send on its own, and
/// what went out is committed.
pub(crate) async fn send_calendar_event_emails(context: &MailContext, options: SendOptions) {
    let Some(transport) = context.bindings.transport.clone() else {
        return;
    };
    if options.attendees.is_empty() {
        return;
    }
    let kind = template_kind(options.kind);
    let ended = kind.is_ended();
    let batch = Batch {
        app_url: event_url_for(context),
        method: if ended { "CANCEL" } else { "REQUEST" },
        meeting_url: if ended {
            None
        } else {
            options
                .event
                .meeting_url
                .as_deref()
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .map(str::to_owned)
        },
        zone: mail_time_zone(&options.event, &options.organizer),
        sequence: if kind == CalendarEventKind::Invite {
            options.sequence.unwrap_or(0)
        } else {
            options.sequence.unwrap_or(0).max(next_ics_sequence())
        },
    };
    let organizer_email = options.organizer.email.to_lowercase();
    let recipients: Vec<&Attendee> = options
        .attendees
        .iter()
        .filter(|a| {
            a.email
                .as_deref()
                .is_some_and(|email| !email.is_empty() && email.to_lowercase() != organizer_email)
        })
        .collect();
    if recipients.is_empty() {
        return;
    }
    let Ok(reservation) = reserve_batch(context, &options, &recipients).await else {
        return;
    };
    let mut sent = Vec::new();
    for attendee in &recipients {
        let email = attendee.email.clone().unwrap_or_default();
        match send_attendee_mail(context, transport.as_ref(), &options, &batch, &email).await {
            Ok(()) => sent.push(email),
            Err(error) => tracing::error!(
                error,
                "[calendar-api/calendar-mail] {:?} email failed for {email}",
                options.kind
            ),
        }
    }
    let guard = context
        .bindings
        .guard(context.master.clone(), context.cache.clone());
    if sent.is_empty() {
        release_outbound(&guard, &reservation).await;
    } else if sent.len() < recipients.len() {
        commit_outbound(&guard, Some(&context.db), &reservation, Some(&sent)).await;
    } else {
        commit_outbound(&guard, Some(&context.db), &reservation, None).await;
    }
}

/// `queueMail`: look up members and the workspace language, then send, in
/// the background. Nothing without a transport or attendees.
pub(crate) fn queue(state: &CalendarState, caller: &Caller, options: SendOptions) {
    if !has_transport(state, caller) || options.attendees.is_empty() {
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
