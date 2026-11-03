//! `corpus/*.ts`: the plain-text threads warmup mail is written from, and
//! rendering one message for a pair of people.
//!
//! The built-in English set (`builtin_corpus.json`) is reach-warmup-worker's
//! `BUILTIN_CORPUS`, exported by `pnpm rust:reach-warmup-fixtures` (its
//! check fails when the two drift). Global refreshes a generated set monthly
//! with a model; there is no AI port here, so these editions always write
//! from the built-in set.

use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use weldsuite_reach_domain::text::{collapse_spaces, js_trim, js_trim_end};

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

/// `loadCorpus(env)` / `loadCorpusForLookup(env)`: the built-in set.
pub fn corpus() -> &'static [CorpusThread] {
    &BUILTIN_CORPUS
}

/// A thread by id.
pub fn find_thread(id: &str) -> Option<&'static CorpusThread> {
    corpus().iter().find(|t| t.id == id)
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
