/**
 * Approving and declining, the same on Absence → Requests and Expenses → To
 * approve: plain rows like the member's own lists, the person and what they
 * ask for on the left, the dates or the amount on the right, and Decline /
 * Approve small under the text.
 */

import { useState } from 'react';
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
import { useI18n } from '@/lib/i18n';
import { PersonAvatar } from './PersonAvatar';
import { List } from './Row';

export type ApprovalKind = 'leave' | 'expenses';

/** The avatar beside a row: smaller than the category tiles, level with the two lines of text. */
const ROW_AVATAR = 34;

export function LeaveApprovals({ requests }: Readonly<{ requests: HrLeaveRequest[] }>) {
  const { t, plural, intlLocale } = useI18n();
  const [rejecting, setRejecting] = useState<string | null>(null);
  return (
    <View style={styles.list}>
      <List>
        {requests.map((row) => (
          <ApprovalRow
            key={row.id}
            kind="leave"
            id={row.id}
            name={row.employeeName}
            subtitle={row.leaveTypeName ?? t.absence.leave}
            note={row.reason}
            value={formatSpan(row.startDate, row.endDate, intlLocale)}
            detail={plural(row.days, t.balance.days)}
            onReject={() => setRejecting(row.id)}
          />
        ))}
      </List>
      {rejecting ? <RejectSheet kind="leave" id={rejecting} onClose={() => setRejecting(null)} /> : null}
    </View>
  );
}

export function ExpenseApprovals({ declarations }: Readonly<{ declarations: HrDeclarationListItem[] }>) {
  const { intlLocale } = useI18n();
  const [rejecting, setRejecting] = useState<string | null>(null);
  return (
    <View style={styles.list}>
      <List>
        {declarations.map((row) => (
          <ApprovalRow
            key={row.id}
            kind="expenses"
            id={row.id}
            name={row.employeeName}
            subtitle={row.description}
            value={formatMoney(row.amount, row.currency, intlLocale)}
            detail={formatDay(row.expenseDate, intlLocale)}
            onReject={() => setRejecting(row.id)}
          />
        ))}
      </List>
      {rejecting ? <RejectSheet kind="expenses" id={rejecting} onClose={() => setRejecting(null)} /> : null}
    </View>
  );
}

/** Approving a request: a success tick and a toast, or the error. */
function useApprove(kind: ApprovalKind) {
  const { t } = useI18n();
  const toast = useToast();
  const reviewLeave = useReviewLeave();
  const reviewExpense = useReviewExpense();
  const review = kind === 'leave' ? reviewLeave : reviewExpense;

  const approve = (id: string) => {
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
  return { approve, isPending: review.isPending };
}

/**
 * One request or claim to approve, laid out like a row of the member's own
 * list: who on top, what for under it (and why, on a line of its own), the
 * dates or amount and a second figure on the right, then the two buttons,
 * small, under the text.
 */
function ApprovalRow({
  kind,
  id,
  name,
  subtitle,
  note,
  value,
  detail,
  onReject,
}: Readonly<{
  kind: ApprovalKind;
  id: string;
  name: string;
  subtitle: string;
  /** Why they ask (a leave request's reason), under the subtitle. */
  note?: string | null;
  value: string;
  detail: string;
  onReject: () => void;
}>) {
  const palette = usePalette();
  const { t } = useI18n();
  const { approve, isPending } = useApprove(kind);

  return (
    <View style={styles.row}>
      <View style={styles.rowAvatar}>
        <PersonAvatar name={name} size={ROW_AVATAR} />
      </View>
      <View style={styles.flex}>
        <View style={styles.rowTop}>
          <View style={styles.flex}>
            <Text style={[styles.rowTitle, { color: palette.text }]} numberOfLines={1}>
              {name}
            </Text>
            <Text style={[styles.rowSubtitle, { color: palette.muted }]} numberOfLines={1}>
              {subtitle}
            </Text>
            {note ? (
              <Text style={[styles.rowNote, { color: palette.muted }]} numberOfLines={2}>
                {note}
              </Text>
            ) : null}
          </View>
          <View style={styles.rowSide}>
            <Text style={[styles.rowValue, { color: palette.text }]} numberOfLines={1}>
              {value}
            </Text>
            <Text style={[styles.rowSubtitle, { color: palette.muted }]} numberOfLines={1}>
              {detail}
            </Text>
          </View>
        </View>
        <View style={styles.smallActions}>
          <Pressable
            onPress={onReject}
            disabled={isPending}
            accessibilityRole="button"
            style={({ pressed }) => [styles.smallAction, { backgroundColor: palette.control, opacity: pressed ? 0.75 : 1 }]}
          >
            <Text style={[styles.smallActionText, { color: palette.text }]}>{t.team.reject}</Text>
          </Pressable>
          <Pressable
            onPress={() => approve(id)}
            disabled={isPending}
            accessibilityRole="button"
            style={({ pressed }) => [styles.smallAction, { backgroundColor: palette.ink, opacity: pressed ? 0.85 : 1 }]}
          >
            {isPending ? (
              <ActivityIndicator size="small" color={palette.inkText} />
            ) : (
              <Text style={[styles.smallActionText, { color: palette.inkText }]}>{t.team.approve}</Text>
            )}
          </Pressable>
        </View>
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
  sheet: { gap: 14 },
  // The type and spacing of Row (Row.tsx), plus the small buttons.
  list: { marginTop: 6 },
  // The avatar 11pt from the text, as a Row's tile is.
  row: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 16, paddingVertical: 13, gap: 11 },
  // Centred on the name and description (about 40pt of text), as the tiles are in a Row.
  rowAvatar: { marginTop: 3 },
  rowTop: { flexDirection: 'row', gap: 12 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowSubtitle: { fontSize: 14, lineHeight: 19, marginTop: 2 },
  // Straight under the subtitle, as its next line.
  rowNote: { fontSize: 14, lineHeight: 19 },
  rowSide: { alignItems: 'flex-end', flexShrink: 0, maxWidth: '45%' },
  rowValue: { fontSize: 15, fontVariant: ['tabular-nums'] },
  smallActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  smallAction: {
    minWidth: 96,
    height: 34,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallActionText: { fontSize: 15, fontWeight: '600' },
});
