/**
 * Shared chat search field. Single source of truth for the search "pill" design
 * so every surface that shows it (DMs list, search page, …) stays in sync.
 *
 * Two modes:
 *  - Editable (default): pass `value` + `onChangeText` → renders a TextInput
 *    with an optional clear (✕) button.
 *  - Button: pass `onPress` and omit `onChangeText` → renders a tappable
 *    placeholder row (e.g. the DMs list bar that opens the search page).
 *
 * Outer spacing differs per surface, so pass margins/`flex` via `style`; the
 * inner look (height, radius, fill, icon, typography) is owned here. It is a
 * light gray field with softly rounded corners.
 */
import React from 'react';
import { View, Text, TextInput, TouchableOpacity, Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Search, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import type { ThemeColors } from '@/lib/theme-colors';


interface SearchFieldProps {
  placeholder?: string;
  /** Editable mode — provide both to render a text input. */
  value?: string;
  onChangeText?: (text: string) => void;
  autoFocus?: boolean;
  onClear?: () => void;
  inputRef?: React.Ref<TextInput>;
  /** Button mode — provide (and omit onChangeText) to render a tappable row. */
  onPress?: () => void;
  /** Outer container overrides (margins / flex), per surface. */
  style?: StyleProp<ViewStyle>;
}

export function SearchField({
  placeholder = 'Search',
  value,
  onChangeText,
  autoFocus,
  onClear,
  inputRef,
  onPress,
  style,
}: Readonly<SearchFieldProps>) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const isButton = onChangeText === undefined && !!onPress;
  const icon = <Search size={18} color={colors.muted} strokeWidth={2.2} />;

  if (isButton) {
    return (
      <Pressable
        style={({ pressed }) => [styles.container, pressed && styles.containerPressed, style]}
        onPress={onPress}
        accessibilityRole="search"
        accessibilityLabel={placeholder}
      >
        {icon}
        <Text style={styles.placeholder} numberOfLines={1}>{placeholder}</Text>
      </Pressable>
    );
  }

  return (
    <View style={[styles.container, style]}>
      {icon}
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        autoFocus={autoFocus}
        returnKeyType="search"
      />
      {!!value?.length && onClear && (
        <TouchableOpacity
          style={styles.clear}
          onPress={onClear}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
        >
          <X size={11} color={colors.background} strokeWidth={3} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      height: 42,
      paddingLeft: 14,
      paddingRight: 13,
      borderRadius: 14,
      borderCurve: 'continuous',
      backgroundColor: c.inputBackground,
    },
    containerPressed: { backgroundColor: c.skeleton },
    input: { flex: 1, fontSize: 16, color: c.text, padding: 0 },
    placeholder: { flex: 1, fontSize: 16, color: c.muted },
    // A filled round ✕, like the iOS search field.
    clear: {
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: c.muted,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
