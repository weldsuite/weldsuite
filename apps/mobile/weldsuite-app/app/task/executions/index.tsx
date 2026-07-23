import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { Play } from 'lucide-react-native';

export default function ExecutionsPage() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={[styles.contentContainer, { paddingBottom: insets.bottom + 100 }]}
    >
      <View style={styles.header}>
        <Play size={24} color="#8B5CF6" strokeWidth={2} />
        <Text style={[styles.title, { color: colors.text }]}>Executions</Text>
      </View>

      <View style={[styles.emptyState, { borderColor: colors.border }]}>
        <Play size={48} color={colors.muted} strokeWidth={1.5} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>No executions yet</Text>
        <Text style={[styles.emptyText, { color: colors.muted }]}>
          Workflow executions will appear here once you run your first workflow.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
  },
  emptyState: {
    padding: 48,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 8,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 280,
  },
});
