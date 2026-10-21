'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowRightLeft, Check, Circle, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Progress } from '@weldsuite/ui/components/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { cancelDatabaseMoveAction, loadDatabaseMoveAction, recoverDatabaseMoveAction } from '@/actions/databases';
import { formatDateTime } from '@/lib/billing-format';
import {
  MOVE_POLL_INTERVAL_MS,
  MOVE_STEPS,
  canCancelMove,
  isActiveMove,
  moveProgressPercent,
  moveStepIndex,
  recoverMode,
  type DatabaseMoveView,
  type MovePlacementView,
  type WorkerState,
} from '@/lib/database-moves';
import { adminCopy, fill } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Dash, Mono, Notice, lookup } from './presentation';
import { MoveDestination, MoveStatusBadge, moveKindLabel } from './move-presentation';

/**
 * The moves part of a workspace's Database tab: the move that is running (or
 * failed and still needs a recovery), followed live, and the earlier ones.
 */
export function DatabaseMovesPanel({
  state,
  canManage,
  action,
}: Readonly<{
  state: WorkerState<DatabaseMoveView[]>;
  /** A superadmin: may cancel and recover. */
  canManage: boolean;
  /** The Move button, or why there is none; rendered next to the heading. */
  action?: React.ReactNode;
}>) {
  const t = adminCopy().databases.moves;

  let body: React.ReactNode;
  if (state.kind === 'not_configured') {
    body = <Notice tone="muted">{t.notConfigured}</Notice>;
  } else if (state.kind === 'error') {
    body = <Notice tone="warning">{fill(t.unavailable, { message: state.message })}</Notice>;
  } else {
    const moves = state.data;
    const latest = moves[0];
    const current = latest && (isActiveMove(latest.status) || latest.status === 'failed') ? latest : null;
    const history = current ? moves.slice(1) : moves;
    body = (
      <div className="space-y-4">
        {current && <CurrentMoveCard key={current.id} initial={current} canManage={canManage} />}
        {moves.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
        {history.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.history}</h3>
            <MoveHistoryTable moves={history} />
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">{t.title}</h2>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">{t.description}</p>
        </div>
        {action}
      </div>
      {body}
    </section>
  );
}

function Placement({ place, pending }: Readonly<{ place: MovePlacementView | null; pending?: string }>) {
  const t = adminCopy().databases.moves.card;
  if (!place) return <span className="text-sm text-muted-foreground">{pending ?? t.notChosen}</span>;
  if (place.sharedProjectId) {
    return <MoveDestination requestedTarget={place.sharedProjectId} targetShardId={place.sharedProjectId} />;
  }
  return (
    <span className="space-x-1.5">
      <span className="text-sm">{t.dedicatedPlace}</span>
      {place.neonProjectId && <Mono className="text-muted-foreground">{place.neonProjectId}</Mono>}
    </span>
  );
}

function Steps({ move }: Readonly<{ move: DatabaseMoveView }>) {
  const t = adminCopy().databases.moves;
  const reached = moveStepIndex(move.status);
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1.5">
      {MOVE_STEPS.map((step, index) => {
        const done = reached > index || move.status === 'completed';
        const current = reached === index && move.status !== 'completed';
        let icon = <Circle className="h-3.5 w-3.5" />;
        if (done) icon = <Check className="h-3.5 w-3.5 text-emerald-600" />;
        else if (current) icon = <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
        return (
          <li
            key={step}
            className={cn(
              'flex items-center gap-1 text-xs',
              current ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {icon}
            {lookup(t.status, step)}
          </li>
        );
      })}
    </ol>
  );
}

type Confirming = 'cancel' | 'recover' | null;

/** A move followed live: polled while it runs; the page reloads once it ends. */
function CurrentMoveCard({ initial, canManage }: Readonly<{ initial: DatabaseMoveView; canManage: boolean }>) {
  const t = adminCopy().databases.moves;
  const c = t.card;
  const router = useRouter();
  const [move, setMove] = useState(initial);
  const [confirming, setConfirming] = useState<Confirming>(null);
  // Set after mount only, so the server render and hydration agree.
  const [now, setNow] = useState<number | null>(null);

  const active = isActiveMove(move.status);

  const startedActive = isActiveMove(initial.status);

  useEffect(() => {
    setNow(Date.now());
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const result = await loadDatabaseMoveAction(initial.id);
      if (stopped) return;
      setNow(Date.now());
      if (result.ok) {
        setMove(result.data);
        if (!isActiveMove(result.data.status)) {
          // It ended while we watched: reload, so placement and history follow.
          if (startedActive) router.refresh();
          return;
        }
      }
      timer = setTimeout(poll, MOVE_POLL_INTERVAL_MS);
    };
    // A failed move does not change by itself; the one read fills in its detail (tables, verification).
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [initial.id, startedActive, router]);

  const percent = moveProgressPercent(move.progress);
  const tables = move.progress?.tables;
  const mode = now === null ? 'none' : recoverMode(move, now);
  const minutesStill = now === null ? 0 : Math.floor((now - Date.parse(move.updatedAt)) / 60_000);

  const cancel = async () => {
    const result = await cancelDatabaseMoveAction(move.id, move.workspaceId);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(t.cancel.done);
    setConfirming(null);
    router.refresh();
  };

  const recover = async () => {
    const result = await recoverDatabaseMoveAction(move.id, move.workspaceId, mode === 'force');
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(fill(t.recover.done, { status: lookup(t.status, result.data.status) }));
    if (!result.data.sourceUnlocked || !result.data.targetReleased) toast.warning(t.recover.incomplete);
    setConfirming(null);
    router.refresh();
  };

  return (
    <Card className="py-4">
      <CardContent className="space-y-4 px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{active ? c.title : c.lastTitle}</h3>
            <MoveStatusBadge status={move.status} />
            <span className="text-xs text-muted-foreground">{moveKindLabel(move.kind)}</span>
          </div>
          {active && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              {t.live}
            </span>
          )}
        </div>

        {move.status !== 'failed' && move.status !== 'cancelling' && <Steps move={move} />}

        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex items-center justify-between gap-4 border-b border-border/50 pb-1.5">
            <dt className="text-muted-foreground">{c.from}</dt>
            <dd className="min-w-0 break-all text-right">
              <Placement place={move.source} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 border-b border-border/50 pb-1.5">
            <dt className="text-muted-foreground">{c.to}</dt>
            <dd className="min-w-0 break-all text-right">
              <Placement place={move.target} />
            </dd>
          </div>
        </dl>

        {move.progress && (
          <div className="space-y-1.5">
            {percent !== null && <Progress value={percent} className="h-1.5" />}
            <p className="text-xs tabular-nums text-muted-foreground">
              {percent === null
                ? fill(c.progressUnknown, {
                    copied: move.progress.copiedRows.toLocaleString('en-GB'),
                  })
                : fill(c.progress, {
                    copied: move.progress.copiedRows.toLocaleString('en-GB'),
                    total: (move.progress.totalRows ?? 0).toLocaleString('en-GB'),
                    percent,
                  })}
              {tables && tables.length > 0 && (
                <>
                  {' · '}
                  {fill(c.tables, {
                    done: tables.filter((table) => table.done).length,
                    total: tables.length,
                  })}
                </>
              )}
            </p>
          </div>
        )}

        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            {fill(c.startedBy, {
              email: move.startedBy,
              time: formatDateTime(move.startedAt ?? move.createdAt),
            })}
          </p>
          {move.reason && (
            <p>
              {c.reason}: {move.reason}
            </p>
          )}
        </div>

        {move.cancelRequestedAt && move.status !== 'failed' && (
          <Notice tone="muted">
            {fill(c.cancelRequested, {
              time: formatDateTime(move.cancelRequestedAt),
            })}
          </Notice>
        )}
        {mode === 'force' && <Notice tone="warning">{fill(c.stale, { minutes: minutesStill })}</Notice>}
        {move.error && <Notice tone="warning">{move.error}</Notice>}
        <Verification move={move} />

        {canManage && (canCancelMove(move) || mode !== 'none') && (
          <div className="flex flex-wrap gap-2">
            {canCancelMove(move) && (
              <Button size="sm" variant="outline" onClick={() => setConfirming('cancel')}>
                {t.cancel.button}
              </Button>
            )}
            {mode !== 'none' && (
              <Button
                size="sm"
                variant={mode === 'force' ? 'destructive' : 'default'}
                onClick={() => setConfirming('recover')}
              >
                {mode === 'force' ? t.recover.forceButton : t.recover.button}
              </Button>
            )}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={confirming === 'cancel'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={t.cancel.title}
        description={t.cancel.description}
        confirmLabel={t.cancel.button}
        cancelLabel={t.close}
        variant="destructive"
        onConfirm={cancel}
      />
      <ConfirmDialog
        open={confirming === 'recover'}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={mode === 'force' ? t.recover.forceTitle : t.recover.title}
        description={mode === 'force' ? t.recover.forceDescription : t.recover.description}
        confirmLabel={mode === 'force' ? t.recover.forceButton : t.recover.button}
        cancelLabel={t.close}
        variant={mode === 'force' ? 'destructive' : 'default'}
        onConfirm={recover}
      />
    </Card>
  );
}

function Verification({ move }: Readonly<{ move: DatabaseMoveView }>) {
  const c = adminCopy().databases.moves.card;
  const v = move.verification;
  if (!v) return null;
  if (v.ok)
    return (
      <p className="text-xs text-emerald-700 dark:text-emerald-400">{fill(c.verified, { count: v.tableCount })}</p>
    );
  return (
    <div className="space-y-1">
      {v.mismatchedTables.length > 0 && (
        <Notice tone="warning">{fill(c.mismatched, { tables: v.mismatchedTables.join(', ') })}</Notice>
      )}
      {v.sourceChangedTables.length > 0 && (
        <Notice tone="warning">{fill(c.sourceChanged, { tables: v.sourceChangedTables.join(', ') })}</Notice>
      )}
    </div>
  );
}

/** Earlier moves of one workspace, newest first. */
function MoveHistoryTable({ moves }: Readonly<{ moves: DatabaseMoveView[] }>) {
  const t = adminCopy().databases.moves;
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader className="[&_tr]:border-border/70">
          <TableRow>
            <TableHead className="w-36 text-[13.5px]">{t.columns.status}</TableHead>
            <TableHead className="text-[13.5px]">{t.columns.move}</TableHead>
            <TableHead className="text-[13.5px]">{t.columns.startedBy}</TableHead>
            <TableHead className="w-44 text-[13.5px]">{t.columns.started}</TableHead>
            <TableHead className="w-44 text-[13.5px]">{t.columns.ended}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="[&_tr]:border-border/70">
          {moves.map((move) => (
            <TableRow key={move.id} className="align-top hover:bg-muted/50">
              <TableCell className="py-2.5">
                <MoveStatusBadge status={move.status} />
              </TableCell>
              <TableCell className="whitespace-normal py-2.5">
                <div className="text-sm">{moveKindLabel(move.kind)}</div>
                <MoveDestination
                  requestedTarget={move.requestedTarget}
                  targetShardId={move.target?.sharedProjectId ?? null}
                />
                {move.error && <p className="mt-1 text-xs text-destructive">{move.error}</p>}
                {move.oldDatabaseDropError && (
                  <p className="mt-1 text-xs text-destructive">
                    {fill(t.card.oldDropError, {
                      error: move.oldDatabaseDropError,
                    })}
                  </p>
                )}
                {move.status === 'completed' && move.oldDatabaseRetainedUntil && !move.oldDatabaseDroppedAt && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {fill(t.card.retainedUntil, {
                      date: formatDateTime(move.oldDatabaseRetainedUntil),
                    })}
                  </p>
                )}
                {move.oldDatabaseDroppedAt && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {fill(t.card.oldDropped, {
                      date: formatDateTime(move.oldDatabaseDroppedAt),
                    })}
                  </p>
                )}
              </TableCell>
              <TableCell className="py-2.5 text-xs">{move.startedBy}</TableCell>
              <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                {formatDateTime(move.startedAt ?? move.createdAt)}
              </TableCell>
              <TableCell className="py-2.5 text-xs tabular-nums text-muted-foreground">
                {move.completedAt ? formatDateTime(move.completedAt) : <Dash />}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
