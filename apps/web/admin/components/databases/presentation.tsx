import Link from 'next/link';
import { AlertTriangle, type LucideIcon } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { cn } from '@/lib/utils';
import { adminCopy, fill } from '@/lib/i18n';
import type { DatabasePlacement, FillLevel, ShardDrift, ShardFill } from '@/lib/databases';
import type { PoolStatus, ShardStatus } from '@/lib/databases-data';

// Small building blocks shared by the Databases overview, the shard page and the
// workspace Database tab. Server components only: nothing here needs the browser.

/** The label for `key`, or `key` itself for a value the copy does not know (a status added later, say). */
export function lookup(labels: Readonly<Record<string, string>>, key: string): string {
  return labels[key] ?? key;
}

export function Mono({ children, className }: Readonly<{ children: React.ReactNode; className?: string }>) {
  return <span className={cn('font-mono text-xs', className)}>{children}</span>;
}

export function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

export function StatCard({
  label,
  value,
  hint,
}: Readonly<{ label: string; value: React.ReactNode; hint?: React.ReactNode }>) {
  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

export function SectionHeading({
  icon: Icon,
  title,
  count,
  description,
}: Readonly<{ icon: LucideIcon; title: string; count?: number; description?: string }>) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">
          {title}
          {count !== undefined && <span className="ml-1.5 tabular-nums text-muted-foreground">({count})</span>}
        </h2>
      </div>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

const NOTICE_TONE = {
  warning: 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-400',
  muted: 'border-border bg-muted/30 text-muted-foreground',
} as const;

export function Notice({
  tone,
  title,
  children,
}: Readonly<{ tone: keyof typeof NOTICE_TONE; title?: string; children: React.ReactNode }>) {
  return (
    <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', NOTICE_TONE[tone])}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="space-y-0.5">
        {title && <div className="font-medium">{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

const PLACEMENT_VARIANT = {
  shared: 'secondary',
  dedicated: 'outline',
  none: 'warning',
} as const;

export function PlacementBadge({ placement }: Readonly<{ placement: DatabasePlacement }>) {
  const t = adminCopy().databases;
  return <Badge variant={PLACEMENT_VARIANT[placement]}>{t.placement[placement]}</Badge>;
}

const SHARD_STATUS_VARIANT: Record<ShardStatus, 'success' | 'warning' | 'secondary'> = {
  active: 'success',
  full: 'warning',
  disabled: 'secondary',
};

export function ShardStatusBadge({ status }: Readonly<{ status: ShardStatus }>) {
  const t = adminCopy().databases;
  return <Badge variant={SHARD_STATUS_VARIANT[status] ?? 'secondary'}>{lookup(t.shards.status, status)}</Badge>;
}

const PROVISIONING_VARIANT: Record<string, 'success' | 'destructive'> = {
  ready: 'success',
  failed: 'destructive',
};

export function ProvisioningBadge({ status }: Readonly<{ status: string }>) {
  const t = adminCopy().databases;
  return <Badge variant={PROVISIONING_VARIANT[status] ?? 'warning'}>{lookup(t.provisioning, status)}</Badge>;
}

const POOL_STATUS_VARIANT: Record<PoolStatus, 'success' | 'secondary' | 'destructive'> = {
  available: 'success',
  assigned: 'secondary',
  error: 'destructive',
};

export function PoolStatusBadge({ status }: Readonly<{ status: PoolStatus }>) {
  const t = adminCopy().databases;
  return <Badge variant={POOL_STATUS_VARIANT[status] ?? 'secondary'}>{lookup(t.pool.status, status)}</Badge>;
}

// ---------------------------------------------------------------------------
// Shard fill
// ---------------------------------------------------------------------------

const FILL_TONE: Record<FillLevel, { bar: string; text: string }> = {
  ok: { bar: 'bg-emerald-500', text: 'text-muted-foreground' },
  warning: { bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  full: { bar: 'bg-destructive', text: 'text-destructive' },
};

/** A bar with the used/maximum count and the fill level, coloured by level. */
export function FillBar({
  fill: shardFill,
  count,
  max,
}: Readonly<{ fill: ShardFill; count: number; max: number }>) {
  const t = adminCopy().databases;
  const tone = FILL_TONE[shardFill.level];
  const width = Math.min(100, Math.max(0, shardFill.percent));
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={fill(t.fillAria, { count, max })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={width}
        className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn('h-full rounded-full', tone.bar)} style={{ width: `${width}%` }} />
      </div>
      <span className="text-xs tabular-nums">
        {count} / {max}
      </span>
      <span className={cn('text-xs tabular-nums', tone.text)}>
        {shardFill.percent}% · {t.fillLevel[shardFill.level]}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shard counter drift
// ---------------------------------------------------------------------------

/** Nothing for a shard whose counter matches. */
export function DriftBadge({ drift }: Readonly<{ drift: ShardDrift }>) {
  const t = adminCopy().databases;
  if (drift.state === 'in_sync') return null;
  if (drift.state === 'recent') return <Badge variant="outline">{t.drift.badgeRecent}</Badge>;
  return (
    <Badge variant="warning">
      <AlertTriangle />
      {t.drift.badge}
    </Badge>
  );
}

/** The explanation behind a {@link DriftBadge}, with the numbers. Nothing for a shard that is in sync. */
export function DriftNotice({
  drift,
  liveWorkspaces,
  pendingTeardown,
  warmSlots,
}: Readonly<{ drift: ShardDrift; liveWorkspaces: number; pendingTeardown: number; warmSlots: number }>) {
  const t = adminCopy().databases;
  if (drift.state === 'in_sync') return null;

  let message = drift.delta > 0 ? t.drift.higher : t.drift.lower;
  if (drift.state === 'recent') message = t.drift.recent;
  const text = fill(message, {
    actual: drift.actual,
    expected: drift.expected,
    breakdown: fill(t.drift.breakdown, {
      workspaces: liveWorkspaces,
      teardown: pendingTeardown,
      slots: warmSlots,
    }),
  });
  return (
    <Notice tone={drift.state === 'recent' ? 'muted' : 'warning'} title={t.drift.title}>
      {text}
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export function ShardLink({ id, name }: Readonly<{ id: string; name: string }>) {
  return (
    <Link href={`/databases/shards/${id}`} className="text-sm font-medium underline-offset-2 hover:underline">
      {name}
    </Link>
  );
}

export function WorkspaceLink({ id, name }: Readonly<{ id: string; name: string }>) {
  return (
    <Link href={`/workspaces/${id}`} className="text-sm font-medium underline-offset-2 hover:underline">
      {name}
    </Link>
  );
}
