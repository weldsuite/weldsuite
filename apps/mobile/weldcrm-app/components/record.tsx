/**
 * Pieces shared by the person and company detail screens: the header actions,
 * the avatar block, an editable field row, and the linked-record rows.
 */

import React, { type ReactNode } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View, type TextInputProps } from 'react-native';
import { ChevronRight, Edit3, Mail, Phone, Save, Trash2, X, type LucideIcon } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useI18n } from '@/lib/i18n';
import { initialsOf } from '@/lib/crm';

const ACCENT = '#7C3AED';

interface HeaderActionsProps {
  isEditing: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** Edit and delete while reading; cancel and save while editing. */
export function RecordHeaderActions({ isEditing, saving, onCancel, onSave, onEdit, onDelete }: Readonly<HeaderActionsProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  if (isEditing) {
    return (
      <>
        <TouchableOpacity
          onPress={onCancel}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel={t.common.cancel}
        >
          <X size={22} color={colors.muted} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onSave}
          style={styles.headerButton}
          disabled={saving}
          accessibilityRole="button"
          accessibilityLabel={t.common.save}
        >
          <Save size={22} color={saving ? colors.muted : ACCENT} />
        </TouchableOpacity>
      </>
    );
  }
  return (
    <>
      <TouchableOpacity
        onPress={onEdit}
        style={styles.headerButton}
        accessibilityRole="button"
        accessibilityLabel={t.common.edit}
      >
        <Edit3 size={22} color={colors.text} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={onDelete}
        style={styles.headerButton}
        accessibilityRole="button"
        accessibilityLabel={t.common.delete}
      >
        <Trash2 size={22} color={colors.destructive} />
      </TouchableOpacity>
    </>
  );
}

interface ProfileHeaderProps {
  name: string;
  subtitle?: string;
  isEditing: boolean;
  /** Left out when the record has no phone number, which hides the button. */
  onCall?: () => void;
  /** Left out when the record has no email address. */
  onEmail?: () => void;
  /** A small label under the name, such as "Archived". */
  badge?: string;
}

/** Avatar, name and the call and email buttons. */
export function RecordProfileHeader({ name, subtitle, isEditing, onCall, onEmail, badge }: Readonly<ProfileHeaderProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <View style={styles.profile}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initialsOf(name)}</Text>
      </View>
      <Text style={[styles.profileName, { color: colors.text }]}>{name}</Text>
      {!!subtitle && !isEditing && <Text style={[styles.profileSub, { color: colors.muted }]}>{subtitle}</Text>}

      {!!badge && (
        <View style={[styles.badge, styles.profileBadge]}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      )}

      {!isEditing && (!!onCall || !!onEmail) && (
        <View style={styles.quickActions}>
          {onCall ? (
            <TouchableOpacity
              style={[styles.quickAction, { backgroundColor: colors.background, borderColor: colors.divider }]}
              onPress={onCall}
              accessibilityRole="button"
            >
              <Phone size={20} color={ACCENT} />
              <Text style={[styles.quickActionText, { color: colors.text }]}>{t.common.call}</Text>
            </TouchableOpacity>
          ) : null}
          {onEmail ? (
            <TouchableOpacity
              style={[styles.quickAction, { backgroundColor: colors.background, borderColor: colors.divider }]}
              onPress={onEmail}
              accessibilityRole="button"
            >
              <Mail size={20} color={ACCENT} />
              <Text style={[styles.quickActionText, { color: colors.text }]}>{t.common.email}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </View>
  );
}

export interface RecordFieldConfig<K extends string> {
  key: K;
  label: string;
  icon: LucideIcon;
  placeholder: string;
  required?: boolean;
  multiline?: boolean;
  inputProps?: TextInputProps;
  /** Style the read-only value as a link: always, or only when filled in. */
  viewLink?: 'always' | 'whenFilled';
  onPressView?: () => void;
}

interface RecordFieldProps<K extends string> {
  config: RecordFieldConfig<K>;
  value: string;
  isEditing: boolean;
  error?: string | null;
  onChange: (key: K, text: string) => void;
}

interface RecordFieldInputProps<K extends string> {
  config: RecordFieldConfig<K>;
  value: string;
  error?: string | null;
  onChange: (key: K, text: string) => void;
}

function RecordFieldInput<K extends string>({ config, value, error, onChange }: Readonly<RecordFieldInputProps<K>>) {
  const { colors } = useTheme();
  return (
    <>
      <TextInput
        accessibilityLabel={config.label}
        style={[
          config.multiline ? styles.textArea : styles.input,
          { color: colors.text, borderColor: error ? colors.destructive : colors.divider },
        ]}
        value={value}
        onChangeText={(next) => onChange(config.key, next)}
        placeholder={config.placeholder}
        placeholderTextColor={colors.muted}
        multiline={config.multiline}
        textAlignVertical={config.multiline ? 'top' : 'center'}
        {...config.inputProps}
      />
      {error ? <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text> : null}
    </>
  );
}

function RecordFieldValue<K extends string>({ config, value }: Readonly<{ config: RecordFieldConfig<K>; value: string }>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const isLink = config.viewLink === 'always' || (config.viewLink === 'whenFilled' && !!value);
  const text = (
    <Text style={[styles.fieldValue, isLink ? { color: ACCENT } : { color: colors.text }]}>
      {value || t.common.dash}
    </Text>
  );
  if (!config.onPressView || !value) return text;
  return (
    <TouchableOpacity onPress={config.onPressView} accessibilityRole="link">
      {text}
    </TouchableOpacity>
  );
}

/** A labelled value that turns into a text input while editing. */
export function RecordField<K extends string>({ config, value, isEditing, error, onChange }: Readonly<RecordFieldProps<K>>) {
  const { colors } = useTheme();
  const Icon = config.icon;

  return (
    <View style={styles.field}>
      <View style={styles.fieldLabel}>
        <Icon size={16} color={colors.muted} />
        <Text style={[styles.fieldLabelText, { color: colors.muted }]}>{config.label}</Text>
        {isEditing && config.required ? <Text style={{ color: colors.destructive, fontSize: 13 }}>*</Text> : null}
      </View>
      {isEditing ? (
        <RecordFieldInput config={config} value={value} error={error} onChange={onChange} />
      ) : (
        <RecordFieldValue config={config} value={value} />
      )}
    </View>
  );
}

export function RecordSectionTitle({ children }: Readonly<{ children: ReactNode }>) {
  const { colors } = useTheme();
  return <Text style={[styles.sectionTitle, { color: colors.text }]}>{children}</Text>;
}

interface LinkRowProps {
  title: string;
  subtitle?: string;
  badge?: string;
  trailing?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityHint?: string;
}

/** A tappable row for a person or deal linked to the record. */
export function RecordLinkRow({ title, subtitle, badge, trailing, onPress, onLongPress, accessibilityHint }: Readonly<LinkRowProps>) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      style={[styles.linkRow, { borderBottomColor: colors.divider }]}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityHint={accessibilityHint}
    >
      <View style={styles.linkText}>
        <Text style={[styles.linkTitle, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        {!!subtitle && (
          <Text style={[styles.linkSub, { color: colors.muted }]} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {!!badge && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      )}
      {!!trailing && <Text style={[styles.trailing, { color: colors.text }]}>{trailing}</Text>}
      {onPress ? <ChevronRight size={16} color={colors.muted} /> : null}
    </TouchableOpacity>
  );
}

export function RecordInfoRow({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.infoRow, { borderBottomColor: colors.divider }]}>
      <Text style={[styles.infoLabel, { color: colors.muted }]}>{label}</Text>
      {typeof children === 'string' ? (
        <Text style={[styles.infoValue, { color: colors.text }]}>{children}</Text>
      ) : (
        children
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  headerButton: { padding: 8 },
  profile: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 16 },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#EDE9FE',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  avatarText: { fontSize: 28, fontWeight: '600', color: ACCENT },
  profileName: { fontSize: 22, fontWeight: '600', marginBottom: 4, textAlign: 'center' },
  profileSub: { fontSize: 15, textAlign: 'center' },
  quickActions: { flexDirection: 'row', gap: 12, marginTop: 20 },
  profileBadge: { marginTop: 8 },
  quickAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  quickActionText: { fontSize: 14, fontWeight: '500' },
  field: { marginBottom: 16 },
  fieldLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  fieldLabelText: { fontSize: 13, fontWeight: '500' },
  fieldValue: { fontSize: 15, paddingVertical: 4 },
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
  sectionTitle: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  linkText: { flex: 1 },
  linkTitle: { fontSize: 15, fontWeight: '500' },
  linkSub: { fontSize: 12, marginTop: 2 },
  badge: { backgroundColor: '#EDE9FE', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  badgeText: { fontSize: 11, fontWeight: '600', color: ACCENT },
  trailing: { fontSize: 14, fontWeight: '600' },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  infoLabel: { fontSize: 14 },
  infoValue: { fontSize: 14, fontWeight: '500' },
});
