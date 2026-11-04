import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Button } from '@weldsuite/ui/components/button';
import type { CloseRaidItem } from '@weldsuite/app-api-client/domains/project-closing';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useUpdateRaidItem } from '@/hooks/queries/use-project-control-queries';
import { closingKeys } from '@/hooks/queries/use-project-closing-queries';
import { statusLabel } from '@/app/weldflow/project/[projectId]/raid/_lib/copy';
import { statusTone } from '@/app/weldflow/project/[projectId]/raid/_lib/raid';
import { TONE_DOT, TONE_PILL } from '@/app/weldflow/project/[projectId]/raid/_lib/styles';
import { apiMessage } from '../_lib/api-error';
import { isRaidKind, raidCloseBody, raidClosedStatus } from '../_lib/close';
import { useClose } from './close-context';
import { HandoverDialog } from './handover-dialog';
import { PersonAvatar } from './person-avatar';

/** The open register items under the RAID check: hand each over or close it. */
export function RaidItems({ items }: Readonly<{ items: readonly CloseRaidItem[] }>) {
  const { t, format } = useI18n();
  const copy = t.flowClosing.close.raid;
  const { abilities, memberOf } = useClose();
  const [handing, setHanding] = useState<CloseRaidItem | null>(null);
  const [closing, setClosing] = useState<CloseRaidItem | null>(null);
  const update = useUpdateRaidItem();
  const qc = useQueryClient();

  const closeItem = async () => {
    if (!closing || !isRaidKind(closing.kind)) return;
    try {
      await update.mutateAsync({ id: closing.id, data: raidCloseBody(closing.kind) });
      // The item leaves the open list, so the checklist counts change too.
      await qc.invalidateQueries({ queryKey: closingKeys.checklists() });
      toast.success(format(copy.closeItem.success, { code: closing.code }));
      setClosing(null);
    } catch (error) {
      toast.error(apiMessage(error, copy.closeItem.failed));
    }
  };

  const closingKind = closing && isRaidKind(closing.kind) ? closing.kind : null;

  return (
    <div className="mt-2.5 ml-8 flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{copy.hint}</p>
      <ul aria-label={copy.heading} className="flex flex-col gap-2">
        {items.map((item) => {
          const kind = isRaidKind(item.kind) ? item.kind : null;
          const owner = memberOf(item.ownerId);
          const ownerName = owner?.name ?? t.flowClosing.shared.unknownMember;
          const tone = kind ? statusTone(kind, item.status) : 'neutral';
          return (
            <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2.5">
              <div className="min-w-0 flex-[1_1_14rem]">
                <div className="text-[13px]">
                  <span className="text-muted-foreground">{item.code}</span> <span className="font-medium">{item.title}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {kind ? <span>{t.projects.raid.kinds[kind]}</span> : null}
                  <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium', TONE_PILL[tone])}>
                    <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />
                    {kind ? statusLabel(t.projects.raid, kind, item.status) : item.status}
                  </span>
                  {item.ownerId ? (
                    <span className="inline-flex items-center gap-1.5">
                      <PersonAvatar name={ownerName} avatar={owner?.avatar} className="size-5" />
                      {format(copy.owner, { name: ownerName })}
                    </span>
                  ) : (
                    <span>{copy.noOwner}</span>
                  )}
                  {item.handedOver ? (
                    <span className="rounded-md bg-green-100 px-1.5 py-0.5 font-medium text-green-800 dark:bg-green-950 dark:text-green-200">
                      {copy.handedOver}
                    </span>
                  ) : null}
                </div>
              </div>
              {abilities.manage ? (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={format(copy.handOverAria, { code: item.code, title: item.title })}
                    onClick={() => setHanding(item)}
                  >
                    {copy.handOver}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={format(copy.closeAria, { code: item.code, title: item.title })}
                    onClick={() => setClosing(item)}
                  >
                    {copy.close}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <HandoverDialog key={handing?.id ?? 'none'} item={handing} onClose={() => setHanding(null)} />
      <ConfirmDialog
        open={closing !== null}
        onOpenChange={(open) => (open ? undefined : setClosing(null))}
        title={closing ? format(copy.closeItem.title, { code: closing.code }) : ''}
        description={
          closing && closingKind
            ? format(copy.closeItem.description, {
                title: closing.title,
                status: statusLabel(t.projects.raid, closingKind, raidClosedStatus(closingKind)),
              })
            : ''
        }
        confirmLabel={copy.closeItem.confirm}
        cancelLabel={t.flowClosing.shared.cancel}
        onConfirm={closeItem}
      />
    </div>
  );
}
