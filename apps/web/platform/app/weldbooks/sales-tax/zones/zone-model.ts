/**
 * Tax zones without the React: the form values, the validation schema and the
 * conversions to what the API takes. The ZIP list is typed as text
 * ("78701, 78702, 78710-78799") and read by `parseZipList`.
 */
import { z } from 'zod';
import type {
  CreateZoneInput,
  SalesTaxJurisdiction,
  SalesTaxZone,
  UpdateZoneInput,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { formatPercent } from '../setup/format';
import type { FormatText, SetupTexts, ValidationTexts } from '../setup/setup-texts';
import { MAX_ZIP_ENTRIES, formatZipList, parseZipList, type ZipListError } from './zip-list';

export const DEFAULT_ZONE_PRIORITY = 100;

export interface ZoneFormValues {
  name: string;
  jurisdictionIds: string[];
  zipText: string;
  isOrigin: boolean;
  priority: string;
}

export function emptyZoneForm(): ZoneFormValues {
  return { name: '', jurisdictionIds: [], zipText: '', isOrigin: false, priority: String(DEFAULT_ZONE_PRIORITY) };
}

export function zoneToForm(zone: SalesTaxZone): ZoneFormValues {
  return {
    name: zone.name,
    jurisdictionIds: zone.jurisdictionIds,
    zipText: formatZipList(zone.postalCodes),
    isOrigin: zone.isOrigin,
    priority: String(zone.priority),
  };
}

/** The sentence for one ZIP problem, e.g. `"7870" is not a ZIP code or range`. */
export function zipProblemText(error: ZipListError, texts: SetupTexts['zones']['problems'], format: FormatText): string {
  switch (error.problem) {
    case 'zip4':
      return format(texts.zip4, { token: error.token });
    case 'backwards':
      return format(texts.backwards, { token: error.token });
    case 'too_many':
      return format(texts.tooMany, { max: MAX_ZIP_ENTRIES });
    default:
      return format(texts.format, { token: error.token });
  }
}

/** All the ZIP problems of a typed list as one line ("…, …"), or '' when it reads cleanly. */
export function zipProblemsText(text: string, texts: SetupTexts['zones']['problems'], format: FormatText): string {
  const { errors } = parseZipList(text);
  return errors.map((e) => zipProblemText(e, texts, format)).join('; ');
}

export function makeZoneSchema(validation: ValidationTexts, problems: SetupTexts['zones']['problems'], format: FormatText) {
  return z
    .object({
      name: z.string().trim().min(1, validation.required).max(255, validation.tooLong),
      jurisdictionIds: z.array(z.string()).min(1, validation.zoneJurisdictions),
      zipText: z.string(),
      isOrigin: z.boolean(),
      priority: z.string().refine((v) => /^\d{1,5}$/.test(v.trim()) && Number(v) <= 10000, validation.priority),
    })
    .superRefine((values, ctx) => {
      const parsed = parseZipList(values.zipText);
      if (parsed.errors.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['zipText'],
          message: format(validation.zipInvalid, {
            problems: parsed.errors.map((e) => zipProblemText(e, problems, format)).join('; '),
          }),
        });
      } else if (parsed.entries.length === 0 && !values.isOrigin) {
        // A destination zone without ZIP codes would never match a sale.
        ctx.addIssue({ code: 'custom', path: ['zipText'], message: validation.zoneZips });
      }
    });
}

export function toCreateZoneInput(agencyId: string, values: ZoneFormValues): CreateZoneInput {
  return {
    agencyId,
    name: values.name.trim(),
    jurisdictionIds: values.jurisdictionIds,
    postalCodes: parseZipList(values.zipText).entries,
    isOrigin: values.isOrigin,
    priority: Number(values.priority),
  };
}

export function toUpdateZoneInput(values: ZoneFormValues): UpdateZoneInput {
  return {
    name: values.name.trim(),
    jurisdictionIds: values.jurisdictionIds,
    postalCodes: parseZipList(values.zipText).entries,
    isOrigin: values.isOrigin,
    priority: Number(values.priority),
  };
}

/** The sum of the chosen jurisdictions' rates today, in percent (the server's `combinedRate`). */
export function combinedRate(jurisdictions: readonly Pick<SalesTaxJurisdiction, 'id' | 'currentRate'>[], ids: readonly string[]): number {
  const chosen = new Set(ids);
  const sum = jurisdictions.filter((j) => chosen.has(j.id)).reduce((total, j) => total + (j.currentRate ?? 0), 0);
  return Math.round(sum * 10000) / 10000;
}

export function formatCombinedRate(value: number): string {
  return `${formatPercent(value) || '0'}%`;
}
