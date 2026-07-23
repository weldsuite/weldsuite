import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import type { ObjectPanelTabDescriptor } from './types';

interface ObjectPanelTabsProps {
  tabs: ObjectPanelTabDescriptor[];
  activeTab: string;
  onChange: (tabId: string) => void;
  className?: string;
}

/**
 * Tab bar for object panels. Wraps the platform's `PageTabs` so every object
 * panel renders tabs with identical styling without each one re-deriving the
 * same markup.
 */
export function ObjectPanelTabs({ tabs, activeTab, onChange, className }: ObjectPanelTabsProps) {
  const visible = tabs.filter((t) => !t.hidden);
  const mapped: PageTab[] = visible.map((t) => ({
    id: t.id,
    label: t.label,
    icon: t.icon,
    count: t.count,
  }));
  return (
    <PageTabs
      tabs={mapped}
      activeTab={activeTab}
      onTabChange={onChange}
      className={className}
      overflow="dropdown"
      // `pr-12` reserves room on the right edge for the hover-revealed
      // "visible tabs" settings gear so the "+N more" button never sits under it.
      innerClassName="pl-3 md:pl-4 pr-12 pt-2"
    />
  );
}
