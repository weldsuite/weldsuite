/**
 * Validation and merging of `connector_connections.settings` (non-secret
 * per-connection settings: the Stripe import start date, the Moneybird push).
 */

import { z } from 'zod';
import type { ConnectorConnectionSettings, MoneybirdPushSettings } from '@weldsuite/db/schema';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const moneybirdId = z.string().min(1).max(64).nullable();

const taxRateOverridesSchema = z.object({
  reverseCharge: moneybirdId.default(null),
  outsideEu: moneybirdId.default(null),
  exempt: moneybirdId.default(null),
  noTax: moneybirdId.default(null),
});

export const moneybirdPushSettingsSchema = z
  .object({
    enabled: z.boolean(),
    sourceConnectionIds: z.array(z.string().min(1).max(30)).max(20).default([]),
    revenueLedgerAccountId: moneybirdId.default(null),
    financialAccountId: moneybirdId.default(null),
    feeLedgerAccountId: moneybirdId.default(null),
    payoutLedgerAccountId: moneybirdId.default(null),
    taxRateOverrides: taxRateOverridesSchema.default({}),
    startDate: isoDate.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && !value.revenueLedgerAccountId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['revenueLedgerAccountId'], message: 'Pick a revenue ledger account' });
    }
    if (value.financialAccountId && (!value.feeLedgerAccountId || !value.payoutLedgerAccountId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feeLedgerAccountId'],
        message: 'Pick the fee and transfer ledgers for the Stripe account',
      });
    }
  });

export const connectorSettingsSchema = z
  .object({
    importStartDate: isoDate.nullable().optional(),
    moneybirdPush: moneybirdPushSettingsSchema.nullable().optional(),
  })
  .strict();

export type ConnectorSettingsInput = z.infer<typeof connectorSettingsSchema>;

/** A setting that does not belong to this provider, or null. */
export function settingsError(provider: string, settings: ConnectorSettingsInput | undefined): string | null {
  if (!settings) return null;
  if (settings.importStartDate !== undefined && provider !== 'stripe') {
    return 'importStartDate only applies to Stripe connections';
  }
  if (settings.moneybirdPush !== undefined && provider !== 'moneybird') {
    return 'moneybirdPush only applies to Moneybird connections';
  }
  return null;
}

/** Shallow merge per key: a key left out of the patch keeps its stored value. */
export function mergeConnectorSettings(
  current: ConnectorConnectionSettings | null | undefined,
  patch: ConnectorSettingsInput,
): ConnectorConnectionSettings {
  const next: ConnectorConnectionSettings = { ...(current ?? {}) };
  if (patch.importStartDate !== undefined) next.importStartDate = patch.importStartDate;
  if (patch.moneybirdPush !== undefined) next.moneybirdPush = patch.moneybirdPush as MoneybirdPushSettings | null;
  return next;
}
