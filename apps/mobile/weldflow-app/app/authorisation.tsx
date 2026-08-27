import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

import { BRAND } from '@/lib/brand';

export default function AuthorisationScreen() {
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
