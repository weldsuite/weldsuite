/**
 * Screen chrome for empty/placeholder routes — shared Screen + EmptyState
 * from the mobile design system.
 */

import type { LucideIcon } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Screen, ScreenHeader } from '@/components/screen';

interface PlaceholderScreenProps {
  title: string;
  icon: LucideIcon;
  heading: string;
  message: string;
}

export function PlaceholderScreen({ title, icon: Icon, heading, message }: PlaceholderScreenProps) {
  const router = useRouter();
  const { colors } = useTheme();

  return (
    <Screen header={<ScreenHeader title={title} onBack={() => router.back()} />}>
      <EmptyState
        icon={<Icon size={36} color={colors.muted} strokeWidth={1.5} />}
        title={heading}
        description={message}
        style={{ flex: 1 }}
      />
    </Screen>
  );
}
