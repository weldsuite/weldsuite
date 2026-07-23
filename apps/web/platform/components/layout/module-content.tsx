import * as React from 'react';
import { cn } from '@/lib/utils';
import { ObjectPanelHost } from '@/components/object-panel';
import { DrawerHost } from './drawer-host';

interface ModuleContentProps {
  children: React.ReactNode;
  /** Extra classes for the white content card (rarely needed). */
  className?: string;
  /**
   * Optional module-owned side panel(s) rendered as flex siblings between the
   * content card and the global object-panel / drawer hosts — e.g. WeldChat's
   * member-profile panel or WeldMail's customer panel. Each should be a
   * `shrink-0` in-flow card so it lays out in the row exactly like the object
   * panel does.
   */
  aside?: React.ReactNode;
}

/**
 * The content row for a module page. Sits BELOW the module's full-width header
 * and lays out — as real flex siblings with a uniform gap — the module content,
 * any module-owned aside panel(s), the object-panel stack, and any open top-nav
 * drawer:
 *
 *   ┌ header (full width, rendered by the module layout) ┐
 *   ├──────────────────────────────────────────────────┤
 *   │  [ content (flex-1) ] [ aside ] [ panel… ] [ drawer ] │  ← this row
 *   └──────────────────────────────────────────────────┘
 *
 * Everything is flex — the content shrinks automatically as panels/drawers
 * open, and the `gap` is the single source of spacing. No absolute positioning,
 * no width reservation, no drawer-inset math.
 *
 * Module layouts render `<ModuleContent>{page}</ModuleContent>` in place of the
 * old `<div data-module-content style={{ width }}>` wrapper.
 */
export function ModuleContent({ children, className, aside }: ModuleContentProps) {
  return (
    <div className="flex min-h-0 flex-1 gap-2 p-2">
      <div
        data-module-content
        className={cn(
          'flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-background',
          className,
        )}
      >
        {children}
      </div>
      {aside}
      <ObjectPanelHost />
      <DrawerHost />
    </div>
  );
}
