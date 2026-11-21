import { useEffect } from 'react';
import { useObserve } from 'expo-observe';
import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

import { BRAND } from '@/lib/brand';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';

export default function AuthorisationScreen() {
  const { language } = useI18n();
  const { markInteractive } = useObserve();

  useEffect(() => {
    hideAppSplash();
    markInteractive();
  }, [markInteractive]);

  return (
    <LoginScreen
      logo={require('../assets/images/icon.png')}
      logoSize={{ width: 40, height: 40 }}
      appName="WeldCalendar"
      language={language}
      subtitle="Your schedule on the go"
      showEmailLogin={true}
      accentColor={BRAND}
    />
  );
}
