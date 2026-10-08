import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from '@/lib/router';
import { getTranslations } from '@/lib/i18n';
import type { TranslationNamespaces } from '@/lib/i18n';
import { PageLoader } from '@/components/page-loader';
import {
  EntityGrid,
  type EntityGridConfig,
  type EntityGridActions,
  type GridPaginationState,
  type GridColumnDef,
} from '@/components/entity-grid';
import { User, Mail, Phone, Smartphone, Briefcase, Calendar } from 'lucide-react';
import { useInfinitePeople, type ListPeopleQuery, type Person } from '@/hooks/queries/use-people-queries';
import { QuickAddPersonDialog } from '@/app/weldcrm/people/components/quick-add-person-dialog';
import { useCall } from '@/contexts/call-context';
import { WeldCallGate } from '../components/weldcall-gate';

const pageSize = 50;

function getPrimaryPhone(person: Person): string | undefined {
  return person.directPhone?.trim() || person.mobilePhone?.trim() || undefined;
}

function getPersonInitials(person: Person): string {
  const parts = person.displayName.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
  return person.displayName.charAt(0).toUpperCase();
}

// Column ids double as the server-side sort keys of GET /people.
function buildCallContactColumns(tc: TranslationNamespaces['weldmeet']['weldcall']['contacts']): GridColumnDef<Person>[] {
  return [
    {
      id: 'name',
      name: tc.columns.name,
      type: 'company',
      width: 250,
      icon: User,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (p) => p.displayName,
    },
    {
      id: 'directPhone',
      name: tc.columns.directPhone,
      type: 'phone',
      width: 170,
      icon: Phone,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (p) => p.directPhone ?? '',
    },
    {
      id: 'mobilePhone',
      name: tc.columns.mobilePhone,
      type: 'phone',
      width: 170,
      icon: Smartphone,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (p) => p.mobilePhone ?? '',
    },
    {
      id: 'email',
      name: tc.columns.email,
      type: 'email',
      width: 220,
      icon: Mail,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (p) => p.email ?? '',
    },
    {
      id: 'title',
      name: tc.columns.jobTitle,
      type: 'text',
      width: 180,
      icon: Briefcase,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (p) => p.title ?? '',
    },
    {
      id: 'lastContactedAt',
      name: tc.columns.lastContacted,
      type: 'date',
      width: 150,
      icon: Calendar,
      visible: true,
      editable: false,
      sortable: true,
      getValue: (p) => p.lastContactedAt ?? null,
    },
    {
      id: 'createdAt',
      name: tc.columns.added,
      type: 'date',
      width: 140,
      icon: Calendar,
      visible: false,
      editable: false,
      sortable: true,
      getValue: (p) => p.createdAt,
    },
  ];
}

function CallContactsContent() {
  const { setIsDialerOpen, setInitialDialerNumber } = useCall();
  const t = getTranslations('weldmeet');
  const tc = t.weldcall.contacts;
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false);

  const searchParams = useSearchParams();
  const search = searchParams.get('search') || undefined;
  const sort = searchParams.get('sort') || undefined;
  const sortDir = (searchParams.get('sortDir') as 'asc' | 'desc' | null) || undefined;

  // CRM people that can actually be dialled. Mail/helpdesk identities
  // (inCrm=false) stay out, same as the WeldCRM People grid.
  const filters: Omit<ListPeopleQuery, 'cursor'> = useMemo(() => {
    const f: Omit<ListPeopleQuery, 'cursor'> = { limit: pageSize, inCrm: true, hasPhone: true };
    if (search) f.search = search;
    if (sort) {
      f.sort = sort;
      if (sortDir) f.sortDir = sortDir;
    }
    return f;
  }, [search, sort, sortDir]);

  const {
    data: infiniteData,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfinitePeople(filters);

  const contacts = useMemo(
    () => infiniteData?.pages.flatMap((page) => page.data ?? []) ?? [],
    [infiniteData],
  );
  const totalCount = infiniteData?.pages[0]?.pagination?.totalCount ?? 0;

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const callContactGridConfig: EntityGridConfig<Person> = useMemo(() => ({
    entityName: tc.entityName,
    gridViewName: 'weldcall-contact',
    entityNamePlural: tc.entityNamePlural,
    columns: buildCallContactColumns(tc),
    getEntityId: (p) => p.id,
    getEntityName: (p) => p.displayName,
    getEntityInitials: getPersonInitials,
    getEntityAvatar: (p) => p.avatarUrl ?? undefined,
    getEntitySubtitle: (p) => p.title ?? undefined,
    allowCustomColumns: false,
    enableCalculations: false,
    enableInlineEditing: false,
    enableRowSelection: false,
    enableExport: false,
    enableImport: false,
  }), [tc]);

  const pagination: GridPaginationState = {
    page: 1,
    pageSize,
    totalCount,
    totalPages: 1,
    hasMore: !!hasNextPage,
  };

  const actions: EntityGridActions<Person> = useMemo(
    () => ({
      onUpdateEntity: () => Promise.resolve({ success: true }),
      onDeleteEntity: () => Promise.resolve({ success: true }),
      onRowClick: (person) => {
        const phone = getPrimaryPhone(person);
        if (!phone) return;
        setInitialDialerNumber(phone);
        setIsDialerOpen(true);
      },
      onCreateEntity: () => setIsQuickAddOpen(true),
    }),
    [setIsDialerOpen, setInitialDialerNumber],
  );

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="h-[calc(100vh-4rem)]">
      <EntityGrid
        config={callContactGridConfig}
        actions={actions}
        entities={contacts}
        pagination={pagination}
        searchParams={{ search, sort, sortDir }}
        onLoadMore={handleLoadMore}
        hasMore={!!hasNextPage}
        isFetchingMore={isFetchingNextPage}
      />
      <QuickAddPersonDialog open={isQuickAddOpen} onOpenChange={setIsQuickAddOpen} />
    </div>
  );
}

export default function CallContactsPage() {
  return (
    <WeldCallGate>
      <CallContactsContent />
    </WeldCallGate>
  );
}
