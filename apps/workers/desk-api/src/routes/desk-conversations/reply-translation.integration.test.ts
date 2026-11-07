/**
 * POST /api/desk/conversations/:id/reply with `translation`: a reply the
 * agent wrote in their own language and sent translated keeps their words in
 * the message's internal metadata, never in what the customer sees.
 * Conformance-ready (served by both backends).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { toPublicDeskMessage, type DeskMessage } from '@weldsuite/db/lib/desk';
import { deskConversationsRoutes } from './index';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const BASE = '/api/desk/conversations';
const at = new Date(Date.UTC(2026, 0, 2, 9, 0, 0));
let db: Database;

const reply = (id: string, body: unknown) =>
  createTestApp(BASE, deskConversationsRoutes, {
    context: { permissions: permissions('conversations:update'), tenantDb: db },
  }).request(`${BASE}/${id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.deskConversations).values({
    id: 'dconv_translated',
    conversationNumber: 501,
    title: 'Rechnung',
    state: 'open',
    channel: 'messenger',
    visitorId: 'visitor_translated',
    name: 'Jonas',
    language: 'de',
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(schema.deskMessages).values({
    id: 'dmsg_translated_1',
    conversationId: 'dconv_translated',
    kind: 'message',
    authorType: 'visitor',
    body: 'Meine Rechnung ist falsch.',
    createdAt: at,
  });
}, 60_000);

describe('POST /api/desk/conversations/:id/reply · translation', () => {
  it('sends the translation and keeps what the agent wrote in internal metadata', async () => {
    const res = await reply('dconv_translated', {
      body: 'Ich prüfe das für Sie.',
      translation: { original: "I'll look into it for you.", sourceLocale: 'en', targetLocale: 'de' },
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { message: DeskMessage } };
    expect(data.message.body).toBe('Ich prüfe das für Sie.');
    expect(data.message.metadata).toEqual({
      translation: { original: "I'll look into it for you.", sourceLocale: 'en', targetLocale: 'de' },
    });
    // The customer's view of the message carries no metadata at all.
    const visible = toPublicDeskMessage(data.message, new Map()) as unknown as Record<string, unknown>;
    expect(visible).not.toHaveProperty('metadata');
    expect(JSON.stringify(visible)).not.toContain('look into it');
  });

  it('stores no metadata on a reply sent without a translation', async () => {
    const res = await reply('dconv_translated', { body: 'Danke!' });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { message: DeskMessage } };
    expect(data.message.metadata).toBeNull();
  });

  it.each([
    ['without the original', { sourceLocale: 'en', targetLocale: 'de' }],
    ['with an empty original', { original: '', sourceLocale: 'en', targetLocale: 'de' }],
    ['with a locale that is too long', { original: 'Hi', sourceLocale: 'english-gb-x', targetLocale: 'de' }],
    ['that is not an object', 'Hi'],
  ])('refuses a translation %s', async (_label, translation) => {
    const res = await reply('dconv_translated', { body: 'Hallo', translation });
    expect(res.status).toBe(400);
  });
});
