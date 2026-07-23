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
 * inner look (height, radius, fill, icon, typography) is owned here.
 */
import React from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Search, X } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';

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
}: SearchFieldProps) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);
  const isButton = onChangeText === undefined && !!onPress;

  if (isButton) {
    return (
      <TouchableOpacity style={[styles.container, style]} activeOpacity={0.6} onPress={onPress}>
        <Search size={20} color={colors.textSecondary} />
        <Text style={styles.placeholder} numberOfLines={1}>{placeholder}</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.container, style]}>
      <Search size={20} color={colors.textSecondary} />
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        autoFocus={autoFocus}
        returnKeyType="search"
      />
      {!!value?.length && onClear && (
        <TouchableOpacity onPress={onClear} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <X size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (c: ColorScheme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      height: 40,
      backgroundColor: c.searchField,
      borderRadius: 14,
      gap: 10,
    },
    input: { flex: 1, fontSize: 16, color: c.textPrimary, padding: 0, fontWeight: '500' },
    placeholder: { flex: 1, fontSize: 16, color: c.textSecondary, fontWeight: '500' },
  });
