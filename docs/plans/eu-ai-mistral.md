# EU AI: Mistral by default, other providers by workspace opt-in

Status: planned (2026-11-13). Recorded in ADR AI-012 (Proposed) in
`weldsuite-documentation`, which replaces AI-011 ("no AI on the EU edition
until an EU provider is chosen") feature by feature as each port lands. Global
is unchanged.

Decided with Gert (2026-11-13):

- **Mistral is the EU edition's AI provider** for every AI feature: chat,
  structured output, OCR, embeddings and speech-to-text. A workspace starts on
  Mistral and stays on it unless an admin changes that.
- **Workspace admins may opt in to providers outside the EU**: Anthropic
  (Claude) and OpenAI (ChatGPT). The providers are off by default and labelled as
  outside the EU, as OPS-012 requires for any integration that sends data out
  of the EU.
- **Both key sources.** For each non-EU provider, the admin chooses WeldSuite's
  account, which is charged as AI credits, or the workspace's own API key, which
  is not charged.
- **Admin sets a default and per-feature overrides.** Enabling a provider changes
  nothing by itself. The admin can make it the workspace default, or pick it
  (and optionally a model) for a single feature. Model pickers show only the
  enabled providers.
- **Mistral is paid in credits, as on Global.** Every call is metered into the
  workspace credit wallet at the shared rate table, charging the model that
  served (AI-005, AI-006). The hard 402 gate (AI-007) switches on once the EU
  edition has a credit top-up (Mollie). Until then calls are charged but not
  blocked.
- **WeldAgent comes later, on our own agent loop in Rust**, not on Claude
  Managed Agents and not on Mistral's Agents API. It is phase 5 and gets its
  own plan.

## Where we start

- The Rust backend has **no LLM port**. The only AI port is `Embeddings`
  (`rust/crates/ports/src/embeddings.rs`), with an OpenAI-compatible adapter
  (`rust/crates/adapters-oss/src/embeddings.rs`). On EU it is switched off
  (`consume.embeddings` unset), so the semantic search index is off.
- AI features are listed in the static `UNAVAILABLE_FEATURES`
  (`rust/bins/weldsuite/src/edition.rs`) and in `EDITION_FEATURES`
  (`apps/web/platform/lib/edition.ts`), and are hidden: `mail-ai`,
  `weldconnect-ai`, `books-ocr`, `meet-transcription`, `agent-ai`, `desk-ai`,
  `forms-ai`.
- How the AI routes answer in Rust today:

  | Behaviour | Routes |
  |---|---|
  | 404, not mounted | `/api/mail-ai/*` (8 routes), `/api/workflows/generate`, `/api/search/reindex`, and the whole `agent` module (`/api/ai`, `/api/ai-models`, `/api/weldagent`) |
  | 503 `ai_unavailable` | forms AI (`forms/src/routes/ai.rs`), desk translation (`desk/src/channels/translation.rs`), Connect builder, board AI, books `/process`, meet transcribe/summarize |
  | Runs without the model | WeldReach replies stay `unclassified`, Connect `ai_generate`/`ai_classify` steps are refused, WeldData AI actions are skipped, files understanding passes `model_failed` through |

  All of these routes are in `excludedRoutes` in `rust/conformance/suites.json`.
- **WeldMerge release notes** (`rust/modules/merge/src/releases/notes.rs`) are
  the one real LLM client in Rust. They call the **Cloudflare AI Gateway**
  whenever `CF_ACCOUNT_ID` is set, and answer 503 otherwise. That is a US path
  on EU, and phase 1 closes it.
- **The credit wallet exists in Rust** (master `workspace_credits` +
  `credit_transactions`), written through `social-domain::credits`. Workspaces
  get credits at onboarding. There is no top-up (`credit-top-up` is
  unavailable) and no refill cron.
- **No workspace-level AI setting exists**, on either backend. The only model
  choice is a mail account's `aiSettings.modelPreference`. Model ids sent by
  clients (`/api/ai` `model`, mail `modelId`, workflow `inputs.model`, CRM
  `model`) are never checked against a list, so the policy has to be enforced
  in the backend's AI layer, not only in the UI.

## Design

### Providers and regions

| Provider | Region label | How it is called from EU | Key | Offered |
|---|---|---|---|---|
| Mistral | EU | Directly, `https://api.mistral.ai/v1` (phase 0 checks whether the DPA needs an EU-only host) | WeldSuite's (`MISTRAL_API_KEY`) | Always; the install default |
| Anthropic | Outside the EU | Directly, Messages API (`api.anthropic.com`). Not through the Cloudflare gateway: that would add a second US processor. | WeldSuite's (`ANTHROPIC_API_KEY`, a separate account from Global's) or the workspace's own | Opt-in |
| OpenAI | Outside the EU | Directly, `api.openai.com/v1` | WeldSuite's (`OPENAI_API_KEY`) or the workspace's own | Opt-in |
| OpenAI-compatible endpoint | Set by the install (`eu` or `outside-eu`) | The configured base URL (vLLM, Ollama, Azure) | The install's | Self-hosted installs; an in-cluster EU fallback |

A provider's region comes from the catalog, never from the workspace. An
endpoint that a US company runs counts as "outside the EU", even when the
company offers EU data residency.

### Model catalog and tasks

Call sites ask for a **task and tier**, not a model:
`ai.run(feature, Task::Draft, Tier::Quality, …)`. The resolver turns that into
a model through the chosen provider's task map. The tasks and tiers are the
ones in `recommended` (`packages/core/ai/src/models.ts`): `{ free, quality }`
per task.

Mistral's map. The table names model families. Phase 0 pins dated model ids,
because prices are keyed on the id and the `-latest` aliases move:

| Task | `free` | `quality` | API |
|---|---|---|---|
| classify, sentiment, evaluate | Mistral Small | Mistral Small | chat, `response_format: json_schema` |
| translate | Mistral Small | Mistral Medium | chat, json_schema |
| summarize | Mistral Medium | Mistral Medium | chat |
| draft, copilot | Mistral Medium | Mistral Large | chat (tools, streaming for the assistant) |
| ocr | Mistral OCR (+ Small to extract fields) | same | `POST /v1/ocr`; its document annotations may do the extraction in one call |
| embed | `mistral-embed` (1024 dimensions, the search index's `EMBED_DIMENSIONS`) | same | `/v1/embeddings` (existing adapter) |
| transcribe | Voxtral (transcription) | same | `/v1/audio/transcriptions` |
| rerank | none: EU search keeps its own order | | |

Anthropic and OpenAI get the same kind of map: Haiku / Sonnet / Opus 5.5,
GPT-5 mini / GPT-5. Embeddings and transcription are Mistral-only (see
"Features").

**One source of truth (AI-006).** The catalog lives in TypeScript next to the
rate table, as every shared catalog does: models with provider, region,
capabilities (`tools`, `json_schema`, `file_input`, `vision`, `stream`,
`embed`, `stt`) and prices, the per-provider task maps, and the feature list
below. It goes in `packages/core/ai/src/` (`models.ts`, `billing-rates.ts`,
`model-map.ts` gain Mistral; a new `catalog.ts` holds the rest).
`pnpm rust:catalogs` exports it to `rust/catalogs/ai.json`, and `crates/catalogs`
generates the Rust types. Mistral prices land in `MODEL_PRICES`, so a workspace
moved between Global and EU pays the same for the same model. Global never
selects a Mistral id, so its behaviour doesn't change.

### Features

The unit an admin can override, and the `op` written on each credit charge:

| Feature | Covers | Task(s) | Needs | Admin can override |
|---|---|---|---|---|
| `mail` | drafts, replies, improve text, smart replies, inbox summary, labels, inbound auto-label | draft, summarize, classify | json_schema | yes |
| `desk-translate` | WeldDesk inbox translation | translate | json_schema | yes |
| `forms` | generate a form, suggest questions, summarise answers | draft (quality) | json_schema | yes |
| `board` | WeldBoard AI | draft, classify, summarize (quality) | json_schema | yes |
| `connect` | "Generate with AI", `ai_generate` / `ai_classify` steps | copilot (quality), draft, classify | json_schema | yes; a step's own model choice is checked against the policy |
| `books-ocr` | document OCR | ocr | file input | yes: Mistral OCR, or Claude/OpenAI with native file input |
| `files` | files understanding | summarize | file input | yes |
| `data` | WeldData AI actions | draft, classify | json_schema | yes |
| `search` | search query understanding | classify | json_schema | yes |
| `reach` | reply labels | classify | json_schema | yes |
| `merge` | release notes | summarize (quality) | none | yes |
| `meet` | summaries / transcripts | summarize / transcribe | / audio | summaries yes; transcription no |
| `assistant` | the assistant chat and drawer | copilot | tools, streaming | yes |
| `agents` | WeldAgent (phase 5) | copilot | tools | yes |
| `search-index` | embeddings | embed | | **no**: install-level. Vectors from two models can't be mixed in one index |
| `reach-warmup` | the warmup corpus | draft | | **no**: a system job with no customer content |
| `mail-review` | outbound abuse review (`TemplateClassifier`) | classify | | **no**: WeldSuite's own abuse control stays in the EU |

### Workspace policy

Stored per workspace (tenant DB, see "Schema"):

```ts
{
  providers: {            // the install default is always enabled
    anthropic?: { enabled: boolean; keySource: 'weldsuite' | 'own'; enabledBy; enabledAt }
    openai?:    { … }
  },
  defaultProvider: 'mistral' | 'anthropic' | 'openai',
  featureOverrides: { [feature]: { provider: string; model?: string } },
}
```

**Resolution** (`crates/ai::policy::resolve`), for a call from a feature at a
task and tier:

1. **An explicit model**, from the request (`model` / `modelId`) or stored on a
   record (a mail account's `modelPreference`, a workflow step's model). It is
   used only if its provider is enabled for the workspace and the model has the
   capabilities the feature needs. Otherwise:
   - a request answers 422 `AI_MODEL_NOT_ALLOWED`;
   - a stored choice is skipped with a log line, and resolution goes on.
2. **The feature's override**: its provider and model, or the provider's task
   map when no model is set.
3. **The workspace default provider's** task map.
4. **The install default** (Mistral on EU).

**Rules that hold whatever the settings say:**

- **A provider that isn't enabled is never called.** Disabling a provider
  sends every default, override and stored choice that pointed at it back to the
  install default at once. No migration of records is needed, because the
  resolver checks on every call.
- **Fallback never leaves the EU.**
  - A refusal from a non-EU provider (AI-004's list: 5xx, 401, 402, 403, 429,
    credit messages) falls back to Mistral's model for the same task and tier.
    It is charged at Mistral's price on WeldSuite's account (AI-005), whatever
    the key source was. File calls fall back too: from native file input to
    Mistral OCR.
  - A failing **own key** (401/402/403) is marked `failing` on the settings
    page and falls back the same way.
  - A Mistral refusal falls back only to `ai.fallbackModel` when the install
    sets one, and it must be an EU model (for example an in-cluster vLLM).
    Config validation rejects a non-EU fallback. Otherwise the call fails, and
    the route answers as the TypeScript worker does without its model.
- **Labels.** Every AI surface that runs on a non-EU provider shows it (a
  "Claude · outside the EU" badge in the mail AI menu, the Connect step, the
  assistant header). The resolved provider comes back with each AI response
  (`meta.ai.provider`) or from the policy endpoint.

### Keys

- **WeldSuite's account.** The keys are in the install's Secret. A provider is
  offered with this source only when its key is there.
- **The workspace's own key.**
  - Stored in `ai_provider_keys`, sealed with AES-256-GCM under a new
    `AI_KEYS_ENCRYPTION_KEY` secret. The AAD is `ai_provider_keys:<workspaceId>:<provider>`,
    so a row copied onto another workspace fails to open. This is the same
    construction as `rust/crates/db/src/crypto.rs`.
  - The key is checked when it is saved, with a cheap call (list models).
  - Only a hint is ever returned (`sk-…a1b2`). The key never goes back to the
    browser, into an entity event or into a log.
  - Removing the key is an action of its own: disabling the provider keeps the
    key, so re-enabling it takes one click.
- Own-key calls are **not charged**. They are counted per provider and month
  for the settings page (`ai_provider_usage`, `key_source = 'own'`, no cost to
  WeldSuite).

### Metering

- A Rust twin of `@weldsuite/core-domain/ai-billing`, in `crates/ai::billing`:
  `resolve_metering`, `assert_credits`, `charge_usage` (AI-005 to AI-007:
  charge the model that served, `max(1, ceil(cost × 2.5 × 100))` credits). The
  wallet writes move from `social-domain::credits` into `core-domain`, so that
  social, merge, call, meet and AI share them.
- Every charge on WeldSuite's account also writes the ops ledger
  (`ai_provider_usage`) with what WeldSuite paid Mistral, Anthropic or OpenAI.
  That closes, for EU, the gap the AI platform doc lists for Global.
- **The gate is off until the top-up exists.**
  - `ai.creditGate: false`: calls are charged, and a balance may go negative,
    booked as debt (AI-007's overdraft rule).
  - Phase 4 adds the Mollie top-up and sets it to `true`, which turns on the
    402 `INSUFFICIENT_CREDITS` gate.
  - Self-hosted installs set `ai.billing: display`: they meter for display and
    never charge, as the editions design says.

### `crates/ai`

The crate the editions design reserved (`rust/crates/ai`). It holds:

- `catalog`: the generated catalog: models, prices, task maps, features.
- `policy`: settings → route (provider, model, key, fallback chain), with the
  rules above, and the settings cached in Valkey per workspace (60 s, cleared
  on write).
- `providers`:
  - `openai_compat`: chat completions for Mistral, OpenAI, vLLM and Ollama:
    tools, `json_schema`, SSE streaming, and image and document parts where
    the model has them.
  - `anthropic`: the Messages API: tools, structured output through a forced
    tool call, files, streaming. Anthropic's OpenAI-compatible endpoint is
    meant for testing, not production, so it isn't used.
  - `mistral_ocr`: the OCR endpoint, with annotations.
  - `transcription`: OpenAI-compatible `/audio/transcriptions` (Voxtral).

  Each provider shapes its own requests: sampling ranges, `max_tokens` naming,
  Claude 5.x refusing non-default sampling (`sampling.ts`).
- `fallback`: refusal detection, ported from `fallback.ts` and kept in step
  with it.
- `billing`: as above.
- `FakeProvider`: for unit tests and conformance.

Also:

- **HTTP** goes through `OutboundHttp` / `ReqwestOutbound`. Timeouts are 10 s
  to connect and 120 s overall (300 s for OCR and transcription). Calls are
  retried on 429 with backoff, honouring `Retry-After`.
- **Logging and traces** carry the workspace, feature, provider, model, tokens
  and latency. They never carry prompts or completions.
- **Wiring:**
  - `config.rs` reads an `AiConfig`, and `AppState` gains `ai: Option<Arc<Ai>>`.
  - The `consume` (search index, reach labels, inbound labels), `cron` and
    workflow roles build the same `Ai`.
  - `weldsuite doctor` checks each configured key, and that the default models
    answer.

### Install configuration

Helm `config.ai` (env names in brackets):

```yaml
ai:
  defaultProvider: mistral        # AI_DEFAULT_PROVIDER; empty = AI off (self-hosted default)
  mistral:
    baseUrl: https://api.mistral.ai/v1   # AI_MISTRAL_BASE_URL
  optIn:                          # what workspaces may enable, and with which key
    anthropic: { weldsuiteKey: true, ownKey: true }   # AI_OPTIN_ANTHROPIC=weldsuite,own
    openai:    { weldsuiteKey: true, ownKey: true }   # AI_OPTIN_OPENAI=weldsuite,own
  openaiCompatible:               # self-hosted: the customer's endpoint
    baseUrl: ""                   # AI_COMPAT_BASE_URL
    region: eu                    # AI_COMPAT_REGION (eu | outside-eu)
  fallbackModel: ""               # AI_FALLBACK_MODEL; must be an EU model
  creditGate: false               # AI_CREDIT_GATE
  billing: credits                # AI_BILLING (credits | display)
```

| Secret key | Holds |
|---|---|
| `MISTRAL_API_KEY` | WeldSuite's Mistral key; also used as `EMBEDDINGS_API_KEY` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | WeldSuite's EU-edition accounts; optional |
| `AI_COMPAT_API_KEY` | the self-hosted endpoint's key; optional |
| `AI_KEYS_ENCRYPTION_KEY` | 64 hex characters; seals workspaces' own keys. Losing it loses every stored own key, nothing else |

- EU's Flux values (`rust/deploy/flux/apps/eu/values/weldsuite.yaml`) set
  `ai.defaultProvider: mistral` and `consume.embeddings` (Mistral URL,
  `mistral-embed`). The keys go in the SOPS secret `weldsuite-env`.
- Self-hosted keeps `defaultProvider` empty until the customer sets one. With
  `openaiCompatible` set, its default is `compat`.

### `/config.json` and the platform

- `describe()` adds an `ai` block when a default provider is configured:
  `{ defaultProvider, providers: [{ id, region, keySources }] }`.
- The AI entries leave the static `UNAVAILABLE_FEATURES`:
  - `unavailable_features()` adds them back when no provider is configured,
    following the `mail-domains` pattern;
  - each feature stays listed until its port (phase 3) lands.
  - `EDITION_FEATURES` in `apps/web/platform/lib/edition.ts` follows the same
    change.
- `agent-ai` splits into `assistant-ai` (the assistant chat and drawer, phase
  3e) and `agent-ai` (agents, routines, teach mode; phase 5).

### API

Rust `core-platform`, a new prefix `/api/ai-settings` registered to `core` in
`packages/core/api-modules`. Global's app-api doesn't serve it, and the
platform calls it only when `/config.json` has `ai` (check that the ownership
test accepts a Rust-only prefix).

| Route | Permission | What |
|---|---|---|
| `GET /api/ai-settings` | any member | The effective policy: providers with region and enabled state, default, overrides, and the models each feature may use (the source for every model picker on EU). Admins also see key status (hint, `ok`/`failing`, last checked). |
| `PUT /api/ai-settings` | `ai:manage` | Providers, default, overrides. Enabling a non-EU provider needs `acknowledgedOutsideEu: true` in the body. An override is checked against the feature's capabilities. |
| `PUT /api/ai-settings/keys/:provider` | `ai:manage` | Store and check an own key |
| `POST /api/ai-settings/keys/:provider/test` | `ai:manage` | Check the stored key again |
| `DELETE /api/ai-settings/keys/:provider` | `ai:manage` | Remove the key (204) |
| `GET /api/ai-settings/usage` | `ai:manage` | Credits and tokens per provider and feature, this month and last month |

- **Permission.** `ai:manage` is a new key in `@weldsuite/permissions`,
  OWNER and ADMIN by default; then `pnpm rust:catalogs`.
- **Events.** Mutations publish `ai_settings.updated`,
  `ai_provider_key.set` and `ai_provider_key.removed`, carrying the provider
  and key hint only. Enabling a non-EU provider also emails the workspace
  owners (`@weldsuite/emails`, en/nl), naming who enabled it.

### Platform UI

`app/settings/ai/` (route `src/routes/settings/ai/`), shown when
`/config.json` has `ai` and the member has `ai:manage`. Built from
`@weldsuite/ui` only (`SettingsPage`, `SettingsSection`, `SettingRow`,
`ConfirmDialog`, `InfoBanner`, `SoftBadge`, `FilterSelect`).

1. **Providers.**
   - Mistral is shown as "Processed in the EU · default".
   - Claude and ChatGPT are shown as "Outside the EU", each with a switch.
     Turning one on opens a `ConfirmDialog`: what leaves the EU, to whom, and
     an acknowledgement checkbox. Then the admin chooses the key source:
     "WeldSuite's account (uses AI credits)" or "Our own API key", with a
     masked field, a hint after saving, a Test button and the status.
2. **Default provider**, chosen from the enabled ones.
3. **Per feature**: one row per overridable feature: Default / a provider / a
   specific model. The fixed features are shown read-only ("Search index:
   Mistral, set by WeldSuite").
4. **Usage**: credits per provider and feature, and own-key tokens.

Pickers that exist today read `GET /api/ai-settings` on EU and show the region
badge:

- the mail account AI dialog (`ai-settings-dialog.tsx`, which today reads the
  stale `AVAILABLE_MODELS`);
- the Connect AI step;
- later the agent model picker.

Every new string goes in `en` and `nl` (`packages/core/i18n`). The
library-level labels go through `UiLabelsProvider`.

### Tests and conformance

- **`crates/ai`**: unit tests for every resolution rule, the fallback chains,
  capability checks, the "never call a disabled provider" property, request
  shaping per provider, and sealing (a key copied to another workspace fails).
- **Settings routes**: tests for permissions (a member can't write; `ai:manage`
  can), the acknowledgement rule, key hint only, and events.
- **Each ported AI route** leaves `excludedRoutes` and joins the conformance
  suites.
  - Both backends point at one mock OpenAI-compatible server. TypeScript's
    `@weldsuite/ai` needs a test-only base-URL override for that, because
    `config.ts` builds Cloudflare URLs.
  - The model id in ledger descriptions is normalised, since Global's default
    is Llama and EU's is Mistral.
- **Platform**: Vitest for the settings page and pickers, and one Playwright
  spec against the Kubernetes test environment (enable Claude with an own key,
  set it for `mail`, check the badge).

## Phases

**Phase 0: decisions, accounts, paperwork** (no code)
- **ADR and design docs.** Drafted on 2026-11-13: AI-012 (Proposed), and
  updates to `ai-platform.md`, `editions-and-self-hosting.md`, its status page
  and `weldagent.md`. `billing-and-credits.md` follows with phase 4.
- **Mistral account.** Open the EU edition's Mistral account: DPA, rate-limit
  tier, zero data retention. Check its subprocessors. If the API is served
  from a US company's cloud in Paris, OPS-012's "EU companies only" needs a
  note in the ADR.
- **Anthropic and OpenAI accounts** for the EU edition's WeldSuite-key mode,
  separate from Global's and with zero data retention where offered. The EU
  edition's subprocessor list names them "only for workspaces that enable
  them".
- **Verify the Mistral details.** Pin model ids and prices; check the endpoint
  host, the OCR annotation API and Voxtral transcription.
- **Approve the schema** (below).

**Phase 1: `crates/ai` with Mistral as the install provider**
- The catalog in TypeScript and its `rust:catalogs` export. Mistral prices go
  in `MODEL_PRICES`.
- `crates/ai`:
  - the providers (OpenAI-compatible, Anthropic, Mistral OCR, transcription);
  - fallback and billing, with the wallet writes moved to `core-domain`;
  - the `FakeProvider`.
- `AiConfig`, the Helm values and templates, the EU Flux values and secret
  keys, `/config.json` `ai`, and `doctor`.
- The search index on EU through `mistral-embed`.
- WeldMerge release notes move from the Cloudflare gateway onto `crates/ai`,
  closing the US path.
- Done when: on the Kubernetes test environment, `doctor` reports AI healthy,
  the search index fills, release notes come from Mistral, and charges and ops
  rows are written.

**Phase 2: workspace AI settings**
- The schema migration, `ai:manage`, the `/api/ai-settings` routes, the policy
  resolver reading them, and own-key sealing.
- Events and the owners' email.
- The settings page and i18n.
- Done when: an admin can enable Claude with either key source, set a default
  and an override, and see the label. A member can't change anything. The
  resolver tests cover every rule.

**Phase 3: port the hidden AI features**, one PR per group. Each removes its
`unavailableFeatures` entry, mounts or un-refuses its routes in Rust, moves
them into the conformance suites, and adds the region badge.
- **3a. `mail`**: `/api/mail-ai/*`, inbound auto-label (Global uses Jev, which
  Mistral doesn't have, so EU uses a `classify` call with a schema), and the
  outbound review classifier.
- **3b. The small structured-output features**: `desk-translate`, `forms`,
  `board`, `search` (query understanding and `/api/search/reindex`), `reach`
  (labels and the warmup corpus on Mistral), `data`, `files`.
- **3c. `connect`**: `/api/workflows/generate` and the `ai_generate` /
  `ai_classify` steps. A step's model is checked against the policy.
- **3d. `books-ocr`**: Mistral OCR, then field extraction; native file input
  when the admin chose Claude or OpenAI, falling back to Mistral OCR.
- **3e. `assistant`**: `/api/ai/generate`, `/api/ai/chat` and
  `/api/ai/chat/stream` without `agentId`, with the persona tools and
  streaming.
  - Only these routes of the `agent` module are mounted. `agent` stays out of
    `RUST_PORTED_MODULES`, so the WeldAgent app stays hidden.
  - `assistant-ai` is split from `agent-ai`.
- **3f. `meet`**: summaries and Voxtral transcripts. Blocked until the
  Kubernetes editions record meetings (MEET-007 has no recordings); the
  feature stays hidden until then.

**Phase 4: credit top-up and the gate.** A Mollie top-up for the EU edition's
credit packages, the balance on the billing page, and `ai.creditGate: true`.
EU billing is bigger than AI, so this gets its own plan.

**Phase 5: WeldAgent on our own Rust agent loop.** Its own plan. In outline:
- a tool-calling loop over `crates/ai`, provider and model from the policy's
  `agents` feature;
- conversation state in the existing `weldagent_*` tenant tables;
- platform tools as Rust functions that run with the caller's permissions;
- the agent module's data routes, rooms, the routine cron and the `weldagent`
  subscriber;
- no sandbox, computer use or browsing at first (those toggles are hidden on
  EU);
- `WORKSPACE_AGENT_MODELS` becomes edition-aware.

## Schema (needs approval before any migration)

Tenant DB, in `packages/core/db/src/schema/ai-settings.ts`. The tables are
unused on Global.

- `ai_settings`, a singleton:
  - `id`
  - `providers` jsonb
  - `default_provider` varchar
  - `feature_overrides` jsonb
  - `updated_by`, `updated_at`
- `ai_provider_keys`:
  - `id`, `provider` (unique)
  - `ciphertext`, `key_hint`
  - `status` (`ok` | `failing`), `last_error`, `last_checked_at`
  - `created_by`, `created_at`

Master DB:

- `ai_provider_usage` gains `key_source` (`weldsuite` | `own`) and `feature`.

The migration is generated with `pnpm --filter @weldsuite/db db:generate`, and
the Rust runner picks it up from the journal.

## Risks and open points

- **Quality.** Mail drafting and Connect generation were tuned on Claude Sonnet.
  Mistral Medium/Large may need prompt changes, so each phase 3 PR compares a
  small set of real prompts before it ships.
- **One shared Mistral account.** Its rate limits are shared by every EU
  workspace. Phase 1 adds a per-workspace concurrency cap (Valkey) so that one
  workspace's bulk labelling can't starve the others; phase 0 asks for a
  higher tier.
- **Moving a workspace between Global and EU.** Global's search vectors are
  bge-m3 and EU's are `mistral-embed`, so they can't be mixed. A workspace
  imported into EU (or back) is reindexed, never copied.
- **Subprocessors.** Mistral's own hosting chain decides whether "EU companies
  only" (OPS-012) holds literally. Phase 0 settles it, and the ADR records the
  answer.
- **Prices drift.** `MODEL_PRICES` is maintained by hand. The Mistral prices get
  the same "last verified" header as the others.
- **Out of scope:**
  - Google Gemini as an opt-in (the catalog makes it a small addition later);
  - GPUs in the cluster;
  - any change to Global's providers;
  - Telnyx voice agents (they run inside Telnyx and are decided with the call
    module).
