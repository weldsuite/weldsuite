import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Linking, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useOrganizationList } from '@clerk/expo';
import { Globe, RefreshCw, LogOut } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';

const WELDSUITE_URL = 'https://weldsuite.com';

export default function NoWorkspaceScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useClerkAuth();
  const { userMemberships } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  const [checking, setChecking] = useState(false);

  const handleOpenWebsite = () => {
    Linking.openURL(WELDSUITE_URL);
  };

  const handleRefresh = useCallback(async () => {
    setChecking(true);
    try {
      await userMemberships?.revalidate?.();
      if (userMemberships?.data && userMemberships.data.length > 0) {
        router.replace('/(tabs)');
        return;
      }
    } catch {
      // Ignore errors — user can retry
    }
    setChecking(false);
  }, [userMemberships, router]);

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch {
      router.replace('/authorisation');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.content}>
        <View style={[styles.iconCircle, { backgroundColor: colors.card }]}>
          <Globe size={48} color="{{PRIMARY_COLOR}}" />
        </View>

        <Text style={[styles.title, { color: colors.text }]}>
          Create your workspace
        </Text>

        <Text style={[styles.description, { color: colors.muted }]}>
          To get started with {{APP_NAME}}, create your workspace on our website. Once your workspace is ready, come back here to sign in.
        </Text>

        <TouchableOpacity style={styles.primaryButton} onPress={handleOpenWebsite}>
          <Globe size={18} color="#fff" />
          <Text style={styles.primaryButtonText}>Go to weldsuite.com</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryButton, { borderColor: colors.border }]}
          onPress={handleRefresh}
          disabled={checking}
        >
          {checking ? (
            <ActivityIndicator size="small" color="{{PRIMARY_COLOR}}" />
          ) : (
            <RefreshCw size={18} color="{{PRIMARY_COLOR}}" />
          )}
          <Text style={[styles.secondaryButtonText, { color: '{{PRIMARY_COLOR}}' }]}>
            {checking ? 'Checking...' : "I've created my workspace"}
          </Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
        <LogOut size={16} color={colors.muted} />
        <Text style={[styles.signOutText, { color: colors.muted }]}>Sign out</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  iconCircle: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
  description: { fontSize: 16, lineHeight: 24, textAlign: 'center', marginBottom: 32 },
  primaryButton: { backgroundColor: '{{PRIMARY_COLOR}}', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%' },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondaryButton: { borderRadius: 12, borderWidth: 1, paddingVertical: 14, paddingHorizontal: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', marginTop: 12 },
  secondaryButtonText: { fontSize: 16, fontWeight: '600' },
  signOutButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 16 },
  signOutText: { fontSize: 15 },
});
