/**
 * Stand-in for `@/components/object-panel` in the tests of record panels.
 *
 * The real module pulls in the panel host, the registry and the settings
 * queries behind the per-user tab visibility; a panel test only needs its
 * shell (fullscreen, so every tab shows), a plain tab strip with every tab
 * visible, and a recorded `open`. Use it as the factory of the mock:
 *
 *   vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
 *
 * Not a test file itself, and nothing in the app imports it.
 */

import { vi } from 'vitest';

/** Every `useObjectPanel().open(...)` call of the test. */
export const panelOpen = vi.fn();

interface ShellOptions {
  mode?: 'panel' | 'fullscreen';
  onClose?: () => void;
  loading?: boolean;
}

export function useObjectPanelShell({ mode = 'fullscreen', onClose, loading }: ShellOptions) {
  return {
    mode,
    setMode: vi.fn(),
    entityDetailViewProps: { mode, isOpen: true, onClose, onToggleExpand: vi.fn(), loading },
  };
}

export function ObjectPanelTabs({
  tabs,
  activeTab,
  onChange,
}: Readonly<{
  tabs: { id: string; label: string; count?: number }[];
  activeTab: string;
  onChange: (id: string) => void;
}>) {
  return (
    <div role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === activeTab}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function useObjectPanelTabConfig({ tabs }: Readonly<{ tabs: { id: string }[] }>) {
  return {
    visibility: Object.fromEntries(tabs.map((tab) => [tab.id, true])),
    isVisible: () => true,
    toggle: vi.fn(),
    resetToDefaults: vi.fn(),
  };
}

export function useObjectPanel() {
  return { open: panelOpen, close: vi.fn(), stack: [] };
}

export const useObjectPanelUrlSync = vi.fn();
export const registerObjectPanel = vi.fn();
