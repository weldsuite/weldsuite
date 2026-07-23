import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

export default function AuthorisationScreen() {
  return (
    <LoginScreen
      logo={require('../assets/images/logo.png')}
      logoSize={{ width: 72, height: 72 }}
      appName="WeldSocial"
      subtitle="Social publishing on the go"
      showEmailLogin={true}
    />
  );
}
