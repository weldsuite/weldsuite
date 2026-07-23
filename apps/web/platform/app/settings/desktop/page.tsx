import { useEffect } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useRouter } from '@/lib/router';
import { isDesktop } from '@/lib/desktop';
import { DesktopSettingsPanel } from '@/components/desktop/desktop-settings';

export default function DesktopSettingsPage() {
  const t = useTranslations();
  const router = useRouter();

  // Page is only useful inside the Electron shell. If a user hits this route
  // in a normal browser, send them back to the main settings page.
  useEffect(() => {
    if (!isDesktop()) {
      router.replace('/settings');
    }
  }, [router]);

  if (!isDesktop()) return null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('sweep.settings.desktopPage.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('sweep.settings.desktopPage.description')}
        </p>
      </div>
      <DesktopSettingsPanel />
    </div>
  );
}
