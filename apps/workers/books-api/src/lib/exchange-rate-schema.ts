import { z } from 'zod';

/**
 * An exchange rate a user types on a document or payment: foreign units per
 * base unit (1 EUR = 1.08 USD is 1.08), a number above zero, sent as a number
 * or a numeric string.
 */
export const exchangeRateSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => value !== '' && Number.isFinite(Number(value)) && Number(value) > 0, {
    message: 'The exchange rate must be a number above zero',
  });
