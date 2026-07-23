import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { StatusBadge } from './StatusBadge';
import type { Project } from '@/types/weldflow';

export function ProjectCard({ project }: { project: Project }) {
  const { colors } = useTheme();
  const router = useRouter();

  const progressNum = Number(project.progress ?? 0);
  const color = project.color || '#6366F1';

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}
      onPress={() => router.push(`/project/${project.id}`)}
      activeOpacity={0.7}
    >
      <View style={styles.header}>
        <View style={[styles.colorDot, { backgroundColor: color }]} />
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {project.name}
        </Text>
      </View>

      <View style={styles.metaRow}>
        <StatusBadge status={project.status} />
        {project.code ? (
          <Text style={[styles.code, { color: colors.muted }]}>{project.code}</Text>
        ) : null}
      </View>

      <View style={styles.progressRow}>
        <View style={[styles.progressBar, { backgroundColor: colors.divider }]}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.min(100, Math.max(0, progressNum))}%`, backgroundColor: color },
            ]}
          />
        </View>
        <Text style={[styles.progressLabel, { color: colors.muted }]}>{progressNum.toFixed(0)}%</Text>
      </View>

      <View style={styles.footer}>
        <Text style={[styles.stat, { color: colors.muted }]}>
          {project.completedTasks}/{project.totalTasks} tasks
        </Text>
        {project.endDate ? (
          <Text style={[styles.stat, { color: colors.muted }]}>
            Due {new Date(project.endDate).toLocaleDateString()}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: 0.5,
    padding: 16,
    marginBottom: 12,
    gap: 10,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  colorDot: { width: 10, height: 10, borderRadius: 5 },
  title: { fontSize: 17, fontWeight: '600', flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  code: { fontSize: 12, fontWeight: '500' },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  progressBar: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3 },
  progressLabel: { fontSize: 12, fontWeight: '600', minWidth: 40, textAlign: 'right' },
  footer: { flexDirection: 'row', justifyContent: 'space-between' },
  stat: { fontSize: 12 },
});
