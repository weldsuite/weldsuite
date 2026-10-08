import { useMemo, useState } from 'react';
import { Pin, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { usePinnedMessages, useUnpinMessage, useWorkspaceMembers } from '@/hooks/queries/use-weldchat-queries';
import type { ChatMessage } from '@/hooks/queries/use-weldchat-queries';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { messagePreviewText } from '../lib/render-message-content';

interface PinnedMessagesBarProps {
  channelId: string;
}

export function PinnedMessagesBar({ channelId }: Readonly<PinnedMessagesBarProps>) {
  const { t } = useI18n();
  const { data } = usePinnedMessages(channelId);
  const { mutate: unpinMessage } = useUnpinMessage();
  const [activeIndex, setActiveIndex] = useState(0);
  const { data: membersData } = useWorkspaceMembers();
  const memberNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersData?.data ?? []) {
      if (m.userId && m.name) map.set(m.userId, m.name);
    }
    return map;
  }, [membersData]);

  const pinnedMessages: ChatMessage[] = data?.data ?? [];
  if (pinnedMessages.length === 0) return null;

  const safeIndex = activeIndex >= pinnedMessages.length ? 0 : activeIndex;
  const currentMessage = pinnedMessages[safeIndex];

  const handleClick = () => {
    const nextIndex = pinnedMessages.length > 1
      ? (safeIndex + 1) % pinnedMessages.length
      : safeIndex;
    setActiveIndex(nextIndex);

    const targetId = pinnedMessages[nextIndex].id;
    const el = document.querySelector(`[data-message-id="${targetId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('pinned-highlight');
      setTimeout(() => el.classList.remove('pinned-highlight'), 1000);
    }
  };

  const handleUnpin = () => {
    unpinMessage({ channelId, messageId: currentMessage.id });
    if (safeIndex >= pinnedMessages.length - 1) {
      setActiveIndex(0);
    }
  };

  return (
    <>
    <style>{`
      @keyframes pinned-flash {
        0% { background-color: transparent; }
        10% { background-color: rgba(59, 130, 246, 0.12); }
        50% { background-color: rgba(59, 130, 246, 0.12); }
        100% { background-color: transparent; }
      }
      .pinned-highlight {
        animation: pinned-flash 1s ease-out forwards;
      }
    `}</style>
    <div
      data-testid="chat-pinned-bar"
      className="group border-b bg-muted/30 flex-shrink-0 flex items-center hover:bg-muted/50 transition-colors"
    >
      <button
        type="button"
        onClick={handleClick}
        className="flex flex-1 min-w-0 items-center gap-2 md:gap-3 pl-4 py-2.5 text-left cursor-pointer"
      >
        {/* Indicator dots — fixed height, dots sized to fit */}
        {pinnedMessages.length > 1 && (
          <span className="flex flex-col justify-center gap-[2px] flex-shrink-0 h-[20px]">
            {pinnedMessages.map((m, i) => (
              <span
                key={m.id}
                className={cn(
                  'w-[3px] rounded-full transition-all',
                  i === safeIndex
                    ? 'flex-[2] bg-primary'
                    : 'flex-1 bg-muted-foreground/30',
                )}
              />
            ))}
          </span>
        )}

        {/* Pin icon */}
        <Pin className="h-4 w-4 text-primary flex-shrink-0" />

        {/* Message content */}
        <span className="block flex-1 min-w-0">
          <span className="block text-sm text-foreground truncate">
            {messagePreviewText(currentMessage.content ?? '', memberNames)}
          </span>
        </span>
      </button>

      {/* Unpin button */}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 mx-4 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
        onClick={handleUnpin}
        title={t.weldchat.pinnedMessages.unpin}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
    </>
  );
}
