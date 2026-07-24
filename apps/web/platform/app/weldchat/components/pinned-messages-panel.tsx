import { usePinnedMessages } from '@/hooks/queries/use-weldchat-queries';
import { MessageItem } from './message-item';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { X, Pin } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useChatContext } from './chat-context';
import { useI18n } from '@/lib/i18n/provider';

interface PinnedMessagesPanelProps {
  channelId: string;
  embedded?: boolean;
}

export function PinnedMessagesPanel({ channelId, embedded = false }: PinnedMessagesPanelProps) {
  const { t } = useI18n();
  const { setRightPanel } = useChatContext();
  const { data, isLoading } = usePinnedMessages(channelId);
  const messages = data?.data || [];

  return (
    <div className="flex flex-col h-full">
      {!embedded && (
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <Pin className="h-4 w-4" />
            <h3 className="font-semibold">{t.weldchat.pinnedMessages.title}</h3>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setRightPanel(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
      <ScrollArea className="flex-1">
        <div className="p-2">
          {isLoading && (
            <div className="text-center text-muted-foreground py-8">
              {t.weldchat.pinnedMessages.loading}
            </div>
          )}
          {!isLoading && messages.length === 0 && (
            <div className="text-center text-muted-foreground py-8">
              {t.weldchat.pinnedMessages.empty}
            </div>
          )}
          {messages.map((msg) => (
            <MessageItem key={msg.id} message={msg} channelId={channelId} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
