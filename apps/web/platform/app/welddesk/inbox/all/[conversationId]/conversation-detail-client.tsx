
import React, { useState, useTransition, useRef, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  MoreVertical,
  Archive,
  Star,
  Check,
  CheckCircle,
  CheckCheck,
  Ticket,
  SquareCheck,
  ChevronLeft,
  FileText,
  Download,
  Loader2,
  Trash2,
  X,
  Globe,
  MapPin,
  Lock,
  MessageSquare,
  StickyNote,
  PenLine,
  ArrowRightLeft,
  UserCheck,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { WeldAgentInput, type AttachmentPreview, type MessageAttachment } from '@weldsuite/ui/components/weldagent-input';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { helpdeskWorkerApi } from '@/lib/api/domains/welddesk';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import type { MessageAttachment as ActionMessageAttachment } from '@/hooks/queries/use-helpdesk-queries';
import { useRouter } from '@/lib/router';
import { useWeldDesk } from '@/hooks/welddesk/use-welddesk';
import { CreateTicketDialog } from '../create-ticket-dialog';
import { playMessageReceivedSound, playMessageSentSound } from '@/lib/utils/notification-sound';
import { ContactDetailView } from '@/components/customer-detail/contact-detail-view';
import { CreateTaskDialog } from '@/components/tasks/create-task-dialog';
import { AuditTimeline } from '@/components/audit-timeline';
import { useConversationAuditLogs } from '@/hooks/queries/use-helpdesk-queries';
import { decrementHelpdeskBadge } from '@/hooks/use-sidebar-badges';
import { CannedResponsePicker } from '@/components/welddesk/canned-response-picker';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface ConversationReview {
  id: string;
  rating: number;
  content: string;
  reviewerName: string;
  reviewerEmail: string;
  createdAt: string;
}

interface ConversationDetailClientProps {
  conversation: Helpdesk.Conversation;
  initialMessages: Helpdesk.ConversationMessage[];
  accessToken?: string;
  review?: ConversationReview;
  userId?: string;
  userName?: string;
  userAvatar?: string;
}

export default function ConversationDetailClient({
  conversation: initialConversation,
  initialMessages,
  accessToken,
  review,
  userId,
  userName,
  userAvatar,
}: ConversationDetailClientProps) {
  const router = useRouter();
  const { t } = useI18n();
  const st = useTranslations();
  const ti = t.helpdesk.inbox;
  // WeldDesk AI (auto-draft / reply-rewrite / subject generation) is OFFLINE.
  //
  // These controls used to POST at api-worker, but every one of those routes is
  // already dead: `/welddesk/conversations/ai-reply` and
  // `/helpdesk/conversations/generate-subject` are not mounted anywhere (404),
  // and `/helpdesk/conversations/:id/auto-draft` hard-returns 503
  // `ai_unavailable` since the AI teardown. They are deliberately NOT ported to
  // app-api: rebuilding them is a feature (needs @weldsuite/ai + credit
  // metering), not the transport swap this migration is. Each handler below
  // keeps its existing user-visible outcome and drops the dead request.
  //
  // TODO(welddesk-ai): rebuild on app-api's @weldsuite/ai + credits path — see
  // services/mail/ai.ts + routes/mail-ai for the WeldMail precedent — or remove
  // these controls. Product decision, tracked in the W5b report.
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  const [conversation, setConversation] = useState(initialConversation);

  useBreadcrumbs([
    { label: 'Helpdesk', href: '/welddesk' },
    { label: 'Inbox', href: '/welddesk/inbox' },
    { label: 'Conversations', href: '/welddesk/inbox/all' },
    { label: initialConversation.subject || 'Conversation' },
  ]);
  const [messages, setMessages] = useState(() =>
    // Sort initial messages oldest first (ascending by createdAt)
    [...initialMessages].sort((a, b) =>
      new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    )
  );
  const [weldAgentPrompt, setWeldAgentPrompt] = useState('');
  const [isPending, startTransition] = useTransition();
  const [visitorCurrentPage, setVisitorCurrentPage] = useState<{ url: string; title: string } | null>(null);
  const [showCreateTicket, setShowCreateTicket] = useState(false);
  const [linkedTicketId, setLinkedTicketId] = useState<string | null>(conversation.ticketId || null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showCreateTaskDialog, setShowCreateTaskDialog] = useState(false);
  const [isContactExpanded, setIsContactExpanded] = useState(false);
  const [contactCreateFailed, setContactCreateFailed] = useState(false);
  const [isEditingSubject, setIsEditingSubject] = useState(false);
  const [editedSubject, setEditedSubject] = useState(conversation.subject || '');
  // NOTE: the `isGeneratingSubject` / `isAutoGenerating` spinner states that
  // used to live here are gone — with WeldDesk AI offline (see below) nothing
  // could ever set them true, so both spinners were unreachable.
  const [isInternalNote, setIsInternalNote] = useState(false);
  const [isAutoDraft, setIsAutoDraft] = useState(false);
  const [autoDraftPrompt, setAutoDraftPrompt] = useState('');
  const [isAutoDraftRegenerating, setIsAutoDraftRegenerating] = useState(false);
  const autoDraftInputRef = useRef<HTMLTextAreaElement>(null);
  const [previewImage, setPreviewImage] = useState<{ url: string; name: string } | null>(null);
  const [showTransferPopover, setShowTransferPopover] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: string; userId: string; name: string; email: string; role: string }>>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([]);
  const [transferTab, setTransferTab] = useState<'agents' | 'teams'>('agents');

  // Auto-assign conversation to the current agent when opening it (if unassigned or AI-assigned)
  useEffect(() => {
    const shouldAutoAssign = userId && (!initialConversation.assigneeId || initialConversation.assigneeId === 'ai-agent');
    if (shouldAutoAssign) {
      setConversation(prev => ({ ...prev, assigneeId: userId, assigneeName: userName }));
      getClient().then(client =>
        // Assignment is a plain column write on app-api's generic PATCH.
        client.patch(`/conversations/${initialConversation.id}`, {
          assigneeId: userId,
          assigneeName: userName || 'Agent',
          assigneeAvatar: userAvatar,
        })
      ).catch(() => {});
    }
  }, [initialConversation.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Audit logs query
  const { data: auditLogsData } = useConversationAuditLogs(conversation.id);
  const auditLogs = auditLogsData?.data || [];

  // Sync messages from DB (source of truth) when initialMessages prop changes
  useEffect(() => {
    if (initialMessages.length > 0) {
      const sorted = [...initialMessages].sort((a, b) =>
        new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
      );
      setMessages(sorted);
    }
  }, [initialMessages]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const subjectInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTypingRef = useRef<boolean>(false);

  // Refetch conversation data to pick up contact/email changes
  const refreshConversationData = useCallback(() => {
    getClient().then(async (client) => {
      try {
        // app-api returns { data: conversation }. The legacy code unwrapped
        // twice and gated on a `success` flag the client never surfaced, so
        // this refresh could never actually apply.
        const response = await client.get<{ data: any }>(`/conversations/${conversation.id}`);
        const updated = response.data;
        if (updated) {
          setConversation(prev => {
            const contactChanged = updated.contactId !== prev.contactId;
            const emailChanged = updated.customerEmail !== prev.customerEmail;
            if (contactChanged || emailChanged) {
              // Invalidate contact detail query so sidebar refreshes
              if (updated.contactId) {
                queryClient.invalidateQueries({ queryKey: ['crm', 'contacts', 'detail', updated.contactId] });
              }
              if (prev.contactId && prev.contactId !== updated.contactId) {
                queryClient.invalidateQueries({ queryKey: ['crm', 'contacts', 'detail', prev.contactId] });
              }
            }
            return { ...prev, ...updated };
          });
        }
      } catch {
        // Silently ignore — not critical
      }
    }).catch(() => {});
  }, [conversation.id, getClient, queryClient]);

  // WeldDesk hook — manages messages, real-time, typing, presence, events
  const {
    messages: weldDeskMessages,
    isLoadingMessages: _isLoadingMessages,
    sendMessage: weldDeskSendMessage,
    sendNote: weldDeskSendNote,
    isSending,
    respondToBlock,
    conversation: weldDeskConversation,
    typing,
    startTyping: weldDeskStartTyping,
    stopTyping: weldDeskStopTyping,
    events,
    isConnected,
    connectionState,
    closeConversation: weldDeskCloseConversation,
    updateConversation: weldDeskUpdateConversation,
  } = useWeldDesk({
    conversationId: conversation.id,
    role: 'agent',
    userId: userId || 'anonymous',
    userName: userName,
    userAvatar: userAvatar,
    workspaceId: undefined, // orgId is set via middleware
  });

  // Sync weldDesk messages into local state (preserving existing initialMessages merge)
  useEffect(() => {
    if (weldDeskMessages.length > 0) {
      setMessages(weldDeskMessages as unknown as Helpdesk.ConversationMessage[]);
    }
  }, [weldDeskMessages]);

  // Sync conversation updates from real-time events
  useEffect(() => {
    if (weldDeskConversation) {
      setConversation(prev => ({ ...prev, ...weldDeskConversation }));
    }
  }, [weldDeskConversation]);

  // Play sound for incoming customer messages (skip initial load)
  const prevMessageCountRef = useRef(weldDeskMessages.length);
  const hasInitializedRef = useRef(false);
  useEffect(() => {
    if (!hasInitializedRef.current) {
      // Skip the first load — these are existing messages, not new live ones
      hasInitializedRef.current = weldDeskMessages.length > 0;
      prevMessageCountRef.current = weldDeskMessages.length;
      return;
    }
    if (weldDeskMessages.length > prevMessageCountRef.current) {
      const lastMsg = weldDeskMessages[weldDeskMessages.length - 1];
      if (lastMsg && lastMsg.authorType === 'customer' && !lastMsg.isPending) {
        playMessageReceivedSound();
        refreshConversationData();
      }
    }
    prevMessageCountRef.current = weldDeskMessages.length;
  }, [weldDeskMessages, refreshConversationData]);

  // Show toasts for NEW real-time events only — track by ID to avoid re-toasting
  const toastedEventIdsRef = useRef(new Set<string>());
  useEffect(() => {
    for (const event of events) {
      if (toastedEventIdsRef.current.has(event.id)) continue;
      toastedEventIdsRef.current.add(event.id);

      if (event.eventType === 'conversation_closed' || event.eventType === 'conversation.closed') {
        setConversation(prev => ({ ...prev, status: 'closed' }));
        toast.info(ti.conversationClosedBy.replace('{name}', event.actorName || 'someone'));
      } else if (event.eventType === 'agent_assigned' || event.eventType === 'assignment.agent_assigned') {
        // Skip the initial auto-assign that fires on mount
        if (event.actorId === userId) continue;
        toast.info(ti.agentAssignedToConversation.replace('{name}', event.actorName || 'someone'));
      }
    }
  }, [events, userId]);

  // Backwards-compatible aliases
  const isConnecting = connectionState === 'connecting';
  const sendTypingIndicator = useCallback((_isTyping: boolean) => {
    weldDeskStartTyping();
  }, [weldDeskStartTyping]);
  const typingUsers = new Set(typing.typingUsers.map(u => u.userName));

  // Auto-scroll to bottom when new messages arrive (newest messages are at bottom)
  useEffect(() => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
  }, [messages]);

  // Show connection error
  useEffect(() => {
    if (connectionState === 'failed') {
      console.error('WeldDesk connection failed');
    }
  }, [connectionState]);

  // Auto-create and link a contact when conversation has no contactId
  useEffect(() => {
    if (!conversation.contactId && conversation.customerEmail) {
      setContactCreateFailed(false);
      getClient().then(async (client) => {
        try {
          // app-api envelope: { data: { contactId } }. Non-2xx throws.
          const response = await client.post<{ data: { contactId: string } }>(
            `/conversations/${conversation.id}/auto-link-contact`,
            {
              email: conversation.customerEmail,
              name: conversation.customerName,
              phone: conversation.customerPhone,
            },
          );
          const contactId = response.data?.contactId;
          if (contactId) {
            setConversation(prev => ({ ...prev, contactId }));
          } else {
            setContactCreateFailed(true);
          }
        } catch {
          setContactCreateFailed(true);
        }
      }).catch(() => {
        setContactCreateFailed(true);
      });
    }
  }, [conversation.id, conversation.contactId, conversation.customerEmail, conversation.customerName, conversation.customerPhone, getClient]);

  // Handle input change with typing indicator (Chat SDK handles heartbeat natively)
  const stopTypingIndicator = useCallback(() => {
    if (isTypingRef.current) {
      isTypingRef.current = false;
      weldDeskStopTyping();
    }
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  }, [weldDeskStopTyping]);

  const handleInputChange = useCallback((value: string) => {
    setWeldAgentPrompt(value);

    if (!isConnected) return;

    if (!value.trim()) {
      stopTypingIndicator();
      return;
    }

    // Start typing (Chat SDK handles heartbeat throttling natively)
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      weldDeskStartTyping();
    }

    // Reset the inactivity timeout — fires after 2s of no input
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      stopTypingIndicator();
    }, 2000);
  }, [isConnected, weldDeskStartTyping, stopTypingIndicator]);

  // Cleanup typing on unmount
  useEffect(() => {
    return () => {
      stopTypingIndicator();
    };
  }, [stopTypingIndicator]);

  // Mark conversation as read when opened
  useEffect(() => {
    if (!initialConversation.isRead) {
      getClient().then(async (client) => {
        try {
          // Legacy PATCH /:id/read also zeroed unreadCount; app-api's generic
          // PATCH writes exactly what it is given, so send both.
          await client.patch(`/conversations/${initialConversation.id}`, { isRead: true, unreadCount: 0 });
          setConversation(prev => ({ ...prev, isRead: true }));
          decrementHelpdeskBadge(queryClient);
        } catch {
          // Silently fail
        }
      });
    }
  }, [initialConversation.id, initialConversation.isRead, getClient, queryClient]);


  const handleWeldAgentSend = async (attachments?: AttachmentPreview[]) => {
    if (!weldAgentPrompt.trim() && (!attachments || attachments.length === 0)) return;

    // Stop typing indicator when sending
    stopTypingIndicator();

    const messageContent = weldAgentPrompt;
    setWeldAgentPrompt('');

    // Upload attachments first if any
    let uploadedAttachments: ActionMessageAttachment[] | undefined;
    if (attachments && attachments.length > 0) {
      uploadedAttachments = [];
      try {
        const client = await getClient();
        for (const attachment of attachments) {
          // Step 1: Generate upload URL
          const genResponse = await client.post('/storage/generate-upload-url', {
            fileName: attachment.file.name,
            contentType: attachment.file.type || 'application/octet-stream',
            fileSize: attachment.file.size,
            folder: 'helpdesk',
            entityType: 'conversation',
            entityId: conversation.id,
            isPublic: true,
          }) as any;

          if (!genResponse.success) {
            toast.error(ti.failedToUploadFile.replace('{name}', attachment.name));
            continue;
          }

          // Step 2: Upload the file binary
          await fetch(genResponse.uploadUrl, {
            method: 'PUT',
            body: attachment.file,
            headers: { 'Content-Type': attachment.file.type || 'application/octet-stream' },
          });

          // Step 3: Confirm the upload
          const confirmResponse = await client.post('/storage/confirm-upload', {
            uploadToken: genResponse.uploadToken,
            fileKey: genResponse.fileKey,
          }) as any;

          if (confirmResponse.success && confirmResponse.file) {
            uploadedAttachments.push({
              id: confirmResponse.file.id,
              fileName: confirmResponse.file.fileName,
              fileSize: confirmResponse.file.fileSize,
              mimeType: confirmResponse.file.mimeType,
              url: confirmResponse.file.url,
            });
          } else {
            toast.error(ti.failedToUploadFile.replace('{name}', attachment.name));
          }
        }
      } catch (error) {
        console.error('Failed to upload attachments:', error);
        toast.error(ti.failedToUploadAttachments);
      }
    }

    const sendingAsInternal = isInternalNote;
    if (sendingAsInternal) setIsInternalNote(false);

    // Add optimistic update - show message immediately
    const optimisticMessage: Helpdesk.ConversationMessage = {
      id: `temp-${Date.now()}`,
      conversationId: conversation.id,
      content: messageContent,
      authorType: 'agent',
      authorName: conversation.assignedAgentName || 'You',
      userId: conversation.assignedAgentId || 'current-agent',
      type: sendingAsInternal ? 'note' : 'message',
      isInternal: sendingAsInternal,
      isPublic: !sendingAsInternal,
      createdAt: new Date().toISOString(),
      attachments: uploadedAttachments?.map(a => ({
        id: a.id,
        name: a.fileName,
        url: a.url,
        type: a.mimeType,
        size: a.fileSize,
      })),
    };

    // Append optimistic message (messages are sorted oldest first)
    setMessages(prev => [...prev, optimisticMessage]);
    playMessageSentSound();
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);

    try {
      // Always save to database via API
      const client = await getClient();
      const sendResponse = await client.post<{ data: { id: string } }>(
        `/conversations/${conversation.id}/messages`,
        {
          content: messageContent,
          isInternal: sendingAsInternal,
          authorName: userName,
          attachments: uploadedAttachments,
        },
      );

      if (sendResponse.data?.id) {
        // Refetch from DB to replace optimistic message with the real one
        queryClient.invalidateQueries({ queryKey: ['helpdesk', 'conversations', 'messages', conversation.id] });

        // Real-time delivery is handled by the server via @weldsuite/realtime publish after DB insert
        // No need to send via WebSocket separately — the server publishes via @weldsuite/realtime
      } else {
        // Remove optimistic message on failure
        setMessages(prev => prev.filter(m => m.id !== optimisticMessage.id));
        toast.error(ti.failedToSendMessage);
        setWeldAgentPrompt(messageContent); // Restore message on error
      }
    } catch (error) {
      console.error('Failed to send message:', error);
      // Remove optimistic message on failure
      setMessages(prev => prev.filter(m => m.id !== optimisticMessage.id));
      toast.error(ti.failedToSendMessage);
      setWeldAgentPrompt(messageContent); // Restore message on error
    }
  };

  const handleArchive = async () => {
    try {
      const client = await getClient();
      // /archive sets status='archived' alongside the flag, server-side.
      await client.patch(`/conversations/${conversation.id}/archive`, { isArchived: true });
      toast.success(ti.conversationArchived);
      router.push('/welddesk/inbox/all');
    } catch (error) {
      toast.error(ti.failedToArchiveConversation);
    }
  };

  const handleDeleteConfirm = async () => {
    setShowDeleteDialog(false);
    try {
      const client = await getClient();
      await client.delete(`/conversations/${conversation.id}`);
      toast.success(ti.conversationDeleted);
      router.push('/welddesk/inbox/all');
    } catch (error) {
      toast.error(ti.failedToDeleteConversation);
    }
  };

  const handleClose = async () => {
    try {
      await weldDeskCloseConversation();
      setConversation(prev => ({ ...prev, status: 'closed' }));
      toast.success(ti.conversationClosed);
    } catch (error) {
      toast.error(ti.failedToCloseConversation);
    }
  };

  const handleToggleStar = async () => {
    try {
      const client = await getClient();
      // Sends the TOGGLED value, matching the optimistic update below. The
      // legacy call was doubly broken: it POSTed to a PATCH-only route (404)
      // and sent the pre-toggle value.
      await client.patch(`/conversations/${conversation.id}`, { isStarred: !conversation.isStarred });
      setConversation(prev => ({ ...prev, isStarred: !prev.isStarred }));
    } catch (error) {
      toast.error(ti.failedToToggleStar);
    }
  };

  const formatMessageDate = (date: Date | string | null | undefined) => {
    if (!date) return 'N/A';
    const d = new Date(date);
    if (isNaN(d.getTime())) return 'N/A';
    return format(d, 'MMM d, yyyy h:mm a');
  };

  // Helper to check if attachment is an image
  const isImageAttachment = (mimeType: string | undefined) => {
    if (!mimeType) return false;
    return mimeType.startsWith('image/');
  };

  // Helper to format file size
  const formatFileSize = (bytes: number | undefined) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return `${size.toFixed(1)} ${units[i]}`;
  };

  // Render attachments for a message
  const renderAttachments = (attachments: any[] | undefined, isAgentMessage: boolean) => {
    if (!attachments || attachments.length === 0) return null;

    const images = attachments.filter(att => isImageAttachment(att.fileType || att.mimeType || att.type || ''));
    const files = attachments.filter(att => !isImageAttachment(att.fileType || att.mimeType || att.type || ''));

    return (
      <div className="mt-2 space-y-2">
        {images.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", images.length === 1 ? "max-w-[300px]" : "max-w-[400px]")}>
            {images.map((att, idx) => {
              const fileName = att.fileName || att.name || 'File';
              const url = att.url;
              return (
                <Button
                  variant="ghost"
                  key={att.id || idx}
                  onClick={() => setPreviewImage({ url, name: fileName })}
                  className={cn(
                    "block rounded-lg overflow-hidden cursor-pointer focus:outline-none",
                    images.length === 1 ? "w-full" : "w-[calc(50%-3px)]"
                  )}
                >
                  <img
                    src={url}
                    alt={fileName}
                    className="w-full h-auto object-cover rounded-lg hover:opacity-90 transition-opacity"
                    onError={(e) => {
                      const target = e.target as HTMLImageElement;
                      target.style.display = 'none';
                      target.parentElement!.innerHTML = `
                        <div class="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-secondary rounded-lg">
                          <span class="text-sm text-gray-600 dark:text-muted-foreground">${st('sweep.welddesk.conversationDetail.failedToLoadImage')}</span>
                        </div>
                      `;
                    }}
                  />
                </Button>
              );
            })}
          </div>
        )}
        {files.map((att, idx) => {
          const fileName = att.fileName || att.name || 'File';
          const fileSize = att.fileSize || att.size;
          const url = att.url;
          return (
            <a
              key={att.id || idx}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "flex items-center gap-2 px-3 py-2 rounded-lg transition-colors max-w-[280px]",
                isAgentMessage
                  ? "bg-blue-200/50 hover:bg-blue-200/70"
                  : "bg-gray-200/50 dark:bg-accent/50 hover:bg-gray-200/70 dark:hover:bg-accent/70"
              )}
            >
              <FileText className="h-4 w-4 flex-shrink-0 text-gray-500" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate text-gray-900 dark:text-foreground">{fileName}</p>
                {fileSize && (
                  <p className="text-xs text-gray-500 dark:text-muted-foreground">{formatFileSize(fileSize)}</p>
                )}
              </div>
              <Download className="h-4 w-4 flex-shrink-0 text-gray-400" />
            </a>
          );
        })}
      </div>
    );
  };

  return (
    <>
    <div className="bg-white dark:bg-background/30 flex h-full overflow-hidden flex-1">
      {/* Main Content Area */}
      <div className="flex flex-col h-full flex-1 min-w-0">
        {/* Closed Banner */}
        {conversation.status === 'closed' && (
          <div className="px-6 py-2 bg-gray-100 dark:bg-secondary border-b border-gray-200 dark:border-border flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-gray-500" />
            <span className="text-sm text-gray-600 dark:text-muted-foreground">
              {ti.thisConversationHasBeenClosed}
            </span>
          </div>
        )}

        {/* Source Website Bar */}
        {(visitorCurrentPage || conversation.metadata?.website) && (
          <div className="px-6 py-1.5 bg-gray-50 dark:bg-secondary/50 border-b border-gray-200 dark:border-border flex items-center gap-2">
            {visitorCurrentPage ? (
              <>
                <span className="relative flex h-2 w-2 flex-shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
                <Globe className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
                <a
                  href={visitorCurrentPage.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gray-600 dark:text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400 hover:underline truncate"
                  title={visitorCurrentPage.url}
                >
                  {(() => {
                    try {
                      const u = new URL(visitorCurrentPage.url);
                      return u.hostname + u.pathname;
                    } catch {
                      return visitorCurrentPage.url;
                    }
                  })()}
                </a>
              </>
            ) : (
              <>
                <Globe className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                <a
                  href={conversation.metadata!.website as string}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gray-500 dark:text-muted-foreground hover:text-blue-600 dark:hover:text-blue-400 hover:underline"
                >
                  {new URL(conversation.metadata!.website as string).hostname}
                </a>
              </>
            )}
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-3 md:px-4 h-[53px] border-b border-gray-200 dark:border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* Mobile back button */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden p-1.5 -ml-1 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors flex-shrink-0"
              onClick={() => router.push('/welddesk/inbox/all')}
              aria-label={st('sweep.welddesk.conversationDetail.backToListAriaLabel')}
            >
              <ChevronLeft className="h-5 w-5 text-gray-600 dark:text-muted-foreground" />
            </Button>
            {/* Desktop close/done buttons */}
            <div className="hidden md:flex items-center border border-border rounded-md overflow-hidden flex-shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary transition-colors"
                onClick={() => router.push('/welddesk/inbox/all')}
                title={ti.backToInbox}
              >
                <X className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
              </Button>
              <div className="w-px h-5 bg-border" />
              <Button
                variant="ghost"
                size="icon"
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary transition-colors"
                onClick={async () => {
                  await handleClose();
                  router.push('/welddesk/inbox/all');
                }}
                disabled={isPending || conversation.status === 'closed'}
                title={conversation.status === 'closed' ? ti.alreadyClosed : ti.closeAndGoBack}
              >
                <Check className="h-3.5 w-3.5 text-gray-500 dark:text-muted-foreground" />
              </Button>
            </div>
            {isEditingSubject ? (
              <input
                ref={subjectInputRef}
                type="text"
                defaultValue={conversation.subject || ''}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setConversation(prev => ({ ...prev, subject: subjectInputRef.current?.value || '' }));
                    setIsEditingSubject(false);
                  } else if (e.key === 'Escape') {
                    setIsEditingSubject(false);
                  }
                }}
                onBlur={() => {
                  setConversation(prev => ({ ...prev, subject: subjectInputRef.current?.value || '' }));
                  setIsEditingSubject(false);
                }}
                className="text-sm md:text-lg font-medium text-gray-900 dark:text-foreground bg-transparent outline-none border border-blue-500 dark:border-blue-400 rounded-md px-2 py-0.5 min-w-[80px] w-full -ml-0.5"
                autoFocus
              />
            ) : (
              <div
                className="flex items-center min-w-0 group cursor-text border border-transparent hover:border-gray-300 dark:hover:border-border rounded-md px-2 py-0.5 -ml-0.5 transition-colors"
                onClick={() => {
                  setEditedSubject(conversation.subject || '');
                  setIsEditingSubject(true);
                }}
              >
                <h1 className="text-sm md:text-lg font-medium text-gray-900 dark:text-foreground truncate">
                  {conversation.subject || 'No subject'}
                </h1>
                {/*
                  WELDDESK AI IS OFFLINE (see the welddesk-ai note above). This
                  used to POST /helpdesk/conversations/generate-subject on
                  api-worker — a route that never existed, so the call 404'd and
                  the handler had no catch: the button already did nothing but
                  spin. Disabled rather than left live-but-inert until the AI
                  rebuild lands.
                */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => e.stopPropagation()}
                  disabled
                  className="flex-shrink-0 p-1 ml-1 text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded opacity-0 group-hover:opacity-100 transition-all disabled:opacity-100"
                  title={ti.generateSubjectWithAI}
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 889.29 618.69" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                    <path d="M759.79,0v129.48H129.48v359.69c-29.88-8.21-56.62-24.07-77.92-45.32C19.72,411.96,0,367.95,0,319.32v-143.22C0,78.84,78.84,0,176.1,0h583.7Z"/>
                    <path d="M129.49,618.69v-129.48h630.32V129.51c29.88,8.21,56.62,24.07,77.92,45.32,31.84,31.89,51.56,75.9,51.56,124.53v143.22c0,97.26-78.84,176.1-176.1,176.1H129.49Z"/>
                    <path d="M419.29,349.82h-161.9c0-44.73,36.22-80.95,80.95-80.95s80.95,36.22,80.95,80.95Z"/>
                    <path d="M631.9,349.82h-161.9c0-44.73,36.22-80.95,80.95-80.95s80.95,36.22,80.95,80.95Z"/>
                  </svg>
                </Button>
              </div>
            )}
          </div>

          {/* Assignment Badge */}
          {conversation.assigneeId && (
            <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 mr-1">
              <UserCheck className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
              <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
                {conversation.assigneeId === userId ? ti.assignedToYou : ti.assignedToAgent.replace('{name}', conversation.assigneeName || 'agent')}
              </span>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
            {/* Transfer Button */}
            <Popover open={showTransferPopover} onOpenChange={setShowTransferPopover}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={async () => {
                    if (agents.length === 0 && !loadingAgents) {
                      setLoadingAgents(true);
                      try {
                        const [agentsResult, deptsResult] = await Promise.all([
                          helpdeskWorkerApi.listAgents(),
                          helpdeskWorkerApi.listDepartments({ isActive: true }),
                        ]);
                        if (agentsResult.success && agentsResult.data) {
                          setAgents(agentsResult.data.filter((a: any) => a.userId !== userId));
                        }
                        if (deptsResult.success && deptsResult.data) {
                          setDepartments(deptsResult.data.map((d: any) => ({ id: d.id, name: d.name })));
                        }
                      } catch {} finally {
                        setLoadingAgents(false);
                      }
                    }
                  }}
                  className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors"
                  title={ti.transferToAgentOrTeam}
                >
                  <ArrowRightLeft className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[240px] p-2">
                <div className="flex gap-1 mb-2 px-1">
                  <Button
                    variant="ghost"
                    onClick={() => setTransferTab('agents')}
                    className={cn(
                      'text-xs font-medium px-2 py-1 rounded-md transition-colors',
                      transferTab === 'agents'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted'
                    )}
                  >
                    {ti.agents}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setTransferTab('teams')}
                    className={cn(
                      'text-xs font-medium px-2 py-1 rounded-md transition-colors',
                      transferTab === 'teams'
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted'
                    )}
                  >
                    {ti.teams}
                  </Button>
                </div>
                {loadingAgents ? (
                  <div className="flex items-center justify-center gap-2 py-3">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">{ti.loading}</span>
                  </div>
                ) : transferTab === 'agents' ? (
                  agents.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-1 py-2">{ti.noAgentsAvailable}</p>
                  ) : (
                    <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
                      {agents.map(agent => (
                        <Button
                          variant="ghost"
                          key={agent.id}
                          className="w-full text-left px-2 py-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-secondary text-sm transition-colors"
                          onClick={async () => {
                            setShowTransferPopover(false);
                            try {
                              await helpdeskWorkerApi.assignConversation(conversation.id, agent.userId, agent.name);
                              setConversation(prev => ({ ...prev, assigneeId: agent.userId, assigneeName: agent.name }));
                              toast.success(ti.transferredToAgent.replace('{name}', agent.name));
                            } catch {
                              toast.error(ti.failedToTransferConversation);
                            }
                          }}
                        >
                          <div className="font-medium">{agent.name}</div>
                          <div className="text-xs text-muted-foreground">{agent.email}</div>
                        </Button>
                      ))}
                    </div>
                  )
                ) : (
                  departments.length === 0 ? (
                    <p className="text-xs text-muted-foreground px-1 py-2">{ti.noTeamsAvailable}</p>
                  ) : (
                    <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
                      {departments.map(dept => (
                        <Button
                          variant="ghost"
                          key={dept.id}
                          className={cn(
                            'w-full text-left px-2 py-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-secondary text-sm transition-colors',
                            conversation.departmentId === dept.id && 'bg-muted'
                          )}
                          onClick={async () => {
                            setShowTransferPopover(false);
                            try {
                              await helpdeskWorkerApi.assignConversationTeam(conversation.id, dept.id);
                              setConversation(prev => ({
                                ...prev,
                                departmentId: dept.id,
                                assigneeId: undefined as any,
                                assigneeName: undefined as any,
                              }));
                              toast.success(ti.assignedToTeam.replace('{name}', dept.name));
                            } catch {
                              toast.error(ti.failedToAssignToTeam);
                            }
                          }}
                        >
                          <div className="font-medium">{dept.name}</div>
                          {conversation.departmentId === dept.id && (
                            <div className="text-xs text-muted-foreground">{ti.currentTeam}</div>
                          )}
                        </Button>
                      ))}
                    </div>
                  )
                )}
              </PopoverContent>
            </Popover>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleToggleStar}
              className={cn("p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors", conversation.isStarred && "text-yellow-500")}
              title={conversation.isStarred ? ti.unstar : ti.star}
            >
              <Star className={cn("h-4 w-4", conversation.isStarred ? "fill-current" : "text-gray-500 dark:text-muted-foreground")} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleArchive}
              className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors"
              title={ti.archive}
            >
              <Archive className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
            </Button>
            {linkedTicketId ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => router.push(`/welddesk/tickets/${linkedTicketId}`)}
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors"
                title={ti.viewLinkedTicket}
              >
                <Ticket className="h-4 w-4 text-blue-500" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowCreateTicket(true)}
                className="p-1.5 hover:bg-gray-100 dark:hover:bg-secondary rounded-md transition-colors"
                title={ti.createTicket}
              >
                <Ticket className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
              </Button>
            )}
          </div>
        </div>

        {/* Chat Thread */}
        <div
          className="flex-1 overflow-y-auto min-h-0 bg-white dark:bg-background"
          style={{
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(203, 213, 225, 0.3) transparent'
          }}
        >
          <div className="px-5 py-4">
            {messages.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-gray-500">{ti.noMessagesYet}</p>
              </div>
            ) : (
              <>
                {/* Date Divider */}
                <div className="flex items-center justify-center mb-6">
                  <div className="h-px flex-1 bg-gray-200 dark:bg-accent" />
                  <span className="px-3 text-[11px] font-medium text-gray-400 dark:text-muted-foreground uppercase tracking-wider">
                    {messages[0]?.createdAt
                      ? format(new Date(messages[0].createdAt), 'EEEE, MMMM d')
                      : conversation.createdAt
                      ? format(new Date(conversation.createdAt), 'EEEE, MMMM d')
                      : format(new Date(), 'EEEE, MMMM d')}
                  </span>
                  <div className="h-px flex-1 bg-gray-200 dark:bg-accent" />
                </div>

                {/* Messages with WhatsApp-style bubbles */}
                {messages.map((message, index, array) => {
                  // System messages render as centered gray pills or ticket cards
                  if (message.authorType === 'system' || message.type === 'system') {
                    const meta = message.metadata as Record<string, unknown> | undefined;
                    const ticketMeta = meta?.ticketId ? meta as { ticketId: string; ticketNumber: string; ticketSubject: string; ticketStatus: string; ticketPriority: string } : null;

                    if (ticketMeta) {
                      return (
                        <div key={message.id} className="flex justify-center mb-4">
                          <Button
                            variant="ghost"
                            onClick={() => router.push(`/welddesk/tickets/${ticketMeta.ticketId}`)}
                            className="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-border bg-white dark:bg-secondary hover:bg-gray-50 dark:hover:bg-accent transition-colors shadow-sm max-w-[360px] text-left"
                          >
                            <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
                              <Ticket className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[12px] font-medium text-blue-600 dark:text-blue-400">{ticketMeta.ticketNumber}</span>
                                <span className={cn(
                                  "text-[10px] px-1.5 py-px rounded-md font-medium",
                                  ticketMeta.ticketStatus === 'open' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                                  ticketMeta.ticketStatus === 'pending' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                                  ticketMeta.ticketStatus === 'resolved' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                                  'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                                )}>
                                  {ticketMeta.ticketStatus}
                                </span>
                              </div>
                              <p className="text-[13px] text-foreground truncate mt-0.5">{ticketMeta.ticketSubject}</p>
                            </div>
                          </Button>
                        </div>
                      );
                    }

                    return (
                      <div key={message.id} className="flex justify-center mb-4">
                        <div className="px-3 py-1 rounded-full bg-gray-100 dark:bg-secondary text-[12px] text-muted-foreground">
                          {message.content}
                        </div>
                      </div>
                    );
                  }

                  // Render interactive workflow elements (read-only for agents)
                  const msgMeta = message.metadata as Record<string, unknown> | undefined;
                  const interactiveType = msgMeta?.interactiveType as string | undefined;

                  // Render choices (send_choices workflow step)
                  if (interactiveType === 'choices') {
                    const options = (msgMeta?.options as Array<{ id: string; label: string; value: string }>) || [];
                    const selectedOptionId = msgMeta?.selectedOptionId as string | undefined;
                    return (
                      <div key={message.id} className="flex justify-end mb-4">
                        <div className="max-w-[75%] space-y-2">
                          <div className="px-4 py-2.5 rounded-2xl rounded-br-sm bg-[#D7E8FE] dark:bg-blue-900/40 text-[13px] text-foreground">
                            <p className="whitespace-pre-wrap">{message.content}</p>
                          </div>
                          <div className="flex flex-col gap-1.5 w-full">
                            {options.map((option) => {
                              const isSelected = selectedOptionId === option.id;
                              return (
                                <div
                                  key={option.id}
                                  className={cn(
                                    'w-full text-left px-4 py-2 rounded-xl text-[13px] font-medium border',
                                    isSelected
                                      ? 'bg-primary text-primary-foreground border-primary'
                                      : selectedOptionId
                                        ? 'bg-gray-50 dark:bg-accent text-muted-foreground border-border'
                                        : 'bg-white dark:bg-secondary text-foreground border-border'
                                  )}
                                >
                                  <span className="flex items-center justify-between gap-2">
                                    <span>{option.label}</span>
                                    {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                          {!selectedOptionId && (
                            <div className="text-[10px] text-muted-foreground italic text-right">{ti.waitingForCustomerToChoose}</div>
                          )}
                          <div className="text-[10px] text-muted-foreground mt-1 text-right">
                            {message.authorName || 'Bot'} &middot; {new Date(message.createdAt || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // Render collect_input form
                  if (interactiveType === 'collect_input') {
                    const fields = (msgMeta?.fields as Array<{ id: string; label: string; type: string }>) || [];
                    const submitted = msgMeta?.submittedData as Record<string, string> | undefined;
                    return (
                      <div key={message.id} className="flex justify-end mb-4">
                        <div className="max-w-[75%] space-y-2">
                          <div className="px-4 py-2.5 rounded-2xl rounded-br-sm bg-[#D7E8FE] dark:bg-blue-900/40 text-[13px] text-foreground">
                            <p className="whitespace-pre-wrap">{message.content}</p>
                          </div>
                          <div className="rounded-xl border border-border bg-white dark:bg-secondary overflow-hidden">
                            <div className="p-3 space-y-2">
                              {fields.map((field) => (
                                <div key={field.id}>
                                  <div className="text-[11px] font-medium text-muted-foreground mb-0.5">
                                    {field.label}
                                    {!submitted && (field as any).required && <span className="text-red-500 ml-0.5">*</span>}
                                  </div>
                                  {submitted ? (
                                    <div className="text-[13px] text-foreground py-1 px-2.5 bg-gray-50 dark:bg-accent rounded-md">
                                      {submitted[field.id] || '-'}
                                    </div>
                                  ) : (
                                    <div className="text-[13px] text-muted-foreground py-1.5 px-2.5 bg-gray-50 dark:bg-accent rounded-md border border-border">
                                      {(field as any).placeholder || field.label}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                            {submitted ? (
                              <div className="px-3 pb-2.5 flex items-center gap-1.5 text-[11px] text-green-600 dark:text-green-400">
                                <Check className="h-3 w-3" />
                                <span>{ti.submittedByCustomer}</span>
                              </div>
                            ) : (
                              <div className="px-3 pb-2.5 text-[10px] text-muted-foreground italic">
                                {ti.waitingForCustomerToFillIn}
                              </div>
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-1 text-right">
                            {message.authorName || 'Bot'} &middot; {new Date(message.createdAt || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  // Render CSAT survey
                  if (interactiveType === 'csat_survey') {
                    const submittedRating = msgMeta?.submittedRating as number | undefined;
                    const submittedFeedback = msgMeta?.submittedFeedback as string | undefined;
                    return (
                      <div key={message.id} className="flex justify-end mb-4">
                        <div className="max-w-[75%] space-y-2">
                          <div className="px-4 py-2.5 rounded-2xl rounded-br-sm bg-[#D7E8FE] dark:bg-blue-900/40 text-[13px] text-foreground">
                            <p className="whitespace-pre-wrap">{message.content}</p>
                          </div>
                          <div className="rounded-xl border border-border bg-white dark:bg-secondary overflow-hidden">
                            <div className="p-3 space-y-2">
                              <div className="flex items-center justify-center gap-1 py-1">
                                {[1, 2, 3, 4, 5].map((star) => (
                                  <Star
                                    key={star}
                                    className={cn(
                                      'h-6 w-6',
                                      submittedRating != null && star <= submittedRating
                                        ? 'fill-yellow-400 text-yellow-400'
                                        : 'fill-transparent text-gray-300 dark:text-gray-600'
                                    )}
                                  />
                                ))}
                              </div>
                              {submittedRating != null && (
                                <p className="text-center text-[11px] text-muted-foreground">{submittedRating}/5</p>
                              )}
                              {submittedFeedback && (
                                <p className="text-[13px] text-foreground py-1.5 px-2.5 bg-gray-50 dark:bg-accent rounded-md">
                                  {submittedFeedback}
                                </p>
                              )}
                            </div>
                            {submittedRating != null ? (
                              <div className="px-3 pb-2.5 flex items-center gap-1.5 text-[11px] text-green-600 dark:text-green-400">
                                <Check className="h-3 w-3" />
                                <span>{ti.ratedByCustomer}</span>
                              </div>
                            ) : (
                              <div className="px-3 pb-2.5 text-[10px] text-muted-foreground italic">
                                {ti.waitingForCustomerToRate}
                              </div>
                            )}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-1 text-right">
                            {message.authorName || 'Bot'} &middot; {new Date(message.createdAt || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                      </div>
                    );
                  }

                  const isInternalNote = message.isInternal === true || message.type === 'note';
                  const lines = (message.content || '').split('\n');
                  const lastLine = lines[lines.length - 1];
                  const shouldPutTimestampBelow = lastLine.length > 60;

                  // Check if the next message is from the same sender AND within 5 minutes
                  // Internal notes never group with other messages
                  const nextMessage = array[index + 1];
                  const nextIsInternal = nextMessage && (nextMessage.isInternal === true || nextMessage.type === 'note');
                  const isFollowedBySameSender = nextMessage && nextMessage.authorType === message.authorType && !isInternalNote && !nextIsInternal;
                  const timeDiffInMinutes = nextMessage
                    ? Math.abs(new Date(nextMessage.createdAt || 0).getTime() - new Date(message.createdAt || 0).getTime()) / (1000 * 60)
                    : Infinity;
                  const shouldGroupWithNext = isFollowedBySameSender && timeDiffInMinutes <= 5;
                  const marginBottom = shouldGroupWithNext ? "mb-1.5" : "mb-6";

                  // Check if the previous message is from the same sender AND within 5 minutes
                  const prevMessage = array[index - 1];
                  const prevIsInternal = prevMessage && (prevMessage.isInternal === true || prevMessage.type === 'note');
                  const isPrecededBySameSender = prevMessage && prevMessage.authorType === message.authorType && !isInternalNote && !prevIsInternal;
                  const prevTimeDiffInMinutes = prevMessage
                    ? Math.abs(new Date(message.createdAt || 0).getTime() - new Date(prevMessage.createdAt || 0).getTime()) / (1000 * 60)
                    : Infinity;
                  const isGroupedWithPrev = isPrecededBySameSender && prevTimeDiffInMinutes <= 5;

                  // Determine border radius based on grouping
                  // Agent messages: bottom-right is always small, top-right is small only when grouped with prev
                  // Customer messages: bottom-left is always small, top-left is small only when grouped with prev
                  let borderRadiusClass = "rounded-2xl";
                  if (isInternalNote) {
                    borderRadiusClass = "rounded-2xl";
                  } else if (message.authorType === 'agent') {
                    if (isGroupedWithPrev && shouldGroupWithNext) {
                      borderRadiusClass = "rounded-l-2xl rounded-tr-sm rounded-br-sm";
                    } else if (isGroupedWithPrev && !shouldGroupWithNext) {
                      borderRadiusClass = "rounded-l-2xl rounded-tr-sm rounded-br-sm";
                    } else if (!isGroupedWithPrev && shouldGroupWithNext) {
                      borderRadiusClass = "rounded-2xl rounded-br-sm";
                    } else {
                      borderRadiusClass = "rounded-2xl rounded-br-sm";
                    }
                  } else {
                    if (isGroupedWithPrev && shouldGroupWithNext) {
                      borderRadiusClass = "rounded-r-2xl rounded-tl-sm rounded-bl-sm";
                    } else if (isGroupedWithPrev && !shouldGroupWithNext) {
                      borderRadiusClass = "rounded-r-2xl rounded-tl-sm rounded-bl-sm";
                    } else if (!isGroupedWithPrev && shouldGroupWithNext) {
                      borderRadiusClass = "rounded-2xl rounded-bl-sm";
                    } else {
                      borderRadiusClass = "rounded-2xl rounded-bl-sm";
                    }
                  }

                  return (
                    <div key={message.id} className={cn(
                      "flex gap-2 items-end",
                      marginBottom,
                      isInternalNote ? "justify-end" : message.authorType === 'agent' ? "justify-end" : ""
                    )}>
                      <div className={cn(
                        "inline-block max-w-[70%] overflow-hidden",
                        isInternalNote || message.authorType === 'agent' ? "ml-auto" : ""
                      )}>
                        {isInternalNote && (
                          <div className="flex items-center gap-1 justify-end mb-1">
                            <Lock className="w-3 h-3 text-amber-700 dark:text-amber-400" />
                            <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">{ti.internalNote}</span>
                          </div>
                        )}
                        <div className={cn(
                          "inline-block",
                          borderRadiusClass,
                          !(message.content || '').trim() && message.attachments?.length ? "px-2 py-1.5" : "px-4 py-2.5",
                          isInternalNote
                            ? "bg-amber-100 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800"
                            : message.authorType === 'agent'
                              ? "bg-[#D7E8FE] dark:bg-blue-900/40"
                              : "bg-[#F5F6F8] dark:bg-secondary"
                        )}>
                          {(message.content || '').trim() && (
                            <div className={cn(
                              "text-[14px] leading-relaxed whitespace-pre-wrap break-all",
                              isInternalNote
                                ? "text-amber-900 dark:text-amber-200"
                                : message.authorType === 'agent'
                                  ? "text-gray-900 dark:text-gray-900"
                                  : "text-gray-700 dark:text-foreground"
                            )}>
                              {lines.map((line, i) => {
                                const isLastLine = i === lines.length - 1;
                                if (isLastLine && !shouldPutTimestampBelow && !(message.attachments && message.attachments.length > 0)) {
                                  return (
                                    <div key={i} className="flex items-end gap-2">
                                      <span className="flex-1">{line}</span>
                                      <div className="flex items-center gap-1.5 flex-shrink-0 -translate-y-px">
                                        <span className={cn(
                                          "text-[11px]",
                                          isInternalNote
                                            ? "text-amber-700 dark:text-amber-400"
                                            : message.authorType === 'agent'
                                              ? "text-gray-700 dark:text-gray-700"
                                              : "text-gray-500 dark:text-muted-foreground"
                                        )}>
                                          {format(new Date(message.createdAt || new Date()), 'h:mm a')}
                                        </span>
                                        {message.authorType === 'agent' && !isInternalNote && (
                                          <CheckCheck className="w-4 h-4 text-gray-700" />
                                        )}
                                      </div>
                                    </div>
                                  );
                                }
                                return <div key={i}>{line || <br />}</div>;
                              })}
                              {shouldPutTimestampBelow && !(message.attachments && message.attachments.length > 0) && (
                                <div className="flex items-center gap-1.5 justify-end mt-1">
                                  <span className={cn(
                                    "text-[11px]",
                                    isInternalNote
                                      ? "text-amber-700 dark:text-amber-400"
                                      : message.authorType === 'agent'
                                        ? "text-gray-700 dark:text-gray-700"
                                        : "text-gray-500 dark:text-muted-foreground"
                                  )}>
                                    {format(new Date(message.createdAt || new Date()), 'h:mm a')}
                                  </span>
                                  {message.authorType === 'agent' && !isInternalNote && (
                                    <CheckCheck className="w-4 h-4 text-gray-700" />
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                          {/* Message Attachments */}
                          {renderAttachments(message.attachments, message.authorType === 'agent')}
                          {/* Timestamp below attachments */}
                          {message.attachments && message.attachments.length > 0 && (
                            <div className="flex items-center gap-1.5 justify-end mt-1">
                              <span className={cn(
                                "text-[11px]",
                                isInternalNote
                                  ? "text-amber-700 dark:text-amber-400"
                                  : message.authorType === 'agent'
                                    ? "text-gray-700 dark:text-gray-700"
                                    : "text-gray-500 dark:text-muted-foreground"
                              )}>
                                {format(new Date(message.createdAt || new Date()), 'h:mm a')}
                              </span>
                              {message.authorType === 'agent' && !isInternalNote && (
                                <CheckCheck className="w-4 h-4 text-gray-700" />
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Typing Indicator */}
                {typingUsers.size > 0 && (
                  <div className="flex gap-2 mb-4 items-center">
                    <div className="bg-gray-100 dark:bg-secondary rounded-2xl rounded-bl-sm px-4 flex items-center" style={{ height: '42.75px' }}>
                      <div className="flex gap-1">
                        <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse"></div>
                        <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse" style={{ animationDelay: '200ms' }}></div>
                        <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse" style={{ animationDelay: '400ms' }}></div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Scroll anchor for newest message (at bottom) */}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>
        </div>

        {/* WeldAgent Input - Clean Design */}
        <div className="bg-white dark:bg-background/50 flex-shrink-0">
          <div className="p-5">
            {conversation.status === 'closed' ? (
              <div className="space-y-3">
                {review && (
                  <div className="flex items-center gap-3 py-3 px-4 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800">
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((value) => (
                        <Star
                          key={value}
                          className={cn(
                            "h-4 w-4",
                            value <= review.rating
                              ? "text-amber-400 fill-amber-400"
                              : "text-gray-300"
                          )}
                        />
                      ))}
                    </div>
                    <span className="text-sm text-gray-600 dark:text-muted-foreground">
                      {review.content || ti.noComment}
                    </span>
                    <span className="text-xs text-gray-400 ml-auto flex-shrink-0">
                      {review.reviewerName}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-center py-3 px-4 bg-gray-50 dark:bg-background rounded-lg border border-gray-200 dark:border-border">
                  <span className="text-sm text-gray-500 dark:text-muted-foreground">
                    {ti.thisConversationIsClosed}
                  </span>
                </div>
              </div>
            ) : (
              <div className="space-y-0">
                {isAutoDraft ? (
                  <div className={cn(
                    "w-full max-w-[768px] mx-auto rounded-[20px] border border-gray-200 dark:border-border bg-white dark:bg-background p-[10px] min-h-[102px] flex flex-col shadow-[0_1px_4px_-1px_rgba(0,0,0,0.03)]",
                    isInternalNote && "ring-1 ring-amber-300 dark:ring-amber-700"
                  )}>
                    {/* AI Preview Area */}
                    <div className="mx-2 mt-1 mb-2 rounded-lg border border-purple-200/60 dark:border-purple-500/20 bg-gradient-to-br from-purple-50/50 via-blue-50/30 to-violet-50/40 dark:from-purple-950/20 dark:via-blue-950/10 dark:to-violet-950/15 px-3 py-3">
                      <div
                        className="w-full min-h-[60px] text-[15px] text-gray-900 dark:text-foreground outline-none bg-transparent whitespace-pre-wrap"
                        contentEditable
                        suppressContentEditableWarning
                        onInput={(e) => setWeldAgentPrompt(e.currentTarget.textContent || '')}
                        ref={(el) => {
                          if (el && el.textContent !== weldAgentPrompt && !el.matches(':focus')) {
                            el.textContent = weldAgentPrompt;
                          }
                        }}
                      />
                    </div>
                    {/* AI Input Bar */}
                    <div className="flex items-center gap-2 px-2 py-2">
                      <PenLine className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <textarea
                        ref={autoDraftInputRef}
                        value={autoDraftPrompt}
                        onChange={(e) => {
                          setAutoDraftPrompt(e.target.value);
                          e.target.style.height = 'auto';
                          e.target.style.height = e.target.scrollHeight + 'px';
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            if (!autoDraftPrompt.trim() || isAutoDraftRegenerating) return;
                            // WELDDESK AI IS OFFLINE — the /welddesk/conversations/ai-reply
                            // route 404s today, so this already ended in the
                            // failure toast below. Same outcome, no request.
                            toast.error(ti.failedToUpdateDraft);
                            setAutoDraftPrompt('');
                          }
                          if (e.key === 'Escape') {
                            setIsAutoDraft(false);
                            setAutoDraftPrompt('');
                            setWeldAgentPrompt('');
                          }
                        }}
                        placeholder={ti.tellWeldAgentWhatToChange}
                        className="flex-1 text-sm outline-none bg-transparent placeholder-muted-foreground/60 resize-none overflow-hidden min-h-[24px] mt-[3px] ml-[3px]"
                        rows={1}
                      />
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setIsAutoDraft(false);
                            setAutoDraftPrompt('');
                            setWeldAgentPrompt('');
                          }}
                        >
                          {ti.cancel}
                        </Button>
                        {autoDraftPrompt.trim() ? (
                          <Button
                            size="sm"
                            onClick={() => {
                              if (!autoDraftPrompt.trim() || isAutoDraftRegenerating) return;
                              // WELDDESK AI IS OFFLINE — /welddesk/conversations/ai-reply
                              // 404s today, so this already ended in the failure
                              // toast below. Same outcome, no request.
                              toast.error(ti.failedToUpdateDraft);
                              setAutoDraftPrompt('');
                            }}
                            disabled={isAutoDraftRegenerating}
                          >
                            {isAutoDraftRegenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : ti.regenerate}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => {
                              setIsAutoDraft(false);
                              setAutoDraftPrompt('');
                            }}
                          >
                            {ti.insert}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <WeldAgentInput
                    value={weldAgentPrompt}
                    onChange={handleInputChange}
                    onSend={handleWeldAgentSend}
                    disabled={isPending}
                    placeholder={isInternalNote ? ti.writeInternalNote : undefined}
                    enableAttachments
                    className={isInternalNote ? "ring-1 ring-amber-300 dark:ring-amber-700" : undefined}
                    extraLeftActions={
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setIsInternalNote(!isInternalNote)}
                          className={cn(
                            "p-[7px] rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                            isInternalNote
                              ? "text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40"
                              : "text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent"
                          )}
                          title={isInternalNote ? ti.switchToReply : ti.switchToInternalNote}
                        >
                          <StickyNote className="h-[16px] w-[16px]" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          /*
                            WELDDESK AI IS OFFLINE — /helpdesk/conversations/:id/auto-draft
                            hard-returns 503 `ai_unavailable` since the AI teardown, so this
                            only ever produced a failure toast. Because the panel below opens
                            only on auto-draft SUCCESS, that 503 already made the whole
                            auto-draft/regenerate UI unreachable — it is pre-existing dead
                            code, left in place for the AI rebuild rather than deleted here.
                          */
                        disabled
                        className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        title={ti.autoDraftWithAI}
                      >
                        <img src="/assets/images/weldagent/logo-light.png" alt="WeldAgent" className="h-[18px] w-[18px]" />
                      </Button>
                      <CannedResponsePicker
                        variables={{
                          customer: {
                            name: conversation.customerName || '',
                            email: conversation.customerEmail || '',
                          },
                          agent: { name: userName || '' },
                          conversation: { id: conversation.id },
                        }}
                        onSelect={(result) => {
                          setWeldAgentPrompt(result.content);
                          // Execute macro actions if any
                          if (result.actions && result.actions.length > 0) {
                            for (const action of result.actions) {
                              // Actions are executed via existing conversation APIs
                              // handled by the parent component through standard mutations
                            }
                          }
                        }}
                        disabled={isPending}
                      />
                      </>
                    }
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Contact Details Sidebar */}
      {conversation.contactId ? (
        <div className="w-[500px] border-l border-border flex flex-col h-full">
          <div className="flex-1 overflow-y-auto min-h-0">
            <ContactDetailView
              contactId={conversation.contactId}
              mode="embedded"
              onToggleExpand={() => setIsContactExpanded(true)}
              visitorLocation={conversation.visitorLocation}
            />
            {/* Activity Log */}
            {auditLogs.length > 0 && (
              <div className="border-t border-border px-4 py-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{ti.activityLabel}</h3>
                <AuditTimeline logs={auditLogs} />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="w-[500px] border-l border-border flex flex-col h-full">
          <div className="flex-1 flex items-center justify-center">
            {contactCreateFailed ? (
              <p className="text-sm text-muted-foreground">{ti.noContactLinked}</p>
            ) : (
              <div className="flex items-center justify-center gap-2 py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{ti.loading}</span>
              </div>
            )}
          </div>
          {/* Activity Log */}
          {auditLogs.length > 0 && (
            <div className="border-t border-border px-4 py-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{ti.activityLabel}</h3>
              <AuditTimeline logs={auditLogs} />
            </div>
          )}
        </div>
      )}
    </div>

    {/* Expanded Contact Detail Overlay */}
    {isContactExpanded && conversation.contactId && (
      <div
        className="fixed inset-0 md:inset-auto md:right-0 md:top-[60px] md:bottom-0 z-40 bg-background"
        style={{ width: 'calc(100% - 64px - 16rem)' }}
      >
        <ContactDetailView
          contactId={conversation.contactId}
          mode="page"
          isExpanded={true}
          onToggleExpand={() => setIsContactExpanded(false)}
          visitorLocation={conversation.visitorLocation}
        />
      </div>
    )}

    {/* Create Ticket Dialog */}
    <CreateTicketDialog
      open={showCreateTicket}
      onOpenChange={setShowCreateTicket}
      conversationId={conversation.id}
      onTicketCreated={(ticketId) => setLinkedTicketId(ticketId)}
      prefillData={{
        subject: conversation.subject || 'No subject',
        customerEmail: conversation.customerEmail || 'customer@example.com',
        customerName: conversation.customerName || 'Unknown Customer',
        description: messages[0]?.content || conversation.preview || 'No description available',
      }}
    />

    {/* Delete Confirmation Dialog */}
    <ConfirmDialog
      open={showDeleteDialog}
      onOpenChange={setShowDeleteDialog}
      title={ti.deleteConversation}
      description={ti.deleteConversationConfirmDescription}
      confirmLabel={ti.deleteConfirm}
      variant="destructive"
      onConfirm={handleDeleteConfirm}
    />

    {/* Create Task Dialog */}
    <CreateTaskDialog
      open={showCreateTaskDialog}
      onOpenChange={setShowCreateTaskDialog}
      defaultTitle={`Follow up: ${conversation.subject || 'Conversation'}`}
      defaultDescription={`Related to conversation with ${conversation.customerName || conversation.customerEmail || 'customer'}`}
    />

    {/* Image Preview Overlay */}
    {previewImage && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
        onClick={() => setPreviewImage(null)}
        onKeyDown={(e) => { if (e.key === 'Escape') setPreviewImage(null); }}
        tabIndex={0}
        ref={(el) => el?.focus()}
      >
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setPreviewImage(null)}
          className="absolute top-4 right-4 p-2 rounded-lg bg-black/50 hover:bg-black/70 text-white transition-colors z-10"
        >
          <X className="h-5 w-5" />
        </Button>
        <a
          href={previewImage.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="absolute top-4 right-16 p-2 rounded-lg bg-black/50 hover:bg-black/70 text-white transition-colors z-10"
          title={ti.openInNewTab}
        >
          <Download className="h-5 w-5" />
        </a>
        <Loader2 className="h-6 w-6 animate-spin text-white/50 absolute" />
        <img
          src={previewImage.url}
          alt={previewImage.name}
          className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg relative"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    )}

    </>
  );
}
