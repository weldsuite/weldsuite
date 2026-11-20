/**
 * The folder picker in the home page's toolbar: all forms, every folder with
 * its form count and the forms outside a folder, plus create, and rename and
 * delete for the folder picked.
 */

import { useState } from 'react';
import { ChevronDown, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import type { FormFolder } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { FilterButton } from '@weldsuite/ui/components/filter-button';
import { Input } from '@weldsuite/ui/components/input';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateFormFolder, useDeleteFormFolder, useUpdateFormFolder } from '@/hooks/queries/use-weldforms-queries';

export const ALL_FOLDERS = '__all__';
export const NO_FOLDER = '__none__';

interface Props {
  folders: FormFolder[];
  /** `ALL_FOLDERS`, `NO_FOLDER` or a folder id. */
  selected: string;
  onSelect: (id: string) => void;
  totalCount: number | null;
}

export function FolderMenu({ folders, selected, onSelect, totalCount }: Readonly<Props>) {
  const { t } = useI18n();
  const tf = t.weldforms.folders;
  const canCreate = useCan('forms:create');
  const create = useCreateFormFolder();
  const update = useUpdateFormFolder();
  const remove = useDeleteFormFolder();
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'rename'; folder: FormFolder } | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<FormFolder | null>(null);

  const current = folders.find((folder) => folder.id === selected) ?? null;
  let label = tf.all;
  if (current) label = current.name;
  else if (selected === NO_FOLDER) label = tf.none;

  function open(next: typeof dialog) {
    setDialog(next);
    setName(next?.mode === 'rename' ? next.folder.name : '');
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || !dialog) return;
    try {
      if (dialog.mode === 'create') {
        const folder = await create.mutateAsync({ name: trimmed });
        onSelect(folder.data.id);
      } else {
        await update.mutateAsync({ id: dialog.folder.id, name: trimmed });
      }
      setDialog(null);
    } catch {
      toast.error(tf.saveFailed);
    }
  }

  const count = (value: number | null) => value !== null && <span className="ml-auto pl-4 text-xs tabular-nums text-muted-foreground">{value}</span>;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <FilterButton aria-label={`${tf.title}: ${label}`} className="max-w-56 gap-1.5">
            <span className="truncate">{label}</span>
            <ChevronDown className="size-3.5 shrink-0" aria-hidden />
          </FilterButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuRadioGroup value={selected} onValueChange={onSelect}>
            <DropdownMenuRadioItem value={ALL_FOLDERS}>
              {tf.all}
              {count(totalCount)}
            </DropdownMenuRadioItem>
            {folders.map((folder) => (
              <DropdownMenuRadioItem key={folder.id} value={folder.id}>
                <span className="truncate">{folder.name}</span>
                {count(folder.formCount)}
              </DropdownMenuRadioItem>
            ))}
            <DropdownMenuRadioItem value={NO_FOLDER}>{tf.none}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          {canCreate && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => open({ mode: 'create' })}>
                <FolderPlus className="size-4" />
                {tf.new}
              </DropdownMenuItem>
              {current && (
                <>
                  <DropdownMenuItem onSelect={() => open({ mode: 'rename', folder: current })}>
                    <Pencil className="size-4" />
                    {tf.renameFolder}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(current)}>
                    <Trash2 className="size-4" />
                    {tf.deleteFolder}
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{dialog?.mode === 'rename' ? tf.rename : tf.new}</DialogTitle>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            maxLength={255}
            placeholder={tf.namePlaceholder}
            aria-label={tf.name}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDialog(null)}>
              {t.common.actions.cancel}
            </Button>
            <Button type="button" onClick={() => void save()} disabled={name.trim() === '' || create.isPending || update.isPending}>
              {t.common.actions.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={tf.deleteTitle}
        description={tf.deleteDescription.replace('{name}', deleting?.name ?? '')}
        confirmLabel={t.common.actions.delete}
        variant="destructive"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            if (selected === deleting.id) onSelect(ALL_FOLDERS);
            toast.success(tf.deleted);
          } catch {
            toast.error(tf.deleteFailed);
          } finally {
            setDeleting(null);
          }
        }}
      />
    </>
  );
}
