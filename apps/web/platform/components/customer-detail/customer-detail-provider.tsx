
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { Note } from './note-editor-dialog';
import type {
  CustomerDetailContextValue,
  CustomerDetailData,
  CustomerDetailTab,
  CustomerDetailSidebarTab,
  CustomerDetailMode,
  CustomerDetailEntityType,
  CustomerNavigationData,
} from './types';
import {
  useCompanyDetail,
  useCompanyNavigation,
} from '@/components/objects/company/use-company-data';
import {
  usePersonDetail,
  usePersonNavigation,
} from '@/components/objects/person/use-person-data';
import { useTranslations } from '@weldsuite/i18n/client';

/**
 * `GET /people/:id/detail` returns `unknown` at the API layer (a combined
 * person + activity payload not modeled there) — this narrows just the
 * fields this provider reads off it.
 */
interface PersonDetailRow {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  fullName?: string;
  directPhone?: string;
  mobilePhone?: string;
  status?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  avatarUrl?: string;
  title?: string;
  department?: string;
  role?: string;
  extension?: string;
  preferredContactMethod?: string;
  preferredLanguage?: string;
  linkedinUrl?: string;
  twitterHandle?: string;
  influenceLevel?: string;
  isPrimary?: boolean;
  isDecisionMaker?: boolean;
  isBillingContact?: boolean;
  isTechnicalContact?: boolean;
}

const CustomerDetailContext = createContext<CustomerDetailContextValue | null>(null);

export function useCustomerDetailContext() {
  const context = useContext(CustomerDetailContext);
  if (!context) {
    throw new Error('useCustomerDetailContext must be used within a CustomerDetailProvider');
  }
  return context;
}

export function useCustomerDetailContextSafe() {
  return useContext(CustomerDetailContext);
}

interface CustomerDetailProviderProps {
  children: ReactNode;
  customerId: string;
  entityType?: CustomerDetailEntityType;
  mode?: CustomerDetailMode;
  initialData?: CustomerDetailData;
  navigation?: CustomerNavigationData;
  defaultTab?: CustomerDetailTab;
  showHeader?: boolean;
  showTabs?: boolean;
  showSidebar?: boolean;
  listId?: string;
  returnUrl?: string;
  onCompose?: (email: string) => void;
  onCall?: (phone: string) => void;
  onClose?: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  visitorLocation?: { city?: string; region?: string; country?: string; timezone?: string } | null;
}

export function CustomerDetailProvider({
  children,
  customerId,
  entityType = 'customer',
  mode = 'page',
  initialData,
  navigation: initialNavigation,
  defaultTab = 'overview',
  showHeader = true,
  showTabs = true,
  showSidebar = true,
  listId,
  returnUrl,
  onCompose,
  onCall,
  onClose,
  isExpanded,
  onToggleExpand,
  visitorLocation,
}: CustomerDetailProviderProps) {
  const t = useTranslations();
  const isContact = entityType === 'contact';
  const skipNavigation = mode === 'embedded' || !!initialNavigation;

  // Use TanStack Query hooks for data fetching
  const companyDetailQuery = useCompanyDetail(
    customerId,
    { activitiesLimit: 20, ordersLimit: 20, opportunitiesLimit: 20, peopleLimit: 50 },
    !isContact && !initialData && !!customerId,
  );
  const personDetailQuery = usePersonDetail(
    customerId,
    { activitiesLimit: 20 },
    isContact && !initialData && !!customerId,
  );
  const companyNavQuery = useCompanyNavigation(customerId, listId, !isContact && !skipNavigation && !!customerId);
  const personNavQuery = usePersonNavigation(customerId, isContact && !skipNavigation ? listId : undefined, isContact && !skipNavigation && !!customerId);

  const detailQuery = isContact ? personDetailQuery : companyDetailQuery;

  // Derive detail data from queries
  const queryData = isContact
    ? (personDetailQuery.data?.data ? (() => {
        const person = personDetailQuery.data!.data as unknown as PersonDetailRow;
        const fullName = person.displayName || person.fullName || `${person.firstName || ''} ${person.lastName || ''}`.trim();
        return {
          customer: {
            id: person.id, type: 'b2c' as const, email: person.email, firstName: person.firstName,
            lastName: person.lastName, fullName, phone: person.directPhone, mobile: person.mobilePhone,
            status: person.status ?? 'active', notes: person.notes, tags: [], createdAt: person.createdAt,
            updatedAt: person.updatedAt, avatarUrl: person.avatarUrl,
            customFields: {
              _entityType: 'contact', title: person.title, department: person.department,
              role: person.role, extension: person.extension,
              preferredContactMethod: person.preferredContactMethod,
              preferredLanguage: person.preferredLanguage, linkedinUrl: person.linkedinUrl,
              twitterHandle: person.twitterHandle, influenceLevel: person.influenceLevel,
              isPrimary: person.isPrimary, isDecisionMaker: person.isDecisionMaker,
              isBillingContact: person.isBillingContact, isTechnicalContact: person.isTechnicalContact,
            },
          },
          contacts: [], activities: [], opportunities: [], orders: [], invoices: [], lists: [],
          counts: { contacts: 0, activities: 0, opportunities: 0, orders: 0, invoices: 0, notes: 0, tasks: 0 },
          lastActivity: null,
        } as CustomerDetailData;
      })() : null)
    : (companyDetailQuery.data?.data as CustomerDetailData | null ?? null);

  const data = initialData ?? queryData;

  // Derive navigation data from queries.
  // Both company and person navigation endpoints return the same shape.
  const navigation: CustomerNavigationData | null = (() => {
    if (initialNavigation) return initialNavigation;
    const rawNav = isContact ? personNavQuery.data : companyNavQuery.data;
    if (!rawNav?.data) return null;
    return rawNav.data as unknown as CustomerNavigationData;
  })();

  const isLoading = detailQuery.isLoading;
  const error = detailQuery.error ? (detailQuery.error instanceof Error ? detailQuery.error.message : t('sweep.weldcrm.customerDetailProvider.errorOccurred')) : null;

  const [activeTab, setActiveTab] = useState<CustomerDetailTab>(defaultTab);
  const [sidebarTab, setSidebarTab] = useState<CustomerDetailSidebarTab>('details');
  const [countOverrides, setCountOverrides] = useState<Partial<import('./types').CustomerDetailCounts>>({});
  const [pendingNoteCreate, setPendingNoteCreate] = useState(false);
  const [floatingNote, setFloatingNote] = useState<Note | null>(null);
  const [showFloatingNoteEditor, setShowFloatingNoteEditor] = useState(false);
  const [showTaskDialog, setShowTaskDialog] = useState(false);

  const setCountOverride = useCallback((key: keyof import('./types').CustomerDetailCounts, value: number) => {
    setCountOverrides(prev => prev[key] === value ? prev : { ...prev, [key]: value });
  }, []);

  const refresh = useCallback(async () => {
    const navRefetch = isContact ? personNavQuery.refetch() : companyNavQuery.refetch();
    await Promise.all([detailQuery.refetch(), !skipNavigation ? navRefetch : Promise.resolve()]);
  }, [isContact, skipNavigation, detailQuery, personNavQuery, companyNavQuery]);

  // Background refresh — refetches data without showing the loading spinner.
  // TanStack Query background refetches don't flip isLoading, only isFetching,
  // so a simple refetch achieves the same "silent" behavior.
  const silentRefresh = useCallback(async () => {
    await detailQuery.refetch();
  }, [detailQuery]);

  const value: CustomerDetailContextValue = {
    data,
    isLoading,
    error,
    navigation,
    activeTab,
    setActiveTab,
    sidebarTab,
    setSidebarTab,
    refresh,
    silentRefresh,
    mode,
    entityType,
    customerId,
    listId,
    returnUrl,
    showHeader,
    showTabs,
    showSidebar: mode === 'page' ? showSidebar : isExpanded ? true : false,
    onCompose,
    onCall,
    onClose,
    isExpanded,
    onToggleExpand,
    countOverrides,
    setCountOverride,
    pendingNoteCreate,
    setPendingNoteCreate,
    floatingNote,
    setFloatingNote,
    showFloatingNoteEditor,
    setShowFloatingNoteEditor,
    showTaskDialog,
    setShowTaskDialog,
    visitorLocation,
  };

  return (
    <CustomerDetailContext.Provider value={value}>
      {children}
    </CustomerDetailContext.Provider>
  );
}
