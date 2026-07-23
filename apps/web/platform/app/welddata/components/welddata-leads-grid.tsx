import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSetAtom } from 'jotai';
import { toast } from 'sonner';
import {
  ArrowRightLeft,
  ListPlus,
  Pencil,
  Play,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useRouter } from '@/lib/router';
import type {
  WelddataCell,
  WelddataColumn,
  WelddataLead,
} from '@weldsuite/app-api-client/schemas/welddata';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@weldsuite/ui/components/context-menu';
import {
  EntityGrid,
  type EntityGridActions,
  type GridColumnDef,
} from '@/components/entity-grid';
import { useObjectPanel } from '@/components/object-panel';
import {
  welddataLeadCacheAtom,
  welddataLeadFromSavedLead,
} from '@/components/objects/welddata-lead';
import {
  useConvertLead,
  useDeleteColumn,
  useRemoveLead,
  useRunCell,
  useRunColumn,
  useWelddataCells,
  useWelddataColumns,
  useWelddataLeads,
} from '@/hooks/queries/use-welddata-queries';
import {
  buildLeadColumns,
  buildLeadGridConfig,
  leadColumnOptionsForKind,
} from '../config/lead-grid-config';
import { AddColumnDialog } from './add-column-dialog';
import { AddToCrmListDialog } from './add-to-crm-list-dialog';

/** Saved leads keep the raw provider payload in `data`; pull the photo/logo
 * from it (field name varies), falling back to the company-domain favicon. */
function leadAvatar(lead: WelddataLead): string | undefined {
  const raw = (lead.data ?? {}) as Record<string, unknown>;
  const keys =
    lead.kind === 'company'
      ? ['company_logo_url', 'logo_url', 'logo', 'companyLogoUrl']
      : ['lead_picture_url', 'picture_url', 'profile_picture_url', 'profilePictureUrl', 'picture', 'photo', 'photo_url', 'avatar', 'image'];
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'string' && v) return v;
  }
  if (lead.kind === 'person' && Array.isArray(raw.experiences)) {
    const logo = (raw.experiences[0] as Record<string, unknown> | undefined)?.company_logo_url;
    if (typeof logo === 'string' && logo) return logo;
  }
  if (lead.domain) {
    const clean = lead.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(clean)}&sz=64`;
  }
  return undefined;
}

interface WelddataLeadsGridProps {
  listId: string;
  listName?: string;
  listKind?: 'person' | 'company';
}

/** Placeholder rows shown during the first load so the grid fades in instead of
 * flashing empty. Mirrors the real row rhythm (avatar + a few text columns). */
function GridSkeleton() {
  return (
    <div className="space-y-px p-4">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-border/40 py-2.5 animate-in fade-in duration-500"
          // Stagger each row's entrance so it reveals like a wave, not a block.
          // `backwards` keeps rows hidden during their delay (no pre-flash).
          style={{ animationDelay: `${i * 45}ms`, animationFillMode: 'backwards' }}
        >
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="hidden h-4 w-28 sm:block" />
          <Skeleton className="ml-auto h-4 w-40" />
        </div>
      ))}
    </div>
  );
}

/**
 * A list's saved leads rendered through the shared EntityGrid (same component
 * as /weldcrm/people): standard lead columns, plus the list's enrichment
 * columns as live cells. Selection → "Remove from list"; per-row convert / view
 * in CRM live in the right-click menu; enrichment columns get run / edit /
 * delete from their header menu.
 */
export function WelddataLeadsGrid({ listId, listName, listKind }: WelddataLeadsGridProps) {
  const t = useTranslations();
  const router = useRouter();
  const { open: openObjectPanel } = useObjectPanel();
  const cacheLead = useSetAtom(welddataLeadCacheAtom);

  const { data: leadsResp, isLoading: leadsLoading } = useWelddataLeads(listId);
  const { data: columns } = useWelddataColumns(listId);
  const { data: cells } = useWelddataCells(listId);
  const convertLead = useConvertLead();
  const removeLead = useRemoveLead();
  const runColumn = useRunColumn();
  const runCell = useRunCell();
  const deleteColumn = useDeleteColumn();

  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [editingColumn, setEditingColumn] = useState<WelddataColumn | null>(null);
  // The enrichment cell whose full contents are shown in the detail dialog.
  const [detail, setDetail] = useState<{ columnName: string; leadName: string; cell: WelddataCell } | null>(null);
  // The column awaiting a "run all vs skip enriched" choice (null = closed).
  const [runChoice, setRunChoice] = useState<{ columnId: string; columnName: string } | null>(null);

  // "Add to CRM list" dialog state. Saved leads are referenced by id (the
  // backend converts + marks them); the grid selection is cleared on success.
  const [crmListOpen, setCrmListOpen] = useState(false);
  const [crmListLeadIds, setCrmListLeadIds] = useState<string[]>([]);
  const clearSelectionRef = useRef<(() => void) | null>(null);

  const openAddToCrmList = useCallback((ids: string[], clearSelection?: () => void) => {
    if (ids.length === 0) return;
    setCrmListLeadIds(ids);
    clearSelectionRef.current = clearSelection ?? null;
    setCrmListOpen(true);
  }, []);

  const detailText =
    detail?.cell.status === 'error'
      ? detail.cell.error || t('welddata.enrich.statusError')
      : detail?.cell.value || '';

  async function copyDetail() {
    if (!detailText) return;
    try {
      await navigator.clipboard.writeText(detailText);
      toast.success(t('welddata.enrich.copied'));
    } catch {
      /* clipboard unavailable */
    }
  }

  const leads = useMemo(() => leadsResp?.data ?? [], [leadsResp]);
  const enrichColumns = useMemo(() => columns ?? [], [columns]);
  const cellMap = cells ?? {};

  // How many cells the pending run choice would touch: total vs only-missing
  // (everything not already in a `done` state).
  const runCounts = useMemo(() => {
    const total = leads.length;
    if (!runChoice) return { total, missing: total };
    let done = 0;
    for (const lead of leads) {
      if (cellMap[`${runChoice.columnId}:${lead.id}`]?.status === 'done') done++;
    }
    return { total, missing: total - done };
  }, [runChoice, leads, cellMap]);

  async function convertOne(lead: WelddataLead) {
    try {
      await convertLead.mutateAsync({ id: lead.id, listId, createCompany: true });
      toast.success(t('welddata.toasts.converted'));
    } catch {
      toast.error(t('welddata.toasts.convertFailed'));
    }
  }

  async function runWholeColumn(columnId: string, onlyMissing: boolean) {
    try {
      const res = await runColumn.mutateAsync({ listId, columnId, input: { onlyMissing } });
      toast.success(t('welddata.toasts.runQueued', { count: res.queued }));
    } catch {
      toast.error(t('welddata.toasts.runFailed'));
    }
  }

  // AI has been removed platform-wide — running an 'ai' enrichment column
  // would hit a dead endpoint, so gate it client-side instead.
  function requestRunColumn(col: WelddataColumn) {
    if (col.config.type === 'ai') {
      toast.error(t('common.ai.unavailable.title'));
      return;
    }
    setRunChoice({ columnId: col.id, columnName: col.name });
  }

  async function rerunCell(column: WelddataColumn, leadId: string) {
    // AI has been removed platform-wide — an 'ai' cell would hit a dead
    // endpoint, so gate it client-side instead.
    if (column.config.type === 'ai') {
      toast.error(t('common.ai.unavailable.title'));
      return;
    }
    try {
      await runCell.mutateAsync({ columnId: column.id, leadId, listId });
    } catch {
      toast.error(t('welddata.toasts.runFailed'));
    }
  }

  /** Run every non-AI enrichment column for a single lead (Clay-style "run row"). */
  async function runRow(lead: WelddataLead) {
    const runnableColumns = enrichColumns.filter((c) => c.config.type !== 'ai');
    if (runnableColumns.length === 0) return;
    try {
      await Promise.all(
        runnableColumns.map((c) => runCell.mutateAsync({ columnId: c.id, leadId: lead.id, listId })),
      );
      toast.success(t('welddata.toasts.cellQueued'));
    } catch {
      toast.error(t('welddata.toasts.runFailed'));
    }
  }

  async function handleDeleteColumn(column: WelddataColumn) {
    if (!confirm(t('welddata.enrich.deleteConfirm', { name: column.name }))) return;
    try {
      await deleteColumn.mutateAsync({ id: column.id, listId });
      toast.success(t('welddata.toasts.columnDeleted'));
    } catch {
      toast.error(t('welddata.toasts.runFailed'));
    }
  }

  function renderEnrichmentCell(column: WelddataColumn, lead: WelddataLead) {
    const cell = cellMap[`${column.id}:${lead.id}`];
    const status = cell?.status;
    const busy = status === 'pending' || status === 'running';

    // Left side: the cell's current content/status.
    let content: ReactNode;
    if (status === 'pending' || status === 'running') {
      // A soft shimmer reads as "working" far more smoothly than status text.
      content = (
        <div
          className="flex flex-col gap-1.5 py-0.5 animate-in fade-in duration-300"
          aria-label={t(
            status === 'running' ? 'welddata.enrich.statusRunning' : 'welddata.enrich.statusPending',
          )}
        >
          <Skeleton className="h-3 w-[70%]" />
          <Skeleton className="h-3 w-[45%]" />
        </div>
      );
    } else if (status === 'error') {
      content = (
        <span className="inline-flex items-center gap-1 text-xs text-destructive text-left animate-in fade-in duration-300">
          {t('welddata.enrich.statusError')}
        </span>
      );
    } else if (status === 'done') {
      content = cell?.value ? (
        <span className="line-clamp-3 whitespace-pre-wrap text-sm text-left animate-in fade-in duration-300">
          {cell.value}
        </span>
      ) : (
        // Ran successfully but came back empty — say so rather than a bare dash.
        <span className="text-[13px] text-muted-foreground/60 animate-in fade-in duration-300">
          {t('welddata.enrich.nothingFound')}
        </span>
      );
    } else {
      content = <span className="text-xs text-muted-foreground/40">{t('welddata.enrich.empty')}</span>;
    }

    // Double-click anywhere in the cell content opens the full-detail dialog
    // (single clicks no longer open it — they're free for cell selection).
    const canOpenDetail = !!cell && (status === 'done' || status === 'error');

    return (
      <div className="group/cell flex w-full items-start justify-between gap-1.5">
        <div
          className="min-w-0 flex-1"
          title={canOpenDetail ? t('welddata.enrich.viewDetails') : undefined}
          onDoubleClick={(e) => {
            if (!canOpenDetail || !cell) return;
            e.stopPropagation();
            setDetail({ columnName: column.name, leadName: lead.name ?? '—', cell });
          }}
        >
          {content}
        </div>
        {/* Per-cell play button — run just this one row's cell (Clay-style).
            While busy the skeleton already signals loading, so we show nothing
            here (no redundant spinner) and just hide the button. */}
        {!busy && (
          <Button
            type="button"
            variant="ghost"
            className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border text-muted-foreground/60 opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover/cell:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              rerunCell(column, lead.id);
            }}
            title={status === 'done' || status === 'error' ? t('welddata.enrich.rerun') : t('welddata.enrich.runCell')}
          >
            <Play className="h-3 w-3 fill-current" />
          </Button>
        )}
      </div>
    );
  }

  const config = useMemo(() => {
    // The first column (type 'company') renders the avatar, name, selection
    // checkbox and row context menu — so it must NOT use a custom `render`
    // (that would short-circuit the checkbox + menu). The kind (person vs
    // company) is conveyed via the entity subtitle instead.
    // Person lists get person columns (title, email); company lists get
    // company columns (no title/email, "Company" header on the name column).
    const baseColumns = buildLeadColumns<WelddataLead>(
      leadColumnOptionsForKind(listKind ?? 'person', true),
    );

    const statusCol: GridColumnDef<WelddataLead> = {
      id: 'convertedStatus',
      name: t('welddata.columns.status'),
      type: 'text',
      width: 130,
      visible: true,
      editable: false,
      sortable: false,
      getValue: (lead) => lead.convertedStatus,
      render: (lead) =>
        lead.convertedStatus === 'converted' ? (
          <Badge variant="secondary">{t('welddata.detail.converted')}</Badge>
        ) : (
          <Badge variant="outline">{t('welddata.detail.pending')}</Badge>
        ),
    };

    const enrichGridColumns: GridColumnDef<WelddataLead>[] = enrichColumns.map((col) => ({
      id: `enrich:${col.id}`,
      name: col.name,
      type: 'text',
      width: 240,
      icon: Sparkles,
      visible: true,
      editable: false,
      sortable: false,
      isEnrichField: true,
      getValue: (lead) => cellMap[`${col.id}:${lead.id}`]?.value ?? '',
      render: (lead) => renderEnrichmentCell(col, lead),
      onEnrichAll: () => requestRunColumn(col),
      headerMenuItems: [
        {
          label: t('welddata.enrich.runColumn'),
          icon: Play,
          onSelect: () => requestRunColumn(col),
        },
        {
          label: t('welddata.enrich.edit'),
          icon: Pencil,
          onSelect: () => {
            setEditingColumn(col);
            setAddColumnOpen(true);
          },
        },
        {
          label: t('welddata.enrich.delete'),
          icon: Trash2,
          destructive: true,
          onSelect: () => handleDeleteColumn(col),
        },
      ],
    }));

    return buildLeadGridConfig<WelddataLead>([...baseColumns, ...enrichGridColumns, statusCol], {
      getAvatar: leadAvatar,
    });
  }, [enrichColumns, cellMap, t, listKind]);

  const actions: EntityGridActions<WelddataLead> = useMemo(
    () => ({
      onRowClick: (lead) => {
        cacheLead((prev) => ({ ...prev, [lead.id]: welddataLeadFromSavedLead(lead) }));
        openObjectPanel({ type: 'welddata-lead', id: lead.id });
      },
      onUpdateEntity: async () => ({ success: false }),
      onDeleteEntity: async (id) => {
        try {
          await removeLead.mutateAsync({ id, listId });
          return { success: true };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Failed' };
        }
      },
      onBulkDelete: async (ids) => {
        let ok = 0;
        for (const id of ids) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await removeLead.mutateAsync({ id, listId });
            ok++;
          } catch {
            /* keep going */
          }
        }
        if (ok > 0) toast.success(t('welddata.toasts.leadRemoved'));
      },
      bulkActions: [
        {
          id: 'move-to-crm',
          label: t('welddata.detail.moveToCrm'),
          icon: ArrowRightLeft,
          onAction: async (ids, clear) => {
            const targets = leads.filter(
              (l) => ids.includes(l.id) && l.convertedStatus === 'pending',
            );
            if (targets.length === 0) {
              toast.info(t('welddata.detail.alreadyConverted'));
              clear();
              return;
            }
            let ok = 0;
            for (const lead of targets) {
              try {
                // eslint-disable-next-line no-await-in-loop
                await convertLead.mutateAsync({ id: lead.id, listId, createCompany: true });
                ok++;
              } catch {
                /* keep going */
              }
            }
            if (ok > 0) toast.success(t('welddata.toasts.convertedMany', { count: ok }));
            else toast.error(t('welddata.toasts.convertFailed'));
            clear();
          },
        },
        {
          id: 'add-to-crm-list',
          label: t('welddata.crmList.add'),
          icon: ListPlus,
          onAction: (ids, clear) => openAddToCrmList(ids, clear),
        },
      ],
    }),
    [removeLead, convertLead, leads, listId, t, cacheLead, openObjectPanel, openAddToCrmList],
  );

  // Per-row actions (right-click): convert / view in CRM / remove.
  const config2 = useMemo(
    () => ({
      ...config,
      // Surface the shared grid's trailing "+ Add" column header (same as the
      // CRM lists pages) and wire it to this list's Add-column dialog, instead
      // of a separate toolbar button.
      allowCustomColumns: true,
      onCreateAttribute: () => {
        setEditingColumn(null);
        setAddColumnOpen(true);
      },
      renderRowContextMenu: (lead: WelddataLead) => (
        <>
          {enrichColumns.length > 0 && (
            <>
              <ContextMenuItem onSelect={() => runRow(lead)}>
                {t('welddata.enrich.runRow')}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {lead.convertedStatus === 'converted' ? (
            <ContextMenuItem
              onSelect={() =>
                router.push(
                  lead.convertedPersonId
                    ? `/weldcrm/people/${lead.convertedPersonId}`
                    : `/weldcrm/companies/${lead.convertedCompanyId}`,
                )
              }
            >
              {t('welddata.detail.viewInCrm')}
            </ContextMenuItem>
          ) : (
            <ContextMenuItem onSelect={() => convertOne(lead)}>
              {t('welddata.detail.convert')}
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => openAddToCrmList([lead.id])}>
            {t('welddata.crmList.add')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="text-destructive"
            onSelect={() => removeLead.mutateAsync({ id: lead.id, listId }).then(
              () => toast.success(t('welddata.toasts.leadRemoved')),
              () => toast.error(t('welddata.toasts.convertFailed')),
            )}
          >
            {t('welddata.detail.remove')}
          </ContextMenuItem>
        </>
      ),
    }),
    [config, listId, t, openAddToCrmList],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0">
        {leadsLoading && leads.length === 0 ? (
          <GridSkeleton />
        ) : (
          <div className="h-full animate-in fade-in duration-300">
            <EntityGrid
              // Remount when the list's kind resolves so the grid rebuilds its
              // column set cleanly — otherwise EntityGrid's column-sync keeps the
              // person columns it first built (while `listKind` was still loading)
              // and appends them after the company columns.
              key={`${listId}-${listKind ?? 'pending'}`}
              config={config2}
              actions={actions}
              entities={leads}
              pagination={{ page: 1, pageSize: leads.length || 50, totalCount: leads.length, totalPages: 1 }}
              listName={listName}
            />
          </div>
        )}
      </div>

      <AddToCrmListDialog
        open={crmListOpen}
        onOpenChange={setCrmListOpen}
        kind={listKind ?? 'person'}
        leadIds={crmListLeadIds}
        onAdded={() => clearSelectionRef.current?.()}
      />

      <AddColumnDialog
        open={addColumnOpen}
        onOpenChange={setAddColumnOpen}
        listId={listId}
        column={editingColumn}
        leadKind={listKind}
      />

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{detail?.columnName}</DialogTitle>
            <DialogDescription>{detail?.leadName}</DialogDescription>
          </DialogHeader>

          <div
            className={`max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border p-3 text-sm ${
              detail?.cell.status === 'error' ? 'text-destructive' : ''
            }`}
          >
            {detailText || '—'}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {detail?.cell.data && typeof (detail.cell.data as { modelId?: string }).modelId === 'string' && (
              <span>{(detail.cell.data as { modelId?: string }).modelId}</span>
            )}
            {typeof detail?.cell.creditsUsed === 'number' && (
              <span>{t('welddata.enrich.creditsUsed', { count: detail.cell.creditsUsed })}</span>
            )}
            {detail?.cell.ranAt && <span>{new Date(detail.cell.ranAt).toLocaleString()}</span>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={copyDetail} disabled={!detailText}>
              {t('welddata.enrich.copy')}
            </Button>
            <Button onClick={() => setDetail(null)}>{t('welddata.enrich.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!runChoice} onOpenChange={(o) => !o && setRunChoice(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t('welddata.enrich.runChoiceTitle', { name: runChoice?.columnName ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('welddata.enrich.runChoiceDescription')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-2 py-1">
            <Button
              type="button"
              variant="ghost"
              disabled={runCounts.missing === 0}
              className="rounded-lg border p-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                if (runChoice) runWholeColumn(runChoice.columnId, true);
                setRunChoice(null);
              }}
            >
              <div className="text-sm font-medium">{t('welddata.enrich.runChoiceSkip')}</div>
              <div className="text-xs text-muted-foreground">
                {runCounts.missing === 0
                  ? t('welddata.enrich.runChoiceAllEnriched')
                  : t('welddata.enrich.runChoiceSkipHint', { count: runCounts.missing })}
              </div>
            </Button>

            <Button
              type="button"
              variant="ghost"
              className="rounded-lg border p-3 text-left transition-colors hover:bg-muted"
              onClick={() => {
                if (runChoice) runWholeColumn(runChoice.columnId, false);
                setRunChoice(null);
              }}
            >
              <div className="text-sm font-medium">{t('welddata.enrich.runChoiceAll')}</div>
              <div className="text-xs text-muted-foreground">
                {t('welddata.enrich.runChoiceAllHint', { count: runCounts.total })}
              </div>
            </Button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRunChoice(null)}>
              {t('common.actions.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
