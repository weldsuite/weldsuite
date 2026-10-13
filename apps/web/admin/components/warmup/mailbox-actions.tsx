'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@weldsuite/ui/components/button';
import { ActionDialog } from '@/components/billing/action-dialog';
import { pauseWarmupMailbox, resumeWarmupMailbox } from '@/actions/warmup-network';
import { STAFF_PAUSE_REASON, canPause, canResume, type PoolStatus } from '@/lib/warmup-network';

type Action = 'pause' | 'resume';

/** Resume wins for a paused mailbox; otherwise pause, when the status allows it. */
function actionFor(status: PoolStatus): Action | null {
  if (canResume(status)) return 'resume';
  return canPause(status) ? 'pause' : null;
}

/** Pause or resume one pool mailbox's warmup. Renders nothing for staff who cannot write or a status that allows neither. */
export function MailboxWarmupActions({
  mailbox,
  canWrite,
}: Readonly<{
  mailbox: { id: string; email: string; status: PoolStatus; pausedReason: string | null };
  canWrite: boolean;
}>) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Action | null>(null);

  const action = actionFor(mailbox.status);
  if (!canWrite || !action) return null;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5 text-xs"
        onClick={() => setDialog(action)}
        aria-label={`${action === 'pause' ? 'Pause' : 'Resume'} warmup for ${mailbox.email}`}
      >
        {action === 'pause' ? 'Pause' : 'Resume'}
      </Button>

      {dialog === 'pause' && (
        <ActionDialog
          title={`Pause warmup for ${mailbox.email}`}
          description="The mailbox stops sending and receiving warmup mail until you resume it. Its campaigns are not affected. The reason is kept in the activity log."
          submitLabel="Pause warmup"
          destructive
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            const result = await pauseWarmupMailbox(mailbox.id, reason);
            if (result.ok) router.refresh();
            return result;
          }}
          successMessage="Warmup paused"
        />
      )}

      {dialog === 'resume' && (
        <ActionDialog
          title={`Resume warmup for ${mailbox.email}`}
          description={
            mailbox.pausedReason === STAFF_PAUSE_REASON
              ? 'Warmup carries on where it had got to (warming up, or maintaining once past its ramp). The reason is kept in the activity log.'
              : 'This mailbox was not paused by staff, so check why it stopped first. Warmup carries on where it had got to. The reason is kept in the activity log.'
          }
          submitLabel="Resume warmup"
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            const result = await resumeWarmupMailbox(mailbox.id, reason);
            if (result.ok) router.refresh();
            return result;
          }}
          successMessage="Warmup resumed"
        />
      )}
    </>
  );
}
