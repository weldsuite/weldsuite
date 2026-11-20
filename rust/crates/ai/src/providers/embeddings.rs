//! Embeddings on OpenAI-compatible APIs: Mistral's `POST /v1/embeddings`
//! (`mistral-embed`, 1024 dimensions) or an install's own endpoint.

use serde_json::{Value, json};

use crate::catalog::ProviderId;
use crate::error::AiError;
use crate::policy::Target;
use crate::types::Usage;

pub(crate) fn embed_body(target: &Target, inputs: &[String]) -> Value {
    json!({ "model": target.native_model(), "input": inputs })
}

/// The vectors in input order, and the tokens billed.
pub(crate) fn parse_embeddings(
    provider: ProviderId,
    body: &Value,
    expected: usize,
) -> Result<(Vec<Vec<f32>>, Usage), AiError> {
    let mut rows: Vec<(usize, Vec<f32>)> = body
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(position, row)| {
            let index = row
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|i| usize::try_from(i).ok())
                .unwrap_or(position);
            #[allow(clippy::cast_possible_truncation)]
            let vector = row
                .get("embedding")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_f64)
                .map(|x| x as f32)
                .collect();
            (index, vector)
        })
        .collect();
    if rows.len() != expected {
        return Err(AiError::Provider {
            provider,
            status: None,
            message: format!("asked for {expected} embeddings, got {}", rows.len()),
        });
    }
    rows.sort_by_key(|(index, _)| *index);
    let usage = Usage {
        input_tokens: body
            .pointer("/usage/prompt_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        output_tokens: 0,
    };
    Ok((rows.into_iter().map(|(_, v)| v).collect(), usage))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{KeySource, Region};

    #[test]
    fn vectors_come_back_in_input_order() {
        let target = Target {
            provider: ProviderId::Mistral,
            model: "mistral/mistral-embed-2312".to_owned(),
            region: Region::Eu,
            key_source: KeySource::Weldsuite,
        };
        let body = embed_body(&target, &["a".to_owned(), "b".to_owned()]);
        assert_eq!(
            body,
            json!({ "model": "mistral-embed-2312", "input": ["a", "b"] })
        );
        let (vectors, usage) = parse_embeddings(
            ProviderId::Mistral,
            &json!({
                "data": [{ "index": 1, "embedding": [0.5, 0.25] }, { "index": 0, "embedding": [1.0, 0.0] }],
                "usage": { "prompt_tokens": 6 },
            }),
            2,
        )
        .expect("vectors");
        assert_eq!(vectors, vec![vec![1.0, 0.0], vec![0.5, 0.25]]);
        assert_eq!(usage.input_tokens, 6);
        assert!(parse_embeddings(ProviderId::Mistral, &json!({ "data": [] }), 1).is_err());
    }
}
