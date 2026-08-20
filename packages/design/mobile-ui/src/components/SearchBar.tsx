import React from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Search, X } from 'lucide-react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';

export interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onClear?: () => void;
  autoFocus?: boolean;
  /** Hardware barcode wedges typically submit with Enter. */
  onSubmitEditing?: TextInputProps['onSubmitEditing'];
  autoCorrect?: boolean;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  containerStyle?: StyleProp<ViewStyle>;
}

export function SearchBar({
  value,
  onChangeText,
  placeholder = 'Search',
  onClear,
  autoFocus,
  onSubmitEditing,
  autoCorrect,
  autoCapitalize,
  containerStyle,
}: SearchBarProps) {
  const { colors } = useTheme();

  function handleClear() {
    onChangeText('');
    onClear?.();
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.inputBackground },
        containerStyle,
      ]}
    >
      <Search size={18} color={colors.mutedForeground} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.placeholder}
        autoFocus={autoFocus}
        returnKeyType="search"
        clearButtonMode="never"
        autoCorrect={autoCorrect}
        autoCapitalize={autoCapitalize}
        onSubmitEditing={onSubmitEditing}
        blurOnSubmit={false}
        style={[styles.input, { color: colors.text }]}
      />
      {value.length > 0 && (
        <Pressable
          onPress={handleClear}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={8}
        >
          <X size={16} color={colors.mutedForeground} />
        </Pressable>
      )}
    </View>
  );
}

export default SearchBar;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: 40,
    paddingHorizontal: Spacing.md,
    borderRadius: Radii.md,
  },
  input: { flex: 1, fontSize: 15, paddingVertical: Spacing.sm },
});
