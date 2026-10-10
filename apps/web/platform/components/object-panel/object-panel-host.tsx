import { Suspense, useEffect, useRef } from 'react';
import { resolveObjectPanel } from './object-panel-registry';
import { useObjectPanel } from './use-object-panel';
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
 * Renders nothing while the stack is empty.
 */
export function ObjectPanelHost() {
  const { stack, close, closeAll, setMode } = useObjectPanel();

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
  const depth = stack.length - 1;

  return (
    <Suspense fallback={null}>
      <PanelComponent
        // Key by depth + identity so swapping the top of the stack remounts
        // the panel rather than mutating the existing one mid-render.
        key={`${depth}:${handle.type}:${handle.id}`}
        id={handle.id}
        isOpen
        // The close button dismisses the panel entirely; the back chevron
        // (only when it was opened from another panel) steps back one level.
        onClose={closeAll}
        onBack={depth > 0 ? close : undefined}
        initialTab={handle.initialTab}
        mode={handle.mode}
        onModeChange={(next) => setMode(depth, next)}
      />
    </Suspense>
  );
}
