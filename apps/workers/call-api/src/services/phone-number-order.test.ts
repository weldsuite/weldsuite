import { beforeEach, describe, expect, it, vi } from 'vitest';

const telnyxRequest = vi.fn();
const dbCalls = { inserts: 0 };

vi.mock('../lib/telnyx', () => ({
  isTelnyxConfigured: () => true,
  telnyxRequest: (...args: unknown[]) => telnyxRequest(...args),
}));
vi.mock('../lib/phone-registry', () => ({ upsertPhoneNumberRegistry: vi.fn(async () => undefined) }));
vi.mock('@weldsuite/worker-kit/db', () => {
  const rows: unknown[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
    insert: () => ({
      values: async () => {
        dbCalls.inserts += 1;
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
  return {
    getTenantDbForWorkspace: async () => db,
    schema: { voipPhoneNumbers: { phoneNumber: 'phone_number', deletedAt: 'deleted_at', id: 'id' } },
  };
});

import { fulfillPaidPhoneNumberForCheckout, PhoneFulfillInProgressError } from './phone-number-order';

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
  };
}

const input = {
  checkoutSessionId: 'cs_test_abcdefgh',
  clerkOrgId: 'org_1',
  phoneNumber: '+31201234567',
  countryCode: 'NL',
  numberType: 'local',
};

const paidSession = {
  id: 'cs_test_abcdefgh',
  object: 'checkout.session',
  status: 'complete',
  payment_status: 'paid',
  metadata: {
    type: 'phone_checkout',
    clerkOrgId: 'org_1',
    phone_number: '+31201234567',
    phone_country_code: 'NL',
    phone_number_type: 'local',
  },
};

function makeEnv(kv: ReturnType<typeof fakeKv>) {
  return { WORKSPACE_CACHE: kv, STRIPE_SECRET_KEY: 'sk_test_1', TELNYX_API_KEY: 'k' } as never;
}

describe('fulfillPaidPhoneNumberForCheckout', () => {
  beforeEach(() => {
    telnyxRequest.mockReset();
    telnyxRequest.mockResolvedValue({
      data: { id: 'order_1', phone_numbers: [{ id: 'pn_1', phone_number: '+31201234567', requirements_met: true }] },
    });
    dbCalls.inserts = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(paidSession), { status: 200 })));
  });

  it('buys nothing when the payment cannot be verified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ...paidSession, payment_status: 'unpaid' }), { status: 200 })),
    );
    const kv = fakeKv();
    await expect(fulfillPaidPhoneNumberForCheckout(makeEnv(kv), input)).rejects.toMatchObject({ status: 402 });
    expect(telnyxRequest).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it('buys nothing for an org that did not pay', async () => {
    const kv = fakeKv();
    await expect(
      fulfillPaidPhoneNumberForCheckout(makeEnv(kv), { ...input, clerkOrgId: 'org_attacker' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(telnyxRequest).not.toHaveBeenCalled();
  });

  it('orders once and replays the first result for a retried reference', async () => {
    const kv = fakeKv();
    const first = await fulfillPaidPhoneNumberForCheckout(makeEnv(kv), input);
    expect(first).toMatchObject({ alreadyFulfilled: false, status: 'active' });

    const second = await fulfillPaidPhoneNumberForCheckout(makeEnv(kv), input);
    expect(second).toMatchObject({ id: first.id, alreadyFulfilled: true, status: 'active' });

    expect(telnyxRequest).toHaveBeenCalledTimes(1);
    expect(dbCalls.inserts).toBe(1);
  });

  it('refuses a concurrent duplicate while the first is in flight (no second order)', async () => {
    const kv = fakeKv();
    kv.store.set('phone-fulfill:cs_test_abcdefgh', JSON.stringify({ state: 'inflight' }));
    await expect(fulfillPaidPhoneNumberForCheckout(makeEnv(kv), input)).rejects.toBeInstanceOf(
      PhoneFulfillInProgressError,
    );
    expect(telnyxRequest).not.toHaveBeenCalled();
  });

  it('frees the claim when the order fails so a retry can run', async () => {
    const kv = fakeKv();
    telnyxRequest.mockRejectedValueOnce(new Error('telnyx down'));
    await expect(fulfillPaidPhoneNumberForCheckout(makeEnv(kv), input)).rejects.toThrow('telnyx down');
    expect(kv.store.has('phone-fulfill:cs_test_abcdefgh')).toBe(false);

    await expect(fulfillPaidPhoneNumberForCheckout(makeEnv(kv), input)).resolves.toMatchObject({
      alreadyFulfilled: false,
    });
  });
});
