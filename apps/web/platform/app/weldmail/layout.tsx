import { useEffect } from 'react';
import { useAppAccess } from '@/hooks/use-app-access';
import { MailLayoutClient } from './components/mail-layout-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { markMailGatePassed } from './lib/open-timing';

export default function MailLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('weldmail');

  useEffect(() => {
    if (!isLoading && isInstalled) markMailGatePassed();
  }, [isLoading, isInstalled]);

  if (isLoading) return <PageLoader />;
  if (!isInstalled) return <div className="flex items-center justify-center h-screen text-muted-foreground">{t.mail.layout.appNotInstalled}</div>;

  return (
    <MailLayoutClient>
      {children}
    </MailLayoutClient>
  );
}
