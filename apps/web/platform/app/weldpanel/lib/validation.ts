/**
 * Validation for the WeldPanel forms. The rules are the contract's
 * (`panelDomainSchema`, `panelUrlPatternSchema`, the limits and enums in
 * `@weldsuite/app-api-client/schemas/weldpanel`); only the messages are ours,
 * so a failed field reads in the user's language and not in the schema's English.
 */

import { z } from 'zod';
import {
  PANEL_CONSENT_MODES,
  PANEL_MASKING_LEVELS,
  PANEL_PROJECT_KINDS,
  panelDomainSchema,
  panelUrlPatternSchema,
} from '@weldsuite/app-api-client/schemas/weldpanel';
import type { useI18n } from '@/lib/i18n/provider';

export type ValidationStrings = ReturnType<typeof useI18n>['t']['weldpanel']['validation'];

export const MAX_DOMAINS = 20;
export const MAX_EXCLUDED_URLS = 50;
export const MAX_IP_FILTERS = 50;

/**
 * What someone pastes into "allowed domains" is often a whole address
 * (`https://Example.com/pricing`, `example.com:8080`). The schema wants a bare
 * host, so the scheme, port, path, query and fragment are dropped first.
 */
export function normalizeDomainInput(raw: string): string {
  const withoutScheme = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const end = withoutScheme.search(/[/?#]/);
  return (end === -1 ? withoutScheme : withoutScheme.slice(0, end)).replace(/:\d+$/, '');
}

/** The host `panelDomainSchema` accepts for this input, or `null`. */
export function parseDomain(raw: string): string | null {
  const result = panelDomainSchema.safeParse(normalizeDomainInput(raw));
  return result.success ? result.data : null;
}

/** The pattern `panelUrlPatternSchema` accepts for this input, or `null`. */
export function parseUrlPattern(raw: string): string | null {
  const result = panelUrlPatternSchema.safeParse(raw);
  return result.success ? result.data : null;
}

const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

function isIpv6(text: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(':')) return false;
  const halves = text.split('::');
  if (halves.length > 2) return false;
  // An embedded IPv4 tail (::ffff:1.2.3.4) counts as two groups.
  const groups = halves.flatMap((half) => (half === '' ? [] : half.split(':')));
  let count = 0;
  for (const [index, group] of groups.entries()) {
    if (index === groups.length - 1 && group.includes('.')) {
      if (!IPV4.test(group)) return false;
      count += 2;
    } else if (HEX_GROUP.test(group)) {
      count += 1;
    } else {
      return false;
    }
  }
  return halves.length === 2 ? count < 8 : count === 8;
}

/**
 * The entry for an IPv4 or IPv6 address or a CIDR range (`203.0.113.0/24`,
 * `2001:db8::/32`), or `null`. Checked by shape only; the collector does the matching.
 */
export function parseIpFilter(raw: string): string | null {
  const text = raw.trim();
  const [address = '', prefix, ...extra] = text.split('/');
  if (extra.length > 0 || address === '') return null;
  const v4 = IPV4.test(address);
  if (!v4 && !isIpv6(address)) return null;
  if (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (v4 ? 32 : 128))) return null;
  return text.length <= 64 ? text : null;
}

/** A string the contract schema accepts as it is, failing with our message. */
function accepted(parse: (raw: string) => string | null, message: string) {
  return z.string().superRefine((value, ctx) => {
    if (parse(value) !== value) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });
}

/** Name, type and allowed domains: the create dialog and the General tab. */
export function buildProjectFormSchema(v: ValidationStrings) {
  return z.object({
    name: z.string().trim().min(1, v.nameRequired).max(255, v.nameTooLong),
    kind: z.enum(PANEL_PROJECT_KINDS),
    allowedDomains: z.array(accepted(parseDomain, v.domainInvalid)).max(MAX_DOMAINS, v.tooManyDomains),
  });
}
export type ProjectFormValues = z.infer<ReturnType<typeof buildProjectFormSchema>>;

/** The settings the Privacy & collection tab edits. */
export function buildPrivacyFormSchema(v: ValidationStrings) {
  return z.object({
    autocapture: z.boolean(),
    consentMode: z.enum(PANEL_CONSENT_MODES),
    maskingLevel: z.enum(PANEL_MASKING_LEVELS),
    excludedUrls: z.array(accepted(parseUrlPattern, v.patternInvalid)).max(MAX_EXCLUDED_URLS, v.tooManyPatterns),
    ipFilters: z.array(accepted(parseIpFilter, v.ipInvalid)).max(MAX_IP_FILTERS, v.tooManyIps),
    /** Whole percent of consented sessions that are recorded; the API takes a 0 to 1 share. */
    recordingSamplePercent: z
      .number({ required_error: v.sampleRateInvalid, invalid_type_error: v.sampleRateInvalid })
      .int(v.sampleRateInvalid)
      .min(0, v.sampleRateInvalid)
      .max(100, v.sampleRateInvalid),
    aiEnabled: z.boolean(),
  });
}
export type PrivacyFormValues = z.infer<ReturnType<typeof buildPrivacyFormSchema>>;
