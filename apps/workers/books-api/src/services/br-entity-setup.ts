/**
 * Brazil-specific entity setup: the jurisdiction_settings a BR entity keeps
 * (state, municipality, ISS rate, Pix key, CBS/IBS rates from 2027, ...), its
 * time zone, and switching the seeded tax profiles when the regime changes
 * (the regime can change each January).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  brProfileOf,
  brRegimeOf,
  brState,
  isPlausiblePixKey,
  normalizeCep,
  timezoneOfUf,
  type BrEntitySettings,
} from '@weldsuite/books-domain/jurisdictions/br';
import type { StoredPostalAddress } from '@weldsuite/db/schema';
import { EntitySetupError } from './accounting-entity-setup';

const percent = (max: number) => z.number().min(0).max(max);

/** The Brazilian keys of jurisdiction_settings; other keys (fiscal webhook state, sync cursors) pass through. */
export const brSettingsSchema = z
  .object({
    uf: z.string().trim().length(2).optional(),
    municipalityCode: z.string().regex(/^\d{7}$/, 'The IBGE municipality code has 7 digits').optional(),
    municipalityName: z.string().trim().max(100).optional(),
    inscricaoMunicipal: z.string().trim().max(20).optional(),
    cnae: z.string().trim().regex(/^\d{7}$|^\d{4}-\d\/\d{2}$/, 'CNAE is 7 digits (e.g. 6201501)').optional(),
    issRate: z.number().min(2).max(5).optional(),
    simplesAnexo: z.enum(['I', 'II', 'III', 'IV', 'V']).optional(),
    icmsContributor: z.boolean().optional(),
    cbsRate: percent(30).optional(),
    ibsRate: percent(30).optional(),
    pixKey: z.string().trim().max(77).optional(),
    pixCity: z.string().trim().max(15).optional(),
    fiscalProvider: z.literal('focus_nfe').optional(),
    fiscalEnvironment: z.enum(['homologacao', 'producao']).optional(),
    nfseStandard: z.enum(['nacional', 'municipal']).optional(),
    nfeSeries: z.string().regex(/^\d{1,3}$/).optional(),
    payroll12m: z.number().min(0).optional(),
  })
  .passthrough();

/**
 * Check and complete a BR entity's settings: the UF comes from the address
 * when not given, the municipality code must be in that UF, the Pix key must
 * look like one. Returns the settings and the time zone of the state.
 */
export function normalizeBrSettings(
  settings: Record<string, unknown> | null | undefined,
  address: StoredPostalAddress | null | undefined,
): { settings: Record<string, unknown>; timezone: string } {
  // A null or blank value clears the key (PATCH merges settings into the stored ones).
  const present = Object.fromEntries(Object.entries(settings ?? {}).filter(([, value]) => value !== null && value !== ''));
  const parsed = brSettingsSchema.safeParse(present);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EntitySetupError(`jurisdictionSettings.${issue.path.join('.')}: ${issue.message}`);
  }
  const next: BrEntitySettings & Record<string, unknown> = { ...parsed.data };

  const state = brState(next.uf ?? address?.state ?? undefined);
  if (next.uf && !state) throw new EntitySetupError(`'${next.uf}' is not a Brazilian state (UF)`);
  if (state) next.uf = state.uf;
  if (next.municipalityCode && state && next.municipalityCode.slice(0, 2) !== state.ibge) {
    throw new EntitySetupError(`Municipality ${next.municipalityCode} is not in ${state.uf}`);
  }
  if (next.pixKey && !isPlausiblePixKey(next.pixKey)) {
    throw new EntitySetupError('The Pix key must be a CPF/CNPJ (digits only), an e-mail, a +55 phone number or a random key');
  }
  if (!next.pixCity && address?.city) next.pixCity = address.city.slice(0, 15);
  return { settings: next, timezone: timezoneOfUf(next.uf) };
}

/** A Brazilian address with its CEP in the 00000-000 form. */
export function normalizeBrAddress<T extends { postalCode?: string | null } | null | undefined>(address: T): T {
  if (!address?.postalCode) return address;
  const cep = normalizeCep(address.postalCode);
  if (!cep) throw new EntitySetupError('The CEP must have 8 digits (00000-000)');
  return { ...address, postalCode: cep };
}

/**
 * After a change of regime: the profiles of the new regime are switched on,
 * the others off. A default that no longer fits moves to the regime's default.
 */
export async function syncBrTaxProfiles(db: Database, entityId: string, taxClassification: string | null): Promise<void> {
  const regime = brRegimeOf(taxClassification);
  const rates = await db
    .select({ id: schema.taxRates.id, jurisdictionMetadata: schema.taxRates.jurisdictionMetadata })
    .from(schema.taxRates)
    .where(and(eq(schema.taxRates.entityId, entityId), isNull(schema.taxRates.deletedAt)));
  const now = new Date();
  for (const rate of rates) {
    const profile = brProfileOf(rate.jurisdictionMetadata as Record<string, unknown> | null);
    if (!profile) continue; // a rate created by hand stays as it is
    const active = profile.regimes.includes(regime);
    await db
      .update(schema.taxRates)
      .set({ isActive: active, ...(active ? {} : { isDefault: false }), updatedAt: now })
      .where(eq(schema.taxRates.id, rate.id));
  }
}
