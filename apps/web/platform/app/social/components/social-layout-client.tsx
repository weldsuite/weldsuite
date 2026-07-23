import { BreadcrumbProvider } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';
import { SocialHeader } from './social-header';
import { ModuleContent } from '@/components/layout/module-content';

interface SocialLayoutClientProps {
  children: React.ReactNode;
}

/**
 * The module sidebar is rendered by PlatformShell via UnifiedModuleSidebar + MODULE_CONFIGS.social.
 * This layout renders the WeldSocial full-width header (with global search, the WeldAgent/Calendar/
 * Notifications toggles, and the "New Post" composer in the actions slot), then the active page in the
 * shared content row (content + object panel(s) + drawers) via ModuleContent.
 */
export function SocialLayoutClient({ children }: SocialLayoutClientProps) {
  const { t } = useI18n();

  return (
    <BreadcrumbProvider defaultBreadcrumbs={[{ label: t.social.title, href: '/social' }]}>
      <div className="flex-1 flex flex-col w-full min-h-0 h-full overflow-hidden">
        <SocialHeader />
        <ModuleContent className="overflow-y-auto overflow-x-hidden subtle-scrollbar">
          {children}
        </ModuleContent>
      </div>
    </BreadcrumbProvider>
  );
}
