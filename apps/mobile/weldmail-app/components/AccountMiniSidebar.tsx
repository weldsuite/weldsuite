import React from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useMail, getAvatarColor } from '@/contexts/MailContext';
import { usePermissions } from '@/contexts/PermissionContext';
import WeldMailLogo from '@/components/WeldMailLogo';

const MINI_SIDEBAR_WIDTH = 68;

export default function AccountMiniSidebar() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const {
    accounts, selectedAccount, selectAccount,
    isUnifiedInbox, selectUnifiedInbox,
  } = useMail();
  const { can } = usePermissions();

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          backgroundColor: colors.card || colors.background,
          borderRightColor: colors.divider,
        },
      ]}
    >
      <ScrollView showsVerticalScrollIndicator={false} style={styles.content}>
        {/* Unified inbox */}
        <TouchableOpacity style={styles.item} onPress={selectUnifiedInbox} activeOpacity={0.7}>
          <View style={[styles.avatar, isUnifiedInbox ? styles.avatarUnifiedActive : styles.avatarUnified]}>
            <WeldMailLogo size={24} color={isUnifiedInbox ? '#f6663e' : '#9CA3AF'} />
          </View>
          {isUnifiedInbox && <View style={styles.activeIndicator} />}
        </TouchableOpacity>

        {accounts.length > 0 && (
          <View style={[styles.divider, { backgroundColor: colors.divider, opacity: 0.4 }]} />
        )}

        {accounts.map((account) => {
          const isActive = !isUnifiedInbox && selectedAccount?.id === account.id;
          const avatarColor = getAvatarColor(account.displayName);
          return (
            <TouchableOpacity
              key={account.id}
              style={styles.item}
              onPress={() => selectAccount(account)}
              activeOpacity={0.7}
            >
              <View style={[styles.avatar, { backgroundColor: avatarColor }, isActive && styles.avatarRing]}>
                <Text style={styles.avatarText}>
                  {account.displayName?.charAt(0).toUpperCase() || 'U'}
                </Text>
              </View>
              {isActive && <View style={styles.activeIndicator} />}
            </TouchableOpacity>
          );
        })}

        {/* Add account — only for members who can create mail accounts */}
        {can('accounts:create') && (
          <TouchableOpacity
            style={styles.item}
            onPress={() => router.push('/add-account' as any)}
            activeOpacity={0.7}
          >
            <View style={[styles.avatar, styles.addButton]}>
              <Plus size={20} color="#B0B5BC" strokeWidth={2} />
            </View>
          </TouchableOpacity>
        )}
      </ScrollView>

      <View style={{ paddingBottom: insets.bottom + 8 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: MINI_SIDEBAR_WIDTH,
    borderRightWidth: 0.5,
    flexDirection: 'column',
    paddingTop: 12,
  },
  content: {
    flex: 1,
  },
  item: {
    alignItems: 'center',
    paddingVertical: 6,
    position: 'relative',
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
  },
  avatarActive: {
    backgroundColor: '#3B82F6',
  },
  avatarUnified: {
    backgroundColor: '#F3F4F6',
  },
  avatarUnifiedActive: {
    backgroundColor: '#FEF0EC',
  },
  avatarRing: {
    borderWidth: 2.5,
    borderColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 3,
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  addButton: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderStyle: 'dashed',
  },
  activeIndicator: {
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderTopRightRadius: 3,
    borderBottomRightRadius: 3,
    backgroundColor: '#3B82F6',
  },
  divider: {
    height: 0.5,
    marginHorizontal: 12,
    marginVertical: 6,
  },
  bottom: {
    borderTopWidth: 0.5,
    paddingTop: 8,
  },
  settingsIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
