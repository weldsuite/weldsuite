/** An item's saved versions, with restore. Restoring writes a new version. */

import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import type { WeldPassItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import {
  useRestoreWeldPassItem,
  useWeldPassItemVersions,
} from '@/hooks/queries/use-weldpass-passwords-queries';
import { ErrorBanner, InlineSpinner, TimeAgo, errorMessage } from '../../components/shared';
import { usePasswordsT } from '../lib/use-passwords-t';

const KNOWN_ACTIONS = new Set(['created', 'updated', 'restored', 'deleted']);

export function ItemHistoryPanel({
  item,
  onRestored,
}: Readonly<{ item: WeldPassItem; onRestored: () => void }>) {
  const tp = usePasswordsT();
  const { data: versions, isLoading, error } = useWeldPassItemVersions(item.vaultId, item.id);
  const restore = useRestoreWeldPassItem();
  const [failure, setFailure] = useState<string | null>(null);

  async function restoreVersion(version: number) {
    setFailure(null);
    try {
      await restore.mutateAsync({ vaultId: item.vaultId, itemId: item.id, version });
      onRestored();
    } catch (err) {
      setFailure(errorMessage(err, tp('history.restoreFailed')));
    }
  }

  return (
    <div className="space-y-3">
      <ErrorBanner
        error={failure ?? (error ? errorMessage(error, tp('history.loadFailed')) : null)}
      />

      {isLoading ? (
        <InlineSpinner />
      ) : (
        <div className="max-h-[50vh] space-y-1 overflow-y-auto">
          {versions?.map((version) => (
            <div
              key={version.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  v{version.version} ·{' '}
                  {KNOWN_ACTIONS.has(version.action)
                    ? tp(`history.actions.${version.action}`)
                    : version.action}
                  {version.version === item.version && (
                    <span className="ml-1.5 text-muted-foreground">({tp('history.current')})</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  <TimeAgo value={version.createdAt} />
                </p>
              </div>
              {version.version !== item.version && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={restore.isPending}
                  onClick={() => void restoreVersion(version.version)}
                >
                  {tp('history.restore')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">{tp('history.restoreNote')}</p>
    </div>
  );
}
