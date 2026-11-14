/**
 * The folder list of the home page: all forms, every folder with its form
 * count, and create, rename and delete.
 */

import { useState } from 'react';
import { Folder, FolderPlus, MoreHorizontal, Pencil, Trash2, ClipboardList } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import type { FormFolder } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@/lib/utils';
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

export function FolderRail({ folders, selected, onSelect, totalCount }: Readonly<Props>) {
  const { t } = useI18n();
  const tf = t.weldforms.folders;
  const canCreate = useCan('forms:create');
  const create = useCreateFormFolder();
  const update = useUpdateFormFolder();
  const remove = useDeleteFormFolder();
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'rename'; folder: FormFolder } | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<FormFolder | null>(null);

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

  const row = (id: string, label: string, Icon: typeof Folder, count: number | null, menu?: React.ReactNode) => (
    <li key={id} className="group flex items-center">
      <button
        type="button"
        onClick={() => onSelect(id)}
        aria-current={selected === id ? 'true' : undefined}
        className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm', selected === id ? 'bg-accent font-medium' : 'hover:bg-accent/60')}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== null && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>}
      </button>
      {menu}
    </li>
  );

  return (
    <nav aria-label={tf.title} className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{tf.title}</span>
        {canCreate && (
          <Button type="button" variant="ghost" size="icon-xs" onClick={() => open({ mode: 'create' })} aria-label={tf.new}>
            <FolderPlus />
          </Button>
        )}
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {row(ALL_FOLDERS, tf.all, ClipboardList, totalCount)}
        {folders.map((folder) =>
          row(
            folder.id,
            folder.name,
            Folder,
            folder.formCount,
            canCreate && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={t.common.actions.openMenu}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => open({ mode: 'rename', folder })}>
                    <Pencil className="size-4" />
                    {tf.rename}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(folder)}>
                    <Trash2 className="size-4" />
                    {t.common.actions.delete}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          ),
        )}
        {row(NO_FOLDER, tf.none, Folder, null)}
      </ul>

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
    </nav>
  );
}
