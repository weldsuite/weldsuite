//! `corpus/generate.ts`: the monthly corpus refresh. A model writes fresh
//! English business email threads; those that pass the same checks as the
//! stored set ([`super::validate`]) replace it.
//!
//! Global asks `recommended.draft.quality` through the AI Gateway and keeps
//! the set in R2. These editions ask the install's AI (`weldsuite_ai`, ADR
//! AI-012) for the fixed feature `reach-warmup` (task `draft`, quality tier:
//! Mistral on EU, never a workspace's provider: the job has no customer
//! content) and keep the set in the master database's `system_settings`
//! ([`super::corpus`]), where `cron` and `consume` both read it. WeldSuite
//! pays for the calls; nothing is charged to a workspace. Any failure leaves
//! the previous set (or the built-in one) in place.

use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_ai::{Ai, AiCall, ChatRequest, Feature, Task, Tier};
use weldsuite_reach_domain::text::js_trim;

use super::clock::DAY_MS;
use super::corpus::{
    CORPUS_LATEST_KEY, CORPUS_META_KEY, CORPUS_PREVIOUS_KEY, CorpusThread, read_setting,
    reset_corpus_cache, write_setting,
};
use super::validate::{parse_corpus_thread, prompt_forbidden_words};

pub const THREADS_PER_BATCH: usize = 10;
pub const BATCH_COUNT: usize = 12;
/// Calls in flight at once.
const BATCH_CONCURRENCY: usize = 4;
const MAX_OUTPUT_TOKENS: u32 = 12_000;
/// A refresh that yields fewer valid threads than this is discarded.
pub const MIN_GENERATED_THREADS: usize = 60;
/// The stored set is replaced once it is older than this.
pub const CORPUS_MAX_AGE_MS: i64 = 30 * DAY_MS;

pub const TOPICS: [&str; 64] = [
    "scheduling a call or a meeting",
    "following up on a quote or a proposal",
    "a question about an invoice or a payment",
    "a project status check",
    "an introduction between two business contacts",
    "scheduling an interview for a job opening",
    "onboarding a new supplier or client",
    "event logistics such as catering, venue and headcount",
    "feedback on a draft document",
    "office and facilities admin such as badges, rooms and printers",
    "small talk after meeting at a conference, with a work hook",
    "thanking someone after a meeting",
    "rescheduling an appointment",
    "a request for a professional reference",
    "timing of a contract review",
    "a budget or approval question",
    "a delayed or missing delivery",
    "planning a training session",
    "an agenda for a review meeting",
    "connecting someone with a colleague",
    "meeting notes and action items",
    "a handover before going on leave",
    "a discrepancy in a monthly report",
    "review of text for a company website",
    "a request for design files or a logo",
    "planning a customer or site visit",
    "an invitation to speak or join a panel",
    "asking for a recommendation for a local professional",
    "a planning workshop for the team",
    "preparing the first week of a new employee",
    "ordering equipment for a team",
    "discussing the results of a customer survey",
    "a catch-up coffee or lunch between contacts",
    "delivery windows and access instructions for a site",
    "slides or material for a presentation",
    "a question about an internal expense policy",
    "translation or localisation of a document",
    "a visit to a warehouse or a factory",
    "an office move",
    "feedback after a job interview",
    "a request for a deadline extension",
    "a request for an export of data for an audit",
    "a calendar conflict",
    "planning a team lunch or social event",
    "access permissions to a shared folder",
    "clarifying a specification or a drawing",
    "the kickoff of a small pilot project",
    "renewing a service agreement",
    "feedback on product samples or a prototype",
    "a question about a confidentiality agreement",
    "asking an experienced colleague for advice",
    "a heads-up about a customer complaint",
    "travel arrangements for a team offsite",
    "reconciling accounts at the end of a quarter",
    "staffing and shift planning",
    "an apology for a late reply",
    "changing the time of a recurring meeting",
    "a mention in a local publication",
    "catching up after a holiday",
    "scheduling a yearly stock count",
    "a request for a quote for services",
    "preparing a joint presentation",
    "holiday cover planning for a small team",
    "a shipping or customs question",
];

const TONES: [&str; 6] = [
    "warm and friendly",
    "brisk and businesslike",
    "formal and polite",
    "relaxed and casual",
    "concise, almost terse",
    "thoughtful and detailed",
];

const FORMATS: [&str; 5] = [
    "a greeting with the first name and a sign-off with the first name",
    "no greeting, straight to the point, sign-off with the first name",
    "a greeting with the first name, no sign-off",
    "a greeting with the first name and a formal sign-off with first and last name",
    "no greeting and no sign-off, like a quick reply",
];

const LENGTHS: [&str; 4] = [
    "one or two sentences per message",
    "three or four sentences per message",
    "four to six sentences per message, in short paragraphs",
    "mixed: some messages one sentence, others longer",
];

const MESSAGE_COUNTS: [usize; 10] = [2, 3, 4, 3, 2, 3, 4, 2, 3, 3];

/// `ThreadBrief`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadBrief {
    pub topic: &'static str,
    pub message_count: usize,
    pub tone: &'static str,
    pub format: &'static str,
    pub length: &'static str,
}

/// `buildBatchPlan(batchIndex, count)`: the briefs of one batch, pure, so the
/// batches differ and a run is reproducible.
pub fn build_batch_plan(batch_index: usize, count: usize) -> Vec<ThreadBrief> {
    (0..count)
        .map(|i| {
            let slot = batch_index * count + i;
            ThreadBrief {
                topic: TOPICS[(slot * 7) % TOPICS.len()],
                message_count: MESSAGE_COUNTS[slot % MESSAGE_COUNTS.len()],
                tone: TONES[(slot * 5 + batch_index) % TONES.len()],
                format: FORMATS[(slot * 3) % FORMATS.len()],
                length: LENGTHS[(slot * 2 + 1) % LENGTHS.len()],
            }
        })
        .collect()
}

/// `SYSTEM_PROMPT`.
pub fn system_prompt() -> String {
    [
        "You write realistic English business emails exchanged between two people at different small or mid-sized companies. They know each other a little from work. The emails are ordinary day-to-day correspondence.".to_owned(),
        "Each thread has a \"starter\" who writes the first message and a \"responder\" who replies, alternating: starter, responder, starter, responder. Every reply answers what the previous message said and moves the conversation on.".to_owned(),
        "Names: never write a real or invented name. Use these placeholders only: {{recipientFirstName}} is the person the message is addressed to, {{senderFirstName}} and {{senderLastName}} are the person writing that message, {{recipientLastName}} is the addressee's last name. A greeting uses {{recipientFirstName}}; a sign-off uses {{senderFirstName}} (optionally followed by {{senderLastName}}). The placeholders always refer to the writer and the addressee of that very message, so in a reply they swap places.".to_owned(),
        "Plain text only: no markdown, no bullet symbols, no bold, no emoji, no HTML. Separate paragraphs with a blank line.".to_owned(),
        "Never include a link, a web address, an email address, a phone number, a currency symbol, or a mention of an attachment or an enclosed file. Numbers, times and weekdays are fine. No real company, brand or person names.".to_owned(),
        "No marketing language and no sales pitches: nothing about offers, prices as promotions, deals or discounts, and no urgency or pressure. Nothing about email, mailboxes, deliverability, testing or warming up.".to_owned(),
        format!("Never use these words: {}.", prompt_forbidden_words().join(", ")),
        "Vary the voice of each thread: sentence length, warmth, formality, greetings and sign-offs, and how much detail is given. Do not start threads the same way. Avoid stock phrases such as \"I hope this email finds you well\".".to_owned(),
        "The subject is a short plain phrase of 2 to 7 words without \"Re:\" or \"Fwd:\". Output JSON only, with one thread per brief, in the order of the briefs.".to_owned(),
    ]
    .join("\n")
}

/// `buildBatchPrompt(briefs)`.
pub fn build_batch_prompt(briefs: &[ThreadBrief]) -> String {
    let lines: Vec<String> = briefs
        .iter()
        .enumerate()
        .map(|(index, brief)| {
            format!(
                "Brief {}: topic \"{}\"; exactly {} messages; tone: {}; format: {}; length: {}.",
                index + 1,
                brief.topic,
                brief.message_count,
                brief.tone,
                brief.format,
                brief.length
            )
        })
        .collect();
    format!(
        "Write {} separate email threads, one for each brief.\n\n{}",
        briefs.len(),
        lines.join("\n")
    )
}

/// `batchSchema`.
pub fn batch_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "threads": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "subject": { "type": "string" },
                        "messages": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "author": { "type": "string", "enum": ["starter", "responder"] },
                                    "body": { "type": "string" },
                                },
                                "required": ["author", "body"],
                                "additionalProperties": false,
                            },
                        },
                    },
                    "required": ["subject", "messages"],
                    "additionalProperties": false,
                },
            },
        },
        "required": ["threads"],
        "additionalProperties": false,
    })
}

/// `sanitizeGeneratedText(text)`: the typographic characters models like,
/// folded to the plain ones a person types.
pub fn sanitize_generated_text(text: &str) -> String {
    let folded = text
        .replace("\r\n", "\n")
        .replace(['\u{2018}', '\u{2019}'], "'")
        .replace(['\u{201C}', '\u{201D}'], "\"")
        .replace('\u{2026}', "...")
        .replace(['\u{2014}', '\u{2013}'], " - ")
        .replace('\u{00A0}', " ");
    let lines: Vec<String> = folded
        .split('\n')
        .map(|line| {
            let mut out = String::with_capacity(line.len());
            let mut spaces = 0;
            for c in line.chars() {
                if c == ' ' {
                    spaces += 1;
                } else {
                    if spaces > 0 {
                        out.push(' ');
                    }
                    spaces = 0;
                    out.push(c);
                }
            }
            if spaces > 0 {
                out.push(' ');
            }
            weldsuite_reach_domain::text::js_trim_end(&out).to_owned()
        })
        .collect();
    let mut joined = lines.join("\n");
    while joined.contains("\n\n\n") {
        joined = joined.replace("\n\n\n", "\n\n");
    }
    js_trim(&joined).to_owned()
}

/// `cleanSubject(subject)`: one line, no `Re:` / `Fwd:` / `Fw:`, no full stop.
fn clean_subject(subject: &str) -> String {
    let line = sanitize_generated_text(subject).replace('\n', " ");
    let mut rest = line.as_str();
    loop {
        let lower = rest.to_ascii_lowercase();
        let prefixed = ["re:", "fwd:", "fw:"]
            .iter()
            .any(|prefix| lower.starts_with(prefix));
        if !prefixed {
            break;
        }
        let colon = rest.find(':').unwrap_or_default();
        rest = js_trim(&rest[colon + 1..]);
    }
    rest.strip_suffix('.').unwrap_or(rest).to_owned()
}

/// `toCandidate(draft, id)`: a model draft shaped into a thread candidate;
/// anything off-shape fails validation.
fn to_candidate(draft: &Value, id: &str) -> Value {
    let (Some(subject), Some(messages)) = (
        draft.get("subject").and_then(Value::as_str),
        draft.get("messages").and_then(Value::as_array),
    ) else {
        return Value::Null;
    };
    let messages: Vec<Value> = messages
        .iter()
        .map(
            |message| match message.get("body").and_then(Value::as_str) {
                Some(body) if message.is_object() => json!({
                    "author": message.get("author").cloned().unwrap_or(Value::Null),
                    "body": sanitize_generated_text(body),
                }),
                _ => Value::Null,
            },
        )
        .collect();
    json!({ "id": id, "subject": clean_subject(subject), "messages": messages })
}

/// `threadId(now, sequence)`: `gen-<yyyy>-<mm>-<nnn>`.
fn thread_id(year: i32, month: u8, sequence: usize) -> String {
    format!("gen-{year}-{month:02}-{sequence:03}")
}

/// `ThreadCollector`: valid drafts, one per subject.
struct ThreadCollector {
    year: i32,
    month: u8,
    threads: Vec<CorpusThread>,
    subjects: Vec<String>,
    rejected: usize,
}

impl ThreadCollector {
    fn add(&mut self, draft: &Value) {
        let candidate = to_candidate(
            draft,
            &thread_id(self.year, self.month, self.threads.len() + 1),
        );
        let Some(thread) = parse_corpus_thread(&candidate) else {
            self.rejected += 1;
            return;
        };
        let key = thread.subject.to_lowercase();
        if self.subjects.contains(&key) {
            self.rejected += 1;
            return;
        }
        self.subjects.push(key);
        self.threads.push(thread);
    }
}

/// The call: the fixed feature `reach-warmup`, drafting at the quality tier,
/// unmetered (no master database: WeldSuite pays).
fn corpus_call() -> AiCall {
    AiCall::new(
        "reach-warmup",
        Feature::ReachWarmup,
        Task::Draft,
        Tier::Quality,
    )
    .op("reach_warmup_corpus")
}

/// `generateBatch(ai, batchIndex)`: the drafts of one batch.
async fn generate_batch(ai: &Ai, batch_index: usize) -> Result<Vec<Value>, weldsuite_ai::AiError> {
    let request = ChatRequest::system_user(
        system_prompt(),
        build_batch_prompt(&build_batch_plan(batch_index, THREADS_PER_BATCH)),
    )
    .schema("warmup_threads", batch_schema())
    .temperature(0.9)
    .max_tokens(MAX_OUTPUT_TOKENS);
    let answer = ai.chat(&corpus_call(), request).await?;
    Ok(answer
        .object
        .as_ref()
        .and_then(|object| object.get("threads"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// `collectThreads(ai, now)`: every batch, a few at a time, keeping the
/// drafts that pass validation.
async fn collect_threads(ai: &Ai, year: i32, month: u8) -> Vec<CorpusThread> {
    let mut collector = ThreadCollector {
        year,
        month,
        threads: Vec::new(),
        subjects: Vec::new(),
        rejected: 0,
    };
    let batches: Vec<usize> = (0..BATCH_COUNT).collect();
    for round in batches.chunks(BATCH_CONCURRENCY) {
        let results = futures_util::future::join_all(
            round
                .iter()
                .map(|batch_index| generate_batch(ai, *batch_index)),
        )
        .await;
        for result in results {
            match result {
                Ok(drafts) => drafts.iter().for_each(|draft| collector.add(draft)),
                Err(error) => tracing::warn!(%error, "[reach-warmup] corpus batch failed"),
            }
        }
    }
    if collector.rejected > 0 {
        tracing::warn!(
            rejected = collector.rejected,
            "[reach-warmup] corpus refresh dropped threads that failed validation"
        );
    }
    collector.threads
}

/// When the stored set was generated (epoch ms), or `None` without a
/// readable meta.
async fn read_generated_at(master: &PgPool) -> sqlx::Result<Option<i64>> {
    let meta = read_setting(master, CORPUS_META_KEY).await?;
    Ok(meta
        .as_ref()
        .and_then(|meta| meta.get("generatedAt"))
        .and_then(Value::as_str)
        .and_then(weldsuite_reach_domain::parse_iso)
        .map(weldsuite_reach_domain::epoch_ms))
}

/// `storeCorpus`: the replaced set kept as `previous` (threads planned or
/// mid-conversation still reference its ids), the new one as `latest`, the
/// meta last.
async fn store_corpus(master: &PgPool, threads: &[CorpusThread], now: i64) -> sqlx::Result<()> {
    let json: Vec<Value> = threads.iter().map(CorpusThread::to_json).collect();
    if let Some(replaced) = read_setting(master, CORPUS_LATEST_KEY).await? {
        write_setting(master, CORPUS_PREVIOUS_KEY, &replaced).await?;
    }
    write_setting(master, CORPUS_LATEST_KEY, &Value::Array(json)).await?;
    let meta = json!({
        "generatedAt": super::db::ts(now),
        "threads": threads.len(),
        "feature": Feature::ReachWarmup.as_str(),
    });
    write_setting(master, CORPUS_META_KEY, &meta).await
}

/// `refreshCorpus(env, now)`: a new set when the stored one is older than
/// 30 days (or there is none). A no-op without AI. Keeps the old set when
/// fewer than [`MIN_GENERATED_THREADS`] threads pass. Never fails.
pub async fn refresh_corpus(master: &PgPool, ai: Option<&Ai>, now: i64) -> bool {
    let Some(ai) = ai.filter(|ai| ai.enabled()) else {
        return false;
    };
    let generated_at = match read_generated_at(master).await {
        Ok(at) => at,
        Err(error) => {
            tracing::warn!(%error, "[reach-warmup] corpus refresh failed");
            return false;
        }
    };
    if generated_at.is_some_and(|at| now - at < CORPUS_MAX_AGE_MS) {
        return false;
    }
    let at = weldsuite_reach_domain::from_epoch_ms(now);
    let threads = collect_threads(ai, at.year(), u8::from(at.month())).await;
    if threads.len() < MIN_GENERATED_THREADS {
        tracing::warn!(
            valid = threads.len(),
            needed = MIN_GENERATED_THREADS,
            "[reach-warmup] corpus refresh produced too few valid threads; keeping the current set"
        );
        return false;
    }
    if let Err(error) = store_corpus(master, &threads, now).await {
        tracing::warn!(%error, "[reach-warmup] corpus refresh failed");
        return false;
    }
    reset_corpus_cache();
    true
}

#[cfg(test)]
mod tests {
    use weldsuite_ai::{AiConfig, FakeProvider};

    use super::*;

    #[test]
    fn batches_follow_the_typescript_plan() {
        let first = build_batch_plan(0, THREADS_PER_BATCH);
        assert_eq!(first.len(), 10);
        assert_eq!(
            first[0],
            ThreadBrief {
                topic: "scheduling a call or a meeting",
                message_count: 2,
                tone: "warm and friendly",
                format: "a greeting with the first name and a sign-off with the first name",
                length: "three or four sentences per message",
            }
        );
        let later = build_batch_plan(3, THREADS_PER_BATCH);
        // slot 31: topic 217 % 64 = 25, count 31 % 10 = 1, tone (155 + 3) % 6 = 2,
        // format 93 % 5 = 3, length 63 % 4 = 3.
        assert_eq!(later[1].topic, TOPICS[25]);
        assert_eq!(later[1].message_count, 3);
        assert_eq!(later[1].tone, TONES[2]);
        assert_eq!(later[1].format, FORMATS[3]);
        assert_eq!(later[1].length, LENGTHS[3]);
        let prompt = build_batch_prompt(&first[..1]);
        assert_eq!(
            prompt,
            "Write 1 separate email threads, one for each brief.\n\nBrief 1: topic \"scheduling a call or a meeting\"; exactly 2 messages; tone: warm and friendly; format: a greeting with the first name and a sign-off with the first name; length: three or four sentences per message."
        );
        assert!(system_prompt().contains("Never use these words: warmup, deliverability, inbox,"));
        assert!(!system_prompt().contains("warm-up"));
    }

    #[test]
    fn generated_text_is_folded_to_what_a_person_types() {
        assert_eq!(
            sanitize_generated_text(
                "\u{201C}Hi\u{201D} \u{2014} it\u{2019}s  fine\u{2026}\r\n\n\n\nBest,\u{00A0}  \n"
            ),
            "\"Hi\" - it's fine...\n\nBest,"
        );
        assert_eq!(
            clean_subject("Re: Fwd: Moving our meeting."),
            "Moving our meeting"
        );
        assert_eq!(clean_subject("Fw:  Quick question"), "Quick question");
        assert_eq!(thread_id(2026, 11, 7), "gen-2026-11-007");
    }

    #[test]
    fn drafts_are_validated_and_one_per_subject() {
        let mut collector = ThreadCollector {
            year: 2026,
            month: 11,
            threads: Vec::new(),
            subjects: Vec::new(),
            rejected: 0,
        };
        let good = json!({
            "subject": "Re: Moving our meeting.",
            "messages": [
                { "author": "starter", "body": "Hi {{recipientFirstName}}, can we move our meeting to Friday morning?\n\nThanks,\n{{senderFirstName}}" },
                { "author": "responder", "body": "Friday morning works for me, see you then.\n\n{{senderFirstName}}" },
            ],
        });
        collector.add(&good);
        collector.add(&good);
        collector.add(&json!({ "subject": "Free offer", "messages": [] }));
        collector.add(&json!("not a thread"));
        assert_eq!(collector.threads.len(), 1);
        assert_eq!(collector.threads[0].id, "gen-2026-11-001");
        assert_eq!(collector.threads[0].subject, "Moving our meeting");
        assert_eq!(collector.rejected, 3);
    }

    #[tokio::test]
    async fn a_batch_asks_the_install_model_for_json() {
        let env = |name: &str| match name {
            "AI_DEFAULT_PROVIDER" => Some("mistral".to_owned()),
            "MISTRAL_API_KEY" => Some("mistral-key".to_owned()),
            _ => None,
        };
        let mut problems = Vec::new();
        let config = AiConfig::from_lookup(&env, &mut problems);
        let fake = FakeProvider::new()
            .reply_json(&json!({ "threads": [{ "subject": "Lunch", "messages": [] }] }));
        let ai = Ai::fake(config, fake.clone());
        let drafts = generate_batch(&ai, 0).await.expect("drafts");
        assert_eq!(drafts.len(), 1);
        let calls = fake.calls();
        assert_eq!(calls[0].url, "https://api.mistral.ai/v1/chat/completions");
        assert_eq!(calls[0].model().as_deref(), Some("mistral-large-4-0"));
        assert_eq!(calls[0].body["response_format"]["type"], "json_schema");
        assert!(
            calls[0].body["messages"][1]["content"]
                .as_str()
                .is_some_and(|prompt| prompt.starts_with("Write 10 separate email threads"))
        );
    }

    #[tokio::test]
    async fn without_ai_nothing_is_refreshed() {
        let master = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://reach@127.0.0.1:1/never")
            .expect("a lazy pool");
        assert!(!refresh_corpus(&master, None, 0).await);
    }
}
