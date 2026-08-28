import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

export default function AuthorisationScreen() {
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
