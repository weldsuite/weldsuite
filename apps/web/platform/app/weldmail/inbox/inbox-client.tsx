
import React, { useState, useEffect, useRef } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useMobileNavOptional } from '@/contexts/mobile-nav-context';
import {
  Search,
  Archive,
  Trash,
  Star,
  MoreVertical,
  Reply,
  Forward,
  Clock,
  Mail,
  Paperclip,
  Tag,
  Send,
  X,
  Loader2,
  ChevronDown,
  Filter,
  Plus,
  MessageSquare,
  Check,
  Edit,
  Minimize2,
  Maximize2,
  Expand,
  PenSquare,
  Library,
  FileText,
  LayoutGrid,
  Globe,
  ShoppingCart,
  Users,
  Server,
  Package,
  Megaphone,
  Headphones,
  Warehouse,
  BookOpen,
  CheckSquare,
  Settings,
  Mic,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Copy,
  Eye,
  Flag,
  AlertTriangle,
  FileDown,
  Shield,
  StickyNote,
  ListTodo,
  Pin,
  CornerDownRight,
  PictureInPicture2,
  Minus,
  Link,
  Smile,
  HardDrive,
  Image,
  Bell,
  ShieldAlert,
  Calendar,
  type LucideIcon
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { ButtonGroup } from '@weldsuite/ui/components/button-group';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Separator } from '@weldsuite/ui/components/separator';
import { Card, CardContent, CardDescription, CardTitle } from '@weldsuite/ui/components/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuGroup, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuPortal } from '@weldsuite/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import { Calendar as CalendarComponent } from '@weldsuite/ui/components/calendar';
import { cn } from '@/lib/utils';
import { format, isToday, isYesterday } from 'date-fns';
import { toast } from 'sonner';
import { mailApi } from '../lib/api-client';
import { IsolatedHtmlContent } from '../components/isolated-html-content';
import {
  useMarkMailRead,
  useToggleMailStar,
  useMoveToTrash,
  useArchiveMailMessage,
} from '@/hooks/queries/use-mail-queries';
import type { Mail } from '@/lib/api/types/apps/mail.types';

type EmailMessage = Mail.Email;
type EmailFolder = string;

// AI Assistant Panel removed - now using BreadcrumbHeader WeldAgent. Kept as a
// disabled flag (rather than deleting the JSX) since `showAiPanel` still
// drives layout elsewhere (width/flex classes further down).
const AI_PANEL_ENABLED = false;

interface InboxClientProps {
  initialMessages: EmailMessage[];
  folders: EmailFolder[];
  currentFolder: EmailFolder | null;
  activeAccount: {
    id: string;
    email: string;
    displayName: string;
  };
}

export function InboxClient({
  initialMessages,
  currentFolder,
  activeAccount
}: InboxClientProps) {
  const { t } = useI18n();
  const st = useTranslations();
  // Set breadcrumbs for inbox
  useBreadcrumbs([
    { label: t.mail.inboxPage.mailBreadcrumb, href: '/weldmail' },
    { label: currentFolder || t.mail.inboxPage.inboxBreadcrumb }
  ]);

  const mobileNav = useMobileNavOptional();
  const agentRight = mobileNav?.showWeldAgent ? `${(mobileNav?.weldAgentWidth ?? 480) + 16}px` : '16px';

  const markReadMutation = useMarkMailRead();
  const toggleStarMutation = useToggleMailStar();
  const moveToTrashMutation = useMoveToTrash();
  const archiveMessageMutation = useArchiveMailMessage();

  const [messages, setMessages] = useState<EmailMessage[]>(initialMessages);
  const [selectedEmail, setSelectedEmail] = useState<EmailMessage | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [isAiPanelFullscreen, setIsAiPanelFullscreen] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isComposeMinimized, setIsComposeMinimized] = useState(false);
  const [showCompletedEmails, setShowCompletedEmails] = useState(false);
  const [completedEmails, setCompletedEmails] = useState<Set<string>>(new Set());
  const [setAsideEmails] = useState<Set<string>>(new Set());
  const [pinnedEmails, setPinnedEmails] = useState<Set<string>>(new Set());
  const [snoozedEmails, setSnoozedEmails] = useState<Set<string>>(new Set());
  const [snoozeCalendarOpen, setSnoozeCalendarOpen] = useState(false);
  const [snoozeCustomDate, setSnoozeCustomDate] = useState<Date | undefined>(undefined);
  const snoozeCalendarTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [isReplying, setIsReplying] = useState(false);
  const [composeData, setComposeData] = useState({
    to: '',
    subject: '',
    body: ''
  });
  const [aiMessages, setAiMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([
    { role: 'assistant', content: st('sweep.weldmail.aiPanel.greeting') }
  ]);
  const [aiInput, setAiInput] = useState('');
  const [chatHistory, setChatHistory] = useState<Array<{ id: string; title: string; timestamp: Date }>>([
    { id: '1', title: st('sweep.weldmail.aiPanel.sampleChat1'), timestamp: new Date(Date.now() - 86400000) },
    { id: '2', title: st('sweep.weldmail.aiPanel.sampleChat2'), timestamp: new Date(Date.now() - 172800000) },
    { id: '3', title: st('sweep.weldmail.aiPanel.sampleChat3'), timestamp: new Date(Date.now() - 259200000) },
  ]);
  const [currentChatId, setCurrentChatId] = useState<string>('current');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showPreferencesModal, setShowPreferencesModal] = useState(false);
  const [showAppDetailModal, setShowAppDetailModal] = useState(false);
  const [selectedApp, setSelectedApp] = useState<{ name: string; icon: LucideIcon } | null>(null);
  const [isEmailCollapsed, setIsEmailCollapsed] = useState(false);
  const [isLoadingEmail, setIsLoadingEmail] = useState(false);
  const [collapsedPreviews] = useState<Set<string>>(new Set());
  const [showAllRecipients, setShowAllRecipients] = useState(false);
  const [hoveredWeldMailTeam, setHoveredWeldMailTeam] = useState(false);
  const [hoveredWeldMailTeamList, setHoveredWeldMailTeamList] = useState(false);
  const [hoveredWeldMailTeamCollapsed, setHoveredWeldMailTeamCollapsed] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hoverTimeoutRefList = useRef<NodeJS.Timeout | null>(null);
  const hoverTimeoutRefCollapsed = useRef<NodeJS.Timeout | null>(null);
  
  // Compose enhancements
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showTagsPopup, setShowTagsPopup] = useState(false);
  const [scheduledTime, setScheduledTime] = useState<Date | null>(null);
  const [showSchedulePopup, setShowSchedulePopup] = useState(false);
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [ccRecipients, setCcRecipients] = useState('');
  const [bccRecipients, setBccRecipients] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputRefMinimized = useRef<HTMLInputElement>(null);
  const aiInputRef = useRef<HTMLTextAreaElement>(null);
  
  // Text selection popup state
  const [selectedText, setSelectedText] = useState('');
  const [popupPosition, setPopupPosition] = useState({ x: 0, y: 0 });
  const [showSelectionPopup, setShowSelectionPopup] = useState(false);

  // Popup reply window state
  const [showPopupReply, setShowPopupReply] = useState(false);
  const [isPopupMinimized, setIsPopupMinimized] = useState(false);
  const [popupComposeData, setPopupComposeData] = useState({
    to: '',
    subject: '',
    body: ''
  });
  const [showSubjectField, setShowSubjectField] = useState(false);
  const [showPopupCc, setShowPopupCc] = useState(false);
  const [showPopupBcc, setShowPopupBcc] = useState(false);
  const [popupCcRecipients, setPopupCcRecipients] = useState('');
  const [popupBccRecipients, setPopupBccRecipients] = useState('');

  const filteredMessages = messages
    .filter(msg => {
      const matchesSearch = msg.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
        msg.from.toLowerCase().includes(searchQuery.toLowerCase()) ||
        msg.preview.toLowerCase().includes(searchQuery.toLowerCase());

      const isCompleted = completedEmails.has(msg.id);
      const isSetAside = setAsideEmails.has(msg.id);
      const isSnoozed = snoozedEmails.has(msg.id);

      // Show email if: matches search AND (showing completed OR email is not completed) AND not set aside AND not snoozed
      return matchesSearch && (showCompletedEmails || !isCompleted) && !isSetAside && !isSnoozed;
    })
    .sort((a, b) => {
      // Pinned emails always come first
      const aIsPinned = pinnedEmails.has(a.id);
      const bIsPinned = pinnedEmails.has(b.id);

      if (aIsPinned && !bIsPinned) return -1;
      if (!aIsPinned && bIsPinned) return 1;

      // If both pinned or both not pinned, maintain original order (by date)
      return 0;
    });

  // Helper function to get date label
  const getDateLabel = (dateString: string) => {
    const messageDate = new Date(dateString);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Reset time to compare only dates
    today.setHours(0, 0, 0, 0);
    yesterday.setHours(0, 0, 0, 0);
    messageDate.setHours(0, 0, 0, 0);

    if (messageDate.getTime() === today.getTime()) {
      return 'Today';
    } else if (messageDate.getTime() === yesterday.getTime()) {
      return 'Yesterday';
    } else {
      // Return formatted date for older messages
      return messageDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    }
  };

  // Group messages by date (group all messages first, then filter for display)
  const allGroupedMessages = messages.reduce((groups: { [key: string]: EmailMessage[] }, message) => {
    const label = getDateLabel(message.date);
    if (!groups[label]) {
      groups[label] = [];
    }
    groups[label].push(message);
    return groups;
  }, {});

  // Filter grouped messages for display
  const groupedMessages: { [key: string]: EmailMessage[] } = {};
  Object.entries(allGroupedMessages).forEach(([dateLabel, emails]) => {
    const filteredEmails = emails
      .filter(msg => {
        const matchesSearch = msg.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
          msg.from.toLowerCase().includes(searchQuery.toLowerCase()) ||
          msg.preview.toLowerCase().includes(searchQuery.toLowerCase());

        const isCompleted = completedEmails.has(msg.id);
        const isSetAside = setAsideEmails.has(msg.id);
        const isSnoozed = snoozedEmails.has(msg.id);

        return matchesSearch && (showCompletedEmails || !isCompleted) && !isSetAside && !isSnoozed;
      })
      .sort((a, b) => {
        // Pinned emails always come first within each date group
        const aIsPinned = pinnedEmails.has(a.id);
        const bIsPinned = pinnedEmails.has(b.id);

        if (aIsPinned && !bIsPinned) return -1;
        if (!aIsPinned && bIsPinned) return 1;

        // If both pinned or both not pinned, maintain original order
        return 0;
      });

    // Only include the date section if it has emails after filtering
    if (filteredEmails.length > 0) {
      groupedMessages[dateLabel] = filteredEmails;
    }
  });

  // Generate avatar color based on sender name
  const getAvatarColor = (name: string) => {
    const colors = [
      '#fbbf24', // yellow
      '#ef4444', // red
      '#3b82f6', // blue
      '#10b981', // green
      '#8b5cf6', // purple
      '#f59e0b', // orange
      '#ec4899', // pink
      '#14b8a6', // teal
      '#6366f1', // indigo
      '#f97316', // orange-red
    ];

    // Generate a consistent index based on the name
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % colors.length;
    return colors[index];
  };

  const handleMarkAsRead = async (messageId: string) => {
    markReadMutation.mutate({ id: messageId, read: true, accountId: activeAccount.id }, {
      onSuccess: () => {
        setMessages(prev => prev.map(msg =>
          msg.id === messageId ? { ...msg, isRead: true } : msg
        ));
      },
    });
  };

  const handleToggleStar = async (messageId: string) => {
    const msg = messages.find(m => m.id === messageId);
    const newStarredState = !msg?.isStarred;

    try {
      // Optimistically update UI
      setMessages(prev => prev.map(m =>
        m.id === messageId ? { ...m, isStarred: newStarredState } : m
      ));

      // Update selectedEmail if it's the one being starred
      if (selectedEmail?.id === messageId) {
        setSelectedEmail(prev => prev ? { ...prev, isStarred: newStarredState } : null);
      }

      toast.success(newStarredState ? t.mail.inboxPage.emailStarred : t.mail.inboxPage.emailUnstarred);

      // Make API call in background - pass account ID for star toggle
      toggleStarMutation.mutate({ id: messageId, isStarred: newStarredState, accountId: activeAccount.id }, {
        onError: () => {
          // Revert on error
          setMessages(prev => prev.map(m =>
            m.id === messageId ? { ...m, isStarred: !newStarredState } : m
          ));

          if (selectedEmail?.id === messageId) {
            setSelectedEmail(prev => prev ? { ...prev, isStarred: !newStarredState } : null);
          }

          toast.error(t.mail.inboxPage.failedToUpdateStar);
        },
      });
    } catch (error) {
      // Revert on error
      setMessages(prev => prev.map(m =>
        m.id === messageId ? { ...m, isStarred: !newStarredState } : m
      ));

      if (selectedEmail?.id === messageId) {
        setSelectedEmail(prev => prev ? { ...prev, isStarred: !newStarredState } : null);
      }

      console.error('Error toggling star:', error);
      toast.error(t.mail.inboxPage.failedToUpdateStar);
    }
  };

  const handleDelete = async (messageId: string) => {
    moveToTrashMutation.mutate({ id: messageId, accountId: activeAccount.id }, {
      onSuccess: () => {
        setMessages(prev => prev.filter(msg => msg.id !== messageId));
        setSelectedEmail(null);
        toast.success(t.mail.inboxPage.movedToTrash);
      },
      onError: () => {
        toast.error(t.mail.inboxPage.failedToDelete);
      },
    });
  };

  const handleArchive = async (messageId: string) => {
    archiveMessageMutation.mutate({ id: messageId, accountId: activeAccount.id }, {
      onSuccess: () => {
        setMessages(prev => prev.filter(msg => msg.id !== messageId));
        setSelectedEmail(null);
        toast.success(t.mail.inboxPage.archived);
      },
    });
  };

  const handlePin = (messageId: string) => {
    setPinnedEmails(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
        toast.success(t.mail.inboxPage.emailUnpinned);
      } else {
        newSet.add(messageId);
        toast.success(t.mail.inboxPage.emailPinned);
      }
      return newSet;
    });
  };

  const handleSnooze = (messageId: string) => {
    setSnoozedEmails(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
        toast.success(t.mail.inboxPage.emailUnsnoozed);
      } else {
        newSet.add(messageId);
        toast.success(t.mail.inboxPage.emailSnoozed);
      }
      return newSet;
    });
    setSelectedEmail(null);
  };

  const handleSnoozeCalendarMouseEnter = () => {
    if (snoozeCalendarTimeoutRef.current) {
      clearTimeout(snoozeCalendarTimeoutRef.current);
    }
    setSnoozeCalendarOpen(true);
  };

  const handleSnoozeCalendarMouseLeave = () => {
    snoozeCalendarTimeoutRef.current = setTimeout(() => {
      setSnoozeCalendarOpen(false);
    }, 200);
  };

  const formatEmailDate = (date: Date) => {
    const emailDate = new Date(date);
    
    if (isToday(emailDate)) {
      return format(emailDate, 'h:mm a');
    } else if (isYesterday(emailDate)) {
      return 'Yesterday';
    } else {
      return format(emailDate, 'MMM d');
    }
  };

  const openEmail = async (email: EmailMessage) => {
    // Show preview immediately
    setSelectedEmail(email);
    setIsComposing(false);
    setIsReplying(false);
    setIsEmailCollapsed(false);

    // Optimistically mark as read in the UI
    if (!email.isRead) {
      setSelectedEmail(prev => prev ? { ...prev, isRead: true } : prev);
      setMessages(prev => prev.map(msg =>
        msg.id === email.id ? { ...msg, isRead: true } : msg
      ));
    }

    // Fetch full content if not already loaded
    if (!email.body && !email.bodyHtml) {
      setIsLoadingEmail(true);
      try {
        const result = await mailApi.messages.get(activeAccount.id, email.id);
        if (result.success && result.data) {
          const fullMessage = result.data;
          // Update selected email with full content, preserving original display fields
          const updatedMessage = {
            ...fullMessage,
            preview: fullMessage.preview || email.preview,
            from: email.from,
            fromEmail: email.fromEmail,
          };
          setSelectedEmail(updatedMessage);
          // Also update in the messages list, preserving original display fields
          setMessages(prev => prev.map(msg =>
            msg.id === email.id ? {
              ...msg,
              ...fullMessage,
              preview: fullMessage.preview || msg.preview,
              from: msg.from,
              fromEmail: msg.fromEmail,
            } : msg
          ));
        }
      } catch (error) {
        console.error('Failed to fetch email content:', error);
        toast.error(t.mail.inboxPage.failedToLoadEmail);
      } finally {
        setIsLoadingEmail(false);
      }
    }

    if (!email.isRead) {
      handleMarkAsRead(email.id);
    }
  };

  const handleAiSend = () => {
    if (!aiInput.trim()) return;
    
    setAiMessages(prev => [...prev, { role: 'user', content: aiInput }]);
    
    // Simulate AI response
    setTimeout(() => {
      setAiMessages(prev => [...prev, { 
        role: 'assistant', 
        content: `I'll help you with "${aiInput}". Based on your current email context, here's what I suggest...` 
      }]);
    }, 1000);
    
    setAiInput('');
    
    // Reset textarea height
    if (aiInputRef.current) {
      aiInputRef.current.style.height = '40px';
    }
  };

  // Compose enhancement functions
  const handleFileAttachment = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      const newFiles = Array.from(files);
      setAttachedFiles(prev => [...prev, ...newFiles]);
      toast.success(t.mail.inboxPage.filesAttached.replace('{n}', String(newFiles.length)));
    }
  };

  const removeAttachment = (index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const availableTags = [
    { id: '1', name: st('sweep.weldmail.tags.important'), color: '#ef4444' },
    { id: '2', name: st('sweep.weldmail.tags.work'), color: '#3b82f6' },
    { id: '3', name: st('sweep.weldmail.tags.personal'), color: '#10b981' },
    { id: '4', name: st('sweep.weldmail.tags.followUp'), color: '#eab308' },
    { id: '5', name: st('sweep.weldmail.tags.urgent'), color: '#f97316' },
  ];

  const toggleTag = (tagId: string) => {
    setSelectedTags(prev =>
      prev.includes(tagId)
        ? prev.filter(id => id !== tagId)
        : [...prev, tagId]
    );
  };


  const handleSchedule = (date: Date) => {
    setScheduledTime(date);
    setShowSchedulePopup(false);
    toast.success(t.mail.inboxPage.emailScheduled.replace('{date}', format(date, 'PPp')));
  };

  const handleSendEmail = async () => {
    // Validate required fields
    if (!composeData.to.trim()) {
      toast.error(t.mail.inboxPage.pleaseEnterRecipient);
      return;
    }
    if (!composeData.subject.trim()) {
      toast.error(t.mail.inboxPage.pleaseEnterSubject);
      return;
    }
    if (!composeData.body.trim()) {
      toast.error(t.mail.inboxPage.pleaseEnterMessage);
      return;
    }

    // Parse recipients (comma or semicolon separated)
    const parseRecipients = (str: string): string[] =>
      str.split(/[,;]/).map(e => e.trim()).filter(e => e.length > 0);

    const toAddresses = parseRecipients(composeData.to);
    const ccAddresses = ccRecipients ? parseRecipients(ccRecipients) : undefined;
    const bccAddresses = bccRecipients ? parseRecipients(bccRecipients) : undefined;

    // Simple HTML conversion (newlines to <br>)
    const htmlBody = composeData.body.replace(/\n/g, '<br>');

    // Handle scheduled emails
    if (scheduledTime) {
      toast.success(t.mail.inboxPage.emailScheduled.replace('{date}', format(scheduledTime, 'PPp')));
      // TODO: Implement scheduled email functionality
      setIsComposing(false);
      setComposeData({ to: '', subject: '', body: '' });
      setCcRecipients('');
      setBccRecipients('');
      setAttachedFiles([]);
      setSelectedTags([]);
      setScheduledTime(null);
      setShowCcBcc(false);
      return;
    }

    setIsSending(true);
    try {
      const result = await mailApi.messages.send(activeAccount.id, {
        to: toAddresses,
        cc: ccAddresses,
        bcc: bccAddresses,
        subject: composeData.subject.trim(),
        body: composeData.body.trim(),
        htmlBody,
      });

      if (result.success) {
        toast.success(t.mail.inboxPage.emailSentSuccessfully);
        // Reset form
        setIsComposing(false);
        setComposeData({ to: '', subject: '', body: '' });
        setCcRecipients('');
        setBccRecipients('');
        setAttachedFiles([]);
        setSelectedTags([]);
        setScheduledTime(null);
        setShowCcBcc(false);
      } else {
        toast.error(result.error || t.mail.inboxPage.failedToSendEmail);
      }
    } catch (error) {
      console.error('Failed to send email:', error);
      toast.error(t.mail.inboxPage.failedToSendEmail);
    } finally {
      setIsSending(false);
    }
  };

  const handleAskWeldAgent = () => {
    const textToAdd = selectedText;
    
    // First open the panel if needed
    if (!showAiPanel) {
      setShowAiPanel(true);
    }
    
    // Add the selected text to input with proper formatting
    setAiInput(prevInput => {
      if (prevInput.trim()) {
        return prevInput + '\n\n' + textToAdd;
      }
      return textToAdd;
    });
    
    // Hide popup and clear states
    setShowSelectionPopup(false);
    setSelectedText('');
    
    // Clear browser selection
    window.getSelection()?.removeAllRanges();
    
    // Focus the AI input field
    setTimeout(() => {
      if (aiInputRef.current) {
        aiInputRef.current.focus();
        const length = aiInputRef.current.value.length;
        aiInputRef.current.setSelectionRange(length, length);
      }
    }, 300);
  };

  // Handle ESC key to close compose and fullscreen AI panel
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isAiPanelFullscreen) {
          setIsAiPanelFullscreen(false);
        } else if (isComposing) {
          setIsComposing(false);
          setComposeData({ to: '', subject: '', body: '' });
        }
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isComposing, isAiPanelFullscreen]);

  // Handle text selection - bulletproof implementation
  useEffect(() => {
    let selectionTimeout: NodeJS.Timeout | null = null;
    let popupVisible = false;
    
    const clearSelection = () => {
      if (selectionTimeout) {
        clearTimeout(selectionTimeout);
        selectionTimeout = null;
      }
      if (popupVisible) {
        setShowSelectionPopup(false);
        setSelectedText('');
        popupVisible = false;
      }
    };
    
    const checkSelection = () => {
      const selection = window.getSelection();
      
      // No selection object or no ranges
      if (!selection || selection.rangeCount === 0) {
        clearSelection();
        return;
      }
      
      const text = selection.toString().trim();
      
      // No text selected
      if (!text || text.length === 0) {
        clearSelection();
        return;
      }
      
      try {
        // Get the first range
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        
        // Check if selection has valid dimensions
        if (rect.width <= 0 || rect.height <= 0) {
          clearSelection();
          return;
        }
        
        // Calculate position for popup
        const x = rect.left + (rect.width / 2);
        const y = rect.top + window.scrollY - 50; // 50px above selection
        
        // Update state
        setSelectedText(text);
        setPopupPosition({ x, y });
        setShowSelectionPopup(true);
        popupVisible = true;
        
      } catch (e) {
        console.error('Error getting selection:', e);
        clearSelection();
      }
    };
    
    const handleMouseUp = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // Ignore if clicking on the popup
      if (target.closest('.selection-popup')) {
        return;
      }
      
      // Clear any existing timeout
      if (selectionTimeout) {
        clearTimeout(selectionTimeout);
      }
      
      // Check for selection after delay
      selectionTimeout = setTimeout(() => {
        checkSelection();
      }, 300);
    };
    
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // If clicking on popup, don't do anything
      if (target.closest('.selection-popup')) {
        e.preventDefault();
        return;
      }
      
      // Clear selection state when starting new selection
      clearSelection();
    };
    
    const handleKeyDown = (e: KeyboardEvent) => {
      // Hide popup on Escape
      if (e.key === 'Escape') {
        clearSelection();
      }
    };
    
    // Add event listeners
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    
    // Cleanup
    return () => {
      if (selectionTimeout) {
        clearTimeout(selectionTimeout);
      }
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <>
      <style>{`
        @keyframes scaleIn {
          from {
            transform: scale(0.95) translateY(20px);
            opacity: 0;
          }
          to {
            transform: scale(1) translateY(0);
            opacity: 1;
          }
        }
        
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        
        .animate-scale-in {
          animation: scaleIn 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94);
          transform-origin: top center;
        }
        
        .animate-fade-in {
          animation: fadeIn 0.2s ease-out;
        }
        
        /* Keep text selection visible */
        ::selection {
          background-color: #3b82f6 !important;
          color: white !important;
        }
        
        ::-moz-selection {
          background-color: #3b82f6 !important;
          color: white !important;
        }
      `}</style>
    <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-background">
      {/* Main Content Area */}
      <div
        className="flex flex-1 overflow-y-hidden transition-all duration-300"
        style={{
          width: showAiPanel ? 'calc(100% - 480px)' : '100%'
        }}
      >
        {/* Email List - Spark Mail Style */}
        <div className="bg-white dark:bg-background flex flex-col h-full overflow-visible relative z-0 w-[420px]">
        {/* Clean Header */}
        <div className="pt-4 pb-3 px-4">
          {/* Header with Compose and Icons */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-1.5">
              <Switch
                id="show-completed"
                checked={showCompletedEmails}
                onCheckedChange={setShowCompletedEmails}
                className="scale-75"
              />
              <Label htmlFor="show-completed" className="text-xs text-gray-500 dark:text-muted-foreground cursor-pointer">
                {st('sweep.weldmail.inboxPage.doneToggle')}
              </Label>
            </div>
            <Button
              data-testid="inbox-compose-btn"
              onClick={() => {
                setIsComposing(true);
                setIsComposeMinimized(false);
                // Don't clear selectedEmail — keep it so closing compose
                // returns the user to the email they were reading instead of
                // the empty "Select a message" state.
              }}
              variant="default"
              size="sm"
              className="h-[34px] rounded-lg gap-2"
            >
              {st('sweep.weldmail.inboxPage.composeButton')}
            </Button>
          </div>

          {/* Search Bar with Filter */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
            <Input
              data-testid="inbox-search-input"
              placeholder={st('sweep.weldmail.search.inMail')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 pl-9 pr-9 w-full text-sm border border-border/50 bg-white dark:bg-background focus:bg-white dark:focus:bg-background shadow-none transition-all duration-200"
            />
            <Button variant="ghost" className="absolute right-1.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded-sm transition-colors flex items-center justify-center hover:bg-gray-100 dark:hover:bg-accent">
              <Filter className="h-4 w-4 text-muted-foreground/70" />
            </Button>
          </div>
        </div>

        {/* Email List */}
        <div
          className="flex-1 overflow-y-auto overflow-x-hidden inbox-list-scroll"
          style={{
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(156, 163, 175, 0.3) transparent'
          }}
        >
          {filteredMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-background/50 flex items-center justify-center mb-3">
                <Mail className="h-5 w-5 text-gray-400 dark:text-muted-foreground" />
              </div>
              <p className="text-sm text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.noMessagesFound}</p>
            </div>
          ) : (
            <div className="overflow-visible relative">
              {Object.entries(groupedMessages).map(([dateLabel, emails]) => (
                <div key={dateLabel} className="mb-1 pr-[5px]">
                  {/* Date Separator */}
                  <div className="relative flex items-center gap-2 px-3 md:px-4 h-8 bg-background border-b border-border/70 mb-1">
                    <div className="absolute inset-0 bg-muted/50 pointer-events-none" />
                    <span className="relative text-xs font-medium text-muted-foreground">{dateLabel}</span>
                    <span className="relative text-[10px] font-mono text-muted-foreground bg-muted border border-border w-[16px] h-[16px] flex items-center justify-center rounded-[5px] -translate-y-px">
                      <span className="translate-y-[1px]">{emails.length}</span>
                    </span>
                  </div>
                  {/* Emails for this date */}
                  {emails.map((email, emailIndex) => (
                <div key={email.id} className="relative">
                  <div
                    className={cn(
                      "group cursor-pointer border border-transparent relative z-0 py-2.5",
                      selectedEmail?.id === email.id
                        ? "bg-accent !border-accent border-l-transparent pl-4 -mr-1 pr-4 rounded-none"
                        : completedEmails.has(email.id)
                        ? "bg-gray-50 dark:bg-secondary -mx-3 px-6 rounded-lg hover:bg-gray-100 dark:hover:bg-accent"
                        : "hover:bg-gray-50 dark:hover:bg-accent pl-4 -mr-3 pr-6"
                    )}
                    onClick={() => openEmail(email)}
                  >
                    <div className="flex items-center gap-3">
                      {/* Avatar with Unread Indicator Dot */}
                      <div className="relative flex-shrink-0" style={{ marginTop: '-22px' }}>
                        {/* Blue dot to the left of avatar */}
                        {!email.isRead && selectedEmail?.id !== email.id && (
                          <div className="absolute -left-[11px] top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-blue-600 z-50" />
                        )}
                        <div
                          className="w-6 h-6 rounded-md flex items-center justify-center text-white font-semibold text-[10px]"
                          style={{ backgroundColor: getAvatarColor(email.from) }}
                        >
                          {email.from.charAt(0).toUpperCase()}
                        </div>
                      </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between gap-2">
                        <div className="flex-1">
                          {!collapsedPreviews.has(email.id) ? (
                            <>
                              <div className="flex items-center justify-between">
                                <div className={cn(
                                  "text-sm truncate flex-1",
                                  !email.isRead ? "font-semibold text-gray-900 dark:text-foreground" : "font-normal text-gray-500 dark:text-muted-foreground"
                                )}>
                                  {email.fromEmail || `${email.from.toLowerCase().replace(/\s+/g, '.')}@gmail.com`}
                                </div>
                                <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
                                  {email.isStarred && (
                                    <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500" />
                                  )}
                                  {pinnedEmails.has(email.id) && (
                                    <Pin className="h-3.5 w-3.5 text-blue-500 fill-blue-500" />
                                  )}
                                  {snoozedEmails.has(email.id) && (
                                    <Clock className="h-3.5 w-3.5 text-purple-500" />
                                  )}
                                  <span className={cn(
                                    "text-xs text-right",
                                    !email.isRead ? "text-gray-900 dark:text-foreground font-semibold" : "font-normal text-gray-500 dark:text-muted-foreground"
                                  )}>
                                    {formatEmailDate(email.date)}
                                  </span>
                                </div>
                              </div>
                              <div className={cn(
                                "text-sm mt-0.5 truncate",
                                !email.isRead ? "font-bold text-gray-900 dark:text-foreground" : "font-normal text-gray-500 dark:text-muted-foreground"
                              )}>
                                {email.subject}
                              </div>
                              <div className={cn(
                                "text-sm mt-0.5 line-clamp-1",
                                !email.isRead ? "text-gray-500 dark:text-muted-foreground" : "text-gray-500 dark:text-muted-foreground"
                              )}>
                                {email.preview}
                              </div>
                            </>
                          ) : (
                            <div className="flex items-center justify-between">
                              <div className={cn(
                                "text-sm flex-1",
                                !email.isRead ? "font-semibold text-gray-900 dark:text-foreground" : "font-normal text-gray-500 dark:text-muted-foreground"
                              )}>
                                {email.from === 'WeldMail Team' ? (
                                  <Popover open={hoveredWeldMailTeamList} onOpenChange={setHoveredWeldMailTeamList}>
                                    <PopoverTrigger asChild>
                                      <span 
                                        className="cursor-pointer hover:underline"
                                        onMouseEnter={() => {
                                          if (hoverTimeoutRefList.current) {
                                            clearTimeout(hoverTimeoutRefList.current);
                                          }
                                          setHoveredWeldMailTeamList(true);
                                        }}
                                        onMouseLeave={() => {
                                          hoverTimeoutRefList.current = setTimeout(() => {
                                            setHoveredWeldMailTeamList(false);
                                          }, 100);
                                        }}
                                      >
                                        {email.from}
                                      </span>
                                    </PopoverTrigger>
                                    <PopoverContent 
                                      className="w-80 p-0 overflow-hidden" 
                                      align="start" 
                                      sideOffset={8}
                                      onOpenAutoFocus={(e) => e.preventDefault()}
                                      onMouseEnter={() => {
                                        if (hoverTimeoutRefList.current) {
                                          clearTimeout(hoverTimeoutRefList.current);
                                        }
                                        setHoveredWeldMailTeamList(true);
                                      }}
                                      onMouseLeave={() => {
                                        hoverTimeoutRefList.current = setTimeout(() => {
                                          setHoveredWeldMailTeamList(false);
                                        }, 100);
                                      }}
                                    >
                                      <div>
                                        <div className="p-3">
                                          {/* Header with logo and name */}
                                        <div className="flex items-start gap-3">
                                          {/* Logo - matching email avatar style */}
                                          <div className="w-8 h-8 rounded-md bg-[#fbbf24] flex items-center justify-center flex-shrink-0">
                                            <span className="text-white font-semibold text-xs">W</span>
                                          </div>
                                          
                                          {/* Name and domain */}
                                          <div className="flex-1">
                                            <div className="font-semibold text-gray-900 dark:text-foreground text-sm leading-tight">WeldMail Team</div>
                                            <div className="text-xs text-gray-500 dark:text-muted-foreground">welcome@weldmail.com</div>
                                          </div>
                                        </div>
                                        
                                        {/* Connection/Status Label - Under the logo */}
                                        <div className="mt-1.5">
                                          <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-green-50 border border-green-200 rounded-md ml-0">
                                            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                                            <span className="text-xs font-medium text-green-700">{t.mail.inboxPage.senderVeryStrongConnection}</span>
                                          </div>
                                        </div>
                                        
                                        {/* Divider */}
                                        <Separator className="my-3" />
                                        
                                        {/* Important Details */}
                                        <div className="space-y-2.5">
                                          <div className="flex items-start gap-2">
                                            <Users className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                            <div className="flex-1">
                                              <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderTeam}</div>
                                              <div className="text-[13px] text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.senderSupportAndDevelopment}</div>
                                            </div>
                                          </div>
                                          
                                          <div className="flex items-start gap-2">
                                            <Globe className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                            <div className="flex-1">
                                              <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderWebsite}</div>
                                              <a href="#" className="text-[13px] text-blue-600 hover:underline">weldmail.com</a>
                                            </div>
                                          </div>
                                          
                                          <div className="flex items-start gap-2">
                                            <Mail className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                            <div className="flex-1">
                                              <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderResponseTime}</div>
                                              <div className="text-[13px] text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.senderUsuallyWithin24Hours}</div>
                                            </div>
                                          </div>
                                          
                                          <div className="flex items-start gap-2">
                                            <Shield className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                            <div className="flex-1">
                                              <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderSecurity}</div>
                                              <div className="text-[13px] text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.senderEndToEndEncrypted}</div>
                                            </div>
                                          </div>
                                        </div>
                                        </div>
                                        
                                        {/* Action Buttons */}
                                        <div className="border-t border-gray-200 dark:border-border pt-3 px-3 pb-3">
                                          <div className="flex flex-wrap gap-2">
                                          <Button variant="ghost"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              toast.success(t.mail.inboxPage.composingToWeldMailTeam);
                                            }}
                                            className="flex-1 min-w-[60px] px-2.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors flex items-center justify-center gap-1"
                                          >
                                            <Mail className="h-3.5 w-3.5" />
                                            {st('sweep.weldmail.quickActions.email')}
                                          </Button>
                                          <Button variant="ghost"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              toast.success(t.mail.inboxPage.openingNotes);
                                            }}
                                            className="flex-1 min-w-[60px] px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-foreground bg-gray-100 dark:bg-secondary hover:bg-gray-200 dark:hover:bg-accent rounded-md transition-colors flex items-center justify-center gap-1"
                                          >
                                            <StickyNote className="h-3.5 w-3.5" />
                                            {st('sweep.weldmail.quickActions.notes')}
                                          </Button>
                                          <Button variant="ghost"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              toast.success(t.mail.inboxPage.creatingTask);
                                            }}
                                            className="flex-1 min-w-[60px] px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-foreground bg-gray-100 dark:bg-secondary hover:bg-gray-200 dark:hover:bg-accent rounded-md transition-colors flex items-center justify-center gap-1"
                                          >
                                            <ListTodo className="h-3.5 w-3.5" />
                                            {st('sweep.weldmail.quickActions.tasks')}
                                          </Button>
                                          </div>
                                        </div>
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                ) : (
                                  email.from
                                )}
                              </div>
                              <span className={cn(
                                "text-xs flex-shrink-0 ml-2 text-right",
                                !email.isRead ? "text-gray-900 dark:text-foreground font-semibold" : "text-gray-400 dark:text-muted-foreground"
                              )}>
                                {formatEmailDate(email.date)}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                  {emailIndex < emails.length - 1 && (
                    <div className="border-b border-gray-100 dark:border-border ml-[60px] mr-4" />
                  )}
                </div>
                </div>
              ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Vertical Separator Line */}
      <div className="w-px bg-border h-full" />

      {/* Email Content or Compose - Spark Mail Style */}
      <div className="flex-1 flex h-full overflow-hidden">
          {/* Main Email View */}
          <div className={cn(
            "bg-white dark:bg-background flex flex-col h-full overflow-hidden",
            showAiPanel ? "flex-1" : "w-full"
          )}>
          {isComposing ? (
            /* Compose Header */
            <div className="pl-6 pr-6 pt-4 pb-2 flex-shrink-0">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-medium">
                  {st('sweep.weldmail.compose.newMessage')}
                </h2>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" 
                    onClick={() => {
                      setIsComposing(false);
                      setComposeData({ to: '', subject: '', body: '' });
                    }}
                    className="p-1.5 border border-gray-200 dark:border-border hover:bg-accent rounded-md transition-colors"
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button variant="ghost"
                    onClick={() => {
                      setIsComposeMinimized(true);
                    }}
                    className="p-1.5 border border-gray-200 dark:border-border hover:bg-accent rounded-md transition-colors"
                  >
                    <Minimize2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button variant="ghost"
                    onClick={handleSendEmail}
                    disabled={isSending}
                    className="px-3 py-1.5 bg-[#3451ff] text-white rounded-lg hover:bg-[#2945f0] transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    <span className="text-sm">{isSending ? 'Sending...' : 'Send'}</span>
                  </Button>
                </div>
              </div>
            </div>
          ) : selectedEmail ? (
            /* Email Header - Minimal Spark Mail Style */
            <div className="pl-6 pr-6 pt-[18px] pb-[18px] flex-shrink-0">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="inline-flex h-7 items-center rounded-md border border-input bg-background text-muted-foreground">
                    <Button variant="ghost"
                      onClick={() => {
                        // Mark as read and close
                        setMessages(prev => prev.map(msg =>
                          msg.id === selectedEmail.id ? { ...msg, isRead: true } : msg
                        ));
                        setSelectedEmail(null);
                        toast.success(t.mail.inboxPage.emailClosed);
                      }}
                      className="inline-flex items-center justify-center px-2 py-1 text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                    <div className="h-3.5 w-[1px] bg-border" />
                    <Button variant="ghost"
                      onClick={() => {
                        const wasCompleted = completedEmails.has(selectedEmail.id);

                        // Mark as done
                        setCompletedEmails(prev => {
                          const newSet = new Set(prev);
                          if (wasCompleted) {
                            newSet.delete(selectedEmail.id);
                            toast.success(t.mail.inboxPage.unmarkedAsDone);
                          } else {
                            newSet.add(selectedEmail.id);
                            toast.success(t.mail.inboxPage.markedAsDone);
                          }
                          return newSet;
                        });

                        // Go to next email in same section if marking as done
                        if (!wasCompleted) {
                          // Find current email's date section in the DISPLAYED grouped messages
                          const currentDateLabel = getDateLabel(selectedEmail.date);
                          const currentSection = groupedMessages[currentDateLabel];

                          if (currentSection) {
                            const currentIndexInSection = currentSection.findIndex(msg => msg.id === selectedEmail.id);

                            // Try to find next visible (non-completed) email in same section
                            let nextEmail = null;
                            for (let i = currentIndexInSection + 1; i < currentSection.length; i++) {
                              const email = currentSection[i];
                              if (showCompletedEmails || !completedEmails.has(email.id)) {
                                nextEmail = email;
                                break;
                              }
                            }

                            if (nextEmail) {
                              setSelectedEmail(nextEmail);
                            } else {
                              // No more visible emails in this section, close
                              setSelectedEmail(null);
                            }
                          } else {
                            setSelectedEmail(null);
                          }
                        }
                      }}
                      className={cn(
                        "inline-flex items-center justify-center px-2 py-1 text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none",
                        completedEmails.has(selectedEmail.id) && "text-green-600"
                      )}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <h2 className="text-lg font-semibold font-sans">
                    {selectedEmail.subject}
                  </h2>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost"
                    onClick={() => selectedEmail && handleToggleStar(selectedEmail.id)}
                    className="p-1.5 hover:bg-accent rounded-md transition-colors"
                    title={st('sweep.weldmail.toolbar.starEmail')}
                  >
                    <Star className={cn(
                      "h-4 w-4",
                      selectedEmail?.isStarred ? "text-yellow-500 fill-yellow-500" : "text-muted-foreground"
                    )} />
                  </Button>
                  <Button variant="ghost"
                    onClick={() => selectedEmail && handleArchive(selectedEmail.id)}
                    className="p-1.5 hover:bg-accent rounded-md transition-colors"
                    title={st('sweep.weldmail.toolbar.archive')}
                  >
                    <Archive className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button variant="ghost"
                    onClick={() => selectedEmail && handleDelete(selectedEmail.id)}
                    className="p-1.5 hover:bg-accent rounded-md transition-colors"
                    title={st('sweep.weldmail.toolbar.delete')}
                  >
                    <Trash className="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button variant="ghost"
                    onClick={() => selectedEmail && handlePin(selectedEmail.id)}
                    className="p-1.5 hover:bg-accent rounded-md transition-colors"
                    title={selectedEmail && pinnedEmails.has(selectedEmail.id) ? "Unpin email" : "Pin email"}
                  >
                    <Pin className={cn(
                      "h-4 w-4",
                      selectedEmail && pinnedEmails.has(selectedEmail.id) ? "text-blue-500 fill-blue-500" : "text-muted-foreground"
                    )} />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" className="p-1.5 hover:bg-accent rounded-md transition-colors" title={st('sweep.weldmail.toolbar.moveToFolder')}>
                        <Tag className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={() => {
                        toast.success(t.mail.inboxPage.movedToWorkFolder);
                      }}>
                        <div className="w-3 h-3 rounded-full bg-blue-500 mr-2" />
                        <span>{t.mail.inboxPage.folderWork}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => {
                        toast.success(t.mail.inboxPage.movedToPersonalFolder);
                      }}>
                        <div className="w-3 h-3 rounded-full bg-green-500 mr-2" />
                        <span>{t.mail.inboxPage.folderPersonal}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => {
                        toast.success(t.mail.inboxPage.movedToImportantFolder);
                      }}>
                        <div className="w-3 h-3 rounded-full bg-red-500 mr-2" />
                        <span>{t.mail.inboxPage.folderImportant}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => {
                        toast.success(t.mail.inboxPage.movedToFinanceFolder);
                      }}>
                        <div className="w-3 h-3 rounded-full bg-yellow-500 mr-2" />
                        <span>{t.mail.inboxPage.folderFinance}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => {
                        toast.success(t.mail.inboxPage.movedToProjectsFolder);
                      }}>
                        <div className="w-3 h-3 rounded-full bg-purple-500 mr-2" />
                        <span>{t.mail.inboxPage.folderProjects}</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" className="p-1.5 hover:bg-accent rounded-md transition-colors" title={st('sweep.weldmail.toolbar.snooze')}>
                        <Clock className={cn(
                          "h-4 w-4",
                          selectedEmail && snoozedEmails.has(selectedEmail.id) ? "text-purple-500" : "text-muted-foreground"
                        )} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem onClick={() => {
                        if (selectedEmail) handleSnooze(selectedEmail.id);
                        toast.success(t.mail.inboxPage.snoozedUntilLaterToday);
                      }}>
                        <Clock className="h-4 w-4 mr-0.5" />
                        {t.mail.inboxPage.snoozeLaterToday}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => {
                        if (selectedEmail) handleSnooze(selectedEmail.id);
                        toast.success(t.mail.inboxPage.snoozedUntilTomorrow);
                      }}>
                        <Clock className="h-4 w-4 mr-0.5" />
                        {t.mail.inboxPage.snoozeTomorrow}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => {
                        if (selectedEmail) handleSnooze(selectedEmail.id);
                        toast.success(t.mail.inboxPage.snoozedUntilThisWeekend);
                      }}>
                        <Clock className="h-4 w-4 mr-0.5" />
                        {t.mail.inboxPage.snoozeThisWeekend}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => {
                        if (selectedEmail) handleSnooze(selectedEmail.id);
                        toast.success(t.mail.inboxPage.snoozedUntilNextWeek);
                      }}>
                        <Clock className="h-4 w-4 mr-0.5" />
                        {t.mail.inboxPage.snoozeNextWeek}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => {
                        if (selectedEmail) handleSnooze(selectedEmail.id);
                        toast.success(t.mail.inboxPage.snoozedUntilNextMonth);
                      }}>
                        <Clock className="h-4 w-4 mr-0.5" />
                        {t.mail.inboxPage.snoozeNextMonth}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={(e) => e.preventDefault()}
                        onMouseEnter={handleSnoozeCalendarMouseEnter}
                        onMouseLeave={handleSnoozeCalendarMouseLeave}
                      >
                        <Popover modal={false} open={snoozeCalendarOpen} onOpenChange={setSnoozeCalendarOpen}>
                          <PopoverTrigger asChild>
                            <Button variant="ghost"
                              className="flex items-center w-full justify-between"
                              onMouseEnter={handleSnoozeCalendarMouseEnter}
                              onMouseLeave={handleSnoozeCalendarMouseLeave}
                            >
                              <div className="flex items-center">
                                <Calendar className="h-4 w-4 mr-0.5" />
                                {st('sweep.weldmail.snooze.customDate')}
                              </div>
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-auto p-0"
                            side="bottom"
                            align="end"
                            sideOffset={12}
                            alignOffset={-12}
                            onMouseEnter={handleSnoozeCalendarMouseEnter}
                            onMouseLeave={handleSnoozeCalendarMouseLeave}
                            onOpenAutoFocus={(e) => e.preventDefault()}
                          >
                            <CalendarComponent
                              mode="single"
                              selected={snoozeCustomDate}
                              captionLayout="dropdown"
                              onSelect={(date) => {
                                setSnoozeCustomDate(date);
                                if (date && selectedEmail) {
                                  handleSnooze(selectedEmail.id);
                                  toast.success(t.mail.inboxPage.snoozedUntilDate.replace('{date}', date.toLocaleDateString()));
                                }
                                setSnoozeCalendarOpen(false);
                              }}
                            />
                          </PopoverContent>
                        </Popover>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button variant="ghost"
                    onClick={() => {
                      toast.success(t.mail.inboxPage.markedAsSpam);
                    }}
                    className="p-1.5 hover:bg-accent rounded-md transition-colors"
                    title={st('sweep.weldmail.toolbar.markAsSpam')}
                  >
                    <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Email Thread or Compose Content */}
          <div className="flex-1 overflow-y-auto min-h-0 bg-white dark:bg-background px-6">
            {/* Email or Compose Card with Border */}
            {(isComposing || selectedEmail) && (
            <div className="bg-white dark:bg-background rounded-lg border border-gray-200 dark:border-border">
              {isComposing ? (
                /* Compose Interface */
                <div className="flex flex-col h-full">
                  {/* Subject Field */}
                  <div className="px-4 py-3 border-b border-gray-200 dark:border-border">
                    <input
                      type="text"
                      placeholder={st('sweep.weldmail.compose.subject')}
                      className="w-full text-sm font-medium outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground"
                      value={composeData.subject}
                      onChange={(e) => setComposeData(prev => ({ ...prev, subject: e.target.value }))}
                    />
                  </div>

                  {/* To Field */}
                  <div className="px-4 py-3 border-b border-gray-200 dark:border-border">
                    <div className="flex items-center justify-between gap-4">
                      <input
                        type="text"
                        placeholder={st('sweep.weldmail.compose.to')}
                        className="flex-1 text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground text-blue-600"
                        value={composeData.to}
                        onChange={(e) => setComposeData(prev => ({ ...prev, to: e.target.value }))}
                      />
                      {!showCcBcc && (
                        <Button variant="ghost"
                          onClick={() => setShowCcBcc(true)}
                          className="text-xs text-gray-500 dark:text-muted-foreground hover:text-gray-700 dark:hover:text-foreground transition-colors whitespace-nowrap"
                        >
                          {st('sweep.weldmail.compose.ccBcc')}
                        </Button>
                      )}
                    </div>
                    {showCcBcc && (
                      <div className="space-y-2 mt-2">
                        <div className="flex items-center justify-between gap-4">
                          <input
                            type="text"
                            placeholder={st('sweep.weldmail.compose.cc')}
                            className="flex-1 text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground text-blue-600"
                            value={ccRecipients}
                            onChange={(e) => setCcRecipients(e.target.value)}
                          />
                        </div>
                        <div className="flex items-center justify-between gap-4">
                          <input
                            type="text"
                            placeholder={st('sweep.weldmail.compose.bcc')}
                            className="flex-1 text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground text-blue-600"
                            value={bccRecipients}
                            onChange={(e) => setBccRecipients(e.target.value)}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Message Body */}
                  <div className="flex-1 px-4 py-4 min-h-[300px]">
                    {/* Attached Files */}
                    {attachedFiles.length > 0 && (
                      <div className="mb-3 p-2 bg-gray-50 dark:bg-secondary rounded-lg border border-gray-200 dark:border-border">
                        <div className="text-xs font-medium text-gray-600 dark:text-muted-foreground mb-2">{t.mail.inboxPage.attachmentsLabel}</div>
                        <div className="space-y-1">
                          {attachedFiles.map((file, index) => (
                            <div key={index} className="flex items-center justify-between p-1 hover:bg-gray-100 dark:hover:bg-accent rounded">
                              <div className="flex items-center gap-2">
                                <Paperclip className="h-3 w-3 text-gray-400 dark:text-muted-foreground" />
                                <span className="text-sm text-gray-700 dark:text-foreground">{file.name}</span>
                                <span className="text-xs text-gray-500 dark:text-muted-foreground">({(file.size / 1024).toFixed(1)} KB)</span>
                              </div>
                              <Button variant="ghost"
                                onClick={() => removeAttachment(index)}
                                className="p-1 hover:bg-gray-200 dark:hover:bg-accent rounded transition-colors"
                              >
                                <X className="h-3 w-3 text-gray-500 dark:text-muted-foreground" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Selected Tags */}
                    {selectedTags.length > 0 && (
                      <div className="mb-3 flex flex-wrap gap-1">
                        {selectedTags.map(tagId => {
                          const tag = availableTags.find(t => t.id === tagId);
                          if (!tag) return null;
                          return (
                            <span
                              key={tag.id}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium text-white"
                              style={{ backgroundColor: tag.color }}
                            >
                              {tag.name}
                              <Button variant="ghost"
                                onClick={() => toggleTag(tag.id)}
                                className="hover:opacity-75"
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                    
                    {/* Scheduled Time */}
                    {scheduledTime && (
                      <div className="mb-3 inline-flex items-center gap-2 px-3 py-1 bg-blue-50 text-blue-700 rounded-lg text-sm">
                        <Clock className="h-4 w-4" />
                        <span>{t.mail.inboxPage.scheduledFor.replace('{date}', format(scheduledTime, 'PPp'))}</span>
                        <Button variant="ghost"
                          onClick={() => setScheduledTime(null)}
                          className="ml-2 hover:bg-blue-100 dark:hover:bg-accent rounded p-0.5"
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                    
                    <textarea
                      placeholder={st('sweep.weldmail.compose.enterText')}
                      className="w-full h-full text-sm outline-none bg-transparent resize-none placeholder-gray-400 dark:placeholder-muted-foreground"
                      value={composeData.body}
                      onChange={(e) => setComposeData(prev => ({ ...prev, body: e.target.value }))}
                    />
                  </div>

                  {/* Compose Footer */}
                  <div className="px-6 py-3 border-t border-gray-200 dark:border-border">
                    {/* Hidden file input */}
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      onChange={handleFileAttachment}
                      className="hidden"
                    />
                    
                    {/* Bottom Actions */}
                    <div className="flex items-center justify-end">
                      <div className="flex items-center gap-3">
                        <Button variant="ghost" 
                          onClick={() => fileInputRef.current?.click()}
                          className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                          title={st('sweep.weldmail.compose.attachFiles')}
                        >
                          <Paperclip className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                        </Button>
                        
                        <Popover open={showTagsPopup} onOpenChange={setShowTagsPopup}>
                          <PopoverTrigger asChild>
                            <Button variant="ghost" 
                              className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                              title={st('sweep.weldmail.compose.addTags')}
                            >
                              <Tag className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-56 p-2" align="start">
                            <div className="text-xs font-medium text-gray-600 dark:text-muted-foreground mb-2">{t.mail.inboxPage.selectTags}</div>
                            <div className="space-y-1">
                              {availableTags.map(tag => (
                                <Button variant="ghost"
                                  key={tag.id}
                                  onClick={() => toggleTag(tag.id)}
                                  className="w-full flex items-center justify-between p-2 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors"
                                >
                                  <div className="flex items-center gap-2">
                                    <div 
                                      className="w-3 h-3 rounded-full" 
                                      style={{ backgroundColor: tag.color }}
                                    />
                                    <span className="text-sm">{tag.name}</span>
                                  </div>
                                  {selectedTags.includes(tag.id) && (
                                    <Check className="h-3 w-3 text-green-600" />
                                  )}
                                </Button>
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>
                        
                        <Popover open={showSchedulePopup} onOpenChange={setShowSchedulePopup}>
                          <PopoverTrigger asChild>
                            <Button variant="ghost" 
                              className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                              title={st('sweep.weldmail.compose.scheduleSend')}
                            >
                              <Clock className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-64 p-3" align="start">
                            <div className="text-sm font-medium mb-3">{t.mail.inboxPage.scheduleEmail}</div>
                            <div className="space-y-2">
                              <Button variant="ghost"
                                onClick={() => handleSchedule(new Date(Date.now() + 3600000))}
                                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                              >
                                {t.mail.inboxPage.scheduleIn1Hour}
                              </Button>
                              <Button variant="ghost"
                                onClick={() => handleSchedule(new Date(Date.now() + 14400000))}
                                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                              >
                                {t.mail.inboxPage.scheduleIn4Hours}
                              </Button>
                              <Button variant="ghost"
                                onClick={() => {
                                  const tomorrow = new Date();
                                  tomorrow.setDate(tomorrow.getDate() + 1);
                                  tomorrow.setHours(9, 0, 0, 0);
                                  handleSchedule(tomorrow);
                                }}
                                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                              >
                                {t.mail.inboxPage.scheduleTomorrow9AM}
                              </Button>
                              <Button variant="ghost"
                                onClick={() => {
                                  const nextWeek = new Date();
                                  nextWeek.setDate(nextWeek.getDate() + 7);
                                  nextWeek.setHours(9, 0, 0, 0);
                                  handleSchedule(nextWeek);
                                }}
                                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                              >
                                {t.mail.inboxPage.scheduleNextWeek}
                              </Button>
                            </div>
                          </PopoverContent>
                        </Popover>

                        <Button variant="ghost" 
                          onClick={() => {
                            const subject = composeData.subject;
                            setComposeData(prev => ({ 
                              ...prev, 
                              subject: subject.startsWith('Fwd: ') ? subject : `Fwd: ${subject}` 
                            }));
                            toast.success(t.mail.inboxPage.readyToForward);
                          }}
                          className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                          title={t.mail.inboxPage.forwardAction}
                        >
                          <Forward className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                        </Button>

                        <Button variant="ghost"
                          onClick={() => {
                            // Search for similar emails or contacts
                            toast.success(t.mail.inboxPage.searchingRelatedEmails);
                          }}
                          className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                          title={st('sweep.weldmail.compose.searchRelated')}
                        >
                          <Search className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : selectedEmail ? (
                /* Email Content */
                <>
              {/* Sender Header */}
              <div className="pl-[18px] pr-[18px] py-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center">
                    <div className="w-7 h-7 rounded-md bg-[#fbbf24] flex items-center justify-center text-white font-semibold text-xs">
                      {selectedEmail.from.charAt(0).toUpperCase()}
                    </div>
                    <div className="ml-1">
                      {!isEmailCollapsed && (
                        <div className="flex items-center">
                          {selectedEmail.from === 'WeldMail Team' ? (
                            <Popover open={hoveredWeldMailTeam} onOpenChange={setHoveredWeldMailTeam}>
                              <PopoverTrigger asChild>
                                <Button variant="ghost" 
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toast.success(t.mail.inboxPage.clickedOn.replace('{name}', String(selectedEmail.from)));
                                  }}
                                  onMouseEnter={() => {
                                    if (hoverTimeoutRef.current) {
                                      clearTimeout(hoverTimeoutRef.current);
                                    }
                                    setHoveredWeldMailTeam(true);
                                  }}
                                  onMouseLeave={() => {
                                    hoverTimeoutRef.current = setTimeout(() => {
                                      setHoveredWeldMailTeam(false);
                                    }, 100);
                                  }}
                                  className={cn(
                                    "font-semibold text-gray-900 dark:text-foreground text-sm px-2 py-1 rounded-md transition-colors focus:outline-none",
                                    hoveredWeldMailTeam ? "bg-gray-100 dark:bg-secondary" : "hover:bg-gray-100 dark:hover:bg-accent"
                                  )}
                                >
                                  {selectedEmail.from}
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent 
                                className="w-80 p-0" 
                                align="start" 
                                sideOffset={8}
                                onOpenAutoFocus={(e) => e.preventDefault()}
                                onMouseEnter={() => {
                                  if (hoverTimeoutRef.current) {
                                    clearTimeout(hoverTimeoutRef.current);
                                  }
                                  setHoveredWeldMailTeam(true);
                                }}
                                onMouseLeave={() => {
                                  hoverTimeoutRef.current = setTimeout(() => {
                                    setHoveredWeldMailTeam(false);
                                  }, 100);
                                }}
                              >
                                <div>
                                  <div className="p-3">
                                    {/* Header with logo and name */}
                                    <div className="flex items-start gap-3">
                                      {/* Logo - matching email avatar style */}
                                      <div className="w-8 h-8 rounded-md bg-[#fbbf24] flex items-center justify-center flex-shrink-0">
                                        <span className="text-white font-semibold text-xs">W</span>
                                      </div>
                                    
                                    {/* Name and domain */}
                                    <div className="flex-1">
                                      <div className="font-semibold text-gray-900 dark:text-foreground text-sm leading-tight">WeldMail Team</div>
                                      <div className="text-xs text-gray-500 dark:text-muted-foreground">welcome@weldmail.com</div>
                                    </div>
                                  </div>
                                  
                                  {/* Connection/Status Label - Under the logo */}
                                  <div className="mt-1.5">
                                    <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-green-50 border border-green-200 rounded-md ml-0">
                                      <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                                      <span className="text-xs font-medium text-green-700">{t.mail.inboxPage.senderVeryStrongConnection}</span>
                                    </div>
                                  </div>
                                  
                                  {/* Divider */}
                                  <Separator className="my-3" />
                                  
                                  {/* Important Details */}
                                  <div className="space-y-2.5">
                                    <div className="flex items-start gap-2">
                                      <Users className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                      <div className="flex-1">
                                        <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderTeam}</div>
                                        <div className="text-[13px] text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.senderSupportAndDevelopment}</div>
                                      </div>
                                    </div>
                                    
                                    <div className="flex items-start gap-2">
                                      <Globe className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                      <div className="flex-1">
                                        <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderWebsite}</div>
                                        <a href="#" className="text-[13px] text-blue-600 hover:underline">weldmail.com</a>
                                      </div>
                                    </div>
                                    
                                    <div className="flex items-start gap-2">
                                      <Mail className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                      <div className="flex-1">
                                        <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderResponseTime}</div>
                                        <div className="text-[13px] text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.senderUsuallyWithin24Hours}</div>
                                      </div>
                                    </div>
                                    
                                    <div className="flex items-start gap-2">
                                      <Shield className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                      <div className="flex-1">
                                        <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderSecurity}</div>
                                        <div className="text-[13px] text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.senderEndToEndEncrypted}</div>
                                      </div>
                                    </div>
                                  </div>
                                  
                                </div>
                                
                                {/* Action Buttons */}
                                <div className="border-t border-gray-200 dark:border-border pt-3 px-3 pb-3">
                                  <div className="flex flex-wrap gap-2">
                                    <Button variant="ghost"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toast.success(t.mail.inboxPage.composingToWeldMailTeam);
                                      }}
                                      className="flex-1 min-w-[60px] px-2.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors flex items-center justify-center gap-1"
                                    >
                                      <Mail className="h-3.5 w-3.5" />
                                      {st('sweep.weldmail.quickActions.email')}
                                    </Button>
                                    <Button variant="ghost"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toast.success(t.mail.inboxPage.openingNotes);
                                      }}
                                      className="flex-1 min-w-[60px] px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-foreground bg-gray-100 dark:bg-secondary hover:bg-gray-200 dark:hover:bg-accent rounded-md transition-colors flex items-center justify-center gap-1"
                                    >
                                      <StickyNote className="h-3.5 w-3.5" />
                                      {st('sweep.weldmail.quickActions.notes')}
                                    </Button>
                                    <Button variant="ghost"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toast.success(t.mail.inboxPage.creatingTask);
                                      }}
                                      className="flex-1 min-w-[60px] px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-foreground bg-gray-100 dark:bg-secondary hover:bg-gray-200 dark:hover:bg-accent rounded-md transition-colors flex items-center justify-center gap-1"
                                    >
                                      <ListTodo className="h-3.5 w-3.5" />
                                      {st('sweep.weldmail.quickActions.tasks')}
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </PopoverContent>
                            </Popover>
                          ) : (
                            <Button variant="ghost" 
                              onClick={(e) => {
                                e.stopPropagation();
                                toast.success(t.mail.inboxPage.clickedOn.replace('{name}', String(selectedEmail.from)));
                              }}
                              className="font-semibold text-gray-900 dark:text-foreground text-sm hover:bg-gray-100 dark:hover:bg-accent px-2 py-1 rounded-md transition-colors"
                            >
                              {selectedEmail.from}
                            </Button>
                          )}
                          <span className="text-[#007aff] text-sm ml-1">
                            to{' '}
                            {selectedEmail.to.map((recipient, index) => (
                              <span key={index}>
                                <Button variant="ghost"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toast.success(t.mail.inboxPage.clickedOn.replace('{name}', String(recipient)));
                                  }}
                                  className="hover:bg-gray-100 dark:hover:bg-accent px-1 py-0.5 rounded-md transition-colors"
                                >
                                  {recipient}
                                </Button>
                                {index < selectedEmail.to.length - 1 && ', '}
                              </span>
                            ))}
                            <Popover open={showAllRecipients} onOpenChange={setShowAllRecipients}>
                              <PopoverTrigger asChild>
                                <Button variant="ghost"
                                  onClick={(e) => e.stopPropagation()}
                                  className={cn(
                                    "px-1 py-0.5 rounded-md transition-colors",
                                    showAllRecipients ? "bg-gray-100 dark:bg-secondary" : "hover:bg-gray-100 dark:hover:bg-accent"
                                  )}
                                >
                                  +3
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-72 p-0" align="start" sideOffset={4}>
                                <div className="px-3 py-2 border-b border-border/50">
                                  <p className="text-xs font-medium text-muted-foreground">{t.mail.inboxPage.recipientsCount.replace('{count}', '4')}</p>
                                </div>
                                <div className="p-2 space-y-1">
                                  {[
                                    { email: 'user@example.com', name: 'User Example', color: '#3b82f6' },
                                    { email: 'john.doe@company.com', name: 'John Doe', color: '#10b981' },
                                    { email: 'jane.smith@org.com', name: 'Jane Smith', color: '#f59e0b' },
                                    { email: 'mike.wilson@mail.com', name: 'Mike Wilson', color: '#8b5cf6' }
                                  ].map((recipient, index) => (
                                    <Button variant="ghost"
                                      key={index}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toast.success(t.mail.inboxPage.clickedOn.replace('{name}', recipient.name));
                                        setShowAllRecipients(false);
                                      }}
                                      className="flex items-center gap-3 w-full text-left hover:bg-gray-100 dark:hover:bg-accent px-2 py-1.5 rounded-md transition-colors"
                                    >
                                      <Avatar className="h-7 w-7">
                                        <AvatarFallback 
                                          className="text-[11px] font-medium text-white"
                                          style={{ backgroundColor: recipient.color }}
                                        >
                                          {recipient.name.split(' ').map(n => n[0]).join('')}
                                        </AvatarFallback>
                                      </Avatar>
                                      <div className="flex-1 min-w-0">
                                        <div className="text-sm font-medium leading-none">{recipient.name}</div>
                                        <div className="text-xs text-muted-foreground mt-0.5">{recipient.email}</div>
                                      </div>
                                    </Button>
                                  ))}
                                </div>
                              </PopoverContent>
                            </Popover>
                          </span>
                        </div>
                      )}
                      {isEmailCollapsed && (
                        selectedEmail.from === 'WeldMail Team' ? (
                          <Popover open={hoveredWeldMailTeamCollapsed} onOpenChange={setHoveredWeldMailTeamCollapsed}>
                            <PopoverTrigger asChild>
                              <Button variant="ghost" 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toast.success(t.mail.inboxPage.clickedOn.replace('{name}', String(selectedEmail.from)));
                                }}
                                onMouseEnter={() => {
                                  if (hoverTimeoutRefCollapsed.current) {
                                    clearTimeout(hoverTimeoutRefCollapsed.current);
                                  }
                                  setHoveredWeldMailTeamCollapsed(true);
                                }}
                                onMouseLeave={() => {
                                  hoverTimeoutRefCollapsed.current = setTimeout(() => {
                                    setHoveredWeldMailTeamCollapsed(false);
                                  }, 100);
                                }}
                                className={cn(
                                  "font-semibold text-gray-900 dark:text-foreground text-sm px-2 py-1 rounded-md transition-colors focus:outline-none",
                                  hoveredWeldMailTeamCollapsed ? "bg-gray-100 dark:bg-secondary" : "hover:bg-gray-100 dark:hover:bg-accent"
                                )}
                              >
                                {selectedEmail.from}
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent 
                              className="w-80 p-0" 
                              align="start" 
                              sideOffset={8}
                              onOpenAutoFocus={(e) => e.preventDefault()}
                              onMouseEnter={() => {
                                if (hoverTimeoutRefCollapsed.current) {
                                  clearTimeout(hoverTimeoutRefCollapsed.current);
                                }
                                setHoveredWeldMailTeamCollapsed(true);
                              }}
                              onMouseLeave={() => {
                                hoverTimeoutRefCollapsed.current = setTimeout(() => {
                                  setHoveredWeldMailTeamCollapsed(false);
                                }, 100);
                              }}
                            >
                              <div>
                                <div className="p-3">
                                  {/* Header with logo and name */}
                                  <div className="flex items-start gap-3">
                                    {/* Logo - matching email avatar style */}
                                    <div className="w-8 h-8 rounded-md bg-[#fbbf24] flex items-center justify-center flex-shrink-0">
                                      <span className="text-white font-semibold text-xs">W</span>
                                    </div>
                                  
                                  {/* Name and domain */}
                                  <div className="flex-1">
                                    <div className="font-semibold text-gray-900 dark:text-foreground text-sm leading-tight">WeldMail Team</div>
                                    <div className="text-xs text-gray-500 dark:text-muted-foreground">welcome@weldmail.com</div>
                                  </div>
                                </div>
                                
                                {/* Connection/Status Label - Under the logo */}
                                <div className="mt-1.5">
                                  <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-green-50 border border-green-200 rounded-md ml-0">
                                    <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                                    <span className="text-xs font-medium text-green-700">{t.mail.inboxPage.senderVeryStrongConnection}</span>
                                  </div>
                                </div>
                                
                                {/* Divider */}
                                <Separator className="my-3" />
                                
                                {/* Important Details */}
                                <div className="space-y-2.5">
                                  <div className="flex items-start gap-2">
                                    <Users className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                    <div className="flex-1">
                                      <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderTeam}</div>
                                      <div className="text-[13px] text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.senderSupportAndDevelopment}</div>
                                    </div>
                                  </div>
                                  
                                  <div className="flex items-start gap-2">
                                    <Globe className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                    <div className="flex-1">
                                      <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderWebsite}</div>
                                      <a href="#" className="text-[13px] text-blue-600 hover:underline">weldmail.com</a>
                                    </div>
                                  </div>
                                  
                                  <div className="flex items-start gap-2">
                                    <Mail className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                    <div className="flex-1">
                                      <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderResponseTime}</div>
                                      <div className="text-[13px] text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.senderUsuallyWithin24Hours}</div>
                                    </div>
                                  </div>
                                  
                                  <div className="flex items-start gap-2">
                                    <Shield className="h-4 w-4 text-gray-400 dark:text-muted-foreground mt-0.5 flex-shrink-0" />
                                    <div className="flex-1">
                                      <div className="text-[13px] font-medium text-gray-700 dark:text-foreground">{t.mail.inboxPage.senderSecurity}</div>
                                      <div className="text-[13px] text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.senderEndToEndEncrypted}</div>
                                    </div>
                                  </div>
                                </div>
                                
                                {/* Action Buttons */}
                                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-200 dark:border-border">
                                  <Button variant="ghost"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toast.success(t.mail.inboxPage.composingToWeldMailTeam);
                                    }}
                                    className="flex-1 min-w-[60px] px-2.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors flex items-center justify-center gap-1"
                                  >
                                    <Mail className="h-3.5 w-3.5" />
                                    {st('sweep.weldmail.quickActions.email')}
                                  </Button>
                                  <Button variant="ghost"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toast.success(t.mail.inboxPage.openingNotes);
                                    }}
                                    className="flex-1 min-w-[60px] px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-foreground bg-gray-100 dark:bg-secondary hover:bg-gray-200 dark:hover:bg-accent rounded-md transition-colors flex items-center justify-center gap-1"
                                  >
                                    <StickyNote className="h-3.5 w-3.5" />
                                    {st('sweep.weldmail.quickActions.notes')}
                                  </Button>
                                  <Button variant="ghost"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toast.success(t.mail.inboxPage.creatingTask);
                                    }}
                                    className="flex-1 min-w-[60px] px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-foreground bg-gray-100 dark:bg-secondary hover:bg-gray-200 dark:hover:bg-accent rounded-md transition-colors flex items-center justify-center gap-1"
                                  >
                                    <ListTodo className="h-3.5 w-3.5" />
                                    {st('sweep.weldmail.quickActions.tasks')}
                                  </Button>
                                  </div>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        ) : (
                          <Button variant="ghost" 
                            onClick={(e) => {
                              e.stopPropagation();
                              toast.success(t.mail.inboxPage.clickedOn.replace('{name}', String(selectedEmail.from)));
                            }}
                            className="font-semibold text-gray-900 dark:text-foreground text-sm hover:bg-gray-100 dark:hover:bg-accent px-2 py-1 rounded-md transition-colors"
                          >
                            {selectedEmail.from}
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-gray-500 dark:text-muted-foreground">
                    <Button variant="ghost"
                      onClick={() => setIsEmailCollapsed(!isEmailCollapsed)}
                      className="text-sm hover:bg-gray-100 dark:hover:bg-accent px-2 py-1 rounded-md transition-colors cursor-pointer"
                    >
                      {format(new Date(selectedEmail.date), 'd MMM, HH:mm')}
                    </Button>
                    {!isEmailCollapsed && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" className="p-1 hover:bg-gray-100 dark:hover:bg-accent data-[state=open]:bg-gray-100 dark:data-[state=open]:bg-accent rounded-md transition-colors">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuItem onClick={() => {
                            toast.success(t.mail.inboxPage.markedAsUnread);
                          }}>
                            <Eye className="mr-0.5 h-4 w-4" />
                            <span>{t.mail.inboxPage.markAsUnread}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => {
                            toast.success(t.mail.inboxPage.addedStar);
                          }}>
                            <Star className="mr-0.5 h-4 w-4" />
                            <span>{t.mail.inboxPage.addStar}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => {
                            toast.success(t.mail.inboxPage.markedAsImportant);
                          }}>
                            <Flag className="mr-0.5 h-4 w-4" />
                            <span>{t.mail.inboxPage.markAsImportant}</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => {
                            navigator.clipboard.writeText(selectedEmail?.id || '');
                            toast.success(t.mail.inboxPage.messageIdCopied);
                          }}>
                            <Copy className="mr-0.5 h-4 w-4" />
                            <span>{t.mail.inboxPage.copyMessageId}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => {
                            toast.success(t.mail.inboxPage.openingInNewWindow);
                          }}>
                            <ExternalLink className="mr-0.5 h-4 w-4" />
                            <span>{t.mail.inboxPage.openInNewWindow}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => {
                            toast.success(t.mail.inboxPage.downloadingEmail);
                          }}>
                            <FileDown className="mr-0.5 h-4 w-4" />
                            <span>{t.mail.inboxPage.download}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => {
                            toast.success(t.mail.inboxPage.creatingFilter);
                          }}>
                            <Filter className="mr-0.5 h-4 w-4" />
                            <span>{t.mail.inboxPage.filterMessagesLikeThis}</span>
                          </DropdownMenuItem>
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger className="gap-2">
                              <Tag className="h-4 w-4 mr-0.5" />
                              {t.mail.inboxPage.moveToFolder}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuPortal>
                              <DropdownMenuSubContent side="left" sideOffset={5}>
                                <DropdownMenuItem onClick={() => {
                                  toast.success(t.mail.inboxPage.movedToWorkFolder);
                                }}>
                                  <div className="w-3 h-3 rounded-full bg-blue-500 mr-2" />
                                  <span>{t.mail.inboxPage.folderWork}</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => {
                                  toast.success(t.mail.inboxPage.movedToPersonalFolder);
                                }}>
                                  <div className="w-3 h-3 rounded-full bg-green-500 mr-2" />
                                  <span>{t.mail.inboxPage.folderPersonal}</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => {
                                  toast.success(t.mail.inboxPage.movedToImportantFolder);
                                }}>
                                  <div className="w-3 h-3 rounded-full bg-red-500 mr-2" />
                                  <span>{t.mail.inboxPage.folderImportant}</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => {
                                  toast.success(t.mail.inboxPage.movedToFinanceFolder);
                                }}>
                                  <div className="w-3 h-3 rounded-full bg-yellow-500 mr-2" />
                                  <span>{t.mail.inboxPage.folderFinance}</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => {
                                  toast.success(t.mail.inboxPage.movedToProjectsFolder);
                                }}>
                                  <div className="w-3 h-3 rounded-full bg-purple-500 mr-2" />
                                  <span>{t.mail.inboxPage.folderProjects}</span>
                                </DropdownMenuItem>
                              </DropdownMenuSubContent>
                            </DropdownMenuPortal>
                          </DropdownMenuSub>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => {
                            toast.success(t.mail.inboxPage.movedToArchive);
                          }}>
                            <Archive className="mr-0.5 h-4 w-4" />
                            <span>{t.mail.actions.archive}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => {
                            toast.success(t.mail.inboxPage.markedAsSpam);
                          }}>
                            <AlertTriangle className="mr-0.5 h-4 w-4" />
                            <span>{t.mail.actions.markAsSpam}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => {
                            toast.success(t.mail.inboxPage.movedToTrashSingle);
                          }} className="text-red-600">
                            <Trash className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
                            <span>{t.mail.actions.delete}</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>
              </div>

              {/* Email Content - Only show when not collapsed */}
              {!isEmailCollapsed && (
                <div className="pl-[18px] pr-[18px] pt-0 pb-4">
                <div className="text-gray-700 dark:text-foreground text-[14px] leading-[1.7]">
                  {isLoadingEmail ? (
                    <div className="flex items-center justify-center gap-2 py-8">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      <span className="text-sm text-muted-foreground">{t.mail.inboxPage.loadingEmailContent}</span>
                    </div>
                  ) : selectedEmail.bodyHtml ? (
                    // SECURITY: email HTML is attacker-controlled and stored
                    // unsanitized. Render it through the sandboxed iframe (no
                    // allow-scripts) — NEVER via dangerouslySetInnerHTML, which
                    // executes inline event handlers (onerror/onload) in the app
                    // origin with the user's session. Matches message-detail.tsx.
                    <IsolatedHtmlContent html={selectedEmail.bodyHtml} />
                  ) : selectedEmail.bodyText ? (
                    <div className="whitespace-pre-wrap">
                      {selectedEmail.bodyText}
                    </div>
                  ) : (
                    <div className="text-gray-400 dark:text-muted-foreground italic">{t.mail.inboxPage.noContent}</div>
                  )}
                </div>

                {/* Attachments */}
                {selectedEmail.hasAttachments && (
                  <div className="mt-6 p-3 bg-gray-50 dark:bg-secondary rounded-lg border border-gray-200 dark:border-border">
                    <div className="flex items-center gap-3">
                      <Paperclip className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                      <span className="text-sm text-gray-700 dark:text-foreground">document.pdf</span>
                      <span className="text-sm text-gray-500 dark:text-muted-foreground">2.4 MB</span>
                    </div>
                  </div>
                )}
                
                {/* Reply and Forward Buttons */}
                <div className="flex items-center justify-end gap-2 mt-6">
                  <Button variant="ghost" 
                    onClick={() => {
                      setIsReplying(!isReplying);
                      if (!isReplying && selectedEmail) {
                        setComposeData({
                          to: selectedEmail.fromEmail || selectedEmail.from,
                          subject: `Re: ${selectedEmail.subject}`,
                          body: ''
                        });
                      }
                    }}
                    className="px-3 py-1.5 border border-gray-200 dark:border-border text-gray-600 dark:text-muted-foreground rounded-lg hover:bg-gray-50 dark:hover:bg-accent transition-colors flex items-center gap-2"
                    title={t.mail.inboxPage.replyAction}
                  >
                    <Reply className="h-4 w-4" />
                    <span className="text-sm">{t.mail.inboxPage.replyAction}</span>
                  </Button>
                  <Button variant="ghost" className="px-3 py-1.5 border border-gray-200 dark:border-border text-gray-600 dark:text-muted-foreground rounded-lg hover:bg-gray-50 dark:hover:bg-accent transition-colors flex items-center gap-2" title={t.mail.inboxPage.forwardAction}>
                    <Forward className="h-4 w-4" />
                    <span className="text-sm">{t.mail.inboxPage.forwardAction}</span>
                  </Button>
                </div>
              </div>
              )}
                </>
              ) : null}
            </div>
            )}

            {/* Empty State - No Email Selected - Positioned lower on page */}
            {!isComposing && !selectedEmail && (
              <div className="flex-1 flex justify-center p-8 pt-96">
                <div className="max-w-4xl w-full">
                  {/* Icon and Message */}
                  <Card className="mb-8 !rounded-sm border-0 shadow-none">
                    <CardContent className="p-6">
                      <div className="flex flex-col items-center text-center gap-4">
                        <div className="w-16 h-16 relative flex-shrink-0">
                          <div className="absolute inset-0 rounded-lg border-2 border-dashed border-primary/30 bg-primary/5"></div>
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Mail className="h-8 w-8 text-muted-foreground" />
                          </div>
                        </div>
                        <div>
                          <CardTitle className="text-base mb-1">In the past 24 hours you missed {filteredMessages.filter(e => !e.isRead).length} messages</CardTitle>
                          <CardDescription className="text-sm">{t.mail.inboxPage.selectConversationToRead}</CardDescription>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* CTA Buttons */}
                  <div className="flex justify-center">
                    <div className="grid gap-3 md:grid-cols-2 max-w-2xl w-full">
                      {/* Unread Messages */}
                      <div className="group relative overflow-hidden rounded-lg border bg-card p-3 transition-all hover:bg-accent/50">
                        <div className="flex items-center gap-3">
                          <div className="rounded-md bg-muted p-1.5 flex-shrink-0">
                            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium leading-tight">{filteredMessages.filter(e => !e.isRead).length} ongelezen berichten</p>
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                        </div>
                      </div>

                      {/* Starred Messages */}
                      <div className="group relative overflow-hidden rounded-lg border bg-card p-3 transition-all hover:bg-accent/50">
                        <div className="flex items-center gap-3">
                          <div className="rounded-md bg-muted p-1.5 flex-shrink-0">
                            <Star className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium leading-tight">{filteredMessages.filter(e => e.isStarred).length} met ster gemarkeerd</p>
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Reply Compose Interface - Separate Card */}
            {isReplying && selectedEmail && (
              <div className="bg-white dark:bg-background rounded-lg border border-gray-200 dark:border-border mt-4">
                {/* To Field */}
                <div className="pl-[18px] pr-[18px] py-2 border-b border-gray-200 dark:border-border flex items-center gap-2">
                  <Button variant="ghost"
                    onClick={() => {
                      toast.success(t.mail.inboxPage.replyCollapsed);
                    }}
                    className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors flex-shrink-0"
                    title={st('sweep.weldmail.compose.collapseReply')}
                  >
                    <CornerDownRight className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                  </Button>
                  <input
                    type="text"
                    placeholder={st('sweep.weldmail.compose.to')}
                    className="flex-1 text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground"
                    value={composeData.to}
                    onChange={(e) => setComposeData(prev => ({ ...prev, to: e.target.value }))}
                  />
                  <Button variant="ghost"
                    onClick={() => {
                      setPopupComposeData({
                        to: composeData.to,
                        subject: composeData.subject,
                        body: composeData.body
                      });
                      setShowPopupReply(true);
                      setIsPopupMinimized(false);
                    }}
                    className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors flex-shrink-0"
                    title={st('sweep.weldmail.compose.popOutReply')}
                  >
                    <PictureInPicture2 className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                  </Button>
                </div>

                {/* Message Body */}
                <div className="pl-[18px] pr-[18px] py-4">
                  <textarea
                    placeholder={st('sweep.weldmail.compose.typeYourReply')}
                    className="w-full h-32 text-sm outline-none bg-transparent resize-none placeholder-gray-400 dark:placeholder-muted-foreground"
                    value={composeData.body}
                    onChange={(e) => setComposeData(prev => ({ ...prev, body: e.target.value }))}
                    autoFocus
                  />
                </div>

                {/* Reply Footer */}
                <div className="pl-[18px] pr-[18px] py-3 border-t border-gray-200 dark:border-border flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Button variant="ghost"
                      className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors"
                      title={st('sweep.weldmail.compose.attachFiles')}
                      onClick={() => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.multiple = true;
                        input.onchange = (e: Event) => {
                          const files = Array.from((e.target as HTMLInputElement).files ?? []);
                          toast.success(t.mail.inboxPage.filesAttached.replace('{n}', String(files.length)));
                        };
                        input.click();
                      }}
                    >
                      <Paperclip className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>
                    <Button variant="ghost"
                      className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors"
                      title={st('sweep.weldmail.compose.insertLink')}
                      onClick={() => {
                        const url = prompt('Enter link URL:');
                        if (url) {
                          toast.success(t.mail.inboxPage.linkInserted);
                        }
                      }}
                    >
                      <Link className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>
                    <Button variant="ghost"
                      className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors"
                      title={st('sweep.weldmail.compose.insertEmoji')}
                      onClick={() => toast.success(t.mail.inboxPage.emojiPickerComingSoon)}
                    >
                      <Smile className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>
                    <Button variant="ghost"
                      className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors"
                      title={st('sweep.weldmail.compose.insertFilesFromDrive')}
                      onClick={() => toast.success(t.mail.inboxPage.driveIntegrationComingSoon)}
                    >
                      <HardDrive className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>
                    <Button variant="ghost"
                      className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors"
                      title={st('sweep.weldmail.compose.insertPhoto')}
                      onClick={() => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = 'image/*';
                        input.multiple = true;
                        input.onchange = (e: Event) => {
                          const files = Array.from((e.target as HTMLInputElement).files ?? []);
                          toast.success(t.mail.inboxPage.imagesAttached.replace('{n}', String(files.length)));
                        };
                        input.click();
                      }}
                    >
                      <Image className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>
                    <Button variant="ghost"
                      className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors"
                      title={st('sweep.weldmail.compose.setReminder')}
                      onClick={() => toast.success(t.mail.inboxPage.reminderSet)}
                    >
                      <Bell className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>
                    <Button variant="ghost"
                      className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors"
                      title={st('sweep.weldmail.compose.insertTemplate')}
                      onClick={() => toast.success(t.mail.inboxPage.templatePickerComingSoon)}
                    >
                      <FileText className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>
                    <Button variant="ghost"
                      className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors"
                      title={st('sweep.weldmail.compose.moreOptions')}
                      onClick={() => toast.success(t.mail.inboxPage.moreOptionsComingSoon)}
                    >
                      <MoreVertical className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost"
                      className="p-2 hover:bg-gray-100 dark:hover:bg-accent rounded-lg transition-colors"
                      title={t.mail.messageDetail.deleteDraft}
                      onClick={() => {
                        setIsReplying(false);
                        setComposeData({ to: '', subject: '', body: '' });
                        toast.success(t.mail.inboxPage.draftDiscarded);
                      }}
                    >
                      <Trash className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>
                    <ButtonGroup>
                      <Button variant="outline" className="!h-[34px] !rounded-lg !bg-[#3451ff] !text-white hover:!bg-[#2945f0] !border-[#3451ff]" onClick={async () => {
                        if (!composeData.body.trim()) {
                          toast.error(t.mail.inboxPage.pleaseEnterMessage);
                          return;
                        }
                        try {
                          const result = await mailApi.messages.send(activeAccount.id, {
                            to: [selectedEmail?.from || ''],
                            subject: composeData.subject || `Re: ${selectedEmail?.subject || ''}`,
                            body: composeData.body.trim(),
                            htmlBody: composeData.body.trim().replace(/\n/g, '<br>'),
                          });
                          if (result.success) {
                            toast.success(t.mail.inboxPage.replySentSuccessfully);
                            setIsReplying(false);
                            setComposeData({ to: '', subject: '', body: '' });
                          } else {
                            toast.error(result.error || t.mail.inboxPage.failedToSendReply);
                          }
                        } catch (error) {
                          console.error('Failed to send reply:', error);
                          toast.error(t.mail.inboxPage.failedToSendReply);
                        }
                      }}>{t.mail.compose.send}</Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" className="!pl-[10px] !w-[34px] !h-[34px] !rounded-lg !bg-[#3451ff] !text-white hover:!bg-[#2945f0] !border-[#3451ff]">
                          <ChevronDown />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="[--radius:1rem]">
                        <DropdownMenuGroup>
                          <DropdownMenuItem>
                            <Clock />
                            {st('sweep.weldmail.compose.scheduleSendAction')}
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <Archive />
                            {st('sweep.weldmail.compose.sendAndArchive')}
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <Check />
                            {st('sweep.weldmail.compose.saveDraft')}
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                          <DropdownMenuItem variant="destructive">
                            <Trash />
                            {st('sweep.weldmail.compose.discardDraft')}
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ButtonGroup>
                  </div>
                </div>
              </div>
            )}
          </div>

          </div>

          {AI_PANEL_ENABLED && showAiPanel && (
            <>
              {/* Overlay for fullscreen mode */}
              <div 
                className={cn(
                  "fixed inset-0 z-40",
                  isAiPanelFullscreen ? "bg-black/50 pointer-events-auto animate-fade-in" : "bg-transparent pointer-events-none"
                )} 
                onClick={() => isAiPanelFullscreen && setIsAiPanelFullscreen(false)} 
              />
              
              <div 
                className={cn(
                  "backdrop-blur-sm border-l border-gray-200/50 dark:border-border/50 flex",
                  isAiPanelFullscreen 
                    ? "fixed inset-x-0 top-4 bottom-0 z-50 w-full bg-white dark:bg-[#141415] rounded-t-lg overflow-hidden animate-scale-in" 
                    : "w-[420px] h-full bg-gray-50/50 dark:bg-[#141415]/50 flex-col overflow-hidden"
                )}
              >
                {/* Sidebar for fullscreen mode */}
                {isAiPanelFullscreen && (
                  <div className="w-80 bg-gray-50 dark:bg-background border-r border-gray-200 dark:border-border flex flex-col rounded-tl-lg overflow-hidden">
                    {/* Sidebar Header */}
                    <div className="p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h2 className="text-sm font-medium text-gray-900 dark:text-foreground">{t.mail.inboxPage.conversations}</h2>
                        <Button variant="ghost"
                          onClick={() => {
                            setChatHistory(prev => [...prev, { 
                              id: Date.now().toString(), 
                              title: st('sweep.weldmail.chat.newChat'), 
                              timestamp: new Date() 
                            }]);
                            setAiMessages([{ role: 'assistant', content: st('sweep.weldmail.aiPanel.greeting') }]);
                            setAiInput('');
                          }}
                          className="p-1 hover:bg-gray-200 dark:hover:bg-accent rounded-lg transition-colors"
                          title={st('sweep.weldmail.chat.newChat')}
                        >
                          <PenSquare className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                        </Button>
                      </div>
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-muted-foreground" />
                        <input
                          type="text"
                          placeholder={st('sweep.weldmail.search.placeholder')}
                          className="w-full pl-9 pr-3 py-2 bg-white dark:bg-secondary border border-gray-200 dark:border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-600"
                        />
                      </div>
                    </div>
                    
                    {/* Chat History */}
                    <div className="flex-1 overflow-y-auto p-3 space-y-1">
                      <div className="text-xs font-medium text-gray-500 dark:text-muted-foreground px-2 py-1">{t.mail.inboxPage.today}</div>
                      {chatHistory.slice(0, 3).map(chat => (
                        <Button variant="ghost"
                          key={chat.id}
                          onClick={() => setCurrentChatId(chat.id)}
                          className={cn(
                            "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors",
                            currentChatId === chat.id
                              ? "bg-white dark:bg-secondary text-gray-900 dark:text-white"
                              : "text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary/70"
                          )}
                        >
                          <div className="truncate">{chat.title}</div>
                        </Button>
                      ))}
                      
                      <div className="text-xs font-medium text-gray-500 dark:text-muted-foreground px-2 py-1 mt-3">{t.mail.inboxPage.yesterday}</div>
                      {chatHistory.slice(3, 6).map(chat => (
                        <Button variant="ghost"
                          key={chat.id}
                          onClick={() => setCurrentChatId(chat.id)}
                          className={cn(
                            "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors",
                            currentChatId === chat.id
                              ? "bg-white dark:bg-secondary text-gray-900 dark:text-white"
                              : "text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary/70"
                          )}
                        >
                          <div className="truncate">{chat.title}</div>
                        </Button>
                      ))}
                    </div>
                    
                    {/* Sidebar Footer */}
                    <div className="p-3 border-t border-gray-200 dark:border-border space-y-1">
                      <Button variant="ghost" className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-colors">
                        <Library className="h-4 w-4" />
                        <span>{t.mail.inboxPage.library}</span>
                      </Button>
                      <Button variant="ghost" className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-colors">
                        <FileText className="h-4 w-4" />
                        <span>{t.mail.inboxPage.templates}</span>
                      </Button>
                    </div>
                  </div>
                )}
                
                {/* Main Content Area */}
                <div className="flex-1 flex flex-col overflow-hidden">
                  {/* AI Header */}
                  <div className={cn(
                    "px-4 py-3 bg-white dark:bg-background/80 dark:bg-[#141415]/80 backdrop-blur-sm flex-shrink-0",
                    isAiPanelFullscreen && "rounded-tr-lg"
                  )}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-medium text-gray-900 dark:text-foreground pl-1 pt-1 inline-block">WeldAgent</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost"
                          onClick={() => {
                            setAiMessages([{ role: 'assistant', content: st('sweep.weldmail.aiPanel.greeting') }]);
                            setAiInput('');
                          }}
                          className="p-1 hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-colors"
                          title={st('sweep.weldmail.chat.newChat')}
                        >
                          <PenSquare className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                        </Button>
                        <Button variant="ghost"
                          onClick={() => setIsAiPanelFullscreen(!isAiPanelFullscreen)}
                          className="p-1 hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-colors"
                          title={isAiPanelFullscreen ? "Exit fullscreen" : "Expand to fullscreen"}
                        >
                          <Expand className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                        </Button>
                        <Button variant="ghost"
                          onClick={() => {
                            setShowAiPanel(false);
                            setIsAiPanelFullscreen(false);
                          }}
                          className="p-1 hover:bg-gray-100 dark:hover:bg-secondary rounded-lg transition-colors"
                        >
                          <X className="h-5 w-5 text-gray-500 dark:text-muted-foreground" />
                        </Button>
                      </div>
                    </div>
                  </div>

              {/* Chat Messages */}
              <div className="flex-1 overflow-y-auto bg-white dark:bg-background [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-gray-300 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb:hover]:bg-gray-400 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700 dark:[&::-webkit-scrollbar-thumb:hover]:bg-gray-600">
                <div className={cn(
                  "px-4 py-6 space-y-6 mx-auto",
                  isAiPanelFullscreen && "max-w-3xl"
                )}>
                  {aiMessages.map((message, index) => (
                    <div
                      key={index}
                      className={cn(
                        "flex gap-3",
                        message.role === 'user' ? "justify-end" : "justify-start"
                      )}
                    >
                      {message.role === 'assistant' ? (
                        <div className="max-w-[85%] text-[15px] text-gray-800 dark:text-foreground">
                          <p className="leading-relaxed whitespace-pre-wrap">{message.content}</p>
                        </div>
                      ) : (
                        <div className="max-w-[85%] rounded-tl-2xl rounded-tr-2xl rounded-bl-2xl rounded-br-md px-4 py-2.5 text-[15px] bg-gray-50 dark:bg-background text-gray-800 dark:text-foreground ml-auto">
                          <p className="leading-relaxed whitespace-pre-wrap">{message.content}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Input Area - ChatGPT Style */}
              <div className="bg-white dark:bg-background flex-shrink-0">
                <div className={cn(
                  "mx-auto p-4",
                  isAiPanelFullscreen && "max-w-3xl"
                )}>
                  <div className={cn(
                    "relative bg-white dark:bg-secondary/50 border border-gray-200 dark:border-border",
                    isAiPanelFullscreen ? "rounded-2xl" : "rounded-lg"
                  )}>
                    {/* Selected Text Context */}
                    {selectedText && aiInput.includes(selectedText) && (
                      <div className="px-3 py-2 bg-gray-50 dark:bg-secondary border-b border-gray-200 dark:border-border rounded-t-lg">
                        <div className="flex items-start gap-2">
                          <div className="flex-1">
                            <div className="text-xs font-medium text-gray-500 dark:text-muted-foreground mb-1">{t.mail.inboxPage.selectedText}</div>
                            <div className="text-sm text-gray-700 dark:text-muted-foreground italic line-clamp-3">&ldquo;{selectedText}&rdquo;</div>
                          </div>
                          <Button variant="ghost"
                            onClick={() => {
                              setSelectedText('');
                              setAiInput(aiInput.replace(selectedText, ''));
                            }}
                            className="p-1 hover:bg-gray-200 dark:hover:bg-accent rounded transition-colors"
                          >
                            <X className="h-3 w-3 text-gray-500 dark:text-muted-foreground" />
                          </Button>
                        </div>
                      </div>
                    )}
                    
                    <div className={cn(
                      "flex flex-col gap-2",
                      isAiPanelFullscreen ? "p-3" : "p-2"
                    )}>
                      {/* Input Field at the top */}
                      <div className="w-full">
                        <textarea
                          ref={aiInputRef}
                          value={aiInput}
                          onChange={(e) => setAiInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              handleAiSend();
                            }
                          }}
                          onInput={(e) => {
                            const target = e.target as HTMLTextAreaElement;
                            target.style.height = "40px";
                            target.style.height = `${target.scrollHeight}px`;
                          }}
                          placeholder={st('sweep.weldmail.aiPanel.typeAMessage')}
                          disabled={false}
                          className={cn(
                            "w-full resize-none bg-transparent text-base focus:outline-none disabled:opacity-50 placeholder:text-gray-500 dark:placeholder:text-gray-400 dark:placeholder:text-muted-foreground",
                            isAiPanelFullscreen ? "px-3 py-2" : "px-2 py-1"
                          )}
                          rows={1}
                          style={{ minHeight: "40px", maxHeight: "200px" }}
                        />
                      </div>
                      
                      {/* Controls row below */}
                      <div className="flex items-center gap-2">
                        {/* Plus Button */}
                        <Button variant="ghost" className="flex-shrink-0 p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-accent transition-colors">
                          <Plus className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                        </Button>

                        {/* Sources Button */}
                        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
                          <DropdownMenuTrigger asChild>
                            <Button 
                              variant="ghost" 
                              size="sm"
                              className="h-8 px-3 py-1 text-sm font-medium text-gray-700 dark:text-muted-foreground hover:bg-gray-200 dark:hover:bg-accent flex items-center gap-1"
                            >
                              <LayoutGrid className="h-4 w-4" />
                              <span>{t.mail.inboxPage.sources}</span>
                              <ChevronDown className="h-3 w-3" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="start"
                            className="w-72 p-1 bg-white dark:bg-secondary shadow-xl rounded-xl border border-gray-200 dark:border-border"
                          >
                            {/* Search on internet with toggle */}
                            <div className="flex items-center justify-between px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-accent/50 rounded-lg mx-1">
                              <div className="flex items-center gap-3">
                                <Globe className="h-4 w-4 text-gray-700 dark:text-muted-foreground" />
                                <span className="text-sm font-medium text-gray-900 dark:text-foreground">{t.mail.inboxPage.searchOnTheWeb}</span>
                              </div>
                              <Switch defaultChecked />
                            </div>

                            {/* Mail */}
                            <div className="flex items-center justify-between px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-accent/50 rounded-lg mx-1">
                              <div className="flex items-center gap-3">
                                <Mail className="h-4 w-4 text-gray-700 dark:text-muted-foreground" />
                                <span className="text-sm font-medium text-gray-900 dark:text-foreground">{t.mail.inbox.allMail}</span>
                              </div>
                              <Switch defaultChecked />
                            </div>

                            {/* Divider */}
                            <div className="my-1.5 mx-2 border-t border-gray-100 dark:border-border" />

                            {/* Manage preferences */}
                            <div
                              onClick={() => {
                                setDropdownOpen(false);
                                setShowPreferencesModal(true);
                              }}
                              className="flex items-center gap-3 px-3 py-2.5 mx-1 cursor-pointer hover:bg-gray-50 dark:hover:bg-accent/50 rounded-lg"
                            >
                              <Settings className="h-4 w-4 text-gray-700 dark:text-muted-foreground" />
                              <span className="text-sm font-medium text-gray-900 dark:text-foreground">{t.mail.inboxPage.managePreferences}</span>
                            </div>
                          </DropdownMenuContent>
                        </DropdownMenu>

                        {/* Spacer */}
                        <div className="flex-1" />

                        {/* Right Side Controls */}
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {/* Globe Dropdown */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 hover:bg-gray-200 dark:hover:bg-accent"
                              >
                                <Globe className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem>{t.mail.inboxPage.allSources}</DropdownMenuItem>
                              <DropdownMenuItem>{t.mail.inboxPage.webOnly}</DropdownMenuItem>
                              <DropdownMenuItem>{t.mail.inboxPage.databaseOnly}</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>

                          {/* Mic Button */}
                          <Button variant="ghost" className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-accent transition-colors">
                            <Mic className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
                          </Button>
                          
                          {/* Send Button */}
                          <Button variant="ghost" 
                            onClick={handleAiSend}
                            disabled={!aiInput.trim()}
                            className={`p-2 rounded-lg transition-all ${
                              aiInput.trim() 
                                ? "bg-primary hover:bg-primary/90"
                                : "bg-gray-100 dark:bg-secondary cursor-not-allowed"
                            }`}
                          >
                            <Send className={`h-4 w-4 ${
                              aiInput.trim()
                                ? "text-primary-foreground"
                                : "text-gray-400 dark:text-muted-foreground"
                            }`} />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                </div>
              </div>
              </div>{/* End of Main Content Area */}
            </div>
            </>
          )}
        </div>
      </div>

      {/* Minimized Compose - Bottom Right */}
      {isComposing && isComposeMinimized && (
        <div className="fixed bottom-4 w-[700px] h-[500px] bg-white dark:bg-background rounded-lg shadow-xl border border-gray-200 dark:border-border flex flex-col" style={{ right: agentRight }}>
          {/* Compose Header - Same as full size */}
          <div className="pl-2 pr-6 pt-4 pb-2 flex-shrink-0">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-medium">
                {st('sweep.weldmail.compose.newMessage')}
              </h2>
              <div className="flex items-center gap-2">
                <Button variant="ghost" 
                  onClick={() => {
                    setIsComposing(false);
                    setComposeData({ to: '', subject: '', body: '' });
                  }}
                  className="p-1.5 border border-gray-200 dark:border-border hover:bg-accent rounded-md transition-colors"
                >
                  <X className="h-4 w-4 text-muted-foreground" />
                </Button>
                <Button variant="ghost" 
                  onClick={() => {
                    setIsComposeMinimized(false);
                  }}
                  className="p-1.5 border border-gray-200 dark:border-border hover:bg-accent rounded-md transition-colors"
                >
                  <Maximize2 className="h-4 w-4 text-muted-foreground" />
                </Button>
                <Button variant="ghost"
                  onClick={handleSendEmail}
                  disabled={isSending}
                  className="px-3 py-1.5 bg-[#3451ff] text-white rounded-lg hover:bg-[#2945f0] transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  <span className="text-sm">{isSending ? 'Sending...' : 'Send'}</span>
                </Button>
              </div>
            </div>
          </div>

          {/* Email Content Area */}
          <div className="flex-1 overflow-y-auto min-h-0 bg-white dark:bg-background pt-3">
            <div className="bg-white dark:bg-background rounded-lg border border-gray-200 dark:border-border ml-2 mr-6">
              {/* Subject Field */}
              <div className="px-4 py-3 border-b border-gray-200 dark:border-border">
                <input
                  type="text"
                  placeholder={st('sweep.weldmail.compose.subject')}
                  className="w-full text-sm font-medium outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground"
                  value={composeData.subject}
                  onChange={(e) => setComposeData(prev => ({ ...prev, subject: e.target.value }))}
                />
              </div>

              {/* To Field */}
              <div className="px-4 py-3 border-b border-gray-200 dark:border-border">
                <div className="space-y-2">
                  <input
                    type="text"
                    placeholder={st('sweep.weldmail.compose.to')}
                    className="w-full text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground"
                    value={composeData.to}
                    onChange={(e) => setComposeData(prev => ({ ...prev, to: e.target.value }))}
                  />
                  {showCcBcc && (
                    <>
                      <input
                        type="text"
                        placeholder={st('sweep.weldmail.compose.cc')}
                        className="w-full text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground"
                        value={ccRecipients}
                        onChange={(e) => setCcRecipients(e.target.value)}
                      />
                      <input
                        type="text"
                        placeholder={st('sweep.weldmail.compose.bcc')}
                        className="w-full text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground"
                        value={bccRecipients}
                        onChange={(e) => setBccRecipients(e.target.value)}
                      />
                    </>
                  )}
                  {!showCcBcc && (
                    <Button variant="ghost"
                      onClick={() => setShowCcBcc(true)}
                      className="text-xs text-gray-500 dark:text-muted-foreground hover:text-gray-700 dark:hover:text-foreground transition-colors"
                    >
                      {st('sweep.weldmail.compose.addCcBcc')}
                    </Button>
                  )}
                </div>
              </div>

              {/* Message Body */}
              <div className="px-4 py-4 min-h-[200px]">
                {/* Attached Files */}
                {attachedFiles.length > 0 && (
                  <div className="mb-3 p-2 bg-gray-50 dark:bg-secondary rounded-lg border border-gray-200 dark:border-border">
                    <div className="text-xs font-medium text-gray-600 dark:text-muted-foreground mb-2">{t.mail.inboxPage.attachmentsLabel}</div>
                    <div className="space-y-1">
                      {attachedFiles.map((file, index) => (
                        <div key={index} className="flex items-center justify-between p-1 hover:bg-gray-100 dark:hover:bg-accent rounded">
                          <div className="flex items-center gap-2">
                            <Paperclip className="h-3 w-3 text-gray-400 dark:text-muted-foreground" />
                            <span className="text-sm text-gray-700 dark:text-foreground">{file.name}</span>
                            <span className="text-xs text-gray-500 dark:text-muted-foreground">({(file.size / 1024).toFixed(1)} KB)</span>
                          </div>
                          <Button variant="ghost"
                            onClick={() => removeAttachment(index)}
                            className="p-1 hover:bg-gray-200 dark:hover:bg-accent rounded transition-colors"
                          >
                            <X className="h-3 w-3 text-gray-500 dark:text-muted-foreground" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {/* Selected Tags */}
                {selectedTags.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1">
                    {selectedTags.map(tagId => {
                      const tag = availableTags.find(t => t.id === tagId);
                      if (!tag) return null;
                      return (
                        <span
                          key={tag.id}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium text-white"
                          style={{ backgroundColor: tag.color }}
                        >
                          {tag.name}
                          <Button variant="ghost"
                            onClick={() => toggleTag(tag.id)}
                            className="hover:opacity-75"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </span>
                      );
                    })}
                  </div>
                )}
                
                {/* Scheduled Time */}
                {scheduledTime && (
                  <div className="mb-3 inline-flex items-center gap-2 px-3 py-1 bg-blue-50 text-blue-700 rounded-lg text-sm">
                    <Clock className="h-4 w-4" />
                    <span>{t.mail.inboxPage.scheduledFor.replace('{date}', format(scheduledTime, 'PPp'))}</span>
                    <Button variant="ghost"
                      onClick={() => setScheduledTime(null)}
                      className="ml-2 hover:bg-blue-100 dark:hover:bg-accent rounded p-0.5"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                )}
                
                <textarea
                  placeholder={st('sweep.weldmail.compose.enterText')}
                  className="w-full h-full text-sm outline-none bg-transparent resize-none placeholder-gray-400 dark:placeholder-muted-foreground"
                  value={composeData.body}
                  onChange={(e) => setComposeData(prev => ({ ...prev, body: e.target.value }))}
                />
              </div>

              {/* Compose Footer - Same as full size */}
              <div className="px-6 py-3 border-t border-gray-200 dark:border-border">
                {/* Hidden file input */}
                <input
                  ref={fileInputRefMinimized}
                  type="file"
                  multiple
                  onChange={handleFileAttachment}
                  className="hidden"
                />
                
                <div className="flex items-center justify-end">
                  <div className="flex items-center gap-3">
                    <Button variant="ghost" 
                      onClick={() => fileInputRefMinimized.current?.click()}
                      className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                      title={st('sweep.weldmail.compose.attachFiles')}
                    >
                      <Paperclip className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>
                    
                    <Popover open={showTagsPopup} onOpenChange={setShowTagsPopup}>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" 
                          className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                          title={st('sweep.weldmail.compose.addTags')}
                        >
                          <Tag className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-56 p-2" align="start">
                        <div className="text-xs font-medium text-gray-600 dark:text-muted-foreground mb-2">{t.mail.inboxPage.selectTags}</div>
                        <div className="space-y-1">
                          {availableTags.map(tag => (
                            <Button variant="ghost"
                              key={tag.id}
                              onClick={() => toggleTag(tag.id)}
                              className="w-full flex items-center justify-between p-2 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <div 
                                  className="w-3 h-3 rounded-full" 
                                  style={{ backgroundColor: tag.color }}
                                />
                                <span className="text-sm">{tag.name}</span>
                              </div>
                              {selectedTags.includes(tag.id) && (
                                <Check className="h-3 w-3 text-green-600" />
                              )}
                            </Button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                    
                    <Popover open={showSchedulePopup} onOpenChange={setShowSchedulePopup}>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" 
                          className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                          title={st('sweep.weldmail.compose.scheduleSend')}
                        >
                          <Clock className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64 p-3" align="start">
                        <div className="text-sm font-medium mb-3">{t.mail.inboxPage.scheduleEmail}</div>
                        <div className="space-y-2">
                          <Button variant="ghost"
                            onClick={() => handleSchedule(new Date(Date.now() + 3600000))}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                          >
                            {st('sweep.weldmail.schedule.in1Hour')}
                          </Button>
                          <Button variant="ghost"
                            onClick={() => handleSchedule(new Date(Date.now() + 14400000))}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                          >
                            {st('sweep.weldmail.schedule.in4Hours')}
                          </Button>
                          <Button variant="ghost"
                            onClick={() => {
                              const tomorrow = new Date();
                              tomorrow.setDate(tomorrow.getDate() + 1);
                              tomorrow.setHours(9, 0, 0, 0);
                              handleSchedule(tomorrow);
                            }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                          >
                            {st('sweep.weldmail.schedule.tomorrow9am')}
                          </Button>
                          <Button variant="ghost"
                            onClick={() => {
                              const nextWeek = new Date();
                              nextWeek.setDate(nextWeek.getDate() + 7);
                              nextWeek.setHours(9, 0, 0, 0);
                              handleSchedule(nextWeek);
                            }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-accent rounded-md"
                          >
                            {t.mail.inboxPage.scheduleNextWeek}
                          </Button>
                        </div>
                      </PopoverContent>
                    </Popover>

                    <Button variant="ghost"
                      onClick={() => {
                        const subject = composeData.subject;
                        setComposeData(prev => ({ 
                          ...prev, 
                          subject: subject.startsWith('Fwd: ') ? subject : `Fwd: ${subject}` 
                        }));
                        toast.success(t.mail.inboxPage.readyToForward);
                      }}
                      className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                      title={t.mail.inboxPage.forwardAction}
                    >
                      <Forward className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>

                    <Button variant="ghost"
                      onClick={() => {
                        // Search for similar emails or contacts
                        toast.success(t.mail.inboxPage.searchingRelatedEmails);
                      }}
                      className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                      title={st('sweep.weldmail.compose.searchRelated')}
                    >
                      <Search className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Preferences Modal */}
      {showPreferencesModal && (
        <>
          {/* Backdrop */}
          <div 
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setShowPreferencesModal(false)}
          />
          
          {/* Modal */}
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] bg-white dark:bg-secondary rounded-2xl shadow-2xl z-50 px-6 pt-6 pb-4">
            {/* Header */}
            <div className="mb-6">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-foreground">{t.mail.inboxPage.connectors}</h2>
              <p className="text-sm text-gray-500 dark:text-muted-foreground mt-1">
                {t.mail.inboxPage.connectorsDescription} <a href="#" className="text-blue-600 hover:underline">{t.mail.inboxPage.connectorsMoreInfo}</a>
              </p>
            </div>
            
            {/* Apps Grid */}
            <div className="grid grid-cols-3 gap-3 mb-3">
              {/* Commerce */}
              <Button variant="ghost" 
                onClick={() => {
                  setSelectedApp({ name: 'Commerce', icon: ShoppingCart });
                  setShowAppDetailModal(true);
                }}
                className="flex flex-col items-start justify-center p-2.5 h-[74px] rounded-lg border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent/50 transition-colors"
              >
                <ShoppingCart className="h-5 w-5 text-gray-700 dark:text-muted-foreground mb-1.5" />
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">Commerce</span>
              </Button>
              
              {/* CRM */}
              <Button variant="ghost" 
                onClick={() => {
                  setSelectedApp({ name: 'CRM', icon: Users });
                  setShowAppDetailModal(true);
                }}
                className="flex flex-col items-start justify-center p-2.5 h-[74px] rounded-lg border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent/50 transition-colors"
              >
                <Users className="h-5 w-5 text-gray-700 dark:text-muted-foreground mb-1.5" />
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">CRM</span>
              </Button>
              
              {/* Chat */}
              <Button variant="ghost" 
                onClick={() => {
                  setSelectedApp({ name: 'Chat', icon: MessageSquare });
                  setShowAppDetailModal(true);
                }}
                className="flex flex-col items-start justify-center p-2.5 h-[74px] rounded-lg border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent/50 transition-colors"
              >
                <MessageSquare className="h-5 w-5 text-gray-700 dark:text-muted-foreground mb-1.5" />
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">Chat</span>
              </Button>
              
              {/* Host */}
              <Button variant="ghost" 
                onClick={() => {
                  setSelectedApp({ name: 'Host', icon: Server });
                  setShowAppDetailModal(true);
                }}
                className="flex flex-col items-start justify-center p-2.5 h-[74px] rounded-lg border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent/50 transition-colors"
              >
                <Server className="h-5 w-5 text-gray-700 dark:text-muted-foreground mb-1.5" />
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">Host</span>
              </Button>
              
              {/* Parcel */}
              <Button variant="ghost" 
                onClick={() => {
                  setSelectedApp({ name: 'Parcel', icon: Package });
                  setShowAppDetailModal(true);
                }}
                className="flex flex-col items-start justify-center p-2.5 h-[74px] rounded-lg border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent/50 transition-colors"
              >
                <Package className="h-5 w-5 text-gray-700 dark:text-muted-foreground mb-1.5" />
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">Parcel</span>
              </Button>
              
              {/* Campaign */}
              <Button variant="ghost" 
                onClick={() => {
                  setSelectedApp({ name: 'Campaign', icon: Megaphone });
                  setShowAppDetailModal(true);
                }}
                className="flex flex-col items-start justify-center p-2.5 h-[74px] rounded-lg border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent/50 transition-colors"
              >
                <Megaphone className="h-5 w-5 text-gray-700 dark:text-muted-foreground mb-1.5" />
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">Campaign</span>
              </Button>
              
              {/* Desk */}
              <Button variant="ghost" 
                onClick={() => {
                  setSelectedApp({ name: 'Desk', icon: Headphones });
                  setShowAppDetailModal(true);
                }}
                className="flex flex-col items-start justify-center p-2.5 h-[74px] rounded-lg border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent/50 transition-colors"
              >
                <Headphones className="h-5 w-5 text-gray-700 dark:text-muted-foreground mb-1.5" />
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">Desk</span>
              </Button>
              
              {/* WMS */}
              <Button variant="ghost" 
                onClick={() => {
                  setSelectedApp({ name: 'WMS', icon: Warehouse });
                  setShowAppDetailModal(true);
                }}
                className="flex flex-col items-start justify-center p-2.5 h-[74px] rounded-lg border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent/50 transition-colors"
              >
                <Warehouse className="h-5 w-5 text-gray-700 dark:text-muted-foreground mb-1.5" />
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">WMS</span>
              </Button>
              
              {/* Books */}
              <Button variant="ghost" 
                onClick={() => {
                  setSelectedApp({ name: 'Books', icon: BookOpen });
                  setShowAppDetailModal(true);
                }}
                className="flex flex-col items-start justify-center p-2.5 h-[74px] rounded-lg border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent/50 transition-colors"
              >
                <BookOpen className="h-5 w-5 text-gray-700 dark:text-muted-foreground mb-1.5" />
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">Books</span>
              </Button>
              
              {/* Task */}
              <Button variant="ghost" 
                onClick={() => {
                  setSelectedApp({ name: 'Task', icon: CheckSquare });
                  setShowAppDetailModal(true);
                }}
                className="flex flex-col items-start justify-center p-2.5 h-[74px] rounded-lg border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent/50 transition-colors"
              >
                <CheckSquare className="h-5 w-5 text-gray-700 dark:text-muted-foreground mb-1.5" />
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">Task</span>
              </Button>
              
              {/* Mail */}
              <Button variant="ghost" 
                onClick={() => {
                  setSelectedApp({ name: 'Mail', icon: Mail });
                  setShowAppDetailModal(true);
                }}
                className="flex flex-col items-start justify-center p-2.5 h-[74px] rounded-lg border border-gray-200 dark:border-border hover:bg-gray-50 dark:hover:bg-accent/50 transition-colors"
              >
                <Mail className="h-5 w-5 text-gray-700 dark:text-muted-foreground mb-1.5" />
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">Mail</span>
              </Button>
            </div>
            
            {/* Close Button */}
            <Button variant="ghost"
              onClick={() => setShowPreferencesModal(false)}
              className="absolute top-4 right-4 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-accent transition-colors"
            >
              <X className="h-5 w-5 text-gray-500 dark:text-muted-foreground" />
            </Button>
          </div>
        </>
      )}
      
      {/* App Detail Modal */}
      {showAppDetailModal && selectedApp && (
        <>
          {/* Backdrop */}
          <div 
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setShowAppDetailModal(false)}
          />
          
          {/* Modal */}
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] bg-white dark:bg-secondary rounded-2xl shadow-2xl z-50">
            {/* Header with back button */}
            <div className="flex items-center gap-3 p-6 pb-0">
              <Button variant="ghost"
                onClick={() => setShowAppDetailModal(false)}
                className="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-accent transition-colors"
              >
                <ChevronLeft className="h-5 w-5 text-gray-600 dark:text-muted-foreground" />
              </Button>
              <span className="text-sm text-gray-600 dark:text-muted-foreground">{t.mail.inboxPage.connectorsBack}</span>
            </div>
            
            {/* App info section */}
            <div className="p-6">
              <div className="flex items-start gap-4 mb-6">
                <div className="w-14 h-14 bg-gray-100 dark:bg-accent rounded-xl flex items-center justify-center">
                  {selectedApp.icon && <selectedApp.icon className="h-8 w-8 text-gray-700 dark:text-muted-foreground" />}
                </div>
                <div className="flex-1">
                  <h2 className="text-xl font-semibold text-gray-900 dark:text-foreground">{selectedApp.name}</h2>
                  <p className="text-sm text-gray-500 dark:text-muted-foreground">
                    {t.mail.inboxPage.connectorsAppDescription.replace('{appName}', selectedApp.name || '')}
                  </p>
                </div>
                <Button className="bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 rounded-full text-sm font-medium">
                  {t.mail.inboxPage.connectorsConnect}
                </Button>
              </div>
              
              {/* Information section */}
              <div className="space-y-4">
                <h3 className="text-base font-semibold text-gray-900 dark:text-foreground mb-4">{t.mail.inboxPage.connectorsInformation}</h3>

                <div className="grid grid-cols-[140px_1fr] gap-y-3 text-sm">
                  <span className="text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.connectorsWorksWith}</span>
                  <span className="text-gray-900 dark:text-foreground">Products, Orders, Customers, Inventory</span>

                  <span className="text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.connectorsCategory}</span>
                  <span className="text-gray-900 dark:text-foreground">{t.mail.inboxPage.connectorsProductivity}</span>

                  <span className="text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.connectorsDeveloper}</span>
                  <span className="text-gray-900 dark:text-foreground">WeldSuite</span>

                  <span className="text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.senderWebsite}</span>
                  <a href="#" className="text-gray-900 dark:text-foreground flex items-center gap-1 hover:underline">
                    commerce.weldsuite.com
                    <ExternalLink className="h-3 w-3" />
                  </a>

                  <span className="text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.connectorsPrivacyPolicy}</span>
                  <a href="#" className="text-gray-900 dark:text-foreground flex items-center gap-1 hover:underline">
                    {st('sweep.weldmail.footer.privacyPolicy')}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
              
              {/* Preferences section */}
              <div className="mt-8 pt-6 border-t border-gray-200 dark:border-border">
                <h3 className="text-base font-semibold text-gray-900 dark:text-foreground mb-4">{t.mail.inboxPage.connectorsPreferences}</h3>

                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-foreground">
                      {t.mail.inboxPage.connectorsConnectionRecommendations}
                    </p>
                    <p className="text-sm text-gray-500 dark:text-muted-foreground">
                      {t.mail.inboxPage.connectorsConnectionRecommendationsDescription.replace('{appName}', selectedApp.name || '')}
                    </p>
                  </div>
                  <Switch defaultChecked />
                </div>
              </div>
            </div>
          </div>
        </>
      )}
      
      {/* Text Selection Popup */}
      {showSelectionPopup && selectedText && (
        <div 
          className="selection-popup fixed z-[100] bg-gray-800 text-white px-3 py-2 rounded-lg shadow-xl flex items-center gap-2 text-sm font-medium cursor-pointer hover:bg-gray-700 transition-colors"
          style={{
            left: `${popupPosition.x}px`,
            top: `${popupPosition.y}px`,
            transform: 'translateX(-50%)',
            pointerEvents: 'auto'
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleAskWeldAgent();
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <MessageSquare className="h-4 w-4" />
          <span>{t.mail.inboxPage.askWeldAgent}</span>
        </div>
      )}

      {/* Popup Reply Window - Floating */}
      {showPopupReply && (
        <div
          className={cn(
            "fixed w-[600px] bg-white dark:bg-background rounded-lg shadow-lg border border-gray-200 dark:border-border flex flex-col z-50",
            isPopupMinimized ? "h-12" : "h-[550px]"
          )}
          style={{
            right: '24px',
            bottom: '30px'
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between pl-4 pr-3 py-2 border-b border-gray-200 dark:border-border bg-gray-50 dark:bg-secondary rounded-t-lg"
          >
            <h3 className="text-sm font-semibold text-gray-900 dark:text-foreground">
              {popupComposeData.subject || st('sweep.weldmail.compose.newMessage')}
            </h3>
            <div className="flex items-center gap-1">
              <Button variant="ghost"
                onClick={() => {
                  setIsPopupMinimized(true);
                }}
                className="p-1 hover:bg-gray-200 dark:hover:bg-accent rounded-md transition-colors"
                title={t.mail.floatingCompose.minimize}
              >
                <Minus className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
              </Button>
              <Button variant="ghost"
                onClick={() => setShowPopupReply(false)}
                className="p-1 hover:bg-gray-200 dark:hover:bg-accent rounded-md transition-colors"
                title={t.mail.floatingCompose.close}
              >
                <X className="h-4 w-4 text-gray-600 dark:text-muted-foreground" />
              </Button>
            </div>
          </div>

          {/* Content - Only show when not minimized */}
          {!isPopupMinimized && (
            <>
              {/* To Field */}
              <div className="pl-4 pr-3 border-b border-gray-200 dark:border-border py-2">
                <div className="flex items-start gap-2 w-full">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost"
                        className="p-1 hover:bg-gray-100 dark:hover:bg-accent rounded-md transition-colors flex-shrink-0"
                        title={st('sweep.weldmail.compose.replyOptions')}
                      >
                        <CornerDownRight className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onClick={() => toast.success(t.mail.inboxPage.replyAction)}>
                        <Reply className="h-4 w-4 mr-0.5" />
                        {st('sweep.weldmail.thread.replyAction')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toast.success(t.mail.inboxPage.forwardAction)}>
                        <Forward className="h-4 w-4 mr-0.5" />
                        {st('sweep.weldmail.thread.forwardAction')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setShowSubjectField(!showSubjectField)}>
                        <Edit className="h-4 w-4 mr-0.5" />
                        {st('sweep.weldmail.thread.editSubject')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <div className="flex-1 space-y-2">
                    <input
                      type="text"
                      className="w-full text-sm outline-none bg-transparent text-blue-600"
                      value={popupComposeData.to}
                      onChange={(e) => setPopupComposeData(prev => ({ ...prev, to: e.target.value }))}
                    />
                    {showPopupCc && (
                      <input
                        type="text"
                        placeholder={st('sweep.weldmail.compose.cc')}
                        className="w-full text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground text-blue-600"
                        value={popupCcRecipients}
                        onChange={(e) => setPopupCcRecipients(e.target.value)}
                      />
                    )}
                    {showPopupBcc && (
                      <input
                        type="text"
                        placeholder={st('sweep.weldmail.compose.bcc')}
                        className="w-full text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground text-blue-600"
                        value={popupBccRecipients}
                        onChange={(e) => setPopupBccRecipients(e.target.value)}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 pt-0.5">
                    {!showPopupCc && (
                      <Button variant="ghost"
                        onClick={() => setShowPopupCc(true)}
                        className="text-xs text-gray-500 dark:text-muted-foreground hover:text-gray-700 dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent transition-colors whitespace-nowrap px-2 py-1 rounded-md"
                      >
                        {st('sweep.weldmail.compose.cc')}
                      </Button>
                    )}
                    {!showPopupBcc && (
                      <Button variant="ghost"
                        onClick={() => setShowPopupBcc(true)}
                        className="text-xs text-gray-500 dark:text-muted-foreground hover:text-gray-700 dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent transition-colors whitespace-nowrap px-2 py-1 rounded-md"
                      >
                        {st('sweep.weldmail.compose.bcc')}
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Subject Field - Conditional */}
              {showSubjectField && (
                <div className="px-4 border-b border-gray-200 dark:border-border h-[41px] flex items-center gap-2">
                  <span className="text-sm text-gray-500 dark:text-muted-foreground">{t.mail.inboxPage.rePrefix}</span>
                  <input
                    type="text"
                    placeholder={st('sweep.weldmail.compose.subject')}
                    className="flex-1 text-sm outline-none bg-transparent placeholder-gray-400 dark:placeholder-muted-foreground"
                    value={popupComposeData.subject.replace(/^Re:\s*/i, '')}
                    onChange={(e) => setPopupComposeData(prev => ({ ...prev, subject: `Re: ${e.target.value}` }))}
                  />
                </div>
              )}

              {/* Message Body */}
              <div className="flex-1 pl-4 pr-0 py-3 overflow-hidden">
                <style>{`
                  .custom-scrollbar::-webkit-scrollbar {
                    width: 6px;
                  }
                  .custom-scrollbar::-webkit-scrollbar-track {
                    background: transparent;
                  }
                  .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: #e5e7eb;
                    border-radius: 3px;
                  }
                  .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: #d1d5db;
                  }
                `}</style>
                <textarea
                  placeholder={st('sweep.weldmail.compose.enterText')}
                  className="w-full h-full text-sm outline-none bg-transparent resize-none placeholder-gray-400 dark:placeholder-muted-foreground overflow-y-auto pl-0 pr-2 custom-scrollbar"
                  style={{
                    scrollbarWidth: 'thin',
                    scrollbarColor: '#e5e7eb transparent'
                  }}
                  value={popupComposeData.body}
                  onChange={(e) => setPopupComposeData(prev => ({ ...prev, body: e.target.value }))}
                />
              </div>

              {/* Footer with actions */}
              <div className="px-4 py-3 border-t border-gray-200 dark:border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Button variant="ghost"
                    className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                    title={st('sweep.weldmail.compose.attachFiles')}
                    onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.multiple = true;
                      input.onchange = (e: Event) => {
                        const files = Array.from((e.target as HTMLInputElement).files ?? []);
                        toast.success(t.mail.inboxPage.filesAttached.replace('{n}', String(files.length)));
                      };
                      input.click();
                    }}
                  >
                    <Paperclip className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                  </Button>
                  <Button variant="ghost"
                    className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                    title={st('sweep.weldmail.compose.insertLink')}
                    onClick={() => {
                      const url = prompt('Enter link URL:');
                      if (url) {
                        toast.success(t.mail.inboxPage.linkInserted);
                      }
                    }}
                  >
                    <Link className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                  </Button>
                  <Button variant="ghost"
                    className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                    title={st('sweep.weldmail.compose.insertEmoji')}
                    onClick={() => toast.success(t.mail.inboxPage.emojiPickerComingSoon)}
                  >
                    <Smile className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                  </Button>
                  <Button variant="ghost"
                    className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                    title={st('sweep.weldmail.compose.insertFilesFromDrive')}
                    onClick={() => toast.success(t.mail.inboxPage.driveIntegrationComingSoon)}
                  >
                    <HardDrive className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                  </Button>
                  <Button variant="ghost"
                    className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                    title={st('sweep.weldmail.compose.insertPhoto')}
                    onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = 'image/*';
                      input.multiple = true;
                      input.onchange = (e: Event) => {
                        const files = Array.from((e.target as HTMLInputElement).files ?? []);
                        toast.success(t.mail.inboxPage.imagesAttached.replace('{n}', String(files.length)));
                      };
                      input.click();
                    }}
                  >
                    <Image className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                  </Button>
                  <Button variant="ghost"
                    className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                    title={st('sweep.weldmail.compose.setReminder')}
                    onClick={() => toast.success(t.mail.inboxPage.reminderSet)}
                  >
                    <Bell className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                  </Button>
                  <Button variant="ghost"
                    className="p-1.5 hover:bg-gray-100 dark:hover:bg-accent rounded transition-colors"
                    title={st('sweep.weldmail.compose.insertTemplate')}
                    onClick={() => toast.success(t.mail.inboxPage.templatePickerComingSoon)}
                  >
                    <FileText className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
                  </Button>
                </div>
                <ButtonGroup>
                  <Button variant="outline" className="!h-[34px] !rounded-lg !bg-[#3451ff] !text-white hover:!bg-[#2945f0] !border-[#3451ff]" onClick={async () => {
                    if (!popupComposeData.body.trim()) {
                      toast.error(t.mail.inboxPage.pleaseEnterMessage);
                      return;
                    }
                    try {
                      const toAddresses = popupComposeData.to.split(/[,;]/).map((e: string) => e.trim()).filter((e: string) => e.length > 0);
                      const result = await mailApi.messages.send(activeAccount.id, {
                        to: toAddresses.length > 0 ? toAddresses : [selectedEmail?.from || ''],
                        subject: popupComposeData.subject || `Re: ${selectedEmail?.subject || ''}`,
                        body: popupComposeData.body.trim(),
                        htmlBody: popupComposeData.body.trim().replace(/\n/g, '<br>'),
                      });
                      if (result.success) {
                        toast.success(t.mail.inboxPage.emailSent);
                        setShowPopupReply(false);
                        setPopupComposeData({ to: '', subject: '', body: '' });
                      } else {
                        toast.error(result.error || t.mail.inboxPage.failedToSendEmail);
                      }
                    } catch (error) {
                      console.error('Failed to send email:', error);
                      toast.error(t.mail.inboxPage.failedToSendEmail);
                    }
                  }}>{t.mail.compose.send}</Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="!pl-[10px] !w-[34px] !h-[34px] !rounded-lg !bg-[#3451ff] !text-white hover:!bg-[#2945f0] !border-[#3451ff]">
                        <ChevronDown />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="[--radius:1rem]">
                      <DropdownMenuGroup>
                        <DropdownMenuItem>
                          <Clock />
                          {st('sweep.weldmail.compose.scheduleSendAction')}
                        </DropdownMenuItem>
                        <DropdownMenuItem>
                          <Archive />
                          {st('sweep.weldmail.compose.sendAndArchive')}
                        </DropdownMenuItem>
                        <DropdownMenuItem>
                          <Check />
                          {st('sweep.weldmail.compose.saveDraft')}
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuItem variant="destructive">
                          <Trash />
                          {st('sweep.weldmail.compose.discardDraft')}
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ButtonGroup>
              </div>
            </>
          )}
        </div>
      )}
    </div>
    </>
  );
}