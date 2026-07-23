import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

export default function AuthorisationScreen() {
  return (
    <LoginScreen
      logo={require('../assets/images/logo.png')}
      logoSize={{ width: 72, height: 72 }}
      appName="WeldDesk"
      subtitle="Helpdesk & customer support"
      showEmailLogin={true}
    />
  );
}
