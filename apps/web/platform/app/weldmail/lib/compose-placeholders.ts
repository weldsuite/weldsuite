// `{{token}}`, the form the compose "Insert variable" button writes.
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * The `{{placeholder}}`s left in a mail about to be sent, each once, in the
 * order they appear. Nothing fills them in when a mail is sent, so the
 * recipient would read them exactly as written.
 */
export function unfilledPlaceholders(...parts: ReadonlyArray<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const part of parts) {
    for (const match of (part ?? '').matchAll(PLACEHOLDER)) found.add(`{{${match[1]}}}`);
  }
  return [...found];
}
