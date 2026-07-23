/**
 * Invoice compliance helpers (NL factuureisen).
 *
 * Finalizing an invoice is the moment it becomes a legal document, so this is
 * where the Belastingdienst's invoice requirements are enforced:
 * - the entity must carry its mandatory identifiers (BTW-nummer, KvK, IBAN)
 * - reverse-charge / intracommunautaire invoices need a VIES-valid buyer VAT
 *   number and the "BTW verlegd" wording on the document
 * - a KOR entity must not charge VAT at all
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Entity } from '@weldsuite/db/schema';
import { schema, type Database } from '../db';
import { getAdapter, hasAdapter } from './jurisdictions/registry';
import {
  NL_NOTICE_KOR,
  NL_NOTICE_REVERSE_CHARGE_DOMESTIC,
  NL_NOTICE_REVERSE_CHARGE_EU,
} from './jurisdictions/nl/invoice-format';
import { isKorActive } from './accounting-guards';
import { checkVatNumber } from './vies';

/** Buyer VAT number: parties carry no tax ids — the wrapped company row does. */
export async function getContactVatNumber(
  db: Database,
  partyId: string | null | undefined,
): Promise<string | null> {
  if (!partyId) return null;
  const [party] = await db
    .select({ companyId: schema.parties.companyId })
    .from(schema.parties)
    .where(eq(schema.parties.id, partyId))
    .limit(1);
  if (!party?.companyId) return null;
  const [company] = await db
    .select({ vatNumber: schema.companies.vatNumber })
    .from(schema.companies)
    .where(eq(schema.companies.id, party.companyId))
    .limit(1);
  return company?.vatNumber ?? null;
}

/** Distinct tax category codes used by an invoice's line items. */
export async function collectInvoiceTaxCategories(
  db: Database,
  invoiceId: string,
): Promise<Set<string>> {
  const items = await db
    .select({ taxRateId: schema.invoiceItems.taxRateId })
    .from(schema.invoiceItems)
    .where(and(eq(schema.invoiceItems.invoiceId, invoiceId), isNull(schema.invoiceItems.deletedAt)));

  const rateIds = [...new Set(items.map((i) => i.taxRateId).filter((id): id is string => !!id))];
  if (rateIds.length === 0) return new Set();

  const rates = await db
    .select({ taxCategoryCode: schema.taxRates.taxCategoryCode })
    .from(schema.taxRates)
    .where(inArray(schema.taxRates.id, rateIds));

  return new Set(rates.map((r) => r.taxCategoryCode).filter((code): code is NonNullable<typeof code> => !!code));
}

export function invoiceUsesReverseCharge(categories: Set<string>): boolean {
  return categories.has('reverse_charge') || categories.has('eu_b2b_service');
}

/** Legally required statements to print on the invoice document. */
export function buildComplianceNotices(entity: Entity, categories: Set<string>): string[] {
  if (entity.jurisdictionCode !== 'NL') return [];
  const notices: string[] = [];
  if (isKorActive(entity)) notices.push(NL_NOTICE_KOR);
  if (categories.has('eu_b2b_service')) notices.push(NL_NOTICE_REVERSE_CHARGE_EU);
  else if (categories.has('reverse_charge')) notices.push(NL_NOTICE_REVERSE_CHARGE_DOMESTIC);
  return notices;
}

export interface ComplianceCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  buyerVatNumber: string | null;
}

/**
 * Validate an invoice against the entity jurisdiction's factuureisen before
 * it is finalized. Returns errors (block) and warnings (proceed, surface).
 */
export async function validateInvoiceForFinalize(
  db: Database,
  entity: Entity,
  invoice: { contactId: string | null; taxTotal: string | null },
  categories: Set<string>,
): Promise<ComplianceCheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  let buyerVatNumber: string | null = null;

  if (hasAdapter(entity.jurisdictionCode)) {
    const requirements = getAdapter(entity.jurisdictionCode).getInvoiceRequirements(
      entity.locale ?? undefined,
    );
    const missing: string[] = [];
    for (const field of requirements.requiredFields) {
      if (field === 'vatNumber' && !entity.taxIdentifiers?.vatNumber) missing.push('BTW-nummer');
      if (field === 'registrationNumber' && !entity.taxIdentifiers?.registrationNumber) missing.push('KvK-nummer');
      if (field === 'iban' && !entity.bankDetails?.iban) missing.push('IBAN');
      if (field === 'bic' && !entity.bankDetails?.bic) missing.push('BIC');
    }
    if (missing.length > 0) {
      errors.push(
        `Entity is missing legally required invoice fields: ${missing.join(', ')}. Add them in the entity settings before finalizing.`,
      );
    }
  }

  // KOR entities may not charge VAT on any invoice.
  if (isKorActive(entity) && parseFloat(invoice.taxTotal || '0') > 0) {
    errors.push(
      'This entity uses the kleineondernemersregeling (KOR) — invoices must not charge BTW. Use the exempt tax rate on all lines.',
    );
  }

  // Reverse charge / ICL: valid buyer VAT number is a hard condition for the
  // 0% treatment (an invalid number shifts the liability back to the seller).
  if (invoiceUsesReverseCharge(categories)) {
    buyerVatNumber = await getContactVatNumber(db, invoice.contactId);
    if (!buyerVatNumber) {
      errors.push(
        "Reverse-charge / intracommunautaire invoices require the customer's VAT number on their company record.",
      );
    } else {
      const vies = await checkVatNumber(db, buyerVatNumber);
      if (vies.available && !vies.valid) {
        errors.push(
          `Customer VAT number ${buyerVatNumber} failed VIES validation — the 0% reverse-charge treatment is not allowed with an invalid number.`,
        );
      } else if (!vies.available) {
        warnings.push(
          `VIES is currently unavailable — could not verify customer VAT number ${buyerVatNumber}. The invoice was finalized; re-validate later.`,
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, buyerVatNumber };
}
