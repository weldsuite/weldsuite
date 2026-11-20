//! Step `quota` (`workflows/steps/quota.ts`): the response may have taken
//! the workspace to 80 % or 100 % of its monthly quota; owners and admins get
//! `forms.quota` once per threshold per month.

use serde_json::Value;
use weldsuite_ports::BoxFuture;

use crate::common::text;
use crate::notify::send_quota_notices;
use crate::process::{ProcessContext, ProcessStep, StepKind, StepResult};

pub(crate) struct QuotaStep;

impl ProcessStep for QuotaStep {
    fn name(&self) -> &'static str {
        "quota"
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
                send_quota_notices(&ctx.ctx)
                    .await
                    .map_err(|error| format!("{error:?}"))?;
            }
            Ok(StepResult::Skipped(String::new()))
        })
    }
}
