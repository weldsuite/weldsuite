/** Pure text helpers of the payroll screens (no React, no API), kept apart so they can be tested on their own. */

/** Parses what a person types into a number field; accepts a decimal comma. Blank is `null`, unparsable is `NaN`. */
export function parseNumberInput(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return Number(trimmed.replace(',', '.'));
}

/** `snake_case` or `camelCase` → "Snake case", the last resort when a label is missing. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replaceAll(/[_.]/g, ' ')
    .replaceAll(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Fills an issue message. `[ ... {param} ... ]` marks an optional part that is
 * dropped when any param inside it is missing; remaining `{param}` are
 * replaced, and unknown ones are left as they are.
 */
export function fillIssueTemplate(template: string, params: Record<string, string>): string {
  const withOptionals = template.replaceAll(/\[([^\]]*)\]/g, (_match, part: string) => {
    const names = [...part.matchAll(/\{(\w+)\}/g)].map((found) => found[1]);
    return names.every((name) => name in params) ? part : '';
  });
  const filled = withOptionals.replaceAll(/\{(\w+)\}/g, (match, name: string) => (name in params ? params[name] : match));
  return filled.replaceAll(/\s+([.,;:])/g, '$1').trim();
}
