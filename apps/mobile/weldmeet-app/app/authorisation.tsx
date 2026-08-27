import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

export default function AuthorisationScreen() {
  return (
    <LoginScreen
      logo={require('../assets/images/logo.png')}
      logoSize={{ width: 40, height: 40 }}
      appName="WeldMeet"
      subtitle="Video meetings on the go"
      showEmailLogin={true}
      accentColor="#7C3AED"
    />
  );
}
