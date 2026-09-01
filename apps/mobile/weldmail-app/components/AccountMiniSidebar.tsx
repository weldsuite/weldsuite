import React, { useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Building2 } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useMail, getAvatarColor } from '@/contexts/MailContext';
import { usePermissions } from '@/contexts/PermissionContext';
import { useNotifications } from '@/contexts/NotificationContext';
import WeldMailLogo from '@/components/WeldMailLogo';
import { BRAND } from '@/lib/brand';

const MINI_SIDEBAR_WIDTH = 68;

export default function AccountMiniSidebar() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const {
    accounts, selectedAccount, selectAccount, selectAccountById,
    isUnifiedInbox, selectUnifiedInbox, hasPersonalAccount,
  } = useMail();
  const { can } = usePermissions();
  const { organizationId } = useClerkAuth();
  const { workspaces, switchWorkspace } = useWorkspace();
  const { prepareWorkspaceSwitch } = useNotifications();

  const personalAccounts = accounts.filter((a) => a.tenantKind === 'personal');
  const currentOrgAccounts = accounts.filter(
    (a) => a.tenantKind === 'workspace' && (!a.clerkOrgId || a.clerkOrgId === organizationId),
  );
  const otherOrgAccounts = accounts.filter(
    (a) => a.tenantKind === 'workspace' && a.clerkOrgId && a.clerkOrgId !== organizationId,
  );
  const listedOrgIds = new Set(
    accounts.filter((a) => a.tenantKind === 'workspace' && a.clerkOrgId).map((a) => a.clerkOrgId),
  );
  const otherWorkspaces = workspaces.filter(
    (ws) => ws.clerkOrgId !== organizationId && !listedOrgIds.has(ws.clerkOrgId),
  );

  const openAccount = useCallback(
    async (account: typeof accounts[number]) => {
      if (
        account.tenantKind === 'personal' ||
        !account.clerkOrgId ||
        account.clerkOrgId === organizationId
      ) {
        selectAccount(account);
        return;
      }
      selectAccountById(account.id);
      try {
        await prepareWorkspaceSwitch();
        await switchWorkspace(account.clerkOrgId);
      } catch (err) {
        console.error('Failed to switch workspace for mailbox:', err);
      }
    },
    [organizationId, selectAccount, selectAccountById, prepareWorkspaceSwitch, switchWorkspace],
  );

  const openWorkspace = useCallback(
    async (clerkOrgId: string) => {
      if (clerkOrgId === organizationId) {
        selectUnifiedInbox();
        return;
      }
      try {
        await prepareWorkspaceSwitch();
        await switchWorkspace(clerkOrgId);
      } catch (err) {
        console.error('Failed to switch workspace:', err);
      }
    },
    [organizationId, selectUnifiedInbox, prepareWorkspaceSwitch, switchWorkspace],
  );

  const showAdd = can('accounts:create') || !hasPersonalAccount;

  const renderAccount = (account: typeof accounts[number]) => {
    const isActive = !isUnifiedInbox && selectedAccount?.id === account.id;
    const avatarColor = getAvatarColor(account.displayName);
    return (
      <TouchableOpacity
        key={account.id}
        style={styles.item}
        onPress={() => openAccount(account)}
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
  };

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
        <TouchableOpacity style={styles.item} onPress={selectUnifiedInbox} activeOpacity={0.7}>
          <View style={[styles.avatar, isUnifiedInbox ? styles.avatarUnifiedActive : styles.avatarUnified]}>
            <WeldMailLogo size={24} color={isUnifiedInbox ? BRAND : colors.muted} />
          </View>
          {isUnifiedInbox && <View style={styles.activeIndicator} />}
        </TouchableOpacity>

        {personalAccounts.length > 0 && (
          <View style={[styles.divider, { backgroundColor: colors.divider, opacity: 0.4 }]} />
        )}
        {personalAccounts.map(renderAccount)}

        {currentOrgAccounts.length > 0 && (
          <View style={[styles.divider, { backgroundColor: colors.divider, opacity: 0.4 }]} />
        )}
        {currentOrgAccounts.map(renderAccount)}

        {(otherOrgAccounts.length > 0 || otherWorkspaces.length > 0) && (
          <View style={[styles.divider, { backgroundColor: colors.divider, opacity: 0.4 }]} />
        )}
        {otherOrgAccounts.map(renderAccount)}
        {otherWorkspaces.map((ws) => (
          <TouchableOpacity
            key={ws.clerkOrgId}
            style={styles.item}
            onPress={() => openWorkspace(ws.clerkOrgId)}
            activeOpacity={0.7}
          >
            <View style={[styles.avatar, styles.workspaceButton, { borderColor: colors.divider }]}>
              <Building2 size={18} color={colors.muted} strokeWidth={2} />
            </View>
          </TouchableOpacity>
        ))}

        {showAdd && (
          <TouchableOpacity
            style={styles.item}
            onPress={() => router.push('/add-account' as never)}
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
  avatarUnified: {
    backgroundColor: '#F3F4F6',
  },
  avatarUnifiedActive: {
    backgroundColor: 'rgba(240,101,67,0.12)',
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
  workspaceButton: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
  },
  activeIndicator: {
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderTopRightRadius: 3,
    borderBottomRightRadius: 3,
    backgroundColor: BRAND,
  },
  divider: {
    height: 0.5,
    marginHorizontal: 12,
    marginVertical: 6,
  },
});
