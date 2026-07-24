
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useProjectMessageEvents } from '@/hooks/realtime/use-entity-events';
import type { ProjectMessageEventData, AnyPlatformEvent } from '@/lib/platform-events/types';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@weldsuite/ui/components/dropdown-menu';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import {
  Send,
  Paperclip,
  Smile,
  EllipsisVertical,
  Reply,
  Trash2,
  Edit,
  Search,
  Filter,
  AtSign,
  MessageCircle,
  AlertCircle,
  Loader2,
  Image as ImageIcon,
  FileText,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { messagesApi } from '@/app/weldflow/lib/api-client';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';

interface ProjectMessage {
  id: string;
  message: string;
  createdAt: string | Date;
  editedAt?: string | Date;
  sender?: {
    name?: string;
    avatar?: string;
  };
  replyTo?: {
    message?: string;
  };
  reactions?: Record<string, string[]>;
  attachments?: unknown[];
}

interface MessagesClientProps {
  projectId: string;
  initialMessages: ProjectMessage[] | null;
  error: string | null;
}

export function MessagesClient({ projectId, initialMessages, error }: MessagesClientProps) {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.projects.messages.projects, href: '/weldflow' },
    { label: t.projects.messages.title },
  ]);

  const [messages, setMessages] = useState<ProjectMessage[]>(initialMessages || []);
  const [messageInput, setMessageInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { canWrite } = useProjectPermissions();

  // Real-time message event handlers
  const handleMessageCreated = useCallback((event: AnyPlatformEvent) => {
    const messageData = event.data as ProjectMessageEventData;
    // Only handle messages for this project
    if (messageData.projectId !== projectId) return;

    const newMessage: ProjectMessage = {
      id: messageData.id,
      message: messageData.message || '',
      createdAt: new Date().toISOString(),
      sender: {
        name: messageData.senderName,
      },
    };

    setMessages(prev => {
      if (prev.some(m => m.id === newMessage.id)) return prev;
      return [...prev, newMessage];
    });
  }, [projectId]);

  const handleMessageUpdated = useCallback((event: AnyPlatformEvent) => {
    const messageData = event.data as ProjectMessageEventData;
    if (messageData.projectId !== projectId) return;

    setMessages(prev => prev.map(msg => {
      if (msg.id !== messageData.id) return msg;
      return {
        ...msg,
        ...(messageData.message && { message: messageData.message }),
        editedAt: new Date().toISOString(),
      };
    }));
  }, [projectId]);

  const handleMessageDeleted = useCallback((event: AnyPlatformEvent) => {
    const messageData = event.data as ProjectMessageEventData;
    if (messageData.projectId !== projectId) return;

    setMessages(prev => prev.filter(msg => msg.id !== messageData.id));
  }, [projectId]);

  // Subscribe to real-time message events
  useProjectMessageEvents({
    onCreated: handleMessageCreated,
    onUpdated: handleMessageUpdated,
    onDeleted: handleMessageDeleted,
  });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = async () => {
    if (!messageInput.trim() || isSending) return;

    setIsSending(true);
    try {
      const result = await messagesApi.send(projectId, {
        message: messageInput,
        messageType: 'text',
      });
      if (result.success && result.data) {
        setMessages([...messages, result.data as ProjectMessage]);
        setMessageInput('');
      }
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleAddReaction = async (messageId: string, emoji: string) => {
    try {
      const result = await messagesApi.addReaction(projectId, messageId, emoji);
      if (result.success && result.data) {
        setMessages(messages.map(msg => msg.id === messageId ? result.data as ProjectMessage : msg));
      }
    } catch (err) {
      console.error('Failed to add reaction:', err);
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    try {
      const result = await messagesApi.delete(projectId, messageId);
      if (result.success) {
        setMessages(messages.filter(msg => msg.id !== messageId));
      }
    } catch (err) {
      console.error('Failed to delete message:', err);
    }
  };

  const getAttachmentIcon = (type: string) => {
    if (type === 'image') return <ImageIcon className="h-4 w-4" />;
    return <FileText className="h-4 w-4" />;
  };

  const filteredMessages = messages.filter(msg =>
    msg.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (msg.sender?.name || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (error) {
    return (
      <div className="flex h-[calc(100vh-12rem)] items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
          <p className="text-gray-600">{error}</p>
        </div>
      </div>
    );
  }

  if (!initialMessages || initialMessages.length === 0) {
    return (
      <div className="flex h-[calc(100vh-12rem)] gap-4">
        {/* Main Chat Area */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <Card className="mb-4">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <MessageCircle className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <h2 className="font-semibold">{t.projects.messages.projectChat}</h2>
                    <p className="text-xs text-muted-foreground">{t.projects.messages.messagesCount.replace('{n}', '0')}</p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Empty State */}
          <Card className="flex-1 flex flex-col">
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <MessageCircle className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500">{t.projects.messages.noMessagesYet}</p>
                <p className="text-sm text-gray-400 mt-1">
                  {t.projects.messages.beFirstToSend}
                </p>
              </div>
            </div>

            {/* Message Input - only show for users with write permission */}
            {canWrite && (
              <div className="border-t p-4">
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-2">
                    <Textarea
                      placeholder={t.projects.messages.typeMessagePlaceholder}
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      onKeyDown={handleKeyPress}
                      className="min-h-[80px] resize-none"
                    />
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm">
                        <Paperclip className="h-4 w-4 mr-0.5" />
                        {t.projects.messages.attachBtn}
                      </Button>
                      <Button variant="ghost" size="sm">
                        <Smile className="h-4 w-4 mr-0.5" />
                        {t.projects.messages.emojiBtn}
                      </Button>
                    </div>
                  </div>
                  <Button onClick={handleSendMessage} className="h-10" disabled={isSending}>
                    {isSending ? (
                      <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4 mr-0.5" />
                    )}
                    {t.projects.messages.sendBtn}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-12rem)] gap-4">
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <Card className="mb-4">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <MessageCircle className="h-5 w-5 text-muted-foreground" />
                <div>
                  <h2 className="font-semibold">{t.projects.messages.projectChat}</h2>
                  <p className="text-xs text-muted-foreground">
                    {t.projects.messages.messagesCount.replace('{n}', String(messages.length))}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t.projects.messages.searchPlaceholder}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-8 h-8 w-64"
                  />
                </div>
                <Button variant="outline" size="sm">
                  <Filter className="h-4 w-4 mr-0.5" />
                  {t.projects.messages.filterBtn}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Messages */}
        <Card className="flex-1 flex flex-col">
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4">
              {filteredMessages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onReact={(emoji) => handleAddReaction(message.id, emoji)}
                  onDelete={() => handleDeleteMessage(message.id)}
                  getAttachmentIcon={getAttachmentIcon}
                  canWrite={canWrite}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>

          {/* Message Input - only show for users with write permission */}
          {canWrite && (
            <div className="border-t p-4">
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-2">
                  <Textarea
                    placeholder={t.projects.messages.typeMessagePlaceholder}
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyDown={handleKeyPress}
                    className="min-h-[80px] resize-none"
                  />
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm">
                      <Paperclip className="h-4 w-4 mr-0.5" />
                      {t.projects.messages.attachBtn}
                    </Button>
                    <Button variant="ghost" size="sm">
                      <Smile className="h-4 w-4 mr-0.5" />
                      {t.projects.messages.emojiBtn}
                    </Button>
                    <Button variant="ghost" size="sm">
                      <AtSign className="h-4 w-4 mr-0.5" />
                      {t.projects.messages.mentionBtn}
                    </Button>
                  </div>
                </div>
                <Button onClick={handleSendMessage} className="h-10" disabled={isSending}>
                  {isSending ? (
                    <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4 mr-0.5" />
                  )}
                  {t.projects.messages.sendBtn}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// Message Bubble Component
function MessageBubble({
  message,
  onReact,
  onDelete,
  canWrite,
}: {
  message: ProjectMessage;
  onReact: (emoji: string) => void;
  onDelete: () => void;
  getAttachmentIcon: (type: string) => React.ReactElement;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const sender = message.sender;
  const initials = sender?.name
    ? sender.name.charAt(0).toUpperCase()
    : '?';

  return (
    <div className="group flex gap-3 p-3 rounded-lg hover:bg-muted/50 transition-colors">
      <Avatar className="h-10 w-10">
        {sender?.avatar && <AvatarImage src={sender.avatar} />}
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-semibold text-sm">{sender?.name || t.projects.messages.unknown}</span>
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(message.createdAt), { addSuffix: true })}
          </span>
          {message.editedAt && (
            <span className="text-xs text-muted-foreground">{t.projects.messages.edited}</span>
          )}
        </div>

        {message.replyTo && (
          <div className="mb-2 pl-3 border-l-2 border-muted-foreground/30 text-xs text-muted-foreground">
            {t.projects.messages.replyingTo} {message.replyTo.message?.substring(0, 50)}...
          </div>
        )}

        <div className="text-sm mb-2 whitespace-pre-wrap break-words">
          {message.message}
        </div>

        {message.reactions && Object.keys(message.reactions).length > 0 && (
          <div className="flex gap-1 mb-2">
            {Object.entries(message.reactions).map(([emoji, users]) => (
              <Button
                key={emoji}
                variant="ghost"
                onClick={() => onReact(emoji)}
                className={cn(
                  'flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors',
                  'bg-muted hover:bg-muted/70'
                )}
              >
                <span>{emoji}</span>
                <span>{Array.isArray(users) ? users.length : 0}</span>
              </Button>
            ))}
          </div>
        )}

        {canWrite && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={() => onReact('👍')}
            >
              <Smile className="h-3 w-3 mr-1" />
              {t.projects.messages.react}
            </Button>
            <Button variant="ghost" size="sm" className="h-6 text-xs">
              <Reply className="h-3 w-3 mr-1" />
              {t.projects.messages.reply}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                  <EllipsisVertical className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem>
                  <Edit className="h-4 w-4 mr-0.5" />
                  {t.projects.messages.editMenuItem}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-red-600" onClick={onDelete}>
                  <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
                  {t.projects.messages.deleteMenuItem}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </div>
  );
}
