'use server';

import { revalidatePath } from 'next/cache';
import { partnerContractSchema } from '@weldsuite/app-api-client/schemas/partners';
import { guardWrite } from '@/lib/auth';
import { getMasterDb, masterSchema } from '@/lib/db';
import { generateId } from '@/lib/id';
import { PARTNER_CONTRACT_DEFAULTS_KEY, contractDefaultsValue, zodMessage, type ContractTerms } from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';
import type { ActionResult } from './workspaces';

const { systemSettings } = masterSchema;

/**
 * Save the default contract terms (`billing.partner_contract_defaults`). They
 * only prefill a new partner's first contract; existing contracts never change.
 */
export async function savePartnerContractDefaults(contract: Record<string, unknown>): Promise<ActionResult<ContractTerms>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };

  const parsed = partnerContractSchema.safeParse(contract);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error), code: 'VALIDATION' };

  const value = contractDefaultsValue(parsed.data);
  const updatedBy = guard.identity.email;
  try {
    await getMasterDb()
      .insert(systemSettings)
      .values({
        id: generateId('set'),
        key: PARTNER_CONTRACT_DEFAULTS_KEY,
        category: 'billing',
        dataType: 'json',
        value,
        description: 'Default terms of a new reseller partner contract (admin console prefill)',
        updatedBy,
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value, category: 'billing', dataType: 'json', updatedBy, updatedAt: new Date() },
      });
  } catch {
    return { ok: false, error: partnersCopy().defaults.saveFailed };
  }

  revalidatePath('/partners/defaults');
  revalidatePath('/partners/new');
  return { ok: true, data: value };
}
