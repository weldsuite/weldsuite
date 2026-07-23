
import { useRouter } from '@/lib/router';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  X,
  Check,
  Building2,
  User,
  Star,
  Mail,
  Phone,
  EllipsisVertical,
  ChevronUp,
  ChevronDown,
  Maximize,
  Minimize,
  SquareCheck,
  StickyNote,
  Pencil,
  Copy,
  Trash2,
  Camera,
  Loader2,
  Link as LinkIcon,
  Share2,
  MessageSquareShare,
  ListPlus,
  Tag,
  Download,
  GitMerge,
  Archive,
  UserCog,
  MessageSquare,
  Calendar,
  CalendarPlus,
  ExternalLink,
  SquareArrowOutUpRight,
  Search,
  Plus,
  Smile,
  AtSign,
  Baseline,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@weldsuite/ui/components/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useCustomerDetailContext } from './customer-detail-provider';
import { useUpdateCompany } from '@/components/objects/company/use-company-data';
import { useUpdatePerson } from '@/components/objects/person/use-person-data';
import { useCustomerLists, useAddCustomersToList, useAddContactsToList } from '@/hooks/queries/use-customer-lists-queries';
import { coloredSquareIcons } from '@/components/app-sidebar-layout';
import { NewEventDialog } from '@/app/weldcalendar/events/components/new-event-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useCreateCustomerNote } from '@/hooks/queries/use-customer-notes-queries';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { useChannels, useCreateDm, useSendMessage, useDmChannels } from '@/hooks/queries/use-weldchat-queries';
import { Hash, Lock, Users as UsersIcon } from 'lucide-react';
import { useFileUpload } from '@/hooks/use-file-upload';
import { useComposeSafe } from '@/contexts/compose-context';
import { useTranslations } from '@weldsuite/i18n/client';

interface CustomerDetailHeaderProps {
  variant?: 'page' | 'panel';
  onDelete?: () => void;
  onNavigateToCustomer?: (customerId: string) => void;
}

/**
 * Inline-editable customer / contact name. Mirrors the EditableTitle used in
 * apps/web/platform/components/task-detail/task-detail-panel.tsx — same hover
 * border, same edit-on-click, same Enter/Escape keys, same optimistic local
 * mirror so the displayed text never flashes back to a stale prop while the
 * API update is in flight.
 */
function EditableHeaderName({
  name,
  onSave,
  className,
}: {
  name: string;
  onSave: (newName: string) => void;
  className?: string;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [localName, setLocalName] = useState(name);
  const editorRef = useRef<HTMLDivElement>(null);

  const isEditingRef = useRef(isEditing);
  useEffect(() => { isEditingRef.current = isEditing; }, [isEditing]);

  useEffect(() => {
    if (isEditingRef.current) return;
    setLocalName(name);
  }, [name]);

  useEffect(() => {
    if (!isEditing) return;
    const el = editorRef.current;
    if (!el) return;
    el.textContent = localName;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  const handleSave = () => {
    const next = (editorRef.current?.textContent ?? localName).trim();
    if (next && next !== localName) {
      setLocalName(next);
      onSave(next);
    } else if (editorRef.current) {
      editorRef.current.textContent = localName;
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLDivElement).blur();
    }
    if (e.key === 'Escape') {
      if (editorRef.current) editorRef.current.textContent = localName;
      setIsEditing(false);
    }
  };

  return (
    <div
      ref={editorRef}
      contentEditable={isEditing}
      suppressContentEditableWarning
      onClick={() => { if (!isEditing) setIsEditing(true); }}
      onBlur={handleSave}
      onKeyDown={isEditing ? handleKeyDown : undefined}
      className={cn(
        'rounded-md px-1.5 py-0.5 -mx-1.5 -my-0.5 border outline-none whitespace-pre-wrap break-words min-w-0',
        isEditing
          ? 'border-border focus:ring-1 focus:ring-primary cursor-text'
          : 'border-transparent hover:border-border transition-colors cursor-text',
        className,
      )}
    >
      {localName}
    </div>
  );
}

export function CustomerDetailHeader({
  variant = 'page',
  onDelete,
  onNavigateToCustomer,
}: CustomerDetailHeaderProps) {
  const t = useTranslations();
  const router = useRouter();
  const {
    data,
    isLoading,
    navigation,
    customerId,
    entityType,
    listId,
    returnUrl,
    onCompose,
    onCall,
    onClose,
    mode,
    isExpanded,
    onToggleExpand,
    setActiveTab,
    setPendingNoteCreate,
    setFloatingNote,
    setShowFloatingNoteEditor,
    setShowTaskDialog,
    silentRefresh,
  } = useCustomerDetailContext();

  const composeContext = useComposeSafe();
  const createNoteMutation = useCreateCustomerNote();
  const updateCompanyMutation = useUpdateCompany();
  const updatePersonMutation = useUpdatePerson();
  const addCustomersToListMutation = useAddCustomersToList();
  const addContactsToListMutation = useAddContactsToList();
  const [addToListOpen, setAddToListOpen] = useState(false);
  const [newEventOpen, setNewEventOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const isContact = entityType === 'contact';
  const customer = data?.customer;
  const isDataReady = !isLoading && !!customer;

  const [isFavorite, setIsFavorite] = useState(customer?.isFavorite ?? false);
  const [isNavigating, setIsNavigating] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  // Avatar upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(customer?.avatarUrl || null);
  const { uploadFile, isUploading } = useFileUpload({
    folder: 'avatars',
    entityType: 'customer-avatar',
    entityId: customerId,
    isPublic: true,
    maxFileSize: 5 * 1024 * 1024,
    allowedTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
    onSuccess: async (file) => {
      setAvatarUrl(file.url);
      try {
        if (isContact) {
          await updatePersonMutation.mutateAsync({ id: customerId, data: { avatarUrl: file.url } as any });
        } else {
          await updateCompanyMutation.mutateAsync({ id: customerId, data: { logoUrl: file.url } });
        }
        toast.success(t('sweep.weldcrm.contactDetailView.avatarUpdated'));
        silentRefresh();
      } catch {
        toast.error(t('sweep.weldcrm.contactDetailView.failedToSaveAvatar'));
      }
    },
    onError: (error) => {
      toast.error(error);
    },
  });

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      uploadFile(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Sync local state when data loads
  useEffect(() => {
    if (customer?.isFavorite !== undefined) {
      setIsFavorite(customer.isFavorite);
    }
  }, [customer?.isFavorite]);

  useEffect(() => {
    if (customer?.avatarUrl) {
      setAvatarUrl(customer.avatarUrl);
    }
  }, [customer?.avatarUrl]);

  // Defensive checks for customer data
  const customerType = customer?.type?.toLowerCase() || '';
  const isB2B = !isContact && customerType === 'b2b';

  // Persist a renamed customer / contact. Mirrors the field that drives
  // `customerName` in the header so the displayed value stays consistent.
  const handleNameSave = useCallback((newName: string) => {
    if (!customer) return;
    const trimmed = newName.trim();
    if (!trimmed) return;
    const parts = trimmed.split(/\s+/);
    const firstName = parts[0] ?? '';
    const lastName = parts.slice(1).join(' ');
    if (isContact) {
      updatePersonMutation.mutate({ id: customerId, data: { firstName, lastName } as any });
    } else {
      updateCompanyMutation.mutate({ id: customerId, data: { name: trimmed } });
    }
  }, [customer, isContact, customerId, updateCompanyMutation, updatePersonMutation]);

  const customerName = isContact
    ? `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim() || customer?.fullName || ''
    : isB2B
      ? customer?.companyName || ''
      : `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim() || customer?.fullName || '';

  const entityLabel = isContact ? t('sweep.weldcrm.customerDetailHeader.entityContact') : t('sweep.weldcrm.customerDetailHeader.entityCustomer');

  // Navigation defaults
  const navData = navigation || {
    currentIndex: 1,
    totalCount: 1,
    previousId: null,
    nextId: null,
    contextName: 'All Customers',
  };

  // Companies/People no longer have a detail page — links open the object
  // panel on the list surface via the `?stack=` deep link.
  const recordPanelPath = useCallback(
    (targetId: string) =>
      isContact
        ? `/weldcrm/people?stack=person:${targetId}:panel`
        : `/weldcrm/companies?stack=company:${targetId}:panel`,
    [isContact],
  );

  // Build the panel deep link with listId and returnUrl preserved.
  const buildCustomerUrl = useCallback((targetCustomerId: string) => {
    const baseUrl = recordPanelPath(targetCustomerId);
    const params = new URLSearchParams();
    if (listId) params.set('listId', listId);
    if (returnUrl) params.set('returnUrl', returnUrl);
    const queryString = params.toString();
    return queryString ? `${baseUrl}&${queryString}` : baseUrl;
  }, [recordPanelPath, listId, returnUrl]);

  const handlePrevious = useCallback(() => {
    if (navData.previousId && !isNavigating) {
      setIsNavigating(true);
      if (onNavigateToCustomer) {
        onNavigateToCustomer(navData.previousId);
      } else {
        router.push(buildCustomerUrl(navData.previousId));
      }
    }
  }, [navData.previousId, isNavigating, router, buildCustomerUrl, onNavigateToCustomer]);

  const handleNext = useCallback(() => {
    if (navData.nextId && !isNavigating) {
      setIsNavigating(true);
      if (onNavigateToCustomer) {
        onNavigateToCustomer(navData.nextId);
      } else {
        router.push(buildCustomerUrl(navData.nextId));
      }
    }
  }, [navData.nextId, isNavigating, router, buildCustomerUrl, onNavigateToCustomer]);

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
    } else if (returnUrl) {
      router.push(returnUrl);
    } else if (listId) {
      router.push(`/weldcrm/lists/${listId}`);
    } else {
      router.push(isContact ? '/weldcrm/people' : '/weldcrm/companies');
    }
  }, [returnUrl, listId, router, onClose, isContact]);

  const handleComposeEmail = useCallback(() => {
    if (!customer?.email) return;
    if (onCompose) {
      onCompose(customer.email);
    } else if (composeContext) {
      composeContext.openCompose({ to: customer.email });
    } else {
      window.location.href = `mailto:${customer.email}`;
    }
  }, [customer?.email, onCompose, composeContext]);

  const handleCall = useCallback(() => {
    const phone = customer?.phone || customer?.mobile;
    if (phone) {
      if (onCall) {
        onCall(phone);
      } else {
        window.location.href = `tel:${phone}`;
      }
    }
  }, [customer, onCall]);

  const handleOpenFullPage = useCallback(() => {
    if (onClose) {
      onClose();
    }
    const url = buildCustomerUrl(customerId);
    // Include current page as returnUrl so the full page can navigate back
    const currentPath = window.location.pathname + window.location.search;
    const separator = url.includes('?') ? '&' : '?';
    router.push(`${url}${separator}returnUrl=${encodeURIComponent(currentPath)}`);
  }, [customerId, buildCustomerUrl, router, onClose]);

  const handleMinimizeToPanel = useCallback(() => {
    if (onToggleExpand) {
      onToggleExpand();
      return;
    }
    if (returnUrl) {
      // The full page was reached by pushing onto history (handleOpenFullPage),
      // so unwinding via history.back() reliably restores the previous URL —
      // including its original query string (e.g. ?accountId=… on weldmail).
      window.history.back();
      return;
    }
    // Direct-open fallback: deep-link the list with this entity pre-opened.
    const params = new URLSearchParams();
    params.set('open', customerId);
    if (listId) params.set('listId', listId);
    router.push(`/weldcrm/${isContact ? 'contacts' : 'customers'}?${params.toString()}`);
  }, [onToggleExpand, returnUrl, customerId, isContact, listId, router]);

  const handleCreateNote = useCallback(async () => {
    try {
      const result = await createNoteMutation.mutateAsync({ customerId, content: '' });
      if (result.success && result.data) {
        setFloatingNote({
          id: result.data.id,
          content: '',
          createdAt: new Date(),
          updatedAt: new Date(),
          isPinned: false,
          customerId,
          customerName: customerName || undefined,
        });
        setShowFloatingNoteEditor(true);
        silentRefresh();
      } else {
        toast.error((result as any).error || t('sweep.weldcrm.customerDetailHeader.failedToCreateNote'));
      }
    } catch {
      toast.error(t('sweep.weldcrm.customerDetailHeader.failedToCreateNote'));
    }
  }, [customerId, customerName, setFloatingNote, setShowFloatingNoteEditor, silentRefresh, createNoteMutation, t]);

  const handleEdit = useCallback(() => {
    router.push(recordPanelPath(customerId));
  }, [customerId, recordPanelPath, router]);

  const handleToggleFavorite = useCallback(async () => {
    const newValue = !isFavorite;
    setIsFavorite(newValue); // Optimistic update
    try {
      if (isContact) {
        await updatePersonMutation.mutateAsync({ id: customerId, data: { isFavorite: newValue } as any });
      } else {
        await updateCompanyMutation.mutateAsync({ id: customerId, data: { isFavorite: newValue } });
      }
    } catch {
      setIsFavorite(!newValue); // Revert on failure
      toast.error(t('sweep.weldcrm.notesView.failedToUpdateFavorite'));
    }
  }, [isFavorite, customerId, isContact, updateCompanyMutation, updatePersonMutation, t]);

  const handleCopyLink = useCallback(async () => {
    try {
      const path = recordPanelPath(customerId);
      // Always copy the production URL — never localhost — so the copied link
      // is shareable regardless of where the user is browsing from.
      const origin =
        typeof window !== 'undefined' && !/^(localhost|127\.|0\.|192\.168\.)/.test(window.location.hostname)
          ? window.location.origin
          : 'https://app.weldsuite.org';
      await navigator.clipboard.writeText(`${origin}${path}`);
      toast.success(t('sweep.weldcrm.customerDetailHeader.linkCopied'));
    } catch {
      toast.error(t('sweep.weldcrm.customerDetailHeader.failedToCopyLink'));
    }
  }, [recordPanelPath, customerId, t]);

  const handleOpenInNewTab = useCallback(() => {
    const path = recordPanelPath(customerId);
    if (typeof window !== 'undefined') {
      window.open(path, '_blank', 'noopener,noreferrer');
    }
  }, [customerId, recordPanelPath]);

  const handleDuplicate = useCallback(() => {
    router.push(`/weldcrm/${isContact ? 'contacts' : 'customers'}/new?duplicateFrom=${customerId}`);
  }, [customerId, isContact, router]);

  const handleShare = useCallback(() => {
    setShareOpen(true);
  }, []);

  const handleSendMessage = useCallback(() => {
    handleComposeEmail();
  }, [handleComposeEmail]);

  const handleScheduleMeeting = useCallback(() => {
    const params = new URLSearchParams();
    if (customer?.email) params.set('invite', customer.email);
    if (customer?.companyName || customer?.fullName) params.set('title', t('sweep.weldcrm.customerDetailHeader.meetingWith', { name: customer.companyName || customer.fullName }));
    router.push(`/weldmeet/new${params.toString() ? `?${params.toString()}` : ''}`);
  }, [customer, router, t]);

  // Open the new-event dialog with title + description pre-filled from this
  // customer / contact. Renders inline as a popup — no route change.
  const handleScheduleEvent = useCallback(() => {
    setNewEventOpen(true);
  }, []);

  const newEventDefaults = useMemo(() => {
    const recordName =
      customer?.companyName ||
      customer?.fullName ||
      [customer?.firstName, customer?.lastName].filter(Boolean).join(' ').trim() ||
      customer?.email ||
      (isContact ? t('sweep.weldcrm.customerDetailHeader.contact') : t('sweep.weldcrm.customerDetailHeader.customer'));
    return {
      title: t('sweep.weldcrm.customerDetailHeader.eventWith', { name: recordName }),
      description: customer?.email ? t('sweep.weldcrm.customerDetailHeader.attendee', { email: customer.email }) : '',
      type: 'meeting' as const,
    };
  }, [customer, isContact, t]);

  const handleAddToList = useCallback(() => {
    setAddToListOpen(true);
  }, []);

  const handleManageTags = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('customer-manage-tags', { detail: { customerId, entityType } }),
      );
    }
    toast.info(t('sweep.weldcrm.customerDetailHeader.manageTags'));
  }, [customerId, entityType, t]);

  const handleChangeOwner = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('customer-change-owner', { detail: { customerId, entityType } }),
      );
    }
    toast.info(t('sweep.weldcrm.customerDetailHeader.changeOwner'));
  }, [customerId, entityType, t]);

  const handleMerge = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('customer-merge', { detail: { customerId, entityType } }),
      );
    }
    toast.info(t('sweep.weldcrm.customerDetailHeader.selectRecordToMerge'));
  }, [customerId, entityType, t]);

  const handleExport = useCallback(() => {
    if (!customer) {
      toast.error(t('sweep.weldcrm.customerDetailHeader.nothingToExport'));
      return;
    }
    let url: string | null = null;
    try {
      // Wrap in a small envelope so the file documents what it contains.
      const payload = {
        exportedAt: new Date().toISOString(),
        entityType: isContact ? 'contact' : 'customer',
        record: customer,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const nameBase =
        customer.companyName ||
        customer.fullName ||
        [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() ||
        customer.email ||
        customerId;
      const slug = String(nameBase)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)+/g, '') || 'record';
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `${slug}-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast.success(t('sweep.weldcrm.customerDetailHeader.exportDownloaded'));
    } catch (err: any) {
      console.error('[CustomerDetailHeader] Failed to export:', err);
      toast.error(err?.message || t('sweep.weldcrm.customerDetailHeader.failedToExport'));
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }, [customer, customerId, isContact, t]);

  const handleArchive = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('customer-archive', { detail: { customerId, entityType } }),
      );
    }
    toast.info(t('sweep.weldcrm.customerDetailHeader.archive'));
  }, [customerId, entityType, t]);

  // Get avatar color based on name
  const getAvatarColor = (name: string): string => {
    const colors = [
      '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F97316',
      '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6',
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  const initials = customerName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();

  // Panel variant header - matches the page header design
  if (variant === 'panel') {
    return (
      <div className="group/header flex items-center justify-between px-3 md:px-4 py-[12.5px] flex-shrink-0">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
          className="hidden"
          onChange={handleAvatarFileChange}
        />
        {/* Left Section */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Avatar + Name */}
          <div className="flex items-center gap-2 min-w-0">
            {isDataReady ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleAvatarClick}
                  disabled={isUploading}
                  className="relative w-7 h-7 rounded-lg flex-shrink-0 group overflow-hidden"
                  title={t('sweep.weldcrm.contactDetailView.uploadAvatar')}
                >
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={customerName}
                      className="w-full h-full object-cover rounded-lg"
                    />
                  ) : (
                    <div className={cn(
                      "w-full h-full rounded-lg flex items-center justify-center",
                      isContact ? "bg-emerald-100 dark:bg-emerald-900" : isB2B ? "bg-blue-100 dark:bg-blue-900" : "bg-purple-100 dark:bg-purple-900"
                    )}>
                      {isContact ? (
                        <User className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : isB2B ? (
                        <Building2 className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                      ) : (
                        <User className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                      )}
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    {isUploading ? (
                      <Loader2 className="h-3.5 w-3.5 text-white animate-spin" />
                    ) : (
                      <Camera className="h-3.5 w-3.5 text-white" />
                    )}
                  </div>
                </Button>
                <EditableHeaderName
                  name={customerName}
                  onSave={handleNameSave}
                  className="text-[15px] font-medium text-foreground max-w-[200px] truncate translate-y-[0.5px]"
                />
                {isFavorite && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleToggleFavorite}
                    title={t('sweep.weldcrm.customerDetailHeader.unfavorite')}
                    className="flex-shrink-0 translate-y-[0.5px] rounded-md p-1.5 -m-1.5 hover:bg-muted transition-colors"
                  >
                    <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                  </Button>
                )}
              </>
            ) : (
              <>
                <div className="w-7 h-7 rounded-lg bg-muted animate-pulse flex-shrink-0" />
                <div className="h-4 w-32 rounded bg-muted animate-pulse" />
              </>
            )}
          </div>

        </div>

        {/* Right Section */}
        <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
          {/* Compose Email */}
          {customer?.email && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="p-1.5 hover:bg-muted rounded-md transition-colors"
                  onClick={handleComposeEmail}
                  aria-label={t('sweep.weldcrm.contactDetailView.composeEmail')}
                >
                  <Mail className="h-4 w-4 text-gray-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('sweep.weldcrm.contactDetailView.composeEmail')}</TooltipContent>
            </Tooltip>
          )}

          {/* Call */}
          {(customer?.phone || customer?.mobile) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="p-1.5 hover:bg-muted rounded-md transition-colors"
                  onClick={handleCall}
                  aria-label={t('sweep.weldcrm.contactDetailView.call')}
                >
                  <Phone className="h-4 w-4 text-gray-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('sweep.weldcrm.contactDetailView.call')}</TooltipContent>
            </Tooltip>
          )}

          {/* More menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none focus-visible:outline-none">
                <EllipsisVertical className="h-4 w-4 text-gray-500" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {isContact && (
                <DropdownMenuItem onClick={handleEdit}>
                  <Pencil className="h-4 w-4 mr-0.5" />
                  {t('sweep.weldcrm.customerDetailHeader.editEntity', { entity: entityLabel })}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleToggleFavorite}>
                <Star className={cn('h-4 w-4 mr-0.5', isFavorite && 'fill-yellow-400 text-yellow-400')} />
                {isFavorite ? t('sweep.weldcrm.customerDetailHeader.unfavorite') : t('sweep.weldcrm.customerDetailHeader.favorite')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDuplicate}>
                <Copy className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.duplicate')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleOpenInNewTab}>
                <SquareArrowOutUpRight className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.openInNewTab')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleCopyLink}>
                <LinkIcon className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.copyLink')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleScheduleEvent}>
                <CalendarPlus className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.scheduleEvent')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleAddToList}>
                <ListPlus className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.addToList')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleExport}>
                <Download className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.export')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleArchive}>
                <Archive className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.archive')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
                onClick={(e) => {
                  e.preventDefault();
                  setConfirmDeleteOpen(true);
                }}
              >
                <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                {t('sweep.weldcrm.customerDetailHeader.deleteEntity', { entity: entityLabel })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Expand / Minimize */}
          <Button
            variant="ghost"
            size="icon"
            className="p-1.5 hover:bg-muted rounded-md transition-colors"
            onClick={onToggleExpand || handleOpenFullPage}
            title={isExpanded ? t('sweep.weldcrm.globalPinnedNote.minimize') : t('sweep.weldcrm.globalPinnedNote.expand')}
          >
            {isExpanded ? (
              <Minimize className="h-4 w-4 text-gray-500" />
            ) : (
              <Maximize className="h-4 w-4 text-gray-500" />
            )}
          </Button>

          {/* Close panel - hidden in embedded mode without explicit onClose */}
          {!(mode === 'embedded' && !onClose) && (
            <Button
              variant="ghost"
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              onClick={handleClose}
              title={t('sweep.weldcrm.globalPinnedNote.close')}
            >
              <X className="h-4 w-4 text-gray-500" />
            </Button>
          )}
        </div>

        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          recordTitle={customer?.companyName || customer?.fullName || t('sweep.weldcrm.customerDetailHeader.recordFallback')}
          recordSubtitle={customer?.email || customer?.website || customer?.industry || ''}
          recordAvatar={avatarUrl || undefined}
          url={(() => {
            const path = recordPanelPath(customerId);
            return typeof window !== 'undefined' ? `${window.location.origin}${path}` : path;
          })()}
        />

        <AddToListPicker
          open={addToListOpen}
          onOpenChange={setAddToListOpen}
          isContact={isContact}
          onPick={async (listId) => {
            try {
              if (isContact) {
                await addContactsToListMutation.mutateAsync({ listId, contactIds: [customerId] });
              } else {
                await addCustomersToListMutation.mutateAsync({ listId, customerIds: [customerId] });
              }
              toast.success(t('sweep.weldcrm.customerDetailHeader.addedToList'));
              setAddToListOpen(false);
            } catch {
              toast.error(t('sweep.weldcrm.customerDetailHeader.failedToAddToList'));
            }
          }}
        />

        <NewEventDialog
          open={newEventOpen}
          onOpenChange={setNewEventOpen}
          defaults={newEventDefaults}
          hideTypeTabs
        />

        <ConfirmDialog
          open={confirmDeleteOpen}
          onOpenChange={setConfirmDeleteOpen}
          title={t('sweep.weldcrm.customerDetailHeader.deleteEntityTitle', { entity: entityLabel })}
          description={
            customerName
              ? t('sweep.weldcrm.customerDetailHeader.deleteNamedConfirmation', { name: customerName })
              : t('sweep.weldcrm.customerDetailHeader.deleteEntityConfirmation', { entity: entityLabel })
          }
          variant="destructive"
          confirmLabel={t('sweep.weldcrm.customerDetailHeader.delete')}
          onConfirm={() => {
            onDelete?.();
          }}
        />
      </div>
    );
  }

  // Page variant header
  return (
    <div className="flex flex-col bg-background">
      <div className="group/header flex items-center justify-between px-3 md:px-4 py-[12.5px] flex-shrink-0">
        {/* Left Section */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Mobile back button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden p-1.5 -ml-1 hover:bg-muted rounded-md transition-colors flex-shrink-0"
            onClick={handleClose}
            aria-label={t('sweep.weldcrm.customerDetailHeader.backToList')}
          >
            <X className="h-5 w-5 text-muted-foreground" />
          </Button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={handleAvatarFileChange}
          />

          {/* Avatar + Name */}
          <div className="flex items-center gap-2 min-w-0">
            {isDataReady ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleAvatarClick}
                  disabled={isUploading}
                  className="relative w-7 h-7 rounded-lg flex-shrink-0 group overflow-hidden"
                  title={t('sweep.weldcrm.contactDetailView.uploadAvatar')}
                >
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={customerName}
                      className="w-full h-full object-cover rounded-lg"
                    />
                  ) : (
                    <div className={cn(
                      "w-full h-full rounded-lg flex items-center justify-center",
                      isContact ? "bg-emerald-100 dark:bg-emerald-900" : isB2B ? "bg-blue-100 dark:bg-blue-900" : "bg-purple-100 dark:bg-purple-900"
                    )}>
                      {isContact ? (
                        <User className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : isB2B ? (
                        <Building2 className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                      ) : (
                        <User className="h-3.5 w-3.5 text-purple-600 dark:text-purple-400" />
                      )}
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    {isUploading ? (
                      <Loader2 className="h-3.5 w-3.5 text-white animate-spin" />
                    ) : (
                      <Camera className="h-3.5 w-3.5 text-white" />
                    )}
                  </div>
                </Button>
                <EditableHeaderName
                  name={customerName}
                  onSave={handleNameSave}
                  className="text-sm md:text-lg font-medium text-foreground truncate"
                />
                {isFavorite && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleToggleFavorite}
                    title={t('sweep.weldcrm.customerDetailHeader.unfavorite')}
                    className="flex-shrink-0 rounded-md p-1.5 -m-1.5 hover:bg-muted transition-colors"
                  >
                    <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
                  </Button>
                )}
              </>
            ) : (
              <>
                <div className="w-7 h-7 rounded-lg bg-muted animate-pulse flex-shrink-0" />
                <div className="h-5 w-36 rounded bg-muted animate-pulse" />
              </>
            )}
          </div>

        </div>

        {/* Right Section */}
        <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
          {/* Compose Email */}
          {customer?.email && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="p-1.5 hover:bg-muted rounded-md transition-colors"
                  onClick={handleComposeEmail}
                  aria-label={t('sweep.weldcrm.contactDetailView.composeEmail')}
                >
                  <Mail className="h-4 w-4 text-gray-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('sweep.weldcrm.contactDetailView.composeEmail')}</TooltipContent>
            </Tooltip>
          )}

          {/* Call */}
          {(customer?.phone || customer?.mobile) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="p-1.5 hover:bg-muted rounded-md transition-colors"
                  onClick={handleCall}
                  aria-label={t('sweep.weldcrm.contactDetailView.call')}
                >
                  <Phone className="h-4 w-4 text-gray-500" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('sweep.weldcrm.contactDetailView.call')}</TooltipContent>
            </Tooltip>
          )}

          {/* Note - hidden on mobile */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:flex p-1.5 hover:bg-muted rounded-md transition-colors"
            onClick={handleCreateNote}
            title={t('sweep.weldcrm.customerDetailHeader.createNote')}
          >
            <StickyNote className="h-4 w-4 text-gray-500" />
          </Button>

          {/* Task - hidden on mobile */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:flex p-1.5 hover:bg-muted rounded-md transition-colors"
            onClick={() => setShowTaskDialog(true)}
            title={t('sweep.weldcrm.customerDetailHeader.createTask')}
          >
            <SquareCheck className="h-4 w-4 text-gray-500" />
          </Button>

          {/* More menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none focus-visible:outline-none">
                <EllipsisVertical className="h-4 w-4 text-gray-500" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {isContact && (
                <DropdownMenuItem onClick={handleEdit}>
                  <Pencil className="h-4 w-4 mr-0.5" />
                  {t('sweep.weldcrm.customerDetailHeader.editEntity', { entity: entityLabel })}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={handleToggleFavorite}>
                <Star className={cn('h-4 w-4 mr-0.5', isFavorite && 'fill-yellow-400 text-yellow-400')} />
                {isFavorite ? t('sweep.weldcrm.customerDetailHeader.unfavorite') : t('sweep.weldcrm.customerDetailHeader.favorite')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDuplicate}>
                <Copy className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.duplicate')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleOpenInNewTab}>
                <SquareArrowOutUpRight className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.openInNewTab')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleCopyLink}>
                <LinkIcon className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.copyLink')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleScheduleEvent}>
                <CalendarPlus className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.scheduleEvent')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleAddToList}>
                <ListPlus className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.addToList')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleExport}>
                <Download className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.export')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleArchive}>
                <Archive className="h-4 w-4 mr-0.5" />
                {t('sweep.weldcrm.customerDetailHeader.archive')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
                onClick={(e) => {
                  e.preventDefault();
                  setConfirmDeleteOpen(true);
                }}
              >
                <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                {t('sweep.weldcrm.customerDetailHeader.deleteEntity', { entity: entityLabel })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Minimize + Close */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:flex p-1.5 hover:bg-muted rounded-md transition-colors"
            onClick={handleMinimizeToPanel}
            title={t('sweep.weldcrm.globalPinnedNote.minimize')}
          >
            <Minimize className="h-4 w-4 text-gray-500" />
          </Button>
          {/* Hide close when used as expanded overlay without onClose (e.g. helpdesk) */}
          {!(onToggleExpand && !onClose) && (
            <Button
              variant="ghost"
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              onClick={handleClose}
              title={t('sweep.weldcrm.globalPinnedNote.close')}
            >
              <X className="h-4 w-4 text-gray-500" />
            </Button>
          )}
        </div>
      </div>

      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        recordTitle={customer?.companyName || customer?.fullName || t('sweep.weldcrm.customerDetailHeader.recordFallback')}
        url={(() => {
          const path = recordPanelPath(customerId);
          return typeof window !== 'undefined' ? `${window.location.origin}${path}` : path;
        })()}
      />

      <AddToListPicker
        open={addToListOpen}
        onOpenChange={setAddToListOpen}
        isContact={isContact}
        onPick={async (listId) => {
          try {
            if (isContact) {
              await addContactsToListMutation.mutateAsync({ listId, contactIds: [customerId] });
            } else {
              await addCustomersToListMutation.mutateAsync({ listId, customerIds: [customerId] });
            }
            toast.success(t('sweep.weldcrm.customerDetailHeader.addedToList'));
            setAddToListOpen(false);
          } catch {
            toast.error(t('sweep.weldcrm.customerDetailHeader.failedToAddToList'));
          }
        }}
      />

      <NewEventDialog
        open={newEventOpen}
        onOpenChange={setNewEventOpen}
        defaults={newEventDefaults}
        hideTypeTabs
      />

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={`Delete this ${entityLabel}?`}
        description={
          customerName
            ? `${customerName} will be permanently removed. This action cannot be undone.`
            : `This ${entityLabel} will be permanently removed. This action cannot be undone.`
        }
        variant="destructive"
        confirmLabel="Delete"
        onConfirm={() => {
          onDelete?.();
        }}
      />

    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Share dialog — mirrors the weldchat "Forward this message" dialog
// (chip-based multi-select + message composer + record preview).

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recordTitle: string;
  recordSubtitle?: string;
  recordAvatar?: string;
  url: string;
}

interface ShareTarget {
  id: string;
  rawId: string;
  name: string;
  picture?: string;
  kind: 'user' | 'channel' | 'private' | 'group';
}

/**
 * Small picker dialog: lists every customer/contact list and adds the current
 * record to the one the user clicks. Closes on success.
 */
function AddToListPicker({
  open,
  onOpenChange,
  isContact,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isContact: boolean;
  onPick: (listId: string) => void;
}) {
  const t = useTranslations();
  const { data, isLoading } = useCustomerLists(open ? { pageSize: 100 } : undefined);
  const lists = (data?.data ?? []).filter((l: any) => isContact ? l.kind === 'contact' || !l.kind : l.kind === 'customer' || !l.kind);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const filtered = lists.filter((l: any) =>
    !search.trim() || (l.name || '').toLowerCase().includes(search.trim().toLowerCase())
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px] p-0 gap-0 overflow-hidden rounded-xl [&>button]:hidden flex flex-col max-h-[480px]">
        <div className="flex items-center justify-between pl-4 pr-2.5 pt-4 pb-3">
          <DialogTitle className="text-[17px] font-semibold">
            {t('sweep.weldcrm.customerDetailHeader.addToList')}
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
            className="rounded-md p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground hover:bg-gray-100 dark:hover:bg-secondary transition-colors"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder={t('sweep.weldcrm.customerDetailHeader.searchLists')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              autoFocus
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto pb-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 gap-3">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{t('sweep.weldcrm.customerDetailHeader.loadingLists')}</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">
              {search ? t('sweep.weldcrm.customerDetailHeader.noListsMatch', { query: search }) : t('sweep.weldcrm.customerDetailHeader.noListsAvailable')}
            </div>
          ) : (
            filtered.map((list: any) => {
              const IconComp = list.icon
                ? (coloredSquareIcons.find((i) => i.label === list.icon)?.value || ListPlus)
                : ListPlus;
              return (
                <Button
                  variant="ghost"
                  key={list.id}
                  onClick={() => onPick(list.id)}
                  className="w-full flex items-center gap-2.5 px-4 py-1.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-secondary/40"
                >
                  <div
                    className={cn(
                      'w-5 h-5 rounded-[6px] flex items-center justify-center flex-shrink-0',
                      list.color || 'bg-muted'
                    )}
                  >
                    <IconComp
                      className={cn(
                        'h-3 w-3',
                        list.color ? 'text-white' : 'text-muted-foreground'
                      )}
                    />
                  </div>
                  <span className="text-[14px] font-medium text-foreground truncate">
                    {list.name || t('sweep.weldcrm.customerDetailHeader.untitledList')}
                  </span>
                </Button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ShareDialog({
  open,
  onOpenChange,
  recordTitle,
  recordSubtitle,
  recordAvatar,
  url,
}: ShareDialogProps) {
  const st = useTranslations();
  const { data: membersData } = useWorkspaceMembers(1, 100);
  const { data: channelsData } = useChannels();
  const { data: dmsData } = useDmChannels();
  const { mutateAsync: createDm } = useCreateDm();
  const { mutateAsync: sendMessage } = useSendMessage();
  const [query, setQuery] = useState('');
  const [selectedList, setSelectedList] = useState<ShareTarget[]>([]);
  const [extraMessage, setExtraMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedList([]);
      setExtraMessage('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const members: any[] = membersData?.data ?? [];
  const channels: any[] = channelsData?.data ?? [];
  const dms: any[] = dmsData?.data ?? [];

  // Combined search across WeldChat channels, group DMs, existing 1:1 DMs and
  // workspace people. Mirrors the "Forward this message" dialog. 1:1 DMs are
  // de-duplicated against people so the same person doesn't appear twice.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const selectedIds = new Set(selectedList.map((s) => s.id));

    const channelItems: ShareTarget[] = channels
      // The `/chat/channels` endpoint returns DMs too (type='dm'). Skip them
      // here — `useDmChannels` handles DMs separately so we can render the
      // other person's name + avatar instead of the empty channel name.
      .filter((ch) => ch.type !== 'dm')
      .filter((ch) => (q ? (ch.name || '').toLowerCase().includes(q) : true))
      .map((ch) => ({
        id: `channel:${ch.id}`,
        rawId: ch.id,
        name: ch.name,
        kind: (ch.isPrivate || ch.type === 'private'
          ? 'private'
          : ch.type === 'group'
            ? 'group'
            : 'channel') as 'private' | 'group' | 'channel',
      }));

    // DM channels — split into 1:1 (kind=user, posts straight to channel) and
    // group DMs (kind=group). Track the userIds of 1:1 partners so we can hide
    // them from the people list below to avoid duplicates.
    const oneOnOneUserIds = new Set<string>();
    const dmItems: ShareTarget[] = [];
    for (const dm of dms) {
      const otherMembers: any[] = dm.otherMembers ?? [];
      const isGroup = otherMembers.length > 1;
      if (isGroup) {
        const displayName =
          otherMembers.map((m: any) => m.name || m.email || st('sweep.weldcrm.contactDetailView.unknown')).join(', ') ||
          dm.name ||
          st('sweep.weldcrm.customerDetailHeader.group');
        if (q && !displayName.toLowerCase().includes(q)) continue;
        dmItems.push({
          id: `channel:${dm.id}`,
          rawId: dm.id,
          name: displayName,
          kind: 'group',
        });
      } else if (otherMembers.length === 1) {
        const other = otherMembers[0];
        const displayName = other?.name || other?.email || dm.name || st('sweep.weldcrm.customerDetailHeader.directMessage');
        if (other?.userId) oneOnOneUserIds.add(other.userId);
        if (q && !displayName.toLowerCase().includes(q)) continue;
        dmItems.push({
          id: `channel:${dm.id}`,
          rawId: dm.id,
          name: displayName,
          picture: other?.picture,
          kind: 'user',
        });
      }
    }

    const userItems: ShareTarget[] = members
      .filter((m) => {
        const userId = m.userId || m.id;
        if (oneOnOneUserIds.has(userId)) return false;
        const name = (m.name || m.email || '').toLowerCase();
        return q ? name.includes(q) : true;
      })
      .map((m) => ({
        id: `user:${m.userId || m.id}`,
        rawId: m.userId || m.id,
        name: m.name || m.email,
        picture: m.picture,
        kind: 'user' as const,
      }));

    return [...channelItems, ...dmItems, ...userItems]
      .filter((it) => !selectedIds.has(it.id))
      .slice(0, 30);
  }, [channels, dms, members, query, selectedList]);

  const handleSelect = (t: ShareTarget) => {
    setSelectedList((prev) => (prev.some((s) => s.id === t.id) ? prev : [...prev, t]));
    setQuery('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleRemove = (id: string) => {
    setSelectedList((prev) => prev.filter((s) => s.id !== id));
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const canShare = selectedList.length > 0 && !isSending;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(st('sweep.weldcrm.customerDetailHeader.linkCopied'));
    } catch {
      toast.error(st('sweep.weldcrm.customerDetailHeader.failedToCopyLink'));
    }
  };

  // Resolve each selected target to a channelId we can post into. Channels
  // (including existing DMs — their `id` starts with `channel:`) post
  // directly. Workspace people without an existing DM get one created on the
  // fly via `useCreateDm`.
  const resolveChannelIds = async (): Promise<string[]> => {
    const ids: string[] = [];
    for (const target of selectedList) {
      if (target.kind === 'user' && target.id.startsWith('user:')) {
        try {
          const dm = await createDm({ userIds: [target.rawId] });
          const dmId = (dm as any)?.data?.id || (dm as any)?.id;
          if (dmId) ids.push(dmId);
        } catch {
          toast.error(st('sweep.weldcrm.customerDetailHeader.couldNotOpenDm', { name: target.name }));
        }
      } else {
        // channel / private / group / existing 1:1 DM channel
        ids.push(target.rawId);
      }
    }
    return ids;
  };

  const handleShare = async () => {
    if (selectedList.length === 0) return;
    setIsSending(true);
    try {
      const targetChannelIds = await resolveChannelIds();
      if (targetChannelIds.length === 0) {
        toast.error(st('sweep.weldcrm.customerDetailHeader.noValidRecipients'));
        return;
      }
      const message = extraMessage.trim() ? `${extraMessage.trim()}\n${url}` : url;
      await Promise.all(
        targetChannelIds.map((channelId) => sendMessage({ channelId, content: message })),
      );
      toast.success(
        selectedList.length === 1
          ? st('sweep.weldcrm.customerDetailHeader.sharedWithOne', { name: selectedList[0].name })
          : st('sweep.weldcrm.customerDetailHeader.sharedWithMany', { count: selectedList.length }),
      );
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || st('sweep.weldcrm.customerDetailHeader.failedToShare'));
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden" showCloseButton={false}>
        {/* Header */}
        <DialogHeader className="flex flex-row items-center justify-between px-5 py-4">
          <DialogTitle className="text-base font-semibold">{st('sweep.weldcrm.customerDetailHeader.shareThisRecord')}</DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 -mr-1"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DialogHeader>

        <div className="px-5 pb-4 space-y-3">
          {/* Recipient picker — chips render inline INSIDE the input.
              Typing filters live; pressing Enter (or Tab) adds the first
              match as a chip. No dropdown row under the field. */}
          <div
            className={cn(
              'flex flex-wrap items-center gap-1.5 min-h-9 rounded-md border border-input bg-transparent dark:bg-input/30 px-2 py-1 text-sm transition-[color,box-shadow]',
              'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
            )}
            onClick={() => inputRef.current?.focus()}
          >
                {selectedList.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center gap-1 rounded bg-accent text-accent-foreground px-1.5 py-[4px] text-xs font-medium"
                  >
                    {t.kind === 'user' ? (
                      <Avatar className="h-3.5 w-3.5 !rounded-[4px]">
                        {t.picture && <AvatarImage src={t.picture} alt={t.name} className="!rounded-[4px]" />}
                        <AvatarFallback className="!rounded-[4px] text-[8px] font-medium bg-gray-200 dark:bg-background text-gray-600 dark:text-muted-foreground">
                          {(t.name || '?').charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    ) : t.kind === 'group' ? (
                      <UsersIcon className="h-3 w-3" />
                    ) : t.kind === 'private' ? (
                      <Lock className="h-3 w-3" />
                    ) : (
                      <Hash className="h-3 w-3" />
                    )}
                    {t.name}
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handleRemove(t.id);
                      }}
                      className="ml-0.5 rounded hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </span>
                ))}
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Backspace' && query === '' && selectedList.length > 0) {
                      e.preventDefault();
                      setSelectedList((prev) => prev.slice(0, -1));
                      return;
                    }
                    if ((e.key === 'Enter' || e.key === 'Tab') && query.trim() && matches.length > 0) {
                      e.preventDefault();
                      handleSelect(matches[0]);
                    }
                  }}
                  placeholder={selectedList.length === 0 ? st('sweep.weldcrm.customerDetailHeader.addByNamePlaceholder') : ''}
                  className="flex-1 min-w-[60px] bg-transparent outline-none placeholder:text-muted-foreground text-sm"
                />
          </div>

          {/* Message field — record being shared appears as a non-removable
              chip pinned at the start; the user types their message after it. */}
          <div className="rounded-md border border-input bg-transparent dark:bg-input/30 transition-[color,box-shadow] focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]">
            <div className="px-3 pt-2 flex flex-wrap items-start gap-1.5">
              <span className="inline-flex items-center gap-1.5 rounded bg-primary/10 text-primary px-1.5 py-[3px] text-xs font-medium flex-shrink-0">
                <Avatar className="h-3.5 w-3.5 !rounded-[4px]">
                  {recordAvatar && <AvatarImage src={recordAvatar} alt={recordTitle} className="!rounded-[4px]" />}
                  <AvatarFallback className="!rounded-[4px] text-[8px] font-semibold bg-primary/20 text-primary">
                    {(recordTitle || '?').charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate max-w-[140px]">{recordTitle}</span>
              </span>
            </div>
            <Textarea
              value={extraMessage}
              onChange={(e) => setExtraMessage(e.target.value)}
              placeholder={st('sweep.weldcrm.customerDetailHeader.addMessagePlaceholder')}
              rows={2}
              className="resize-none min-h-[40px] border-0 bg-transparent dark:bg-transparent focus-visible:ring-0 focus-visible:border-0 shadow-none pt-1"
            />
            <div className="flex items-center gap-0 px-2 pb-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={st('sweep.weldcrm.customerDetailHeader.addAttachment')}
                className={cn(
                  'p-1.5 rounded-lg transition-colors',
                  'text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent',
                )}
              >
                <Plus className="h-[18px] w-[18px]" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={st('sweep.weldcrm.customerDetailHeader.emoji')}
                className={cn(
                  'p-1.5 rounded-lg transition-colors',
                  'text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent',
                )}
              >
                <Smile className="h-[18px] w-[18px]" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={st('sweep.weldcrm.customerDetailHeader.mentionSomeone')}
                className={cn(
                  'p-1.5 rounded-lg transition-colors',
                  'text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent',
                )}
              >
                <AtSign className="h-[18px] w-[18px]" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={st('sweep.weldcrm.customerDetailHeader.formatting')}
                className={cn(
                  'p-1.5 rounded-lg transition-colors',
                  'text-gray-500 hover:text-gray-700 dark:text-muted-foreground dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-accent',
                )}
              >
                <Baseline className="h-[18px] w-[18px]" />
              </Button>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3">
          <Button variant="outline" onClick={handleCopyLink}>
            {st('sweep.weldcrm.customerDetailHeader.copyLinkButton')}
          </Button>
          <Button disabled={!canShare} onClick={handleShare}>
            {isSending ? st('sweep.weldcrm.customerDetailHeader.sharing') : st('sweep.weldcrm.customerDetailHeader.share')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
