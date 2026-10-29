//! String helpers with JavaScript's semantics (lengths and slices in UTF-16
//! units, `trim`), and the message text rules: previews
//! (`@weldsuite/chat-domain/message-preview`), reply snippets
//! (`/reply-reference`) and channel slugs (`/create-channel`).

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};
use sqlx::PgPool;

/// `String.prototype.trim()`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `String.prototype.trimEnd()`.
pub fn js_trim_end(text: &str) -> &str {
    text.trim_end_matches(is_js_space)
}

fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `text.length`: UTF-16 code units.
pub fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, end)` in UTF-16 units. A surrogate pair cut in half keeps
/// its lone high half, as JavaScript does; it is written as U+FFFD here.
pub fn js_prefix(text: &str, end: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(end).collect();
    String::from_utf16_lossy(&units)
}

static MENTION_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<@([^>]+)>").expect("the mention pattern compiles"));
static FILE_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<@file:[^>]*>").expect("the file pattern compiles"));
static RUNS_OF_SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[ \t]{2,}").expect("the spaces pattern compiles"));
static OPEN_TOKEN_AT_END: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<@[^>]*$").expect("the open token pattern compiles"));

const PREVIEW_MAX_LENGTH: usize = 100;
const UNKNOWN_MENTION_LABEL: &str = "unknown";
const REPLY_SNIPPET_LENGTH: usize = 200;

/// Every `<@…>` token body in `content`, in order.
pub fn mention_bodies(content: &str) -> Vec<String> {
    MENTION_TOKEN
        .captures_iter(content)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_owned()))
        .collect()
}

/// `bareMentionIds`: the plain user or agent ids among the tokens.
pub fn bare_mention_ids(content: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for body in mention_bodies(content) {
        if body.contains(':') || body.contains('|') || body == "everyone" {
            continue;
        }
        if !ids.contains(&body) {
            ids.push(body);
        }
    }
    ids
}

fn mention_label(body: &str, names: &HashMap<String, String>) -> String {
    if let Some((_, label)) = body.split_once('|') {
        return if label.is_empty() {
            UNKNOWN_MENTION_LABEL.to_owned()
        } else {
            label.to_owned()
        };
    }
    if let Some((_, label)) = body.split_once(':') {
        return if label.is_empty() {
            UNKNOWN_MENTION_LABEL.to_owned()
        } else {
            label.to_owned()
        };
    }
    if body == "everyone" {
        return "everyone".to_owned();
    }
    names
        .get(body)
        .cloned()
        .unwrap_or_else(|| UNKNOWN_MENTION_LABEL.to_owned())
}

/// `formatMessagePreview`: tokens as `@Name`, inline files dropped, runs of
/// spaces folded, at most 100 characters.
#[allow(clippy::implicit_hasher)]
pub fn format_message_preview(content: &str, names: &HashMap<String, String>) -> String {
    let without_files = FILE_TOKEN.replace_all(content, "");
    let labelled = MENTION_TOKEN.replace_all(&without_files, |caps: &regex::Captures<'_>| {
        format!("@{}", mention_label(&caps[1], names))
    });
    let folded = RUNS_OF_SPACES.replace_all(&labelled, " ");
    let text = js_trim(&folded);
    if js_len(text) > PREVIEW_MAX_LENGTH {
        format!("{}...", js_prefix(text, PREVIEW_MAX_LENGTH))
    } else {
        text.to_owned()
    }
}

/// `resolveMentionNames`: the display names of the bare mentions.
pub async fn resolve_mention_names(
    db: &PgPool,
    content: &str,
) -> Result<HashMap<String, String>, sqlx::Error> {
    let mut names = HashMap::new();
    let ids = bare_mention_ids(content);
    if ids.is_empty() {
        return Ok(names);
    }
    let (agent_ids, user_ids): (Vec<String>, Vec<String>) =
        ids.into_iter().partition(|id| id.starts_with("agt_"));
    let mut rows: Vec<(String, Option<String>)> = Vec::new();
    if !user_ids.is_empty() {
        rows.extend(
            sqlx::query_as::<_, (String, Option<String>)>(
                "select user_id, name from workspace_members where user_id = any($1)",
            )
            .bind(&user_ids)
            .fetch_all(db)
            .await?,
        );
    }
    if !agent_ids.is_empty() {
        rows.extend(
            sqlx::query_as::<_, (String, Option<String>)>(
                "select id, name from weldagent_agents where id = any($1)",
            )
            .bind(&agent_ids)
            .fetch_all(db)
            .await?,
        );
    }
    for (id, name) in rows {
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            names.insert(id, name);
        }
    }
    Ok(names)
}

/// `buildMessagePreview`: a failed name lookup previews with `@unknown`.
pub async fn build_message_preview(db: &PgPool, content: &str) -> String {
    let names = match resolve_mention_names(db, content).await {
        Ok(names) => names,
        Err(error) => {
            tracing::error!(%error, "[chat-domain] mention name lookup for preview failed");
            HashMap::new()
        }
    };
    format_message_preview(content, &names)
}

/// `replySnippet`: the quoted text, cut at 200 characters without leaving
/// half a mention token.
pub fn reply_snippet(content: &str) -> String {
    if js_len(content) <= REPLY_SNIPPET_LENGTH {
        return content.to_owned();
    }
    let cut = js_prefix(content, REPLY_SNIPPET_LENGTH);
    let cut = OPEN_TOKEN_AT_END.replace(&cut, "");
    format!("{}…", js_trim_end(&cut))
}

/// `readReplyReference(metadata)`: `metadata.replyTo` when it has a string
/// `messageId`.
pub fn read_reply_reference(metadata: &Value) -> Option<&Value> {
    let reference = metadata.as_object()?.get("replyTo")?;
    reference
        .as_object()
        .filter(|r| r.get("messageId").is_some_and(Value::is_string))
        .map(|_| reference)
}

/// `buildReplyReference(target)`: the snapshot of the quoted message.
pub fn build_reply_reference(
    id: &str,
    author_id: &str,
    author_name: &str,
    author_avatar: Option<&str>,
    content: &str,
    has_attachments: Option<bool>,
    metadata: &Value,
) -> Value {
    let previous = read_reply_reference(metadata);
    let root_id = previous
        .and_then(|p| p.get("rootId"))
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| Value::String(id.to_owned()));
    let depth = previous
        .and_then(|p| p.get("depth"))
        .filter(|v| !v.is_null())
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        + 1.0;
    json!({
        "messageId": id,
        "rootId": root_id,
        "depth": js_number(depth),
        "authorId": author_id,
        "authorName": author_name,
        "authorAvatar": author_avatar,
        "content": reply_snippet(content),
        "hasAttachments": has_attachments == Some(true),
    })
}

/// A number as JSON the way JavaScript prints it: integral values without
/// a fraction.
pub fn js_number(value: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return Value::from(value as i64);
    }
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// JavaScript's `\s`, spelled out: the workspace builds `regex` without its
/// Unicode classes, so `\s` itself does not compile.
const JS_SPACE: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";
static NOT_SLUG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("[^a-z0-9{JS_SPACE}-]")).expect("the slug pattern compiles")
});
static SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("[{JS_SPACE}]+")).expect("the spaces pattern compiles"));
static DASHES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-+").expect("the dashes pattern compiles"));

/// `slugifyChannelName`: lowercase, only `a-z0-9`, spaces and dashes, then
/// dashes for spaces, at most 255 characters.
pub fn slugify_channel_name(name: &str) -> String {
    let lower = name.to_lowercase();
    let kept = NOT_SLUG.replace_all(&lower, "");
    let dashed = SPACES.replace_all(&kept, "-");
    let single = DASHES.replace_all(&dashed, "-");
    js_prefix(&single, 255)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_label_mentions_and_cut_long_text() {
        let mut names = HashMap::new();
        names.insert("user_1".to_owned(), "Ann".to_owned());
        assert_eq!(
            format_message_preview("hi <@user_1>  and <@task:t1|Fix it> <@file:a1>", &names),
            "hi @Ann and @Fix it"
        );
        assert_eq!(
            format_message_preview("<@user_2> <@everyone>", &names),
            "@unknown @everyone"
        );
        let long = "x".repeat(120);
        assert_eq!(
            format_message_preview(&long, &names),
            format!("{}...", "x".repeat(100))
        );
    }

    #[test]
    fn snippets_drop_an_open_token() {
        let content = format!("{}<@user_1>", "a".repeat(195));
        assert_eq!(reply_snippet(&content), format!("{}…", "a".repeat(195)));
    }

    #[test]
    fn slugs_like_the_create_route() {
        assert_eq!(slugify_channel_name("Engineering Team"), "engineering-team");
        assert_eq!(slugify_channel_name("slug clash!"), "slug-clash");
        assert_eq!(slugify_channel_name("🎉"), "");
        assert_eq!(slugify_channel_name("a  --  b"), "a-b");
    }
}
