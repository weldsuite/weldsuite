/**
 * An invoice/bill attachment is streamed only when its R2 key sits under this
 * workspace: uploads are keyed by the Clerk org id, accounting-inbox mail by
 * `workspaces.id` (mail-inbound-worker). The request carries both.
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { streamDocumentAttachment } from './document-attachment';

const ORG = 'org_mine';
const WS = 'ws_mine';

function app(vars: { clerkOrgId?: string; workspaceId?: string } = { clerkOrgId: ORG, workspaceId: WS }) {
  const objects = new Map<string, string>();
  const STORAGE = {
    get: async (key: string) =>
      objects.has(key)
        ? { body: objects.get(key), httpEtag: '"e"', writeHttpMetadata: () => undefined }
        : null,
  } as unknown as R2Bucket;

  const hono = new Hono<{ Bindings: Env; Variables: Variables }>();
  hono.use('*', async (c, next) => {
    if (vars.clerkOrgId !== undefined) c.set('clerkOrgId', vars.clerkOrgId);
    if (vars.workspaceId !== undefined) c.set('workspaceId', vars.workspaceId);
    await next();
  });
  hono.get('/attachment', (c) =>
    streamDocumentAttachment(c, { attachmentKeys: [c.req.query('key') ?? ''], index: 0 }),
  );

  return {
    objects,
    get: (key: string) => hono.request(`/attachment?key=${encodeURIComponent(key)}`, undefined, { STORAGE }),
  };
}

describe('streamDocumentAttachment', () => {
  it('streams an upload keyed by the Clerk org id', async () => {
    const { objects, get } = app();
    const key = `workspaces/${ORG}/accounting/1_a/bill.pdf`;
    objects.set(key, 'pdf');
    const res = await get(key);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pdf');
  });

  it('streams accounting-inbox mail keyed by workspaces.id', async () => {
    const { objects, get } = app();
    const key = `workspaces/${WS}/accounting/inbox/e1/bill.pdf`;
    objects.set(key, 'pdf');
    expect((await get(key)).status).toBe(200);
  });

  it("refuses another workspace's key under either id", async () => {
    const { objects, get } = app();
    objects.set('workspaces/org_other/accounting/1_a/bill.pdf', 'x');
    objects.set('workspaces/ws_other/accounting/inbox/e1/bill.pdf', 'x');
    expect((await get('workspaces/org_other/accounting/1_a/bill.pdf')).status).toBe(403);
    expect((await get('workspaces/ws_other/accounting/inbox/e1/bill.pdf')).status).toBe(403);
  });

  it('answers 400 when the request has no Clerk org', async () => {
    const { get } = app({ workspaceId: WS });
    expect((await get(`workspaces/${WS}/accounting/inbox/e1/bill.pdf`)).status).toBe(400);
  });
});
