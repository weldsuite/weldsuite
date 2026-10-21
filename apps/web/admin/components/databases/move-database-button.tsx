'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRightLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { ActionDialog } from '@/components/billing/action-dialog';
import { startDatabaseMoveAction } from '@/actions/databases';
import { adminCopy, fill } from '@/lib/i18n';
import type { MoveTargets } from '@/lib/database-moves';

interface TargetOption {
  value: string;
  label: string;
  hint: string;
}

function targetOptions(targets: MoveTargets, region: string): TargetOption[] {
  const t = adminCopy().databases.moves.dialog;
  const options: TargetOption[] = [];
  if (targets.auto)
    options.push({
      value: 'shard:auto',
      label: t.auto,
      hint: fill(t.autoHint, { region }),
    });
  for (const shard of targets.shards) {
    options.push({
      value: shard.id,
      label: shard.name,
      hint: fill(t.shardHint, {
        count: shard.databaseCount,
        max: shard.maxDatabases,
        percent: shard.fill.percent,
      }),
    });
  }
  if (targets.dedicated)
    options.push({
      value: 'dedicated',
      label: t.dedicated,
      hint: t.dedicatedHint,
    });
  return options;
}

/**
 * The Move button on a workspace's Database tab, for superadmins. Offers only
 * targets the worker would accept (see `moveTargets`); the worker checks again
 * when the move starts.
 */
export function MoveDatabaseButton({
  workspaceId,
  workspaceName,
  region,
  targets,
}: Readonly<{
  workspaceId: string;
  workspaceName: string;
  region: string;
  targets: MoveTargets;
}>) {
  const t = adminCopy().databases.moves;
  const router = useRouter();
  const options = targetOptions(targets, region);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(options[0]?.value ?? '');

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} disabled={options.length === 0}>
        <ArrowRightLeft className="h-4 w-4" />
        {t.move}
      </Button>
      {open && (
        <ActionDialog
          title={fill(t.dialog.title, { name: workspaceName })}
          description={t.dialog.description}
          submitLabel={t.dialog.submit}
          wide
          invalidMessage={target ? null : adminCopy().databases.moves.errors.invalidTarget}
          successMessage={t.dialog.started}
          onSubmit={(reason) => startDatabaseMoveAction(workspaceId, target, reason)}
          onClose={() => {
            setOpen(false);
            router.refresh();
          }}
        >
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">{t.dialog.target}</Label>
            <RadioGroup value={target} onValueChange={setTarget} className="gap-2">
              {options.map((option) => (
                <Label
                  key={option.value}
                  htmlFor={`move-target-${option.value}`}
                  className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[[data-state=checked]]:border-primary"
                >
                  <RadioGroupItem id={`move-target-${option.value}`} value={option.value} className="mt-0.5" />
                  <span className="space-y-0.5">
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </div>
        </ActionDialog>
      )}
    </>
  );
}
