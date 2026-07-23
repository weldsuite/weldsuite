import { z } from 'zod';

// ============================================================================
// Accounting Settings — workspace-wide singleton config row.
//
// Entity-specific identity (company details, tax IDs, numbering, branding,
// jurisdiction filing credentials) lives on the `accounting_entities` table.
// This row only tracks workspace-level defaults and shared inputs.
//
// Backed by the `settings` table (packages/db/src/schema/accounting-settings).
// Permission prefix: `accounts:*`.
// ============================================================================

export const updateAccountingSettingsSchema = z.object({
  defaultEntityId: z.string().max(30).nullish(),
  fiscalYearStart: z.number().int().min(1).max(12).optional(),
  accountingMethod: z.enum(['accrual', 'cash']).optional(),
  defaultPaymentTermsDays: z.number().int().min(0).optional(),
  emailSettings: z
    .object({
      inboxAddress: z.string().optional(),
      autoScanEnabled: z.boolean().optional(),
      autoCreateDraftBills: z.boolean().optional(),
    })
    .optional(),
});

export const registerInboxSchema = z.object({
  email: z.string().email(),
});

export type UpdateAccountingSettingsInput = z.infer<typeof updateAccountingSettingsSchema>;
export type RegisterInboxInput = z.infer<typeof registerInboxSchema>;
