//! The Discord and Slack calls of the channel integrations
//! (`services/integrations/discord.ts`, the Slack slice of
//! `@weldsuite/desk-domain/helpdesk-integrations`), through the desk's HTTP
//! port. Errors carry the message the TypeScript `Error` has.

use serde_json::{Value, json};
use weldsuite_desk_domain::http::{DynDeskHttp, HttpRequest, HttpResponse};
use weldsuite_ports::OutboundHttp;

const DISCORD_API_BASE: &str = "https://discord.com/api/v10";

async fn send(http: Option<&DynDeskHttp>, request: HttpRequest) -> Result<HttpResponse, String> {
    let http = http.ok_or("fetch failed")?;
    http.send(request).await
}

fn bot(token: &str) -> Vec<(String, String)> {
    vec![("Authorization".to_owned(), format!("Bot {token}"))]
}

fn bot_json(token: &str) -> Vec<(String, String)> {
    vec![
        ("Authorization".to_owned(), format!("Bot {token}")),
        ("Content-Type".to_owned(), "application/json".to_owned()),
    ]
}

/// `response.json()`.
fn json_of(response: &HttpResponse) -> Result<Value, String> {
    serde_json::from_str(&response.body).map_err(|error| error.to_string())
}

/// `discordFetch`: a failed status throws with Discord's body.
async fn discord_fetch(http: Option<&DynDeskHttp>, request: HttpRequest) -> Result<Value, String> {
    let response = send(http, request).await?;
    if !response.ok() {
        return Err(format!(
            "Discord API error ({}): {}",
            response.status, response.body
        ));
    }
    json_of(&response)
}

/// `snowflake(value, label)`: an id that can't add path segments.
fn snowflake<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    if (1..=25).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit()) {
        Ok(value)
    } else {
        Err(format!("Invalid Discord {label}"))
    }
}

fn get(url: String, headers: Vec<(String, String)>) -> HttpRequest {
    HttpRequest {
        method: "GET",
        url,
        headers,
        body: None,
    }
}

/// `getGuild(botToken, guildId)`.
pub(super) async fn get_guild(
    http: Option<&DynDeskHttp>,
    token: &str,
    guild_id: &str,
) -> Result<Value, String> {
    let guild = snowflake(guild_id, "guild id")?;
    discord_fetch(
        http,
        get(format!("{DISCORD_API_BASE}/guilds/{guild}"), bot(token)),
    )
    .await
}

fn form_post(url: String, body: String) -> HttpRequest {
    HttpRequest {
        method: "POST",
        url,
        headers: vec![(
            "Content-Type".to_owned(),
            "application/x-www-form-urlencoded".to_owned(),
        )],
        body: Some(body),
    }
}

/// `exchangeOAuthCode(clientId, clientSecret, code, redirectUri)`.
pub(super) async fn exchange_code(
    http: Option<&DynDeskHttp>,
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<Value, String> {
    let body = super::form_encode(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ]);
    discord_fetch(
        http,
        form_post(format!("{DISCORD_API_BASE}/oauth2/token"), body),
    )
    .await
}

/// `refreshOAuthToken(clientId, clientSecret, refreshToken)`.
pub(super) async fn refresh_token(
    http: Option<&DynDeskHttp>,
    client_id: &str,
    client_secret: &str,
    refresh: &str,
) -> Result<Value, String> {
    let body = super::form_encode(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ]);
    discord_fetch(
        http,
        form_post(format!("{DISCORD_API_BASE}/oauth2/token"), body),
    )
    .await
}

/// `getBotUser(botToken)`.
pub(super) async fn bot_user(http: Option<&DynDeskHttp>, token: &str) -> Result<Value, String> {
    discord_fetch(
        http,
        get(format!("{DISCORD_API_BASE}/users/@me"), bot(token)),
    )
    .await
}

/// `getGuildChannels(botToken, guildId)`: text channels only.
pub(super) async fn guild_channels(
    http: Option<&DynDeskHttp>,
    token: &str,
    guild_id: &str,
) -> Result<Vec<Value>, String> {
    let guild = snowflake(guild_id, "guild id")?;
    let channels = discord_fetch(
        http,
        get(
            format!("{DISCORD_API_BASE}/guilds/{guild}/channels"),
            bot(token),
        ),
    )
    .await?;
    let Value::Array(channels) = channels else {
        return Err("channels.filter is not a function".to_owned());
    };
    Ok(channels
        .into_iter()
        .filter(|c| c["type"] == json!(0))
        .collect())
}

/// `sendMessage` / `sendMessageWithEmbed`: POST a message body.
pub(super) async fn post_message(
    http: Option<&DynDeskHttp>,
    token: &str,
    channel_id: &str,
    body: &Value,
) -> Result<Value, String> {
    let channel = snowflake(channel_id, "channel id")?;
    discord_fetch(
        http,
        HttpRequest {
            method: "POST",
            url: format!("{DISCORD_API_BASE}/channels/{channel}/messages"),
            headers: bot_json(token),
            body: Some(body.to_string()),
        },
    )
    .await
}

/// A PATCH whose failed status throws, the body unread otherwise.
async fn patch(
    http: Option<&DynDeskHttp>,
    token: &str,
    url: String,
    body: &Value,
) -> Result<(), String> {
    let response = send(
        http,
        HttpRequest {
            method: "PATCH",
            url,
            headers: bot_json(token),
            body: Some(body.to_string()),
        },
    )
    .await?;
    if !response.ok() {
        return Err(format!(
            "Discord API error ({}): {}",
            response.status, response.body
        ));
    }
    Ok(())
}

/// `setBotGuildNickname(botToken, guildId, nickname)`.
pub(super) async fn set_nickname(
    http: Option<&DynDeskHttp>,
    token: &str,
    guild_id: &str,
    nickname: &str,
) -> Result<(), String> {
    let guild = snowflake(guild_id, "guild id")?;
    patch(
        http,
        token,
        format!("{DISCORD_API_BASE}/guilds/{guild}/members/@me"),
        &json!({ "nick": nickname }),
    )
    .await
}

/// `parsePublicAvatarUrl(raw)`: a public https URL, or the error.
#[allow(clippy::case_sensitive_file_extension_comparisons)] // a host name, already lower case
fn public_avatar_url(raw: &str) -> Result<String, String> {
    let uri: http::Uri = raw.parse().map_err(|_| "Invalid avatar URL".to_owned())?;
    let (Some(scheme), Some(authority)) = (uri.scheme_str(), uri.authority()) else {
        return Err("Invalid avatar URL".to_owned());
    };
    let host = authority.host().to_ascii_lowercase();
    let credentials = authority.as_str().contains('@');
    let private_ipv4 = {
        let octets: Vec<&str> = host.split('.').collect();
        let n = |i: usize| octets.get(i).and_then(|o| o.parse::<u16>().ok());
        let first = n(0);
        let second = n(1).unwrap_or(999);
        host.starts_with("0.")
            || host.starts_with("10.")
            || host.starts_with("127.")
            || host.starts_with("169.254.")
            || host.starts_with("192.168.")
            || (first == Some(172) && (16..=31).contains(&second) && host.matches('.').count() >= 2)
            || (first == Some(100)
                && (64..=127).contains(&second)
                && host.matches('.').count() >= 2)
    };
    let internal = host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.starts_with('[')
        || private_ipv4;
    if !scheme.eq_ignore_ascii_case("https") || credentials || internal {
        return Err("Avatar URL must be a public https URL".to_owned());
    }
    Ok(raw.to_owned())
}

/// `btoa` over bytes.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> shift) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The avatar image: status and bytes. The bytes client when there is one
/// (the desk port reads text), else the desk port.
async fn fetch_image(
    bytes_http: Option<&OutboundHttp>,
    http: Option<&DynDeskHttp>,
    url: &str,
) -> Result<(u16, Vec<u8>), String> {
    if let Some(client) = bytes_http {
        let response = client
            .send(weldsuite_ports::HttpRequest::empty("GET", url))
            .await
            .map_err(|error| error.to_string())?;
        return Ok((response.status, response.body));
    }
    let response = send(http, get(url.to_owned(), Vec::new())).await?;
    Ok((response.status, response.body.into_bytes()))
}

/// `setBotAvatar(botToken, avatarUrl)`: the image as a data URI, or a reset.
/// Neither HTTP port hands back response headers, so the image type is
/// `image/png`, the TypeScript fallback.
pub(super) async fn set_avatar(
    bytes_http: Option<&OutboundHttp>,
    http: Option<&DynDeskHttp>,
    token: &str,
    avatar_url: Option<&str>,
) -> Result<(), String> {
    let avatar = match avatar_url {
        Some(url) => {
            let url = public_avatar_url(url)?;
            let (status, bytes) = fetch_image(bytes_http, http, &url).await?;
            if !(200..300).contains(&status) {
                return Err(format!("Failed to fetch avatar image ({status})"));
            }
            json!(format!("data:image/png;base64,{}", base64(&bytes)))
        }
        None => Value::Null,
    };
    patch(
        http,
        token,
        format!("{DISCORD_API_BASE}/users/@me"),
        &json!({ "avatar": avatar }),
    )
    .await
}

/// `slackAuthTest(botToken)`.
pub(super) async fn slack_auth_test(
    http: Option<&DynDeskHttp>,
    token: &str,
) -> Result<Value, String> {
    let response = send(
        http,
        get(
            "https://slack.com/api/auth.test".to_owned(),
            vec![("Authorization".to_owned(), format!("Bearer {token}"))],
        ),
    )
    .await?;
    json_of(&response)
}

/// `slackListChannels(botToken)`.
pub(super) async fn slack_channels(
    http: Option<&DynDeskHttp>,
    token: &str,
) -> Result<Value, String> {
    let response = send(
        http,
        get(
            "https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=200".to_owned(),
            vec![("Authorization".to_owned(), format!("Bearer {token}"))],
        ),
    )
    .await?;
    json_of(&response)
}

/// `POST https://slack.com/api/oauth.v2.access`.
pub(super) async fn slack_exchange(
    http: Option<&DynDeskHttp>,
    form: String,
) -> Result<Value, String> {
    let response = send(
        http,
        form_post("https://slack.com/api/oauth.v2.access".to_owned(), form),
    )
    .await?;
    json_of(&response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_btoa() {
        assert_eq!(base64(&[137, 80, 78, 71]), "iVBORw==");
        assert_eq!(base64(b"ab"), "YWI=");
        assert_eq!(base64(b"abc"), "YWJj");
    }

    #[test]
    fn avatar_urls_must_be_public_https() {
        assert!(public_avatar_url("https://cdn.example.test/a.png").is_ok());
        assert!(public_avatar_url("http://cdn.example.test/a.png").is_err());
        assert!(public_avatar_url("https://localhost/x.png").is_err());
        assert!(public_avatar_url("https://10.0.0.1/x.png").is_err());
    }
}
