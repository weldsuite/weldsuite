/**
 * The Details tab of a company or person: the form model, its validation and
 * save payload, and the read-only and edit views. Used by `record-screen.tsx`.
 */

import React from 'react';
import { Linking, StyleSheet, Switch, Text, TouchableOpacity, View, type KeyboardTypeOptions } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { CustomFieldsEdit, CustomFieldsView, customDrafts } from '@/components/custom-fields';
import { FormField } from '@/components/form';
import { SelectField, TagInput, type SheetOption } from '@/components/option-sheet';
import { RecordInfoRow, RecordSectionTitle } from '@/components/record';
import {
  formatAddress,
  type Address,
  type CompanyInput,
  type CompanyRecord,
  type CustomFieldDefinition,
  type CustomFieldValues,
  type Member,
  type PersonInput,
  type PersonRecord,
} from '@/services/api';
import type { RecordKind } from '@/services/notes';
import { useI18n, type Translations } from '@/lib/i18n';
import { mergeCustomValues } from '@/lib/custom-fields';
import { languageName } from '@/lib/field-options';
import {
  checkEmployeeCount,
  checkOptionalEmail,
  checkWebsite,
  describeError,
  isBlank,
  type FieldError,
} from '@/lib/validation';

export type AnyRecord = CompanyRecord | PersonRecord;

export type TextKey =
  | 'name'
  | 'firstName'
  | 'lastName'
  | 'jobTitle'
  | 'department'
  | 'website'
  | 'linkedinUrl'
  | 'email'
  | 'phone'
  | 'mobile'
  | 'industry'
  | 'vatNumber'
  | 'registrationNumber'
  | 'employeeCount'
  | 'description'
  | 'notes';

const COMPANY_TEXT: readonly TextKey[] = [
  'name',
  'website',
  'email',
  'phone',
  'mobile',
  'industry',
  'vatNumber',
  'registrationNumber',
  'employeeCount',
  'description',
];
const PERSON_TEXT: readonly TextKey[] = [
  'firstName',
  'lastName',
  'jobTitle',
  'department',
  'email',
  'phone',
  'mobile',
  'linkedinUrl',
  'notes',
];
const ADDRESS_KEYS = ['line1', 'line2', 'postalCode', 'city', 'state', 'country'] as const;

export interface RecordForm {
  text: Partial<Record<TextKey, string>>;
  ownerId: string | null;
  accountManagerId: string | null;
  status: string;
  lifecycleStage: string | null;
  language: string;
  tags: string[];
  address: Address;
  isLead: boolean;
  isSupplier: boolean;
  customValues: CustomFieldValues;
  customDrafts: Record<string, string>;
}

export type FormErrorMap = Partial<Record<TextKey, FieldError>>;

/** A text field of the record ('' when empty). */
export function textOf(record: AnyRecord, key: TextKey): string {
  const value = (record as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

export function formFromRecord(kind: RecordKind, record: AnyRecord, defs: readonly CustomFieldDefinition[]): RecordForm {
  const keys = kind === 'company' ? COMPANY_TEXT : PERSON_TEXT;
  return {
    text: Object.fromEntries(keys.map((key) => [key, textOf(record, key)])),
    ownerId: record.ownerId ?? null,
    accountManagerId: record.accountManagerId ?? null,
    status: record.status ?? '',
    lifecycleStage: record.lifecycleStage ?? null,
    language: record.language ?? '',
    tags: record.tags,
    address: record.address ?? {},
    isLead: record.isLead,
    isSupplier: record.isSupplier,
    customValues: { ...record.customFields },
    customDrafts: customDrafts(defs, record.customFields),
  };
}

/** The same checks the API makes, so a save isn't refused for something we can see. */
export function validateRecordForm(kind: RecordKind, form: RecordForm): FormErrorMap {
  const checks: [TextKey, FieldError | null][] =
    kind === 'company'
      ? [
          ['name', isBlank(form.text.name) ? 'required' : null],
          ['website', checkWebsite(form.text.website)],
          ['employeeCount', checkEmployeeCount(form.text.employeeCount)],
        ]
      : [['firstName', isBlank(form.text.firstName) && isBlank(form.text.lastName) ? 'required' : null]];
  checks.push(['email', checkOptionalEmail(form.text.email)]);
  return Object.fromEntries(checks.filter(([, error]) => error !== null)) as FormErrorMap;
}

/** The address to send: the form's, `null` to clear a stored one, or nothing. */
function addressToSave(form: RecordForm, record: AnyRecord): Address | null | undefined {
  if (Object.values(form.address).some((value) => value?.trim())) return form.address;
  return record.address ? null : undefined;
}

/**
 * Everything the form edits, as the update payload. `customFields` is the
 * whole merged map (the API replaces the stored set), and only sent when the
 * definitions loaded, so a failed load can't wipe the values.
 */
export function recordInput(
  kind: RecordKind,
  form: RecordForm,
  record: AnyRecord,
  defs: readonly CustomFieldDefinition[] | null,
  parsedCustom: CustomFieldValues,
): CompanyInput | PersonInput {
  const text = (key: TextKey) => form.text[key] ?? '';
  const shared = {
    email: text('email'),
    phone: text('phone'),
    mobile: text('mobile'),
    status: form.status || undefined,
    lifecycleStage: form.lifecycleStage,
    ownerId: form.ownerId ?? undefined,
    accountManagerId: form.accountManagerId,
    tags: form.tags,
    language: form.language || undefined,
    address: addressToSave(form, record),
    isLead: form.isLead,
    isSupplier: form.isSupplier,
    customFields: defs ? mergeCustomValues(record.customFields, { ...form.customValues, ...parsedCustom }) : undefined,
  };
  if (kind === 'company') {
    return {
      ...shared,
      name: form.text.name,
      website: text('website'),
      industry: text('industry'),
      vatNumber: text('vatNumber'),
      registrationNumber: text('registrationNumber'),
      employeeCount: text('employeeCount'),
      description: text('description'),
    };
  }
  return {
    ...shared,
    firstName: text('firstName'),
    lastName: text('lastName'),
    jobTitle: text('jobTitle'),
    department: text('department'),
    linkedinUrl: text('linkedinUrl'),
    notes: text('notes'),
  };
}

function fieldLabels(t: Translations, kind: RecordKind): Record<TextKey, string> {
  const copy = kind === 'company' ? t.company : t.person;
  return {
    name: t.company.name,
    firstName: t.person.firstName,
    lastName: t.person.lastName,
    jobTitle: t.person.jobTitle,
    department: t.records.department,
    website: t.company.website,
    linkedinUrl: t.records.linkedin,
    email: copy.email,
    phone: copy.phone,
    mobile: t.person.mobile,
    industry: t.company.industry,
    vatNumber: t.records.vatNumber,
    registrationNumber: t.records.registrationNumber,
    employeeCount: t.records.employees,
    description: t.company.description,
    notes: t.person.notes,
  };
}

const websiteUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

/** Display helpers the view and the screen share. */
export interface RecordLabels {
  status: (value?: string) => string;
  lifecycle: (value?: string | null) => string;
  member: (userId?: string | null) => string;
}

// ---------------------------------------------------------------------------
// Read-only
// ---------------------------------------------------------------------------

interface ViewProps {
  kind: RecordKind;
  record: AnyRecord;
  defs: readonly CustomFieldDefinition[] | null;
  labels: RecordLabels;
  memberName: (userId: string) => string | undefined;
}

export function RecordDetailsView({ kind, record, defs, labels, memberName }: Readonly<ViewProps>) {
  const { colors } = useTheme();
  const { t, intlLocale, language } = useI18n();
  const copy = kind === 'company' ? t.company : t.person;
  const field = fieldLabels(t, kind);

  const info = (label: string, value: string | undefined, onPress?: () => void) => {
    let content: React.ReactNode = value || t.common.dash;
    if (value && onPress) {
      content = (
        <TouchableOpacity onPress={onPress} accessibilityRole="link" style={styles.linkValue}>
          <Text style={styles.linkText} numberOfLines={1}>
            {value}
          </Text>
        </TouchableOpacity>
      );
    }
    return (
      <RecordInfoRow key={label} label={label}>
        {content}
      </RecordInfoRow>
    );
  };
  const open = (url: string) => () => void Linking.openURL(url);
  const about = kind === 'company' ? textOf(record, 'description') : textOf(record, 'notes');
  const flags = [record.isLead ? t.records.isLead : '', record.isSupplier ? t.records.isSupplier : ''].filter(Boolean);

  return (
    <View>
      <RecordSectionTitle>{t.records.contact}</RecordSectionTitle>
      {info(field.email, record.email, open(`mailto:${record.email}`))}
      {info(field.phone, textOf(record, 'phone'), open(`tel:${textOf(record, 'phone')}`))}
      {info(field.mobile, textOf(record, 'mobile'), open(`tel:${textOf(record, 'mobile')}`))}
      {kind === 'company'
        ? info(field.website, textOf(record, 'website'), open(websiteUrl(textOf(record, 'website'))))
        : info(field.linkedinUrl, textOf(record, 'linkedinUrl'), open(websiteUrl(textOf(record, 'linkedinUrl'))))}

      <View style={styles.gap} />
      <RecordSectionTitle>{t.records.details}</RecordSectionTitle>
      {kind === 'person' && info(field.jobTitle, textOf(record, 'jobTitle'))}
      {kind === 'person' && info(field.department, textOf(record, 'department'))}
      {kind === 'company' && info(field.industry, textOf(record, 'industry'))}
      {info(t.records.owner, labels.member(record.ownerId))}
      {info(t.records.manager, labels.member(record.accountManagerId))}
      {info(copy.status, labels.status(record.status))}
      {info(t.records.lifecycleStage, labels.lifecycle(record.lifecycleStage))}
      {info(t.records.language, languageName(record.language, language))}
      {info(t.records.tags, record.tags.join(', '))}
      {kind === 'company' && info(field.vatNumber, textOf(record, 'vatNumber'))}
      {kind === 'company' && info(field.registrationNumber, textOf(record, 'registrationNumber'))}
      {kind === 'company' && info(field.employeeCount, textOf(record, 'employeeCount'))}
      {info(t.records.flags, flags.join(', '))}
      {info(t.records.address, formatAddress(record.address))}

      {!!about && (
        <>
          <View style={styles.gap} />
          <RecordSectionTitle>{kind === 'company' ? field.description : field.notes}</RecordSectionTitle>
          <Text style={[styles.longText, { color: colors.text }]}>{about}</Text>
        </>
      )}

      {!!defs && defs.length > 0 && (
        <>
          <View style={styles.gap} />
          <RecordSectionTitle>{t.records.customFields}</RecordSectionTitle>
          <CustomFieldsView defs={defs} values={record.customFields} memberName={memberName} />
        </>
      )}

      <View style={styles.gap} />
      {info(copy.created, new Date(record.createdAt).toLocaleDateString(intlLocale))}
      {info(copy.lastUpdated, new Date(record.updatedAt).toLocaleDateString(intlLocale))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

export type DetailsPicker = 'owner' | 'manager' | 'status' | 'lifecycle' | 'language';

interface EditProps {
  kind: RecordKind;
  form: RecordForm;
  errors: FormErrorMap;
  customErrors: Record<string, boolean>;
  defs: readonly CustomFieldDefinition[] | null;
  members: readonly Member[];
  labels: RecordLabels;
  statusOptions: readonly SheetOption[];
  onChange: (form: RecordForm) => void;
  onOpenPicker: (picker: DetailsPicker) => void;
}

interface TextOptions {
  required?: boolean;
  multiline?: boolean;
  keyboard?: KeyboardTypeOptions;
}

const COMPANY_FIELDS: [TextKey, TextOptions][] = [
  ['name', { required: true }],
  ['website', { keyboard: 'url' }],
  ['email', { keyboard: 'email-address' }],
  ['phone', { keyboard: 'phone-pad' }],
  ['mobile', { keyboard: 'phone-pad' }],
  ['industry', {}],
];
const PERSON_FIELDS: [TextKey, TextOptions][] = [
  ['firstName', { required: true }],
  ['lastName', {}],
  ['jobTitle', {}],
  ['department', {}],
  ['email', { keyboard: 'email-address' }],
  ['phone', { keyboard: 'phone-pad' }],
  ['mobile', { keyboard: 'phone-pad' }],
  ['linkedinUrl', { keyboard: 'url' }],
];
const COMPANY_REGISTRATION: [TextKey, TextOptions][] = [
  ['vatNumber', {}],
  ['registrationNumber', {}],
  ['employeeCount', { keyboard: 'number-pad' }],
];

export function RecordDetailsEdit({
  kind,
  form,
  errors,
  customErrors,
  defs,
  members,
  labels,
  statusOptions,
  onChange,
  onOpenPicker,
}: Readonly<EditProps>) {
  const { colors } = useTheme();
  const { t, language } = useI18n();
  const copy = kind === 'company' ? t.company : t.person;
  const field = fieldLabels(t, kind);
  const set = <K extends keyof RecordForm>(key: K, value: RecordForm[K]) => onChange({ ...form, [key]: value });

  const textField = ([key, options]: [TextKey, TextOptions]) => {
    const error = errors[key];
    const plain = !options.keyboard || options.keyboard === 'number-pad';
    return (
      <FormField
        key={key}
        label={field[key]}
        required={options.required}
        value={form.text[key] ?? ''}
        onChangeText={(value) => set('text', { ...form.text, [key]: value })}
        error={error ? describeError(t, error, field[key]) : null}
        multiline={options.multiline}
        numberOfLines={options.multiline ? 4 : undefined}
        keyboardType={options.keyboard}
        autoCapitalize={plain ? 'sentences' : 'none'}
        autoCorrect={plain}
      />
    );
  };
  const toggle = (label: string, value: boolean, key: 'isLead' | 'isSupplier') => (
    <View style={styles.switchRow}>
      <Text style={[styles.switchLabel, { color: colors.text }]}>{label}</Text>
      <Switch value={value} onValueChange={(next) => set(key, next)} accessibilityLabel={label} />
    </View>
  );

  return (
    <View>
      {(kind === 'company' ? COMPANY_FIELDS : PERSON_FIELDS).map(textField)}
      <SelectField label={t.records.owner} value={labels.member(form.ownerId)} onPress={() => onOpenPicker('owner')} />
      <SelectField
        label={t.records.manager}
        value={labels.member(form.accountManagerId)}
        onPress={() => onOpenPicker('manager')}
        onClear={() => set('accountManagerId', null)}
      />
      <SelectField
        label={copy.status}
        value={labels.status(form.status)}
        color={statusOptions.find((s) => s.value === form.status)?.color}
        onPress={() => onOpenPicker('status')}
      />
      <SelectField
        label={t.records.lifecycleStage}
        value={labels.lifecycle(form.lifecycleStage)}
        onPress={() => onOpenPicker('lifecycle')}
        onClear={() => set('lifecycleStage', null)}
      />
      <SelectField
        label={t.records.language}
        value={languageName(form.language, language)}
        onPress={() => onOpenPicker('language')}
        onClear={() => set('language', '')}
      />
      <TagInput label={t.records.tags} value={form.tags} placeholder={t.records.tagsPlaceholder} onChange={(tags) => set('tags', tags)} />
      {kind === 'company' && COMPANY_REGISTRATION.map(textField)}
      {toggle(t.records.isLead, form.isLead, 'isLead')}
      {toggle(t.records.isSupplier, form.isSupplier, 'isSupplier')}

      <RecordSectionTitle>{t.records.address}</RecordSectionTitle>
      {ADDRESS_KEYS.map((key) => (
        <FormField
          key={key}
          label={t.records.addressFields[key]}
          value={form.address[key] ?? ''}
          onChangeText={(value) => set('address', { ...form.address, [key]: value })}
          autoCapitalize={key === 'postalCode' ? 'characters' : 'words'}
        />
      ))}

      {textField([kind === 'company' ? 'description' : 'notes', { multiline: true }])}

      {!!defs && defs.length > 0 && (
        <>
          <RecordSectionTitle>{t.records.customFields}</RecordSectionTitle>
          <CustomFieldsEdit
            defs={defs}
            values={form.customValues}
            drafts={form.customDrafts}
            errors={customErrors}
            members={members}
            onValue={(slug, value) => set('customValues', { ...form.customValues, [slug]: value })}
            onDraft={(slug, text) => set('customDrafts', { ...form.customDrafts, [slug]: text })}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { height: 20 },
  longText: { fontSize: 15, lineHeight: 22 },
  linkValue: { flexShrink: 1, marginLeft: 12 },
  linkText: { fontSize: 14, fontWeight: '500', color: '#7C3AED' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  switchLabel: { fontSize: 15 },
});
