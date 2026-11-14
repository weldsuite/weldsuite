//! The outbound abuse review on the Kubernetes editions
//! (`packages/domains/mail/src/outbound/review.ts`,
//! `weldsuite-documentation/plans/weldmail-outbound-abuse.md`): the model that classifies a
//! template the ledgers queued, and the queue itself.
//!
//! - [`AiTemplateClassifier`]: `classifyOutboundTemplate` on `weldsuite-ai`,
//!   feature `mail-review` (fixed to the install provider, so WeldSuite's
//!   own abuse control stays in the EU whatever a workspace enabled), task
//!   `classify`, free tier, where Global runs Llama 3.3 70B on Workers AI.
//!   Same system prompt, prompt, schema and checks
//!   ([`weldsuite_mail_domain::outbound::review`]); the verdict is stamped
//!   with the model that served. WeldSuite pays: the ops ledger gets the row
//!   (`mail_outbound_review`, `creditsCharged: 0`), the wallet is never
//!   charged. It never fails: no model, an empty sample or a failed call
//!   leave the template unclassified and the heuristics decide.
//! - [`JobsReviewQueue`] and [`OutboundReviewJob`]: the
//!   `mail-outbound-review` queue as a durable job (`mail.outbound-review`)
//!   on the deployment's jobs port. The job classifies once and hands the
//!   verdict to the ledger, retrying the ledger write as the queue consumer
//!   retries (`handleOutboundReviewBatch`).

use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_ai::{Ai, AiCall, ChatRequest, Feature, KeySource, Task, Tier};
use weldsuite_db::PgPool;
use weldsuite_mail_domain::ai_usage::{OpsUsage, record_ops_usage};
use weldsuite_mail_domain::outbound::clock;
use weldsuite_mail_domain::outbound::ledger_core::{ReviewReason, StoredVerdict};
use weldsuite_mail_domain::outbound::review::{
    OUTBOUND_CATEGORIES, ReviewContext, ReviewInput, SYSTEM_PROMPT, TemplateClassifier,
    verdict_from_model,
};
use weldsuite_mail_domain::outbound::{OutboundLedger, OutboundReviewMessage, ReviewQueue};
use weldsuite_ports::{
    BoxFuture, DynJobs, Job, JobContext, JobError, JobRequest, PortError, StepRetry,
};

/// The ops ledger's `op`.
pub const REVIEW_OP: &str = "mail_outbound_review";

/// The review job's name.
pub const OUTBOUND_REVIEW_JOB: &str = "mail.outbound-review";

/// `verdictJsonSchema`.
pub fn verdict_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "category": { "type": "string", "enum": OUTBOUND_CATEGORIES },
            "unsolicited": { "type": "boolean" },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "signals": { "type": "array", "items": { "type": "string" }, "maxItems": 8 },
        },
        "required": ["category", "unsolicited", "confidence", "signals"],
        "additionalProperties": false,
    })
}

/// The model request for one template.
pub fn review_request(input: &ReviewInput) -> ChatRequest {
    ChatRequest::system_user(SYSTEM_PROMPT, input.prompt())
        .schema("outbound_verdict", verdict_schema())
}

/// `classifyOutboundTemplate` on the install provider (feature
/// `mail-review`).
pub struct AiTemplateClassifier {
    pub ai: Option<Ai>,
    /// The ops ledger (`DATABASE_URL_MASTER`); `None` books nothing.
    pub master: Option<PgPool>,
}

impl AiTemplateClassifier {
    async fn classify_once(
        &self,
        input: &ReviewInput,
        workspace_id: Option<&str>,
        fingerprint: &str,
    ) -> Option<StoredVerdict> {
        if weldsuite_mail_domain::text::js_trim(&input.text).is_empty() {
            return None;
        }
        let ai = self.ai.as_ref().filter(|ai| ai.enabled())?;
        // The workspace scopes the concurrency cap only: the feature is fixed
        // to the install provider, and the call is booked below, uncharged.
        let scope = workspace_id.unwrap_or("personal");
        let call = AiCall::new(scope, Feature::MailReview, Task::Classify, Tier::Free)
            .op(REVIEW_OP)
            .reference(fingerprint);
        let response = match ai.chat(&call, review_request(input)).await {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(%error, "[outbound-review] model call failed");
                return None;
            }
        };
        if let Some(master) = &self.master {
            let served = &response.served;
            let cost = if served.key_source == KeySource::Own {
                0
            } else {
                weldsuite_ai::billing::nano_usd(weldsuite_ai::billing::provider_cost_usd(
                    &served.model,
                    response.usage,
                    0,
                    0.0,
                ))
            };
            let now = clock::iso(clock::now_ms());
            let idempotency_key = format!(
                "{REVIEW_OP}:{}:{fingerprint}:{}",
                workspace_id.unwrap_or("personal"),
                now.get(..10).unwrap_or_default()
            );
            record_ops_usage(
                master,
                &OpsUsage {
                    model_id: &served.model,
                    key_source: served.key_source.as_str(),
                    feature: Feature::MailReview.as_str(),
                    op: REVIEW_OP,
                    input_tokens: response.usage.input_tokens,
                    output_tokens: response.usage.output_tokens,
                    provider_cost_nano_usd: cost,
                    workspace_id,
                    reference_type: "mail_outbound_template",
                    reference_id: Some(fingerprint),
                    idempotency_key: &idempotency_key,
                },
            )
            .await;
        }
        let object = response.object.as_ref()?;
        verdict_from_model(
            object,
            fingerprint,
            &response.served.model,
            clock::iso(clock::now_ms()),
        )
    }
}

impl TemplateClassifier for AiTemplateClassifier {
    fn classify<'a>(
        &'a self,
        input: &'a ReviewInput,
        workspace_id: Option<&'a str>,
        fingerprint: &'a str,
    ) -> BoxFuture<'a, Option<StoredVerdict>> {
        Box::pin(self.classify_once(input, workspace_id, fingerprint))
    }
}

/// The `MAIL_OUTBOUND_REVIEW` queue on the deployment's jobs: each review a
/// [`OUTBOUND_REVIEW_JOB`] run, keyed by its ledger, template and time.
pub struct JobsReviewQueue {
    pub jobs: Arc<dyn DynJobs>,
}

impl ReviewQueue for JobsReviewQueue {
    fn send(&self, message: OutboundReviewMessage) -> BoxFuture<'_, Result<(), PortError>> {
        Box::pin(async move {
            let key = format!(
                "{}:{}:{}",
                message.subject.ledger_key(),
                message.request.fingerprint,
                message.requested_at
            );
            let request = JobRequest::new(OUTBOUND_REVIEW_JOB, key, &message)?;
            self.jobs.start_boxed(request).await
        })
    }
}

/// The review job: classify, then record the verdict on the ledger.
pub struct OutboundReviewJob {
    pub ledger: Arc<dyn OutboundLedger>,
    pub classifier: Arc<dyn TemplateClassifier>,
}

/// The [`ReviewInput`] of a queued review (`handleOutboundReviewBatch`).
pub fn review_input(message: &OutboundReviewMessage) -> ReviewInput {
    let request = &message.request;
    ReviewInput {
        subject: request.subject.clone(),
        text: request.sample.clone(),
        context: ReviewContext {
            first_contact_recipients: request.first_contact_recipients,
            recipients: request.recipients,
            sources: request.sources.clone(),
            trust_level: request.trust_level,
        },
    }
}

impl Job for OutboundReviewJob {
    fn name(&self) -> &'static str {
        OUTBOUND_REVIEW_JOB
    }

    fn run<'a>(
        &'a self,
        ctx: &'a dyn JobContext,
        payload: Value,
    ) -> BoxFuture<'a, Result<(), JobError>> {
        Box::pin(async move {
            let message: OutboundReviewMessage = serde_json::from_value(payload)?;
            let input = review_input(&message);
            // One model call: a replay returns the journaled verdict.
            let verdict: Option<StoredVerdict> =
                weldsuite_ports::step(ctx, "classify", StepRetry::ONCE, || async {
                    Ok(self
                        .classifier
                        .classify(
                            &input,
                            message.subject.workspace_id(),
                            &message.request.fingerprint,
                        )
                        .await)
                })
                .await?;
            let Some(verdict) = verdict else {
                return Ok(());
            };
            let key = message.subject.ledger_key();
            let staff = message.request.reason == ReviewReason::Staff;
            weldsuite_ports::step(ctx, "record-verdict", StepRetry::default(), || async {
                self.ledger
                    .record_verdict(&key, &verdict, staff)
                    .await
                    .map_err(|error| {
                        tracing::error!(%error, "[outbound-review] failed");
                        JobError::failed(error)
                    })
            })
            .await
        })
    }
}

#[cfg(test)]
mod tests {
    use weldsuite_ai::{AiConfig, FakeProvider, ProviderId};
    use weldsuite_mail_domain::outbound::limits::TrustLevel;

    use super::*;

    fn input(text: &str) -> ReviewInput {
        ReviewInput {
            subject: "Quick question".to_owned(),
            text: text.to_owned(),
            context: ReviewContext {
                first_contact_recipients: 12,
                recipients: 15,
                sources: vec!["compose".to_owned()],
                trust_level: TrustLevel::New,
            },
        }
    }

    fn ai(fake: &FakeProvider, optin: bool) -> Ai {
        let lookup = |name: &str| match name {
            "AI_DEFAULT_PROVIDER" => Some("mistral".to_owned()),
            "MISTRAL_API_KEY" => Some("k".to_owned()),
            "AI_OPTIN_ANTHROPIC" if optin => Some("weldsuite".to_owned()),
            "ANTHROPIC_API_KEY" if optin => Some("a".to_owned()),
            _ => None,
        };
        Ai::fake(
            AiConfig::from_lookup(&lookup, &mut Vec::new()),
            fake.clone(),
        )
    }

    #[tokio::test]
    async fn a_template_is_classified_on_the_install_provider() {
        let fake = FakeProvider::new().reply_json(&json!({
            "category": "cold_outreach",
            "unsolicited": true,
            "confidence": 0.86,
            "signals": ["meeting request", "first contact"],
        }));
        let classifier = AiTemplateClassifier {
            ai: Some(ai(&fake, true)),
            master: None,
        };
        let verdict = classifier
            .classify(
                &input("hi tokname, quick question"),
                Some("ws_1"),
                "4af60179559eb53e",
            )
            .await
            .expect("verdict");
        assert_eq!(verdict.category, "cold_outreach");
        assert!(verdict.unsolicited);
        assert!((verdict.confidence - 0.86).abs() < f64::EPSILON);
        assert_eq!(verdict.fingerprint, "4af60179559eb53e");
        assert_eq!(
            Some(verdict.model_id.as_str()),
            weldsuite_ai::catalog::task_model(ProviderId::Mistral, Task::Classify, Tier::Free)
        );
        let sent = &fake.calls()[0];
        assert!(sent.url.starts_with("https://api.mistral.ai/"));
        assert_eq!(sent.body["messages"][0]["content"], SYSTEM_PROMPT);
        assert_eq!(
            sent.body["messages"][1]["content"],
            input("hi tokname, quick question").prompt()
        );
        assert_eq!(
            sent.body["response_format"]["json_schema"]["schema"],
            verdict_schema()
        );
    }

    #[tokio::test]
    async fn no_model_an_empty_sample_or_a_bad_answer_leave_it_unclassified() {
        let fake = FakeProvider::new()
            .reply_json(&json!({ "category": "spam", "unsolicited": true, "confidence": 0.9, "signals": [] }))
            .reply_status(500, "{\"error\":{\"message\":\"down\"}}");
        let off = AiTemplateClassifier {
            ai: None,
            master: None,
        };
        assert!(off.classify(&input("text"), None, "fp").await.is_none());
        let classifier = AiTemplateClassifier {
            ai: Some(ai(&fake, false)),
            master: None,
        };
        assert!(
            classifier
                .classify(&input("   "), None, "fp")
                .await
                .is_none()
        );
        assert!(fake.calls().is_empty());
        // A category outside the list fails the schema check.
        assert!(
            classifier
                .classify(&input("text"), None, "fp")
                .await
                .is_none()
        );
        // A failing provider (after its retries) too.
        assert!(
            classifier
                .classify(&input("text"), None, "fp")
                .await
                .is_none()
        );
    }

    #[test]
    fn the_queue_keys_a_run_by_ledger_template_and_time() {
        use weldsuite_mail_domain::outbound::ledger_core::{LedgerSubject, ReviewRequest};
        let message = OutboundReviewMessage {
            subject: LedgerSubject::workspace("ws_1", Some("org_1")),
            request: ReviewRequest {
                fingerprint: "fp".to_owned(),
                sample: "hello tokname".to_owned(),
                subject: "Hi".to_owned(),
                reason: ReviewReason::TemplateThreshold,
                first_contact_recipients: 10,
                recipients: 11,
                sources: vec!["api".to_owned()],
                domains: Vec::new(),
                trust_level: TrustLevel::Standard,
            },
            requested_at: "2026-11-13T10:00:00.000Z".to_owned(),
        };
        let input = review_input(&message);
        assert_eq!(input.text, "hello tokname");
        assert_eq!(input.context.recipients, 11);
        assert_eq!(input.context.trust_level, TrustLevel::Standard);
    }
}
