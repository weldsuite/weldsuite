/**
 * Calendars — own calendars and ones shared with you, each with a visibility
 * switch that drives what the agenda and the month grid request.
 *
 * The list route annotates every row with `isOwn` + `permission`, which is
 * what splits the two sections and what gates the "shared" rows from offering
 * anything but visibility.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  StyleSheet,
  Modal,
  Pressable,
  Switch,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useObserve } from 'expo-observe';
import * as Haptics from 'expo-haptics';
import { CalendarDays, Plus } from 'lucide-react-native';

import { useOrganization } from '@clerk/expo';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import { Card } from '@weldsuite/mobile-ui/components/Card';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';

import { BRAND, CALENDAR_COLORS } from '@/lib/brand';
import { useCalendarVisibility } from '@/lib/calendar-visibility';
import { Screen, ScreenHeader } from '@/components/screen';
import { ColorSwatch } from '@/components/detail';
import { ErrorState, ListSkeleton } from '@/components/data-states';
import {
  useCalendars,
  useCreateCalendar,
  useEnsureDefaultCalendar,
} from '@/hooks/use-weldcalendar';
import { permissionLabel, useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';
import type { Calendar } from '@/types/weldcalendar';

export default function CalendarsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { markInteractive } = useObserve();
  const { organization } = useOrganization();
  const { t } = useI18n();
  const toast = useToast();
  const { isHidden, toggle } = useCalendarVisibility();

  const calendarsQuery = useCalendars();
  const createCalendar = useCreateCalendar();
  const ensureDefault = useEnsureDefaultCalendar();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState<string>(CALENDAR_COLORS[0]);
  const [nameError, setNameError] = useState<string | null>(null);

  const calendars = useMemo(() => calendarsQuery.data?.data ?? [], [calendarsQuery.data]);
  const personal = useMemo(
    () => calendars.filter((c) => c.tenantKind === 'personal'),
    [calendars],
  );
  const workspaceOwn = useMemo(
    () => calendars.filter((c) => c.tenantKind !== 'personal' && c.isOwn),
    [calendars],
  );
  const shared = useMemo(
    () => calendars.filter((c) => c.tenantKind !== 'personal' && !c.isOwn),
    [calendars],
  );

  const loading = calendarsQuery.isLoading;

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

  /**
   * A member who has never opened WeldCalendar on the web owns no calendar, so
   * the create-event screen would have nothing to write to. Provision the
   * default one instead of showing an empty state they cannot act on.
   *
   * `isIdle` gates this to a single attempt per mount: a failure must not turn
   * into a request loop against the route. Depending on the two mutation
   * fields rather than the mutation object keeps the effect from re-running on
   * every render — `useMutation` hands back a fresh object each time.
   */
  const { isIdle: ensureIsIdle, mutate: ensureMutate } = ensureDefault;
  useEffect(() => {
    if (loading || calendarsQuery.isError) return;
    if (!ensureIsIdle) return;
    const needsPersonal = personal.length === 0;
    const needsWorkspace = !!organization && workspaceOwn.length === 0;
    if (!needsPersonal && !needsWorkspace) return;
    ensureMutate(undefined, {
      onError: () => toast.error(t.calendars.ensureFailed),
    });
  }, [
    loading,
    calendarsQuery.isError,
    personal.length,
    workspaceOwn.length,
    organization,
    ensureIsIdle,
    ensureMutate,
    toast,
    t,
  ]);

  const resetForm = useCallback(() => {
    setName('');
    setDescription('');
    setColor(CALENDAR_COLORS[0]);
    setNameError(null);
  }, []);

  const handleCreate = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t.calendars.nameRequired);
      return;
    }
    try {
      await createCalendar.mutateAsync({
        name: trimmed,
        description: description.trim() || undefined,
        color,
        tenantKind: organization ? 'workspace' : 'personal',
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCreating(false);
      resetForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.calendars.createFailed);
    }
  }, [name, description, color, organization, createCalendar, resetForm, toast, t]);

  const header = (
    <ScreenHeader
      title={t.calendars.title}
      actions={
        <IconButton
          icon={<Plus size={22} color={colors.text} />}
          accessibilityLabel={t.calendars.newCalendar}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setCreating(true);
          }}
        />
      }
    />
  );

  if (calendarsQuery.isError && !calendarsQuery.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={t.calendars.loadError}
          onRetry={() => void calendarsQuery.refetch()}
          retrying={calendarsQuery.isRefetching}
        />
      </Screen>
    );
  }

  const renderRow = (calendar: Calendar, isLast: boolean) => {
    const hidden = isHidden(calendar.id);
    return (
      <View key={calendar.id}>
        <View style={styles.row}>
          <ColorSwatch color={calendar.color || BRAND} />
          <View style={styles.rowText}>
            <View style={styles.rowTitleLine}>
              <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                {calendar.name}
              </Text>
              {calendar.isDefault ? (
                <Badge variant="secondary" size="sm" label={t.calendars.defaultBadge} />
              ) : null}
            </View>
            <Text style={[styles.rowSubtitle, { color: colors.mutedForeground }]} numberOfLines={1}>
              {calendar.isOwn
                ? calendar.description || t.permission.manage
                : permissionLabel(t, calendar.permission)}
            </Text>
          </View>
          <Switch
            value={!hidden}
            onValueChange={() => toggle(calendar.id)}
            trackColor={{ true: BRAND, false: colors.border }}
            accessibilityLabel={calendar.name}
          />
        </View>
        {isLast ? null : <Divider inset={62} />}
      </View>
    );
  };

  return (
    <Screen header={header}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={calendarsQuery.isRefetching}
            onRefresh={() => void calendarsQuery.refetch()}
            tintColor={BRAND}
          />
        }
      >
        {loading && !calendarsQuery.data ? <ListSkeleton count={4} /> : null}

        {!loading && calendars.length === 0 ? (
          <EmptyState
            icon={<CalendarDays size={32} color={colors.mutedForeground} />}
            title={t.calendars.emptyTitle}
            description={t.calendars.emptyDescription}
            style={styles.empty}
          />
        ) : null}

        {personal.length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
              {t.calendars.personal}
            </Text>
            <Card style={styles.card}>
              {personal.map((calendar, index) => renderRow(calendar, index === personal.length - 1))}
            </Card>
          </>
        ) : null}

        {workspaceOwn.length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
              {organization?.name || t.calendars.workspace}
            </Text>
            <Card style={styles.card}>
              {workspaceOwn.map((calendar, index) =>
                renderRow(calendar, index === workspaceOwn.length - 1),
              )}
            </Card>
          </>
        ) : null}

        {shared.length > 0 ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
              {t.calendars.shared}
            </Text>
            <Card style={styles.card}>
              {shared.map((calendar, index) => renderRow(calendar, index === shared.length - 1))}
            </Card>
          </>
        ) : null}

        {calendars.length > 0 ? (
          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            {t.calendars.visibilityHint}
          </Text>
        ) : null}
      </ScrollView>

      <Modal
        visible={creating}
        transparent
        animationType="slide"
        onRequestClose={() => setCreating(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setCreating(false)}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: colors.cardBackground, paddingBottom: insets.bottom + 16 },
            ]}
            onPress={(event) => event.stopPropagation()}
          >
            <Text style={[styles.sheetTitle, { color: colors.text }]}>
              {t.calendars.createTitle}
            </Text>

            <Text style={[styles.label, { color: colors.muted }]}>{t.calendars.nameLabel}</Text>
            <TextInput
              style={[
                styles.input,
                {
                  color: colors.text,
                  backgroundColor: colors.background,
                  borderColor: nameError ? colors.destructive : colors.divider,
                },
              ]}
              placeholder={t.calendars.namePlaceholder}
              placeholderTextColor={colors.muted}
              value={name}
              onChangeText={(value) => {
                setName(value);
                if (nameError) setNameError(null);
              }}
              autoFocus
            />
            {nameError ? (
              <Text style={[styles.errorText, { color: colors.destructive }]}>{nameError}</Text>
            ) : null}

            <Text style={[styles.label, { color: colors.muted }]}>
              {t.calendars.descriptionLabel}
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  color: colors.text,
                  backgroundColor: colors.background,
                  borderColor: colors.divider,
                },
              ]}
              placeholder={t.calendars.descriptionPlaceholder}
              placeholderTextColor={colors.muted}
              value={description}
              onChangeText={setDescription}
            />

            <Text style={[styles.label, { color: colors.muted }]}>{t.calendars.colorLabel}</Text>
            <View style={styles.colorRow}>
              {CALENDAR_COLORS.map((option) => (
                <TouchableOpacity
                  key={option}
                  onPress={() => setColor(option)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: option === color }}
                  style={[
                    styles.colorSwatch,
                    {
                      backgroundColor: option,
                      borderColor: option === color ? colors.text : 'transparent',
                    },
                  ]}
                />
              ))}
            </View>

            <View style={styles.sheetActions}>
              <TouchableOpacity
                onPress={() => {
                  setCreating(false);
                  resetForm();
                }}
                style={[styles.secondaryBtn, { borderColor: colors.divider }]}
                accessibilityRole="button"
              >
                <Text style={[styles.secondaryBtnText, { color: colors.text }]}>
                  {t.common.cancel}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleCreate}
                disabled={createCalendar.isPending || !name.trim()}
                style={[
                  styles.primaryBtn,
                  (createCalendar.isPending || !name.trim()) && styles.disabled,
                ]}
                accessibilityRole="button"
              >
                {createCalendar.isPending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>{t.common.create}</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8, paddingBottom: 24 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 20,
    marginBottom: 8,
    paddingHorizontal: 20,
  },
  card: { marginHorizontal: 16, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  rowSubtitle: { fontSize: 13, marginTop: 2 },
  hint: { fontSize: 12, lineHeight: 16, paddingHorizontal: 20, marginTop: 16 },
  empty: { marginTop: 40 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16 },
  sheetTitle: { fontSize: 18, fontWeight: '700', marginBottom: 16 },
  label: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 0.5,
  },
  errorText: { fontSize: 12, marginTop: 4 },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorSwatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 2 },
  sheetActions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 20 },
  secondaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 0.5,
  },
  secondaryBtnText: { fontSize: 15, fontWeight: '500' },
  primaryBtn: {
    backgroundColor: BRAND,
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 10,
    minWidth: 92,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.6 },
});
