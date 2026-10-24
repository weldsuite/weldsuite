import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { TONES, toneFg, type Tone } from '@/constants/brand';

/** A small tinted label for statuses ("Pending", "Paid", "New"). */
export function Pill({ label, tone = 'neutral', style }: Readonly<{ label: string; tone?: Tone; style?: StyleProp<ViewStyle> }>) {
  const { theme } = useTheme();
  return (
    <View style={[styles.pill, { backgroundColor: TONES[tone].bg }, style]}>
      <Text style={[styles.label, { color: toneFg(tone, theme) }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  pending: 'warning',
  approved: 'success',
  paid: 'brand',
  rejected: 'danger',
  cancelled: 'neutral',
};

/** Leave requests and declarations share their status words. */
export function statusTone(status: string): Tone {
  return STATUS_TONES[status] ?? 'neutral';
}

const styles = StyleSheet.create({
  pill: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  label: { fontSize: 12, fontWeight: '600' },
});
