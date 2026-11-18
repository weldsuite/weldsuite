/**
 * Asks before a commerce list deletes a row, with the library `ConfirmDialog`
 * rather than the browser's `window.confirm`. `request(row)` opens it; the
 * `dialog` element is rendered once next to the list. `onDelete` does the
 * delete (and its toasts); the dialog closes either way.
 */

import { useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { getTranslations } from '@/lib/i18n';

export function useConfirmDelete<T>({
  title,
  name,
  onDelete,
}: Readonly<{
  /** The question, such as "Delete this product?". */
  title: string;
  /** What the row is called, for "… will be deleted". */
  name: (row: T) => string;
  onDelete: (row: T) => Promise<void>;
}>): { request: (row: T) => void; dialog: ReactNode } {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const [pending, setPending] = useState<T | null>(null);

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
      title={title}
      description={pending === null ? '' : t.common.deleteDescription.replace('{name}', name(pending))}
      variant="destructive"
      confirmLabel={tc.actions.delete}
      cancelLabel={tc.actions.cancel}
      onConfirm={async () => {
        if (pending === null) return;
        try {
          await onDelete(pending);
        } finally {
          setPending(null);
        }
      }}
    />
  );

  return { request: setPending, dialog };
}
