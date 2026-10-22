/** Replace `{name}` placeholders. Unknown keys are left as-is. */
import { asText } from '@weldsuite/text';
export function interpolate(template: string, values: Record<string, unknown> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return values[key] !== undefined ? asText(values[key]) : match;
  });
}

export function plural(
  count: number,
  forms: { one: string; other: string },
  values: Record<string, unknown> = {},
): string {
  const template = count === 1 ? forms.one : forms.other;
  return interpolate(template, { count, ...values });
}
