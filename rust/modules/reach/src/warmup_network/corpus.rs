//! `corpus/*.ts`: the plain-text threads warmup mail is written from, and
//! rendering one message for a pair of people.
//!
//! The built-in English set (`builtin_corpus.json`) is reach-warmup-worker's
//! `BUILTIN_CORPUS`, exported by `pnpm rust:reach-warmup-fixtures` (its
//! check fails when the two drift). A model writes a fresh set monthly
//! ([`super::generate`], with the install's AI); it is kept in the master
//! database's `system_settings` (Global: R2), where the planner (`cron`) and
//! the sender and engager (`cron` or `consume`) all read it. Without AI, or
//! while the stored set has too few valid threads, the built-in set is used.

use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use weldsuite_reach_domain::text::{collapse_spaces, js_trim, js_trim_end};

use super::validate::parse_corpus_threads;

/// The set the planner reads (`CORPUS_LATEST_KEY`), as a `system_settings`
/// key of the master database.
pub const CORPUS_LATEST_KEY: &str = "reach-warmup.corpus.latest";
/// The set a refresh replaced: mail planned before it still renders from it.
pub const CORPUS_PREVIOUS_KEY: &str = "reach-warmup.corpus.previous";
/// `{ generatedAt }`: when the latest set was produced.
pub const CORPUS_META_KEY: &str = "reach-warmup.corpus.meta";
/// A stored set with fewer valid threads is ignored for the built-in one.
pub const MIN_STORED_THREADS: usize = 30;
/// How long a process keeps the loaded sets (`CORPUS_CACHE_TTL_MS`).
const CORPUS_CACHE_TTL: Duration = Duration::from_hours(1);

/// `CorpusMessage`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CorpusMessage {
    /// `starter` or `responder`.
    pub author: String,
    pub body: String,
}

/// `CorpusThread`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CorpusThread {
    pub id: String,
    pub subject: String,
    pub messages: Vec<CorpusMessage>,
}

/// `CorpusPerson`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CorpusPerson {
    pub first_name: String,
    pub last_name: String,
}

/// `RenderedCorpusMessage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedCorpusMessage {
    pub subject: String,
    pub text: String,
}

/// `BUILTIN_CORPUS`.
pub static BUILTIN_CORPUS: LazyLock<Vec<CorpusThread>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("builtin_corpus.json")).expect("the built-in corpus")
});

/// The built-in set.
pub fn corpus() -> &'static [CorpusThread] {
    &BUILTIN_CORPUS
}

/// A built-in thread by id.
pub fn find_thread(id: &str) -> Option<&'static CorpusThread> {
    corpus().iter().find(|t| t.id == id)
}

impl CorpusThread {
    /// As stored: `{ id, subject, messages: [{ author, body }] }`.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "subject": self.subject,
            "messages": self
                .messages
                .iter()
                .map(|m| json!({ "author": m.author, "body": m.body }))
                .collect::<Vec<_>>(),
        })
    }
}

/// A `system_settings` value of the master database.
pub(crate) async fn read_setting(master: &PgPool, key: &str) -> sqlx::Result<Option<Value>> {
    let value: Option<Option<Value>> =
        sqlx::query_scalar("select value from system_settings where key = $1 limit 1")
            .bind(key)
            .fetch_optional(master)
            .await?;
    Ok(value.flatten())
}

/// Writes a `system_settings` value, creating the row on first use.
pub(crate) async fn write_setting(master: &PgPool, key: &str, value: &Value) -> sqlx::Result<()> {
    sqlx::query(
        "insert into system_settings (id, key, category, value, description, data_type, updated_by)
         values ($1, $2, 'general', $3, 'WeldReach warmup corpus (refreshed monthly)', 'json', 'reach-warmup')
         on conflict (key) do update set value = excluded.value, updated_at = now()",
    )
    .bind(weldsuite_kit::generate_id("sset"))
    .bind(key)
    .bind(value)
    .execute(master)
    .await?;
    Ok(())
}

/// The sets one process holds, and when they were read.
struct Loaded {
    at: Instant,
    current: Arc<Vec<CorpusThread>>,
    lookup: Arc<Vec<CorpusThread>>,
}

static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);

/// `resetCorpusCache()`: forget the loaded sets (after a refresh wrote one).
pub fn reset_corpus_cache() {
    *LOADED.lock().unwrap_or_else(PoisonError::into_inner) = None;
}

/// The stored set when it has enough valid threads (`readStoredCorpus`).
async fn read_stored(master: &PgPool) -> Option<Vec<CorpusThread>> {
    match read_setting(master, CORPUS_LATEST_KEY).await {
        Ok(Some(value)) => {
            let threads = parse_corpus_threads(&value);
            if threads.len() < MIN_STORED_THREADS {
                tracing::warn!(
                    valid = threads.len(),
                    needed = MIN_STORED_THREADS,
                    "[reach-warmup] stored corpus has too few valid threads; using the built-in set"
                );
                return None;
            }
            Some(threads)
        }
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(%error, "[reach-warmup] stored corpus unreadable; using the built-in set");
            None
        }
    }
}

/// The set a refresh replaced (`readPreviousCorpus`), or none.
async fn read_previous(master: &PgPool) -> Vec<CorpusThread> {
    match read_setting(master, CORPUS_PREVIOUS_KEY).await {
        Ok(value) => value.map(|v| parse_corpus_threads(&v)).unwrap_or_default(),
        Err(error) => {
            tracing::warn!(%error, "[reach-warmup] previous corpus unreadable");
            Vec::new()
        }
    }
}

async fn loaded(master: &PgPool) -> (Arc<Vec<CorpusThread>>, Arc<Vec<CorpusThread>>) {
    if let Some(loaded) = LOADED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .filter(|loaded| loaded.at.elapsed() < CORPUS_CACHE_TTL)
    {
        return (Arc::clone(&loaded.current), Arc::clone(&loaded.lookup));
    }
    let current = read_stored(master)
        .await
        .unwrap_or_else(|| (*BUILTIN_CORPUS).clone());
    let previous = read_previous(master).await;
    // By id, the later set winning, in order of first appearance.
    let mut lookup: Vec<CorpusThread> = Vec::new();
    for thread in BUILTIN_CORPUS.iter().chain(&previous).chain(&current) {
        match lookup.iter_mut().find(|t| t.id == thread.id) {
            Some(existing) => *existing = thread.clone(),
            None => lookup.push(thread.clone()),
        }
    }
    let (current, lookup) = (Arc::new(current), Arc::new(lookup));
    *LOADED.lock().unwrap_or_else(PoisonError::into_inner) = Some(Loaded {
        at: Instant::now(),
        current: Arc::clone(&current),
        lookup: Arc::clone(&lookup),
    });
    (current, lookup)
}

/// `loadCorpus(env)`: the stored generated set when it has at least
/// [`MIN_STORED_THREADS`] valid threads, else the built-in set. Never empty.
pub async fn load_corpus(master: &PgPool) -> Arc<Vec<CorpusThread>> {
    loaded(master).await.0
}

/// `loadCorpusForLookup(env)`: every thread warmup mail may still reference
/// (the built-in set, the one the last refresh replaced, the current one).
/// The sender and the engager look threads up here, so mail planned before
/// a refresh still renders; the planner picks new threads from
/// [`load_corpus`].
pub async fn load_corpus_for_lookup(master: &PgPool) -> Arc<Vec<CorpusThread>> {
    loaded(master).await.1
}

static COLLAPSE_SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(" {2,}").expect("pattern"));
static SPACE_BEFORE_PUNCTUATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(" ([,.;:!?])").expect("pattern"));
static BLANK_LINE_RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new("\n{3,}").expect("pattern"));

fn clean_name(value: &str) -> String {
    js_trim(&value.replace(['{', '}'], "")).to_owned()
}

fn tidy_after_blank(text: &str) -> String {
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let line = COLLAPSE_SPACES.replace_all(line, " ");
            let line = SPACE_BEFORE_PUNCTUATION.replace_all(&line, "$1");
            js_trim_end(&line).to_owned()
        })
        .collect();
    let joined = lines.join("\n");
    js_trim(&BLANK_LINE_RUNS.replace_all(&joined, "\n\n")).to_owned()
}

/// `fillPlaceholders(template, values)`.
pub fn fill_placeholders(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::new();
    let mut pos = 0;
    let mut blanked = false;
    loop {
        let Some(open) = template[pos..].find("{{").map(|i| i + pos) else {
            out.push_str(&template[pos..]);
            break;
        };
        out.push_str(&template[pos..open]);
        let Some(close) = template[open + 2..].find("}}").map(|i| i + open + 2) else {
            out.push_str(&template[open + 2..].replace("{{", ""));
            blanked = true;
            break;
        };
        let name = js_trim(&template[open + 2..close]);
        let value = values
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| clean_name(value))
            .unwrap_or_default();
        if value.is_empty() {
            blanked = true;
        }
        out.push_str(&value);
        pos = close + 2;
    }
    if blanked { tidy_after_blank(&out) } else { out }
}

fn strip_reply_prefix(subject: &str) -> String {
    let mut rest = js_trim(subject).to_owned();
    while rest.len() >= 3 && rest.is_char_boundary(3) && rest[..3].eq_ignore_ascii_case("re:") {
        rest = js_trim(&rest[3..]).to_owned();
    }
    rest
}

/// `renderCorpusMessage(thread, step, sender, recipient)`.
pub fn render_corpus_message(
    thread: &CorpusThread,
    step: i64,
    sender: &CorpusPerson,
    recipient: &CorpusPerson,
) -> Result<RenderedCorpusMessage, String> {
    let message = usize::try_from(step)
        .ok()
        .and_then(|s| thread.messages.get(s))
        .ok_or_else(|| {
            format!(
                "renderCorpusMessage: step {step} is out of range for thread \"{}\" ({} messages)",
                thread.id,
                thread.messages.len()
            )
        })?;
    let values = [
        ("senderFirstName", sender.first_name.as_str()),
        ("senderLastName", sender.last_name.as_str()),
        ("recipientFirstName", recipient.first_name.as_str()),
        ("recipientLastName", recipient.last_name.as_str()),
    ];
    let subject = strip_reply_prefix(&collapse_spaces(&fill_placeholders(
        &thread.subject,
        &values,
    )));
    Ok(RenderedCorpusMessage {
        subject: if step == 0 {
            subject
        } else {
            format!("Re: {subject}")
        },
        text: fill_placeholders(&message.body, &values),
    })
}
