
import React, { useState } from 'react';
import { Link } from '@/lib/router';
import { useBetaAppCodes, useInstallApp, useUninstallApp, type AvailableApp } from '@/hooks/queries/use-settings-queries';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { getAppLogo, getAppLucideIcon } from '@/lib/apps/app-registry';
import { BetaBadge } from '@/components/layout/beta-badge';
import { getTranslations } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';
import { useAppLicence } from '@/components/partner/use-app-licence';
import { isNotLicensedError } from '@/lib/partner/api-errors';
import { CustomAppsSection, OfficialHostedAppsSection } from './custom-apps-section';
import { AppAccessRequestDialog } from './app-access-request-dialog';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { accessBadgeTone, canRequestAccess, getAppAccessInfo, type AppAccessState } from './app-access-state';
import { getConsolidatedCategory } from './app-categories';
import {
  APP_CATEGORY_FILTER,
  APP_STATUS_FILTER,
  APP_STATUS_INSTALLED,
  APP_STATUS_NOT_INSTALLED,
  isCompleteFilter,
  matchesAppFilters,
  matchesAppQuery,
  userAppMatches,
} from './app-search';
import { SearchIconButton } from '@/components/entity-grid';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { useUserAppStore } from '@/hooks/queries/use-user-apps-queries';

interface AppStoreClientProps {
  initialApps: AvailableApp[];
  categories: string[];
  canManage?: boolean; // Only admins can install/uninstall apps
  /** Shows the Developer console link next to the search. */
  canDevelop?: boolean;
}

function AppLogo({ code, className = 'h-5 w-5' }: Readonly<{ code: string; className?: string }>) {
  const logoPath = getAppLogo(code, 'light');
  if (logoPath) {
    return <img src={logoPath} alt={code} className={cn(className, 'object-contain')} />;
  }
  const Icon = getAppLucideIcon(code);
  return <Icon className={className} />;
}

export function AppStoreClient({ initialApps, canManage = false, canDevelop = false }: Readonly<AppStoreClientProps>) {
  const { data: betaAppCodes } = useBetaAppCodes();
  const t = getTranslations('navigation');
  const { t: allT, format } = useI18n();
  // In a partner-managed workspace the licence decides which apps can be added.
  const licence = useAppLicence();
  const [apps, setApps] = useState<AvailableApp[]>(initialApps);
  const [hoveredApp, setHoveredApp] = useState<string | null>(null);
  const [loadingApp, setLoadingApp] = useState<string | null>(null);
  const [appToUninstall, setAppToUninstall] = useState<AvailableApp | null>(null);
  // On-request apps (WeldReach): the app whose access request form is open.
  const [appToRequest, setAppToRequest] = useState<AvailableApp | null>(null);
  // The search field's text and the filter pills (status, category); both
  // narrow the first-party apps and the WeldApps sections.
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const isSearching = query.trim() !== '';
  const isFiltering = filters.some(isCompleteFilter);
  const clearSearchAndFilters = () => {
    setQuery('');
    setSearchOpen(false);
    setFilters([]);
  };
  // The WeldApps sections load the same (cached) list; read it here too so a
  // search that only matches WeldApps doesn't show "No apps found".
  const { data: userApps } = useUserAppStore();

  const installApp = useInstallApp();
  const uninstallApp = useUninstallApp();
  const appActionLabel = (isInstalled: boolean | undefined) =>
    isInstalled ? t.appstore.uninstall : t.appstore.install;

  async function handleInstallApp(app: AvailableApp) {
    try {
      setLoadingApp(app.code);
      await installApp.mutateAsync({ appCode: app.code });

      // Optimistically update local state
      setApps((prevApps) =>
        prevApps.map((a) =>
          a.code === app.code ? { ...a, isInstalled: true } : a
        )
      );

      toast.success(t.appstore.installSuccess.replace('{name}', app.name));
    } catch (error) {
      console.error('Failed to install app:', error);
      // A licence refusal is explained by the global toast (with the partner's name).
      if (!isNotLicensedError(error)) {
        toast.error(error instanceof Error ? error.message : t.appstore.installError);
      }

      // Revert optimistic update on error
      setApps((prevApps) =>
        prevApps.map((a) =>
          a.code === app.code ? { ...a, isInstalled: false } : a
        )
      );
    } finally {
      setLoadingApp(null);
    }
  }

  async function handleUninstallApp(app: AvailableApp) {
    try {
      setLoadingApp(app.code);
      setAppToUninstall(null); // Close dialog
      await uninstallApp.mutateAsync(app.code);

      // Optimistically update local state
      setApps((prevApps) =>
        prevApps.map((a) =>
          a.code === app.code ? { ...a, isInstalled: false } : a
        )
      );

      toast.success(t.appstore.uninstallSuccess.replace('{name}', app.name));
    } catch (error) {
      console.error('Failed to uninstall app:', error);
      toast.error(t.appstore.uninstallError);

      // Revert optimistic update on error
      setApps((prevApps) =>
        prevApps.map((a) =>
          a.code === app.code ? { ...a, isInstalled: true } : a
        )
      );
    } finally {
      setLoadingApp(null);
    }
  }

  // An app that is on request only cannot be installed before staff approve the workspace.
  const accessStatusOf = (app: AvailableApp) => getAppAccessInfo(app).status;
  const needsAccess = (app: AvailableApp) =>
    getAppAccessInfo(app).requiresApproval &&
    !app.isInstalled &&
    accessStatusOf(app) !== 'approved' &&
    !licence.isUnlicensed(app.code);
  const accessStatusLabel = (status: AppAccessState) =>
    status === 'none' ? allT.reach.accessUi.onRequestBadge : allT.reach.access.status[status];

  // Map internal category keys to translated display labels
  const categoryLabel: Record<string, string> = {
    'Customers': t.appstore.categoryCustomers,
    'Communication': t.appstore.categoryCommunication,
    'Work': t.appstore.categoryWork,
    'Storage': t.appstore.categoryStorage,
    'Finance': t.appstore.categoryFinance,
  };

  // The Filter button's fields: install status and category group.
  const filterConfigs: FilterConfig[] = [
    {
      field: APP_STATUS_FILTER,
      label: t.appstore.status,
      options: [
        { value: APP_STATUS_INSTALLED, label: t.appstore.installed },
        { value: APP_STATUS_NOT_INSTALLED, label: t.appstore.notInstalled },
      ],
    },
    {
      field: APP_CATEGORY_FILTER,
      label: t.appstore.category,
      options: Object.entries(categoryLabel).map(([value, label]) => ({ value, label })),
    },
  ];

  // Group the apps that match the search and filters by consolidated category
  // for display. Categories without a match drop out of the list and the
  // categories column.
  const { appsByCategory, consolidatedCategories } = React.useMemo(() => {
    const grouped: Record<string, AvailableApp[]> = {};
    apps.forEach((app) => {
      const consolidatedCategory = getConsolidatedCategory(app.category, app.code);
      const matches =
        matchesAppQuery(query, [
          app.name,
          app.code,
          app.description,
          app.category,
          categoryLabel[consolidatedCategory],
        ]) && matchesAppFilters(filters, { isInstalled: !!app.isInstalled, group: consolidatedCategory });
      if (!matches) return;
      if (!grouped[consolidatedCategory]) {
        grouped[consolidatedCategory] = [];
      }
      grouped[consolidatedCategory].push(app);
    });

    // Define the order of categories
    const categoryOrder = ['Customers', 'Communication', 'Work', 'Storage', 'Finance'];
    const sortedCategories = categoryOrder.filter(cat => grouped[cat]);

    return { appsByCategory: grouped, consolidatedCategories: sortedCategories };
    // `categoryLabel` is rebuilt every render from the static translations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps, query, filters]);

  const hasUserAppMatch = (userApps ?? []).some((app) => userAppMatches(app, query, filters));
  const showNoResults =
    (isSearching || isFiltering) && consolidatedCategories.length === 0 && !hasUserAppMatch;

  const scrollToCategory = (category: string) => {
    const element = document.getElementById(`category-${category.replaceAll(/\s+/g, '-').toLowerCase()}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <>
      <div className="flex justify-center flex-1 relative overflow-y-auto">
        {/* As tall as the apps (at least the page), so the categories column and its divider run to the bottom. */}
        <div className="relative flex min-h-full w-full max-w-[1150px] self-start">
          {/* Categories Section */}
          <div className="hidden md:flex md:w-60 md:shrink-0 md:flex-col py-6 md:pl-8 border-r border-border">
            <div className="sticky top-6 w-full self-start">
              <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider mb-4 uppercase">
                {t.appstore.categories}
              </h2>
              <div className="flex flex-col gap-1">
                {consolidatedCategories.map((category) => (
                  <Button
                    key={category}
                    variant="ghost"
                    onClick={() => scrollToCategory(category)}
                    className={cn(
                      'justify-start py-2 px-3 text-left text-sm border-none rounded-lg cursor-pointer transition-all -ml-3 mr-3',
                      'hover:bg-accent hover:text-foreground',
                      'text-muted-foreground font-normal'
                    )}
                  >
                    {categoryLabel[category] ?? category}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          {/* Apps Content */}
          <div className="flex-1 p-4 md:p-6 md:pl-8">
            {/* Filter and search row above the cards, laid out like the settings
                list toolbars (roles, activity): the filter pills on the left, the
                list pages' (`GridToolbar`) magnifier search on the right.
                `@container` sizes the open field the same way the toolbar does. */}
            <div className="@container mb-6 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <FilterPills
                  filters={filters}
                  filterConfigs={filterConfigs}
                  maxFilters={2}
                  onFiltersChange={setFilters}
                  operatorLabels={{ is: allT.sweep.entities.operatorIs, 'is not': allT.sweep.entities.operatorIsNot }}
                  labels={{ filter: allT.sweep.entities.filter, selectCondition: allT.sweep.entities.selectCondition }}
                />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <SearchIconButton
                  value={query}
                  onChange={setQuery}
                  placeholder={t.appstore.searchPlaceholder}
                  isOpen={searchOpen}
                  onOpenChange={setSearchOpen}
                />
                {canDevelop && (
                  <Button asChild variant="outline" size="sm" className="h-8 shadow-none">
                    <Link href="/apps/manage">{allT.weldapps.breadcrumb.myApps}</Link>
                  </Button>
                )}
              </div>
            </div>

            {showNoResults && (
              <EmptyState
                title={t.appstore.noResultsTitle}
                description={
                  isSearching
                    ? format(t.appstore.noResultsDescription, { query: query.trim() })
                    : t.appstore.noResultsFilters
                }
                action={
                  <Button variant="outline" size="sm" onClick={clearSearchAndFilters}>
                    {isFiltering ? t.appstore.clearFilters : t.appstore.clearSearch}
                  </Button>
                }
              />
            )}

            <OfficialHostedAppsSection query={query} filters={filters} />

            {consolidatedCategories.map((category, index) => (
              <div
                key={category}
                id={`category-${category.replaceAll(/\s+/g, '-').toLowerCase()}`}
                className="scroll-mt-6"
              >
                {index > 0 && (
                  <div className="border-t border-dashed border-border my-8" />
                )}
                <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider mb-4 uppercase">
                  {categoryLabel[category] ?? category}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {appsByCategory[category].map((app) => (
                    <Link
                      key={app.code}
                      href={`/appstore/${app.code}`}
                      className="bg-card border border-border rounded-xl p-4 cursor-pointer transition-all relative hover:bg-accent/50 hover:border-border/80 block"
                      onMouseEnter={() => setHoveredApp(app.code)}
                      onMouseLeave={() => setHoveredApp(null)}
                    >
                      {app.isInstalled && hoveredApp !== app.code && (
                        <Badge className="absolute top-3 right-3 rounded bg-blue-100 text-blue-600 border-transparent dark:bg-blue-950 dark:text-blue-400">
                          {t.appstore.installed}
                        </Badge>
                      )}
                      {!app.isInstalled && licence.isUnlicensed(app.code) && hoveredApp !== app.code && (
                        <Badge variant="secondary" className="absolute top-3 right-3 rounded">
                          {allT.partner.appStore.notLicensed}
                        </Badge>
                      )}
                      {hoveredApp === app.code && canManage && !app.isInstalled && licence.isUnlicensed(app.code) && licence.managed && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="absolute top-3 right-3 z-10 h-7 max-w-[60%] truncate px-2.5 text-xs"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            licence.askPartner(app);
                          }}
                        >
                          {format(allT.partner.appStore.askPartnerShort, { partner: licence.managed.partner.name })}
                        </Button>
                      )}
                      {needsAccess(app) && hoveredApp !== app.code && (
                        <SoftBadge tone={accessBadgeTone(accessStatusOf(app))} className="absolute top-3 right-3 rounded">
                          {accessStatusLabel(accessStatusOf(app))}
                        </SoftBadge>
                      )}
                      {needsAccess(app) && hoveredApp === app.code && canManage && canRequestAccess(accessStatusOf(app)) && (
                        <Button
                          size="sm"
                          className="absolute top-3 right-3 z-10 h-7 text-xs px-2.5"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setAppToRequest(app);
                          }}
                        >
                          {accessStatusOf(app) === 'rejected' ? allT.reach.access.requestAgain : allT.reach.access.requestAccess}
                        </Button>
                      )}
                      {hoveredApp === app.code && canManage && !needsAccess(app) && !(!app.isInstalled && licence.isUnlicensed(app.code)) && (
                        <Button
                          variant={app.isInstalled ? 'outline' : 'default'}
                          size="sm"
                          disabled={loadingApp === app.code}
                          className="absolute top-3 right-3 z-10 h-7 text-xs px-2.5"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (app.isInstalled) {
                              setAppToUninstall(app);
                            } else {
                              void handleInstallApp(app);
                            }
                          }}
                        >
                          {loadingApp === app.code ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            appActionLabel(app.isInstalled)
                          )}
                        </Button>
                      )}
                      <div className="flex flex-col gap-3">
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-[0.625rem] bg-white dark:bg-background border border-gray-200 dark:border-border flex items-center justify-center shrink-0">
                            <AppLogo code={app.code} />
                          </div>
                          <div className="relative top-px">
                            <div className="flex items-center gap-1.5 mb-px">
                              <h3 className="text-[0.9375rem] font-semibold text-foreground m-0">
                                {app.name}
                              </h3>
                              {betaAppCodes?.has(app.code) && <BetaBadge variant="inline" />}
                            </div>
                            <p className="text-xs text-muted-foreground m-0">
                              {app.category}
                            </p>
                          </div>
                        </div>
                        <p className="text-sm text-muted-foreground m-0 leading-[1.4] line-clamp-2">
                          {app.description}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            ))}

            <CustomAppsSection query={query} filters={filters} />

            <div className="pb-8" />
          </div>
        </div>
      </div>

      {appToRequest && (
        <AppAccessRequestDialog
          app={appToRequest}
          open
          onOpenChange={(open) => !open && setAppToRequest(null)}
          onSubmitted={() =>
            setApps((prevApps) =>
              prevApps.map((a) => (a.code === appToRequest.code ? { ...a, accessStatus: 'requested' } : a)),
            )
          }
        />
      )}

      {/* Uninstall Confirmation Dialog */}
      <ConfirmDialog
        open={!!appToUninstall}
        onOpenChange={(open) => !open && setAppToUninstall(null)}
        title={t.appstore.uninstallTitle.replace('{name}', appToUninstall?.name ?? '')}
        description={t.appstore.uninstallDescription}
        confirmLabel={t.appstore.uninstall}
        onConfirm={() => {
          if (appToUninstall) {
            void handleUninstallApp(appToUninstall);
          }
        }}
      />
    </>
  );
}
