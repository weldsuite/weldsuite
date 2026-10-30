/**
 * The row shell for the lists inside a company / person panel tab.
 *
 * It is the standard `EntityList` row: the spacing, divider and hover of a task
 * row, a click target stretched over the whole row, and a row menu in the
 * 40px gutter that `EntityList` reserves at the end of its header row. The
 * caller renders the cells as children, with the same widths as its
 * `headerColumns`.
 */

import type { ReactNode } from 'react';
import { EllipsisVertical } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import { RowOverlayButton } from '@/components/shared/row-overlay-button';

/**
 * The container a list's columns measure themselves against. Columns that drop
 * out or narrow in a side panel do so by the list's own width (`@max-[…]:`),
 * not the viewport's — a panel is far narrower than the window it sits in.
 */
export function TabListScope({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="@container min-w-0 w-full">{children}</div>;
}

export function TabListRow({
  label,
  onOpen,
  menuLabel,
  menu,
  children,
  className,
}: Readonly<{
  /** Accessible name of the row's click target, e.g. the record's name. */
  label: string;
  /** Makes the whole row clickable. */
  onOpen?: () => void;
  /** Accessible name of the row menu button. */
  menuLabel?: string;
  /** `DropdownMenuItem`s of the row menu; the gutter stays empty without them. */
  menu?: ReactNode;
  /** The row's cells. */
  children: ReactNode;
  /** Extra classes for the row, e.g. less padding in a narrow side panel. */
  className?: string;
}>) {
  return (
    <div
      className={cn(
        'group relative flex items-center gap-4 px-4 py-3 border-b border-gray-200/70 dark:border-border hover:bg-gray-50 dark:hover:bg-secondary/50',
        onOpen && 'cursor-pointer',
        className,
      )}
    >
      {onOpen && <RowOverlayButton label={label} onClick={onOpen} />}
      {children}
      {/* h-7 = the menu button's height: it sets the row's height, so the row is
          as tall with the button hidden and whatever its cells hold. */}
      <div className="relative z-[1] w-[40px] h-7 flex items-center justify-end flex-shrink-0">
        {menu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent"
              aria-label={menuLabel}
            >
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
        </DropdownMenu>
        )}
      </div>
    </div>
  );
}
