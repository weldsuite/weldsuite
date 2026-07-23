import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Calendar } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { StatusBadge } from './StatusBadge';
import { PriorityIndicator } from './PriorityIndicator';
import type { ProjectTask, ProjectTaskWithProject } from '@/types/weldflow';

interface Props {
  task: ProjectTask | ProjectTaskWithProject;
  onPress: () => void;
  showProject?: boolean;
}

export function TaskCard({ task, onPress, showProject = false }: Props) {
  const { colors } = useTheme();

  const project = 'project' in task ? task.project : null;
  const isOverdue =
    task.dueDate &&
    task.status !== 'done' &&
    task.status !== 'cancelled' &&
    new Date(task.dueDate).getTime() < Date.now();

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.topRow}>
        <PriorityIndicator priority={task.priority} />
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {task.title}
        </Text>
      </View>

      {showProject && project ? (
        <Text style={[styles.project, { color: colors.muted }]} numberOfLines={1}>
          {project.name}
        </Text>
      ) : null}

      <View style={styles.metaRow}>
        <StatusBadge status={task.status} />
        {task.dueDate ? (
          <View style={styles.dueDate}>
            <Calendar size={12} color={isOverdue ? '#DC2626' : colors.muted} />
            <Text style={[styles.dueDateText, { color: isOverdue ? '#DC2626' : colors.muted }]}>
              {new Date(task.dueDate).toLocaleDateString()}
            </Text>
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 10,
    borderWidth: 0.5,
    padding: 12,
    marginBottom: 8,
    gap: 8,
  },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  title: { fontSize: 15, fontWeight: '500', flex: 1, lineHeight: 20 },
  project: { fontSize: 12, fontWeight: '500' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dueDate: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dueDateText: { fontSize: 12, fontWeight: '500' },
});
