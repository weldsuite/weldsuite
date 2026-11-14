//! Mail AI (`apps/workers/mail-api/src/services/mail/ai.ts`): drafts,
//! replies, rewrites, smart replies, the inbox summary and labels, on
//! `weldsuite-ai` (feature `mail`, ADR AI-012) where Global calls
//! `@weldsuite/ai` through the Cloudflare AI Gateway.
//!
//! Each operation loads its context behind the per-account gate (the rule in
//! `@weldsuite/mail-domain/access`) before any model call or credit check,
//! and sends the TypeScript prompts, schemas and post-processing word for
//! word. It asks for a task and tier, never a model (`MODEL_DEFAULTS`):
//!
//! - the writing (draft, improve text, auto-draft, reply): `draft` /
//!   `quality`, where Global defaults to Claude Sonnet;
//! - smart replies `draft` / `free`, the inbox summary `summarize` / `free`,
//!   labels `classify` / `free` (`recommended.*.free`).
//!
//! A client's `modelId` goes through the workspace policy (422
//! `AI_MODEL_NOT_ALLOWED` when it is refused); the account's
//! `aiSettings.modelPreference` is used when the policy allows it and
//! skipped otherwise. Each call is charged under its route's `op`
//! (`chargeAiUsage`); the classification write-back goes through the
//! `postgres` mailbox store's `categories` op, the only store here
//! (MAIL-010).

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use weldsuite_ai::{Ai, AiCall, AiError, ChatRequest, ChatResponse, Feature, Task, Tier};
use weldsuite_db::{PgPool, js_row};
use weldsuite_mail_domain::access::{accessible_account_ids, check_account_access};
use weldsuite_mail_domain::text::{js_trim, utf16_prefix};

/// `'Access to this mail account is not allowed'`.
pub(crate) const NO_ACCESS: &str = "Access to this mail account is not allowed";
/// The batch's refusal.
pub(crate) const NO_ACCESS_SOME: &str = "Access to one or more mail accounts is not allowed";

/// `CLASSIFY_CATEGORIES`.
pub(crate) const CLASSIFY_CATEGORIES: [&str; 8] = [
    "sales",
    "support",
    "billing",
    "personal",
    "newsletter",
    "notification",
    "spam",
    "other",
];
/// `PRIORITIES`.
pub(crate) const PRIORITIES: [&str; 3] = ["high", "normal", "low"];

/// What an operation can end with besides its answer (`MailAiError`, and
/// the errors `handleError` maps).
#[derive(Debug)]
pub(crate) enum MailAiError {
    /// 403 `forbidden`.
    Forbidden(&'static str),
    /// 404 `message_not_found`.
    MessageNotFound(&'static str),
    /// 404 `account_not_found`.
    AccountNotFound,
    /// The AI layer: 503 without a model, 422, 402, 502.
    Ai(AiError),
    /// Anything else: 500 `internal_error`, "AI request failed".
    Internal(String),
}

impl From<sqlx::Error> for MailAiError {
    fn from(error: sqlx::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

impl From<AiError> for MailAiError {
    fn from(error: AiError) -> Self {
        Self::Ai(error)
    }
}

pub(crate) type MailAiResult<T> = Result<T, MailAiError>;

/// `MailAiOp`: which route asked, for its task, tier and ledger `op`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Op {
    Draft,
    ImproveText,
    AutoDraft,
    Reply,
    SmartReplies,
    InboxSummary,
    Label,
    LabelBatch,
}

impl Op {
    /// `MODEL_DEFAULTS[op]` as a task and tier: Claude Sonnet for the
    /// writing is the quality draft tier; `recommended.<task>.free` the rest.
    pub(crate) fn task_tier(self) -> (Task, Tier) {
        match self {
            Self::Draft | Self::ImproveText | Self::AutoDraft | Self::Reply => {
                (Task::Draft, Tier::Quality)
            }
            Self::SmartReplies => (Task::Draft, Tier::Free),
            Self::InboxSummary => (Task::Summarize, Tier::Free),
            Self::Label | Self::LabelBatch => (Task::Classify, Tier::Free),
        }
    }

    /// The `op` each call is charged under (`classifyOne` charges `label`
    /// for a batch too).
    pub(crate) fn ledger_op(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::ImproveText => "improve-text",
            Self::AutoDraft => "auto-draft",
            Self::Reply => "reply",
            Self::SmartReplies => "smart-replies",
            Self::InboxSummary => "inbox-summary",
            Self::Label | Self::LabelBatch => "label",
        }
    }
}

/// One request's view: the caller, the tenant and master databases and the
/// AI it calls (`None`: AI off).
#[derive(Clone)]
pub(crate) struct MailAi {
    pub(crate) db: PgPool,
    pub(crate) user_id: String,
    pub(crate) workspace_id: String,
    pub(crate) master: Option<PgPool>,
    pub(crate) ai: Option<Ai>,
}

impl MailAi {
    /// `getAi(env)`: the model, or 503 `ai_unavailable`.
    fn ai(&self) -> MailAiResult<&Ai> {
        self.ai
            .as_ref()
            .ok_or(MailAiError::Ai(AiError::Unavailable))
    }

    /// The call for `op`: `pickModel(op, accountCtx, explicit)` as the policy
    /// sees it (an explicit `modelId` is a request; the account's
    /// `modelPreference` a stored choice).
    pub(crate) fn call(
        &self,
        op: Op,
        account: Option<&AccountContext>,
        model_id: Option<&str>,
    ) -> AiCall {
        op_call(&self.workspace_id, &self.user_id, op, account, model_id)
            .tenant(self.db.clone())
            .master(self.master.clone())
    }

    /// `assertAiCredits(metering)` once the model is known to exist.
    async fn ready(&self, call: &AiCall) -> MailAiResult<&Ai> {
        let ai = self.ai()?;
        ai.assert_credits(call).await?;
        Ok(ai)
    }
}

/// The call for `op` without its databases: feature `mail`, the op's task,
/// tier and ledger `op`, and `explicit || modelPreference` (a request's model
/// wins over the account's).
pub(crate) fn op_call(
    workspace_id: &str,
    user_id: &str,
    op: Op,
    account: Option<&AccountContext>,
    model_id: Option<&str>,
) -> AiCall {
    let (task, tier) = op.task_tier();
    let call = AiCall::new(workspace_id, Feature::Mail, task, tier)
        .user(user_id)
        .op(op.ledger_op());
    match model_id.filter(|m| !m.trim().is_empty()) {
        Some(model) => call.requested_model(Some(model)),
        None => call.stored_model(account.and_then(AccountContext::model_preference)),
    }
}

// ---------------------------------------------------------------------------
// Per-account access
// ---------------------------------------------------------------------------

/// `accountGate(db, userId, message)`: the access check for one request,
/// memoised by account.
pub(crate) struct AccountGate {
    message: &'static str,
    checked: HashMap<String, bool>,
}

impl AccountGate {
    pub(crate) fn new(message: &'static str) -> Self {
        Self {
            message,
            checked: HashMap::new(),
        }
    }

    pub(crate) async fn check(&mut self, cx: &MailAi, account_id: &str) -> MailAiResult<()> {
        let allowed = if let Some(allowed) = self.checked.get(account_id) {
            *allowed
        } else {
            let allowed = check_account_access(&cx.db, account_id, &cx.user_id).await?;
            self.checked.insert(account_id.to_owned(), allowed);
            allowed
        };
        if allowed {
            Ok(())
        } else {
            Err(MailAiError::Forbidden(self.message))
        }
    }
}

// ---------------------------------------------------------------------------
// Context loaders
// ---------------------------------------------------------------------------

/// `AccountContext`: the account's `aiSettings` and display name.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct AccountContext {
    /// `aiSettings` (`null` when unset).
    pub(crate) ai_settings: Value,
    pub(crate) display_name: Option<String>,
}

impl AccountContext {
    /// `aiSettings?.<key>` as text, when it is a string.
    fn setting(&self, key: &str) -> Option<&str> {
        self.ai_settings.get(key).and_then(Value::as_str)
    }

    /// A setting that is set at all (`?? ` keeps any non-null value).
    fn setting_set(&self, key: &str) -> bool {
        self.ai_settings.get(key).is_some_and(|v| !v.is_null())
    }

    /// `aiSettings.modelPreference`, when non-empty.
    pub(crate) fn model_preference(&self) -> Option<&str> {
        self.setting("modelPreference").filter(|m| !m.is_empty())
    }

    fn default_tone(&self) -> Option<&str> {
        self.setting_set("defaultTone")
            .then(|| self.setting("defaultTone").unwrap_or_default())
    }

    fn default_length(&self) -> Option<&str> {
        self.setting_set("defaultLength")
            .then(|| self.setting("defaultLength").unwrap_or_default())
    }
}

/// `loadAccountContext(db, accountId)`: a live account's AI settings.
pub(crate) async fn load_account_context(
    db: &PgPool,
    account_id: &str,
) -> Result<Option<AccountContext>, sqlx::Error> {
    let row: Option<(Option<Value>, Option<String>)> = sqlx::query_as(
        "select ai_settings, display_name from mail_accounts
         where id = $1 and deleted_at is null limit 1",
    )
    .bind(account_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(ai_settings, display_name)| AccountContext {
        ai_settings: ai_settings.unwrap_or(Value::Null),
        display_name,
    }))
}

/// `loadMessage(db, messageId)`: a live message row, camelCased.
async fn load_message(db: &PgPool, message_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(m) from mail_messages m
         where m.id = $1 and m.deleted_at is null limit 1",
    )
    .bind(message_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(js_row))
}

/// `loadAccessibleMessage`: a message from a mailbox the caller may open;
/// `None` when it does not exist, 403 when the mailbox is not theirs.
async fn load_accessible_message(
    cx: &MailAi,
    gate: &mut AccountGate,
    message_id: &str,
) -> MailAiResult<Option<Value>> {
    let Some(message) = load_message(&cx.db, message_id).await? else {
        return Ok(None);
    };
    let account = message["accountId"].as_str().unwrap_or_default().to_owned();
    gate.check(cx, &account).await?;
    Ok(Some(message))
}

/// `loadRecentMessages(db, accountIds, limit)`: recent live, non-trash
/// messages of the accounts already checked; none for no accounts.
async fn load_recent_messages(
    db: &PgPool,
    account_ids: &[String],
    limit: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    if account_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<Value> = sqlx::query_scalar(
        "select jsonb_build_object(
                'id', id, 'subject', subject, 'from', \"from\", 'preview', preview,
                'isRead', is_read)
         from mail_messages
         where deleted_at is null and is_trash = false and account_id = any($1::text[])
         order by sent_date desc
         limit $2",
    )
    .bind(account_ids)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

/// A value in a template literal: `value ?? fallback`.
fn js_text(value: Option<&Value>, fallback: &str) -> String {
    match value {
        None | Some(Value::Null) => fallback.to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// `a || b || ''` over string fields.
fn first_truthy<'a>(values: &[&'a Value]) -> &'a str {
    values
        .iter()
        .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
        .unwrap_or_default()
}

/// `baseSystem(accountCtx, role)`.
pub(crate) fn base_system(account: Option<&AccountContext>, role: &str) -> String {
    let mut parts = vec![role.to_owned()];
    if let Some(name) = account
        .and_then(|a| a.display_name.as_deref())
        .filter(|n| !n.is_empty())
    {
        parts.push(format!("You are writing on behalf of {name}."));
    }
    if let Some(instructions) = account
        .and_then(|a| a.setting("customInstructions"))
        .filter(|i| !i.is_empty())
    {
        parts.push(format!("Always follow these instructions: {instructions}"));
    }
    parts.push(
        "Write plain text only — no markdown, and no preamble like \"Here is your email\"."
            .to_owned(),
    );
    parts.join("\n")
}

/// `toneLine(tone)`.
pub(crate) fn tone_line(tone: Option<&str>) -> &'static str {
    match tone {
        Some("friendly") => "Tone: warm and friendly.",
        Some("casual") => "Tone: casual and conversational.",
        Some("brief") => "Tone: brief and direct.",
        _ => "Tone: professional and polished.",
    }
}

/// `lengthLine(length)`.
pub(crate) fn length_line(length: Option<&str>) -> &'static str {
    match length {
        Some("short") => "Length: 1–2 short paragraphs.",
        Some("long") => "Length: thorough and detailed.",
        _ => "Length: a few concise paragraphs.",
    }
}

/// `messageContext(m)`.
pub(crate) fn message_context(message: &Value) -> String {
    let from = &message["from"];
    let from_name = js_text(from.get("name"), "");
    let from_email = js_text(from.get("email"), "");
    let body = first_truthy(&[&message["textBody"], &message["preview"]]);
    let body = utf16_prefix(body, 6000);
    let subject = js_text(message.get("subject"), "(no subject)");
    format!("From: {from_name} <{from_email}>\nSubject: {subject}\n\n{body}")
}

/// `[...].filter(Boolean).join('\n')`.
fn lines(parts: &[&str]) -> String {
    parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
}

/// `emailSchema`.
pub(crate) fn email_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "subject": { "type": "string" }, "body": { "type": "string" } },
        "required": ["subject", "body"],
        "additionalProperties": false,
    })
}

/// `repliesSchema`.
pub(crate) fn replies_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "replies": { "type": "array", "items": { "type": "string" }, "maxItems": 3 } },
        "required": ["replies"],
        "additionalProperties": false,
    })
}

/// `classifySchema`.
pub(crate) fn classify_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "category": { "type": "string", "enum": CLASSIFY_CATEGORIES },
            "priority": { "type": "string", "enum": PRIORITIES },
        },
        "required": ["category", "priority"],
        "additionalProperties": false,
    })
}

/// The fields `keys` of a structured answer, as the TypeScript object
/// literal copies them (a key the model left out stays out).
fn pick(object: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = object.get(*key) {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    Value::Object(out)
}

/// `generateObject(...)`: the parsed answer (502 when it isn't JSON).
async fn object_call(
    ai: &Ai,
    call: &AiCall,
    request: ChatRequest,
) -> MailAiResult<(Value, ChatResponse)> {
    let response = ai.chat(call, request).await?;
    let object = response.object.clone().ok_or_else(|| {
        AiError::Invalid("the model's answer isn't the JSON its schema asks for".to_owned())
    })?;
    Ok((object, response))
}

/// `meteredText(...)`: the trimmed answer.
async fn text_call(
    ai: &Ai,
    call: &AiCall,
    system: String,
    prompt: String,
) -> MailAiResult<(String, ChatResponse)> {
    let response = ai
        .chat(call, ChatRequest::system_user(system, prompt))
        .await?;
    Ok((js_trim(&response.text).to_owned(), response))
}

/// What an operation answers: its `data`, and who served it (`meta.ai`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Answer {
    pub(crate) data: Value,
    pub(crate) served: Option<Value>,
}

impl Answer {
    fn new(data: Value, response: &ChatResponse) -> Self {
        Self {
            data,
            served: Some(response.served.meta()),
        }
    }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/// `DraftInput`.
#[derive(Debug, Clone, Default)]
pub(crate) struct DraftInput {
    pub(crate) prompt: String,
    pub(crate) reply_to_message_id: Option<String>,
    pub(crate) account_id: Option<String>,
    pub(crate) tone: Option<String>,
    pub(crate) length: Option<String>,
    pub(crate) model_id: Option<String>,
}

fn truthy(value: Option<&String>) -> Option<&str> {
    value.map(String::as_str).filter(|v| !v.is_empty())
}

/// `draftEmail`: `{ subject, body }`.
pub(crate) async fn draft_email(cx: &MailAi, input: &DraftInput) -> MailAiResult<Answer> {
    let mut gate = AccountGate::new(NO_ACCESS);
    let account_id = truthy(input.account_id.as_ref());
    if let Some(account) = account_id {
        gate.check(cx, account).await?;
    }
    let account = match account_id {
        Some(account) => load_account_context(&cx.db, account).await?,
        None => None,
    };
    let reply_to = match truthy(input.reply_to_message_id.as_ref()) {
        Some(id) => {
            let message = load_accessible_message(cx, &mut gate, id).await?;
            if message.is_none() {
                return Err(MailAiError::MessageNotFound("Original message not found"));
            }
            message
        }
        None => None,
    };
    let call = cx.call(Op::Draft, account.as_ref(), input.model_id.as_deref());
    let ai = cx.ready(&call).await?;
    let tone = input
        .tone
        .as_deref()
        .or_else(|| account.as_ref().and_then(AccountContext::default_tone));
    let length = input
        .length
        .as_deref()
        .or_else(|| account.as_ref().and_then(AccountContext::default_length));
    let request = draft_request(
        account.as_ref(),
        reply_to.as_ref(),
        &input.prompt,
        tone,
        length,
    );
    let (object, response) = object_call(ai, &call, request).await?;
    Ok(Answer::new(pick(&object, &["subject", "body"]), &response))
}

/// The model request `draftEmail` sends.
pub(crate) fn draft_request(
    account: Option<&AccountContext>,
    reply_to: Option<&Value>,
    prompt: &str,
    tone: Option<&str>,
    length: Option<&str>,
) -> ChatRequest {
    let reply = reply_to.map(|m| {
        format!(
            "You are drafting a reply to this email:\n\n{}\n",
            message_context(m)
        )
    });
    let ask = format!("Write an email that: {prompt}");
    ChatRequest::system_user(
        base_system(
            account,
            "You are an expert email-writing assistant. Write a complete, ready-to-send email.",
        ),
        lines(&[
            tone_line(tone),
            length_line(length),
            reply.as_deref().unwrap_or_default(),
            &ask,
            "Return a concise subject line and the email body.",
        ]),
    )
    .schema("email", email_schema())
}

/// `ImproveTextInput`.
#[derive(Debug, Clone, Default)]
pub(crate) struct ImproveTextInput {
    pub(crate) text: String,
    pub(crate) action: String,
    pub(crate) account_id: Option<String>,
    pub(crate) model_id: Option<String>,
}

/// `IMPROVE_INSTRUCTIONS[action]`.
pub(crate) fn improve_instruction(action: &str) -> &'static str {
    match action {
        "shorten" => "Make the text more concise without losing its key points.",
        "expand" => "Expand the text with more detail and helpful context.",
        "formalize" => "Rewrite the text in a more formal, professional tone.",
        "make_friendly" => "Rewrite the text in a warmer, friendlier tone.",
        _ => {
            "Improve the clarity, grammar, and flow of the text while preserving its meaning and intent."
        }
    }
}

/// `improveText`: `{ text }`.
pub(crate) async fn improve_text(cx: &MailAi, input: &ImproveTextInput) -> MailAiResult<Answer> {
    let account_id = truthy(input.account_id.as_ref());
    if let Some(account) = account_id {
        AccountGate::new(NO_ACCESS).check(cx, account).await?;
    }
    let account = match account_id {
        Some(account) => load_account_context(&cx.db, account).await?,
        None => None,
    };
    let call = cx.call(Op::ImproveText, account.as_ref(), input.model_id.as_deref());
    let ai = cx.ready(&call).await?;
    let (text, response) = text_call(
        ai,
        &call,
        base_system(
            account.as_ref(),
            "You are an expert editor for email. Return only the rewritten text.",
        ),
        format!(
            "{}\n\nText:\n{}",
            improve_instruction(&input.action),
            input.text
        ),
    )
    .await?;
    Ok(Answer::new(json!({ "text": text }), &response))
}

/// `AutoDraftInput`.
#[derive(Debug, Clone, Default)]
pub(crate) struct AutoDraftInput {
    pub(crate) account_id: String,
    pub(crate) message_id: Option<String>,
    pub(crate) prompt: Option<String>,
    pub(crate) recent_message_ids: Option<Vec<String>>,
    pub(crate) model_id: Option<String>,
}

/// `loadRecentContext`: the caller's message ids, each checked (they need
/// not be the account's), else the account's eight newest.
async fn load_recent_context(
    cx: &MailAi,
    gate: &mut AccountGate,
    input: &AutoDraftInput,
) -> MailAiResult<Vec<Value>> {
    if let Some(ids) = input
        .recent_message_ids
        .as_ref()
        .filter(|ids| !ids.is_empty())
    {
        let mut out = Vec::new();
        for id in ids.iter().take(20) {
            if let Some(message) = load_accessible_message(cx, gate, id).await? {
                out.push(message);
            }
        }
        return Ok(out);
    }
    Ok(load_recent_messages(&cx.db, std::slice::from_ref(&input.account_id), 8).await?)
}

/// `autoDraft`: `{ subject, body }`.
pub(crate) async fn auto_draft(cx: &MailAi, input: &AutoDraftInput) -> MailAiResult<Answer> {
    let account = load_account_context(&cx.db, &input.account_id)
        .await?
        .ok_or(MailAiError::AccountNotFound)?;
    let mut gate = AccountGate::new(NO_ACCESS);
    gate.check(cx, &input.account_id).await?;
    let reply_to = match truthy(input.message_id.as_ref()) {
        Some(id) => load_accessible_message(cx, &mut gate, id).await?,
        None => None,
    };
    let recent = if reply_to.is_some() {
        Vec::new()
    } else {
        load_recent_context(cx, &mut gate, input).await?
    };
    let call = cx.call(Op::AutoDraft, Some(&account), input.model_id.as_deref());
    let ai = cx.ready(&call).await?;
    let request = auto_draft_request(
        &account,
        reply_to.as_ref(),
        &recent,
        input.prompt.as_deref(),
    );
    let (object, response) = object_call(ai, &call, request).await?;
    Ok(Answer::new(pick(&object, &["subject", "body"]), &response))
}

/// `- from: subject — preview` per message.
fn digest_line(message: &Value) -> String {
    format!(
        "- {}: {} — {}",
        js_text(message["from"].get("email"), ""),
        js_text(message.get("subject"), "(no subject)"),
        js_text(message.get("preview"), ""),
    )
}

/// The model request `autoDraft` sends.
pub(crate) fn auto_draft_request(
    account: &AccountContext,
    reply_to: Option<&Value>,
    recent: &[Value],
    prompt: Option<&str>,
) -> ChatRequest {
    let digest = recent
        .iter()
        .map(digest_line)
        .collect::<Vec<_>>()
        .join("\n");
    let intent = match prompt.filter(|p| !p.is_empty()) {
        Some(prompt) => format!("The user's intent: {prompt}"),
        None if reply_to.is_some() => "Write an appropriate reply.".to_owned(),
        None => "Suggest a helpful follow-up email based on the context.".to_owned(),
    };
    let role = if reply_to.is_some() {
        "You are an email-writing assistant. Draft a reply to the email below."
    } else {
        "You are an email-writing assistant. Draft a useful email the user is likely to want to send next."
    };
    let reply = reply_to.map(|m| format!("Reply to this email:\n\n{}\n", message_context(m)));
    let context = (!digest.is_empty()).then(|| format!("Recent inbox context:\n{digest}\n"));
    ChatRequest::system_user(
        base_system(Some(account), role),
        lines(&[
            tone_line(account.default_tone()),
            length_line(account.default_length()),
            reply.as_deref().unwrap_or_default(),
            context.as_deref().unwrap_or_default(),
            &intent,
            "Return a subject line and the email body.",
        ]),
    )
    .schema("email", email_schema())
}

/// `ReplyInput`.
#[derive(Debug, Clone, Default)]
pub(crate) struct ReplyInput {
    pub(crate) message_id: Option<String>,
    pub(crate) user_prompt: Option<String>,
    pub(crate) account_id: Option<String>,
    pub(crate) tone: Option<String>,
    pub(crate) model_id: Option<String>,
}

/// `replySuggestion`: `{ body }`.
pub(crate) async fn reply_suggestion(cx: &MailAi, input: &ReplyInput) -> MailAiResult<Answer> {
    let mut gate = AccountGate::new(NO_ACCESS);
    if let Some(account) = truthy(input.account_id.as_ref()) {
        gate.check(cx, account).await?;
    }
    let message = match truthy(input.message_id.as_ref()) {
        Some(id) => Some(
            load_accessible_message(cx, &mut gate, id)
                .await?
                .ok_or(MailAiError::MessageNotFound("Message not found"))?,
        ),
        None => None,
    };
    // `input.accountId ?? message?.accountId`.
    let account_for_context = input.account_id.clone().or_else(|| {
        message
            .as_ref()
            .and_then(|m| m["accountId"].as_str().map(str::to_owned))
    });
    let account = match account_for_context.filter(|a| !a.is_empty()) {
        Some(account) => load_account_context(&cx.db, &account).await?,
        None => None,
    };
    let call = cx.call(Op::Reply, account.as_ref(), input.model_id.as_deref());
    let ai = cx.ready(&call).await?;
    let (system, prompt) = reply_prompt(
        account.as_ref(),
        message.as_ref(),
        input.tone.as_deref(),
        input.user_prompt.as_deref(),
    );
    let (body, response) = text_call(ai, &call, system, prompt).await?;
    Ok(Answer::new(json!({ "body": body }), &response))
}

/// The system prompt and prompt `replySuggestion` sends.
pub(crate) fn reply_prompt(
    account: Option<&AccountContext>,
    message: Option<&Value>,
    tone: Option<&str>,
    user_prompt: Option<&str>,
) -> (String, String) {
    let tone = tone.or_else(|| account.and_then(AccountContext::default_tone));
    let reply = message.map(|m| format!("Reply to this email:\n\n{}\n", message_context(m)));
    let ask = match user_prompt.filter(|p| !p.is_empty()) {
        Some(prompt) => format!("The reply should: {prompt}"),
        None => "Write an appropriate reply.".to_owned(),
    };
    (
        base_system(
            account,
            "You are an email-writing assistant. Write a reply body only (no subject line).",
        ),
        lines(&[tone_line(tone), reply.as_deref().unwrap_or_default(), &ask]),
    )
}

/// The summary when there is nothing to summarise.
pub(crate) const NOTHING_TO_SUMMARISE: &str = "No recent messages to summarise.";

/// The inbox summary's system prompt.
pub(crate) const SUMMARY_SYSTEM: &str = "You summarise a user's email inbox. Be concise and actionable. Group by theme and call out anything urgent or awaiting a reply.";

/// `inboxSummary`: `{ summary }` over one mailbox or every one the caller
/// may open.
pub(crate) async fn inbox_summary(
    cx: &MailAi,
    account_id: Option<&str>,
    model_id: Option<&str>,
) -> MailAiResult<Answer> {
    let account_id = account_id.filter(|a| !a.is_empty());
    let account_ids = match account_id {
        Some(account) => {
            AccountGate::new(NO_ACCESS).check(cx, account).await?;
            vec![account.to_owned()]
        }
        None => accessible_account_ids(&cx.db, &cx.user_id).await?,
    };
    let account = match account_id {
        Some(account) => load_account_context(&cx.db, account).await?,
        None => None,
    };
    let recent = load_recent_messages(&cx.db, &account_ids, 20).await?;
    if recent.is_empty() {
        return Ok(Answer {
            data: json!({ "summary": NOTHING_TO_SUMMARISE }),
            served: None,
        });
    }
    let call = cx.call(Op::InboxSummary, account.as_ref(), model_id);
    let ai = cx.ready(&call).await?;
    let (summary, response) = text_call(
        ai,
        &call,
        SUMMARY_SYSTEM.to_owned(),
        summary_prompt(&recent),
    )
    .await?;
    Ok(Answer::new(json!({ "summary": summary }), &response))
}

/// `Summarise these recent emails:` and the numbered digest.
pub(crate) fn summary_prompt(recent: &[Value]) -> String {
    let digest = recent
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let unread = if m["isRead"].as_bool() == Some(true) {
                ""
            } else {
                "[unread] "
            };
            format!(
                "{}. {unread}{}: {} — {}",
                i + 1,
                js_text(m["from"].get("email"), ""),
                js_text(m.get("subject"), "(no subject)"),
                js_text(m.get("preview"), ""),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("Summarise these recent emails:\n\n{digest}")
}

/// `smartReplies`: `{ replies }`, at most three.
pub(crate) async fn smart_replies(
    cx: &MailAi,
    message_id: &str,
    model_id: Option<&str>,
) -> MailAiResult<Answer> {
    let message = load_accessible_message(cx, &mut AccountGate::new(NO_ACCESS), message_id)
        .await?
        .ok_or(MailAiError::MessageNotFound("Message not found"))?;
    let account = message_account(cx, &message).await?;
    let call = cx.call(Op::SmartReplies, account.as_ref(), model_id);
    let ai = cx.ready(&call).await?;
    let (object, response) =
        object_call(ai, &call, smart_replies_request(account.as_ref(), &message)).await?;
    // `res.object.replies.slice(0, 3)`: a model that sends no list is the
    // route's unexpected error.
    let replies = object["replies"]
        .as_array()
        .ok_or_else(|| MailAiError::Internal("the model sent no replies".to_owned()))?;
    let replies: Vec<Value> = replies.iter().take(3).cloned().collect();
    Ok(Answer::new(json!({ "replies": replies }), &response))
}

/// The model request `smartReplies` sends.
pub(crate) fn smart_replies_request(
    account: Option<&AccountContext>,
    message: &Value,
) -> ChatRequest {
    ChatRequest::system_user(
        base_system(account, "You suggest short, ready-to-send reply options for an email."),
        format!(
            "Suggest 3 brief, distinct reply options (e.g. an affirmative, a decline, and a follow-up) to this email:\n\n{}",
            message_context(message)
        ),
    )
    .schema("replies", replies_schema())
}

/// `message.accountId ? loadAccountContext(...) : null`.
async fn message_account(cx: &MailAi, message: &Value) -> MailAiResult<Option<AccountContext>> {
    match message["accountId"].as_str().filter(|a| !a.is_empty()) {
        Some(account) => Ok(load_account_context(&cx.db, account).await?),
        None => Ok(None),
    }
}

/// `ClassificationResult`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Classification {
    pub(crate) message_id: String,
    pub(crate) account_id: String,
    pub(crate) subject: Value,
    pub(crate) category: String,
    pub(crate) priority: Value,
}

impl Classification {
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "messageId": self.message_id,
            "accountId": self.account_id,
            "subject": self.subject,
            "category": self.category,
            "priority": self.priority,
        })
    }
}

/// The model request `classifyOne` sends.
pub(crate) fn classify_request(message: &Value) -> ChatRequest {
    ChatRequest::system_user(
        "You are an email triage assistant. Classify the email into one category and a priority.",
        format!(
            "Categories: {}.\nPriorities: {}.\n\nEmail:\n{}",
            CLASSIFY_CATEGORIES.join(", "),
            PRIORITIES.join(", "),
            message_context(message)
        ),
    )
    .schema("classification", classify_schema())
}

/// `classifyOne`: the category and priority (charged as `label`, referenced
/// to the message).
async fn classify_one(
    ai: &Ai,
    call: AiCall,
    message: &Value,
) -> MailAiResult<(String, Value, ChatResponse)> {
    let call = call.reference(message["id"].as_str().unwrap_or_default());
    let (object, response) = object_call(ai, &call, classify_request(message)).await?;
    let category = object["category"]
        .as_str()
        .ok_or_else(|| AiError::Invalid("the classification has no category".to_owned()))?;
    Ok((category.to_owned(), object["priority"].clone(), response))
}

/// `persistClassification`: `ai:<category>` added to `categories` (deduped,
/// in order), and `isImportant` for a high priority, through the store's
/// `categories` op (which stamps `updatedAt`).
async fn persist_classification(
    db: &PgPool,
    message: &Value,
    category: &str,
    priority: &Value,
) -> Result<(), sqlx::Error> {
    let categories = with_category(&message["categories"], category);
    let important = priority.as_str() == Some("high");
    sqlx::query(
        "update mail_messages
            set categories = $2::jsonb, updated_at = $3::timestamp,
                is_important = case when $4 then true else is_important end
          where id = $1 and deleted_at is null",
    )
    .bind(message["id"].as_str().unwrap_or_default())
    .bind(categories)
    .bind(crate::util::now())
    .bind(important)
    .execute(db)
    .await?;
    Ok(())
}

/// `Array.from(new Set([...existing, 'ai:<category>']))`.
pub(crate) fn with_category(existing: &Value, category: &str) -> Value {
    let mut out: Vec<Value> = Vec::new();
    let items = existing.as_array().cloned().unwrap_or_default();
    for item in items
        .into_iter()
        .chain(std::iter::once(Value::String(format!("ai:{category}"))))
    {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    Value::Array(out)
}

/// `classifyMessage`: one message, persisted.
pub(crate) async fn classify_message(
    cx: &MailAi,
    message_id: &str,
    model_id: Option<&str>,
) -> MailAiResult<(Classification, Option<Value>)> {
    let message = load_accessible_message(cx, &mut AccountGate::new(NO_ACCESS), message_id)
        .await?
        .ok_or(MailAiError::MessageNotFound("Message not found"))?;
    let account = message_account(cx, &message).await?;
    let call = cx.call(Op::Label, account.as_ref(), model_id);
    let ai = cx.ready(&call).await?;
    let (category, priority, response) = classify_one(ai, call, &message).await?;
    persist_classification(&cx.db, &message, &category, &priority).await?;
    Ok((
        classification(&message, category, priority),
        Some(response.served.meta()),
    ))
}

fn classification(message: &Value, category: String, priority: Value) -> Classification {
    Classification {
        message_id: message["id"].as_str().unwrap_or_default().to_owned(),
        account_id: message["accountId"].as_str().unwrap_or_default().to_owned(),
        subject: message["subject"].clone(),
        category,
        priority,
    }
}

/// `classifyMessagesBatch`: the whole batch checked first (one mailbox the
/// caller may not open refuses it before anything is classified, written
/// back or charged), missing ids skipped, then each classified in order.
pub(crate) async fn classify_batch(
    cx: &MailAi,
    message_ids: &[String],
    model_id: Option<&str>,
) -> MailAiResult<(Vec<Classification>, Option<Value>)> {
    let mut gate = AccountGate::new(NO_ACCESS_SOME);
    let mut batch = Vec::new();
    for id in message_ids {
        if let Some(message) = load_accessible_message(cx, &mut gate, id).await? {
            batch.push(message);
        }
    }
    let first = cx.call(Op::LabelBatch, None, model_id);
    let ai = cx.ready(&first).await?;
    let mut results = Vec::with_capacity(batch.len());
    let mut served = None;
    for message in &batch {
        let account = message_account(cx, message).await?;
        let call = cx.call(Op::LabelBatch, account.as_ref(), model_id);
        let (category, priority, response) = classify_one(ai, call, message).await?;
        persist_classification(&cx.db, message, &category, &priority).await?;
        served.get_or_insert_with(|| response.served.meta());
        results.push(classification(message, category, priority));
    }
    Ok((results, served))
}

#[cfg(test)]
mod tests;
