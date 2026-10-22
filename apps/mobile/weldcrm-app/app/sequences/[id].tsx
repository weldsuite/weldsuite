import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { MoreHorizontal, Pause, Play, Plus, UserMinus, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { StackHeader } from '@/components/headers';
import { PersonPicker } from '@/components/company-picker';
import { usePagedList } from '@/hooks/use-paged-list';
import { sequencesApi, type CrmSequence, type SequenceEnrollment } from '@/services/sequences';
import { initialsOf } from '@/lib/crm';
import { interpolate, labelFor, useI18n } from '@/lib/i18n';

type StatusFilter = 'all' | 'active' | 'paused' | 'pending' | 'completed' | 'failed';
type SequenceAction = 'launch' | 'pause' | 'resume';
type LoadMode = 'initial' | 'refresh' | 'silent';

const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'active', 'paused', 'pending', 'completed', 'failed'];

const SEQUENCE_COLORS: Record<string, string> = {
  draft: '#6B7280',
  active: '#10B981',
  paused: '#F59E0B',
  archived: '#9CA3AF',
};

const ENROLLMENT_COLORS: Record<string, string> = {
  pending: '#3B82F6',
  active: '#10B981',
  paused: '#F59E0B',
  completed: '#6366F1',
  failed: '#EF4444',
  unenrolled: '#9CA3AF',
};

/** Statuses an enrollment can still be pulled out of. */
const UNENROLLABLE = new Set(['pending', 'active', 'paused', 'failed']);

const canAct = (status: string) => UNENROLLABLE.has(status);

export default function SequenceDetailScreen() {
  const { colors } = useTheme();
  const { t, plural, intlLocale } = useI18n();
  const toast = useToast();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const id = params.id;

  const [sequence, setSequence] = useState<CrmSequence | null>(null);
  const [sequenceLoading, setSequenceLoading] = useState(true);
  const [sequenceError, setSequenceError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [target, setTarget] = useState<SequenceEnrollment | null>(null);
  const [picking, setPicking] = useState(false);

  const requestId = useRef(0);
  const loadedOnce = useRef(false);

  const loadSequence = useCallback(
    async (mode: LoadMode) => {
      const current = ++requestId.current;
      if (mode === 'initial') setSequenceLoading(true);
      const res = await sequencesApi.getSequence(id);
      if (current !== requestId.current) return;
      if (res.success && res.data) {
        setSequence(res.data);
        setSequenceError(false);
        loadedOnce.current = true;
      } else if (mode !== 'silent') {
        setSequenceError(true);
      }
      setSequenceLoading(false);
    },
    [id],
  );

  useEffect(() => {
    void loadSequence('initial');
  }, [loadSequence]);

  const fetchEnrollments = useCallback(
    (page: { cursor: string | null; search: string }) =>
      sequencesApi.getEnrollments(id, { ...page, status: statusFilter === 'all' ? undefined : statusFilter }),
    [id, statusFilter],
  );
  const enrollments = usePagedList<SequenceEnrollment>(fetchEnrollments, { search, resetKey: statusFilter });

  useFocusEffect(
    useCallback(() => {
      // The first focus is the initial load above; later ones refetch quietly.
      if (loadedOnce.current) void loadSequence('silent');
    }, [loadSequence]),
  );

  useEffect(() => {
    if (sequenceError) toast.error(t.sequences.notFound);
  }, [sequenceError, t, toast]);

  useEffect(() => {
    if (enrollments.error) toast.error(t.sequences.peopleLoadFailed);
  }, [enrollments.error, t, toast]);

  const title = sequence?.name ?? params.name ?? t.sequences.title;
  const status = sequence?.status ?? '';

  const refreshAll = async () => {
    await Promise.all([loadSequence('refresh'), enrollments.refresh()]);
  };

  const formatDate = (value: string) =>
    new Date(value).toLocaleDateString(intlLocale, { day: 'numeric', month: 'short', year: 'numeric' });

  // ---- Sequence actions -------------------------------------------------

  const runSequenceAction = async (action: SequenceAction) => {
    setBusy(true);
    const res =
      action === 'launch'
        ? await sequencesApi.launch(id)
        : action === 'pause'
          ? await sequencesApi.pause(id)
          : await sequencesApi.resume(id);
    setBusy(false);
    if (res.success) {
      toast.success(
        action === 'launch' ? t.sequences.launchedToast : action === 'pause' ? t.sequences.pausedToast : t.sequences.resumedToast,
      );
      await Promise.all([loadSequence('silent'), enrollments.refresh()]);
      return;
    }
    const failed =
      action === 'launch' ? t.sequences.launchFailed : action === 'pause' ? t.sequences.pauseFailed : t.sequences.resumeFailed;
    // Launching is refused with a reason ("add a step first"), which is worth showing as-is.
    toast.error(action === 'launch' && typeof res.error === 'string' ? res.error : failed);
  };

  const confirmSequenceAction = (action: SequenceAction) => {
    const copy =
      action === 'launch'
        ? { title: t.sequences.launchTitle, message: t.sequences.launchMessage, button: t.sequences.launch }
        : action === 'pause'
          ? { title: t.sequences.pauseTitle, message: t.sequences.pauseMessage, button: t.sequences.pause }
          : { title: t.sequences.resumeTitle, message: t.sequences.resumeMessage, button: t.sequences.resume };
    Alert.alert(copy.title, interpolate(copy.message, { name: title }), [
      { text: t.common.cancel, style: 'cancel' },
      { text: copy.button, onPress: () => void runSequenceAction(action) },
    ]);
  };

  // ---- Enrollment actions -----------------------------------------------

  const enroll = async (personId: string, name: string) => {
    const res = await sequencesApi.enrollPerson(id, personId);
    if (!res.success || !res.data) {
      toast.error(t.sequences.enrollFailed);
      return;
    }
    if (res.data.enrolled === 0) {
      toast.info(interpolate(t.sequences.alreadyEnrolled, { name }));
      return;
    }
    toast.success(interpolate(t.sequences.enrolledToast, { name }));
    await Promise.all([loadSequence('silent'), enrollments.refresh()]);
  };

  const handlePicked = (personId: string, name: string) => {
    setPicking(false);
    if (status === 'active') {
      // On a running sequence the first email can go out right away.
      Alert.alert(t.sequences.enroll, interpolate(t.sequences.enrollActiveMessage, { name, sequence: title }), [
        { text: t.common.cancel, style: 'cancel' },
        { text: t.sequences.enroll, onPress: () => void enroll(personId, name) },
      ]);
      return;
    }
    void enroll(personId, name);
  };

  const pauseEnrollment = async (item: SequenceEnrollment) => {
    const res = await sequencesApi.pauseEnrollment(id, item.id);
    if (res.success) {
      enrollments.updateItem({ ...item, status: 'paused' });
      toast.success(interpolate(t.sequences.pausedEnrollmentToast, { name: item.name }));
      void loadSequence('silent');
    } else {
      toast.error(t.sequences.pauseEnrollmentFailed);
    }
  };

  const resumeEnrollment = async (item: SequenceEnrollment) => {
    if (status === 'paused') {
      // The server refuses this too: the person's run would just park again.
      toast.info(t.sequences.resumeSequenceFirst);
      return;
    }
    const res = await sequencesApi.resumeEnrollment(id, item.id);
    if (res.success) {
      enrollments.updateItem({ ...item, status: 'active' });
      toast.success(interpolate(t.sequences.resumedEnrollmentToast, { name: item.name }));
      void loadSequence('silent');
    } else {
      toast.error(t.sequences.resumeEnrollmentFailed);
    }
  };

  const unenroll = async (item: SequenceEnrollment) => {
    const res = await sequencesApi.unenroll(item.id);
    if (res.success) {
      if (statusFilter === 'all') {
        enrollments.updateItem({ ...item, status: 'unenrolled' });
      } else {
        enrollments.removeItem(item.id);
      }
      toast.success(interpolate(t.sequences.unenrolledToast, { name: item.name }));
      void loadSequence('silent');
    } else {
      toast.error(t.sequences.unenrollFailed);
    }
  };

  const confirmUnenroll = (item: SequenceEnrollment) => {
    Alert.alert(t.sequences.unenrollTitle, interpolate(t.sequences.unenrollMessage, { name: item.name }), [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.sequences.unenroll, style: 'destructive', onPress: () => void unenroll(item) },
    ]);
  };

  const closeSheet = () => setTarget(null);

  const openPerson = (item: SequenceEnrollment) => {
    router.push({ pathname: '/person/[id]', params: { id: item.personId, name: item.name } });
  };

  // ---- Rendering --------------------------------------------------------

  const filterLabel = (value: StatusFilter) =>
    value === 'all' ? t.sequences.filterAll : labelFor(t.sequences.enrollmentStatus, value);

  const stats: { key: string; label: string; value: number }[] = sequence
    ? [
        { key: 'enrolled', label: t.sequences.stats.enrolled, value: sequence.enrolledCount },
        { key: 'active', label: t.sequences.stats.active, value: sequence.activeCount },
        { key: 'pending', label: t.sequences.stats.pending, value: sequence.pendingCount },
        ...(sequence.completedCount === undefined
          ? []
          : [{ key: 'completed', label: t.sequences.stats.completed, value: sequence.completedCount }]),
        ...(sequence.failedCount === undefined
          ? []
          : [{ key: 'failed', label: t.sequences.stats.failed, value: sequence.failedCount }]),
      ]
    : [];

  const action: { kind: SequenceAction; label: string; Icon: typeof Play } | null =
    status === 'draft'
      ? { kind: 'launch', label: t.sequences.launch, Icon: Play }
      : status === 'active'
        ? { kind: 'pause', label: t.sequences.pause, Icon: Pause }
        : status === 'paused'
          ? { kind: 'resume', label: t.sequences.resume, Icon: Play }
          : null;

  const renderSummary = () => {
    if (!sequence) {
      return (
        <View style={styles.summaryEmpty}>
          {sequenceLoading ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={[styles.emptyText, { color: colors.muted }]}>{t.sequences.notFound}</Text>
          )}
        </View>
      );
    }
    const color = SEQUENCE_COLORS[sequence.status] ?? '#6B7280';
    const lastRun = sequence.lastRunAt
      ? interpolate(t.sequences.lastRun, { date: formatDate(sequence.lastRunAt) })
      : t.sequences.neverRun;
    const primary = action?.kind !== 'pause';
    return (
      <View style={styles.summary}>
        <View style={styles.summaryTop}>
          <View style={[styles.statusBadge, { backgroundColor: `${color}20` }]}>
            <Text style={[styles.statusText, { color }]}>{labelFor(t.sequences.status, sequence.status)}</Text>
          </View>
          <Text style={[styles.summaryMeta, { color: colors.muted }]} numberOfLines={1}>
            {[plural(sequence.stepCount, t.sequences.stepCount), lastRun].join(' · ')}
          </Text>
        </View>
        {!!sequence.description && (
          <Text style={[styles.description, { color: colors.text }]}>{sequence.description}</Text>
        )}
        <View style={styles.stats}>
          {stats.map((stat) => (
            <View key={stat.key} style={[styles.stat, { borderColor: colors.divider }]}>
              <Text style={[styles.statValue, { color: colors.text }]}>{stat.value}</Text>
              <Text style={[styles.statLabel, { color: colors.muted }]} numberOfLines={1}>
                {stat.label}
              </Text>
            </View>
          ))}
        </View>
        {action && (
          <TouchableOpacity
            style={[
              styles.actionButton,
              primary
                ? { backgroundColor: colors.text, borderColor: colors.text }
                : { backgroundColor: 'transparent', borderColor: colors.buttonBorder },
              { opacity: busy ? 0.6 : 1 },
            ]}
            onPress={() => confirmSequenceAction(action.kind)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityState={{ disabled: busy, busy }}
          >
            {busy ? (
              <ActivityIndicator color={primary ? colors.background : colors.text} />
            ) : (
              <>
                <action.Icon size={16} color={primary ? colors.background : colors.text} />
                <Text style={[styles.actionButtonText, { color: primary ? colors.background : colors.text }]}>
                  {action.label}
                </Text>
              </>
            )}
          </TouchableOpacity>
        )}
        <Text style={[styles.hint, { color: colors.muted }]}>{t.sequences.webOnlyHint}</Text>
      </View>
    );
  };

  const header = (
    <View>
      {renderSummary()}
      <Text style={[styles.sectionTitle, { color: colors.text }]} accessibilityRole="header">
        {t.sequences.peopleTitle}
      </Text>
      <View style={[styles.searchBar, { backgroundColor: colors.inputBackground }]}>
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder={t.sequences.searchPeople}
          placeholderTextColor={colors.muted}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t.sequences.searchPeople}
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
        {STATUS_FILTERS.map((value) => {
          const selected = statusFilter === value;
          return (
            <TouchableOpacity
              key={value}
              style={[
                styles.filterButton,
                { backgroundColor: selected ? colors.text : 'transparent', borderColor: selected ? colors.text : colors.divider },
              ]}
              onPress={() => setStatusFilter(value)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={filterLabel(value)}
            >
              <Text style={[styles.filterButtonText, { color: selected ? colors.background : colors.text }]}>
                {filterLabel(value)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );

  const renderEmpty = () => {
    if (enrollments.loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      );
    }
    if (enrollments.error) {
      return (
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t.sequences.peopleLoadFailed}</Text>
          <Text style={[styles.emptyText, { color: colors.muted }]}>{t.common.pullToRetry}</Text>
        </View>
      );
    }
    const filtered = !!search || statusFilter !== 'all';
    return (
      <View style={styles.emptyState}>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          {filtered ? t.sequences.peopleEmptyFiltered : t.sequences.peopleEmpty}
        </Text>
        {!filtered && <Text style={[styles.emptyText, { color: colors.muted }]}>{t.sequences.peopleEmptyHint}</Text>}
      </View>
    );
  };

  const renderEnrollment = ({ item }: { item: SequenceEnrollment }) => {
    const color = ENROLLMENT_COLORS[item.status] ?? '#6B7280';
    const statusLabel = labelFor(t.sequences.enrollmentStatus, item.status);
    const showProgress = (item.status === 'active' || item.status === 'paused') && item.totalSteps > 0;
    const detail = [
      item.companyName ?? item.email,
      showProgress
        ? interpolate(t.sequences.stepProgress, {
            current: Math.min(item.currentStepIndex + 1, item.totalSteps),
            total: item.totalSteps,
          })
        : interpolate(t.sequences.enrolledOn, { date: formatDate(item.enrolledAt) }),
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <View style={[styles.row, { borderBottomColor: colors.divider }]}>
        <TouchableOpacity
          style={styles.rowMain}
          activeOpacity={0.7}
          onPress={() => openPerson(item)}
          accessibilityRole="button"
          accessibilityLabel={`${item.name}, ${statusLabel}`}
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initialsOf(item.name)}</Text>
          </View>
          <View style={styles.rowText}>
            <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={[styles.sub, { color: colors.muted }]} numberOfLines={1}>
              {detail}
            </Text>
            {item.status === 'failed' && !!item.errorMessage && (
              <Text style={[styles.sub, { color: colors.destructive }]} numberOfLines={2}>
                {item.errorMessage}
              </Text>
            )}
          </View>
          <View style={[styles.statusBadge, { backgroundColor: `${color}20` }]}>
            <Text style={[styles.statusText, { color }]}>{statusLabel}</Text>
          </View>
        </TouchableOpacity>
        {canAct(item.status) ? (
          <TouchableOpacity
            style={styles.moreButton}
            onPress={() => setTarget(item)}
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
            accessibilityRole="button"
            accessibilityLabel={interpolate(t.sequences.actionsFor, { name: item.name })}
          >
            <MoreHorizontal size={20} color={colors.muted} />
          </TouchableOpacity>
        ) : (
          <View style={styles.moreButton} />
        )}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader
        title={title}
        onBack={() => router.back()}
        right={
          sequence ? (
            <TouchableOpacity
              style={styles.iconButton}
              onPress={() => setPicking(true)}
              accessibilityRole="button"
              accessibilityLabel={t.sequences.enroll}
            >
              <Plus size={24} color={colors.text} />
            </TouchableOpacity>
          ) : null
        }
      />

      <FlatList
        data={enrollments.items}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={enrollments.refreshing} onRefresh={() => void refreshAll()} />}
        onEndReached={() => void enrollments.loadMore()}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={header}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={
          enrollments.loadingMore ? <ActivityIndicator style={styles.footerSpinner} color={colors.text} /> : null
        }
        renderItem={renderEnrollment}
      />

      <PersonPicker
        visible={picking}
        onClose={() => setPicking(false)}
        onSelect={(person) => handlePicked(person.id, person.name)}
      />

      <Modal visible={!!target} animationType="fade" transparent onRequestClose={closeSheet}>
        <TouchableOpacity style={styles.menuOverlay} activeOpacity={1} onPress={closeSheet}>
          <View style={[styles.menuCard, { backgroundColor: colors.background }]}>
            <View style={[styles.menuHeader, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.menuName, { color: colors.text }]} numberOfLines={1}>
                {target?.name}
              </Text>
              <TouchableOpacity onPress={closeSheet} accessibilityRole="button" accessibilityLabel={t.common.close}>
                <X size={20} color={colors.muted} />
              </TouchableOpacity>
            </View>
            {target?.status === 'active' && (
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => {
                  const item = target;
                  closeSheet();
                  void pauseEnrollment(item);
                }}
                accessibilityRole="button"
                accessibilityLabel={t.sequences.pauseEnrollment}
              >
                <Pause size={20} color={colors.text} />
                <Text style={[styles.menuItemText, { color: colors.text }]}>{t.sequences.pauseEnrollment}</Text>
              </TouchableOpacity>
            )}
            {target?.status === 'paused' && (
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => {
                  const item = target;
                  closeSheet();
                  void resumeEnrollment(item);
                }}
                accessibilityRole="button"
                accessibilityLabel={t.sequences.resumeEnrollment}
              >
                <Play size={20} color={colors.text} />
                <Text style={[styles.menuItemText, { color: colors.text }]}>{t.sequences.resumeEnrollment}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.menuItem}
              onPress={() => {
                const item = target;
                closeSheet();
                if (item) confirmUnenroll(item);
              }}
              accessibilityRole="button"
              accessibilityLabel={t.sequences.unenroll}
            >
              <UserMinus size={20} color={colors.destructive} />
              <Text style={[styles.menuItemText, { color: colors.destructive }]}>{t.sequences.unenroll}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 48 },
  iconButton: { padding: 8 },
  listContent: { flexGrow: 1, paddingBottom: 24 },
  footerSpinner: { paddingVertical: 16 },
  summary: { padding: 16, gap: 12 },
  summaryEmpty: { padding: 32, alignItems: 'center' },
  summaryTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  summaryMeta: { flex: 1, fontSize: 13 },
  description: { fontSize: 14 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { minWidth: 92, flexGrow: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  statValue: { fontSize: 18, fontWeight: '700' },
  statLabel: { fontSize: 11, marginTop: 2 },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  actionButtonText: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 12 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  statusText: { fontSize: 11, fontWeight: '600' },
  sectionTitle: { fontSize: 17, fontWeight: '600', paddingHorizontal: 16, paddingTop: 8 },
  searchBar: { marginHorizontal: 16, marginTop: 10, marginBottom: 4, borderRadius: 10 },
  searchInput: { paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  filterList: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  filterButton: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  filterButtonText: { fontSize: 13, fontWeight: '500' },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 48, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginBottom: 6, textAlign: 'center' },
  emptyText: { fontSize: 13, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, paddingRight: 8 },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 16, paddingVertical: 12 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#E0E7FF', alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 13, fontWeight: '600', color: '#4F46E5' },
  rowText: { flex: 1 },
  name: { fontSize: 15, fontWeight: '500' },
  sub: { fontSize: 12, marginTop: 2 },
  moreButton: { width: 36, alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  menuOverlay: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.5)', justifyContent: 'flex-end' },
  menuCard: { borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 34 },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    gap: 12,
  },
  menuName: { flex: 1, fontSize: 16, fontWeight: '600' },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 14 },
  menuItemText: { fontSize: 16 },
});
