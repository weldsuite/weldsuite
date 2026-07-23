
import { useAppAccess } from '@/hooks/use-app-access';
import { MailLayoutClient } from './components/mail-layout-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function MailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('weldmail');

  if (isLoading) return <PageLoader />;
  if (!isInstalled) return <div className="flex items-center justify-center h-screen text-muted-foreground">{t.mail.layout.appNotInstalled}</div>;

  return (
    <MailLayoutClient>
      {children}
    </MailLayoutClient>
  );
}
