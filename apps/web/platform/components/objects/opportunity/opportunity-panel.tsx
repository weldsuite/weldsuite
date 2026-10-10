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
import { MemberPropertyRow, PropertyRow } from '@/components/objects/_shared/property-row';
import { ComingSoonTab } from '@/components/objects/_shared/coming-soon-tab';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { PickerCheck } from '@/components/shared/picker-menu';
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
import { usePipelines, usePipelineStages } from '@/hooks/queries/use-pipelines-queries';
import { useCompany } from '@/components/objects/company/use-company-data';
import { OPPORTUNITY_TABS, type OpportunityTab } from './opportunity-tabs';
import {
  formatDealDate,
  formatDealMoney,
  fromDateInputValue,
  getCurrencyOptions,
  resolveDealCurrency,
  toDateInputValue,
} from '@/lib/crm/deal-format';

const OPPORTUNITY_PANEL_WIDTH = 400;

// ─── Header ────────────────────────────────────────────────────────────────

function opportunityInitial(name: string): string {
  const trimmed = name?.trim() ?? '';
  return (trimmed[0] ?? '#').toUpperCase();
}

function OpportunityAvatar({ opportunity }: Readonly<{ opportunity?: Opportunity }>) {
  if (!opportunity) return <div className="h-7 w-7 rounded-lg bg-muted animate-pulse" />;
  return (
    <Avatar className="h-7 w-7 rounded-lg border border-border">
      <AvatarFallback className="rounded-lg bg-muted text-[12px] font-medium">
        {opportunityInitial(opportunity.name)}
      </AvatarFallback>
    </Avatar>
  );
}

function OpportunityTitle({ opportunity }: Readonly<{ opportunity?: Opportunity }>) {
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
}: Readonly<{
  opportunity?: Opportunity;
  onMarkWon: () => void;
  onMarkLost: () => void;
  onDelete: () => void;
}>) {
  const t = useTranslations();
  if (!opportunity) return null;

  const isClosed = opportunity.status === 'won' || opportunity.status === 'lost';

  return (
    <div className="flex items-center gap-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={t('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!isClosed && (
            <>
              <DropdownMenuItem onClick={onMarkWon}>
                <CircleCheck className="text-emerald-600" />
                {t('sweep.entities.markAsWon')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onMarkLost}>
                <CircleX className="text-rose-600" />
                {t('sweep.entities.markAsLost')}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash2 />
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
}: Readonly<{
  activeTab: OpportunityTab['id'];
  setActiveTab: (id: OpportunityTab['id']) => void;
  mode: 'panel' | 'fullscreen';
  activityCount: number;
}>) {
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

/**
 * Legacy free-text stage values. Only used to label deals that predate
 * pipeline stages (`stageId` is empty) — the stage picker itself lists the
 * deal's own pipeline stages.
 */
function getLegacyStageOptions(t: (path: string) => string): { value: string; label: string }[] {
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

function StageBadge({ label }: Readonly<{ label: string }>) {
  return (
    <span className="inline-flex max-w-full items-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium break-words [overflow-wrap:anywhere]">
      {label}
    </span>
  );
}

function StatusBadge({ value }: Readonly<{ value: string }>) {
  const t = useTranslations();
  const opt = getStatusOptions(t).find((o) => o.value === value);
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-md px-1.5 py-0.5 text-xs font-medium',
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
}: Readonly<{
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string | null | undefined;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
  renderBadge: (value: string) => React.ReactNode;
}>) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    // `minmax(0,1fr)`, not `1fr`: a plain `1fr` track can't shrink below its
    // content, so a wide value stretched the row past the 400px panel and the
    // whole Details body scrolled sideways (TASK-1086). The trigger is a plain
    // button with the shared Select/Status rows' geometry (the ghost `Button`
    // centres its content and never wraps), pulled into the gutter so the badge
    // text lines up with the rows above and below it.
    <div className="grid grid-cols-[120px_minmax(0,1fr)_auto] gap-2 items-center group/row min-h-[32px]">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 w-[calc(100%+1rem)] -mx-2 px-2 min-h-[32px] py-1 items-center justify-start text-left text-sm cursor-pointer rounded-[9px] hover:bg-muted/50 data-[state=open]:bg-muted/50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {value ? (
              <span className="-ml-1.5 flex min-w-0 max-w-full">{renderBadge(value)}</span>
            ) : (
              <span className="text-muted-foreground/70">
                {t('sweep.entities.setFieldPlaceholder', { label })}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <Command>
            <CommandInput placeholder={t('sweep.entities.searchEllipsisPlaceholder')} />
            <CommandList>
              <CommandEmpty>{t('sweep.entities.noOptionsFound')}</CommandEmpty>
              <CommandGroup>
                {options.map((opt) => (
                  <CommandItem
                    key={opt.value}
                    value={opt.label}
                    onSelect={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                  >
                    {renderBadge(opt.value)}
                    <PickerCheck selected={opt.value === value} />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <div />
    </div>
  );
}

// ─── Details body ──────────────────────────────────────────────────────────

function formatMoney(amount: string | undefined | null, currency: string | undefined | null): string | null {
  if (amount === undefined || amount === null || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return formatDealMoney(n, currency, { fractionDigits: 2 });
}

// One close-date format for the card, the Company pipeline tab and this
// panel (TASK-920), shared via `lib/crm/deal-format`.
function formatDate(iso: string | undefined): string | null {
  return formatDealDate(iso);
}

export function OpportunityDetailsTab({
  opportunity,
  onUpdateField,
}: Readonly<{
  opportunity: Opportunity;
  onUpdateField: (patch: Partial<Opportunity>) => void;
}>) {
  const t = useTranslations();
  const statusOptions = useMemo(() => getStatusOptions(t), [t]);

  // The board places a deal by `stageId`, so the picker must list the deal's
  // own pipeline stages and write `stageId` (not the legacy `stage` text).
  const { data: stagesResult } = usePipelineStages(opportunity.pipeline || undefined);
  const { data: pipelinesResult } = usePipelines();
  const pipelineStages = useMemo(
    () => [...(stagesResult?.data ?? [])].sort((a, b) => a.position - b.position),
    [stagesResult],
  );
  const stageOptions = useMemo(
    () => pipelineStages.map((s) => ({ value: s.id, label: s.name })),
    [pipelineStages],
  );
  const legacyStageOptions = useMemo(() => getLegacyStageOptions(t), [t]);
  const stageLabel = useCallback(
    (value: string) =>
      pipelineStages.find((s) => s.id === value)?.name ??
      legacyStageOptions.find((o) => o.value === value)?.label ??
      // Never flash a raw stage id while the pipeline's stages are loading.
      (stagesResult ? value : '…'),
    [pipelineStages, legacyStageOptions, stagesResult],
  );
  const pipelineName =
    pipelinesResult?.data?.find((p) => p.id === opportunity.pipeline)?.name ??
    (pipelinesResult ? opportunity.pipeline : null);
  const currencyOptions = useMemo(() => getCurrencyOptions(), []);
  const dealCurrency = resolveDealCurrency(opportunity.currency);
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
        value={opportunity.stageId || opportunity.stage}
        options={stageOptions}
        onChange={(v) => onUpdateField({ stageId: v, stage: v })}
        renderBadge={(v) => <StageBadge label={stageLabel(v)} />}
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
        renderValue={(v) => (v ? `${v}%` : null)}
        onSave={(v) => {
          const n = v ? Number(v.replace('%', '').trim()) : null;
          if (n === null || !Number.isFinite(n)) return;
          // Probability is a whole percentage between 0 and 100.
          onUpdateField({ probability: Math.min(100, Math.max(0, Math.round(n))) });
        }}
      />
      <PropertyRow
        icon={PiggyBank}
        label={t('sweep.entities.fieldAmount')}
        value={opportunity.amount}
        renderValue={(v) => formatMoney(v, opportunity.currency)}
        onSave={(v) => {
          if (!v) return;
          // Edited as the raw number (not the locale-formatted money string),
          // and never negative: a deal value below zero is a data-entry slip.
          const n = Number(v.replace(/[^0-9.-]/g, ''));
          if (!Number.isFinite(n) || n < 0) return;
          onUpdateField({ amount: String(n) });
        }}
      />
      <SelectPropertyRow
        icon={PiggyBank}
        label={t('sweep.entities.fieldCurrency')}
        value={dealCurrency}
        options={currencyOptions}
        onChange={(v) => onUpdateField({ currency: v })}
        renderBadge={(v) => <StageBadge label={currencyOptions.find((o) => o.value === v)?.label ?? v} />}
      />
      <PropertyRow
        icon={Calendar}
        label={t('sweep.entities.fieldCloseDate')}
        type="date"
        value={toDateInputValue(opportunity.closeDate)}
        renderValue={() => formatDate(opportunity.closeDate ?? undefined)}
        // Optional since TASK-671: clearing the input removes the close date.
        onSave={(v) => onUpdateField({ closeDate: v ? fromDateInputValue(v) : null })}
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
        value={pipelineName}
        readOnly
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
}: Readonly<{
  opportunity: Opportunity;
  onOpenCompany: (companyId: string) => void;
}>) {
  const t = useTranslations();
  // `customerName` is a denormalized mirror filled in at create/update time;
  // deals created before that existed (or ones where the lookup missed)
  // still have it null. Resolve the real company record by id instead of
  // falling straight to "(unknown company)".
  const companyQuery = useCompany(opportunity.customerId ?? '', !opportunity.customerName && !!opportunity.customerId);
  const resolvedCompany = companyQuery.data?.data;
  if (!opportunity.customerId) {
    return (
      <div className="p-6 text-sm text-muted-foreground text-center">
        {t('sweep.entities.noCompanyLinked')}
      </div>
    );
  }
  const name =
    opportunity.customerName ||
    resolvedCompany?.displayName ||
    resolvedCompany?.name ||
    t('sweep.entities.unknownCompany');
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
}: Readonly<{
  opportunity: Opportunity;
  onOpenPerson: (personId: string) => void;
}>) {
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

function OpportunityActivityTab({ opportunityId }: Readonly<{ opportunityId: string }>) {
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

export function OpportunityPanel(props: Readonly<ObjectPanelComponentProps>) {
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
      // Per-call promise (not `mutate`'s callbacks, which only fire for the
      // latest of several quick edits): every rejected edit is reported, and
      // the hook's refetch puts the server's value back in the panel.
      updateMut
        .mutateAsync({ id: opportunity.id, data: patch })
        .catch(() => toast.error(t('sweep.entities.updateFailed')));
    },
    [opportunity, updateMut, t],
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
