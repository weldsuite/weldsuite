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
  Briefcase,
  Building,
  Bookmark,
  ChevronRight,
  EllipsisVertical,
  ExternalLink,
  Flag,
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
import { PropertyRow } from '@/components/objects/_shared/property-row';
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
import {
  usePerson,
  usePersonCompanies,
  useUpdatePerson,
  useDeletePerson,
  useAddPersonToCrm,
  usePersonChannel,
} from './use-person-data';
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

function PersonAvatar({ person, onUpload }: { person?: Person; onUpload?: (url: string) => void }) {
  if (!person) return <div className="h-7 w-7 rounded-lg bg-muted animate-pulse" />;
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
    <Avatar className="h-7 w-7 rounded-lg border border-border">
      {src && <AvatarImage src={src} className="rounded-lg object-cover" />}
      <AvatarFallback className="rounded-lg bg-muted text-[12px] font-medium">
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}

function PersonTitle({ person }: { person?: Person }) {
  if (!person) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <span className="text-[15px] font-medium text-foreground truncate">
      {person.displayName}
    </span>
  );
}

function PersonActions({
  person,
  onDelete,
}: {
  person?: Person;
  onDelete: () => void;
}) {
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
  return (
    <div className="flex items-center gap-0.5">
      {!person.inCrm && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 mr-1 gap-1.5 text-xs"
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
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              onClick={handleCompose}
              aria-label={st('sweep.entities.composeEmail')}
            >
              <Mail className="h-4 w-4 text-muted-foreground" />
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
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              onClick={() => { window.location.href = `tel:${phone}`; }}
              aria-label={st('sweep.entities.call')}
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{st('sweep.entities.call')}</TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none"
            aria-label={st('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
            {st('sweep.entities.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Tab bar ───────────────────────────────────────────────────────────────

function PersonPanelTabsBar({
  activeTab,
  setActiveTab,
  mode,
  companyCount,
}: {
  activeTab: PersonTab['id'];
  setActiveTab: (id: PersonTab['id']) => void;
  mode: 'panel' | 'fullscreen';
  companyCount: number;
}) {
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
        />
      </div>
    </div>
  );
}

// ─── Details body ──────────────────────────────────────────────────────────

function formatAddress(addr?: Record<string, unknown> | null): string {
  if (!addr) return '';
  const parts = [
    [addr.street, addr.houseNumber].filter(Boolean).join(' '),
    [addr.postalCode, addr.city].filter(Boolean).join(' '),
    addr.state,
    addr.country,
  ].filter((s) => typeof s === 'string' && s.trim().length > 0);
  return parts.join(', ');
}

function PersonDetailsTab({
  person,
  onUpdateField,
  onUpdateFieldAsync,
}: {
  person: Person;
  onUpdateField: (patch: Record<string, unknown>) => void;
  onUpdateFieldAsync: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const st = useTranslations();
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
      <PropertyRow
        icon={User}
        label={st('sweep.entities.fieldOwner')}
        value={person.ownerId}
        readOnly
        placeholder={st('sweep.entities.unassigned')}
      />
      <PropertyRow
        icon={Briefcase}
        label={st('sweep.entities.fieldManager')}
        value={person.accountManagerId}
        readOnly
        placeholder={st('sweep.entities.unassigned')}
      />
      <PropertyRow
        icon={Tag}
        label={st('sweep.entities.fieldTags')}
        value={person.tags?.length ? person.tags.join(', ') : null}
        readOnly
      />
      <PropertyRow
        icon={Flag}
        label={st('sweep.entities.fieldStatus')}
        value={person.status}
        readOnly
        accessory={<ChevronRight className="h-3.5 w-3.5 rotate-90 text-muted-foreground" />}
      />
      <PropertyRow
        icon={Smile}
        label={st('sweep.entities.fieldLifecycle')}
        value={person.lifecycleStage}
        onSave={(v) => onUpdateField({ lifecycleStage: v })}
      />
      <PropertyRow
        icon={Languages}
        label={st('sweep.entities.fieldLanguage')}
        value={person.preferredLanguage}
        onSave={(v) => onUpdateField({ preferredLanguage: v })}
      />
      <PropertyRow
        icon={ExternalLink}
        label={st('sweep.entities.fieldLinkedIn')}
        type="url"
        value={person.linkedinUrl}
        onSave={(v) => onUpdateField({ linkedinUrl: v })}
      />
      <PropertyRow
        icon={MapPin}
        label={st('sweep.entities.fieldAddress')}
        type="address"
        value={formatAddress(person.primaryAddress) || null}
        readOnly
        placeholder={st('sweep.entities.setAddressPlaceholder')}
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

function PersonCompaniesTab({
  employments,
  onOpenCompany,
}: {
  employments: PersonCompanyRow[];
  onOpenCompany: (companyId: string) => void;
}) {
  const st = useTranslations();
  if (employments.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground text-center">
        {st('sweep.entities.notAffiliatedWithCompany')}
      </div>
    );
  }
  return (
    <ul className="p-2 space-y-0.5">
      {employments.map((pc) => {
        const name = pc.company?.displayName ?? st('sweep.entities.deletedCompany');
        return (
          <li key={pc.id}>
            <Button
              variant="ghost"
              onClick={() => onOpenCompany(pc.companyId)}
              className="w-full text-left text-sm flex items-center justify-between gap-2 hover:bg-muted/50 rounded-md px-2 py-1.5 transition-colors"
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
          </li>
        );
      })}
    </ul>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function PersonPanel(props: ObjectPanelComponentProps) {
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

  // The chat channel is created lazily on the first sent message, so
  // "channel exists" === "there is at least one message". Reads from the same
  // cached query PersonChat runs, so it adds no extra request. Used to hide the
  // resize-handle line above the composer until a conversation actually exists.
  const personChannel = usePersonChannel(id);
  const hasMessages = !!personChannel.data?.data;

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      avatar={<PersonAvatar person={person} onUpload={(url) => handleUpdateField({ avatarUrl: url })} />}
      title={<PersonTitle person={person} />}
      actions={<PersonActions person={person} onDelete={handleDelete} />}
      tabs={
        <PersonPanelTabsBar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          mode={mode}
          companyCount={employments.length}
        />
      }
      sidebar={chatSidebar}
      sidebarShowResizeHandle={hasMessages}
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
          defaultDialNumber={person.directPhone ?? person.mobilePhone ?? undefined}
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
