import { describe, expect, it } from "vitest";

import {
  MODEL_PRICES,
  creditsForUsage,
  providerCostUsd,
} from "./billing-rates.js";
import {
  AI_CAPABILITIES,
  AI_FEATURES,
  AI_MODELS,
  AI_PROVIDERS,
  AI_TASKS,
  PROVIDER_TASKS,
  TASK_NEEDS,
  aiFeature,
  aiModel,
  featureNeeds,
  modelHas,
  taskModel,
} from "./catalog.js";
import { knownCanonicalIds } from "./model-map.js";
import { recommended } from "./models.js";

describe("AI catalog", () => {
  it("lists every task of `recommended`", () => {
    expect(AI_TASKS).toEqual(Object.keys(recommended));
    expect(Object.keys(TASK_NEEDS).sort()).toEqual([...AI_TASKS].sort());
  });

  it("gives every model a provider of the catalog, a known capability and a price", () => {
    const providers = new Set(AI_PROVIDERS.map((p) => p.id));
    for (const model of AI_MODELS) {
      expect(providers.has(model.provider), model.id).toBe(true);
      expect(model.id.startsWith(`${model.provider}/`), model.id).toBe(true);
      for (const capability of model.capabilities)
        expect(AI_CAPABILITIES).toContain(capability);
      expect(MODEL_PRICES[model.id], model.id).toBeDefined();
      expect(knownCanonicalIds()).toContain(model.id);
    }
  });

  it("maps tasks only to catalog models of the same provider that can do the task", () => {
    for (const [provider, tasks] of Object.entries(PROVIDER_TASKS)) {
      for (const [task, models] of Object.entries(tasks)) {
        for (const id of [models.free, models.quality]) {
          const model = aiModel(id);
          expect(model?.provider, `${provider}.${task}`).toBe(provider);
          expect(
            modelHas(id, TASK_NEEDS[task as keyof typeof TASK_NEEDS]),
            `${provider}.${task} → ${id}`,
          ).toBe(true);
          expect(
            model?.retires,
            `${provider}.${task} uses a retiring model`,
          ).toBeNull();
        }
      }
    }
  });

  it("serves every task but rerank on Mistral, and embeddings and transcription only there", () => {
    for (const task of AI_TASKS) {
      expect(taskModel("mistral", task, "free") !== null, task).toBe(
        task !== "rerank",
      );
    }
    for (const provider of ["anthropic", "openai", "compat"] as const) {
      expect(taskModel(provider, "embed", "free")).toBeNull();
      expect(taskModel(provider, "transcribe", "quality")).toBeNull();
    }
  });

  it("uses Claude 5.5 and GPT-5 for the opt-in providers", () => {
    expect(taskModel("anthropic", "draft", "quality")).toBe(
      "anthropic/claude-opus-5-5",
    );
    expect(taskModel("anthropic", "classify", "free")).toBe(
      "anthropic/claude-haiku-5-5",
    );
    expect(taskModel("anthropic", "summarize", "free")).toBe(
      "anthropic/claude-sonnet-5-5",
    );
    expect(taskModel("openai", "classify", "quality")).toBe(
      "openai/gpt-5-mini",
    );
    expect(taskModel("openai", "copilot", "quality")).toBe("openai/gpt-5");
  });

  it("lists the plan's features, the fixed ones not overridable", () => {
    expect(AI_FEATURES.map((f) => f.id)).toEqual([
      "mail",
      "desk-translate",
      "forms",
      "board",
      "connect",
      "books-ocr",
      "files",
      "data",
      "search",
      "reach",
      "merge",
      "meet",
      "assistant",
      "agents",
      "search-index",
      "reach-warmup",
      "mail-review",
    ]);
    expect(AI_FEATURES.filter((f) => !f.overridable).map((f) => f.id)).toEqual([
      "search-index",
      "reach-warmup",
      "mail-review",
    ]);
    for (const feature of AI_FEATURES) {
      expect(feature.tasks.length, feature.id).toBeGreaterThan(0);
      for (const task of feature.tasks) expect(AI_TASKS).toContain(task);
    }
  });

  it("needs file input for books-ocr: Mistral OCR and the Claude/GPT models have it", () => {
    const needs = featureNeeds("books-ocr", "ocr");
    expect(needs).toEqual(["file_input"]);
    expect(modelHas("mistral/mistral-ocr-4-1", needs)).toBe(true);
    expect(modelHas("anthropic/claude-sonnet-5-5", needs)).toBe(true);
    expect(modelHas("openai/gpt-5", needs)).toBe(true);
    expect(modelHas("mistral/mistral-embed-2312", needs)).toBe(false);
  });

  it("needs tools for the assistant, and a chat model for chat tasks", () => {
    expect(featureNeeds("assistant", "copilot").sort()).toEqual([
      "stream",
      "tools",
    ]);
    expect(
      modelHas("mistral/mistral-ocr-4-1", featureNeeds("mail", "draft")),
    ).toBe(false);
    expect(
      modelHas("mistral/mistral-large-4-0", featureNeeds("mail", "draft")),
    ).toBe(true);
    expect(aiFeature("search-index").tasks).toEqual(["embed"]);
  });
});

describe("page and minute prices", () => {
  it("prices Mistral OCR per page, more with annotations", () => {
    expect(
      providerCostUsd("mistral/mistral-ocr-4-1", { pages: 10 }),
    ).toBeCloseTo(0.04, 10);
    expect(
      providerCostUsd("mistral/mistral-ocr-4-1", {
        pages: 10,
        annotatedPages: 10,
      }),
    ).toBeCloseTo(0.05, 10);
    expect(creditsForUsage("mistral/mistral-ocr-4-1", { pages: 10 })).toBe(10);
  });

  it("prices Voxtral per minute of audio", () => {
    expect(
      providerCostUsd("mistral/voxtral-mini-transcribe-3-0", {
        audioSeconds: 600,
      }),
    ).toBeCloseTo(0.035, 10);
  });

  it("leaves token-priced models' cost alone, pages or not", () => {
    const usage = { inputTokens: 1000, outputTokens: 500 };
    const tokens = providerCostUsd("anthropic/claude-sonnet-5-5", usage);
    expect(tokens).toBe((1000 / 1_000_000) * 2 + (500 / 1_000_000) * 10);
    expect(
      providerCostUsd("anthropic/claude-sonnet-5-5", {
        ...usage,
        pages: 3,
        audioSeconds: 60,
      }),
    ).toBe(tokens);
    expect(
      providerCostUsd("mistral/mistral-small-2603", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.75, 10);
  });
});
