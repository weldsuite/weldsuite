/**
 * Request bodies of `POST /api/products` and `PATCH /api/products/:id`: the
 * shared product schema plus the sales tax fields WeldBooks invoices and the
 * order tax calculation read (`products.taxable`, `products.tax_class`).
 *
 * Kept next to the route because the shared schema is also served by
 * external-api and mcp-server, which have no business validating against the
 * books domain.
 *
 * `taxClass` is a WeldBooks tax code (`general`, `saas`, ...) or a provider
 * code for a product the short list does not describe: a Stripe Tax code
 * (`txcd_20030000`) or an Avalara AvaTax code (`P0000000`, `SW054000`,
 * `FR020100`). Anything else is refused here: the readers fall back to
 * `general` on an unknown word, which would silently tax a product the owner
 * meant to exempt.
 */

import { z } from 'zod';
import { createProductSchema as baseCreateProductSchema } from '@weldsuite/core-api-client/schemas/products';
import { isStripeTaxCode, isWeldTaxCode } from '@weldsuite/books-domain/jurisdictions/us/tax-codes';

/** Stricter than the domain's own Avalara test, so everything accepted here is read back as a code. */
const AVALARA_CODE_RE = /^[A-Z]{1,2}\d{6,7}$/;

/** True for a WeldBooks code, a Stripe `txcd_` code or an Avalara code. */
export function isAcceptedProductTaxClass(value: string): boolean {
  return isWeldTaxCode(value) || isStripeTaxCode(value) || AVALARA_CODE_RE.test(value);
}

/**
 * A product tax code. Absent stays absent (a PATCH leaves it alone); `null` or
 * blank clears it (the product falls back to `general`); anything else must be
 * an accepted code.
 */
export const productTaxClassSchema = z
  .string()
  .max(50)
  .nullish()
  .transform((value) => {
    if (value === undefined) return undefined;
    const trimmed = value === null ? '' : value.trim();
    return trimmed === '' ? null : trimmed;
  })
  .refine((value) => value == null || isAcceptedProductTaxClass(value), {
    message: 'Unknown tax code: use a WeldBooks code, a Stripe txcd_ code or an Avalara code',
  });

const taxFields = {
  taxable: z.boolean().optional(),
  taxClass: productTaxClassSchema,
};

export const createProductBodySchema = baseCreateProductSchema.extend(taxFields);
export const updateProductBodySchema = createProductBodySchema.partial();
