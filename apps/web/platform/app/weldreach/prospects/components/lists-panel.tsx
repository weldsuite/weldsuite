/** The saved prospect lists beside the prospects table: pick one to filter, create, rename, delete. */

import { EllipsisVertical, ListFilter, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachProspectList } from '@weldsuite/app-api-client/schemas/reach';
import { cn } from '@/lib/utils';
import { useReachFormat } from '@/app/weldreach/components/engage/format';
import { ErrorBanner, InlineSpinner } from '@/app/weldreach/components/engage/kit';

export function ListsPanel({
  lists,
  isLoading,
  error,
  selectedListId,
  canCreate,
  canUpdate,
  canDelete,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: Readonly<{
  lists: ReachProspectList[];
  isLoading: boolean;
  error: string | null;
  selectedListId: string | undefined;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onSelect: (listId: string | undefined) => void;
  onCreate: () => void;
  onRename: (list: ReachProspectList) => void;
  onDelete: (list: ReachProspectList) => void;
}>) {
  const t = useTranslations();
  const format = useReachFormat();

  const rowClass = (active: boolean) =>
    cn(
      'group flex items-center gap-1 rounded-md pr-1 text-sm transition-colors',
      active ? 'bg-muted font-medium' : 'hover:bg-muted/60',
    );

  return (
    <aside
      aria-label={t('reachEngage.prospects.lists.title')}
      className="hidden w-60 shrink-0 flex-col border-r md:flex"
    >
      <div className="flex h-[53px] items-center justify-between border-b px-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ListFilter className="h-4 w-4 text-muted-foreground" />
          {t('reachEngage.prospects.lists.title')}
        </h2>
        {canCreate && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onCreate}
            aria-label={t('reachEngage.prospects.lists.create')}
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>

      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        <div className={rowClass(selectedListId === undefined)}>
          <button
            type="button"
            onClick={() => onSelect(undefined)}
            aria-current={selectedListId === undefined ? 'true' : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
          >
            <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{t('reachEngage.prospects.lists.all')}</span>
          </button>
        </div>

        {isLoading && <InlineSpinner className="py-6" />}
        {error && <ErrorBanner error={error} />}

        {lists.map((list) => (
          <div key={list.id} className={rowClass(selectedListId === list.id)}>
            <button
              type="button"
              onClick={() => onSelect(list.id)}
              aria-current={selectedListId === list.id ? 'true' : undefined}
              className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1.5 text-left"
            >
              <span className="truncate">{list.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {format.number(list.prospectCount)}
              </span>
            </button>
            {(canUpdate || canDelete) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                    aria-label={t('reachEngage.prospects.lists.menu', { name: list.name })}
                  >
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canUpdate && (
                    <DropdownMenuItem onSelect={() => onRename(list)}>
                      <Pencil className="mr-0.5 h-4 w-4" />
                      {t('reachEngage.prospects.lists.rename')}
                    </DropdownMenuItem>
                  )}
                  {canUpdate && canDelete && <DropdownMenuSeparator />}
                  {canDelete && (
                    <DropdownMenuItem
                      onSelect={() => onDelete(list)}
                      className="text-red-600 focus:text-red-600 dark:text-red-400"
                    >
                      <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
                      {t('reachEngage.common.delete')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}

        {!isLoading && lists.length === 0 && (
          <p className="px-2 py-4 text-xs text-muted-foreground">{t('reachEngage.prospects.lists.empty')}</p>
        )}
      </nav>
    </aside>
  );
}
