import 'server-only';

import { eq } from 'drizzle-orm';
import { getMasterDb, masterSchema } from './db';
import { PARTNER_CONTRACT_DEFAULTS_KEY, parseContractDefaults, type ContractTerms } from './partners';

const { systemSettings } = masterSchema;

export interface PartnerContractDefaultsView {
  /** Null until saved once (the forms then use the built-in defaults). */
  terms: ContractTerms | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** The default terms a new partner's first contract starts from (`system_settings`). */
export async function getPartnerContractDefaults(): Promise<PartnerContractDefaultsView> {
  const [row] = await getMasterDb()
    .select({ value: systemSettings.value, updatedAt: systemSettings.updatedAt, updatedBy: systemSettings.updatedBy })
    .from(systemSettings)
    .where(eq(systemSettings.key, PARTNER_CONTRACT_DEFAULTS_KEY))
    .limit(1);
  const terms = row ? parseContractDefaults(row.value) : null;
  return {
    terms,
    updatedAt: terms && row ? row.updatedAt.toISOString() : null,
    updatedBy: terms ? (row?.updatedBy ?? null) : null,
  };
}
