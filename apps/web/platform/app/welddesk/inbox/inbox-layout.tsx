import type { ReactNode } from 'react';
import { usePathname } from '@/lib/router';
import { useAppAccess } from '@/hooks/use-app-access';
import { getTranslations } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { cn } from '@/lib/utils';

export function InboxLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const tInbox = getTranslations('deskInbox2');
  const { isInstalled, isLoading } = useAppAccess('welddesk');
  const canRead = useCan('welddesk:conversations:read');

  if (isLoading) return <PageLoader />;

  if (!isInstalled) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        {t.common.empty.appNotInstalled}
      </div>
    );
  }

  if (!canRead) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        {tInbox.list.loadError}
      </div>
    );
  }

  return <>{children}</>;
}

interface DeskSplitLayoutProps {
  list: ReactNode;
  detail: ReactNode;
}

export function DeskSplitLayout({ list, detail }: DeskSplitLayoutProps) {
  const pathname = usePathname();
  const pathParts = pathname?.split('/').filter(Boolean) ?? [];
  const hasConversationSelected = pathParts[0] === 'welddesk' && pathParts[1] === 'inbox' && pathParts.length >= 3;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-white dark:bg-background">
      <div className="flex flex-1 overflow-hidden">
        <div
          className={cn(
            'w-full md:w-[420px] flex-shrink-0 md:border-r border-gray-200 dark:border-border overflow-hidden',
            hasConversationSelected ? 'hidden md:block' : 'block',
          )}
        >
          {list}
        </div>
        <div
          className={cn(
            'flex-1 overflow-hidden bg-white dark:bg-background',
            hasConversationSelected ? 'block' : 'hidden md:block',
          )}
        >
          {detail}
        </div>
      </div>
    </div>
  );
}
