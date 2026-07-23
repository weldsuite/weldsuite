
import { useEffect, useMemo, useRef, useState } from 'react';
import { getTranslations } from '@/lib/i18n';
import { EmailAccountsList } from './email-accounts-list';
import { SetupAddAccount } from '@/app/weldmail/setup/setup-add-account';
import {
  EmptyStateIllustration,
  FilterPills,
  type ActiveFilter,
  type FilterConfig,
} from '@/components/entity-list';
import { useMailAppSettings } from '@/hooks/queries/use-app-settings-queries';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ExpandingSearchInput } from '@/components/settings/expanding-search-input';

export default function EmailAccountsSettingsPage() {
  const { data, isLoading } = useMailAppSettings();
  const ts = getTranslations('settings');
  const ta = ts.weldmail.accounts;
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  const accounts = data?.accounts || [];
  const usage = data?.usage;
  const canAddMore = !usage?.emailAccounts?.limit || (usage?.emailAccounts?.current ?? 0) < usage.emailAccounts.limit;

  const filterConfigs: FilterConfig[] = useMemo(
    () => [
      {
        field: 'provider',
        label: ta.filterProvider,
        filterType: 'select',
        options: [
          { value: 'gmail', label: 'Gmail' },
          { value: 'outlook', label: 'Outlook' },
          { value: 'mailcow', label: 'WeldMail' },
        ],
      },
      {
        field: 'status',
        label: ta.filterStatus,
        filterType: 'select',
        options: [
          { value: 'active', label: ta.statusActive },
          { value: 'inactive', label: ta.statusInactive },
          { value: 'error', label: ta.statusError },
          { value: 'suspended', label: ta.statusSuspended },
          { value: 'quota_exceeded', label: ta.statusQuotaExceeded },
        ],
      },
      {
        field: 'isShared',
        label: ta.filterShared,
        filterType: 'boolean',
        options: [],
      },
    ],
    [ta],
  );

  if (isLoading) return <PageLoader fullScreen={false} />;

  const q = searchQuery.trim().toLowerCase();
  const filteredAccounts = accounts.filter((a) => {
    if (q && !a.email.toLowerCase().includes(q) && !(a.displayName ?? '').toLowerCase().includes(q)) {
      return false;
    }
    for (const f of activeFilters) {
      if (!f.value) continue;
      if (f.field === 'provider' && a.provider !== f.value) return false;
      if (f.field === 'status' && a.status !== f.value) return false;
      if (f.field === 'isShared') {
        const truthy = f.value === 'true' || f.value === true;
        if (!!a.isShared !== truthy) return false;
      }
    }
    return true;
  });

  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col items-center justify-center py-16">
          <EmptyStateIllustration>
            <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* Envelope body */}
              <rect x="24" y="38" width="72" height="48" rx="4" className="fill-white dark:fill-secondary stroke-gray-300 dark:stroke-border" strokeWidth="1.2" />
              {/* Envelope flap */}
              <path d="M24 42 L60 66 L96 42" className="stroke-gray-300 dark:stroke-border" strokeWidth="1.2" fill="none" />
              {/* Bottom fold lines */}
              <path d="M24 86 L48 66" className="stroke-gray-200 dark:stroke-border" strokeWidth="0.7" />
              <path d="M96 86 L72 66" className="stroke-gray-200 dark:stroke-border" strokeWidth="0.7" />
              {/* @ symbol circle */}
              <circle cx="88" cy="78" r="14" className="fill-white dark:fill-secondary stroke-gray-300 dark:stroke-border" strokeWidth="1.2" />
              <text x="88" y="82" textAnchor="middle" className="fill-gray-400 dark:fill-muted-foreground" fontSize="14" fontWeight="500">@</text>
            </svg>
          </EmptyStateIllustration>
          <h3 className="text-lg font-medium mb-1">{ta.noAccounts}</h3>
          <p className="text-sm text-muted-foreground mb-6">
            {ta.noAccountsDescription}
          </p>
          <SetupAddAccount disabled={!canAddMore} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FilterPills
            filters={activeFilters}
            filterConfigs={filterConfigs}
            maxFilters={5}
            onFiltersChange={setActiveFilters}
          />
        </div>

        <div className="flex items-center gap-2">
          <ExpandingSearchInput value={searchQuery} onChange={setSearchQuery} placeholder={ta.searchPlaceholder} />
          <SetupAddAccount disabled={!canAddMore} />
        </div>
      </div>

      <EmailAccountsList accounts={filteredAccounts} />
    </div>
  );
}
