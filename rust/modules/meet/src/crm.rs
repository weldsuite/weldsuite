//! WeldCRM's auto-add for meetings ([`weldsuite_crm_domain::auto_add`]):
//! the external people a member invites to a meeting (on create, on update
//! and through an invitation) are people the workspace deals with, so with
//! the workspace's setting on they go into the CRM. Guests joining through
//! the meeting portal are not a member's doing and add nobody.

use serde_json::Value;
use weldsuite_crm_domain::auto_add::{self, Candidate, Source};
use weldsuite_crm_domain::events::OrderedEvents;
use weldsuite_db::PgPool;

use crate::attendees::Attendee;
use crate::{Caller, MeetState};

/// The attendees who are no workspace member.
fn external(attendees: &[Attendee]) -> Vec<Candidate> {
    attendees
        .iter()
        .filter(|a| {
            a.get("workspaceMemberId")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
        })
        .filter_map(|a| {
            let email = a.get("email").and_then(Value::as_str)?;
            Some(Candidate::new(email, a.get("name").and_then(Value::as_str)))
        })
        .collect()
}

/// Adds the external attendees the caller invited. Never fails the request.
pub(crate) async fn auto_add_invitees(
    state: &MeetState,
    caller: &Caller,
    db: &PgPool,
    attendees: &[Attendee],
) {
    let candidates = external(attendees);
    if candidates.is_empty() {
        return;
    }
    let events = OrderedEvents::new(state.events.clone(), caller.events.clone());
    auto_add::add_logged(
        db,
        &events,
        Source::Meetings,
        &candidates,
        Some(&caller.user_id),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn only_people_outside_the_workspace() {
        let attendees: Vec<Attendee> = [
            json!({ "email": "jan@acme.com", "name": "Jan" }),
            json!({ "email": "ann@weldsuite.org", "workspaceMemberId": "wm_1" }),
            json!({ "email": "eve@example.com", "workspaceMemberId": "" }),
            json!({ "name": "No address" }),
        ]
        .into_iter()
        .filter_map(|v| v.as_object().cloned())
        .collect();
        assert_eq!(
            external(&attendees),
            vec![
                Candidate::new("jan@acme.com", Some("Jan")),
                Candidate::new("eve@example.com", None),
            ]
        );
    }
}
