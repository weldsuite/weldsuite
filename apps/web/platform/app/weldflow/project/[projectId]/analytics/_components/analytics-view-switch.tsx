import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { usePathname } from '@/lib/router';
import { useProjectDelivery } from '@/hooks/queries/use-flow-agile-queries';
import { activeSubNavId, SubNavSwitch, type SubNavItem } from '@/app/weldflow/components/sub-nav';

/**
 * Sprints or Custom reports, first in the toolbar of both Analytics pages. Only
 * a project that plans in sprints has the Sprints page; for the others there is
 * no switch.
 */
export function AnalyticsViewSwitch({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useI18n();
  const pathname = usePathname();
  const delivery = useProjectDelivery(projectId);
  const basePath = `/weldflow/project/${projectId}/analytics`;
  const items = useMemo<SubNavItem[]>(
    () => [
      { id: 'sprints', label: t.flowAgile.views.sprints, path: '/sprints' },
      { id: 'custom', label: t.flowAgile.views.customReports, path: '' },
    ],
    [t],
  );
  if (!delivery.usesSprints) return null;
  return (
    <SubNavSwitch
      label={t.flowAgileSprints.analytics.switchLabel}
      basePath={basePath}
      items={items}
      activeId={activeSubNavId(pathname, basePath, items)}
    />
  );
}
