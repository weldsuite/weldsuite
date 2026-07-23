/**
 * Company object panel — full-fat version that mirrors the legacy
 * customer/contact panels' look + feel.
 *
 * Layout:
 *   - Header: avatar / displayName / inline actions (email, phone, kebab)
 *   - Tab strip with the same 11 tabs the customer panel uses; in panel
 *     mode only Details + Activity + People show by default, the rest are
 *     toggleable via the kebab menu's "Configure tabs" submenu. Fullscreen
 *     shows all tabs.
 *   - Details body: a vertical list of `PropertyRow`s — same icon + label +
 *     inline-editable value affordance as the customer panel.
 *   - All 11 tabs are wired: Details, Activity, People, Emails, Calls,
 *     Pipeline, Notes, Meetings, Tasks, Files, Audit Log.
 *   - Sidebar: company chat (locked-open in fullscreen).
 */

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  Archive,
  Bookmark,
  Briefcase,
  Building,
  Check,
  Diamond,
  EllipsisVertical,
  Flag,
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
import { MemberSelect } from '@/components/team/member-select';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { companyStatusConfig } from '@/app/weldcrm/companies/config/company-grid-config';
import { cn } from '@/lib/utils';
import {
  useCompany,
  useCompanyPeople,
  useUpdateCompany,
  useArchiveCompany,
  useUnarchiveCompany,
  useDeleteCompany,
  useCompanyChannel,
} from './use-company-data';
import { useUnlinkPersonFromCompany } from '@/hooks/queries/use-person-companies-queries';
import { EntityList } from '@/components/entity-list';
import { LinkPersonPopover } from './link-person-popover';
import { CompanyChat } from './company-chat';
import { COMPANY_TABS, type CompanyTab } from './company-tabs';
import type { Company } from '@weldsuite/app-api-client/schemas/companies';

const COMPANY_PANEL_WIDTH = 400;

// ─── Header ────────────────────────────────────────────────────────────────

function companyInitial(name: string): string {
  const trimmed = name?.trim() ?? '';
  return (trimmed[0] ?? '#').toUpperCase();
}

function CompanyAvatar({ company, onUpload }: { company?: Company; onUpload?: (url: string) => void }) {
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

function CompanyTitle({ company }: { company?: Company }) {
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
}: {
  company?: Company;
  onArchiveToggle: () => void;
  onDelete: () => void;
  tabFields: TabConfigEntry[];
  isTabVisible: (id: string) => boolean;
  onToggleTab: (id: string) => void;
  onResetTabs: () => void;
}) {
  const st = useTranslations();
  if (!company) return null;

  return (
    <div className="flex items-center gap-0.5">
      {company.email && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="p-1.5 hover:bg-muted rounded-md transition-colors"
              onClick={() => { window.location.href = `mailto:${company.email}`; }}
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
}: {
  activeTab: CompanyTab['id'];
  setActiveTab: (id: CompanyTab['id']) => void;
  peopleCount: number;
  isTabVisible: (id: string) => boolean;
}) {
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

const STATUS_OPTIONS = ['active', 'prospect', 'inactive', 'churned', 'suspended'] as const;

function StatusBadge({ value }: { value: string }) {
  const style = companyStatusConfig[value];
  const label = style?.label ?? value;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
        style?.bg ?? 'bg-muted',
        style?.color ?? 'text-foreground',
      )}
    >
      {label}
    </span>
  );
}

function StatusPropertyRow({
  value,
  onChange,
}: {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
}) {
  const st = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <div className="grid grid-cols-[120px_1fr_auto] gap-2 items-center group/row min-h-[32px]">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Flag className="h-4 w-4" />
        <span>{st('sweep.entities.fieldStatus')}</span>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="text-sm min-w-0 text-left cursor-pointer rounded px-1.5 -mx-1.5 py-0.5 hover:bg-muted/40 transition-colors flex items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring h-auto"
          >
            {value ? (
              <StatusBadge value={value} />
            ) : (
              <span className="text-muted-foreground/70">{st('sweep.entities.setStatusPlaceholder')}</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <Command>
            <CommandInput placeholder={st('sweep.entities.searchEllipsisPlaceholder')} />
            <CommandList className="max-h-[260px] p-1">
              <CommandEmpty>{st('sweep.entities.noStatusesFound')}</CommandEmpty>
              {STATUS_OPTIONS.map((opt) => {
                const isSelected = opt === value;
                return (
                  <CommandItem
                    key={opt}
                    value={companyStatusConfig[opt]?.label ?? opt}
                    onSelect={() => {
                      onChange(opt);
                      setOpen(false);
                    }}
                    className="flex items-center justify-between gap-2 px-1.5"
                  >
                    <StatusBadge value={opt} />
                    {isSelected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                  </CommandItem>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <div />
    </div>
  );
}

function MemberPropertyRow({
  icon: Icon,
  label,
  value,
  placeholder,
  onChange,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  placeholder: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr_auto] gap-2 items-center group/row min-h-[32px]">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <div className="min-w-0 -mx-2">
        <MemberSelect
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          variant="assignee"
        />
      </div>
      <div />
    </div>
  );
}

function CompanyDetailsTab({
  company,
  onUpdateField,
  onUpdateFieldAsync,
}: {
  company: Company;
  onUpdateField: (patch: Record<string, unknown>) => void;
  onUpdateFieldAsync: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const st = useTranslations();
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
      <PropertyRow
        icon={Tag}
        label={st('sweep.entities.fieldTags')}
        value={company.tags?.length ? company.tags.join(', ') : null}
        readOnly
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
      <PropertyRow
        icon={Smile}
        label={st('sweep.entities.fieldLifecycle')}
        value={company.lifecycleStage}
        onSave={(v) => onUpdateField({ lifecycleStage: v })}
      />
      <PropertyRow
        icon={Languages}
        label={st('sweep.entities.fieldLanguage')}
        value={company.preferredLanguage}
        onSave={(v) => onUpdateField({ preferredLanguage: v })}
      />
      <PropertyRow
        icon={MapPin}
        label={st('sweep.entities.fieldAddress')}
        type="address"
        value={formatAddress(company.primaryAddress) || null}
        readOnly
        placeholder={st('sweep.entities.setAddressPlaceholder')}
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
}: {
  companyId: string;
  employments: CompanyPersonRow[];
  onOpenPerson: (personId: string) => void;
}) {
  const st = useTranslations();
  const unlinkMut = useUnlinkPersonFromCompany();
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
            </span>
          </Button>
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
    [companyId, onOpenPerson, unlinkMut, st],
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

export function CompanyPanel(props: ObjectPanelComponentProps) {
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

  const handleDelete = useCallback(() => {
    if (!company) return;
    deleteMut.mutate(company.id, {
      onSuccess: () => {
        toast.success(st('sweep.entities.companyDeleted'));
        onClose();
      },
      onError: (err: unknown) =>
        toast.error(err instanceof Error ? err.message : st('sweep.entities.deleteFailed')),
    });
  }, [company, deleteMut, onClose, st]);

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

  // The chat channel is created lazily on the first sent message, so
  // "channel exists" === "there is at least one message". Reads from the same
  // cached query CompanyChat runs, so it adds no extra request. Drives the
  // chat region's top border — hidden until a conversation exists. The drag
  // handle itself is always visible so the Details list can be resized either
  // way.
  const companyChannel = useCompanyChannel(id);
  const hasMessages = !!companyChannel.data?.data;

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
      sidebarShowResizeHandle={hasMessages}
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
          defaultDialNumber={company.phone ?? undefined}
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
    </EntityDetailView>
  );
}
