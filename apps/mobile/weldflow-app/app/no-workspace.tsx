import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useOrganizationList, useUser } from '@clerk/expo';
import { Inbox, RefreshCw, LogOut, Trash2 } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';

export default function NoWorkspaceScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, signOut } = useClerkAuth();
  const { user: clerkUser } = useUser();
  const { userMemberships, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });

  const [checking, setChecking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleRefresh = useCallback(async () => {
    setChecking(true);
    try {
      await userMemberships?.revalidate?.();
      if (userMemberships?.data && userMemberships.data.length > 0) {
        router.replace('/(tabs)');
        return;
      }
    } catch {
      // user can retry
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

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      `This will permanently delete the account for ${user?.email}. This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (!clerkUser) return;
            setDeleting(true);
            try {
              await clerkUser.delete();
              await signOut().catch(() => {});
            } catch (error) {
              console.error('Error deleting account:', error);
              Alert.alert(
                'Failed to delete account',
                'Please try again or contact privacy@weldsuite.com for help.'
              );
              setDeleting(false);
            }
          },
        },
      ]
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.content}>
        <View style={[styles.iconCircle, { backgroundColor: colors.cardBackground }]}>
          <Inbox size={48} color="#6366F1" />
        </View>

        <Text style={[styles.title, { color: colors.text }]}>Waiting for an invite</Text>

        <Text style={[styles.description, { color: colors.muted }]}>
          WeldFlow is a team app. Ask a workspace admin to invite{' '}
          <Text style={{ fontWeight: '600' }}>{user?.email}</Text> to their workspace, then come back
          here and tap refresh.
        </Text>

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={handleRefresh}
          disabled={checking || !isLoaded}
        >
          {checking ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <RefreshCw size={18} color="#fff" />
          )}
          <Text style={styles.primaryButtonText}>
            {checking ? 'Checking...' : 'Refresh'}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={styles.footer}>
        <TouchableOpacity style={styles.footerButton} onPress={handleSignOut}>
          <LogOut size={16} color={colors.muted} />
          <Text style={[styles.footerText, { color: colors.muted }]}>Sign out</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.footerButton}
          onPress={handleDeleteAccount}
          disabled={deleting}
        >
          {deleting ? (
            <ActivityIndicator size="small" color="#EF4444" />
          ) : (
            <Trash2 size={16} color="#EF4444" />
          )}
          <Text style={[styles.footerText, { color: '#EF4444' }]}>Delete account</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  iconCircle: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
  description: { fontSize: 16, lineHeight: 24, textAlign: 'center', marginBottom: 32 },
  primaryButton: {
    backgroundColor: '#6366F1',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    width: '100%',
  },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 32,
  },
  footerButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12 },
  footerText: { fontSize: 15, fontWeight: '500' },
});
