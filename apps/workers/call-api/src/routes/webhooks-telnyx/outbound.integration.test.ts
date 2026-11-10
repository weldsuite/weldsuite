/**
 * An outbound call placed from a conversation (click-to-call): the browser's
 * client_state carries no conversation, so the webhook reads it from the call
 * row and "Call ended" lands on the conversation.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { stubTelnyx } from '../../test/telnyx-stub';
import { BASE, ORG, callEvent, deliverWith, encodeState, env, messagesOf, seedPhoneWorkspace } from '../../test/phone-webhook-harness';

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getMasterDb: () => conformanceMasterDb(holder.master),
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  };
});

import { telnyxWebhookRoutes } from './index';

let db: Database;
stubTelnyx();

const deliver = (event: unknown) =>
  deliverWith(
    createTestApp(BASE, telnyxWebhookRoutes as never, {
      context: { tenantDb: db, masterDb: holder.master as Database, orgId: null, clerkOrgId: null },
      env: env() as never,
    }).request,
    event,
  );

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = db;
  await seedPhoneWorkspace(db, master);
  await db.insert(schema.deskVisitors).values({ id: 'dvis_out', name: 'Eve', phone: '+31612345678' });
  await db.insert(schema.deskConversations).values({
    id: 'dconv_out', conversationNumber: 9101, title: 'Call Eve', state: 'open', channel: 'email', visitorId: 'dvis_out',
  });
  await db.insert(schema.voipCalls).values([
    { id: 'vcall_out_linked', userId: 'user_anna', direction: 'outbound', status: 'initiated', fromNumber: '+31201270001', toNumber: '+31612345678', deskConversationId: 'dconv_out', initiatedAt: new Date() },
    { id: 'vcall_out_plain', userId: 'user_anna', direction: 'outbound', status: 'initiated', fromNumber: '+31201270001', toNumber: '+31612345679', initiatedAt: new Date() },
  ]);
}, 180_000);

afterAll(() => vi.unstubAllGlobals());

describe('the end of an outbound call placed from a conversation', () => {
  it('lands "Call ended" on the conversation although the client_state has none', async () => {
    await deliver(
      callEvent('call.hangup', {
        client_state: encodeState({ callId: 'vcall_out_linked', workspaceId: ORG, record: 'true' }),
        call_control_id: 'cc-out-1',
        hangup_cause: 'normal_clearing',
      }),
    );
    expect((await messagesOf(db, 'dconv_out')).map((m) => m.body)).toContain('Call ended (completed)');
  });

  it('adds nothing for an outbound call with no conversation', async () => {
    const before = (await db.select().from(schema.deskMessages)).length;
    await deliver(
      callEvent('call.hangup', {
        client_state: encodeState({ callId: 'vcall_out_plain', workspaceId: ORG, record: 'true' }),
        call_control_id: 'cc-out-2',
        hangup_cause: 'normal_clearing',
      }),
    );
    expect((await db.select().from(schema.deskMessages)).length).toBe(before);
  });
});
