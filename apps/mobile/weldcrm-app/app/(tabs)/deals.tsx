import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Calendar, DollarSign, FileText, Plus, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { CompanyPicker } from '@/components/company-picker';
import { FormField } from '@/components/form';
import { TabHeader } from '@/components/headers';
import {
  api,
  type CompanyRecord,
  type DealRecord,
  type PipelineWithStages,
} from '@/services/api';
import { useI18n } from '@/lib/i18n';
import { dueDateFromToday, parseDateInput } from '@/lib/dates';
import { currencySymbol, formatMoney, resolveCurrency } from '@/lib/money';
import { describeError, optionalText, parseAmountInput, validateDeal, type FormErrors } from '@/lib/validation';

const CHANCE_OPTIONS = [10, 25, 50, 75, 90, 100];
/** Deals are read 100 at a time; this caps a board at 1,000 of them. */
const MAX_DEAL_PAGES = 10;

interface Column {
  id: string;
  title: string;
  color: string;
  deals: DealRecord[];
}

type DealField = 'name' | 'value' | 'closeDate';

function buildColumns(pipeline: PipelineWithStages, deals: DealRecord[]): Column[] {
  return pipeline.stages.map((stage) => ({
    id: stage.id,
    title: stage.name,
    color: stage.color || '#6B7280',
    deals: deals.filter((deal) => deal.stageId === stage.id),
  }));
}

export default function DealsScreen() {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ new?: string }>();

  const [pipeline, setPipeline] = useState<PipelineWithStages | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [currency, setCurrency] = useState('EUR');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loadedOnce = useRef(false);

  // Create flow: pick the company, then fill in the deal.
  const [stageId, setStageId] = useState<string | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [company, setCompany] = useState<CompanyRecord | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [chance, setChance] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<FormErrors<DealField>>({});
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' | 'silent') => {
      if (mode === 'initial') setLoading(true);
      if (mode === 'refresh') setRefreshing(true);

      const [pipelinesRes, workspaceCurrency] = await Promise.all([api.getPipelines(), api.getWorkspaceCurrency()]);
      setCurrency(resolveCurrency(workspaceCurrency));

      const first = pipelinesRes.success ? pipelinesRes.data?.[0] : undefined;
      if (first) {
        const deals: DealRecord[] = [];
        let cursor: string | null = null;
        let failed = false;
        for (let page = 0; page < MAX_DEAL_PAGES; page += 1) {
          const res = await api.getDeals({ cursor, pipelineId: first.id });
          if (!res.success || !res.data) {
            failed = true;
            break;
          }
          deals.push(...res.data.items);
          cursor = res.data.cursor;
          if (!res.data.hasMore || !cursor) break;
        }
        setPipeline(first);
        setColumns(buildColumns(first, deals));
        if (failed && mode !== 'silent') toast.error(t.deals.loadFailed);
      } else {
        setPipeline(null);
        setColumns([]);
        if (!pipelinesRes.success && mode !== 'silent') toast.error(t.deals.loadFailed);
      }

      loadedOnce.current = true;
      setLoading(false);
      setRefreshing(false);
    },
    [t, toast],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      if (loadedOnce.current) void load('silent');
    }, [load]),
  );

  const startCreate = useCallback((targetStageId: string) => {
    setStageId(targetStageId);
    setCompany(null);
    setName('');
    setValue('');
    setCloseDate('');
    setChance(null);
    setNotes('');
    setErrors({});
    setPickerVisible(true);
  }, []);

  // Home's "Create Deal" lands here with ?new=1: start in the first stage.
  useEffect(() => {
    if (params.new !== '1' || loading) return;
    router.setParams({ new: undefined });
    const firstStage = columns[0]?.id;
    if (firstStage) startCreate(firstStage);
  }, [params.new, loading, columns, startCreate]);

  const closeCreate = () => {
    setPickerVisible(false);
    setCompany(null);
    setStageId(null);
  };

  const stageName = columns.find((column) => column.id === stageId)?.title ?? '';

  const handleCreate = async () => {
    if (!company || !stageId) return;
    const found = validateDeal({ name, value, closeDate }, parseDateInput);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const parsedDate = parseDateInput(closeDate).date ?? undefined;
    setSubmitting(true);
    const res = await api.createDeal({
      name,
      companyId: company.id,
      amount: parseAmountInput(value),
      currency,
      stageId,
      probability: chance ?? undefined,
      closeDate: (parsedDate ?? dueDateFromToday(30)).toISOString(),
      notes: optionalText(notes),
      pipelineId: pipeline?.id,
    });
    setSubmitting(false);

    if (res.success && res.data) {
      const created = res.data;
      setColumns((prev) =>
        prev.map((column) => (column.id === stageId ? { ...column, deals: [...column.deals, created] } : column)),
      );
      toast.success(t.deals.createdToast);
      closeCreate();
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.deals.createFailed);
    }
  };

  const message = (field: DealField, label: string) => {
    const error = errors[field];
    return error ? describeError(t, error, label) : null;
  };

  const formatDate = (iso?: string) =>
    iso ? new Date(iso).toLocaleDateString(intlLocale, { day: 'numeric', month: 'short', year: 'numeric' }) : t.deals.noDate;

  const formVisible = !!company && !pickerVisible;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TabHeader title={t.deals.title} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      ) : !pipeline ? (
        <ScrollView
          contentContainerStyle={styles.center}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} />}
        >
          <Text style={[styles.emptyText, { color: colors.muted }]}>{t.deals.noPipeline}</Text>
        </ScrollView>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          bounces={false}
          directionalLockEnabled
          contentContainerStyle={styles.columns}
        >
          {columns.map((column) => (
            <View key={column.id} style={styles.column}>
              <View style={styles.columnHeader}>
                <View style={[styles.columnDot, { backgroundColor: column.color }]} />
                <Text style={[styles.columnTitle, { color: colors.text }]} numberOfLines={1}>
                  {column.title}
                </Text>
                <Text style={[styles.columnCount, { color: colors.muted }]}>{column.deals.length}</Text>
              </View>

              <ScrollView
                style={styles.columnContent}
                showsVerticalScrollIndicator={false}
                nestedScrollEnabled
                bounces={false}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} />}
              >
                {column.deals.map((deal) => (
                  <TouchableOpacity
                    key={deal.id}
                    style={[styles.dealCard, { backgroundColor: colors.background, borderColor: colors.divider }]}
                    activeOpacity={0.7}
                    disabled={!deal.companyId}
                    onPress={() =>
                      deal.companyId && router.push({ pathname: '/company/[id]', params: { id: deal.companyId } })
                    }
                    accessibilityRole="button"
                    accessibilityLabel={deal.name}
                  >
                    <View style={styles.dealRow}>
                      <FileText size={16} color="#9CA3AF" strokeWidth={1.5} />
                      <Text style={[styles.dealTitle, { color: colors.text }]} numberOfLines={1}>
                        {deal.name}
                      </Text>
                    </View>
                    <View style={styles.dealRow}>
                      <DollarSign size={16} color="#9CA3AF" strokeWidth={1.5} />
                      <Text style={[styles.dealText, { color: deal.value ? colors.text : '#9CA3AF' }]}>
                        {deal.value ? formatMoney(deal.value, deal.currency ?? currency, intlLocale) : t.deals.setValue}
                      </Text>
                    </View>
                    <View style={styles.dealRow}>
                      <Calendar size={16} color="#9CA3AF" strokeWidth={1.5} />
                      <Text style={[styles.dealText, { color: colors.text }]}>{formatDate(deal.expectedCloseDate)}</Text>
                    </View>
                  </TouchableOpacity>
                ))}

                <TouchableOpacity
                  style={[styles.addDeal, { borderColor: colors.divider }]}
                  onPress={() => startCreate(column.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.deals.addDeal}: ${column.title}`}
                >
                  <Plus size={18} color={colors.muted} strokeWidth={2} />
                  <Text style={[styles.addDealText, { color: colors.muted }]}>{t.deals.addDeal}</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          ))}
        </ScrollView>
      )}

      <CompanyPicker
        visible={pickerVisible}
        onClose={closeCreate}
        onSelect={(selected) => {
          setCompany(selected);
          setPickerVisible(false);
        }}
      />

      <Modal visible={formVisible} animationType="slide" onRequestClose={closeCreate}>
        <KeyboardAvoidingView
          style={[styles.form, { backgroundColor: colors.background, paddingTop: insets.top }]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.formHeader, { borderBottomColor: colors.divider }]}>
            <View style={styles.formHeaderText}>
              <Text style={[styles.formTitle, { color: colors.text }]} numberOfLines={1}>
                {company?.name ?? t.deals.newDeal}
              </Text>
              <Text style={[styles.formSub, { color: colors.muted }]}>
                {t.deals.newDeal} · {stageName}
              </Text>
            </View>
            <TouchableOpacity
              onPress={closeCreate}
              style={styles.formClose}
              accessibilityRole="button"
              accessibilityLabel={t.common.close}
            >
              <X size={22} color={colors.text} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.formBody} keyboardShouldPersistTaps="handled">
            <FormField
              label={t.deals.dealName}
              required
              value={name}
              onChangeText={setName}
              placeholder={t.deals.dealNamePlaceholder}
              error={message('name', t.deals.dealName)}
            />
            <FormField
              label={`${t.deals.value} (${currencySymbol(currency, intlLocale)})`}
              value={value}
              onChangeText={setValue}
              placeholder={t.deals.valuePlaceholder}
              error={message('value', t.deals.value)}
              keyboardType="decimal-pad"
            />

            <Text style={[styles.chipsLabel, { color: colors.muted }]}>{t.deals.chance}</Text>
            <View style={styles.chips}>
              {CHANCE_OPTIONS.map((option) => {
                const active = chance === option;
                return (
                  <TouchableOpacity
                    key={option}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: active ? colors.text : colors.background,
                        borderColor: active ? colors.text : colors.divider,
                      },
                    ]}
                    onPress={() => setChance(active ? null : option)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.chipText, { color: active ? colors.background : colors.text }]}>{option}%</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <FormField
              label={t.deals.closingDate}
              value={closeDate}
              onChangeText={setCloseDate}
              placeholder={t.deals.closingDatePlaceholder}
              error={message('closeDate', t.deals.closingDate)}
              keyboardType="numbers-and-punctuation"
              maxLength={10}
            />
            <FormField
              label={t.deals.notes}
              value={notes}
              onChangeText={setNotes}
              placeholder={t.deals.notesPlaceholder}
              multiline
              numberOfLines={3}
            />
          </ScrollView>

          <View
            style={[
              styles.formFooter,
              { paddingBottom: Math.max(insets.bottom, 12), borderTopColor: colors.divider },
            ]}
          >
            <TouchableOpacity
              style={[styles.submit, { backgroundColor: colors.text, opacity: submitting ? 0.6 : 1 }]}
              onPress={() => void handleCreate()}
              disabled={submitting}
              accessibilityRole="button"
              accessibilityLabel={t.deals.createDeal}
            >
              {submitting ? (
                <ActivityIndicator color={colors.background} />
              ) : (
                <Text style={[styles.submitText, { color: colors.background }]}>{t.deals.createDeal}</Text>
              )}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyText: { fontSize: 15, textAlign: 'center' },
  columns: { flexDirection: 'row', paddingVertical: 12 },
  column: { width: 280, paddingHorizontal: 12 },
  columnHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12, paddingHorizontal: 4 },
  columnDot: { width: 10, height: 10, borderRadius: 4 },
  columnTitle: { fontSize: 14, fontWeight: '600', flex: 1 },
  columnCount: { fontSize: 12, fontWeight: '500' },
  columnContent: { flex: 1 },
  dealCard: { padding: 12, borderRadius: 8, borderWidth: 1, marginBottom: 8, gap: 10 },
  dealRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dealTitle: { fontSize: 14, fontWeight: '500', flex: 1 },
  dealText: { fontSize: 14 },
  addDeal: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 8,
    marginBottom: 24,
  },
  addDealText: { fontSize: 13, fontWeight: '500' },
  form: { flex: 1 },
  formHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  formHeaderText: { flex: 1 },
  formTitle: { fontSize: 17, fontWeight: '600' },
  formSub: { fontSize: 12, marginTop: 2 },
  formClose: { padding: 4 },
  formBody: { padding: 16, paddingBottom: 32 },
  chipsLabel: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1 },
  chipText: { fontSize: 13, fontWeight: '500' },
  formFooter: { paddingHorizontal: 16, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  submit: { paddingVertical: 14, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontSize: 15, fontWeight: '600' },
});
