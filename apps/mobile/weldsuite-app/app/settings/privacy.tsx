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
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useClerkAuth } from '@/contexts/ClerkAuthContext';
import api from '@/services/api';

export default function PrivacyScreen() {
  const { colors } = useTheme();
  const { showToast } = useToast();
  const { user, signOut } = useClerkAuth();
  const [exportingData, setExportingData] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);

  const handleExportData = async () => {
    Alert.alert(
      'Export Your Data',
      'We will prepare a download of your personal data. This may take a few minutes. You will receive an email when your data is ready.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Request Export',
          onPress: async () => {
            setExportingData(true);
            try {
              const response = await api.requestDataExport();
              if (response.success) {
                showToast('Data export requested. Check your email.', 'success');
              } else {
                showToast(response.error || 'Failed to request data export', 'error');
              }
            } catch (error) {
              console.error('Error requesting data export:', error);
              showToast('Failed to request data export', 'error');
            } finally {
              setExportingData(false);
            }
          },
        },
      ]
    );
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This action cannot be undone. All your data will be permanently deleted, including:\n\n- Your profile and preferences\n- All notifications and history\n- Access to all organizations\n\nAre you absolutely sure?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            // Double confirmation
            Alert.alert(
              'Final Confirmation',
              `Type "DELETE" to confirm deletion of your account (${user?.email}).\n\nThis is your last chance to cancel.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'I Understand, Delete',
                  style: 'destructive',
                  onPress: async () => {
                    setDeletingAccount(true);
                    try {
                      const response = await api.deleteAccount();
                      if (response.success) {
                        showToast('Account deletion requested', 'success');
                        // Clear session and log out
                        await signOut();
                      } else {
                        showToast(response.error || 'Failed to delete account', 'error');
                      }
                    } catch (error) {
                      console.error('Error deleting account:', error);
                      showToast('Failed to delete account', 'error');
                    } finally {
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
        {/* Data Portability */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Your Data</Text>
          <Text style={[styles.sectionDescription, { color: colors.muted }]}>
            You have the right to access, export, and delete your personal data at any time.
          </Text>

          <TouchableOpacity
            style={[styles.actionItem, { borderColor: colors.divider }]}
            onPress={handleExportData}
            disabled={exportingData}
          >
            <View style={styles.actionContent}>
              <View style={[styles.actionIcon, { backgroundColor: colors.divider }]}>
                <Ionicons name="download-outline" size={24} color={colors.text} />
              </View>
              <View style={styles.actionText}>
                <Text style={[styles.actionTitle, { color: colors.text }]}>Export Your Data</Text>
                <Text style={[styles.actionDescription, { color: colors.muted }]}>
                  Download a copy of all your personal data
                </Text>
              </View>
            </View>
            {exportingData ? (
              <ActivityIndicator size="small" color={colors.text} />
            ) : (
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            )}
          </TouchableOpacity>
        </View>

        {/* Legal Documents */}
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
                Terms and conditions for using WeldSuite
              </Text>
            </View>
            <Ionicons name="open-outline" size={16} color={colors.muted} />
          </TouchableOpacity>
        </View>

        {/* Contact */}
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

        {/* Danger Zone */}
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

        {/* Bottom spacing */}
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  section: {
    marginTop: 24,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  sectionDescription: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  actionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderWidth: 1,
    borderRadius: 12,
  },
  actionContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  actionIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionText: {
    flex: 1,
  },
  actionTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  actionDescription: {
    fontSize: 13,
    marginTop: 2,
  },
  settingItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  settingContent: {
    flex: 1,
    gap: 2,
    paddingRight: 12,
  },
  settingLabel: {
    fontSize: 15,
    fontWeight: '400',
  },
  settingDescription: {
    fontSize: 12,
    fontWeight: '400',
  },
  dangerCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
  },
  dangerContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 16,
  },
  dangerText: {
    flex: 1,
  },
  dangerTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  dangerDescription: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  deleteButton: {
    backgroundColor: '#F44336',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
