/**
 * The OutboundLedger Durable Object around LedgerCore: policy loading, the
 * alarm, review queueing and automatic actions. The master-DB side
 * (policy-store, cases) is mocked; storage is an in-memory fake.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OUTBOUND_DEFAULT_LIMITS } from '@weldsuite/app-api-client/schemas/outbound-mail';
import type { LoadedPolicy } from './policy-store';

const loadLedgerPolicy = vi.fn();
const applyAutomaticState = vi.fn();
const saveRiskScore = vi.fn();
const openOutboundCase = vi.fn();

vi.mock('./policy-store', () => ({
  loadLedgerPolicy: (...args: unknown[]) => loadLedgerPolicy(...args),
  applyAutomaticState: (...args: unknown[]) => applyAutomaticState(...args),
  saveRiskScore: (...args: unknown[]) => saveRiskScore(...args),
  recordOutboundEvent: vi.fn(),
}));
vi.mock('./cases', () => ({ openOutboundCase: (...args: unknown[]) => openOutboundCase(...args) }));

import { OutboundLedger } from './ledger';
import type { OutboundLedgerEnv } from './ledger';
import type { ReserveRequest } from './ledger-core';

function fakeState() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
      if (typeof keyOrEntries === 'string') data.set(keyOrEntries, value);
      else for (const [k, v] of Object.entries(keyOrEntries)) data.set(k, v);
    },
    delete: async (keys: string[]) => keys.filter((k) => data.delete(k)).length,
    list: async ({ prefix }: { prefix: string }) => new Map([...data].filter(([k]) => k.startsWith(prefix))),
    getAlarm: async () => alarm,
    setAlarm: async (at: number) => {
      alarm = at;
    },
  };
  let ready: Promise<unknown> = Promise.resolve();
  return {
    storage,
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => {
      ready = fn();
      return ready;
    },
    get ready() {
      return ready;
    },
    get alarm() {
      return alarm;
    },
  };
}

function policy(overrides: Partial<LoadedPolicy> = {}): LoadedPolicy {
  return {
    mode: 'enforce',
    trustLevel: 'standard',
    state: 'active',
    stateReason: null,
    stateSetBy: null,
    stateSetAt: null,
    allowRepliesWhenSuspended: false,
    limits: { ...OUTBOUND_DEFAULT_LIMITS.standard },
    riskScore: 0,
    ...overrides,
  };
}

const subject = { kind: 'workspace' as const, workspaceId: 'ws_1', clerkOrgId: 'org_1' };
const request = (overrides: Partial<ReserveRequest> = {}): ReserveRequest => ({
  sender: 'tom@acme.com',
  source: 'compose',
  kind: 'new_thread',
  recipients: ['a@x.com'],
  firstContact: [],
  template: null,
  contentScore: 0,
  sharedDomain: false,
  ...overrides,
});

async function makeLedger(env: Partial<OutboundLedgerEnv> = {}) {
  const state = fakeState();
  const ledger = new OutboundLedger(state as unknown as DurableObjectState, {
    DATABASE_URL_MASTER: 'postgres://unused',
    ...env,
  } as OutboundLedgerEnv);
  await state.ready;
  return { ledger, state };
}

describe('OutboundLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadLedgerPolicy.mockResolvedValue(policy());
  });

  it('decides with the loaded policy, remembers its subject and arms the alarm', async () => {
    const { ledger, state } = await makeLedger();
    const decision = await ledger.reserve(subject, request());
    expect(decision.allow).toBe(true);
    expect(loadLedgerPolicy).toHaveBeenCalledWith(expect.anything(), subject, expect.anything());
    expect(await state.storage.get('subject')).toEqual(subject);
    expect(state.alarm).not.toBeNull();
  });

  it('enforces a hold from the policy', async () => {
    loadLedgerPolicy.mockResolvedValue(policy({ state: 'hold' }));
    const { ledger } = await makeLedger();
    expect((await ledger.reserve(subject, request())).denial?.code).toBe('SENDING_ON_HOLD');
  });

  it('counts, but never blocks, when the policy cannot be loaded', async () => {
    loadLedgerPolicy.mockRejectedValue(new Error('master down'));
    const { ledger } = await makeLedger();
    const decision = await ledger.reserve(subject, request({ recipients: Array.from({ length: 50 }, (_, i) => `r${i}@x.com`) }));
    expect(decision).toMatchObject({ allow: true, mode: 'shadow' });
  });

  it('queues an AI review when a template crosses the threshold', async () => {
    const send = vi.fn();
    const { ledger } = await makeLedger({ MAIL_OUTBOUND_REVIEW: { send } as unknown as Queue<never> });
    const template = { fingerprint: '0f0f0f0f0f0f0f0f', sample: 'hi tokname quick question', subject: 'Quick question' };
    for (let i = 0; i < 10; i++) {
      const d = await ledger.reserve(subject, request({ recipients: [`p${i}@x.com`], firstContact: [`p${i}@x.com`], template }));
      await ledger.commit(d.reservationId!);
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ subject, request: { fingerprint: template.fingerprint, reason: 'template_threshold' } });
  });

  it('applies a phishing verdict: hold, case, policy reload', async () => {
    const { ledger } = await makeLedger();
    await ledger.reserve(subject, request());
    await ledger.recordVerdict({
      fingerprint: '0f0f0f0f0f0f0f0f',
      category: 'phishing_or_scam',
      unsolicited: true,
      confidence: 0.97,
      signals: ['credential lure'],
      modelId: 'test',
      reviewedAt: new Date().toISOString(),
    });
    expect(applyAutomaticState).toHaveBeenCalledWith(expect.anything(), subject, expect.objectContaining({ from: 'active', to: 'hold' }));
    expect(openOutboundCase).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ trigger: 'phishing', severity: 'urgent', state: 'hold' }));
  });

  it('restricts on bounces from its alarm and saves the risk score', async () => {
    const { ledger } = await makeLedger();
    const d = await ledger.reserve(subject, request({ recipients: Array.from({ length: 40 }, (_, i) => `r${i}@x.com`) }));
    await ledger.commit(d.reservationId!);
    for (let i = 0; i < 5; i++) await ledger.recordDelivery(subject, 'hard_bounce', Date.now());
    await ledger.alarm();
    expect(applyAutomaticState).toHaveBeenCalledWith(expect.anything(), subject, expect.objectContaining({ to: 'restricted' }));
    expect(openOutboundCase).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ trigger: 'bounce_rate' }));
    expect(saveRiskScore).toHaveBeenCalled();
  });
});
