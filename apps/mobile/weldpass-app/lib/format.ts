/** "24 Nov, 14:05": when something last happened, in the app's language. */
export function formatWhen(iso: string | null | undefined, intlLocale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(intlLocale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
