/**
 * DB-backed integration test for POST /api/desk/conversations/:id/apply-macro
 * — proves the route wires validation → services/desk/macros.applyMacro →
 * response envelope (composerPrefill hint, never auto-sending the reply).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { deskConversationsRoutes } from './index';
import { createDeskMacro } from '../../services/desk/macros';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import type { Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function app(perm: string) {
  return createTestApp('/api/desk/conversations', deskConversationsRoutes, {
    context: { permissions: permissions(perm), tenantDb: db },
  }).request;
}

describe('POST /api/desk/conversations/:id/apply-macro · pglite integration', () => {
  it('applies a macro\'s actions and returns a composer prefill without sending', async () => {
    const createRes = await app('conversations:create')('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'messenger', body: 'Need help' }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const macro = await createDeskMacro(db, 'user_test_default', {
      name: 'Apology + close',
      body: 'Sorry for the trouble!',
      insertAs: 'reply',
      actions: [{ type: 'add_tag', tag: 'apologized' }, { type: 'close' }],
    });

    const res = await app('conversations:update')(`/api/desk/conversations/${created.id}/apply-macro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ macroId: macro.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        conversation: { state: string; tags: string[] };
        composerPrefill?: { body: string; insertAs: string };
        skipped: unknown[];
      };
    };
    expect(body.data.conversation.state).toBe('closed');
    expect(body.data.conversation.tags).toContain('apologized');
    expect(body.data.composerPrefill).toEqual({ body: 'Sorry for the trouble!', insertAs: 'reply' });

    // The reply must NOT have been auto-sent: the only 'comment' part is the
    // conversation's own opening message — applyMacro never appends a reply,
    // it only returns composerPrefill as a hint for the client.
    const getRes = await app('conversations:read')(`/api/desk/conversations/${created.id}?include=parts`);
    const getBody = (await getRes.json()) as { data: { parts: Array<{ partType: string; body: string | null }> } };
    const commentParts = getBody.data.parts.filter((p) => p.partType === 'comment');
    expect(commentParts).toHaveLength(1);
    expect(commentParts[0].body).toBe('Need help');
    expect(getBody.data.parts.filter((p) => p.partType === 'close')).toHaveLength(1);
  });

  it('returns 404 when the conversation does not exist', async () => {
    const macro = await createDeskMacro(db, 'user_test_default', { name: 'Noop', insertAs: 'reply', actions: [] });
    const res = await app('conversations:update')('/api/desk/conversations/dconv_missing/apply-macro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ macroId: macro.id }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the macro does not exist', async () => {
    const createRes = await app('conversations:create')('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'messenger', body: 'Need help' }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const res = await app('conversations:update')(`/api/desk/conversations/${created.id}/apply-macro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ macroId: 'dmacro_missing' }),
    });
    expect(res.status).toBe(404);
  });
});
