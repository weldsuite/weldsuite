/**
 * Curated model ids for WeldSuite, addressed through Cloudflare AI Gateway.
 *
 * Two families:
 *  - **Workers AI** (`@cf/…`) — runs on Cloudflare's own GPUs, billed against
 *    your Workers AI allocation (free tier included). Prefer these for
 *    high-volume, latency-sensitive, or cost-sensitive tasks.
 *  - **Third-party** (`provider/model`) — Anthropic / OpenAI / Google, billed
 *    through AI Gateway Unified Billing (or BYOK). Prefer these when you need
 *    top-tier reasoning, long agentic tool loops, or best-in-class quality.
 *
 * This list is for autocomplete + a single place to bump defaults — it is NOT
 * exhaustive and NOT enforced. Any string the gateway understands is valid.
 */

/** Free / low-cost Cloudflare Workers AI models (`@cf/…`). */
export const workersAi = {
  /** Llama 3.3 70B (fp8, fast) — the free workhorse. Function calling. ~24k ctx. */
  llama70bFast: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  /** Llama 3.1 8B (fast) — cheapest/fastest for lightweight tasks. ~60k ctx. */
  llama8bFast: '@cf/meta/llama-3.1-8b-instruct-fast',
  /** Llama 4 Scout 17B — long context (~131k), multimodal. */
  llama4Scout: '@cf/meta/llama-4-scout-17b-16e-instruct',
  /** Qwen3 30B (fp8) — strong reasoning. ~32k ctx. */
  qwen3: '@cf/qwen/qwen3-30b-a3b-fp8',
  // Embeddings
  /** BGE-M3 — multilingual (100+ langs incl. NL) embeddings. Best for en/nl. */
  embedM3: '@cf/baai/bge-m3',
  /** BGE large EN v1.5 — English embeddings (1024 dims). */
  embedLargeEn: '@cf/baai/bge-large-en-v1.5',
  /** BGE base EN v1.5 — smaller/faster English embeddings (768 dims). */
  embedBaseEn: '@cf/baai/bge-base-en-v1.5',
  // Retrieval + speech
  /** BGE reranker — reorder RAG candidates by relevance. */
  reranker: '@cf/baai/bge-reranker-base',
  /** Whisper large v3 turbo — speech-to-text (transcription). */
  whisper: '@cf/openai/whisper-large-v3-turbo',
} as const;

/** Premium third-party models (`provider/model`), via Unified Billing / BYOK. */
export const thirdParty = {
  anthropic: {
    sonnet: 'anthropic/claude-sonnet-4-5',
    opus: 'anthropic/claude-opus-4-1',
    haiku: 'anthropic/claude-haiku-4-5',
  },
  openai: {
    gpt5: 'openai/gpt-5',
    gpt5Mini: 'openai/gpt-5-mini',
    gpt4o: 'openai/gpt-4o',
    embed3Small: 'openai/text-embedding-3-small',
    embed3Large: 'openai/text-embedding-3-large',
  },
  google: {
    flash: 'google-ai-studio/gemini-2.5-flash',
    pro: 'google-ai-studio/gemini-2.5-pro',
  },
} as const;

/**
 * The models WeldSuite actually needs, mapped by task. `free` uses your Workers
 * AI allocation; `quality` uses a premium third-party model. Pick per call site
 * based on how much the output quality matters vs. cost/latency.
 *
 * @example
 * ```ts
 * // cheap, high-volume classification on the free tier
 * ai.model(recommended.classify.free)
 * // customer-facing Copilot reply where quality matters
 * ai.model(recommended.copilot.quality)
 * ```
 */
export const recommended = {
  /** WeldDesk/WeldMail: ticket & email triage/classification. */
  classify: { free: workersAi.llama8bFast, quality: thirdParty.anthropic.haiku },
  /** Sentiment scoring on conversations. */
  sentiment: { free: workersAi.llama8bFast, quality: thirdParty.anthropic.haiku },
  /** Summarise threads/tickets/meetings (long context on the free tier). */
  summarize: { free: workersAi.llama4Scout, quality: thirdParty.anthropic.sonnet },
  /** en/nl translation (WeldSuite is bilingual). */
  translate: { free: workersAi.llama70bFast, quality: thirdParty.google.flash },
  /** Draft replies / suggested responses. */
  draft: { free: workersAi.llama70bFast, quality: thirdParty.anthropic.sonnet },
  /** WeldDesk Copilot / WeldAgent — agentic tool-calling. */
  copilot: { free: workersAi.llama70bFast, quality: thirdParty.anthropic.sonnet },
  /** Embeddings for search / RAG (WeldKnow, help center) — multilingual. */
  embed: { free: workersAi.embedM3, quality: thirdParty.openai.embed3Small },
  /** Rerank RAG candidates (Workers AI only). */
  rerank: { free: workersAi.reranker, quality: workersAi.reranker },
  /** Speech-to-text — WeldMeet transcripts, WeldCRM call intelligence. */
  transcribe: { free: workersAi.whisper, quality: workersAi.whisper },
} as const;

/** Flattened id list (for validation / model-picker UIs). */
export const models = { workersAi, thirdParty, recommended } as const;

type WorkersAiId = (typeof workersAi)[keyof typeof workersAi];
type AnthropicId = (typeof thirdParty.anthropic)[keyof typeof thirdParty.anthropic];
type OpenAiId = (typeof thirdParty.openai)[keyof typeof thirdParty.openai];
type GoogleId = (typeof thirdParty.google)[keyof typeof thirdParty.google];

/** Known model ids (autocomplete), but any string is accepted. */
export type ModelId =
  | WorkersAiId
  | AnthropicId
  | OpenAiId
  | GoogleId
  | (string & {});
