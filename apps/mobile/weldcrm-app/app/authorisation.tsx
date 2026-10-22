import { useEffect } from 'react';
import { useObserve } from 'expo-observe';
import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';

export default function AuthorisationScreen() {
  const { markInteractive } = useObserve();
  const { t, language } = useI18n();

  useEffect(() => {
    hideAppSplash();
    markInteractive();
  }, [markInteractive]);

  return (
    <LoginScreen
      logo={require('../assets/images/logo.png')}
      logoSize={{ width: 40, height: 40 }}
      appName="WeldCRM"
      subtitle={t.login.subtitle}
      language={language}
      showEmailLogin={true}
      accentColor="#7C3AED"
    />
  );
}
