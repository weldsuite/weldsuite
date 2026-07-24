/**
 * Opportunity object panel — mirrors the company / person / task panels:
 * shared `useObjectPanelShell` + `EntityDetailView` shell, `PropertyRow`
 * details body, per-mode tab visibility via `useObjectPanelTabConfig`.
 *
 * Layout:
 *  - Header: avatar (initial of opportunity name) / title / actions (kebab:
 *    copy link, open in new tab, mark won, mark lost, delete).
 *  - Tab strip: Details + Activity + Company + Contacts visible by default
 *    (Contacts in fullscreen only); remaining tabs render `ComingSoonTab`.
 *  - Details body: vertical list of `PropertyRow`s for every editable field.
 *  - Sidebar omitted in v1 — opportunity chat needs an app-api endpoint
 *    (`/opportunities/{id}/chat/channel`) that doesn't exist yet. Add the
 *    sidebar in a follow-up when that route lands.
 */

import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  Activity as ActivityIcon,
  Briefcase,
  Building,
  Calendar,
  Check,
  CircleCheck,
  CircleX,
  EllipsisVertical,
  Flag,
  LayoutGrid,
  Megaphone,
  PiggyBank,
  StickyNote,
  Tag,
  Target,
  Trash2,
  TrendingUp,
  User,
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { ComingSoonTab } from '@/components/objects/_shared/coming-soon-tab';
import { MemberSelect } from '@/components/team/member-select';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { cn } from '@/lib/utils';
import {
  useOpportunity,
  useOpportunityActivities,
  useUpdateOpportunity,
  useDeleteOpportunity,
  useWinOpportunity,
  useLoseOpportunity,
  type Opportunity,
} from './use-opportunity-data';
import { OPPORTUNITY_TABS, type OpportunityTab } from './opportunity-tabs';

const OPPORTUNITY_PANEL_WIDTH = 400;

// ─── Header ────────────────────────────────────────────────────────────────

function opportunityInitial(name: string): string {
  const trimmed = name?.trim() ?? '';
  return (trimmed[0] ?? '#').toUpperCase();
}

function OpportunityAvatar({ opportunity }: { opportunity?: Opportunity }) {
  if (!opportunity) return <div className="h-7 w-7 rounded-lg bg-muted animate-pulse" />;
  return (
    <Avatar className="h-7 w-7 rounded-lg border border-border">
      <AvatarFallback className="rounded-lg bg-muted text-[12px] font-medium">
        {opportunityInitial(opportunity.name)}
      </AvatarFallback>
    </Avatar>
  );
}

function OpportunityTitle({ opportunity }: { opportunity?: Opportunity }) {
  if (!opportunity) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <span className="text-[15px] font-medium text-foreground truncate">
      {opportunity.name}
    </span>
  );
}

function OpportunityActions({
  opportunity,
  onMarkWon,
  onMarkLost,
  onDelete,
}: {
  opportunity?: Opportunity;
  onMarkWon: () => void;
  onMarkLost: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations();
  if (!opportunity) return null;

  const isClosed = opportunity.status === 'won' || opportunity.status === 'lost';

  return (
    <div className="flex items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none"
            aria-label={t('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {!isClosed && (
            <>
              <DropdownMenuItem onClick={onMarkWon}>
                <CircleCheck className="h-4 w-4 mr-0.5 text-emerald-600" />
                {t('sweep.entities.markAsWon')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onMarkLost}>
                <CircleX className="h-4 w-4 mr-0.5 text-rose-600" />
                {t('sweep.entities.markAsLost')}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
            {t('sweep.entities.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Tab bar ───────────────────────────────────────────────────────────────

function OpportunityPanelTabsBar({
  activeTab,
  setActiveTab,
  mode,
  activityCount,
}: {
  activeTab: OpportunityTab['id'];
  setActiveTab: (id: OpportunityTab['id']) => void;
  mode: 'panel' | 'fullscreen';
  activityCount: number;
}) {
  const st = useTranslations();
  const configEntries = useMemo(
    () =>
      OPPORTUNITY_TABS.map((t) => ({
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
    objectType: 'opportunity',
    mode,
    tabs: configEntries,
  });

  useEffect(() => {
    if (isVisible(activeTab)) return;
    const fallback = OPPORTUNITY_TABS.find((t) => isVisible(t.id));
    if (fallback && fallback.id !== activeTab) setActiveTab(fallback.id);
  }, [activeTab, isVisible, setActiveTab]);

  const tabs = useMemo(
    () =>
      OPPORTUNITY_TABS.filter((t) => isVisible(t.id)).map((t) => ({
        id: t.id,
        label: t.label,
        icon: t.icon,
        count: t.id === 'activity' ? activityCount : undefined,
      })),
    [isVisible, activityCount],
  );

  return (
    <div className="group/tabs-header relative">
      <ObjectPanelTabs
        tabs={tabs}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as OpportunityTab['id'])}
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

// ─── Stage / status pickers ────────────────────────────────────────────────

function getStageOptions(t: (path: string) => string): { value: string; label: string }[] {
  return [
    { value: 'prospecting', label: t('sweep.entities.stageProspecting') },
    { value: 'qualification', label: t('sweep.entities.stageQualification') },
    { value: 'needs_analysis', label: t('sweep.entities.stageNeedsAnalysis') },
    { value: 'proposal', label: t('sweep.entities.stageProposal') },
    { value: 'negotiation', label: t('sweep.entities.stageNegotiation') },
    { value: 'closed_won', label: t('sweep.entities.stageClosedWon') },
    { value: 'closed_lost', label: t('sweep.entities.stageClosedLost') },
  ];
}

function getStatusOptions(
  t: (path: string) => string,
): { value: string; label: string; tone: string }[] {
  return [
    { value: 'open', label: t('sweep.entities.statusOpen'), tone: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' },
    { value: 'won', label: t('sweep.entities.statusWon'), tone: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200' },
    { value: 'lost', label: t('sweep.entities.statusLost'), tone: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200' },
    { value: 'abandoned', label: t('sweep.entities.statusAbandoned'), tone: 'bg-muted text-muted-foreground' },
  ];
}

function StageBadge({ value }: { value: string }) {
  const t = useTranslations();
  const opt = getStageOptions(t).find((o) => o.value === value);
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium">
      {opt?.label ?? value}
    </span>
  );
}

function StatusBadge({ value }: { value: string }) {
  const t = useTranslations();
  const opt = getStatusOptions(t).find((o) => o.value === value);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
        opt?.tone ?? 'bg-muted text-foreground',
      )}
    >
      {opt?.label ?? value}
    </span>
  );
}

function SelectPropertyRow({
  icon: Icon,
  label,
  value,
  options,
  onChange,
  renderBadge,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string | null | undefined;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
  renderBadge: (value: string) => React.ReactNode;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <div className="grid grid-cols-[120px_1fr_auto] gap-2 items-center group/row min-h-[32px]">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="text-sm min-w-0 text-left cursor-pointer rounded px-1.5 -mx-1.5 py-0.5 hover:bg-muted/40 transition-colors flex items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {value ? (
              renderBadge(value)
            ) : (
              <span className="text-muted-foreground/70">
                {t('sweep.entities.setFieldPlaceholder', { label })}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <Command>
            <CommandInput placeholder={t('sweep.entities.searchEllipsisPlaceholder')} />
            <CommandList className="max-h-[260px] p-1">
              <CommandEmpty>{t('sweep.entities.noOptionsFound')}</CommandEmpty>
              {options.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <CommandItem
                    key={opt.value}
                    value={opt.label}
                    onSelect={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className="flex items-center justify-between gap-2 px-1.5"
                  >
                    {renderBadge(opt.value)}
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

// ─── Details body ──────────────────────────────────────────────────────────

function formatMoney(amount: string | undefined, currency: string | undefined): string | null {
  if (amount === undefined || amount === null || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'EUR',
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency ?? ''} ${n.toFixed(2)}`.trim();
  }
}

function formatDate(iso: string | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

function OpportunityDetailsTab({
  opportunity,
  onUpdateField,
}: {
  opportunity: Opportunity;
  onUpdateField: (patch: Partial<Opportunity>) => void;
}) {
  const t = useTranslations();
  const stageOptions = useMemo(() => getStageOptions(t), [t]);
  const statusOptions = useMemo(() => getStatusOptions(t), [t]);
  return (
    <div className="p-4 space-y-1">
      <PropertyRow
        icon={LayoutGrid}
        label={t('sweep.entities.fieldName')}
        value={opportunity.name}
        onSave={(v) => onUpdateField({ name: v ?? '' })}
      />
      <PropertyRow
        icon={StickyNote}
        label={t('sweep.entities.fieldDescription')}
        type="address"
        value={opportunity.description}
        onSave={(v) => onUpdateField({ description: v ?? undefined })}
      />
      <SelectPropertyRow
        icon={Target}
        label={t('sweep.entities.fieldStage')}
        value={opportunity.stage}
        options={stageOptions}
        onChange={(v) => onUpdateField({ stage: v })}
        renderBadge={(v) => <StageBadge value={v} />}
      />
      <SelectPropertyRow
        icon={Flag}
        label={t('sweep.entities.fieldStatus')}
        value={opportunity.status}
        options={statusOptions}
        onChange={(v) => onUpdateField({ status: v })}
        renderBadge={(v) => <StatusBadge value={v} />}
      />
      <PropertyRow
        icon={TrendingUp}
        label={t('sweep.entities.fieldProbability')}
        value={
          typeof opportunity.probability === 'number'
            ? String(opportunity.probability)
            : null
        }
        onSave={(v) => {
          const n = v ? Number(v) : null;
          onUpdateField({ probability: n === null || Number.isNaN(n) ? undefined : n });
        }}
      />
      <PropertyRow
        icon={PiggyBank}
        label={t('sweep.entities.fieldAmount')}
        value={formatMoney(opportunity.amount, opportunity.currency)}
        onSave={(v) => {
          if (!v) return;
          const cleaned = v.replace(/[^0-9.-]/g, '');
          if (!cleaned) return;
          onUpdateField({ amount: cleaned });
        }}
      />
      <PropertyRow
        icon={PiggyBank}
        label={t('sweep.entities.fieldCurrency')}
        value={opportunity.currency}
        onSave={(v) => onUpdateField({ currency: (v ?? 'EUR').toUpperCase() })}
      />
      <PropertyRow
        icon={Calendar}
        label={t('sweep.entities.fieldCloseDate')}
        value={formatDate(opportunity.closeDate)}
        readOnly
      />
      <PropertyRow
        icon={Calendar}
        label={t('sweep.entities.fieldActualClose')}
        value={formatDate(opportunity.actualCloseDate)}
        readOnly
      />
      <MemberPropertyRow
        icon={User}
        label={t('sweep.entities.fieldOwner')}
        value={opportunity.ownerId ?? ''}
        placeholder={t('sweep.entities.setOwnerPlaceholder')}
        onChange={(v) => onUpdateField({ ownerId: v || '' })}
      />
      <PropertyRow
        icon={Megaphone}
        label={t('sweep.entities.fieldLeadSource')}
        value={opportunity.leadSource}
        onSave={(v) => onUpdateField({ leadSource: v ?? undefined })}
      />
      <PropertyRow
        icon={Megaphone}
        label={t('sweep.entities.fieldCampaign')}
        value={opportunity.campaign}
        onSave={(v) => onUpdateField({ campaign: v ?? undefined })}
      />
      <PropertyRow
        icon={Briefcase}
        label={t('sweep.entities.fieldType')}
        value={opportunity.type}
        onSave={(v) => onUpdateField({ type: v ?? undefined })}
      />
      <PropertyRow
        icon={ActivityIcon}
        label={t('sweep.entities.fieldPipeline')}
        value={opportunity.pipeline}
        onSave={(v) => onUpdateField({ pipeline: v ?? undefined })}
      />
      <PropertyRow
        icon={StickyNote}
        label={t('sweep.entities.fieldNextStep')}
        value={opportunity.nextStep}
        onSave={(v) => onUpdateField({ nextStep: v ?? undefined })}
      />
      <PropertyRow
        icon={Calendar}
        label={t('sweep.entities.fieldNextStepDate')}
        value={formatDate(opportunity.nextStepDate)}
        readOnly
      />
      <PropertyRow
        icon={StickyNote}
        label={t('sweep.entities.fieldWinLossReason')}
        type="address"
        value={opportunity.winLossReason}
        onSave={(v) => onUpdateField({ winLossReason: v ?? undefined })}
      />
      <PropertyRow
        icon={Tag}
        label={t('sweep.entities.fieldTags')}
        value={opportunity.tags?.length ? opportunity.tags.join(', ') : null}
        readOnly
      />
    </div>
  );
}

// ─── Company tab ───────────────────────────────────────────────────────────

function OpportunityCompanyTab({
  opportunity,
  onOpenCompany,
}: {
  opportunity: Opportunity;
  onOpenCompany: (companyId: string) => void;
}) {
  const t = useTranslations();
  if (!opportunity.customerId) {
    return (
      <div className="p-6 text-sm text-muted-foreground text-center">
        {t('sweep.entities.noCompanyLinked')}
      </div>
    );
  }
  const name = opportunity.customerName || t('sweep.entities.unknownCompany');
  return (
    <ul className="p-2 space-y-0.5">
      <li>
        <Button
          variant="ghost"
          onClick={() => onOpenCompany(opportunity.customerId)}
          className="w-full text-left text-sm flex items-center gap-2 hover:bg-muted/50 rounded-md px-2 py-1.5 transition-colors min-w-0"
        >
          <Avatar className="h-7 w-7 rounded-md flex-shrink-0">
            <AvatarFallback className="rounded-md text-[10px]">
              {opportunityInitial(name)}
            </AvatarFallback>
          </Avatar>
          <span className="flex flex-col min-w-0">
            <span className="text-sm text-foreground truncate">{name}</span>
            <span className="text-xs text-muted-foreground truncate">
              {t('sweep.entities.openCompanyPanel')}
            </span>
          </span>
        </Button>
      </li>
    </ul>
  );
}

// ─── Contacts tab ──────────────────────────────────────────────────────────

function OpportunityContactsTab({
  opportunity,
  onOpenPerson,
}: {
  opportunity: Opportunity;
  onOpenPerson: (personId: string) => void;
}) {
  const t = useTranslations();
  const ids = useMemo(() => {
    const set = new Set<string>();
    if (opportunity.primaryContactId) set.add(opportunity.primaryContactId);
    return Array.from(set);
  }, [opportunity.primaryContactId]);

  if (ids.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground text-center">
        {t('sweep.entities.noContactsLinked')}
      </div>
    );
  }
  return (
    <ul className="p-2 space-y-0.5">
      {ids.map((id) => (
        <li key={id}>
          <Button
            variant="ghost"
            onClick={() => onOpenPerson(id)}
            className="w-full text-left text-sm flex items-center gap-2 hover:bg-muted/50 rounded-md px-2 py-1.5 transition-colors min-w-0"
          >
            <Avatar className="h-7 w-7 rounded-md flex-shrink-0">
              <AvatarFallback className="rounded-md text-[10px]">·</AvatarFallback>
            </Avatar>
            <span className="flex flex-col min-w-0">
              <span className="text-sm text-foreground truncate">
                {id === opportunity.primaryContactId
                  ? t('sweep.entities.primaryContact')
                  : t('sweep.entities.contactLabel')}
              </span>
              <span className="text-xs text-muted-foreground truncate">
                {t('sweep.entities.openPersonPanel')}
              </span>
            </span>
            {id === opportunity.primaryContactId && (
              <Badge variant="default" className="ml-auto text-[10px]">{t('sweep.entities.primary')}</Badge>
            )}
          </Button>
        </li>
      ))}
    </ul>
  );
}

// ─── Activity tab ──────────────────────────────────────────────────────────

interface ActivityItem {
  id: string;
  type?: string;
  subject?: string;
  description?: string;
  createdAt?: string;
  dueDate?: string;
}

function OpportunityActivityTab({ opportunityId }: { opportunityId: string }) {
  const t = useTranslations();
  const { data, isLoading } = useOpportunityActivities(opportunityId);
  const items = (data?.data as ActivityItem[] | undefined) ?? [];

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">{t('sweep.entities.loadingActivity')}</div>;
  }
  if (items.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground text-center">
        {t('sweep.entities.noActivityLoggedYet')}
      </div>
    );
  }
  return (
    <ul className="p-2 space-y-0.5">
      {items.map((it) => (
        <li key={it.id} className="rounded-md px-2 py-2 hover:bg-muted/40">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-foreground truncate">
              {it.subject || it.type || t('sweep.entities.activityLabel')}
            </span>
            <span className="text-xs text-muted-foreground">{formatDate(it.createdAt) ?? ''}</span>
          </div>
          {it.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{it.description}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function OpportunityPanel(props: ObjectPanelComponentProps) {
  const t = useTranslations();
  const { id, onClose, initialTab } = props;
  const opportunityQuery = useOpportunity(id);
  const opportunity = opportunityQuery.data?.data as Opportunity | undefined;

  const shell = useObjectPanelShell({
    ...props,
    width: OPPORTUNITY_PANEL_WIDTH,
    loading: opportunityQuery.isLoading && !opportunity,
  });
  const mode = shell.mode;
  const { open: openPanel } = useObjectPanel();

  const updateMut = useUpdateOpportunity();
  const deleteMut = useDeleteOpportunity();
  const winMut = useWinOpportunity();
  const loseMut = useLoseOpportunity();

  const activitiesQuery = useOpportunityActivities(id);
  const activityCount =
    (activitiesQuery.data?.data as ActivityItem[] | undefined)?.length ?? 0;

  const handleUpdateField = useCallback(
    (patch: Partial<Opportunity>) => {
      if (!opportunity) return;
      updateMut.mutate({ id: opportunity.id, data: patch });
    },
    [opportunity, updateMut],
  );

  const handleMarkWon = useCallback(() => {
    if (!opportunity) return;
    winMut.mutate(
      { id: opportunity.id },
      {
        onSuccess: () => toast.success(t('sweep.entities.markedAsWon')),
        onError: (err: unknown) =>
          toast.error(err instanceof Error ? err.message : t('sweep.entities.markWonFailed')),
      },
    );
  }, [opportunity, winMut, t]);

  const handleMarkLost = useCallback(() => {
    if (!opportunity) return;
    loseMut.mutate(
      { id: opportunity.id },
      {
        onSuccess: () => toast.success(t('sweep.entities.markedAsLost')),
        onError: (err: unknown) =>
          toast.error(err instanceof Error ? err.message : t('sweep.entities.markLostFailed')),
      },
    );
  }, [opportunity, loseMut, t]);

  const handleDelete = useCallback(() => {
    if (!opportunity) return;
    deleteMut.mutate(opportunity.id, {
      onSuccess: () => {
        toast.success(t('sweep.entities.opportunityDeleted'));
        onClose();
      },
      onError: (err: unknown) =>
        toast.error(err instanceof Error ? err.message : t('sweep.entities.deleteFailed')),
    });
  }, [opportunity, deleteMut, onClose, t]);

  const initial: OpportunityTab['id'] = useMemo(() => {
    if (initialTab && OPPORTUNITY_TABS.some((tab) => tab.id === initialTab)) {
      return initialTab as OpportunityTab['id'];
    }
    return 'overview';
  }, [initialTab]);
  const [activeTab, setActiveTab] = useState<OpportunityTab['id']>(initial);

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      avatar={<OpportunityAvatar opportunity={opportunity} />}
      title={<OpportunityTitle opportunity={opportunity} />}
      actions={
        <OpportunityActions
          opportunity={opportunity}
          onMarkWon={handleMarkWon}
          onMarkLost={handleMarkLost}
          onDelete={handleDelete}
        />
      }
      tabs={
        <OpportunityPanelTabsBar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          mode={mode}
          activityCount={activityCount}
        />
      }
    >
      {opportunity && activeTab === 'overview' && (
        <OpportunityDetailsTab
          opportunity={opportunity}
          onUpdateField={handleUpdateField}
        />
      )}
      {opportunity && activeTab === 'activity' && (
        <OpportunityActivityTab opportunityId={opportunity.id} />
      )}
      {opportunity && activeTab === 'company' && (
        <OpportunityCompanyTab
          opportunity={opportunity}
          onOpenCompany={(companyId) =>
            openPanel({ type: 'company', id: companyId, stack: true })
          }
        />
      )}
      {opportunity && activeTab === 'contacts' && (
        <OpportunityContactsTab
          opportunity={opportunity}
          onOpenPerson={(personId) =>
            openPanel({ type: 'person', id: personId, stack: true })
          }
        />
      )}
      {opportunity &&
        activeTab !== 'overview' &&
        activeTab !== 'activity' &&
        activeTab !== 'company' &&
        activeTab !== 'contacts' && (
          <ComingSoonTab
            icon={OPPORTUNITY_TABS.find((tab) => tab.id === activeTab)?.icon ?? Building}
            label={OPPORTUNITY_TABS.find((tab) => tab.id === activeTab)?.label ?? t('sweep.entities.comingSoon')}
          />
        )}
    </EntityDetailView>
  );
}
