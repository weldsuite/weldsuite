import { useEffect } from 'react';
import { useObserve } from 'expo-observe';
// WeldDesk signs in on the server's own page only (WeldID on WeldSuite EU):
// the hosted screen, which, unlike LoginScreen, loads nothing of Clerk.
import { HostedLoginScreen } from '@weldsuite/mobile-ui/components/HostedLoginScreen';

import { useI18n } from '@/lib/i18n';
import { BRAND } from '@/lib/brand';
import { hideAppSplash } from '@/utils/splash';

export default function AuthorisationScreen() {
  const { t, language } = useI18n();
  const { markInteractive } = useObserve();

  useEffect(() => {
    hideAppSplash();
    markInteractive();
  }, [markInteractive]);

  return (
    <HostedLoginScreen
      logo={require('../assets/images/logo.png')}
      logoSize={{ width: 40, height: 40 }}
      appName={t.appName}
      copy={t.auth}
      language={language}
      accentColor={BRAND}
    />
  );
}
