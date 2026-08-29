import { useEffect } from 'react';
import { useObserve } from 'expo-observe';
import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

import { hideAppSplash } from '@/utils/splash';

export default function AuthorisationScreen() {
  const { markInteractive } = useObserve();

  useEffect(() => {
    hideAppSplash();
    markInteractive();
  }, [markInteractive]);

  return (
    <LoginScreen
      logo={require('../assets/images/logo.png')}
      logoSize={{ width: 40, height: 40 }}
      appName="WeldStash"
      subtitle="Products and stock for the warehouse floor"
      showEmailLogin={true}
      accentColor="#EA580C"
    />
  );
}
