import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { ProjectSubNavLayout, type SubNavItem } from '@/app/weldflow/components/sub-nav';

/**
 * The Gantt tab: the baseline chart, task dependencies, and phases and gates.
 * The baseline chart lays itself out edge to edge; the other sub-pages get the
 * padded, scrolling content area.
 */
export default function GanttLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { t } = useI18n();
  const copy = t.projects.subNav.gantt;
  const items: SubNavItem[] = [
    { id: 'baseline', label: copy.baseline, path: '' },
    { id: 'dependencies', label: copy.dependencies, path: '/dependencies' },
    { id: 'phases', label: copy.phases, path: '/phases' },
  ];
  return (
    <ProjectSubNavLayout section="gantt" label={copy.label} items={items} fullBleedId="baseline">
      {children}
    </ProjectSubNavLayout>
  );
}
