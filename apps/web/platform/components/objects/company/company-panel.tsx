/**
 * Company object panel — full-fat version that mirrors the legacy
 * customer/contact panels' look + feel.
 *
 * Layout:
 *   - Header: avatar / displayName / inline actions (email, phone, kebab)
 *   - Tab strip with the same 11 tabs the customer panel uses. Every tab is
 *     visible by default in both modes; whatever doesn't fit the width
 *     collapses into the strip's "+N more" menu. Tabs can still be hidden via
 *     the kebab menu's "Configure tabs" submenu.
 *   - Details body: a vertical list of `PropertyRow`s — same icon + label +
 *     inline-editable value affordance as the customer panel.
 *   - All 11 tabs are wired: Details, Activity, People, Emails, Calls,
 *     Pipeline, Notes, Meetings, Tasks, Files, Audit Log.
 *   - Sidebar: company chat (locked-open in fullscreen).
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Archive,
  Bookmark,
  Briefcase,
  Building,
  Diamond,
  EllipsisVertical,
  Globe,
  Languages,
  Mail,
  MapPin,
  Phone,
  Receipt,
  RotateCcw,
  Settings2,
  Smile,
  Tag,
  Trash2,
  User,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { useComposeSafe } from '@/contexts/compose-context';
import {
  ObjectPanelTabs,
  useObjectPanel,
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { EditableEntityAvatar } from '@/components/objects/editable-entity-avatar';
import {
  PropertyRow,
  MemberPropertyRow,
  StatusPropertyRow,
  TagsPropertyRow,
} from '@/components/objects/_shared/property-row';
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
import { useCustomerStatusOptions } from '@/hooks/queries/use-weldcrm-customer-statuses';
import {
  useCompany,
  useCompanyPeople,
  useUpdateCompany,
  useArchiveCompany,
  useUnarchiveCompany,
  useDeleteCompany,
} from './use-company-data';
import { useUnlinkPersonFromCompany } from '@/hooks/queries/use-person-companies-queries';
import {
  useCommercePortalAccess,
  useInviteCommercePortalAccess,
  useResendCommercePortalAccess,
  useRevokeCommercePortalAccess,
} from '@/hooks/queries/use-commerce-queries';
import { EntityList } from '@/components/entity-list';
import { LinkPersonPopover } from './link-person-popover';
import { CompanyChat } from './company-chat';
import { useCompanyDeleteGuard } from './use-company-delete-guard';
import { COMPANY_TABS, type CompanyTab } from './company-tabs';
import type { Company } from '@weldsuite/app-api-client/schemas/companies';

const COMPANY_PANEL_WIDTH = 400;

// ─── Header ────────────────────────────────────────────────────────────────

function companyInitial(name: string): string {
  const trimmed = name?.trim() ?? '';
  return (trimmed[0] ?? '#').toUpperCase();
}

function CompanyAvatar({ company, onUpload }: Readonly<{ company?: Company; onUpload?: (url: string) => void }>) {
  if (!company) return <div className="h-7 w-7 rounded-lg bg-muted animate-pulse" />;
  const initial = companyInitial(company.displayName);
  // Treat empty strings as "no avatar" so the fallback initial renders.
  const avatarSrc = company.avatarUrl && company.avatarUrl.length > 0 ? company.avatarUrl : undefined;
  if (onUpload) {
    return (
      <EditableEntityAvatar
        src={avatarSrc}
        initial={initial}
        onUploaded={onUpload}
        entityType="company-avatar"
        entityId={company.id}
      />
    );
  }
  return (
    <Avatar className="h-7 w-7 rounded-lg border border-border">
      {avatarSrc && (
        <AvatarImage src={avatarSrc} className="rounded-lg object-cover" />
      )}
      <AvatarFallback className="rounded-lg bg-muted text-[12px] font-medium">
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}

function CompanyTitle({ company }: Readonly<{ company?: Company }>) {
  if (!company) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <span className="text-[15px] font-medium text-foreground truncate">
      {company.displayName}
    </span>
  );
}

type TabConfigEntry = {
  id: CompanyTab['id'];
  label: string;
  required?: boolean;
  defaultVisible: boolean;
};

function CompanyActions({
  company,
  onArchiveToggle,
  onDelete,
  tabFields,
  isTabVisible,
  onToggleTab,
  onResetTabs,
}: Readonly<{
  company?: Company;
  onArchiveToggle: () => void;
  onDelete: () => void;
  tabFields: TabConfigEntry[];
  isTabVisible: (id: string) => boolean;
  onToggleTab: (id: string) => void;
  onResetTabs: () => void;
}>) {
  const st = useTranslations();
  const compose = useComposeSafe();
  if (!company) return null;

  const handleCompose = () => {
    if (!company.email) return;
    if (compose) {
      compose.openCompose({ to: company.email });
      return;
    }
    window.location.href = `mailto:${company.email}`;
  };

  return (
    <div className="flex items-center gap-0.5">
      {company.email && (
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
      {company.phone && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              onClick={() => { window.location.href = `tel:${company.phone}`; }}
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Settings2 className="h-4 w-4 mr-0.5" />
              {st('sweep.entities.configureTabs')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              <DropdownMenuLabel className="flex items-center justify-between gap-2">
                <span>{st('sweep.entities.visibleTabs')}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.preventDefault();
                    onResetTabs();
                  }}
                  className="p-1 -mr-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                  title={st('sweep.entities.resetToDefaults')}
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {tabFields.map((field) => {
                const isOn = field.required || isTabVisible(field.id);
                return (
                  <DropdownMenuCheckboxItem
                    key={field.id}
                    checked={isOn}
                    disabled={field.required}
                    onCheckedChange={() => onToggleTab(field.id)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    {field.label}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onArchiveToggle}>
            <Archive className="h-4 w-4 mr-0.5" />
            {company.archivedAt ? st('sweep.entities.unarchive') : st('sweep.entities.archive')}
          </DropdownMenuItem>
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

function CompanyPanelTabsBar({
  activeTab,
  setActiveTab,
  peopleCount,
  isTabVisible,
}: Readonly<{
  activeTab: CompanyTab['id'];
  setActiveTab: (id: CompanyTab['id']) => void;
  peopleCount: number;
  isTabVisible: (id: string) => boolean;
}>) {
  const tabs = useMemo(
    () =>
      COMPANY_TABS.filter((t) => isTabVisible(t.id)).map((t) => ({
        id: t.id,
        label: t.label,
        icon: t.icon,
        count: t.id === 'people' ? peopleCount : undefined,
      })),
    [isTabVisible, peopleCount],
  );

  return (
    <ObjectPanelTabs
      tabs={tabs}
      activeTab={activeTab}
      onChange={(id) => setActiveTab(id as CompanyTab['id'])}
    />
  );
}

// ─── Details body ──────────────────────────────────────────────────────────

function CompanyDetailsTab({
  company,
  onUpdateField,
  onUpdateFieldAsync,
}: Readonly<{
  company: Company;
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
        icon={Globe}
        label={st('sweep.entities.fieldWebsite')}
        type="url"
        value={company.website}
        onSave={(v) => onUpdateField({ website: v })}
      />
      <PropertyRow
        icon={Bookmark}
        label={st('sweep.entities.fieldName')}
        value={company.name}
        onSave={(v) => onUpdateField({ name: v ?? '' })}
      />
      <PropertyRow
        icon={Mail}
        label={st('sweep.entities.fieldEmail')}
        type="email"
        value={company.email}
        onSave={(v) => onUpdateField({ email: v ?? '' })}
      />
      <PropertyRow
        icon={Phone}
        label={st('sweep.entities.fieldPhone')}
        type="phone"
        value={company.phone}
        onSave={(v) => onUpdateField({ phone: v })}
      />
      <PropertyRow
        icon={Phone}
        label={st('sweep.entities.fieldMobile')}
        type="phone"
        value={company.mobile}
        onSave={(v) => onUpdateField({ mobile: v })}
      />
      <MemberPropertyRow
        icon={User}
        label={st('sweep.entities.fieldOwner')}
        value={company.ownerId ?? ''}
        placeholder={st('sweep.entities.setOwnerPlaceholder')}
        onChange={(v) => onUpdateField({ ownerId: v || null })}
      />
      <MemberPropertyRow
        icon={Briefcase}
        label={st('sweep.entities.fieldManager')}
        value={company.accountManagerId ?? ''}
        placeholder={st('sweep.entities.setManagerPlaceholder')}
        onChange={(v) => onUpdateField({ accountManagerId: v || null })}
      />
      <TagsPropertyRow
        icon={Tag}
        label={st('sweep.entities.fieldTags')}
        value={company.tags}
        onChange={(next) => onUpdateField({ tags: next })}
      />
      <PropertyRow
        icon={Building}
        label={st('sweep.entities.fieldIndustry')}
        value={company.industry}
        onSave={(v) => onUpdateField({ industry: v })}
      />
      <StatusPropertyRow
        value={company.status}
        onChange={(v) => onUpdateField({ status: v ?? '' })}
        options={statusOptions}
      />
      <PropertyRow
        icon={Receipt}
        label={st('sweep.entities.fieldVat')}
        value={company.vatNumber}
        onSave={(v) => onUpdateField({ vatNumber: v })}
      />
      <PropertyRow
        icon={Diamond}
        label={st('sweep.entities.fieldRegistrationNumber')}
        value={company.registrationNumber}
        onSave={(v) => onUpdateField({ registrationNumber: v })}
      />
      <PropertyRow
        icon={Users}
        label={st('sweep.entities.fieldEmployees')}
        value={company.employeeCount}
        onSave={(v) => onUpdateField({ employeeCount: v })}
      />
      <SelectPropertyRow
        icon={Smile}
        label={st('sweep.entities.fieldLifecycle')}
        value={company.lifecycleStage}
        options={lifecycleOptions}
        onChange={(v) => onUpdateField({ lifecycleStage: v })}
      />
      <SelectPropertyRow
        icon={Languages}
        label={st('sweep.entities.fieldLanguage')}
        value={company.preferredLanguage}
        options={languageOptions}
        onChange={(v) => onUpdateField({ preferredLanguage: v })}
      />
      <AddressPropertyRow
        icon={MapPin}
        label={st('sweep.entities.fieldAddress')}
        value={company.primaryAddress as Record<string, unknown> | null | undefined}
        placeholder={st('sweep.entities.setAddressPlaceholder')}
        onSave={(next) => onUpdateFieldAsync({ primaryAddress: next })}
      />

      <CustomFieldsSidebarSection
        entityType="company"
        values={company.customFields as Record<string, unknown> | null | undefined}
        onSave={(next) => onUpdateFieldAsync({ customFields: next })}
        layout="row"
      />
    </div>
  );
}

// ─── People tab ────────────────────────────────────────────────────────────

type CompanyPersonRow = {
  id: string;
  personId: string;
  role?: string | null;
  isPrimary?: boolean | null;
  endedAt?: string | null;
  person?: {
    displayName: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
  } | null;
};

function personRowInitial(p: CompanyPersonRow['person']): string {
  if (!p) return '?';
  const first = p.firstName?.[0] ?? '';
  const last = p.lastName?.[0] ?? '';
  return ((first + last) || p.displayName?.[0] || '?').toUpperCase();
}

function personRowGravatar(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  return `https://www.gravatar.com/avatar/${encodeURIComponent(email.toLowerCase())}?d=mp&s=48`;
}

// Search-friendly row: flattens the nested person fields up to the top level
// so EntityList's `searchFields` (which reads `keyof T`) can match on name /
// email without a custom `applyFilters`.
type CompanyPersonListItem = CompanyPersonRow & {
  name: string;
  email: string;
};

function CompanyPeopleTab({
  companyId,
  employments,
  onOpenPerson,
}: Readonly<{
  companyId: string;
  employments: CompanyPersonRow[];
  onOpenPerson: (personId: string) => void;
}>) {
  const st = useTranslations();
  const portalT = getTranslations('commerce').module.portal;
  const unlinkMut = useUnlinkPersonFromCompany();
  const accessQuery = useCommercePortalAccess(companyId);
  const inviteMut = useInviteCommercePortalAccess();
  const revokeMut = useRevokeCommercePortalAccess(companyId);
  const resendMut = useResendCommercePortalAccess(companyId);
  const accessByPerson = useMemo(() => {
    const map = new Map<string, { id: string; status: string }>();
    for (const row of accessQuery.data?.data ?? []) {
      map.set(row.personId, { id: row.id, status: row.status });
    }
    return map;
  }, [accessQuery.data]);
  const linkedIds = useMemo(
    () => new Set(employments.map((e) => e.personId)),
    [employments],
  );

  const items = useMemo<CompanyPersonListItem[]>(
    () =>
      employments.map((pc) => ({
        ...pc,
        name: pc.person?.displayName ?? '',
        email: pc.person?.email ?? '',
      })),
    [employments],
  );

  const renderRow = useCallback(
    (pc: CompanyPersonListItem) => {
      const name = pc.person?.displayName ?? st('sweep.entities.deletedPerson');
      const avatarSrc = pc.person?.avatarUrl ?? personRowGravatar(pc.person?.email);
      let portalActions: ReactNode = null;
      if (!pc.endedAt && pc.person?.email) {
        if (accessByPerson.get(pc.personId)?.status === 'revoked' || !accessByPerson.get(pc.personId)) {
          portalActions = (
            <Button
              variant="ghost"
              size="sm"
              className="opacity-0 group-hover/row:opacity-100 h-7 text-xs"
              disabled={inviteMut.isPending}
              onClick={() => {
                inviteMut.mutate(
                  { personId: pc.personId, companyId },
                  {
                    onSuccess: () => toast.success(portalT.invitedToast),
                    onError: () => toast.error(portalT.inviteFailed),
                  },
                );
              }}
            >
              {portalT.invite}
            </Button>
          );
        } else {
          portalActions = (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="opacity-0 group-hover/row:opacity-100 h-7 text-xs"
                disabled={resendMut.isPending}
                onClick={() => {
                  const access = accessByPerson.get(pc.personId);
                  if (!access) return;
                  resendMut.mutate(access.id, {
                    onSuccess: () => toast.success(portalT.resentToast),
                    onError: () => toast.error(portalT.inviteFailed),
                  });
                }}
              >
                {portalT.resend}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="opacity-0 group-hover/row:opacity-100 h-7 text-xs"
                disabled={revokeMut.isPending}
                onClick={() => {
                  const access = accessByPerson.get(pc.personId);
                  if (!access) return;
                  revokeMut.mutate(access.id, {
                    onSuccess: () => toast.success(portalT.revokedToast),
                  });
                }}
              >
                {portalT.revoke}
              </Button>
            </>
          );
        }
      }
      return (
        <div key={pc.id} className="group/row flex items-center gap-1 px-2 py-0.5">
          <Button
            variant="ghost"
            onClick={() => onOpenPerson(pc.personId)}
            className="flex-1 text-left text-sm flex items-center justify-between gap-2 hover:bg-muted/50 rounded-md px-2 py-1.5 transition-colors min-w-0 h-auto"
          >
            <span className="flex items-center gap-2 min-w-0">
              <Avatar className="h-7 w-7 rounded-md flex-shrink-0">
                <AvatarImage src={avatarSrc} className="rounded-md object-cover" />
                <AvatarFallback className="rounded-md text-[10px]">
                  {personRowInitial(pc.person)}
                </AvatarFallback>
              </Avatar>
              <span className="flex flex-col min-w-0">
                <span className="text-sm text-foreground truncate">{name}</span>
                {pc.role || pc.person?.email ? (
                  <span className="text-xs text-muted-foreground truncate">
                    {pc.role ? pc.role : pc.person?.email}
                    {pc.role && pc.person?.email ? ` · ${pc.person.email}` : ''}
                  </span>
                ) : null}
              </span>
            </span>
            <span className="flex items-center gap-1 flex-shrink-0">
              {pc.endedAt && <Badge variant="outline" className="text-[10px]">{st('sweep.entities.past')}</Badge>}
              {pc.isPrimary && <Badge variant="default" className="text-[10px]">{st('sweep.entities.primary')}</Badge>}
              {accessByPerson.get(pc.personId)?.status === 'active' && (
                <Badge variant="secondary" className="text-[10px]">{portalT.statusActive}</Badge>
              )}
              {accessByPerson.get(pc.personId)?.status === 'invited' && (
                <Badge variant="outline" className="text-[10px]">{portalT.statusInvited}</Badge>
              )}
            </span>
          </Button>
          {portalActions}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              unlinkMut.mutate(
                { id: pc.id, personId: pc.personId, companyId },
                { onSuccess: () => toast.success(st('sweep.entities.unlinked')) },
              );
            }}
            disabled={unlinkMut.isPending}
            className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 p-1.5 hover:bg-muted rounded-md text-muted-foreground hover:text-foreground transition-[opacity,color,background-color]"
            aria-label={st('sweep.entities.unlink')}
            title={st('sweep.entities.unlinkFromCompany')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      );
    },
    [accessByPerson, companyId, inviteMut, onOpenPerson, portalT, resendMut, revokeMut, unlinkMut, st],
  );

  return (
    <EntityList<CompanyPersonListItem>
      items={items}
      isLoading={false}
      error={null}
      filters={[]}
      renderRow={renderRow}
      searchPlaceholder={st('sweep.entities.searchPeoplePlaceholder')}
      searchFields={['name', 'email', 'role']}
      actionButtons={
        <LinkPersonPopover companyId={companyId} linkedPersonIds={linkedIds} />
      }
      itemsClassName="py-1.5"
      emptyState={{
        icon: <Users className="h-8 w-8 text-muted-foreground/60 mb-3" />,
        title: st('sweep.entities.noPeopleYetTitle'),
        description: st('sweep.entities.noPeopleYetDescription'),
      }}
      noResultsState={{
        title: st('sweep.entities.noPeopleFoundTitle'),
        description: st('sweep.entities.noPeopleFoundDescription'),
      }}
    />
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function CompanyPanel(props: Readonly<ObjectPanelComponentProps>) {
  const st = useTranslations();
  const { id, onClose, initialTab } = props;
  const companyQuery = useCompany(id);
  const company = companyQuery.data?.data as Company | undefined;
  const peopleQuery = useCompanyPeople(id);
  const employments = peopleQuery.data?.data ?? [];

  const shell = useObjectPanelShell({
    ...props,
    width: COMPANY_PANEL_WIDTH,
    loading: companyQuery.isLoading && !company,
  });
  const mode = shell.mode;
  const { open: openPanel } = useObjectPanel();

  const updateMut = useUpdateCompany();
  const archiveMut = useArchiveCompany();
  const unarchiveMut = useUnarchiveCompany();
  const deleteMut = useDeleteCompany();
  const { confirmDelete: confirmCompanyDelete, dialog: companyDeleteDialog } = useCompanyDeleteGuard();

  const handleUpdateField = useCallback((patch: Record<string, unknown>) => {
    if (!company) return;
    updateMut.mutate({ id: company.id, data: patch as Parameters<typeof updateMut.mutate>[0]['data'] });
  }, [company, updateMut]);

  const handleUpdateFieldAsync = useCallback(async (patch: Record<string, unknown>) => {
    if (!company) return;
    await updateMut.mutateAsync({ id: company.id, data: patch as Parameters<typeof updateMut.mutate>[0]['data'] });
  }, [company, updateMut]);

  const handleArchiveToggle = useCallback(() => {
    if (!company) return;
    const mut = company.archivedAt ? unarchiveMut : archiveMut;
    mut.mutate(company.id, {
      onSuccess: () =>
        toast.success(company.archivedAt ? st('sweep.entities.unarchived') : st('sweep.entities.archived')),
      onError: (err: unknown) =>
        toast.error(err instanceof Error ? err.message : st('sweep.entities.archiveUpdateFailed')),
    });
  }, [company, archiveMut, unarchiveMut, st]);

  const handleDelete = useCallback(async () => {
    if (!company) return;
    // Warn first when the company still has open deals (TASK-1040).
    if (!(await confirmCompanyDelete([company.id]))) return;
    deleteMut.mutate(company.id, {
      onSuccess: () => {
        toast.success(st('sweep.entities.companyDeleted'));
        onClose();
      },
      onError: (err: unknown) =>
        toast.error(err instanceof Error ? err.message : st('sweep.entities.deleteFailed')),
    });
  }, [company, deleteMut, confirmCompanyDelete, onClose, st]);

  const initial: CompanyTab['id'] = useMemo(() => {
    if (initialTab && COMPANY_TABS.some((t) => t.id === initialTab)) {
      return initialTab as CompanyTab['id'];
    }
    return 'overview';
  }, [initialTab]);
  const [activeTab, setActiveTab] = useState<CompanyTab['id']>(initial);

  // Tab visibility config — lifted here so the "Configure tabs" control can
  // live in the header's kebab (3-dots) menu while the tab strip stays a
  // presentational consumer.
  const tabConfigEntries = useMemo<TabConfigEntry[]>(
    () =>
      COMPANY_TABS.map((t) => ({
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

  const {
    isVisible: isTabVisible,
    toggle: toggleTab,
    resetToDefaults: resetTabs,
  } = useObjectPanelTabConfig({
    objectType: 'company',
    mode,
    tabs: tabConfigEntries,
  });

  useEffect(() => {
    if (isTabVisible(activeTab)) return;
    const fallback = COMPANY_TABS.find((t) => isTabVisible(t.id));
    if (fallback && fallback.id !== activeTab) setActiveTab(fallback.id);
  }, [activeTab, isTabVisible]);

  const chatSidebar = (
    <CompanyChat companyId={id} companyName={company?.displayName} />
  );

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      avatar={<CompanyAvatar company={company} onUpload={(url) => handleUpdateField({ avatarUrl: url })} />}
      title={<CompanyTitle company={company} />}
      actions={
        <CompanyActions
          company={company}
          onArchiveToggle={handleArchiveToggle}
          onDelete={handleDelete}
          tabFields={tabConfigEntries}
          isTabVisible={isTabVisible}
          onToggleTab={toggleTab}
          onResetTabs={resetTabs}
        />
      }
      tabs={
        <CompanyPanelTabsBar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          peopleCount={employments.length}
          isTabVisible={isTabVisible}
        />
      }
      sidebar={chatSidebar}
      sidebarDefaultSize={mode === 'panel' ? 320 : 500}
      sidebarMinSize={mode === 'panel' ? 140 : 320}
      sidebarMaxSize={mode === 'panel' ? undefined : 900}
      sidebarPersistKey={mode === 'fullscreen' ? 'company-panel-chat-right' : 'company-panel-chat-bottom'}
      sidebarDefaultCollapsed={false}
      sidebarDefaultOpen
      sidebarLocked={false}
    >
      {company && activeTab === 'overview' && (
        <CompanyDetailsTab
          company={company}
          onUpdateField={handleUpdateField}
          onUpdateFieldAsync={handleUpdateFieldAsync}
        />
      )}
      {company && activeTab === 'people' && (
        <CompanyPeopleTab
          companyId={company.id}
          employments={employments}
          onOpenPerson={(personId) => openPanel({ type: 'person', id: personId, stack: true })}
        />
      )}
      {company && activeTab === 'notes' && (
        <NotesTab
          entityId={company.id}
          entityKind="company"
          entityName={company.displayName}
        />
      )}
      {company && activeTab === 'activity' && (
        <ActivityTab entityId={company.id} entityKind="company" />
      )}
      {company && activeTab === 'deals' && (
        <DealsTab entityId={company.id} entityKind="company" />
      )}
      {company && activeTab === 'calls' && (
        <CallsTab
          entityId={company.id}
          entityKind="company"
        />
      )}
      {company && activeTab === 'meetings' && (
        <MeetingsTab entityId={company.id} entityKind="company" />
      )}
      {company && activeTab === 'tasks' && (
        <TasksTab entityId={company.id} entityKind="company" />
      )}
      {company && activeTab === 'files' && (
        <FilesTab entityId={company.id} entityKind="company" />
      )}
      {company && activeTab === 'emails' && (
        <EmailsTab entityEmail={company.email ?? undefined} entityKind="company" />
      )}
      {company && activeTab === 'audit' && (
        <AuditTab entityId={company.id} entityKind="company" />
      )}
      {companyDeleteDialog}
    </EntityDetailView>
  );
}
