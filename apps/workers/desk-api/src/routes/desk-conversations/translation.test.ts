/**
 * Inbox translation on /api/desk/conversations against pglite, with the model
 * and the credit wallet mocked: language detection stored on the
 * conversation, translations cached in KV (a re-open makes no model call and
 * no charge), the reply draft, 402 on an empty wallet, 503 without the AI
 * gateway.
 *
 * TypeScript only: Rust answers these routes 503 (no AI provider on the
 * Kubernetes editions), so they are excluded from its conformance suite.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { appendDeskMessage, createDeskConversation } from '@weldsuite/db/lib/desk';
import { generateId } from '@weldsuite/worker-kit/id';

const ai = vi.hoisted(() => ({
  generateObject: vi.fn(),
  assertGatewayConfigured: vi.fn(),
}));
const billing = vi.hoisted(() => ({
  assertAiCredits: vi.fn(async () => {}),
  chargeAiUsage: vi.fn(async () => 1),
}));

vi.mock('@weldsuite/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/ai')>();
  return {
    ...actual,
    generateObject: ai.generateObject,
    assertGatewayConfigured: ai.assertGatewayConfigured,
    createWeldAI: () => ({ model: (id: string) => ({ modelId: id }) }),
  };
});

vi.mock('@weldsuite/core-domain/ai-billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/core-domain/ai-billing')>();
  return {
    ...actual,
    resolveAiMetering: vi.fn(async () => ({ masterDb: {}, internalWsId: 'ws_internal', userId: 'user_agent' })),
    assertAiCredits: billing.assertAiCredits,
    chargeAiUsage: billing.chargeAiUsage,
  };
});

// Imported after the mocks.
const { deskConversationsRoutes } = await import('./index');
const { InsufficientAiCreditsError } = await import('@weldsuite/core-domain/ai-billing');
const { DESK_TRANSLATION_CACHE_TTL } = await import('../../services/desk-translation');

let db: Database;
const kv = new Map<string, string>();
const kvPuts: { key: string; ttl: number | undefined }[] = [];
const events: { entityType: string; action: string; entityId: string; changes?: unknown }[] = [];

const WORKSPACE_CACHE = {
  get: async (key: string) => kv.get(key) ?? null,
  put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
    kv.set(key, value);
    kvPuts.push({ key, ttl: opts?.expirationTtl });
  },
};
const ENTITY_EVENTS = {
  send: async (message: { entityType: string; action: string; entityId: string; changes?: unknown }) => {
    events.push(message);
  },
  sendBatch: async () => {},
};

const app = (keys = ['conversations:update']) =>
  createTestApp('/api/desk/conversations', deskConversationsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db },
    env: { WORKSPACE_CACHE, ENTITY_EVENTS } as never,
  });

const post = (path: string, body: unknown, keys?: string[]) => {
  const test = app(keys);
  return test
    .request(`/api/desk/conversations${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    .then(async (res) => {
      await test.settled();
      return res;
    });
};

const usage = { inputTokens: 120, outputTokens: 80, totalTokens: 200 };

/** A German conversation: two customer messages and an agent reply. */
async function germanConversation(visitorId: string) {
  const { conversation, message: first } = await createDeskConversation(db, {
    generateId,
    visitorId,
    name: 'Jonas',
    body: 'Meine Rechnung ist falsch.',
  });
  await appendDeskMessage(db, {
    generateId,
    conversationId: conversation.id,
    kind: 'message',
    authorType: 'agent',
    authorId: 'user_agent',
    body: 'Which invoice?',
  });
  const { message: second } = await appendDeskMessage(db, {
    generateId,
    conversationId: conversation.id,
    kind: 'message',
    authorType: 'visitor',
    body: 'Die vom März, bitte.',
  });
  return { id: conversation.id, first: first!.id, second: second.id };
}

function answer(language: string, translations: { id: string; text: string }[]) {
  ai.generateObject.mockResolvedValueOnce({ object: { language, translations }, usage, providerMetadata: undefined });
}

/** A conversation of `count` customer messages. */
async function thread(visitorId: string, count: number, text: (i: number) => string) {
  const { conversation } = await createDeskConversation(db, { generateId, visitorId, name: 'Jonas', body: text(1) });
  for (let i = 2; i <= count; i++) {
    await appendDeskMessage(db, {
      generateId,
      conversationId: conversation.id,
      kind: 'message',
      authorType: 'visitor',
      body: text(i),
    });
  }
  return { id: conversation.id };
}

/** The messages a model call was given. */
function promptOf(call: number): { id: string; role: string; text: string }[] {
  return JSON.parse((ai.generateObject.mock.calls[call]![0] as { prompt: string }).prompt);
}

/** A model that names `language` and "translates" every message it is given; `failCall` (1-based) throws instead. */
function echo(language: string, opts: { failCall?: number } = {}) {
  let calls = 0;
  ai.generateObject.mockImplementation(async (input: { prompt: string }) => {
    calls += 1;
    if (calls === opts.failCall) throw new Error('upstream');
    const messages = JSON.parse(input.prompt) as { id: string; text: string }[];
    return {
      object: { language, translations: messages.map((m) => ({ id: m.id, text: `EN: ${m.text}` })) },
      usage,
      providerMetadata: undefined,
    };
  });
}

interface TranslateBody {
  data: { language: string | null; targetLocale: string; translations: { messageId: string; text: string }[] };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  ai.generateObject.mockReset();
  ai.assertGatewayConfigured.mockReset();
  billing.assertAiCredits.mockReset();
  billing.assertAiCredits.mockResolvedValue(undefined);
  billing.chargeAiUsage.mockClear();
  events.length = 0;
  kvPuts.length = 0;
});

describe('POST /api/desk/conversations/:id/translate', () => {
  it('detects the language, stores it, translates the customer messages and caches them', async () => {
    const c = await germanConversation('visitor_tr_1');
    answer('de', [
      { id: c.first, text: 'My invoice is wrong.' },
      { id: c.second, text: 'The one from March, please.' },
    ]);

    const res = await post(`/${c.id}/translate`, { targetLocale: 'en' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TranslateBody).data).toEqual({
      language: 'de',
      targetLocale: 'en',
      translations: [
        { messageId: c.first, text: 'My invoice is wrong.' },
        { messageId: c.second, text: 'The one from March, please.' },
      ],
    });

    // Only the customer's messages go to the model.
    const call = ai.generateObject.mock.calls[0]![0] as { prompt: string; model: { modelId: string } };
    expect(JSON.parse(call.prompt)).toEqual([
      { id: c.first, role: 'customer', text: 'Meine Rechnung ist falsch.' },
      { id: c.second, role: 'customer', text: 'Die vom März, bitte.' },
    ]);
    expect(call.model.modelId).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');

    expect(billing.assertAiCredits).toHaveBeenCalledTimes(1);
    expect(billing.chargeAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ internalWsId: 'ws_internal' }),
      expect.objectContaining({ op: 'desk_translate', usage, modelId: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' }),
    );

    const [row] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, c.id));
    expect(row!.language).toBe('de');
    expect(kvPuts).toHaveLength(2);
    expect(kvPuts.every((put) => put.ttl === DESK_TRANSLATION_CACHE_TTL)).toBe(true);
    expect(DESK_TRANSLATION_CACHE_TTL).toBe(30 * 24 * 60 * 60);
    expect(events).toEqual([
      expect.objectContaining({
        entityType: 'desk_conversation',
        action: 'updated',
        entityId: c.id,
        changes: { language: { old: null, new: 'de' } },
      }),
    ]);

    // Re-opening costs nothing: the language is known and every translation cached.
    const again = await post(`/${c.id}/translate`, { targetLocale: 'en' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as TranslateBody).data.translations).toHaveLength(2);
    expect(ai.generateObject).toHaveBeenCalledTimes(1);
    expect(billing.chargeAiUsage).toHaveBeenCalledTimes(1);
    expect(billing.assertAiCredits).toHaveBeenCalledTimes(1);
  });

  it('translates only the requested messages, and only those not cached yet', async () => {
    const c = await germanConversation('visitor_tr_2');
    answer('de', [{ id: c.second, text: 'The one from March, please.' }]);
    const res = await post(`/${c.id}/translate`, { targetLocale: 'en', messageIds: [c.second] });
    expect(((await res.json()) as TranslateBody).data.translations).toEqual([
      { messageId: c.second, text: 'The one from March, please.' },
    ]);

    answer('de', [{ id: c.first, text: 'My invoice is wrong.' }]);
    const all = await post(`/${c.id}/translate`, { targetLocale: 'en' });
    expect(((await all.json()) as TranslateBody).data.translations.map((t) => t.messageId)).toEqual([c.first, c.second]);
    const prompt = JSON.parse((ai.generateObject.mock.calls[1]![0] as { prompt: string }).prompt) as { id: string }[];
    expect(prompt.map((m) => m.id)).toEqual([c.first]);
  });

  it('translates nothing when the customer already writes the agent language', async () => {
    const { conversation } = await createDeskConversation(db, {
      generateId,
      visitorId: 'visitor_tr_en',
      body: 'My invoice is wrong.',
    });
    answer('en', [{ id: 'x', text: 'My invoice is wrong.' }]);
    const res = await post(`/${conversation.id}/translate`, { targetLocale: 'en' });
    expect(((await res.json()) as TranslateBody).data).toEqual({ language: 'en', targetLocale: 'en', translations: [] });
    // The message is remembered as judged (not as a translation), so it is not judged again.
    expect(kvPuts).toHaveLength(1);

    // Known now: no second model call.
    await post(`/${conversation.id}/translate`, { targetLocale: 'en-GB' });
    expect(ai.generateObject).toHaveBeenCalledTimes(1);
  });

  it('judges the language on the newest customer messages before paying for a whole thread', async () => {
    const c = await thread('visitor_tr_long_en', 20, (i) => `Message number ${i} about my order.`);
    answer('en', []);
    const res = await post(`/${c.id}/translate`, { targetLocale: 'en' });
    expect(((await res.json()) as TranslateBody).data).toEqual({ language: 'en', targetLocale: 'en', translations: [] });

    // One small call for a thread in the agent's own language, not twenty messages.
    expect(ai.generateObject).toHaveBeenCalledTimes(1);
    expect(promptOf(0)).toHaveLength(5);
    expect(billing.chargeAiUsage).toHaveBeenCalledTimes(1);

    await post(`/${c.id}/translate`, { targetLocale: 'en' });
    expect(ai.generateObject).toHaveBeenCalledTimes(1);
  });

  it('puts a wrong first guess right once the customer writes on', async () => {
    const { conversation, message: hello } = await createDeskConversation(db, {
      generateId,
      visitorId: 'visitor_tr_hallo',
      body: 'Hallo',
    });
    // "Hallo" alone reads as Dutch to a Dutch agent's translation.
    answer('nl', []);
    const first = await post(`/${conversation.id}/translate`, { targetLocale: 'nl' });
    expect(((await first.json()) as TranslateBody).data).toMatchObject({ language: 'nl', translations: [] });

    const { message: next } = await appendDeskMessage(db, {
      generateId,
      conversationId: conversation.id,
      kind: 'message',
      authorType: 'visitor',
      body: 'Ich brauche Hilfe mit meiner Rechnung.',
    });
    events.length = 0;
    answer('de', [{ id: next.id, text: 'Ik heb hulp nodig met mijn factuur.' }]);
    answer('de', [{ id: hello!.id, text: 'Hallo' }]);
    const second = await post(`/${conversation.id}/translate`, { targetLocale: 'nl' });
    expect(((await second.json()) as TranslateBody).data).toEqual({
      language: 'de',
      targetLocale: 'nl',
      translations: [
        { messageId: hello!.id, text: 'Hallo' },
        { messageId: next.id, text: 'Ik heb hulp nodig met mijn factuur.' },
      ],
    });
    // The new message was judged first, on its own; the earlier one followed.
    expect(promptOf(1).map((m) => m.id)).toEqual([next.id]);
    expect(promptOf(2).map((m) => m.id)).toEqual([hello!.id]);
    const [row] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, conversation.id));
    expect(row!.language).toBe('de');
    expect(events).toEqual([expect.objectContaining({ changes: { language: { old: 'nl', new: 'de' } } })]);
  });

  it('translates a long thread in batches, each charged', async () => {
    const c = await thread('visitor_tr_long_de', 30, (i) => `Nachricht ${i} zu meiner Bestellung.`);
    echo('de');
    const res = await post(`/${c.id}/translate`, { targetLocale: 'en' });
    expect(res.status).toBe(200);
    const body = ((await res.json()) as TranslateBody).data;
    expect(body.language).toBe('de');
    expect(body.translations).toHaveLength(30);
    expect(body.translations.every((t) => t.text.startsWith('EN: Nachricht'))).toBe(true);

    // The newest five to judge the language, then twelve a call.
    expect(ai.generateObject.mock.calls.map((_, i) => promptOf(i).length)).toEqual([5, 12, 12, 1]);
    expect((ai.generateObject.mock.calls[0]![0] as { maxOutputTokens?: number }).maxOutputTokens).toBeGreaterThan(0);
    expect(billing.assertAiCredits).toHaveBeenCalledTimes(1);
    expect(billing.chargeAiUsage).toHaveBeenCalledTimes(4);
  });

  it('answers what it has when a later batch fails, and the rest on the next request', async () => {
    const c = await thread('visitor_tr_partial', 20, (i) => `Nachricht ${i} zu meiner Rechnung.`);
    echo('de', { failCall: 3 });
    const res = await post(`/${c.id}/translate`, { targetLocale: 'en' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TranslateBody).data.translations).toHaveLength(17);
    expect(billing.chargeAiUsage).toHaveBeenCalledTimes(2);

    ai.generateObject.mockReset();
    echo('de');
    const again = await post(`/${c.id}/translate`, { targetLocale: 'en' });
    expect(((await again.json()) as TranslateBody).data.translations).toHaveLength(20);
    expect(ai.generateObject).toHaveBeenCalledTimes(1);
    expect(promptOf(0)).toHaveLength(3);
  });

  it('answers 402 when the wallet is empty, before calling the model', async () => {
    const c = await germanConversation('visitor_tr_402');
    billing.assertAiCredits.mockRejectedValueOnce(new InsufficientAiCreditsError(0, 1, 1));
    const res = await post(`/${c.id}/translate`, { targetLocale: 'en' });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(ai.generateObject).not.toHaveBeenCalled();
    expect(billing.chargeAiUsage).not.toHaveBeenCalled();
  });

  it('answers 503 ai_unavailable when the AI gateway is not configured', async () => {
    const c = await germanConversation('visitor_tr_503');
    ai.assertGatewayConfigured.mockImplementationOnce(() => {
      throw new Error('CF_ACCOUNT_ID is not set');
    });
    const res = await post(`/${c.id}/translate`, { targetLocale: 'en' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ai_unavailable');
    expect(billing.assertAiCredits).not.toHaveBeenCalled();
  });

  it('answers 502 when the model call fails', async () => {
    const c = await germanConversation('visitor_tr_502');
    ai.generateObject.mockRejectedValueOnce(new Error('upstream'));
    const res = await post(`/${c.id}/translate`, { targetLocale: 'en' });
    expect(res.status).toBe(502);
    expect(billing.chargeAiUsage).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown conversation, 403 without conversations:update, 400 for a bad locale', async () => {
    expect((await post('/dconv_missing/translate', { targetLocale: 'en' })).status).toBe(404);
    expect((await post('/dconv_missing/translate', { targetLocale: 'en' }, ['conversations:read'])).status).toBe(403);
    expect((await post('/dconv_missing/translate', { targetLocale: 'english!' })).status).toBe(400);
  });
});

describe('POST /api/desk/conversations/:id/translate-reply', () => {
  it("puts the agent's draft in the conversation's language", async () => {
    const c = await germanConversation('visitor_tr_reply');
    await db.update(schema.deskConversations).set({ language: 'de' }).where(eq(schema.deskConversations.id, c.id));
    ai.generateObject.mockResolvedValueOnce({
      object: { text: 'Ich prüfe das für Sie.', sourceLanguage: 'en' },
      usage,
    });
    const res = await post(`/${c.id}/translate-reply`, { text: "I'll look into it for you." });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      text: 'Ich prüfe das für Sie.',
      sourceLocale: 'en',
      targetLocale: 'de',
    });
    expect((ai.generateObject.mock.calls[0]![0] as { prompt: string }).prompt).toBe("I'll look into it for you.");
    expect(billing.chargeAiUsage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ op: 'desk_translate' }));
  });

  it('answers 400 while the language is unknown and no targetLocale is given', async () => {
    const c = await germanConversation('visitor_tr_reply_unknown');
    const res = await post(`/${c.id}/translate-reply`, { text: 'Hello' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('language_unknown');
    expect(ai.generateObject).not.toHaveBeenCalled();
  });

  it('answers 402 on an empty wallet', async () => {
    const c = await germanConversation('visitor_tr_reply_402');
    billing.assertAiCredits.mockRejectedValueOnce(new InsufficientAiCreditsError(0, 1, 1));
    const res = await post(`/${c.id}/translate-reply`, { text: 'Hello', targetLocale: 'fr' });
    expect(res.status).toBe(402);
    expect(ai.generateObject).not.toHaveBeenCalled();
  });
});
