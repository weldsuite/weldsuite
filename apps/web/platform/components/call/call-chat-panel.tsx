import { useState, useMemo } from 'react';
import { X, MessageSquare, Loader2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { MessageList } from '@/app/weldchat/components/message-list';
import { MessageInput } from '@/app/weldchat/components/message-input';
import { ChatContext, type ReplyTo } from '@/app/weldchat/components/chat-context';
import { useWeldChatRoom } from '@/hooks/weldchat/use-weldchat-room';

interface CallChatPanelProps {
  channelId?: string;
  isOpen: boolean;
  onClose: () => void;
}

function ChannelChatContent({ channelId }: { channelId: string }) {
  const { client } = useWeldChatRoom(channelId);
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const chatCtx = useMemo(() => ({
    activeChannelId: null,
    setActiveChannelId: () => {},
    rightPanel: null as null,
    setRightPanel: () => {},
    threadMessageId: null,
    openThread: () => {},
    closeThread: () => {},
    replyTo,
    setReplyTo,
    filters: { type: 'all' as const, search: '', from: [] as string[], date: undefined },
    setFilters: () => {},
    selectedProfileUserId: null,
    openUserProfile: () => {},
    closeUserProfile: () => {},
    selectedAgentProfileId: null,
    openAgentProfile: () => {},
    closeAgentProfile: () => {},
  }), [replyTo]);

  return (
    <ChatContext.Provider value={chatCtx}>
      <div className="flex-1 min-h-0 overflow-auto">
        <MessageList channelId={channelId} client={client} />
      </div>
      <MessageInput channelId={channelId} client={client} />
    </ChatContext.Provider>
  );
}

function ChatLoading() {
  const t = useTranslations();
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-[13px] text-muted-foreground">{t('sweep.shared.settingUpChat')}</p>
      </div>
    </div>
  );
}

function CallChatPanel({ channelId, isOpen, onClose }: CallChatPanelProps) {
  const t = useTranslations();
  return (
    <div
      className="flex-shrink-0 border-l flex flex-col min-h-0 overflow-hidden"
      style={{
        width: isOpen ? 479 : 0,
        opacity: isOpen ? 1 : 0,
        transition: 'width 300ms cubic-bezier(0.25, 0.1, 0.25, 1), opacity 200ms ease',
        willChange: 'width, opacity',
      }}
    >
      <div className="w-[479px] flex flex-col min-h-0 h-full">
        <div className="px-4 border-b flex-shrink-0 h-[53px] flex items-center justify-between">
          <span className="text-sm font-semibold">{t('sweep.shared.chat')}</span>
          <Button variant="ghost" size="icon" onClick={onClose} className="p-1 rounded-md hover:bg-muted transition-colors">
            <X className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
        {channelId ? (
          <ChannelChatContent channelId={channelId} />
        ) : (
          <ChatLoading />
        )}
      </div>
    </div>
  );
}

/** Inline chat content (no slide-out shell) for embedding inside another panel */
function CallChatContent({ channelId }: { channelId: string }) {
  const { client } = useWeldChatRoom(channelId);
  const [replyTo, setReplyTo] = useState<ReplyTo | null>(null);
  const chatCtx = useMemo(() => ({
    activeChannelId: null,
    setActiveChannelId: () => {},
    rightPanel: null as null,
    setRightPanel: () => {},
    threadMessageId: null,
    openThread: () => {},
    closeThread: () => {},
    replyTo,
    setReplyTo,
    filters: { type: 'all' as const, search: '', from: [] as string[], date: undefined },
    setFilters: () => {},
    selectedProfileUserId: null,
    openUserProfile: () => {},
    closeUserProfile: () => {},
    selectedAgentProfileId: null,
    openAgentProfile: () => {},
    closeAgentProfile: () => {},
  }), [replyTo]);

  return (
    <ChatContext.Provider value={chatCtx}>
      <div className="flex flex-col h-full">
        <div className="flex-1 min-h-0 overflow-auto">
          <MessageList channelId={channelId} client={client} />
        </div>
        <MessageInput channelId={channelId} client={client} />
      </div>
    </ChatContext.Provider>
  );
}
