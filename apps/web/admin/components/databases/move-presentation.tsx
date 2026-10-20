import Link from 'next/link';
import { Badge } from '@weldsuite/ui/components/badge';
import { adminCopy, fill } from '@/lib/i18n';
import type { ComputeState, DatabaseMoveKind, DatabaseMoveStatus, WorkerState } from '@/lib/database-moves';
import { Notice, lookup } from './presentation';

// Badges and labels for moves and live compute. Usable from server pages and
// from the client move panel alike: nothing here reads the database.

const MOVE_STATUS_VARIANT: Record<DatabaseMoveStatus, 'outline' | 'warning' | 'success' | 'destructive' | 'secondary'> =
  {
    queued: 'outline',
    preparing: 'outline',
    soft_locked: 'warning',
    locked: 'warning',
    copying: 'warning',
    verifying: 'warning',
    switching: 'warning',
    completed: 'success',
    failed: 'destructive',
    cancelling: 'warning',
    cancelled: 'secondary',
  };

export function MoveStatusBadge({ status }: Readonly<{ status: DatabaseMoveStatus }>) {
  const t = adminCopy().databases.moves;
  return <Badge variant={MOVE_STATUS_VARIANT[status] ?? 'secondary'}>{lookup(t.status, status)}</Badge>;
}

export function moveKindLabel(kind: DatabaseMoveKind): string {
  return lookup(adminCopy().databases.moves.kind, kind);
}

const COMPUTE_VARIANT: Record<ComputeState, 'success' | 'secondary' | 'warning' | 'outline'> = {
  active: 'success',
  suspended: 'secondary',
  starting: 'warning',
  unknown: 'outline',
};

export function ComputeBadge({ state }: Readonly<{ state: ComputeState }>) {
  const t = adminCopy().databases.compute;
  return <Badge variant={COMPUTE_VARIANT[state]}>{t.state[state]}</Badge>;
}

/** Why the live columns are missing: the worker is not wired up, or it did not answer. Nothing when it did. */
export function LiveStateNotice({ state }: Readonly<{ state: WorkerState<unknown> }>) {
  const t = adminCopy().databases.compute;
  if (state.kind === 'ok') return null;
  return (
    <Notice tone="muted">
      {state.kind === 'not_configured' ? t.notConfigured : fill(t.unavailable, { message: state.message })}
    </Notice>
  );
}

/**
 * Where a move goes: the shard it reserved, else what was asked for. A shard is
 * shown by id (the move rows do not carry its name), linked to its page.
 */
export function MoveDestination({
  requestedTarget,
  targetShardId,
}: Readonly<{ requestedTarget: string; targetShardId: string | null }>) {
  const t = adminCopy().databases.moves;
  const shardId = targetShardId ?? (requestedTarget.startsWith('nsp_') ? requestedTarget : null);
  if (shardId) {
    return (
      <Link href={`/databases/shards/${shardId}`} className="font-mono text-xs underline-offset-2 hover:underline">
        {shardId}
      </Link>
    );
  }
  return <span className="text-sm">{requestedTarget === 'dedicated' ? t.target.dedicated : t.target.auto}</span>;
}
