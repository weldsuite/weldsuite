//! `MERGE_INTERNAL`: the GitHub App webhook's forward to WeldMerge
//! (`github/merge-forward.ts`). On Global the receiver calls merge-api's
//! `MergeInternal.githubEvent` over a service binding; here the binary
//! answers in process from WeldMerge's internal router.
//!
//! The forward runs after the App's HMAC is verified and the workspace is
//! resolved, and is fire-and-forget: a missing binding or a failing intake
//! is logged and never changes the webhook's answer, and the WeldFlow
//! handling next to it is untouched.

use serde_json::{Value, json};
use weldsuite_ports::BoxFuture;

/// The events WeldMerge mirrors (`MERGE_GITHUB_FORWARDED_EVENTS`).
pub const FORWARDED_EVENTS: [&str; 4] = [
    "pull_request",
    "pull_request_review",
    "check_suite",
    "installation_repositories",
];

/// `isForwardedToMerge(event)`.
pub fn is_forwarded_to_merge(event: &str) -> bool {
    FORWARDED_EVENTS.contains(&event)
}

/// merge-api's `MergeInternal` entrypoint: `githubEvent(envelope)`. An `Err`
/// is what the call threw (the intake refused or failed).
pub trait MergeInternal: Send + Sync {
    fn github_event(&self, envelope: Value) -> BoxFuture<'_, Result<Value, String>>;
}

/// The envelope `forwardToMerge` sends (`MergeGithubEventEnvelope`).
pub fn envelope(workspace_id: &str, event: &str, delivery_id: &str, payload: &Value) -> Value {
    json!({
        "workspaceId": workspace_id,
        "event": event,
        // `deliveryId || null`.
        "deliveryId": if delivery_id.is_empty() { Value::Null } else { json!(delivery_id) },
        "payload": payload,
    })
}

/// `forwardToMerge(env, input)`: never fails; logs and returns when the
/// binding is missing or the call fails.
pub async fn forward_to_merge(
    binding: Option<&dyn MergeInternal>,
    workspace_id: &str,
    event: &str,
    delivery_id: &str,
    payload: &Value,
) {
    let Some(binding) = binding else {
        tracing::warn!(
            "[GitHub Webhook] MERGE_INTERNAL binding missing; {event} not forwarded to WeldMerge (delivery: {delivery_id})"
        );
        return;
    };
    if let Err(error) = binding
        .github_event(envelope(workspace_id, event, delivery_id, payload))
        .await
    {
        tracing::error!(
            "[GitHub Webhook] WeldMerge refused {event} (delivery: {delivery_id}): {error}"
        );
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    struct Recording(Arc<Mutex<Vec<Value>>>, bool);

    impl MergeInternal for Recording {
        fn github_event(&self, envelope: Value) -> BoxFuture<'_, Result<Value, String>> {
            self.0.lock().unwrap().push(envelope);
            let fail = self.1;
            Box::pin(async move {
                if fail {
                    Err("merge-api github-event answered 500".to_owned())
                } else {
                    Ok(json!({ "outcome": "applied" }))
                }
            })
        }
    }

    #[test]
    fn forwards_only_what_weldmerge_mirrors() {
        assert!(is_forwarded_to_merge("pull_request"));
        assert!(is_forwarded_to_merge("installation_repositories"));
        assert!(!is_forwarded_to_merge("issues"));
        assert!(!is_forwarded_to_merge("projects_v2_item"));
    }

    #[tokio::test]
    async fn sends_the_envelope_and_swallows_a_refusal() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let payload = json!({ "action": "opened", "installation": { "id": 4242 } });
        for fail in [false, true] {
            let binding = Recording(Arc::clone(&sent), fail);
            forward_to_merge(Some(&binding), "org_alpha", "pull_request", "d-1", &payload).await;
        }
        forward_to_merge(None, "org_alpha", "pull_request", "", &payload).await;
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(
            sent[0],
            json!({ "workspaceId": "org_alpha", "event": "pull_request", "deliveryId": "d-1", "payload": payload })
        );
        assert_eq!(
            envelope("o", "check_suite", "", &json!({}))["deliveryId"],
            Value::Null
        );
    }
}
