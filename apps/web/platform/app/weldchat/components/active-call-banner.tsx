import { Phone, Video } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useQuery } from '@tanstack/react-query';
import { weldchatKeys } from '@/hooks/queries/use-weldchat-queries';
import { useI18n } from '@/lib/i18n/provider';

interface ActiveCallBannerProps {
  channelId: string;
}

export function ActiveCallBanner({ channelId }: ActiveCallBannerProps) {
  const { t } = useI18n();
  const { getClient } = useAppApiClient();
  const { status, callId: currentCallId, joinCall } = useWeldChatCall();

  const { data } = useQuery({
    queryKey: weldchatKeys.activeCall(channelId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<any>(`/chat-calls/active/${channelId}`);
    },
    staleTime: Infinity,
  });

  const activeCall = data?.data;
  if (!activeCall) return null;

  // Don't show banner if we're already in this call
  if (currentCallId === activeCall.id) return null;
  // Don't show if we're already in any call
  if (status !== 'idle') return null;

  const isVideo = activeCall.callType === 'video';
  const participantCount = (activeCall.participants || []).filter((p: any) => !p.leftAt).length;

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
