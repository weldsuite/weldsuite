import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { LogOut, Moon, Sun } from 'lucide-react-native';

export default function SettingsScreen() {
  const { theme, colors, toggleTheme } = useTheme();
  const { user, signOut } = useClerkAuth();
  const { currentWorkspace } = useWorkspace();

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Settings</Text>
      </View>

      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>Account</Text>
        <View style={[styles.row, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.label, { color: colors.text }]}>{user?.fullName || user?.email || 'User'}</Text>
          <Text style={[styles.value, { color: colors.muted }]}>{user?.email}</Text>
        </View>
        {currentWorkspace && (
          <View style={styles.row}>
            <Text style={[styles.label, { color: colors.text }]}>Workspace</Text>
            <Text style={[styles.value, { color: colors.muted }]}>{currentWorkspace.name}</Text>
          </View>
        )}
      </View>

      <View style={[styles.section, { backgroundColor: colors.card }]}>
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>Appearance</Text>
        <TouchableOpacity style={styles.row} onPress={toggleTheme}>
          <View style={styles.rowLeft}>
            {theme === 'dark' ? <Moon size={20} color={colors.text} /> : <Sun size={20} color={colors.text} />}
            <Text style={[styles.label, { color: colors.text }]}>Dark Mode</Text>
          </View>
          <Text style={[styles.value, { color: colors.muted }]}>{theme === 'dark' ? 'On' : 'Off'}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.signOutButton} onPress={signOut}>
        <LogOut size={20} color="#EF4444" />
        <Text style={styles.signOutText}>Sign Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 60, paddingBottom: 16 },
  headerTitle: { fontSize: 34, fontWeight: '700' },
  section: { marginHorizontal: 16, marginBottom: 24, borderRadius: 12, overflow: 'hidden' },
  sectionTitle: { fontSize: 13, fontWeight: '500', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 0.5 },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { fontSize: 16 },
  value: { fontSize: 15 },
  signOutButton: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, paddingVertical: 16, justifyContent: 'center' },
  signOutText: { fontSize: 16, fontWeight: '500', color: '#EF4444' },
});
