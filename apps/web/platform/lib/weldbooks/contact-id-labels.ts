/** EU member states other than NL and BE (their company registers have no special name here). */
const EU_COUNTRIES = new Set([
  'AT', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'PL',
  'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/** Which words a contact's tax and registration fields use. */
export interface ContactIdKinds {
  /** The tax number field: a VAT number, a GSTIN, or a plain tax id. */
  taxId: 'vat_number' | 'gstin' | 'tax_id' | 'entity';
  /** The company registration field; `null` hides it (a US contact has no such number to file here). */
  registrationId: 'kvk' | 'kbo' | 'company_number' | 'pan' | 'entity' | null;
}

/**
 * The labels of a contact's tax number and registration number follow the
 * contact's country, not the books' jurisdiction: a Belgian customer of a Dutch
 * company has an enterprise number (KBO/BCE), not a KvK number. With no
 * country yet, the entity's own terminology applies.
 */
export function contactIdKinds(countryCode: string | null | undefined): ContactIdKinds {
  const country = countryCode?.trim().toUpperCase();
  if (!country || country.length !== 2) return { taxId: 'entity', registrationId: 'entity' };
  if (country === 'NL') return { taxId: 'vat_number', registrationId: 'kvk' };
  if (country === 'BE') return { taxId: 'vat_number', registrationId: 'kbo' };
  if (country === 'IN') return { taxId: 'gstin', registrationId: 'pan' };
  // A US business is identified by an EIN (collected with the vendor tax details), not a registration number.
  if (country === 'US') return { taxId: 'tax_id', registrationId: null };
  if (EU_COUNTRIES.has(country) || country === 'GB') return { taxId: 'vat_number', registrationId: 'company_number' };
  return { taxId: 'tax_id', registrationId: 'company_number' };
}

/** The terminology texts (`t.accounting.terminology`) the labels come from. */
interface TerminologyTexts {
  taxId: Record<string, string>;
  registrationId: Record<string, string>;
}

/** Resolved labels of the tax number and registration number fields; `registration` null = hide the field. */
export function contactIdLabels(
  countryCode: string | null | undefined,
  tt: TerminologyTexts,
  entityLabels: { taxId: string; registrationId: string },
): { taxId: string; registrationId: string | null } {
  const kinds = contactIdKinds(countryCode);
  let registrationId: string | null = null;
  if (kinds.registrationId === 'entity') registrationId = entityLabels.registrationId;
  else if (kinds.registrationId !== null) {
    registrationId = tt.registrationId[kinds.registrationId] ?? entityLabels.registrationId;
  }
  return {
    taxId: kinds.taxId === 'entity' ? entityLabels.taxId : (tt.taxId[kinds.taxId] ?? entityLabels.taxId),
    registrationId,
  };
}
