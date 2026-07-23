import { WeldbooksHeader } from './weldbooks-header';
import { ModuleContent } from '@/components/layout/module-content';

/**
 * The module sidebar is rendered by PlatformShell via UnifiedModuleSidebar + MODULE_CONFIGS.weldbooks.
 * This layout renders the WeldBooks full-width header at the top (with module-wide search and the
 * entity switcher in the actions slot), then the active page's content in the shared content row.
 *
 * Entity setup is available at /weldbooks/entities. List and form pages render regardless of
 * whether an entity has been created — they show their own empty states when there is no data.
 */
export function AccountingLayoutClient({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex flex-col min-h-0 h-full overflow-hidden">
      <WeldbooksHeader />
      <ModuleContent className="overflow-auto">{children}</ModuleContent>
    </div>
  );
}
