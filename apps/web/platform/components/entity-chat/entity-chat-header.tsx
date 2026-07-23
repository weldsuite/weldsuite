import { Phone, Video } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useWeldChatCall } from '@/contexts/weldchat-call-context';
import { useTranslations } from '@weldsuite/i18n/client';

interface EntityChatHeaderProps {
  /** Display name — entity name when no channel, channel name otherwise. */
  name: string;
  /** Channel id once the chat channel has been lazily created. */
  channelId: string | null;
  /** Hide the voice/video call buttons (e.g. inside the task detail panel). */
  hideCallButtons?: boolean;
}

/**
 * Slim header for entity-linked chat panels (task / project / …). Shows
 * the conversation name plus voice + video call buttons. Call buttons
 * disable until a channel exists (i.e. the first message has been sent).
 */
export function EntityChatHeader({ name, channelId, hideCallButtons = false }: EntityChatHeaderProps) {
  const t = useTranslations();
  const { startCall, status } = useWeldChatCall();
  const inCall = status !== 'idle';
  const canCall = !!channelId && !inCall;

  return (
    <div className="flex h-10 flex-shrink-0 items-center justify-between gap-2 border-b px-3">
      <span className="truncate text-sm font-medium">{name}</span>
      {!hideCallButtons && (
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => channelId && startCall(channelId, 'voice')}
            disabled={!canCall}
            aria-label={t('sweep.weldchat.entityChatHeader.startVoiceCall')}
            title={t('sweep.weldchat.entityChatHeader.startVoiceCall')}
            className="text-muted-foreground hover:text-foreground size-8"
          >
            <Phone className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => channelId && startCall(channelId, 'video')}
            disabled={!canCall}
            aria-label={t('sweep.weldchat.entityChatHeader.startVideoCall')}
            title={t('sweep.weldchat.entityChatHeader.startVideoCall')}
            className="text-muted-foreground hover:text-foreground size-8"
          >
            <Video className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
