//! WeldCRM's auto-add for the helpdesk ([`weldsuite_crm_domain::auto_add`]):
//! a requester an agent has publicly replied to is someone the workspace
//! deals with, so with the workspace's setting on they go into the CRM, the
//! replying agent owning them when nobody does. Internal notes and
//! conversations without an address add nobody.

use serde_json::Value;
use weldsuite_crm_domain::auto_add::{self, Candidate, Source};
use weldsuite_crm_domain::events::OrderedEvents;

use crate::{Caller, DeskState};

/// The conversation's requester, when it has an address.
fn requester(conversation: &Value) -> Option<Candidate> {
    let email = conversation
        .get("email")
        .and_then(Value::as_str)
        .filter(|e| !e.trim().is_empty())?;
    let name = conversation.get("name").and_then(Value::as_str);
    Some(Candidate::new(email, name))
}

/// Adds the requester of a conversation the caller replied to. Never fails
/// the reply.
pub(crate) async fn auto_add_requester(state: &DeskState, caller: &Caller, conversation: &Value) {
    let Some(candidate) = requester(conversation) else {
        return;
    };
    let events = OrderedEvents::new(state.events.clone(), caller.events.clone());
    auto_add::add_logged(
        &caller.db,
        &events,
        Source::Helpdesk,
        &[candidate],
        Some(&caller.user_id),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_requester_needs_an_address() {
        assert_eq!(
            requester(&json!({ "email": "jan@acme.com", "name": "Jan" })),
            Some(Candidate::new("jan@acme.com", Some("Jan")))
        );
        assert_eq!(requester(&json!({ "email": " ", "name": "Jan" })), None);
        assert_eq!(
            requester(&json!({ "email": null, "visitorId": "v_1" })),
            None
        );
    }
}
