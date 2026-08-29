import { useEffect } from 'react';
import { useObserve } from 'expo-observe';
import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

import { BRAND } from '@/lib/brand';
import { hideAppSplash } from '@/utils/splash';

export default function AuthorisationScreen() {
  const { markInteractive } = useObserve();

  useEffect(() => {
    hideAppSplash();
    markInteractive();
  }, [markInteractive]);

  return (
    <LoginScreen
      logo={require('../assets/images/icon.png')}
      logoSize={{ width: 40, height: 40 }}
      appName="WeldFlow"
      subtitle="Projects & tasks on the go"
      showEmailLogin={true}
      accentColor={BRAND}
    />
  );
}
