
import { useMemo, useCallback } from 'react';
import { Link, useRouter } from '@/lib/router';
import {
  MoreVertical,
  Eye,
  Settings,
  RefreshCcw,
  ExternalLink,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter } from '@/components/entity-list';
import type { HostDomain } from "@/lib/api/domains/weldhost";
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  useObjectPanel,
  useObjectPanelNavigationReporter,
  useObjectPanelStack,
  useObjectPanelUrlSync,
} from '@/components/object-panel';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { isFeatureAvailable } from '@/lib/edition';
import { useToggleAutoRenew } from '@/hooks/queries/use-host-queries';
import { isExternalDomainRegistrar, publicDomainRegistrar } from '@weldsuite/core-api-client/schemas/domains';
import { UsedByWeldReachBadge } from '../components/used-by-weldreach-badge';

interface DomainsClientProps {
  domains: HostDomain[];
}

// Status badge className (style only — labels come from i18n)
const statusClassName: Record<string, string> = {
  active: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950',
  pending: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950',
  expired: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950',
  suspended: 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950',
  cancelled: 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary',
};

export function DomainsClient({ domains }: Readonly<DomainsClientProps>) {
  const router = useRouter();
  const { t } = useI18n();
  const tdl = t.host.domainsList;
  // The domain detail lives in the shared object panel (registered as type
  // 'domain'), rendered by the global <ObjectPanelHost /> that WeldHost's
  // layout already mounts. Same shell as WeldCRM companies/people.
  const { open: openPanel } = useObjectPanel();
  // Two-way sync: open/expand writes `?stack=domain:<id>[:fullscreen][:tab=…]`
  // onto `/weldhost/domains`, and landing on that URL reopens the panel.
  useObjectPanelUrlSync('/weldhost/domains');
  const panelStack = useObjectPanelStack();
  // Previous / next in the open panel step through the rows as shown.
  const reportDisplayedDomains = useObjectPanelNavigationReporter<HostDomain>({ type: 'domain' });
  // Match on `type` rather than reading the stack tail: a panel pushed on top
  // of the domain panel would otherwise clear the row highlight, or — if its
  // id happened to collide — move it to the wrong row.
  const selectedDomainId =
    [...panelStack].reverse().find((handle) => handle.type === 'domain')?.id ?? null;
  // With the domain panel open the list keeps the domain and its status; the
  // other columns pushed Status out of view (TASK-1433).
  const panelOpen = selectedDomainId !== null;
  const wideOnly = useCallback((width: string) => (panelOpen ? 'hidden' : width), [panelOpen]);
  const domainWidth = panelOpen ? 'flex-1 min-w-0' : 'flex-1 min-w-[200px]';
  const canPurchase = isFeatureAvailable('domain-purchase');
  const toggleAutoRenew = useToggleAutoRenew();
  const disableAutoRenew = useCallback((domain: HostDomain) => {
    toggleAutoRenew.mutate(
      { domainId: domain.id, enabled: false },
      {
        onSuccess: () => toast.success(t.host.domainDetail.autoRenewUpdated),
        onError: () => toast.error(t.host.domainDetail.failedToSaveSettings),
      },
    );
  }, [toggleAutoRenew, t]);

  useBreadcrumbs([
    { label: tdl.breadcrumbHost, href: '/weldhost' },
    { label: tdl.breadcrumbDomains }
  ]);

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: tdl.filterStatus,
      options: [
        { value: 'active', label: tdl.statusActive },
        { value: 'pending', label: tdl.statusPending },
        { value: 'expired', label: tdl.statusExpired },
        { value: 'suspended', label: tdl.statusSuspended },
        { value: 'cancelled', label: tdl.statusCancelled },
      ],
    },
  ], [tdl]);

  // Group configs by status
  const groupConfigs: GroupConfig<HostDomain>[] = useMemo(() => [
    {
      id: 'pending',
      label: tdl.groupPending,
      sortOrder: 1,
      filter: (d) => d.status === 'pending',
    },
    {
      id: 'active',
      label: tdl.groupActive,
      sortOrder: 2,
      filter: (d) => d.status === 'active',
    },
    {
      id: 'expired',
      label: tdl.groupExpired,
      sortOrder: 3,
      filter: (d) => d.status === 'expired',
    },
    {
      id: 'suspended',
      label: tdl.groupSuspended,
      sortOrder: 4,
      filter: (d) => d.status === 'suspended',
    },
    {
      id: 'cancelled',
      label: tdl.groupCancelled,
      sortOrder: 5,
      filter: (d) => d.status === 'cancelled',
    },
  ], [tdl]);

  // Apply filters
  const applyFilters = useCallback((items: HostDomain[], filters: ActiveFilter[]) => {
    let result = items;

    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;

      if (filter.field === 'status') {
        result = filter.operator === 'is'
          ? result.filter(d => d.status === filter.value)
          : result.filter(d => d.status !== filter.value);
      }
    });

    return result;
  }, []);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'domain', header: tdl.columnDomain, width: domainWidth },
    { id: 'tld', header: tdl.columnTld, width: wideOnly('w-[80px]') },
    { id: 'registrar', header: tdl.columnRegistrar, width: wideOnly('w-[120px]') },
    { id: 'features', header: tdl.columnFeatures, width: wideOnly('w-[100px]') },
    { id: 'expires', header: tdl.columnExpires, width: wideOnly('w-[140px]') },
    { id: 'status', header: tdl.columnStatus, width: 'w-[100px]' },
  ], [tdl, domainWidth, wideOnly]);

  // Render row
  const renderRow = useCallback((domain: HostDomain) => {
    const statusLabel = (tdl as Record<string, string>)[`status${domain.status.charAt(0).toUpperCase()}${domain.status.slice(1)}`] ?? domain.status;
    const statusClass = statusClassName[domain.status] ?? statusClassName.active;
    const fullDomain = domain.fullDomain || `${domain.name}.${domain.tld}`;
    // An external domain renews at its own registrar: WeldSuite never does.
    const autoRenews = !!domain.autoRenew && !isExternalDomainRegistrar(domain.registrar);

    return (
      <div
        key={domain.id}
        className={cn(
          'relative flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group',
          selectedDomainId === domain.id && 'bg-accent',
        )}
      >
        {/* Row click target: stretched button; the actions cell sits above it */}
        <button
          type="button"
          aria-label={fullDomain}
          onClick={() => openPanel({ type: 'domain', id: domain.id, initialTab: 'dns' })}
          className="absolute inset-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        />
        {/* Domain */}
        <div className={cn(domainWidth, 'flex items-center gap-2')}>
          <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate">
            {fullDomain}
          </span>
          {domain.usedByWeldReach && <UsedByWeldReachBadge />}
        </div>

        {/* TLD */}
        <div className={wideOnly('w-[80px]')}>
          <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none font-mono text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary">
            .{domain.tld}
          </span>
        </div>

        {/* Registrar */}
        <div className={wideOnly('w-[120px]')}>
          <span className="text-sm text-gray-500">{publicDomainRegistrar(domain.registrar)}</span>
        </div>

        {/* Features */}
        <div className={wideOnly('w-[100px]')}>
          {autoRenews && (
            <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950">
              {tdl.autoRenewBadge}
            </span>
          )}
        </div>

        {/* Expires */}
        <div className={wideOnly('w-[140px]')}>
          {domain.expiresAt ? (
            <span className="text-sm tabular-nums">
              {new Date(domain.expiresAt).toLocaleDateString()}
            </span>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>

        {/* Status */}
        <div className="w-[100px]">
          <span
            className={cn(
              'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none',
              statusClass,
            )}
          >
            {statusLabel}
          </span>
        </div>

        {/* Actions */}
        <div className="relative z-[1] w-[40px] flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent"
                aria-label={t.common.actions.openMenu}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* Details: the panel, as a row click; Manage: the full page. */}
              <DropdownMenuItem
                className="flex items-center"
                onSelect={() => openPanel({ type: 'domain', id: domain.id, initialTab: 'overview' })}
              >
                <Eye className="h-4 w-4 mr-0.5" />
                {tdl.viewDetails}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/weldhost/domains/${domain.id}`} className="flex items-center">
                  <Settings className="h-4 w-4 mr-0.5" />
                  {tdl.manageDomain}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a href={`https://${fullDomain}`} target="_blank" rel="noopener noreferrer" className="flex items-center">
                  <ExternalLink className="h-4 w-4 mr-0.5" />
                  {tdl.visitDomain}
                </a>
              </DropdownMenuItem>
              {autoRenews && (
                <DropdownMenuItem
                  className="flex items-center text-yellow-600"
                  disabled={toggleAutoRenew.isPending}
                  onSelect={() => disableAutoRenew(domain)}
                >
                  <RefreshCcw className="h-4 w-4 mr-0.5" />
                  {tdl.disableAutoRenew}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [selectedDomainId, openPanel, tdl, t, domainWidth, wideOnly, disableAutoRenew, toggleAutoRenew.isPending]);

  return (
    <EntityList<HostDomain>
      items={domains}
      onDisplayedItemsChange={reportDisplayedDomains}
      isLoading={false}
      error={null}
      headerColumns={headerColumns}
      filters={filterConfigs}
      groups={groupConfigs}
      maxFilters={5}
      applyFilters={applyFilters}
      renderRow={renderRow}
      searchPlaceholder={tdl.searchPlaceholder}
      searchFields={['name', 'fullDomain', 'tld']}
      createButton={
        // Buying a domain is a Stripe checkout, which some editions lack.
        canPurchase
          ? { label: tdl.registerDomain, onClick: () => router.push('/weldhost/domains/register') }
          : undefined
      }
      actionButtons={
        <Button variant="outline" onClick={() => router.push('/weldhost/domains/external')}>
          {t.host.externalDomain.addButton}
        </Button>
      }
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <svg width="140" height="120" viewBox="50 21 140 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* Two plain solid tags stacked straight behind the front one, each 8px higher and 8px narrower a side */}
              <rect x="82.5" y="56.5" width="75" height="28" rx="7" className="fill-white stroke-gray-300 dark:fill-card dark:stroke-white/25" />
              <rect x="74.5" y="64.5" width="91" height="28" rx="7" className="fill-white stroke-gray-300 dark:fill-card dark:stroke-white/25" />
              {/* The front tag: an example domain (the same in every language) */}
              <rect x="66.5" y="72.5" width="107" height="32" rx="8" className="fill-white stroke-gray-300 dark:fill-card dark:stroke-white/30" />
              <text x="120" y="93" textAnchor="middle" className="text-[13px] font-medium">
                <tspan className="fill-gray-500 dark:fill-white/70">website</tspan>
                <tspan className="fill-gray-400 dark:fill-white/40">.com</tspan>
              </text>
            </svg>
          </EmptyStateIllustration>
        ),
        title: tdl.emptyTitle,
        // Without domain purchase (EU), a domain registered elsewhere is the way in.
        description: canPurchase ? tdl.emptyDescription : tdl.emptyDescriptionExternal,
        action: canPurchase
          ? { label: tdl.registerDomain, onClick: () => router.push('/weldhost/domains/register') }
          : { label: t.host.externalDomain.addButton, onClick: () => router.push('/weldhost/domains/external') },
      }}
      noResultsState={{
        title: tdl.noResultsTitle,
        description: tdl.noResultsDescription,
      }}
    />
  );
}
