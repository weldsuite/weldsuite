import { Suspense, useCallback, useEffect, useRef } from 'react';
import { resolveObjectPanel } from './object-panel-registry';
import { useObjectPanel } from './use-object-panel';
import {
  useObjectPanelNavigationControls,
  useObjectPanelNavigationShortcuts,
  type ObjectPanelRef,
} from './use-object-panel-navigation';
import { ObjectPanelActiveTabContext } from './object-panel-active-tab';
import { usePathname } from '@/lib/router';

/**
 * Renders the object panel as a plain in-flow flex sibling. It's mounted
 * inside `ModuleContent`'s flex row right after the module content, directly
 * on the shell background, and attaches with a `border-l` divider — no
 * absolute positioning, no width reservation, no drawer-inset math.
 *
 * Only the top of the stack is rendered: there is never more than one panel
 * on screen. Opening a panel from inside another swaps the content in place
 * and gives the new panel a back chevron that returns to the previous one.
 * A `fullscreen` panel renders its own fixed overlay (see `EntityDetailView`).
 *
 * When the panel was opened from a list (see `use-object-panel-navigation`),
 * it also gets previous / next arrows and the J / K shortcuts.
 *
 * Renders nothing while the stack is empty.
 */
export function ObjectPanelHost() {
  const { stack, close, closeAll, setMode, replaceTop } = useObjectPanel();

  // Close the entire panel stack whenever the user navigates to a different
  // page. Query-param changes are ignored — only pathname transitions.
  const pathname = usePathname();
  const lastPathname = useRef(pathname);
  useEffect(() => {
    if (lastPathname.current !== pathname) {
      lastPathname.current = pathname;
      if (stack.length > 0) closeAll();
    }
  }, [pathname, stack.length, closeAll]);

  const handle = stack.at(-1);
  const depth = stack.length - 1;
  const panelKey = handle ? `${depth}:${handle.type}:${handle.id}` : '';

  // The tab the open panel shows, so previous / next keep it.
  const activeTabRef = useRef<{ panelKey: string; tabId: string } | null>(null);
  const reportActiveTab = useCallback(
    (tabId: string) => {
      activeTabRef.current = { panelKey, tabId };
    },
    [panelKey],
  );

  const handleType = handle?.type;
  const showObject = useCallback(
    (target: ObjectPanelRef) => {
      const activeTab = activeTabRef.current;
      // Tab ids are per object type: a mixed list (companies and people)
      // opens the other type on its default tab.
      const keepTab = target.type === handleType && activeTab?.panelKey === panelKey;
      replaceTop({ ...target, initialTab: keepTab ? activeTab.tabId : undefined });
    },
    [replaceTop, panelKey, handleType],
  );
  const navigation = useObjectPanelNavigationControls(handle, showObject);
  useObjectPanelNavigationShortcuts(navigation);

  if (!handle) return null;

  const definition = resolveObjectPanel(handle.type);
  if (!definition) {
    if (typeof console !== 'undefined') {
      console.warn(
        `[ObjectPanelHost] No panel registered for type "${handle.type}"`,
      );
    }
    return null;
  }
  const PanelComponent = definition.component;

  return (
    <Suspense fallback={null}>
      <ObjectPanelActiveTabContext.Provider value={reportActiveTab}>
        <PanelComponent
          // Key by depth + identity so swapping the top of the stack remounts
          // the panel rather than mutating the existing one mid-render.
          key={panelKey}
          id={handle.id}
          isOpen
          // The close button dismisses the panel entirely; the back chevron
          // (only when it was opened from another panel) steps back one level.
          onClose={closeAll}
          onBack={depth > 0 ? close : undefined}
          initialTab={handle.initialTab}
          mode={handle.mode}
          onModeChange={(next) => setMode(depth, next)}
          navigation={navigation}
        />
      </ObjectPanelActiveTabContext.Provider>
    </Suspense>
  );
}
