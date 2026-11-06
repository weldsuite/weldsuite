/**
 * The pieces of a WeldFlow list row, sized as the cells of a task row (My
 * tasks): the row itself, its click target and menu button, and the cells.
 * Every register built on `EntityList` (the RAID log, Governance) uses them,
 * so the rows read the same everywhere.
 */

import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { EllipsisVertical } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';

/** A row: one line, the task-row spacing, divider and hover. Add `LIST_ROW_SELECTED_CLASS` for the open record. */
export const LIST_ROW_CLASS =
  'group relative flex cursor-pointer items-center gap-4 border-b border-gray-200/70 px-4 py-3 hover:bg-gray-50 dark:border-border dark:hover:bg-secondary/50';
export const LIST_ROW_SELECTED_CLASS = 'bg-gray-50 dark:bg-secondary/50';
/** A cell; its width (and `hidden @3xl:flex` breakpoint) comes from the column. */
export const LIST_CELL_CLASS = 'flex min-w-0 items-center';
/** The menu cell at the end of a row, above the click target; as tall as the menu button, so a row without one keeps the height. */
export const LIST_MENU_CELL_CLASS = 'relative z-[1] flex h-7 w-[40px] items-center justify-end';

/** The whole-row click target: a stretched button under the cells; the menu cell sits above it. */
export function ListRowTarget({ label, onClick }: Readonly<{ label: string; onClick: () => void }>) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="absolute inset-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    />
  );
}

/** The three-dot button of a row menu, shown on hover (use as a `DropdownMenuTrigger` child). */
export const ListRowMenuButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Button> & { label: string }>(
  function ListRowMenuButton({ label, className, ...props }, ref) {
    return (
      <Button
        ref={ref}
        variant="ghost"
        size="sm"
        aria-label={label}
        className={cn(
          'h-7 w-7 p-0 text-gray-400 opacity-0 group-hover:opacity-100 hover:text-gray-600 focus-visible:opacity-100 data-[state=open]:opacity-100',
          className,
        )}
        {...props}
      >
        <EllipsisVertical className="h-3.5 w-3.5" />
      </Button>
    );
  },
);

/** A record code (`DEC-3`, `RSK-1`) as a task's number badge. */
export function ListCode({ code }: Readonly<{ code: string }>) {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center rounded bg-gray-100 px-1.5 font-mono text-[11px] leading-none text-gray-500 dark:bg-secondary dark:text-muted-foreground">
      {code}
    </span>
  );
}

/** The first cell of a row: the code (if any) and the title on one line. */
export function ListTitle({ code, title }: Readonly<{ code?: string | null; title: string }>) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      {code ? <ListCode code={code} /> : null}
      <span className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-foreground">{title}</span>
    </div>
  );
}

/** Secondary text of a row: `text-sm`, muted, one line; an em dash when empty. */
export function ListText({ text }: Readonly<{ text: string | null | undefined }>) {
  return <span className="block truncate text-sm text-gray-600 dark:text-muted-foreground">{text || '—'}</span>;
}

/** A pill of a row, the shape of a task's status and priority pills. `className` carries the colours. */
export function ListPill({ className, children }: Readonly<{ className: string; children: ReactNode }>) {
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 text-[12px] font-medium', className)}>
      {children}
    </span>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
}

/** A person of a row, as a task's assignee: a 20px avatar and the first name (the full name on hover). */
export function ListPerson({ name, avatar }: Readonly<{ name: string | null | undefined; avatar?: string | null }>) {
  if (!name) return <ListText text={null} />;
  return (
    <span className="flex min-w-0 items-center" title={name}>
      <Avatar aria-hidden className="size-5 shrink-0">
        {avatar ? <AvatarImage src={avatar} alt="" /> : null}
        <AvatarFallback className="bg-muted text-[10px] font-semibold text-foreground/80">{initialsOf(name)}</AvatarFallback>
      </Avatar>
      <span className="ml-1.5 truncate text-sm text-gray-600 dark:text-muted-foreground">{name.split(' ')[0]}</span>
    </span>
  );
}
