/** Dialogs for saved prospect lists: create or rename one, and add prospects to one. */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import type { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  createReachListSchema,
  type ReachProspectList,
} from '@weldsuite/app-api-client/schemas/reach';
import {
  useAddReachListMembers,
  useCreateReachList,
  useReachProspectLists,
  useUpdateReachList,
} from '@/hooks/queries/use-reach-prospect-queries';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import { ErrorBanner, errorMessage } from '@/app/weldreach/components/engage/kit';
import { chunk } from '../lib/import-mapping';

type ListFormValues = z.infer<typeof createReachListSchema>;

/** Create a list, or rename (and describe) an existing one. */
export function ListFormDialog({
  list,
  onClose,
}: Readonly<{ list?: ReachProspectList; onClose: () => void }>) {
  const t = useTranslations();
  const create = useCreateReachList();
  const update = useUpdateReachList();
  const [failure, setFailure] = useState<string | null>(null);
  const pending = create.isPending || update.isPending;

  const form = useForm<ListFormValues>({
    resolver: zodResolver(createReachListSchema),
    defaultValues: { name: list?.name ?? '', description: list?.description ?? '' },
  });

  const submit = form.handleSubmit(async (values) => {
    setFailure(null);
    try {
      if (list) {
        await update.mutateAsync({ id: list.id, name: values.name, description: values.description ?? '' });
      } else {
        await create.mutateAsync({ name: values.name, description: values.description || undefined });
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.prospects.lists.saveFailed')));
    }
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {list ? t('reachEngage.prospects.lists.renameTitle') : t('reachEngage.prospects.lists.createTitle')}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label htmlFor="reach-list-name">{t('reachEngage.prospects.lists.name')}</Label>
            <Input
              id="reach-list-name"
              autoFocus
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.name)}
              {...form.register('name')}
            />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{t('reachEngage.prospects.lists.nameRequired')}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reach-list-description">{t('reachEngage.prospects.lists.description')}</Label>
            <Input
              id="reach-list-description"
              autoComplete="off"
              placeholder={t('reachEngage.prospects.lists.descriptionPlaceholder')}
              {...form.register('description')}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t('reachEngage.common.cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {list ? t('reachEngage.common.save') : t('reachEngage.common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const NEW_LIST = '__new__';
/** The API takes at most this many prospects per request (`reachListMembersSchema`). */
const MEMBERS_PER_REQUEST = 5000;

/** Add the selected prospects to an existing list, or to a new one. */
export function AddToListDialog({
  prospectIds,
  onClose,
  onDone,
}: Readonly<{ prospectIds: string[]; onClose: () => void; onDone: () => void }>) {
  const t = useTranslations();
  const format = useReachFormat();
  const lists = useReachProspectLists();
  const createList = useCreateReachList();
  const addMembers = useAddReachListMembers();

  const [target, setTarget] = useState<string | undefined>(undefined);
  const [newName, setNewName] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const creating = target === NEW_LIST;
  const pending = createList.isPending || addMembers.isPending;
  const canSubmit = creating ? newName.trim() !== '' : Boolean(target);

  async function submit() {
    setFailure(null);
    try {
      let listId = target;
      if (creating) {
        const created = await createList.mutateAsync({ name: newName.trim() });
        listId = created.data.id;
      }
      if (!listId) return;
      for (const ids of chunk(prospectIds, MEMBERS_PER_REQUEST)) {
        await addMembers.mutateAsync({ listId, prospectIds: ids });
      }
      onDone();
    } catch (err) {
      setFailure(errorMessage(err, t('reachEngage.prospects.addToList.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('reachEngage.prospects.addToList.title')}</DialogTitle>
          <DialogDescription>
            {t('reachEngage.prospects.addToList.description', { count: format.number(prospectIds.length) })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          <div className="space-y-1.5">
            <Label id="reach-add-to-list-label">{t('reachEngage.prospects.addToList.list')}</Label>
            <Select value={target ?? ''} onValueChange={setTarget}>
              <SelectTrigger aria-labelledby="reach-add-to-list-label" className="w-full">
                <SelectValue placeholder={t('reachEngage.prospects.addToList.placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {(lists.data ?? []).map((list) => (
                  <SelectItem key={list.id} value={list.id}>
                    {list.name} ({format.number(list.prospectCount)})
                  </SelectItem>
                ))}
                <SelectItem value={NEW_LIST}>{t('reachEngage.prospects.addToList.newList')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {creating && (
            <div className="space-y-1.5">
              <Label htmlFor="reach-add-to-list-new-name">{t('reachEngage.prospects.lists.name')}</Label>
              <Input
                id="reach-add-to-list-new-name"
                autoFocus
                autoComplete="off"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {t('reachEngage.common.cancel')}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!canSubmit || pending}>
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('reachEngage.prospects.addToList.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
