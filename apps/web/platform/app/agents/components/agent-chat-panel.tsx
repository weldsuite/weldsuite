'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, MessageSquarePlus, Send, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import {
  useWeldAgentConversations,
  useWeldAgentConversationMessages,
  useCreateConversation,
  useCompleteConversationTurn,
  useDeleteConversation,
} from '@/hooks/queries/use-weldagent-queries';

interface AgentChatPanelProps {
  agentId: string;
  agentName: string;
}

export function AgentChatPanel({ agentId, agentName }: AgentChatPanelProps) {
  const t = getTranslations('common').agents.detail.chat;
  const { data: conversations = [], isLoading: loadingList } = useWeldAgentConversations(50, agentId);
  const createConversation = useCreateConversation();
  const completeTurn = useCompleteConversationTurn();
  const deleteConversation = useDeleteConversation();

  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollEndRef = useRef<HTMLDivElement>(null);

  // Prefer most recent conversation; keep selection if still present.
  useEffect(() => {
    if (activeId && conversations.some((c) => c.id === activeId)) return;
    setActiveId(conversations[0]?.id ?? null);
  }, [conversations, activeId]);

  const { data: messages = [], isLoading: loadingMessages } = useWeldAgentConversationMessages(activeId);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, pendingUser, pendingAssistant, completeTurn.isPending]);

  const startNewChat = useCallback(async () => {
    const conv = await createConversation.mutateAsync({
      name: t.newChatName,
      agentId,
    });
    setActiveId(conv.id);
    setInput('');
    setPendingUser(null);
    setPendingAssistant(null);
    setSendError(null);
  }, [agentId, createConversation, t.newChatName]);

  const handleSend = useCallback(async () => {
    const content = input.trim();
    if (!content || completeTurn.isPending) return;

    let conversationId = activeId;
    if (!conversationId) {
      const conv = await createConversation.mutateAsync({
        name: t.newChatName,
        agentId,
      });
      conversationId = conv.id;
      setActiveId(conv.id);
    }

    setInput('');
    setPendingUser(content);
    setPendingAssistant(null);
    setSendError(null);

    try {
      const result = await completeTurn.mutateAsync({
        conversationId,
        content,
        agentId,
      });
      setPendingAssistant(result?.assistantMessage?.content ?? null);
      // Clear optimistic bubbles once query refetches.
      setPendingUser(null);
      setPendingAssistant(null);
    } catch {
      setSendError(t.sendFailed);
      setPendingUser(null);
    }
  }, [
    activeId,
    agentId,
    completeTurn,
    createConversation,
    input,
    t.newChatName,
    t.sendFailed,
  ]);

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteConversation.mutateAsync(id);
      if (activeId === id) setActiveId(null);
    },
    [activeId, deleteConversation],
  );

  const showEmpty = !loadingMessages && messages.length === 0 && !pendingUser;

  return (
    <div className="flex h-full min-h-0 border-t">
      {/* History rail */}
      <aside className="w-56 shrink-0 border-r flex flex-col bg-muted/20">
        <div className="p-2 border-b">
          <Button
            size="sm"
            className="w-full justify-start gap-1.5"
            onClick={() => void startNewChat()}
            disabled={createConversation.isPending}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {t.newChat}
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-1.5 space-y-0.5">
            {loadingList && (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t.loadingHistory}</p>
            )}
            {!loadingList && conversations.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t.emptyHistory}</p>
            )}
            {conversations.map((conv) => (
              <div
                key={conv.id}
                className={cn(
                  'group flex items-start gap-1 rounded-md px-2 py-1.5 text-left text-sm cursor-pointer',
                  activeId === conv.id ? 'bg-accent' : 'hover:bg-accent/60',
                )}
                onClick={() => setActiveId(conv.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{conv.name}</div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {conv.lastMessageAt
                      ? new Date(conv.lastMessageAt).toLocaleString()
                      : t.noMessagesYet}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDelete(conv.id);
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </ScrollArea>
      </aside>

      {/* Thread */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="px-4 py-2 border-b text-sm text-muted-foreground shrink-0">
          {t.chattingWith.replace('{name}', agentName)}
        </div>

        <ScrollArea className="flex-1 px-4">
          <div className="max-w-2xl mx-auto py-4 space-y-3">
            {showEmpty && (
              <div className="text-center py-16 space-y-1">
                <p className="text-sm font-medium">{t.emptyTitle.replace('{name}', agentName)}</p>
                <p className="text-xs text-muted-foreground">{t.emptyHint}</p>
              </div>
            )}
            {loadingMessages && activeId && (
              <div className="flex justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm whitespace-pre-wrap max-w-[90%]',
                  m.role === 'user'
                    ? 'ml-auto bg-primary text-primary-foreground'
                    : 'mr-auto bg-muted',
                )}
              >
                {m.content}
              </div>
            ))}
            {pendingUser && (
              <div className="ml-auto rounded-lg px-3 py-2 text-sm whitespace-pre-wrap max-w-[90%] bg-primary text-primary-foreground opacity-80">
                {pendingUser}
              </div>
            )}
            {completeTurn.isPending && (
              <div className="mr-auto rounded-lg px-3 py-2 text-sm bg-muted flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t.thinking}
              </div>
            )}
            {pendingAssistant && !completeTurn.isPending && (
              <div className="mr-auto rounded-lg px-3 py-2 text-sm whitespace-pre-wrap max-w-[90%] bg-muted">
                {pendingAssistant}
              </div>
            )}
            {sendError && <p className="text-sm text-destructive text-center">{sendError}</p>}
            <div ref={scrollEndRef} />
          </div>
        </ScrollArea>

        <div className="border-t p-3 shrink-0">
          <div className="max-w-2xl mx-auto flex gap-2 items-end">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t.inputPlaceholder.replace('{name}', agentName)}
              className="min-h-[44px] max-h-32 resize-none"
              rows={1}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <Button
              size="icon"
              disabled={!input.trim() || completeTurn.isPending || createConversation.isPending}
              onClick={() => void handleSend()}
            >
              {completeTurn.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
