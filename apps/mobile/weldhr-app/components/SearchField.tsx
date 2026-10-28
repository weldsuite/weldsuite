/**
 * The search pill, after WeldChat's: a near-white rounded field with a light
 * border and a magnifier, and a round ✕ that pops in once there is text. While it has the
 * keyboard, "Cancel" slides in beside it as on iOS; it clears the search and
 * puts the keyboard away. The screen filters as the text changes. An
 * `accessory` (the filter button) sits right of the field.
 */

import { useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeInRight, FadeOutRight, LinearTransition, ZoomIn, ZoomOut } from 'react-native-reanimated';
import { Search, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { usePalette } from '@/hooks/use-palette';
import { useI18n } from '@/lib/i18n';

/** The field narrows for "Cancel" and widens back in step with it. */
const RESIZE = LinearTransition.duration(220);
/** A step lighter than the grey input fill; the soft border keeps it visible on white. */
const LIGHT_FILL = '#FBFBFC';

/** The field's fill, for things that sit beside it in the same colour. */
export function useSearchFill() {
  const { colors, theme } = useTheme();
  return theme === 'dark' ? colors.inputBackground : LIGHT_FILL;
}

export function SearchField({
  value,
  onChangeText,
  placeholder,
  accessory,
  style,
  testID,
}: Readonly<{
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  accessory?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}>) {
  const { colors } = useTheme();
  const palette = usePalette();
  const { t } = useI18n();
  const input = useRef<TextInput>(null);
  const fill = useSearchFill();
  const [focused, setFocused] = useState(false);

  const cancel = () => {
    onChangeText('');
    input.current?.blur();
  };

  return (
    <View style={[styles.row, style]}>
      <Animated.View layout={RESIZE} style={[styles.field, { backgroundColor: fill, borderColor: palette.softBorder }]}>
        <Search size={18} color={colors.muted} strokeWidth={2.2} />
        <TextInput
          ref={input}
          style={[styles.input, { color: colors.text }]}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="never"
          testID={testID}
        />
        {value.length > 0 ? (
          <Animated.View entering={ZoomIn.duration(160)} exiting={ZoomOut.duration(120)}>
            <Pressable
              onPress={() => onChangeText('')}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t.common.clear}
              style={[styles.clear, { backgroundColor: colors.muted }]}
            >
              <X size={11} color={colors.background} strokeWidth={3} />
            </Pressable>
          </Animated.View>
        ) : null}
      </Animated.View>
      {accessory}
      {focused ? (
        <Animated.View entering={FadeInRight.duration(220)} exiting={FadeOutRight.duration(160)}>
          <Pressable onPress={cancel} hitSlop={8} accessibilityRole="button">
            <Text style={[styles.cancel, { color: colors.text }]}>{t.common.cancel}</Text>
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    height: 42,
    paddingLeft: 14,
    paddingRight: 13,
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: 1,
  },
  input: { flex: 1, fontSize: 16, padding: 0 },
  // A filled round ✕, like the iOS search field.
  clear: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  cancel: { fontSize: 16 },
});
