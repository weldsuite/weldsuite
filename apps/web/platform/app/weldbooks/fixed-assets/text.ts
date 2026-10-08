/** Fills the `{name}` placeholders of a translated string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

/** The message of a failed request (the API's own text), for showing next to the action that failed. */
export function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}
