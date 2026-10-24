/**
 * The manager / HR half of the app, shown only to members with team
 * permissions. Approving and declining is the main job on a phone; the rest
 * of WeldHR administration (payroll runs, settings, onboarding templates)
 * stays on the web.
 */

import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { CheckCheck, ChevronRight, Search } from 'lucide-react-native';
import type { HrDeclarationListItem, HrLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { Avatar } from '@weldsuite/mobile-ui/components/Avatar';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { Panel, Screen, Section } from '@/components/Screen';
import { BRAND, TONES, toneFg } from '@/constants/brand';
import {
  useHrAccess,
  usePendingExpenses,
  usePendingLeave,
  useReviewExpense,
  useReviewLeave,
  useSickToday,
  useTeamDashboard,
  type ReviewDecision,
} from '@/hooks/use-weldhr-queries';
import { formatDateRange, formatDay, formatMoney, withCount } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';

type ApprovalKind = 'leave' | 'expenses';

export default function TeamScreen() {
  const { t } = useI18n();
  const { access } = useHrAccess();
  const dashboard = useTeamDashboard(access.teamToday);
  const sick = useSickToday(access.sickToday);
  const leave = usePendingLeave(access.approveLeave);
  const expenses = usePendingExpenses(access.approveExpenses);

  const refresh = () => {
    void dashboard.refetch();
    void sick.refetch();
    void leave.refetch();
    void expenses.refetch();
  };

  return (
    <Screen
      title={t.team.title}
      refreshing={dashboard.isRefetching || leave.isRefetching || expenses.isRefetching}
      onRefresh={refresh}
    >
      {access.teamToday ? <TodayCard /> : null}
      {access.approveLeave || access.approveExpenses ? <Approvals /> : null}
      {access.directory ? <DirectoryLink /> : null}
      {access.team ? null : <EmptyState title={t.team.noAccess} />}
    </Screen>
  );
}

function TodayCard() {
  const { colors, theme } = useTheme();
  const { t, format, intlLocale } = useI18n();
  const { access } = useHrAccess();
  const dashboard = useTeamDashboard(true);
  const sick = useSickToday(access.sickToday);
  const today = dashboard.data?.today;

  if (!today) return dashboard.isPending ? <ActivityIndicator /> : null;

  const sickRows = sick.data ?? [];
  const out = [
    ...today.onLeave.map((row) => ({
      id: `leave-${row.employeeId}`,
      name: row.employeeName,
      detail: [row.leaveTypeName, format(t.team.until, { date: formatDay(row.endDate, intlLocale) })]
        .filter(Boolean)
        .join(' · '),
      tone: 'info' as const,
    })),
    ...sickRows.map((row) => ({
      id: `sick-${row.id}`,
      name: row.employeeName,
      detail: `${t.team.sick} · ${format(t.team.since, { date: formatDay(row.startDate, intlLocale) })}`,
      tone: 'warning' as const,
    })),
  ];

  return (
    <Section title={t.team.today}>
      <View style={styles.stats}>
        <Stat value={today.clockedIn} label={t.team.clockedIn} tone="brand" />
        <Stat value={today.onLeave.length} label={t.team.onLeave} tone="info" />
        {access.sickToday ? <Stat value={sickRows.length} label={t.team.sick} tone="warning" /> : null}
      </View>
      <Panel>
        {out.length === 0 ? (
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>{t.team.nobodyOut}</Text>
        ) : (
          out.slice(0, 8).map((row, index) => (
            <View
              key={row.id}
              style={[styles.personRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
            >
              <Avatar name={row.name} size={32} />
              <View style={styles.flex}>
                <Text style={[styles.personName, { color: colors.text }]} numberOfLines={1}>
                  {row.name}
                </Text>
                <Text
                  style={[styles.personDetail, { color: toneFg(row.tone, theme) }]}
                  numberOfLines={1}
                >
                  {row.detail}
                </Text>
              </View>
            </View>
          ))
        )}
      </Panel>
    </Section>
  );
}

function Stat({ value, label, tone }: Readonly<{ value: number; label: string; tone: keyof typeof TONES }>) {
  const { colors } = useTheme();
  return (
    <View style={[styles.stat, { backgroundColor: TONES[tone].bg }]}>
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Which list to show: the chosen one when the member can approve both, else the one they can. */
function visibleKind(chosen: ApprovalKind, canLeave: boolean, canExpenses: boolean): ApprovalKind {
  if (canLeave && canExpenses) return chosen;
  return canLeave ? 'leave' : 'expenses';
}

function Approvals() {
  const { t } = useI18n();
  const { access } = useHrAccess();
  const leave = usePendingLeave(access.approveLeave);
  const expenses = usePendingExpenses(access.approveExpenses);
  const [kind, setKind] = useState<ApprovalKind>(access.approveLeave ? 'leave' : 'expenses');
  const [rejecting, setRejecting] = useState<{ kind: ApprovalKind; id: string } | null>(null);

  const showing = visibleKind(kind, access.approveLeave, access.approveExpenses);
  const reject = (target: { kind: ApprovalKind; id: string }) => setRejecting(target);

  return (
    <Section title={t.team.approvals}>
      {access.approveLeave && access.approveExpenses ? (
        <SegmentedControl
          value={kind}
          onValueChange={(value) => setKind(value as ApprovalKind)}
          options={[
            { label: withCount(t.team.leave, leave.data?.length ?? 0), value: 'leave' },
            { label: withCount(t.team.expenses, expenses.data?.length ?? 0), value: 'expenses' },
          ]}
        />
      ) : null}
      {showing === 'leave' ? (
        <ApprovalList
          loading={leave.isPending}
          items={(leave.data ?? []).map((row) => (
            <LeaveApproval key={row.id} row={row} onReject={() => reject({ kind: 'leave', id: row.id })} />
          ))}
        />
      ) : (
        <ApprovalList
          loading={expenses.isPending}
          items={(expenses.data ?? []).map((row) => (
            <ExpenseApproval key={row.id} row={row} onReject={() => reject({ kind: 'expenses', id: row.id })} />
          ))}
        />
      )}
      {rejecting ? <RejectSheet target={rejecting} onClose={() => setRejecting(null)} /> : null}
    </Section>
  );
}

function ApprovalList({ loading, items }: Readonly<{ loading: boolean; items: ReactNode[] }>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  if (loading) return <ActivityIndicator />;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<CheckCheck size={32} color={colors.mutedForeground} />}
        title={t.team.nothingToApprove}
        description={t.team.nothingToApproveDescription}
      />
    );
  }
  return <>{items}</>;
}

function LeaveApproval({ row, onReject }: Readonly<{ row: HrLeaveRequest; onReject: () => void }>) {
  const { colors } = useTheme();
  const { t, plural, intlLocale } = useI18n();
  return (
    <ApprovalCard
      name={row.employeeName}
      title={formatDateRange(row.startDate, row.endDate, intlLocale)}
      subtitle={[row.leaveTypeName, plural(row.days, t.balance.days)].filter(Boolean).join(' · ')}
      note={row.reason}
      accent={row.leaveTypeColor || BRAND}
      onReject={onReject}
      approveKind="leave"
      id={row.id}
      extra={<Text style={[styles.cardMeta, { color: colors.mutedForeground }]}>{formatDay(row.createdAt.slice(0, 10), intlLocale)}</Text>}
    />
  );
}

function ExpenseApproval({ row, onReject }: Readonly<{ row: HrDeclarationListItem; onReject: () => void }>) {
  const { t, intlLocale } = useI18n();
  return (
    <ApprovalCard
      name={row.employeeName}
      title={formatMoney(row.amount, row.currency, intlLocale)}
      subtitle={`${labelFor(t.declarationCategory, row.category)} · ${formatDay(row.expenseDate, intlLocale)}`}
      note={row.description}
      accent={BRAND}
      onReject={onReject}
      approveKind="expenses"
      id={row.id}
    />
  );
}

function ApprovalCard({
  name,
  title,
  subtitle,
  note,
  accent,
  extra,
  approveKind,
  id,
  onReject,
}: Readonly<{
  name: string;
  title: string;
  subtitle: string;
  note: string | null;
  accent: string;
  extra?: ReactNode;
  approveKind: ApprovalKind;
  id: string;
  onReject: () => void;
}>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const reviewLeave = useReviewLeave();
  const reviewExpense = useReviewExpense();
  const review = approveKind === 'leave' ? reviewLeave : reviewExpense;

  const approve = () => {
    review.mutate(
      { id, decision: 'approved' },
      {
        onSuccess: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          toast.success(t.team.approved);
        },
        onError: (err) => toast.error((err as Error).message || t.common.somethingWrong),
      },
    );
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, borderLeftColor: accent }]}>
      <View style={styles.cardHeader}>
        <Avatar name={name} size={36} />
        <View style={styles.flex}>
          <Text style={[styles.cardName, { color: colors.text }]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={[styles.cardMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {extra}
      </View>
      <Text style={[styles.cardTitle, { color: colors.text }]}>{title}</Text>
      {note ? (
        <Text style={[styles.cardNote, { color: colors.mutedForeground }]} numberOfLines={3}>
          {note}
        </Text>
      ) : null}
      <View style={styles.cardActions}>
        <Button title={t.team.reject} variant="outline" onPress={onReject} disabled={review.isPending} style={styles.flex} />
        <Button title={t.team.approve} onPress={approve} loading={review.isPending} style={styles.flex} />
      </View>
    </View>
  );
}

function RejectSheet({ target, onClose }: Readonly<{ target: { kind: ApprovalKind; id: string }; onClose: () => void }>) {
  const { t } = useI18n();
  const toast = useToast();
  const reviewLeave = useReviewLeave();
  const reviewExpense = useReviewExpense();
  const review = target.kind === 'leave' ? reviewLeave : reviewExpense;
  const [note, setNote] = useState('');

  const reject = () => {
    const decision: ReviewDecision = 'rejected';
    review.mutate(
      { id: target.id, decision, note: note.trim() || null },
      {
        onSuccess: () => {
          toast.success(t.team.rejected);
          onClose();
        },
        onError: (err) => toast.error((err as Error).message || t.common.somethingWrong),
      },
    );
  };

  return (
    <Sheet visible onClose={onClose} title={t.team.rejectTitle} heightRatio={0.5}>
      <View style={styles.sheet}>
        <Textarea
          label={t.team.rejectNote}
          placeholder={t.team.rejectNotePlaceholder}
          value={note}
          onChangeText={setNote}
          numberOfLines={3}
          maxLength={2000}
        />
        <Button title={t.team.rejectConfirm} variant="destructive" onPress={reject} loading={review.isPending} fullWidth />
      </View>
    </Sheet>
  );
}

function DirectoryLink() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const router = useRouter();
  return (
    <Section title={t.team.directory}>
      <Pressable
        onPress={() => router.push('/directory')}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.directory,
          { backgroundColor: colors.inputBackground, opacity: pressed ? 0.8 : 1 },
        ]}
      >
        <Search size={18} color={colors.mutedForeground} />
        <Text style={[styles.directoryText, { color: colors.mutedForeground }]}>{t.team.directoryHint}</Text>
        <ChevronRight size={18} color={colors.mutedForeground} />
      </Pressable>
    </Section>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  stats: { flexDirection: 'row', gap: 10 },
  stat: { flex: 1, borderRadius: 14, padding: 12, gap: 2 },
  statValue: { fontSize: 26, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 12, fontWeight: '500' },
  empty: { fontSize: 14, padding: 14 },
  personRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
  personName: { fontSize: 15, fontWeight: '600' },
  personDetail: { fontSize: 13, marginTop: 1 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderLeftWidth: 4, padding: 14, gap: 10 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardName: { fontSize: 15, fontWeight: '600' },
  cardMeta: { fontSize: 13 },
  cardTitle: { fontSize: 20, fontWeight: '700' },
  cardNote: { fontSize: 14, lineHeight: 20 },
  cardActions: { flexDirection: 'row', gap: 10, marginTop: 2 },
  sheet: { gap: 14 },
  directory: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, paddingHorizontal: 14, height: 46 },
  directoryText: { flex: 1, fontSize: 15 },
});
