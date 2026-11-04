import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import type { CloseRaidItem } from '@weldsuite/app-api-client/domains/project-closing';
import { useI18n } from '@/lib/i18n/provider';
import { useHandOver } from '@/hooks/queries/use-project-closing-queries';
import { apiMessage } from '../_lib/api-error';
import { useClose } from './close-context';
import { MemberSelect } from './member-select';

/** Hand one open register item to a new owner. Mount it with `key={item.id}` so each item starts fresh. */
export function HandoverDialog({ item, onClose }: Readonly<{ item: CloseRaidItem | null; onClose: () => void }>) {
  const { t, format } = useI18n();
  const copy = t.flowClosing.close.raid.handover;
  const { projectId, members, memberOf, checklist } = useClose();
  const handOver = useHandOver(projectId);
  const [ownerId, setOwnerId] = useState<string | null>(item?.ownerId ?? checklist.signOff.sponsorId ?? null);
  const [touched, setTouched] = useState(false);

  const submit = async () => {
    if (!item) return;
    if (!ownerId) {
      setTouched(true);
      return;
    }
    try {
      await handOver.mutateAsync({ raidItems: [{ id: item.id, ownerId }] });
      toast.success(format(copy.success, { code: item.code, name: memberOf(ownerId)?.name ?? t.flowClosing.shared.unknownMember }));
      onClose();
    } catch (error) {
      toast.error(apiMessage(error, copy.failed));
    }
  };

  return (
    <Dialog open={item !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        {item ? (
          <>
            <DialogHeader>
              <DialogTitle>{format(copy.title, { code: item.code })}</DialogTitle>
              <DialogDescription>{format(copy.description, { title: item.title })}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="handover-owner">{copy.owner}</Label>
              <MemberSelect
                id="handover-owner"
                members={members}
                value={ownerId}
                onChange={(next) => setOwnerId(next)}
                placeholder={t.flowClosing.shared.choosePerson}
                aria-invalid={touched && !ownerId}
              />
              {touched && !ownerId ? (
                <p role="alert" className="text-sm text-destructive">
                  {copy.ownerRequired}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={handOver.isPending}>
                {t.flowClosing.shared.cancel}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={handOver.isPending}>
                {handOver.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
                {handOver.isPending ? copy.submitting : copy.submit}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
