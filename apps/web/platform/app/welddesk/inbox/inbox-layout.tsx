import type { ReactNode } from 'react';
import { useAppAccess } from '@/hooks/use-app-access';
import { getTranslations } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';

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

  return <div className="flex h-full w-full min-h-0 overflow-hidden">{children}</div>;
}
