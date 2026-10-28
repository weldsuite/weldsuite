/**
 * The filter button beside a search field: a square in the field's fill and
 * border with a filter icon, which opens the filter sheet. While a filter is
 * on it turns black, so a shortened list never comes as a surprise.
 */

import { Pressable, StyleSheet } from 'react-native';
import { ListFilter } from 'lucide-react-native';

import { usePalette } from '@/hooks/use-palette';
import { useSearchFill } from './SearchField';

/** The search field's height, so the two line up. */
const SIZE = 42;

export function FilterButton({
  onPress,
  active,
  label,
  testID,
}: Readonly<{
  onPress: () => void;
  active: boolean;
  label: string;
  testID?: string;
}>) {
  const palette = usePalette();
  const fill = useSearchFill();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        active
          ? { backgroundColor: palette.ink, borderColor: palette.ink }
          : { backgroundColor: fill, borderColor: palette.softBorder },
        { opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <ListFilter size={19} color={active ? palette.inkText : palette.text} strokeWidth={2.2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
