import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

export default function AuthorisationScreen() {
  return (
    <LoginScreen
      logo={require('../assets/images/logo.png')}
      logoSize={{ width: 72, height: 72 }}
      appName="WeldFlow"
      subtitle="Projects & tasks on the go"
      showEmailLogin={true}
    />
  );
}
