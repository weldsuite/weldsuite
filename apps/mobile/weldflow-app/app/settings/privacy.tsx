import React, { useState } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useUser } from '@clerk/expo';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';

export default function PrivacyScreen() {
  const { colors } = useTheme();
  const { user: clerkUser } = useUser();
  const { user, signOut } = useClerkAuth();
  const [deletingAccount, setDeletingAccount] = useState(false);

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This action cannot be undone. Your account, profile, and access to all workspaces will be permanently removed.\n\nAre you absolutely sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Final Confirmation',
              `Permanently delete the account for ${user?.email}?\n\nThis is your last chance to cancel.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'I Understand, Delete',
                  style: 'destructive',
                  onPress: async () => {
                    if (!clerkUser) return;
                    setDeletingAccount(true);
                    try {
                      await clerkUser.delete();
                      // Clerk clears the session on delete; sign out as a safety net.
                      await signOut().catch(() => {});
                    } catch (error) {
                      console.error('Error deleting account:', error);
                      Alert.alert(
                        'Failed to delete account',
                        'Please try again or contact privacy@weldsuite.com for help.'
                      );
                      setDeletingAccount(false);
                    }
                  },
                },
              ]
            );
          },
        },
      ]
    );
  };

  const handleOpenPrivacyPolicy = () => {
    Linking.openURL('https://weldsuite.com/privacy');
  };

  const handleOpenTermsOfService = () => {
    Linking.openURL('https://weldsuite.com/terms');
  };

  const handleContactSupport = () => {
    Linking.openURL('mailto:privacy@weldsuite.com?subject=Privacy%20Inquiry');
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Your Data</Text>
          <Text style={[styles.sectionDescription, { color: colors.muted }]}>
            You have the right to access, export, and delete your personal data at any time. To request a
            copy of your data, contact us at the address below.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Legal</Text>

          <TouchableOpacity
            style={[styles.settingItem, { borderBottomColor: colors.divider }]}
            onPress={handleOpenPrivacyPolicy}
          >
            <View style={styles.settingContent}>
              <Text style={[styles.settingLabel, { color: colors.text }]}>Privacy Policy</Text>
              <Text style={[styles.settingDescription, { color: colors.muted }]}>
                How we collect and use your data
              </Text>
            </View>
            <Ionicons name="open-outline" size={16} color={colors.muted} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.settingItem, { borderBottomColor: colors.divider }]}
            onPress={handleOpenTermsOfService}
          >
            <View style={styles.settingContent}>
              <Text style={[styles.settingLabel, { color: colors.text }]}>Terms of Service</Text>
              <Text style={[styles.settingDescription, { color: colors.muted }]}>
                Terms and conditions for using WeldFlow
              </Text>
            </View>
            <Ionicons name="open-outline" size={16} color={colors.muted} />
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Contact</Text>

          <TouchableOpacity
            style={[styles.settingItem, { borderBottomColor: colors.divider }]}
            onPress={handleContactSupport}
          >
            <View style={styles.settingContent}>
              <Text style={[styles.settingLabel, { color: colors.text }]}>Privacy Inquiries</Text>
              <Text style={[styles.settingDescription, { color: colors.muted }]}>
                privacy@weldsuite.com
              </Text>
            </View>
            <Ionicons name="mail-outline" size={16} color={colors.muted} />
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: '#F44336' }]}>Danger Zone</Text>

          <View style={[styles.dangerCard, { borderColor: '#F44336' }]}>
            <View style={styles.dangerContent}>
              <Ionicons name="warning-outline" size={24} color="#F44336" />
              <View style={styles.dangerText}>
                <Text style={[styles.dangerTitle, { color: colors.text }]}>Delete Account</Text>
                <Text style={[styles.dangerDescription, { color: colors.muted }]}>
                  Permanently delete your account and all associated data. This action cannot be undone.
                </Text>
              </View>
            </View>

            <TouchableOpacity
              style={styles.deleteButton}
              onPress={handleDeleteAccount}
              disabled={deletingAccount}
            >
              {deletingAccount ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.deleteButtonText}>Delete My Account</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  section: { marginTop: 24, paddingHorizontal: 16 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  sectionDescription: { fontSize: 14, lineHeight: 20, marginBottom: 16 },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  settingContent: { flex: 1, gap: 2, paddingRight: 12 },
  settingLabel: { fontSize: 15, fontWeight: '400' },
  settingDescription: { fontSize: 12, fontWeight: '400' },
  dangerCard: { borderWidth: 1, borderRadius: 12, padding: 16 },
  dangerContent: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 16 },
  dangerText: { flex: 1 },
  dangerTitle: { fontSize: 16, fontWeight: '600' },
  dangerDescription: { fontSize: 13, lineHeight: 18, marginTop: 4 },
  deleteButton: {
    backgroundColor: '#F44336',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
