import { useEffect } from 'react';
import { useObserve } from 'expo-observe';
import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

import { useI18n } from '@/lib/i18n';
import { BRAND } from '@/lib/brand';
import { hideAppSplash } from '@/utils/splash';

export default function AuthorisationScreen() {
  const { t } = useI18n();
  const { markInteractive } = useObserve();

  useEffect(() => {
    hideAppSplash();
    markInteractive();
  }, [markInteractive]);

  return (
    <LoginScreen
      logo={require('../assets/images/logo.png')}
      logoSize={{ width: 40, height: 40 }}
      appName={t.appName}
      copy={t.auth}
      accentColor={BRAND}
    />
  );
}
