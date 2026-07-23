import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import api from '@/services/api';
import { ChevronLeft } from 'lucide-react-native';
import Constants from 'expo-constants';

type AppSettings = {
  currency: string;
  fiscalYearStart: string;
};

export default function SettingsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const workspace = useWorkspace();

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getSettings();
      setSettings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const appVersion = Constants.expoConfig?.version || '1.0.0';

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <ChevronLeft size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>Settings</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#10B981" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={fetchSettings}>
              <Text style={styles.errorRetry}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Account */}
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>ACCOUNT</Text>
        <View style={[styles.sectionCard, { backgroundColor: colors.cardBackground }]}>
          <View style={styles.settingRow}>
            <Text style={[styles.settingLabel, { color: colors.muted }]}>Workspace</Text>
            <Text style={[styles.settingValue, { color: colors.text }]}>
              {workspace?.name || 'Unknown'}
            </Text>
          </View>
        </View>

        {/* Preferences */}
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>PREFERENCES</Text>
        <View style={[styles.sectionCard, { backgroundColor: colors.cardBackground }]}>
          <View style={styles.settingRow}>
            <Text style={[styles.settingLabel, { color: colors.muted }]}>Currency</Text>
            <Text style={[styles.settingValue, { color: colors.text }]}>
              {settings?.currency || 'EUR'}
            </Text>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.divider }]} />
          <View style={styles.settingRow}>
            <Text style={[styles.settingLabel, { color: colors.muted }]}>Fiscal Year Start</Text>
            <Text style={[styles.settingValue, { color: colors.text }]}>
              {settings?.fiscalYearStart || 'January'}
            </Text>
          </View>
        </View>

        {/* App */}
        <Text style={[styles.sectionTitle, { color: colors.muted }]}>APP</Text>
        <View style={[styles.sectionCard, { backgroundColor: colors.cardBackground }]}>
          <View style={styles.settingRow}>
            <Text style={[styles.settingLabel, { color: colors.muted }]}>Version</Text>
            <Text style={[styles.settingValue, { color: colors.text }]}>{appVersion}</Text>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.divider }]} />
          <View style={styles.settingRow}>
            <Text style={[styles.settingLabel, { color: colors.muted }]}>About</Text>
            <Text style={[styles.settingValue, { color: colors.text }]}>WeldBooks</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backButton: {
    width: 32,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  headerSpacer: {
    width: 32,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 13,
    flex: 1,
  },
  errorRetry: {
    color: '#EF4444',
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 12,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.8,
    marginBottom: 8,
    marginTop: 20,
    marginLeft: 4,
  },
  sectionCard: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  settingLabel: {
    fontSize: 14,
  },
  settingValue: {
    fontSize: 15,
    fontWeight: '500',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
});
