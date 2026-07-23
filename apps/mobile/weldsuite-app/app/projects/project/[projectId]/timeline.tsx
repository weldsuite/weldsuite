import React from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { GitBranch } from 'lucide-react-native';

export default function ProjectTimelineScreen() {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.placeholder}>
        <GitBranch size={48} color={colors.muted} strokeWidth={1.5} />
        <Text style={[styles.title, { color: colors.text }]}>Timeline</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>
          Project timeline view coming soon
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  placeholder: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  title: { fontSize: 18, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  subtitle: { fontSize: 14, textAlign: 'center' },
});
