import { MessageList } from './message-list';
import { MessageInput } from './message-input';
import { X, ChevronRight, Hash, Lock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useChatContext } from './chat-context';
import { useChannel } from '@/hooks/queries/use-weldchat-queries';
import type { ChatChannel } from '@/hooks/queries/use-weldchat-queries';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';

interface ThreadPanelProps {
  channelId: string;
  messageId: string;
}

const THREAD_NAME_KEY = (id: string) => `weldchat:thread-name:${id}`;

export function ThreadPanel({ channelId, messageId }: ThreadPanelProps) {
  const { t } = useI18n();
  const { closeThread } = useChatContext();
  const { data: channelData } = useChannel(channelId);
  const channel = (channelData?.data ?? channelData) as ChatChannel | undefined;
  const isPrivate = channel?.type === 'private' || channel?.isPrivate;

  const [threadName, setThreadName] = useState(t.weldchat.threadPanel.defaultName);
  const [editingTitle, setEditingTitle] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem(THREAD_NAME_KEY(messageId)) : null;
    const initial = stored && stored.trim() ? stored : t.weldchat.threadPanel.defaultName;
    setThreadName(initial);
    setEditingTitle(false);
    if (titleRef.current) titleRef.current.innerText = initial;
  }, [messageId, t.weldchat.threadPanel.defaultName]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2.5 border-b flex-shrink-0 min-h-[53px]">
        <div className="flex items-center gap-1.5 min-w-0">
          {channel?.name && (
            <div className="flex items-center gap-1 min-w-0">
              {isPrivate ? (
                <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              ) : (
                <Hash className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              )}
              <span className="text-[15px] font-semibold truncate">{channel.name}</span>
            </div>
          )}
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <span
            ref={titleRef}
            contentEditable={editingTitle}
            suppressContentEditableWarning
            className={cn(
              'rounded-md px-2 py-0.5 -mx-1 border transition-colors text-[15px] font-semibold outline-none',
              editingTitle
                ? 'border-gray-400 dark:border-gray-500'
                : 'border-transparent hover:border-border cursor-text',
            )}
            onClick={() => {
              if (!editingTitle) {
                setEditingTitle(true);
                setTimeout(() => {
                  const el = titleRef.current;
                  if (el) {
                    el.focus();
                    const range = document.createRange();
                    range.selectNodeContents(el);
                    const sel = window.getSelection();
                    sel?.removeAllRanges();
                    sel?.addRange(range);
                  }
                }, 0);
              }
            }}
            onBlur={() => {
              const el = titleRef.current;
              const trimmed = (el?.innerText ?? '').trim();
              if (!trimmed) {
                // Empty input — keep the last saved name instead of reverting to "Thread"
                if (el) el.innerText = threadName;
                setEditingTitle(false);
                return;
              }
              if (el) el.innerText = trimmed;
              setThreadName(trimmed);
              try {
                localStorage.setItem(THREAD_NAME_KEY(messageId), trimmed);
              } catch {
                // Storage unavailable (private browsing, quota, …) — rename still applies for this session.
              }
              setEditingTitle(false);
            }}
            onInput={(e) => {
              const el = e.currentTarget;
              if (el.innerText.length > 50) {
                el.innerText = el.innerText.slice(0, 50);
                const range = document.createRange();
                range.selectNodeContents(el);
                range.collapse(false);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                (e.target as HTMLElement).blur();
              }
              if (e.key === 'Escape') {
                if (titleRef.current) titleRef.current.innerText = threadName;
                setEditingTitle(false);
              }
            }}
            title={editingTitle ? undefined : t.weldchat.threadPanel.clickToRename}
          >
            {threadName}
          </span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={closeThread}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <MessageList channelId={channelId} parentId={messageId} />
      </div>
      <MessageInput channelId={channelId} parentId={messageId} />
    </div>
  );
}
