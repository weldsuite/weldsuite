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

/**
 * What someone pastes into "allowed domains" is often a whole address
 * (`https://Example.com/pricing`, `example.com:8080`). The schema wants a bare
 * host, so the scheme, port, path, query and fragment are dropped first.
 */
export function normalizeDomainInput(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');
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
  });
}
export type PrivacyFormValues = z.infer<ReturnType<typeof buildPrivacyFormSchema>>;
