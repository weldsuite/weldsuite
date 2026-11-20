import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MoreVertical } from 'lucide-react';
import type { SheetVersion } from '@weldsuite/app-api-client/schemas/sheets';
import { Engine, type FormatLocale, type WorkbookSnapshot } from '@weldsuite/sheets-engine';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import type { Person } from '../editor/comments/comments-panel';
import { PanelAction, RulePanel } from '../editor/rules/panel';
import { downloadXlsx } from '../files';
import { sheetsQueryKey } from '../store/use-sheet-store';

const PAGE_SIZE = 50;

export const versionsQueryKey = (sheetId: string) => [...sheetsQueryKey, 'versions', sheetId] as const;

/**
 * Saved versions of a spreadsheet beside the grid, as in WeldDocs: name the
 * current version, rename one, download one as .xlsx, or restore one (the
 * room keeps the sheet as it is now as an automatic version first, so a
 * restore can be undone by restoring that).
 */
export function VersionsPanel({
  sheetId,
  name,
  canEdit,
  people,
  locale,
  onClose,
}: {
  sheetId: string;
  name: string;
  canEdit: boolean;
  people: Person[];
  locale: FormatLocale;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const tv = t.weldsheets.versions;
  const sheets = useAppApi().sheets;
  const queryClient = useQueryClient();
  const key = versionsQueryKey(sheetId);
  // A page at a time: every restore adds an automatic version, so a long history is normal.
  const pages = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => sheets.versions(sheetId, { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => (last.pagination.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
  });
  const versions = pages.data?.pages.flatMap((page) => page.data);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });
  const [naming, setNaming] = useState<{ version: SheetVersion | null; value: string } | null>(null);
  const [restoring, setRestoring] = useState<SheetVersion | null>(null);
  /** Set by Rename until its menu has closed. */
  const renamingRef = useRef(false);

  const save = useMutation({
    mutationFn: async ({ version, value }: { version: SheetVersion | null; value: string }) =>
      version ? sheets.renameVersion(sheetId, version.id, { name: value }) : sheets.createVersion(sheetId, { name: value }),
    onSuccess: (_, { version }) => {
      setNaming(null);
      if (!version) toast.success(tv.created);
      void refresh();
    },
    onError: () => toast.error(tv.failed),
  });
  const restore = useMutation({
    mutationFn: (version: SheetVersion) => sheets.restoreVersion(sheetId, version.id),
    onSuccess: () => {
      setRestoring(null);
      void refresh();
    },
    onError: () => toast.error(tv.failed),
  });

  const label = (v: SheetVersion) => v.name ?? tv.automatic;
  const download = async (version: SheetVersion) => {
    try {
      const { data } = await sheets.versionSnapshot(sheetId, version.id);
      const engine = Engine.fromSnapshot(data.snapshot as WorkbookSnapshot);
      engine.recalcAll();
      await downloadXlsx(engine, `${name} - ${label(version)}`, locale);
    } catch {
      toast.error(tv.failed);
    }
  };

  const author = (v: SheetVersion) => people.find((p) => p.id === v.createdById)?.name;
  const when = (v: SheetVersion) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v.createdAt));
  const submit = () => {
    const value = naming?.value.trim();
    if (naming && value) save.mutate({ version: naming.version, value });
  };

  return (
    <RulePanel title={tv.title} closeLabel={tv.close} onClose={onClose}>
      {/* Stays while a version is renamed on its card, so the list does not jump. */}
      {canEdit && !(naming && !naming.version) && (
        <PanelAction onClick={() => setNaming({ version: null, value: '' })}>{tv.nameCurrent}</PanelAction>
      )}
      {naming && !naming.version && (
        <NameForm
          value={naming.value}
          labels={tv}
          saving={save.isPending}
          onChange={(value) => setNaming({ ...naming, value })}
          onSubmit={submit}
          onCancel={() => setNaming(null)}
        />
      )}
      {versions?.length === 0 && <EmptyText>{tv.empty}</EmptyText>}
      {versions?.map((v) =>
        naming?.version?.id === v.id ? (
          // Renamed in place, on its own card.
          <NameForm
            key={v.id}
            value={naming.value}
            labels={tv}
            saving={save.isPending}
            onChange={(value) => setNaming({ ...naming, value })}
            onSubmit={submit}
            onCancel={() => setNaming(null)}
          />
        ) : (
          <div key={v.id} className="flex items-start gap-2 rounded-lg border bg-card p-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className={`truncate font-medium ${v.name ? '' : 'italic text-muted-foreground'}`} title={v.name ? undefined : tv.automaticHint}>
                {label(v)}
              </div>
              <div className="text-xs text-muted-foreground">
                {when(v)}
                {author(v) ? ` · ${tv.by.replace('{name}', author(v)!)}` : ''}
              </div>
            </div>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button type="button" aria-label={label(v)} className="rounded p-1 hover:bg-accent">
                  <MoreVertical className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onCloseAutoFocus={(e) => {
                  // Rename puts the keyboard in the name box; the menu must not take it back to its button.
                  if (renamingRef.current) e.preventDefault();
                  renamingRef.current = false;
                }}
              >
                {canEdit && <DropdownMenuItem onSelect={() => setRestoring(v)}>{tv.restore}</DropdownMenuItem>}
                {canEdit && (
                  <DropdownMenuItem
                    onSelect={() => {
                      renamingRef.current = true;
                      setNaming({ version: v, value: v.name ?? '' });
                    }}
                  >
                    {tv.rename}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => void download(v)}>{tv.download}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      )}
      {pages.hasNextPage && (
        <Button size="sm" variant="ghost" disabled={pages.isFetchingNextPage} onClick={() => void pages.fetchNextPage()}>
          {tv.showMore}
        </Button>
      )}
      <ConfirmDialog
        open={!!restoring}
        onOpenChange={(o) => !o && setRestoring(null)}
        title={restoring ? tv.restoreTitle.replace('{name}', label(restoring)) : ''}
        description={tv.restoreDescription}
        confirmLabel={tv.restore}
        loading={restore.isPending}
        onConfirm={() => {
          if (restoring) restore.mutate(restoring);
        }}
      />
    </RulePanel>
  );
}

/** Naming the current version, or renaming one: focused with its text selected, Enter saves and Escape cancels. */
function NameForm({
  value,
  labels,
  saving,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  labels: { namePlaceholder: string; cancel: string; save: string };
  saving: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Again after the click that opened it has settled (a menu hands focus back to its button).
    const focus = () => {
      const el = ref.current;
      if (!el || document.activeElement === el) return;
      el.focus();
      el.select();
    };
    focus();
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border bg-card p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <input
        ref={ref}
        value={value}
        maxLength={255}
        placeholder={labels.namePlaceholder}
        aria-label={labels.namePlaceholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) onCancel();
        }}
        className="h-8 rounded border bg-background px-2 text-sm"
      />
      <div className="flex justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onCancel}>
          {labels.cancel}
        </Button>
        <Button type="submit" size="sm" className="h-7" disabled={!value.trim() || saving}>
          {labels.save}
        </Button>
      </div>
    </form>
  );
}
