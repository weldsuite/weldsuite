/**
 * Small pickers for the edit screens: a bottom sheet with a list of options,
 * a form row that opens it, a tag editor and a scrolling tab bar.
 */

import React, { useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronDown, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useI18n } from '@/lib/i18n';

export interface SheetOption<V extends string = string> {
  value: V;
  label: string;
  /** Dot shown before the label (stage or status colour). */
  color?: string;
  hint?: string;
}

interface OptionSheetProps<V extends string> {
  visible: boolean;
  title: string;
  options: readonly SheetOption<V>[];
  selected?: V | readonly V[] | null;
  /** Adds a "None" row that selects null. */
  allowNone?: boolean;
  onSelect: (value: V | null) => void;
  onClose: () => void;
}

export function OptionSheet<V extends string>({
  visible,
  title,
  options,
  selected,
  allowNone,
  onSelect,
  onClose,
}: Readonly<OptionSheetProps<V>>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const isSelected = (value: V | null) =>
    Array.isArray(selected) ? value !== null && selected.includes(value) : (selected ?? null) === value;

  const row = (value: V | null, label: string, color?: string, hint?: string) => (
    <TouchableOpacity
      key={value ?? '__none'}
      style={[styles.option, { borderBottomColor: colors.divider }]}
      onPress={() => onSelect(value)}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected(value) }}
      accessibilityLabel={label}
    >
      {color ? <View style={[styles.dot, { backgroundColor: color }]} /> : null}
      <View style={styles.optionText}>
        <Text style={[styles.optionLabel, { color: colors.text }]} numberOfLines={1}>
          {label}
        </Text>
        {hint ? (
          <Text style={[styles.optionHint, { color: colors.muted }]} numberOfLines={1}>
            {hint}
          </Text>
        ) : null}
      </View>
      {isSelected(value) ? <Check size={18} color={colors.text} /> : null}
    </TouchableOpacity>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose} accessibilityRole="button">
        <View
          style={[styles.sheet, { backgroundColor: colors.background, paddingBottom: Math.max(insets.bottom, 16) }]}
          onStartShouldSetResponder={() => true}
        >
          <View style={[styles.header, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">
              {title}
            </Text>
            <TouchableOpacity onPress={onClose} accessibilityRole="button" accessibilityLabel={t.common.close}>
              <X size={20} color={colors.muted} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {allowNone ? row(null, t.common.none) : null}
            {options.map((option) => row(option.value, option.label, option.color, option.hint))}
          </ScrollView>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

interface SelectFieldProps {
  label: string;
  value?: string | null;
  placeholder?: string;
  color?: string;
  required?: boolean;
  error?: string | null;
  disabled?: boolean;
  onPress: () => void;
  onClear?: () => void;
}

/** A form row that shows the chosen value and opens a picker. */
export function SelectField({
  label,
  value,
  placeholder,
  color,
  required,
  error,
  disabled,
  onPress,
  onClear,
}: Readonly<SelectFieldProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.muted }]}>
        {label}
        {required ? <Text style={{ color: colors.destructive }}> *</Text> : null}
      </Text>
      <TouchableOpacity
        style={[
          styles.select,
          {
            borderColor: error ? colors.destructive : colors.divider,
            backgroundColor: colors.background,
            opacity: disabled ? 0.6 : 1,
          },
        ]}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={value ?? undefined}
      >
        {color ? <View style={[styles.dot, { backgroundColor: color }]} /> : null}
        <Text style={[styles.selectText, { color: value ? colors.text : colors.muted }]} numberOfLines={1}>
          {value || placeholder || t.common.select}
        </Text>
        {value && onClear && !disabled ? (
          <TouchableOpacity onPress={onClear} hitSlop={8} accessibilityRole="button" accessibilityLabel={t.common.clear}>
            <X size={16} color={colors.muted} />
          </TouchableOpacity>
        ) : (
          <ChevronDown size={16} color={colors.muted} />
        )}
      </TouchableOpacity>
      {error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}
    </View>
  );
}

interface TagInputProps {
  label: string;
  value: readonly string[];
  placeholder: string;
  onChange: (tags: string[]) => void;
}

/** Tags as removable chips plus a field that adds one on submit or comma. */
export function TagInput({ label, value, placeholder, onChange }: Readonly<TagInputProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const [draft, setDraft] = useState('');

  const add = (text: string) => {
    const tag = text.trim();
    if (tag && !value.some((existing) => existing.toLowerCase() === tag.toLowerCase())) onChange([...value, tag]);
    setDraft('');
  };

  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.muted }]}>{label}</Text>
      {value.length > 0 && (
        <View style={styles.tags}>
          {value.map((tag) => (
            <View key={tag} style={[styles.tag, { backgroundColor: colors.secondary }]}>
              <Text style={[styles.tagText, { color: colors.text }]}>{tag}</Text>
              <TouchableOpacity
                onPress={() => onChange(value.filter((existing) => existing !== tag))}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`${t.common.remove} ${tag}`}
              >
                <X size={12} color={colors.muted} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}
      <TextInput
        accessibilityLabel={label}
        style={[styles.input, { color: colors.text, borderColor: colors.divider, backgroundColor: colors.background }]}
        value={draft}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        onChangeText={(text) => {
          if (text.endsWith(',')) add(text.slice(0, -1));
          else setDraft(text);
        }}
        onSubmitEditing={() => add(draft)}
        onBlur={() => add(draft)}
        returnKeyType="done"
        submitBehavior="submit"
        autoCapitalize="none"
      />
    </View>
  );
}

export interface TabItem<K extends string> {
  key: K;
  label: string;
  count?: number;
}

interface ScrollTabsProps<K extends string> {
  tabs: readonly TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
}

/** A row of tabs that scrolls sideways, like the record panel tabs on the web. */
export function ScrollTabs<K extends string>({ tabs, active, onChange }: Readonly<ScrollTabsProps<K>>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tabsWrap, { borderBottomColor: colors.divider, backgroundColor: colors.background }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {tabs.map((tab) => {
          const selected = tab.key === active;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, selected && { borderBottomColor: colors.text }]}
              onPress={() => onChange(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={tab.label}
            >
              <Text style={[styles.tabText, { color: selected ? colors.text : colors.muted }]}>
                {tab.label}
                {tab.count !== undefined ? ` ${tab.count}` : ''}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '75%' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  list: { flexGrow: 0 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionText: { flex: 1 },
  optionLabel: { fontSize: 15 },
  optionHint: { fontSize: 12, marginTop: 2 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  field: { marginBottom: 16 },
  fieldLabel: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  selectText: { flex: 1, fontSize: 15 },
  error: { fontSize: 12, marginTop: 4 },
  input: { fontSize: 15, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 },
  tagText: { fontSize: 13 },
  tabsWrap: { borderBottomWidth: StyleSheet.hairlineWidth },
  tabs: { paddingHorizontal: 8 },
  tab: { paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabText: { fontSize: 14, fontWeight: '600' },
});
