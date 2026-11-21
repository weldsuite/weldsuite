/**
 * The order form's values and how they turn into what the API takes: the
 * quote and create body (`OrderInput`) and the edit body (`OrderPatch`).
 * Pure functions, so the form components stay about layout.
 */

import { z } from 'zod';
import type {
  Order,
  OrderAddress,
  OrderInput,
  OrderInputItem,
  OrderPatch,
  OrderPatchItem,
} from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';

export interface AddressValues {
  name: string;
  company: string;
  line1: string;
  line2: string;
  postalCode: string;
  city: string;
  region: string;
  country: string;
  phone: string;
  email: string;
}

export interface LineValues {
  /** The id of the order item this line edits; none on a line added now. */
  itemId?: string;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  name: string;
  variantName: string | null;
  quantity: number;
  /** A decimal string; blank takes the catalogue price. */
  unitPrice: string;
}

export interface OrderFormValues {
  companyId: string | null;
  companyName: string;
  personId: string | null;
  personName: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  currency: string;
  items: LineValues[];
  discountCode: string;
  shippingTotal: string;
  billingAddress: AddressValues;
  shippingAddress: AddressValues;
  customerReference: string;
  customerNote: string;
  internalNote: string;
  status: 'pending' | 'confirmed';
}

export const ADDRESS_KEYS = [
  'name',
  'company',
  'line1',
  'line2',
  'postalCode',
  'city',
  'region',
  'country',
  'phone',
  'email',
] as const satisfies readonly (keyof AddressValues)[];

export const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

export function emptyAddress(): AddressValues {
  return { name: '', company: '', line1: '', line2: '', postalCode: '', city: '', region: '', country: '', phone: '', email: '' };
}

export function emptyOrderValues(currency: string): OrderFormValues {
  return {
    companyId: null,
    companyName: '',
    personId: null,
    personName: '',
    customerName: '',
    customerEmail: '',
    customerPhone: '',
    currency,
    items: [],
    discountCode: '',
    shippingTotal: '',
    billingAddress: emptyAddress(),
    shippingAddress: emptyAddress(),
    customerReference: '',
    customerNote: '',
    internalNote: '',
    status: 'confirmed',
  };
}

function addressValues(address: OrderAddress | null): AddressValues {
  const values = emptyAddress();
  if (!address) return values;
  for (const key of ADDRESS_KEYS) values[key] = address[key] ?? '';
  return values;
}

/** The form's starting point for editing `order`. */
export function valuesFromOrder(order: Order): OrderFormValues {
  return {
    companyId: order.companyId,
    companyName: order.companyName ?? '',
    personId: order.personId,
    personName: '',
    customerName: order.customerName ?? '',
    customerEmail: order.customerEmail ?? '',
    customerPhone: order.customerPhone ?? '',
    currency: order.currency,
    items: order.items.map((item) => ({
      itemId: item.id,
      productId: item.productId,
      variantId: item.variantId,
      sku: item.sku,
      name: item.name,
      variantName: item.variantName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
    discountCode: order.discountCode ?? '',
    shippingTotal: order.shippingTotal,
    billingAddress: addressValues(order.billingAddress),
    shippingAddress: addressValues(order.shippingAddress),
    customerReference: order.customerReference ?? '',
    customerNote: order.customerNote ?? '',
    internalNote: order.internalNote ?? '',
    status: 'confirmed',
  };
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The address the API stores: blank fields dropped, and nothing at all when every field is blank. */
export function cleanAddress(values: AddressValues): OrderAddress | null {
  const address: OrderAddress = {};
  for (const key of ADDRESS_KEYS) {
    const value = blankToNull(values[key]);
    if (value === null) continue;
    address[key] = key === 'country' ? value.toUpperCase() : value;
  }
  return Object.keys(address).length === 0 ? null : address;
}

/** A line with nothing in the catalogue behind it: a name and a price typed in. */
export function isFreeLine(line: LineValues): boolean {
  return line.productId === null && line.variantId === null;
}

/** Whether the server can price this line yet. */
export function lineIsComplete(line: LineValues): boolean {
  if (!Number.isInteger(line.quantity) || line.quantity < 1) return false;
  if (!isFreeLine(line)) return line.unitPrice.trim() === '' || MONEY_PATTERN.test(line.unitPrice.trim());
  return line.name.trim() !== '' && MONEY_PATTERN.test(line.unitPrice.trim());
}

function toInputItem(line: LineValues): OrderInputItem {
  const unitPrice = blankToNull(line.unitPrice);
  if (isFreeLine(line)) return { name: line.name.trim(), quantity: line.quantity, unitPrice };
  const item: OrderInputItem = { quantity: line.quantity, unitPrice };
  if (line.variantId) item.variantId = line.variantId;
  else item.productId = line.productId;
  return item;
}

function toPatchItem(line: LineValues): OrderPatchItem {
  return line.itemId ? { id: line.itemId, ...toInputItem(line) } : toInputItem(line);
}

/** The body of `POST /orders` (and of the quote, which takes the same). */
export function toOrderInput(values: OrderFormValues): OrderInput {
  return {
    companyId: values.companyId,
    personId: values.personId,
    customerName: blankToNull(values.customerName),
    customerEmail: blankToNull(values.customerEmail),
    customerPhone: blankToNull(values.customerPhone),
    currency: values.currency.trim().toUpperCase(),
    items: values.items.map(toInputItem),
    discountCode: blankToNull(values.discountCode),
    shippingTotal: blankToNull(values.shippingTotal),
    billingAddress: cleanAddress(values.billingAddress),
    shippingAddress: cleanAddress(values.shippingAddress),
    customerReference: blankToNull(values.customerReference),
    customerNote: blankToNull(values.customerNote),
    internalNote: blankToNull(values.internalNote),
    status: values.status,
  };
}

export interface QuoteRequest {
  input: OrderInput;
  /** For each line of the quote, the index of the form line it prices. */
  lineIndexes: number[];
}

/**
 * What to ask `POST /orders/quote`, or null while there is nothing to price
 * (no currency yet, or no line the server can price). Lines still being
 * typed are left out, so a half-written free line doesn't blank the totals.
 */
export function toQuoteRequest(values: OrderFormValues): QuoteRequest | null {
  const currency = values.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const lineIndexes: number[] = [];
  const items: OrderInputItem[] = [];
  values.items.forEach((line, index) => {
    if (!lineIsComplete(line)) return;
    lineIndexes.push(index);
    items.push(toInputItem(line));
  });
  if (items.length === 0) return null;
  const shipping = blankToNull(values.shippingTotal);
  return {
    input: {
      companyId: values.companyId,
      personId: values.personId,
      currency,
      items,
      discountCode: blankToNull(values.discountCode),
      shippingTotal: shipping !== null && MONEY_PATTERN.test(shipping) ? shipping : null,
    },
    lineIndexes,
  };
}

/**
 * The body of `PATCH /orders/:id`. Addresses, reference and notes can always
 * change; the customer, items, shipping and code only while the order is
 * editable, and the API refuses them otherwise.
 */
export function toOrderPatch(values: OrderFormValues, order: Order): OrderPatch {
  const patch: OrderPatch = {
    billingAddress: cleanAddress(values.billingAddress),
    shippingAddress: cleanAddress(values.shippingAddress),
    customerReference: blankToNull(values.customerReference),
    customerNote: blankToNull(values.customerNote),
    internalNote: blankToNull(values.internalNote),
  };
  if (!order.editable) return patch;
  return {
    ...patch,
    companyId: values.companyId,
    personId: values.personId,
    customerName: blankToNull(values.customerName),
    customerEmail: blankToNull(values.customerEmail),
    customerPhone: blankToNull(values.customerPhone),
    shippingTotal: blankToNull(values.shippingTotal),
    discountCode: blankToNull(values.discountCode),
    items: values.items.map(toPatchItem),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const optionalMoney = (message: string) =>
  z.string().refine((value) => value.trim() === '' || MONEY_PATTERN.test(value.trim()), message);

function buildAddressSchema() {
  const t = getTranslations('commerce').orders.form;
  return z.object({
  name: z.string().max(255),
  company: z.string().max(255),
  line1: z.string().max(255),
  line2: z.string().max(255),
  postalCode: z.string().max(32),
  city: z.string().max(255),
  region: z.string().max(255),
  country: z
    .string()
    .refine((value) => value.trim() === '' || /^[A-Za-z]{2}$/.test(value.trim()), t.invalidCountry),
  phone: z.string().max(64),
  email: z
    .string()
    .max(255)
    .refine((value) => value.trim() === '' || z.string().email().safeParse(value.trim()).success, t.invalidEmail),
  });
}

/** The form's schema, with its own messages in the UI language. */
export function buildOrderFormSchema() {
  const t = getTranslations('commerce').orders.form;
  const line = z
    .object({
      itemId: z.string().optional(),
      productId: z.string().nullable(),
      variantId: z.string().nullable(),
      sku: z.string().nullable(),
      name: z.string().max(500),
      variantName: z.string().nullable(),
      quantity: z.number().int().min(1).max(100000),
      unitPrice: optionalMoney(t.invalidAmount),
    })
    .superRefine((value, ctx) => {
      if (value.productId !== null || value.variantId !== null) return;
      if (value.name.trim() === '') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['name'], message: t.lineNameRequired });
      if (value.unitPrice.trim() === '') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['unitPrice'], message: t.linePriceRequired });
    });

  const address = buildAddressSchema();
  return z.object({
    companyId: z.string().nullable(),
    companyName: z.string(),
    personId: z.string().nullable(),
    personName: z.string(),
    customerName: z.string().max(255),
    customerEmail: z
      .string()
      .max(255)
      .refine((value) => value.trim() === '' || z.string().email().safeParse(value.trim()).success, t.invalidEmail),
    customerPhone: z.string().max(64),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/, t.invalidCurrency),
    items: z.array(line).min(1, t.itemsRequired).max(500),
    discountCode: z.string().max(64),
    shippingTotal: optionalMoney(t.invalidAmount),
    billingAddress: address,
    shippingAddress: address,
    customerReference: z.string().max(255),
    customerNote: z.string().max(5000),
    internalNote: z.string().max(5000),
    status: z.enum(['pending', 'confirmed']),
  });
}
