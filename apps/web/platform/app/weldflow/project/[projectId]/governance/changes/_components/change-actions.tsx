/**
 * What a member does to a change request from a list row or the panel header:
 * submit it, withdraw it, delete it, and the menu items that offer them. The
 * two that cannot be taken back (withdraw, delete) ask first, in the shared
 * confirm dialog.
 */

import { useState, type ReactNode } from 'react';
import { Pencil, Send, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@weldsuite/ui/components/dropdown-menu';
import type { ChangeRequest } from '@weldsuite/app-api-client/domains/flow-approvals';
import { useDeleteChangeRequest, useSubmitChangeRequest, useWithdrawChangeRequest } from '@/hooks/queries/use-flow-approvals-queries';
import { useI18n } from '@/lib/i18n/provider';
import type { ChangeAllowed } from './change-detail';

/** The part of a change the actions need to name it. */
export type ChangeTarget = Pick<ChangeRequest, 'id' | 'code' | 'title'>;

/** Whether the member may do anything to the change (an empty menu is not shown). */
export function hasAnyAction(allowed: ChangeAllowed): boolean {
  return allowed.edit || allowed.submit || allowed.withdraw || allowed.remove;
}

interface PendingConfirmation {
  kind: 'withdraw' | 'delete';
  change: ChangeTarget;
}

interface UseChangeActionsOptions {
  /** A change was deleted. */
  onDeleted?: (change: ChangeTarget) => void;
}

export interface ChangeActions {
  submit: (change: ChangeTarget) => void;
  /** Asks first; the change is withdrawn once the member confirms. */
  requestWithdraw: (change: ChangeTarget) => void;
  /** Asks first; the change is deleted once the member confirms. */
  requestDelete: (change: ChangeTarget) => void;
  isSubmitting: boolean;
  /** Render it once, next to whatever offers the actions. */
  confirmDialog: ReactNode;
}

export function useChangeActions({ onDeleted }: UseChangeActionsOptions = {}): ChangeActions {
  const { t, format } = useI18n();
  const copy = t.flowApprovals.changes;
  const submit = useSubmitChangeRequest();
  const withdraw = useWithdrawChangeRequest();
  const remove = useDeleteChangeRequest();
  const [confirming, setConfirming] = useState<PendingConfirmation | null>(null);

  const run = async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
    try {
      await action();
      toast.success(success);
      return true;
    } catch (error) {
      toast.error(isApiError(error) && error.message ? error.message : copy.actions.failed);
      return false;
    }
  };

  const confirm = async () => {
    if (!confirming) return;
    const { kind, change } = confirming;
    const done =
      kind === 'withdraw'
        ? await run(() => withdraw.mutateAsync(change.id), copy.actions.withdrawn)
        : await run(() => remove.mutateAsync(change.id), copy.actions.deleted);
    if (!done) return;
    setConfirming(null);
    if (kind === 'delete') onDeleted?.(change);
  };

  const isWithdraw = confirming?.kind === 'withdraw';
  const titleCopy = isWithdraw ? copy.actions.withdrawTitle : copy.actions.deleteTitle;
  const descriptionCopy = isWithdraw ? copy.actions.withdrawDescription : copy.actions.deleteDescription;
  const confirmDialog = (
    <ConfirmDialog
      open={confirming !== null}
      onOpenChange={(open) => (open ? undefined : setConfirming(null))}
      title={confirming ? format(titleCopy, { code: confirming.change.code }) : ''}
      description={confirming ? format(descriptionCopy, { title: confirming.change.title }) : ''}
      confirmLabel={isWithdraw ? copy.withdraw : copy.delete}
      cancelLabel={t.flowApprovals.common.cancel}
      variant="destructive"
      loading={withdraw.isPending || remove.isPending}
      onConfirm={confirm}
    />
  );

  return {
    submit: (change) => void run(() => submit.mutateAsync(change.id), copy.actions.submitted),
    requestWithdraw: (change) => setConfirming({ kind: 'withdraw', change }),
    requestDelete: (change) => setConfirming({ kind: 'delete', change }),
    isSubmitting: submit.isPending,
    confirmDialog,
  };
}

interface ChangeMenuItemsProps {
  allowed: ChangeAllowed;
  onEdit: () => void;
  onSubmit: () => void;
  onWithdraw: () => void;
  onDelete: () => void;
}

/** The items of a change's menu, as many as the member may use: edit, submit, withdraw, then delete. */
export function ChangeMenuItems({ allowed, onEdit, onSubmit, onWithdraw, onDelete }: Readonly<ChangeMenuItemsProps>) {
  const { t } = useI18n();
  const copy = t.flowApprovals.changes;
  return (
    <>
      {allowed.edit ? (
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil aria-hidden />
          {copy.edit}
        </DropdownMenuItem>
      ) : null}
      {allowed.submit ? (
        <DropdownMenuItem onSelect={onSubmit}>
          <Send aria-hidden />
          {copy.submit}
        </DropdownMenuItem>
      ) : null}
      {allowed.withdraw ? (
        <DropdownMenuItem onSelect={onWithdraw}>
          <Undo2 aria-hidden />
          {copy.withdraw}
        </DropdownMenuItem>
      ) : null}
      {allowed.remove ? (
        <>
          {allowed.edit || allowed.submit || allowed.withdraw ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 aria-hidden />
            {copy.delete}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}
