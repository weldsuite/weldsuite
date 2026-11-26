/**
 * The popup's tools, behind the tools icon in the header: a list in the
 * platform's row-list style, each row opening its tool in the popup.
 *
 * - Password generator: the generator.
 * - Password health: the platform's report (weak, reused and old logins),
 *   from the same `/password-health` endpoint, without a single password.
 * - Data breach scanner: not built yet on either backend, so it says so.
 */

import type { ComponentType, ReactNode } from 'react';
import { ChevronRight, HeartPulse, ShieldAlert, WandSparkles } from 'lucide-react';
import type {
  WeldPassHealthEntry,
  WeldPassPasswordIssue,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@weldsuite/ui/lib/utils';
import { openTab } from '../lib/chrome-page';
import { t, type MessageKey } from '../lib/i18n';
import type { PopupApi } from './api';
import { useAsync } from './hooks';
import { Empty, LoadError, Padded, Section, SiteIcon } from './list';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';

export type ToolView = 'generator' | 'health';

interface Tool {
  view: ToolView | null;
  icon: ComponentType<{ className?: string }>;
  title: MessageKey;
  body: MessageKey;
}

const TOOLS: Tool[] = [
  { view: 'generator', icon: WandSparkles, title: 'toolGenerator', body: 'toolGeneratorBody' },
  { view: 'health', icon: HeartPulse, title: 'toolHealth', body: 'toolHealthBody' },
  // No backend has a breach check yet.
  { view: null, icon: ShieldAlert, title: 'toolBreach', body: 'toolBreachBody' },
];

/** The icon tile, as the login rows' site icon. */
function ToolIcon({ icon: Icon }: Readonly<{ icon: Tool['icon'] }>) {
  return (
    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border bg-card">
      <Icon className="size-4 text-muted-foreground" />
    </span>
  );
}

export function ToolsList({ onOpen }: Readonly<{ onOpen: (view: ToolView) => void }>) {
  return (
    <ul>
        {TOOLS.map((tool) => {
          const available = tool.view !== null;
          return (
            <li key={tool.title}>
              <button
                type="button"
                disabled={!available}
                onClick={() => tool.view && onOpen(tool.view)}
                className={cn(
                  'flex w-full items-center gap-2.5 border-b border-border/70 px-3 py-2 text-left transition-colors',
                  available ? 'hover:bg-muted/40' : 'cursor-default',
                )}
              >
                <ToolIcon icon={tool.icon} />
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate font-medium', !available && 'text-muted-foreground')}>
                    {t(tool.title)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{t(tool.body)}</span>
                </span>
                {available ? (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <Badge variant="secondary">{t('comingSoon')}</Badge>
                )}
              </button>
            </li>
          );
        })}
    </ul>
  );
}

const ISSUE_ORDER: WeldPassPasswordIssue[] = ['weak', 'reused', 'old'];

/** As on the platform's health page. */
const ISSUE_VARIANT = { weak: 'destructive', reused: 'warning', old: 'secondary' } as const;

function issueLabel(entry: WeldPassHealthEntry, issue: WeldPassPasswordIssue): string {
  if (issue === 'reused') return t('healthReusedOn', entry.reuseCount);
  return t(issue === 'weak' ? 'healthWeak' : 'healthOld');
}

function Stat({ label, value, tone }: Readonly<{ label: string; value: ReactNode; tone?: string }>) {
  return (
    <div className="rounded-[10px] border bg-card px-2.5 py-2">
      <div className={cn('text-base font-semibold tabular-nums', tone)}>{value}</div>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

/** The platform's password health report, in the popup. */
export function HealthView({ api, serverOrigin }: Readonly<{ api: PopupApi; serverOrigin: string }>) {
  const report = useAsync(async () => (await api.passwordHealth()).data, 'health');

  if (report.loading) {
    return (
      <Padded>
        <InlineSpinner label={t('loading')} className="py-0" />
      </Padded>
    );
  }
  if (report.error || !report.data) {
    return <LoadError error={report.error} onRetry={report.reload} />;
  }

  const { checked, healthy, weak, reused, old, items } = report.data;
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-4 gap-2 px-3 py-3">
        <Stat label={t('healthHealthy')} value={`${healthy}/${checked}`} />
        <Stat label={t('healthWeak')} value={weak} tone={weak > 0 ? 'text-destructive' : undefined} />
        <Stat label={t('healthReused')} value={reused} tone={reused > 0 ? 'text-amber-600 dark:text-amber-400' : undefined} />
        <Stat label={t('healthOld')} value={old} />
      </div>

      <Section title={t('healthAttention')} count={items.length}>
        {checked === 0 ? (
          <Empty>{t('healthEmpty')}</Empty>
        ) : items.length === 0 ? (
          <Empty>{t('healthAllHealthy')}</Empty>
        ) : (
          <ul>
            {items.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-2.5 border-b border-border/70 px-3 py-2"
              >
                <SiteIcon url={entry.url} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{entry.title}</div>
                  <div className="truncate text-xs text-muted-foreground">{entry.subtitle || entry.host || '—'}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {ISSUE_ORDER.filter((issue) => entry.issues.includes(issue)).map((issue) => (
                    <Badge key={issue} variant={ISSUE_VARIANT[issue]}>
                      {issueLabel(entry, issue)}
                    </Badge>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {items.length > 0 && (
        <div className="px-3 py-3">
          <Button
            variant="outline"
            className="h-8 w-full text-sm shadow-none"
            onClick={() => openTab(new URL('/weldpass/passwords/health', serverOrigin).href)}
          >
            {t('healthFixInWebApp')}
          </Button>
        </div>
      )}
    </div>
  );
}
