/**
 * POST /api/workflows/generate ("Generate with AI") over HTTP, with the model
 * stubbed at the HTTP level (`@weldsuite/ai/testing`), so the same test runs
 * against the Rust backend (`rust/modules/connect/src/generate.rs`) in the
 * `connect: workflows` conformance suite: both call the one mock model, and
 * the harness compares what the routes answer.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMockModel,
  type MockChatReply,
  type MockChatRequest,
} from "@weldsuite/ai/testing";
import { createTestApp, permissions } from "@weldsuite/worker-kit/testing";
import { createPgliteDb } from "@weldsuite/worker-kit/testing/pglite";
import type { Database } from "@weldsuite/worker-kit/db";

const { workflowsRoutes } = await import("./index");

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The draft the model answers for "welcome new leads". */
const DRAFT = {
  name: "  Welcome new leads ",
  description: "Email every new lead a welcome message",
  triggers: [
    {
      type: "entity_event",
      name: "Person created",
      config: { entityType: "person", eventType: "created" },
    },
    {
      type: "entity_event",
      name: "Person beamed",
      config: { entityType: "person", eventType: "teleported" },
    },
  ],
  steps: [
    {
      type: "send_email",
      name: "Send welcome email",
      config: {
        to: "{{trigger.email}}",
        subject: "Welcome",
        body: "Glad to have you",
      },
    },
    { type: "teleport", name: "Beam up" },
  ],
};

/** Answers by prompt, never by call order: the stub serves both backends. */
function model(reply: (request: MockChatRequest) => MockChatReply) {
  const mock = createMockModel({ chat: reply });
  vi.stubGlobal("fetch", mock.fetch);
  return mock;
}

function app(granted: string[], env: Record<string, unknown> = {}) {
  return createTestApp("/api/workflows", workflowsRoutes, {
    context: { permissions: permissions(...granted), tenantDb: db },
    env: env as never,
  }).request;
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /api/workflows/generate", () => {
  it("turns a prompt into a validated draft, flagging what is outside the catalog", async () => {
    const mock = model((request) => {
      const prompt = request.messages.map((m) => m.text).join("\n");
      if (
        request.system.includes("workflow-automation architect") &&
        prompt.includes("welcome new leads")
      ) {
        return { json: DRAFT };
      }
      return { status: 400, message: "unexpected prompt" };
    });
    const res = await app(["workflows:create"], mock.env)(
      "/api/workflows/generate",
      post({ prompt: "welcome new leads" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        workflow: {
          name: string;
          description?: string;
          triggers: Array<{
            id: string;
            type: string;
            name: string;
            isEnabled: boolean;
            config: unknown;
          }>;
          steps: Array<{
            id: string;
            type: string;
            name: string;
            config: unknown;
          }>;
        };
        warnings: string[];
      };
    };
    expect(body.data.workflow.name).toBe("Welcome new leads");
    expect(body.data.workflow.description).toBe(
      "Email every new lead a welcome message",
    );
    expect(body.data.workflow.triggers).toHaveLength(2);
    expect(body.data.workflow.triggers[0].id).toMatch(/^trg_/);
    expect(body.data.workflow.triggers[0].isEnabled).toBe(true);
    expect(body.data.workflow.steps).toHaveLength(2);
    expect(body.data.workflow.steps[0].id).toMatch(/^step_/);
    expect(body.data.workflow.steps[1].config).toEqual({});
    expect(body.data.warnings).toEqual([
      'Step "Beam up" uses an unknown action type "teleport" — review before publishing.',
      'Trigger "Person beamed" references an unknown event "teleported" for entity "person" — review before publishing.',
    ]);
    expect(mock.calls.length).toBeGreaterThan(0);
  });

  it("names a default for an empty draft and warns about it", async () => {
    const mock = model((request) =>
      request.messages.some((m) => m.text.includes("nothing at all"))
        ? { json: { triggers: [], steps: [] } }
        : { status: 400, message: "unexpected prompt" },
    );
    const res = await app(["workflows:create"], mock.env)(
      "/api/workflows/generate",
      post({ prompt: "nothing at all" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { workflow: Record<string, unknown>; warnings: string[] };
    };
    expect(body.data.workflow).toEqual({
      name: "Untitled workflow",
      triggers: [],
      steps: [],
    });
    expect(body.data.warnings).toEqual([
      "The generated workflow has no steps — add at least one action before publishing.",
      "The generated workflow has no trigger — add one before publishing.",
    ]);
  });

  it("answers 503 AI_NOT_CONFIGURED without a model", async () => {
    // The mock is stubbed (no network) but its env is not given: no model.
    const mock = model(() => ({ json: DRAFT }));
    const res = await app(["workflows:create"])(
      "/api/workflows/generate",
      post({ prompt: "welcome new leads" }),
    );
    expect(res.status).toBe(503);
    expect(mock.calls).toHaveLength(0);
    expect(await res.json()).toEqual({
      error: {
        code: "AI_NOT_CONFIGURED",
        message:
          'AI gateway is not configured (missing CF_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID) for provider "cloudflare"',
      },
    });
  });

  it("refuses a prompt shorter than 3 characters", async () => {
    const mock = model(() => ({ json: DRAFT }));
    const res = await app(["workflows:create"], mock.env)(
      "/api/workflows/generate",
      post({ prompt: "hi" }),
    );
    expect(res.status).toBe(400);
    expect(mock.calls).toHaveLength(0);
  });

  it("needs workflows:create", async () => {
    const mock = model(() => ({ json: DRAFT }));
    const res = await app(["workflows:read"], mock.env)(
      "/api/workflows/generate",
      post({ prompt: "welcome new leads" }),
    );
    expect(res.status).toBe(403);
    expect(mock.calls).toHaveLength(0);
  });
});
