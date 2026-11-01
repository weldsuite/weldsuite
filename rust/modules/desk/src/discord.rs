//! `lib/discord.ts`: the Discord REST calls the desk makes with the bot
//! token (`https://discord.com/api/v10`).

use serde_json::json;
use weldsuite_desk_domain::http::{DeskHttp, HttpRequest};

const DISCORD_API_BASE: &str = "https://discord.com/api/v10";

fn bot_headers(token: &str) -> Vec<(String, String)> {
    vec![
        ("Authorization".to_owned(), format!("Bot {token}")),
        ("Content-Type".to_owned(), "application/json".to_owned()),
    ]
}

/// `sendMessage(botToken, channelId, content)`.
pub(crate) async fn send_message(
    http: Option<&std::sync::Arc<dyn DeskHttp>>,
    token: &str,
    channel_id: &str,
    content: &str,
) -> Result<(), String> {
    let http = http.ok_or("fetch is not available")?;
    let response = http
        .send(HttpRequest {
            method: "POST",
            url: format!("{DISCORD_API_BASE}/channels/{channel_id}/messages"),
            headers: bot_headers(token),
            body: Some(json!({ "content": content }).to_string()),
        })
        .await?;
    if !response.ok() {
        return Err(format!(
            "Discord API error ({}): {}",
            response.status, response.body
        ));
    }
    // `response.json()`: a body that is not JSON throws.
    serde_json::from_str::<serde_json::Value>(&response.body)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// `archiveThread(botToken, threadId)`.
pub(crate) async fn archive_thread(
    http: Option<&std::sync::Arc<dyn DeskHttp>>,
    token: &str,
    thread_id: &str,
) -> Result<(), String> {
    let http = http.ok_or("fetch is not available")?;
    let response = http
        .send(HttpRequest {
            method: "PATCH",
            url: format!("{DISCORD_API_BASE}/channels/{thread_id}"),
            headers: bot_headers(token),
            body: Some(json!({ "archived": true, "locked": true }).to_string()),
        })
        .await?;
    if !response.ok() {
        return Err(format!(
            "Discord API error ({}): {}",
            response.status, response.body
        ));
    }
    Ok(())
}

/// The closing note, then the archive (`archiveDiscordThreadIfTicket`).
pub(crate) async fn close_ticket_thread(
    http: Option<&std::sync::Arc<dyn DeskHttp>>,
    token: &str,
    thread_id: &str,
) -> Result<(), String> {
    send_message(
        http,
        token,
        thread_id,
        "This ticket has been closed by support.",
    )
    .await?;
    archive_thread(http, token, thread_id).await
}
