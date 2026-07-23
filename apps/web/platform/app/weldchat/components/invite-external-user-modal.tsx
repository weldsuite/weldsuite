import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useAddChannelMembers } from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface InviteExternalUserModalProps {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface InviteResponse {
  data?: {
    memberId: string;
    memberType: 'INTERNAL' | 'EXTERNAL_GUEST';
    /** True when the invitee already had a Clerk identity and was added directly. */
    activated: boolean;
  };
}

/**
 * One-shot "invite external user to channel" flow:
 *   1. POST /api/team-members/invite { memberType: 'EXTERNAL_GUEST' }
 *      Backend either (a) finds an existing Clerk user and adds them
 *      directly (ACTIVE), or (b) sends a Clerk invitation email (PENDING).
 *   2. If ACTIVE, immediately add them to the current channel via the
 *      existing addChannelMembers mutation.
 *   3. If PENDING, surface a hint that they'll be added once they accept.
 *
 * Gated by the `team:invite_external` permission server-side; the UI
 * surfaces the 403 error message verbatim when the user lacks it.
 */
export function InviteExternalUserModal({
  channelId,
  open,
  onOpenChange,
}: InviteExternalUserModalProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const ts = (t as any).weldchat?.inviteExternal;
  const { getClient } = useAppApiClient();
  const { mutateAsync: addMembers } = useAddChannelMembers();
  const qc = useQueryClient();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEmail('');
    setName('');
    setError(null);
    setSubmitting(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !name) return;

    setError(null);
    setSubmitting(true);

    try {
      const client = await getClient();
      const res = await client.post<InviteResponse>('/team-members/invite', {
        email: email.trim(),
        name: name.trim(),
        memberType: 'EXTERNAL_GUEST',
      });

      const data = res?.data;
      if (!data) throw new Error('Empty response');

      if (data.activated) {
        // Existing Clerk identity → add to channel right now.
        await addMembers({ channelId, userIds: [data.memberId] });
        await qc.invalidateQueries({ queryKey: ['installed-apps'] });
        toast.success(st('sweep.weldchat.inviteExternal.addedToChannel', { name: name.trim() }));
      } else {
        // Pending invitation — they'll appear once they accept the email.
        toast.success(
          ts?.pending ?? 'Invitation sent. They\'ll join the channel automatically once they accept.',
        );
      }
      reset();
      onOpenChange(false);
    } catch (err: any) {
      const msg = err?.message || err?.error?.message || ts?.genericError || 'Failed to send invitation';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            {ts?.title ?? 'Invite an external guest'}
          </DialogTitle>
          <DialogDescription>
            {ts?.description ?? 'Add a client, freelancer, vendor, or partner to this channel. Guests only see the channels you invite them to and don\'t use a paid seat.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="invite-external-name">{ts?.nameLabel ?? 'Name'}</Label>
            <Input
              id="invite-external-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={ts?.namePlaceholder ?? 'Jane Doe'}
              autoFocus
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="invite-external-email">{ts?.emailLabel ?? 'Email'}</Label>
            <Input
              id="invite-external-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={ts?.emailPlaceholder ?? 'jane@example.com'}
              required
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {ts?.cancel ?? 'Cancel'}
            </Button>
            <Button type="submit" disabled={submitting || !email || !name}>
              {submitting ? (ts?.submitting ?? 'Sending...') : (ts?.submit ?? 'Send invitation')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
