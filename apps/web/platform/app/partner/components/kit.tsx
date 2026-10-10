/**
 * Small building blocks shared by the partner portal pages.
 */

import { useMemo, type ComponentType, type ReactNode } from 'react';
import { AlertCircle, Inbox } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type {
  PartnerRequestStatus,
  PartnerStatementStatus,
  PartnerStatus,
  WorkspaceLicenceStatus,
} from '@weldsuite/app-api-client/schemas/partners';
import { useI18n } from '@/lib/i18n/provider';
import { formatCents, formatMoneyString, formatUnitPrice } from '@/lib/partner/money';
import { cn } from '@/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
}: Readonly<{ title: string; description?: string; actions?: ReactNode }>) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function FieldMessage({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}

export function LoadingBlock({ rows = 4 }: Readonly<{ rows?: number }>) {
  return (
    <div className="space-y-3" role="status" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function ErrorBlock({ message, onRetry }: Readonly<{ message?: string; onRetry?: () => void }>) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center"
    >
      <AlertCircle className="h-6 w-6 text-destructive" aria-hidden />
      <p className="text-sm text-destructive">{message || t.partner.common.loadFailed}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t.partner.common.retry}
        </Button>
      )}
    </div>
  );
}

export function EmptyBlock({
  icon: Icon = Inbox,
  title,
  description,
  action,
}: Readonly<{
  icon?: ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: ReactNode;
}>) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center">
      <Icon className="h-8 w-8 text-muted-foreground" />
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: Readonly<{ label: string; value: ReactNode; hint?: string; tone?: 'default' | 'positive' | 'negative' }>) {
  return (
    <Card>
      <CardContent className="space-y-1 p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p
          className={cn(
            'text-2xl font-semibold tabular-nums',
            tone === 'positive' && 'text-emerald-600 dark:text-emerald-400',
            tone === 'negative' && 'text-destructive',
          )}
        >
          {value}
        </p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';

const PARTNER_STATUS_VARIANT: Record<PartnerStatus, BadgeVariant> = {
  active: 'success',
  past_due: 'warning',
  suspended: 'destructive',
};

const LICENCE_STATUS_VARIANT: Record<WorkspaceLicenceStatus, BadgeVariant> = {
  active: 'success',
  suspended: 'warning',
  ended: 'secondary',
};

const STATEMENT_STATUS_VARIANT: Record<PartnerStatementStatus | 'preview', BadgeVariant> = {
  preview: 'outline',
  draft: 'secondary',
  final: 'secondary',
  invoiced: 'warning',
  paid: 'success',
  void: 'destructive',
};

const REQUEST_STATUS_VARIANT: Record<PartnerRequestStatus, BadgeVariant> = {
  new: 'default',
  contacted: 'secondary',
  provisioned: 'success',
  declined: 'secondary',
};

export function PartnerStatusBadge({ status }: Readonly<{ status: PartnerStatus }>) {
  const { t } = useI18n();
  return <Badge variant={PARTNER_STATUS_VARIANT[status]}>{t.partner.partnerStatus[status]}</Badge>;
}

export function LicenceStatusBadge({ status }: Readonly<{ status: WorkspaceLicenceStatus }>) {
  const { t } = useI18n();
  return <Badge variant={LICENCE_STATUS_VARIANT[status]}>{t.partner.licenceStatus[status]}</Badge>;
}

export function StatementStatusBadge({ status }: Readonly<{ status: PartnerStatementStatus | 'preview' }>) {
  const { t } = useI18n();
  return <Badge variant={STATEMENT_STATUS_VARIANT[status]}>{t.partner.statementStatus[status]}</Badge>;
}

export function RequestStatusBadge({ status }: Readonly<{ status: PartnerRequestStatus }>) {
  const { t } = useI18n();
  return <Badge variant={REQUEST_STATUS_VARIANT[status]}>{t.partner.requestStatus[status]}</Badge>;
}

/** Locale-aware money and date formatting for the portal. */
export function useFormatters() {
  const { language } = useI18n();
  return useMemo(() => {
    const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });
    const dateTime = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
    // Statement periods are UTC calendar months.
    const month = new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const safe = (fmt: Intl.DateTimeFormat, iso: string | null | undefined) => {
      if (!iso) return '';
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? '' : fmt.format(d);
    };
    return {
      cents: (cents: number, currency = 'USD') => formatCents(cents, currency, language),
      money: (amount: string, currency = 'USD') => formatMoneyString(amount, currency, language),
      unitPrice: (price: string, currency = 'USD') => formatUnitPrice(price, currency, language),
      number: (n: number) => new Intl.NumberFormat(language).format(n),
      date: (iso: string | null | undefined) => safe(date, iso),
      dateTime: (iso: string | null | undefined) => safe(dateTime, iso),
      month: (iso: string | null | undefined) => safe(month, iso),
    };
  }, [language]);
}

/** The message of a failed request, or `fallback` when there is none worth showing. */
export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
