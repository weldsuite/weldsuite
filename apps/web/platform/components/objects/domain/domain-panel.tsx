/**
 * Domain object panel.
 *
 * Built on the same shell as the task / person / company panels:
 * `useObjectPanelShell` + `EntityDetailView` + `ObjectPanelTabs`, so it
 * inherits the shared header chrome, the panel↔fullscreen toggle, the
 * stacking/back behaviour and the bottom (panel) / right (fullscreen) chat
 * sidebar for free.
 *
 * This replaces the bespoke `components/weldhost/domain-detail-panel.tsx`,
 * which hand-rolled its own fixed positioning, expand animation, tab strip
 * and chat layout and therefore drifted visually from every other panel.
 *
 * Tabs: Details · DNS · Nameservers · Settings · History. The DNS tab is the
 * real thing — create / edit / delete records against Cloudflare via
 * `/api/dns-records` (see `domain-dns-tab.tsx`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Building2,
  Calendar as CalendarIcon,
  CircleDot,
  Clock,
  Copy,
  EllipsisVertical,
  Globe,
  KeyRound,
  Lock,
  Mail,
  Server,
  Shield,
  ShieldCheck,
  SquareArrowOutUpRight,
  Tag,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  ObjectPanelTabs,
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityChat } from '@/components/entity-chat/entity-chat';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { useRouter } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  isExternalDomainRegistrar,
  publicDomainRegistrar,
  type Domain,
} from '@weldsuite/core-api-client/schemas/domains';
import {
  useDnsRecords,
  useDnsZones,
  useDomain,
  useRefreshZoneStatus,
  useToggleAutoRenew,
} from '@/hooks/queries/use-host-queries';
import { DomainDnsTab } from './domain-dns-tab';
import { getDomainTabs, type DomainTab } from './domain-tabs';
import { useDeleteDomain } from './use-domain-data';
import { usePreviewHelpDocsUiState } from '@/app/preview/help-docs/preview-help-docs-context';

/** Wide enough for a scannable DNS table (type · name · value · ttl). */
const DOMAIN_PANEL_WIDTH = 480;

const PILL = 'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';

const statusPillColor: Record<string, string> = {
  active: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950',
  pending: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950',
  expired: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950',
  suspended: 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950',
  cancelled: 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary',
};

type DomainDetailTranslations = ReturnType<typeof useI18n>['t']['host']['domainDetail'];

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Copy + toast. `writeText` rejects in an insecure context or when the user
 * denies clipboard permission, so the success toast has to wait for the
 * promise rather than fire alongside it.
 */
async function copyToClipboard(text: string, td: DomainDetailTranslations): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(td.copiedToClipboard);
  } catch {
    toast.error(td.copyFailed);
  }
}

function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

// ─── Header ────────────────────────────────────────────────────────────────

function DomainAvatar() {
  return (
    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900">
      <Globe className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
    </div>
  );
}

/**
 * Status labels live under `host.domainsList` (they're the same set the list
 * page uses for its status column and filters), so resolve them from there
 * rather than duplicating five strings under `domainDetail`.
 */
function useDomainStatusLabel(status: string | null | undefined): string {
  const { t } = useI18n();
  if (!status) return '';
  const key = `status${status.charAt(0).toUpperCase()}${status.slice(1)}`;
  return (t.host.domainsList as unknown as Record<string, string>)[key] ?? status;
}

function DomainTitle({ domain }: { domain?: Domain }) {
  const status = domain?.status ?? 'active';
  const statusLabel = useDomainStatusLabel(status);
  if (!domain) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[15px] font-medium text-foreground">
        {domain.fullDomain || `${domain.name}.${domain.tld}`}
      </span>
      <span className={cn(PILL, statusPillColor[status] ?? statusPillColor.active, 'flex-shrink-0')}>
        {statusLabel}
      </span>
    </div>
  );
}

function DomainActions({
  domain,
  canDelete,
  onDelete,
  td,
}: {
  domain?: Domain;
  canDelete: boolean;
  onDelete: () => void;
  td: DomainDetailTranslations;
}) {
  const router = useRouter();
  if (!domain) return null;
  const fullDomain = domain.fullDomain || `${domain.name}.${domain.tld}`;

  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="icon"
        className="p-1.5 hover:bg-muted rounded-md transition-colors"
        title={td.copyDomain}
        aria-label={td.copyDomain}
        onClick={() => void copyToClipboard(fullDomain, td)}
      >
        <Copy className="h-4 w-4 text-muted-foreground" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none"
            aria-label={td.moreActions}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={() => router.push(`/weldhost/domains/${domain.id}`)}>
            <SquareArrowOutUpRight className="h-4 w-4 mr-0.5" />
            {td.openFullPage}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => window.open(`https://${fullDomain}`, '_blank', 'noopener,noreferrer')}
          >
            <Globe className="h-4 w-4 mr-0.5" />
            {td.visitDomain}
          </DropdownMenuItem>
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
                onClick={onDelete}
              >
                <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
                {td.deleteDomain}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Tab bar ───────────────────────────────────────────────────────────────

function DomainPanelTabsBar({
  tabs,
  activeTab,
  setActiveTab,
  mode,
}: {
  tabs: DomainTab[];
  activeTab: DomainTab['id'];
  setActiveTab: (id: DomainTab['id']) => void;
  mode: 'panel' | 'fullscreen';
}) {
  const st = useTranslations();
  const configEntries = useMemo(
    () =>
      tabs.map((t) => ({
        id: t.id,
        label: t.label,
        required: t.required,
        defaultVisible:
          mode === 'panel' ? (t.defaultVisibleInPanel ?? false) : (t.defaultVisibleInFullscreen ?? false),
      })),
    [tabs, mode],
  );

  const { visibility, isVisible, toggle, resetToDefaults } = useObjectPanelTabConfig({
    objectType: 'domain',
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
        .map((t) => ({ id: t.id, label: t.label, icon: t.icon, count: t.count })),
    [tabs, isVisible],
  );

  return (
    <div className="group/tabs-header relative">
      <ObjectPanelTabs
        tabs={visibleTabs}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as DomainTab['id'])}
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

// ─── Details tab ───────────────────────────────────────────────────────────

function DomainDetailsTab({
  domain,
  zoneStatus,
  zoneProvider,
  td,
}: {
  domain: Domain;
  zoneStatus?: string | null;
  zoneProvider?: string | null;
  td: DomainDetailTranslations;
}) {
  const days = daysUntil(domain.expiresAt);
  const statusLabel = useDomainStatusLabel(domain.status);
  return (
    <div className="p-4 space-y-1">
      <PropertyRow
        icon={CircleDot}
        label={td.status}
        value={statusLabel}
        readOnly
        renderValue={(value) => (
          <span
            className={cn(PILL, statusPillColor[domain.status] ?? statusPillColor.active)}
          >
            {value}
          </span>
        )}
      />
      <PropertyRow
        icon={Tag}
        label={td.tld}
        value={`.${domain.tld}`}
        readOnly
        renderValue={(value) => (
          <span className={cn(PILL, 'font-mono text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary')}>
            {value}
          </span>
        )}
      />
      <PropertyRow
        icon={Building2}
        label={td.registrar}
        value={publicDomainRegistrar(domain.registrar)}
        readOnly
      />
      <PropertyRow
        icon={CalendarIcon}
        label={td.registered}
        value={formatDate(domain.registeredAt)}
        placeholder={td.notSet}
        readOnly
      />
      <PropertyRow
        icon={CalendarIcon}
        label={td.expires}
        value={formatDate(domain.expiresAt)}
        placeholder={td.notSet}
        readOnly
        renderValue={(value) => (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-foreground">{value}</span>
            {days !== null && days < 0 && (
              <span className={cn(PILL, 'gap-1 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950')}>
                <AlertTriangle className="h-3 w-3" />
                {td.expiredDaysAgo.replace('{days}', String(Math.abs(days)))}
              </span>
            )}
            {days !== null && days >= 0 && days < 30 && (
              <span className={cn(PILL, 'gap-1 text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950')}>
                <Clock className="h-3 w-3" />
                {td.daysLeft.replace('{days}', String(days))}
              </span>
            )}
          </span>
        )}
      />
      {domain.renewedAt && (
        <PropertyRow
          icon={CalendarIcon}
          label={td.renewed}
          value={formatDate(domain.renewedAt)}
          readOnly
        />
      )}
      {zoneStatus && (
        <PropertyRow
          icon={Server}
          label={td.zone}
          value={zoneStatus}
          readOnly
          renderValue={(value) => <span className="capitalize text-foreground">{value}</span>}
        />
      )}
      {zoneProvider && (
        <PropertyRow
          icon={Server}
          label={td.provider}
          value={zoneProvider}
          readOnly
          renderValue={(value) => <span className="capitalize text-foreground">{value}</span>}
        />
      )}
      <PropertyRow icon={Clock} label={td.created} value={formatDate(domain.createdAt)} readOnly />
      <PropertyRow icon={Clock} label={td.updated} value={formatDate(domain.updatedAt)} readOnly />
      <PropertyRow
        icon={CircleDot}
        label={td.domainId}
        value={domain.id}
        readOnly
        renderValue={(value) => (
          <span className="font-mono text-xs text-muted-foreground break-all">{value}</span>
        )}
      />
      {domain.notes && (
        <div className="pt-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {td.notesSection}
          </p>
          <p className="whitespace-pre-wrap text-sm text-foreground">{domain.notes}</p>
        </div>
      )}
    </div>
  );
}

// ─── Nameservers tab ───────────────────────────────────────────────────────

function DomainNameserversTab({
  domain,
  nameservers,
  zoneStatus,
  td,
}: {
  domain: Domain;
  nameservers: string[];
  zoneStatus?: string | null;
  td: DomainDetailTranslations;
}) {
  const isExternal = isExternalDomainRegistrar(domain.registrar);
  const fullDomain = domain.fullDomain || `${domain.name}.${domain.tld}`;

  if (nameservers.length === 0) {
    return (
      <div className="p-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {td.noNameserversTitle}
          </p>
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
            {td.noNameserversDescription}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <p className="text-sm font-medium text-foreground">{td.nameserversTitle}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {isExternal
            ? td.nameserversExternal
                .replace('{registrar}', domain.registrar || '')
                .replace('{domain}', fullDomain)
            : td.nameserversAuthoritative}
        </p>
        {zoneStatus && (
          <p className="mt-2 text-xs text-muted-foreground">
            {td.zoneStatus} <span className="font-medium capitalize">{zoneStatus}</span>
            {zoneStatus === 'pending' && ` ${td.zonePending}`}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        {nameservers.map((ns, index) => (
          <div
            key={ns}
            className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/50 px-2.5 py-1.5"
          >
            <span className="w-8 flex-shrink-0 text-xs text-muted-foreground">NS{index + 1}</span>
            <code className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{ns}</code>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 flex-shrink-0"
              title={td.copy}
              aria-label={td.copy}
              onClick={() => void copyToClipboard(ns, td)}
            >
              <Copy className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </div>
        ))}
      </div>

      {isExternal && (
        <p className="text-xs text-muted-foreground">{td.nameserversPropagated}</p>
      )}
    </div>
  );
}

// ─── Settings tab ──────────────────────────────────────────────────────────

function DomainSettingsTab({
  domain,
  canUpdate,
  td,
}: {
  domain: Domain;
  canUpdate: boolean;
  td: DomainDetailTranslations;
}) {
  const [autoRenew, setAutoRenew] = useState(!!domain.autoRenew);
  const toggleAutoRenew = useToggleAutoRenew();
  const isExternal = isExternalDomainRegistrar(domain.registrar);

  // Server state wins whenever the record refetches (e.g. after a failed
  // toggle rolls back, or another session changes it).
  useEffect(() => {
    setAutoRenew(!!domain.autoRenew);
  }, [domain.autoRenew]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setAutoRenew(next);
      try {
        await toggleAutoRenew.mutateAsync({ domainId: domain.id, enabled: next });
        toast.success(td.autoRenewUpdated);
      } catch (err) {
        setAutoRenew(!next);
        toast.error(err instanceof Error ? err.message : td.failedToSaveSettings);
      }
    },
    [toggleAutoRenew, domain.id, td],
  );

  const readOnly = isExternal || !canUpdate;

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{td.autoRenewalTitle}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {isExternal ? td.autoRenewalNotAvailable : td.autoRenewalDescription}
          </p>
        </div>
        <Switch
          checked={autoRenew}
          onCheckedChange={(next) => void handleToggle(next)}
          disabled={readOnly || toggleAutoRenew.isPending}
        />
      </div>

      {!isExternal && !autoRenew && domain.expiresAt && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            {td.autoRenewalDisabledTitle}
          </p>
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
            {td.autoRenewalDisabledDescription.replace(
              '{date}',
              formatDate(domain.expiresAt) ?? '',
            )}
          </p>
        </div>
      )}

      {/* Registry-managed flags. Read-only here: they're changed through the
          registrar flows (SSL provisioning, privacy add-on, transfer unlock),
          not by flipping a switch in this panel. */}
      <div className="space-y-1 pt-1">
        <FlagRow icon={ShieldCheck} label={td.ssl} enabled={!!domain.sslEnabled} td={td} />
        <FlagRow
          icon={Mail}
          label={td.emailForwarding}
          enabled={!!domain.emailForwardingEnabled}
          td={td}
        />
        <FlagRow
          icon={Shield}
          label={td.privacyProtection}
          enabled={!!domain.privacyProtection}
          td={td}
        />
        <FlagRow icon={Lock} label={td.transferLock} enabled={!!domain.locked} td={td} />
        {domain.authCode && (
          <PropertyRow
            icon={KeyRound}
            label={td.authCode}
            value={domain.authCode}
            readOnly
            renderValue={(value) => (
              <span className="font-mono text-xs text-muted-foreground break-all">{value}</span>
            )}
          />
        )}
        {domain.registrarSyncedAt && (
          <PropertyRow
            icon={Clock}
            label={td.registrarSync}
            value={formatDate(domain.registrarSyncedAt)}
            readOnly
          />
        )}
      </div>
    </div>
  );
}

function FlagRow({
  icon,
  label,
  enabled,
  td,
}: {
  icon: typeof ShieldCheck;
  label: string;
  enabled: boolean;
  td: DomainDetailTranslations;
}) {
  return (
    <PropertyRow
      icon={icon}
      label={label}
      // `PropertyRow` treats an empty value as "unset" and renders the
      // placeholder, so pass the label text and override the rendering.
      value={enabled ? td.enabled : td.disabled}
      readOnly
      renderValue={(value) => (
        <span
          className={cn(
            PILL,
            enabled
              ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950'
              : 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary',
          )}
        >
          {value}
        </span>
      )}
    />
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function DomainPanel(props: ObjectPanelComponentProps) {
  const { id, onClose, initialTab } = props;
  const { t } = useI18n();
  const td = t.host.domainDetail;

  const domainQuery = useDomain(id);
  const domain = domainQuery.data?.data as Domain | undefined;

  const zoneQuery = useDnsZones(id);
  const zone = zoneQuery.data?.data ?? null;
  const isCloudflareZone = !!zone && zone.provider === 'cloudflare';
  // Only poll Cloudflare for domains that actually have a CF zone.
  useRefreshZoneStatus(id, isCloudflareZone);

  const recordsQuery = useDnsRecords(id, !!zone);
  const records = useMemo(() => recordsQuery.data?.data?.records ?? [], [recordsQuery.data]);

  const canCreateDns = useCan('weldhost:dns:create');
  const canUpdateDns = useCan('weldhost:dns:update');
  const canDeleteDns = useCan('weldhost:dns:delete');
  const canUpdateDomain = useCan('weldhost:domains:update');
  const canDeleteDomain = useCan('weldhost:domains:delete');

  // Writing needs a Cloudflare-backed zone (the API proxies every mutation to
  // CF, so a domain still pending verification has nothing to write to) AND
  // the matching permission. The two are tracked apart so the read-only note
  // can say which one is missing instead of a generic "read only".
  const zoneIsManageable = isCloudflareZone && !!zone?.externalZoneId;
  const dnsReadOnlyReason = zoneIsManageable ? td.dnsReadOnly : td.noDnsRecordsNoZone;

  const deleteDomain = useDeleteDomain();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const previewUi = usePreviewHelpDocsUiState();

  const shell = useObjectPanelShell({
    ...props,
    width: DOMAIN_PANEL_WIDTH,
    loading: domainQuery.isLoading && !domain,
  });
  const mode = shell.mode;

  const tabs = useMemo(
    () =>
      getDomainTabs({
        details: td.details,
        dns: td.dnsRecords,
        nameservers: td.nameservers,
        settings: td.settings,
        history: td.historyTab,
        dnsCount: records.length || undefined,
      }),
    [td, records.length],
  );

  // DNS is the primary management surface for a domain — open there unless
  // the caller asked for a specific tab (e.g. settings from a deep link).
  const initial = useMemo<DomainTab['id']>(() => {
    const match = tabs.find((tab) => tab.id === initialTab);
    return match?.id ?? 'dns';
  }, [initialTab, tabs]);
  const [activeTab, setActiveTab] = useState<DomainTab['id']>(initial);

  const fullDomain = domain ? domain.fullDomain || `${domain.name}.${domain.tld}` : '';

  // Prefer the registry's nameservers; fall back to the ones Cloudflare
  // assigned to the zone (external domains only get the latter until the
  // customer repoints them at their registrar).
  const nameservers = useMemo<string[]>(() => {
    if (domain?.nameservers && domain.nameservers.length > 0) return domain.nameservers;
    const external = zone?.externalNameservers;
    return Array.isArray(external) ? (external as string[]) : [];
  }, [domain?.nameservers, zone?.externalNameservers]);

  const handleDelete = useCallback(async () => {
    if (!domain) return;
    try {
      await deleteDomain.mutateAsync(domain.id);
      toast.success(td.domainDeleted);
      setConfirmDelete(false);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : td.failedToDeleteDomain);
    }
  }, [domain, deleteDomain, td, onClose]);

  const chatSidebar = (
    <EntityChat entityType="domain" entityId={id} fallbackName={fullDomain} hideHeader />
  );

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        avatar={<DomainAvatar />}
        title={<DomainTitle domain={domain} />}
        actions={
          <DomainActions
            domain={domain}
            canDelete={canDeleteDomain}
            onDelete={() => setConfirmDelete(true)}
            td={td}
          />
        }
        tabs={
          <DomainPanelTabsBar
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={mode}
          />
        }
        sidebar={chatSidebar}
        sidebarDefaultSize={mode === 'panel' ? 320 : 500}
        sidebarMinSize={mode === 'panel' ? 140 : 320}
        sidebarMaxSize={mode === 'panel' ? undefined : 900}
        sidebarPersistKey={mode === 'fullscreen' ? 'domain-panel-chat-right' : undefined}
        sidebarDefaultCollapsed={false}
        sidebarDefaultOpen
        sidebarLocked={mode === 'fullscreen'}
      >
        {!domainQuery.isLoading && domainQuery.isError && (
          <div className="p-4 text-sm text-destructive">{td.failedToLoadDomain}</div>
        )}
        {!domainQuery.isLoading && !domainQuery.isError && !domain && (
          <div className="p-6 text-center text-sm text-muted-foreground">{td.domainNotFound}</div>
        )}

        {domain && activeTab === 'overview' && (
          <DomainDetailsTab
            domain={domain}
            zoneStatus={zone?.status}
            zoneProvider={zone?.provider}
            td={td}
          />
        )}
        {domain && activeTab === 'dns' && (
          <DomainDnsTab
            domainId={domain.id}
            records={records}
            isLoading={recordsQuery.isLoading || zoneQuery.isLoading}
            hasZone={zoneIsManageable}
            canCreate={zoneIsManageable && canCreateDns}
            canEdit={zoneIsManageable && canUpdateDns}
            canDelete={zoneIsManageable && canDeleteDns}
            readOnlyReason={dnsReadOnlyReason}
            initialShowAddRecord={previewUi?.initialShowAddRecord}
          />
        )}
        {domain && activeTab === 'nameservers' && (
          <DomainNameserversTab
            domain={domain}
            nameservers={nameservers}
            zoneStatus={zone?.status}
            td={td}
          />
        )}
        {domain && activeTab === 'settings' && (
          <DomainSettingsTab domain={domain} canUpdate={canUpdateDomain} td={td} />
        )}
        {domain && activeTab === 'history' && (
          <EntityAuditPanel entityType="domain" entityId={domain.id} />
        )}
      </EntityDetailView>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={td.deleteDomain}
        description={td.deleteDomainConfirm.replace('{domain}', fullDomain)}
        confirmLabel={td.deleteAction}
        cancelLabel={td.cancel}
        variant="destructive"
        loading={deleteDomain.isPending}
        onConfirm={handleDelete}
      />
    </>
  );
}
