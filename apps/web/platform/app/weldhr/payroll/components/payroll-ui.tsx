/** Small pieces shared across the payroll screens: the access gate, status badges, issue lists. */

import type { ReactNode } from 'react';
import { AlertCircle, AlertTriangle, Banknote, Check, Info } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type {
  HrPayRunStatus,
  HrPayrollFilingStatus,
  HrPayrollIssue,
  HrPayslipStatus,
} from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { PageLoader } from '@/components/page-loader';
import { useHrPayrollFlag } from '@/hooks/queries/use-weldhr-payroll-queries';
import { cn } from '@/lib/utils';
import { DetailPage, emptyIcon } from '../../components/page-kit';
import { ErrorBanner } from '../../components/shared';
import { usePayrollLabels } from '../lib/use-payroll-labels';

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * Payroll screens need the `weldhr-payroll` flag and a permission. While the
 * flag or the permissions are still loading nothing is decided, so a loader is
 * shown instead of a flash of "not available".
 */
export function PayrollGate({ permission = 'payroll:read', children }: Readonly<{ permission?: string; children: ReactNode }>) {
  const t = useTranslations();
  const { can, isLoading: permissionsLoading } = usePermissions();
  const flag = useHrPayrollFlag();

  if (permissionsLoading || flag.isLoading) return <PageLoader fullScreen={false} />;

  if (!flag.enabled) {
    return (
      <DetailPage>
        <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
          {emptyIcon(Banknote)}
          <h2 className="mb-1.5 text-[15px] font-semibold">{t('weldhr.payroll.notEnabled.title')}</h2>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{t('weldhr.payroll.notEnabled.description')}</p>
        </div>
      </DetailPage>
    );
  }

  if (!can(permission)) {
    return (
      <DetailPage>
        <ErrorBanner error={t('weldhr.common.noPermission')} />
      </DetailPage>
    );
  }

  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

const PAID_CLASS = 'border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
const WARN_CLASS = 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';

export function RunStatusBadge({ status }: Readonly<{ status: HrPayRunStatus }>) {
  const t = useTranslations();
  const label = t(`weldhr.payroll.runStatus.${status}`);
  switch (status) {
    case 'draft':
      return <Badge variant="secondary">{label}</Badge>;
    case 'calculated':
      return <Badge variant="outline">{label}</Badge>;
    case 'approved':
      return <Badge>{label}</Badge>;
    case 'paid':
      return <Badge className={PAID_CLASS}>{label}</Badge>;
    default:
      return (
        <Badge variant="secondary" className="line-through">
          {label}
        </Badge>
      );
  }
}

export function PayslipStatusBadge({ status }: Readonly<{ status: HrPayslipStatus }>) {
  const t = useTranslations();
  const label = t(`weldhr.payroll.payslipStatus.${status}`);
  if (status === 'final') return <Badge className={PAID_CLASS}>{label}</Badge>;
  if (status === 'void') return <Badge variant="destructive">{label}</Badge>;
  return <Badge variant="secondary">{label}</Badge>;
}

export function FilingStatusBadge({ status }: Readonly<{ status: HrPayrollFilingStatus }>) {
  const t = useTranslations();
  const label = t(`weldhr.payroll.filingStatus.${status}`);
  switch (status) {
    case 'open':
      return <Badge variant="outline">{label}</Badge>;
    case 'ready':
      return <Badge className={WARN_CLASS}>{label}</Badge>;
    case 'submitted':
      return <Badge variant="secondary">{label}</Badge>;
    case 'rejected':
      return <Badge variant="destructive">{label}</Badge>;
    default:
      return <Badge className={PAID_CLASS}>{label}</Badge>;
  }
}

/** The error and warning counts of a list of issues as two compact badges; nothing when there are none. */
export function IssueCountBadges({ issues, className }: Readonly<{ issues: HrPayrollIssue[]; className?: string }>) {
  const t = useTranslations();
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const warnings = issues.length - errors;
  if (issues.length === 0) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {errors > 0 && (
        <Badge variant="destructive" title={t('weldhr.payroll.issuesPanel.errors', { count: errors })}>
          <AlertCircle className="mr-1 h-3 w-3" />
          {errors}
        </Badge>
      )}
      {warnings > 0 && (
        <Badge className={WARN_CLASS} title={t('weldhr.payroll.issuesPanel.warnings', { count: warnings })}>
          <AlertTriangle className="mr-1 h-3 w-3" />
          {warnings}
        </Badge>
      )}
    </span>
  );
}

/** A "ready" tick or the issue badges, for readiness columns. */
export function ReadinessBadge({ issues }: Readonly<{ issues: HrPayrollIssue[] }>) {
  const t = useTranslations();
  if (issues.length === 0) {
    return (
      <Badge className={PAID_CLASS}>
        <Check className="mr-1 h-3 w-3" />
        {t('weldhr.payroll.ready')}
      </Badge>
    );
  }
  return <IssueCountBadges issues={issues} />;
}

// ---------------------------------------------------------------------------
// Issue list
// ---------------------------------------------------------------------------

/** Errors first, then warnings, one line each. `nameOf` prefixes the employee the issue belongs to. */
export function IssueList({
  issues,
  nameOf,
  currency,
  className,
}: Readonly<{
  issues: HrPayrollIssue[];
  nameOf?: (employeeId: string) => string | undefined;
  /** Formats money amounts inside issue messages. */
  currency?: string;
  className?: string;
}>) {
  const labels = usePayrollLabels();
  const sorted = [...issues].sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
  return (
    <ul className={cn('space-y-1.5', className)}>
      {sorted.map((issue, index) => {
        const name = issue.employeeId ? nameOf?.(issue.employeeId) : undefined;
        const isError = issue.severity === 'error';
        return (
          // Issues have no id of their own; code + employee + position is stable for one render of one list.
          <li key={`${issue.code}-${issue.employeeId ?? 'run'}-${index}`} className="flex items-start gap-2 text-sm">
            {isError ? (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <span>
              {name && <span className="font-medium">{name}: </span>}
              {labels.issue(issue, currency)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** A quiet "nothing to report" line with an info icon. */
export function InfoLine({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Label above a masked or plain value, for the details cards. */
export function ValueRow({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{children || '—'}</div>
    </div>
  );
}

/** A tiny section heading inside a dialog or sheet. */
export function FormSection({ title, description, children }: Readonly<{ title: string; description?: string; children: ReactNode }>) {
  return (
    <fieldset className="space-y-3 rounded-md border p-4">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      {description && <p className="-mt-1 text-xs text-muted-foreground">{description}</p>}
      {children}
    </fieldset>
  );
}
