/**
 * A call that comes in over a customer's own phone system (SIP trunk / PBX):
 * its Telnyx connection is neither of ours, the call arrives as
 * `call.initiated` without a client_state (whatever its `direction` says),
 * and is let in only for a number of that trunk, on its connection, while
 * the trunk is active. Then it follows the number's route like any call.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import * as masterSchema from '@weldsuite/db/schema/master';
import { stubTelnyx } from '../../test/telnyx-stub';
import {
  BASE,
  actionCalls,
  callEvent,
  deliverWith,
  dialCalls,
  env,
  realtimeStub,
  seedPhoneWorkspace,
  stubCallActions,
  stubDial,
  ORG,
} from '../../test/phone-webhook-harness';

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const telnyx = stubTelnyx();
const realtime = realtimeStub();

function app() {
  return createTestApp(BASE, telnyxWebhookRoutes as never, {
    context: { tenantDb: db, masterDb: master as Database, orgId: null, clerkOrgId: null },
    env: { ...env(), REALTIME: realtime.binding } as never,
  });
}
const deliver = (event: unknown) => deliverWith(app().request, event);

const AGENTS = '+31201280001';
const VOICEMAIL = '+31201280002';
const OFF = '+31201280003';
const OTHER = '+31201280004';

let seq = 0;
/** A call the phone system sends to Telnyx: parked, on the trunk's connection, no client_state. */
async function trunkCall(payload: Record<string, unknown>) {
  seq += 1;
  const control = `cc-trunk-${seq}`;
  stubCallActions(telnyx, control);
  const mark = telnyx.calls.length;
  await deliver(
    callEvent('call.initiated', {
      direction: 'outgoing',
      state: 'parked',
      call_control_id: control,
      call_session_id: 'sess',
      call_leg_id: 'leg',
      from: '+31612345001',
      ...payload,
    }),
  );
  const [call] = await db.select().from(schema.voipCalls).where(eq(schema.voipCalls.providerCallId, control));
  return { control, call, calls: telnyx.calls.slice(mark) };
}

const trunk = async (id: string) => (await db.select().from(schema.voipSipTrunks).where(eq(schema.voipSipTrunks.id, id)))[0]!;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  holder.tenant = db;
  await seedPhoneWorkspace(db, master);

  await db.insert(schema.voipSipTrunks).values([
    { id: 'strk_one', name: 'Xelion', provider: 'xelion', authMode: 'ip', providerConnectionId: 'conn-pbx-1', status: 'active' },
    { id: 'strk_two', name: 'Dstny', provider: 'dstny', authMode: 'credentials', sipUsername: 'wdtwo', providerConnectionId: 'conn-pbx-2', status: 'active' },
    { id: 'strk_off', name: 'Switched off', provider: 'other', authMode: 'ip', providerConnectionId: 'conn-pbx-off', status: 'disabled' },
  ]);
  const numbers = [
    { id: 'vpn_t_agents', phoneNumber: AGENTS, sipTrunkId: 'strk_one', providerConnectionId: 'conn-pbx-1' },
    { id: 'vpn_t_voicemail', phoneNumber: VOICEMAIL, sipTrunkId: 'strk_one', providerConnectionId: 'conn-pbx-1' },
    { id: 'vpn_t_off', phoneNumber: OFF, sipTrunkId: 'strk_off', providerConnectionId: 'conn-pbx-off' },
    { id: 'vpn_t_other', phoneNumber: OTHER, sipTrunkId: 'strk_two', providerConnectionId: 'conn-pbx-2' },
  ];
  await db.insert(schema.voipPhoneNumbers).values(
    numbers.map((n) => ({ ...n, provider: 'sip_trunk', countryCode: 'NL', status: 'active', allowOutbound: false })),
  );
  await master.insert(masterSchema.phoneNumberRegistry).values(
    numbers.map((n) => ({ phoneNumber: n.phoneNumber, clerkOrgId: ORG, voipPhoneNumberId: n.id })),
  );
  await db.insert(schema.deskPhoneRoutes).values([
    { id: 'dpr_t_agents', voipPhoneNumberId: 'vpn_t_agents', action: 'agents', options: null },
    { id: 'dpr_t_voicemail', voipPhoneNumberId: 'vpn_t_voicemail', action: 'voicemail', options: null },
  ]);
  stubDial(telnyx);
}, 180_000);

beforeEach(async () => {
  await db.delete(schema.deskPhoneCallLegs);
  await db.delete(schema.voipCalls);
  await db.update(schema.voipSipTrunks).set({ lastInboundAt: null, lastError: null });
  realtime.published.length = 0;
});

afterAll(() => vi.unstubAllGlobals());

describe('a call over a trunk', () => {
  it('is routed to the agents, recorded on the trunk and stamps its last call', async () => {
    const { control, call, calls } = await trunkCall({ connection_id: 'conn-pbx-1', to: AGENTS });
    expect(call).toMatchObject({ sipTrunkId: 'strk_one', direction: 'inbound', toNumber: AGENTS, fromNumber: '+31612345001' });
    expect(actionCalls(calls, control, 'answer')).toHaveLength(1);
    expect(actionCalls(calls, control, 'enqueue')).toHaveLength(1);
    expect(dialCalls(calls).map((c) => (c.body as { to: string }).to).sort()).toEqual([
      'sip:sip_anna@sip.telnyx.com',
      'sip:sip_bob@sip.telnyx.com',
    ]);
    const row = await trunk('strk_one');
    expect(row.lastInboundAt).toBeInstanceOf(Date);
    expect(row.lastError).toBeNull();
    // The call is a WeldDesk phone conversation like any other.
    expect(call!.deskConversationId).toBeTruthy();
  });

  it('is routed to voicemail when the number says so', async () => {
    const { control, call, calls } = await trunkCall({ connection_id: 'conn-pbx-1', to: VOICEMAIL });
    expect(call).toMatchObject({ sipTrunkId: 'strk_one', outcome: 'missed' });
    expect(actionCalls(calls, control, 'answer')).toHaveLength(1);
    expect(actionCalls(calls, control, 'speak')).toHaveLength(1);
  });

  it('finds the number in a sip: address, without its +, or with a 00 prefix', async () => {
    const sip = await trunkCall({ connection_id: 'conn-pbx-1', to: 'sip:31201280001@sip.telnyx.com', from: 'sip:+31612345002@pbx.example.nl;user=phone' });
    expect(sip.call).toMatchObject({ sipTrunkId: 'strk_one', toNumber: AGENTS, fromNumber: '+31612345002' });
    const bare = await trunkCall({ connection_id: 'conn-pbx-1', to: '31201280001', from: '0031612345003' });
    expect(bare.call).toMatchObject({ sipTrunkId: 'strk_one', toNumber: AGENTS, fromNumber: '+31612345003' });
    const double = await trunkCall({ connection_id: 'conn-pbx-1', to: '<sip:0031201280001@host>' });
    expect(double.call).toMatchObject({ sipTrunkId: 'strk_one', toNumber: AGENTS });
  });

  it('is let in whichever direction Telnyx says', async () => {
    const incoming = await trunkCall({ connection_id: 'conn-pbx-1', to: AGENTS, direction: 'incoming' });
    expect(incoming.call).toMatchObject({ sipTrunkId: 'strk_one' });
  });

  it('is refused on another trunk’s connection, and says why on that trunk', async () => {
    const { control, call, calls } = await trunkCall({ connection_id: 'conn-pbx-2', to: AGENTS });
    expect(call).toBeUndefined();
    expect(actionCalls(calls, control, 'hangup')).toHaveLength(1);
    expect(actionCalls(calls, control, 'answer')).toHaveLength(0);
    expect((await trunk('strk_two')).lastError).toContain(AGENTS);
    expect((await trunk('strk_one')).lastInboundAt).toBeNull();
  });

  it('to a number we host is an ordinary inbound call, not a trunk call', async () => {
    // A colleague dials the hosted support number from a desk phone on the PBX.
    const { call } = await trunkCall({ connection_id: 'conn-pbx-1', to: '+31201270001' });
    // The call is recorded and follows the hosted number's own route.
    expect(call).toMatchObject({ sipTrunkId: null, direction: 'inbound', toNumber: '+31201270001' });
    expect(call!.deskConversationId).toBeTruthy();
    expect((await trunk('strk_one')).lastError).toBeNull();
    expect((await trunk('strk_one')).lastInboundAt).toBeNull();
  });

  it('to a trunk number is refused on our own connection or on none', async () => {
    // Only the trunk's connection authenticates the sender of a trunk number's calls.
    const own = await trunkCall({ connection_id: 'conn-1', to: AGENTS, direction: 'incoming' });
    expect(own.call).toBeUndefined();
    expect(actionCalls(own.calls, own.control, 'hangup')).toHaveLength(1);
    expect(actionCalls(own.calls, own.control, 'answer')).toHaveLength(0);
    const unnamed = await trunkCall({ to: AGENTS, direction: 'incoming' });
    expect(unnamed.call).toBeUndefined();
    expect(actionCalls(unnamed.calls, unnamed.control, 'hangup')).toHaveLength(1);
    expect((await trunk('strk_one')).lastInboundAt).toBeNull();
  });

  it('is refused while the trunk is switched off', async () => {
    const { control, call, calls } = await trunkCall({ connection_id: 'conn-pbx-off', to: OFF });
    expect(call).toBeUndefined();
    expect(actionCalls(calls, control, 'hangup')).toHaveLength(1);
    expect((await trunk('strk_off')).lastError).toContain('switched off');
    expect((await trunk('strk_off')).lastInboundAt).toBeNull();
  });

  it('is hung up when its number is unknown', async () => {
    const { control, call, calls } = await trunkCall({ connection_id: 'conn-pbx-1', to: '+31209999999' });
    expect(call).toBeUndefined();
    expect(actionCalls(calls, control, 'hangup')).toHaveLength(1);
  });

  it('clears an earlier refusal once a call gets through', async () => {
    await db.update(schema.voipSipTrunks).set({ lastError: 'old trouble' }).where(eq(schema.voipSipTrunks.id, 'strk_one'));
    await trunkCall({ connection_id: 'conn-pbx-1', to: AGENTS });
    expect((await trunk('strk_one')).lastError).toBeNull();
  });
});

describe('calls on our own connections', () => {
  it('are not taken for trunk calls', async () => {
    // A call our own voice connection originates is not routed as an inbound call.
    const own = await trunkCall({ connection_id: 'conn-1', to: AGENTS });
    expect(own.call).toBeUndefined();
    expect(own.calls).toHaveLength(0);
    const softphone = await trunkCall({ connection_id: 'sip-conn-1', to: AGENTS });
    expect(softphone.call).toBeUndefined();
    expect(softphone.calls).toHaveLength(0);
  });

  it('still route inbound calls that name no connection', async () => {
    const { call } = await trunkCall({ to: '+31201270001', direction: 'incoming' });
    expect(call).toMatchObject({ sipTrunkId: null, toNumber: '+31201270001' });
  });
});
