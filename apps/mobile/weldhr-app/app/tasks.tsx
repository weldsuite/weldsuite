import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Check, ClipboardCheck } from 'lucide-react-native';
import type { HrSelfTask } from '@weldsuite/app-api-client/domains/weldhr';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { QueryBody } from '@/components/QueryBody';
import { Panel, Screen, Section } from '@/components/Screen';
import { BRAND } from '@/constants/brand';
import { useCompleteTask, useTasks } from '@/hooks/use-weldhr-queries';
import { todayIso } from '@/lib/dates';
import { formatDay } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';

export default function TasksScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const tasks = useTasks();

  // One section per checklist ("Onboarding: Sales"), open tasks first.
  const groups = new Map<string, HrSelfTask[]>();
  for (const task of tasks.data ?? []) {
    const list = groups.get(task.checklistName) ?? [];
    list.push(task);
    groups.set(task.checklistName, list);
  }
  for (const list of groups.values()) {
    list.sort(
      (a, b) =>
        Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) ||
        (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'),
    );
  }

  return (
    <Screen title={t.tasks.title} variant="push" refreshing={tasks.isRefetching} onRefresh={() => void tasks.refetch()}>
      <QueryBody query={tasks}>
        {() =>
          groups.size === 0 ? (
            <EmptyState
              icon={<ClipboardCheck size={36} color={colors.mutedForeground} />}
              title={t.tasks.empty}
              description={t.tasks.emptyDescription}
            />
          ) : (
            [...groups.entries()].map(([name, list]) => (
              <Section key={name} title={name}>
                <Panel>
                  {list.map((task, index) => (
                    <TaskRow key={task.id} task={task} first={index === 0} />
                  ))}
                </Panel>
              </Section>
            ))
          )
        }
      </QueryBody>
    </Screen>
  );
}

function TaskRow({ task, first }: Readonly<{ task: HrSelfTask; first: boolean }>) {
  const { colors } = useTheme();
  const { t, format, intlLocale } = useI18n();
  const toast = useToast();
  const complete = useCompleteTask();
  const done = Boolean(task.completedAt);
  const overdue = !done && task.dueDate != null && task.dueDate < todayIso();
  let mark: ReactNode = null;
  if (complete.isPending) mark = <ActivityIndicator size="small" color={done ? '#fff' : BRAND} />;
  else if (done) mark = <Check size={14} color="#fff" />;

  const toggle = () => {
    complete.mutate(
      { id: task.id, done: !done },
      {
        onSuccess: ({ data }) => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          if (data.checklistCompleted) toast.success(t.tasks.checklistDone);
        },
        onError: (err) => toast.error((err as Error).message || t.common.somethingWrong),
      },
    );
  };

  return (
    <Pressable
      onPress={toggle}
      disabled={!task.canComplete || complete.isPending}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done, disabled: !task.canComplete }}
      style={({ pressed }) => [
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
        pressed && { backgroundColor: colors.pressed },
      ]}
    >
      <View
        style={[
          styles.check,
          { borderColor: done ? BRAND : colors.border, backgroundColor: done ? BRAND : 'transparent' },
          !task.canComplete && !done && styles.checkDisabled,
        ]}
      >
        {mark}
      </View>
      <View style={styles.flex}>
        <Text style={[styles.title, { color: done ? colors.mutedForeground : colors.text }, done && styles.titleDone]}>
          {task.title}
        </Text>
        {task.description ? (
          <Text style={[styles.sub, { color: colors.mutedForeground }]} numberOfLines={3}>
            {task.description}
          </Text>
        ) : null}
        <Text style={[styles.sub, { color: overdue ? colors.destructive : colors.mutedForeground }]}>
          {[
            task.dueDate ? format(t.tasks.due, { date: formatDay(task.dueDate, intlLocale) }) : null,
            task.canComplete ? null : format(t.tasks.assignedTo, { role: labelFor(t.tasks.roles, task.assigneeRole) }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14 },
  check: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkDisabled: { opacity: 0.4 },
  title: { fontSize: 15, fontWeight: '600' },
  titleDone: { textDecorationLine: 'line-through' },
  sub: { fontSize: 13 },
});
