import { describe, it, expect } from 'vitest';
import { connectorSettingsSchema, mergeConnectorSettings, settingsError } from './settings';

const push = {
  enabled: true,
  revenueLedgerAccountId: 'led_rev',
};

describe('connector settings', () => {
  it('fills Moneybird push defaults and requires a revenue ledger when enabled', () => {
    const parsed = connectorSettingsSchema.parse({ moneybirdPush: push });
    expect(parsed.moneybirdPush).toEqual({
      enabled: true,
      sourceConnectionIds: [],
      revenueLedgerAccountId: 'led_rev',
      financialAccountId: null,
      feeLedgerAccountId: null,
      payoutLedgerAccountId: null,
      taxRateOverrides: { reverseCharge: null, outsideEu: null, exempt: null, noTax: null },
      startDate: null,
    });
    expect(connectorSettingsSchema.safeParse({ moneybirdPush: { enabled: true } }).success).toBe(false);
    expect(connectorSettingsSchema.safeParse({ moneybirdPush: { enabled: false } }).success).toBe(true);
  });

  it('needs the fee and transfer ledgers once a Stripe account is picked', () => {
    expect(connectorSettingsSchema.safeParse({ moneybirdPush: { ...push, financialAccountId: 'fa' } }).success).toBe(false);
    expect(
      connectorSettingsSchema.safeParse({
        moneybirdPush: { ...push, financialAccountId: 'fa', feeLedgerAccountId: 'f', payoutLedgerAccountId: 'p' },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown keys, bad dates and settings of another provider', () => {
    expect(connectorSettingsSchema.safeParse({ secret: 'x' }).success).toBe(false);
    expect(connectorSettingsSchema.safeParse({ importStartDate: '01-01-2026' }).success).toBe(false);
    expect(settingsError('moneybird', { importStartDate: '2026-01-01' })).toMatch(/Stripe/);
    expect(settingsError('stripe', { moneybirdPush: null })).toMatch(/Moneybird/);
    expect(settingsError('stripe', { importStartDate: '2026-01-01' })).toBeNull();
  });

  it('merges per key and keeps what the patch leaves out', () => {
    const current = { importStartDate: '2026-01-01' };
    expect(mergeConnectorSettings(current, {})).toEqual(current);
    expect(mergeConnectorSettings(current, { importStartDate: null })).toEqual({ importStartDate: null });
  });
});
