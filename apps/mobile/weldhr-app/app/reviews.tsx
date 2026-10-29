/**
 * Coaching notes and evaluations shared with the employee. Reading one and
 * marking it as read (with an optional comment) is the employee's part of
 * the process; writing them happens in WeldHR on the web.
 */

import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { CheckCircle2, Circle } from 'lucide-react-native';
import type { HrSelfCoachingLog, HrSelfEvaluation } from '@weldsuite/app-api-client/domains/weldhr';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { EmptyState } from '@/components/EmptyState';
import { QueryBody } from '@/components/QueryBody';
import { Inset, Screen, TabStrip } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import { useAcknowledge, useCoaching, useEvaluations } from '@/hooks/use-weldhr-queries';
import { formatDate, formatDateRange, withCount } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';

type Tab = 'coaching' | 'evaluations';
type Target = { kind: 'coaching' | 'evaluation'; id: string };

export default function ReviewsScreen() {
  const { t } = useI18n();
  const coaching = useCoaching();
  const evaluations = useEvaluations();
  const [tab, setTab] = useState<Tab>('coaching');
  const [target, setTarget] = useState<Target | null>(null);

  const openCoaching = (coaching.data ?? []).filter((log) => !log.acknowledgedAt).length;
  const openEvaluations = (evaluations.data ?? []).filter((e) => !e.acknowledgedAt).length;

  return (
    <Screen
      title={t.reviews.title}
      variant="push"
      refreshing={coaching.isRefetching || evaluations.isRefetching}
      onRefresh={() => {
        void coaching.refetch();
        void evaluations.refetch();
      }}
      segments={
        <TabStrip
          value={tab}
          onChange={setTab}
          options={[
            { label: withCount(t.reviews.coaching, openCoaching), value: 'coaching' },
            { label: withCount(t.reviews.evaluations, openEvaluations), value: 'evaluations' },
          ]}
        />
      }
    >
      {/* Keyed by the tab, so the other list fades in instead of popping in. */}
      <Animated.View key={tab} entering={FadeIn.duration(180)} style={styles.view}>
        {tab === 'coaching' ? (
          <QueryBody query={coaching}>
            {(logs) =>
              logs.length === 0 ? (
                <EmptyState illustration="chat" title={t.reviews.noCoaching} />
              ) : (
                <Inset style={styles.cards}>
                  {logs.map((log) => (
                    <CoachingCard
                      key={log.id}
                      log={log}
                      onAcknowledge={() => setTarget({ kind: 'coaching', id: log.id })}
                    />
                  ))}
                </Inset>
              )
            }
          </QueryBody>
        ) : (
          <QueryBody query={evaluations}>
            {(rows) =>
              rows.length === 0 ? (
                <EmptyState illustration="chat" title={t.reviews.noEvaluations} />
              ) : (
                <Inset style={styles.cards}>
                  {rows.map((evaluation) => (
                    <EvaluationCard
                      key={evaluation.id}
                      evaluation={evaluation}
                      onAcknowledge={() => setTarget({ kind: 'evaluation', id: evaluation.id })}
                    />
                  ))}
                </Inset>
              )
            }
          </QueryBody>
        )}
      </Animated.View>
      {target ? <AcknowledgeSheet target={target} onClose={() => setTarget(null)} /> : null}
    </Screen>
  );
}

function Card({ children }: Readonly<{ children: ReactNode }>) {
  const palette = usePalette();
  return <View style={[styles.card, { backgroundColor: palette.surface, borderColor: palette.border }]}>{children}</View>;
}

function Acknowledged({
  acknowledgedAt,
  comment,
  onAcknowledge,
}: Readonly<{ acknowledgedAt: string | null; comment: string | null; onAcknowledge: () => void }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  if (!acknowledgedAt) {
    return <Button title={t.reviews.acknowledge} variant="secondary" onPress={onAcknowledge} fullWidth />;
  }
  return (
    <View style={styles.ack}>
      {comment ? (
        <Text style={[styles.body, { color: palette.text }]}>
          <Text style={styles.bold}>{t.reviews.yourComment}: </Text>
          {comment}
        </Text>
      ) : null}
      <View style={styles.ackRow}>
        <CheckCircle2 size={14} color={palette.success} />
        <Text style={[styles.meta, { color: palette.muted }]}>
          {format(t.reviews.acknowledged, { date: formatDate(acknowledgedAt, intlLocale) })}
        </Text>
      </View>
    </View>
  );
}

function CoachingCard({ log, onAcknowledge }: Readonly<{ log: HrSelfCoachingLog; onAcknowledge: () => void }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  return (
    <Card>
      <View style={styles.cardHeader}>
        <Text style={[styles.tag, { color: log.category === 'recognition' ? palette.success : palette.accent }]}>
          {labelFor(t.coachingCategory, log.category)}
        </Text>
        <Text style={[styles.meta, { color: palette.muted }]}>{formatDate(log.sessionDate, intlLocale)}</Text>
      </View>
      <Text style={[styles.title, { color: palette.text }]}>{log.topic}</Text>
      {log.coachName ? (
        <Text style={[styles.meta, { color: palette.muted }]}>{format(t.reviews.by, { name: log.coachName })}</Text>
      ) : null}
      {log.notes ? <Text style={[styles.body, { color: palette.text }]}>{log.notes}</Text> : null}
      {log.actionItems.length > 0 ? (
        <View style={styles.items}>
          <Text style={[styles.label, { color: palette.muted }]}>{t.reviews.actionItems}</Text>
          {log.actionItems.map((item) => (
            <View key={item.id} style={styles.item}>
              {item.done ? <CheckCircle2 size={16} color={palette.success} /> : <Circle size={16} color={palette.muted} />}
              <Text style={[styles.body, styles.flex, { color: palette.text }]}>{item.text}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {log.followUpDate ? (
        <Text style={[styles.meta, { color: palette.muted }]}>
          {format(t.reviews.followUp, { date: formatDate(log.followUpDate, intlLocale) })}
        </Text>
      ) : null}
      <Acknowledged acknowledgedAt={log.acknowledgedAt} comment={log.employeeComment} onAcknowledge={onAcknowledge} />
    </Card>
  );
}

function EvaluationCard({ evaluation, onAcknowledge }: Readonly<{ evaluation: HrSelfEvaluation; onAcknowledge: () => void }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  const scores = new Map(evaluation.scores.map((score) => [score.criterionId, score]));

  return (
    <Card>
      <View style={styles.cardHeader}>
        <Text style={[styles.title, styles.flex, { color: palette.text }]}>{evaluation.formName ?? t.reviews.evaluations}</Text>
        {evaluation.overallScore != null ? (
          <Text style={[styles.tag, { color: palette.accent }]}>{format(t.reviews.score, { score: evaluation.overallScore })}</Text>
        ) : null}
      </View>
      <Text style={[styles.meta, { color: palette.muted }]}>
        {[
          evaluation.periodStart && evaluation.periodEnd
            ? formatDateRange(evaluation.periodStart, evaluation.periodEnd, intlLocale)
            : null,
          evaluation.evaluatorName ? format(t.reviews.by, { name: evaluation.evaluatorName }) : null,
        ]
          .filter(Boolean)
          .join(' • ')}
      </Text>
      {evaluation.criteria.length > 0 ? (
        <View style={styles.items}>
          {evaluation.criteria.map((criterion) => {
            const score = scores.get(criterion.id);
            return (
              <View key={criterion.id} style={styles.criterion}>
                <Text style={[styles.body, styles.flex, { color: palette.text }]}>{criterion.label}</Text>
                <Text style={[styles.score, { color: palette.text }]}>
                  {score?.score != null ? `${score.score}/${criterion.maxScore}` : t.common.dash}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {evaluation.summary ? <Text style={[styles.body, { color: palette.text }]}>{evaluation.summary}</Text> : null}
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
  view: { flexGrow: 1 },
  cards: { gap: 12, marginTop: 8 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 8 },
  tag: { fontSize: 14, fontWeight: '600' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  meta: { fontSize: 14 },
  body: { fontSize: 15, lineHeight: 21 },
  bold: { fontWeight: '600' },
  label: { fontSize: 13, fontWeight: '600' },
  items: { gap: 6, marginTop: 4 },
  item: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  criterion: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  score: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  ack: { gap: 6, marginTop: 4 },
  ackRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sheet: { gap: 14 },
});
