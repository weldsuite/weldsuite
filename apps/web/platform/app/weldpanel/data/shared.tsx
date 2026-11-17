/** Pieces the Data tabs share: a row's actions menu and reading a 409 (a name already taken). */

import { MoreHorizontal } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';

export function isConflict(error: unknown): boolean {
  return isApiError(error) && error.status === 409;
}

export interface DataTabPermissions {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

/** Edit and delete for one row; renders nothing when the viewer may do neither. */
export function RowActions({ name, onEdit, onDelete, editLabel }: Readonly<{ name: string; onEdit?: () => void; onDelete?: () => void; editLabel?: string }>) {
  const { t, format } = useI18n();
  const tc = t.weldpanel.analytics.common;
  if (!onEdit && !onDelete) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={format(t.weldpanel.explore.data.actions, { name })}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onEdit && <DropdownMenuItem onSelect={onEdit}>{editLabel ?? tc.edit}</DropdownMenuItem>}
        {onDelete && (
          <DropdownMenuItem className="text-destructive" onSelect={onDelete}>
            {tc.delete}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
