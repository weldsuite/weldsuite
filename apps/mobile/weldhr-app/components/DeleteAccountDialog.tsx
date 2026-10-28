/**
 * Deleting the member's WeldSuite account from the app, which the App Store
 * and Google Play require of any app that lets people sign up. It removes the
 * Clerk user (and with it every workspace membership); the employee record
 * belongs to the employer and stays with them, which the message says.
 */

import { useState } from 'react';
import { useUser } from '@clerk/expo';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { useI18n } from '@/lib/i18n';

export function DeleteAccountDialog({ visible, onClose }: Readonly<{ visible: boolean; onClose: () => void }>) {
  const { t, format } = useI18n();
  const { user } = useUser();
  const { signOut } = useClerkAuth();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (!user) return;
    setDeleting(true);
    try {
      await user.delete();
      // The session is gone with the user; signing out clears what the app kept.
      await signOut().catch(() => undefined);
    } catch {
      toast.error(t.deleteAccount.failed);
      setDeleting(false);
      onClose();
    }
  };

  return (
    <ConfirmModal
      visible={visible}
      title={t.deleteAccount.title}
      message={format(t.deleteAccount.message, { email: user?.primaryEmailAddress?.emailAddress ?? '' })}
      confirmText={t.deleteAccount.confirm}
      cancelText={t.common.cancel}
      variant="destructive"
      loading={deleting}
      onCancel={onClose}
      onConfirm={() => void remove()}
    />
  );
}
