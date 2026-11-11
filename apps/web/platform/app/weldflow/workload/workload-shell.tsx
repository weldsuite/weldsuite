/**
 * The Workload page around its two views: everyone's tasks on a timeline, and
 * capacity (booked hours against contract hours, with the resource requests).
 * Capacity is for portfolio readers; without that there is no switch.
 */

import { useMemo, type ReactNode } from 'react';
import { usePermissions } from '@weldsuite/permissions/react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { usePathname } from '@/lib/router';
import { activeSubNavId, SubNavSwitch, type SubNavItem } from '../components/sub-nav';

const BASE_PATH = '/weldflow/workload';

/** Timeline or Capacity, first in the view's toolbar. */
export function WorkloadViewSwitch() {
  const t = useI18n().t.projects.workload;
  const { can } = usePermissions();
  const pathname = usePathname();
  const items = useMemo<SubNavItem[]>(
    () => [
      { id: 'timeline', label: t.timeline, path: '' },
      { id: 'capacity', label: t.capacity, path: '/capacity' },
    ],
    [t],
  );
  if (!can('portfolio:read')) return null;
  return <SubNavSwitch label={t.title} basePath={BASE_PATH} items={items} activeId={activeSubNavId(pathname, BASE_PATH, items)} />;
}

/** The page frame both views share: edge to edge, the full height, one breadcrumb. */
export function WorkloadShell({ children }: Readonly<{ children: ReactNode }>) {
  const t = useI18n().t.projects.workload;
  useBreadcrumbs([{ label: t.projects, href: '/weldflow' }, { label: t.title }]);
  return <div className="-mx-3 md:-mx-4 -mt-3 md:-mt-4 flex h-[calc(100vh-60px)] flex-col">{children}</div>;
}
