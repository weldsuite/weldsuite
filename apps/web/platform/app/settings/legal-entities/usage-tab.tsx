import type { ReactNode } from 'react';
import { Database } from 'lucide-react';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useLegalEntityUsage } from '@/hooks/queries/use-legal-entities-queries';
import { useI18n } from '@/lib/i18n/provider';

export function UsageTab({ entityId }: Readonly<{ entityId: string }>) {
  const { t } = useI18n();
  const tu = t.settings.legalEntities.usage;
  const appLabels = t.settings.legalEntities.apps as Record<string, string>;
  const { data, isLoading, error, refetch } = useLegalEntityUsage(entityId);

  let body: ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} className="min-h-[120px] pb-0" />;
  } else if (error) {
    body = <ErrorState message={tu.loadFailed} onRetry={() => refetch()} />;
  } else if (!data || data.length === 0) {
    body = <EmptyText>{tu.empty}</EmptyText>;
  } else {
    body = (
      <ul className="divide-y rounded-md border">
        {data.map((row) => (
          <li key={row.app} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">{appLabels[row.app] ?? row.app}</p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {row.hasData && <Database className="h-3.5 w-3.5" />}
                {row.hasData ? tu.hasData : tu.noData}
              </p>
            </div>
            <SoftBadge tone={row.enabled ? 'success' : 'neutral'}>{row.enabled ? tu.enabled : tu.notEnabled}</SoftBadge>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <SectionCard title={tu.title} description={tu.description} className="max-w-3xl">
      {body}
    </SectionCard>
  );
}
