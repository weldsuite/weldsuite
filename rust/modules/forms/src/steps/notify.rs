//! Step `notify` (`workflows/steps/notify.ts`): tells the members who follow
//! the form about the new response. Instant subscribers get a platform
//! notification (and the `forms.response` email when they are away); a daily
//! subscriber marks the workspace due for the digest. An edit of a completed
//! response notifies nobody.

use serde_json::Value;
use weldsuite_ports::BoxFuture;

use crate::common::text;
use crate::notify::notify_subscribers;
use crate::process::{ProcessContext, ProcessStep, StepKind, StepResult};

pub(crate) struct NotifyStep;

impl ProcessStep for NotifyStep {
    fn name(&self) -> &'static str {
        "notify"
    }

    fn kind(&self) -> StepKind {
        StepKind::Always
    }

    fn run<'a>(
        &'a self,
        ctx: &'a ProcessContext,
        _integration: Option<&'a Value>,
    ) -> BoxFuture<'a, Result<StepResult, String>> {
        Box::pin(async move {
            if ctx.params.mode != "update" && text(&ctx.response, "status") == "completed" {
                notify_subscribers(&ctx.ctx, &ctx.form, &ctx.response, &ctx.definition)
                    .await
                    .map_err(|error| format!("{error:?}"))?;
            }
            Ok(StepResult::Skipped(String::new()))
        })
    }
}
