/**
 * Coaching notes and evaluations shared with the employee. Reading one and
 * marking it as read (with an optional comment) is the employee's part of
 * the process; writing them happens in WeldHR on the web.
 */

import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CheckCircle2, Circle, MessageSquareText } from 'lucide-react-native';
import type { HrSelfCoachingLog, HrSelfEvaluation } from '@weldsuite/app-api-client/domains/weldhr';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { Pill } from '@/components/Pill';
import { QueryBody } from '@/components/QueryBody';
import { Screen } from '@/components/Screen';
import { BRAND } from '@/constants/brand';
import { useAcknowledge, useCoaching, useEvaluations } from '@/hooks/use-weldhr-queries';
import { formatDate, formatDateRange, withCount } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';

type Tab = 'coaching' | 'evaluations';
type Target = { kind: 'coaching' | 'evaluation'; id: string };

export default function ReviewsScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const coaching = useCoaching();
  const evaluations = useEvaluations();
  const [tab, setTab] = useState<Tab>('coaching');
  const [target, setTarget] = useState<Target | null>(null);

  const openCoaching = (coaching.data ?? []).filter((log) => !log.acknowledgedAt).length;
  const openEvaluations = (evaluations.data ?? []).filter((e) => !e.acknowledgedAt).length;
  const emptyIcon = <MessageSquareText size={36} color={colors.mutedForeground} />;

  return (
    <Screen
      title={t.reviews.title}
      variant="push"
      refreshing={coaching.isRefetching || evaluations.isRefetching}
      onRefresh={() => {
        void coaching.refetch();
        void evaluations.refetch();
      }}
    >
      <SegmentedControl
        value={tab}
        onValueChange={(value) => setTab(value as Tab)}
        options={[
          { label: withCount(t.reviews.coaching, openCoaching), value: 'coaching' },
          { label: withCount(t.reviews.evaluations, openEvaluations), value: 'evaluations' },
        ]}
      />
      {tab === 'coaching' ? (
        <QueryBody query={coaching}>
          {(logs) =>
            logs.length === 0 ? (
              <EmptyState icon={emptyIcon} title={t.reviews.noCoaching} />
            ) : (
              logs.map((log) => (
                <CoachingCard
                  key={log.id}
                  log={log}
                  onAcknowledge={() => setTarget({ kind: 'coaching', id: log.id })}
                />
              ))
            )
          }
        </QueryBody>
      ) : (
        <QueryBody query={evaluations}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState icon={emptyIcon} title={t.reviews.noEvaluations} />
            ) : (
              rows.map((evaluation) => (
                <EvaluationCard
                  key={evaluation.id}
                  evaluation={evaluation}
                  onAcknowledge={() => setTarget({ kind: 'evaluation', id: evaluation.id })}
                />
              ))
            )
          }
        </QueryBody>
      )}
      {target ? <AcknowledgeSheet target={target} onClose={() => setTarget(null)} /> : null}
    </Screen>
  );
}

function Card({ children }: Readonly<{ children: ReactNode }>) {
  const { colors } = useTheme();
  return <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>{children}</View>;
}

function Acknowledged({
  acknowledgedAt,
  comment,
  onAcknowledge,
}: Readonly<{ acknowledgedAt: string | null; comment: string | null; onAcknowledge: () => void }>) {
  const { colors } = useTheme();
  const { t, format, intlLocale } = useI18n();
  if (!acknowledgedAt) {
    return <Button title={t.reviews.acknowledge} variant="outline" onPress={onAcknowledge} fullWidth />;
  }
  return (
    <View style={styles.ack}>
      {comment ? (
        <Text style={[styles.body, { color: colors.text }]}>
          <Text style={styles.bold}>{t.reviews.yourComment}: </Text>
          {comment}
        </Text>
      ) : null}
      <View style={styles.ackRow}>
        <CheckCircle2 size={14} color={BRAND} />
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>
          {format(t.reviews.acknowledged, { date: formatDate(acknowledgedAt, intlLocale) })}
        </Text>
      </View>
    </View>
  );
}

function CoachingCard({ log, onAcknowledge }: Readonly<{ log: HrSelfCoachingLog; onAcknowledge: () => void }>) {
  const { colors } = useTheme();
  const { t, format, intlLocale } = useI18n();
  return (
    <Card>
      <View style={styles.cardHeader}>
        <Pill label={labelFor(t.coachingCategory, log.category)} tone={log.category === 'recognition' ? 'success' : 'brand'} />
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>{formatDate(log.sessionDate, intlLocale)}</Text>
      </View>
      <Text style={[styles.title, { color: colors.text }]}>{log.topic}</Text>
      {log.coachName ? (
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>{format(t.reviews.by, { name: log.coachName })}</Text>
      ) : null}
      {log.notes ? <Text style={[styles.body, { color: colors.text }]}>{log.notes}</Text> : null}
      {log.actionItems.length > 0 ? (
        <View style={styles.items}>
          <Text style={[styles.label, { color: colors.mutedForeground }]}>{t.reviews.actionItems}</Text>
          {log.actionItems.map((item) => (
            <View key={item.id} style={styles.item}>
              {item.done ? <CheckCircle2 size={16} color={BRAND} /> : <Circle size={16} color={colors.mutedForeground} />}
              <Text style={[styles.body, styles.flex, { color: colors.text }]}>{item.text}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {log.followUpDate ? (
        <Text style={[styles.meta, { color: colors.mutedForeground }]}>
          {format(t.reviews.followUp, { date: formatDate(log.followUpDate, intlLocale) })}
        </Text>
      ) : null}
      <Acknowledged acknowledgedAt={log.acknowledgedAt} comment={log.employeeComment} onAcknowledge={onAcknowledge} />
    </Card>
  );
}

function EvaluationCard({ evaluation, onAcknowledge }: Readonly<{ evaluation: HrSelfEvaluation; onAcknowledge: () => void }>) {
  const { colors } = useTheme();
  const { t, format, intlLocale } = useI18n();
  const scores = new Map(evaluation.scores.map((score) => [score.criterionId, score]));

  return (
    <Card>
      <View style={styles.cardHeader}>
        <Text style={[styles.title, styles.flex, { color: colors.text }]}>{evaluation.formName ?? t.reviews.evaluations}</Text>
        {evaluation.overallScore != null ? (
          <Pill label={format(t.reviews.score, { score: evaluation.overallScore })} tone="brand" />
        ) : null}
      </View>
      <Text style={[styles.meta, { color: colors.mutedForeground }]}>
        {[
          evaluation.periodStart && evaluation.periodEnd
            ? formatDateRange(evaluation.periodStart, evaluation.periodEnd, intlLocale)
            : null,
          evaluation.evaluatorName ? format(t.reviews.by, { name: evaluation.evaluatorName }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
      {evaluation.criteria.length > 0 ? (
        <View style={styles.items}>
          {evaluation.criteria.map((criterion) => {
            const score = scores.get(criterion.id);
            return (
              <View key={criterion.id} style={styles.criterion}>
                <Text style={[styles.body, styles.flex, { color: colors.text }]}>{criterion.label}</Text>
                <Text style={[styles.score, { color: colors.text }]}>
                  {score?.score != null ? `${score.score}/${criterion.maxScore}` : t.common.dash}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {evaluation.summary ? <Text style={[styles.body, { color: colors.text }]}>{evaluation.summary}</Text> : null}
      <Acknowledged
        acknowledgedAt={evaluation.acknowledgedAt}
        comment={evaluation.employeeComment}
        onAcknowledge={onAcknowledge}
      />
    </Card>
  );
}

function AcknowledgeSheet({ target, onClose }: Readonly<{ target: Target; onClose: () => void }>) {
  const { t } = useI18n();
  const toast = useToast();
  const acknowledge = useAcknowledge();
  const [comment, setComment] = useState('');

  const submit = () => {
    acknowledge.mutate(
      { ...target, comment: comment.trim() || null },
      {
        onSuccess: () => {
          toast.success(t.reviews.done);
          onClose();
        },
        onError: (err) => toast.error((err as Error).message || t.common.somethingWrong),
      },
    );
  };

  return (
    <Sheet visible onClose={onClose} title={t.reviews.acknowledgeTitle} heightRatio={0.5}>
      <View style={styles.sheet}>
        <Textarea
          placeholder={t.reviews.commentPlaceholder}
          value={comment}
          onChangeText={setComment}
          numberOfLines={4}
          maxLength={5000}
        />
        <Button title={t.reviews.acknowledge} onPress={submit} loading={acknowledge.isPending} fullWidth />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 8 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { fontSize: 17, fontWeight: '700' },
  meta: { fontSize: 13 },
  body: { fontSize: 14, lineHeight: 20 },
  bold: { fontWeight: '600' },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  items: { gap: 6, marginTop: 4 },
  item: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  criterion: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  score: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  ack: { gap: 6, marginTop: 4 },
  ackRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sheet: { gap: 14 },
});
