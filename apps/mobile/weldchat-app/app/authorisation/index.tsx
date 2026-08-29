import { useEffect } from 'react';
import { useObserve } from 'expo-observe';
import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

import { hideAppSplash } from '@/utils/splash';

export default function AuthScreen() {
  const { markInteractive } = useObserve();

  useEffect(() => {
    hideAppSplash();
    markInteractive();
  }, [markInteractive]);

  return (
    <LoginScreen
      appName="WeldChat"
      subtitle="Team communication for your workspace"
      showEmailLogin={true}
      accentColor="#2563eb"
    />
  );
}
