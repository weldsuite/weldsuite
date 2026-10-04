/**
 * "Share" an item by moving it into a shared vault. The dialog spells out what
 * that means: everyone in the target can see it, and its history stays behind.
 */

import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type {
  WeldPassItem,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { useMoveWeldPassItem } from '@/hooks/queries/use-weldpass-passwords-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { usePasswordsT } from '../lib/use-passwords-t';

export function MoveItemDialog({
  item,
  targets,
  vaultLabel,
  onClose,
  onMoved,
}: Readonly<{
  item: WeldPassItem;
  /** Vaults where the caller is editor or manager, minus the item's own. */
  targets: WeldPassVault[];
  vaultLabel: (vault: WeldPassVault) => string;
  onClose: () => void;
  onMoved: () => void;
}>) {
  const tp = usePasswordsT();
  const move = useMoveWeldPassItem();
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [failure, setFailure] = useState<string | null>(null);

  const target = targets.find((vault) => vault.id === targetId);

  async function submit() {
    if (!target) return;
    setFailure(null);
    try {
      await move.mutateAsync({
        vaultId: item.vaultId,
        itemId: item.id,
        targetVaultId: target.id,
      });
      onMoved();
    } catch (err) {
      setFailure(errorMessage(err, tp('move.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !move.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{tp('move.title', { title: item.title })}</DialogTitle>
          <DialogDescription>{tp('move.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

          {targets.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              {tp('move.noTargets')}
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="weldpass-move-target">{tp('move.target')}</Label>
                <Select value={targetId} onValueChange={setTargetId}>
                  <SelectTrigger id="weldpass-move-target">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {targets.map((vault) => (
                      <SelectItem key={vault.id} value={vault.id}>
                        {vaultLabel(vault)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="space-y-1">
                  {target?.kind === 'shared' && (
                    <p>
                      {tp('move.visibleToVault', { vault: vaultLabel(target) })}
                    </p>
                  )}
                  <p>{tp('move.historyStays')}</p>
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={move.isPending}>
            {tp('common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!target || move.isPending}>
            {move.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {tp('move.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
