//! `OpenAI`'s domain verification for the `ChatGPT` plugin directory:
//! `GET /.well-known/openai-apps-challenge` on the MCP server's host answers
//! the token `OpenAI`'s dashboard hands out, as plain text and nothing else.
//! The token is `OPENAI_APPS_CHALLENGE` (the chart's
//! `config.mcp.openaiAppsChallenge`); it is not a secret, `OpenAI` reads it
//! from this public URL. Unset, or not a plausible token, the path is a 404
//! like any other unknown path on the host.

use axum::Router;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use http::{HeaderValue, StatusCode, header};

/// Where `OpenAI` looks for the token.
pub const OPENAI_APPS_CHALLENGE_PATH: &str = "/.well-known/openai-apps-challenge";

/// The longest token served. `OpenAI`'s are far shorter.
const MAX_TOKEN_LENGTH: usize = 512;

/// The token to serve: trimmed, 1 to [`MAX_TOKEN_LENGTH`] visible ASCII
/// characters. Anything else is no token.
fn usable_token(raw: Option<&str>) -> Option<String> {
    let token = raw?.trim();
    let usable = !token.is_empty()
        && token.len() <= MAX_TOKEN_LENGTH
        && token.bytes().all(|b| b.is_ascii_graphic());
    if !usable {
        if !token.is_empty() {
            tracing::warn!("OPENAI_APPS_CHALLENGE is not a plausible token; not served");
        }
        return None;
    }
    Some(token.to_owned())
}

fn answer(token: Option<&str>) -> Response {
    match token {
        Some(token) => (
            StatusCode::OK,
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/plain; charset=utf-8"),
                ),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            ],
            token.to_owned(),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// The route, serving `token` (`OPENAI_APPS_CHALLENGE`).
pub fn openai_apps_challenge_router<S>(token: Option<&str>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let token = usable_token(token);
    Router::new().route(
        OPENAI_APPS_CHALLENGE_PATH,
        get(move || {
            let token = token.clone();
            async move { answer(token.as_deref()) }
        }),
    )
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use http::Request;
    use tower::ServiceExt;

    use super::*;

    async fn get_challenge(token: Option<&str>) -> (StatusCode, Option<String>, String) {
        let app: Router = openai_apps_challenge_router(token);
        let response = app
            .oneshot(
                Request::builder()
                    .uri(OPENAI_APPS_CHALLENGE_PATH)
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let status = response.status();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        (
            status,
            content_type,
            String::from_utf8(body.to_vec()).expect("utf-8"),
        )
    }

    #[tokio::test]
    async fn the_token_is_served_as_plain_text_and_nothing_else() {
        let (status, content_type, body) = get_challenge(Some("  oa-verify-AbC123_x  \n")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(content_type.as_deref(), Some("text/plain; charset=utf-8"));
        assert_eq!(body, "oa-verify-AbC123_x");
    }

    #[tokio::test]
    async fn without_a_usable_token_the_path_is_not_found() {
        let too_long = "a".repeat(MAX_TOKEN_LENGTH + 1);
        for token in [
            None,
            Some(""),
            Some("   "),
            Some("two words"),
            Some("x\u{7f}y"),
            Some(too_long.as_str()),
        ] {
            let (status, _, _) = get_challenge(token).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{token:?}");
        }
    }
}
