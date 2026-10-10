import { humanizeKey } from '@/lib/payroll/format';

/** The parts of the details form a missing field belongs to. */
export type MissingGroup = 'nationalId' | 'dateOfBirth' | 'bank' | 'address' | 'idDocument';

function groupOf(code: string): MissingGroup | null {
  const key = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key.startsWith('nationalid') || key === 'bsn' || key === 'ssn') return 'nationalId';
  if (key === 'dateofbirth' || key === 'dob' || key === 'birthdate') return 'dateOfBirth';
  if (key.startsWith('bank') || key === 'iban') return 'bank';
  if (key.startsWith('homeaddress') || key === 'address') return 'address';
  if (key.startsWith('iddocument')) return 'idDocument';
  return null;
}

/**
 * Sorts the API's `missing` codes (`nationalId`, `bankIban`, `dateOfBirth`, …)
 * into the form sections they belong to. A code this portal does not know is
 * kept, humanised, so the reminder never hides something payroll asked for.
 */
export function missingSections(missing: readonly string[]): { groups: ReadonlySet<MissingGroup>; other: string[] } {
  const groups = new Set<MissingGroup>();
  const other: string[] = [];
  for (const code of missing) {
    const group = groupOf(code);
    if (group) groups.add(group);
    else other.push(humanizeKey(code));
  }
  return { groups, other };
}
