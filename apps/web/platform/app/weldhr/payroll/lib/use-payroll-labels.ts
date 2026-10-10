/**
 * Translation helpers for values the payroll engines return as codes:
 * issue codes, pay component codes, payslip line label keys, state
 * certificate fields. Each falls back to something readable instead of the
 * raw key when a dictionary is behind the engines (they fill theirs in
 * separately), and none of them logs a "missing translation" warning for it.
 */

import { useMemo } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useI18n } from '@/lib/i18n/provider';
import { componentDef } from '@weldsuite/payroll-domain/components';
import { payslipLineLabel } from '@weldsuite/payroll-domain/labels';
import { STATE_CERTIFICATE_LABELS } from '@weldsuite/payroll-domain/us/states/certificate-labels';
import type { HrPayrollIssue, HrPayslipLine } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { formatCents, humanizeKey } from './format';
import { fillIssueTemplate } from './text';

export type LabelLanguage = 'en' | 'nl';

type Dictionary = Record<string, string>;

/** Issue params as text: `fooCents` becomes `foo` as money, `field` and `item` become readable words. */
function issueParams(issue: HrPayrollIssue, currency?: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(issue.params ?? {})) {
    if (key.endsWith('Cents') && typeof value === 'number') {
      params[key.slice(0, -5)] = currency ? formatCents(value, currency) : (value / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });
    } else if (key === 'field' || key === 'item') {
      params[key] = humanizeKey(String(value)).toLowerCase();
    } else {
      params[key] = String(value);
    }
  }
  return params;
}

export function usePayrollLabels() {
  const { t: tree, language } = useI18n();
  const t = useTranslations();
  const lang: LabelLanguage = language === 'nl' ? 'nl' : 'en';

  return useMemo(() => {
    const issues = tree.weldhr.payroll.issues as unknown as Dictionary;
    const components = tree.weldhr.payroll.components as unknown as Dictionary;
    const missing = tree.weldhr.payroll.me.missing as unknown as Dictionary;

    return {
      lang,

      /**
       * An issue's message with its params filled in (see `fillIssueTemplate`). Params named `fooCents` are offered as
       * `{foo}` formatted as money, in `currency` when the caller knows it. A `<code>_<field>` message wins when the
       * issue names a `field`. Unknown codes read "Unknown issue (code)".
       */
      issue(issue: HrPayrollIssue, currency?: string): string {
        const field = typeof issue.params?.field === 'string' ? issue.params.field : null;
        const code = field && issues[`${issue.code}_${field}`] ? `${issue.code}_${field}` : issue.code;
        const template = issues[code];
        if (!template) return t('weldhr.payroll.issues.unknown', { code: issue.code });
        return fillIssueTemplate(template, issueParams(issue, currency));
      },

      /** A pay component's name by catalog code (`nl.travel_allowance`), or the readable code when it is not in the catalog. */
      component(code: string): string {
        const def = componentDef(code);
        if (def && components[def.labelKey]) return t(`weldhr.payroll.components.${def.labelKey}`);
        return humanizeKey(code);
      },

      /** A field payroll still needs from the employee (`nationalId`, `bankIban`…), readable; unknown names are humanized. */
      missingField(key: string): string {
        return missing[key] ? t(`weldhr.payroll.me.missing.${key}`) : humanizeKey(key);
      },

      /** A payslip line: the user's own label, else the engine dictionary in the current language. */
      line(line: Pick<HrPayslipLine, 'labelKey' | 'label'>): string {
        return payslipLineLabel({ labelKey: line.labelKey, label: line.label ?? null }, lang);
      },

      /** A state certificate field's label (`<ST>.<key>` in the domain dictionary). */
      stateField(state: string, key: string): string {
        return STATE_CERTIFICATE_LABELS[`${state}.${key}`]?.[lang] ?? humanizeKey(key);
      },

      /** A select option of a state certificate field or its filing status, falling back to the readable option. */
      stateOption(state: string, key: string, option: string): string {
        return STATE_CERTIFICATE_LABELS[`${state}.${key}.${option}`]?.[lang] ?? humanizeKey(option);
      },
    };
  }, [tree, t, lang]);
}
