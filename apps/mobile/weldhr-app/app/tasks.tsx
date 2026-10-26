import { ActivityIndicator, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Check } from 'lucide-react-native';
import type { HrSelfTask } from '@weldsuite/app-api-client/domains/weldhr';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';

import { EmptyState } from '@/components/EmptyState';
import { QueryBody } from '@/components/QueryBody';
import { List, Row } from '@/components/Row';
import { Screen, Section } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import { useCompleteTask, useTasks } from '@/hooks/use-weldhr-queries';
import { todayIso } from '@/lib/dates';
import { formatDay } from '@/lib/format';
import { labelFor, useI18n } from '@/lib/i18n';

export default function TasksScreen() {
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
            <EmptyState illustration="checklist" title={t.tasks.empty} description={t.tasks.emptyDescription} />
          ) : (
            [...groups.entries()].map(([name, list], index) => {
              const done = list.filter((task) => task.completedAt).length;
              return (
                <Section key={name} title={name} meta={`${done}/${list.length}`} first={index === 0}>
                  <List>
                    {list.map((task) => (
                      <TaskRow key={task.id} task={task} />
                    ))}
                  </List>
                </Section>
              );
            })
          )
        }
      </QueryBody>
    </Screen>
  );
}

function TaskRow({ task }: Readonly<{ task: HrSelfTask }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  const toast = useToast();
  const complete = useCompleteTask();
  const done = Boolean(task.completedAt);
  const overdue = !done && task.dueDate != null && task.dueDate < todayIso();

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

  let mark = null;
  if (complete.isPending) mark = <ActivityIndicator size="small" color={done ? palette.inkText : palette.text} />;
  else if (done) mark = <Check size={15} color={palette.inkText} strokeWidth={3} />;

  return (
    <Row
      leading={
        <View
          style={[
            styles.check,
            {
              borderColor: done ? palette.ink : palette.grabber,
              backgroundColor: done ? palette.ink : 'transparent',
            },
            !task.canComplete && !done && styles.checkDisabled,
          ]}
        >
          {mark}
        </View>
      }
      title={task.title}
      subtitle={overdue ? format(t.tasks.due, { date: formatDay(task.dueDate, intlLocale) }) : task.description}
      subtitleColor={overdue ? palette.danger : undefined}
      subtitleLines={3}
      value={task.dueDate ? formatDay(task.dueDate, intlLocale) : null}
      detail={task.canComplete ? undefined : format(t.tasks.assignedTo, { role: labelFor(t.tasks.roles, task.assigneeRole) })}
      detailColor={palette.muted}
      muted={done}
      strike={done}
      onPress={toggle}
      disabled={!task.canComplete || complete.isPending}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done, disabled: !task.canComplete }}
    />
  );
}

const styles = StyleSheet.create({
  check: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 7,
  },
  checkDisabled: { opacity: 0.4 },
});
