//! Invitations of one form (`routes/invitations/index.ts`):
//!
//! ```text
//! POST /forms/:id/invitations                  invite members, CRM people, a CRM list, pasted addresses
//! GET  /forms/:id/invitations                  list (status, q, cursor)
//! GET  /forms/:id/invitations/stats
//! POST /forms/:id/invitations/remind           everyone who has not answered, or the given ones
//! POST /forms/:id/invitations/:iid/revoke      every link of the invitation stops working
//! ```
//!
//! `forms:send`, narrowed by the member's role on the form. Events:
//! `form_invitation:sent` (with `reminder: true` for reminders) and
//! `:revoked`; `:completed` comes from the submit. The workspace is marked
//! due in the reminder index so the sweep sees the next automatic reminder.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value};
use weldsuite_catalogs::entity_events::{FORM_INVITATION_REVOKED, FORM_INVITATION_SENT};
use weldsuite_catalogs::permission_keys::FORMS_SEND;
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};
use weldsuite_kit::{Created, Data, List, Pagination};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::{Member, load_form};
use crate::FormsState;
use crate::access::Need;
use crate::common::{Ctx, answer, text};
use crate::input;
use crate::invitations::{
    CreateInvitations, ListInvitations, REMINDERS_KIND, Recipients, ReminderPlan, RemindersInput,
    create_invitations, event_data, invitation_stats, list_invitations, remind_invitations,
    revoke_invitation, to_invitation_dto,
};

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<FormsState>
where
    Q: PermissionQueries + 'static,
{
    let need = || gate.require([FORMS_SEND.to_owned()]);
    Router::new()
        .route(
            "/forms/{id}/invitations",
            get(list).post(create).route_layer(need()),
        )
        .route(
            "/forms/{id}/invitations/stats",
            get(stats).route_layer(need()),
        )
        .route(
            "/forms/{id}/invitations/remind",
            post(remind).route_layer(need()),
        )
        .route(
            "/forms/{id}/invitations/{iid}/revoke",
            post(revoke).route_layer(need()),
        )
}

// ── Schemas ──────────────────────────────────────────────────────────────────

fn text_rules(trim: bool, min: Option<usize>, max: usize) -> Text {
    Text {
        trim,
        lowercase: false,
        format: None,
        min,
        max: Some(max),
    }
}

fn email_rules() -> Text {
    Text {
        trim: true,
        lowercase: false,
        format: Some(Format::Email),
        min: None,
        max: Some(320),
    }
}

fn day_count(issues: &mut Issues, b: &Map<String, Value>, key: &str, min: f64, max: f64) -> i64 {
    issues
        .whole_number(
            b,
            key,
            Presence::Required,
            Number {
                coerce: false,
                int: true,
                min: Some(min),
                max: Some(max),
            },
        )
        .into_option()
        .unwrap_or_default()
}

fn strings(issues: &mut Issues, b: &Map<String, Value>, key: &str, max: usize) -> Vec<String> {
    issues
        .list(
            b,
            key,
            Presence::Optional,
            None,
            Some(500),
            |issues, item| issues.item_text(item, text_rules(false, None, max)),
        )
        .into_option()
        .unwrap_or_default()
}

/// `recipients.refine(r => emails?.length || userIds?.length || personIds?.length || listId)`.
fn has_recipient(r: &Map<String, Value>) -> bool {
    let listed = |key: &str| {
        r.get(key)
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty())
    };
    listed("emails")
        || listed("userIds")
        || listed("personIds")
        || r.get("listId")
            .and_then(Value::as_str)
            .is_some_and(|l| !l.is_empty())
}

/// `createFormInvitationsSchema`.
fn create_input(issues: &mut Issues, b: &Map<String, Value>) -> CreateInvitations {
    let before = issues.count();
    let recipients = issues
        .nested(b, "recipients", Presence::Required, |issues, r| {
            Recipients {
                emails: issues
                    .list(
                        r,
                        "emails",
                        Presence::Optional,
                        None,
                        Some(500),
                        |issues, item| {
                            let fields = issues.object(item)?;
                            let email = issues.text_with(
                                fields,
                                "email",
                                Presence::Required,
                                email_rules(),
                            );
                            let name = issues.text_with(
                                fields,
                                "name",
                                Presence::Optional,
                                text_rules(false, None, 255),
                            );
                            Some((email.into_option()?, name.into_option()))
                        },
                    )
                    .into_option()
                    .unwrap_or_default(),
                user_ids: strings(issues, r, "userIds", 255),
                person_ids: strings(issues, r, "personIds", 30),
                list_id: issues
                    .text_with(r, "listId", Presence::Optional, text_rules(false, None, 30))
                    .into_option(),
            }
        })
        .into_option();
    // Zod refines an object whose fields got past their type checks.
    let refine = matches!(b.get("recipients"), Some(Value::Object(_)))
        && !issues
            .issues_since(before)
            .iter()
            .any(|issue| issue["code"] == "invalid_type");
    let subject = issues
        .text_with(
            b,
            "subject",
            Presence::Optional,
            text_rules(true, Some(1), 255),
        )
        .into_option();
    let message = issues
        .text_with(
            b,
            "message",
            Presence::Optional,
            text_rules(false, None, 5000),
        )
        .into_option();
    let locale = issues
        .choice(b, "locale", Presence::Optional, &["en", "nl"])
        .into_option();
    let reminders = match issues.nested(b, "reminders", Presence::Nullish, |issues, r| {
        ReminderPlan {
            after_days: day_count(issues, r, "afterDays", 1.0, 30.0),
            every_days: day_count(issues, r, "everyDays", 1.0, 30.0),
            max_count: day_count(issues, r, "maxCount", 0.0, 5.0),
        }
    }) {
        weldsuite_kit::validation::Field::Absent => RemindersInput::Default,
        weldsuite_kit::validation::Field::Null => RemindersInput::None,
        weldsuite_kit::validation::Field::Set(plan) => RemindersInput::Set(plan),
    };
    if refine
        && let Some(Value::Object(r)) = b.get("recipients")
        && !has_recipient(r)
    {
        issues.custom("recipients", "Pick at least one recipient");
    }
    CreateInvitations {
        recipients: recipients.unwrap_or_default(),
        subject,
        message,
        locale,
        reminders,
    }
}

/// `listFormInvitationsQuerySchema`.
fn list_query(issues: &mut Issues, q: &Map<String, Value>) -> ListInvitations {
    ListInvitations {
        status: issues
            .choice(
                q,
                "status",
                Presence::Optional,
                &["sent", "opened", "started", "completed", "revoked"],
            )
            .into_option(),
        q: issues
            .text_with(q, "q", Presence::Optional, text_rules(false, None, 200))
            .into_option(),
        cursor: issues
            .text_with(
                q,
                "cursor",
                Presence::Optional,
                text_rules(false, None, 200),
            )
            .into_option(),
        limit: issues
            .whole_number(
                q,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    int: true,
                    min: Some(1.0),
                    max: Some(200.0),
                },
            )
            .into_option(),
    }
}

/// `remindFormInvitationsSchema`.
fn remind_input(issues: &mut Issues, b: &Map<String, Value>) -> Option<Vec<String>> {
    issues
        .list(
            b,
            "invitationIds",
            Presence::Optional,
            None,
            Some(500),
            |issues, item| issues.item_text(item, text_rules(false, Some(1), 30)),
        )
        .into_option()
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/// `markWorkspaceDue(SCHEDULE_INDEX, 'forms_reminders', …, at)`, after the answer.
fn mark_reminders_due(ctx: &Ctx, at_ms: i64) {
    let Some(master) = ctx.master.clone() else {
        return;
    };
    let workspace_id = ctx.workspace_id.clone();
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(at_ms) * 1_000_000)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    ctx.after(async move {
        weldsuite_db::due_index::mark_due(&master, REMINDERS_KIND, &workspace_id, at).await;
    });
}

async fn create(
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let input = input::json(&headers, &body, create_input)?;
            let loaded = load_form(&member, &id, Some(Need::Send)).await?;
            let made =
                create_invitations(&member.ctx, &loaded.form, &member.user_id, &input).await?;
            for row in &made.created {
                member.publish(
                    FORM_INVITATION_SENT,
                    text(row, "id"),
                    &event_data(row, false),
                );
            }
            if let Some(next) = made.next_reminder_at {
                mark_reminders_due(&member.ctx, next);
            }
            Ok(Created(made.result).into_response())
        }
        .await,
    )
}

async fn list(member: Member, Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    answer(
        async {
            let query = input::query(query.as_deref(), list_query)?;
            let loaded = load_form(&member, &id, Some(Need::Send)).await?;
            let (rows, total, next) =
                list_invitations(&member.ctx, text(&loaded.form, "id"), &query).await?;
            Ok(List::new(
                rows,
                Pagination::new(u64::try_from(total).unwrap_or(0), next.is_some(), next),
            )
            .into_response())
        }
        .await,
    )
}

async fn stats(member: Member, Path(id): Path<String>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::Send)).await?;
            Ok(
                Data(invitation_stats(&member.ctx, text(&loaded.form, "id")).await?)
                    .into_response(),
            )
        }
        .await,
    )
}

async fn remind(
    member: Member,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let ids = input::json(&headers, &body, remind_input)?;
            let loaded = load_form(&member, &id, Some(Need::Send)).await?;
            let (outcome, result) =
                remind_invitations(&member.ctx, &loaded.form, &member.user_id, ids.as_deref())
                    .await?;
            for row in &outcome.reminded {
                member.publish(
                    FORM_INVITATION_SENT,
                    text(row, "id"),
                    &event_data(row, true),
                );
            }
            if let Some(next) = outcome.next_reminder_at {
                mark_reminders_due(&member.ctx, next);
            }
            Ok(Data(result).into_response())
        }
        .await,
    )
}

async fn revoke(member: Member, Path((id, iid)): Path<(String, String)>) -> Response {
    answer(
        async {
            let loaded = load_form(&member, &id, Some(Need::Send)).await?;
            let row = revoke_invitation(&member.ctx, text(&loaded.form, "id"), &iid).await?;
            member.publish(
                FORM_INVITATION_REVOKED,
                text(&row, "id"),
                &event_data(&row, false),
            );
            Ok(Data(to_invitation_dto(&row)).into_response())
        }
        .await,
    )
}
