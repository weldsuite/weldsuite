/**
 * The selection-bar actions the Companies and People grids share: add the
 * selected records to a list, and start an email to them.
 */

import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { useUser } from '@/lib/auth';
import { useTranslations } from '@weldsuite/i18n/client';
import { useComposeSafe } from '@/contexts/compose-context';
import { useLists, useAddListMembers, type ListKind } from '@/hooks/queries/use-lists-queries';

interface BulkRow {
  id: string;
  email?: string | null;
}

export function useCrmBulkActions({
  kind,
  rows,
  currentListId,
}: {
  kind: ListKind;
  /** The rows the grid has loaded; a selection is resolved against them. */
  rows: BulkRow[];
  /** The list this grid is showing, which is left out of the picker. */
  currentListId?: string;
}) {
  const t = useTranslations();
  const { user } = useUser();
  const compose = useComposeSafe();
  const { data: listsResp } = useLists(kind);
  const addMembers = useAddListMembers();

  // Only static lists of this kind take members: a smart list fills itself
  // from its filter, and a list never mixes people and companies.
  const lists = useMemo(
    () => (listsResp?.data ?? []).filter((l) => l.type === 'static' && l.id !== currentListId),
    [listsResp, currentListId],
  );
  const availableLists = useMemo(
    () => lists.map((l) => ({ id: l.id, title: l.name, color: l.color || 'bg-blue-500' })),
    [lists],
  );

  const onAddToList = useCallback(
    async (ids: string[], listId: string) => {
      const listName = lists.find((l) => l.id === listId)?.name ?? '';
      try {
        const res = await addMembers.mutateAsync({ listId, data: { entityIds: ids } });
        toast.success(
          t(res.data.added > 0 ? 'crm.bulkActions.addedToList' : 'crm.bulkActions.alreadyInList', {
            count: res.data.added,
            listName,
          }),
        );
      } catch {
        // `useAddListMembers` reports the failure itself.
      }
    },
    [addMembers, lists, t],
  );

  const onSendEmail = useCallback(
    (ids: string[]) => {
      const emailById = new Map(rows.map((r) => [r.id, r.email?.trim() ?? '']));
      const emails = [...new Set(ids.map((id) => emailById.get(id) ?? '').filter(Boolean))];
      if (emails.length === 0) {
        toast.error(t('crm.bulkActions.noEmailAddresses'));
        return;
      }
      const skipped = ids.length - ids.filter((id) => emailById.get(id)).length;
      if (skipped > 0) toast.info(t('crm.bulkActions.skippedWithoutEmail', { count: skipped }));

      // One recipient is addressed directly. Several go in Bcc, with the
      // sender in To, so the recipients are not shown each other's addresses.
      const [first] = emails;
      const single = emails.length === 1 && first;
      const to = single || (user?.primaryEmailAddress?.emailAddress ?? '');
      const bcc = single ? '' : emails.join(', ');
      if (compose) {
        compose.openCompose({ to, bcc });
        return;
      }
      const query = bcc ? '?bcc=' + encodeURIComponent(bcc) : '';
      window.location.href = `mailto:${to}${query}`;
    },
    [rows, compose, user, t],
  );

  return { availableLists, onAddToList, onSendEmail };
}
