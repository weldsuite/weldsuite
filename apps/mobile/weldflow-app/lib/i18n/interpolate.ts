/** Replace `{name}` placeholders. Unknown keys are left as-is. */
export function interpolate(template: string, values: Record<string, unknown> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return values[key] !== undefined ? String(values[key]) : match;
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
