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
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useObserve } from 'expo-observe';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { MoreHorizontal } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { parseCustomDrafts } from '@/components/custom-fields';
import { StackHeader } from '@/components/headers';
import { MemberPicker, useMembers } from '@/components/member-picker';
import { OptionSheet, ScrollTabs, type SheetOption, type TabItem } from '@/components/option-sheet';
import { RecordHeaderActions, RecordProfileHeader } from '@/components/record';
import {
  RecordDetailsEdit,
  RecordDetailsView,
  formFromRecord,
  recordInput,
  textOf,
  validateRecordForm,
  type AnyRecord,
  type DetailsPicker,
  type FormErrorMap,
  type RecordForm,
  type RecordLabels,
} from '@/components/record-details';
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
  type CompanyInput,
  type CustomFieldDefinition,
  type Member,
  type PersonInput,
  type StatusOption,
} from '@/services/api';
import type { RecordKind, RecordRef } from '@/services/notes';
import { hideAppSplash } from '@/utils/splash';
import { interpolate, labelFor, useI18n } from '@/lib/i18n';
import { BUILT_IN_STATUSES, LIFECYCLE_STAGES, languageOptions, toHexColor } from '@/lib/field-options';

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

type Picker = DetailsPicker | 'actions' | null;
type RecordAction = 'edit' | 'log' | 'archive' | 'delete';

/**
 * The record and what its screen needs alongside it (custom field
 * definitions, statuses, currency, a person's primary company), loaded on
 * mount and quietly again when the screen regains focus.
 */
function useRecordData(kind: RecordKind, id: string, onLoadFailed: () => void) {
  const [record, setRecord] = useState<AnyRecord | null>(null);
  const [primaryCompany, setPrimaryCompany] = useState<string | undefined>();
  // null while unknown: then the form must not send customFields (it would wipe them).
  const [defs, setDefs] = useState<CustomFieldDefinition[] | null>(null);
  const [statuses, setStatuses] = useState<StatusOption[]>([]);
  const [currency, setCurrency] = useState('EUR');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const loadedOnce = useRef(false);
  const failedRef = useRef(onLoadFailed);
  failedRef.current = onLoadFailed;

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
      setDefs(defsRes.success && defsRes.data ? defsRes.data : null);
      if (recordRes.success && recordRes.data) setRecord(recordRes.data);
      else if (!silent) failedRef.current();
      if (kind === 'person') {
        const companiesRes = await api.getPersonCompanies(id);
        const companies = companiesRes.success && companiesRes.data ? companiesRes.data : [];
        setPrimaryCompany((companies.find((c) => c.isPrimary) ?? companies[0])?.name);
      }
      loadedOnce.current = true;
      setLoading(false);
    },
    [kind, id],
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

  return { record, setRecord, primaryCompany, defs, statuses, currency, loading, refreshKey };
}

function RecordPanel({
  tab,
  record,
  refreshKey,
  currency,
  email,
  phone,
}: Readonly<{ tab: TabKey; record: RecordRef; refreshKey: number; currency: string; email: string; phone: string }>) {
  switch (tab) {
    case 'activity':
      return <ActivityPanel record={record} refreshKey={refreshKey} />;
    case 'links':
      return <LinksPanel record={record} refreshKey={refreshKey} />;
    case 'deals':
      return <DealsPanel record={record} refreshKey={refreshKey} currency={currency} />;
    case 'notes':
      return <NotesPanel record={record} refreshKey={refreshKey} />;
    case 'tasks':
      return <TasksPanel record={record} refreshKey={refreshKey} />;
    case 'emails':
      return <EmailsPanel email={email || undefined} refreshKey={refreshKey} />;
    case 'calls':
      return <CallsPanel record={record} refreshKey={refreshKey} phone={phone || undefined} />;
    case 'meetings':
      return <MeetingsPanel record={record} refreshKey={refreshKey} />;
    case 'files':
      return <FilesPanel record={record} refreshKey={refreshKey} />;
    case 'audit':
      return <AuditPanel record={record} refreshKey={refreshKey} />;
    case 'chat':
      return <ChatPanel record={record} refreshKey={refreshKey} />;
    default:
      return null;
  }
}

/** Status options (built-in plus the workspace's own) and the display labels the views share. */
function useRecordLabels(statuses: readonly StatusOption[], byId: ReadonlyMap<string, Member>) {
  const { t } = useI18n();
  const statusOptions = useMemo<SheetOption[]>(() => {
    const builtIn = BUILT_IN_STATUSES.map((s) => ({ value: s.value, label: labelFor(t.status, s.value), color: s.color }));
    const custom = statuses
      .filter((s) => !builtIn.some((b) => b.value === s.value))
      .map((s) => ({ value: s.value, label: s.label, color: toHexColor(s.color) }));
    return [...builtIn, ...custom];
  }, [statuses, t.status]);

  const labels: RecordLabels = {
    status: (value) => (value ? (statusOptions.find((s) => s.value === value)?.label ?? labelFor(t.status, value)) : ''),
    lifecycle: (value) => (value ? ((t.records.lifecycle as Record<string, string>)[value] ?? value) : ''),
    member: (userId) => (userId ? (byId.get(userId)?.name ?? t.common.unknown) : ''),
  };
  return { statusOptions, labels };
}

/** The header and a spinner (or the failure) while the record isn't there yet. */
function RecordLoading({ title, loading, failedText }: Readonly<{ title: string; loading: boolean; failedText: string }>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader title={title} onBack={() => router.back()} />
      <View style={styles.center}>
        {loading ? (
          <ActivityIndicator size="large" color={colors.text} />
        ) : (
          <Text style={[styles.empty, { color: colors.muted }]}>{failedText}</Text>
        )}
      </View>
    </View>
  );
}

function subtitleOf(kind: RecordKind, record: AnyRecord, primaryCompany?: string): string {
  if (kind === 'company') return textOf(record, 'industry');
  return [textOf(record, 'jobTitle'), primaryCompany].filter(Boolean).join(' · ');
}

interface PickersProps {
  kind: RecordKind;
  picker: Picker;
  form: RecordForm;
  members: readonly Member[];
  statusOptions: readonly SheetOption[];
  labels: RecordLabels;
  title: string;
  archived: boolean;
  onField: <K extends keyof RecordForm>(key: K, value: RecordForm[K]) => void;
  onAction: (action: RecordAction | null) => void;
  onClose: () => void;
}

/** The sheets the Details form and the Actions button open. */
function RecordPickers({ kind, picker, form, members, statusOptions, labels, title, archived, onField, onAction, onClose }: Readonly<PickersProps>) {
  const { colors } = useTheme();
  const { t, language } = useI18n();
  const pick = <K extends keyof RecordForm>(key: K) => (value: RecordForm[K]) => {
    onField(key, value);
    onClose();
  };
  return (
    <>
      <MemberPicker
        visible={picker === 'owner'}
        title={t.records.owner}
        members={members}
        selected={form.ownerId ? [form.ownerId] : []}
        onChange={(ids) => onField('ownerId', ids[0] ?? null)}
        onClose={onClose}
      />
      <MemberPicker
        visible={picker === 'manager'}
        title={t.records.manager}
        members={members}
        selected={form.accountManagerId ? [form.accountManagerId] : []}
        allowNone
        onChange={(ids) => onField('accountManagerId', ids[0] ?? null)}
        onClose={onClose}
      />
      <OptionSheet<string>
        visible={picker === 'status'}
        title={(kind === 'company' ? t.company : t.person).status}
        options={statusOptions}
        selected={form.status || null}
        onSelect={(value) => pick('status')(value ?? '')}
        onClose={onClose}
      />
      <OptionSheet<string>
        visible={picker === 'lifecycle'}
        title={t.records.lifecycleStage}
        options={LIFECYCLE_STAGES.map((stage) => ({ value: stage, label: labels.lifecycle(stage) }))}
        selected={form.lifecycleStage}
        allowNone
        onSelect={pick('lifecycleStage')}
        onClose={onClose}
      />
      <OptionSheet<string>
        visible={picker === 'language'}
        title={t.records.language}
        options={languageOptions(language)}
        selected={form.language || null}
        allowNone
        onSelect={(value) => pick('language')(value ?? '')}
        onClose={onClose}
      />
      <OptionSheet<RecordAction>
        visible={picker === 'actions'}
        title={title}
        options={[
          { value: 'edit', label: t.common.edit },
          { value: 'log', label: t.activity.title },
          { value: 'archive', label: archived ? t.records.unarchive : t.records.archive },
          { value: 'delete', label: t.common.delete, color: colors.destructive },
        ]}
        onSelect={onAction}
        onClose={onClose}
      />
    </>
  );
}

interface BodyProps {
  kind: RecordKind;
  record: AnyRecord;
  form: RecordForm;
  isEditing: boolean;
  activeTab: TabKey;
  errors: FormErrorMap;
  customErrors: Record<string, boolean>;
  defs: CustomFieldDefinition[] | null;
  members: readonly Member[];
  byId: ReadonlyMap<string, Member>;
  labels: RecordLabels;
  statusOptions: readonly SheetOption[];
  refreshKey: number;
  currency: string;
  onChange: (form: RecordForm) => void;
  onOpenPicker: (picker: DetailsPicker) => void;
}

/** What sits under the tabs: the edit form, the details, or the open tab's panel. */
function RecordBody(props: Readonly<BodyProps>) {
  const { kind, record, isEditing, activeTab, defs, labels } = props;
  if (isEditing) {
    return (
      <RecordDetailsEdit
        kind={kind}
        form={props.form}
        errors={props.errors}
        customErrors={props.customErrors}
        defs={defs}
        members={props.members}
        labels={labels}
        statusOptions={props.statusOptions}
        onChange={props.onChange}
        onOpenPicker={props.onOpenPicker}
      />
    );
  }
  if (activeTab === 'details') {
    return (
      <RecordDetailsView kind={kind} record={record} defs={defs} labels={labels} memberName={(userId) => props.byId.get(userId)?.name} />
    );
  }
  return (
    <RecordPanel
      tab={activeTab}
      record={{ kind, id: record.id, name: record.name }}
      refreshKey={props.refreshKey}
      currency={props.currency}
      email={record.email}
      phone={textOf(record, 'phone') || textOf(record, 'mobile')}
    />
  );
}

export function RecordScreen({ kind }: Readonly<{ kind: RecordKind }>) {
  const { markInteractive } = useObserve();
  const { id, name, edit, tab } = useLocalSearchParams<{ id: string; name?: string; edit?: string; tab?: TabKey }>();
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const { members, byId } = useMembers();
  const copy = kind === 'company' ? t.company : t.person;

  const data = useRecordData(kind, id, () => toast.error(copy.loadFailed));
  const { record, setRecord, defs } = data;

  const [saving, setSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(edit === 'true');
  const [form, setForm] = useState<RecordForm | null>(null);
  const [errors, setErrors] = useState<FormErrorMap>({});
  const [customErrors, setCustomErrors] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<TabKey>(tab ?? 'details');
  const [picker, setPicker] = useState<Picker>(null);

  // A fresh form whenever the record (re)loads, unless a half-filled one is open.
  // Opening with ?edit=true still needs the first one.
  useEffect(() => {
    if (record && (!isEditing || form === null)) setForm(formFromRecord(kind, record, defs ?? []));
  }, [record, defs, kind, isEditing, form]);

  useEffect(() => {
    if (!data.loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [data.loading, markInteractive]);

  const displayName = record?.name || name || copy.title;
  const { statusOptions, labels } = useRecordLabels(data.statuses, byId);

  const startEdit = () => {
    if (record) setForm(formFromRecord(kind, record, defs ?? []));
    setErrors({});
    setCustomErrors({});
    setActiveTab('details');
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setErrors({});
    setCustomErrors({});
    setIsEditing(false);
  };

  const handleSave = async () => {
    if (!form || !record) return;
    const found = validateRecordForm(kind, form);
    const parsedCustom = defs ? parseCustomDrafts(defs, form.customDrafts) : { values: {}, errors: {} };
    setErrors(found);
    setCustomErrors(parsedCustom.errors);
    if (Object.keys(found).length > 0 || Object.keys(parsedCustom.errors).length > 0) return;

    const input = recordInput(kind, form, record, defs, parsedCustom.values);
    setSaving(true);
    const res =
      kind === 'company' ? await api.updateCompany(id, input as CompanyInput) : await api.updatePerson(id, input as PersonInput);
    setSaving(false);
    if (res.success && res.data) {
      setRecord(res.data);
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

  const remove = async () => {
    const res = kind === 'company' ? await api.deleteCompany(id) : await api.deletePerson(id);
    if (res.success) {
      toast.success(copy.deletedToast);
      router.back();
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.contacts.deleteFailed);
    }
  };

  const handleDelete = () => {
    Alert.alert(copy.deleteTitle, interpolate(copy.deleteMessage, { name: displayName }), [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.common.delete, style: 'destructive', onPress: () => void remove() },
    ]);
  };

  const runAction = (action: RecordAction | null) => {
    setPicker(null);
    if (action === 'edit') startEdit();
    if (action === 'log') {
      router.push({ pathname: '/activity/new', params: { recordKind: kind, recordId: id, recordName: displayName } });
    }
    if (action === 'archive') void toggleArchive();
    if (action === 'delete') handleDelete();
  };

  const setFormField = <K extends keyof RecordForm>(key: K, value: RecordForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  if (data.loading || !record || !form) {
    return <RecordLoading title={displayName} loading={data.loading} failedText={copy.loadFailed} />;
  }

  const phone = textOf(record, 'phone') || textOf(record, 'mobile');
  const email = record.email;

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

  const headerRight = isEditing ? (
    <RecordHeaderActions
      isEditing
      saving={saving}
      onCancel={cancelEdit}
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
  );

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader
        title={isEditing ? copy.editTitle : displayName}
        onBack={() => (isEditing ? cancelEdit() : router.back())}
        right={headerRight}
      />

      <ScrollView
        style={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={isEditing ? undefined : [1]}
      >
        <RecordProfileHeader
          name={displayName}
          subtitle={subtitleOf(kind, record, data.primaryCompany)}
          isEditing={isEditing}
          badge={record.archivedAt ? t.records.archived : undefined}
          onCall={phone ? () => void Linking.openURL(`tel:${phone}`) : undefined}
          onEmail={email ? () => void Linking.openURL(`mailto:${email}`) : undefined}
        />
        {isEditing ? <View /> : <ScrollTabs tabs={tabs} active={activeTab} onChange={setActiveTab} />}
        <View style={styles.panel}>
          <RecordBody
            kind={kind}
            record={record}
            form={form}
            isEditing={isEditing}
            activeTab={activeTab}
            errors={errors}
            customErrors={customErrors}
            defs={defs}
            members={members}
            byId={byId}
            labels={labels}
            statusOptions={statusOptions}
            refreshKey={data.refreshKey}
            currency={data.currency}
            onChange={setForm}
            onOpenPicker={setPicker}
          />
        </View>
        <View style={styles.bottomSpace} />
      </ScrollView>

      <RecordPickers
        kind={kind}
        picker={picker}
        form={form}
        members={members}
        statusOptions={statusOptions}
        labels={labels}
        title={displayName}
        archived={!!record.archivedAt}
        onField={setFormField}
        onAction={runAction}
        onClose={() => setPicker(null)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1 },
  panel: { paddingHorizontal: 16, paddingTop: 12 },
  empty: { fontSize: 14 },
  headerButton: { padding: 8 },
  bottomSpace: { height: 40 },
});
