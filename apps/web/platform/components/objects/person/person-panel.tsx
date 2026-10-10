/**
 * Person object panel — full-fat version mirroring the legacy customer /
 * contact panel.
 *
 * Layout:
 *   - Header: avatar / displayName / inline actions (email, phone, kebab)
 *   - Tab strip with the same 11 tabs the customer panel uses, plus a
 *     "Companies" tab in place of "Contacts" since People sit on the other
 *     side of the affiliation relationship.
 *   - Details body: a vertical list of `PropertyRow`s with the same icon +
 *     label + inline-editable value affordance as the customer panel.
 *   - All 11 tabs are wired: Details, Activity, Companies, Emails, Calls,
 *     Pipeline, Notes, Meetings, Tasks, Files, Audit Log.
 *   - Sidebar: person chat (locked-open in fullscreen).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Briefcase,
  Bookmark,
  Building,
  ExternalLink,
  EllipsisVertical,
  Languages,
  Mail,
  MapPin,
  Phone,
  Smile,
  StickyNote,
  Tag,
  Trash2,
  User,
  UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  ObjectPanelTabs,
  useObjectPanel,
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { EditableEntityAvatar } from '@/components/objects/editable-entity-avatar';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import { useComposeSafe } from '@/contexts/compose-context';
import {
  PropertyRow,
  MemberPropertyRow,
  StatusPropertyRow,
  TagsPropertyRow,
} from '@/components/objects/_shared/property-row';
import { useCustomerStatusOptions } from '@/hooks/queries/use-weldcrm-customer-statuses';
import { SelectPropertyRow } from '@/components/objects/_shared/select-property-row';
import { AddressPropertyRow } from '@/components/objects/_shared/address-property-row';
import { useLifecycleStageOptions, useLanguageOptions } from '@/components/objects/_shared/crm-field-options';
import { NotesTab } from '@/components/objects/_shared/notes-tab';
import { ActivityTab } from '@/components/objects/_shared/activity-tab';
import { DealsTab } from '@/components/objects/_shared/deals-tab';
import { CallsTab } from '@/components/objects/_shared/calls-tab';
import { MeetingsTab } from '@/components/objects/_shared/meetings-tab';
import { TasksTab } from '@/components/objects/_shared/tasks-tab';
import { FilesTab } from '@/components/objects/_shared/files-tab';
import { AuditTab } from '@/components/objects/_shared/audit-tab';
import { EmailsTab } from '@/components/objects/_shared/emails-tab';
import { CustomFieldsSidebarSection } from '@/components/custom-fields/custom-fields-sidebar-section';
import { EntityList } from '@/components/entity-list';
import { useUnlinkPersonFromCompany } from '@/hooks/queries/use-person-companies-queries';
import {
  usePerson,
  usePersonChannel,
  usePersonCompanies,
  useUpdatePerson,
  useDeletePerson,
  useAddPersonToCrm,
  useArchivePerson,
  useUnarchivePerson,
} from './use-person-data';
import { LinkCompanyPopover } from './link-company-popover';
import { PersonChat } from './person-chat';
import { PERSON_TABS, type PersonTab } from './person-tabs';
import type { Person } from '@weldsuite/core-api-client/schemas/people';

const PERSON_PANEL_WIDTH = 400;

// ─── Header ────────────────────────────────────────────────────────────────

function personInitial(person?: Person): string {
  if (!person) return '#';
  const first = person.firstName?.trim()?.[0];
  if (first) return first.toUpperCase();
  const display = person.displayName?.trim()?.[0];
  if (display) return display.toUpperCase();
  const email = person.email?.trim()?.[0];
  return (email ?? '#').toUpperCase();
}

function personGravatar(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  return `https://www.gravatar.com/avatar/${encodeURIComponent(email.toLowerCase())}?d=mp&s=64`;
}

function PersonAvatar({ person, onUpload }: Readonly<{ person?: Person; onUpload?: (url: string) => void }>) {
  if (!person) return <div className="size-[22px] rounded-[8px] bg-muted animate-pulse" />;
  const initial = personInitial(person);
  // Treat empty strings as "no avatar" so the fallback initial renders.
  const explicit = person.avatarUrl && person.avatarUrl.length > 0 ? person.avatarUrl : undefined;
  const src = explicit ?? personGravatar(person.email);
  if (onUpload) {
    return (
      <EditableEntityAvatar
        src={src}
        initial={initial}
        onUploaded={onUpload}
        entityType="person-avatar"
        entityId={person.id}
      />
    );
  }
  return (
    <Avatar className="size-[22px] !rounded-[8px]">
      {src && <AvatarImage src={src} className="!rounded-[8px] object-cover" />}
      <AvatarFallback className="!rounded-[8px] bg-muted text-[10px] font-medium">
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}

function PersonTitle({ person }: Readonly<{ person?: Person }>) {
  if (!person) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <span className="block text-[15px] font-medium leading-6 text-foreground truncate">
      {person.displayName}
    </span>
  );
}

function PersonActions({
  person,
  onDelete,
  onArchiveToggle,
}: Readonly<{
  person?: Person;
  onDelete: () => void;
  onArchiveToggle: () => void;
}>) {
  const st = useTranslations();
  const compose = useComposeSafe();
  const addToCrm = useAddPersonToCrm();
  const t = getTranslations('crm');
  if (!person) return null;
  const phone = person.directPhone || person.mobilePhone;

  const handleCompose = () => {
    if (!person.email) return;
    if (compose) {
      compose.openCompose({ to: person.email });
      return;
    }
    window.location.href = `mailto:${person.email}`;
  };

  const handleAddToCrm = () => {
    addToCrm.mutate(person.id, {
      onSuccess: () => toast.success(t.personPanel.addedToCrm),
      onError: (err: unknown) =>
        toast.error(err instanceof Error ? err.message : t.personPanel.addToCrmFailed),
    });
  };
  // Same 28px icon buttons as the shell's Expand / Close, returned as a
  // fragment so the shell's own spacing applies between every header button.
  return (
    <>
      {!person.inCrm && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={handleAddToCrm}
          disabled={addToCrm.isPending}
        >
          <UserPlus className="h-3.5 w-3.5" />
          {t.personPanel.addToCrm}
        </Button>
      )}
      {person.email && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              onClick={handleCompose}
              aria-label={st('sweep.entities.composeEmail')}
            >
              <Mail className="size-4 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{st('sweep.entities.composeEmail')}</TooltipContent>
        </Tooltip>
      )}
      {phone && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              onClick={() => { window.location.href = `tel:${phone}`; }}
              aria-label={st('sweep.entities.call')}
            >
              <Phone className="size-4 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{st('sweep.entities.call')}</TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={st('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        {/* Stock shadcn menu: default width, default icon sizing, stock destructive item. */}
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onArchiveToggle}>
            <Archive />
            {person.archivedAt ? st('sweep.entities.unarchive') : st('sweep.entities.archive')}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 />
            {st('sweep.entities.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

// ─── Tab bar ───────────────────────────────────────────────────────────────

function PersonPanelTabsBar({
  activeTab,
  setActiveTab,
  mode,
  companyCount,
}: Readonly<{
  activeTab: PersonTab['id'];
  setActiveTab: (id: PersonTab['id']) => void;
  mode: 'panel' | 'fullscreen';
  companyCount: number;
}>) {
  const st = useTranslations();
  const configEntries = useMemo(
    () =>
      PERSON_TABS.map((t) => ({
        id: t.id,
        label: t.label,
        required: t.required,
        defaultVisible:
          mode === 'panel'
            ? (t.defaultVisibleInPanel ?? false)
            : (t.defaultVisibleInFullscreen ?? false),
      })),
    [mode],
  );

  const { visibility, isVisible, toggle, resetToDefaults } = useObjectPanelTabConfig({
    objectType: 'person',
    mode,
    tabs: configEntries,
  });

  useEffect(() => {
    if (isVisible(activeTab)) return;
    const fallback = PERSON_TABS.find((t) => isVisible(t.id));
    if (fallback && fallback.id !== activeTab) setActiveTab(fallback.id);
  }, [activeTab, isVisible, setActiveTab]);

  const tabs = useMemo(
    () =>
      PERSON_TABS.filter((t) => isVisible(t.id)).map((t) => ({
        id: t.id,
        label: t.label,
        icon: t.icon,
        count: t.id === 'companies' ? companyCount : undefined,
      })),
    [isVisible, companyCount],
  );

  return (
    <div className="group/tabs-header relative">
      <ObjectPanelTabs
        tabs={tabs}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as PersonTab['id'])}
      />
      <div className="absolute top-0 right-2 h-full flex items-center opacity-0 group-hover/tabs-header:opacity-100 focus-within:opacity-100 transition-opacity">
        <DrawerFieldSettings
          fields={configEntries}
          fieldVisibility={visibility}
          onToggle={toggle}
          onReset={resetToDefaults}
          label={st('sweep.entities.visibleTabs')}
          title={st('sweep.entities.configureTabs')}
        />
      </div>
    </div>
  );
}

// ─── Details body ──────────────────────────────────────────────────────────

function PersonDetailsTab({
  person,
  onUpdateField,
  onUpdateFieldAsync,
}: Readonly<{
  person: Person;
  onUpdateField: (patch: Record<string, unknown>) => void;
  onUpdateFieldAsync: (patch: Record<string, unknown>) => Promise<void>;
}>) {
  const st = useTranslations();
  const { options: statusOptions } = useCustomerStatusOptions();
  const lifecycleOptions = useLifecycleStageOptions();
  const languageOptions = useLanguageOptions();
  return (
    <div className="p-4 space-y-1">
      <PropertyRow
        icon={Bookmark}
        label={st('sweep.entities.fieldFirstName')}
        value={person.firstName}
        onSave={(v) => onUpdateField({ firstName: v })}
      />
      <PropertyRow
        icon={Bookmark}
        label={st('sweep.entities.fieldLastName')}
        value={person.lastName}
        onSave={(v) => onUpdateField({ lastName: v })}
      />
      <PropertyRow
        icon={Briefcase}
        label={st('sweep.entities.fieldTitle')}
        value={person.title}
        onSave={(v) => onUpdateField({ title: v })}
      />
      <PropertyRow
        icon={Briefcase}
        label={st('sweep.entities.fieldDepartment')}
        value={person.department}
        onSave={(v) => onUpdateField({ department: v })}
      />
      <PropertyRow
        icon={StickyNote}
        label={st('sweep.entities.fieldNotes')}
        value={person.notes}
        onSave={(v) => onUpdateField({ notes: v })}
      />
      <PropertyRow
        icon={Mail}
        label={st('sweep.entities.fieldEmail')}
        type="email"
        value={person.email}
        onSave={(v) => onUpdateField({ email: v ?? '' })}
      />
      <PropertyRow
        icon={Phone}
        label={st('sweep.entities.fieldPhone')}
        type="phone"
        value={person.directPhone}
        onSave={(v) => onUpdateField({ directPhone: v })}
      />
      <PropertyRow
        icon={Phone}
        label={st('sweep.entities.fieldMobile')}
        type="phone"
        value={person.mobilePhone}
        onSave={(v) => onUpdateField({ mobilePhone: v })}
      />
      <MemberPropertyRow
        icon={User}
        label={st('sweep.entities.fieldOwner')}
        value={person.ownerId ?? ''}
        placeholder={st('sweep.entities.setOwnerPlaceholder')}
        onChange={(v) => onUpdateField({ ownerId: v || null })}
      />
      <MemberPropertyRow
        icon={Briefcase}
        label={st('sweep.entities.fieldManager')}
        value={person.accountManagerId ?? ''}
        placeholder={st('sweep.entities.setManagerPlaceholder')}
        onChange={(v) => onUpdateField({ accountManagerId: v || null })}
      />
      <TagsPropertyRow
        icon={Tag}
        label={st('sweep.entities.fieldTags')}
        value={person.tags}
        onChange={(next) => onUpdateField({ tags: next })}
      />
      <StatusPropertyRow
        value={person.status}
        onChange={(v) => onUpdateField({ status: v ?? '' })}
        options={statusOptions}
      />
      <SelectPropertyRow
        icon={Smile}
        label={st('sweep.entities.fieldLifecycle')}
        value={person.lifecycleStage}
        options={lifecycleOptions}
        onChange={(v) => onUpdateField({ lifecycleStage: v })}
      />
      <SelectPropertyRow
        icon={Languages}
        label={st('sweep.entities.fieldLanguage')}
        value={person.preferredLanguage}
        options={languageOptions}
        onChange={(v) => onUpdateField({ preferredLanguage: v })}
      />
      <PropertyRow
        icon={ExternalLink}
        label={st('sweep.entities.fieldLinkedIn')}
        type="url"
        value={person.linkedinUrl}
        onSave={(v) => onUpdateField({ linkedinUrl: v })}
      />
      <AddressPropertyRow
        icon={MapPin}
        label={st('sweep.entities.fieldAddress')}
        value={person.primaryAddress as Record<string, unknown> | null | undefined}
        placeholder={st('sweep.entities.setAddressPlaceholder')}
        onSave={(next) => onUpdateFieldAsync({ primaryAddress: next })}
      />

      <CustomFieldsSidebarSection
        entityType="person"
        values={person.customFields as Record<string, unknown> | null | undefined}
        onSave={(next) => onUpdateFieldAsync({ customFields: next })}
        layout="row"
      />
    </div>
  );
}

// ─── Companies tab ────────────────────────────────────────────────────────

type PersonCompanyRow = {
  id: string;
  companyId: string;
  role?: string | null;
  isPrimary?: boolean | null;
  endedAt?: string | null;
  company?: {
    displayName: string;
    name?: string | null;
    industry?: string | null;
    avatarUrl?: string | null;
  } | null;
};

function companyInitial(c: PersonCompanyRow['company']): string {
  if (!c) return '?';
  return (c.displayName?.[0] || '?').toUpperCase();
}

// Search-friendly row: flattens nested company fields so EntityList's
// `searchFields` can match on name / industry without a custom applyFilters.
type PersonCompanyListItem = PersonCompanyRow & {
  name: string;
  industry: string;
};

function PersonCompaniesTab({
  personId,
  employments,
  onOpenCompany,
}: Readonly<{
  personId: string;
  employments: PersonCompanyRow[];
  onOpenCompany: (companyId: string) => void;
}>) {
  const st = useTranslations();
  const unlinkMut = useUnlinkPersonFromCompany();
  const linkedIds = useMemo(
    () => new Set(employments.map((e) => e.companyId)),
    [employments],
  );

  const items = useMemo<PersonCompanyListItem[]>(
    () =>
      employments.map((pc) => ({
        ...pc,
        name: pc.company?.displayName ?? '',
        industry: pc.company?.industry ?? '',
      })),
    [employments],
  );

  const renderRow = useCallback(
    (pc: PersonCompanyListItem) => {
      const name = pc.company?.displayName ?? st('sweep.entities.deletedCompany');
      return (
        <div key={pc.id} className="group/row flex items-center gap-1 px-2 py-0.5">
          <Button
            variant="ghost"
            onClick={() => onOpenCompany(pc.companyId)}
            className="flex-1 text-left text-sm flex items-center justify-between gap-2 hover:bg-muted/50 rounded-md px-2 py-1.5 transition-colors min-w-0 h-auto"
          >
            <span className="flex items-center gap-2 min-w-0">
              <Avatar className="h-7 w-7 rounded-md flex-shrink-0">
                <AvatarImage src={pc.company?.avatarUrl ?? undefined} className="rounded-md object-cover" />
                <AvatarFallback className="rounded-md text-[10px]">
                  {companyInitial(pc.company)}
                </AvatarFallback>
              </Avatar>
              <span className="flex flex-col min-w-0">
                <span className="text-sm text-foreground truncate">{name}</span>
                {pc.role || pc.company?.industry ? (
                  <span className="text-xs text-muted-foreground truncate">
                    {pc.role ? pc.role : pc.company?.industry}
                    {pc.role && pc.company?.industry ? ` · ${pc.company.industry}` : ''}
                  </span>
                ) : null}
              </span>
            </span>
            <span className="flex items-center gap-1 flex-shrink-0">
              {pc.endedAt && <Badge variant="outline" className="text-[10px]">{st('sweep.entities.past')}</Badge>}
              {pc.isPrimary && <Badge variant="default" className="text-[10px]">{st('sweep.entities.primary')}</Badge>}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              unlinkMut.mutate(
                { id: pc.id, personId, companyId: pc.companyId },
                { onSuccess: () => toast.success(st('sweep.entities.unlinked')) },
              );
            }}
            disabled={unlinkMut.isPending}
            className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-[opacity,color,background-color]"
            aria-label={st('sweep.entities.unlink')}
            title={st('sweep.entities.unlinkFromPerson')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      );
    },
    [onOpenCompany, personId, unlinkMut, st],
  );

  return (
    <EntityList<PersonCompanyListItem>
      items={items}
      isLoading={false}
      error={null}
      filters={[]}
      renderRow={renderRow}
      searchPlaceholder={st('sweep.entities.searchCompaniesPlaceholder')}
      searchFields={['name', 'industry', 'role']}
      actionButtons={
        <LinkCompanyPopover personId={personId} linkedCompanyIds={linkedIds} />
      }
      itemsClassName="py-1.5"
      emptyState={{
        icon: <Building className="h-8 w-8 text-muted-foreground/60 mb-3" />,
        title: st('sweep.entities.noCompaniesYetTitle'),
        description: st('sweep.entities.noCompaniesYetDescription'),
      }}
      noResultsState={{
        title: st('sweep.entities.noCompaniesFoundTitle'),
        description: st('sweep.entities.noCompaniesFoundDescription'),
      }}
    />
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function PersonPanel(props: Readonly<ObjectPanelComponentProps>) {
  const st = useTranslations();
  const { id, onClose, initialTab } = props;
  const personQuery = usePerson(id);
  const person = personQuery.data?.data as Person | undefined;
  const companiesQuery = usePersonCompanies(id);
  const employments = companiesQuery.data?.data ?? [];

  const shell = useObjectPanelShell({
    ...props,
    width: PERSON_PANEL_WIDTH,
    loading: personQuery.isLoading && !person,
  });
  const mode = shell.mode;
  const { open: openPanel } = useObjectPanel();

  const updateMut = useUpdatePerson();
  const deleteMut = useDeletePerson();
  const archiveMut = useArchivePerson();
  const unarchiveMut = useUnarchivePerson();

  const handleUpdateField = useCallback((patch: Record<string, unknown>) => {
    if (!person) return;
    updateMut.mutate({ id: person.id, data: patch as Parameters<typeof updateMut.mutate>[0]['data'] });
  }, [person, updateMut]);

  const handleUpdateFieldAsync = useCallback(async (patch: Record<string, unknown>) => {
    if (!person) return;
    await updateMut.mutateAsync({ id: person.id, data: patch as Parameters<typeof updateMut.mutate>[0]['data'] });
  }, [person, updateMut]);

  const handleDelete = useCallback(() => {
    if (!person) return;
    deleteMut.mutate(person.id, {
      onSuccess: () => {
        toast.success(st('sweep.entities.personDeleted'));
        onClose();
      },
      onError: (err: unknown) =>
        toast.error(err instanceof Error ? err.message : st('sweep.entities.deleteFailed')),
    });
  }, [person, deleteMut, onClose, st]);

  const handleArchiveToggle = useCallback(() => {
    if (!person) return;
    const mut = person.archivedAt ? unarchiveMut : archiveMut;
    mut.mutate(person.id, {
      onSuccess: () =>
        toast.success(person.archivedAt ? st('sweep.entities.unarchived') : st('sweep.entities.archived')),
      onError: (err: unknown) =>
        toast.error(err instanceof Error ? err.message : st('sweep.entities.archiveUpdateFailed')),
    });
  }, [person, archiveMut, unarchiveMut, st]);

  const initial: PersonTab['id'] = useMemo(() => {
    if (initialTab && PERSON_TABS.some((t) => t.id === initialTab)) {
      return initialTab as PersonTab['id'];
    }
    return 'overview';
  }, [initialTab]);
  const [activeTab, setActiveTab] = useState<PersonTab['id']>(initial);

  const chatSidebar = (
    <PersonChat personId={id} personName={person?.displayName} />
  );
  // The line above the chat only appears once the chat has had a message (its
  // channel is created by the first one), as in the task panel.
  const chatHasMessages = !!usePersonChannel(id).data?.data;

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      avatar={<PersonAvatar person={person} onUpload={(url) => handleUpdateField({ avatarUrl: url })} />}
      title={<PersonTitle person={person} />}
      actions={<PersonActions person={person} onDelete={handleDelete} onArchiveToggle={handleArchiveToggle} />}
      tabs={
        <PersonPanelTabsBar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          mode={mode}
          companyCount={employments.length}
        />
      }
      sidebar={chatSidebar}
      sidebarDivider={chatHasMessages}
      sidebarDefaultSize={mode === 'panel' ? 320 : 500}
      sidebarMinSize={mode === 'panel' ? 140 : 320}
      sidebarMaxSize={mode === 'panel' ? undefined : 900}
      sidebarPersistKey={mode === 'fullscreen' ? 'person-panel-chat-right' : undefined}
      sidebarDefaultCollapsed={false}
      sidebarDefaultOpen
      sidebarLocked={mode === 'fullscreen'}
    >
      {person && activeTab === 'overview' && (
        <PersonDetailsTab
          person={person}
          onUpdateField={handleUpdateField}
          onUpdateFieldAsync={handleUpdateFieldAsync}
        />
      )}
      {person && activeTab === 'companies' && (
        <PersonCompaniesTab
          personId={person.id}
          employments={employments}
          onOpenCompany={(companyId) => openPanel({ type: 'company', id: companyId, stack: true })}
        />
      )}
      {person && activeTab === 'notes' && (
        <NotesTab
          entityId={person.id}
          entityKind="person"
          entityName={person.displayName}
        />
      )}
      {person && activeTab === 'activity' && (
        <ActivityTab entityId={person.id} entityKind="person" />
      )}
      {person && activeTab === 'deals' && (
        <DealsTab entityId={person.id} entityKind="person" />
      )}
      {person && activeTab === 'calls' && (
        <CallsTab
          entityId={person.id}
          entityKind="person"
        />
      )}
      {person && activeTab === 'meetings' && (
        <MeetingsTab entityId={person.id} entityKind="person" />
      )}
      {person && activeTab === 'tasks' && (
        <TasksTab entityId={person.id} entityKind="person" />
      )}
      {person && activeTab === 'files' && (
        <FilesTab entityId={person.id} entityKind="person" />
      )}
      {person && activeTab === 'emails' && (
        <EmailsTab entityEmail={person.email ?? undefined} entityKind="person" />
      )}
      {person && activeTab === 'audit' && (
        <AuditTab entityId={person.id} entityKind="person" />
      )}
    </EntityDetailView>
  );
}
