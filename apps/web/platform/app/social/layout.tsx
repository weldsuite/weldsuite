import { useAppAccess } from '@/hooks/use-app-access';
import { SocialLayoutClient } from './components/social-layout-client';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';

export default function SocialLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('social');
  if (isLoading) return <PageLoader />;
  if (!isInstalled)
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.social.title}
      </div>
    );
  return <SocialLayoutClient>{children}</SocialLayoutClient>;
}
