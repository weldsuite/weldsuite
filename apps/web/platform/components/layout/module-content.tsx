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
   * module content and the object-panel stack — e.g. the WeldCalendar event
   * panel. Each should be a `shrink-0` in-flow column with a `border-l` and no
   * card chrome, so it lays out exactly like the object panel does.
   */
  aside?: React.ReactNode;
}

/**
 * The content row for a module page. Sits BELOW the module's full-width header.
 * The module content, any module-owned aside panel(s) and the object-panel
 * stack sit directly on the shell background — no card, no inset — separated
 * only by the panels' `border-l` divider. Open top-nav drawers attach the same
 * way on the right:
 *
 *   ┌ header (full width, rendered by the module layout) ──────┐
 *   ├──────────────────────────────────────────────────────────┤
 *   │  content (flex-1) │ aside │ panel…     [ drawer ]         │  ← this row
 *   └──────────────────────────────────────────────────────────┘
 *
 * `--background` is remapped to the shell's panel tone for the whole row, so
 * every `bg-background` surface inside pages and panels (sticky headers,
 * lists, fullscreen panels…) matches the background instead of reading as a
 * card. Portaled popovers and dialogs live outside the group and keep the
 * regular colour.
 *
 * Everything is flex — the content shrinks automatically as panels/drawers
 * open. No absolute positioning, no width reservation, no drawer-inset math.
 *
 * Module layouts render `<ModuleContent>{page}</ModuleContent>` in place of the
 * old `<div data-module-content style={{ width }}>` wrapper.
 */
const ON_BACKGROUND_STYLE = {
  '--background': 'var(--shell-panel)',
} as React.CSSProperties;

export function ModuleContent({ children, className, aside }: ModuleContentProps) {
  return (
    <div className="flex min-h-0 flex-1" style={ON_BACKGROUND_STYLE}>
      <div className="flex min-w-0 flex-1">
        <div
          data-module-content
          className={cn('flex min-w-0 flex-1 flex-col overflow-hidden bg-background', className)}
        >
          {children}
        </div>
        {aside}
        <ObjectPanelHost />
      </div>
      <div className="flex shrink-0 empty:hidden">
        <DrawerHost />
      </div>
    </div>
  );
}
