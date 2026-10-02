import { beforeEach, describe, expect, it, vi } from 'vitest';

const credits = vi.hoisted(() => ({
  checkCredits: vi.fn(),
  consumeCredits: vi.fn(),
  grantCredits: vi.fn(),
  resolveInternalWorkspaceId: vi.fn(),
}));
vi.mock('@weldsuite/credits', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/credits')>('@weldsuite/credits');
  return { ...actual, ...credits };
});

const masterRows = vi.hoisted(() => ({ value: undefined as unknown, calls: 0, fail: false }));
vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => {
      masterRows.calls++;
      if (masterRows.fail) throw new Error('master db down');
      return masterRows.value === undefined ? [] : [{ value: masterRows.value }];
    },
  };
  return { ...actual, getMasterDb: () => chain };
});

import {
  InsufficientMeetingCreditsError,
  MeetingBillingUnavailableError,
  WELDMEET_AI_PRICING_KV_KEY,
  assertMeetingAiCredits,
  billableMinutes,
  chargeMeetingAi,
  creditsForMinutes,
  defaultMeetingAiPricing,
  getMeetingAiPricing,
  meetingAiIdempotencyKey,
  minimumBalanceFor,
  parseMeetingAiPricing,
  resetMeetingAiPricingMemo,
  resolveMeetingMetering,
  type MeetingMetering,
} from './billing';

const metering = { masterDb: {} as never, internalWsId: 'ws_internal', userId: 'user_1' } as MeetingMetering;

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string, type?: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMeetingAiPricingMemo();
  masterRows.value = undefined;
  masterRows.calls = 0;
  masterRows.fail = false;
});

describe('pricing parse', () => {
  it('uses defaults for a missing row and for invalid fields', () => {
    expect(parseMeetingAiPricing(undefined)).toEqual(defaultMeetingAiPricing());
    expect(
      parseMeetingAiPricing({ transcriptionCreditsPerMinute: -1, summaryCreditsPerMinute: 1.234 }),
    ).toEqual(defaultMeetingAiPricing());
  });

  it('accepts positive rates with at most 2 decimals', () => {
    expect(
      parseMeetingAiPricing({ transcriptionCreditsPerMinute: 3.5, summaryCreditsPerMinute: 0.25 }),
    ).toEqual({ transcriptionCreditsPerMinute: 3.5, summaryCreditsPerMinute: 0.25 });
  });
});

describe('getMeetingAiPricing', () => {
  it('reads the master system_settings row, then serves it from the memo', async () => {
    masterRows.value = { transcriptionCreditsPerMinute: 4, summaryCreditsPerMinute: 2 };
    const kv = fakeKv();
    const env = { DATABASE_URL_MASTER: 'x', WORKSPACE_CACHE: kv as never };

    expect(await getMeetingAiPricing(env)).toEqual({
      transcriptionCreditsPerMinute: 4,
      summaryCreditsPerMinute: 2,
    });
    expect(masterRows.calls).toBe(1);
    expect(kv.put).toHaveBeenCalledWith(WELDMEET_AI_PRICING_KV_KEY, expect.any(String), { expirationTtl: 60 });

    await getMeetingAiPricing(env);
    expect(masterRows.calls).toBe(1);
  });

  it('prefers the KV cache over the database', async () => {
    const kv = fakeKv({
      [WELDMEET_AI_PRICING_KV_KEY]: JSON.stringify({ transcriptionCreditsPerMinute: 9, summaryCreditsPerMinute: 8 }),
    });
    const pricing = await getMeetingAiPricing({ DATABASE_URL_MASTER: 'x', WORKSPACE_CACHE: kv as never });
    expect(pricing.transcriptionCreditsPerMinute).toBe(9);
    expect(masterRows.calls).toBe(0);
  });

  it('falls back to the defaults when the row is absent or the database is down', async () => {
    const env = { DATABASE_URL_MASTER: 'x', WORKSPACE_CACHE: fakeKv() as never };
    expect(await getMeetingAiPricing(env)).toEqual(defaultMeetingAiPricing());

    resetMeetingAiPricingMemo();
    masterRows.fail = true;
    expect(await getMeetingAiPricing({ DATABASE_URL_MASTER: 'x', WORKSPACE_CACHE: fakeKv() as never })).toEqual(
      defaultMeetingAiPricing(),
    );
  });
});

describe('minutes and credits', () => {
  it('bills started minutes and rounds credits up', () => {
    expect(billableMinutes(61)).toBe(2);
    expect(billableMinutes(0)).toBe(0);
    expect(billableMinutes(null)).toBe(0);
    expect(creditsForMinutes(10, 2)).toBe(20);
    expect(creditsForMinutes(3, 0.5)).toBe(2);
    expect(creditsForMinutes(0, 2)).toBe(0);
  });

  it('floor is one minute of the selected items, at least 1', () => {
    const pricing = { transcriptionCreditsPerMinute: 2, summaryCreditsPerMinute: 1 };
    expect(minimumBalanceFor(pricing, { transcription: true })).toBe(2);
    expect(minimumBalanceFor(pricing, { transcription: true, summary: true })).toBe(3);
    expect(
      minimumBalanceFor({ transcriptionCreditsPerMinute: 0.25, summaryCreditsPerMinute: 0.25 }, { summary: true }),
    ).toBe(1);
  });
});

describe('assertMeetingAiCredits (the start gate)', () => {
  const pricing = { transcriptionCreditsPerMinute: 2, summaryCreditsPerMinute: 1 };

  it('passes when the wallet covers one minute of both', async () => {
    credits.checkCredits.mockResolvedValue({ available: true, currentBalance: 10, required: 3, shortfall: 0 });
    await expect(
      assertMeetingAiCredits(metering, pricing, { transcription: true, summary: true }),
    ).resolves.toBeUndefined();
    expect(credits.checkCredits).toHaveBeenCalledWith(metering.masterDb, 'ws_internal', 3);
  });

  it('throws InsufficientMeetingCreditsError with the shortfall', async () => {
    credits.checkCredits.mockResolvedValue({ available: false, currentBalance: 1, required: 3, shortfall: 2 });
    const err = await assertMeetingAiCredits(metering, pricing, { transcription: true, summary: true }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(InsufficientMeetingCreditsError);
    expect(err).toMatchObject({ currentBalance: 1, required: 3, shortfall: 2 });
  });
});

describe('resolveMeetingMetering', () => {
  it('maps the Clerk org id to the internal workspace id', async () => {
    credits.resolveInternalWorkspaceId.mockResolvedValue('ws_internal');
    const m = await resolveMeetingMetering({ DATABASE_URL_MASTER: 'x' }, 'org_1', 'user_1', {} as never);
    expect(m.internalWsId).toBe('ws_internal');
    expect(credits.resolveInternalWorkspaceId).toHaveBeenCalledWith({}, 'org_1');
  });

  it('fails closed when the workspace has no master row', async () => {
    credits.resolveInternalWorkspaceId.mockResolvedValue(null);
    await expect(
      resolveMeetingMetering({ DATABASE_URL_MASTER: 'x' }, 'org_x', 'user_1', {} as never),
    ).rejects.toBeInstanceOf(MeetingBillingUnavailableError);
  });
});

describe('chargeMeetingAi', () => {
  const params = {
    kind: 'transcription',
    sessionId: 'msess_1',
    minutes: 10,
    ratePerMinute: 2,
    source: 'rtk',
  } as const;

  it('consumes minutes x rate with a per-session idempotency key', async () => {
    credits.consumeCredits.mockResolvedValue({ ok: true, transactionId: 't', newBalance: 5, duplicate: false });
    const result = await chargeMeetingAi(metering, params);
    expect(result).toEqual({ credits: 20, duplicate: false, settledNegative: false });
    expect(credits.consumeCredits).toHaveBeenCalledWith(
      metering.masterDb,
      expect.objectContaining({
        workspaceId: 'ws_internal',
        amount: 20,
        serviceType: 'meeting_transcription',
        idempotencyKey: meetingAiIdempotencyKey('transcription', 'msess_1'),
        referenceId: 'msess_1',
        referenceType: 'meeting_session',
      }),
    );
    expect(credits.grantCredits).not.toHaveBeenCalled();
  });

  it('reports a retry as a duplicate instead of charging twice', async () => {
    credits.consumeCredits.mockResolvedValue({ ok: true, transactionId: 't', newBalance: 5, duplicate: true });
    expect((await chargeMeetingAi(metering, params)).duplicate).toBe(true);
  });

  it('settles into a negative balance when the wallet cannot cover it', async () => {
    credits.consumeCredits.mockResolvedValue({
      ok: false,
      reason: 'INSUFFICIENT_CREDITS',
      currentBalance: 3,
      required: 20,
    });
    credits.grantCredits.mockResolvedValue({ ok: true, transactionId: 'd', newBalance: -17, duplicate: false });
    const result = await chargeMeetingAi(metering, { ...params, kind: 'summary', runId: 'run1', ratePerMinute: 1 });
    expect(result).toEqual({ credits: 10, duplicate: false, settledNegative: true });
    expect(credits.grantCredits).toHaveBeenCalledWith(
      metering.masterDb,
      expect.objectContaining({
        amount: -10,
        type: 'adjustment',
        serviceType: 'meeting_summary',
        idempotencyKey: 'meet-summary:msess_1:run1:settle',
        metadata: expect.objectContaining({ forcedSettlement: true }),
      }),
    );
  });

  it('charges nothing for zero minutes', async () => {
    expect(await chargeMeetingAi(metering, { ...params, minutes: 0 })).toEqual({
      credits: 0,
      duplicate: false,
      settledNegative: false,
    });
    expect(credits.consumeCredits).not.toHaveBeenCalled();
  });
});
