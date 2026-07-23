import { useState, useCallback, useMemo, lazy, Suspense } from 'react';
import { useObjectPanel } from '@/components/object-panel';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  EllipsisVertical,
  Trash2,
  Star,
  Crown,
  ExternalLink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { personKeys } from '@/components/objects/person/use-person-data';
import { companyKeys } from '@/components/objects/company/use-company-data';

// ---------------------------------------------------------------------------
// Inline link/unlink/primary mutations against app-api /person-companies.
// Unlink + setPrimary need the join row id, which we look up via the
// company-people listing returned from /api/companies/:id/people.
// ---------------------------------------------------------------------------

async function findLinkRowId(client: any, customerId: string, contactId: string): Promise<string | null> {
  const res = await client.get<{ data: Array<{ id: string; personId: string }> }>(
    `/companies/${encodeURIComponent(customerId)}/people`,
  );
  const row = res.data.find((r) => r.personId === contactId);
  return row?.id ?? null;
}

function useUnlinkContactFromCustomer() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ contactId, customerId }: { contactId: string; customerId: string }) => {
      const client = await getClient();
      const linkId = await findLinkRowId(client, customerId, contactId);
      if (!linkId) return;
      await client.delete<void>(`/person-companies/${linkId}`);
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: personKeys.all });
      qc.invalidateQueries({ queryKey: personKeys.detail(variables.contactId) });
      qc.invalidateQueries({ queryKey: companyKeys.people(variables.customerId) });
    },
  });
}

function useSetContactPrimaryForCustomer() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ contactId, customerId }: { contactId: string; customerId: string }) => {
      const client = await getClient();
      const linkId = await findLinkRowId(client, customerId, contactId);
      if (!linkId) return;
      await client.patch<{ data: { id: string } }>(`/person-companies/${linkId}`, { isPrimary: true });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: personKeys.all });
      qc.invalidateQueries({ queryKey: personKeys.detail(variables.contactId) });
      qc.invalidateQueries({ queryKey: companyKeys.people(variables.customerId) });
    },
  });
}

function useLinkContactsToCustomer() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ customerId, contactIds, role }: { customerId: string; contactIds: string[]; role?: string }) => {
      const client = await getClient();
      await Promise.all(
        contactIds.map((contactId) =>
          client.post<{ data: { id: string } }>('/person-companies', {
            personId: contactId,
            companyId: customerId,
            ...(role ? { role } : {}),
          }),
        ),
      );
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: personKeys.all });
      qc.invalidateQueries({ queryKey: companyKeys.people(variables.customerId) });
    },
  });
}
import { RecordSelectionModal } from '@/components/objects/_shared/record-selection-modal';
// Lazy: a contact's detail view can open nested inside the customer view.
// A static import here closes an import cycle (view -> content -> this
// section -> view); lazy keeps the recursion at runtime only.
const CustomerDetailView = lazy(() =>
  import('../customer-detail-view').then((m) => ({ default: m.CustomerDetailView })),
);
import {
  EntityList,
  EmptyStateIllustration,
  type HeaderColumn,
  type FilterConfig,
  type RowHandlers,
} from '@/components/entity-list';
import { useCustomerDetailContext } from '../customer-detail-provider';
import type { ContactsSectionProps, CustomerContact } from '../types';
import { useTranslations } from '@weldsuite/i18n/client';

export function ContactsSection({ customer, contacts }: ContactsSectionProps) {
  const t = useTranslations();
  const { open: openObjectPanel } = useObjectPanel();
  const { mode, isExpanded, silentRefresh } = useCustomerDetailContext();
  const isPanel = (mode === 'panel' && !isExpanded) || mode === 'embedded';
  const unlinkContactMut = useUnlinkContactFromCustomer();
  const setPrimaryMut = useSetContactPrimaryForCustomer();
  const linkContactsMut = useLinkContactsToCustomer();
  const [linkContactOpen, setLinkContactOpen] = useState(false);
  // When opened in panel mode, clicking a contact row opens the
  // ContactDetailPanel stacked on top of the customer panel (with a Back
  // button) instead of navigating to the full contact page.
  const [openContact, setOpenContact] = useState<CustomerContact | null>(null);

  const getContactName = useCallback(
    (contact: CustomerContact) =>
      contact.fullName ||
      `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() ||
      contact.email ||
      t('sweep.weldcrm.contactsSection.unnamedContact'),
    [t],
  );

  const handleUnlink = useCallback(async (contactId: string) => {
    try {
      await unlinkContactMut.mutateAsync({ contactId, customerId: customer.id });
      toast.success(t('sweep.weldcrm.contactsSection.contactUnlinked'));
      silentRefresh();
    } catch {
      toast.error(t('sweep.weldcrm.contactsSection.failedToUnlink'));
    }
  }, [unlinkContactMut, customer.id, silentRefresh, t]);

  const handleSetPrimary = useCallback(async (contactId: string) => {
    try {
      await setPrimaryMut.mutateAsync({ contactId, customerId: customer.id });
      toast.success(t('sweep.weldcrm.contactsSection.setAsPrimarySuccess'));
      silentRefresh();
    } catch {
      toast.error(t('sweep.weldcrm.contactsSection.failedToSetPrimary'));
    }
  }, [setPrimaryMut, customer.id, silentRefresh, t]);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'role',
      label: t('sweep.weldcrm.contactsSection.role'),
      options: [
        { value: 'primary', label: t('sweep.weldcrm.contactsSection.primary') },
        { value: 'other', label: t('sweep.weldcrm.contactsSection.other') },
      ],
    },
  ], [t]);

  const renderContactRow = useCallback((contact: CustomerContact, _handlers: RowHandlers<CustomerContact>) => {
    const name = getContactName(contact);
    return (
      <div key={contact.id}>
        {/* Desktop row - hidden in panel mode */}
        {!isPanel && <div
          className="hidden md:flex items-center gap-4 px-4 py-3 border-b border-border/70 group cursor-pointer hover:bg-muted/30"
          onClick={() => openObjectPanel({ type: 'person', id: contact.id, stack: true })}
        >
          {/* Name (with avatar) */}
          <div className="w-[360px] min-w-0 flex items-center gap-3">
            <div className="flex-shrink-0">
              <Avatar className="h-7 w-7 !rounded-[8px]">
                <AvatarImage src={contact.avatarUrl} alt={name} className="!rounded-[8px]" />
                <AvatarFallback className="!rounded-[8px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                  {name.charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-foreground truncate text-left">
                {name}
              </span>
              {contact.isPrimary && (
                <Crown className="h-3.5 w-3.5 text-amber-500 shrink-0" />
              )}
            </div>
          </div>

          {/* Email */}
          <div className="flex-1 min-w-0">
            {contact.email ? (
              <span className="text-sm text-muted-foreground truncate block">
                {contact.email}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">—</span>
            )}
          </div>

          {/* Role / Primary status */}
          <div className="w-[100px] flex-shrink-0">
            {contact.isPrimary ? (
              <Badge className="text-xs font-medium rounded-md border-transparent bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
                {t('sweep.weldcrm.contactsSection.primary')}
              </Badge>
            ) : (
              <span className="text-sm text-muted-foreground">—</span>
            )}
          </div>

          {/* Title */}
          <div className="w-[140px] flex-shrink-0">
            {contact.title ? (
              <span className="text-sm text-muted-foreground truncate block">
                {contact.title}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">—</span>
            )}
          </div>

          {/* Phone */}
          <div className="w-[120px] flex-shrink-0">
            {contact.directPhone ? (
              <span className="text-sm text-muted-foreground font-mono">
                {contact.directPhone}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">—</span>
            )}
          </div>

          {/* Actions */}
          <div className="w-[40px] flex justify-end flex-shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openObjectPanel({ type: 'person', id: contact.id, stack: true }); }}>
                  <ExternalLink className="mr-0.5 h-4 w-4" />
                  {t('sweep.weldcrm.contactsSection.viewProfile')}
                </DropdownMenuItem>
                {!contact.isPrimary && (
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); handleSetPrimary(contact.id); }}>
                    <Star className="mr-0.5 h-4 w-4" />
                    {t('sweep.weldcrm.contactsSection.setAsPrimary')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={(e) => { e.stopPropagation(); handleUnlink(contact.id); }}
                  className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
                >
                  <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
                  {t('sweep.weldcrm.contactsSection.unlink')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>}

        {/* Compact row - always in panel mode, mobile-only otherwise */}
        <div
          className={cn(
            isPanel ? "flex" : "md:hidden flex",
            "group items-center gap-3 px-4 py-3 border-b border-border/70 hover:bg-gray-50 dark:hover:bg-secondary/40 active:bg-muted/50 cursor-pointer transition-colors",
          )}
          onClick={() => {
            if (isPanel) {
              setOpenContact(contact);
            } else {
              openObjectPanel({ type: 'person', id: contact.id, stack: true });
            }
          }}
        >
          <Avatar className="h-[22px] w-[22px] !rounded-[8px] flex-shrink-0">
            <AvatarImage src={contact.avatarUrl} alt={name} className="!rounded-[8px]" />
            <AvatarFallback className="!rounded-[8px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
              {name.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0 w-full">
              <div className="flex items-center gap-1 min-w-0 flex-shrink">
                <span className="text-sm font-medium text-foreground truncate">
                  {name}
                </span>
                {contact.isPrimary && <Crown className="h-3 w-3 text-amber-500 shrink-0" />}
              </div>
              {contact.email && (
                <span className="text-sm text-muted-foreground truncate ml-auto pl-2 min-w-0">
                  {contact.email}
                </span>
              )}
            </div>
            {(contact.isPrimary || contact.title) && (
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {contact.isPrimary && (
                  <Badge className="text-[10px] font-medium rounded-md border-transparent px-1.5 py-0 bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400">
                    {t('sweep.weldcrm.contactsSection.primary')}
                  </Badge>
                )}
                {contact.title && (
                  <span className="text-xs text-muted-foreground">{contact.title}</span>
                )}
              </div>
            )}
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => openObjectPanel({ type: 'person', id: contact.id, stack: true })}>
                  <ExternalLink className="mr-0.5 h-4 w-4" />
                  {t('sweep.weldcrm.contactsSection.viewProfile')}
                </DropdownMenuItem>
                {!contact.isPrimary && (
                  <DropdownMenuItem onClick={() => handleSetPrimary(contact.id)}>
                    <Star className="mr-0.5 h-4 w-4" />
                    {t('sweep.weldcrm.contactsSection.setAsPrimary')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => handleUnlink(contact.id)}
                  className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
                >
                  <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
                  {t('sweep.weldcrm.contactsSection.unlink')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    );
  }, [getContactName, isPanel, openObjectPanel, handleSetPrimary, handleUnlink, t]);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: t('sweep.weldcrm.contactsSection.name'), width: 'w-[360px] min-w-0' },
    { id: 'email', header: t('sweep.weldcrm.contactDetailView.email'), width: 'flex-1 min-w-0' },
    { id: 'role', header: t('sweep.weldcrm.contactsSection.role'), width: 'w-[100px]' },
    { id: 'title', header: t('sweep.weldcrm.contactsSection.title'), width: 'w-[140px]' },
    { id: 'phone', header: t('sweep.weldcrm.contactDetailView.phone'), width: 'w-[120px]' },
  ], [t]);

  return (
    <>
      <EntityList<CustomerContact>
        items={contacts}
        isLoading={false}
        error={null}
        headerColumns={isPanel ? undefined : headerColumns}
        filters={filterConfigs}
        maxFilters={3}
        renderRow={renderContactRow}
        searchPlaceholder={t('sweep.weldcrm.contactsSection.searchContacts')}
        searchFields={['firstName', 'lastName', 'email', 'title']}
        emptyStateClassName="pb-24"
        createButton={{
          label: t('sweep.weldcrm.contactsSection.addContact'),
          onClick: () => setLinkContactOpen(true),
        }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="140" viewBox="0 0 120 140" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ transform: 'perspective(600px) rotateY(-6deg) rotateX(4deg)' }}>
                <rect x="16" y="22" width="80" height="100" rx="6" className="fill-white dark:fill-white/[0.03]" />
                <rect x="16" y="22" width="80" height="100" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                <circle cx="56" cy="56" r="14" className="fill-gray-50 dark:fill-white/[0.06] stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
                <path d="M40 92c0-9 7-16 16-16s16 7 16 16" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" fill="none" />
              </svg>
            </EmptyStateIllustration>
          ),
          title: t('sweep.weldcrm.contactsSection.noContactsYet'),
          description: t('sweep.weldcrm.contactsSection.noContactsYetDescription'),
          action: {
            label: t('sweep.weldcrm.contactsSection.addContact'),
            onClick: () => setLinkContactOpen(true),
          },
        }}
        noResultsState={{
          title: t('sweep.weldcrm.contactsSection.noContactsFound'),
          description: t('sweep.weldcrm.contactsSection.noContactsFoundDescription'),
        }}
      />
      {openContact && (
        <Suspense fallback={null}>
        <CustomerDetailView
          customerId={openContact.id}
          entityType="contact"
          mode="panel"
          isOpen={!!openContact}
          onClose={() => setOpenContact(null)}
          onBack={() => setOpenContact(null)}
          width="500px"
        />
        </Suspense>
      )}
      <RecordSelectionModal
        open={linkContactOpen}
        onOpenChange={setLinkContactOpen}
        kind="person"
        multiSelect
        existingIds={contacts.map((c) => c.id)}
        onSelectMultiple={async (records) => {
          const contactIds = records.map((r) => r.id);
          if (contactIds.length === 0) return;
          try {
            await linkContactsMut.mutateAsync({ customerId: customer.id, contactIds });
            toast.success(
              contactIds.length === 1
                ? t('sweep.weldcrm.contactsSection.linkedContactsSingular', { count: contactIds.length })
                : t('sweep.weldcrm.contactsSection.linkedContactsPlural', { count: contactIds.length })
            );
            silentRefresh();
          } catch {
            toast.error(t('sweep.weldcrm.contactsSection.failedToLinkContacts'));
          }
        }}
      />
    </>
  );
}
