//! `routes/desk-conversations/translation.ts` and
//! `services/desk-translation.ts`: inbox AI translation at
//! `/api/desk/conversations/:id/translate` and `/translate-reply`, behind
//! `conversations:update`, on `weldsuite_ai` (feature `desk-translate`, task
//! `translate` at the free tier, the worker's `recommended.translate.free`,
//! charged as `desk_translate`).
//!
//! The customer writes in their language, the agent reads and answers in
//! theirs:
//!
//! - `/translate` detects the customer's language from their messages,
//!   stores it on `desk_conversations.language`, and translates the asked
//!   messages into the agent's language. Each translation is kept in the
//!   workspace cache (`WORKSPACE_CACHE`) by message id and language for 30
//!   days, so opening the conversation again makes no model call. While the
//!   language is unknown, or stored as the agent's own, it is judged on the
//!   customer's newest messages first (one small call); the rest goes in
//!   batches of twelve.
//! - `/translate-reply` puts the agent's draft into the conversation's
//!   language.
//!
//! Without AI (no provider) both answer 503 `ai_unavailable` where the
//! worker checks its gateway: after the 404, and for `/translate` only when a
//! model call is needed. 402 on an empty wallet before any call, 502
//! `ai_request_failed` when the model fails. Answers that called a model
//! carry `meta.ai`.
//!
//! Sending a translated reply goes through the reply route, which Rust
//! serves in full, `translation` metadata included (`inbox.rs`).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use futures_util::future::join_all;
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_ai::{Ai, AiCall, AiError, ChatRequest, Feature, Served, Task, Tier};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_db::PgPool;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Presence, Text, js_trim};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_ports::DynCache;

use super::Ctx;
use crate::{DeskState, validate};

/// 30 days (`DESK_TRANSLATION_CACHE_TTL`).
pub(crate) const CACHE_TTL: Duration = Duration::from_hours(30 * 24);
/// Messages translated by default: the customer's latest.
const DEFAULT_MESSAGE_LIMIT: usize = 50;
/// The customer's newest messages a language is judged on.
const DETECTION_SAMPLE: usize = 5;
/// Messages per model call.
const TRANSLATE_BATCH: usize = 12;
/// Characters per model call; one longer message goes alone.
const TRANSLATE_BATCH_CHARS: usize = 6_000;
/// Room for a batch's translations as JSON.
const TRANSLATE_MAX_OUTPUT_TOKENS: u32 = 8_000;
/// Cached for a message judged to be in the agent's language: a marker no
/// translation can be (the model writes no NUL), and not empty.
const SAME_LANGUAGE: &str = "\u{0}";
/// The ledger's `op`.
const OP: &str = "desk_translate";
const LOCALE_MESSAGE: &str = "Must be a language code such as de or pt-BR";

/// `deskReplyTranslationSchema` (the reply route's optional `translation`),
/// in its key order: the agent's own words and the two languages.
pub(super) fn read(issues: &mut Issues, fields: &Map<String, Value>) -> Map<String, Value> {
    let original = issues.text(
        fields,
        "original",
        Presence::Required,
        Some(1),
        Some(20_000),
    );
    let source = issues.text(
        fields,
        "sourceLocale",
        Presence::Required,
        Some(2),
        Some(10),
    );
    let target = issues.text(
        fields,
        "targetLocale",
        Presence::Required,
        Some(2),
        Some(10),
    );
    let mut out = Map::new();
    out.insert("original".to_owned(), json!(original.into_option()));
    out.insert("sourceLocale".to_owned(), json!(source.into_option()));
    out.insert("targetLocale".to_owned(), json!(target.into_option()));
    out
}

pub(super) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<DeskState>
where
    Q: PermissionQueries + 'static,
{
    let update = || gate.require([perm::CONVERSATIONS_UPDATE.to_owned()]);
    Router::new()
        .route("/{id}/translate", post(translate).route_layer(update()))
        .route(
            "/{id}/translate-reply",
            post(translate_reply).route_layer(update()),
        )
}

// ── languages ────────────────────────────────────────────────────────────────

/// `/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/`.
fn is_locale(value: &str) -> bool {
    let mut parts = value.split('-');
    let lang = parts.next().unwrap_or_default();
    (2..=3).contains(&lang.len())
        && lang.bytes().all(|b| b.is_ascii_alphabetic())
        && parts.all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

/// `pt-BR` → `pt`: two tags name the same language when their primary
/// subtags match.
fn primary(locale: &str) -> String {
    js_trim(locale)
        .to_lowercase()
        .split('-')
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// `sameLanguage(a, b)`.
pub(crate) fn same_language(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => primary(a) == primary(b),
        _ => false,
    }
}

/// `normalizeLocale(raw)`: what the model answered for a language, as a tag
/// we store (`de`, `pt-br` → `pt-BR`); `None` when it isn't one.
pub(crate) fn normalize_locale(raw: Option<&str>) -> Option<String> {
    let value = js_trim(raw.unwrap_or_default());
    if !is_locale(value) {
        return None;
    }
    let mut parts = value.split('-');
    let lang = parts.next().unwrap_or_default().to_lowercase();
    let mut tag = lang.clone();
    for part in parts {
        tag.push('-');
        if part.len() == 2 {
            tag.push_str(&part.to_uppercase());
        } else {
            tag.push_str(part);
        }
    }
    Some(if tag.len() <= 10 { tag } else { lang })
}

/// English names of the languages a support inbox meets most, for the
/// prompt (`Intl.DisplayNames(['en'], { type: 'language' })`).
const LANGUAGE_NAMES: [(&str, &str); 52] = [
    ("af", "Afrikaans"),
    ("ar", "Arabic"),
    ("bg", "Bulgarian"),
    ("bn", "Bangla"),
    ("bs", "Bosnian"),
    ("ca", "Catalan"),
    ("cs", "Czech"),
    ("cy", "Welsh"),
    ("da", "Danish"),
    ("de", "German"),
    ("el", "Greek"),
    ("en", "English"),
    ("es", "Spanish"),
    ("et", "Estonian"),
    ("eu", "Basque"),
    ("fa", "Persian"),
    ("fi", "Finnish"),
    ("fr", "French"),
    ("fy", "Western Frisian"),
    ("ga", "Irish"),
    ("gl", "Galician"),
    ("he", "Hebrew"),
    ("hi", "Hindi"),
    ("hr", "Croatian"),
    ("hu", "Hungarian"),
    ("id", "Indonesian"),
    ("is", "Icelandic"),
    ("it", "Italian"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("lb", "Luxembourgish"),
    ("lt", "Lithuanian"),
    ("lv", "Latvian"),
    ("mk", "Macedonian"),
    ("ms", "Malay"),
    ("mt", "Maltese"),
    ("nb", "Norwegian Bokmål"),
    ("nl", "Dutch"),
    ("nn", "Norwegian Nynorsk"),
    ("no", "Norwegian"),
    ("pl", "Polish"),
    ("pt", "Portuguese"),
    ("ro", "Romanian"),
    ("ru", "Russian"),
    ("sk", "Slovak"),
    ("sl", "Slovenian"),
    ("sq", "Albanian"),
    ("sr", "Serbian"),
    ("sv", "Swedish"),
    ("th", "Thai"),
    ("tr", "Turkish"),
    ("uk", "Ukrainian"),
];

/// Regional names `Intl.DisplayNames` gives a tag of its own.
const REGIONAL_NAMES: [(&str, &str); 14] = [
    ("de-at", "Austrian German"),
    ("de-ch", "Swiss High German"),
    ("en-au", "Australian English"),
    ("en-ca", "Canadian English"),
    ("en-gb", "British English"),
    ("en-us", "American English"),
    ("es-419", "Latin American Spanish"),
    ("es-es", "European Spanish"),
    ("es-mx", "Mexican Spanish"),
    ("fr-ca", "Canadian French"),
    ("fr-ch", "Swiss French"),
    ("nl-be", "Flemish"),
    ("pt-br", "Brazilian Portuguese"),
    ("pt-pt", "European Portuguese"),
];

/// "German (de)" for a prompt; the tag alone when it can't be named
/// (`languageName`). A tag with a region `Intl` names on its own
/// (`pt-BR`) gets that name; another region keeps the language's.
fn language_name(locale: &str) -> String {
    let lower = locale.to_lowercase();
    let named = REGIONAL_NAMES
        .iter()
        .find(|(tag, _)| *tag == lower)
        .or_else(|| {
            LANGUAGE_NAMES
                .iter()
                .find(|(tag, _)| *tag == primary(locale))
        })
        .map(|(_, name)| *name);
    match named {
        Some(name) => format!("{name} ({locale})"),
        None => locale.to_owned(),
    }
}

// ── the cache ────────────────────────────────────────────────────────────────

/// The workspace cache by message id, for one language. A cache is a cache:
/// a missing binding or a failed read or write is a miss, never an error.
struct TranslationCache {
    kv: Option<Arc<dyn DynCache>>,
    workspace_id: String,
    language: String,
}

impl TranslationCache {
    fn key(&self, message_id: &str) -> String {
        format!(
            "desk-translation:{}:{message_id}:{}",
            self.workspace_id, self.language
        )
    }

    async fn get(&self, message_id: &str) -> Option<String> {
        let kv = self.kv.as_ref()?;
        match kv.get_boxed(&self.key(message_id)).await {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(%error, "[desk-translation] cache read failed");
                None
            }
        }
    }

    async fn put(&self, message_id: &str, text: &str) {
        let Some(kv) = &self.kv else { return };
        if let Err(error) = kv
            .put_boxed(&self.key(message_id), text, Some(CACHE_TTL))
            .await
        {
            tracing::warn!(%error, "[desk-translation] cache write failed");
        }
    }

    async fn delete(&self, message_id: &str) {
        let Some(kv) = &self.kv else { return };
        if let Err(error) = kv.delete_boxed(&self.key(message_id)).await {
            tracing::warn!(%error, "[desk-translation] cache delete failed");
        }
    }
}

// ── the model ────────────────────────────────────────────────────────────────

/// One message as the model sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Message {
    pub(crate) id: String,
    /// `author_type`: `visitor` is the customer.
    pub(crate) author_type: String,
    pub(crate) body: Option<String>,
}

impl Message {
    fn size(&self) -> usize {
        self.body.as_deref().map_or(0, |b| b.encode_utf16().count())
    }
}

/// What one call answers for a batch.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Answer {
    /// The language as the model named it, raw.
    pub(crate) language: Option<String>,
    /// `(message id, text)`, as given.
    pub(crate) translations: Vec<(String, String)>,
}

fn translations_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "language": { "type": "string" },
            "translations": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": { "id": { "type": "string" }, "text": { "type": "string" } },
                    "required": ["id", "text"],
                    "additionalProperties": false,
                },
            },
        },
        "required": ["language", "translations"],
        "additionalProperties": false,
    })
}

fn reply_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "text": { "type": "string" }, "sourceLanguage": { "type": "string" } },
        "required": ["text", "sourceLanguage"],
        "additionalProperties": false,
    })
}

/// The system prompt of a batch.
fn translate_system(target: &str) -> String {
    [
        "You translate customer support conversations.".to_owned(),
        "First name the language the customer writes in, as an ISO 639-1 code (for example 'de'): judge it from the messages whose role is customer.".to_owned(),
        format!("Then translate every message into {}.", language_name(target)),
        "Keep the meaning, tone, names, numbers, links and line breaks. Translate only; add nothing and leave nothing out.".to_owned(),
        "Return each translation with the id of its message.".to_owned(),
    ]
    .join("\n")
}

/// The batch as the prompt carries it: `[{ id, role, text }]`.
fn translate_prompt(batch: &[&Message]) -> String {
    let items: Vec<Value> = batch
        .iter()
        .map(|message| {
            json!({
                "id": message.id,
                "role": if message.author_type == "visitor" { "customer" } else { "support" },
                "text": message.body.as_deref().unwrap_or_default(),
            })
        })
        .collect();
    Value::Array(items).to_string()
}

/// The answer of a batch, read leniently (the schema isn't enforced by every
/// provider).
fn read_answer(object: Option<&Value>) -> Answer {
    let Some(object) = object else {
        return Answer::default();
    };
    let translations = object
        .get("translations")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(Value::as_str)?;
                    let text = item.get("text").and_then(Value::as_str)?;
                    Some((id.to_owned(), text.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    Answer {
        language: object
            .get("language")
            .and_then(Value::as_str)
            .map(str::to_owned),
        translations,
    }
}

/// The model of one request: its AI and the call's context.
pub(crate) struct Translator {
    pub(crate) ai: Ai,
    pub(crate) call: AiCall,
}

impl Translator {
    /// The call for a workspace and member.
    pub(crate) fn call(
        workspace_id: &str,
        user_id: &str,
        tenant: PgPool,
        master: Option<PgPool>,
    ) -> AiCall {
        AiCall::new(
            workspace_id,
            Feature::DeskTranslate,
            Task::Translate,
            Tier::Free,
        )
        .user(user_id)
        .tenant(tenant)
        .master(master)
        .op(OP)
    }

    /// One batch into `target`: the language and the translations.
    pub(crate) async fn batch(
        &self,
        target: &str,
        batch: &[&Message],
    ) -> Result<(Answer, Served), AiError> {
        let request = ChatRequest::system_user(translate_system(target), translate_prompt(batch))
            .schema("translations", translations_schema())
            .max_tokens(TRANSLATE_MAX_OUTPUT_TOKENS);
        let response = self.ai.chat(&self.call, request).await?;
        Ok((read_answer(response.object.as_ref()), response.served))
    }

    /// The agent's draft into `target`: `(text, the language it was written
    /// in as named)`.
    pub(crate) async fn reply(
        &self,
        target: &str,
        text: &str,
    ) -> Result<(Value, Option<String>, Served), AiError> {
        let system = [
            format!(
                "You translate a support agent's reply to a customer into {}.",
                language_name(target)
            ),
            "Keep the meaning, tone, names, numbers, links, placeholders and line breaks. Translate only; add nothing.".to_owned(),
            "Also name the language the agent wrote in, as an ISO 639-1 code (for example 'en').".to_owned(),
        ]
        .join("\n");
        let request = ChatRequest::system_user(system, text)
            .schema("reply", reply_schema())
            .max_tokens(TRANSLATE_MAX_OUTPUT_TOKENS);
        let response = self.ai.chat(&self.call, request).await?;
        let object = response.object.unwrap_or(Value::Null);
        let source = object
            .get("sourceLanguage")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let text = object.get("text").cloned().unwrap_or(Value::Null);
        Ok((text, source, response.served))
    }
}

// ── one translate request ────────────────────────────────────────────────────

/// Why a request ends early, as the worker answers it (`DeskTranslationError`
/// and the other refusals).
enum Failure {
    Answer(Box<Response>),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl Failure {
    fn coded(status: StatusCode, code: &'static str, message: &str) -> Self {
        Self::Answer(Box::new(
            ApiError::new(status, code, message).into_response(),
        ))
    }

    fn not_found(id: &str) -> Self {
        Self::coded(
            StatusCode::NOT_FOUND,
            "not_found",
            &format!("Conversation with ID '{id}' not found"),
        )
    }

    fn unavailable() -> Self {
        Self::coded(
            StatusCode::SERVICE_UNAVAILABLE,
            "ai_unavailable",
            "AI is currently unavailable",
        )
    }

    fn model_failed(error: &AiError) -> Self {
        tracing::error!(%error, "[desk-translation] model call failed");
        Self::coded(
            StatusCode::BAD_GATEWAY,
            "ai_request_failed",
            "Translation failed, try again",
        )
    }

    /// The credit gate's refusal (402, or 503 without a provider).
    fn gate(error: AiError) -> Self {
        match error {
            AiError::Database(error) => Self::Database(error),
            other => Self::Answer(Box::new(other.into_api_error().into_response())),
        }
    }

    fn respond(self) -> Response {
        match self {
            Self::Answer(response) => *response,
            Self::Database(error) => {
                tracing::error!(%error, "[desk-api/desk-conversations] translation failed");
                ApiError::internal()
                    .with_message("Failed to translate")
                    .into_response()
            }
        }
    }
}

/// What one translate request knows so far (`TranslationRun`).
struct Run {
    db: PgPool,
    conversation_id: String,
    /// The agent's language.
    target: String,
    /// `desk_conversations.language` when the request came in.
    stored: Option<String>,
    language: Option<String>,
    language_change: Option<(Option<String>, String)>,
    messages: Vec<Message>,
    /// Message id → its cached translation, or [`SAME_LANGUAGE`].
    cached: HashMap<String, String>,
    cache: TranslationCache,
    /// Who answered the last call.
    served: Option<Served>,
}

impl Run {
    /// A language to translate from: known, and not the agent's own.
    fn is_foreign(&self) -> bool {
        self.language.is_some() && !same_language(self.language.as_deref(), Some(&self.target))
    }

    fn result(&self) -> Value {
        let translations: Vec<Value> = if self.is_foreign() || self.language.is_none() {
            self.messages
                .iter()
                .filter_map(|message| {
                    let text = self.cached.get(&message.id)?;
                    (text != SAME_LANGUAGE)
                        .then(|| json!({ "messageId": message.id, "text": text }))
                })
                .collect()
        } else {
            Vec::new()
        };
        json!({
            "language": self.language,
            "targetLocale": self.target,
            "translations": translations,
        })
    }

    /// Store what a call named as the customer's language, when it is news.
    async fn adopt_language(&mut self, raw: Option<&str>) -> Result<(), sqlx::Error> {
        let Some(detected) = normalize_locale(raw) else {
            return Ok(());
        };
        if self.language.as_deref() == Some(detected.as_str()) {
            return Ok(());
        }
        let updated: Option<String> = sqlx::query_scalar(
            "update desk_conversations set language = $2 where id = $1 returning id",
        )
        .bind(&self.conversation_id)
        .bind(&detected)
        .fetch_optional(&self.db)
        .await?;
        if updated.is_some() {
            self.language_change = Some((self.stored.clone(), detected.clone()));
        }
        self.language = Some(detected);
        Ok(())
    }

    async fn keep(&mut self, batch: &[&Message], items: &[(String, String)]) {
        let wanted: HashSet<&str> = batch.iter().map(|m| m.id.as_str()).collect();
        for (id, text) in items {
            if !wanted.contains(id.as_str()) {
                continue;
            }
            // An empty answer is nothing to show; remembered, so it is not asked for again.
            let text = if text.is_empty() { SAME_LANGUAGE } else { text };
            self.cached.insert(id.clone(), text.to_owned());
            self.cache.put(id, text).await;
        }
    }
}

/// The messages a language is judged on: the customer's newest (any
/// author's when none are the customer's), a handful and within one call's
/// size (`detectionSample`).
fn detection_sample(messages: &[Message]) -> Vec<Message> {
    let from_customer: Vec<&Message> = messages
        .iter()
        .filter(|m| m.author_type == "visitor")
        .collect();
    let pool: Vec<&Message> = if from_customer.is_empty() {
        messages.iter().collect()
    } else {
        from_customer
    };
    let mut sample: Vec<Message> = Vec::new();
    let mut chars = 0;
    for message in pool.iter().rev() {
        if sample.len() >= DETECTION_SAMPLE {
            break;
        }
        let size = message.size();
        if !sample.is_empty() && chars + size > TRANSLATE_BATCH_CHARS {
            break;
        }
        sample.insert(0, (*message).clone());
        chars += size;
    }
    sample
}

/// Messages split into calls: at most [`TRANSLATE_BATCH`] each, and
/// [`TRANSLATE_BATCH_CHARS`] unless one message is longer (`batchesOf`).
fn batches_of(messages: &[Message]) -> Vec<Vec<&Message>> {
    let mut batches: Vec<Vec<&Message>> = Vec::new();
    let mut batch: Vec<&Message> = Vec::new();
    let mut chars = 0;
    for message in messages {
        let size = message.size();
        if !batch.is_empty()
            && (batch.len() == TRANSLATE_BATCH || chars + size > TRANSLATE_BATCH_CHARS)
        {
            batches.push(std::mem::take(&mut batch));
            chars = 0;
        }
        batch.push(message);
        chars += size;
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    batches
}

/// `desk_conversations.language`, or `None` for an unknown conversation.
async fn conversation_language(
    db: &PgPool,
    id: &str,
) -> Result<Option<Option<String>>, sqlx::Error> {
    sqlx::query_scalar("select language from desk_conversations where id = $1 limit 1")
        .bind(id)
        .fetch_optional(db)
        .await
}

/// The asked messages of this conversation (not events, with text), or the
/// customer's latest public messages (`loadMessages`).
async fn load_messages(
    db: &PgPool,
    conversation_id: &str,
    message_ids: Option<&[String]>,
) -> Result<Vec<Message>, sqlx::Error> {
    let has_text = |body: &Option<String>| body.as_deref().is_some_and(|b| !js_trim(b).is_empty());
    if let Some(ids) = message_ids {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
            "select id, kind, author_type, body from desk_messages
             where conversation_id = $1 and id = any($2)
             order by created_at asc, id asc",
        )
        .bind(conversation_id)
        .bind(ids)
        .fetch_all(db)
        .await?;
        return Ok(rows
            .into_iter()
            .filter(|(_, kind, _, body)| kind != "event" && has_text(body))
            .map(|(id, _, author_type, body)| Message {
                id,
                author_type,
                body,
            })
            .collect());
    }
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "select id, author_type, body from desk_messages
         where conversation_id = $1 and author_type = 'visitor' and kind = 'message'
         order by created_at asc, id asc",
    )
    .bind(conversation_id)
    .fetch_all(db)
    .await?;
    let mut messages: Vec<Message> = rows
        .into_iter()
        .filter(|(_, _, body)| has_text(body))
        .map(|(id, author_type, body)| Message {
            id,
            author_type,
            body,
        })
        .collect();
    let skip = messages.len().saturating_sub(DEFAULT_MESSAGE_LIMIT);
    messages.drain(..skip);
    Ok(messages)
}

/// The model of a request, the credit gate passed (`translator`), or 503
/// without AI.
async fn translator(ai: Option<Ai>, call: AiCall) -> Result<Translator, Failure> {
    let ai = ai.ok_or_else(Failure::unavailable)?;
    ai.assert_credits(&call).await.map_err(Failure::gate)?;
    Ok(Translator { ai, call })
}

/// Judge the language on the customer's newest messages of `queue` before
/// paying for more. What is still to translate, or `None` when the customer
/// writes the agent's language (`probeLanguage`).
async fn probe_language(
    run: &mut Run,
    queue: &[Message],
    translate: &Translator,
) -> Result<Option<Vec<Message>>, Failure> {
    let probe = detection_sample(queue);
    let refs: Vec<&Message> = probe.iter().collect();
    let (answer, served) = translate
        .batch(&run.target, &refs)
        .await
        .map_err(|error| Failure::model_failed(&error))?;
    run.served = Some(served);
    run.adopt_language(answer.language.as_deref()).await?;
    if same_language(run.language.as_deref(), Some(&run.target)) {
        for message in queue {
            run.cached
                .insert(message.id.clone(), SAME_LANGUAGE.to_owned());
            run.cache.put(&message.id, SAME_LANGUAGE).await;
        }
        return Ok(None);
    }
    run.keep(&refs, &answer.translations).await;

    // The conversation turned out foreign. Forget the "same language" marks an
    // earlier request left on its other messages: they are translated now, and
    // when their batch fails they are not cached, so the next request sends
    // them again.
    let judged: HashSet<&str> = probe.iter().map(|m| m.id.as_str()).collect();
    let marked: Vec<String> = run
        .messages
        .iter()
        .filter(|m| {
            !judged.contains(m.id.as_str())
                && run.cached.get(&m.id).map(String::as_str) == Some(SAME_LANGUAGE)
        })
        .map(|m| m.id.clone())
        .collect();
    for id in marked {
        run.cached.remove(&id);
        run.cache.delete(&id).await;
    }
    Ok(Some(
        run.messages
            .iter()
            .filter(|m| !judged.contains(m.id.as_str()) && !run.cached.contains_key(&m.id))
            .cloned()
            .collect(),
    ))
}

/// Translate `queue`, a batch per call, all at once. Without a probe before
/// it, the batch with the newest messages also says whether the customer
/// changed language, and every call failing is an error. Otherwise the
/// answer holds what came back (`translateBatches`).
async fn translate_batches(
    run: &mut Run,
    queue: &[Message],
    translate: &Translator,
    probed: bool,
) -> Result<(), Failure> {
    let batches = batches_of(queue);
    let target = run.target.clone();
    let settled = join_all(batches.iter().map(|batch| translate.batch(&target, batch))).await;
    let last = batches.len().saturating_sub(1);
    let mut failures = 0;
    let mut first_failure = None;
    for (index, (batch, outcome)) in batches.iter().zip(settled).enumerate() {
        match outcome {
            Ok((answer, served)) => {
                run.served = Some(served);
                if !probed && index == last {
                    run.adopt_language(answer.language.as_deref()).await?;
                }
                run.keep(batch, &answer.translations).await;
            }
            Err(error) => {
                failures += 1;
                first_failure.get_or_insert(error);
            }
        }
    }
    let Some(error) = first_failure else {
        return Ok(());
    };
    if !probed && failures == batches.len() {
        return Err(Failure::model_failed(&error));
    }
    tracing::error!(%error, "[desk-translation] model call failed");
    Ok(())
}

/// The translate request: the body's messages into `target_locale`
/// (`translateConversation`).
async fn translate_conversation(
    ctx: &Ctx,
    state: &DeskState,
    id: &str,
    message_ids: Option<&[String]>,
    target_locale: &str,
) -> Result<Run, Failure> {
    let caller = &ctx.caller;
    let db = &caller.db;
    let stored = conversation_language(db, id)
        .await?
        .ok_or_else(|| Failure::not_found(id))?;
    let target = normalize_locale(Some(target_locale)).unwrap_or_else(|| target_locale.to_owned());
    let messages = load_messages(db, id, message_ids).await?;
    let cache = TranslationCache {
        kv: ctx.kv(state),
        workspace_id: caller.workspace_id.clone(),
        language: primary(&target),
    };
    let mut cached = HashMap::new();
    for message in &messages {
        if let Some(text) = cache.get(&message.id).await {
            cached.insert(message.id.clone(), text);
        }
    }
    let mut run = Run {
        db: db.clone(),
        conversation_id: id.to_owned(),
        target,
        stored: stored.clone(),
        language: stored,
        language_change: None,
        messages,
        cached,
        cache,
        served: None,
    };

    let mut queue: Vec<Message> = run
        .messages
        .iter()
        .filter(|m| !run.cached.contains_key(&m.id))
        .cloned()
        .collect();
    if queue.is_empty() {
        if run.language.is_some() || run.messages.is_empty() {
            return Ok(run);
        }
        // Every message is cached but the language was never stored: judge it.
        queue = detection_sample(&run.messages);
    }

    let call = Translator::call(
        &caller.workspace_id,
        &caller.user_id,
        caller.db.clone(),
        caller
            .master
            .as_ref()
            .map(|m| m.0.clone())
            .or_else(|| state.master.clone()),
    );
    let translate = translator(ctx.ai(state), call).await?;
    // Unknown, or the agent's own language as far as we know: judge it first.
    let probed = !run.is_foreign();
    if probed {
        match probe_language(&mut run, &queue, &translate).await? {
            None => return Ok(run),
            Some(rest) => queue = rest,
        }
    }
    translate_batches(&mut run, &queue, &translate, probed).await?;
    Ok(run)
}

/// `{ data, meta: { ai } }`, or `{ data }` when no model was called.
fn answered(data: Value, served: Option<&Served>) -> Response {
    let mut body = Map::new();
    body.insert("data".to_owned(), data);
    if let Some(served) = served {
        body.insert("meta".to_owned(), json!({ "ai": served.meta() }));
    }
    axum::Json(Value::Object(body)).into_response()
}

// ── POST /:id/translate ──────────────────────────────────────────────────────

/// `translateDeskConversationSchema`: `(messageIds, targetLocale)`.
fn translate_schema(
    issues: &mut Issues,
    fields: &Map<String, Value>,
) -> (Option<Vec<String>>, String) {
    let ids = issues
        .list(
            fields,
            "messageIds",
            Presence::Optional,
            None,
            Some(50),
            |issues, item| issues.item_text(item, Text::length(None, Some(30))),
        )
        .into_option();
    let target = issues
        .pattern_with(
            fields,
            "targetLocale",
            Presence::Required,
            Text::trimmed(Some(2), Some(10)),
            is_locale,
            LOCALE_MESSAGE,
        )
        .into_option();
    (ids, target.unwrap_or_default())
}

async fn translate(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (message_ids, target) = match validate(&headers, &body, translate_schema) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to translate"),
    };
    let run = match translate_conversation(&ctx, &state, &id, message_ids.as_deref(), &target).await
    {
        Ok(run) => run,
        Err(failure) => return failure.respond(),
    };
    if let Some((old, new)) = &run.language_change {
        let caller = &ctx.caller;
        match weldsuite_desk_domain::webchat::get(&caller.db, &id, false).await {
            Ok(Some((conversation, _))) => {
                let mut changes = Map::new();
                changes.insert("language".to_owned(), json!({ "old": old, "new": new }));
                let event = weldsuite_events::EntityEvent::new(
                    ev::DESK_CONVERSATION_UPDATED,
                    id.clone(),
                    conversation,
                )
                .with_changes(changes);
                state.events.publish(&caller.events, event);
            }
            Ok(None) => {}
            Err(error) => {
                return Failure::Database(error).respond();
            }
        }
    }
    answered(run.result(), run.served.as_ref())
}

// ── POST /:id/translate-reply ────────────────────────────────────────────────

/// `translateDeskReplySchema`: `(text, targetLocale)`.
fn reply_schema_of(issues: &mut Issues, fields: &Map<String, Value>) -> (String, Option<String>) {
    let text = issues
        .text_with(
            fields,
            "text",
            Presence::Required,
            Text::trimmed(Some(1), Some(20_000)),
        )
        .into_option();
    let target = issues
        .pattern_with(
            fields,
            "targetLocale",
            Presence::Optional,
            Text::trimmed(Some(2), Some(10)),
            is_locale,
            LOCALE_MESSAGE,
        )
        .into_option();
    (text.unwrap_or_default(), target)
}

async fn translate_reply(
    State(state): State<DeskState>,
    ctx: Ctx,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (text, target_locale) = match validate(&headers, &body, reply_schema_of) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond("Failed to translate"),
    };
    let caller = &ctx.caller;
    let reply = async {
        let stored = conversation_language(&caller.db, &id)
            .await?
            .ok_or_else(|| Failure::not_found(&id))?;
        let Some(target) = normalize_locale(target_locale.as_deref().or(stored.as_deref())) else {
            return Err(Failure::coded(
                StatusCode::BAD_REQUEST,
                "language_unknown",
                "The customer's language isn't known yet: translate the conversation first",
            ));
        };
        let call = Translator::call(
            &caller.workspace_id,
            &caller.user_id,
            caller.db.clone(),
            caller
                .master
                .as_ref()
                .map(|m| m.0.clone())
                .or_else(|| state.master.clone()),
        );
        let translate = translator(ctx.ai(&state), call).await?;
        let (translated, source, served) = translate
            .reply(&target, &text)
            .await
            .map_err(|error| Failure::model_failed(&error))?;
        let mut data = Map::new();
        if !translated.is_null() {
            data.insert("text".to_owned(), translated);
        }
        data.insert(
            "sourceLocale".to_owned(),
            json!(normalize_locale(source.as_deref())),
        );
        data.insert("targetLocale".to_owned(), json!(target));
        Ok::<_, Failure>(answered(Value::Object(data), Some(&served)))
    }
    .await;
    reply.unwrap_or_else(Failure::respond)
}

#[cfg(test)]
mod tests {
    use super::*;
    use weldsuite_ai::{AiConfig, FakeProvider};

    fn ai(fake: FakeProvider) -> Ai {
        let mut problems = Vec::new();
        let config = AiConfig::from_lookup(
            &|name| match name {
                "AI_DEFAULT_PROVIDER" => Some("mistral".to_owned()),
                "MISTRAL_API_KEY" => Some("mistral-key".to_owned()),
                _ => None,
            },
            &mut problems,
        );
        assert!(problems.is_empty(), "{problems:?}");
        Ai::fake(config, fake)
    }

    fn message(id: &str, author: &str, body: &str) -> Message {
        Message {
            id: id.to_owned(),
            author_type: author.to_owned(),
            body: Some(body.to_owned()),
        }
    }

    fn translator(fake: FakeProvider) -> Translator {
        Translator {
            ai: ai(fake),
            call: AiCall::new("ws_1", Feature::DeskTranslate, Task::Translate, Tier::Free).op(OP),
        }
    }

    #[test]
    fn locales_are_normalized_as_the_worker_does() {
        assert_eq!(normalize_locale(Some(" de ")), Some("de".to_owned()));
        assert_eq!(normalize_locale(Some("pt-br")), Some("pt-BR".to_owned()));
        assert_eq!(normalize_locale(Some("EN-gb")), Some("en-GB".to_owned()));
        assert_eq!(
            normalize_locale(Some("zh-Hant")),
            Some("zh-Hant".to_owned())
        );
        assert_eq!(normalize_locale(Some("english!")), None);
        assert_eq!(normalize_locale(Some("")), None);
        assert_eq!(normalize_locale(None), None);
        // Longer than a column holds: the language alone.
        assert_eq!(normalize_locale(Some("de-abcdefgh")), Some("de".to_owned()));
        assert!(same_language(Some("en"), Some("en-GB")));
        assert!(!same_language(Some("en"), Some("de")));
        assert!(!same_language(None, Some("en")));
        assert!(!same_language(Some(""), Some("")));
    }

    #[test]
    fn languages_are_named_for_the_prompt() {
        assert_eq!(language_name("de"), "German (de)");
        assert_eq!(language_name("pt-BR"), "Brazilian Portuguese (pt-BR)");
        assert_eq!(language_name("de-LU"), "German (de-LU)");
        assert_eq!(language_name("xx"), "xx");
    }

    #[test]
    fn long_threads_are_judged_on_the_newest_and_sent_in_batches() {
        let thread: Vec<Message> = (1..=30)
            .map(|i| message(&format!("m{i}"), "visitor", &format!("Nachricht {i}")))
            .collect();
        let sample = detection_sample(&thread);
        assert_eq!(
            sample.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["m26", "m27", "m28", "m29", "m30"]
        );
        let sizes: Vec<usize> = batches_of(&thread[5..]).iter().map(Vec::len).collect();
        assert_eq!(sizes, [12, 12, 1]);
        // One long message goes alone.
        let long = vec![
            message("a", "visitor", "short"),
            message("b", "visitor", &"x".repeat(7_000)),
            message("c", "visitor", "short"),
        ];
        let sizes: Vec<usize> = batches_of(&long).iter().map(Vec::len).collect();
        assert_eq!(sizes, [1, 1, 1]);
        // Without customer messages, any author's.
        let agents = vec![message("a", "agent", "Hello")];
        assert_eq!(detection_sample(&agents).len(), 1);
    }

    #[tokio::test]
    async fn a_batch_asks_mistral_for_the_translations_schema() {
        let fake = FakeProvider::new().reply_json(&json!({
            "language": "de",
            "translations": [
                { "id": "m1", "text": "My invoice is wrong." },
                { "id": 7, "text": "ignored" },
            ],
        }));
        let translate = translator(fake.clone());
        let first = message("m1", "visitor", "Meine Rechnung ist falsch.");
        let second = message("m2", "agent", "Which invoice?");
        let (answer, served) = translate
            .batch("en", &[&first, &second])
            .await
            .expect("the call answers");
        assert_eq!(answer.language.as_deref(), Some("de"));
        assert_eq!(
            answer.translations,
            [("m1".to_owned(), "My invoice is wrong.".to_owned())]
        );
        assert_eq!(served.provider.as_str(), "mistral");
        assert_eq!(served.meta()["region"], "eu");

        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
        let body = &calls[0].body;
        assert!(calls[0].url.ends_with("/chat/completions"));
        assert_eq!(body["response_format"]["type"], "json_schema");
        assert_eq!(body["max_tokens"], 8_000);
        let system = body["messages"][0]["content"].as_str().unwrap_or_default();
        assert!(system.contains("Then translate every message into English (en)."));
        let prompt: Value =
            serde_json::from_str(body["messages"][1]["content"].as_str().unwrap_or_default())
                .expect("the prompt is JSON");
        assert_eq!(
            prompt,
            json!([
                { "id": "m1", "role": "customer", "text": "Meine Rechnung ist falsch." },
                { "id": "m2", "role": "support", "text": "Which invoice?" },
            ])
        );
    }

    #[tokio::test]
    async fn a_reply_is_translated_with_its_source_language() {
        let fake = FakeProvider::new()
            .reply_json(&json!({ "text": "Ich prüfe das für Sie.", "sourceLanguage": "EN" }));
        let translate = translator(fake.clone());
        let (text, source, _) = translate
            .reply("de", "I'll look into it for you.")
            .await
            .expect("the call answers");
        assert_eq!(text, json!("Ich prüfe das für Sie."));
        assert_eq!(normalize_locale(source.as_deref()), Some("en".to_owned()));
        let body = &fake.calls()[0].body;
        assert_eq!(body["messages"][1]["content"], "I'll look into it for you.");
        assert!(
            body["messages"][0]["content"]
                .as_str()
                .unwrap_or_default()
                .contains("into German (de).")
        );
    }

    #[tokio::test]
    async fn a_failed_model_call_is_the_workers_502() {
        let fake = FakeProvider::new()
            .reply_status(500, "boom")
            .reply_status(500, "boom")
            .reply_status(500, "boom")
            .reply_status(500, "boom");
        let translate = translator(fake);
        let first = message("m1", "visitor", "Hallo");
        let error = translate
            .batch("en", &[&first])
            .await
            .expect_err("the call fails");
        let response = Failure::model_failed(&error).respond();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the body reads");
        let json: Value = serde_json::from_slice(&body).expect("the body is JSON");
        assert_eq!(
            json,
            json!({ "error": { "code": "ai_request_failed", "message": "Translation failed, try again" } })
        );
    }

    #[tokio::test]
    async fn without_ai_it_is_unavailable() {
        let call = AiCall::new("ws_1", Feature::DeskTranslate, Task::Translate, Tier::Free);
        let Err(failure) = super::translator(None, call).await else {
            panic!("no translator without AI");
        };
        let response = failure.respond();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the body reads");
        let json: Value = serde_json::from_slice(&body).expect("the body is JSON");
        assert_eq!(json["error"]["code"], "ai_unavailable");
        assert_eq!(json["error"]["message"], "AI is currently unavailable");
    }
}
