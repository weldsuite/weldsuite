import { useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, MoreVertical } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { SHEET_DATA_OBJECT_KEYS, SHEET_DATA_OBJECTS, type SheetDataObjectKey } from '@weldsuite/app-api-client/schemas/sheet-data';
import type { SheetDataRefreshResult, SheetDataSource } from '@weldsuite/app-api-client/schemas/sheets';
import { findDataTable, formatA1 } from '@weldsuite/sheets-engine';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import type { Person } from '../editor/comments/comments-panel';
import type { SheetController } from '../editor/model/sheet-controller';
import { RulePanel } from '../editor/rules/panel';
import { sheetsQueryKey } from '../store/use-sheet-store';
import { definitionOf, draftOf, newDraft, type SourceDraft } from './data-source-draft';
import { DataSourceForm, useFieldLabel } from './data-source-form';

export const dataSourcesQueryKey = (sheetId: string) => [...sheetsQueryKey, 'data-sources', sheetId] as const;

/** The table being connected (source null) or changed. */
interface Editing {
  source: SheetDataSource | null;
  draft: SourceDraft;
}

/** Where a connected table sits now ("Deals!B2:F120"), or null before its first refresh. */
function placeOf(controller: SheetController, id: string): string | null {
  const placed = findDataTable(controller.engine, id);
  if (!placed) return null;
  const tab = controller.engine.workbook.sheets.find((s) => s.id === placed.sheetId);
  const { r1, c1, r2, c2 } = placed.range;
  return `${tab?.name ?? ''}!${formatA1(r1, c1)}:${formatA1(r2, c2)}`;
}

/** Selects a connected table's block, on its tab. */
function showTable(controller: SheetController, id: string): void {
  const placed = findDataTable(controller.engine, id);
  if (!placed) return;
  const { r1, c1 } = placed.range;
  controller.goTo(placed.sheetId, r1, c1);
  if (controller.activeSheetId !== placed.sheetId) return;
  controller.select({ ranges: [placed.range], active: { row: r1, col: c1 }, anchor: { row: r1, col: c1 } });
}

/**
 * Connected tables beside the grid: WeldSuite records (companies, tickets,
 * invoices, …) listed into a range of the sheet, refreshed by hand or on a
 * schedule. A table lists what the person who connected it may read; whoever
 * changes what it lists becomes that person.
 */
export function DataPanel({
  sheetId,
  controller,
  canEdit,
  people,
  onClose,
}: {
  sheetId: string;
  controller: SheetController;
  canEdit: boolean;
  people: Person[];
  onClose: () => void;
}) {
  // The page made this element once: follow the selection (where a new table starts) here.
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t } = useI18n();
  const td = t.weldsheets.dataSources;
  const sheets = useAppApi().sheets;
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const label = useFieldLabel();
  const key = dataSourcesQueryKey(sheetId);
  const list = useQuery({ queryKey: key, queryFn: async () => (await sheets.dataSources(sheetId)).data });
  const readable = SHEET_DATA_OBJECT_KEYS.filter((k) => can(SHEET_DATA_OBJECTS[k].permission));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<SheetDataSource | null>(null);
  const refetch = () => queryClient.invalidateQueries({ queryKey: key });

  const report = (result: SheetDataRefreshResult) => {
    if (result.refreshed) toast.success(td.refreshed.replace('{count}', String(result.source.rowCount)));
    else toast.error(td.errors[result.source.lastError ?? 'failed']);
  };

  const save = useMutation({
    mutationFn: async ({ source, draft }: Editing) => {
      const definition = definitionOf(draft);
      if (source) return (await sheets.updateDataSource(sheetId, source.id, { definition, refresh: draft.refresh })).data;
      const { row, col } = controller.selection.active;
      const target = { tabId: controller.activeSheetId, row, col };
      return (await sheets.createDataSource(sheetId, { objectType: draft.objectType, definition, refresh: draft.refresh, target })).data;
    },
    onSuccess: (result) => {
      setEditing(null);
      report(result);
      void refetch();
    },
    onError: () => toast.error(td.failed),
  });
  const refresh = useMutation({
    mutationFn: async (source: SheetDataSource) => (await sheets.refreshDataSource(sheetId, source.id)).data,
    onSuccess: (result) => {
      report(result);
      void refetch();
    },
    onError: () => toast.error(td.failed),
  });
  const remove = useMutation({
    mutationFn: (source: SheetDataSource) => sheets.removeDataSource(sheetId, source.id),
    onSuccess: () => {
      setRemoving(null);
      void refetch();
    },
    onError: () => toast.error(td.failed),
  });

  const connect = () => {
    const first = readable[0];
    if (first) setEditing({ source: null, draft: newDraft(first, label) });
  };
  const { row, col } = controller.selection.active;
  const sources = list.data;

  return (
    <RulePanel title={td.title} closeLabel={td.close} onClose={onClose}>
      <p className="text-xs text-muted-foreground">{td.intro}</p>
      {canEdit && !editing && readable.length > 0 && (
        <Button size="sm" variant="outline" onClick={connect}>
          {td.connect}
        </Button>
      )}
      {canEdit && !editing && readable.length === 0 && <p className="text-xs text-muted-foreground">{td.noObjects}</p>}
      {editing && (
        <DataSourceForm
          draft={editing.draft}
          onChange={(draft) => setEditing({ ...editing, draft })}
          objects={editing.source ? [] : readable}
          onObjectChange={(objectType: SheetDataObjectKey) => setEditing({ ...editing, draft: newDraft(objectType, label) })}
          at={editing.source ? undefined : `${controller.sheet.name}!${formatA1(row, col)}`}
          saving={save.isPending}
          onSave={() => save.mutate(editing)}
          onCancel={() => setEditing(null)}
        />
      )}
      {sources?.length === 0 && !editing && <p className="px-1 py-6 text-center text-sm text-muted-foreground">{td.empty}</p>}
      {sources?.map((source) => (
        <SourceCard
          key={source.id}
          source={source}
          place={placeOf(controller, source.id)}
          by={people.find((p) => p.id === source.createdById)?.name}
          canEdit={canEdit}
          busy={refresh.isPending && refresh.variables?.id === source.id}
          onRefresh={() => refresh.mutate(source)}
          onEdit={() => setEditing({ source, draft: draftOf(source) })}
          onShow={() => showTable(controller, source.id)}
          onRemove={() => setRemoving(source)}
        />
      ))}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={td.disconnectTitle}
        description={td.disconnectDescription}
        confirmLabel={td.disconnect}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing);
        }}
      />
    </RulePanel>
  );
}

function SourceCard({
  source,
  place,
  by,
  canEdit,
  busy,
  onRefresh,
  onEdit,
  onShow,
  onRemove,
}: {
  source: SheetDataSource;
  place: string | null;
  by: string | undefined;
  canEdit: boolean;
  busy: boolean;
  onRefresh: () => void;
  onEdit: () => void;
  onShow: () => void;
  onRemove: () => void;
}) {
  const { t, language } = useI18n();
  const td = t.weldsheets.dataSources;
  const when = source.lastRefreshedAt
    ? td.refreshedAt.replace('{time}', new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(source.lastRefreshedAt)))
    : td.never;
  return (
    <div className="flex items-start gap-2 rounded-lg border bg-card p-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{t.sheetData.objects[source.objectType]}</div>
        <div className="truncate text-xs text-muted-foreground">{place ?? td.notPlaced}</div>
        <div className="text-xs text-muted-foreground">
          {td.rows.replace('{count}', String(source.rowCount))} · {td.refreshModes[source.refresh]}
        </div>
        <div className="text-xs text-muted-foreground">
          {busy ? td.refreshing : when}
          {by ? ` · ${td.by.replace('{name}', by)}` : ''}
        </div>
        {source.lastError && (
          <div className="mt-1 flex items-start gap-1 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3 shrink-0" />
            {td.errors[source.lastError]}
          </div>
        )}
      </div>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={td.actions} className="rounded p-1 hover:bg-accent">
            <MoreVertical className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canEdit && (
            <DropdownMenuItem disabled={busy} onSelect={onRefresh}>
              {td.refreshNow}
            </DropdownMenuItem>
          )}
          {canEdit && <DropdownMenuItem onSelect={onEdit}>{td.edit}</DropdownMenuItem>}
          {place && <DropdownMenuItem onSelect={onShow}>{td.goTo}</DropdownMenuItem>}
          {canEdit && (
            <DropdownMenuItem className="text-destructive" onSelect={onRemove}>
              {td.disconnect}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
