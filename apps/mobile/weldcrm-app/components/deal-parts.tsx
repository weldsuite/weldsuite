/**
 * Pieces of the deal screen (`app/deal/[id].tsx`): the form model and its
 * save payload, the data hook, and the details, edit and activity views.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { CustomFieldsEdit, CustomFieldsView, customDrafts } from '@/components/custom-fields';
import { DueDateField } from '@/components/due-date-field';
import { FormField } from '@/components/form';
import { SelectField, TagInput } from '@/components/option-sheet';
import { RecordInfoRow, RecordSectionTitle } from '@/components/record';
import {
  api,
  type CrmActivity,
  type CustomFieldDefinition,
  type CustomFieldValues,
  type DealRecord,
  type DealUpdate,
  type Member,
  type PipelineStage,
  type PipelineWithStages,
} from '@/services/api';
import { useI18n } from '@/lib/i18n';
import { mergeCustomValues } from '@/lib/custom-fields';
import { parseDate, parseDateInput, toDateInput } from '@/lib/dates';
import { formatMoney, toNumber } from '@/lib/money';
import { htmlToText } from '@/lib/note-text';
import { checkOptionalAmount, checkRequired, describeError, parseAmountInput, type FieldError } from '@/lib/validation';

export interface DealForm {
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

export type DealErrors = Partial<Record<'name' | 'amount' | 'closeDate', FieldError>>;

export function formFromDeal(deal: DealRecord, contactName: string | undefined, defs: readonly CustomFieldDefinition[]): DealForm {
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

export function validateDealForm(form: DealForm): DealErrors {
  const checks: ['name' | 'amount' | 'closeDate', FieldError | null][] = [
    ['name', checkRequired(form.name)],
    ['amount', checkOptionalAmount(form.amount)],
    ['closeDate', parseDateInput(form.closeDate).error ?? null],
  ];
  return Object.fromEntries(checks.filter(([, error]) => error !== null)) as DealErrors;
}

/** The update for a saved form; the stage only when it changed, the custom fields as one merged map. */
export function dealFormUpdate(
  form: DealForm,
  deal: DealRecord,
  defs: readonly CustomFieldDefinition[] | null,
  parsedCustom: CustomFieldValues,
): DealUpdate {
  const due = parseDateInput(form.closeDate).date;
  return {
    name: form.name,
    amount: parseAmountInput(form.amount) ?? 0,
    currency: form.currency,
    stageId: form.stageId === deal.stageId ? undefined : form.stageId,
    probability: form.probability,
    closeDate: due ? due.toISOString() : null,
    ownerId: form.ownerId,
    primaryContactId: form.contact?.id,
    leadSource: form.leadSource,
    type: form.type,
    nextStep: form.nextStep,
    tags: form.tags,
    description: form.description,
    customFields: defs ? mergeCustomValues(deal.customFields, { ...form.customValues, ...parsedCustom }) : undefined,
  };
}

/** The pipeline a deal is in: by its pipeline id, else the one that has its stage. */
function pipelineOf(deal: DealRecord, pipelines: readonly PipelineWithStages[]): PipelineWithStages | null {
  return (
    pipelines.find((p) => p.id === deal.pipelineId) ??
    pipelines.find((p) => p.stages.some((s) => s.id === deal.stageId)) ??
    null
  );
}

async function contactNameOf(deal: DealRecord): Promise<string | undefined> {
  if (!deal.primaryContactId) return undefined;
  const res = await api.getPerson(deal.primaryContactId);
  return res.success && res.data ? res.data.name : undefined;
}

/** The deal with its pipeline, contact, custom fields and activity; refetched on focus. */
export function useDealData(id: string, onLoadFailed: () => void) {
  const [deal, setDeal] = useState<DealRecord | null>(null);
  const [pipeline, setPipeline] = useState<PipelineWithStages | null>(null);
  const [contactName, setContactName] = useState<string | undefined>();
  const [defs, setDefs] = useState<CustomFieldDefinition[] | null>(null);
  const [activities, setActivities] = useState<CrmActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const loadedOnce = useRef(false);
  const failedRef = useRef(onLoadFailed);
  failedRef.current = onLoadFailed;

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      const [dealRes, pipelinesRes, defsRes, activitiesRes] = await Promise.all([
        api.getDeal(id),
        api.getPipelines(),
        api.getCustomFields('opportunity'),
        api.getActivities({ opportunityId: id, limit: 50 }),
      ]);
      setDefs(defsRes.success && defsRes.data ? defsRes.data : null);
      if (activitiesRes.success && activitiesRes.data) setActivities(activitiesRes.data.items);
      if (dealRes.success && dealRes.data) {
        const loaded = dealRes.data;
        setDeal(loaded);
        setPipeline(pipelineOf(loaded, pipelinesRes.success && pipelinesRes.data ? pipelinesRes.data : []));
        setContactName(await contactNameOf(loaded));
      } else if (!silent) {
        failedRef.current();
      }
      loadedOnce.current = true;
      setLoading(false);
    },
    [id],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      if (loadedOnce.current) void load(true);
    }, [load]),
  );

  return { deal, setDeal, pipeline, contactName, setContactName, defs, activities, loading };
}

/** A labelled value; a link when it has a value and `onPress`. */
function InfoRow({ label, text, onPress }: Readonly<{ label: string; text?: string; onPress?: () => void }>) {
  const { t } = useI18n();
  if (!text || !onPress) return <RecordInfoRow label={label}>{text || t.common.dash}</RecordInfoRow>;
  return (
    <RecordInfoRow label={label}>
      <TouchableOpacity onPress={onPress} accessibilityRole="link" style={styles.linkValue}>
        <Text style={styles.linkText} numberOfLines={1}>
          {text}
        </Text>
      </TouchableOpacity>
    </RecordInfoRow>
  );
}

interface DetailsProps {
  deal: DealRecord;
  pipeline: PipelineWithStages | null;
  contactName?: string;
  defs: readonly CustomFieldDefinition[] | null;
  memberName: (userId: string) => string | undefined;
}

export function DealDetailsView({ deal, pipeline, contactName, defs, memberName }: Readonly<DetailsProps>) {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const date = (iso?: string) =>
    iso ? new Date(iso).toLocaleDateString(intlLocale, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const openCompany = deal.companyId
    ? () => router.push({ pathname: '/company/[id]', params: { id: deal.companyId as string, name: deal.companyName ?? '' } })
    : undefined;
  const openContact = deal.primaryContactId
    ? () => router.push({ pathname: '/person/[id]', params: { id: deal.primaryContactId as string, name: contactName ?? '' } })
    : undefined;

  return (
    <View>
      <InfoRow label={t.deals.company} text={deal.companyName} onPress={openCompany} />
      <InfoRow label={t.deals.contact} text={contactName} onPress={openContact} />
      <InfoRow label={t.deals.pipeline} text={pipeline?.name} />
      <InfoRow label={t.deals.chance} text={deal.probability === undefined ? undefined : `${deal.probability}%`} />
      <InfoRow label={t.deals.closingDate} text={date(deal.expectedCloseDate)} />
      {deal.status !== 'open' && <InfoRow label={t.deals.actualCloseDate} text={date(deal.actualCloseDate)} />}
      <InfoRow label={t.records.owner} text={deal.ownerId ? memberName(deal.ownerId) : undefined} />
      <InfoRow label={t.deals.leadSource} text={deal.leadSource} />
      <InfoRow label={t.deals.type} text={deal.type} />
      <InfoRow label={t.deals.nextStep} text={deal.nextStep} />
      <InfoRow label={t.records.tags} text={deal.tags.join(', ')} />
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
          <CustomFieldsView defs={defs} values={deal.customFields} memberName={memberName} />
        </>
      )}
      <View style={styles.gap} />
      <InfoRow label={t.company.created} text={date(deal.createdAt)} />
      <InfoRow label={t.company.lastUpdated} text={date(deal.updatedAt)} />
    </View>
  );
}

export type DealPicker = 'stage' | 'currency' | 'owner' | 'contact' | 'chance';

interface EditProps {
  form: DealForm;
  errors: DealErrors;
  customErrors: Record<string, boolean>;
  stage?: PipelineStage;
  defs: readonly CustomFieldDefinition[] | null;
  members: readonly Member[];
  memberName: (userId: string) => string | undefined;
  onChange: (form: DealForm) => void;
  onOpenPicker: (picker: DealPicker) => void;
}

export function DealEditForm({ form, errors, customErrors, stage, defs, members, memberName, onChange, onOpenPicker }: Readonly<EditProps>) {
  const { t } = useI18n();
  const set = <K extends keyof DealForm>(key: K, value: DealForm[K]) => onChange({ ...form, [key]: value });
  const error = (key: keyof DealErrors, label: string) => {
    const found = errors[key];
    return found ? describeError(t, found, label) : null;
  };

  return (
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
          <SelectField label={t.deals.currency} value={form.currency} onPress={() => onOpenPicker('currency')} />
        </View>
      </View>
      <SelectField label={t.deals.stage} value={stage?.name} color={stage?.color} onPress={() => onOpenPicker('stage')} />
      <SelectField
        label={t.deals.chance}
        value={form.probability === undefined ? null : `${form.probability}%`}
        onPress={() => onOpenPicker('chance')}
        onClear={() => set('probability', undefined)}
      />
      <DueDateField
        label={t.deals.closingDate}
        value={form.closeDate}
        onChange={(v) => set('closeDate', v)}
        error={error('closeDate', t.deals.closingDate)}
      />
      <SelectField
        label={t.records.owner}
        value={form.ownerId ? memberName(form.ownerId) : null}
        onPress={() => onOpenPicker('owner')}
      />
      <SelectField label={t.deals.contact} value={form.contact?.name} placeholder={t.common.optional} onPress={() => onOpenPicker('contact')} />
      <FormField label={t.deals.leadSource} value={form.leadSource} onChangeText={(v) => set('leadSource', v)} />
      <FormField label={t.deals.type} value={form.type} onChangeText={(v) => set('type', v)} />
      <FormField label={t.deals.nextStep} value={form.nextStep} onChangeText={(v) => set('nextStep', v)} />
      <TagInput label={t.records.tags} value={form.tags} placeholder={t.records.tagsPlaceholder} onChange={(tags) => set('tags', tags)} />
      <FormField label={t.deals.description} value={form.description} onChangeText={(v) => set('description', v)} multiline numberOfLines={4} />
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
}

const STATUS_COLORS: Record<string, string> = { open: '#3B82F6', won: '#10B981', lost: '#EF4444', abandoned: '#9CA3AF' };

export const dealStatusColor = (status: string) => STATUS_COLORS[status] ?? '#6B7280';

interface SummaryProps {
  deal: DealRecord;
  stage?: PipelineStage;
  busy: boolean;
  stageLocked: boolean;
  onStagePress: () => void;
}

/** The value, status and stage at the top of the deal screen. */
export function DealSummary({ deal, stage, busy, stageLocked, onStagePress }: Readonly<SummaryProps>) {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const value = deal.value && toNumber(deal.value) > 0 ? formatMoney(deal.value, deal.currency ?? 'EUR', intlLocale) : t.common.dash;
  const color = dealStatusColor(deal.status);
  const statusLabel = (t.deals.statuses as Record<string, string>)[deal.status] ?? deal.status;
  return (
    <View style={styles.summary}>
      <Text style={[styles.value, { color: colors.text }]}>{value}</Text>
      <View style={styles.badges}>
        <View style={[styles.badge, { backgroundColor: `${color}20` }]}>
          <Text style={[styles.badgeText, { color }]}>{statusLabel}</Text>
        </View>
        {!!stage && (
          <TouchableOpacity
            style={[styles.stageChip, { borderColor: colors.divider }]}
            onPress={onStagePress}
            disabled={busy || stageLocked}
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
  );
}

export function DealActivityList({ deal, activities }: Readonly<{ deal: DealRecord; activities: readonly CrmActivity[] }>) {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const companyParams = deal.companyId
    ? { recordKind: 'company', recordId: deal.companyId, recordName: deal.companyName ?? '' }
    : {};
  const typeLabel = (type: string) => (t.activity.types as Record<string, string>)[type] ?? type;

  return (
    <View>
      <TouchableOpacity
        style={[styles.addButton, { borderColor: colors.divider }]}
        onPress={() => router.push({ pathname: '/activity/new', params: { opportunityId: deal.id, ...companyParams } })}
        accessibilityRole="button"
      >
        <Text style={[styles.addButtonText, { color: colors.text }]}>{t.activity.title}</Text>
      </TouchableOpacity>
      {activities.length === 0 && <Text style={[styles.empty, { color: colors.muted }]}>{t.records.noActivity}</Text>}
      {activities.map((item) => (
        <View key={item.id} style={[styles.activity, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.activityTitle, { color: colors.text }]}>{`${typeLabel(item.type)} · ${item.subject}`}</Text>
          <Text style={[styles.activityMeta, { color: colors.muted }]}>
            {new Date(item.createdAt).toLocaleString(intlLocale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </Text>
          {!!item.description && (
            <Text style={[styles.activityBody, { color: colors.text }]} numberOfLines={3}>
              {htmlToText(item.description)}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { paddingHorizontal: 16, paddingVertical: 20, gap: 10 },
  value: { fontSize: 28, fontWeight: '700' },
  badges: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  stageChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1 },
  stageText: { fontSize: 12, fontWeight: '600' },
  dot: { width: 8, height: 8, borderRadius: 4 },
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
