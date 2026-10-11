/** "Paid on …" / "Due …" line for a statement; empty when neither date is known. */
export function statementPaymentNote(
  statement: { paidAt?: string | null; dueAt?: string | null },
  copy: { paidOn: string; dueDate: string },
  format: (template: string, values: { date: string }) => string,
  formatDate: (iso: string | null | undefined) => string,
): string {
  if (statement.paidAt) return format(copy.paidOn, { date: formatDate(statement.paidAt) });
  if (statement.dueAt) return format(copy.dueDate, { date: formatDate(statement.dueAt) });
  return '';
}
