import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';

export default function AuthorizationScreen() {
  return (
    <LoginScreen
      logo={require('@/assets/images/weldsuite-logo.png')}
      appName="WeldSuite"
      subtitle="Enter your credentials to access your workspace"
    />
  );
}
