import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  Modal,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Image,
  ActionSheetIOS,
  Alert,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useToast } from '@/contexts/ToastContext';
import type { WorkspaceWithMembership } from '@/services/api';

interface WorkspaceSwitcherProps {
  compact?: boolean;
}

export function WorkspaceSwitcher({ compact = false }: WorkspaceSwitcherProps) {
  const { colors } = useTheme();
  const toast = useToast();
  const {
    currentWorkspace,
    workspaces,
    isLoading,
    isLoadingWorkspaces,
    switchWorkspace,
    hasMultipleWorkspaces,
  } = useWorkspace();

  const [modalVisible, setModalVisible] = useState(false);
  const [switching, setSwitching] = useState(false);

  const handleSwitchWorkspace = async (workspace: WorkspaceWithMembership) => {
    if (workspace.clerkOrgId === currentWorkspace?.clerkOrgId) {
      setModalVisible(false);
      return;
    }

    setSwitching(true);
    try {
      await switchWorkspace(workspace.clerkOrgId);
      setModalVisible(false);
      toast.success(`Switched to ${workspace.name}`);
    } catch (error) {
      toast.error('Failed to switch workspace');
    } finally {
      setSwitching(false);
    }
  };

  const getWorkspaceInitials = (name: string) => {
    return name
      .split(' ')
      .map((word) => word[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  };

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'org:admin':
        return 'Admin';
      case 'org:member':
        return 'Member';
      default:
        return role.replace('org:', '');
    }
  };

  const renderWorkspaceItem = ({ item }: { item: WorkspaceWithMembership }) => {
    const isSelected = item.clerkOrgId === currentWorkspace?.clerkOrgId;

    return (
      <TouchableOpacity
        style={[
          styles.workspaceItem,
          { borderBottomColor: colors.divider },
          isSelected && { backgroundColor: colors.divider + '50' },
        ]}
        onPress={() => handleSwitchWorkspace(item)}
        disabled={switching}
      >
        <View style={styles.workspaceLeft}>
          {item.imageUrl ? (
            <Image source={{ uri: item.imageUrl }} style={styles.workspaceImage} />
          ) : (
            <View style={[styles.workspaceInitials, { backgroundColor: colors.text + '20' }]}>
              <Text style={[styles.workspaceInitialsText, { color: colors.text }]}>
                {getWorkspaceInitials(item.name)}
              </Text>
            </View>
          )}
          <View style={styles.workspaceInfo}>
            <Text style={[styles.workspaceName, { color: colors.text }]}>{item.name}</Text>
            <Text style={[styles.workspaceRole, { color: colors.muted }]}>
              {getRoleBadge(item.role)}
            </Text>
          </View>
        </View>
        {isSelected && <Ionicons name="checkmark" size={20} color={colors.text} />}
      </TouchableOpacity>
    );
  };

  if (isLoading) {
    return (
      <View style={styles.container}>
        <View style={styles.content}>
          <ActivityIndicator size="small" color={colors.muted} />
        </View>
      </View>
    );
  }

  // Show current workspace display
  return (
    <>
      <Pressable
        style={({ pressed }) => [styles.container, pressed && { opacity: 0.7 }]}
        onPress={() => {
          if (!hasMultipleWorkspaces) return;
          const options = [...workspaces.map(w => w.name), 'Cancel'];
          const cancelButtonIndex = options.length - 1;

          if (Platform.OS === 'ios') {
            ActionSheetIOS.showActionSheetWithOptions(
              {
                options,
                cancelButtonIndex,
                title: 'Switch Workspace',
              },
              (buttonIndex) => {
                if (buttonIndex !== cancelButtonIndex) {
                  handleSwitchWorkspace(workspaces[buttonIndex]);
                }
              }
            );
          } else {
            Alert.alert(
              'Switch Workspace',
              undefined,
              [
                ...workspaces.map(w => ({
                  text: w.name,
                  onPress: () => handleSwitchWorkspace(w),
                })),
                { text: 'Cancel', style: 'cancel' as const },
              ]
            );
          }
        }}
        disabled={!hasMultipleWorkspaces}
      >
        <View style={styles.content}>
          <View style={styles.workspaceLeft}>
            {currentWorkspace?.imageUrl ? (
              <Image
                source={{ uri: currentWorkspace.imageUrl }}
                style={compact ? styles.workspaceImageSmall : styles.workspaceImage}
              />
            ) : (
              <View
                style={[
                  compact ? styles.workspaceInitialsSmall : styles.workspaceInitials,
                  { backgroundColor: colors.text + '20' },
                ]}
              >
                <Text
                  style={[
                    compact ? styles.workspaceInitialsTextSmall : styles.workspaceInitialsText,
                    { color: colors.text },
                  ]}
                >
                  {currentWorkspace ? getWorkspaceInitials(currentWorkspace.name) : '--'}
                </Text>
              </View>
            )}
            <View style={styles.workspaceInfo}>
              <Text style={[styles.currentWorkspaceLabel, { color: colors.muted }]}>
                Workspace
              </Text>
              <Text style={[styles.currentWorkspaceName, { color: colors.text }]}>
                {currentWorkspace?.name || 'No workspace'}
              </Text>
            </View>
          </View>
          {hasMultipleWorkspaces && (
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          )}
        </View>
      </Pressable>

      {/* Workspace Switcher Modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setModalVisible(false)}
      >
        <SafeAreaView style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          {/* Modal Header */}
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Switch Workspace</Text>
            <TouchableOpacity
              onPress={() => setModalVisible(false)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

          {/* Workspace List */}
          {isLoadingWorkspaces ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={colors.muted} />
            </View>
          ) : (
            <FlatList
              data={workspaces}
              keyExtractor={(item) => item.id}
              renderItem={renderWorkspaceItem}
              contentContainerStyle={styles.workspaceList}
              ListEmptyComponent={
                <View style={styles.emptyContainer}>
                  <Text style={[styles.emptyText, { color: colors.muted }]}>
                    No workspaces available
                  </Text>
                </View>
              }
            />
          )}

          {/* Switching Overlay */}
          {switching && (
            <View style={styles.switchingOverlay}>
              <ActivityIndicator size="large" color={colors.text} />
              <Text style={[styles.switchingText, { color: colors.text }]}>
                Switching workspace...
              </Text>
            </View>
          )}
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 12,
    paddingHorizontal: 0,
  },
  content: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  workspaceLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  workspaceImage: {
    width: 38,
    height: 38,
    borderRadius: 13,
  },
  workspaceImageSmall: {
    width: 32,
    height: 32,
    borderRadius: 10,
  },
  workspaceInitials: {
    width: 38,
    height: 38,
    borderRadius: 13,
    justifyContent: 'center',
    alignItems: 'center',
  },
  workspaceInitialsSmall: {
    width: 32,
    height: 32,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  workspaceInitialsText: {
    fontSize: 14,
    fontWeight: '600',
  },
  workspaceInitialsTextSmall: {
    fontSize: 12,
    fontWeight: '600',
  },
  workspaceInfo: {
    gap: 2,
  },
  currentWorkspaceLabel: {
    fontSize: 13,
    fontWeight: '400',
  },
  currentWorkspaceName: {
    fontSize: 17,
    fontWeight: '500',
  },
  // Modal styles
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  workspaceList: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  workspaceItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  workspaceName: {
    fontSize: 17,
    fontWeight: '500',
  },
  workspaceRole: {
    fontSize: 15,
    fontWeight: '400',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    padding: 32,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
  },
  switchingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  switchingText: {
    fontSize: 14,
    fontWeight: '500',
  },
});

export default WorkspaceSwitcher;
