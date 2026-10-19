/**
 * Pieces the agency panel's jurisdictions, zones and rules tabs share: the
 * intro line with its "Add" button, the load error, and the menu of a row.
 */

import type { ReactNode } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';

/** What the tab is for, in a line or two, and the button that adds to it. */
export function AgencyTabIntro({
  intro,
  addLabel,
  onAdd,
}: Readonly<{
  intro: ReactNode;
  /** Set when the member may add and there is something to add to. */
  addLabel?: string;
  onAdd?: () => void;
}>) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4">
      <div className="min-w-0 space-y-1 text-sm text-muted-foreground">{intro}</div>
      {addLabel && onAdd ? (
        <Button type="button" size="sm" className="flex-shrink-0" onClick={onAdd}>
          <Plus className="h-4 w-4" aria-hidden />
          {addLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function AgencyTabLoadError({
  message,
  retryLabel,
  onRetry,
}: Readonly<{ message: string; retryLabel: string; onRetry: () => void }>) {
  return (
    <div className="p-4">
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>{message}</span>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

/** The items of a row's menu: edit and delete, each only for a member who may. `undefined` when neither. */
export function rowMenuItems({
  canUpdate,
  canDelete,
  editLabel,
  deleteLabel,
  onEdit,
  onDelete,
  leading,
}: Readonly<{
  canUpdate: boolean;
  canDelete: boolean;
  editLabel: string;
  deleteLabel: string;
  onEdit: () => void;
  onDelete: () => void;
  /** Items before edit and delete (a jurisdiction's "Add rate"). */
  leading?: ReactNode;
}>): ReactNode {
  if (!leading && !canUpdate && !canDelete) return undefined;
  return (
    <>
      {leading}
      {canUpdate ? (
        <DropdownMenuItem onClick={onEdit}>
          <Pencil />
          {editLabel}
        </DropdownMenuItem>
      ) : null}
      {canDelete ? (
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 />
          {deleteLabel}
        </DropdownMenuItem>
      ) : null}
    </>
  );
}
