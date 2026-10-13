import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import {
  appAccessStatusSchema,
  listSourceSchema,
  reachDomainIneligibleReasonSchema,
  reachDomainStatusSchema,
  reachMailboxStatusSchema,
  reachMailboxTypeSchema,
  reachSuppressionReasonSchema,
  WELDREACH_TERMS,
} from '@weldsuite/app-api-client/schemas/reach';

function flatten(node: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

const placeholders = (text: string) => (text.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',');

describe('reach i18n', () => {
  const english = flatten(en.reach);
  const dutch = flatten(nl.reach);

  it('has the same keys in en and nl', () => {
    expect(Object.keys(dutch).sort()).toEqual(Object.keys(english).sort());
  });

  it('uses the same placeholders in both languages', () => {
    const mismatched = Object.keys(english).filter((key) => placeholders(english[key]) !== placeholders(dutch[key] ?? ''));
    expect(mismatched).toEqual([]);
  });

  it('has no empty strings', () => {
    expect(Object.entries(english).filter(([, value]) => value.trim() === '')).toEqual([]);
    expect(Object.entries(dutch).filter(([, value]) => value.trim() === '')).toEqual([]);
  });

  // The screens look these up by the contract's own enum values, so a new value
  // without a translation would show its raw key.
  it('has a label for every value of the contract enums the screens translate', () => {
    const expected = [
      ...reachMailboxStatusSchema.options.map((v) => `status.mailbox.${v}`),
      ...reachDomainStatusSchema.options.map((v) => `status.domain.${v}`),
      ...reachMailboxTypeSchema.options.map((v) => `mailboxTypes.${v}`),
      ...reachMailboxTypeSchema.options.flatMap((v) => [`mailboxes.create.types.${v}.label`, `mailboxes.create.types.${v}.description`]),
      ...reachDomainIneligibleReasonSchema.options.map((v) => `mailboxes.reasons.${v}`),
      ...reachSuppressionReasonSchema.options.map((v) => `settings.suppressions.reasons.${v}`),
      ...listSourceSchema.options.map((v) => `access.form.listSources.${v}`),
      ...WELDREACH_TERMS.map((v) => `access.terms.${v}`),
      ...appAccessStatusSchema.options.map((v) => `access.status.${v}`),
      ...['none', 'active', 'past_due', 'canceled'].map((v) => `status.billing.${v}`),
      ...['spf', 'dkim', 'dmarc', 'mx'].map((v) => `mailboxes.domains.dns.${v}`),
      ...[1, 2, 3, 4, 5, 6, 7].map((v) => `settings.weekdays.${v}`),
      ...['identity', 'payment', 'domains', 'mailboxes', 'done'].map((v) => `setup.steps.${v}`),
    ];
    expect(expected.filter((key) => !(key in english))).toEqual([]);
    expect(expected.filter((key) => !(key in dutch))).toEqual([]);
  });
});
