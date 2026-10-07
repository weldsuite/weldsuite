/**
 * ContactDetailView — Helpdesk contact detail page
 *
 * Same layout as CustomerDetailView but purpose-built for contacts.
 * Fetches data from helpdesk API routes and shows contact-relevant fields only.
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from 'react';
import {
  User, Mail, Phone, Smartphone, Minimize, Maximize, Loader2, X,
  LayoutGrid, MessageSquare, FileText, Globe, MapPin, Type, Tag,
  ChevronDown, ChevronRight, SquareActivity, ListCollapse, MessagesSquare,
  AtSign, ArrowUp, Users, Camera,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import {
  useHelpdeskContactDetailData,
  useUpdateHelpdeskContact,
} from '@/hooks/queries/use-helpdesk-queries';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import {
  useCustomerComments,
  useCreateCustomerComment,
} from '@/hooks/queries/use-customer-notes-queries';
import { useUser } from '@clerk/clerk-react';
import { useFileUpload } from '@/hooks/use-file-upload';
import { useDrawerFieldVisibility } from '@/hooks/use-drawer-field-visibility';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import { useTranslations } from '@weldsuite/i18n/client';

// =============================================================================
// Types
// =============================================================================

type ContactTab = 'overview' | 'conversations';
type SidebarTab = 'details' | 'comments';

/**
 * `GET /helpdesk-contacts/:id` — `useHelpdeskContactDetailData` types this
 * `any` at the hook layer; narrow it here to just the fields this view reads.
 */
interface HelpdeskContactRow {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
  directPhone?: string | null;
  mobilePhone?: string | null;
  status?: string | null;
  notes?: string | null;
  interests?: string[] | null;
  avatarUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface ContactDetailData {
  contact: HelpdeskContactRow;
  conversations: Helpdesk.Conversation[];
  fullName: string;
}

interface ContactDetailContextValue {
  data: ContactDetailData | null;
  isLoading: boolean;
  activeTab: ContactTab;
  setActiveTab: (tab: ContactTab) => void;
  sidebarTab: SidebarTab;
  setSidebarTab: (tab: SidebarTab) => void;
  refresh: () => void;
  contactId: string;
  onClose?: () => void;
  onToggleExpand?: () => void;
  isExpanded?: boolean;
  mode: 'embedded' | 'page';
  visitorLocation?: { city?: string; region?: string; country?: string; timezone?: string } | null;
}

// =============================================================================
// Context + Provider
// =============================================================================

const ContactDetailContext = createContext<ContactDetailContextValue | null>(null);

function useContactDetailContext() {
  const ctx = useContext(ContactDetailContext);
  if (!ctx) throw new Error('useContactDetailContext must be used within ContactDetailProvider');
  return ctx;
}

function ContactDetailProvider({
  children,
  contactId,
  defaultTab = 'overview',
  mode = 'page',
  onClose,
  onToggleExpand,
  isExpanded,
  visitorLocation,
}: Readonly<{
  children: ReactNode;
  contactId: string;
  defaultTab?: ContactTab;
  mode?: 'embedded' | 'page';
  onClose?: () => void;
  onToggleExpand?: () => void;
  isExpanded?: boolean;
  visitorLocation?: { city?: string; region?: string; country?: string; timezone?: string } | null;
}>) {
  const t = useTranslations();
  const { data: raw, isLoading, refetch } = useHelpdeskContactDetailData(contactId);
  const [activeTab, setActiveTab] = useState<ContactTab>(defaultTab);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('details');

  const data = useMemo((): ContactDetailData | null => {
    const contact: HelpdeskContactRow | null = raw?.contactResult?.success
      ? (raw.contactResult.data as unknown as HelpdeskContactRow)
      : null;
    if (!contact) return null;
    const conversations: Helpdesk.Conversation[] =
      raw?.conversationsResult?.success && Array.isArray(raw.conversationsResult.data)
        ? (raw.conversationsResult.data as Helpdesk.Conversation[])
        : [];
    const fullName = contact.fullName || `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || t('sweep.weldcrm.contactDetailView.unknown');
    return { contact, conversations, fullName };
  }, [raw, t]);

  const value = useMemo(() => ({
    data, isLoading, activeTab, setActiveTab, sidebarTab, setSidebarTab,
    refresh: () => { void refetch(); },
    contactId, onClose, onToggleExpand, isExpanded, mode, visitorLocation,
  }), [data, isLoading, activeTab, setActiveTab, sidebarTab, setSidebarTab, refetch, contactId, onClose, onToggleExpand, isExpanded, mode, visitorLocation]);

  return (
    <ContactDetailContext.Provider value={value}>
      {children}
    </ContactDetailContext.Provider>
  );
}

// =============================================================================
// Header (matches CustomerDetailHeader panel variant)
// =============================================================================

function ContactDetailHeader() {
  const t = useTranslations();
  const { data, isLoading, onClose, onToggleExpand, isExpanded, mode, contactId, refresh } = useContactDetailContext();
  const updateMutation = useUpdateHelpdeskContact();
  const { fields: visFields, fieldVisibility, toggleField, resetToDefaults } = useDrawerFieldVisibility('helpdesk-contact-detail');
  const isDataReady = !isLoading && !!data;
  const contactName = data?.fullName || '';

  // Avatar upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(data?.contact?.avatarUrl || null);
  const { uploadFile, isUploading } = useFileUpload({
    folder: 'avatars',
    entityType: 'contact-avatar',
    entityId: contactId,
    isPublic: true,
    maxFileSize: 5 * 1024 * 1024,
    allowedTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
    onSuccess: async (file) => {
      setAvatarUrl(file.url);
      try {
        await updateMutation.mutateAsync({ id: contactId, data: { avatarUrl: file.url } });
        toast.success(t('sweep.weldcrm.contactDetailView.avatarUpdated'));
        refresh();
      } catch {
        toast.error(t('sweep.weldcrm.contactDetailView.failedToSaveAvatar'));
      }
    },
    onError: (err) => {
      toast.error(err);
    },
  });

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  useEffect(() => {
    if (data?.contact?.avatarUrl) {
      setAvatarUrl(data.contact.avatarUrl);
    }
  }, [data?.contact?.avatarUrl]);

  return (
    <div className="flex items-center justify-between px-3 md:px-4 py-[12.5px] flex-shrink-0">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
          className="hidden"
          onChange={handleAvatarFileChange}
        />
        <div className="flex items-center gap-2 min-w-0">
          {isDataReady ? (
            <>
              <Button
                variant="ghost"
                onClick={handleAvatarClick}
                disabled={isUploading}
                className="relative w-7 h-7 rounded-lg flex-shrink-0 group overflow-hidden"
                title={t('sweep.weldcrm.contactDetailView.uploadAvatar')}
              >
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={contactName}
                    className="w-full h-full object-cover rounded-lg"
                  />
                ) : (
                  <div className="w-full h-full rounded-lg bg-emerald-100 dark:bg-emerald-900 flex items-center justify-center">
                    <User className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
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
              <h1 className="text-[15px] font-medium text-foreground truncate max-w-[200px]">
                {contactName}
              </h1>
            </>
          ) : (
            <>
              <div className="w-7 h-7 rounded-lg bg-muted animate-pulse flex-shrink-0" />
              <div className="h-4 w-32 rounded bg-muted animate-pulse" />
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-0.5 md:gap-1 flex-shrink-0">
        {data?.contact?.email && (
          <a href={`mailto:${data.contact.email}`} className="p-1.5 hover:bg-muted rounded-md transition-colors" title={t('sweep.weldcrm.contactDetailView.composeEmail')}>
            <Mail className="h-4 w-4 text-gray-500" />
          </a>
        )}
        {(data?.contact?.directPhone || data?.contact?.mobilePhone) && (
          <a href={`tel:${data.contact.directPhone || data.contact.mobilePhone}`} className="p-1.5 hover:bg-muted rounded-md transition-colors" title={t('sweep.weldcrm.contactDetailView.call')}>
            <Phone className="h-4 w-4 text-gray-500" />
          </a>
        )}
        <DrawerFieldSettings
          fields={visFields}
          fieldVisibility={fieldVisibility}
          onToggle={toggleField}
          onReset={resetToDefaults}
        />
        {onToggleExpand && (
          <Button variant="ghost" size="icon" className="p-1.5 hover:bg-muted rounded-md transition-colors" onClick={onToggleExpand} title={isExpanded ? t('sweep.weldcrm.globalPinnedNote.minimize') : t('sweep.weldcrm.globalPinnedNote.expand')}>
            {isExpanded ? <Minimize className="h-4 w-4 text-gray-500" /> : <Maximize className="h-4 w-4 text-gray-500" />}
          </Button>
        )}
        {!(mode === 'embedded' && !onClose) && onClose && (
          <Button variant="ghost" size="icon" className="p-1.5 hover:bg-muted rounded-md transition-colors" onClick={onClose} title={t('sweep.weldcrm.globalPinnedNote.close')}>
            <X className="h-4 w-4 text-gray-500" />
          </Button>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Tabs
// =============================================================================

function ContactDetailTabs() {
  const t = useTranslations();
  const { activeTab, setActiveTab, data } = useContactDetailContext();
  const tabConfig: PageTab[] = [
    { id: 'overview', label: t('sweep.weldcrm.contactDetailView.overview'), icon: LayoutGrid },
    { id: 'conversations', label: t('sweep.weldcrm.contactDetailView.conversations'), icon: MessageSquare },
  ];
  const tabs: PageTab[] = tabConfig.map(tab =>
    tab.id === 'conversations' ? { ...tab, count: data?.conversations.length } : tab
  );
  return (
    <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={(id) => setActiveTab(id as ContactTab)} innerClassName="px-4 pt-1" />
  );
}

// =============================================================================
// Editable contact fields (same Input style as CRM sidebar)
// =============================================================================

type ContactUpdatePayload = {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  notes?: string;
};

function getOriginalContactFieldValue(contact: HelpdeskContactRow | null | undefined, key: string): string {
  switch (key) {
    case 'firstName': return contact?.firstName || '';
    case 'lastName': return contact?.lastName || '';
    case 'email': return contact?.email || '';
    case 'phone': return contact?.directPhone || '';
    case 'mobile': return contact?.mobilePhone || '';
    case 'notes': return contact?.notes || '';
    default: return '';
  }
}

/** Maps an edited field to its update payload; `null` for fields that are not persisted here. */
function buildContactUpdatePayload(key: string, value: string): ContactUpdatePayload | null {
  switch (key) {
    case 'firstName': return { firstName: value };
    case 'lastName': return { lastName: value };
    case 'email': return { email: value || undefined };
    case 'phone': return { phone: value || undefined };
    case 'notes': return { notes: value || undefined };
    default: return null;
  }
}

function ContactFieldRow({
  icon: Icon,
  label,
  fieldKey,
  value,
  onChange,
  onBlur,
}: Readonly<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  fieldKey: string;
  value: string;
  onChange: (key: string, value: string) => void;
  onBlur: (key: string, value: string) => void;
}>) {
  const t = useTranslations();
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 w-32 flex-shrink-0">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(fieldKey, e.target.value)}
        onBlur={(e) => onBlur(fieldKey, e.target.value)}
        placeholder={t('sweep.weldcrm.contactDetailView.emptyValuePlaceholder')}
        className={cn(
          'flex-1 h-8 text-sm border border-transparent bg-transparent dark:bg-transparent shadow-none',
          'focus-visible:ring-0 focus-visible:border-blue-500 dark:focus-visible:border-blue-500',
          'focus-visible:bg-white dark:focus-visible:bg-gray-900 rounded-md px-2 -mx-2',
          'placeholder:text-muted-foreground transition-colors truncate',
          (fieldKey === 'phone' || fieldKey === 'email') && value && 'text-blue-600 dark:text-blue-400 underline cursor-pointer'
        )}
      />
    </div>
  );
}

function VisitorLocationRows({
  location,
  showLocation,
  showTimezone,
}: Readonly<{
  location: { city?: string; region?: string; country?: string; timezone?: string };
  showLocation: boolean;
  showTimezone: boolean;
}>) {
  const t = useTranslations();
  return (
    <>
      {showLocation && location.city && (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 w-32 flex-shrink-0">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{t('sweep.weldcrm.contactDetailView.location')}</span>
          </div>
          <span className="text-sm text-foreground h-8 flex items-center">
            {[location.city, location.region, location.country].filter(Boolean).join(', ')}
          </span>
        </div>
      )}
      {showTimezone && location.timezone && (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 w-32 flex-shrink-0">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{t('sweep.weldcrm.contactDetailView.timezone')}</span>
          </div>
          <span className="text-sm text-foreground h-8 flex items-center">{location.timezone}</span>
        </div>
      )}
    </>
  );
}

function ContactTagsRow({ interests }: Readonly<{ interests: string[] | null | undefined }>) {
  const t = useTranslations();
  if (!interests || interests.length === 0) return null;
  return (
    <div className="flex items-start gap-3 pt-1">
      <div className="flex items-center gap-2 w-32 flex-shrink-0 h-8">
        <Tag className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('sweep.weldcrm.contactDetailView.tags')}</span>
      </div>
      <div className="flex flex-wrap gap-1 py-1">
        {interests.map((tag: string) => (
          <span key={tag} className="text-xs px-1.5 py-0.5 rounded-md bg-muted text-foreground font-medium">{tag}</span>
        ))}
      </div>
    </div>
  );
}

function ContactEditableFields() {
  const t = useTranslations();
  const editableFields = [
    { key: 'firstName', icon: Type, label: t('sweep.weldcrm.contactDetailView.firstName') },
    { key: 'lastName', icon: Type, label: t('sweep.weldcrm.contactDetailView.lastName') },
    { key: 'email', icon: Mail, label: t('sweep.weldcrm.contactDetailView.email') },
    { key: 'phone', icon: Phone, label: t('sweep.weldcrm.contactDetailView.phone') },
    { key: 'mobile', icon: Smartphone, label: t('sweep.weldcrm.contactDetailView.mobile') },
    { key: 'notes', icon: FileText, label: t('sweep.weldcrm.contactDetailView.notes') },
  ];
  const { data, contactId, refresh, visitorLocation } = useContactDetailContext();
  const updateMutation = useUpdateHelpdeskContact();
  const { isFieldVisible } = useDrawerFieldVisibility('helpdesk-contact-detail');
  const contact = data?.contact;

  const [fieldValues, setFieldValues] = useState<Record<string, string>>({
    firstName: contact?.firstName || '',
    lastName: contact?.lastName || '',
    email: contact?.email || '',
    phone: contact?.directPhone || '',
    mobile: contact?.mobilePhone || '',
    notes: contact?.notes || '',
  });

  const handleFieldChange = (key: string, value: string) => {
    setFieldValues(prev => ({ ...prev, [key]: value }));
  };

  const handleFieldBlur = useCallback(async (key: string, value: string) => {
    if (value === getOriginalContactFieldValue(contact, key)) return;

    try {
      const payload = buildContactUpdatePayload(key, value);
      if (!payload) return;

      const result = await updateMutation.mutateAsync({ id: contactId, data: payload });
      if (!result.success) {
        toast.error((result as { error?: string }).error || t('sweep.weldcrm.contactDetailView.failedToSave'));
        return;
      }
      refresh();
    } catch {
      toast.error(t('sweep.weldcrm.contactDetailView.failedToSaveField'));
    }
  }, [contact, contactId, refresh, updateMutation, t]);

  if (!contact) return null;

  return (
    <div className="space-y-1">
      {editableFields.filter((field) => isFieldVisible(field.key)).map((field) => (
        <ContactFieldRow
          key={field.key}
          icon={field.icon}
          label={field.label}
          fieldKey={field.key}
          value={fieldValues[field.key] || ''}
          onChange={handleFieldChange}
          onBlur={handleFieldBlur}
        />
      ))}

      {/* Visitor location */}
      {visitorLocation && (
        <VisitorLocationRows
          location={visitorLocation}
          showLocation={isFieldVisible('location')}
          showTimezone={isFieldVisible('timezone')}
        />
      )}

      {/* Categories / Tags */}
      {isFieldVisible('tags') && <ContactTagsRow interests={contact.interests} />}
    </div>
  );
}

// =============================================================================
// Highlights (page mode overview, matches CRM HighlightCard)
// =============================================================================

function HighlightCard({ label, value }: Readonly<{ label: string; value: string | null }>) {
  return (
    <div className="bg-background border border-border rounded-lg p-3 h-[82px] flex flex-col justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      {value ? (
        <p className="text-sm font-medium text-foreground">{value}</p>
      ) : (
        <p className="text-sm text-muted-foreground">--</p>
      )}
    </div>
  );
}

// =============================================================================
// Overview content
// =============================================================================

function OverviewContent() {
  const t = useTranslations();
  const { data, mode } = useContactDetailContext();
  if (!data) return null;

  const { contact, conversations, fullName } = data;
  const isPanel = mode === 'embedded';

  // Panel/embedded: show editable fields inline (like CRM sidebar in embedded mode)
  if (isPanel) {
    return <ContactEditableFields />;
  }

  // Page mode: show highlights grid + activity summary
  return (
    <div>
      {/* Highlights */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <LayoutGrid className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">{t('sweep.weldcrm.contactDetailView.highlights')}</h2>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <HighlightCard label={t('sweep.weldcrm.contactDetailView.conversations')} value={conversations.length > 0 ? `${conversations.length}` : null} />
          <HighlightCard label={t('sweep.weldcrm.contactDetailView.email')} value={contact.email || null} />
          <HighlightCard label={t('sweep.weldcrm.contactDetailView.phone')} value={contact.directPhone || contact.mobilePhone || null} />
          <HighlightCard label={t('sweep.weldcrm.contactDetailView.status')} value={contact.status || null} />
          <HighlightCard
            label={t('sweep.weldcrm.contactDetailView.contactSince')}
            value={contact.createdAt ? format(new Date(contact.createdAt), 'MMM d, yyyy') : null}
          />
          <HighlightCard
            label={t('sweep.weldcrm.contactDetailView.lastActive')}
            value={contact.updatedAt ? format(new Date(contact.updatedAt), 'MMM d, yyyy') : null}
          />
        </div>
      </div>

      {/* Activity */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <SquareActivity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">{t('sweep.weldcrm.contactDetailView.activity')}</h2>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-md flex items-center justify-center text-white text-xs font-medium flex-shrink-0 bg-orange-500">
            S
          </div>
          <div className="flex-1 flex items-start justify-between">
            <p className="text-sm text-foreground">
              <span className="font-medium">{fullName}</span> {t('sweep.weldcrm.contactDetailView.wasCreatedBy')} <span className="font-medium">{t('sweep.weldcrm.contactDetailView.system')}</span>
            </p>
            <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">
              {contact.createdAt ? format(new Date(contact.createdAt), 'MMM d, yyyy') : ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Conversations tab
// =============================================================================

function conversationStatusClass(status: Helpdesk.Conversation['status']): string {
  if (status === 'active') return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
  if (status === 'closed') return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300';
}

function conversationDateLabel(conv: Helpdesk.Conversation): string {
  if (conv.lastMessageAt) return format(new Date(conv.lastMessageAt), 'MMM d, yyyy');
  if (conv.createdAt) return format(new Date(conv.createdAt), 'MMM d, yyyy');
  return '';
}

function ConversationList() {
  const t = useTranslations();
  const { data } = useContactDetailContext();
  const conversations = data?.conversations || [];

  if (conversations.length === 0) {
    return <p className="text-sm text-muted-foreground px-4 py-6">{t('sweep.weldcrm.contactDetailView.noConversationsYet')}</p>;
  }

  return (
    <div className="divide-y divide-border">
      {conversations.map((conv: Helpdesk.Conversation) => (
        <div key={conv.id} className="px-4 py-3 hover:bg-muted/50 transition-colors">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium text-foreground truncate">{conv.subject || t('sweep.weldcrm.contactDetailView.noSubject')}</span>
            <span className={cn(
              'text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 ml-2',
              conversationStatusClass(conv.status)
            )}>
              {conv.status}
            </span>
          </div>
          {conv.preview && <p className="text-xs text-muted-foreground line-clamp-2 mb-1">{conv.preview}</p>}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{conv.conversationNumber}</span>
            <span>{conversationDateLabel(conv)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Content switcher
// =============================================================================

function ContactDetailContent() {
  const { activeTab, isLoading, data } = useContactDetailContext();
  if (isLoading || !data) return null;

  if (activeTab === 'conversations') return <ConversationList />;

  return (
    <div className="px-4 py-6">
      <OverviewContent />
    </div>
  );
}

// =============================================================================
// Right sidebar — Details tab (editable fields) + Comments tab
// =============================================================================

function ContactSidebar() {
  const t = useTranslations();
  const sidebarTabItems: PageTab[] = [
    { id: 'details', label: t('sweep.weldcrm.contactDetailView.details'), icon: ListCollapse },
    { id: 'comments', label: t('sweep.weldcrm.contactDetailView.comments'), icon: MessagesSquare },
  ];
  const { sidebarTab, setSidebarTab, contactId, data } = useContactDetailContext();
  const fullName = data?.fullName || '';

  return (
    <div className="flex flex-col h-full">
      {/* Sidebar tabs */}
      <div>
        <PageTabs
          tabs={sidebarTabItems}
          activeTab={sidebarTab}
          onTabChange={(id) => setSidebarTab(id as SidebarTab)}
          innerClassName="px-4 pt-1"
        />
      </div>

      {/* Content */}
      <div className="flex-1 border-l border-border overflow-hidden">
        {sidebarTab === 'details' ? (
          <div className="overflow-y-auto h-full p-4">
            {/* Record Details section (collapsible, like CRM) */}
            <RecordDetailsSection />
          </div>
        ) : (
          <CommentsSection contactId={contactId} contactName={fullName} />
        )}
      </div>
    </div>
  );
}

function RecordDetailsSection() {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mb-6">
      <Button variant="ghost" onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 mb-3">
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <span className="text-sm font-medium text-foreground">{t('sweep.weldcrm.contactDetailView.contactDetails')}</span>
      </Button>
      {expanded && <ContactEditableFields />}
    </div>
  );
}

interface CustomerCommentActivity {
  id: string;
  content?: string;
  createdAt: string;
  authorId?: string;
  authorName?: string;
}

function CommentsSection({ contactId, contactName }: Readonly<{ contactId: string; contactName: string }>) {
  const t = useTranslations();
  const { user } = useUser();
  const { data: commentsData } = useCustomerComments(contactId);
  const createCommentMutation = useCreateCustomerComment();
  const [commentInput, setCommentInput] = useState('');

  const comments = ((commentsData?.data ?? []) as CustomerCommentActivity[]).map((c) => ({
    ...c,
    createdAt: new Date(c.createdAt),
    isCurrentUser: c.authorId === user?.id,
    author: {
      name: c.authorName || t('sweep.weldcrm.contactDetailView.unknown'),
      initials: (c.authorName || 'U').split(' ').map((n: string) => n[0]).join('').substring(0, 2).toUpperCase(),
      color: '#6366F1',
    },
  }));

  const handleSendComment = () => {
    if (!commentInput.trim()) return;
    createCommentMutation.mutate(
      { entityId: contactId, content: commentInput.trim(), entityType: 'contact' },
      { onSuccess: () => setCommentInput('') }
    );
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full">
      {/* Comments List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {comments.length > 0 ? (
          comments.map((comment) => (
            <div key={comment.id} className={cn('flex gap-2 items-end', comment.isCurrentUser ? 'justify-end' : 'justify-start')}>
              {!comment.isCurrentUser && (
                <div className="h-6 w-6 rounded-md flex items-center justify-center text-[10px] font-semibold text-white flex-shrink-0" style={{ backgroundColor: comment.author.color }}>
                  {comment.author.initials}
                </div>
              )}
              {comment.isCurrentUser ? (
                <div className="max-w-[85%]">
                  <div className="bg-gray-100 dark:bg-secondary text-gray-800 dark:text-foreground rounded-2xl rounded-br-sm px-4 py-2.5">
                    <p className="text-sm whitespace-pre-wrap break-words">{comment.content}</p>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1 text-right">
                    {comment.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              ) : (
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{comment.author.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {comment.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <p className="text-sm text-foreground/80 mt-0.5 break-words">{comment.content}</p>
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-muted-foreground">{t('sweep.weldcrm.contactDetailView.noCommentsYet')}</p>
            <p className="text-xs text-muted-foreground mt-1">{t('sweep.weldcrm.contactDetailView.beTheFirstToComment')}</p>
          </div>
        )}
      </div>

      {/* Comment Input */}
      <div className="mt-auto flex-shrink-0 pt-2 px-4 pb-4">
        <div className="rounded-xl border border-gray-200 dark:border-border bg-white dark:bg-background focus-within:border-gray-400 dark:focus-within:border-gray-500 transition-all">
          <textarea
            value={commentInput}
            onChange={(e) => setCommentInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (commentInput.trim()) handleSendComment();
              }
            }}
            placeholder={t('sweep.weldcrm.contactDetailView.addCommentPlaceholder')}
            className="w-full px-4 pt-3 pb-2 bg-transparent text-sm text-foreground placeholder-muted-foreground focus:outline-none resize-none"
            rows={2}
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
              <div className="flex items-center gap-1.5 px-2.5 h-8 rounded-lg bg-gray-50 dark:bg-gray-850 border border-gray-200 dark:border-border text-[13px] text-gray-500 dark:text-muted-foreground max-w-[230px]">
                <Users className="h-3.5 w-3.5 flex-shrink-0 text-gray-400 dark:text-muted-foreground" />
                <span className="truncate">{contactName}</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="icon" className="h-8 w-8 p-0 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-all" title={t('sweep.weldcrm.contactDetailView.mention')}>
                <AtSign className="h-4 w-4" />
              </Button>
              <Button
                variant="default"
                size="icon"
                onClick={() => { if (commentInput.trim()) handleSendComment(); }}
                disabled={!commentInput.trim() || createCommentMutation.isPending}
                className="h-8 w-8 p-0 rounded-lg transition-colors flex items-center justify-center bg-primary hover:bg-primary/90 text-primary-foreground disabled:opacity-50 disabled:pointer-events-none"
                title={t('sweep.weldcrm.contactDetailView.send')}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Layouts
// =============================================================================

/** Embedded — compact, no right sidebar (used inside conversation detail sidebar) */
function EmbeddedLayout() {
  const { isLoading } = useContactDetailContext();

  return (
    <div className="flex flex-col h-full">
      <ContactDetailHeader />
      <div className="flex-1 flex flex-col min-h-0">
        <div className="relative z-10">
          <ContactDetailTabs />
        </div>
        <div className={cn('flex-1 overflow-y-auto overflow-x-hidden transition-opacity duration-200', isLoading ? 'opacity-0' : 'opacity-100')}>
          <ContactDetailContent />
        </div>
      </div>
    </div>
  );
}

/** Page — full layout with header, tabs, content, and right sidebar (Details/Comments tabs) */
function PageLayout() {
  const { isLoading } = useContactDetailContext();

  return (
    <div className="flex flex-col h-full">
      <ContactDetailHeader />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left — tabs + content */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <div className="relative z-10">
            <ContactDetailTabs />
          </div>
          <div className={cn('flex-1 overflow-y-auto overflow-x-hidden transition-opacity duration-200', isLoading ? 'opacity-0' : 'opacity-100')}>
            <ContactDetailContent />
          </div>
        </div>

        {/* Right sidebar (750px, same as CRM) */}
        <div className="w-[750px] flex-shrink-0 bg-background flex flex-col">
          <ContactSidebar />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Public API
// =============================================================================

interface ContactDetailViewProps {
  contactId: string;
  mode?: 'embedded' | 'page';
  defaultTab?: ContactTab;
  onClose?: () => void;
  onToggleExpand?: () => void;
  isExpanded?: boolean;
  visitorLocation?: { city?: string; region?: string; country?: string; timezone?: string } | null;
}

export function ContactDetailView({
  contactId, mode = 'page', defaultTab = 'overview',
  onClose, onToggleExpand, isExpanded, visitorLocation,
}: Readonly<ContactDetailViewProps>) {
  return (
    <ContactDetailProvider
      contactId={contactId} defaultTab={defaultTab} mode={mode}
      onClose={onClose} onToggleExpand={onToggleExpand} isExpanded={isExpanded}
      visitorLocation={visitorLocation}
    >
      {mode === 'embedded' ? <EmbeddedLayout /> : <PageLayout />}
    </ContactDetailProvider>
  );
}
