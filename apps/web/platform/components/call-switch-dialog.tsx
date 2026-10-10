/**
 * The one dialog that asks before a second call replaces the live one.
 *
 * Mounted once in the app shell. Every entry point (WeldChat call buttons, the
 * incoming-call toast, a WeldMeet link) goes through the active-call
 * coordinator, which opens this when the user is already in a call or meeting.
 */

import { useRef } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useCallSwitchDialog, type SwitchDialogState } from '@/contexts/active-call-context';
import { useI18n } from '@/lib/i18n/provider';

export function CallSwitchDialog() {
  // Lazy-loaded + globally mounted in the shell: render nothing, rather than
  // crash it, when the coordinator is not mounted (e.g. an HMR re-import).
  const ctx = useCallSwitchDialog();
  if (!ctx) return null;
  return <CallSwitchDialogInner {...ctx} />;
}

function CallSwitchDialogInner({
  dialog,
  confirm,
  dismiss,
}: Readonly<NonNullable<ReturnType<typeof useCallSwitchDialog>>>) {
  const { t } = useI18n();
  const copy = t.weldchat.switchCallDialog;

  // The text stays put while the dialog fades out instead of going blank.
  const lastDialogRef = useRef<SwitchDialogState | null>(dialog);
  if (dialog) lastDialogRef.current = dialog;
  const shown = dialog ?? lastDialogRef.current;

  return (
    <ConfirmDialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
      title={shown?.target.kind === 'meet' ? copy.titleMeeting : copy.title}
      description={
        shown
          ? copy.description.replace('{current}', shown.current).replace('{target}', shown.target.label)
          : ''
      }
      confirmLabel={copy.leaveAndJoin}
      cancelLabel={copy.stay}
      variant="destructive"
      loading={dialog?.switching ?? false}
      onConfirm={confirm}
    />
  );
}
