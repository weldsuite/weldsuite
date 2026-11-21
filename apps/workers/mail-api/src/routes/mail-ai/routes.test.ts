/**
 * /api/mail-ai/* end to end against a mock model server
 * (`@weldsuite/ai/testing`) behind the `fetch` stub: what each route answers
 * from the model's answer, the prompt it sends, and the classification
 * written back. The mock answers by what the prompt asks for, never by call
 * order, so the file runs on both backends in conformance mode (suite
 * `mail: ai`): Global's models and the Kubernetes editions' Mistral get the
 * same answers, and the harness drops the `meta.ai` label only the Rust side
 * adds.
 */

import {
  describe,
  it,
  expect,
  afterAll,
  beforeAll,
  beforeEach,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import {
  createMockModel,
  type MockChatReply,
  type MockChatRequest,
} from "@weldsuite/ai/testing";

vi.mock("@weldsuite/core-domain/ai-billing", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@weldsuite/core-domain/ai-billing")
  >()),
  resolveAiMetering: vi.fn(async () => null),
}));

import { mailAiRoutes } from "./index";
import { createTestApp, permissions } from "@weldsuite/worker-kit/testing";
import { createPgliteDb } from "@weldsuite/worker-kit/testing/pglite";
import { schema } from "@weldsuite/worker-kit/db";
import { generateId } from "@weldsuite/worker-kit/id";
import type { Database } from "@weldsuite/worker-kit/db";
import type { Env } from "../../types";

const { mailAccounts, mailMessages, workspaceMembers } = schema;

const USER = "user_mail_ai";

/** The model's answer, by what the prompt asks for. */
function answer(request: MockChatRequest): MockChatReply {
  const prompt = [request.system, ...request.messages.map((m) => m.text)].join(
    "\n",
  );
  if (request.wantsJson) {
    if (prompt.includes("email triage assistant")) {
      return {
        json: {
          category: prompt.includes("Invoice") ? "billing" : "support",
          priority: prompt.includes("URGENT") ? "high" : "normal",
        },
      };
    }
    if (prompt.includes("reply options"))
      return {
        json: {
          replies: [
            "Yes, works for me.",
            "No, sorry.",
            "Can we talk later?",
            "Maybe.",
          ],
        },
      };
    return {
      json: { subject: "Re: your request", body: "Here is the draft." },
    };
  }
  if (prompt.includes("summarise a user's email inbox"))
    return { text: "  Two threads need a reply.\n" };
  if (prompt.includes("expert editor")) return { text: "Polished text." };
  return { text: "\nThanks, I will send it today.  " };
}

const mock = createMockModel(
  { chat: answer },
  globalThis.fetch.bind(globalThis),
);
/** The worker env that points `@weldsuite/ai` at the mock (tests only, not in `Env`). */
const aiEnv = mock.env as unknown as Partial<Env>;

let db: Database;
let account: string;
let emptyAccount: string;
let invoiceMessage: string;
let questionMessage: string;

async function seedMessage(
  accountId: string,
  subject: string,
  textBody: string,
): Promise<string> {
  const id = generateId("mmsg");
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: "ana@example.com", name: "Ana" },
    to: [{ email: "team@test.dev" }],
    subject,
    preview: textBody.slice(0, 40),
    textBody,
    sentDate: new Date(),
    labels: ["INBOX"],
  });
  return id;
}

function post(path: string, body: unknown) {
  const { request } = createTestApp("/api/mail-ai", mailAiRoutes, {
    context: {
      userId: USER,
      tenantDb: db,
      permissions: permissions(
        "messages:read",
        "messages:create",
        "messages:update",
      ),
    },
    env: aiEnv,
  });
  return request(`/api/mail-ai${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Every prompt the model was sent, as one string. */
function promptsSent(): string {
  return JSON.stringify(mock.calls.map((call) => call.body));
}

async function row(messageId: string) {
  const [found] = await db
    .select({
      categories: mailMessages.categories,
      isImportant: mailMessages.isImportant,
    })
    .from(mailMessages)
    .where(eq(mailMessages.id, messageId))
    .limit(1);
  return found;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  await db.insert(workspaceMembers).values({
    id: generateId("wm"),
    userId: USER,
    email: `${USER}@test.dev`,
    role: "MEMBER",
  } as typeof workspaceMembers.$inferInsert);
  account = generateId("mail");
  await db.insert(mailAccounts).values({
    id: account,
    name: "Support",
    email: `${account}@test.dev`,
    displayName: "Support Team",
    isShared: true,
    aiSettings: {
      customInstructions: "Sign off as the Support Team.",
      defaultTone: "friendly",
      defaultLength: "short",
    },
  });
  emptyAccount = generateId("mail");
  await db
    .insert(mailAccounts)
    .values({
      id: emptyAccount,
      name: "Empty",
      email: `${emptyAccount}@test.dev`,
      isShared: true,
    });
  invoiceMessage = await seedMessage(
    account,
    "URGENT: Invoice 42",
    "Could you resend invoice 42 today?",
  );
  questionMessage = await seedMessage(
    account,
    "Opening hours",
    "Are you open on Saturday?",
  );
}, 60_000);

beforeEach(() => {
  vi.stubGlobal("fetch", mock.fetch);
  mock.reset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("writing", () => {
  it("POST /draft answers the drafted subject and body", async () => {
    const res = await post("/draft", {
      prompt: "ask Ana for the invoice number",
      accountId: account,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: unknown };
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      subject: "Re: your request",
      body: "Here is the draft.",
    });
    const sent = promptsSent();
    expect(sent).toContain(
      "Write an email that: ask Ana for the invoice number",
    );
    expect(sent).toContain("You are writing on behalf of Support Team.");
    expect(sent).toContain(
      "Always follow these instructions: Sign off as the Support Team.",
    );
    expect(sent).toContain("Tone: warm and friendly.");
  });

  it("POST /draft with a message to reply to puts it in the prompt", async () => {
    const res = await post("/draft", {
      prompt: "say yes",
      replyToMessageId: questionMessage,
      tone: "casual",
    });
    expect(res.status).toBe(200);
    const sent = promptsSent();
    expect(sent).toContain("Are you open on Saturday?");
    expect(sent).toContain("Tone: casual and conversational.");
  });

  it("POST /draft answers 404 for a message that does not exist", async () => {
    const res = await post("/draft", {
      prompt: "hi",
      replyToMessageId: "mmsg_missing",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      error: {
        code: "message_not_found",
        message: "Original message not found",
      },
    });
    expect(mock.calls).toEqual([]);
  });

  it("POST /draft refuses a body without a prompt", async () => {
    const res = await post("/draft", { accountId: account });
    expect(res.status).toBe(400);
    expect(mock.calls).toEqual([]);
  });

  it("POST /improve-text answers the rewritten text", async () => {
    const res = await post("/improve-text", {
      text: "pls send invoice",
      action: "formalize",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown };
    expect(json.data).toEqual({ text: "Polished text." });
    expect(promptsSent()).toContain(
      "Rewrite the text in a more formal, professional tone.",
    );
  });

  it("POST /auto-draft answers the draft twice, from the recent inbox", async () => {
    const res = await post("/auto-draft", {
      accountId: account,
      prompt: "follow up on the invoice",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      draft: unknown;
      data: unknown;
    };
    expect(json.draft).toEqual({
      subject: "Re: your request",
      body: "Here is the draft.",
    });
    expect(json.data).toEqual(json.draft);
    const sent = promptsSent();
    expect(sent).toContain("Recent inbox context:");
    expect(sent).toContain("URGENT: Invoice 42");
    expect(sent).toContain("The user's intent: follow up on the invoice");
  });

  it("POST /auto-draft answers 404 for an account that does not exist", async () => {
    const res = await post("/auto-draft", { accountId: "mail_missing" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: "account_not_found", message: "Mail account not found" },
    });
  });

  it("POST /reply answers the trimmed body, at the top level too", async () => {
    const res = await post("/reply", {
      messageId: invoiceMessage,
      tone: "brief",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { body: string; data: unknown };
    expect(json.body).toBe("Thanks, I will send it today.");
    expect(json.data).toEqual({ body: "Thanks, I will send it today." });
    const sent = promptsSent();
    expect(sent).toContain("Tone: brief and direct.");
    expect(sent).toContain("Could you resend invoice 42 today?");
  });

  it("POST /smart-replies answers at most three replies", async () => {
    const res = await post("/smart-replies", { messageId: questionMessage });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { replies: string[] } };
    expect(json.data.replies).toEqual([
      "Yes, works for me.",
      "No, sorry.",
      "Can we talk later?",
    ]);
  });
});

describe("triage", () => {
  it("POST /inbox-summary summarises the mailbox", async () => {
    const res = await post("/inbox-summary", { accountId: account });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown };
    expect(json.data).toEqual({ summary: "Two threads need a reply." });
    const sent = promptsSent();
    expect(sent).toContain("[unread] ana@example.com: URGENT: Invoice 42");
    expect(sent).toContain("Opening hours");
  });

  it("POST /inbox-summary of an empty mailbox asks no model", async () => {
    const res = await post("/inbox-summary", { accountId: emptyAccount });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown };
    expect(json.data).toEqual({ summary: "No recent messages to summarise." });
    expect(mock.calls).toEqual([]);
  });

  it("POST /label classifies one message and writes the category back", async () => {
    const res = await post("/label", { messageId: invoiceMessage });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown };
    expect(json.data).toEqual({
      messageId: invoiceMessage,
      accountId: account,
      subject: "URGENT: Invoice 42",
      category: "billing",
      priority: "high",
    });
    expect(await row(invoiceMessage)).toEqual({
      categories: ["ai:billing"],
      isImportant: true,
    });
  });

  it("POST /label/batch classifies each message and skips missing ids", async () => {
    const res = await post("/label/batch", {
      messageIds: [questionMessage, "mmsg_missing"],
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { results: unknown[] } };
    expect(json.data.results).toEqual([
      {
        messageId: questionMessage,
        accountId: account,
        subject: "Opening hours",
        category: "support",
        priority: "normal",
      },
    ]);
    expect(await row(questionMessage)).toEqual({
      categories: ["ai:support"],
      isImportant: false,
    });
  });

  it("POST /label/batch refuses an empty list", async () => {
    const res = await post("/label/batch", { messageIds: [] });
    expect(res.status).toBe(400);
  });
});
