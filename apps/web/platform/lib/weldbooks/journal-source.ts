/**
 * What a journal entry says about where it came from (`journal_entries.source_type`).
 *
 * The raw value is a code (`invoice`, `bank_reconciliation`, `payment_fx_adjustment`...), so screens
 * show its translated name from `t.accounting.statusLabels.journalEntrySource`; a code the
 * dictionary does not know yet is shown as plain words (underscores replaced), never as the code.
 */

/** The translated names, as `t.accounting.statusLabels.journalEntrySource`. */
export type JournalSourceLabels = Record<string, string>;

export function journalSourceLabel(
  sourceType: string | null | undefined,
  labels: JournalSourceLabels,
): string {
  const code = sourceType?.trim() || 'manual';
  return labels[code] ?? code.replaceAll('_', ' ');
}
