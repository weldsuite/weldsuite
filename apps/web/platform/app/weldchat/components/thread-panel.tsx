import { MessageList } from './message-list';
import { MessageInput } from './message-input';
import { X, ChevronRight, Hash, Lock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useChatContext } from './chat-context';
import { useChannel } from '@/hooks/queries/use-weldchat-queries';
import type { ChatChannel } from '@/hooks/queries/use-weldchat-queries';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/provider';

interface ThreadPanelProps {
  channelId: string;
  messageId: string;
}

const THREAD_NAME_KEY = (id: string) => `weldchat:thread-name:${id}`;

export function ThreadPanel({ channelId, messageId }: Readonly<ThreadPanelProps>) {
  const { t } = useI18n();
  const { closeThread } = useChatContext();
  const { data: channelData } = useChannel(channelId);
  const channel = (channelData?.data ?? channelData) as ChatChannel | undefined;
  const isPrivate = channel?.type === 'private' || channel?.isPrivate;

  const [threadName, setThreadName] = useState(t.weldchat.threadPanel.defaultName);
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftName, setDraftName] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleButtonRef = useRef<HTMLButtonElement>(null);
  const cancelEditRef = useRef(false);
  // Set when Enter/Escape ends the rename, so focus returns to the title button.
  const refocusTitleRef = useRef(false);

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem(THREAD_NAME_KEY(messageId)) : null;
    const initial = stored?.trim() ? stored : t.weldchat.threadPanel.defaultName;
    setThreadName(initial);
    setEditingTitle(false);
  }, [messageId, t.weldchat.threadPanel.defaultName]);

  useEffect(() => {
    if (!editingTitle) {
      if (refocusTitleRef.current) {
        refocusTitleRef.current = false;
        titleButtonRef.current?.focus();
      }
      return;
    }
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [editingTitle]);

  function startEditing() {
    cancelEditRef.current = false;
    setDraftName(threadName);
    setEditingTitle(true);
  }

  function commitTitle() {
    if (cancelEditRef.current) {
      cancelEditRef.current = false;
      return;
    }
    const trimmed = draftName.trim();
    // Empty input — keep the last saved name instead of reverting to "Thread"
    if (trimmed) {
      setThreadName(trimmed);
      try {
        localStorage.setItem(THREAD_NAME_KEY(messageId), trimmed);
      } catch {
        // Storage unavailable (private browsing, quota, …) — rename still applies for this session.
      }
    }
    setEditingTitle(false);
  }

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
          {editingTitle ? (
            <input
              ref={titleInputRef}
              type="text"
              value={draftName}
              maxLength={50}
              aria-label={t.weldchat.threadPanel.nameLabel}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  refocusTitleRef.current = true;
                  e.currentTarget.blur();
                }
                if (e.key === 'Escape') {
                  refocusTitleRef.current = true;
                  cancelEditRef.current = true;
                  setEditingTitle(false);
                }
              }}
              className="min-w-24 rounded-md border border-gray-400 bg-transparent px-2 py-0.5 -mx-1 text-[15px] font-semibold outline-none [field-sizing:content] dark:border-gray-500"
            />
          ) : (
            <button
              ref={titleButtonRef}
              type="button"
              onClick={startEditing}
              title={t.weldchat.threadPanel.clickToRename}
              className="-mx-1 max-w-full cursor-text truncate rounded-md border border-transparent px-2 py-0.5 text-left text-[15px] font-semibold outline-none transition-colors hover:border-border focus-visible:border-ring"
            >
              {threadName}
            </button>
          )}
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
