import { useAppAccess } from '@/hooks/use-app-access';
import { WeldCallLayoutClient } from './components/weldcall-layout-client';
import { PageLoader } from '@/components/page-loader';
import { getTranslations } from '@/lib/i18n';

export default function WeldCallLayout({ children }: { children: React.ReactNode }) {
  const { isInstalled, isLoading } = useAppAccess('weldcall');
  const t = getTranslations('weldmeet');

  if (isLoading) return <PageLoader />;
  if (!isInstalled)
    return (
      <div className="flex items-center justify-center h-screen text-muted-foreground">
        {t.weldcall.layout.appNotInstalled}
      </div>
    );

  return <WeldCallLayoutClient>{children}</WeldCallLayoutClient>;
}
