/**
 * The AI catalog of the Kubernetes editions (ADR AI-012,
 * `weldsuite-documentation/plans/eu-ai-mistral.md`): providers with their region, the models they
 * serve with capabilities and context, each provider's task map, and the
 * features a workspace admin can route.
 *
 * One source of truth (AI-006): `pnpm rust:catalogs` exports this, with the
 * prices of `billing-rates.ts`, to `rust/catalogs/ai.json`, which
 * `rust/crates/ai` (`catalog.rs`) loads. The Rust enums (`ProviderId`, `Task`,
 * `Feature`, `Capability`) are checked against the JSON both ways.
 *
 * Global doesn't read this: it keeps routing through the Cloudflare gateway
 * with `recommended` (`models.ts`). Call sites on the Kubernetes editions ask
 * for a task and tier of `recommended`, and the policy resolver turns them into
 * a model through the chosen provider's task map below.
 *
 * Pure data and lookups: no env, no network.
 */

import { recommended, thirdParty } from "./models.js";

/** Where a provider processes data. An endpoint a US company runs is `outside-eu`. */
export type AiRegion = "eu" | "outside-eu";

/**
 * - `mistral`: the EU edition's install provider.
 * - `anthropic`, `openai`: opt-in, outside the EU.
 * - `compat`: a self-hosted install's own OpenAI-compatible endpoint (vLLM,
 *   Ollama, Azure); its region and models come from the install
 *   (`AI_COMPAT_REGION`, `AI_COMPAT_MODEL`, `AI_COMPAT_EMBED_MODEL`).
 */
export type AiProviderId = "mistral" | "anthropic" | "openai" | "compat";

/**
 * What a model can do. Every chat model streams, so the chat tasks need
 * `stream` (see {@link TASK_NEEDS}); `ocr` is a dedicated OCR endpoint.
 * `computer_use`: it can drive a desktop from screenshots. WeldAgent's
 * `computer_use` tool (the sandbox of the Kubernetes editions,
 * `rust/crates/sandbox`) is offered only when the turn's model has it.
 */
export type AiCapability =
  | "tools"
  | "json_schema"
  | "file_input"
  | "vision"
  | "stream"
  | "embed"
  | "stt"
  | "ocr"
  | "computer_use";

/** The tasks of `recommended` (`models.ts`). */
export type AiTask = keyof typeof recommended;

export type AiTier = "free" | "quality";

/** The unit an admin can route, and the `op` on each credit charge. */
export type AiFeature =
  | "mail"
  | "desk-translate"
  | "forms"
  | "board"
  | "connect"
  | "books-ocr"
  | "files"
  | "data"
  | "search"
  | "reach"
  | "merge"
  | "meet"
  | "assistant"
  | "agents"
  | "search-index"
  | "reach-warmup"
  | "mail-review";

export const AI_CAPABILITIES: readonly AiCapability[] = [
  "tools",
  "json_schema",
  "file_input",
  "vision",
  "stream",
  "embed",
  "stt",
  "ocr",
  "computer_use",
];

/** Every task, in `recommended`'s order. */
export const AI_TASKS = Object.keys(recommended) as AiTask[];

export interface AiProviderEntry {
  id: AiProviderId;
  label: string;
  /** `null`: set by the install (`compat`). */
  region: AiRegion | null;
  /** `install`: the install's provider, always on. `opt-in`: a workspace admin enables it. */
  offered: "install" | "opt-in";
  /** The API the backend speaks to it. */
  api: "openai-compatible" | "anthropic";
  /** The default base URL (`null`: the install's). */
  baseUrl: string | null;
}

export const AI_PROVIDERS: readonly AiProviderEntry[] = [
  {
    id: "mistral",
    label: "Mistral",
    region: "eu",
    offered: "install",
    api: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
  },
  {
    id: "anthropic",
    label: "Claude",
    region: "outside-eu",
    offered: "opt-in",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
  },
  {
    id: "openai",
    label: "ChatGPT",
    region: "outside-eu",
    offered: "opt-in",
    api: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    id: "compat",
    label: "OpenAI-compatible endpoint",
    region: null,
    offered: "install",
    api: "openai-compatible",
    baseUrl: null,
  },
];

export interface AiModelEntry {
  /** Canonical id, with the provider prefix (stripped when calling the provider). */
  id: string;
  provider: AiProviderId;
  label: string;
  capabilities: AiCapability[];
  /** Context window in tokens; `null` where it doesn't apply. */
  context: number | null;
  /** The provider's retirement date: still callable, left out of pickers. */
  retires: string | null;
}

const CHAT: AiCapability[] = [
  "tools",
  "json_schema",
  "file_input",
  "vision",
  "stream",
];

/**
 * A chat model that also drives a desktop from screenshots: the Claude 5.5
 * models and GPT-5. The opt-in providers only, so computer use on the
 * Kubernetes editions always runs on a model labelled outside the EU.
 */
const CHAT_COMPUTER: AiCapability[] = [...CHAT, "computer_use"];

export const AI_MODELS: readonly AiModelEntry[] = [
  // Mistral. Ids, context and capabilities from the model cards on
  // docs.mistral.ai, last verified 2026-11-13 (prices: billing-rates.ts).
  {
    id: thirdParty.mistral.small,
    provider: "mistral",
    label: "Mistral Small 4",
    capabilities: CHAT,
    context: 262_144,
    retires: null,
  },
  {
    id: thirdParty.mistral.medium,
    provider: "mistral",
    label: "Mistral Medium 3.5",
    capabilities: CHAT,
    context: 262_144,
    retires: "2027-04-30",
  },
  {
    id: thirdParty.mistral.large,
    provider: "mistral",
    label: "Mistral Large 4",
    capabilities: CHAT,
    context: 1_000_000,
    retires: null,
  },
  {
    id: thirdParty.mistral.ocr,
    provider: "mistral",
    label: "Mistral OCR 4.1",
    capabilities: ["ocr", "file_input", "vision"],
    context: null,
    retires: null,
  },
  {
    id: thirdParty.mistral.embed,
    provider: "mistral",
    label: "Mistral Embed",
    capabilities: ["embed"],
    context: 8_192,
    retires: null,
  },
  {
    id: thirdParty.mistral.transcribe,
    provider: "mistral",
    label: "Voxtral Mini Transcribe 3",
    capabilities: ["stt"],
    context: null,
    retires: null,
  },
  // Anthropic (opt-in, outside the EU).
  {
    id: thirdParty.anthropic.haiku55,
    provider: "anthropic",
    label: "Claude Haiku 5.5",
    capabilities: CHAT_COMPUTER,
    context: 200_000,
    retires: null,
  },
  {
    id: thirdParty.anthropic.sonnet55,
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    capabilities: CHAT_COMPUTER,
    context: 200_000,
    retires: null,
  },
  {
    id: thirdParty.anthropic.opus55,
    provider: "anthropic",
    label: "Claude Opus 5.5",
    capabilities: CHAT_COMPUTER,
    context: 200_000,
    retires: null,
  },
  // OpenAI (opt-in, outside the EU).
  {
    id: thirdParty.openai.gpt5Mini,
    provider: "openai",
    label: "GPT-5 mini",
    capabilities: CHAT,
    context: 400_000,
    retires: null,
  },
  {
    id: thirdParty.openai.gpt5,
    provider: "openai",
    label: "GPT-5",
    capabilities: CHAT_COMPUTER,
    context: 400_000,
    retires: null,
  },
];

/**
 * What an install's own OpenAI-compatible model (`compat`) is assumed to do:
 * chat with tools and JSON schema answers. Its embeddings model adds `embed`.
 */
export const COMPAT_CAPABILITIES: readonly AiCapability[] = [
  "tools",
  "json_schema",
  "stream",
];

export interface AiTaskModels {
  free: string;
  quality: string;
}

/**
 * Each provider's task map. A task a provider leaves out isn't served by it:
 * the resolver goes on to the next rule. Embeddings and transcription are
 * Mistral's only (and the install's own models on `compat`), and nobody
 * serves `rerank` on the Kubernetes editions (EU search keeps its own order).
 *
 * Mistral Medium 3.5 is deprecated, so the plan's "Medium" slots use Large 4,
 * its replacement (cheaper, and newer).
 */
export const PROVIDER_TASKS: Readonly<
  Record<AiProviderId, Partial<Record<AiTask, AiTaskModels>>>
> = {
  mistral: {
    classify: {
      free: thirdParty.mistral.small,
      quality: thirdParty.mistral.small,
    },
    evaluate: {
      free: thirdParty.mistral.small,
      quality: thirdParty.mistral.small,
    },
    sentiment: {
      free: thirdParty.mistral.small,
      quality: thirdParty.mistral.small,
    },
    translate: {
      free: thirdParty.mistral.small,
      quality: thirdParty.mistral.large,
    },
    summarize: {
      free: thirdParty.mistral.large,
      quality: thirdParty.mistral.large,
    },
    draft: {
      free: thirdParty.mistral.large,
      quality: thirdParty.mistral.large,
    },
    copilot: {
      free: thirdParty.mistral.large,
      quality: thirdParty.mistral.large,
    },
    ocr: { free: thirdParty.mistral.ocr, quality: thirdParty.mistral.ocr },
    embed: {
      free: thirdParty.mistral.embed,
      quality: thirdParty.mistral.embed,
    },
    transcribe: {
      free: thirdParty.mistral.transcribe,
      quality: thirdParty.mistral.transcribe,
    },
  },
  anthropic: {
    classify: {
      free: thirdParty.anthropic.haiku55,
      quality: thirdParty.anthropic.haiku55,
    },
    evaluate: {
      free: thirdParty.anthropic.haiku55,
      quality: thirdParty.anthropic.haiku55,
    },
    sentiment: {
      free: thirdParty.anthropic.haiku55,
      quality: thirdParty.anthropic.haiku55,
    },
    translate: {
      free: thirdParty.anthropic.haiku55,
      quality: thirdParty.anthropic.sonnet55,
    },
    summarize: {
      free: thirdParty.anthropic.sonnet55,
      quality: thirdParty.anthropic.sonnet55,
    },
    draft: {
      free: thirdParty.anthropic.sonnet55,
      quality: thirdParty.anthropic.opus55,
    },
    copilot: {
      free: thirdParty.anthropic.sonnet55,
      quality: thirdParty.anthropic.opus55,
    },
    ocr: {
      free: thirdParty.anthropic.haiku55,
      quality: thirdParty.anthropic.sonnet55,
    },
  },
  openai: {
    classify: {
      free: thirdParty.openai.gpt5Mini,
      quality: thirdParty.openai.gpt5Mini,
    },
    evaluate: {
      free: thirdParty.openai.gpt5Mini,
      quality: thirdParty.openai.gpt5Mini,
    },
    sentiment: {
      free: thirdParty.openai.gpt5Mini,
      quality: thirdParty.openai.gpt5Mini,
    },
    translate: {
      free: thirdParty.openai.gpt5Mini,
      quality: thirdParty.openai.gpt5,
    },
    summarize: {
      free: thirdParty.openai.gpt5,
      quality: thirdParty.openai.gpt5,
    },
    draft: { free: thirdParty.openai.gpt5, quality: thirdParty.openai.gpt5 },
    copilot: { free: thirdParty.openai.gpt5, quality: thirdParty.openai.gpt5 },
    ocr: { free: thirdParty.openai.gpt5Mini, quality: thirdParty.openai.gpt5 },
  },
  // The install's configured models serve every chat task and `embed`.
  compat: {},
};

/**
 * What a task needs of a model, on top of the feature's needs: a chat model
 * for the chat tasks, file input for OCR (Mistral OCR, or a chat model with
 * native file input), embeddings, speech to text.
 */
export const TASK_NEEDS: Readonly<Record<AiTask, AiCapability[]>> = {
  classify: ["stream"],
  evaluate: ["stream"],
  sentiment: ["stream"],
  summarize: ["stream"],
  translate: ["stream"],
  draft: ["stream"],
  copilot: ["stream"],
  embed: ["embed"],
  rerank: [],
  transcribe: ["stt"],
  ocr: ["file_input"],
};

export interface AiFeatureEntry {
  id: AiFeature;
  /** The tasks it runs; the first is the one its model picker is for. */
  tasks: AiTask[];
  /** What a model needs to serve it, besides its task's needs. */
  needs: AiCapability[];
  /** Whether an admin may move it off the install provider. */
  overridable: boolean;
}

/** The "Features" table of `weldsuite-documentation/plans/eu-ai-mistral.md`. */
export const AI_FEATURES: readonly AiFeatureEntry[] = [
  {
    id: "mail",
    tasks: ["draft", "summarize", "classify"],
    needs: ["json_schema"],
    overridable: true,
  },
  {
    id: "desk-translate",
    tasks: ["translate"],
    needs: ["json_schema"],
    overridable: true,
  },
  { id: "forms", tasks: ["draft"], needs: ["json_schema"], overridable: true },
  {
    id: "board",
    tasks: ["draft", "classify", "summarize"],
    needs: ["json_schema"],
    overridable: true,
  },
  {
    id: "connect",
    tasks: ["copilot", "draft", "classify"],
    needs: ["json_schema"],
    overridable: true,
  },
  { id: "books-ocr", tasks: ["ocr"], needs: ["file_input"], overridable: true },
  {
    id: "files",
    tasks: ["summarize"],
    needs: ["file_input"],
    overridable: true,
  },
  {
    id: "data",
    tasks: ["draft", "classify"],
    needs: ["json_schema"],
    overridable: true,
  },
  {
    id: "search",
    tasks: ["classify"],
    needs: ["json_schema"],
    overridable: true,
  },
  {
    id: "reach",
    tasks: ["classify"],
    needs: ["json_schema"],
    overridable: true,
  },
  { id: "merge", tasks: ["summarize"], needs: [], overridable: true },
  // Summaries may move; transcription stays on the install provider, whose
  // task map is the only one with `transcribe`.
  {
    id: "meet",
    tasks: ["summarize", "transcribe"],
    needs: [],
    overridable: true,
  },
  {
    id: "assistant",
    tasks: ["copilot"],
    needs: ["tools", "stream"],
    overridable: true,
  },
  { id: "agents", tasks: ["copilot"], needs: ["tools"], overridable: true },
  // Fixed: vectors from two models can't share an index.
  { id: "search-index", tasks: ["embed"], needs: [], overridable: false },
  // Fixed: a system job with no customer content.
  { id: "reach-warmup", tasks: ["draft"], needs: [], overridable: false },
  // Fixed: WeldSuite's own outbound abuse control stays in the EU.
  { id: "mail-review", tasks: ["classify"], needs: [], overridable: false },
];

/** The catalog entry of a canonical model id. */
export function aiModel(id: string): AiModelEntry | undefined {
  return AI_MODELS.find((model) => model.id === id);
}

export function aiProvider(id: AiProviderId): AiProviderEntry {
  const provider = AI_PROVIDERS.find((entry) => entry.id === id);
  if (!provider) throw new Error(`[@weldsuite/ai] unknown AI provider ${id}`);
  return provider;
}

export function aiFeature(id: AiFeature): AiFeatureEntry {
  const feature = AI_FEATURES.find((entry) => entry.id === id);
  if (!feature) throw new Error(`[@weldsuite/ai] unknown AI feature ${id}`);
  return feature;
}

/** The model `provider` serves `task` with at `tier`, or `null` when it doesn't serve it. */
export function taskModel(
  provider: AiProviderId,
  task: AiTask,
  tier: AiTier,
): string | null {
  return PROVIDER_TASKS[provider][task]?.[tier] ?? null;
}

/** What a model needs to serve `task` for `feature`. */
export function featureNeeds(feature: AiFeature, task: AiTask): AiCapability[] {
  return [...new Set([...aiFeature(feature).needs, ...TASK_NEEDS[task]])];
}

/** Whether the catalog model `id` has every capability in `needs`. */
export function modelHas(id: string, needs: readonly AiCapability[]): boolean {
  const model = aiModel(id);
  return (
    model !== undefined &&
    needs.every((need) => model.capabilities.includes(need))
  );
}
