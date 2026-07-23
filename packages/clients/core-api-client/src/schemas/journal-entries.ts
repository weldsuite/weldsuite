import { z } from 'zod';

// `/api/journal-entries` — manual journal entries.

export const createJournalEntrySchema = z.object({
  reference: z.string().max(255).optional(),
  entryNumber: z.string().max(100).optional(),
  entityId: z.string().nullish(),
  description: z.string().optional(),
  date: z.string().optional(),
  status: z.string().max(30).optional(),
  totalDebit: z.union([z.string(), z.number()]).optional(),
  totalCredit: z.union([z.string(), z.number()]).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateJournalEntrySchema = createJournalEntrySchema.partial();

export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;
export type UpdateJournalEntryInput = z.infer<typeof updateJournalEntrySchema>;
