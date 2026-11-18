//! Step `receipt` (`workflows/steps/receipt.ts`): a copy of the answers to
//! the respondent when the form has `sendReceipt` on. Only ever to a verified
//! address: a verified-email form (the address was proven with a code) or an
//! invitation (the link went to it); never to an address typed into an
//! anonymous form, and never on a members-only form. Fields the author
//! marked sensitive, files and signatures stay out of the copy.

use serde_json::Value;
use weldsuite_ports::BoxFuture;

use crate::common::text;
use crate::mail::send_receipt_mail;
use crate::model::FormSettings;
use crate::process::{ProcessContext, ProcessStep, StepKind, StepResult};
use crate::response_text::answer_pairs;

pub(crate) struct ReceiptStep;

impl ProcessStep for ReceiptStep {
    fn name(&self) -> &'static str {
        "receipt"
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
            let done = || Ok(StepResult::Skipped(String::new()));
            let response = &ctx.response;
            if ctx.params.mode == "update" || text(response, "status") != "completed" {
                return done();
            }
            let settings = FormSettings::parse(&ctx.form["settings"]);
            let Some(to) = response["respondentEmail"]
                .as_str()
                .filter(|e| !e.is_empty())
            else {
                return done();
            };
            if !settings.send_receipt {
                return done();
            }
            let verified = settings.respondent_mode == "verified_email"
                || response["invitationId"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty());
            if !verified || settings.respondent_mode == "members" {
                return done();
            }
            let answers = answer_pairs(&ctx.definition, &response["answers"], true);
            let language = serde_json::to_value(ctx.definition.presentation.language)
                .ok()
                .and_then(|language| language.as_str().map(str::to_owned));
            send_receipt_mail(
                &ctx.ctx,
                &ctx.form,
                language.as_deref(),
                to,
                response["number"].as_i64(),
                &answers,
            )
            .await
            .map_err(|error| format!("{error:?}"))?;
            done()
        })
    }
}
