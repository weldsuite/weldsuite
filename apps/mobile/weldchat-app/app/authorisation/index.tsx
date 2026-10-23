import { useEffect } from 'react';
import { useObserve } from 'expo-observe';
import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';

export default function AuthScreen() {
  const { markInteractive } = useObserve();
  const { t } = useI18n();

  useEffect(() => {
    hideAppSplash();
    markInteractive();
  }, [markInteractive]);

  return (
    <LoginScreen
      logo={require('../../assets/images/icon.png')}
      logoSize={{ width: 40, height: 40 }}
      appName="WeldChat"
      subtitle={t.login.subtitle}
      showEmailLogin={true}
      accentColor={BRAND}
    />
  );
}
