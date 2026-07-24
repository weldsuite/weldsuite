import { Badge } from '@weldsuite/ui/components/badge';
import { useI18n } from '@/lib/i18n/provider';
import { EmptyStateIllustration } from '@/components/entity-list';
import type { ReactNode } from 'react';

export function NoSettingsForm() {
  const { t } = useI18n();
  return <p className="text-sm text-muted-foreground">{t.weldsuiteHome.settingsPage.noConfigurableSettings}</p>;
}

/**
 * Small "Demo data" pill rendered inside a Card header when the widget is
 * showing the hardcoded mockup fixture instead of real workspace data.
 */
export function DemoBadge() {
  const { t } = useI18n();
  return (
    <Badge variant="secondary" className="text-[10px] font-normal uppercase tracking-wide">
      {t.weldsuiteHome.runtime.demoBadge}
    </Badge>
  );
}

/**
 * Skeleton rows that approximate the layout of a Card while data loads.
 * `variant` picks a row template that matches the Card's row shape:
 *   - `list`  : avatar + 2 stacked lines  (mail, dms, channels, activity)
 *   - `table` : single row of 4 columns   (tickets, tasks, projects, …)
 *   - `chart` : tall block                (analytics, calendar-week)
 *   - `kanban`: 4 column groups           (pipeline)
 */
export function SkeletonRows({ count = 5, variant = 'list' }: { count?: number; variant?: 'list' | 'table' | 'chart' | 'kanban' }) {
  if (variant === 'chart') {
    return <div className="h-[220px] animate-pulse rounded-md bg-muted/60" />;
  }
  if (variant === 'kanban') {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
            <div className="h-14 animate-pulse rounded-md bg-muted/60" />
            <div className="h-14 animate-pulse rounded-md bg-muted/60" />
          </div>
        ))}
      </div>
    );
  }
  if (variant === 'table') {
    return (
      <div className="divide-y divide-border">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 py-2.5">
            <div className="h-4 w-4 shrink-0 animate-pulse rounded bg-muted/60" />
            <div className="h-4 flex-1 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-16 animate-pulse rounded bg-muted/60" />
            <div className="h-4 w-12 animate-pulse rounded bg-muted/60" />
          </div>
        ))}
      </div>
    );
  }
  // list
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 py-2.5">
          <div className="h-7 w-7 shrink-0 animate-pulse rounded-md bg-muted/60" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-3/4 animate-pulse rounded bg-muted/60" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Inline empty state rendered when a widget's hook returned zero rows.
 * `kind` is the i18n key into `weldsuiteHome.runtime.empty.<kind>` so each
 * widget can have its own copy ("No tickets yet", "Inbox zero", …).
 *
 * Uses the same `EmptyStateIllustration` (dotted-grid backdrop + SVG) that
 * the application pages render so widget empty states feel consistent with
 * their full-page counterparts.
 */
export function EmptyState({ kind, icon }: { kind: string; icon?: ReactNode }) {
  const { t } = useI18n();
  const rt = t.weldsuiteHome.runtime;
  const empty = rt.empty as Record<string, string>;
  const descriptions = (rt as unknown as { emptyDescription?: Record<string, string> }).emptyDescription ?? {};
  const title = empty[kind] ?? rt.noItems;
  const description = descriptions[kind];
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-8 text-center">
      <EmptyStateIllustration>
        {icon ?? (
          <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H96C98.2 34 100 35.8 100 38V92C100 94.2 98.2 96 96 96H24C21.8 96 20 94.2 20 92V30Z" className="fill-white dark:fill-white/[0.03]" />
            <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H20V30Z" className="fill-gray-50 dark:fill-white/[0.06]" />
            <path d="M20 30C20 27.8 21.8 26 24 26H48L54 34H96C98.2 34 100 35.8 100 38V92C100 94.2 98.2 96 96 96H24C21.8 96 20 94.2 20 92V30Z" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
            <rect x="32" y="46" width="34" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" opacity="0.5" />
            <rect x="32" y="53" width="24" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.35" />
            <rect x="32" y="63" width="30" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" opacity="0.4" />
            <rect x="32" y="70" width="20" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.25" />
            <rect x="32" y="80" width="26" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/20" opacity="0.3" />
            <rect x="32" y="87" width="16" height="2" rx="1" className="fill-gray-200 dark:fill-white/20" opacity="0.2" />
            <rect x="76" y="45" width="12" height="5" rx="2.5" className="fill-gray-100 dark:fill-white/15" />
            <rect x="76" y="62" width="12" height="5" rx="2.5" className="fill-gray-100 dark:fill-white/15" />
            <rect x="76" y="79" width="12" height="5" rx="2.5" className="fill-gray-100 dark:fill-white/15" />
          </svg>
        )}
      </EmptyStateIllustration>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
