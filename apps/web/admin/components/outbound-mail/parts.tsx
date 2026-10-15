import Link from 'next/link';
import { Badge } from '@weldsuite/ui/components/badge';
import { cn } from '@/lib/utils';
import {
  CASE_STATUS_LABELS,
  SEVERITY_LABELS,
  STATE_LABELS,
  riskTone,
  type OutboundCaseSeverity,
  type OutboundCaseStatus,
  type OutboundState,
  type RiskTone,
  type TrustDisplay,
} from '@/lib/outbound-mail';

type Variant = 'success' | 'warning' | 'secondary' | 'destructive' | 'outline';

const STATE_VARIANT: Record<OutboundState, Variant> = {
  active: 'secondary',
  restricted: 'warning',
  hold: 'warning',
  suspended: 'destructive',
};

/** A workspace's sending state as a pill. */
export function StateBadge({ state }: Readonly<{ state: OutboundState }>) {
  return <Badge variant={STATE_VARIANT[state]}>{STATE_LABELS[state]}</Badge>;
}

const SEVERITY_VARIANT: Record<OutboundCaseSeverity, Variant> = {
  info: 'secondary',
  warning: 'warning',
  urgent: 'destructive',
};

export function SeverityBadge({ severity }: Readonly<{ severity: OutboundCaseSeverity }>) {
  return <Badge variant={SEVERITY_VARIANT[severity]}>{SEVERITY_LABELS[severity]}</Badge>;
}

const CASE_STATUS_VARIANT: Record<OutboundCaseStatus, Variant> = {
  open: 'outline',
  confirmed: 'destructive',
  dismissed: 'secondary',
};

export function CaseStatusBadge({ status }: Readonly<{ status: OutboundCaseStatus }>) {
  return <Badge variant={CASE_STATUS_VARIANT[status]}>{CASE_STATUS_LABELS[status]}</Badge>;
}

const RISK_CLASS: Record<RiskTone, string> = {
  low: 'text-muted-foreground',
  review: 'font-medium',
  high: 'font-medium text-amber-600 dark:text-amber-400',
  critical: 'font-semibold text-destructive',
};

const RISK_TITLE: Record<RiskTone, string> = {
  low: 'Below the review band',
  review: 'Grey zone: an AI review runs on the top template',
  high: 'At or above the restrict threshold',
  critical: 'At or above the hold threshold',
};

/** A 0–100 risk score, coloured by the bands the guard acts on. */
export function RiskScore({ score, className }: Readonly<{ score: number | null; className?: string }>) {
  if (score === null) return <span className="text-muted-foreground">—</span>;
  const tone = riskTone(score);
  return (
    <span className={cn('tabular-nums', RISK_CLASS[tone], className)} title={RISK_TITLE[tone]}>
      {score}
    </span>
  );
}

/** Trust level with where it comes from. */
export function TrustText({ trust }: Readonly<{ trust: TrustDisplay }>) {
  return (
    <span className={cn('text-xs', trust.pinned ? 'font-medium' : 'text-muted-foreground')} title={trust.label}>
      {trust.label}
    </span>
  );
}

export interface FilterTab {
  key: string;
  label: string;
  href: string;
  count?: number;
}

/** A row of link tabs for a filter; the current one is highlighted. */
export function FilterTabs({
  label,
  tabs,
  selected,
}: Readonly<{ label: string; tabs: FilterTab[]; selected: string }>) {
  return (
    <nav aria-label={label} className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          scroll={false}
          aria-current={selected === tab.key ? 'page' : undefined}
          className={cn(
            'rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-muted',
            selected === tab.key && 'bg-muted font-medium text-foreground',
          )}
        >
          {tab.label}
          {tab.count !== undefined && <span className="ml-1.5 tabular-nums">{tab.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** Label/value pairs in a compact grid. */
export function Facts({ items }: Readonly<{ items: Array<{ label: string; value: React.ReactNode }> }>) {
  if (items.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
