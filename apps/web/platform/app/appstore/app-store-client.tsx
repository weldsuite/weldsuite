
import React, { useState } from 'react';
import { Link } from '@/lib/router';
import { useInstallApp, useUninstallApp, type AvailableApp } from '@/hooks/queries/use-settings-queries';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { getAppLogo, getAppLucideIcon } from '@/lib/apps/app-registry';
import { getTranslations } from '@/lib/i18n';
import { CustomAppsSection } from './custom-apps-section';

interface AppStoreClientProps {
  initialApps: AvailableApp[];
  categories: string[];
  canManage?: boolean; // Only admins can install/uninstall apps
}

function AppLogo({ code, className = 'h-5 w-5' }: { code: string; className?: string }) {
  const logoPath = getAppLogo(code, 'light');
  if (logoPath) {
    return <img src={logoPath} alt={code} className={cn(className, 'object-contain')} />;
  }
  const Icon = getAppLucideIcon(code);
  return <Icon className={className} />;
}

// Consolidate categories into broader groups
const CATEGORY_GROUPS: Record<string, string[]> = {
  'Customers': ['sales', 'crm', 'commerce', 'customer', 'support', 'helpdesk', 'marketing'],
  'Communication': ['mail', 'email', 'chat', 'messaging', 'meet', 'video', 'inbox', 'webmail', 'communication'],
  'Work': ['productivity', 'projects', 'tasks', 'task', 'planning', 'collaboration', 'documents', 'notes', 'calendar', 'workflow', 'automation'],
  'Storage': ['drive', 'files', 'storage', 'host', 'hosting', 'dns', 'domains', 'infrastructure'],
  'Finance': ['finance', 'accounting', 'billing', 'invoicing', 'erp', 'books'],
};

// Direct app code to category mapping — wins over keyword matching. Used when
// the app's stored category alone isn't enough to disambiguate (e.g. WeldDrive
// is stored as "Productivity" but belongs in Storage).
const APP_CODE_OVERRIDES: Record<string, string> = {
  'mail': 'Communication',
  'welddrive': 'Storage',
};

function getConsolidatedCategory(originalCategory: string, appCode?: string): string {
  // Check for direct app code override first
  if (appCode && APP_CODE_OVERRIDES[appCode.toLowerCase()]) {
    return APP_CODE_OVERRIDES[appCode.toLowerCase()];
  }

  const normalizedCategory = originalCategory.toLowerCase();
  for (const [group, keywords] of Object.entries(CATEGORY_GROUPS)) {
    if (keywords.some(keyword => normalizedCategory.includes(keyword.toLowerCase()))) {
      return group;
    }
  }
  return 'Work';
}

export function AppStoreClient({ initialApps, canManage = false }: AppStoreClientProps) {
  const t = getTranslations('navigation');
  const [apps, setApps] = useState<AvailableApp[]>(initialApps);
  const [hoveredApp, setHoveredApp] = useState<string | null>(null);
  const [loadingApp, setLoadingApp] = useState<string | null>(null);
  const [appToUninstall, setAppToUninstall] = useState<AvailableApp | null>(null);

  const installApp = useInstallApp();
  const uninstallApp = useUninstallApp();

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
      toast.error(error instanceof Error ? error.message : t.appstore.installError);

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

  // Map internal category keys to translated display labels
  const categoryLabel: Record<string, string> = {
    'Customers': t.appstore.categoryCustomers,
    'Communication': t.appstore.categoryCommunication,
    'Work': t.appstore.categoryWork,
    'Storage': t.appstore.categoryStorage,
    'Finance': t.appstore.categoryFinance,
  };

  // Group all apps by consolidated category for display
  const { appsByCategory, consolidatedCategories } = React.useMemo(() => {
    const grouped: Record<string, AvailableApp[]> = {};
    apps.forEach((app) => {
      const consolidatedCategory = getConsolidatedCategory(app.category, app.code);
      if (!grouped[consolidatedCategory]) {
        grouped[consolidatedCategory] = [];
      }
      grouped[consolidatedCategory].push(app);
    });

    // Define the order of categories
    const categoryOrder = ['Customers', 'Communication', 'Work', 'Storage', 'Finance'];
    const sortedCategories = categoryOrder.filter(cat => grouped[cat]);

    return { appsByCategory: grouped, consolidatedCategories: sortedCategories };
  }, [apps]);

  const scrollToCategory = (category: string) => {
    const element = document.getElementById(`category-${category.replace(/\s+/g, '-').toLowerCase()}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <>
      <div className="flex justify-center flex-1 relative overflow-y-auto">
        <div className="w-full max-w-[1150px] flex relative">
          {/* Categories Section */}
          <div className="hidden md:flex md:w-60 md:shrink-0 py-6 md:pl-8 border-r border-border">
            <div className="sticky top-6 w-full">
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
                      'py-2 px-3 text-left text-sm border-none rounded-lg cursor-pointer transition-all -ml-3 mr-3',
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
            {consolidatedCategories.map((category, index) => (
              <div
                key={category}
                id={`category-${category.replace(/\s+/g, '-').toLowerCase()}`}
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
                      {hoveredApp === app.code && canManage && (
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
                              handleInstallApp(app);
                            }
                          }}
                        >
                          {loadingApp === app.code ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : app.isInstalled ? (
                            t.appstore.uninstall
                          ) : (
                            t.appstore.install
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

            <CustomAppsSection />

            <div className="pb-8" />
          </div>
        </div>
      </div>

      {/* Uninstall Confirmation Dialog */}
      <ConfirmDialog
        open={!!appToUninstall}
        onOpenChange={(open) => !open && setAppToUninstall(null)}
        title={t.appstore.uninstallTitle.replace('{name}', appToUninstall?.name ?? '')}
        description={t.appstore.uninstallDescription}
        confirmLabel={t.appstore.uninstall}
        onConfirm={() => {
          if (appToUninstall) {
            handleUninstallApp(appToUninstall);
          }
        }}
      />
    </>
  );
}
