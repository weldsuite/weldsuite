//! `helpdesk-workflow-worker/src/lib/channel-dispatch.ts`: a step's
//! customer-facing output, sent to the conversation's Discord channel or
//! Slack thread (the widget gets it through the realtime refetch hint
//! instead). Over the [`DeskHttp`](crate::http::DeskHttp) port.

use serde_json::{Map, Value, json};
use weldsuite_db::PgPool;

use super::shared::{js_string, truthy};
use crate::http::{DynDeskHttp, HttpRequest};

const DISCORD_API: &str = "https://discord.com/api/v10";
const BLURPLE: i64 = 0x0058_65F2;

/// What one dispatch needs (`DispatchContext`).
pub struct Dispatch<'a> {
    pub db: &'a PgPool,
    pub http: Option<&'a DynDeskHttp>,
    /// `DISCORD_BOT_TOKEN`.
    pub discord_bot_token: Option<&'a str>,
    pub conversation_id: &'a str,
    pub channel: &'a str,
    pub step_type: &'a str,
    pub step_result: &'a Value,
}

/// `dispatchStepToChannel(ctx)`: never fails, as the TypeScript swallows
/// (and logs) every error.
pub async fn dispatch_step_to_channel(ctx: &Dispatch<'_>) {
    let outcome = match ctx.channel {
        "discord" => dispatch_to_discord(ctx).await,
        "slack" => dispatch_to_slack(ctx).await,
        _ => Ok(()),
    };
    if let Err(error) = outcome {
        tracing::error!(
            %error,
            step_type = ctx.step_type,
            channel = ctx.channel,
            "[ChannelDispatch] Failed to dispatch"
        );
    }
}

/// `(a || b || …)` over a result's fields, else `''`.
fn first_truthy(result: &Value, keys: &[&str]) -> Value {
    keys.iter()
        .map(|key| result.get(*key))
        .find(|value| truthy(*value))
        .flatten()
        .cloned()
        .unwrap_or_else(|| json!(""))
}

/// `` `${value}` ``.
fn template(value: &Value) -> String {
    js_string(Some(value))
}

fn list(result: &Value, key: &str) -> Vec<Value> {
    match result.get(key) {
        Some(Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

/// `text || fallback`.
fn or_text(text: &Value, fallback: &str) -> Value {
    if truthy(Some(text)) {
        text.clone()
    } else {
        json!(fallback)
    }
}

/// `str.slice(0, max)` in UTF-16 units.
fn slice_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out
}

async fn conversation_metadata(
    db: &PgPool,
    conversation_id: &str,
) -> Result<Option<Map<String, Value>>, String> {
    let metadata: Option<Option<Value>> =
        sqlx::query_scalar("select metadata from helpdesk_conversations where id = $1 limit 1")
            .bind(conversation_id)
            .fetch_optional(db)
            .await
            .map_err(|error| error.to_string())?;
    Ok(match metadata.flatten() {
        Some(Value::Object(map)) => Some(map),
        _ => None,
    })
}

fn csat_button_style(rating: i64) -> i64 {
    if rating <= 2 {
        4
    } else if rating == 3 {
        2
    } else {
        3
    }
}

/// The Discord message body for a step, or `None` when there is nothing to send.
fn discord_body(ctx: &Dispatch<'_>) -> Option<Value> {
    let result = ctx.step_result;
    let text = first_truthy(result, &["content", "message", "aiContent"]);
    let step_id = || first_truthy(result, &["stepId", "messageId"]);
    match ctx.step_type {
        "send_choices" => {
            let step_id = template(&step_id());
            let buttons: Vec<Value> = list(result, "options")
                .iter()
                .take(5)
                .map(|opt| {
                    json!({
                        "type": 2,
                        "style": 1,
                        "label": slice_utf16(&template(&opt["label"]), 80),
                        "custom_id": format!("wf_choice:{}:{step_id}:{}", ctx.conversation_id, template(&opt["value"])),
                    })
                })
                .collect();
            Some(json!({
                "embeds": [{ "description": or_text(&text, "Please select an option:"), "color": BLURPLE }],
                "components": [{ "type": 1, "components": buttons }],
            }))
        }
        "trigger_csat" => {
            let step_id = template(&step_id());
            let buttons: Vec<Value> = (1..=5)
                .map(|rating| {
                    json!({
                        "type": 2,
                        "style": csat_button_style(rating),
                        "label": rating.to_string(),
                        "custom_id": format!("wf_csat:{}:{step_id}:{rating}", ctx.conversation_id),
                    })
                })
                .collect();
            Some(json!({
                "embeds": [{ "description": or_text(&text, "How would you rate your experience?"), "color": BLURPLE }],
                "components": [{ "type": 1, "components": buttons }],
            }))
        }
        "collect_input" | "collect_customer_info" => {
            let field_list = list(result, "fields")
                .iter()
                .map(|f| {
                    let bold = if truthy(f.get("required")) { "**" } else { "" };
                    format!("{bold}{}{bold}", template(&f["label"]))
                })
                .collect::<Vec<_>>()
                .join("\n- ");
            Some(json!({
                "embeds": [{
                    "description": or_text(&text, "Please provide the following information:"),
                    "fields": [{ "name": "Required information", "value": format!("- {field_list}") }],
                    "footer": { "text": "Please reply in this thread with the requested details." },
                    "color": BLURPLE,
                }],
            }))
        }
        "suggest_articles" => {
            let articles = list(result, "articles");
            if articles.is_empty() && !truthy(Some(&text)) {
                return None;
            }
            let article_list = articles
                .iter()
                .map(|a| format!("- {}", template(&a["title"])))
                .collect::<Vec<_>>()
                .join("\n");
            let description = if truthy(Some(&text)) {
                format!("{}\n\n{article_list}", template(&text))
            } else {
                article_list
            };
            Some(json!({
                "embeds": [{ "title": "Suggested Articles", "description": description, "color": BLURPLE }],
            }))
        }
        _ => truthy(Some(&text)).then(|| json!({ "content": text })),
    }
}

async fn dispatch_to_discord(ctx: &Dispatch<'_>) -> Result<(), String> {
    let Some(token) = ctx.discord_bot_token.filter(|t| !t.is_empty()) else {
        tracing::warn!("[ChannelDispatch:Discord] No DISCORD_BOT_TOKEN configured");
        return Ok(());
    };
    let Some(metadata) = conversation_metadata(ctx.db, ctx.conversation_id).await? else {
        return Ok(());
    };
    let Some(channel_id) = metadata
        .get("discordChannelId")
        .filter(|v| truthy(Some(*v)))
    else {
        return Ok(());
    };
    let Some(body) = discord_body(ctx) else {
        return Ok(());
    };
    let Some(http) = ctx.http else {
        return Ok(());
    };
    let request = HttpRequest {
        method: "POST",
        url: format!("{DISCORD_API}/channels/{}/messages", template(channel_id)),
        headers: vec![
            ("Authorization".to_owned(), format!("Bot {token}")),
            ("Content-Type".to_owned(), "application/json".to_owned()),
        ],
        body: Some(body.to_string()),
    };
    match http.send(request).await {
        Ok(response) if !response.ok() => tracing::error!(
            status = response.status,
            body = %response.body,
            "[ChannelDispatch:Discord] API error"
        ),
        Ok(_) => {}
        Err(error) => tracing::error!(%error, "[ChannelDispatch:Discord] Failed to send"),
    }
    Ok(())
}

/// The Slack blocks for a step (`None`: a plain message).
fn slack_blocks(ctx: &Dispatch<'_>, text: &Value) -> Option<Value> {
    let result = ctx.step_result;
    let step_id = template(&or_text(&first_truthy(result, &["stepId"]), ""));
    let section =
        |text: Value| json!({ "type": "section", "text": { "type": "mrkdwn", "text": text } });
    match ctx.step_type {
        "send_choices" => {
            let elements: Vec<Value> = list(result, "options")
                .iter()
                .map(|opt| {
                    json!({
                        "type": "button",
                        "text": { "type": "plain_text", "text": opt.get("label"), "emoji": true },
                        "action_id": format!("wf_choice:{}:{step_id}:{}", ctx.conversation_id, template(&opt["value"])),
                        "value": opt.get("value"),
                    })
                })
                .collect();
            Some(json!([
                section(or_text(text, "Please select an option:")),
                { "type": "actions", "block_id": format!("wf_choices_{step_id}"), "elements": elements },
            ]))
        }
        "trigger_csat" => {
            let ratings = [
                ("1", "\u{1F61E}"),
                ("2", "\u{1F641}"),
                ("3", "\u{1F610}"),
                ("4", "\u{1F642}"),
                ("5", "\u{1F60A}"),
            ];
            let elements: Vec<Value> = ratings
                .iter()
                .map(|(value, emoji)| {
                    json!({
                        "type": "button",
                        "text": { "type": "plain_text", "text": format!("{emoji} {value}"), "emoji": true },
                        "action_id": format!("wf_csat:{}:{step_id}:{value}", ctx.conversation_id),
                        "value": value,
                    })
                })
                .collect();
            Some(json!([
                section(or_text(text, "How would you rate your experience?")),
                { "type": "actions", "block_id": format!("wf_csat_{step_id}"), "elements": elements },
            ]))
        }
        "collect_input" | "collect_customer_info" => {
            let field_list = list(result, "fields")
                .iter()
                .map(|f| {
                    let star = if truthy(f.get("required")) { "*" } else { "" };
                    format!("{star}{}{star}", template(&f["label"]))
                })
                .collect::<Vec<_>>()
                .join("\n- ");
            Some(json!([
                section(or_text(text, "Please provide the following information:")),
                section(json!(format!(
                    "- {field_list}\n\n_Please reply in this thread._"
                ))),
            ]))
        }
        _ => None,
    }
}

async fn dispatch_to_slack(ctx: &Dispatch<'_>) -> Result<(), String> {
    let Some(metadata) = conversation_metadata(ctx.db, ctx.conversation_id).await? else {
        return Ok(());
    };
    let Some(channel_id) = metadata.get("slackChannelId").filter(|v| truthy(Some(*v))) else {
        return Ok(());
    };
    let integration: Option<(String, Option<Value>)> = sqlx::query_as(
        "select status, config from helpdesk_channel_integrations
         where provider = 'slack' and deleted_at is null limit 1",
    )
    .fetch_optional(ctx.db)
    .await
    .map_err(|error| error.to_string())?;
    let Some((status, config)) = integration else {
        return Ok(());
    };
    if status != "connected" {
        return Ok(());
    }
    let Some(token) = config
        .as_ref()
        .and_then(|config| config.get("botToken"))
        .filter(|t| truthy(Some(*t)))
    else {
        return Ok(());
    };
    let text = first_truthy(ctx.step_result, &["content", "message"]);
    let mut body = Map::new();
    body.insert("channel".to_owned(), channel_id.clone());
    body.insert(
        "text".to_owned(),
        or_text(&text, "New message from support"),
    );
    if let Some(thread) = metadata.get("slackThreadTs").filter(|v| truthy(Some(*v))) {
        body.insert("thread_ts".to_owned(), thread.clone());
    }
    if let Some(blocks) = slack_blocks(ctx, &text) {
        body.insert("blocks".to_owned(), blocks);
    }
    let Some(http) = ctx.http else {
        return Ok(());
    };
    let response = http
        .send(HttpRequest {
            method: "POST",
            url: "https://slack.com/api/chat.postMessage".to_owned(),
            headers: vec![
                (
                    "Authorization".to_owned(),
                    format!("Bearer {}", template(token)),
                ),
                ("Content-Type".to_owned(), "application/json".to_owned()),
            ],
            body: Some(Value::Object(body).to_string()),
        })
        .await?;
    let answer: Value = serde_json::from_str(&response.body).map_err(|error| error.to_string())?;
    if answer.get("ok").and_then(Value::as_bool) != Some(true) {
        tracing::error!(error = %answer["error"], "[ChannelDispatch:Slack] API error");
    }
    Ok(())
}
