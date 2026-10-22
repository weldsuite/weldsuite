import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { MoreHorizontal } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { PersonPicker } from '@/components/company-picker';
import { CustomFieldsEdit, CustomFieldsView, customDrafts, parseCustomDrafts } from '@/components/custom-fields';
import { DueDateField } from '@/components/due-date-field';
import { FormField } from '@/components/form';
import { StackHeader } from '@/components/headers';
import { MemberPicker, useMembers } from '@/components/member-picker';
import { OptionSheet, ScrollTabs, SelectField, TagInput } from '@/components/option-sheet';
import { RecordHeaderActions, RecordInfoRow, RecordSectionTitle } from '@/components/record';
import { api, type CrmActivity, type CustomFieldDefinition, type CustomFieldValues, type DealRecord, type DealStatus, type PipelineWithStages } from '@/services/api';
import { interpolate, useI18n } from '@/lib/i18n';
import { mergeCustomValues } from '@/lib/custom-fields';
import { parseDate, parseDateInput, toDateInput } from '@/lib/dates';
import { DEAL_CURRENCIES, formatMoney, toNumber } from '@/lib/money';
import { htmlToText } from '@/lib/note-text';
import { checkOptionalAmount, checkRequired, describeError, parseAmountInput, type FieldError } from '@/lib/validation';

const CHANCE_OPTIONS = [0, 10, 25, 50, 75, 90, 100];
const STATUS_COLORS: Record<string, string> = { open: '#3B82F6', won: '#10B981', lost: '#EF4444', abandoned: '#9CA3AF' };

type Tab = 'details' | 'activity';
type Picker = 'stage' | 'currency' | 'owner' | 'contact' | 'chance' | 'actions' | null;

interface DealForm {
  name: string;
  amount: string;
  currency: string;
  stageId?: string;
  probability?: number;
  closeDate: string;
  ownerId?: string;
  contact?: { id: string; name: string };
  leadSource: string;
  type: string;
  nextStep: string;
  tags: string[];
  description: string;
  customValues: CustomFieldValues;
  customDrafts: Record<string, string>;
}

function formFromDeal(deal: DealRecord, contactName: string | undefined, defs: readonly CustomFieldDefinition[]): DealForm {
  return {
    name: deal.name,
    amount: deal.value ? String(toNumber(deal.value)) : '',
    currency: deal.currency ?? 'EUR',
    stageId: deal.stageId,
    probability: deal.probability,
    closeDate: toDateInput(parseDate(deal.expectedCloseDate)),
    ownerId: deal.ownerId,
    contact: deal.primaryContactId ? { id: deal.primaryContactId, name: contactName ?? '' } : undefined,
    leadSource: deal.leadSource ?? '',
    type: deal.type ?? '',
    nextStep: deal.nextStep ?? '',
    tags: deal.tags,
    description: deal.description ?? '',
    customValues: { ...deal.customFields },
    customDrafts: customDrafts(defs, deal.customFields),
  };
}

export default function DealScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const { members, byId } = useMembers();

  const [deal, setDeal] = useState<DealRecord | null>(null);
  const [pipeline, setPipeline] = useState<PipelineWithStages | null>(null);
  const [contactName, setContactName] = useState<string | undefined>();
  const [defs, setDefs] = useState<CustomFieldDefinition[] | null>(null);
  const [activities, setActivities] = useState<CrmActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<DealForm | null>(null);
  const [errors, setErrors] = useState<Partial<Record<'name' | 'amount' | 'closeDate', FieldError>>>({});
  const [customErrors, setCustomErrors] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<Tab>('details');
  const [picker, setPicker] = useState<Picker>(null);
  const loadedOnce = useRef(false);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      const [dealRes, pipelinesRes, defsRes, activitiesRes] = await Promise.all([
        api.getDeal(id),
        api.getPipelines(),
        api.getCustomFields('opportunity'),
        api.getActivities({ opportunityId: id, limit: 50 }),
      ]);
      const loadedDefs = defsRes.success && defsRes.data ? defsRes.data : null;
      setDefs(loadedDefs);
      if (activitiesRes.success && activitiesRes.data) setActivities(activitiesRes.data.items);
      if (dealRes.success && dealRes.data) {
        const loaded = dealRes.data;
        setDeal(loaded);
        const pipelines = pipelinesRes.success && pipelinesRes.data ? pipelinesRes.data : [];
        setPipeline(pipelines.find((p) => p.id === loaded.pipelineId) ?? pipelines.find((p) => p.stages.some((s) => s.id === loaded.stageId)) ?? null);
        let contact: string | undefined;
        if (loaded.primaryContactId) {
          const personRes = await api.getPerson(loaded.primaryContactId);
          contact = personRes.success && personRes.data ? personRes.data.name : undefined;
          setContactName(contact);
        }
        if (!silent) setForm(formFromDeal(loaded, contact, loadedDefs ?? []));
      } else if (!silent) {
        toast.error(t.deals.loadDealFailed);
      }
      loadedOnce.current = true;
      setLoading(false);
    },
    [id, t, toast],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      if (loadedOnce.current) void load(true);
    }, [load]),
  );

  const stage = pipeline?.stages.find((s) => s.id === (isEditing ? form?.stageId : deal?.stageId));
  const formatDate = (iso?: string) =>
    iso ? new Date(iso).toLocaleDateString(intlLocale, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const statusLabel = (status: string) => (t.deals.statuses as Record<string, string>)[status] ?? status;

  const save = async (update: Parameters<typeof api.updateDeal>[1], toastText?: string) => {
    if (!deal) return false;
    setBusy(true);
    const res = await api.updateDeal(deal.id, update);
    setBusy(false);
    if (res.success && res.data) {
      setDeal(res.data);
      if (toastText) toast.success(toastText);
      return true;
    }
    toast.error(typeof res.error === 'string' ? res.error : t.deals.saveFailed);
    return false;
  };

  const setStatus = (status: DealStatus) => {
    const toasts: Record<DealStatus, string> = {
      won: t.deals.wonToast,
      lost: t.deals.lostToast,
      open: t.deals.reopenedToast,
      abandoned: t.deals.lostToast,
    };
    const confirm = status === 'lost' ? t.deals.confirmLost : status === 'won' ? t.deals.confirmWon : null;
    if (!confirm) {
      void save({ status }, toasts[status]);
      return;
    }
    Alert.alert(confirm, undefined, [
      { text: t.common.cancel, style: 'cancel' },
      { text: status === 'won' ? t.deals.markWon : t.deals.markLost, onPress: () => void save({ status }, toasts[status]) },
    ]);
  };

  const handleDelete = () => {
    if (!deal) return;
    Alert.alert(t.deals.deleteTitle, interpolate(t.deals.deleteMessage, { name: deal.name }), [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const res = await api.deleteDeal(deal.id);
            if (res.success) {
              toast.success(t.deals.deletedToast);
              router.back();
            } else {
              toast.error(t.deals.deleteFailed);
            }
          })();
        },
      },
    ]);
  };

  const startEdit = () => {
    if (!deal) return;
    setForm(formFromDeal(deal, contactName, defs ?? []));
    setErrors({});
    setCustomErrors({});
    setTab('details');
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (!form || !deal) return;
    const found: Partial<Record<'name' | 'amount' | 'closeDate', FieldError>> = {};
    const nameError = checkRequired(form.name);
    if (nameError) found.name = nameError;
    const amountError = checkOptionalAmount(form.amount);
    if (amountError) found.amount = amountError;
    if (parseDateInput(form.closeDate).error) found.closeDate = 'invalidDate';
    const parsedCustom = defs ? parseCustomDrafts(defs, form.customDrafts) : { values: {}, errors: {} };
    setErrors(found);
    setCustomErrors(parsedCustom.errors);
    if (Object.keys(found).length > 0 || Object.keys(parsedCustom.errors).length > 0) return;

    const due = parseDateInput(form.closeDate).date;
    const saved = await save(
      {
        name: form.name,
        amount: parseAmountInput(form.amount) ?? 0,
        currency: form.currency,
        stageId: form.stageId !== deal.stageId ? form.stageId : undefined,
        probability: form.probability,
        closeDate: due ? due.toISOString() : null,
        ownerId: form.ownerId,
        primaryContactId: form.contact?.id,
        leadSource: form.leadSource,
        type: form.type,
        nextStep: form.nextStep,
        tags: form.tags,
        description: form.description,
        customFields: defs ? mergeCustomValues(deal.customFields, { ...form.customValues, ...parsedCustom.values }) : undefined,
      },
      t.deals.savedToast,
    );
    if (saved) {
      setContactName(form.contact?.name);
      setIsEditing(false);
    }
  };

  if (loading || !deal || !form) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <StackHeader title={name || t.deals.deal} onBack={() => router.back()} />
        <View style={styles.center}>
          {loading ? (
            <ActivityIndicator size="large" color={colors.text} />
          ) : (
            <Text style={{ color: colors.muted }}>{t.deals.loadDealFailed}</Text>
          )}
        </View>
      </View>
    );
  }

  const set = <K extends keyof DealForm>(key: K, value: DealForm[K]) => setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  const error = (key: keyof typeof errors, label: string) => (errors[key] ? describeError(t, errors[key] as FieldError, label) : null);
  const value = deal.value && toNumber(deal.value) > 0 ? formatMoney(deal.value, deal.currency ?? 'EUR', intlLocale) : t.common.dash;
  const info = (label: string, text?: string, onPress?: () => void) => (
    <RecordInfoRow key={label} label={label}>
      {text && onPress ? (
        <TouchableOpacity onPress={onPress} accessibilityRole="link" style={styles.linkValue}>
          <Text style={styles.linkText} numberOfLines={1}>
            {text}
          </Text>
        </TouchableOpacity>
      ) : (
        text || t.common.dash
      )}
    </RecordInfoRow>
  );

  const editView = (
    <View>
      <FormField label={t.deals.dealName} required value={form.name} onChangeText={(v) => set('name', v)} error={error('name', t.deals.dealName)} />
      <View style={styles.row}>
        <View style={styles.amount}>
          <FormField
            label={t.deals.value}
            value={form.amount}
            onChangeText={(v) => set('amount', v)}
            keyboardType="decimal-pad"
            error={error('amount', t.deals.value)}
          />
        </View>
        <View style={styles.currency}>
          <SelectField label={t.deals.currency} value={form.currency} onPress={() => setPicker('currency')} />
        </View>
      </View>
      <SelectField label={t.deals.stage} value={stage?.name} color={stage?.color} onPress={() => setPicker('stage')} />
      <SelectField
        label={t.deals.chance}
        value={form.probability === undefined ? null : `${form.probability}%`}
        onPress={() => setPicker('chance')}
        onClear={() => set('probability', undefined)}
      />
      <DueDateField label={t.deals.closingDate} value={form.closeDate} onChange={(v) => set('closeDate', v)} error={error('closeDate', t.deals.closingDate)} />
      <SelectField label={t.records.owner} value={form.ownerId ? byId.get(form.ownerId)?.name : null} onPress={() => setPicker('owner')} />
      <SelectField
        label={t.deals.contact}
        value={form.contact?.name}
        placeholder={t.common.optional}
        onPress={() => setPicker('contact')}
      />
      <FormField label={t.deals.leadSource} value={form.leadSource} onChangeText={(v) => set('leadSource', v)} />
      <FormField label={t.deals.type} value={form.type} onChangeText={(v) => set('type', v)} />
      <FormField label={t.deals.nextStep} value={form.nextStep} onChangeText={(v) => set('nextStep', v)} />
      <TagInput label={t.records.tags} value={form.tags} placeholder={t.records.tagsPlaceholder} onChange={(tags) => set('tags', tags)} />
      <FormField
        label={t.deals.description}
        value={form.description}
        onChangeText={(v) => set('description', v)}
        multiline
        numberOfLines={4}
      />
      {!!defs && defs.length > 0 && (
        <>
          <RecordSectionTitle>{t.records.customFields}</RecordSectionTitle>
          <CustomFieldsEdit
            defs={defs}
            values={form.customValues}
            drafts={form.customDrafts}
            errors={customErrors}
            members={members}
            onValue={(slug, v) => set('customValues', { ...form.customValues, [slug]: v })}
            onDraft={(slug, text) => set('customDrafts', { ...form.customDrafts, [slug]: text })}
          />
        </>
      )}
    </View>
  );

  const detailsView = (
    <View>
      {info(t.deals.company, deal.companyName, deal.companyId ? () => router.push({ pathname: '/company/[id]', params: { id: deal.companyId as string, name: deal.companyName ?? '' } }) : undefined)}
      {info(t.deals.contact, contactName, deal.primaryContactId ? () => router.push({ pathname: '/person/[id]', params: { id: deal.primaryContactId as string, name: contactName ?? '' } }) : undefined)}
      {info(t.deals.pipeline, pipeline?.name)}
      {info(t.deals.chance, deal.probability === undefined ? undefined : `${deal.probability}%`)}
      {info(t.deals.closingDate, formatDate(deal.expectedCloseDate))}
      {deal.status !== 'open' && info(t.deals.actualCloseDate, formatDate(deal.actualCloseDate))}
      {info(t.records.owner, deal.ownerId ? byId.get(deal.ownerId)?.name : undefined)}
      {info(t.deals.leadSource, deal.leadSource)}
      {info(t.deals.type, deal.type)}
      {info(t.deals.nextStep, deal.nextStep)}
      {info(t.records.tags, deal.tags.join(', '))}
      {!!deal.description && (
        <>
          <View style={styles.gap} />
          <RecordSectionTitle>{t.deals.description}</RecordSectionTitle>
          <Text style={[styles.longText, { color: colors.text }]}>{deal.description}</Text>
        </>
      )}
      {!!defs && defs.length > 0 && (
        <>
          <View style={styles.gap} />
          <RecordSectionTitle>{t.records.customFields}</RecordSectionTitle>
          <CustomFieldsView defs={defs} values={deal.customFields} memberName={(userId) => byId.get(userId)?.name} />
        </>
      )}
      <View style={styles.gap} />
      {info(t.company.created, formatDate(deal.createdAt))}
      {info(t.company.lastUpdated, formatDate(deal.updatedAt))}
    </View>
  );

  const activityView = (
    <View>
      <TouchableOpacity
        style={[styles.addButton, { borderColor: colors.divider }]}
        onPress={() =>
          router.push({
            pathname: '/activity/new',
            params: {
              opportunityId: deal.id,
              ...(deal.companyId ? { recordKind: 'company', recordId: deal.companyId, recordName: deal.companyName ?? '' } : {}),
            },
          })
        }
        accessibilityRole="button"
      >
        <Text style={[styles.addButtonText, { color: colors.text }]}>{t.activity.title}</Text>
      </TouchableOpacity>
      {activities.length === 0 ? (
        <Text style={[styles.empty, { color: colors.muted }]}>{t.records.noActivity}</Text>
      ) : (
        activities.map((item) => (
          <View key={item.id} style={[styles.activity, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.activityTitle, { color: colors.text }]}>
              {((t.activity.types as Record<string, string>)[item.type] ?? item.type) + ' · ' + item.subject}
            </Text>
            <Text style={[styles.activityMeta, { color: colors.muted }]}>
              {new Date(item.createdAt).toLocaleString(intlLocale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </Text>
            {!!item.description && (
              <Text style={[styles.activityBody, { color: colors.text }]} numberOfLines={3}>
                {htmlToText(item.description)}
              </Text>
            )}
          </View>
        ))
      )}
    </View>
  );

  const statusColor = STATUS_COLORS[deal.status] ?? '#6B7280';
  const actions: { value: string; label: string; color?: string }[] = [
    { value: 'edit', label: t.common.edit },
    ...(deal.status === 'open'
      ? [
          { value: 'won', label: t.deals.markWon, color: STATUS_COLORS.won },
          { value: 'lost', label: t.deals.markLost, color: STATUS_COLORS.lost },
        ]
      : [{ value: 'open', label: t.deals.reopen }]),
    { value: 'delete', label: t.common.delete, color: colors.destructive },
  ];

  return (
    <KeyboardAvoidingView style={[styles.container, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader
        title={isEditing ? t.deals.editTitle : deal.name}
        onBack={() => (isEditing ? setIsEditing(false) : router.back())}
        right={
          isEditing ? (
            <RecordHeaderActions
              isEditing
              saving={busy}
              onCancel={() => setIsEditing(false)}
              onSave={() => void handleSave()}
              onEdit={startEdit}
              onDelete={handleDelete}
            />
          ) : (
            <TouchableOpacity onPress={() => setPicker('actions')} style={styles.headerButton} accessibilityRole="button" accessibilityLabel={t.records.actions}>
              <MoreHorizontal size={22} color={colors.text} />
            </TouchableOpacity>
          )
        }
      />
      <ScrollView style={styles.content} keyboardShouldPersistTaps="handled" stickyHeaderIndices={isEditing ? undefined : [1]}>
        <View style={styles.summary}>
          <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
          <View style={styles.badges}>
            <View style={[styles.badge, { backgroundColor: `${statusColor}20` }]}>
              <Text style={[styles.badgeText, { color: statusColor }]}>{statusLabel(deal.status)}</Text>
            </View>
            {!!stage && (
              <TouchableOpacity
                style={[styles.stageChip, { borderColor: colors.divider }]}
                onPress={() => setPicker('stage')}
                disabled={busy || isEditing}
                accessibilityRole="button"
                accessibilityLabel={`${t.deals.stage}: ${stage.name}`}
              >
                <View style={[styles.dot, { backgroundColor: stage.color || '#6B7280' }]} />
                <Text style={[styles.stageText, { color: colors.text }]}>{stage.name}</Text>
              </TouchableOpacity>
            )}
            {busy && <ActivityIndicator size="small" color={colors.text} />}
          </View>
        </View>
        {isEditing ? (
          <View />
        ) : (
          <ScrollTabs<Tab>
            tabs={[
              { key: 'details', label: t.records.tabs.details },
              { key: 'activity', label: t.records.tabs.activity, count: activities.length || undefined },
            ]}
            active={tab}
            onChange={setTab}
          />
        )}
        <View style={styles.panel}>{isEditing ? editView : tab === 'details' ? detailsView : activityView}</View>
        <View style={{ height: 40 }} />
      </ScrollView>

      <OptionSheet<string>
        visible={picker === 'actions'}
        title={deal.name}
        options={actions}
        onSelect={(action) => {
          setPicker(null);
          if (action === 'edit') startEdit();
          if (action === 'won' || action === 'lost' || action === 'open') setStatus(action);
          if (action === 'delete') handleDelete();
        }}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<string>
        visible={picker === 'stage'}
        title={t.deals.stage}
        options={(pipeline?.stages ?? []).map((s) => ({ value: s.id, label: s.name, color: s.color }))}
        selected={isEditing ? form.stageId : deal.stageId}
        onSelect={(stageId) => {
          setPicker(null);
          if (!stageId) return;
          if (isEditing) set('stageId', stageId);
          else if (stageId !== deal.stageId)
            void save({ stageId }, interpolate(t.deals.movedToast, { stage: pipeline?.stages.find((s) => s.id === stageId)?.name ?? '' }));
        }}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<string>
        visible={picker === 'currency'}
        title={t.deals.currency}
        options={[...new Set([form.currency, ...DEAL_CURRENCIES])].map((code) => ({ value: code, label: code }))}
        selected={form.currency}
        onSelect={(code) => {
          setPicker(null);
          if (code) set('currency', code);
        }}
        onClose={() => setPicker(null)}
      />
      <OptionSheet<string>
        visible={picker === 'chance'}
        title={t.deals.chance}
        options={CHANCE_OPTIONS.map((n) => ({ value: String(n), label: `${n}%` }))}
        selected={form.probability === undefined ? null : String(form.probability)}
        onSelect={(v) => {
          setPicker(null);
          set('probability', v === null ? undefined : Number(v));
        }}
        onClose={() => setPicker(null)}
      />
      <MemberPicker
        visible={picker === 'owner'}
        title={t.records.owner}
        members={members}
        selected={form.ownerId ? [form.ownerId] : []}
        onChange={(ids) => set('ownerId', ids[0])}
        onClose={() => setPicker(null)}
      />
      <PersonPicker
        visible={picker === 'contact'}
        onClose={() => setPicker(null)}
        onSelect={(person) => {
          set('contact', { id: person.id, name: person.name });
          setPicker(null);
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { flex: 1 },
  headerButton: { padding: 8 },
  summary: { paddingHorizontal: 16, paddingVertical: 20, gap: 10 },
  value: { fontSize: 28, fontWeight: '700' },
  badges: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  stageChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1 },
  stageText: { fontSize: 12, fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  panel: { paddingHorizontal: 16, paddingTop: 12 },
  row: { flexDirection: 'row', gap: 12 },
  amount: { flex: 2 },
  currency: { flex: 1 },
  gap: { height: 20 },
  longText: { fontSize: 15, lineHeight: 22 },
  linkValue: { flexShrink: 1, marginLeft: 12 },
  linkText: { fontSize: 14, fontWeight: '500', color: '#7C3AED' },
  addButton: { alignItems: 'center', paddingVertical: 10, borderWidth: 1, borderStyle: 'dashed', borderRadius: 8, marginBottom: 8 },
  addButtonText: { fontSize: 14, fontWeight: '500' },
  empty: { fontSize: 14, paddingVertical: 16 },
  activity: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  activityTitle: { fontSize: 15, fontWeight: '500' },
  activityMeta: { fontSize: 12 },
  activityBody: { fontSize: 13, marginTop: 4 },
});
