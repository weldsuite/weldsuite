import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { MoreHorizontal, Pause, Play, Plus, UserMinus, Users, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { StackHeader } from '@/components/headers';
import { InitialsTile, Pill, RecordRow } from '@/components/record-row';
import { PersonPicker } from '@/components/company-picker';
import { usePagedList } from '@/hooks/use-paged-list';
import { sequencesApi, type CrmSequence, type SequenceEnrollment } from '@/services/sequences';
import { interpolate, labelFor, useI18n } from '@/lib/i18n';

type StatusFilter = 'all' | 'active' | 'paused' | 'pending' | 'completed' | 'failed';
type SequenceAction = 'launch' | 'pause' | 'resume';

const SEQUENCE_ACTION_CALLS: Record<SequenceAction, (id: string) => ReturnType<typeof sequencesApi.launch>> = {
  launch: (id) => sequencesApi.launch(id),
  pause: (id) => sequencesApi.pause(id),
  resume: (id) => sequencesApi.resume(id),
};

/** The run action a sequence offers in each status; other statuses offer none. */
const STATUS_ACTIONS: Record<string, SequenceAction | undefined> = {
  draft: 'launch',
  active: 'pause',
  paused: 'resume',
};
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

  const actionCopy: Record<
    SequenceAction,
    { title: string; message: string; button: string; done: string; failed: string }
  > = {
    launch: {
      title: t.sequences.launchTitle,
      message: t.sequences.launchMessage,
      button: t.sequences.launch,
      done: t.sequences.launchedToast,
      failed: t.sequences.launchFailed,
    },
    pause: {
      title: t.sequences.pauseTitle,
      message: t.sequences.pauseMessage,
      button: t.sequences.pause,
      done: t.sequences.pausedToast,
      failed: t.sequences.pauseFailed,
    },
    resume: {
      title: t.sequences.resumeTitle,
      message: t.sequences.resumeMessage,
      button: t.sequences.resume,
      done: t.sequences.resumedToast,
      failed: t.sequences.resumeFailed,
    },
  };

  const runSequenceAction = async (action: SequenceAction) => {
    setBusy(true);
    const res = await SEQUENCE_ACTION_CALLS[action](id);
    setBusy(false);
    if (res.success) {
      toast.success(actionCopy[action].done);
      await Promise.all([loadSequence('silent'), enrollments.refresh()]);
      return;
    }
    // Launching is refused with a reason ("add a step first"), which is worth showing as-is.
    toast.error(action === 'launch' && typeof res.error === 'string' ? res.error : actionCopy[action].failed);
  };

  const confirmSequenceAction = (action: SequenceAction) => {
    const copy = actionCopy[action];
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

  const actionKind = STATUS_ACTIONS[status];
  const action: { kind: SequenceAction; label: string; Icon: typeof Play } | null = actionKind
    ? { kind: actionKind, label: actionCopy[actionKind].button, Icon: actionKind === 'pause' ? Pause : Play }
    : null;

  const renderSummary = () => {
    if (!sequence) {
      return (
        <View style={styles.summaryEmpty}>
          {sequenceLoading ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <Text style={[styles.notFound, { color: colors.mutedForeground }]}>{t.sequences.notFound}</Text>
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
          <Pill label={labelFor(t.sequences.status, sequence.status)} color={color} />
          <Text style={[styles.summaryMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
            {[plural(sequence.stepCount, t.sequences.stepCount), lastRun].join(' · ')}
          </Text>
        </View>
        {!!sequence.description && (
          <Text style={[styles.description, { color: colors.text }]}>{sequence.description}</Text>
        )}
        <View style={styles.stats}>
          {stats.map((stat) => (
            <View key={stat.key} style={styles.stat}>
              <Text style={[styles.statValue, { color: colors.text }]}>{stat.value}</Text>
              <Text style={[styles.statLabel, { color: colors.mutedForeground }]} numberOfLines={1}>
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
        <Text style={[styles.hint, { color: colors.mutedForeground }]}>{t.sequences.webOnlyHint}</Text>
      </View>
    );
  };

  const header = (
    <View>
      {renderSummary()}
      <Text style={[styles.sectionTitle, { color: colors.text }]} accessibilityRole="header">
        {t.sequences.peopleTitle}
      </Text>
      <View style={styles.controls}>
        <SearchBar
          value={search}
          onChangeText={setSearch}
          placeholder={t.sequences.searchPeople}
          autoCapitalize="none"
          autoCorrect={false}
          containerStyle={styles.search}
        />
        <View style={styles.chips}>
          {STATUS_FILTERS.map((value) => (
            <Chip
              key={value}
              label={filterLabel(value)}
              selected={statusFilter === value}
              onPress={() => setStatusFilter(value)}
            />
          ))}
        </View>
      </View>
    </View>
  );

  const renderEmpty = () => {
    const icon = <Users size={32} color={colors.mutedForeground} />;
    if (enrollments.loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      );
    }
    if (enrollments.error) {
      return <EmptyState icon={icon} title={t.sequences.peopleLoadFailed} description={t.common.pullToRetry} />;
    }
    const filtered = !!search || statusFilter !== 'all';
    return (
      <EmptyState
        icon={icon}
        title={filtered ? t.sequences.peopleEmptyFiltered : t.sequences.peopleEmpty}
        description={filtered ? undefined : t.sequences.peopleEmptyHint}
      />
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
      <RecordRow
        leading={<InitialsTile name={item.name} round />}
        title={item.name}
        subtitle={detail}
        meta={item.status === 'failed' && item.errorMessage ? item.errorMessage : undefined}
        metaColor={colors.destructive}
        badge={
          <View style={styles.badgeRow}>
            <Pill label={statusLabel} color={color} />
            {canAct(item.status) ? (
              <IconButton
                icon={<MoreHorizontal size={20} color={colors.mutedForeground} />}
                size="sm"
                accessibilityLabel={interpolate(t.sequences.actionsFor, { name: item.name })}
                onPress={() => setTarget(item)}
              />
            ) : (
              <View style={styles.badgeSpacer} />
            )}
          </View>
        }
        onPress={() => openPerson(item)}
      />
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
            <IconButton
              icon={<Plus size={24} color={colors.text} />}
              accessibilityLabel={t.sequences.enroll}
              onPress={() => setPicking(true)}
            />
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
  listContent: { flexGrow: 1, paddingBottom: 24 },
  footerSpinner: { paddingVertical: 16 },
  summary: { padding: 16, gap: 12 },
  summaryEmpty: { padding: 32, alignItems: 'center' },
  notFound: { fontSize: 13, textAlign: 'center' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, rowGap: 6 },
  stat: { flexDirection: 'row', alignItems: 'baseline', gap: 5 },
  statValue: { fontSize: 17, fontWeight: '700' },
  statLabel: { fontSize: 13 },
  controls: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, gap: 10 },
  search: { borderRadius: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  badgeSpacer: { width: 32 },
  summaryTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  summaryMeta: { flex: 1, fontSize: 13 },
  description: { fontSize: 14 },
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
  sectionTitle: { fontSize: 17, fontWeight: '600', paddingHorizontal: 16, paddingTop: 8 },
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
