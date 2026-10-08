/**
 * Request schemas of /api/fixed-assets. Amounts are numbers or numeric
 * strings (a form posts either); dates are `YYYY-MM-DD`.
 */

import { z } from 'zod';
import { CONVENTIONS, DEPRECIATION_METHODS } from '../../services/fixed-assets/books';

export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** A number, or a string that is one. */
export const amount = z
  .union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/, 'Not a number')])
  .transform((value) => Number(value))
  .refine((value) => Number.isFinite(value), 'Not a number');

const percent = amount.refine((value) => value >= 0 && value <= 100, 'Use 0 to 100');
const optionalId = z.string().trim().min(1).max(30).nullish();

export const bookSchema = z.object({
  book: z.enum(['book', 'federal', 'state']),
  stateCode: z.string().trim().length(2).nullish(),
  method: z.enum(DEPRECIATION_METHODS),
  convention: z.enum(CONVENTIONS).optional(),
  recoveryYears: amount.refine((value) => value >= 0 && value <= 100, 'Use 0 to 100'),
  section179Amount: amount.refine((value) => value >= 0, 'Cannot be negative').optional(),
  bonusPercent: percent.optional(),
  postsToLedger: z.boolean().optional(),
});

const assetFields = {
  name: z.string().trim().min(1).max(255),
  assetNumber: z.string().trim().min(1).max(50).nullish(),
  description: z.string().max(5000).nullish(),
  assetClass: z.string().trim().min(1).max(20).nullish(),
  assetAccountId: optionalId,
  accumulatedDepreciationAccountId: optionalId,
  depreciationExpenseAccountId: optionalId,
  acquisitionDate: dateString,
  placedInServiceDate: dateString.optional(),
  cost: amount,
  salvageValue: amount.optional(),
  businessUsePercent: percent.optional(),
  listedProperty: z.boolean().optional(),
  billId: optionalId,
  billItemId: optionalId,
  classId: optionalId,
  locationId: optionalId,
  notes: z.string().max(5000).nullish(),
  usefulLifeYears: amount.refine((value) => value > 0 && value <= 100, 'Use more than 0 and at most 100').optional(),
  section179Amount: amount.refine((value) => value >= 0, 'Cannot be negative').optional(),
  bonusPercent: percent.optional(),
  bonusReducedElection: z.boolean().optional(),
  books: z.array(bookSchema).max(12).optional(),
};

export const createAssetSchema = z.object(assetFields);

export const updateAssetSchema = z
  .object({
    name: assetFields.name,
    assetNumber: assetFields.assetNumber,
    description: assetFields.description,
    assetClass: assetFields.assetClass,
    assetAccountId: z.string().trim().min(1).max(30),
    accumulatedDepreciationAccountId: z.string().trim().min(1).max(30),
    depreciationExpenseAccountId: z.string().trim().min(1).max(30),
    acquisitionDate: dateString,
    placedInServiceDate: dateString,
    cost: amount,
    salvageValue: amount,
    businessUsePercent: percent,
    listedProperty: z.boolean(),
    classId: optionalId,
    locationId: optionalId,
    notes: assetFields.notes,
    books: z.array(bookSchema).max(12),
  })
  .partial();

export const fromBillLineSchema = z.object({
  billItemId: z.string().trim().min(1).max(30),
  name: assetFields.name.optional(),
  assetNumber: assetFields.assetNumber,
  description: assetFields.description,
  assetClass: assetFields.assetClass,
  assetAccountId: assetFields.assetAccountId,
  accumulatedDepreciationAccountId: assetFields.accumulatedDepreciationAccountId,
  depreciationExpenseAccountId: assetFields.depreciationExpenseAccountId,
  acquisitionDate: dateString.optional(),
  placedInServiceDate: dateString.optional(),
  /** Overrides the cost taken from the bill line. */
  cost: amount.optional(),
  salvageValue: assetFields.salvageValue,
  businessUsePercent: assetFields.businessUsePercent,
  listedProperty: assetFields.listedProperty,
  classId: assetFields.classId,
  locationId: assetFields.locationId,
  notes: assetFields.notes,
  usefulLifeYears: assetFields.usefulLifeYears,
  section179Amount: assetFields.section179Amount,
  bonusPercent: assetFields.bonusPercent,
  bonusReducedElection: assetFields.bonusReducedElection,
  books: assetFields.books,
  /** The line went to an expense account: post the reclass entry that moves its cost to the asset account. */
  reclass: z.boolean().optional(),
});

export const disposeSchema = z.object({
  date: dateString,
  proceeds: amount.refine((value) => value >= 0, 'Cannot be negative').default(0),
  depositAccountId: optionalId,
  gainLossAccountId: optionalId,
});

export const runSchema = z.object({ through: dateString });

export const deMinimisSchema = z.object({
  amount: amount.refine((value) => value >= 0, 'Cannot be negative'),
  hasAfs: z.boolean().default(false),
  date: dateString.optional(),
});
