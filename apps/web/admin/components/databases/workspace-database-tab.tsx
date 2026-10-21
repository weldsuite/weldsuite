import { adminCopy, fill } from '@/lib/i18n';
import { hasMoveTargets, isActiveMove } from '@/lib/database-moves';
import type { WorkspaceDatabaseTabData } from '@/lib/database-moves-data';
import type { WorkspaceDatabase } from '@/lib/databases-data';
import { DatabaseMovesPanel } from './database-moves-panel';
import { MoveDatabaseButton } from './move-database-button';
import { WorkspaceDatabaseCard } from './workspace-database-card';

/**
 * A workspace's Database tab: where the database lives, its compute, and its
 * moves, with the Move button for a superadmin.
 */
export function WorkspaceDatabaseTab({
  workspaceId,
  workspaceName,
  database,
  data,
  canManage,
}: Readonly<{
  workspaceId: string;
  workspaceName: string;
  database: WorkspaceDatabase;
  data: WorkspaceDatabaseTabData;
  /** A superadmin, on a workspace that is not deleted. */
  canManage: boolean;
}>) {
  const t = adminCopy().databases.moves;

  const note = (text: string) => <p className="max-w-xs text-xs text-muted-foreground sm:text-right">{text}</p>;
  let action: React.ReactNode = null;
  if (!canManage) {
    action = note(t.superadminOnly);
  } else if (data.moves.kind === 'ok') {
    const running = data.moves.data.some((move) => isActiveMove(move.status));
    if (running) action = note(t.running);
    else if (database.placement === 'none') action = note(t.noDatabase);
    else if (!data.targets || !hasMoveTargets(data.targets))
      action = note(fill(t.noTargets, { region: database.region ?? '' }));
    else {
      action = (
        <MoveDatabaseButton
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          region={database.region ?? ''}
          targets={data.targets}
        />
      );
    }
  }

  return (
    <div className="space-y-6">
      <WorkspaceDatabaseCard database={database} compute={data.compute} />
      <DatabaseMovesPanel state={data.moves} canManage={canManage} action={action} />
    </div>
  );
}
