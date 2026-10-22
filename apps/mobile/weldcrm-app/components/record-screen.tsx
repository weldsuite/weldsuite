/**
 * A company or a person, like the platform's record panel: the profile, every
 * Details field (view and edit), archive / delete, and the tabs below it.
 * `app/company/[id].tsx` and `app/person/[id].tsx` render this.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useObserve } from 'expo-observe';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { MoreHorizontal } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { CustomFieldsEdit, CustomFieldsView, customDrafts, parseCustomDrafts } from '@/components/custom-fields';
import { FormField } from '@/components/form';
import { StackHeader } from '@/components/headers';
import { MemberPicker, useMembers } from '@/components/member-picker';
import { OptionSheet, ScrollTabs, SelectField, TagInput, type TabItem } from '@/components/option-sheet';
import { RecordHeaderActions, RecordInfoRow, RecordProfileHeader, RecordSectionTitle } from '@/components/record';
import {
  ActivityPanel,
  AuditPanel,
  CallsPanel,
  ChatPanel,
  DealsPanel,
  EmailsPanel,
  FilesPanel,
  LinksPanel,
  MeetingsPanel,
  NotesPanel,
  TasksPanel,
} from '@/components/record-panels';
import {
  api,
  formatAddress,
  type Address,
  type CompanyInput,
  type CompanyRecord,
  type CustomFieldDefinition,
  type CustomFieldValues,
  type PersonInput,
  type PersonRecord,
  type StatusOption,
} from '@/services/api';
import type { RecordKind } from '@/services/notes';
import { hideAppSplash } from '@/utils/splash';
import { interpolate, labelFor, useI18n } from '@/lib/i18n';
import { mergeCustomValues } from '@/lib/custom-fields';
import { BUILT_IN_STATUSES, LIFECYCLE_STAGES, languageName, languageOptions, toHexColor } from '@/lib/field-options';
import {
  checkEmployeeCount,
  checkOptionalEmail,
  checkWebsite,
  describeError,
  isBlank,
  type FieldError,
} from '@/lib/validation';

type AnyRecord = CompanyRecord | PersonRecord;

type TabKey =
  | 'details'
  | 'activity'
  | 'links'
  | 'deals'
  | 'notes'
  | 'tasks'
  | 'emails'
  | 'calls'
  | 'meetings'
  | 'files'
  | 'audit'
  | 'chat';

type TextKey =
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

interface RecordForm {
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

function textOf(record: AnyRecord, key: TextKey): string {
  const value = (record as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function formFromRecord(kind: RecordKind, record: AnyRecord, defs: readonly CustomFieldDefinition[]): RecordForm {
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

type Picker = 'owner' | 'manager' | 'status' | 'lifecycle' | 'language' | 'actions' | null;

export function RecordScreen({ kind }: Readonly<{ kind: RecordKind }>) {
  const { markInteractive } = useObserve();
  const { id, name, edit, tab } = useLocalSearchParams<{ id: string; name?: string; edit?: string; tab?: TabKey }>();
  const { colors } = useTheme();
  const { t, intlLocale, language } = useI18n();
  const toast = useToast();
  const { members, byId } = useMembers();

  const [record, setRecord] = useState<AnyRecord | null>(null);
  const [primaryCompany, setPrimaryCompany] = useState<string | undefined>();
  const [defs, setDefs] = useState<CustomFieldDefinition[] | null>(null);
  const [statuses, setStatuses] = useState<StatusOption[]>([]);
  const [currency, setCurrency] = useState('EUR');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(edit === 'true');
  const [form, setForm] = useState<RecordForm | null>(null);
  const [errors, setErrors] = useState<Partial<Record<TextKey, FieldError>>>({});
  const [customErrors, setCustomErrors] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<TabKey>(tab ?? 'details');
  const [refreshKey, setRefreshKey] = useState(0);
  const [picker, setPicker] = useState<Picker>(null);
  const loadedOnce = useRef(false);
  // The latest editing flag for the focus refetch, which must not overwrite a half-filled form.
  const isEditingRef = useRef(isEditing);
  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  const copy = kind === 'company' ? t.company : t.person;

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      const [recordRes, defsRes, statusesRes, workspaceCurrency] = await Promise.all([
        kind === 'company' ? api.getCompany(id) : api.getPerson(id),
        api.getCustomFields(kind),
        api.getCustomerStatuses(),
        api.getWorkspaceCurrency(),
      ]);
      setCurrency(workspaceCurrency);
      if (statusesRes.success && statusesRes.data) setStatuses(statusesRes.data);
      // Without the definitions the form must not send customFields (it would wipe them).
      const loadedDefs = defsRes.success && defsRes.data ? defsRes.data : null;
      setDefs(loadedDefs);
      if (recordRes.success && recordRes.data) {
        const loaded = recordRes.data;
        setRecord(loaded);
        setForm((prev) => (prev && silent && isEditingRef.current ? prev : formFromRecord(kind, loaded, loadedDefs ?? [])));
      } else if (!silent) {
        toast.error(copy.loadFailed);
      }
      if (kind === 'person') {
        const companiesRes = await api.getPersonCompanies(id);
        if (companiesRes.success && companiesRes.data) {
          const primary = companiesRes.data.find((c) => c.isPrimary) ?? companiesRes.data[0];
          setPrimaryCompany(primary?.name);
        }
      }
      loadedOnce.current = true;
      setLoading(false);
    },
    [kind, id, copy.loadFailed, toast],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Coming back from a pushed screen (a note, a deal): refresh the record and the open tab.
  useFocusEffect(
    useCallback(() => {
      if (!loadedOnce.current) return;
      void load(true);
      setRefreshKey((key) => key + 1);
    }, [load]),
  );

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

  const displayName = record?.name || name || copy.title;
  const ref = useMemo(() => ({ kind, id, name: record?.name || name }), [kind, id, record?.name, name]);

  const statusOptions = useMemo(() => {
    const builtIn = BUILT_IN_STATUSES.map((s) => ({
      value: s.value,
      label: labelFor(t.status, s.value),
      color: s.color,
    }));
    const custom = statuses
      .filter((s) => !builtIn.some((b) => b.value === s.value))
      .map((s) => ({ value: s.value, label: s.label, color: toHexColor(s.color) }));
    return [...builtIn, ...custom];
  }, [statuses, t.status]);
  const statusLabel = (value?: string) =>
    value ? (statusOptions.find((s) => s.value === value)?.label ?? labelFor(t.status, value)) : '';
  const lifecycleLabel = (value?: string | null) =>
    value ? ((t.records.lifecycle as Record<string, string>)[value] ?? value) : '';
  const memberName = (userId?: string | null) => (userId ? (byId.get(userId)?.name ?? t.common.unknown) : '');

  const setText = (key: TextKey, value: string) =>
    setForm((prev) => (prev ? { ...prev, text: { ...prev.text, [key]: value } } : prev));
  const setField = <K extends keyof RecordForm>(key: K, value: RecordForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const startEdit = () => {
    if (record) setForm(formFromRecord(kind, record, defs ?? []));
    setErrors({});
    setCustomErrors({});
    setActiveTab('details');
    setIsEditing(true);
  };

  const handleCancel = () => {
    if (record) setForm(formFromRecord(kind, record, defs ?? []));
    setErrors({});
    setCustomErrors({});
    setIsEditing(false);
  };

  const validate = (current: RecordForm): Partial<Record<TextKey, FieldError>> => {
    const found: Partial<Record<TextKey, FieldError>> = {};
    const email = checkOptionalEmail(current.text.email);
    if (email) found.email = email;
    if (kind === 'company') {
      if (isBlank(current.text.name)) found.name = 'required';
      const website = checkWebsite(current.text.website);
      if (website) found.website = website;
      const employees = checkEmployeeCount(current.text.employeeCount);
      if (employees) found.employeeCount = employees;
    } else if (isBlank(current.text.firstName) && isBlank(current.text.lastName)) {
      found.firstName = 'required';
    }
    return found;
  };

  const handleSave = async () => {
    if (!form || !record) return;
    const found = validate(form);
    const parsedCustom = defs ? parseCustomDrafts(defs, form.customDrafts) : { values: {}, errors: {} };
    setErrors(found);
    setCustomErrors(parsedCustom.errors);
    if (Object.keys(found).length > 0 || Object.keys(parsedCustom.errors).length > 0) return;

    const shared = {
      email: form.text.email ?? '',
      phone: form.text.phone ?? '',
      mobile: form.text.mobile ?? '',
      status: form.status || undefined,
      lifecycleStage: form.lifecycleStage,
      ownerId: form.ownerId ?? undefined,
      accountManagerId: form.accountManagerId,
      tags: form.tags,
      language: form.language || undefined,
      address: Object.values(form.address).some((v) => v?.trim()) ? form.address : record.address ? null : undefined,
      isLead: form.isLead,
      isSupplier: form.isSupplier,
      // The whole map, merged: the API replaces the stored set with what it gets.
      customFields: defs
        ? mergeCustomValues(record.customFields, { ...form.customValues, ...parsedCustom.values })
        : undefined,
    };

    setSaving(true);
    const res =
      kind === 'company'
        ? await api.updateCompany(id, {
            ...shared,
            name: form.text.name,
            website: form.text.website ?? '',
            industry: form.text.industry ?? '',
            vatNumber: form.text.vatNumber ?? '',
            registrationNumber: form.text.registrationNumber ?? '',
            employeeCount: form.text.employeeCount ?? '',
            description: form.text.description ?? '',
          } satisfies CompanyInput)
        : await api.updatePerson(id, {
            ...shared,
            firstName: form.text.firstName ?? '',
            lastName: form.text.lastName ?? '',
            jobTitle: form.text.jobTitle ?? '',
            department: form.text.department ?? '',
            linkedinUrl: form.text.linkedinUrl ?? '',
            notes: form.text.notes ?? '',
          } satisfies PersonInput);
    setSaving(false);

    if (res.success && res.data) {
      setRecord(res.data);
      setForm(formFromRecord(kind, res.data, defs ?? []));
      setIsEditing(false);
      toast.success(copy.savedToast);
    } else {
      toast.error(typeof res.error === 'string' ? res.error : copy.saveFailed);
    }
  };

  const toggleArchive = async () => {
    if (!record) return;
    const archive = !record.archivedAt;
    const res = kind === 'company' ? await api.setCompanyArchived(id, archive) : await api.setPersonArchived(id, archive);
    if (res.success && res.data) {
      setRecord(res.data);
      toast.success(archive ? t.records.archivedToast : t.records.unarchivedToast);
    } else {
      toast.error(t.records.archiveFailed);
    }
  };

  const handleDelete = () => {
    Alert.alert(copy.deleteTitle, interpolate(copy.deleteMessage, { name: displayName }), [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const res = kind === 'company' ? await api.deleteCompany(id) : await api.deletePerson(id);
            if (res.success) {
              toast.success(copy.deletedToast);
              router.back();
            } else {
              toast.error(typeof res.error === 'string' ? res.error : t.contacts.deleteFailed);
            }
          })();
        },
      },
    ]);
  };

  const phone = record ? textOf(record, 'phone') || textOf(record, 'mobile') : '';
  const email = record?.email ?? '';

  if (loading || !record || !form) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StackHeader title={displayName} onBack={() => router.back()} />
        <View style={styles.center}>
          {loading ? (
            <ActivityIndicator size="large" color={colors.text} />
          ) : (
            <Text style={[styles.empty, { color: colors.muted }]}>{copy.loadFailed}</Text>
          )}
        </View>
      </View>
    );
  }

  const tabs: TabItem<TabKey>[] = [
    { key: 'details', label: t.records.tabs.details },
    { key: 'activity', label: t.records.tabs.activity },
    { key: 'links', label: kind === 'company' ? t.records.tabs.people : t.records.tabs.companies },
    { key: 'deals', label: t.records.tabs.deals },
    { key: 'notes', label: t.records.tabs.notes },
    { key: 'tasks', label: t.records.tabs.tasks },
    { key: 'emails', label: t.records.tabs.emails },
    { key: 'calls', label: t.records.tabs.calls },
    { key: 'meetings', label: t.records.tabs.meetings },
    { key: 'files', label: t.records.tabs.files },
    { key: 'audit', label: t.records.tabs.audit },
    { key: 'chat', label: t.records.tabs.chat },
  ];

  const message = (key: TextKey, label: string) => (errors[key] ? describeError(t, errors[key] as FieldError, label) : null);
  const labels: Record<TextKey, string> = {
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

  const textField = (key: TextKey, options: { required?: boolean; multiline?: boolean; keyboard?: 'email-address' | 'phone-pad' | 'url' | 'number-pad' } = {}) => (
    <FormField
      key={key}
      label={labels[key]}
      required={options.required}
      value={form.text[key] ?? ''}
      onChangeText={(value) => setText(key, value)}
      error={message(key, labels[key])}
      multiline={options.multiline}
      numberOfLines={options.multiline ? 4 : undefined}
      keyboardType={options.keyboard}
      autoCapitalize={options.keyboard && options.keyboard !== 'number-pad' ? 'none' : 'sentences'}
      autoCorrect={!options.keyboard}
    />
  );

  const editDetails = (
    <View style={styles.section}>
      {kind === 'company' ? (
        <>
          {textField('name', { required: true })}
          {textField('website', { keyboard: 'url' })}
          {textField('email', { keyboard: 'email-address' })}
          {textField('phone', { keyboard: 'phone-pad' })}
          {textField('mobile', { keyboard: 'phone-pad' })}
          {textField('industry')}
        </>
      ) : (
        <>
          {textField('firstName', { required: true })}
          {textField('lastName')}
          {textField('jobTitle')}
          {textField('department')}
          {textField('email', { keyboard: 'email-address' })}
          {textField('phone', { keyboard: 'phone-pad' })}
          {textField('mobile', { keyboard: 'phone-pad' })}
          {textField('linkedinUrl', { keyboard: 'url' })}
        </>
      )}
      <SelectField label={t.records.owner} value={memberName(form.ownerId)} onPress={() => setPicker('owner')} />
      <SelectField
        label={t.records.manager}
        value={memberName(form.accountManagerId)}
        onPress={() => setPicker('manager')}
        onClear={() => setField('accountManagerId', null)}
      />
      <SelectField
        label={copy.status}
        value={statusLabel(form.status)}
        color={statusOptions.find((s) => s.value === form.status)?.color}
        onPress={() => setPicker('status')}
      />
      <SelectField
        label={t.records.lifecycleStage}
        value={lifecycleLabel(form.lifecycleStage)}
        onPress={() => setPicker('lifecycle')}
        onClear={() => setField('lifecycleStage', null)}
      />
      <SelectField
        label={t.records.language}
        value={languageName(form.language, language)}
        onPress={() => setPicker('language')}
        onClear={() => setField('language', '')}
      />
      <TagInput label={t.records.tags} value={form.tags} placeholder={t.records.tagsPlaceholder} onChange={(tags) => setField('tags', tags)} />
      {kind === 'company' && (
        <>
          {textField('vatNumber')}
          {textField('registrationNumber')}
          {textField('employeeCount', { keyboard: 'number-pad' })}
        </>
      )}
      <View style={styles.switchRow}>
        <Text style={[styles.switchLabel, { color: colors.text }]}>{t.records.isLead}</Text>
        <Switch value={form.isLead} onValueChange={(v) => setField('isLead', v)} accessibilityLabel={t.records.isLead} />
      </View>
      <View style={styles.switchRow}>
        <Text style={[styles.switchLabel, { color: colors.text }]}>{t.records.isSupplier}</Text>
        <Switch value={form.isSupplier} onValueChange={(v) => setField('isSupplier', v)} accessibilityLabel={t.records.isSupplier} />
      </View>

      <RecordSectionTitle>{t.records.address}</RecordSectionTitle>
      {ADDRESS_KEYS.map((key) => (
        <FormField
          key={key}
          label={t.records.addressFields[key]}
          value={form.address[key] ?? ''}
          onChangeText={(value) => setField('address', { ...form.address, [key]: value })}
          autoCapitalize={key === 'postalCode' ? 'characters' : 'words'}
        />
      ))}

      {kind === 'company' ? textField('description', { multiline: true }) : textField('notes', { multiline: true })}

      {!!defs && defs.length > 0 && (
        <>
          <RecordSectionTitle>{t.records.customFields}</RecordSectionTitle>
          <CustomFieldsEdit
            defs={defs}
            values={form.customValues}
            drafts={form.customDrafts}
            errors={customErrors}
            members={members}
            onValue={(slug, value) => setField('customValues', { ...form.customValues, [slug]: value })}
            onDraft={(slug, text) => setField('customDrafts', { ...form.customDrafts, [slug]: text })}
          />
        </>
      )}
    </View>
  );

  const link = (value: string, onPress: () => void) => (
    <TouchableOpacity onPress={onPress} accessibilityRole="link" style={styles.linkValue}>
      <Text style={styles.linkText} numberOfLines={1}>
        {value}
      </Text>
    </TouchableOpacity>
  );
  const info = (label: string, value: string | undefined, onPress?: () => void) => (
    <RecordInfoRow key={label} label={label}>
      {value ? (onPress ? link(value, onPress) : value) : t.common.dash}
    </RecordInfoRow>
  );
  const websiteUrl = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

  const viewDetails = (
    <View style={styles.section}>
      <RecordSectionTitle>{t.records.contact}</RecordSectionTitle>
      {info(copy.email, email, email ? () => void Linking.openURL(`mailto:${email}`) : undefined)}
      {info(copy.phone, textOf(record, 'phone'), () => void Linking.openURL(`tel:${textOf(record, 'phone')}`))}
      {info(t.person.mobile, textOf(record, 'mobile'), () => void Linking.openURL(`tel:${textOf(record, 'mobile')}`))}
      {kind === 'company'
        ? info(t.company.website, textOf(record, 'website'), () => void Linking.openURL(websiteUrl(textOf(record, 'website'))))
        : info(t.records.linkedin, textOf(record, 'linkedinUrl'), () => void Linking.openURL(websiteUrl(textOf(record, 'linkedinUrl'))))}

      <View style={styles.gap} />
      <RecordSectionTitle>{t.records.details}</RecordSectionTitle>
      {kind === 'person' && info(t.person.jobTitle, textOf(record, 'jobTitle'))}
      {kind === 'person' && info(t.records.department, textOf(record, 'department'))}
      {kind === 'company' && info(t.company.industry, textOf(record, 'industry'))}
      {info(t.records.owner, memberName(record.ownerId))}
      {info(t.records.manager, memberName(record.accountManagerId))}
      {info(copy.status, statusLabel(record.status))}
      {info(t.records.lifecycleStage, lifecycleLabel(record.lifecycleStage))}
      {info(t.records.language, languageName(record.language, language))}
      {info(t.records.tags, record.tags.join(', '))}
      {kind === 'company' && info(t.records.vatNumber, textOf(record, 'vatNumber'))}
      {kind === 'company' && info(t.records.registrationNumber, textOf(record, 'registrationNumber'))}
      {kind === 'company' && info(t.records.employees, textOf(record, 'employeeCount'))}
      {info(t.records.flags, [record.isLead ? t.records.isLead : '', record.isSupplier ? t.records.isSupplier : ''].filter(Boolean).join(', '))}
      {info(t.records.address, formatAddress(record.address))}

      {!!(kind === 'company' ? textOf(record, 'description') : textOf(record, 'notes')) && (
        <>
          <View style={styles.gap} />
          <RecordSectionTitle>{kind === 'company' ? t.company.description : t.person.notes}</RecordSectionTitle>
          <Text style={[styles.longText, { color: colors.text }]}>
            {kind === 'company' ? textOf(record, 'description') : textOf(record, 'notes')}
          </Text>
        </>
      )}

      {!!defs && defs.length > 0 && (
        <>
          <View style={styles.gap} />
          <RecordSectionTitle>{t.records.customFields}</RecordSectionTitle>
          <CustomFieldsView defs={defs} values={record.customFields} memberName={(userId) => byId.get(userId)?.name} />
        </>
      )}

      <View style={styles.gap} />
      {info(copy.created, new Date(record.createdAt).toLocaleDateString(intlLocale))}
      {info(copy.lastUpdated, new Date(record.updatedAt).toLocaleDateString(intlLocale))}
    </View>
  );

  const panel = () => {
    switch (activeTab) {
      case 'activity':
        return <ActivityPanel record={ref} refreshKey={refreshKey} />;
      case 'links':
        return <LinksPanel record={ref} refreshKey={refreshKey} />;
      case 'deals':
        return <DealsPanel record={ref} refreshKey={refreshKey} currency={currency} />;
      case 'notes':
        return <NotesPanel record={ref} refreshKey={refreshKey} />;
      case 'tasks':
        return <TasksPanel record={ref} refreshKey={refreshKey} />;
      case 'emails':
        return <EmailsPanel email={email || undefined} refreshKey={refreshKey} />;
      case 'calls':
        return <CallsPanel record={ref} refreshKey={refreshKey} phone={phone || undefined} />;
      case 'meetings':
        return <MeetingsPanel record={ref} refreshKey={refreshKey} />;
      case 'files':
        return <FilesPanel record={ref} refreshKey={refreshKey} />;
      case 'audit':
        return <AuditPanel record={ref} refreshKey={refreshKey} />;
      case 'chat':
        return <ChatPanel record={ref} refreshKey={refreshKey} />;
      default:
        return isEditing ? editDetails : viewDetails;
    }
  };

  const subtitle =
    kind === 'company'
      ? textOf(record, 'industry')
      : [textOf(record, 'jobTitle'), primaryCompany].filter(Boolean).join(' · ');

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader
        title={isEditing ? copy.editTitle : displayName}
        onBack={() => (isEditing ? handleCancel() : router.back())}
        right={
          isEditing ? (
            <RecordHeaderActions
              isEditing
              saving={saving}
              onCancel={handleCancel}
              onSave={() => void handleSave()}
              onEdit={startEdit}
              onDelete={handleDelete}
            />
          ) : (
            <TouchableOpacity
              onPress={() => setPicker('actions')}
              style={styles.headerButton}
              accessibilityRole="button"
              accessibilityLabel={t.records.actions}
            >
              <MoreHorizontal size={22} color={colors.text} />
            </TouchableOpacity>
          )
        }
      />

      <ScrollView
        style={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={isEditing ? undefined : [1]}
      >
        <RecordProfileHeader
          name={displayName}
          subtitle={subtitle}
          isEditing={isEditing}
          badge={record.archivedAt ? t.records.archived : undefined}
          onCall={phone ? () => void Linking.openURL(`tel:${phone}`) : undefined}
          onEmail={email ? () => void Linking.openURL(`mailto:${email}`) : undefined}
        />
        {isEditing ? <View /> : <ScrollTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />}
        <View style={styles.panel}>{panel()}</View>
        <View style={{ height: 40 }} />
      </ScrollView>

      <MemberPicker
        visible={picker === 'owner'}
        title={t.records.owner}
        members={members}
        selected={form.ownerId ? [form.ownerId] : []}
        onChange={(ids) => setField('ownerId', ids[0] ?? null)}
        onClose={() => setPicker(null)}
      />
      <MemberPicker
        visible={picker === 'manager'}
        title={t.records.manager}
        members={members}
        selected={form.accountManagerId ? [form.accountManagerId] : []}
        allowNone
        onChange={(ids) => setField('accountManagerId', ids[0] ?? null)}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<string>
        visible={picker === 'status'}
        title={copy.status}
        options={statusOptions}
        selected={form.status || null}
        onSelect={(value) => {
          setField('status', value ?? '');
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<string>
        visible={picker === 'lifecycle'}
        title={t.records.lifecycleStage}
        options={LIFECYCLE_STAGES.map((stage) => ({ value: stage, label: lifecycleLabel(stage) }))}
        selected={form.lifecycleStage}
        allowNone
        onSelect={(value) => {
          setField('lifecycleStage', value);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<string>
        visible={picker === 'language'}
        title={t.records.language}
        options={languageOptions(language)}
        selected={form.language || null}
        allowNone
        onSelect={(value) => {
          setField('language', value ?? '');
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<'edit' | 'log' | 'archive' | 'delete'>
        visible={picker === 'actions'}
        title={displayName}
        options={[
          { value: 'edit', label: t.common.edit },
          { value: 'log', label: t.activity.title },
          { value: 'archive', label: record.archivedAt ? t.records.unarchive : t.records.archive },
          { value: 'delete', label: t.common.delete, color: colors.destructive },
        ]}
        onSelect={(action) => {
          setPicker(null);
          if (action === 'edit') startEdit();
          if (action === 'log')
            router.push({ pathname: '/activity/new', params: { recordKind: kind, recordId: id, recordName: record.name } });
          if (action === 'archive') void toggleArchive();
          if (action === 'delete') handleDelete();
        }}
        onClose={() => setPicker(null)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1 },
  section: { paddingVertical: 4 },
  panel: { paddingHorizontal: 16, paddingTop: 12 },
  empty: { fontSize: 14 },
  headerButton: { padding: 8 },
  gap: { height: 20 },
  longText: { fontSize: 15, lineHeight: 22 },
  linkValue: { flexShrink: 1, marginLeft: 12 },
  linkText: { fontSize: 14, fontWeight: '500', color: '#7C3AED' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  switchLabel: { fontSize: 15 },
});
