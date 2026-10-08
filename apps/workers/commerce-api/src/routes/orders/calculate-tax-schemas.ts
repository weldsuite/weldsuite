/**
 * Request bodies of the order sales tax endpoints (`POST /calculate-tax` and
 * `POST /:id/calculate-tax`). Kept next to the routes until a checkout client
 * needs them in `@weldsuite/core-api-client`.
 */

import { z } from 'zod';

const optionalText = (max: number) => z.string().max(max).nullish();

/** An address in the shape orders and parties store (the legacy `street`/`province` spellings are read too). */
export const taxAddressSchema = z
  .object({
    line1: optionalText(255),
    line2: optionalText(255),
    street: optionalText(255),
    houseNumber: optionalText(30),
    city: optionalText(120),
    state: optionalText(100),
    province: optionalText(100),
    postalCode: optionalText(20),
    country: optionalText(100),
    county: optionalText(120),
  })
  .strip();

export const taxUseSchema = z.enum(['business', 'personal']);

const isoDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const taxLineSchema = z.object({
  lineId: z.string().min(1).max(60),
  productId: z.string().max(30).nullish(),
  /** Line amount net of seller discounts (quantity × price − discount). */
  amount: z.number().min(0),
  quantity: z.number().positive().default(1),
  /** A WeldBooks tax code (`general`, `saas`, ...); else the product's `taxClass`, else `general`. */
  taxCode: z.string().max(50).nullish(),
  taxIncluded: z.boolean().optional(),
});

/** `POST /api/orders/calculate-tax`: a cart or draft that is not stored. */
export const calculateCartTaxSchema = z.object({
  lines: z.array(taxLineSchema).max(500),
  shippingAmount: z.number().min(0).optional(),
  shipTo: taxAddressSchema.nullish(),
  billTo: taxAddressSchema.nullish(),
  customerPartyId: z.string().max(30).nullish(),
  customerUse: taxUseSchema.optional(),
  date: isoDaySchema.optional(),
  currency: z.string().length(3).default('USD'),
  marketplaceFacilitated: z.boolean().optional(),
});

/** `POST /api/orders/:id/calculate-tax`: recalculate a stored order, and with `apply` write the result. */
export const calculateOrderTaxSchema = z.object({
  apply: z.boolean().optional(),
  date: isoDaySchema.optional(),
  customerUse: taxUseSchema.optional(),
  marketplaceFacilitated: z.boolean().optional(),
});

export type CalculateCartTaxInput = z.infer<typeof calculateCartTaxSchema>;
export type CalculateOrderTaxInput = z.infer<typeof calculateOrderTaxSchema>;
