import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

export default function AuthorisationScreen() {
  return (
    <LoginScreen
      logo={require('../assets/images/logo.png')}
      logoSize={{ width: 40, height: 40 }}
      appName="WeldSocial"
      subtitle="Social publishing on the go"
      showEmailLogin={true}
      accentColor="#8B5CF6"
    />
  );
}
