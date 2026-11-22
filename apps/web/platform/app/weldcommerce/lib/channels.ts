/**
 * Sales channels in the UI: labels and tones, the EU countries a channel can
 * sell in, and the forms' values and validation (a channel, a storefront key's
 * origins, a shipping rate) with the conversion to the API's bodies.
 */

import { z } from 'zod';
import type { SoftTone } from '@weldsuite/ui/components/soft-badge';
import type {
  ChannelAudience,
  ChannelInput,
  ChannelKey,
  ChannelKeyKind,
  ChannelPaymentMethod,
  ChannelStatus,
  ChannelType,
  CommerceChannel,
  ShippingRate,
  ShippingRateInput,
} from '@/hooks/queries/use-commerce-channels-queries';
import { getLocale, getTranslations } from '@/lib/i18n';
import { MONEY_PATTERN } from './order-form';

/** The channel types staff create by hand; Shopify and WooCommerce channels come from a connection. */
export const CREATABLE_CHANNEL_TYPES: readonly ChannelType[] = ['storefront', 'manual'];
export const CHANNEL_AUDIENCES: readonly ChannelAudience[] = ['b2c', 'b2b'];
export const CHANNEL_FORM_STATUSES: readonly ChannelStatus[] = ['draft', 'active'];
export const CHANNEL_PAYMENT_METHODS: readonly ChannelPaymentMethod[] = ['mollie', 'invoice'];

/** The EU member states (ISO 3166-1 alpha-2): the countries a channel can sell in for now. */
export const EU_MEMBER_STATES: readonly string[] = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
];

/** A country's name in the UI language; the code itself when the browser doesn't know it. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames([getLocale()], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface CountryOption {
  value: string;
  label: string;
}

/** Countries as options for a multi-select, sorted by their name in the UI language. */
export function countryOptions(codes: readonly string[] = EU_MEMBER_STATES): CountryOption[] {
  const collator = new Intl.Collator(getLocale());
  return codes.map((value) => ({ value, label: countryName(value) })).sort((a, b) => collator.compare(a.label, b.label));
}

/** Country codes as one line of names: "Belgium, Netherlands". */
export function countryNames(codes: readonly string[]): string {
  return codes.map(countryName).join(', ');
}

// ---------------------------------------------------------------------------
// Labels and tones
// ---------------------------------------------------------------------------

const STATUS_TONES: Record<ChannelStatus, SoftTone> = {
  draft: 'neutral',
  active: 'success',
  archived: 'neutral',
};

export function channelStatusTone(status: ChannelStatus): SoftTone {
  return STATUS_TONES[status] ?? 'neutral';
}

function label(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value.replace(/_/g, ' ');
}

export function channelStatusLabel(status: ChannelStatus): string {
  return label(getTranslations('commerce').channels.status, status);
}

export function channelTypeLabel(type: ChannelType): string {
  return label(getTranslations('commerce').channels.type, type);
}

export function channelAudienceLabel(audience: ChannelAudience): string {
  return label(getTranslations('commerce').channels.audience, audience);
}

export function paymentMethodLabel(method: ChannelPaymentMethod): string {
  return label(getTranslations('commerce').channels.paymentMethod, method);
}

/** What the 409 `CHANNEL_INCOMPLETE` lists as missing, in words; a key this version doesn't know, as sent. */
export function missingLabel(field: string): string {
  return label(getTranslations('commerce').channels.missing, field);
}

/** The `details.missing` of a `CHANNEL_INCOMPLETE` refusal as labels. */
export function missingFields(details: Record<string, unknown> | undefined): string[] {
  const missing = details?.missing;
  return Array.isArray(missing) ? missing.filter((item): item is string => typeof item === 'string').map(missingLabel) : [];
}

// ---------------------------------------------------------------------------
// Channel form
// ---------------------------------------------------------------------------

export interface ChannelFormValues {
  name: string;
  type: ChannelType;
  audience: ChannelAudience;
  status: ChannelStatus;
  currency: string;
  pricesIncludeTax: boolean;
  sellingCountries: string[];
  guestCheckout: boolean;
  paymentMethods: ChannelPaymentMethod[];
}

/** A B2C channel shows prices with VAT in them, a B2B channel without. */
export function defaultPricesIncludeTax(audience: ChannelAudience): boolean {
  return audience === 'b2c';
}

export function emptyChannelValues(currency: string): ChannelFormValues {
  return {
    name: '',
    type: 'storefront',
    audience: 'b2c',
    status: 'draft',
    currency,
    pricesIncludeTax: defaultPricesIncludeTax('b2c'),
    sellingCountries: [],
    guestCheckout: true,
    paymentMethods: ['mollie'],
  };
}

export function valuesFromChannel(channel: CommerceChannel): ChannelFormValues {
  return {
    name: channel.name,
    type: channel.type,
    audience: channel.audience,
    status: channel.status,
    currency: channel.currency,
    pricesIncludeTax: channel.pricesIncludeTax,
    sellingCountries: channel.sellingCountries,
    guestCheckout: channel.guestCheckout,
    paymentMethods: channel.paymentMethods,
  };
}

export function buildChannelFormSchema() {
  const t = getTranslations('commerce').channels.form;
  return z.object({
    name: z.string().trim().min(1, t.nameRequired).max(255),
    type: z.enum(['storefront', 'manual', 'shopify', 'woocommerce']),
    audience: z.enum(['b2c', 'b2b']),
    status: z.enum(['draft', 'active', 'archived']),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/, t.currencyInvalid),
    pricesIncludeTax: z.boolean(),
    sellingCountries: z.array(z.string()),
    guestCheckout: z.boolean(),
    paymentMethods: z.array(z.enum(['mollie', 'invoice'])),
  });
}

/** Only a storefront sells to shoppers, so only it has countries, guest checkout and payment methods. */
export function isStorefront(type: ChannelType): boolean {
  return type === 'storefront';
}

/** Connector channels (Shopify, WooCommerce) keep their name and status here; the rest comes from the shop. */
export function isConnectorChannel(type: ChannelType): boolean {
  return type === 'shopify' || type === 'woocommerce';
}

/**
 * The create or update body. A channel that isn't a storefront sends no
 * countries or payment methods, and an invoice is only offered to businesses.
 * A connector channel changes its name and status only.
 */
export function toChannelInput(values: ChannelFormValues, mode: 'create' | 'edit'): ChannelInput {
  const name = values.name.trim();
  if (isConnectorChannel(values.type)) return { name, status: values.status };
  const storefront = isStorefront(values.type);
  const body: ChannelInput = {
    name,
    audience: values.audience,
    status: values.status,
    currency: values.currency.trim().toUpperCase(),
    pricesIncludeTax: values.pricesIncludeTax,
    sellingCountries: storefront ? values.sellingCountries : [],
    guestCheckout: storefront ? values.guestCheckout : false,
    paymentMethods: storefront ? values.paymentMethods.filter((m) => m !== 'invoice' || values.audience === 'b2b') : [],
  };
  if (mode === 'create') body.type = values.type;
  return body;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export const CHANNEL_KEY_KINDS: readonly ChannelKeyKind[] = ['publishable', 'private'];

export function keyKindLabel(kind: ChannelKeyKind): string {
  return label(getTranslations('commerce').channels.keys.kind, kind);
}

/** The origins typed in a box: one per line (commas and spaces work too), blanks and repeats dropped. */
export function parseOrigins(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\s,]+/)) {
    const origin = part.trim();
    if (origin) seen.add(origin);
  }
  return [...seen];
}

/** Exact origins only: a scheme, a host and maybe a port, with no path, query or trailing slash. */
export function isValidOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

export interface KeyFormValues {
  kind: ChannelKeyKind;
  name: string;
  /** One origin per line. */
  origins: string;
}

export function emptyKeyValues(): KeyFormValues {
  return { kind: 'publishable', name: '', origins: '' };
}

export function valuesFromKey(key: ChannelKey): KeyFormValues {
  return { kind: key.kind, name: key.name, origins: key.allowedOrigins.join('\n') };
}

/** The key form's schema: a name, and for a publishable key at least one valid origin. */
export function buildKeyFormSchema() {
  const t = getTranslations('commerce').channels.keys.form;
  return z
    .object({
      kind: z.enum(['publishable', 'private']),
      name: z.string().trim().min(1, t.nameRequired).max(255),
      origins: z.string(),
    })
    .superRefine((values, ctx) => {
      if (values.kind !== 'publishable') return;
      const origins = parseOrigins(values.origins);
      if (origins.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['origins'], message: t.originsRequired });
      } else if (!origins.every(isValidOrigin)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['origins'], message: t.originsInvalid });
      }
    });
}

// ---------------------------------------------------------------------------
// Shipping rates
// ---------------------------------------------------------------------------

export interface ShippingRateFormValues {
  zoneName: string;
  countries: string[];
  name: string;
  price: string;
  freeShippingThreshold: string;
  active: boolean;
}

export function emptyShippingRateValues(): ShippingRateFormValues {
  return { zoneName: '', countries: [], name: '', price: '', freeShippingThreshold: '', active: true };
}

export function valuesFromShippingRate(rate: ShippingRate): ShippingRateFormValues {
  return {
    zoneName: rate.zoneName,
    countries: rate.countries,
    name: rate.name,
    price: rate.price,
    freeShippingThreshold: rate.freeShippingThreshold ?? '',
    active: rate.active,
  };
}

export function buildShippingRateFormSchema() {
  const t = getTranslations('commerce').channels.shipping.form;
  return z.object({
    zoneName: z.string().trim().min(1, t.zoneRequired).max(255),
    countries: z.array(z.string()).min(1, t.countriesRequired),
    name: z.string().trim().min(1, t.nameRequired).max(255),
    price: z.string().trim().regex(MONEY_PATTERN, t.priceInvalid),
    freeShippingThreshold: z
      .string()
      .trim()
      .refine((value) => value === '' || MONEY_PATTERN.test(value), t.priceInvalid),
    active: z.boolean(),
  });
}

/** A decimal string with two decimals: "4.9" becomes "4.90". */
export function toMoneyString(value: string): string {
  return Number(value.trim()).toFixed(2);
}

export function toShippingRateInput(values: ShippingRateFormValues): ShippingRateInput {
  const threshold = values.freeShippingThreshold.trim();
  return {
    zoneName: values.zoneName.trim(),
    countries: values.countries,
    name: values.name.trim(),
    price: toMoneyString(values.price),
    freeShippingThreshold: threshold === '' ? null : toMoneyString(threshold),
    active: values.active,
  };
}

/** The ids of the rates after moving the one at `index` one place up (`-1`) or down (`1`); the same order at an edge. */
export function moveRate(ids: readonly string[], index: number, direction: -1 | 1): string[] {
  const target = index + direction;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
