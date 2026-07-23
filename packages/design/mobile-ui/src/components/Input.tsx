import React, { forwardRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';

export interface InputProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string;
  helperText?: string;
  /** Node rendered inside the field, before the text (e.g. a search icon). */
  leftElement?: React.ReactNode;
  /** Node rendered inside the field, after the text (e.g. a clear button). */
  rightElement?: React.ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextInputProps['style']>;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  { label, error, helperText, leftElement, rightElement, containerStyle, inputStyle, onFocus, onBlur, editable = true, ...rest },
  ref,
) {
  const { colors } = useTheme();
  const [focused, setFocused] = useState(false);

  const borderColor = error ? colors.destructive : focused ? colors.ring : colors.border;

  return (
    <View style={[styles.container, containerStyle]}>
      {label && <Text style={[styles.label, { color: colors.text }]}>{label}</Text>}
      <View
        style={[
          styles.field,
          {
            backgroundColor: colors.inputBackground,
            borderColor,
            opacity: editable ? 1 : 0.5,
          },
        ]}
      >
        {leftElement}
        <TextInput
          ref={ref}
          editable={editable}
          placeholderTextColor={colors.placeholder}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, { color: colors.text }, inputStyle]}
          {...rest}
        />
        {rightElement}
      </View>
      {(error || helperText) && (
        <Text style={[styles.helper, { color: error ? colors.destructive : colors.mutedForeground }]}>
          {error ?? helperText}
        </Text>
      )}
    </View>
  );
});

export default Input;

const styles = StyleSheet.create({
  container: { gap: Spacing.xs },
  label: { fontSize: 14, fontWeight: '500' },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: 44,
    paddingHorizontal: Spacing.md,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  input: { flex: 1, fontSize: 15, paddingVertical: 10 },
  helper: { fontSize: 13 },
});
