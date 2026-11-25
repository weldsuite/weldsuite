/**
 * The Backlog's epics panel: every epic (and feature) with its progress. A
 * click filters the backlog by it; the arrow opens its page. "New epic" adds
 * one by title.
 */

import { useId, useState, type FormEvent } from 'react';
import { ArrowUpRight, Plus } from 'lucide-react';
import type { EpicRollup, ItemTypeNaming } from '@weldsuite/app-api-client/schemas/flow-agile';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { TaskTypeBadge } from '@/components/weldflow/agile/task-type-badge';
import { epicPageHref } from '@/components/weldflow/agile/task-agile-fields';
import { NO_EPIC } from '@/app/weldflow/lib/backlog';

/** Points done over points; items done over items when nothing is estimated. */
export function epicPercent(epic: Pick<EpicRollup, 'items' | 'done' | 'points' | 'donePoints'>): number {
  if (epic.points > 0) return Math.round((epic.donePoints / epic.points) * 100);
  if (epic.items > 0) return Math.round((epic.done / epic.items) * 100);
  return 0;
}

const ROW = 'flex w-full min-w-0 items-center rounded-lg text-left text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50';

export function EpicsPanel({
  epics,
  loading,
  failed,
  selected,
  onSelect,
  naming,
  featureLevel,
  projectId,
  canCreate,
  onCreate,
}: Readonly<{
  epics: readonly EpicRollup[];
  loading: boolean;
  failed: boolean;
  /** An epic's id, `NO_EPIC`, or null for all items. */
  selected: string | null;
  onSelect: (epicId: string | null) => void;
  naming: ItemTypeNaming;
  featureLevel: boolean;
  projectId: string;
  canCreate: boolean;
  onCreate: (title: string) => Promise<void>;
}>) {
  const { t, format } = useI18n();
  const copy = t.flowAgileBacklog.epics;
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const inputId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = title.trim();
    if (!next || busy) return;
    setBusy(true);
    try {
      await onCreate(next);
      setTitle('');
      setAdding(false);
    } catch {
      // The page showed why; keep the title to try again.
    } finally {
      setBusy(false);
    }
  };

  const pick = (id: string | null) => onSelect(selected === id ? null : id);

  return (
    <aside aria-label={copy.title} className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between px-2 pb-1">
        <h2 className="text-[13px] font-semibold">{copy.title}</h2>
        {canCreate ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            aria-label={copy.newEpic}
            aria-expanded={adding}
            onClick={() => setAdding((value) => !value)}
          >
            <Plus aria-hidden className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {adding ? (
        <form onSubmit={submit} className="flex flex-col gap-1.5 px-1 pb-2">
          <label htmlFor={inputId} className="sr-only">
            {copy.newEpicPlaceholder}
          </label>
          <Input
            id={inputId}
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={copy.newEpicPlaceholder}
            disabled={busy}
            className="h-8 text-sm"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setAdding(false);
            }}
          />
        </form>
      ) : null}

      <div className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        <button
          type="button"
          aria-pressed={selected === null}
          onClick={() => onSelect(null)}
          className={cn(ROW, 'shrink-0 px-2.5 py-2 font-medium', selected === null ? 'bg-muted' : 'hover:bg-muted/60')}
        >
          {copy.all}
        </button>

        {loading ? (
          <div className="flex gap-1 lg:flex-col">
            <Skeleton className="h-12 w-44 lg:w-full" />
            <Skeleton className="h-12 w-44 lg:w-full" />
          </div>
        ) : null}
        {failed ? <p className="px-2.5 py-2 text-sm text-destructive">{copy.loadFailed}</p> : null}
        {!loading && !failed && epics.length === 0 ? <p className="px-2.5 py-2 text-xs text-muted-foreground">{copy.empty}</p> : null}

        {epics.map((epic) => {
          const percent = epicPercent(epic);
          const active = selected === epic.id;
          return (
            <div key={epic.id} className={cn('flex shrink-0 items-center rounded-lg lg:shrink', active ? 'bg-muted' : 'hover:bg-muted/60')}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => pick(epic.id)}
                className={cn(ROW, 'min-w-44 flex-1 flex-col items-stretch gap-1.5 px-2.5 py-2 lg:min-w-0')}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <TaskTypeBadge type={epic.type} naming={naming} featureLevel={featureLevel} size="sm" />
                  <span className="truncate">{epic.title}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-valuetext={format(copy.progress, { percent })}
                    className="block h-1 flex-1 overflow-hidden rounded-full bg-muted-foreground/20"
                  >
                    <span className="block h-full bg-violet-600 dark:bg-violet-400" style={{ width: `${percent}%` }} />
                  </span>
                  <span className="min-w-8 text-right text-xs tabular-nums text-muted-foreground">{percent}%</span>
                </span>
              </button>
              <Link
                href={epicPageHref(projectId, epic.id)}
                aria-label={`${copy.openEpic}: ${epic.title}`}
                className="mr-1 flex h-7 w-7 flex-none items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <ArrowUpRight aria-hidden className="h-4 w-4" />
              </Link>
            </div>
          );
        })}

        <button
          type="button"
          aria-pressed={selected === NO_EPIC}
          onClick={() => pick(NO_EPIC)}
          className={cn(ROW, 'shrink-0 px-2.5 py-2 text-muted-foreground', selected === NO_EPIC ? 'bg-muted text-foreground' : 'hover:bg-muted/60')}
        >
          {copy.withoutEpic}
        </button>
      </div>
    </aside>
  );
}
