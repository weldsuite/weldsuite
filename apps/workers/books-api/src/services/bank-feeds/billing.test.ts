import { describe, expect, it, vi } from 'vitest';
import { BankConnectionBillingError, checkNewConnection, createBankConnectionBilling, type BankConnectionBilling } from './billing';

const summary = { connections: 1, included: 1, billedExtra: 0, unitAmountCents: 500, currency: 'eur', hasPaymentMethod: true, canAddPaid: true };

function context(environment: string) {
  return { env: { ENVIRONMENT: environment }, req: { header: () => 'Bearer jwt' } };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createBankConnectionBilling', () => {
  it('is off where billing-worker cannot authenticate the caller (local, plain HTTP)', async () => {
    const call = vi.fn();
    const billing = createBankConnectionBilling(context('development'), call);
    expect(await billing.status()).toBeNull();
    await billing.sync();
    expect(call).not.toHaveBeenCalled();
  });

  it('reads the summary and posts a sync to billing-worker', async () => {
    const call = vi.fn(async (_c: unknown, path: string, _init?: { method?: string }) =>
      path.endsWith('/status') ? json(200, { data: summary }) : json(200, { data: { quantity: 0 } }),
    );
    const billing = createBankConnectionBilling(context('test'), call);
    expect(await billing.status()).toEqual(summary);
    await billing.sync();
    expect(call.mock.calls.map((args) => [args[1], args[2]?.method])).toEqual([
      ['/api/billing/bank-connections/status', 'GET'],
      ['/api/billing/bank-connections/sync', 'POST'],
    ]);
  });

  it('treats an environment without Stripe as billing off', async () => {
    const billing = createBankConnectionBilling(context('test'), async () => json(503, { error: { code: 'BILLING_NOT_CONFIGURED' } }));
    expect(await billing.status()).toBeNull();
  });

  it('passes billing-worker refusals on with their code, and an outage as 502', async () => {
    const refused = createBankConnectionBilling(context('test'), async () => json(403, { error: { code: 'BILLING_ADMIN_REQUIRED', message: 'admins only' } }));
    await expect(refused.sync()).rejects.toMatchObject({ status: 403, code: 'BILLING_ADMIN_REQUIRED' });

    const down = createBankConnectionBilling(context('test'), async () => {
      throw new Error('network');
    });
    await expect(down.status()).rejects.toMatchObject({ status: 502, code: 'BILLING_UNAVAILABLE' });

    const odd = createBankConnectionBilling(context('test'), async () => json(500, {}));
    await expect(odd.status()).rejects.toBeInstanceOf(BankConnectionBillingError);
  });
});

describe('checkNewConnection', () => {
  const billingWith = (value: typeof summary | null): BankConnectionBilling => ({ status: async () => value, sync: async () => undefined });

  it('lets a connection within the included ones through unbilled, and anything when billing is off', async () => {
    expect(await checkNewConnection(billingWith({ ...summary, connections: 0 }), { accepted: false, requireAcceptance: true })).toEqual({ billed: false });
    expect(await checkNewConnection(billingWith(null), { accepted: false, requireAcceptance: true })).toEqual({ billed: false });
  });

  it('above them needs agreement (when asked for), an admin and a payment method', async () => {
    await expect(checkNewConnection(billingWith(summary), { accepted: false, requireAcceptance: true })).rejects.toMatchObject({
      status: 402,
      code: 'BANK_CONNECTION_LIMIT_REACHED',
    });
    expect(await checkNewConnection(billingWith(summary), { accepted: true, requireAcceptance: true })).toEqual({ billed: true });
    expect(await checkNewConnection(billingWith(summary), { accepted: false, requireAcceptance: false })).toEqual({ billed: true });
    await expect(checkNewConnection(billingWith({ ...summary, canAddPaid: false }), { accepted: true, requireAcceptance: true })).rejects.toMatchObject({
      status: 403,
      code: 'BILLING_ADMIN_REQUIRED',
    });
    await expect(checkNewConnection(billingWith({ ...summary, hasPaymentMethod: false }), { accepted: true, requireAcceptance: true })).rejects.toMatchObject({
      status: 402,
      code: 'PAYMENT_METHOD_REQUIRED',
    });
  });
});
