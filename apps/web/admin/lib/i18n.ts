import { getTranslations } from '@weldsuite/i18n';

export function adminPricingCopy() {
  return getTranslations('host').adminPricing;
}

export function fill(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)),
    template,
  );
}
