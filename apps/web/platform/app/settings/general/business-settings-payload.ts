/**
 * What a Business settings save sends to `PUT /api/workspace-settings`.
 *
 * The legal fields are written through to the default legal entity, where an
 * empty value clears the field (or deletes the VAT / registration number).
 * So the form sends only the fields the member changed since they were
 * loaded: a field it shows but the member did not touch can never clear what
 * the entity holds (TASK-1464).
 */

/** The Business settings form, every text field a string (empty = not set). */
export interface BusinessSettingsFormValues {
  timezone?: string;
  legalName?: string;
  tradingName?: string;
  contactFirstName?: string;
  contactLastName?: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryCode: string;
  taxId?: string;
  registrationNumber?: string;
}

/** Form field -> settings field, for the fields that live on the legal entity. */
const LEGAL_FIELDS = {
  legalName: 'legalName',
  tradingName: 'tradingName',
  contactFirstName: 'contactFirstName',
  contactLastName: 'contactLastName',
  email: 'email',
  phone: 'phone',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  state: 'state',
  postalCode: 'postalCode',
  taxId: 'vatNumber',
  registrationNumber: 'registrationNumber',
} as const satisfies Partial<Record<keyof BusinessSettingsFormValues, string>>;

type LegalSettingsField = (typeof LEGAL_FIELDS)[keyof typeof LEGAL_FIELDS];

export type BusinessSettingsPayload = Partial<Record<LegalSettingsField, string | null>> & {
  timezone?: string;
  country?: string;
};

const clean = (value: string | undefined): string => value?.trim() ?? '';

/**
 * The PUT body: every field that differs from `loaded` (an emptied one as
 * null), and the country along with any other legal field, so a first save
 * can still create the default entity. Empty when nothing changed.
 */
export function businessSettingsPayload(
  values: BusinessSettingsFormValues,
  loaded: BusinessSettingsFormValues,
): BusinessSettingsPayload {
  const payload: BusinessSettingsPayload = {};
  for (const [formField, settingsField] of Object.entries(LEGAL_FIELDS) as [keyof typeof LEGAL_FIELDS, LegalSettingsField][]) {
    const value = clean(values[formField]);
    if (value !== clean(loaded[formField])) payload[settingsField] = value || null;
  }
  const country = clean(values.countryCode);
  if (country && (country !== clean(loaded.countryCode) || Object.keys(payload).length > 0)) payload.country = country;
  const timezone = clean(values.timezone);
  if (timezone && timezone !== clean(loaded.timezone)) payload.timezone = timezone;
  return payload;
}
