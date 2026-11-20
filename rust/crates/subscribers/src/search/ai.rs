//! The index's vectors through the install's AI (`weldsuite_ai`, ADR AI-012):
//! `ai.embed` for the fixed feature `search-index` (task `embed`, always on the
//! install provider: Mistral's `mistral-embed` on EU, 1024 dimensions, or a
//! self-hosted install's `AI_COMPAT_EMBED_MODEL`). Global's twin is
//! `createEmbedder` in `apps/workers/app-api/src/services/search/indexer.ts`
//! (Workers AI `bge-m3` through the AI Gateway, unmetered there).
//!
//! Each record's chunks are one embeddings call, but the wallet is charged
//! once per workspace and batch ([`WorkspaceEmbeddings::settle`]): the calls
//! run unmetered (an `AiCall` without the master database) and their tokens
//! add up, so a batch of a hundred small edits costs one charge at the
//! published rate instead of a hundred one-credit minimums. The charge and
//! its ops ledger row carry the model that served. The indexer is not gated
//! on the wallet: a background index that stops on an empty wallet goes
//! stale for good, and AI-007's overdraft rule books what the wallet can't
//! cover as debt.

use std::sync::{Mutex, PoisonError};

use weldsuite_ai::billing;
use weldsuite_ai::policy::Target;
use weldsuite_ai::{Ai, AiCall, Feature, Served, Task, Tier, Usage};
use weldsuite_db::PgPool;
use weldsuite_ports::{BoxFuture, Embeddings, PortError};

use super::EMBED_DIMENSIONS;

/// The call every embedding of the index is: `search-index`, `embed`, free
/// tier (the install's one embedding model).
fn index_call(workspace_id: &str) -> AiCall {
    AiCall::new(workspace_id, Feature::SearchIndex, Task::Embed, Tier::Free)
}

/// The model the install embeds with (`mistral/mistral-embed-2312` on EU),
/// stored with each vector; `None` when the install's AI has no embedding
/// model (a `compat` endpoint without `AI_COMPAT_EMBED_MODEL`).
pub fn index_model(ai: &Ai) -> Option<String> {
    if !ai.enabled() {
        return None;
    }
    let settings = weldsuite_ai::WorkspaceAiSettings::default();
    weldsuite_ai::policy::resolve(ai.config(), &settings, &index_call(""))
        .ok()
        .map(|route| route.primary.model)
}

/// One workspace's embeddings within one batch: [`Embeddings`] over
/// `ai.embed`, with the tokens of every call kept for one charge.
pub struct WorkspaceEmbeddings {
    ai: Ai,
    model: String,
    workspace_id: String,
    spent: Mutex<Spent>,
}

#[derive(Default)]
struct Spent {
    usage: Usage,
    served: Option<Served>,
}

impl std::fmt::Debug for WorkspaceEmbeddings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceEmbeddings")
            .field("model", &self.model)
            .field("workspace_id", &self.workspace_id)
            .finish_non_exhaustive()
    }
}

impl WorkspaceEmbeddings {
    /// `model` is [`index_model`]'s answer.
    pub fn new(ai: Ai, model: String, workspace_id: impl Into<String>) -> Self {
        Self {
            ai,
            model,
            workspace_id: workspace_id.into(),
            spent: Mutex::default(),
        }
    }

    /// The tokens spent so far.
    pub fn usage(&self) -> Usage {
        self.spent
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .usage
    }

    async fn call(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, PortError> {
        // Unmetered here (no master database): `settle` charges the batch.
        let answer = self
            .ai
            .embed(&index_call(&self.workspace_id), texts)
            .await
            .map_err(PortError::backend)?;
        {
            let mut spent = self.spent.lock().unwrap_or_else(PoisonError::into_inner);
            spent.usage.input_tokens += answer.usage.input_tokens;
            spent.usage.output_tokens += answer.usage.output_tokens;
            if !answer.vectors.is_empty() {
                spent.served = Some(answer.served.clone());
            }
        }
        // Vectors of another model must never land next to these.
        if !answer.vectors.is_empty() && answer.served.model != self.model {
            return Err(PortError::backend(format!(
                "[search-indexer] embeddings came from {} instead of {}",
                answer.served.model, self.model
            )));
        }
        if let Some(vector) = answer.vectors.iter().find(|v| v.len() != EMBED_DIMENSIONS) {
            return Err(PortError::backend(format!(
                "[search-indexer] {} returned {} dimensions; the index holds {EMBED_DIMENSIONS}",
                self.model,
                vector.len()
            )));
        }
        Ok(answer.vectors)
    }

    /// Charge the workspace once for every call of the batch, and write the
    /// ops ledger row; nothing when nothing was embedded. Never fails: the
    /// metering logs its own errors. The credits charged.
    pub async fn settle(&self, master: Option<&PgPool>) -> i64 {
        let (usage, served) = {
            let mut spent = self.spent.lock().unwrap_or_else(PoisonError::into_inner);
            (
                std::mem::take(&mut spent.usage),
                std::mem::take(&mut spent.served),
            )
        };
        let Some(served) = served else {
            return 0;
        };
        let call = index_call(&self.workspace_id).master(master.cloned());
        let target = Target {
            provider: served.provider,
            model: served.model,
            region: served.region,
            key_source: served.key_source,
        };
        let cost = billing::provider_cost_usd(&target.model, usage, 0, 0.0);
        billing::charge(self.ai.config(), &call, &target, cost, usage).await
    }
}

impl Embeddings for WorkspaceEmbeddings {
    fn model(&self) -> &str {
        &self.model
    }

    fn embed<'a>(&'a self, texts: &'a [String]) -> BoxFuture<'a, Result<Vec<Vec<f32>>, PortError>> {
        Box::pin(self.call(texts))
    }
}

#[cfg(test)]
mod tests {
    use weldsuite_ai::{AiConfig, FakeProvider};

    use super::*;

    fn ai(fake: &FakeProvider) -> Ai {
        let env = |name: &str| match name {
            "AI_DEFAULT_PROVIDER" => Some("mistral".to_owned()),
            "MISTRAL_API_KEY" => Some("mistral-key".to_owned()),
            _ => None,
        };
        let mut problems = Vec::new();
        let config = AiConfig::from_lookup(&env, &mut problems);
        assert!(problems.is_empty(), "{problems:?}");
        Ai::fake(config, fake.clone())
    }

    fn vectors(count: usize) -> Vec<Vec<f32>> {
        vec![vec![0.5; EMBED_DIMENSIONS]; count]
    }

    #[tokio::test]
    async fn the_index_embeds_with_the_install_model_and_adds_up_the_tokens() {
        let fake = FakeProvider::new()
            .reply_embeddings(vectors(2))
            .reply_embeddings(vectors(1));
        let ai = ai(&fake);
        let model = index_model(&ai).expect("an embedding model");
        assert_eq!(model, "mistral/mistral-embed-2312");
        let embeddings = WorkspaceEmbeddings::new(ai, model, "ws_1");
        let first = embeddings
            .embed(&["one".to_owned(), "two".to_owned()])
            .await
            .expect("vectors");
        assert_eq!(first.len(), 2);
        embeddings
            .embed(&["three".to_owned()])
            .await
            .expect("vectors");
        let calls = fake.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].url, "https://api.mistral.ai/v1/embeddings");
        assert_eq!(calls[0].model().as_deref(), Some("mistral-embed-2312"));
        assert_eq!(
            embeddings.usage().input_tokens,
            2 * weldsuite_ai::fake::FAKE_INPUT_TOKENS
        );
        // Without a master database the batch is unmetered, and settling
        // clears what was spent.
        assert_eq!(embeddings.settle(None).await, 0);
        assert_eq!(embeddings.usage(), Usage::default());
    }

    #[tokio::test]
    async fn vectors_of_the_wrong_width_are_refused() {
        let fake = FakeProvider::new().reply_embeddings(vec![vec![0.5; 768]]);
        let ai = ai(&fake);
        let model = index_model(&ai).expect("an embedding model");
        let embeddings = WorkspaceEmbeddings::new(ai, model, "ws_1");
        let error = embeddings
            .embed(&["one".to_owned()])
            .await
            .expect_err("768 dimensions");
        assert!(error.to_string().contains("768 dimensions"), "{error}");
    }

    #[tokio::test]
    async fn a_refusal_is_an_error_the_subscriber_retries() {
        let fake = FakeProvider::new().reply_status(400, "{\"message\":\"bad\"}");
        let ai = ai(&fake);
        let model = index_model(&ai).expect("an embedding model");
        let embeddings = WorkspaceEmbeddings::new(ai, model, "ws_1");
        assert!(embeddings.embed(&["one".to_owned()]).await.is_err());
        assert_eq!(embeddings.settle(None).await, 0);
    }

    #[test]
    fn without_ai_there_is_no_index_model() {
        let ai = Ai::fake(AiConfig::default(), FakeProvider::new());
        assert_eq!(index_model(&ai), None);
    }
}
