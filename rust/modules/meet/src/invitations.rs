//! Meeting invitation mail (`services/weldmeet/invitations.ts`): the
//! `meet.invitation` template with the public join link, an `.ics` when the
//! meeting is scheduled, sent through the worker's transport (`SEND_EMAIL`)
//! after the outbound guard allowed the whole batch (source `meet`, from
//! WeldSuite's own address, counted against the workspace).

use std::sync::Arc;

use weldsuite_db::PgPool;
use weldsuite_emails::ics::{IcsEvent, IcsPerson, IcsTime, ics_attachment};
use weldsuite_emails::meet::{MeetInvitation, invitation};
use weldsuite_emails::{EmailBrand, EmailLocale};
use weldsuite_mail_domain::outbound::guard::{
    CheckOutboundInput, SubjectInput, check_outbound, commit_outbound, release_outbound,
};
use weldsuite_mail_domain::outbound::transmit::{SendEmailParams, send_email};
use weldsuite_mail_domain::outbound::{MimeAttachment, OutboundBindings, OutboundKind};
use weldsuite_ports::DynCache;

use crate::js::{now_ms, parse_ms};

/// WeldSuite's own sending address (`SYSTEM_SENDER`).
const SYSTEM_SENDER: &str = "notifications@mail.weldsuite.org";
/// `DEFAULT_MEETING_PORTAL_URL`.
const DEFAULT_PORTAL_URL: &str = "https://meet.weldsuite.org";
/// The `.ics` event's length without an end (`DEFAULT_DURATION_MS`).
const DEFAULT_DURATION_MS: i64 = 60 * 60 * 1000;

/// `getMeetingPortalUrl(configured)`.
pub(crate) fn portal_url(configured: Option<&str>) -> String {
    let url = configured
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .unwrap_or(DEFAULT_PORTAL_URL);
    url.trim_end_matches('/').to_owned()
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(value: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `buildMeetingJoinUrl(portalUrl, workspaceId, joinCode)`.
pub(crate) fn join_url(portal: &str, workspace_id: &str, join_code: &str) -> String {
    format!(
        "{portal}/{}/{}",
        encode_uri_component(workspace_id),
        encode_uri_component(join_code)
    )
}

/// The meeting as the mail shows it (`InvitationMeeting`).
#[derive(Debug, Clone)]
pub(crate) struct Meeting {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) description: Option<String>,
    pub(crate) scheduled_start: Option<String>,
    pub(crate) scheduled_end: Option<String>,
}

/// The organizer as the mail names them.
#[derive(Debug, Clone)]
pub(crate) struct Organizer {
    pub(crate) name: String,
    pub(crate) email: String,
    pub(crate) timezone: Option<String>,
}

/// What one batch needs from the request.
pub(crate) struct Batch<'a> {
    pub(crate) db: &'a PgPool,
    pub(crate) clerk_org_id: &'a str,
    pub(crate) bindings: OutboundBindings,
    pub(crate) master: Option<PgPool>,
    pub(crate) cache: Option<Arc<dyn DynCache>>,
    /// `SYSTEM_EMAIL_FROM`.
    pub(crate) from_override: Option<String>,
    pub(crate) meeting: &'a Meeting,
    pub(crate) organizer: &'a Organizer,
    pub(crate) join_url: &'a str,
}

/// `sendInvitationEmail(env, params)`: whether the mail was handed to the
/// transport. Never fails.
async fn send_one(
    batch: &Batch<'_>,
    transport: &dyn weldsuite_ports::MailTransport,
    email: &str,
    name: Option<&str>,
) -> bool {
    match try_send(batch, transport, email, name).await {
        Ok(()) => true,
        Err(error) => {
            tracing::error!(%error, "[meet-api/invitations] invitation email failed");
            false
        }
    }
}

async fn try_send(
    batch: &Batch<'_>,
    transport: &dyn weldsuite_ports::MailTransport,
    email: &str,
    name: Option<&str>,
) -> Result<(), String> {
    let meeting = batch.meeting;
    let organizer = batch.organizer;
    let start = meeting.scheduled_start.as_deref().and_then(parse_ms);
    let end = meeting.scheduled_end.as_deref().and_then(parse_ms);
    let organizer_email = if organizer.email.is_empty() {
        SYSTEM_SENDER
    } else {
        organizer.email.as_str()
    };
    let rendered = invitation(
        EmailLocale::En,
        &EmailBrand::weldsuite("WeldMeet"),
        &MeetInvitation {
            organizer_name: organizer.name.clone(),
            title: meeting.title.clone(),
            description: meeting.description.clone(),
            start,
            end,
            timezone: organizer.timezone.clone(),
            join_url: batch.join_url.to_owned(),
        },
    )
    .map_err(|e| e.to_string())?;
    let mut attachments = Vec::new();
    if let Some(start) = start {
        let end = end
            .filter(|end| *end > start)
            .unwrap_or(start + DEFAULT_DURATION_MS);
        let ics = IcsEvent {
            uid: format!("{}@meet.weldsuite.org", meeting.id),
            method: "REQUEST".to_owned(),
            sequence: 0,
            title: meeting.title.clone(),
            description: meeting.description.clone(),
            location: None,
            start: IcsTime::At(start),
            end: IcsTime::At(end),
            all_day: false,
            timezone: None,
            organizer: Some(IcsPerson {
                email: organizer_email.to_owned(),
                name: Some(organizer.name.clone()),
            }),
            attendees: vec![IcsPerson {
                email: email.to_owned(),
                name: name.map(str::to_owned),
            }],
            url: None,
            meeting_url: Some(batch.join_url.to_owned()),
            product: "WeldMeet".to_owned(),
        };
        let attachment = ics_attachment(&ics, now_ms()).map_err(|e| e.to_string())?;
        attachments.push(MimeAttachment {
            filename: attachment.filename,
            content_type: Some(attachment.content_type),
            content: attachment.content,
            cid: None,
        });
    }
    let address = batch
        .from_override
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .unwrap_or(SYSTEM_SENDER);
    let params = SendEmailParams {
        from: format!("WeldMeet <{address}>"),
        to: vec![email.to_owned()],
        subject: rendered.subject,
        text: Some(rendered.text),
        html: Some(rendered.html),
        reply_to: (!organizer.email.is_empty()).then(|| organizer.email.clone()),
        attachments,
        ..SendEmailParams::default()
    };
    send_email(transport, &params)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// `sendInvitationEmails(env, params)`: per attendee and in order, whether
/// the mail was handed to the transport (all `false` without a transport or
/// when the guard refused the batch). Never fails.
pub(crate) async fn send_all(
    batch: &Batch<'_>,
    attendees: &[(String, Option<String>)],
) -> Vec<bool> {
    if attendees.is_empty() {
        return Vec::new();
    }
    let Some(transport) = batch.bindings.transport.clone() else {
        return vec![false; attendees.len()];
    };
    let guard = batch
        .bindings
        .guard(batch.master.clone(), batch.cache.clone());
    let mut input = CheckOutboundInput::new(
        SubjectInput::Workspace {
            clerk_org_id: batch.clerk_org_id.to_owned(),
            workspace_id: None,
        },
        "meet",
        OutboundKind::NewThread,
        SYSTEM_SENDER,
        attendees.iter().map(|(email, _)| email.clone()).collect(),
    );
    input.system_sender = true;
    input.subject_line = Some(batch.meeting.title.clone());
    input.text.clone_from(&batch.meeting.description);
    input.recipient_names = attendees
        .iter()
        .filter_map(|(_, name)| name.clone())
        .filter(|name| !name.is_empty())
        .collect();
    let reservation = match check_outbound(&guard, Some(batch.db), &input).await {
        Ok(reservation) => reservation,
        Err(denied) => {
            tracing::warn!(
                "[meet-api/invitations] invitations for meeting {} not sent: the outbound guard refused ({:?})",
                batch.meeting.id,
                denied.code()
            );
            return vec![false; attendees.len()];
        }
    };
    let mut results = Vec::with_capacity(attendees.len());
    for (email, name) in attendees {
        results.push(send_one(batch, transport.as_ref(), email, name.as_deref()).await);
    }
    let sent: Vec<String> = attendees
        .iter()
        .zip(&results)
        .filter(|(_, ok)| **ok)
        .map(|((email, _), _)| email.clone())
        .collect();
    if sent.is_empty() {
        release_outbound(&guard, &reservation).await;
    } else {
        let partial = sent.len() < attendees.len();
        commit_outbound(
            &guard,
            Some(batch.db),
            &reservation,
            partial.then_some(sent.as_slice()),
        )
        .await;
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_join_link() {
        assert_eq!(portal_url(None), "https://meet.weldsuite.org");
        assert_eq!(
            portal_url(Some(" https://meet.example/ ")),
            "https://meet.example"
        );
        assert_eq!(
            join_url("https://meet.example", "org 1", "wm-abc-def-ghi"),
            "https://meet.example/org%201/wm-abc-def-ghi"
        );
    }
}
