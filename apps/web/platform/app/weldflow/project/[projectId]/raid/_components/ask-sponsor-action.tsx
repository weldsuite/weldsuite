import { useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import { useI18n } from '@/lib/i18n/provider';
import { useRequestRiskAcceptance } from '@/hooks/queries/use-flow-approvals-queries';

/** A risk that accepts a score of 9 or more has to be accepted by the sponsor. */
export function needsSponsorAcceptance(item: Pick<RaidItem, 'kind' | 'strategy' | 'score' | 'closedAt'>): boolean {
  return item.kind === 'risk' && item.strategy === 'accept' && (item.score ?? 0) >= 9 && item.closedAt === null;
}

/** "Ask the sponsor to accept": a button and a small dialog with an optional reason. */
export function AskSponsorAction({ item }: Readonly<{ item: RaidItem }>) {
  const { t, format } = useI18n();
  const copy = t.flowApprovals.raid;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const request = useRequestRiskAcceptance();

  const send = async () => {
    try {
      await request.mutateAsync({ id: item.id, note: note.trim() ? note.trim() : null });
      toast.success(copy.sent);
      setOpen(false);
      setNote('');
    } catch (error) {
      toast.error(isApiError(error) && error.message ? error.message : copy.failed);
    }
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ShieldCheck aria-hidden />
        {copy.askSponsor}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle>{format(copy.title, { code: item.code })}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <label htmlFor="sponsor-reason" className="text-sm font-medium">
              {copy.reason}
            </label>
            <Textarea id="sponsor-reason" rows={3} value={note} placeholder={copy.reasonPlaceholder} onChange={(event) => setNote(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t.flowApprovals.common.cancel}
            </Button>
            <Button type="button" disabled={request.isPending} onClick={() => void send()}>
              {request.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {copy.send}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
