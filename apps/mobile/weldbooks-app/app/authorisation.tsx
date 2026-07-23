import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

export default function AuthorisationScreen() {
  return (
    <LoginScreen
      logo={require('../assets/images/icon.png')}
      logoSize={{ width: 72, height: 72 }}
      appName="WeldBooks"
      subtitle="Accounting on the go"
      showEmailLogin={false}
    />
  );
}
