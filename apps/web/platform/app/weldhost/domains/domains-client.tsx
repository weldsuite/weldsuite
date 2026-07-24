
import { useMemo, useCallback, useState } from 'react';
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
import { DomainDetailPanel } from '@/components/weldhost/domain-detail-panel';
import { useI18n } from '@/lib/i18n/provider';

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

export function DomainsClient({ domains }: DomainsClientProps) {
  const router = useRouter();
  const { t } = useI18n();
  const tdl = t.host.domainsList;
  const [selectedDomain, setSelectedDomain] = useState<HostDomain | null>(null);

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
    { id: 'domain', header: tdl.columnDomain, width: 'flex-1 min-w-[200px]' },
    { id: 'tld', header: tdl.columnTld, width: 'w-[80px]' },
    { id: 'registrar', header: tdl.columnRegistrar, width: 'w-[120px]' },
    { id: 'features', header: tdl.columnFeatures, width: 'w-[100px]' },
    { id: 'expires', header: tdl.columnExpires, width: 'w-[140px]' },
    { id: 'status', header: tdl.columnStatus, width: 'w-[100px]' },
  ], [tdl]);

  // Render row
  const renderRow = useCallback((domain: HostDomain) => {
    const statusLabel = (tdl as Record<string, string>)[`status${domain.status.charAt(0).toUpperCase()}${domain.status.slice(1)}`] ?? domain.status;
    const statusClass = statusClassName[domain.status] ?? statusClassName.active;

    return (
      <div
        key={domain.id}
        onClick={() => setSelectedDomain(domain)}
        className={cn(
          'flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group',
          selectedDomain?.id === domain.id && 'bg-accent',
        )}
      >
        {/* Domain */}
        <div className="flex-1 min-w-[200px] flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 dark:text-foreground">
            {domain.fullDomain || `${domain.name}.${domain.tld}`}
          </span>
        </div>

        {/* TLD */}
        <div className="w-[80px]">
          <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none font-mono text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary">
            .{domain.tld}
          </span>
        </div>

        {/* Registrar */}
        <div className="w-[120px]">
          <span className="text-sm text-gray-500">{domain.registrar || 'WeldHost'}</span>
        </div>

        {/* Features */}
        <div className="w-[100px]">
          {domain.autoRenew && (
            <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950">
              {tdl.autoRenewBadge}
            </span>
          )}
        </div>

        {/* Expires */}
        <div className="w-[140px]">
          {domain.expiresAt ? (
            <span className="text-sm text-gray-700 dark:text-muted-foreground">
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
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/weldhost/domains/${domain.id}`} className="flex items-center">
                  <Eye className="h-4 w-4 mr-0.5" />
                  {tdl.viewDetails}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/weldhost/domains/${domain.id}`} className="flex items-center">
                  <Settings className="h-4 w-4 mr-0.5" />
                  {tdl.manageDomain}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="flex items-center">
                <ExternalLink className="h-4 w-4 mr-0.5" />
                {tdl.visitDomain}
              </DropdownMenuItem>
              {domain.autoRenew && (
                <DropdownMenuItem className="flex items-center text-yellow-600">
                  <RefreshCcw className="h-4 w-4 mr-0.5" />
                  {tdl.disableAutoRenew}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [selectedDomain?.id, tdl]);

  return (
    <>
    <EntityList<HostDomain>
      items={domains}
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
      createButton={{
        label: tdl.registerDomain,
        onClick: () => router.push('/weldhost/domains/register'),
      }}
      actionButtons={
        <Button variant="outline" onClick={() => router.push('/weldhost/domains/external')}>
          <ExternalLink className="h-4 w-4 mr-2" />
          {t.host.externalDomain.addButton}
        </Button>
      }
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <clipPath id="globe-clip">
                  <circle cx="60" cy="56" r="35.5" />
                </clipPath>
              </defs>
              {/* Globe */}
              <circle cx="60" cy="56" r="36" className="fill-white dark:fill-secondary" />
              <g clipPath="url(#globe-clip)">
                {/* Center meridian */}
                <line x1="60" y1="20" x2="60" y2="92" className="stroke-gray-200 dark:stroke-border" strokeWidth="0.7" />
                {/* Meridians */}
                <ellipse cx="60" cy="56" rx="12" ry="36" className="stroke-gray-200 dark:stroke-border" strokeWidth="0.7" fill="none" />
                <ellipse cx="60" cy="56" rx="24" ry="36" className="stroke-gray-200 dark:stroke-border" strokeWidth="0.7" fill="none" />
                {/* Equator */}
                <line x1="24" y1="56" x2="96" y2="56" className="stroke-gray-200 dark:stroke-border" strokeWidth="0.7" />
                {/* Parallels */}
                <ellipse cx="60" cy="56" rx="36" ry="12" className="stroke-gray-200 dark:stroke-border" strokeWidth="0.7" fill="none" />
                <ellipse cx="60" cy="56" rx="36" ry="24" className="stroke-gray-200 dark:stroke-border" strokeWidth="0.7" fill="none" />
              </g>
              <circle cx="60" cy="56" r="36" className="stroke-gray-300 dark:stroke-border" strokeWidth="1.2" fill="none" />
            </svg>
          </EmptyStateIllustration>
        ),
        title: tdl.emptyTitle,
        description: tdl.emptyDescription,
        action: {
          label: tdl.registerDomain,
          onClick: () => router.push('/weldhost/domains/register'),
        },
      }}
      noResultsState={{
        title: tdl.noResultsTitle,
        description: tdl.noResultsDescription,
      }}
    />
    <DomainDetailPanel
      domain={selectedDomain}
      isOpen={!!selectedDomain}
      onClose={() => setSelectedDomain(null)}
    />
    </>
  );
}
