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

export interface TextareaProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string;
  helperText?: string;
  numberOfLines?: number;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextInputProps['style']>;
}

export const Textarea = forwardRef<TextInput, TextareaProps>(function Textarea(
  {
    label,
    error,
    helperText,
    numberOfLines = 4,
    containerStyle,
    inputStyle,
    onFocus,
    onBlur,
    editable = true,
    ...rest
  },
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
        <TextInput
          ref={ref}
          multiline
          textAlignVertical="top"
          numberOfLines={numberOfLines}
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
      </View>
      {(error || helperText) && (
        <Text style={[styles.helper, { color: error ? colors.destructive : colors.mutedForeground }]}>
          {error ?? helperText}
        </Text>
      )}
    </View>
  );
});

export default Textarea;

const styles = StyleSheet.create({
  container: { gap: Spacing.xs },
  label: { fontSize: 14, fontWeight: '500' },
  field: {
    minHeight: 110,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  input: { flex: 1, fontSize: 15, minHeight: 86 },
  helper: { fontSize: 13 },
});
