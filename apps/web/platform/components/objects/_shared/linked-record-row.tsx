/**
 * The list row for a record linked to the one a panel shows: the people of a
 * company, the companies of a person.
 *
 * A `TabListRow` with four columns under a header row — name, a secondary
 * value, role, status — and a row menu in the gutter.
 * `linkedRecordHeaderColumns` returns the matching `headerColumns`.
 *
 * The secondary columns drop out by the list's own width, so the list must be
 * wrapped in `TabListScope`.
 */

import type { ReactNode } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { cn } from '@/lib/utils';
import { TabListRow } from './tab-list-row';
import type { HeaderColumn } from '@/components/entity-list';

const COLUMN = {
  name: 'min-w-0 flex-1',
  secondary: 'w-[200px] @max-[560px]:w-[140px]',
  role: 'w-[130px] @max-[820px]:hidden',
  status: 'w-[110px] @max-[560px]:hidden',
};

/** `headerColumns` for an `EntityList` whose rows are `LinkedRecordRow`s. */
export function linkedRecordHeaderColumns(labels: {
  name: string;
  secondary: string;
  role: string;
  status: string;
}): HeaderColumn[] {
  return [
    { id: 'name', header: labels.name, width: COLUMN.name },
    { id: 'secondary', header: labels.secondary, width: COLUMN.secondary },
    { id: 'role', header: labels.role, width: COLUMN.role },
    { id: 'status', header: labels.status, width: COLUMN.status },
  ];
}

const STATUS_TONE = {
  blue: 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-400',
  green: 'bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400',
  amber: 'bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-400',
  gray: 'bg-gray-100 dark:bg-secondary text-gray-600 dark:text-muted-foreground',
};

/**
 * A label for the status column: the same 22px tinted chip as a status in the
 * grids and the task rows.
 */
export function LinkedRecordStatus({
  tone,
  children,
}: Readonly<{ tone: keyof typeof STATUS_TONE; children: ReactNode }>) {
  return (
    <span
      className={cn(
        'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none flex-shrink-0',
        STATUS_TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

function Cell({ className, children }: Readonly<{ className: string; children?: ReactNode }>) {
  return (
    <div className={cn(className, 'min-w-0')}>
      <span className="block truncate text-sm text-muted-foreground">{children || '—'}</span>
    </div>
  );
}

export function LinkedRecordRow({
  name,
  avatarUrl,
  secondary,
  role,
  status,
  onOpen,
  menuLabel,
  menu,
}: Readonly<{
  name: string;
  avatarUrl?: string | null;
  secondary?: string | null;
  role?: string | null;
  /** `LinkedRecordStatus` labels for the status column. */
  status?: ReactNode;
  onOpen: () => void;
  /** Accessible name of the row menu button. */
  menuLabel: string;
  /** `DropdownMenuItem`s of the row menu. */
  menu: ReactNode;
}>) {
  return (
    <TabListRow label={name} onOpen={onOpen} menuLabel={menuLabel} menu={menu}>
      <div className={cn(COLUMN.name, 'flex items-center gap-2')}>
        <Avatar className="h-[18px] w-[18px] !rounded-[6px] flex-shrink-0">
          {avatarUrl && <AvatarImage src={avatarUrl} alt={name} className="!rounded-[6px] object-cover" />}
          <AvatarFallback className="!rounded-[6px] text-[9px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
            {(name.trim()[0] ?? '?').toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
      </div>
      <Cell className={COLUMN.secondary}>{secondary}</Cell>
      <Cell className={COLUMN.role}>{role}</Cell>
      <div className={cn(COLUMN.status, 'flex items-center gap-1 min-w-0')}>
        {status || <span className="text-sm text-muted-foreground">—</span>}
      </div>
    </TabListRow>
  );
}
