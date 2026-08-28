import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

import { useI18n } from '@/lib/i18n';
import { BRAND } from '@/lib/brand';

export default function AuthorisationScreen() {
  const { t } = useI18n();

  return (
    <LoginScreen
      logo={require('../assets/images/icon.png')}
      logoSize={{ width: 40, height: 40 }}
      appName={t.appName}
      copy={t.auth}
      accentColor={BRAND}
    />
  );
}
