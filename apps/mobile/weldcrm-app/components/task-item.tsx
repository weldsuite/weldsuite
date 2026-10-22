/** One task row: checkbox, title, status, priority, record, due date, assignees. */

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Calendar, Check, Flag, Repeat } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { TASK_PRIORITY_COLORS, TASK_STATUS_COLORS } from '@/components/task-sheet';
import type { CrmTask } from '@/services/tasks';
import { useI18n } from '@/lib/i18n';
import { initialsOf } from '@/lib/crm';
import { formatDueLabel, isOverdue, parseDate } from '@/lib/dates';

interface TaskItemProps {
  task: CrmTask;
  onPress: (task: CrmTask) => void;
  onToggle: (task: CrmTask) => void;
  /** Hide the record name (on the record's own Tasks tab). */
  hideRecord?: boolean;
}

export function TaskItem({ task, onPress, onToggle, hideRecord }: Readonly<TaskItemProps>) {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const dueDate = parseDate(task.dueDate);
  const overdue = !!dueDate && !task.completed && isOverdue(dueDate);
  const statusColors = TASK_STATUS_COLORS[task.status];

  return (
    <TouchableOpacity
      style={styles.taskItem}
      activeOpacity={0.7}
      onPress={() => onPress(task)}
      accessibilityRole="button"
      accessibilityLabel={task.title}
    >
      <View style={styles.taskRow}>
        <TouchableOpacity
          onPress={() => onToggle(task)}
          hitSlop={8}
          style={[
            styles.checkbox,
            {
              borderColor: task.completed ? '#8B5CF6' : colors.divider,
              backgroundColor: task.completed ? '#8B5CF6' : 'transparent',
            },
          ]}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: task.completed }}
          accessibilityLabel={task.completed ? t.tasks.markNotDone : t.tasks.markDone}
        >
          {task.completed && <Check size={16} color="#FFFFFF" strokeWidth={2.5} />}
        </TouchableOpacity>

        <View style={styles.taskContent}>
          <Text
            style={[styles.taskTitle, { color: colors.text }, task.completed && styles.taskTitleCompleted]}
            numberOfLines={1}
          >
            {task.title}
          </Text>

          <View style={styles.taskMeta}>
            <View style={[styles.statusBadge, { backgroundColor: statusColors.bgColor }]}>
              <Text style={[styles.statusText, { color: statusColors.color }]}>{t.tasks.status[task.status]}</Text>
            </View>

            {!!task.priority && (
              <View style={styles.metaItem}>
                <Flag size={11} color={TASK_PRIORITY_COLORS[task.priority]} strokeWidth={2} />
                <Text style={[styles.metaText, { color: TASK_PRIORITY_COLORS[task.priority] }]}>
                  {t.tasks.priority[task.priority]}
                </Text>
              </View>
            )}

            {!hideRecord && !!task.record?.name && (
              <Text style={[styles.metaText, { color: colors.muted }]} numberOfLines={1}>
                {task.record.name}
              </Text>
            )}

            {!!dueDate && (
              <View style={styles.metaItem}>
                <Calendar size={11} color={overdue ? '#EF4444' : colors.muted} strokeWidth={2} />
                <Text style={[styles.metaText, { color: overdue ? '#EF4444' : colors.muted }]}>
                  {formatDueLabel(dueDate, t, intlLocale)}
                </Text>
              </View>
            )}

            {!!task.repeat && <Repeat size={11} color={colors.muted} strokeWidth={2} />}

            {task.assignees.slice(0, 3).map((person) => (
              <View key={person.id} style={[styles.avatar, { backgroundColor: colors.secondary }]}>
                <Text style={styles.avatarText}>{initialsOf(person.name)}</Text>
              </View>
            ))}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  taskItem: { borderRadius: 8, paddingVertical: 10 },
  taskRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.25, justifyContent: 'center', alignItems: 'center', marginTop: -1 },
  taskContent: { flex: 1, gap: 6 },
  taskTitle: { fontSize: 14, fontWeight: '500' },
  taskTitleCompleted: { textDecorationLine: 'line-through', opacity: 0.5 },
  taskMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaText: { fontSize: 11, flexShrink: 1 },
  statusBadge: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4 },
  statusText: { fontSize: 10, fontWeight: '600' },
  avatar: { width: 20, height: 20, borderRadius: 4, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontSize: 8, fontWeight: '600', color: '#6B7280' },
});
