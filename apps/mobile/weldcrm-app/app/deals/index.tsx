import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Building2, Calendar, ChevronDown, DollarSign, FileText, Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { StackHeader } from '@/components/headers';
import { OptionSheet } from '@/components/option-sheet';
import { api, type DealRecord, type PipelineWithStages } from '@/services/api';
import { interpolate, useI18n } from '@/lib/i18n';
import { formatMoney, resolveCurrency, sumInCurrency } from '@/lib/money';

/** Deals are read 100 at a time; this caps a board at 1,000 of them. */
const MAX_DEAL_PAGES = 10;

interface Column {
  id: string;
  title: string;
  color: string;
  deals: DealRecord[];
}

function buildColumns(pipeline: PipelineWithStages, deals: DealRecord[]): Column[] {
  return pipeline.stages.map((stage) => ({
    id: stage.id,
    title: stage.name,
    color: stage.color || '#6B7280',
    deals: deals.filter((deal) => deal.stageId === stage.id),
  }));
}

/** Reads a pipeline's deals page by page; `failed` when a page could not be loaded. */
async function fetchDeals(pipelineId: string): Promise<{ deals: DealRecord[]; failed: boolean }> {
  const deals: DealRecord[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_DEAL_PAGES; page += 1) {
    const res = await api.getDeals({ cursor, pipelineId });
    if (!res.success || !res.data) return { deals, failed: true };
    deals.push(...res.data.items);
    cursor = res.data.cursor;
    if (!res.data.hasMore || !cursor) break;
  }
  return { deals, failed: false };
}

export default function DealsScreen() {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const params = useLocalSearchParams<{ new?: string }>();

  const [pipelines, setPipelines] = useState<PipelineWithStages[]>([]);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [columns, setColumns] = useState<Column[]>([]);
  const [currency, setCurrency] = useState('EUR');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pipelinePickerVisible, setPipelinePickerVisible] = useState(false);
  const [moving, setMoving] = useState<DealRecord | null>(null);
  const loadedOnce = useRef(false);
  // The pipeline to show; a ref so a reload keeps the user's choice.
  const selectedRef = useRef<string | null>(null);

  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? null;

  // Bumped per load, so a slower earlier load (another pipeline) can't overwrite a newer one.
  const requestRef = useRef(0);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' | 'silent') => {
      const request = ++requestRef.current;
      const isStale = () => request !== requestRef.current;
      const finish = () => {
        loadedOnce.current = true;
        setLoading(false);
        setRefreshing(false);
      };
      if (mode === 'initial') setLoading(true);
      if (mode === 'refresh') setRefreshing(true);

      const [pipelinesRes, workspaceCurrency] = await Promise.all([api.getPipelines(), api.getWorkspaceCurrency()]);
      if (isStale()) return;
      const all = pipelinesRes.success && pipelinesRes.data ? pipelinesRes.data : null;
      // A failed quiet reload keeps the board that is showing.
      if (!all && mode === 'silent') return finish();
      const current = all?.find((p) => p.id === selectedRef.current) ?? all?.[0] ?? null;
      const result = current ? await fetchDeals(current.id) : null;
      if (isStale()) return;
      if (result?.failed && mode === 'silent') return finish();

      setCurrency(resolveCurrency(workspaceCurrency));
      setPipelines(all ?? []);
      selectedRef.current = current?.id ?? null;
      setPipelineId(current?.id ?? null);
      setColumns(current && result ? buildColumns(current, result.deals) : []);
      if (!all || result?.failed) toast.error(t.deals.loadFailed);
      finish();
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

  const startCreate = useCallback(
    (stageId?: string) => {
      if (!pipeline) return;
      router.push({ pathname: '/deal/new', params: { pipelineId: pipeline.id, stageId: stageId ?? '' } });
    },
    [pipeline],
  );

  // Home's "Create Deal" lands here with ?new=1: start in the first stage.
  useEffect(() => {
    if (params.new !== '1' || loading) return;
    router.setParams({ new: undefined });
    if (pipeline) startCreate(pipeline.stages[0]?.id);
    else toast.error(t.deals.noPipeline);
  }, [params.new, loading, pipeline, startCreate, t, toast]);

  const selectPipeline = (id: string | null) => {
    setPipelinePickerVisible(false);
    if (!id || id === pipelineId) return;
    selectedRef.current = id;
    void load('initial');
  };

  const moveDeal = async (deal: DealRecord, stageId: string | null) => {
    setMoving(null);
    if (!stageId || stageId === deal.stageId) return;
    // Optimistic move, reverted if the API refuses.
    const before = columns;
    setColumns((prev) =>
      prev.map((column) => ({
        ...column,
        deals:
          column.id === stageId
            ? [...column.deals, { ...deal, stageId }]
            : column.deals.filter((item) => item.id !== deal.id),
      })),
    );
    const res = await api.updateDeal(deal.id, { stageId });
    if (res.success && res.data) {
      const saved = res.data;
      setColumns((prev) =>
        prev.map((column) => ({
          ...column,
          deals: column.deals.map((item) => (item.id === saved.id ? saved : item)),
        })),
      );
      toast.success(interpolate(t.deals.movedToast, { stage: columns.find((c) => c.id === stageId)?.title ?? '' }));
    } else {
      setColumns(before);
      toast.error(typeof res.error === 'string' ? res.error : t.deals.moveFailed);
    }
  };

  const formatDate = (iso?: string) =>
    iso ? new Date(iso).toLocaleDateString(intlLocale, { day: 'numeric', month: 'short', year: 'numeric' }) : t.deals.noDate;

  const columnTotal = (column: Column) => {
    const total = sumInCurrency(
      column.deals.map((deal) => ({ amount: deal.value, currency: deal.currency })),
      currency,
    ).total;
    return total > 0 ? formatMoney(total, currency, intlLocale, { compact: true }) : null;
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader
        title={t.deals.title}
        onBack={() => router.back()}
        right={
          pipeline ? (
            <IconButton
              icon={<Plus size={22} color={colors.text} />}
              accessibilityLabel={t.deals.newDeal}
              onPress={() => startCreate(pipeline.stages[0]?.id)}
            />
          ) : null
        }
      />
      {pipelines.length > 0 && (
        <TouchableOpacity
          style={[styles.pipelineButton, { borderColor: colors.divider }]}
          onPress={() => setPipelinePickerVisible(true)}
          disabled={pipelines.length < 2}
          accessibilityRole="button"
          accessibilityLabel={`${t.deals.pipeline}: ${pipeline?.name ?? ''}`}
        >
          {pipeline?.color ? <View style={[styles.columnDot, { backgroundColor: pipeline.color }]} /> : null}
          <Text style={[styles.pipelineText, { color: colors.text }]} numberOfLines={1}>
            {pipeline?.name}
          </Text>
          {pipelines.length > 1 && <ChevronDown size={16} color={colors.muted} />}
        </TouchableOpacity>
      )}

      {loading && (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      )}

      {!loading && !pipeline && (
        <ScrollView
          contentContainerStyle={styles.center}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load('refresh')} />}
        >
          <Text style={[styles.emptyText, { color: colors.muted }]}>{t.deals.noPipeline}</Text>
        </ScrollView>
      )}

      {!loading && !!pipeline && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          bounces={false}
          directionalLockEnabled
          contentContainerStyle={styles.columns}
        >
          {columns.map((column) => {
            const total = columnTotal(column);
            return (
              <View key={column.id} style={styles.column}>
                <View style={styles.columnHeader}>
                  <View style={[styles.columnDot, { backgroundColor: column.color }]} />
                  <Text style={[styles.columnTitle, { color: colors.text }]} numberOfLines={1}>
                    {column.title}
                  </Text>
                  <Text style={[styles.columnCount, { color: colors.muted }]}>
                    {total ? `${total} · ` : ''}
                    {column.deals.length}
                  </Text>
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
                      onPress={() => router.push({ pathname: '/deal/[id]', params: { id: deal.id, name: deal.name } })}
                      onLongPress={() => setMoving(deal)}
                      accessibilityRole="button"
                      accessibilityLabel={deal.name}
                      accessibilityHint={t.deals.longPressHint}
                    >
                      <View style={styles.dealRow}>
                        <FileText size={16} color="#9CA3AF" strokeWidth={1.5} />
                        <Text style={[styles.dealTitle, { color: colors.text }]} numberOfLines={1}>
                          {deal.name}
                        </Text>
                      </View>
                      {!!deal.companyName && (
                        <View style={styles.dealRow}>
                          <Building2 size={16} color="#9CA3AF" strokeWidth={1.5} />
                          <Text style={[styles.dealText, { color: colors.muted }]} numberOfLines={1}>
                            {deal.companyName}
                          </Text>
                        </View>
                      )}
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
            );
          })}
        </ScrollView>
      )}

      <OptionSheet<string>
        visible={pipelinePickerVisible}
        title={t.deals.pipeline}
        options={pipelines.map((p) => ({ value: p.id, label: p.name, color: p.color }))}
        selected={pipelineId}
        onSelect={selectPipeline}
        onClose={() => setPipelinePickerVisible(false)}
      />
      <OptionSheet<string>
        visible={!!moving}
        title={moving ? interpolate(t.deals.moveTo, { name: moving.name }) : ''}
        options={columns.map((column) => ({ value: column.id, label: column.title, color: column.color }))}
        selected={moving?.stageId ?? null}
        onSelect={(stageId) => moving && void moveDeal(moving, stageId)}
        onClose={() => setMoving(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyText: { fontSize: 15, textAlign: 'center' },
  pipelineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    marginTop: 12,
    marginHorizontal: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: '90%',
  },
  pipelineText: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
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
  dealText: { fontSize: 14, flexShrink: 1 },
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
});
