//! Text embeddings: the port behind the semantic search index
//! (`createEmbedder` in `apps/workers/app-api/src/services/search/indexer.ts`,
//! Workers AI `bge-m3` through the AI Gateway in Global). On Kubernetes an
//! OpenAI-compatible endpoint serves the model (`OpenAiEmbeddings` in
//! `weldsuite-adapters-oss`).

use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::{BoxFuture, PortError};

/// Turns texts into vectors, one per text, in order.
pub trait Embeddings: Send + Sync {
    /// The model id stored with each vector (`search_index.embed_model`):
    /// vectors of two models are not comparable, so a different id makes the
    /// indexer embed again.
    fn model(&self) -> &str;

    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, PortError>>;
}

/// [`Embeddings`] double: a deterministic vector per text, and every call
/// recorded. The vector is `dimensions` long with a single 1 at an index
/// taken from the text's SHA-256 (the same function the TypeScript fixture
/// generator uses), so tests can compare stored vectors across backends.
#[derive(Debug)]
pub struct FakeEmbeddings {
    model: String,
    dimensions: usize,
    calls: Mutex<Vec<Vec<String>>>,
    vector_for: fn(&str, usize) -> Vec<f32>,
}

impl FakeEmbeddings {
    /// `vector_for(text, dimensions)` makes each vector.
    pub fn new(
        model: impl Into<String>,
        dimensions: usize,
        vector_for: fn(&str, usize) -> Vec<f32>,
    ) -> Self {
        Self {
            model: model.into(),
            dimensions,
            calls: Mutex::default(),
            vector_for,
        }
    }

    /// The texts of every call, in order.
    pub fn calls(&self) -> Vec<Vec<String>> {
        self.lock().clone()
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Vec<String>>> {
        self.calls.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Embeddings for FakeEmbeddings {
    fn model(&self) -> &str {
        &self.model
    }

    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, PortError>> {
        self.lock().push(texts.to_vec());
        let vectors = texts
            .iter()
            .map(|text| (self.vector_for)(text, self.dimensions))
            .collect();
        Box::pin(std::future::ready(Ok(vectors)))
    }
}
