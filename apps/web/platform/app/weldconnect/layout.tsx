
import { useAppAccess } from '@/hooks/use-app-access';
import { TaskLayoutClient } from './components/task-layout-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function TaskLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isInstalled, isLoading } = useAppAccess('weldconnect');
  const { t } = useI18n();

  if (isLoading) return <PageLoader />;
  if (!isInstalled) return <div className="flex items-center justify-center h-screen text-muted-foreground">{t.weldconnect.notInstalled}</div>;

  return (
    <TaskLayoutClient>
      {children}
    </TaskLayoutClient>
  );
}
