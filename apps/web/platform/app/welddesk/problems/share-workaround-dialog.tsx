import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { getTranslations } from '@/lib/i18n';
import {
  useShareDeskProblemWorkaround,
  type DeskProblem,
  type DeskProblemShareVisibility,
} from '@/hooks/queries/use-desk-problem-queries';
import { deskLinkErrorMessage, deskLinkRefusal } from '@/hooks/queries/use-desk-link-queries';

/**
 * "Share workaround with linked tickets": an internal note or a reply on
 * every open ticket of the problem, with the text editable first. Says how
 * many open tickets get it.
 */
export function ShareWorkaroundDialog({
  problem,
  open,
  onOpenChange,
}: Readonly<{ problem: DeskProblem; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const t = getTranslations('deskProblems');
  const share = useShareDeskProblemWorkaround();
  const [visibility, setVisibility] = useState<DeskProblemShareVisibility>('note');
  const [text, setText] = useState(problem.workaround ?? '');

  // Start from the saved workaround each time the dialog opens.
  useEffect(() => {
    if (open) {
      setText(problem.workaround ?? '');
      setVisibility('note');
    }
  }, [open, problem.workaround]);

  const recipients = problem.openIncidentCount;
  const submit = () => {
    share.mutate(
      { id: problem.id, body: text.trim(), visibility },
      {
        onSuccess: (res) => {
          const { delivered, skipped } = res.data;
          const done = (visibility === 'note' ? t.share.sharedNote : t.share.sharedReply).replace('{count}', String(delivered));
          toast.success(done);
          if (skipped > 0) toast.warning(t.share.skipped.replace('{count}', String(skipped)));
          onOpenChange(false);
        },
        onError: (err) => {
          const reason = deskLinkRefusal(err);
          const known = reason ? (t.refusals as Record<string, string>)[reason] : undefined;
          toast.error(known ?? deskLinkErrorMessage(err) ?? t.share.failed);
        },
      },
    );
  };

  let recipientsText = t.share.recipients.replace('{count}', String(recipients));
  if (recipients === 1) recipientsText = t.share.recipientsOne;
  if (recipients === 0) recipientsText = t.share.recipientsNone;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="desk-problem-share">
        <DialogHeader>
          <DialogTitle>{t.share.title}</DialogTitle>
          <DialogDescription>{t.share.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <RadioGroup value={visibility} onValueChange={(value) => setVisibility(value as DeskProblemShareVisibility)} className="gap-3">
            <Label htmlFor="desk-share-note" className="flex cursor-pointer items-start gap-3 font-normal">
              <RadioGroupItem id="desk-share-note" value="note" className="mt-0.5" />
              <span>
                <span className="block text-sm font-medium">{t.share.note}</span>
                <span className="block text-xs text-muted-foreground">{t.share.noteHint}</span>
              </span>
            </Label>
            <Label htmlFor="desk-share-reply" className="flex cursor-pointer items-start gap-3 font-normal">
              <RadioGroupItem id="desk-share-reply" value="reply" className="mt-0.5" />
              <span>
                <span className="block text-sm font-medium">{t.share.reply}</span>
                <span className="block text-xs text-muted-foreground">{t.share.replyHint}</span>
              </span>
            </Label>
          </RadioGroup>
          <div className="space-y-1.5">
            <Label htmlFor="desk-share-text">{t.share.textLabel}</Label>
            <Textarea
              id="desk-share-text"
              value={text}
              rows={5}
              maxLength={20_000}
              placeholder={t.share.textPlaceholder}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <InfoBanner variant={recipients === 0 ? 'warning' : 'info'}>{recipientsText}</InfoBanner>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={share.isPending}>
            {t.share.cancel}
          </Button>
          <Button onClick={submit} disabled={share.isPending || recipients === 0 || text.trim() === ''}>
            {t.share.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
