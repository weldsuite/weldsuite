/**
 * Time tracking on mobile: the task's Time card (start/stop a timer, log time
 * by hand), the running-timer bar above the tab bar, and the shared duration
 * formatting. Backed by flow-api `/api/time-entries` (one timer per user; a
 * stopped timer becomes a draft time entry).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Clock, Play, Square, Trash2, Plus } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';

import { BRAND, BRAND_TINT } from '@/lib/brand';
import { useKeyboardHeight } from '@/lib/keyboard';
import { SectionCard } from '@/components/detail';
import {
  useCreateTimeEntry,
  useDiscardTimer,
  useRunningTimer,
  useStartTimer,
  useStopTimer,
  useTask,
  useTimeEntries,
} from '@/hooks/use-weldflow';
import { useI18n } from '@/lib/i18n';
import {
  addDays,
  deviceTimeZone,
  elapsedMs,
  entryMinutes,
  formatElapsed,
  fromDateKey,
  parseLoggedMinutes,
  splitMinutes,
  toDateKey,
} from '@/lib/time-tracking';

/** Days the "Log time" sheet offers: today and the six before it. */
const LOGGABLE_DAYS = 7;

/** Current time, re-read every `intervalMs` while `active`. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/** "1h 05m" / "45m" in the app language. */
export function useFormatMinutes(): (minutes: number) => string {
  const { t, format } = useI18n();
  return useCallback(
    (minutes: number) => {
      const split = splitMinutes(minutes);
      if (split.hours === 0) return format(t.time.minutesOnly, { minutes: split.minutes });
      return format(t.time.hoursMinutes, {
        hours: split.hours,
        minutes: String(split.minutes).padStart(2, '0'),
      });
    },
    [t, format],
  );
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// ============================================================================
// Task Time card
// ============================================================================

export function TaskTimeCard({ projectId, taskId }: Readonly<{ projectId: string; taskId: string }>) {
  const { colors } = useTheme();
  const toast = useToast();
  const { t, format } = useI18n();
  const formatMinutes = useFormatMinutes();

  const timerQuery = useRunningTimer();
  const timer = timerQuery.data ?? null;
  const runningHere = timer?.taskId === taskId;
  const runningElsewhere = !!timer && !runningHere;
  const now = useNow(runningHere);

  // The caller's own entries on this task; 500 is the API's page cap.
  const entriesQuery = useTimeEntries({ taskId, limit: 500 });
  const loggedMinutes = useMemo(
    () => (entriesQuery.data?.data ?? []).reduce((sum, e) => sum + entryMinutes(e), 0),
    [entriesQuery.data],
  );

  const startTimer = useStartTimer();
  const stopTimer = useStopTimer();
  const discardTimer = useDiscardTimer();
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const busy = startTimer.isPending || stopTimer.isPending || discardTimer.isPending;

  const start = async () => {
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await startTimer.mutateAsync({ projectId, taskId });
    } catch (err) {
      // 409: a timer started elsewhere (web, another device) in the meantime.
      void timerQuery.refetch();
      toast.error(errorMessage(err, t.time.startFailed));
    }
  };

  const stop = async (): Promise<boolean> => {
    try {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const res = await stopTimer.mutateAsync({ timeZone: deviceTimeZone() });
      toast.success(format(t.time.stopped, { time: formatMinutes(Number(res.data.duration)) }));
      return true;
    } catch (err) {
      void timerQuery.refetch();
      toast.error(errorMessage(err, t.time.stopFailed));
      return false;
    }
  };

  const switchToThisTask = async () => {
    setConfirmSwitch(false);
    if (await stop()) await start();
  };

  const discard = async () => {
    setConfirmDiscard(false);
    try {
      await discardTimer.mutateAsync();
    } catch (err) {
      toast.error(errorMessage(err, t.time.discardFailed));
    }
  };

  return (
    <SectionCard title={t.time.title}>
      {runningHere && timer ? (
        <View style={styles.runningRow}>
          <View style={[styles.dot, { backgroundColor: BRAND }]} />
          <Text
            style={[styles.elapsed, { color: colors.text }]}
            accessibilityLabel={t.time.running}
          >
            {formatElapsed(elapsedMs(timer.startedAt, now))}
          </Text>
        </View>
      ) : (
        <Text style={[styles.summary, { color: colors.mutedForeground }]}>
          {loggedMinutes > 0
            ? format(t.time.loggedOnTask, { time: formatMinutes(loggedMinutes) })
            : t.time.noTimeOnTask}
        </Text>
      )}
      {runningElsewhere ? (
        <Text style={[styles.note, { color: colors.mutedForeground }]}>
          {t.time.runningElsewhere}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {runningHere ? (
          <>
            <Button
              title={t.time.stop}
              size="sm"
              leftIcon={<Square size={14} color="#fff" fill="#fff" />}
              onPress={() => void stop()}
              loading={stopTimer.isPending}
              disabled={busy}
              style={styles.flex}
            />
            <Button
              title={t.time.discard}
              size="sm"
              variant="outline"
              leftIcon={<Trash2 size={14} color={colors.destructive} />}
              onPress={() => setConfirmDiscard(true)}
              disabled={busy}
            />
          </>
        ) : (
          <Button
            title={t.time.start}
            size="sm"
            leftIcon={<Play size={14} color="#fff" fill="#fff" />}
            onPress={() => (runningElsewhere ? setConfirmSwitch(true) : void start())}
            loading={startTimer.isPending}
            disabled={busy || timerQuery.isLoading}
            style={styles.flex}
          />
        )}
        <Button
          title={t.time.logTime}
          size="sm"
          variant="outline"
          leftIcon={<Plus size={14} color={colors.text} />}
          onPress={() => setLogOpen(true)}
        />
      </View>

      <ConfirmModal
        visible={confirmSwitch}
        title={t.time.switchTitle}
        message={t.time.switchMessage}
        confirmText={t.time.switchConfirm}
        cancelText={t.common.cancel}
        onCancel={() => setConfirmSwitch(false)}
        onConfirm={() => void switchToThisTask()}
      />
      <ConfirmModal
        visible={confirmDiscard}
        title={t.time.discardTitle}
        message={t.time.discardMessage}
        confirmText={t.time.discard}
        cancelText={t.common.cancel}
        variant="destructive"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => void discard()}
      />
      <LogTimeSheet
        visible={logOpen}
        projectId={projectId}
        taskId={taskId}
        onClose={() => setLogOpen(false)}
      />
    </SectionCard>
  );
}

// ============================================================================
// Log time sheet
// ============================================================================

function LogTimeSheet({
  visible,
  projectId,
  taskId,
  onClose,
}: Readonly<{ visible: boolean; projectId: string; taskId: string; onClose: () => void }>) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const toast = useToast();
  const { t, format, intlLocale } = useI18n();
  const formatMinutes = useFormatMinutes();
  const createEntry = useCreateTimeEntry();

  const [hours, setHours] = useState('');
  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const today = toDateKey(new Date());
  const [day, setDay] = useState(today);

  // Fresh form on every open.
  useEffect(() => {
    if (!visible) return;
    setHours('');
    setMinutes('');
    setNote('');
    setError(null);
    setDay(toDateKey(new Date()));
  }, [visible]);

  const days = useMemo(
    () => Array.from({ length: LOGGABLE_DAYS }, (_, i) => addDays(today, -i)),
    [today],
  );

  const dayLabel = (key: string, index: number) => {
    if (index === 0) return t.time.today;
    if (index === 1) return t.time.yesterday;
    return fromDateKey(key).toLocaleDateString(intlLocale, { weekday: 'short', day: 'numeric' });
  };

  const save = async () => {
    const total = parseLoggedMinutes(hours, minutes);
    if (total === null) {
      setError(t.time.invalidDuration);
      return;
    }
    try {
      await createEntry.mutateAsync({
        projectId,
        taskId,
        date: day,
        duration: total,
        description: note.trim() || undefined,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success(format(t.time.logged, { time: formatMinutes(total) }));
      onClose();
    } catch (err) {
      // The server refuses e.g. a day over the workspace's daily limit.
      setError(errorMessage(err, t.time.logFailed));
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: colors.cardBackground,
              paddingBottom: (keyboardHeight || insets.bottom) + 16,
            },
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={[styles.sheetTitle, { color: colors.text }]}>{t.time.logTime}</Text>

            <View style={styles.durationRow}>
              <Input
                label={t.time.hours}
                value={hours}
                onChangeText={(v) => {
                  setHours(v.replace(/\D/g, ''));
                  setError(null);
                }}
                keyboardType="number-pad"
                placeholder="0"
                maxLength={2}
                containerStyle={styles.flex}
                testID="log-time-hours"
              />
              <Input
                label={t.time.minutes}
                value={minutes}
                onChangeText={(v) => {
                  setMinutes(v.replace(/\D/g, ''));
                  setError(null);
                }}
                keyboardType="number-pad"
                placeholder="0"
                maxLength={4}
                containerStyle={styles.flex}
                testID="log-time-minutes"
              />
            </View>

            <Text style={[styles.fieldLabel, { color: colors.text }]}>{t.time.day}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {days.map((key, index) => {
                const active = key === day;
                return (
                  <Pressable
                    key={key}
                    onPress={() => setDay(key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: active ? BRAND_TINT : colors.secondary,
                        borderColor: active ? BRAND : 'transparent',
                      },
                    ]}
                  >
                    <Text style={[styles.chipText, { color: active ? BRAND : colors.text }]}>
                      {dayLabel(key, index)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <Textarea
              label={t.time.note}
              value={note}
              onChangeText={setNote}
              placeholder={t.time.notePlaceholder}
              numberOfLines={3}
              containerStyle={styles.noteField}
            />

            {error ? (
              <Text style={[styles.error, { color: colors.destructive }]}>{error}</Text>
            ) : null}

            <View style={styles.actions}>
              <Button title={t.common.cancel} variant="outline" onPress={onClose} style={styles.flex} />
              <Button
                title={t.common.save}
                onPress={() => void save()}
                loading={createEntry.isPending}
                style={styles.flex}
                testID="log-time-save"
              />
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ============================================================================
// Running-timer bar (above the tab bar)
// ============================================================================

/** Pill shown above the tab bar while a timer runs; tap opens its task. */
export function RunningTimerBar({ bottom }: Readonly<{ bottom: number }>) {
  const { colors } = useTheme();
  const router = useRouter();
  const { t } = useI18n();
  const { data: timer } = useRunningTimer();
  const now = useNow(!!timer);
  const taskQuery = useTask(timer?.projectId ?? '', timer?.taskId ?? '');

  if (!timer) return null;
  const title = taskQuery.data?.data.title ?? timer.description ?? t.time.running;
  const canOpen = !!timer.projectId && !!timer.taskId;

  return (
    <View pointerEvents="box-none" style={[styles.barWrap, { bottom }]}>
      <Pressable
        onPress={() => {
          if (!canOpen) return;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          router.push(`/task/${timer.projectId}/${timer.taskId}`);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${t.time.running}: ${title}`}
        style={({ pressed }) => [
          styles.bar,
          { backgroundColor: colors.cardBackground, borderColor: colors.border },
          pressed && { opacity: 0.8 },
        ]}
        testID="running-timer-bar"
      >
        <Clock size={16} color={BRAND} />
        <Text style={[styles.barTitle, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.barElapsed, { color: BRAND }]}>
          {formatElapsed(elapsedMs(timer.startedAt, now))}
        </Text>
      </Pressable>
    </View>
  );
}

/** Height the running-timer bar takes, so tab screens can make room for it. */
export const RUNNING_TIMER_BAR_SPACE = 52;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  runningRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  elapsed: { fontSize: 32, fontWeight: '700', fontVariant: ['tabular-nums'], letterSpacing: -0.5 },
  summary: { fontSize: 14 },
  note: { fontSize: 13, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    maxHeight: '90%',
  },
  sheetTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  durationRow: { flexDirection: 'row', gap: 12 },
  fieldLabel: { fontSize: 14, fontWeight: '500', marginTop: 4, marginBottom: 8 },
  chips: { gap: 8, paddingBottom: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1 },
  chipText: { fontSize: 14, fontWeight: '500' },
  noteField: { marginTop: 12 },
  error: { fontSize: 13, marginTop: 8 },
  barWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', paddingHorizontal: 20 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    maxWidth: 420,
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  barTitle: { flex: 1, fontSize: 14, fontWeight: '600' },
  barElapsed: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
