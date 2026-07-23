import { LoginScreen } from '@weldsuite/mobile-ui/components/LoginScreen';
import { WeldMailWordmark } from '@/components/WeldMailWordmark';

export default function AuthorisationScreen() {
  return (
    <LoginScreen
      logoElement={<WeldMailWordmark width={210} />}
      appName="WeldMail"
      subtitle="Professional email client"
      showEmailLogin={true}
    />
  );
}
