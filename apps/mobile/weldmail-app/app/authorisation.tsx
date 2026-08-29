import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';
import { useObserve } from 'expo-observe';
import { useEffect } from 'react';
import { WeldMailWordmark } from '@/components/WeldMailWordmark';
import { hideAppSplash } from '@/utils/splash';

export default function AuthorisationScreen() {
  const { markInteractive } = useObserve();

  useEffect(() => {
    hideAppSplash();
    markInteractive();
  }, [markInteractive]);

  return (
    <LoginScreen
      logoElement={<WeldMailWordmark width={210} />}
      appName="WeldMail"
      subtitle="Professional email client"
      showEmailLogin={true}
      accentColor="#F06543"
    />
  );
}
