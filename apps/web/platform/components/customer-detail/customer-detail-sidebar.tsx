
import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Mail,
  Phone,
  Globe,
  Building2,
  MapPin,
  Calendar,
  ChevronDown,
  Plus,
  MoreHorizontal,
  X,
  FileText,
  Copy,
  Pencil,
  Trash2,
  Upload,
  Check,
  ListCollapse,
  MessagesSquare,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { CustomFieldsSidebarSection } from '@/components/custom-fields/custom-fields-sidebar-section';
import { useCustomerDetailContext } from './customer-detail-provider';
import { useUpdateCompany } from '@/components/objects/company/use-company-data';
import { useTranslations } from '@weldsuite/i18n/client';

interface CustomerDetailSidebarProps {
  variant?: 'page' | 'panel';
}

interface Comment {
  id: string;
  text: string;
  date: string;
  author: string;
  isMe?: boolean;
  createdAt: number;
  editedAt?: number;
  attachments?: { name: string; size: string; url?: string; isImage?: boolean }[];
}

function getAvatarColor(name: string): string {
  const colors = [
    '#4F46E5', '#7C3AED', '#EC4899', '#EF4444', '#F97316',
    '#EAB308', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function CustomerDetailSidebar({ variant = 'page' }: CustomerDetailSidebarProps) {
  const t = useTranslations();
  const { data, sidebarTab, setSidebarTab, showSidebar, isLoading } = useCustomerDetailContext();
  const customer = data?.customer;

  const [commentsHeight, setCommentsHeight] = useState(250);
  const [showCommentInput, setShowCommentInput] = useState(true);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [isCommentMultiLine, setIsCommentMultiLine] = useState(false);

  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const commentsHeightRef = useRef(commentsHeight);
  const commentFileInputRef = useRef<HTMLInputElement>(null);
  const [commentAttachments, setCommentAttachments] = useState<{ name: string; size: string; file: File; url?: string; isImage?: boolean }[]>([]);

  useEffect(() => {
    commentsHeightRef.current = commentsHeight;
  }, [commentsHeight]);

  const autoResizeCommentInput = () => {
    const textarea = commentInputRef.current;
    if (textarea) {
      textarea.style.height = '24px';
      const maxHeight = 120;
      const newHeight = Math.min(textarea.scrollHeight, maxHeight);
      textarea.style.height = `${newHeight}px`;
      textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
      setIsCommentMultiLine(newHeight > 24);
    }
  };

  const handleAddComment = () => {
    if (!newComment.trim() && commentAttachments.length === 0) return;

    const comment: Comment = {
      id: Date.now().toString(),
      text: newComment.trim(),
      date: new Date().toLocaleString(),
      author: t('sweep.weldcrm.notesView.you'),
      isMe: true,
      createdAt: Date.now(),
      attachments: commentAttachments.length > 0 ? commentAttachments.map(a => ({ name: a.name, size: a.size, url: a.url, isImage: a.isImage })) : undefined,
    };
    setComments(prev => [...prev, comment]);
    setNewComment('');
    setCommentAttachments([]);
    setIsCommentMultiLine(false);
    if (commentInputRef.current) {
      commentInputRef.current.style.height = '24px';
      commentInputRef.current.style.overflowY = 'hidden';
    }
  };

  const handleSaveEdit = (commentId: string) => {
    if (!editingText.trim()) return;
    setComments(prev => prev.map(c =>
      c.id === commentId
        ? { ...c, text: editingText.trim(), editedAt: Date.now() }
        : c
    ));
    setEditingCommentId(null);
    setEditingText('');
  };

  const canEditComment = (createdAt: number) => {
    const fifteenMinutes = 15 * 60 * 1000;
    return Date.now() - createdAt < fifteenMinutes;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const isImageFile = (fileName: string) => {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
    return imageExtensions.some(ext => fileName.toLowerCase().endsWith(ext));
  };

  const handleCommentFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles) return;

    const newAttachments = Array.from(uploadedFiles).map(file => {
      const isImage = isImageFile(file.name);
      return {
        name: file.name,
        size: formatFileSize(file.size),
        file,
        url: isImage ? URL.createObjectURL(file) : undefined,
        isImage,
      };
    });
    setCommentAttachments(prev => [...prev, ...newAttachments]);
    if (commentFileInputRef.current) commentFileInputRef.current.value = '';
  };

  const removeCommentAttachment = (index: number) => {
    setCommentAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = commentsHeightRef.current;
    const maxHeight = window.innerHeight - 200;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.min(Math.max(startHeight + deltaY, 100), maxHeight);
      setCommentsHeight(newHeight);
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // Panel variant - comments section only
  if (variant === 'panel') {
    return (
      <div className="bg-background" style={{ flexShrink: 0 }}>
        {/* Draggable resize handle */}
        <div
          className="h-5 cursor-ns-resize flex items-center justify-center group"
          onMouseDown={handleResizeStart}
        >
          <div className="w-full h-px bg-border group-hover:bg-muted-foreground/50 transition-colors" />
        </div>

        <div className="flex items-center justify-between px-4 pt-[7px] pb-3 border-b">
          <span className="text-sm font-medium text-foreground">{t('sweep.weldcrm.contactDetailView.comments')}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowCommentInput(!showCommentInput)}
          >
            <ChevronDown className={cn(
              "h-4 w-4 transition-transform duration-200",
              !showCommentInput && "rotate-180"
            )} />
          </Button>
        </div>

        {showCommentInput && (
          <CommentsContent
            commentsHeight={commentsHeight}
            comments={comments}
            setComments={setComments}
            newComment={newComment}
            setNewComment={setNewComment}
            editingCommentId={editingCommentId}
            setEditingCommentId={setEditingCommentId}
            editingText={editingText}
            setEditingText={setEditingText}
            isCommentMultiLine={isCommentMultiLine}
            commentInputRef={commentInputRef}
            commentFileInputRef={commentFileInputRef}
            commentAttachments={commentAttachments}
            handleAddComment={handleAddComment}
            handleSaveEdit={handleSaveEdit}
            canEditComment={canEditComment}
            autoResizeCommentInput={autoResizeCommentInput}
            handleCommentFileUpload={handleCommentFileUpload}
            removeCommentAttachment={removeCommentAttachment}
          />
        )}
      </div>
    );
  }

  // Don't render page sidebar if disabled
  if (!showSidebar) return null;

  // Page variant - full sidebar with tabs
  return (
    <div className="w-[750px] border-l border-border bg-background flex flex-col">
      {/* Sidebar Tabs */}
      <div className="flex items-center gap-1 py-2 px-4 border-b border-border">
        <Button
          variant="ghost"
          onClick={() => setSidebarTab('details')}
          className={cn(
            "relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors",
            sidebarTab === 'details'
              ? "bg-muted/50 border border-border text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {sidebarTab === 'details' && (
            <span className="absolute -bottom-[10px] left-0 right-0 h-[1.5px] bg-foreground" />
          )}
          <ListCollapse className="h-3.5 w-3.5" />
          {t('sweep.weldcrm.customerDetailTabs.details')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setSidebarTab('comments')}
          className={cn(
            "relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors",
            sidebarTab === 'comments'
              ? "bg-muted/50 border border-border text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {sidebarTab === 'comments' && (
            <span className="absolute -bottom-[10px] left-0 right-0 h-[1.5px] bg-foreground" />
          )}
          <MessagesSquare className="h-3.5 w-3.5" />
          {t('sweep.weldcrm.contactDetailView.comments')}
          {comments.length > 0 && (
            <span className="text-[10px] font-mono text-muted-foreground bg-muted border border-border min-w-[15px] h-[15px] flex items-center justify-center rounded-[5px] px-1">
              <span className="translate-y-[1px]">{comments.length}</span>
            </span>
          )}
        </Button>
      </div>

      {/* Sidebar Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {sidebarTab === 'details' ? (
          <CustomerDetailsContent customer={customer} />
        ) : (
          <div className="flex flex-col h-full">
            <CommentsContent
              commentsHeight={Math.min(commentsHeight, 400)}
              comments={comments}
              setComments={setComments}
              newComment={newComment}
              setNewComment={setNewComment}
              editingCommentId={editingCommentId}
              setEditingCommentId={setEditingCommentId}
              editingText={editingText}
              setEditingText={setEditingText}
              isCommentMultiLine={isCommentMultiLine}
              commentInputRef={commentInputRef}
              commentFileInputRef={commentFileInputRef}
              commentAttachments={commentAttachments}
              handleAddComment={handleAddComment}
              handleSaveEdit={handleSaveEdit}
              canEditComment={canEditComment}
              autoResizeCommentInput={autoResizeCommentInput}
              handleCommentFileUpload={handleCommentFileUpload}
              removeCommentAttachment={removeCommentAttachment}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Editable contact field with clickable link
 * - Clicking the blue link text triggers the link action (mailto/tel/navigate)
 * - Clicking anywhere else in the row enters inline edit mode
 */
function EditableContactField({
  icon: Icon,
  value,
  href,
  target,
  fieldKey,
  customerId,
  onSaved,
  suffix,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  href: string;
  target?: string;
  fieldKey: string;
  customerId: string;
  onSaved: () => void;
  suffix?: string;
}) {
  const t = useTranslations();
  const updateCustomerMutation = useUpdateCompany();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const linkClickedRef = useRef(false);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = async () => {
    const trimmed = editValue.trim();
    if (trimmed === value) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    try {
      const result = await updateCustomerMutation.mutateAsync({ id: customerId, data: { [fieldKey]: trimmed } as any });
      if (result.data) {
        onSaved();
        setIsEditing(false);
      } else {
        toast.error((result as any).error || t('sweep.weldcrm.customerDetailSidebar.failedToUpdate'));
      }
    } catch {
      toast.error(t('sweep.weldcrm.customerDetailSidebar.failedToUpdate'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditValue(value);
    setIsEditing(false);
  };

  // Handle link click: open the link manually to have full control
  const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    linkClickedRef.current = true;

    if (target === '_blank') {
      window.open(href, '_blank', 'noopener,noreferrer');
    } else {
      window.location.href = href;
    }
  };

  // Handle link mousedown: mark that a link click is in progress
  const handleLinkMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    linkClickedRef.current = true;
    // Reset flag after a short delay
    setTimeout(() => { linkClickedRef.current = false; }, 300);
  };

  // Handle row click: only enter edit mode if the link was NOT clicked
  const handleRowClick = (e: React.MouseEvent) => {
    if (linkClickedRef.current) {
      linkClickedRef.current = false;
      return;
    }
    // Double-check: if the click target is inside an <a> tag, don't edit
    const target = e.target as HTMLElement;
    if (target.tagName === 'A' || target.closest('a')) {
      return;
    }
    setIsEditing(true);
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-3">
        <Icon className="h-4 w-4 text-gray-400 flex-shrink-0" />
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') handleCancel();
            }}
            onBlur={handleCancel}
            disabled={isSaving}
            className="flex-1 min-w-0 text-sm bg-white dark:bg-background border border-gray-200 dark:border-border rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <Button
            variant="ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleSave}
            disabled={isSaving}
            className="p-0.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-colors"
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleCancel}
            className="p-0.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-secondary rounded transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-3 rounded -mx-1 px-1 cursor-text hover:bg-gray-50 dark:hover:bg-secondary/50 transition-colors"
      onClick={handleRowClick}
    >
      <Icon className="h-4 w-4 text-gray-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <a
          href={href}
          target={target}
          rel={target === '_blank' ? 'noopener noreferrer' : undefined}
          className="text-sm text-blue-600 hover:underline cursor-pointer outline-none focus:outline-none"
          style={{ pointerEvents: 'auto' }}
          onClick={handleLinkClick}
          onMouseDown={handleLinkMouseDown}
        >
          {value}{suffix}
        </a>
      </div>
    </div>
  );
}

/**
 * Customer details content
 */
function CustomerDetailsContent({ customer }: { customer: any }) {
  const t = useTranslations();
  const { silentRefresh } = useCustomerDetailContext();
  const updateCustomerMutation = useUpdateCompany();

  if (!customer) return null;

  const isB2B = customer.type?.toLowerCase() === 'b2b';

  const handleSaved = useCallback(() => {
    silentRefresh();
  }, [silentRefresh]);

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatAddress = (address: any) => {
    if (!address) return null;
    const parts = [
      address.line1,
      address.line2,
      address.city,
      address.state,
      address.postalCode,
      address.country,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  };

  return (
    <div className="space-y-4">
      {/* Contact Info */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">{t('sweep.weldcrm.customerDetailSidebar.contactInformation')}</h3>

        <div className="flex items-center gap-3">
          <Mail className="h-4 w-4 text-muted-foreground" />
          {customer.email ? (
            <a href={`mailto:${customer.email}`} className="text-sm text-blue-600 hover:underline">
              {customer.email}
            </a>
          ) : (
            <span className="text-sm text-muted-foreground">--</span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Phone className="h-4 w-4 text-muted-foreground" />
          {customer.phone ? (
            <a href={`tel:${customer.phone}`} className="text-sm text-foreground">
              {customer.phone}
            </a>
          ) : (
            <span className="text-sm text-muted-foreground">--</span>
          )}
        </div>

        {customer.mobile && customer.mobile !== customer.phone && (
          <div className="flex items-center gap-3">
            <Phone className="h-4 w-4 text-muted-foreground" />
            <a href={`tel:${customer.mobile}`} className="text-sm text-foreground">
              {t('sweep.weldcrm.customerDetailSidebar.mobileSuffix', { number: customer.mobile })}
            </a>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Globe className="h-4 w-4 text-muted-foreground" />
          {customer.website ? (
            <a href={customer.website} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline">
              {customer.website}
            </a>
          ) : (
            <span className="text-sm text-muted-foreground">--</span>
          )}
        </div>
      </div>

      {/* Company Info (B2B) */}
      {isB2B && (
        <div className="space-y-3 pt-4 border-t border-border">
          <h3 className="text-sm font-medium text-foreground">{t('sweep.weldcrm.customerDetailSidebar.companyDetails')}</h3>

          <div className="flex items-center gap-3">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span className={cn("text-sm", customer.companyName ? "text-foreground" : "text-muted-foreground")}>{customer.companyName || '--'}</span>
          </div>

          <div className="flex items-start gap-3">
            <span className="text-sm text-muted-foreground w-24">{t('sweep.weldcrm.customerDetailSidebar.industry')}</span>
            <span className={cn("text-sm", customer.industry ? "text-foreground" : "text-muted-foreground")}>{customer.industry || '--'}</span>
          </div>

          <div className="flex items-start gap-3">
            <span className="text-sm text-muted-foreground w-24">{t('sweep.weldcrm.customerDetailSidebar.vatNumber')}</span>
            <span className={cn("text-sm", customer.vatNumber ? "text-foreground" : "text-muted-foreground")}>{customer.vatNumber || '--'}</span>
          </div>

          <div className="flex items-start gap-3">
            <span className="text-sm text-muted-foreground w-24">{t('sweep.weldcrm.customerDetailSidebar.regNumber')}</span>
            <span className={cn("text-sm", customer.registrationNumber ? "text-foreground" : "text-muted-foreground")}>{customer.registrationNumber || '--'}</span>
          </div>
        </div>
      )}

      {/* Address */}
      {(formatAddress(customer.billingAddress) || formatAddress(customer.shippingAddress)) && (
        <div className="space-y-3 pt-4 border-t border-border">
          <h3 className="text-sm font-medium text-foreground">{t('sweep.weldcrm.customerDetailSidebar.addresses')}</h3>

          {formatAddress(customer.billingAddress) && (
            <div className="flex items-start gap-3">
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
              <div>
                <span className="text-xs text-muted-foreground block mb-1">{t('sweep.weldcrm.customerDetailSidebar.billing')}</span>
                <span className="text-sm text-foreground">
                  {formatAddress(customer.billingAddress)}
                </span>
              </div>
            </div>
          )}

          {formatAddress(customer.shippingAddress) && (
            <div className="flex items-start gap-3">
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
              <div>
                <span className="text-xs text-muted-foreground block mb-1">{t('sweep.weldcrm.customerDetailSidebar.shipping')}</span>
                <span className="text-sm text-foreground">
                  {formatAddress(customer.shippingAddress)}
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Additional Info */}
      <div className="space-y-3 pt-4 border-t border-border">
        <h3 className="text-sm font-medium text-foreground">{t('sweep.weldcrm.customerDetailSidebar.additionalInformation')}</h3>

        <div className="flex items-start gap-3">
          <span className="text-sm text-muted-foreground w-24">{t('sweep.weldcrm.customerDetailSidebar.status')}</span>
          <span className={cn(
            "text-xs px-2 py-0.5 rounded-full",
            customer.status === 'active' ? "bg-green-100 text-green-700" :
            customer.status === 'prospect' ? "bg-blue-100 text-blue-700" :
            "bg-muted text-foreground"
          )}>
            {customer.status || t('sweep.weldcrm.customerDetailSidebar.unknown')}
          </span>
        </div>

        <div className="flex items-start gap-3">
          <span className="text-sm text-muted-foreground w-24">{t('sweep.weldcrm.customerDetailSidebar.segment')}</span>
          <span className={cn("text-sm", customer.segment ? "text-foreground" : "text-muted-foreground")}>{customer.segment || '--'}</span>
        </div>

        <div className="flex items-start gap-3">
          <span className="text-sm text-muted-foreground w-24">{t('sweep.weldcrm.customerDetailSidebar.source')}</span>
          <span className={cn("text-sm", customer.source ? "text-foreground" : "text-muted-foreground")}>{customer.source || '--'}</span>
        </div>

        <div className="flex items-center gap-3">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t('sweep.weldcrm.customerDetailSidebar.created', { date: formatDate(customer.createdAt) })}</span>
        </div>

        {/* Custom Fields - inline within Record Details */}
        <CustomFieldsSidebarSection
          entityType="company"
          values={customer.customFields}
          onSave={async (next) => {
            await updateCustomerMutation.mutateAsync({
              id: customer.id,
              data: { customFields: next } as any,
            });
          }}
          onSaved={handleSaved}
          hideHeader
        />
      </div>

      {/* Notes */}
      {customer.notes && (
        <div className="space-y-2 pt-4 border-t border-border">
          <h3 className="text-sm font-medium text-foreground">{t('sweep.weldcrm.contactDetailView.notes')}</h3>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {customer.notes}
          </p>
        </div>
      )}

      {/* Tags */}
      {customer.tags && customer.tags.length > 0 && (
        <div className="space-y-2 pt-4 border-t border-border">
          <h3 className="text-sm font-medium text-foreground">{t('sweep.weldcrm.contactDetailView.tags')}</h3>
          <div className="flex flex-wrap gap-1.5">
            {customer.tags.map((tag: string, index: number) => (
              <span
                key={index}
                className="text-xs px-2 py-0.5 bg-muted text-foreground rounded"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Comments content (shared between variants)
 */
function CommentsContent({
  commentsHeight,
  comments,
  setComments,
  newComment,
  setNewComment,
  editingCommentId,
  setEditingCommentId,
  editingText,
  setEditingText,
  isCommentMultiLine,
  commentInputRef,
  commentFileInputRef,
  commentAttachments,
  handleAddComment,
  handleSaveEdit,
  canEditComment,
  autoResizeCommentInput,
  handleCommentFileUpload,
  removeCommentAttachment,
}: {
  commentsHeight: number;
  comments: Comment[];
  setComments: React.Dispatch<React.SetStateAction<Comment[]>>;
  newComment: string;
  setNewComment: React.Dispatch<React.SetStateAction<string>>;
  editingCommentId: string | null;
  setEditingCommentId: React.Dispatch<React.SetStateAction<string | null>>;
  editingText: string;
  setEditingText: React.Dispatch<React.SetStateAction<string>>;
  isCommentMultiLine: boolean;
  commentInputRef: React.RefObject<HTMLTextAreaElement>;
  commentFileInputRef: React.RefObject<HTMLInputElement>;
  commentAttachments: { name: string; size: string; file: File; url?: string; isImage?: boolean }[];
  handleAddComment: () => void;
  handleSaveEdit: (commentId: string) => void;
  canEditComment: (createdAt: number) => boolean;
  autoResizeCommentInput: () => void;
  handleCommentFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  removeCommentAttachment: (index: number) => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col" style={{ height: `${commentsHeight}px` }}>
      {/* Comments List */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        {comments.length > 0 ? (
          <div className="space-y-3">
            {comments.map((comment) => {
              const isMe = !!comment.isMe;
              return (
                <div key={comment.id} className={cn("flex items-end gap-2", isMe && "flex-row-reverse")}>
                  {!isMe && (
                    <div
                      className="w-6 h-6 rounded-md flex items-center justify-center text-white font-medium text-xs flex-shrink-0"
                      style={{ backgroundColor: getAvatarColor(comment.author) }}
                    >
                      {comment.author.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className={cn(
                    "max-w-[85%] p-3 bg-muted rounded-2xl group relative",
                    isMe ? "rounded-br-md" : "rounded-bl-md"
                  )}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{comment.author}</span>
                      <div className="flex items-center gap-2">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" className="opacity-0 group-hover:opacity-100 p-1 hover:bg-muted rounded-md transition-opacity">
                              <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-36">
                            <DropdownMenuItem
                              onClick={() => {
                                navigator.clipboard.writeText(comment.text);
                                toast.success(t('sweep.weldcrm.customerDetailSidebar.copiedToClipboard'));
                              }}
                            >
                              <Copy className="h-3.5 w-3.5 mr-1.5" />
                              {t('sweep.weldcrm.customerDetailSidebar.copy')}
                            </DropdownMenuItem>
                            {canEditComment(comment.createdAt) && (
                              <DropdownMenuItem
                                onClick={() => {
                                  setEditingCommentId(comment.id);
                                  setEditingText(comment.text);
                                }}
                              >
                                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                                {t('sweep.weldcrm.customerDetailSidebar.edit')}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-red-600 dark:text-red-400"
                              onClick={() => setComments(prev => prev.filter(c => c.id !== comment.id))}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                              {t('sweep.weldcrm.customerDetailSidebar.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <span className="text-xs text-muted-foreground">{comment.date}</span>
                      </div>
                    </div>
                    {editingCommentId === comment.id ? (
                      <div className="space-y-2">
                        <textarea
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          className="w-full text-sm bg-background border border-border rounded-md p-2 resize-none focus:outline-none focus:ring-1"
                          rows={3}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              handleSaveEdit(comment.id);
                            }
                            if (e.key === 'Escape') {
                              setEditingCommentId(null);
                              setEditingText('');
                            }
                          }}
                        />
                        <div className="flex gap-2 justify-end">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              setEditingCommentId(null);
                              setEditingText('');
                            }}
                          >
                            {t('sweep.weldcrm.customerDetailSidebar.cancel')}
                          </Button>
                          <Button size="sm" className="h-7 text-xs" onClick={() => handleSaveEdit(comment.id)}>
                            {t('sweep.weldcrm.customerDetailSidebar.save')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">
                        {comment.text}
                        {comment.editedAt && <span className="text-xs text-muted-foreground ml-1.5">{t('sweep.weldcrm.customerDetailSidebar.edited')}</span>}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground text-center py-4">{t('sweep.weldcrm.contactDetailView.noCommentsYet')}</div>
        )}
      </div>

      {/* Comment Input */}
      <div className="px-4 pt-3 pb-4">
        {commentAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {commentAttachments.map((attachment, index) => (
              <div key={index} className="flex items-center gap-2 bg-muted rounded-lg px-3 py-1.5 text-sm">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-foreground max-w-[150px] truncate">{attachment.name}</span>
                <span className="text-xs text-muted-foreground">{attachment.size}</span>
                <Button variant="ghost" onClick={() => removeCommentAttachment(index)} className="p-0.5 hover:bg-muted rounded">
                  <X className="h-3 w-3 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <input
          type="file"
          ref={commentFileInputRef}
          onChange={handleCommentFileUpload}
          className="hidden"
          multiple
        />
        <div className="flex items-end gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                type="button"
                className="w-[46px] h-[46px] rounded-full bg-muted hover:bg-muted flex items-center justify-center flex-shrink-0 transition-colors self-end"
              >
                <Plus className="h-5 w-5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              <DropdownMenuItem onClick={() => commentFileInputRef.current?.click()}>
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                {t('sweep.weldcrm.customerDetailSidebar.uploadFile')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className={cn(
            "flex-1 min-w-0 flex bg-muted rounded-[23px] pl-4 pr-2 min-h-[46px]",
            isCommentMultiLine ? "items-end py-[11px]" : "items-center"
          )}>
            <textarea
              ref={commentInputRef}
              placeholder={t('sweep.weldcrm.contactDetailView.addCommentPlaceholder')}
              value={newComment}
              onChange={(e) => {
                setNewComment(e.target.value);
                autoResizeCommentInput();
              }}
              className="flex-1 min-w-0 bg-transparent outline-none text-sm placeholder-muted-foreground resize-none overflow-hidden"
              style={{ height: '24px', lineHeight: '24px' }}
              rows={1}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAddComment();
                }
              }}
            />
            <Button
              variant="ghost"
              type="button"
              onClick={handleAddComment}
              disabled={!newComment.trim() && commentAttachments.length === 0}
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ml-4",
                (newComment.trim() || commentAttachments.length > 0)
                  ? "bg-foreground text-background hover:bg-foreground/90"
                  : "bg-border text-muted-foreground cursor-not-allowed"
              )}
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
