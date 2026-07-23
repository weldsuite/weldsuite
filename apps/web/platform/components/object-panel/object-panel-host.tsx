import { Suspense, useEffect, useRef } from 'react';
import { resolveObjectPanel } from './object-panel-registry';
import { useObjectPanel } from './use-object-panel';
import { usePathname } from '@/lib/router';

/**
 * Renders the object-panel stack as plain in-flow flex siblings. It's mounted
 * inside `ModuleContent`'s flex row (next to the module content and the drawer
 * host), so the panels sit in that row and the row's `gap` handles all spacing
 * — no absolute positioning, no width reservation, no drawer-inset math.
 *
 * Deeper panels render first (to the left), the top-of-stack last (to the
 * right). A `fullscreen` panel renders its own fixed overlay (see
 * `EntityDetailView`) and so drops out of the row, covering the content area.
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

  if (stack.length === 0) return null;

  return (
    <Suspense fallback={null}>
      {stack.map((handle, depth) => {
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
        const isTop = depth === stack.length - 1;
        return (
          <PanelComponent
            // Key by depth + identity so a "swap top of stack" remounts the
            // panel rather than mutating the existing one mid-render.
            key={`${depth}:${handle.type}:${handle.id}`}
            id={handle.id}
            isOpen
            onClose={isTop ? close : () => undefined}
            onBack={depth > 0 ? close : undefined}
            initialTab={handle.initialTab}
            mode={handle.mode}
            onModeChange={(next) => setMode(depth, next)}
            rightOffset={0}
          />
        );
      })}
    </Suspense>
  );
}
