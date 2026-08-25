import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

import { useI18n } from '@/lib/i18n';

export default function AuthorisationScreen() {
  const { t } = useI18n();

  return (
    <LoginScreen
      logo={require('../assets/images/icon.png')}
      logoSize={{ width: 72, height: 72 }}
      appName={t.appName}
      copy={t.auth}
    />
  );
}
