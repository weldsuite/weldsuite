/**
 * Approving and declining: a card per request with the person, what they
 * ask for, their note, and Decline / Approve. Used for leave on Absence →
 * Requests and for expenses on Expenses → To approve.
 */

import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { HrDeclarationListItem, HrLeaveRequest } from '@weldsuite/app-api-client/domains/weldhr';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { usePalette } from '@/hooks/use-palette';
import { useReviewExpense, useReviewLeave, type ReviewDecision } from '@/hooks/use-weldhr-queries';
import { formatDay, formatMoney, formatSpan } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';
import { LeaveTypeTile } from './HrRows';
import { AVATAR_BADGE, PersonAvatar } from './PersonAvatar';

export type ApprovalKind = 'leave' | 'expenses';

export function LeaveApprovals({ requests }: Readonly<{ requests: HrLeaveRequest[] }>) {
  const { t, plural, intlLocale } = useI18n();
  const [rejecting, setRejecting] = useState<string | null>(null);
  return (
    <View style={styles.cards}>
      {requests.map((row) => (
        <ApprovalCard
          key={row.id}
          kind="leave"
          id={row.id}
          name={row.employeeName}
          badge={<LeaveTypeTile color={row.leaveTypeColor} size={AVATAR_BADGE} />}
          subtitle={row.leaveTypeName ?? t.absence.leave}
          title={formatSpan(row.startDate, row.endDate, intlLocale)}
          figure={plural(row.days, t.balance.days)}
          note={row.reason}
          sent={formatDay(row.createdAt.slice(0, 10), intlLocale)}
          onReject={() => setRejecting(row.id)}
        />
      ))}
      {rejecting ? <RejectSheet kind="leave" id={rejecting} onClose={() => setRejecting(null)} /> : null}
    </View>
  );
}

export function ExpenseApprovals({ declarations }: Readonly<{ declarations: HrDeclarationListItem[] }>) {
  const { t, intlLocale } = useI18n();
  const [rejecting, setRejecting] = useState<string | null>(null);
  return (
    <View style={styles.cards}>
      {declarations.map((row) => (
        <ApprovalCard
          key={row.id}
          kind="expenses"
          id={row.id}
          name={row.employeeName}
          subtitle={`${labelFor(t.declarationCategory, row.category)} • ${formatDay(row.expenseDate, intlLocale)}`}
          title={formatMoney(row.amount, row.currency, intlLocale)}
          note={row.description}
          onReject={() => setRejecting(row.id)}
        />
      ))}
      {rejecting ? <RejectSheet kind="expenses" id={rejecting} onClose={() => setRejecting(null)} /> : null}
    </View>
  );
}

function ApprovalCard({
  kind,
  id,
  name,
  badge,
  subtitle,
  title,
  figure,
  note,
  sent,
  onReject,
}: Readonly<{
  kind: ApprovalKind;
  id: string;
  name: string;
  badge?: ReactNode;
  subtitle: string;
  title: string;
  figure?: string;
  note: string | null;
  sent?: string;
  onReject: () => void;
}>) {
  const palette = usePalette();
  const { t } = useI18n();
  const toast = useToast();
  const reviewLeave = useReviewLeave();
  const reviewExpense = useReviewExpense();
  const review = kind === 'leave' ? reviewLeave : reviewExpense;

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
    <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>
      <View style={styles.header}>
        <PersonAvatar name={name} badge={badge} />
        <View style={styles.flex}>
          <Text style={[styles.name, { color: palette.text }]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={[styles.subtitle, { color: palette.muted }]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        {sent ? <Text style={[styles.sent, { color: palette.muted }]}>{sent}</Text> : null}
      </View>
      <View style={styles.figures}>
        <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
        {figure ? <Text style={[styles.figure, { color: palette.muted }]}>{figure}</Text> : null}
      </View>
      {note ? (
        <View style={[styles.note, { backgroundColor: palette.tile }]}>
          <Text style={[styles.noteText, { color: palette.text }]} numberOfLines={4}>
            {note}
          </Text>
        </View>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          onPress={onReject}
          disabled={review.isPending}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, { backgroundColor: palette.control, opacity: pressed ? 0.75 : 1 }]}
        >
          <Text style={[styles.actionText, { color: palette.text }]}>{t.team.reject}</Text>
        </Pressable>
        <Pressable
          onPress={approve}
          disabled={review.isPending}
          accessibilityRole="button"
          style={({ pressed }) => [styles.action, { backgroundColor: palette.ink, opacity: pressed ? 0.85 : 1 }]}
        >
          {review.isPending ? (
            <ActivityIndicator color={palette.inkText} />
          ) : (
            <Text style={[styles.actionText, { color: palette.inkText }]}>{t.team.approve}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function RejectSheet({ kind, id, onClose }: Readonly<{ kind: ApprovalKind; id: string; onClose: () => void }>) {
  const { t } = useI18n();
  const toast = useToast();
  const reviewLeave = useReviewLeave();
  const reviewExpense = useReviewExpense();
  const review = kind === 'leave' ? reviewLeave : reviewExpense;
  const [note, setNote] = useState('');

  const reject = () => {
    const decision: ReviewDecision = 'rejected';
    review.mutate(
      { id, decision, note: note.trim() || null },
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  cards: { paddingHorizontal: 16, gap: 12, marginTop: 8 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 14 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  name: { fontSize: 16, fontWeight: '600' },
  subtitle: { fontSize: 15, marginTop: 1 },
  sent: { fontSize: 14 },
  figures: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  title: { flexShrink: 1, fontSize: 22, fontWeight: '700', letterSpacing: -0.4 },
  figure: { fontSize: 15 },
  note: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  noteText: { fontSize: 15, lineHeight: 21 },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  actionText: { fontSize: 16, fontWeight: '600' },
  sheet: { gap: 14 },
});
