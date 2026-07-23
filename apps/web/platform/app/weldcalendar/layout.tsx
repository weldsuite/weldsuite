
import { useAppAccess } from '@/hooks/use-app-access';
import { CalendarLayoutClient } from './components/calendar-layout-client';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

export default function CalendarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isInstalled, isLoading } = useAppAccess('weldcalendar');
  const t = getTranslations('weldcalendar');

  if (isLoading) return <PageLoader />;
  if (!isInstalled) return <div className="flex items-center justify-center h-screen text-muted-foreground">{t.layout.appNotInstalled}</div>;

  return (
    <CalendarLayoutClient>
      {children}
    </CalendarLayoutClient>
  );
}
