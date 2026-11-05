import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { keyBetween, newId, type BoardElement, type RecordKind, type RecordRef, type RecordView } from '@weldsuite/board-engine';
import type { SearchEntityType, SearchResultItem } from '@weldsuite/app-api-client/schemas/search';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useProjects } from '@/hooks/queries/use-projects-queries';
import { useAppApi } from '@/lib/api/use-app-api';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { BoardController } from '../editor/model/board-controller';
import { boardsQueryKey } from '../store/use-board-store';

/** Where a record opens in the platform (the same addresses as global search). */
export function recordUrl(ref: RecordRef): string {
  const id = encodeURIComponent(ref.id);
  switch (ref.kind) {
    case 'task':
      return `/weldflow/task/${id}`;
    case 'project':
      return `/weldflow/project/${id}`;
    case 'company':
      return `/weldcrm/companies?stack=company:${id}`;
    case 'person':
      return `/weldcrm/people?stack=person:${id}`;
    case 'opportunity':
      return `/weldcrm?entity=opportunity:${id}`;
    case 'ticket':
      return `/welddesk/inbox?entity=ticket:${id}`;
  }
}

/** Global search's type for each record kind. */
const SEARCH_TYPE: Record<RecordKind, SearchEntityType> = {
  task: 'task',
  project: 'project',
  company: 'customer',
  person: 'contact',
  opportunity: 'opportunity',
  ticket: 'ticket',
};
const KIND_OF = new Map<string, RecordKind>(Object.entries(SEARCH_TYPE).map(([kind, type]) => [type, kind as RecordKind]));
const KINDS = Object.keys(SEARCH_TYPE) as RecordKind[];

const refKey = (ref: RecordRef) => `${ref.kind}:${ref.id}`;

/**
 * What the board's record cards show, fetched for the records on it and kept
 * up to date as cards come and go. `record` is what the renderer asks;
 * `version` changes when new views arrive, so the canvas redraws.
 */
export function useRecordViews(c: BoardController | null, boardId: string): { record: (ref: RecordRef) => RecordView | null; version: number } {
  const appApi = useAppApi();
  const { t } = useI18n();
  const kinds = t.weldboard.editor.records.kinds;
  const subscribe = c ? c.subscribe : () => () => undefined;
  const boardVersion = useSyncExternalStore(subscribe, () => (c ? c.board.version : 0));
  const refs = useMemo(() => {
    if (!c) return [];
    const seen = new Map<string, RecordRef>();
    for (const el of c.board.elements.values()) if (el.type === 'record' && el.record) seen.set(refKey(el.record), el.record);
    return [...seen.values()].sort((a, b) => (refKey(a) < refKey(b) ? -1 : 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, boardVersion]);
  const key = refs.map(refKey).join(',');
  const views = useQuery({
    queryKey: [...boardsQueryKey, 'records', boardId, key],
    queryFn: async () => {
      const out: Record<string, { title: string; subtitle: string | null; status: string | null } | null> = {};
      for (let i = 0; i < refs.length; i += 500) Object.assign(out, (await appApi.boards.records({ refs: refs.slice(i, i + 500) })).data.views);
      return out;
    },
    enabled: refs.length > 0,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
  const data = views.data;
  const record = useMemo(
    () => (ref: RecordRef): RecordView | null => {
      const v = data?.[refKey(ref)];
      if (!v) return null;
      return { title: v.title, subtitle: v.subtitle ?? undefined, status: v.status ?? undefined, kindLabel: kinds[ref.kind] };
    },
    [data, kinds],
  );
  return { record, version: views.dataUpdatedAt };
}

/** Adds WeldSuite records as cards: search any kind the person may see, click to add. */
export function RecordsDialog({ controller: c, open, onOpenChange }: { controller: BoardController; open: boolean; onOpenChange: (open: boolean) => void }) {
  const appApi = useAppApi();
  const { t } = useI18n();
  const tr = t.weldboard.editor.records;
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState<RecordKind | null>(null);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(id);
  }, [q]);
  const results = useQuery({
    queryKey: ['weldboard-record-search', debounced, kind],
    queryFn: async () => (await appApi.search.search({ q: debounced, types: kind ? [SEARCH_TYPE[kind]] : KINDS.map((k) => SEARCH_TYPE[k]), limit: 8 })).data,
    enabled: open && debounced.length > 0,
  });
  const items: (SearchResultItem & { kind: RecordKind })[] = (results.data ?? []).flatMap((g) => {
    const k = KIND_OF.get(g.type);
    return k ? g.items.map((it) => ({ ...it, kind: k })) : [];
  });

  const add = (item: { id: string; kind: RecordKind }) => {
    const at = c.center();
    const offset = (c.selection.size % 6) * 24;
    const el: BoardElement = {
      id: newId(),
      type: 'record',
      order: keyBetween(c.board.topOrder(null), null),
      x: at.x - 140 + offset,
      y: at.y - 48 + offset,
      w: 280,
      h: 96,
      record: { kind: item.kind, id: item.id },
      createdBy: c.options.userId,
      createdAt: Date.now(),
    };
    c.apply({ type: 'create', elements: [el] }, { select: [el.id] });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{tr.title}</DialogTitle>
        </DialogHeader>
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr.search} aria-label={tr.search} />
        <div className="flex flex-wrap gap-1">
          {[null, ...KINDS].map((k) => (
            <button
              key={k ?? 'all'}
              type="button"
              onClick={() => setKind(k)}
              className={cn('rounded-full border px-2.5 py-0.5 text-xs', kind === k ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}
            >
              {k ? tr.kinds[k] : tr.all}
            </button>
          ))}
        </div>
        <div className="max-h-72 min-h-24 overflow-y-auto">
          {results.isFetching && (
            <div className="flex justify-center py-4">
              <InlineSpinner />
            </div>
          )}
          {!results.isFetching && debounced && items.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">{tr.empty}</p>}
          <ul className="divide-y">
            {items.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{[tr.kinds[item.kind], item.subtitle].filter(Boolean).join(' · ')}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => add(item)}>
                  {tr.add}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Turns the chosen stickies into WeldFlow tasks in a project (board-api makes the tasks and the task cards). */
export function TasksDialog({ boardId, elementIds, projectId, onOpenChange }: { boardId: string; elementIds: string[] | null; projectId: string | null; onOpenChange: (open: boolean) => void }) {
  const appApi = useAppApi();
  const queryClient = useQueryClient();
  const { t, format } = useI18n();
  const tr = t.weldboard.editor.records;
  const projects = useProjects({ pageSize: 100 });
  const [chosen, setChosen] = useState<string | null>(projectId);
  const [busy, setBusy] = useState(false);
  useEffect(() => setChosen(projectId), [projectId, elementIds]);
  const list = projects.data?.data ?? [];
  const count = elementIds?.length ?? 0;

  const submit = async () => {
    if (!elementIds || !chosen) return;
    setBusy(true);
    try {
      const { data } = await appApi.boards.tasks(boardId, { elementIds, projectId: chosen });
      toast.success(format(tr.created, { count: data.created.length }));
      void queryClient.invalidateQueries({ queryKey: [...boardsQueryKey, 'records', boardId] });
      onOpenChange(false);
    } catch {
      toast.error(tr.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={elementIds !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{tr.toTasksTitle}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{tr.toTasksDescription}</p>
        {!projectId &&
          (list.length ? (
            <Select value={chosen ?? undefined} onValueChange={setChosen}>
              <SelectTrigger aria-label={tr.project}>
                <SelectValue placeholder={tr.project} />
              </SelectTrigger>
              <SelectContent>
                {list.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm text-muted-foreground">{projects.isLoading ? '' : tr.noProjects}</p>
          ))}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.weldboard.editor.comments.cancel}
          </Button>
          <Button disabled={!chosen || busy || count === 0} onClick={() => void submit()}>
            {format(tr.create, { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
