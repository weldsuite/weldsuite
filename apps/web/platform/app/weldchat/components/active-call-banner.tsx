import { Button } from '@weldsuite/ui/components/button';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useQuery } from '@tanstack/react-query';
import { weldchatKeys } from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';
import type { ChatCall } from '@weldsuite/db/schema/chat-calls';
import { isFeatureAvailable } from '@/lib/edition';
import { useAuth } from '@/lib/auth';

interface ActiveCallBannerProps {
  channelId: string;
}

/** What the bar looks at: the call, and who is in it. */
interface BannerCall {
  id: string;
  status: string;
  participants?: ReadonlyArray<{ userId: string; leftAt?: string | null }> | null;
}

/**
 * The green "call in progress · Join" bar shows only for a call that is going
 * on with the user in it, while this tab is not connected to it (they joined
 * on another device, or reloaded): Join takes them back in. Not for a call
 * that only rings, has ended, or that they left; a call they are not in is
 * joined from its notice in the messages.
 */
export function showsActiveCallBar(
  call: BannerCall | null | undefined,
  userId: string | null | undefined,
  currentCallId: string | null | undefined,
): boolean {
  if (!call || !userId || call.status !== 'active' || call.id === currentCallId) return false;
  return (call.participants ?? []).some((p) => p.userId === userId && !p.leftAt);
}

export function ActiveCallBanner({ channelId }: Readonly<ActiveCallBannerProps>) {
  const { t } = useI18n();
  const { getClient } = useAppApiClient();
  const { callId: currentCallId, joinCall } = useWeldChatCall();
  const { userId } = useAuth();

  const { data } = useQuery({
    queryKey: weldchatKeys.activeCall(channelId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<{ data: ChatCall | null }>(`/chat-calls/active/${channelId}`);
    },
    staleTime: Infinity,
    enabled: isFeatureAvailable('chat-calls'),
  });

  const activeCall = data?.data;
  if (!activeCall || !showsActiveCallBar(activeCall, userId, currentCallId)) return null;

  const isVideo = activeCall.callType === 'video';
  const participantCount = (activeCall.participants || []).filter((p) => !p.leftAt).length;

  return (
    <div className="flex items-center gap-3 px-4 h-[45px] bg-green-500/10 dark:bg-green-500/5 border-b border-green-500/20">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
      </span>
      <span className="text-sm text-green-700 dark:text-green-400">
        {isVideo ? t.weldchat.activeCallBanner.videoCall : t.weldchat.activeCallBanner.voiceCall} {t.weldchat.activeCallBanner.call} &middot; {participantCount} {participantCount === 1 ? t.weldchat.activeCallBanner.person : t.weldchat.activeCallBanner.people}
      </span>
      <Button
        size="xs"
        className="ml-auto h-7 px-2.5 text-[14px] bg-green-600 text-white hover:bg-green-700"
        onClick={() => joinCall(activeCall.id)}
      >
        {t.weldchat.activeCallBanner.join}
      </Button>
    </div>
  );
}
