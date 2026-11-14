/**
 * The workspace business profile is the default legal entity
 * (weldsuite-documentation/plans/legal-entities.md, "Workspace business profile").
 *
 * During the transition `PUT /api/workspace-settings` writes the legal fields
 * through to the default entity and `GET` reads them back from it, so old
 * clients keep working. Pure functions over the tenant DB (no Hono context).
 *
 * Field mapping (settings column -> legal entity):
 *   legalName -> legal_name        tradingName -> dba
 *   contactFirstName/LastName -> contact.contactPerson
 *   email, phone, websiteUrl -> contact.email / phone / website
 *   addressLine1/2, city, state, postalCode -> address
 *   country -> address.country and jurisdiction_code (ISO-2 only)
 *   vatNumber -> primary `vat` registration
 *   registrationNumber -> primary `company_registration` registration
 *   logoUrl, primaryColor, accentColor -> branding
 */

import { normalizeCountryCode } from '@weldsuite/app-api-client/schemas/plan-country-pricing';
import type { UpdateWorkspaceSettingsInput } from '@weldsuite/app-api-client/schemas/workspace-settings';
import type {
  CreateLegalEntityInput,
  LegalEntityRegistrationType,
  UpdateLegalEntityInput,
} from '@weldsuite/app-api-client/schemas/legal-entities';
import { normalizeRegistrationNumber } from '@weldsuite/app-api-client/schemas/legal-entities';
import {
  LegalEntityError,
  createLegalEntity,
  createRegistration,
  deleteRegistration,
  getDefaultLegalEntityRow,
  getRegistration,
  listRegistrations,
  lockedCoreChange,
  updateLegalEntity,
  updateRegistration,
} from '@weldsuite/core-domain/legal-entities';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import type { StripeCustomerProfile } from './workspace-settings';

type EntityRow = typeof schema.legalEntities.$inferSelect;
type SettingsRow = typeof schema.workspaceSettings.$inferSelect;

/** Currency a new entity gets when the workspace has none: the country's own. */
const COUNTRY_CURRENCY: Record<string, string> = {
  NL: 'EUR', BE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', PT: 'EUR', IE: 'EUR', AT: 'EUR',
  FI: 'EUR', LU: 'EUR', GR: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', MT: 'EUR', CY: 'EUR',
  GB: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD', IN: 'INR', BR: 'BRL', CH: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK',
  PL: 'PLN', CZ: 'CZK',
};

const LEGAL_FIELDS = [
  'legalName', 'tradingName', 'contactFirstName', 'contactLastName', 'email', 'phone', 'addressLine1',
  'addressLine2', 'city', 'state', 'postalCode', 'country', 'vatNumber', 'registrationNumber', 'logoUrl',
  'websiteUrl', 'primaryColor', 'accentColor',
] as const;

/** True when the save touches a field that lives on the legal entity. */
export function touchesLegalFields(data: UpdateWorkspaceSettingsInput): boolean {
  return LEGAL_FIELDS.some((field) => (data as Record<string, unknown>)[field] !== undefined);
}

const blank = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** Core columns of an entity update from the fields a save carries (merged over what the entity holds). */
function entityPatch(data: UpdateWorkspaceSettingsInput, existing: EntityRow): UpdateLegalEntityInput {
  const patch: UpdateLegalEntityInput = {};
  if (data.legalName !== undefined) patch.legalName = blank(data.legalName) ?? null;
  if (data.tradingName !== undefined) patch.dba = blank(data.tradingName) ?? null;

  const has = (...keys: (keyof UpdateWorkspaceSettingsInput)[]) => keys.some((k) => data[k] !== undefined);

  if (has('addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country')) {
    const address = { ...(existing.address ?? {}) } as Record<string, string | undefined>;
    if (data.addressLine1 !== undefined) address.line1 = blank(data.addressLine1);
    if (data.addressLine2 !== undefined) address.line2 = blank(data.addressLine2);
    if (data.city !== undefined) address.city = blank(data.city);
    if (data.state !== undefined) address.state = blank(data.state);
    if (data.postalCode !== undefined) address.postalCode = blank(data.postalCode);
    if (data.country !== undefined) {
      const iso = normalizeCountryCode(data.country);
      address.country = iso ?? blank(data.country)?.slice(0, 2);
      if (iso) patch.jurisdictionCode = iso;
    }
    patch.address = Object.fromEntries(Object.entries(address).filter(([, v]) => v !== undefined));
  }

  if (has('email', 'phone', 'websiteUrl', 'contactFirstName', 'contactLastName')) {
    const contact = { ...(existing.contact ?? {}) } as Record<string, unknown>;
    if (data.email !== undefined) contact.email = blank(data.email);
    if (data.phone !== undefined) contact.phone = blank(data.phone);
    if (data.websiteUrl !== undefined) contact.website = blank(data.websiteUrl);
    if (has('contactFirstName', 'contactLastName')) {
      const person = { ...(existing.contact?.contactPerson ?? {}) };
      if (data.contactFirstName !== undefined) person.firstName = blank(data.contactFirstName);
      if (data.contactLastName !== undefined) person.lastName = blank(data.contactLastName);
      contact.contactPerson = person;
    }
    patch.contact = Object.fromEntries(
      Object.entries(contact).filter(([, v]) => v !== undefined),
    ) as UpdateLegalEntityInput['contact'];
  }

  if (has('logoUrl', 'primaryColor', 'accentColor')) {
    const branding = { ...(existing.branding ?? {}) } as Record<string, string | undefined>;
    if (data.logoUrl !== undefined) branding.logoUrl = blank(data.logoUrl);
    if (data.primaryColor !== undefined) branding.primaryColor = blank(data.primaryColor);
    if (data.accentColor !== undefined) branding.accentColor = blank(data.accentColor);
    patch.branding = Object.fromEntries(Object.entries(branding).filter(([, v]) => v !== undefined));
  }
  return patch;
}

/** Create the default entity from a saved settings row, or null when there is not enough to do so. */
function createInputFromSettings(row: SettingsRow, fallbackName: string | null): CreateLegalEntityInput | null {
  const country = normalizeCountryCode(row.country);
  if (!country) return null;
  const currency = /^[A-Za-z]{3}$/.test(row.currency?.trim() ?? '')
    ? row.currency!.trim().toUpperCase()
    : (COUNTRY_CURRENCY[country] ?? null);
  const name = blank(row.tradingName) ?? blank(row.legalName) ?? blank(fallbackName);
  if (!currency || !name) return null;
  const input: CreateLegalEntityInput = {
    name,
    legalName: blank(row.legalName) ?? null,
    dba: blank(row.tradingName) ?? null,
    jurisdictionCode: country,
    baseCurrency: currency,
    isDefault: true,
  };
  const address = Object.fromEntries(
    Object.entries({
      line1: blank(row.addressLine1),
      line2: blank(row.addressLine2),
      city: blank(row.city),
      state: blank(row.state),
      postalCode: blank(row.postalCode),
      country,
    }).filter(([, v]) => v !== undefined),
  );
  input.address = address;
  const person = { firstName: blank(row.contactFirstName), lastName: blank(row.contactLastName) };
  const contact = Object.fromEntries(
    Object.entries({
      email: blank(row.email),
      phone: blank(row.phone),
      website: blank(row.websiteUrl),
      contactPerson: person.firstName || person.lastName ? Object.fromEntries(Object.entries(person).filter(([, v]) => v)) : undefined,
    }).filter(([, v]) => v !== undefined),
  );
  if (Object.keys(contact).length > 0) input.contact = contact as CreateLegalEntityInput['contact'];
  const branding = Object.fromEntries(
    Object.entries({
      logoUrl: blank(row.logoUrl),
      primaryColor: blank(row.primaryColor),
      accentColor: blank(row.accentColor),
    }).filter(([, v]) => v !== undefined),
  );
  if (Object.keys(branding).length > 0) input.branding = branding;
  return input;
}

/** Write one primary registration: set, change or (empty value) remove it. Invalid formats are skipped, never thrown. */
async function writeRegistration(
  db: Database,
  entityId: string,
  type: LegalEntityRegistrationType,
  value: string | null | undefined,
): Promise<boolean> {
  if (value === undefined) return false;
  const existing = await getRegistration(db, entityId, type);
  const number = blank(value);
  try {
    if (!number) {
      if (!existing) return false;
      await deleteRegistration(db, entityId, existing.id);
      return true;
    }
    if (existing) {
      await updateRegistration(db, entityId, existing.id, { number, isPrimary: true });
    } else {
      await createRegistration(db, entityId, { type, number, isPrimary: true });
    }
    return true;
  } catch (err) {
    // The settings form accepts looser formats than the registration catalog; the legacy column keeps the value.
    if (err instanceof LegalEntityError) {
      console.warn(`[app-api/business-profile] ${type} registration not written: ${err.message}`);
      return false;
    }
    throw err;
  }
}

export interface WriteThroughResult {
  entity: EntityRow;
  /** True when the default entity was created by this save. */
  created: boolean;
}

/**
 * Why a settings save may not change the default entity's country (WeldBooks
 * has postings or WeldHR has pay runs for it), or null. Checked before the
 * save, so the member gets the same 409 as in Settings → Legal entities
 * instead of a save whose country silently does not stick.
 */
export async function lockedBusinessProfileChange(db: Database, data: UpdateWorkspaceSettingsInput): Promise<string | null> {
  if (data.country === undefined) return null;
  const iso = normalizeCountryCode(data.country);
  if (!iso) return null;
  const existing = await getDefaultLegalEntityRow(db);
  if (!existing || existing.jurisdictionCode.toUpperCase() === iso) return null;
  return lockedCoreChange(db, existing.id, { jurisdictionCode: true, baseCurrency: false, fiscalYear: false });
}

/**
 * Write a settings save through to the default legal entity. Updates it when
 * it exists; otherwise creates it when the country is an ISO-2 code (and a
 * currency and name can be found). Returns null when nothing was written.
 * `settings` is the row after the upsert; `fallbackName` resolves the workspace
 * name, asked only when an entity has to be created without a business name.
 */
export async function writeThroughToDefaultEntity(
  db: Database,
  data: UpdateWorkspaceSettingsInput,
  settings: SettingsRow,
  fallbackName: () => Promise<string | null>,
): Promise<WriteThroughResult | null> {
  if (!touchesLegalFields(data)) return null;
  const existing = await getDefaultLegalEntityRow(db);
  if (existing) {
    const patch = entityPatch(data, existing);
    const entity = Object.keys(patch).length > 0 ? await updateLegalEntity(db, existing.id, patch) : existing;
    const vat = await writeRegistration(db, existing.id, 'vat', data.vatNumber);
    const reg = await writeRegistration(db, existing.id, 'company_registration', data.registrationNumber);
    if (Object.keys(patch).length === 0 && !vat && !reg) return null;
    return { entity: vat || reg ? ((await getDefaultLegalEntityRow(db)) ?? entity) : entity, created: false };
  }

  const needsName = !blank(settings.tradingName) && !blank(settings.legalName);
  const input = createInputFromSettings(settings, needsName ? await fallbackName() : null);
  if (!input) return null;
  const entity = await createLegalEntity(db, input);
  await writeRegistration(db, entity.id, 'vat', settings.vatNumber);
  await writeRegistration(db, entity.id, 'company_registration', settings.registrationNumber);
  return { entity: (await getDefaultLegalEntityRow(db)) ?? entity, created: true };
}

/**
 * The settings row with the legal fields read from the default entity. The
 * entity wins; a field it leaves empty falls back to the row (a save writes
 * both, so a cleared field is empty in both).
 */
export async function overlayDefaultEntity(db: Database, row: SettingsRow): Promise<SettingsRow> {
  const entity = await getDefaultLegalEntityRow(db);
  if (!entity) return row;
  const registrations = await listRegistrations(db, entity.id);
  const primary = (type: LegalEntityRegistrationType) =>
    registrations.find((r) => r.type === type && r.isPrimary)?.number ?? registrations.find((r) => r.type === type)?.number;
  const pick = (fromEntity: string | null | undefined, fromRow: string | null): string | null => blank(fromEntity) ?? fromRow;
  // Registrations are stored normalised; keep the member's own spelling
  // (spaces, dots, case) while it is still the same number.
  const pickNumber = (type: LegalEntityRegistrationType, fromRow: string | null): string | null => {
    const fromEntity = blank(primary(type));
    if (fromEntity && fromRow && normalizeRegistrationNumber(type, fromRow) === normalizeRegistrationNumber(type, fromEntity)) {
      return fromRow;
    }
    return fromEntity ?? fromRow;
  };
  const address = entity.address ?? {};
  const contact = entity.contact ?? {};
  const branding = entity.branding ?? {};
  return {
    ...row,
    legalName: pick(entity.legalName, row.legalName),
    tradingName: pick(entity.dba, row.tradingName),
    contactFirstName: pick(contact.contactPerson?.firstName, row.contactFirstName),
    contactLastName: pick(contact.contactPerson?.lastName, row.contactLastName),
    email: pick(contact.email, row.email),
    phone: pick(contact.phone, row.phone),
    websiteUrl: pick(contact.website, row.websiteUrl),
    addressLine1: pick(address.line1, row.addressLine1),
    addressLine2: pick(address.line2, row.addressLine2),
    city: pick(address.city, row.city),
    state: pick(address.state, row.state),
    postalCode: pick(address.postalCode, row.postalCode),
    country: pick(address.country ?? entity.jurisdictionCode, row.country),
    vatNumber: pickNumber('vat', row.vatNumber),
    registrationNumber: pickNumber('company_registration', row.registrationNumber),
    logoUrl: pick(branding.logoUrl, row.logoUrl),
    primaryColor: pick(branding.primaryColor, row.primaryColor),
    accentColor: pick(branding.accentColor, row.accentColor),
  };
}

/** What the Stripe customer should show for the default entity. */
export function stripeProfileFromEntity(entity: EntityRow): StripeCustomerProfile {
  const address = entity.address ?? {};
  return {
    name: blank(entity.legalName) ?? blank(entity.dba) ?? blank(entity.name),
    email: blank(entity.contact?.email),
    address: {
      line1: blank(address.line1),
      line2: blank(address.line2),
      city: blank(address.city),
      state: blank(address.state),
      postalCode: blank(address.postalCode),
      country: blank(address.country) ?? blank(entity.jurisdictionCode),
    },
  };
}
