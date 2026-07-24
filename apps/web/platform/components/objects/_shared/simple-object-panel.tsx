/**
 * `SimpleObjectPanel` — shared template for read-only ObjectPanels that are
 * thin equivalents of the legacy "tier 2" EntitySheet renderers (lead,
 * ticket, article, project, invoice, bill, order, product, …).
 *
 * Provides the ObjectPanel shell (`useObjectPanelShell`, `EntityDetailView`,
 * header avatar/title/actions, tab bar with per-mode visibility config,
 * Details + ComingSoonTab branches), and lets each entity supply the
 * variable bits via props:
 *   - title / subtitle
 *   - status badges row
 *   - field list rendered as `dl` grid
 *   - optional extras (line items, notes, tags) rendered below
 *   - `tabs` descriptors (defaults to Overview + standard ComingSoonTab set)
 *
 * Per-panel folders can replace this with a richer
 * `useObjectPanel().open(...)` consumer (see `objects/company`) when
 * inline-editing / related-list tabs are needed.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  LayoutGrid,
  SquareActivity,
  Mail,
  Phone,
  StickyNote,
  Video,
  SquareCheck,
  Folder,
  History,
  EllipsisVertical,
  Link as LinkIcon,
  SquareArrowOutUpRight,
  Loader2,
  Building,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  ObjectPanelTabs,
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
  type ObjectPanelTabDescriptor,
} from '@/components/object-panel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import { ComingSoonTab } from './coming-soon-tab';

const PANEL_WIDTH = 400;

interface SimplePanelField {
  label: string;
  value: string | number | null | undefined;
}

interface SimplePanelTab extends ObjectPanelTabDescriptor {
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

/**
 * Default tab set: Overview + the standard ComingSoonTab list. Used when an
 * entity doesn't override `tabs`.
 */
function getDefaultSimpleTabs(t: (path: string, params?: Record<string, unknown>) => string): SimplePanelTab[] {
  return [
    { id: 'overview', label: t('sweep.entities.detailsTab'), icon: LayoutGrid, required: true, defaultVisibleInPanel: true, defaultVisibleInFullscreen: true },
    { id: 'activity', label: t('sweep.entities.activityTab'), icon: SquareActivity, defaultVisibleInFullscreen: true },
    { id: 'emails', label: t('sweep.entities.emailsTab'), icon: Mail, defaultVisibleInFullscreen: true },
    { id: 'calls', label: t('sweep.entities.callsTab'), icon: Phone, defaultVisibleInFullscreen: true },
    { id: 'notes', label: t('sweep.entities.notesTab'), icon: StickyNote, defaultVisibleInFullscreen: true },
    { id: 'meetings', label: t('sweep.entities.meetingsTab'), icon: Video, defaultVisibleInFullscreen: true },
    { id: 'tasks', label: t('sweep.entities.tasksTab'), icon: SquareCheck, defaultVisibleInFullscreen: true },
    { id: 'files', label: t('sweep.entities.filesTab'), icon: Folder, defaultVisibleInFullscreen: true },
    { id: 'audit', label: t('sweep.entities.auditLogTab'), icon: History, defaultVisibleInFullscreen: true },
  ];
}

export interface SimpleObjectPanelProps extends ObjectPanelComponentProps {
  /** Object type used for tab-config storage key. */
  objectType: string;
  /** Loading state from the entity query. */
  isLoading: boolean;
  /** Error from the entity query — when set, shows a fallback error body. */
  hasError?: boolean;
  /** When false (entity not found), shows the "not found" body. */
  hasData?: boolean;
  /** Title shown in the header (after data loads). */
  title?: string;
  /** Subtitle shown under the title. */
  subtitle?: string;
  /** Optional avatar override — defaults to first letter of title. */
  avatar?: ReactNode;
  /** Optional URL for the "open in new tab" menu item. */
  openHref?: string;
  /** Status badges rendered at the top of the Details body. */
  statusBadges?: ReactNode;
  /** 2-col grid of label/value pairs (null/undefined values are skipped). */
  fields?: SimplePanelField[];
  /** Free-form content rendered below the fields (line items, notes, etc.). */
  extras?: ReactNode;
  /**
   * Tab descriptors. Defaults to `DEFAULT_SIMPLE_TABS`. The first tab is
   * always treated as the Details tab and renders fields/extras. Any other
   * active tab renders `ComingSoonTab` unless `renderTab` is supplied.
   */
  tabs?: SimplePanelTab[];
  /** Optional per-tab body renderer (called for non-overview tabs). */
  renderTab?: (tabId: string) => ReactNode;
}

function PanelAvatar({ title }: { title?: string }) {
  const initial = (title?.trim()[0] ?? '#').toUpperCase();
  if (!title) {
    return <div className="h-7 w-7 rounded-lg bg-muted animate-pulse" />;
  }
  return (
    <Avatar className="h-7 w-7 rounded-lg border border-border">
      <AvatarFallback className="rounded-lg bg-muted text-[12px] font-medium">
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}

function PanelTitle({ title, subtitle }: { title?: string; subtitle?: string }) {
  if (!title) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[15px] font-medium text-foreground truncate">{title}</span>
      {subtitle && (
        <span className="text-xs text-muted-foreground truncate">{subtitle}</span>
      )}
    </div>
  );
}

function PanelActions({ openHref }: { openHref?: string }) {
  const t = useTranslations();
  if (!openHref) return null;
  const handleCopyLink = async () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    try {
      await navigator.clipboard.writeText(`${origin}${openHref}`);
      toast.success(t('sweep.entities.linkCopied'));
    } catch {
      toast.error(t('sweep.entities.copyLinkFailed'));
    }
  };
  const handleOpenNewTab = () => {
    window.open(openHref, '_blank', 'noopener,noreferrer');
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none"
          aria-label={t('sweep.entities.moreActions')}
        >
          <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={handleOpenNewTab}>
          <SquareArrowOutUpRight className="h-4 w-4 mr-0.5" />
          {t('sweep.entities.openInNewTab')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCopyLink}>
          <LinkIcon className="h-4 w-4 mr-0.5" />
          {t('sweep.entities.copyLink')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PanelTabsBar({
  objectType,
  mode,
  tabs,
  activeTab,
  setActiveTab,
}: {
  objectType: string;
  mode: 'panel' | 'fullscreen';
  tabs: SimplePanelTab[];
  activeTab: string;
  setActiveTab: (id: string) => void;
}) {
  const st = useTranslations();
  const configEntries = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        label: t.label,
        required: t.required,
        defaultVisible:
          mode === 'panel'
            ? (t.defaultVisibleInPanel ?? false)
            : (t.defaultVisibleInFullscreen ?? false),
      })),
    [tabs, mode],
  );

  const { visibility, isVisible, toggle, resetToDefaults } = useObjectPanelTabConfig({
    objectType,
    mode,
    tabs: configEntries,
  });

  useEffect(() => {
    if (isVisible(activeTab)) return;
    const fallback = tabs.find((t) => isVisible(t.id));
    if (fallback && fallback.id !== activeTab) setActiveTab(fallback.id);
  }, [activeTab, isVisible, setActiveTab, tabs]);

  const visibleTabs = useMemo(
    () =>
      tabs
        .filter((t) => isVisible(t.id))
        .map((t) => ({ id: t.id, label: t.label, icon: t.icon })),
    [tabs, isVisible],
  );

  return (
    <div className="group/tabs-header relative">
      <ObjectPanelTabs tabs={visibleTabs} activeTab={activeTab} onChange={setActiveTab} />
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

function FieldGrid({ fields }: { fields: SimplePanelField[] }) {
  const filled = fields.filter((f) => f.value !== null && f.value !== undefined && f.value !== '');
  if (filled.length === 0) return null;
  return (
    <dl className="grid grid-cols-1 @md:grid-cols-2 gap-x-4 gap-y-3 px-4 pt-4 pb-2 text-sm">
      {filled.map((f) => (
        <div key={f.label} className="flex flex-col gap-0.5 min-w-0">
          <dt className="text-xs text-muted-foreground">{f.label}</dt>
          <dd className="text-sm text-foreground truncate">{String(f.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SimpleObjectPanel(props: SimpleObjectPanelProps) {
  const {
    objectType,
    isLoading,
    hasError,
    hasData,
    title,
    subtitle,
    avatar,
    openHref,
    statusBadges,
    fields,
    extras,
    tabs: tabsProp,
    renderTab,
    initialTab,
  } = props;

  const st = useTranslations();
  const tabs = useMemo(() => tabsProp ?? getDefaultSimpleTabs(st), [tabsProp, st]);

  const shell = useObjectPanelShell({
    ...props,
    width: PANEL_WIDTH,
    loading: isLoading && !hasData,
  });
  const mode = shell.mode;

  const initial = useMemo(() => {
    if (initialTab && tabs.some((t) => t.id === initialTab)) return initialTab;
    return tabs[0]?.id ?? 'overview';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<string>(initial);

  const isOverview = activeTab === (tabs[0]?.id ?? 'overview');

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      avatar={avatar ?? <PanelAvatar title={title} />}
      title={<PanelTitle title={title} subtitle={subtitle} />}
      actions={<PanelActions openHref={openHref} />}
      tabs={
        <PanelTabsBar
          objectType={objectType}
          mode={mode}
          tabs={tabs}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
        />
      }
    >
      {isLoading && !hasData && (
        <div className="flex items-center justify-center gap-2 py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{st('sweep.entities.loadingEllipsis')}</span>
        </div>
      )}
      {!isLoading && hasError && (
        <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>
      )}
      {!isLoading && !hasError && !hasData && (
        <div className="p-6 text-sm text-muted-foreground text-center">{st('sweep.entities.notFound')}</div>
      )}
      {hasData && isOverview && (
        <div className="@container">
          {statusBadges && (
            <div className="flex flex-wrap items-center gap-1.5 px-4 pt-4">
              {statusBadges}
            </div>
          )}
          {fields && <FieldGrid fields={fields} />}
          {extras && <div className="pb-2">{extras}</div>}
        </div>
      )}
      {hasData && !isOverview && (
        renderTab?.(activeTab) ?? (
          <ComingSoonTab
            icon={tabs.find((t) => t.id === activeTab)?.icon ?? Building}
            label={tabs.find((t) => t.id === activeTab)?.label ?? st('sweep.entities.comingSoon')}
          />
        )
      )}
    </EntityDetailView>
  );
}

/** Helper to format an ISO date for display. */
export function formatPanelDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Helper to format a money value for display. */
export function formatPanelMoney(
  amount: string | number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (amount === undefined || amount === null || amount === '') return null;
  const num = typeof amount === 'number' ? amount : Number(amount);
  if (Number.isNaN(num)) return typeof amount === 'string' ? amount : null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  } catch {
    return `${currency ?? ''} ${num.toFixed(2)}`.trim();
  }
}

/** Helper to render Badge rows for tags. */
export function BadgeRow({ values, variant }: { values: string[]; variant?: 'secondary' | 'outline' | 'default' }) {
  if (values.length === 0) return null;
  return (
    <div className="px-4 py-3 flex flex-wrap gap-1.5">
      {values.map((v) => (
        <Badge key={v} variant={variant ?? 'secondary'}>{v}</Badge>
      ))}
    </div>
  );
}

/** Helper for a labelled section header. */
export function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-4 pt-3 pb-1">
      {children}
    </h3>
  );
}

/** Helper for a paragraph block (description, notes). */
export function ProseBlock({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 pb-3 text-sm text-foreground whitespace-pre-wrap">{children}</p>
  );
}

/** Helper for a simple two-column line item list. */
export function LineItemList<T>({
  items,
  renderLeft,
  renderRight,
  getKey,
}: {
  items: T[];
  renderLeft: (item: T) => ReactNode;
  renderRight: (item: T) => ReactNode;
  getKey: (item: T) => string;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="divide-y divide-border border-y border-border mx-4">
      {items.map((item) => (
        <li key={getKey(item)} className="flex items-center justify-between py-2 text-sm gap-2">
          <span className="truncate">{renderLeft(item)}</span>
          <span className="text-muted-foreground tabular-nums whitespace-nowrap">
            {renderRight(item)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Re-export for tab-customising panels. */
export type { ObjectPanelComponentProps };

// Re-export the icon used as default fallback so consumers don't need their own.
;
