import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useRequestSignOff } from '@/hooks/queries/use-project-closing-queries';
import { intlLocaleOf } from '@/app/weldflow/project/[projectId]/raid/_lib/locale';
import { apiMessage } from '../_lib/api-error';
import { formatDay, openBlockingChecks } from '../_lib/close';
import { useClose } from './close-context';
import { PersonAvatar } from './person-avatar';

function RequestDialog({ open, onClose, sponsorName }: Readonly<{ open: boolean; onClose: () => void; sponsorName: string | null }>) {
  const { t, format } = useI18n();
  const copy = t.flowClosing.close.signoff;
  const { projectId } = useClose();
  const request = useRequestSignOff(projectId);
  const [note, setNote] = useState('');

  const submit = async () => {
    try {
      await request.mutateAsync({ note: note.trim() || null });
      toast.success(sponsorName ? format(copy.success, { name: sponsorName }) : copy.successNoSponsor);
      setNote('');
      onClose();
    } catch (error) {
      toast.error(apiMessage(error, copy.failed));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.dialog.title}</DialogTitle>
          <DialogDescription>{sponsorName ? format(copy.dialog.description, { name: sponsorName }) : copy.dialog.descriptionNoSponsor}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="signoff-note">{copy.dialog.note}</Label>
          <Textarea id="signoff-note" rows={3} value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} placeholder={copy.dialog.notePlaceholder} />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={request.isPending}>
            {t.flowClosing.shared.cancel}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={request.isPending}>
            {request.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {request.isPending ? copy.dialog.submitting : copy.dialog.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The sponsor, the state of the sign-off, and the request. */
export function SignOffCard() {
  const { t, language, plural, format } = useI18n();
  const copy = t.flowClosing.close.signoff;
  const { checklist, memberOf, abilities, userId } = useClose();
  const [requesting, setRequesting] = useState(false);
  const { signOff } = checklist;
  const sponsor = memberOf(signOff.sponsorId);
  const sponsorName = signOff.sponsorId ? (sponsor?.name ?? t.flowClosing.shared.unknownMember) : null;
  const locale = intlLocaleOf(language);
  const blocking = openBlockingChecks(checklist.checks);
  const names = t.flowClosing.close.checklist.names;
  const isApprover = signOff.state === 'pending' && signOff.approval?.approverId === userId && userId !== null;

  const descriptionKey = checklist.closed ? 'closed' : signOff.state;
  const dateIso = signOff.state === 'pending' ? signOff.approval?.requestedAt : signOff.approval?.decidedAt;
  const date = formatDay(dateIso ?? null, locale);
  let description: string = copy.description.closed;
  if (descriptionKey !== 'closed') {
    const withName = sponsorName !== null;
    const key = (withName ? descriptionKey : `${descriptionKey}NoSponsor`) as keyof typeof copy.description;
    description = format(copy.description[key], { name: sponsorName ?? '', date });
  }

  let reason: string | null = null;
  if (!checklist.closed && abilities.manage && !checklist.canRequest && signOff.state !== 'pending') {
    reason = format(plural(blocking.length, copy.blockedReason), { checks: blocking.map((check) => names[check.key]).join(', ') });
  } else if (!checklist.closed && !abilities.manage && !isApprover) {
    reason = copy.managersOnly;
  }

  return (
    <section aria-labelledby="close-signoff-title" className="flex flex-wrap items-center gap-4 rounded-xl border bg-card p-4">
      <PersonAvatar name={sponsorName ?? '?'} avatar={sponsor?.avatar} className="size-10 text-sm" />
      <div className="min-w-0 flex-[1_1_20rem]">
        <h3 id="close-signoff-title" className="text-sm font-semibold">
          {sponsorName ? format(copy.titleWithName, { name: sponsorName }) : copy.title}
        </h3>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
        {signOff.state === 'rejected' && signOff.approval?.note ? (
          <blockquote className="mt-2 border-l-2 pl-3 text-[13px]">
            <span className="block text-xs text-muted-foreground">{copy.noteLabel}</span>
            {signOff.approval.note}
          </blockquote>
        ) : null}
      </div>
      {reason ? (
        <span id="signoff-reason" className="max-w-xs text-xs text-amber-700 dark:text-amber-400">
          {reason}
        </span>
      ) : null}
      {checklist.closed ? (
        <span className="rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-800 dark:bg-green-950 dark:text-green-200">{copy.closed}</span>
      ) : isApprover ? (
        <div className="flex flex-col items-start gap-1">
          <span className="text-xs text-muted-foreground">{copy.answerInReviews}</span>
          <Button asChild>
            <Link href="/weldflow/reviews">{copy.openReviews}</Link>
          </Button>
        </div>
      ) : abilities.manage ? (
        <Button
          type="button"
          disabled={!checklist.canRequest || signOff.state === 'pending'}
          aria-describedby={reason ? 'signoff-reason' : undefined}
          onClick={() => setRequesting(true)}
        >
          {signOff.state === 'pending' ? copy.requested : copy.request}
        </Button>
      ) : null}
      <RequestDialog open={requesting} onClose={() => setRequesting(false)} sponsorName={sponsorName} />
    </section>
  );
}
