import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';

export default function HomeScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useClerkAuth();
  const { currentWorkspace } = useWorkspace();

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.greeting, { color: colors.muted }]}>
          {currentWorkspace?.name || 'Workspace'}
        </Text>
        <Text style={[styles.title, { color: colors.text }]}>
          Hey, {user?.firstName || 'there'}
        </Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Welcome to {{APP_NAME}}</Text>
        <Text style={[styles.cardBody, { color: colors.muted }]}>
          This home screen is a placeholder. Edit{' '}
          <Text style={{ fontFamily: 'monospace' }}>app/(tabs)/index.tsx</Text> to build your app.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 16 },
  greeting: { fontSize: 15, fontWeight: '500', marginBottom: 4 },
  title: { fontSize: 34, fontWeight: '700' },
  card: { marginHorizontal: 16, padding: 20, borderRadius: 12, borderWidth: 1 },
  cardTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  cardBody: { fontSize: 15, lineHeight: 22 },
});
