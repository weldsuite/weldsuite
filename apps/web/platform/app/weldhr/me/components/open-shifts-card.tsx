/**
 * My HR → Schedule: open shifts you can sign up for. A sign-up goes to your
 * manager, who approves it (the shift lands on your rooster) or turns it down.
 * Your own pending sign-up can be withdrawn.
 */

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfOpenShift } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useMyHrCancelShiftRequest,
  useMyHrOpenShifts,
  useMyHrSignUpForOpenShift,
} from '@/hooks/queries/use-weldhr-queries';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { ErrorBanner, errorMessage, formatDateTime, useFormatTime } from '../../components/shared';
import { TabLoading } from './shared';

const REQUEST_TONE = { approved: 'default', rejected: 'destructive' } as const;

/** My sign-up for the shift, unless it was withdrawn (then it is as if I never signed up). */
function activeRequest(shift: HrSelfOpenShift) {
  return shift.myRequest && shift.myRequest.status !== 'cancelled' ? shift.myRequest : null;
}

export function OpenShiftsCard() {
  const t = useTranslations();
  const formatTime = useFormatTime();
  const { data, isLoading, error } = useMyHrOpenShifts();
  const cancelRequest = useMyHrCancelShiftRequest();
  const [signUpTarget, setSignUpTarget] = useState<HrSelfOpenShift | null>(null);

  async function withdraw(requestId: string) {
    try {
      await cancelRequest.mutateAsync(requestId);
      toast.success(t('weldhr.me.openShifts.withdrawnToast'));
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.me.openShifts.withdrawFailed')));
    }
  }

  function spotsLabel(spotsLeft: number): string {
    if (spotsLeft === 0) return t('weldhr.me.openShifts.full');
    return t(spotsLeft === 1 ? 'weldhr.me.openShifts.spotsLeft' : 'weldhr.me.openShifts.spotsLeftPlural', { count: spotsLeft });
  }

  let body: ReactNode;
  if (isLoading) body = <TabLoading />;
  else if (!data) body = <ErrorBanner error={errorMessage(error, t('weldhr.me.openShifts.loadFailed'))} />;
  else if (data.length === 0) body = <EmptyText>{t('weldhr.me.openShifts.empty')}</EmptyText>;
  else {
    body = (
      <ul className="divide-y">
        {data.map((shift) => {
          const request = activeRequest(shift);
          const details = [shift.workType, shift.companyName, shift.departmentName].filter(Boolean).join(' · ');
          return (
            <li key={shift.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-0.5 text-sm">
                <p className="font-medium tabular-nums">
                  {formatDateTime(shift.startsAt)} – {formatTime(shift.endsAt)}
                </p>
                {details && <p className="text-muted-foreground">{details}</p>}
                {shift.notes && <p className="whitespace-pre-wrap break-words text-muted-foreground">{shift.notes}</p>}
                <p className="text-xs text-muted-foreground">{spotsLabel(shift.spotsLeft)}</p>
                {request?.status === 'rejected' && request.reviewNote && (
                  <p className="text-xs text-muted-foreground">{t('weldhr.me.openShifts.reviewNote', { note: request.reviewNote })}</p>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                {request ? (
                  <>
                    <Badge variant={REQUEST_TONE[request.status as keyof typeof REQUEST_TONE] ?? 'outline'}>
                      {t(`weldhr.me.openShifts.status.${request.status}`)}
                    </Badge>
                    {request.status === 'pending' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={cancelRequest.isPending}
                        onClick={() => void withdraw(request.id)}
                      >
                        {cancelRequest.isPending && cancelRequest.variables === request.id && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                        {t('weldhr.me.openShifts.withdraw')}
                      </Button>
                    )}
                  </>
                ) : (
                  <Button size="sm" disabled={shift.spotsLeft === 0} onClick={() => setSignUpTarget(shift)}>
                    {t('weldhr.me.openShifts.signUp')}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      <SectionCard title={t('weldhr.me.openShifts.title')}>
        <p className="-mt-1 mb-3 text-sm text-muted-foreground">{t('weldhr.me.openShifts.description')}</p>
        {body}
      </SectionCard>

      {signUpTarget && <SignUpDialog shift={signUpTarget} onClose={() => setSignUpTarget(null)} />}
    </>
  );
}

function SignUpDialog({ shift, onClose }: Readonly<{ shift: HrSelfOpenShift; onClose: () => void }>) {
  const t = useTranslations();
  const formatTime = useFormatTime();
  const signUp = useMyHrSignUpForOpenShift();
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    setFailure(null);
    try {
      await signUp.mutateAsync({ id: shift.id, note: note.trim() || null });
      toast.success(t('weldhr.me.openShifts.signedUpToast'));
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.me.openShifts.signUpFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !signUp.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('weldhr.me.openShifts.signUpTitle')}</DialogTitle>
          <DialogDescription className="tabular-nums">
            {formatDateTime(shift.startsAt)} – {formatTime(shift.endsAt)}
            {shift.workType && ` · ${shift.workType}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />
          <div className="space-y-1.5">
            <Label htmlFor="my-hr-open-shift-note">{t('weldhr.me.openShifts.noteLabel')}</Label>
            <Textarea
              id="my-hr-open-shift-note"
              rows={3}
              maxLength={1000}
              value={note}
              placeholder={t('weldhr.me.openShifts.notePlaceholder')}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={signUp.isPending}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={signUp.isPending}>
            {signUp.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('weldhr.me.openShifts.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
