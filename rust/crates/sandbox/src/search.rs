//! `web_search` on the cluster's own `SearXNG` (`SEARXNG_URL`, the chart's
//! `searxng`). Only the query leaves the cluster, to the engines `SearXNG` is
//! configured with; no account, no profile, no cookie goes with it. The query
//! is sent in a POST body, so it shows in no access log.

use std::time::Duration;

use serde_json::{Value, json};
use weldsuite_ports::{HttpRequest, OutboundHttp};

use crate::error::SandboxError;
use crate::sanitize::{clean_line, web_url};

/// The most results one search returns.
pub const MAX_RESULTS: usize = 10;
const TITLE_CHARS: usize = 200;
const SNIPPET_CHARS: usize = 500;
const TIMEOUT: Duration = Duration::from_secs(20);

/// One result, cleaned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub engine: String,
}

impl SearchHit {
    pub fn to_json(&self) -> Value {
        json!({ "title": self.title, "url": self.url, "snippet": self.snippet, "engine": self.engine })
    }
}

/// The `SearXNG` JSON API.
#[derive(Clone)]
pub struct SearchClient {
    http: OutboundHttp,
    base: String,
}

impl std::fmt::Debug for SearchClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchClient")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

impl SearchClient {
    pub fn new(http: OutboundHttp, base: impl Into<String>) -> Self {
        Self {
            http,
            base: base.into().trim_end_matches('/').to_owned(),
        }
    }

    /// Up to `count` results for `query` (`language`: a code such as `nl`,
    /// or `SearXNG`'s own choice).
    pub async fn search(
        &self,
        query: &str,
        count: usize,
        language: Option<&str>,
    ) -> Result<Vec<SearchHit>, SandboxError> {
        let body: String = form_urlencoded::Serializer::new(String::new())
            .append_pair("q", query)
            .append_pair("format", "json")
            .append_pair("pageno", "1")
            .append_pair("safesearch", "1")
            .append_pair("language", language.unwrap_or("auto"))
            .finish();
        let request = HttpRequest {
            method: "POST".to_owned(),
            url: format!("{}/search", self.base),
            headers: vec![
                (
                    "Content-Type".to_owned(),
                    "application/x-www-form-urlencoded".to_owned(),
                ),
                ("Accept".to_owned(), "application/json".to_owned()),
                (
                    "Accept-Language".to_owned(),
                    language.unwrap_or("en").to_owned(),
                ),
                ("User-Agent".to_owned(), "WeldSuite-Agent".to_owned()),
            ],
            body: Some(body.into_bytes()),
        };
        let response = tokio::time::timeout(TIMEOUT, self.http.send(request))
            .await
            .map_err(|_| SandboxError::Timeout("web search"))?
            .map_err(|error| SandboxError::Unreachable(format!("searxng: {error}")))?;
        if !response.ok() {
            return Err(SandboxError::Agent(
                response.status,
                "The web search did not answer. Try again later.".to_owned(),
            ));
        }
        Ok(hits(&response.json(), count.clamp(1, MAX_RESULTS)))
    }
}

/// The usable results of a `SearXNG` answer: http(s) URLs only, cleaned,
/// without duplicates.
fn hits(answer: &Value, count: usize) -> Vec<SearchHit> {
    let mut out: Vec<SearchHit> = Vec::new();
    for result in answer
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(url) = result
            .get("url")
            .and_then(Value::as_str)
            .and_then(|u| web_url(u).ok())
        else {
            continue;
        };
        if url.len() > 2000 || out.iter().any(|hit| hit.url == url) {
            continue;
        }
        let text = |key: &str| result.get(key).and_then(Value::as_str).unwrap_or_default();
        out.push(SearchHit {
            title: clean_line(text("title"), TITLE_CHARS),
            url,
            snippet: clean_line(text("content"), SNIPPET_CHARS),
            engine: clean_line(text("engine"), 40),
        });
        if out.len() >= count {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake::RecordingHttp;

    #[tokio::test]
    async fn posts_the_query_and_cleans_the_results() {
        let http = RecordingHttp::new(|_| {
            (
                200,
                json!({ "results": [
                    { "url": "https://a.example/x", "title": "A\u{200B}  title", "content": "Snip", "engine": "qwant" },
                    { "url": "javascript:alert(1)", "title": "bad" },
                    { "url": "https://a.example/x", "title": "dup" },
                    { "url": "https://b.example/", "title": "B", "content": "x".repeat(900) },
                    { "url": "https://c.example/", "title": "C" },
                ]}),
            )
        });
        let client = SearchClient::new(http.outbound(), "http://searxng:8080/");
        let found = client
            .search("weldsuite eu", 2, Some("nl"))
            .await
            .expect("answer");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].title, "A title");
        assert_eq!(found[0].engine, "qwant");
        assert_eq!(found[1].url, "https://b.example/");
        assert!(found[1].snippet.chars().count() < 600);
        let call = &http.calls()[0];
        assert_eq!(call.method, "POST");
        assert_eq!(call.url, "http://searxng:8080/search");
        // The query is in the body, never the URL.
        assert!(!call.url.contains("weldsuite"));
        let body = String::from_utf8(call.body.clone().unwrap_or_default()).expect("utf-8");
        assert!(body.contains("q=weldsuite+eu"));
        assert!(body.contains("format=json"));
        assert!(body.contains("language=nl"));
    }

    #[tokio::test]
    async fn a_failing_engine_is_an_error() {
        let http = RecordingHttp::new(|_| (429, json!({})));
        let client = SearchClient::new(http.outbound(), "http://searxng:8080");
        assert!(matches!(
            client.search("x", 5, None).await,
            Err(SandboxError::Agent(429, _))
        ));
    }
}
