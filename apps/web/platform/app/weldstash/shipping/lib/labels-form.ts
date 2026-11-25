/**
 * The "Create labels" form: its values (every number is text while it is
 * typed), the Zod schema, the prefill from `GET /pick-lists/:id/shipping` and
 * the conversion to the `POST /pick-lists/:id/labels` body.
 */

import { z } from 'zod';
import {
  CUSTOMS_CONTENT_TYPES,
  type AddressInput,
  type CarrierProduct,
  type CreateLabelsInput,
  type CustomsContentType,
  type PickListShipping,
  type QuoteInput,
  type ServicePointChoice,
  type ShipmentOptions,
} from '@weldsuite/app-api-client/schemas/shipping';

export interface PieceValues {
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
}

export interface AddressValues {
  name: string;
  company: string;
  street: string;
  houseNumber: string;
  houseNumberSuffix: string;
  line2: string;
  postalCode: string;
  city: string;
  state: string;
  country: string;
  email: string;
  phone: string;
}

/** An address block with no rules, for an optional address such as a carrier's sender address. */
export const addressValuesSchema = z.object({
  name: z.string(),
  company: z.string(),
  street: z.string(),
  houseNumber: z.string(),
  houseNumberSuffix: z.string(),
  line2: z.string(),
  postalCode: z.string(),
  city: z.string(),
  state: z.string(),
  country: z.string(),
  email: z.string(),
  phone: z.string(),
});

export interface CustomsLineValues {
  description: string;
  quantity: string;
  /** In the invoice currency's major unit, such as `12.50`. */
  value: string;
  weightGrams: string;
  hsCode: string;
  originCountry: string;
}

export interface LabelsFormValues {
  carrierId: string;
  product: string;
  pieces: PieceValues[];
  signature: boolean;
  ageCheck: boolean;
  noNeighbour: boolean;
  eveningDelivery: boolean;
  saturdayDelivery: boolean;
  mailbox: boolean;
  /** Euros. */
  insuredValue: string;
  returnLabel: boolean;
  recipient: AddressValues;
  customs: {
    content: CustomsContentType;
    invoiceNumber: string;
    currency: string;
    lines: CustomsLineValues[];
  };
}

/** The boolean options a product can list, in the form's own field names. */
export const BOOLEAN_OPTION_KEYS = [
  'signature',
  'ageCheck',
  'noNeighbour',
  'eveningDelivery',
  'saturdayDelivery',
  'mailbox',
] as const satisfies ReadonlyArray<keyof LabelsFormValues & keyof ShipmentOptions>;

// ── Numbers ─────────────────────────────────────────────────────────────────

/** A decimal typed with a point or a comma, or null when it is not a number. */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function kgToGrams(text: string): number | null {
  const kg = parseDecimal(text);
  return kg === null ? null : Math.round(kg * 1000);
}

export function gramsToKg(grams: number): string {
  return String(Math.round(grams) / 1000);
}

export function toCents(text: string): number | null {
  const amount = parseDecimal(text);
  return amount === null ? null : Math.round(amount * 100);
}

export function centsToText(cents: number): string {
  return (cents / 100).toFixed(2);
}

// ── Schema ──────────────────────────────────────────────────────────────────

export interface LabelsFormMessages {
  required: string;
  invalidWeight: string;
  invalidNumber: string;
  invalidQuantity: string;
}

export interface LabelsSchemaOptions {
  customsRequired: boolean;
}

export function makeLabelsFormSchema(m: LabelsFormMessages, options: LabelsSchemaOptions) {
  const required = z.string().trim().min(1, m.required);
  const optionalNumber = z.string().refine((v) => v.trim() === '' || (parseDecimal(v) !== null && (parseDecimal(v) ?? 0) >= 0), m.invalidNumber);

  const piece = z.object({
    weightKg: z.string().refine((v) => (parseDecimal(v) ?? 0) > 0, m.invalidWeight),
    lengthCm: optionalNumber,
    widthCm: optionalNumber,
    heightCm: optionalNumber,
  });

  const recipient = z.object({
    name: required,
    company: z.string(),
    street: required,
    houseNumber: z.string(),
    houseNumberSuffix: z.string(),
    line2: z.string(),
    postalCode: required,
    city: required,
    state: z.string(),
    country: z.string().trim().length(2, m.required),
    email: z.string(),
    phone: z.string(),
  });

  const line = z.object({
    description: z.string(),
    quantity: z.string(),
    value: z.string(),
    weightGrams: z.string(),
    hsCode: z.string(),
    originCountry: z.string(),
  });

  return z
    .object({
      carrierId: required,
      product: required,
      pieces: z.array(piece).min(1),
      signature: z.boolean(),
      ageCheck: z.boolean(),
      noNeighbour: z.boolean(),
      eveningDelivery: z.boolean(),
      saturdayDelivery: z.boolean(),
      mailbox: z.boolean(),
      insuredValue: optionalNumber,
      returnLabel: z.boolean(),
      recipient,
      customs: z.object({
        content: z.enum(CUSTOMS_CONTENT_TYPES),
        invoiceNumber: z.string(),
        currency: z.string(),
        lines: z.array(line),
      }),
    })
    .superRefine((values, ctx) => {
      if (!options.customsRequired) return;
      const { customs } = values;
      if (customs.currency.trim().length !== 3) {
        ctx.addIssue({ code: 'custom', path: ['customs', 'currency'], message: m.required });
      }
      customs.lines.forEach((l, index) => {
        const at = (field: keyof CustomsLineValues, message: string) =>
          ctx.addIssue({ code: 'custom', path: ['customs', 'lines', index, field], message });
        if (!l.description.trim()) at('description', m.required);
        const quantity = parseDecimal(l.quantity);
        if (quantity === null || !Number.isInteger(quantity) || quantity < 1) at('quantity', m.invalidQuantity);
        const value = parseDecimal(l.value);
        if (value === null || value < 0) at('value', m.invalidNumber);
        const weight = parseDecimal(l.weightGrams);
        if (weight === null || weight < 0) at('weightGrams', m.invalidNumber);
        if (!l.originCountry.trim()) at('originCountry', m.required);
      });
      if (customs.lines.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['customs', 'lines'], message: m.required });
      }
    });
}

// ── Prefill ─────────────────────────────────────────────────────────────────

const text = (value: string | null | undefined) => value ?? '';

export function addressToValues(address: AddressInput | null | undefined): AddressValues {
  const a = address ?? {};
  return {
    name: text(a.name),
    company: text(a.company),
    street: text(a.street) || text(a.line1),
    houseNumber: text(a.houseNumber),
    houseNumberSuffix: text(a.houseNumberSuffix),
    line2: text(a.line2),
    postalCode: text(a.postalCode),
    city: text(a.city),
    state: text(a.state),
    country: text(a.country).toUpperCase(),
    email: text(a.email),
    phone: text(a.phone),
  };
}

export function emptyPiece(weightKg = ''): PieceValues {
  return { weightKg, lengthCm: '', widthCm: '', heightCm: '' };
}

export function emptyCustomsLine(originCountry = ''): CustomsLineValues {
  return { description: '', quantity: '1', value: '', weightGrams: '', hsCode: '', originCountry };
}

export function shippingToFormValues(shipping: PickListShipping): LabelsFormValues {
  return {
    carrierId: shipping.defaultCarrierId ?? '',
    product: '',
    pieces: [emptyPiece(shipping.suggestedWeightGrams ? gramsToKg(shipping.suggestedWeightGrams) : '')],
    signature: false,
    ageCheck: false,
    noNeighbour: false,
    eveningDelivery: false,
    saturdayDelivery: false,
    mailbox: false,
    insuredValue: '',
    returnLabel: false,
    recipient: addressToValues(shipping.recipient),
    customs: {
      content: shipping.customs.content,
      invoiceNumber: text(shipping.customs.invoiceNumber),
      currency: shipping.customs.currency || 'EUR',
      lines: shipping.customs.lines.map((l) => ({
        description: l.description,
        quantity: String(l.quantity),
        value: centsToText(l.valueCents),
        weightGrams: String(l.weightGrams),
        hsCode: text(l.hsCode),
        originCountry: text(l.originCountry),
      })),
    },
  };
}

// ── To the API ──────────────────────────────────────────────────────────────

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

export function valuesToAddress(values: AddressValues): AddressInput {
  const street = values.street.trim();
  const number = `${values.houseNumber.trim()}${values.houseNumberSuffix.trim()}`;
  return {
    name: orNull(values.name),
    company: orNull(values.company),
    street: orNull(values.street),
    houseNumber: orNull(values.houseNumber),
    houseNumberSuffix: orNull(values.houseNumberSuffix),
    line1: [street, number].filter(Boolean).join(' ') || null,
    line2: orNull(values.line2),
    postalCode: orNull(values.postalCode),
    city: orNull(values.city),
    state: orNull(values.state),
    country: orNull(values.country.toUpperCase()),
    email: orNull(values.email),
    phone: orNull(values.phone),
  };
}

function optionalNumber(value: string): number | undefined {
  const n = parseDecimal(value);
  return n !== null && n > 0 ? n : undefined;
}

/** The pieces the product allows: one unless it is a multi-collo product. */
export function piecesFor(values: LabelsFormValues, product: CarrierProduct | undefined) {
  const pieces = product && !product.multiCollo ? values.pieces.slice(0, 1) : values.pieces;
  return pieces.map((p) => ({
    weightGrams: kgToGrams(p.weightKg) ?? 0,
    lengthCm: optionalNumber(p.lengthCm),
    widthCm: optionalNumber(p.widthCm),
    heightCm: optionalNumber(p.heightCm),
  }));
}

export function buildShipmentOptions(values: LabelsFormValues, product: CarrierProduct | undefined): ShipmentOptions {
  const listed = new Set(product?.options ?? []);
  const options: ShipmentOptions = {};
  for (const key of BOOLEAN_OPTION_KEYS) {
    if (listed.has(key) && values[key]) options[key] = true;
  }
  const insured = toCents(values.insuredValue);
  if (listed.has('insurance') && insured !== null && insured > 0) options.insuredValueCents = insured;
  return options;
}

export interface BuildLabelsContext {
  product: CarrierProduct | undefined;
  servicePoint: ServicePointChoice | null;
  customsRequired: boolean;
}

export function buildLabelsInput(values: LabelsFormValues, ctx: BuildLabelsContext): CreateLabelsInput {
  const { product } = ctx;
  const input: CreateLabelsInput = {
    carrierId: values.carrierId,
    product: values.product,
    pieces: piecesFor(values, product),
    options: buildShipmentOptions(values, product),
    recipient: valuesToAddress(values.recipient),
  };
  if (product?.servicePoint && ctx.servicePoint) {
    input.servicePoint = {
      id: ctx.servicePoint.id,
      name: ctx.servicePoint.name,
      address: { ...ctx.servicePoint.address },
      networkId: ctx.servicePoint.networkId,
    };
  }
  if (values.returnLabel && supportsReturn(product)) input.returnLabel = true;
  if (ctx.customsRequired) {
    input.customs = {
      content: values.customs.content,
      invoiceNumber: orNull(values.customs.invoiceNumber),
      currency: values.customs.currency.trim().toUpperCase(),
      lines: values.customs.lines.map((l) => ({
        description: l.description.trim(),
        quantity: Math.round(parseDecimal(l.quantity) ?? 1),
        valueCents: toCents(l.value) ?? 0,
        weightGrams: Math.round(parseDecimal(l.weightGrams) ?? 0),
        hsCode: orNull(l.hsCode),
        originCountry: orNull(l.originCountry.toUpperCase()),
      })),
    };
  }
  return input;
}

export function supportsReturn(product: CarrierProduct | undefined): boolean {
  return !!product && (product.returns || product.options.includes('returnLabel'));
}

/** The quote request for the current values, or null while they are incomplete. */
export function buildQuoteInput(values: LabelsFormValues, product: CarrierProduct | undefined): QuoteInput | null {
  const country = values.recipient.country.trim().toUpperCase();
  if (!product || country.length !== 2) return null;
  const pieces = piecesFor(values, product).map((p) => ({ weightGrams: p.weightGrams }));
  if (pieces.some((p) => p.weightGrams < 1)) return null;
  return {
    product: product.code,
    toCountry: country,
    pieces,
    options: buildShipmentOptions(values, product),
    returnLabel: values.returnLabel && supportsReturn(product) ? true : undefined,
  };
}
