import { useState } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Alert,
  Linking,
} from 'react-native';
import { useUser } from '@clerk/expo';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { ChevronRight } from 'lucide-react-native';

import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard } from '@/components/detail';
import { useI18n } from '@/lib/i18n';

export default function PrivacyScreen() {
  const { colors } = useTheme();
  const { user: clerkUser } = useUser();
  const { user, signOut } = useClerkAuth();
  const { t } = useI18n();
  const [deletingAccount, setDeletingAccount] = useState(false);

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This action cannot be undone. Your account, profile, and access to all workspaces will be permanently removed.\n\nAre you absolutely sure?',
      [
        { text: t.common.cancel, style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Final Confirmation',
              `Permanently delete the account for ${user?.email}?\n\nThis is your last chance to cancel.`,
              [
                { text: t.common.cancel, style: 'cancel' },
                {
                  text: 'I Understand, Delete',
                  style: 'destructive',
                  onPress: async () => {
                    if (!clerkUser) return;
                    setDeletingAccount(true);
                    try {
                      await clerkUser.delete();
                      await signOut().catch(() => {});
                    } catch (error) {
                      console.error('Error deleting account:', error);
                      Alert.alert(
                        'Failed to delete account',
                        'Please try again or contact privacy@weldsuite.com for help.',
                      );
                      setDeletingAccount(false);
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  };

  return (
    <Screen header={<ScreenHeader title={t.settings.privacyAccount} showBack />}>
      <ScrollView contentContainerStyle={styles.content}>
        <SectionCard title={t.settings.privacy}>
          <LinkRow
            label="Privacy Policy"
            onPress={() => Linking.openURL('https://weldsuite.com/privacy')}
          />
          <LinkRow
            label="Terms of Service"
            onPress={() => Linking.openURL('https://weldsuite.com/terms')}
          />
          <LinkRow
            label="Contact Support"
            onPress={() =>
              Linking.openURL('mailto:privacy@weldsuite.com?subject=Privacy%20Inquiry')
            }
          />
        </SectionCard>

        <SectionCard title={t.settings.account}>
          <Pressable
            onPress={handleDeleteAccount}
            disabled={deletingAccount}
            accessibilityRole="button"
            style={({ pressed }) => [styles.deleteRow, pressed && { opacity: 0.7 }]}
          >
            {deletingAccount ? (
              <ActivityIndicator color={colors.destructive} />
            ) : (
              <Text style={[styles.deleteText, { color: colors.destructive }]}>
                Delete account
              </Text>
            )}
          </Pressable>
        </SectionCard>
      </ScrollView>
    </Screen>
  );
}

function LinkRow({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
    >
      <Text style={[styles.linkLabel, { color: colors.text }]}>{label}</Text>
      <ChevronRight size={18} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 32 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  linkLabel: { fontSize: 15, fontWeight: '500' },
  deleteRow: { paddingVertical: 10, alignItems: 'center' },
  deleteText: { fontSize: 15, fontWeight: '600' },
});
