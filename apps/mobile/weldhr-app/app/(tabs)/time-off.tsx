import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CalendarDays, Plus } from 'lucide-react-native';
import type { HrSelfLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { LeaveBalances } from '@/components/LeaveBalances';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { Pill, statusTone } from '@/components/Pill';
import { ErrorNote, HeaderButton, Panel, Screen, Section } from '@/components/Screen';
import { BRAND } from '@/constants/brand';
import { useCancelLeave, useLeave } from '@/hooks/use-weldhr-queries';
import { todayIso } from '@/lib/dates';
import { canCancelLeave, sortRequests } from '@/lib/leave';
import { formatDateRange } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';

export default function TimeOffScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const state = useSelfState();
  const leave = useLeave();
  const canRequest = state.status === 'ready' && state.self.features.leaveRequests;

  return (
    <Screen
      title={t.timeOff.title}
      refreshing={leave.isRefetching}
      onRefresh={() => {
        state.refetch();
        void leave.refetch();
      }}
      action={
        canRequest ? (
          <HeaderButton
            icon={<Plus size={20} color={BRAND} />}
            label={t.timeOff.newRequest}
            testID="time-off-new"
            onPress={() => router.push('/leave/new')}
          />
        ) : undefined
      }
    >
      <MyHrGate state={state}>
        {state.status === 'ready' && !state.self.features.leaveRequests ? (
          <Banner variant="info">{t.timeOff.turnedOff}</Banner>
        ) : null}
        <TimeOffBody />
      </MyHrGate>
    </Screen>
  );
}

function TimeOffBody() {
  const { colors } = useTheme();
  const { t, format, plural, intlLocale } = useI18n();
  const toast = useToast();
  const leave = useLeave();
  const cancel = useCancelLeave();
  const [confirming, setConfirming] = useState<HrSelfLeaveRequest | null>(null);

  if (leave.isPending) return <ActivityIndicator style={styles.loading} />;
  if (leave.isError || !leave.data) return <ErrorNote message={t.common.somethingWrong} />;

  const today = todayIso();
  const requests = sortRequests(leave.data.requests, today);

  return (
    <>
      <LeaveBalances balances={leave.data.balances} />

      <Section title={t.timeOff.requests}>
        {requests.length === 0 ? (
          <EmptyState
            icon={<CalendarDays size={36} color={colors.mutedForeground} />}
            title={t.timeOff.noRequests}
            description={t.timeOff.noRequestsDescription}
          />
        ) : (
          <Panel>
            {requests.map((request, index) => (
              <Pressable
                key={request.id}
                disabled={!canCancelLeave(request, today)}
                onPress={() => setConfirming(request)}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.row,
                  index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                  pressed && { backgroundColor: colors.pressed },
                ]}
              >
                <View style={[styles.colorBar, { backgroundColor: request.leaveTypeColor || BRAND }]} />
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, { color: colors.text }]}>
                    {formatDateRange(request.startDate, request.endDate, intlLocale)}
                  </Text>
                  <Text style={[styles.rowSub, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {[request.leaveTypeName, plural(request.days, t.balance.days)]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  {request.reviewNote ? (
                    <Text style={[styles.note, { color: colors.mutedForeground }]}>
                      {format(t.timeOff.reviewNoteAnonymous, { note: request.reviewNote })}
                    </Text>
                  ) : null}
                </View>
                <Pill label={labelFor(t.leaveStatus, request.status)} tone={statusTone(request.status)} />
              </Pressable>
            ))}
          </Panel>
        )}
      </Section>

      <ConfirmModal
        visible={confirming != null}
        title={t.timeOff.cancelTitle}
        message={
          confirming
            ? format(t.timeOff.cancelMessage, {
                type: confirming.leaveTypeName ?? '',
                dates: formatDateRange(confirming.startDate, confirming.endDate, intlLocale),
              })
            : undefined
        }
        confirmText={t.timeOff.cancelConfirm}
        cancelText={t.timeOff.keep}
        variant="destructive"
        loading={cancel.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (!confirming) return;
          cancel.mutate(confirming.id, {
            onSuccess: () => {
              toast.success(t.timeOff.cancelled);
              setConfirming(null);
            },
            onError: (err) => {
              toast.error((err as Error).message || t.common.somethingWrong);
              setConfirming(null);
            },
          });
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: 32 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingRight: 14 },
  colorBar: { width: 4, alignSelf: 'stretch', borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowSub: { fontSize: 13 },
  note: { fontSize: 13, fontStyle: 'italic', marginTop: 2 },
});
