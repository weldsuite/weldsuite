import { StyleSheet, View } from 'react-native';
import { CreditCard, KeyRound, StickyNote } from 'lucide-react-native';
import type { WeldPassItemType } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND, BRAND_DARK } from '@/lib/brand';

const ICONS = { login: KeyRound, note: StickyNote, card: CreditCard } as const;

/** The item's type on a tinted tile. */
export function ItemIcon({ type, size = 40 }: Readonly<{ type: WeldPassItemType; size?: number }>) {
  const { theme } = useTheme();
  const Icon = ICONS[type];
  const color = theme === 'dark' ? BRAND_DARK : BRAND;
  return (
    <View
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          borderRadius: size * 0.28,
          backgroundColor: theme === 'dark' ? 'rgba(129, 140, 248, 0.16)' : 'rgba(79, 70, 229, 0.10)',
        },
      ]}
    >
      <Icon size={size * 0.5} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: 'center', justifyContent: 'center' },
});
