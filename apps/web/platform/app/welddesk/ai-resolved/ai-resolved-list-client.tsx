
import React, { useState, useEffect, useMemo } from 'react';
import { useRouter, usePathname } from '@/lib/router';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import { Toggle } from '@weldsuite/ui/components/toggle';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { cn } from '@/lib/utils';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { ConversationList, type ConversationItem } from '@/components/shared/conversation-list';

type FilterType = 'all' | 'resolved' | 'closed';

interface AiResolvedListClientProps {
  initialConversations: Helpdesk.Conversation[];
}

export default function AiResolvedListClient({ initialConversations }: AiResolvedListClientProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { getClient } = useAppApiClient();
  const { t } = useI18n();
  const ta = t.helpdesk.aiResolved;
  const [conversations, setConversations] = useState<Helpdesk.Conversation[]>(initialConversations);

  const conversationToItem = (conv: Helpdesk.Conversation): ConversationItem => ({
    id: conv.id,
    name: conv.customerName || conv.customerEmail || ta.unknownCustomer,
    email: conv.customerEmail,
    subject: conv.subject || ta.noSubject,
    preview: conv.preview || conv.lastMessage || '',
    date: new Date(conv.lastMessageAt || conv.createdAt),
    isRead: conv.isRead,
    isStarred: conv.isStarred,
    hasAttachments: false,
    labels: [...(conv.labels || []), ta.aiResolvedLabel],
    messageCount: conv.messageCount || 1,
    unreadCount: conv.isRead ? 0 : 1,
  });

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: ta.breadcrumb },
  ]);

  const [activeFilter, setActiveFilter] = useState<FilterType>('all');

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  const selectedConversationId = pathname.split('/').pop();

  const filteredConversations = conversations.filter(conv => {
    switch (activeFilter) {
      case 'resolved': return conv.status === 'resolved';
      case 'closed': return conv.status === 'closed';
      default: return true;
    }
  });

  const items = useMemo(() => filteredConversations.map(conversationToItem), [filteredConversations]);

  const handleItemClick = async (item: ConversationItem) => {
    const conversation = conversations.find(c => c.id === item.id);
    if (conversation && !conversation.isRead) {
      setConversations(prev => prev.map(c => c.id === item.id ? { ...c, isRead: true } : c));
      try {
        const client = await getClient();
        // Legacy PATCH /:id/read also zeroed unreadCount; app-api's generic
        // PATCH writes exactly what it is given, so send both.
        await client.patch(`/conversations/${item.id}`, { isRead: true, unreadCount: 0 });
      } catch { /* ignore */ }
    }
    router.push(`/welddesk/ai-resolved/${item.id}`);
  };

  const handleToggleStar = async (id: string) => {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    setConversations(prev => prev.map(c => c.id === id ? { ...c, isStarred: !conv.isStarred } : c));
    try {
      const client = await getClient();
      // Sends the TOGGLED value. The legacy call was doubly broken: it POSTed
      // to a PATCH-only route (404) and sent the pre-toggle value.
      await client.patch(`/conversations/${id}`, { isStarred: !conv.isStarred });
    } catch {
      setConversations(prev => prev.map(c => c.id === id ? { ...c, isStarred: conv.isStarred } : c));
    }
  };

  const filterContent = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn('h-8 text-sm px-3 shadow-none gap-1.5', activeFilter !== 'all' ? 'text-foreground' : 'text-muted-foreground')}
        >
          {ta.filter}
          {activeFilter !== 'all' && (
            <span className="inline-flex items-center justify-center size-5 text-[10px] font-mono font-medium text-muted-foreground bg-muted border border-border rounded-md">1</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-3">
        <p className="text-xs font-medium text-muted-foreground mb-2">{ta.status}</p>
        <div className="flex flex-wrap gap-1.5">
          {([
            { value: 'all' as FilterType, label: ta.all },
            { value: 'resolved' as FilterType, label: ta.resolved },
            { value: 'closed' as FilterType, label: ta.closed },
          ]).map(({ value, label }) => (
            <Toggle
              key={value}
              size="sm"
              variant="outline"
              pressed={activeFilter === value}
              onPressedChange={() => setActiveFilter(value)}
              className="h-7 px-2.5 text-xs shadow-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:border-primary"
            >
              {label}
            </Toggle>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );

  return (
    <ConversationList
      items={items}
      selectedId={selectedConversationId}
      getItemUrl={(item) => `/welddesk/ai-resolved/${item.id}`}
      onItemClick={handleItemClick}
      filterContent={filterContent}
      onToggleStar={handleToggleStar}
      emptyMessage={ta.noAiResolvedConversations}
    />
  );
}
