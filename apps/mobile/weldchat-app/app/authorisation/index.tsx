import { useEffect } from 'react';
import { useObserve } from 'expo-observe';
// WeldChat signs in on the server's own page only (WeldID on WeldSuite EU):
// the hosted screen, which, unlike LoginScreen, loads nothing of Clerk.
import { HostedLoginScreen } from '@weldsuite/mobile-ui/components/HostedLoginScreen';

import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';

export default function AuthScreen() {
  const { markInteractive } = useObserve();
  const { t, language } = useI18n();

  useEffect(() => {
    hideAppSplash();
    markInteractive();
  }, [markInteractive]);

  return (
    <HostedLoginScreen
      logo={require('../../assets/images/icon.png')}
      logoSize={{ width: 40, height: 40 }}
      appName="WeldChat"
      subtitle={t.login.subtitle}
      language={language}
      accentColor={BRAND}
    />
  );
}
