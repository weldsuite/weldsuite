/**
 * The tab strip of an object panel with the "Visible tabs" gear: the tabs a
 * member sees are remembered per object type and per mode (side panel or
 * fullscreen), starting from each tab's default for that mode.
 */

import { useEffect, useMemo } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import {
  ObjectPanelTabs,
  useObjectPanelTabConfig,
  type ObjectPanelTabDescriptor,
} from '@/components/object-panel';

export interface ConfigurablePanelTab<TId extends string = string> extends ObjectPanelTabDescriptor {
  id: TId;
  /** Cannot be switched off. */
  required?: boolean;
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
}

export function ConfigurablePanelTabs<TId extends string>({
  objectType,
  tabs,
  activeTab,
  setActiveTab,
  mode,
}: Readonly<{
  objectType: string;
  tabs: ConfigurablePanelTab<TId>[];
  activeTab: TId;
  setActiveTab: (id: TId) => void;
  mode: 'panel' | 'fullscreen';
}>) {
  const st = useTranslations();
  const configEntries = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        required: tab.required,
        defaultVisible:
          mode === 'panel' ? (tab.defaultVisibleInPanel ?? false) : (tab.defaultVisibleInFullscreen ?? false),
      })),
    [tabs, mode],
  );

  const { visibility, isVisible, toggle, resetToDefaults } = useObjectPanelTabConfig({
    objectType,
    mode,
    tabs: configEntries,
  });

  // The open tab was switched off (or never applied to this record): fall back to the first visible one.
  useEffect(() => {
    if (isVisible(activeTab)) return;
    const fallback = tabs.find((tab) => isVisible(tab.id));
    if (fallback && fallback.id !== activeTab) setActiveTab(fallback.id);
  }, [activeTab, isVisible, setActiveTab, tabs]);

  const visibleTabs = useMemo(
    () =>
      tabs
        .filter((tab) => isVisible(tab.id))
        .map((tab) => ({ id: tab.id, label: tab.label, icon: tab.icon, count: tab.count })),
    [tabs, isVisible],
  );

  return (
    <div className="group/tabs-header relative">
      <ObjectPanelTabs tabs={visibleTabs} activeTab={activeTab} onChange={(id) => setActiveTab(id as TId)} />
      <div className="absolute top-0 right-2 h-full flex items-center opacity-0 group-hover/tabs-header:opacity-100 focus-within:opacity-100 transition-opacity">
        <DrawerFieldSettings
          fields={configEntries}
          fieldVisibility={visibility}
          onToggle={toggle}
          onReset={resetToDefaults}
          label={st('sweep.entities.visibleTabs')}
        />
      </div>
    </div>
  );
}
