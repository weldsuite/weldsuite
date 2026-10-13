/**
 * India GST: where a supply is made (place of supply) and so whether the tax
 * is CGST + SGST (intra-state) or IGST (inter-state).
 *
 * The tax calculation (services/accounting-tax-resolve) splits a GST slab by
 * comparing the supplier's state with the place-of-supply state. This module
 * works out the buyer's side of that comparison for a document, in order:
 *
 *   1. the place of supply the user chose on the invoice
 *   2. the state in the buyer's GSTIN (first two digits)
 *   3. the state of the shipping address, else the billing address
 *
 * Nothing is guessed beyond that: with no state the calculation fails closed
 * (the slab rate, no CGST/SGST/IGST split) and finalizing refuses until a
 * place of supply is set. A buyer outside India is an export (zero-rated) and
 * gets the foreign-country code (96).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import { getContactVatNumber } from '@weldsuite/books-domain/accounting-compliance';
import {
  extractStateCodeFromGstin,
  GST_FOREIGN_COUNTRY_CODE,
  gstStateCodeFromText,
  isValidGstStateCode,
} from '@weldsuite/books-domain/jurisdictions/in';

type Address = Parameters<typeof normalizePostalAddress>[0];

export interface GstSupply {
  /** Two-digit GST state code (or 96 for a supply outside India) the invoice is stored with; null when unknown. */
  placeOfSupply: string | null;
  /** The state the tax calculation compares with the supplier's. */
  buyerStateCode?: string;
  /** `IN` for a domestic buyer, the buyer's country (an export) otherwise; undefined when no address says. */
  buyerCountry?: string;
  /** The counterparty's GSTIN as it is on its company record now. */
  buyerGstin: string | null;
}

/** True for an entity whose jurisdiction is India. */
export async function isGstEntity(db: Database, entityId: string): Promise<boolean> {
  const [entity] = await db
    .select({ jurisdictionCode: schema.entities.jurisdictionCode })
    .from(schema.entities)
    .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
    .limit(1);
  return entity?.jurisdictionCode?.toUpperCase() === 'IN';
}

function countryOf(address: Address): string | undefined {
  const raw = normalizePostalAddress(address)?.country;
  if (!raw) return undefined;
  const upper = raw.trim().toUpperCase();
  return upper === 'IN' || upper === 'IND' || upper === 'INDIA' ? 'IN' : upper;
}

/** A user-entered place of supply: a valid two-digit state code, or 96. Anything else is ignored. */
function explicitPlaceOfSupply(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === GST_FOREIGN_COUNTRY_CODE) return trimmed;
  return isValidGstStateCode(trimmed) ? trimmed : undefined;
}

/** State code a GSTIN starts with, when it is a real one. */
function stateOfGstin(gstin: string | null | undefined): string | undefined {
  if (!gstin) return undefined;
  const code = extractStateCodeFromGstin(gstin);
  return isValidGstStateCode(code) ? code : undefined;
}

/**
 * Place of supply of an invoice or credit note. Null for an entity outside
 * India (no GST split applies).
 */
export async function resolveGstSupply(
  db: Database,
  args: {
    entityId: string;
    contactId: string | null | undefined;
    /** What the user chose (null/undefined: derive). */
    placeOfSupply?: string | null;
    shippingAddress?: Address;
    billingAddress?: Address;
  },
): Promise<GstSupply | null> {
  if (!(await isGstEntity(db, args.entityId))) return null;

  const buyerGstin = await getContactVatNumber(db, args.contactId);
  // An invoice created without addresses (an API client) falls back to the contact's own.
  let shippingAddress = args.shippingAddress;
  let billingAddress = args.billingAddress;
  if (!normalizePostalAddress(shippingAddress) && !normalizePostalAddress(billingAddress) && args.contactId) {
    const [party] = await db
      .select({ billingAddress: schema.parties.billingAddress, shippingAddress: schema.parties.shippingAddress })
      .from(schema.parties)
      .where(eq(schema.parties.id, args.contactId))
      .limit(1);
    shippingAddress = party?.shippingAddress;
    billingAddress = party?.billingAddress;
  }
  const shippingCountry = countryOf(shippingAddress);
  const buyerCountry = shippingCountry ?? countryOf(billingAddress);
  const explicit = explicitPlaceOfSupply(args.placeOfSupply);

  // A buyer abroad is an export whatever else is on file; so is a user-chosen 96.
  const abroad = explicit === GST_FOREIGN_COUNTRY_CODE || (!explicit && Boolean(buyerCountry && buyerCountry !== 'IN'));
  if (abroad) {
    return {
      placeOfSupply: GST_FOREIGN_COUNTRY_CODE,
      buyerStateCode: GST_FOREIGN_COUNTRY_CODE,
      buyerCountry: buyerCountry && buyerCountry !== 'IN' ? buyerCountry : undefined,
      buyerGstin,
    };
  }

  const state =
    explicit ??
    stateOfGstin(buyerGstin) ??
    gstStateCodeFromText(normalizePostalAddress(shippingAddress)?.state) ??
    gstStateCodeFromText(normalizePostalAddress(billingAddress)?.state);

  return {
    placeOfSupply: state ?? null,
    buyerStateCode: state,
    buyerCountry: 'IN',
    buyerGstin,
  };
}

/**
 * The supplier-side state of a bill (the "buyer" the tax calculation compares
 * with the entity's own state): the supplier's GSTIN, else the vendor address
 * on the bill. Null for an entity outside India.
 */
export async function resolveGstBillSupply(
  db: Database,
  args: { entityId: string; contactId: string | null | undefined; vendorAddress?: Address },
): Promise<GstSupply | null> {
  if (!(await isGstEntity(db, args.entityId))) return null;
  const supplierGstin = await getContactVatNumber(db, args.contactId);
  const country = countryOf(args.vendorAddress);
  if (country && country !== 'IN') {
    // An import: IGST is paid at the border or self-assessed (reverse charge rate), never split here.
    return { placeOfSupply: null, buyerStateCode: undefined, buyerCountry: 'IN', buyerGstin: supplierGstin };
  }
  const state = stateOfGstin(supplierGstin) ?? gstStateCodeFromText(normalizePostalAddress(args.vendorAddress)?.state);
  return { placeOfSupply: null, buyerStateCode: state, buyerCountry: 'IN', buyerGstin: supplierGstin };
}
