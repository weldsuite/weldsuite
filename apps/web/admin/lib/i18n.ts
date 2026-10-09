import { getTranslations } from '@weldsuite/i18n';

export function adminPricingCopy() {
  return getTranslations('host').adminPricing;
}

export function adminPhonePricingCopy() {
  return getTranslations('host').adminPhonePricing;
}

export function adminMeetAiPricingCopy() {
  return getTranslations('host').adminMeetAiPricing;
}

/** Billing, plan catalog and activity log copy. */
export function adminCopy() {
  return getTranslations('admin');
}

export type AdminCopy = ReturnType<typeof adminCopy>;

export function fill(template: string, vars: Record<string, string | number>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)),
    template,
  );
}
