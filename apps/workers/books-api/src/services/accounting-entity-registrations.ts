/**
 * Release 1: the tax identifiers a WeldBooks entity request carries are also
 * the entity's primary registrations in core (`legal_entity_registrations`,
 * weldsuite-documentation/plans/legal-entities.md). `entities.tax_identifiers` stays written by
 * the caller (the mirror); this keeps the registrations in step.
 *
 *   vatNumber          -> vat (gstin for an Indian entity); a US entity's EIN lives in `ein`
 *   registrationNumber -> company_registration
 *   einOrSsn           -> ein, only when it is an EIN (an SSN never becomes a registration)
 */

import {
  createRegistration,
  deleteRegistration,
  getRegistration,
  LegalEntityError,
  updateRegistration,
} from '@weldsuite/core-domain/legal-entities';
import {
  normalizeRegistrationNumber,
  type LegalEntityRegistrationType,
} from '@weldsuite/app-api-client/schemas/legal-entities';
import type { Database } from '@weldsuite/worker-kit/db';

export interface TaxIdentifierValues {
  vatNumber?: string;
  registrationNumber?: string;
  einOrSsn?: string;
}

const EIN_PATTERN = /^\d{2}-\d{7}$/;

/** Set (or, for a blank number, retire) the primary registration of a type. Numbers the core format check refuses stay on the old column only. */
async function syncPrimary(
  db: Database,
  entityId: string,
  type: LegalEntityRegistrationType,
  number: string | undefined,
): Promise<void> {
  if (number === undefined) return;
  try {
    const current = await getRegistration(db, entityId, type);
    const value = number.trim();
    if (value === '') {
      if (current?.isPrimary) await deleteRegistration(db, entityId, current.id);
      return;
    }
    if (current && current.number === normalizeRegistrationNumber(type, value)) return;
    if (current?.isPrimary) {
      await updateRegistration(db, entityId, current.id, { number: value });
    } else {
      await createRegistration(db, entityId, { type, number: value, isPrimary: true });
    }
  } catch (err) {
    // A number core's format check or a payroll link refuses must not fail the WeldBooks save: the old column still holds it.
    if (!(err instanceof LegalEntityError)) throw err;
  }
}

/** Mirror the identifiers a request touched (`touched` lists the keys) into the entity's primary registrations. */
export async function syncRegistrationsFromTaxIdentifiers(
  db: Database,
  entity: { id: string; jurisdictionCode: string },
  identifiers: TaxIdentifierValues | null | undefined,
  touched: ReadonlySet<keyof TaxIdentifierValues>,
): Promise<void> {
  if (!identifiers || touched.size === 0) return;
  const code = entity.jurisdictionCode.toUpperCase();
  // A touched identifier that is missing (or blank) in the validated result was cleared.
  if (touched.has('vatNumber') && code !== 'US') {
    await syncPrimary(db, entity.id, code.startsWith('IN') ? 'gstin' : 'vat', identifiers.vatNumber ?? '');
  }
  if (touched.has('registrationNumber')) {
    await syncPrimary(db, entity.id, 'company_registration', identifiers.registrationNumber ?? '');
  }
  if (touched.has('einOrSsn') || (code === 'US' && touched.has('vatNumber'))) {
    const given = [identifiers.einOrSsn, code === 'US' ? identifiers.vatNumber : undefined].filter(
      (v): v is string => typeof v === 'string' && v.trim() !== '',
    );
    const ein = given.find((v) => EIN_PATTERN.test(v.trim()));
    if (ein) await syncPrimary(db, entity.id, 'ein', ein);
    // Nothing left in the slots clears the EIN; an SSN there is not a registration and leaves a registered EIN alone.
    else if (given.length === 0) await syncPrimary(db, entity.id, 'ein', '');
  }
}
