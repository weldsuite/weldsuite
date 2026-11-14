//! `engine/actions/ai.ts`: `ai_generate` and `ai_classify`, on the install's
//! AI provider through `weldsuite-ai` (ADR AI-012, feature `connect`).
//!
//! Inputs, defaults, outputs and errors are the worker's:
//!
//! - `ai_generate`: `prompt` (required), `systemPrompt` (or `system`),
//!   `model`, `temperature`, `maxTokens` (or `max_tokens`); answers
//!   `{ text, model, finishReason, usage, creditsUsed }`. Without a model,
//!   `draft` at the free tier.
//! - `ai_classify`: `text` (or `input`) and `categories` (or `labels`), both
//!   required, and `model`; a JSON answer `{ category, confidence,
//!   reasoning }` with `category` one of the categories, answered as
//!   `{ category, confidence, reasoning, model, usage, creditsUsed }`.
//!   Without a model, `classify` at the free tier.
//!
//! **A step's own model** (`inputs.model`, stored on the workflow) is a
//! stored choice: the workspace policy uses it only when its provider is
//! enabled and it can do the job, and otherwise skips it with a log line and
//! takes the feature's model. The worker sends any id to the gateway and fails
//! the step when it doesn't know it; that stays Global's.
//!
//! **Credits.** The hard gate runs first (`AiInsufficientCreditsError`, which
//! the engine retries like any failure), then the run's cap
//! (`workflows.settings.maxCreditsPerRun`): what this run has already been
//! charged (its `credit_transactions`, by the execution id the charges carry
//! as their reference) plus this call's worst-case estimate must stay within
//! it, or the step fails without retrying (`ai_credit_cap_exceeded`). The
//! estimate (input length / 4 tokens in, `maxTokens` or a default out, the
//! dearer of the model and its fallback) never changes what is charged: that
//! is the provider's real usage, metered by `weldsuite-ai` with the ledger op
//! `ai_generate` / `ai_classify`. A step's attempt is journaled, so a replay
//! returns its result instead of calling (and charging) again.
//!
//! Without an AI provider both steps fail as the worker without its gateway
//! does (`GatewayConfigError`, after the input checks).

use serde_json::{Map, Value, json};
use weldsuite_ai::{
    Ai, AiCall, AiError, BillingMode, ChatRequest, ChatResponse, Feature, KeySource, LedgerTag,
    Message, Task, Tier, Usage, billing,
};
use weldsuite_db::PgPool;

use super::{ActionCtx, ActionError, ActionResult, text_or};
use crate::js::{as_text, coalesce, js_number, js_string};

/// The ledger ops (`chargeUsage({ op })`).
const OP_GENERATE: &str = "ai_generate";
const OP_CLASSIFY: &str = "ai_classify";
/// `credit_transactions.reference_type` of an AI step's charge, as
/// workflow-worker books it: the run's cap sums these.
const STEP_REFERENCE_TYPE: &str = "workflow_step";

/// Rough characters per token, for the cap's estimate only.
const CHARS_PER_TOKEN_ESTIMATE: usize = 4;
/// Worst-case output tokens of `ai_generate` without `maxTokens`.
const GENERATE_OUTPUT_TOKENS_ESTIMATE: i64 = 4096;
/// `ai_classify` asks for one small object.
const CLASSIFY_OUTPUT_TOKENS_ESTIMATE: i64 = 300;

/// `ai_classify`'s system prompt.
const CLASSIFY_SYSTEM: &str = "You are a text classifier. Classify the given text into exactly one of the provided categories. Include a confidence between 0 and 1 and a brief reasoning.";

/// Who an AI step runs for, and where its settings and wallet are.
struct Scope {
    tenant: Option<PgPool>,
    master: Option<PgPool>,
    /// `workspaces.id` when the master database knows the run's workspace
    /// (metered), else the run's own reference (unmetered).
    workspace_id: String,
    metered: bool,
    user_id: Option<String>,
    execution_id: String,
    /// The step's id: with the execution and the op, the charge's
    /// idempotency key.
    step_id: String,
    /// `workflows.settings.maxCreditsPerRun`.
    cap: Option<i64>,
}

impl Scope {
    /// `resolveMetering(ctx)`: the run's workspace in the master database.
    async fn of(ctx: &ActionCtx<'_>) -> Self {
        let reference = &ctx.info.workspace_id;
        let internal = match &ctx.deps.master {
            Some(master) => match sqlx::query_scalar::<_, String>(
                "select id from workspaces where id = $1 or clerk_org_id = $1 limit 1",
            )
            .bind(reference)
            .fetch_optional(master)
            .await
            {
                Ok(found) => {
                    if found.is_none() {
                        tracing::warn!(workspace = %reference, "[ai] no master workspace; unmetered");
                    }
                    found
                }
                Err(error) => {
                    tracing::warn!(%error, "[ai] credit metering unavailable");
                    None
                }
            },
            None => None,
        };
        Self {
            tenant: Some(ctx.db.clone()),
            master: ctx.deps.master.clone(),
            metered: internal.is_some(),
            workspace_id: internal.unwrap_or_else(|| reference.clone()),
            user_id: Some(ctx.info.user_id.clone()).filter(|id| !id.is_empty()),
            execution_id: ctx.info.execution_id.clone(),
            step_id: ctx.step_id.to_owned(),
            cap: ctx.info.max_credits_per_run,
        }
    }

    /// The step's call: feature `connect` at the free tier, its own model as
    /// a stored choice, charged with `op` against the run.
    fn call(&self, task: Task, op: &str, model: Option<&str>) -> AiCall {
        let mut call = AiCall::new(&self.workspace_id, Feature::Connect, task, Tier::Free)
            .master(self.master.clone())
            .stored_model(model)
            .op(op)
            .reference(&self.execution_id)
            // `chargeStepUsage`: booked against the step, once per attempt.
            .ledger(LedgerTag {
                reference_type: STEP_REFERENCE_TYPE.to_owned(),
                idempotency_key: Some(format!("wf:{}:{}:{op}", self.execution_id, self.step_id)),
                label: "Workflow AI".to_owned(),
            });
        if let Some(tenant) = &self.tenant {
            call = call.tenant(tenant.clone());
        }
        if let Some(user) = &self.user_id {
            call = call.user(user);
        }
        call
    }
}

/// `assertGatewayConfigured(ctx.env)`: the install's AI, or the error the
/// worker throws without its gateway.
fn available(ai: Option<&Ai>) -> Result<&Ai, ActionError> {
    ai.filter(|ai| ai.enabled()).ok_or_else(not_configured)
}

fn not_configured() -> ActionError {
    ActionError::named("GatewayConfigError", crate::generate::NOT_CONFIGURED)
}

/// What a failed AI call throws in the worker.
fn failure(error: AiError) -> ActionError {
    match error {
        AiError::Unavailable => not_configured(),
        AiError::InsufficientCredits { balance, required } => ActionError::named(
            "AiInsufficientCreditsError",
            &format!(
                "Insufficient AI credits for this workflow step (balance {balance}, need {required})"
            ),
        ),
        AiError::Provider { message, .. } => ActionError::named("AI_APICallError", &message),
        AiError::Invalid(message) => ActionError::named("AI_NoObjectGeneratedError", &message),
        other => ActionError::plain(&other.to_string()),
    }
}

/// `estimateTokens(text)`: JavaScript's length (UTF-16 units) / 4, at least 1.
fn estimate_tokens(text: &str) -> i64 {
    let units = text.encode_utf16().count();
    i64::try_from(units.div_ceil(CHARS_PER_TOKEN_ESTIMATE).max(1)).unwrap_or(i64::MAX)
}

/// `estimateMaxCredits(…)`: the worst case over the targets WeldSuite pays
/// for (the model and its fallbacks); an own key costs the wallet nothing.
async fn estimate_max_credits(
    ai: &Ai,
    call: &AiCall,
    input: &str,
    max_output: Option<u32>,
    default_output: i64,
) -> Result<i64, ActionError> {
    let route = ai.route(call).await.map_err(failure)?;
    let usage = Usage {
        input_tokens: estimate_tokens(input),
        output_tokens: max_output.map_or(default_output, i64::from),
    };
    Ok(route
        .targets()
        .filter(|target| target.key_source == KeySource::Weldsuite)
        .map(|target| {
            billing::credits_for_cost_usd(billing::provider_cost_usd(&target.model, usage, 0, 0.0))
        })
        .max()
        .unwrap_or(0))
}

/// `sumChargedCredits(master, { referenceId: executionId, … })`: every
/// credit this run's AI calls were charged, debts included.
async fn charged_this_run(
    master: &PgPool,
    workspace_id: &str,
    execution_id: &str,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "select coalesce(sum(abs(amount)), 0)::bigint from credit_transactions
         where workspace_id = $1 and reference_id = $2 and reference_type = $3
           and service_type = 'ai_tokens'",
    )
    .bind(workspace_id)
    .bind(execution_id)
    .bind(STEP_REFERENCE_TYPE)
    .fetch_one(master)
    .await
}

/// `assertWithinCreditCap(…)`: a no-op without a cap, without metering, or
/// when the install only displays usage (nothing is charged to cap).
async fn assert_within_cap(
    ai: &Ai,
    scope: &Scope,
    call: &AiCall,
    op: &str,
    estimate: impl Future<Output = Result<i64, ActionError>>,
) -> Result<(), ActionError> {
    let (Some(cap), Some(master)) = (scope.cap, scope.master.as_ref()) else {
        return Ok(());
    };
    if !scope.metered || ai.config().billing != BillingMode::Credits {
        return Ok(());
    }
    let already = charged_this_run(master, &call.workspace_id, &scope.execution_id)
        .await
        .map_err(|error| ActionError::plain(&error.to_string()))?;
    let estimated = estimate.await?;
    if already + estimated > cap {
        return Err(ActionError::fatal_with(
            &format!(
                "This workflow run's AI credit cap of {cap} would be exceeded by this {op} step \
                 (already used {already} credit(s) this run, this step could use up to \
                 {estimated} more)."
            ),
            json!({
                "code": "ai_credit_cap_exceeded",
                "cap": cap,
                "alreadyCharged": already,
                "estimatedCredits": estimated,
            }),
        ));
    }
    Ok(())
}

/// The AI SDK's `usage` (`LanguageModelUsage`) as an OpenAI-compatible
/// answer fills it: tokens in, out and in all, with the details it knows
/// (no cache or reasoning counts).
fn usage_json(usage: Usage) -> Value {
    json!({
        "inputTokens": usage.input_tokens,
        "inputTokenDetails": { "noCacheTokens": usage.input_tokens },
        "outputTokens": usage.output_tokens,
        "outputTokenDetails": { "textTokens": usage.output_tokens },
        "totalTokens": usage.input_tokens + usage.output_tokens,
    })
}

/// The AI SDK's check of `maxOutputTokens` (`prepareCallSettings`): a whole
/// number of at least 1, or `AI_InvalidArgumentError`.
fn max_output_tokens(raw: Option<f64>) -> Result<Option<u32>, ActionError> {
    let Some(max) = raw else {
        return Ok(None);
    };
    let refuse = |message: &str| {
        Err(ActionError::named(
            "AI_InvalidArgumentError",
            &format!("Invalid argument for parameter maxOutputTokens: {message}"),
        ))
    };
    if !max.is_finite() || max.fract() != 0.0 {
        return refuse("maxOutputTokens must be an integer");
    }
    if max < 1.0 {
        return refuse("maxOutputTokens must be >= 1");
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let max = max.min(f64::from(u32::MAX)) as u32;
    Ok(Some(max))
}

/// `inputs.model ? asText(inputs.model) : <default>`: the step's own model.
fn step_model(inputs: &Map<String, Value>) -> Option<String> {
    Some(text_or(&[inputs.get("model")], "")).filter(|model| !model.is_empty())
}

/// `ai_generate`'s inputs.
#[derive(Debug, Clone, PartialEq)]
struct GenerateInput {
    prompt: String,
    system: Option<String>,
    model: Option<String>,
    temperature: Option<f32>,
    /// `Number(maxTokens ?? max_tokens)`, checked when the model is called.
    max_tokens: Option<f64>,
}

impl GenerateInput {
    fn read(inputs: &Map<String, Value>) -> Result<Self, ActionError> {
        let prompt = text_or(&[inputs.get("prompt")], "");
        if prompt.is_empty() {
            return Err(ActionError::plain("Prompt is required"));
        }
        let system = coalesce(&[inputs.get("systemPrompt"), inputs.get("system")])
            .map(|value| as_text(Some(value)))
            .filter(|system| !system.is_empty());
        #[allow(clippy::cast_possible_truncation)]
        let temperature = inputs
            .get("temperature")
            .map(|value| js_number(Some(value)))
            .filter(|t| t.is_finite())
            .map(|t| t as f32);
        let max_tokens = coalesce(&[inputs.get("maxTokens"), inputs.get("max_tokens")])
            .map(|value| js_number(Some(value)));
        Ok(Self {
            prompt,
            system,
            model: step_model(inputs),
            temperature,
            max_tokens,
        })
    }

    /// The token limit the cap's estimate assumes: the step's, when usable.
    fn estimated_output(&self) -> Option<u32> {
        max_output_tokens(self.max_tokens).ok().flatten()
    }

    fn request(&self) -> Result<ChatRequest, ActionError> {
        let mut request = ChatRequest {
            system: self.system.clone(),
            messages: vec![Message::user(self.prompt.clone())],
            ..ChatRequest::default()
        };
        if let Some(temperature) = self.temperature {
            request = request.temperature(temperature);
        }
        if let Some(max) = max_output_tokens(self.max_tokens)? {
            request = request.max_tokens(max);
        }
        Ok(request)
    }
}

/// `ai_classify`'s inputs.
#[derive(Debug, Clone, PartialEq)]
struct ClassifyInput {
    text: String,
    categories: Vec<Value>,
    model: Option<String>,
}

impl ClassifyInput {
    fn read(inputs: &Map<String, Value>) -> Result<Self, ActionError> {
        let text = text_or(&[inputs.get("text"), inputs.get("input")], "");
        let categories = coalesce(&[inputs.get("categories"), inputs.get("labels")]);
        if text.is_empty() {
            return Err(ActionError::plain("Text input is required"));
        }
        let categories = match categories {
            Some(Value::Array(items)) if !items.is_empty() => items.clone(),
            _ => return Err(ActionError::plain("Categories array is required")),
        };
        Ok(Self {
            text,
            categories,
            model: step_model(inputs),
        })
    }

    /// `categories.join(', ')`.
    fn joined(&self) -> String {
        self.categories
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The answer's schema: one of the categories, a confidence and a reason.
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "category": { "type": "string", "enum": self.categories },
                "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                "reasoning": { "type": "string" },
            },
            "required": ["category"],
            "additionalProperties": false,
        })
    }

    fn request(&self) -> ChatRequest {
        ChatRequest::system_user(
            CLASSIFY_SYSTEM,
            format!("Categories: {}.\n\nText:\n{}", self.joined(), self.text),
        )
        .schema("classification", self.schema())
    }
}

/// `handleAiGenerate(inputs, ctx)`.
pub(super) async fn generate(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let input = GenerateInput::read(inputs)?;
    let ai = available(ctx.deps.ai.as_ref())?;
    let scope = Scope::of(ctx).await;
    run_generate(ai, &scope, &input).await
}

/// `handleAiClassify(inputs, ctx)`.
pub(super) async fn classify(inputs: &Map<String, Value>, ctx: &ActionCtx<'_>) -> ActionResult {
    let input = ClassifyInput::read(inputs)?;
    let ai = available(ctx.deps.ai.as_ref())?;
    let scope = Scope::of(ctx).await;
    run_classify(ai, &scope, &input).await
}

/// What one step's call is: its `AiCall`, ledger op, the text the cap's
/// estimate counts and the output it assumes.
struct Planned<'a> {
    call: AiCall,
    op: &'a str,
    estimate_input: String,
    max_output: Option<u32>,
    default_output: i64,
}

/// The gate, the cap, then the call (`request` is built last: the AI SDK
/// checks its settings inside the call).
async fn call_model(
    ai: &Ai,
    scope: &Scope,
    planned: &Planned<'_>,
    request: impl FnOnce() -> Result<ChatRequest, ActionError>,
) -> Result<ChatResponse, ActionError> {
    let call = &planned.call;
    ai.assert_credits(call).await.map_err(failure)?;
    assert_within_cap(
        ai,
        scope,
        call,
        planned.op,
        estimate_max_credits(
            ai,
            call,
            &planned.estimate_input,
            planned.max_output,
            planned.default_output,
        ),
    )
    .await?;
    ai.chat(call, request()?).await.map_err(failure)
}

async fn run_generate(ai: &Ai, scope: &Scope, input: &GenerateInput) -> ActionResult {
    let planned = Planned {
        call: scope.call(Task::Draft, OP_GENERATE, input.model.as_deref()),
        op: OP_GENERATE,
        estimate_input: format!(
            "{}\n{}",
            input.system.as_deref().unwrap_or(""),
            input.prompt
        ),
        max_output: input.estimated_output(),
        default_output: GENERATE_OUTPUT_TOKENS_ESTIMATE,
    };
    let answer = call_model(ai, scope, &planned, || input.request()).await?;
    Ok(json!({
        "text": answer.text,
        "model": answer.served.model,
        "finishReason": answer.finish_reason,
        "usage": usage_json(answer.usage),
        "creditsUsed": answer.credits,
    }))
}

async fn run_classify(ai: &Ai, scope: &Scope, input: &ClassifyInput) -> ActionResult {
    let planned = Planned {
        call: scope.call(Task::Classify, OP_CLASSIFY, input.model.as_deref()),
        op: OP_CLASSIFY,
        estimate_input: format!("{}\n{}", input.text, input.joined()),
        max_output: None,
        default_output: CLASSIFY_OUTPUT_TOKENS_ESTIMATE,
    };
    let answer = call_model(ai, scope, &planned, || Ok(input.request())).await?;
    let object = answer.object.unwrap_or(Value::Null);
    let mut result = Map::new();
    // `result.object.category`: left out only when the answer has none.
    if let Some(category) = object.get("category") {
        result.insert("category".into(), category.clone());
    }
    result.insert(
        "confidence".into(),
        object
            .get("confidence")
            .filter(|c| !c.is_null())
            .cloned()
            .unwrap_or(Value::Null),
    );
    result.insert(
        "reasoning".into(),
        object
            .get("reasoning")
            .filter(|r| !r.is_null())
            .cloned()
            .unwrap_or_else(|| json!("")),
    );
    result.insert("model".into(), json!(answer.served.model));
    result.insert("usage".into(), usage_json(answer.usage));
    result.insert("creditsUsed".into(), json!(answer.credits));
    Ok(Value::Object(result))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use weldsuite_ai::{AiConfig, FakeProvider};

    fn ai(fake: &FakeProvider) -> Ai {
        let mut problems = Vec::new();
        let config = AiConfig::from_lookup(
            &|name: &str| match name {
                "AI_DEFAULT_PROVIDER" => Some("mistral".to_owned()),
                "MISTRAL_API_KEY" => Some("mistral-key".to_owned()),
                _ => None,
            },
            &mut problems,
        );
        assert!(problems.is_empty(), "{problems:?}");
        Ai::fake(config, fake.clone())
    }

    /// A run without databases: the install's defaults, unmetered.
    fn scope() -> Scope {
        Scope {
            tenant: None,
            master: None,
            workspace_id: "org_test".to_owned(),
            metered: false,
            user_id: Some("user_owner".to_owned()),
            execution_id: "wex_1".to_owned(),
            step_id: "step_1".to_owned(),
            cap: Some(1),
        }
    }

    #[test]
    fn books_the_charge_against_the_step_once() {
        let call = scope().call(Task::Draft, OP_GENERATE, None);
        assert_eq!(
            call.ledger,
            Some(LedgerTag {
                reference_type: STEP_REFERENCE_TYPE.to_owned(),
                idempotency_key: Some("wf:wex_1:step_1:ai_generate".to_owned()),
                label: "Workflow AI".to_owned(),
            })
        );
        assert_eq!(call.reference_id.as_deref(), Some("wex_1"));
    }

    fn inputs(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn generate_needs_a_prompt_before_anything_else() {
        let error = GenerateInput::read(&inputs(&json!({ "prompt": "" }))).unwrap_err();
        assert_eq!(error, ActionError::plain("Prompt is required"));
        let input = GenerateInput::read(&inputs(&json!({
            "prompt": "Summarise {{trigger.text}}",
            "system": "Be brief",
            "model": "anthropic/claude-sonnet-5-5",
            "temperature": "0.2",
            "max_tokens": 200,
        })))
        .unwrap();
        assert_eq!(input.system.as_deref(), Some("Be brief"));
        assert_eq!(input.model.as_deref(), Some("anthropic/claude-sonnet-5-5"));
        assert_eq!(input.temperature, Some(0.2));
        assert_eq!(input.estimated_output(), Some(200));
        assert_eq!(input.request().unwrap().max_tokens, Some(200));
    }

    #[tokio::test]
    async fn a_bad_token_limit_fails_when_the_model_is_called() {
        let fake = FakeProvider::new();
        let ai = ai(&fake);
        for (raw, message) in [
            (json!("lots"), "maxOutputTokens must be an integer"),
            (json!(12.5), "maxOutputTokens must be an integer"),
            (json!(0), "maxOutputTokens must be >= 1"),
        ] {
            let input =
                GenerateInput::read(&inputs(&json!({ "prompt": "x", "maxTokens": raw }))).unwrap();
            let refused = run_generate(&ai, &scope(), &input).await.unwrap_err();
            assert_eq!(refused.name, "AI_InvalidArgumentError");
            assert_eq!(
                refused.message,
                format!("Invalid argument for parameter maxOutputTokens: {message}")
            );
        }
        assert!(fake.calls().is_empty());
    }

    #[test]
    fn classify_needs_text_and_categories() {
        let no_text = ClassifyInput::read(&inputs(&json!({ "categories": ["a"] }))).unwrap_err();
        assert_eq!(no_text, ActionError::plain("Text input is required"));
        let no_categories =
            ClassifyInput::read(&inputs(&json!({ "input": "hi", "labels": [] }))).unwrap_err();
        assert_eq!(
            no_categories,
            ActionError::plain("Categories array is required")
        );
        let not_a_list =
            ClassifyInput::read(&inputs(&json!({ "text": "hi", "categories": "a,b" })))
                .unwrap_err();
        assert_eq!(
            not_a_list,
            ActionError::plain("Categories array is required")
        );
    }

    #[test]
    fn without_a_provider_the_steps_fail_as_the_worker_without_its_gateway() {
        let error = available(None).unwrap_err();
        assert_eq!(error.name, "GatewayConfigError");
        assert!(!error.non_retryable);
        assert_eq!(error.message, crate::generate::NOT_CONFIGURED);
    }

    #[tokio::test]
    async fn generate_answers_the_text_on_the_draft_model() {
        let fake = FakeProvider::new().reply_text("Hello there");
        let ai = ai(&fake);
        let input = GenerateInput::read(&inputs(&json!({
            "prompt": "Say hello",
            "systemPrompt": "You are terse",
            "temperature": 0.5,
            "maxTokens": 64,
        })))
        .unwrap();
        let result = run_generate(&ai, &scope(), &input).await.unwrap();
        assert_eq!(result["text"], "Hello there");
        assert_eq!(result["finishReason"], "stop");
        assert_eq!(result["creditsUsed"], 0);
        assert_eq!(
            result["usage"],
            json!({
                "inputTokens": 12,
                "inputTokenDetails": { "noCacheTokens": 12 },
                "outputTokens": 8,
                "outputTokenDetails": { "textTokens": 8 },
                "totalTokens": 20,
            })
        );
        let model = result["model"].as_str().unwrap();
        assert!(model.starts_with("mistral/"), "{model}");

        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
        let body = &calls[0].body;
        assert_eq!(
            format!("mistral/{}", body["model"].as_str().unwrap()),
            model
        );
        assert_eq!(body["max_tokens"], 64);
        assert_eq!(body["temperature"], 0.5);
        assert_eq!(
            body["messages"][0],
            json!({ "role": "system", "content": "You are terse" })
        );
        assert_eq!(body["messages"][1]["content"], "Say hello");
    }

    #[tokio::test]
    async fn a_step_model_the_policy_refuses_is_skipped_for_the_feature_default() {
        let fake = FakeProvider::new().reply_text("ok");
        let ai = ai(&fake);
        // Claude isn't enabled for the workspace (no settings: the install's defaults).
        let input = GenerateInput::read(&inputs(&json!({
            "prompt": "Say hello",
            "model": "anthropic/claude-sonnet-5-5",
        })))
        .unwrap();
        let result = run_generate(&ai, &scope(), &input).await.unwrap();
        assert!(result["model"].as_str().unwrap().starts_with("mistral/"));
        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
        assert!(!calls[0].url.contains("anthropic"));
    }

    #[tokio::test]
    async fn classify_asks_for_one_of_the_categories() {
        let fake = FakeProvider::new().reply_json(&json!({
            "category": "billing",
            "confidence": 0.9,
            "reasoning": "Mentions an invoice",
        }));
        let ai = ai(&fake);
        let input = ClassifyInput::read(&inputs(&json!({
            "text": "Where is my invoice?",
            "categories": ["billing", "support", null],
        })))
        .unwrap();
        let result = run_classify(&ai, &scope(), &input).await.unwrap();
        assert_eq!(result["category"], "billing");
        assert_eq!(result["confidence"], 0.9);
        assert_eq!(result["reasoning"], "Mentions an invoice");
        assert_eq!(result["creditsUsed"], 0);
        assert!(
            result["model"]
                .as_str()
                .unwrap()
                .starts_with("mistral/mistral-small")
        );

        let body = &fake.calls()[0].body;
        assert_eq!(body["messages"][0]["content"], CLASSIFY_SYSTEM);
        assert_eq!(
            body["messages"][1]["content"],
            "Categories: billing, support, .\n\nText:\nWhere is my invoice?"
        );
        assert_eq!(
            body["response_format"]["json_schema"]["schema"]["properties"]["category"]["enum"],
            json!(["billing", "support", null])
        );
    }

    #[tokio::test]
    async fn a_classification_without_extras_gets_the_worker_defaults() {
        let fake = FakeProvider::new().reply_json(&json!({ "category": "support" }));
        let ai = ai(&fake);
        let input = ClassifyInput::read(&inputs(
            &json!({ "text": "Help", "categories": ["support"] }),
        ))
        .unwrap();
        let result = run_classify(&ai, &scope(), &input).await.unwrap();
        assert_eq!(result["confidence"], Value::Null);
        assert_eq!(result["reasoning"], "");
    }

    #[tokio::test]
    async fn a_provider_failure_is_retried_by_the_engine() {
        let fake = FakeProvider::new().reply_status(400, r#"{"message":"bad request"}"#);
        let ai = ai(&fake);
        let input = GenerateInput::read(&inputs(&json!({ "prompt": "x" }))).unwrap();
        let error = run_generate(&ai, &scope(), &input).await.unwrap_err();
        assert_eq!(error.name, "AI_APICallError");
        assert_eq!(error.message, "bad request");
        assert!(!error.non_retryable);
    }

    #[test]
    fn errors_are_the_workers() {
        let broke = failure(AiError::InsufficientCredits {
            balance: 0,
            required: 1,
        });
        assert_eq!(broke.name, "AiInsufficientCreditsError");
        assert_eq!(
            broke.message,
            "Insufficient AI credits for this workflow step (balance 0, need 1)"
        );
        assert!(!broke.non_retryable);
        assert_eq!(failure(AiError::Unavailable).name, "GatewayConfigError");
    }

    #[test]
    fn the_estimate_counts_javascript_characters() {
        assert_eq!(estimate_tokens(""), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        // One astral character is two UTF-16 units.
        assert_eq!(estimate_tokens("😀😀😀"), 2);
    }
}
