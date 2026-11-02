//! Embeddings from an OpenAI-compatible endpoint (`POST {base}/embeddings`):
//! Mistral's API, or a model served in the cluster by Hugging Face's text
//! embeddings inference, vLLM or Ollama. The Kubernetes counterpart of the
//! Workers AI embeddings the semantic search index uses in Global.

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use weldsuite_ports::{BoxFuture, Embeddings, PortError};

/// How to reach the endpoint.
#[derive(Clone)]
pub struct OpenAiEmbeddingsOptions {
    /// The API base, `https://api.mistral.ai/v1` or `http://tei:8080/v1`.
    pub base_url: String,
    /// The model the endpoint serves, also stored with each vector.
    pub model: String,
    /// Sent as a bearer token when set.
    pub api_key: Option<String>,
}

impl std::fmt::Debug for OpenAiEmbeddingsOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenAiEmbeddingsOptions")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("api_key", &self.api_key.as_ref().map(|_| "…"))
            .finish()
    }
}

/// [`Embeddings`] over the `OpenAI` embeddings API.
#[derive(Debug, Clone)]
pub struct OpenAiEmbeddings {
    options: OpenAiEmbeddingsOptions,
    client: reqwest::Client,
}

impl OpenAiEmbeddings {
    pub fn new(options: OpenAiEmbeddingsOptions) -> Result<Self, PortError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(PortError::backend)?;
        Ok(Self { options, client })
    }

    async fn call(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, PortError> {
        let url = format!("{}/embeddings", self.options.base_url.trim_end_matches('/'));
        let mut request = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .body(json!({ "model": self.options.model, "input": texts }).to_string());
        if let Some(key) = &self.options.api_key {
            request = request.bearer_auth(key);
        }
        let response = request
            .send()
            .await
            .map_err(|error| PortError::backend(error.without_url()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(PortError::backend(format!(
                "embeddings endpoint answered {status}"
            )));
        }
        let text = response
            .text()
            .await
            .map_err(|error| PortError::backend(error.without_url()))?;
        let body: EmbeddingsResponse = serde_json::from_str(&text)?;
        order_embeddings(body, texts.len())
    }
}

#[derive(Debug, Deserialize)]
struct EmbeddingsResponse {
    data: Vec<EmbeddingItem>,
}

#[derive(Debug, Deserialize)]
struct EmbeddingItem {
    embedding: Vec<f32>,
    #[serde(default)]
    index: Option<usize>,
}

/// The vectors in input order (`index`, else the order given).
fn order_embeddings(body: EmbeddingsResponse, expected: usize) -> Result<Vec<Vec<f32>>, PortError> {
    if body.data.len() != expected {
        return Err(PortError::backend(format!(
            "embeddings endpoint returned {} vectors for {expected} texts",
            body.data.len()
        )));
    }
    let mut items: Vec<(usize, Vec<f32>)> = body
        .data
        .into_iter()
        .enumerate()
        .map(|(position, item)| (item.index.unwrap_or(position), item.embedding))
        .collect();
    items.sort_by_key(|(index, _)| *index);
    Ok(items.into_iter().map(|(_, vector)| vector).collect())
}

impl Embeddings for OpenAiEmbeddings {
    fn model(&self) -> &str {
        &self.options.model
    }

    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, PortError>> {
        Box::pin(self.call(texts))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vectors_follow_the_index() {
        let body: EmbeddingsResponse = serde_json::from_value(json!({
            "data": [
                { "index": 1, "embedding": [2.0] },
                { "index": 0, "embedding": [1.0] },
            ]
        }))
        .expect("parses");
        assert_eq!(
            order_embeddings(body, 2).expect("ordered"),
            vec![vec![1.0], vec![2.0]]
        );
    }

    #[test]
    fn a_short_answer_is_an_error() {
        let body: EmbeddingsResponse =
            serde_json::from_value(json!({ "data": [{ "embedding": [1.0] }] })).expect("parses");
        assert!(order_embeddings(body, 2).is_err());
    }
}
