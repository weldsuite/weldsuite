/**
 * Building blocks for the create and edit screens: a labelled field that can
 * show a validation message under it, and the screen frame with a header, a
 * scrolling body and a submit button.
 */

import React, { type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type TextInputProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { StackHeader } from '@/components/headers';

interface FormFieldProps extends Omit<TextInputProps, 'style'> {
  label: string;
  /** Marks the label with an asterisk. */
  required?: boolean;
  /** Validation message shown under the field; also turns the border red. */
  error?: string | null;
  multiline?: boolean;
}

export function FormField({ label, required, error, multiline, ...inputProps }: Readonly<FormFieldProps>) {
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.muted }]}>
        {label}
        {required ? <Text style={{ color: colors.destructive }}> *</Text> : null}
      </Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        textAlignVertical={multiline ? 'top' : 'center'}
        multiline={multiline}
        {...inputProps}
        style={[
          multiline ? styles.textArea : styles.input,
          {
            color: colors.text,
            borderColor: error ? colors.destructive : colors.divider,
            backgroundColor: colors.background,
          },
        ]}
      />
      {error ? (
        <Text style={[styles.error, { color: colors.destructive }]} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

interface FormScreenProps {
  title: string;
  onClose: () => void;
  submitLabel: string;
  onSubmit: () => void;
  submitting?: boolean;
  children: ReactNode;
}

/** Header, keyboard-aware scrolling body and a submit button pinned to the bottom. */
export function FormScreen({
  title,
  onClose,
  submitLabel,
  onSubmit,
  submitting = false,
  children,
}: Readonly<FormScreenProps>) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      style={[styles.screen, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StackHeader title={title} onBack={onClose} />
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
      <View
        style={[
          styles.footer,
          { paddingBottom: Math.max(insets.bottom, 12), borderTopColor: colors.divider, backgroundColor: colors.background },
        ]}
      >
        <TouchableOpacity
          style={[styles.submit, { backgroundColor: colors.text, opacity: submitting ? 0.6 : 1 }]}
          onPress={onSubmit}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel={submitLabel}
        >
          {submitting ? (
            <ActivityIndicator color={colors.background} />
          ) : (
            <Text style={[styles.submitText, { color: colors.background }]}>{submitLabel}</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1 },
  bodyContent: { padding: 16, paddingBottom: 32 },
  field: { marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  input: { fontSize: 15, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  textArea: {
    fontSize: 15,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 100,
  },
  error: { fontSize: 12, marginTop: 4 },
  footer: { paddingHorizontal: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  submit: { paddingVertical: 14, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontSize: 15, fontWeight: '600' },
});
