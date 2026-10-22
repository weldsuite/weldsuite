/**
 * The workspace's custom fields on a record: read-only rows, and the inputs
 * for each field type while editing.
 */

import React, { useState } from 'react';
import { StyleSheet, Switch, Text, TouchableOpacity, View, type KeyboardTypeOptions } from 'react-native';
import { Star } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { FormField } from '@/components/form';
import { MemberPicker } from '@/components/member-picker';
import { OptionSheet, SelectField } from '@/components/option-sheet';
import { RecordInfoRow } from '@/components/record';
import type { CustomFieldDefinition, CustomFieldValues, Member } from '@/services/api';
import { useI18n } from '@/lib/i18n';
import {
  READ_ONLY_FIELD_TYPES,
  TEXT_FIELD_TYPES,
  customInputToValue,
  customValueToInput,
  formatCustomValue,
} from '@/lib/custom-fields';

interface ViewProps {
  defs: readonly CustomFieldDefinition[];
  values: CustomFieldValues;
  memberName: (userId: string) => string | undefined;
}

export function CustomFieldsView({ defs, values, memberName }: Readonly<ViewProps>) {
  const { t, intlLocale } = useI18n();
  const options = { locale: intlLocale, yes: t.common.yes, no: t.common.no, memberName };
  return (
    <>
      {defs.map((def) => (
        <RecordInfoRow key={def.id} label={def.name}>
          {formatCustomValue(def, values[def.slug], options) || t.common.dash}
        </RecordInfoRow>
      ))}
    </>
  );
}

interface EditProps {
  defs: readonly CustomFieldDefinition[];
  values: CustomFieldValues;
  /** Text typed into text-like fields, keyed by slug, so half-typed input survives re-renders. */
  drafts: Record<string, string>;
  errors: Record<string, boolean>;
  members: readonly Member[];
  onValue: (slug: string, value: unknown) => void;
  onDraft: (slug: string, text: string) => void;
}

/** Initial drafts for the text-like fields of a record. */
export function customDrafts(defs: readonly CustomFieldDefinition[], values: CustomFieldValues): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const def of defs) {
    if (TEXT_FIELD_TYPES.has(def.fieldType)) drafts[def.slug] = customValueToInput(def, values[def.slug]);
  }
  return drafts;
}

/**
 * The drafts parsed back to values. Returns the slugs that don't parse (a
 * number field with letters, an impossible date) as errors.
 */
export function parseCustomDrafts(
  defs: readonly CustomFieldDefinition[],
  drafts: Record<string, string>,
): { values: CustomFieldValues; errors: Record<string, boolean> } {
  const values: CustomFieldValues = {};
  const errors: Record<string, boolean> = {};
  for (const def of defs) {
    if (!TEXT_FIELD_TYPES.has(def.fieldType)) continue;
    const parsed = customInputToValue(def, drafts[def.slug] ?? '');
    if (parsed === undefined) errors[def.slug] = true;
    else values[def.slug] = parsed;
  }
  return { values, errors };
}

const KEYBOARDS: Partial<Record<CustomFieldDefinition['fieldType'], KeyboardTypeOptions>> = {
  number: 'decimal-pad',
  currency: 'decimal-pad',
  email: 'email-address',
  phone: 'phone-pad',
  url: 'url',
};

/** The selection a select field's sheet starts with. */
function sheetSelection(def: CustomFieldDefinition, value: unknown): string | string[] | null {
  if (def.fieldType === 'multi_select') return Array.isArray(value) ? (value as string[]) : [];
  return typeof value === 'string' ? value : null;
}

interface FieldInputProps {
  def: CustomFieldDefinition;
  value: unknown;
  draft: string;
  invalid: boolean;
  formatOptions: Parameters<typeof formatCustomValue>[2];
  onValue: (slug: string, value: unknown) => void;
  onDraft: (slug: string, text: string) => void;
  onOpen: (slug: string) => void;
}

/** One custom field's input, chosen by its type. */
function CustomFieldInput({ def, value, draft, invalid, formatOptions, onValue, onDraft, onOpen }: Readonly<FieldInputProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();

  if (READ_ONLY_FIELD_TYPES.has(def.fieldType)) {
    return <RecordInfoRow label={def.name}>{formatCustomValue(def, value, formatOptions) || t.common.dash}</RecordInfoRow>;
  }
  if (TEXT_FIELD_TYPES.has(def.fieldType)) {
    return (
      <FormField
        label={def.name}
        required={def.required}
        value={draft}
        onChangeText={(text) => onDraft(def.slug, text)}
        placeholder={def.fieldType === 'date' ? t.tasks.dueDatePlaceholder : undefined}
        multiline={def.fieldType === 'textarea'}
        keyboardType={KEYBOARDS[def.fieldType] ?? 'default'}
        autoCapitalize={def.fieldType === 'email' || def.fieldType === 'url' ? 'none' : 'sentences'}
        error={invalid ? t.validation.invalidValue : null}
      />
    );
  }
  if (def.fieldType === 'boolean') {
    return (
      <View style={styles.switchRow}>
        <Text style={[styles.label, { color: colors.text }]}>{def.name}</Text>
        <Switch value={value === true || value === 'true'} onValueChange={(next) => onValue(def.slug, next)} accessibilityLabel={def.name} />
      </View>
    );
  }
  if (def.fieldType === 'rating') {
    const current = Number(value) || 0;
    return (
      <View style={styles.field}>
        <Text style={[styles.fieldLabel, { color: colors.muted }]}>{def.name}</Text>
        <View style={styles.stars}>
          {[1, 2, 3, 4, 5].map((n) => (
            <TouchableOpacity
              key={n}
              onPress={() => onValue(def.slug, current === n ? null : n)}
              accessibilityRole="button"
              accessibilityLabel={`${def.name} ${n}`}
            >
              <Star size={24} color="#F59E0B" fill={n <= current ? '#F59E0B' : 'none'} />
            </TouchableOpacity>
          ))}
        </View>
      </View>
    );
  }
  return (
    <SelectField
      label={def.name}
      required={def.required}
      value={formatCustomValue(def, value, formatOptions) || null}
      onPress={() => onOpen(def.slug)}
      onClear={() => onValue(def.slug, null)}
    />
  );
}

export function CustomFieldsEdit({ defs, values, drafts, errors, members, onValue, onDraft }: Readonly<EditProps>) {
  const { t, intlLocale } = useI18n();
  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const open = defs.find((def) => def.slug === openSlug);
  const formatOptions = {
    locale: intlLocale,
    yes: t.common.yes,
    no: t.common.no,
    memberName: (id: string) => members.find((m) => m.userId === id)?.name,
  };

  const selectOption = (def: CustomFieldDefinition, selected: string | null) => {
    if (def.fieldType !== 'multi_select') {
      onValue(def.slug, selected);
      setOpenSlug(null);
      return;
    }
    if (!selected) return;
    const current = sheetSelection(def, values[def.slug]) as string[];
    onValue(def.slug, current.includes(selected) ? current.filter((v) => v !== selected) : [...current, selected]);
  };

  const isSelect = open?.fieldType === 'single_select' || open?.fieldType === 'multi_select';

  return (
    <>
      {defs.map((def) => (
        <CustomFieldInput
          key={def.id}
          def={def}
          value={values[def.slug]}
          draft={drafts[def.slug] ?? ''}
          invalid={!!errors[def.slug]}
          formatOptions={formatOptions}
          onValue={onValue}
          onDraft={onDraft}
          onOpen={setOpenSlug}
        />
      ))}

      {open && isSelect && (
        <OptionSheet<string>
          visible
          title={open.name}
          options={open.options.map((option) => ({ value: option.value, label: option.label, color: option.color }))}
          selected={sheetSelection(open, values[open.slug])}
          onSelect={(selected) => selectOption(open, selected)}
          onClose={() => setOpenSlug(null)}
        />
      )}
      {open?.fieldType === 'user_ref' && (
        <MemberPicker
          visible
          title={open.name}
          members={members}
          selected={values[open.slug] ? [String(values[open.slug])] : []}
          allowNone
          onChange={(ids) => onValue(open.slug, ids[0] ?? null)}
          onClose={() => setOpenSlug(null)}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: 16 },
  fieldLabel: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  label: { fontSize: 15, flex: 1 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  stars: { flexDirection: 'row', gap: 8 },
});
