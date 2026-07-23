import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

export default function AuthScreen() {
  return (
    <LoginScreen
      appName="WeldChat"
      subtitle="Team communication for your workspace"
      showEmailLogin={true}
    />
  );
}
