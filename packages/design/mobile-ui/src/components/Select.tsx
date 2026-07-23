import React, { useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Check, ChevronDown } from 'lucide-react-native';
import { useTheme } from '../contexts/ThemeContext';
import { Radii, Spacing } from '../constants/theme';

export interface SelectOption {
  label: string;
  value: string;
}

export interface SelectProps {
  value: string | null;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  label,
  disabled = false,
  style,
}: SelectProps) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);

  const selectedOption = options.find((o) => o.value === value) ?? null;

  function handleSelect(optionValue: string) {
    onValueChange(optionValue);
    setOpen(false);
  }

  return (
    <View style={[styles.container, style]}>
      {label && (
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      )}

      <Pressable
        onPress={() => !disabled && setOpen(true)}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        style={({ pressed }) => [
          styles.trigger,
          {
            backgroundColor: colors.inputBackground,
            borderColor: colors.border,
            opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
          },
        ]}
      >
        <Text
          style={[
            styles.triggerText,
            {
              color: selectedOption ? colors.text : colors.placeholder,
              flex: 1,
            },
          ]}
          numberOfLines={1}
        >
          {selectedOption ? selectedOption.label : placeholder}
        </Text>
        <ChevronDown size={18} color={colors.mutedForeground} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <TouchableWithoutFeedback onPress={() => setOpen(false)}>
          <View style={[styles.overlay, { backgroundColor: colors.overlay }]}>
            <TouchableWithoutFeedback>
              <View style={[styles.sheet, { backgroundColor: colors.card }]}>
                <View
                  style={[styles.handle, { backgroundColor: colors.mutedForeground }]}
                />
                <ScrollView
                  bounces={false}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {options.map((option, index) => {
                    const isSelected = option.value === value;
                    const isLast = index === options.length - 1;
                    return (
                      <Pressable
                        key={option.value}
                        onPress={() => handleSelect(option.value)}
                        accessibilityRole="menuitem"
                        accessibilityState={{ selected: isSelected }}
                        style={({ pressed }) => [
                          styles.optionRow,
                          !isLast && [
                            styles.optionRowBorder,
                            { borderBottomColor: colors.border },
                          ],
                          { backgroundColor: pressed ? colors.secondary : 'transparent' },
                        ]}
                      >
                        <Text
                          style={[
                            styles.optionLabel,
                            {
                              color: isSelected ? colors.primary : colors.text,
                              fontWeight: isSelected ? '600' : '400',
                            },
                          ]}
                        >
                          {option.label}
                        </Text>
                        {isSelected && (
                          <Check size={18} color={colors.primary} />
                        )}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

export default Select;

const styles = StyleSheet.create({
  container: {
    gap: Spacing.xs,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: 44,
    paddingHorizontal: Spacing.md,
    borderRadius: Radii.md,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  triggerText: {
    fontSize: 15,
  },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: Radii.xl,
    borderTopRightRadius: Radii.xl,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xl,
    maxHeight: '70%',
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: Radii.full,
    marginBottom: Spacing.md,
    opacity: 0.4,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    minHeight: 48,
  },
  optionRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionLabel: {
    fontSize: 15,
    flex: 1,
  },
});
