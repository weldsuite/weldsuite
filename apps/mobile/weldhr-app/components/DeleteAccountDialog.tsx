/**
 * Deleting the member's WeldSuite account from the app, which the App Store
 * and Google Play require of any app that lets people sign up. It goes through
 * app-api's `/api/account` (like the platform's Security settings), not
 * straight to Clerk: that route refuses while the member is the only admin of
 * a workspace with other members, deletes the workspaces they are alone in,
 * and clears their rows in the master DB. The employee record belongs to the
 * employer and stays with them, which the message says.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useUser } from '@clerk/expo';
import { DELETE_ACCOUNT_CONFIRMATION } from '@weldsuite/app-api-client/schemas/account';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { useI18n } from '@/lib/i18n';
import { appApi } from '@/services/app-api';

export function DeleteAccountDialog({ visible, onClose }: Readonly<{ visible: boolean; onClose: () => void }>) {
  const { t, format } = useI18n();
  const { user } = useUser();
  const { signOut } = useClerkAuth();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  // Asked fresh every time the dialog opens: a blocker may have been solved on the web meanwhile.
  const status = useQuery({
    queryKey: ['account', 'deletion-status'],
    queryFn: async () => (await appApi.account.getDeletionStatus()).data,
    enabled: visible,
    staleTime: 0,
    retry: 1,
  });

  const failed = visible && status.isError && !status.isFetching;
  useEffect(() => {
    if (!failed) return;
    toast.error(t.deleteAccount.failed);
    onClose();
  }, [failed, toast, t, onClose]);

  const remove = async () => {
    setDeleting(true);
    try {
      await appApi.account.deleteAccount({ confirmation: DELETE_ACCOUNT_CONFIRMATION });
    } catch {
      // 409 when a blocker appeared since the check; the toast says to try again.
      toast.error(t.deleteAccount.failed);
      setDeleting(false);
      onClose();
      return;
    }
    // The user is gone at Clerk; signing out clears what the app kept.
    await signOut().catch(() => undefined);
  };

  const blockers = status.data?.blockers ?? [];
  if (blockers.length > 0 && !status.isFetching) {
    return (
      <ConfirmModal
        visible={visible}
        title={t.deleteAccount.blockedTitle}
        message={format(t.deleteAccount.blockedMessage, { workspaces: blockers.map((b) => b.name).join(', ') })}
        confirmText={t.common.close}
        cancelText={t.common.cancel}
        onCancel={onClose}
        onConfirm={onClose}
      />
    );
  }

  const alone = status.data?.workspacesToDelete ?? [];
  const message = format(t.deleteAccount.message, { email: user?.primaryEmailAddress?.emailAddress ?? '' });
  return (
    <ConfirmModal
      visible={visible}
      title={t.deleteAccount.title}
      message={
        alone.length > 0
          ? `${message}\n\n${format(t.deleteAccount.workspacesDeleted, { workspaces: alone.map((w) => w.name).join(', ') })}`
          : message
      }
      confirmText={t.deleteAccount.confirm}
      cancelText={t.common.cancel}
      variant="destructive"
      loading={deleting || status.isFetching || failed}
      onCancel={onClose}
      onConfirm={() => void remove()}
    />
  );
}
