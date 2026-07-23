# @weldsuite/ai

The single AI entry point for WeldSuite. It **re-exports the Vercel AI SDK** and
routes every call through the **Cloudflare AI Gateway**, so all model usage across
the monorepo goes through one logged/cached/rate-limited endpoint while you keep
using the AI SDK as documented.

- **One CF token, two model families.** Workers AI (`@cf/…`, free allocation) *and*
  third-party models (Anthropic / OpenAI / Google, via Unified Billing / BYOK)
  share one endpoint and one token.
- **Canonical model ids.** Call sites pass Cloudflare-shaped ids (e.g.
  `anthropic/claude-sonnet-4-5`); billing keys on the canonical id, so pricing is
  stable across every surface.
- **Full AI SDK surface:** `generateText`, `streamText`, `generateObject`,
  `streamObject`, `embed`, `embedMany`, `tool` (tool calling), etc.

> **Single gateway.** WeldSuite runs Cloudflare only. The `GatewayProvider` type,
> the routing modes, and the `runWithFallback` wrapper are kept as a seam (and to
> feed the ops cost ledger), they resolve to Cloudflare and never fan out. See
> "Adding a gateway" if a second one is ever reintroduced.

## Install (workspace)

```jsonc
"dependencies": { "@weldsuite/ai": "workspace:*" }
```

Import from `@weldsuite/ai`, **not** from `ai` directly, so everyone shares one
SDK instance and the gateway wiring.

## Configuration

One CF token reaches Workers AI (`@cf/…`, free allocation) *and* third-party
models (Unified Billing / BYOK).

| Env var | Purpose | Default |
| --- | --- | --- |
| `CF_ACCOUNT_ID` / `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account (required) |, |
| `AI_GATEWAY_API_TOKEN` / `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN` | CF API token → `Authorization` |, |
| `CF_AI_GATEWAY` | Gateway id → `cf-aig-gateway-id` | account's `default` gateway |
| `CF_AIG_TOKEN` | Gateway auth token → `cf-aig-authorization` |, (authenticated gateways only) |
| `AI_DEFAULT_MODEL` | Default **canonical** model id | free Workers AI 70B |
| `AI_GATEWAY_PROVIDER` | Optional; must be `cloudflare` | `cloudflare` |

## Cost ledger

Cloudflare passes inference through at provider list price with **0% token markup**
(plus a flat 5% Unified Billing credit-purchase fee). What we pay is recorded in
the ops ledger (`ai_provider_usage`); what the **customer** pays comes from
`creditsForUsage`, keyed only on the canonical model id, so the two never drift.
The gap shows up as margin at `/ai-costs` in the admin console.

`runWithFallback` is the call wrapper that records that ledger entry:

```ts
import { runWithFallback, generateText, recommended } from '@weldsuite/ai';

const { value, gateway } = await runWithFallback(
  env,
  { modelId: recommended.draft.free, op: 'ai_generate', onUsage },
  ({ model }) => generateText({ model, prompt, maxRetries: 1 }),
);
```

## Usage

```ts
import { createWeldAI, generateText, recommended } from '@weldsuite/ai';

const ai = createWeldAI(c.env);            // Worker: pass request env

// Free Workers AI (your CF allocation)
await generateText({ model: ai.model('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), prompt });

// Premium third-party when quality matters
await generateText({ model: ai.model('anthropic/claude-sonnet-4-5'), prompt });

// Or let the task→model map decide free vs quality
await generateText({ model: ai.model(recommended.summarize.quality), prompt });
```

Streaming, `generateObject` (Zod), `tool` calling, and `embed` all work exactly
as in the AI SDK docs, just get the model from `ai.model()` / `ai.embedding()`.

## Verifying the gateway

Unit tests never hit the network. To prove the gateway actually answers:

```bash
pnpm --filter @weldsuite/ai smoke
```

## Models for WeldSuite

`@weldsuite/ai/models` exports three groups:

- **`workersAi`**, free/low-cost `@cf/…` ids: `llama70bFast` (workhorse),
  `llama8bFast` (cheapest), `llama4Scout` (long context), `qwen3` (reasoning),
  `embedM3` (multilingual en/nl embeddings), `reranker`, `whisper` (speech-to-text).
- **`thirdParty`**, `anthropic.{sonnet,opus,haiku}`, `openai.{gpt5,gpt5Mini,gpt4o,embed3Small,embed3Large}`,
  `google.{flash,pro}`.
- **`recommended`**, task→model map, each with `.free` (Workers AI) and
  `.quality` (third-party): `classify`, `sentiment`, `summarize`, `translate`,
  `draft`, `copilot`, `embed`, `rerank`, `transcribe`.

```ts
import { recommended } from '@weldsuite/ai';
ai.model(recommended.classify.free);      // @cf/meta/llama-3.1-8b-instruct-fast
ai.model(recommended.copilot.quality);    // anthropic/claude-sonnet-4-5
```

## API

- `createWeldAI(configOrEnv?)` → `{ model, embedding, provider, config, gateway }`.
  `model(id?)` takes a **canonical** id and returns a plain AI SDK model.
- `model(id?)` / `embedding(id)`, Node convenience using env-resolved config.
- `models` / `workersAi` / `thirdParty` / `recommended`, id constants.
- `assertGatewayConfigured(env)` / `isGatewayConfigured(env)`, validate the
  gateway env. Prefer these over hand-rolled `CF_ACCOUNT_ID` checks.
- `runWithFallback(env, opts, run)`, run a call and record the ops-ledger entry.
- `resolveModelId(canonicalId)` / `isModelSupported(...)`, id mapping seam.
- `UnsupportedModelError`, `GatewayConfigError`.
- Everything from the [Vercel AI SDK](https://ai-sdk.dev).

## Adding a gateway

The multi-gateway seam was removed to keep the package Cloudflare-only. To bring a
second gateway back:

1. Widen `GatewayProvider` in `src/adapters/types.ts` and add a config branch in
   `src/config.ts` (+ `GATEWAY_PROVIDERS`).
2. Add `src/adapters/<name>.ts` exporting a factory → `AdapterRuntime`, and
   register it in `src/adapters/index.ts`.
3. Reintroduce per-gateway translation in `src/model-map.ts` (verify ids against
   the gateway's live catalog, don't guess).
4. Widen `Gateway` in `@weldsuite/credits/gateway-costs` to match, and extend the
   Env types + `wrangler.toml` docs of `app-api` / `workflow-worker`.
5. Run the unit tests, then the live `smoke` script above.
