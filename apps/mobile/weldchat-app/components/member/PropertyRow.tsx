import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useI18n } from '@/lib/i18n';

import type { ThemeColors } from '@/lib/theme-colors';

type IconType = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

/**
 * One field of a member's details, laid out like the platform's PropertyRow:
 * a 120pt label column (icon + muted label), the value beside it. Empty
 * values read "Set {label}…". Editable rows turn into an input on tap and
 * save on blur / return.
 */
export function PropertyRow({
  icon: Icon,
  label,
  value,
  multiline,
  keyboardType,
  readOnly,
  onSave,
  renderValue,
}: Readonly<{
  icon: IconType;
  label: string;
  value: string | null | undefined;
  multiline?: boolean;
  keyboardType?: 'default' | 'phone-pad' | 'decimal-pad';
  readOnly?: boolean;
  onSave?: (value: string | null) => void;
  /** Custom render of a non-empty value (links, timezone, …). */
  renderValue?: (value: string) => ReactNode;
}>) {
  const { colors } = useTheme();
  const { t, format } = useI18n();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const editable = !readOnly && !!onSave;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next === (value ?? '').trim()) return;
    onSave?.(next === '' ? null : next);
  };

  let content: ReactNode;
  if (editing) {
    content = (
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={multiline ? undefined : commit}
        autoFocus
        multiline={multiline}
        keyboardType={keyboardType}
        returnKeyType={multiline ? 'default' : 'done'}
        style={styles.input}
      />
    );
  } else if (!value) {
    content = <Text style={styles.placeholder}>{format(t.member.setField, { label })}</Text>;
  } else {
    content = renderValue ? renderValue(value) : <Text style={styles.value}>{value}</Text>;
  }

  return (
    <View style={styles.row}>
      <View style={styles.labelCell}>
        <Icon size={16} color={colors.mutedForeground} strokeWidth={2} />
        <Text style={styles.label} numberOfLines={1}>{label}</Text>
      </View>
      <Pressable
        style={[styles.valueCell, editing && styles.valueCellEditing]}
        onPress={editable && !editing ? () => setEditing(true) : undefined}
        disabled={!editable || editing}
        accessibilityRole={editable ? 'button' : undefined}
        accessibilityLabel={editable ? label : undefined}
      >
        {content}
      </Pressable>
    </View>
  );
}

/** Icon in a muted circle, title and description: the panel's empty / error state. */
export function PanelEmptyState({
  icon,
  title,
  description,
}: Readonly<{ icon: ReactNode; title: string; description: string }>) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>{icon}</View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyDescription}>{description}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', minHeight: 32, gap: 8 },
    labelCell: { width: 120, flexDirection: 'row', alignItems: 'center', gap: 8 },
    label: { flexShrink: 1, fontSize: 14, color: c.mutedForeground },
    valueCell: {
      flex: 1,
      minHeight: 32,
      justifyContent: 'center',
      paddingVertical: 4,
      // Same box in every state, so entering edit mode never moves the text.
      marginHorizontal: -8,
      paddingHorizontal: 7,
      borderWidth: 1,
      borderColor: 'transparent',
      borderRadius: 9,
    },
    valueCellEditing: { borderColor: c.border, backgroundColor: c.background },
    value: { fontSize: 14, color: c.text },
    placeholder: { fontSize: 14, color: c.mutedForeground, opacity: 0.7 },
    input: { fontSize: 14, color: c.text, padding: 0 },
    empty: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 48, gap: 8 },
    emptyIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: c.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emptyTitle: { fontSize: 14, fontWeight: '500', color: c.text, textAlign: 'center' },
    emptyDescription: { fontSize: 12, color: c.mutedForeground, textAlign: 'center', maxWidth: 260 },
  });
