/**
 * Inbox translation on /api/desk/conversations against pglite, with the model
 * stubbed at the HTTP level (`@weldsuite/ai/testing`), so both backends run
 * it: Global on `@weldsuite/ai`, the Kubernetes editions on `weldsuite-ai`
 * (feature `desk-translate`). Conformance-ready (served by both backends);
 * the mock answers by the request's content, never by call order.
 *
 * Batching, the credit gate and the KV TTL are covered on TypeScript in
 * translation.test.ts, with the AI layer mocked.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMockModel, type MockChatReply, type MockChatRequest } from '@weldsuite/ai/testing';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { deskConversationsRoutes } from './index';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const BASE = '/api/desk/conversations';
const at = (minute: number) => new Date(Date.UTC(2026, 0, 2, 9, minute, 0));

/** What the model "translates" each text to; anything else comes back as it is. */
const TRANSLATED: Record<string, string> = {
  'Meine Rechnung ist falsch.': 'My invoice is wrong.',
  'Die vom März, bitte.': 'The one from March, please.',
  "I'll look into it for you.": 'Ich prüfe das für Sie.',
};
const GERMAN = /Rechnung|bitte|März/;

/** The model: a reply's translation, or a batch's language and translations. */
function answer(request: MockChatRequest): MockChatReply {
  const user = request.messages.at(-1)?.text ?? '';
  if (user.includes('FAIL')) return { status: 400, message: 'mock refusal' };
  if (request.system.includes("support agent's reply")) {
    return { json: { text: TRANSLATED[user] ?? user, sourceLanguage: 'en' } };
  }
  const batch = JSON.parse(user) as {
    id: string;
    role: string;
    text: string;
  }[];
  const german = batch.some((m) => m.role === 'customer' && GERMAN.test(m.text));
  return {
    json: {
      language: german ? 'de' : 'en',
      translations: batch.map((m) => ({
        id: m.id,
        text: TRANSLATED[m.text] ?? m.text,
      })),
    },
  };
}

const mock = createMockModel({ chat: answer });
const kv = createMemoryKv();
let db: Database;

const post = (path: string, body: unknown, env: Record<string, unknown> = mock.env) =>
  createTestApp(BASE, deskConversationsRoutes, {
    context: {
      permissions: permissions('conversations:update'),
      tenantDb: db,
      userId: 'user_agent',
    },
    env: { WORKSPACE_CACHE: kv, ...env } as never,
  }).request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

interface TranslateBody {
  data: {
    language: string | null;
    targetLocale: string;
    translations: { messageId: string; text: string }[];
  };
}

/** A conversation with its messages, in order: `[authorType, body]`. */
async function conversation(id: string, number: number, messages: [string, string][], language: string | null = null) {
  await db.insert(schema.deskConversations).values({
    id,
    conversationNumber: number,
    title: 'Rechnung',
    state: 'open',
    channel: 'messenger',
    visitorId: `visitor_${id}`,
    name: 'Jonas',
    language,
    createdAt: at(0),
    updatedAt: at(0),
  });
  await db.insert(schema.deskMessages).values(
    messages.map(([authorType, body], i) => ({
      id: `${id}_m${i + 1}`,
      conversationId: id,
      kind: 'message' as const,
      authorType: authorType as 'visitor' | 'agent',
      body,
      createdAt: at(i + 1),
    })),
  );
}

beforeAll(async () => {
  vi.stubGlobal('fetch', mock.fetch);
  db = (await createPgliteDb()).db;
  await conversation('dconv_tr_de', 601, [
    ['visitor', 'Meine Rechnung ist falsch.'],
    ['agent', 'Which invoice?'],
    ['visitor', 'Die vom März, bitte.'],
  ]);
  await conversation('dconv_tr_ids', 602, [
    ['visitor', 'Meine Rechnung ist falsch.'],
    ['visitor', 'Die vom März, bitte.'],
  ]);
  await conversation('dconv_tr_en', 603, [['visitor', 'My invoice is wrong.']]);
  await conversation('dconv_tr_reply', 604, [['visitor', 'Meine Rechnung ist falsch.']], 'de');
  await conversation('dconv_tr_unknown', 605, [['visitor', 'Meine Rechnung ist falsch.']]);
  await conversation('dconv_tr_fail', 606, [['visitor', 'FAIL Meine Rechnung']]);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/desk/conversations/:id/translate', () => {
  it('detects the language, stores it and translates the customer messages', async () => {
    const res = await post('/dconv_tr_de/translate', { targetLocale: 'en' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TranslateBody).data).toEqual({
      language: 'de',
      targetLocale: 'en',
      translations: [
        { messageId: 'dconv_tr_de_m1', text: 'My invoice is wrong.' },
        { messageId: 'dconv_tr_de_m3', text: 'The one from March, please.' },
      ],
    });
    const [row] = await db
      .select()
      .from(schema.deskConversations)
      .where(eq(schema.deskConversations.id, 'dconv_tr_de'));
    expect(row!.language).toBe('de');
  });

  it('answers a second time from the cache', async () => {
    const res = await post('/dconv_tr_de/translate', { targetLocale: 'en' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TranslateBody).data.translations).toHaveLength(2);
  });

  it('translates only the requested messages', async () => {
    const res = await post('/dconv_tr_ids/translate', {
      targetLocale: 'en',
      messageIds: ['dconv_tr_ids_m2'],
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TranslateBody).data).toEqual({
      language: 'de',
      targetLocale: 'en',
      translations: [{ messageId: 'dconv_tr_ids_m2', text: 'The one from March, please.' }],
    });
  });

  it('translates nothing when the customer already writes the agent language', async () => {
    const res = await post('/dconv_tr_en/translate', { targetLocale: 'en-GB' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TranslateBody).data).toEqual({
      language: 'en',
      targetLocale: 'en-GB',
      translations: [],
    });
  });

  it('answers 502 when the model call fails', async () => {
    const res = await post('/dconv_tr_fail/translate', { targetLocale: 'en' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ai_request_failed');
  });

  it('answers 503 ai_unavailable without a model', async () => {
    const res = await post('/dconv_tr_unknown/translate', { targetLocale: 'en' }, {});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ai_unavailable');
  });

  it('answers 404 for an unknown conversation and 400 for a bad locale', async () => {
    const missing = await post('/dconv_missing/translate', {
      targetLocale: 'en',
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('not_found');
    expect((await post('/dconv_tr_de/translate', { targetLocale: 'english!' })).status).toBe(400);
  });
});

describe('POST /api/desk/conversations/:id/translate-reply', () => {
  it("puts the agent's draft in the conversation's language", async () => {
    const res = await post('/dconv_tr_reply/translate-reply', {
      text: "I'll look into it for you.",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      text: 'Ich prüfe das für Sie.',
      sourceLocale: 'en',
      targetLocale: 'de',
    });
  });

  it('answers 400 while the language is unknown and no targetLocale is given', async () => {
    const res = await post('/dconv_tr_unknown/translate-reply', {
      text: 'Hello',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('language_unknown');
  });

  it('answers 503 ai_unavailable without a model', async () => {
    const res = await post('/dconv_tr_reply/translate-reply', { text: 'Hello' }, {});
    expect(res.status).toBe(503);
  });
});
