//! `engine/actions/merge.ts`: `merge.create_issue`, `merge.update_issue`,
//! `merge.comment_on_issue`.
//!
//! Like the CRM and WeldFlow actions these never write the tenant tables
//! directly: they hand the inputs to WeldMerge's workflow-action intake
//! (`MERGE_INTERNAL.workflowAction`, in process: [`MergeWorkflowActions`]),
//! which checks the workflow OWNER's WeldMerge permissions as they are now
//! (CONN-004), goes through the same issue services as the member routes and
//! publishes the same entity events, with the run's chain depth so those
//! events cannot retrigger workflows forever.
//!
//! A refusal (no permission, unknown issue, bad input) comes back as
//! `ok: false` and fails the step without retrying: asking again cannot
//! change the answer.

use serde_json::{Map, Value, json};

use super::records::workflow_actor;
use super::{ActionCtx, ActionError, ActionResult};

/// `MERGE_INTERNAL.workflowAction(envelope)`: WeldMerge's answer
/// (`{ ok, issueId, issueKey, commentId, error }`), or `Err` with what the
/// call threw (the intake failed).
pub trait MergeWorkflowActions: Send + Sync {
    fn workflow_action(
        &self,
        envelope: Value,
    ) -> weldsuite_ports::BoxFuture<'_, Result<Value, String>>;
}

/// `runMergeAction(action, inputs, ctx)`.
pub(super) async fn run(
    action: &str,
    inputs: &Map<String, Value>,
    ctx: &ActionCtx<'_>,
) -> ActionResult {
    let Some(binding) = ctx.deps.merge.as_deref() else {
        return Err(ActionError::fatal(
            "WeldMerge actions are not available on this deployment",
        ));
    };
    let actor = workflow_actor(ctx)?;
    let envelope = json!({
        "workspaceId": actor["workspaceId"],
        "userId": actor["ownerUserId"],
        "action": action,
        "input": inputs,
        "chainDepth": actor["chainDepth"],
    });
    let result = binding
        .workflow_action(envelope)
        .await
        .map_err(|error| ActionError::plain(&error))?;
    answer(action, &result)
}

/// WeldMerge's answer as the step's: a refusal (`ok: false`) fails it for
/// good, else [`output`].
fn answer(action: &str, result: &Value) -> ActionResult {
    if result.get("ok") != Some(&Value::Bool(true)) {
        // `result.error ?? 'WeldMerge refused the action'`.
        let error = match result.get("error") {
            None | Some(Value::Null) => "WeldMerge refused the action".to_owned(),
            Some(Value::String(error)) => error.clone(),
            Some(other) => other.to_string(),
        };
        return Err(ActionError::fatal(&format!("{action} failed: {error}")));
    }
    Ok(output(result))
}

/// The step's result: the issue (and comment) WeldMerge answered, and where
/// the issue opens.
fn output(result: &Value) -> Value {
    let field = |key: &str| result.get(key).cloned().unwrap_or(Value::Null);
    let url = match result.get("issueKey") {
        Some(Value::String(key)) if !key.is_empty() => json!(format!("/weldmerge/issues/{key}")),
        _ => Value::Null,
    };
    json!({
        "issueId": field("issueId"),
        "issueKey": field("issueKey"),
        "commentId": field("commentId"),
        "url": url,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_fails_the_step_for_good() {
        let refused = answer(
            "merge.create_issue",
            &json!({ "ok": false, "issueId": null, "issueKey": null, "commentId": null,
                     "error": "The member this call acts for may not create issues (merge_issues:create)" }),
        )
        .unwrap_err();
        assert_eq!(refused.name, "NonRetryableStepError");
        assert!(refused.non_retryable);
        assert_eq!(
            refused.message,
            "merge.create_issue failed: The member this call acts for may not create issues (merge_issues:create)"
        );
        let silent =
            answer("merge.update_issue", &json!({ "ok": false, "error": null })).unwrap_err();
        assert_eq!(
            silent.message,
            "merge.update_issue failed: WeldMerge refused the action"
        );
        assert_eq!(
            answer(
                "merge.comment_on_issue",
                &json!({ "ok": true, "issueId": "mis_1", "issueKey": "PLAT-1", "commentId": "mcm_1", "error": null })
            )
            .unwrap()["commentId"],
            json!("mcm_1")
        );
    }

    #[test]
    fn the_output_links_the_issue_by_key() {
        assert_eq!(
            output(
                &json!({ "ok": true, "issueId": "mis_1", "issueKey": "PLAT-1", "commentId": null, "error": null })
            ),
            json!({ "issueId": "mis_1", "issueKey": "PLAT-1", "commentId": null, "url": "/weldmerge/issues/PLAT-1" })
        );
        assert_eq!(
            output(&json!({ "ok": true, "issueId": null, "issueKey": "", "commentId": "mcm_1" }))["url"],
            Value::Null
        );
    }
}
