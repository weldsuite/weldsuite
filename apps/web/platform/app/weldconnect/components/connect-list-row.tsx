/**
 * The row of every WeldConnect list (workflows, executions, templates,
 * variables, webhooks), in the WeldFlow task-row style: one line per record,
 * the task row's spacing, divider and hover, a fixed 53px height, a whole-row
 * click target and a three-dot menu that shows on hover.
 *
 * Cells go in as `ConnectRowCell`s whose widths match the page's
 * `headerColumns`. EntityList appends a 40px spacer to its header for the row
 * menu, so pages never add an "actions" header column of their own.
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
import { RowOverlayButton, ROW_CELL_PASSTHROUGH } from '@/components/shared/row-overlay-button';

export {
  RowTitle,
  RowChip,
  RowNumberChip,
  RowText,
  RowDate,
  StatusChip,
  EmptyCell,
  type ChipTone,
} from '@/components/accounting/weldbooks-row-cells';

/** Destructive menu item colours, matching the other platform row menus. */
export const DESTRUCTIVE_MENU_ITEM =
  'text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400 [&_svg]:text-red-600 dark:[&_svg]:text-red-400';

export function ConnectListRow({
  label,
  onOpen,
  menu,
  selected,
  className,
  children,
}: Readonly<{
  /** Accessible name of the row's click target, usually the record's name. */
  label: string;
  onOpen?: () => void;
  /** The row menu, usually a `ConnectRowMenu`. */
  menu?: ReactNode;
  selected?: boolean;
  className?: string;
  children: ReactNode;
}>) {
  return (
    <div
      className={cn(
        'group relative flex items-center gap-4 px-4 py-3 border-b border-gray-200/70 dark:border-border',
        onOpen && 'cursor-pointer hover:bg-gray-50 dark:hover:bg-secondary/50',
        selected && 'bg-primary/5 dark:bg-primary/10',
        className,
      )}
    >
      {onOpen ? <RowOverlayButton label={label} onClick={onOpen} /> : null}
      {children}
      {/* h-7 matches the task row's menu button, so rows share its fixed 53px height. */}
      <div className="relative z-[1] flex h-7 w-[40px] flex-shrink-0 items-center justify-end">{menu}</div>
    </div>
  );
}

/** One cell of a `ConnectListRow`: vertically centred, truncating, click-through to the row. */
export function ConnectRowCell({
  width,
  className,
  children,
}: Readonly<{ width: string; className?: string; children?: ReactNode }>) {
  return <div className={cn('flex min-w-0 items-center gap-2', ROW_CELL_PASSTHROUGH, width, className)}>{children}</div>;
}

/** The hover three-dot menu at the end of a `ConnectListRow`. */
export function ConnectRowMenu({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={label}
          className="h-7 w-7 p-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent"
        >
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
