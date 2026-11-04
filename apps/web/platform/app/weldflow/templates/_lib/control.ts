/**
 * The "Control and reporting" lines of a template preview: change approval,
 * change board, status report and risk appetite, written out from the
 * blueprint's settings.
 */

import type { Blueprint } from '@weldsuite/app-api-client/schemas/project-closing';
import type { TranslationsType } from '@weldsuite/i18n/types';
import type { PluralForms } from '@weldsuite/i18n/plural';
import { formatMoney } from '@/app/weldflow/project/[projectId]/close/_lib/close';

type ControlCopy = TranslationsType['flowClosing']['templates']['preview']['control'];

interface ControlContext {
  copy: ControlCopy;
  plural: (count: number, forms: PluralForms) => string;
  format: (template: string, values: Record<string, unknown>) => string;
  intlLocale: string;
}

export interface ControlLine {
  key: 'changeApproval' | 'changeBoard' | 'statusReport' | 'riskAppetite';
  value: string;
}

/** The name of an ISO weekday (1 = Monday) in the user's language. */
export function weekdayName(isoWeekday: number, intlLocale: string): string {
  // 2026-01-05 is a Monday.
  const date = new Date(Date.UTC(2026, 0, 4 + isoWeekday));
  return new Intl.DateTimeFormat(intlLocale, { weekday: 'long', timeZone: 'UTC' }).format(date);
}

export function controlLines(blueprint: Blueprint, ctx: ControlContext): ControlLine[] {
  const { copy, plural, format, intlLocale } = ctx;
  const { changeControl, statusReport, riskAppetite } = blueprint.settings;
  const roleLabel = (key: string) => blueprint.roles.find((role) => role.key === key)?.label ?? key;
  const lines: ControlLine[] = [];
  const changeBoardValue = () => {
    if (!changeControl) return copy.notSet;
    return changeControl.boardRoles.length > 0 ? changeControl.boardRoles.map(roleLabel).join(', ') : copy.changeBoardEmpty;
  };

  lines.push({
    key: 'changeApproval',
    value: changeControl
      ? format(copy.changeApprovalValue, {
          cost: formatMoney(changeControl.costLimit, blueprint.project.budgetCurrency, intlLocale),
          days: plural(changeControl.scheduleLimitDays, copy.workingDays),
        })
      : copy.notSet,
  });
  lines.push({
    key: 'changeBoard',
    value: changeBoardValue(),
  });
  lines.push({
    key: 'statusReport',
    value: statusReport
      ? format(copy.statusReportValue, {
          cadence: copy.cadence[statusReport.cadence],
          weekday: weekdayName(statusReport.weekday, intlLocale),
          time: `${String(statusReport.hour).padStart(2, '0')}:00`,
          recipients: copy.recipients[statusReport.recipientsRule],
        })
      : copy.notSet,
  });
  lines.push({
    key: 'riskAppetite',
    value: riskAppetite === undefined ? copy.notSet : format(copy.riskAppetiteValue, { score: riskAppetite }),
  });
  return lines;
}
