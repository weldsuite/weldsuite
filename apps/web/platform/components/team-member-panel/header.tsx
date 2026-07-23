import * as React from 'react';
import { Phone, Video, MessageSquare, Clock } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { StatusDot, STATUS_LABELS, type PresenceStatus } from '@weldsuite/ui/components/status-dot';
import { usePresence } from '@/contexts/presence-context';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { useDmByUser } from '@/hooks/queries/use-weldchat-queries';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { useNow, formatLocalTime, formatTimezoneOffset } from './use-now';
import type { MemberProfile } from '@weldsuite/core-api-client/schemas/member-profile';

interface TeamMemberPanelHeaderProps {
  profile: MemberProfile;
  onClose: () => void;
  isSelf: boolean;
}

export function TeamMemberPanelHeader({ profile, onClose, isSelf }: TeamMemberPanelHeaderProps) {
  const t = useTranslations();
  const { getStatus } = usePresence();
  const { startCall, status: callStatus } = useWeldChatCall();
  const dmQuery = useDmByUser(isSelf ? '' : profile.userId);
  const navigate = useNavigate();
  const now = useNow(30_000);

  const presence = getStatus(profile.userId);
  const status = (presence?.status ?? 'offline') as PresenceStatus;
  const statusLabel = STATUS_LABELS[status] ?? t('sweep.shared.offline');

  const localTime = formatLocalTime(now, profile.timezone);
  const tzOffset = formatTimezoneOffset(now, profile.timezone);

  const dmChannelId: string | undefined = dmQuery.data?.data?.id;
  const callInProgress = callStatus !== 'idle' && callStatus !== 'ended';

  const handleCall = async (kind: 'voice' | 'video') => {
    if (!dmChannelId) {
      toast.error(t('sweep.shared.unableToStartCallNoDm'));
      return;
    }
    if (callInProgress) {
      toast.error(t('sweep.shared.alreadyInACall'));
      return;
    }
    try {
      await startCall(dmChannelId, kind);
    } catch (err) {
      toast.error(t('sweep.shared.failedToStartCall'));
      console.error(err);
    }
  };

  const handleMessage = () => {
    if (!dmChannelId) return;
    navigate({ to: `/weldchat/c/${dmChannelId}` as any });
    onClose();
  };

  return (
    <div className="border-b px-6 pt-6 pb-4">
      <div className="flex items-start gap-4">
        <div className="relative shrink-0">
          {profile.picture ? (
            <img
              src={profile.picture}
              alt={profile.name ?? ''}
              className="h-16 w-16 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-xl font-medium uppercase">
              {(profile.name ?? '?').charAt(0)}
            </div>
          )}
          <StatusDot
            status={status}
            size="lg"
            className="absolute bottom-0 right-0 border-2 border-background"
          />
        </div>

        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold leading-tight truncate">
            {profile.name ?? profile.email ?? t('sweep.shared.teamMember')}
          </h2>
          {profile.title && (
            <p className="text-sm text-muted-foreground truncate">{profile.title}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <StatusDot status={status} size="sm" />
              {presence?.statusText || statusLabel}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {localTime}
              {tzOffset && <span className="text-muted-foreground/70">({tzOffset})</span>}
            </span>
            {status === 'busy' && (
              <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-medium text-orange-900 dark:bg-orange-500/20 dark:text-orange-200">
                {t('sweep.shared.inACall')}
              </span>
            )}
          </div>
        </div>

        {!isSelf && (
          <div className="flex shrink-0 gap-1">
            <Button
              size="icon"
              variant="outline"
              onClick={handleMessage}
              disabled={!dmChannelId}
              title={t('sweep.shared.message')}
            >
              <MessageSquare className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              onClick={() => handleCall('voice')}
              disabled={!dmChannelId || callInProgress}
              title={t('sweep.shared.voiceCall')}
            >
              <Phone className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              onClick={() => handleCall('video')}
              disabled={!dmChannelId || callInProgress}
              title={t('sweep.shared.videoCall')}
            >
              <Video className="h-[18px] w-[18px]" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
