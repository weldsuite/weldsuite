import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

interface ReportShellProps {
  title: string;
  /** One line under the title: the period, the basis. */
  subtitle?: string;
  toolbar: ReactNode;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  children: ReactNode;
}

/** Title, toolbar and the loading and error states every report page shares. */
export function ReportShell({ title, subtitle, toolbar, isLoading, isError, onRetry, children }: Readonly<ReportShellProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.reports;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>

      {toolbar}

      {isLoading ? (
        <PageLoader fullScreen={false} className="min-h-40" />
      ) : isError ? (
        <div className="flex flex-col items-center gap-3 rounded-md border p-8 text-center" role="alert">
          <AlertCircle className="h-8 w-8 text-destructive" aria-hidden />
          <p className="text-sm text-muted-foreground">{tr.loadError}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            {tr.retry}
          </Button>
        </div>
      ) : (
        children
      )}
    </div>
  );
}

interface LedgerLinkProps {
  accountId: string;
  from?: string | null;
  to?: string | null;
  children: ReactNode;
}

/** Opens the general ledger of an account for the period of the report. */
export function LedgerLink({ accountId, from, to, children }: Readonly<LedgerLinkProps>) {
  return (
    <Link
      to="/weldbooks/reports/general-ledger"
      search={{ accountId, from: from ?? undefined, to: to ?? undefined }}
      className="hover:underline"
    >
      {children}
    </Link>
  );
}

/** A warning line under a statement, e.g. a balance sheet that doesn't balance. */
export function ReportWarning({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2 text-sm" role="status">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
