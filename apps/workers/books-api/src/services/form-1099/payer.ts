/**
 * The payer on a 1099: the accounting entity. Its EIN sits in
 * `entities.tax_identifiers.einOrSsn`; a sole proprietor without one has an
 * SSN in `entities.ssn_encrypted`, which is decrypted (and the reveal logged)
 * only when the caller needs the full number.
 */

import { decryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import { maskTin } from '@weldsuite/books-domain/jurisdictions/us/identifiers';
import type { IrisPayer } from '@weldsuite/books-domain/us-compliance/iris-csv';
import type { EntityRow } from './load';

export interface Payer {
  name: string;
  nameLine2: string | null;
  tinType: 'ein' | 'ssn';
  /** Full TIN; null when the payer has none or the caller did not ask for the SSN. */
  tin: string | null;
  tinMasked: string | null;
  address: IrisPayer['address'] | null;
  phone: string | null;
  email: string | null;
  /** Things to fix on the entity before filing. */
  issues: string[];
}

type KeyEnv = { DATABASE_ENCRYPTION_KEY?: string; DATABASE_ENCRYPTION_KEY_V2?: string };

export async function loadPayer(
  db: Database,
  entity: EntityRow,
  options: { env: KeyEnv; revealSsn: boolean; userId: string; reason: string },
): Promise<Payer> {
  const issues: string[] = [];
  const ein = entity.taxIdentifiers?.einOrSsn?.trim() || null;
  let tinType: 'ein' | 'ssn' = 'ein';
  let tin: string | null = null;
  let masked: string | null = null;

  if (ein) {
    tin = ein.replace(/\D/g, '');
    masked = maskTin(tin, 'ein');
  } else if (entity.ssnEncrypted) {
    tinType = 'ssn';
    masked = entity.ssnLast4 ? maskTin(entity.ssnLast4, 'ssn') : null;
    if (options.revealSsn) {
      const keyring = keyringFromEnv(options.env);
      if (!keyring.v1 && !keyring.v2) {
        issues.push('The payer SSN cannot be read: the worker has no encryption key.');
      } else {
        const plaintext = await decryptField(entity.ssnEncrypted, keyring);
        await db.insert(schema.taxIdReveals).values({
          id: generateId('tir'),
          entityId: entity.id,
          subjectType: 'entity',
          subjectId: entity.id,
          field: 'ssn',
          revealedBy: options.userId,
          reason: options.reason,
        });
        tin = plaintext.replace(/\D/g, '');
      }
    }
  } else {
    issues.push('The accounting entity has no EIN or SSN; add it on the entity page.');
  }

  const address = normalizePostalAddress(entity.address);
  if (!address?.line1 || !address.city || !address.state || !address.postalCode) {
    issues.push('The accounting entity needs a complete address (street, city, state, ZIP).');
  }

  const legal = (entity.legalName ?? entity.name).trim();
  const dba = entity.dba?.trim();
  return {
    name: legal,
    nameLine2: dba && dba.toLowerCase() !== legal.toLowerCase() ? dba : null,
    tinType,
    tin,
    tinMasked: masked,
    address: address
      ? {
          line1: address.line1 ?? '',
          line2: address.line2 ?? null,
          city: address.city ?? '',
          state: address.state ?? '',
          zip: address.postalCode ?? '',
          country: address.country && address.country !== 'US' ? address.country : null,
        }
      : null,
    phone: entity.contact?.phone ?? null,
    email: entity.contact?.email ?? null,
    issues,
  };
}
