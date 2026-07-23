import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useLocalSearchParams } from 'expo-router';
import {
  Plus,
  Mail,
  MoreHorizontal,
  Search,
  X,
  Trash2,
  Shield,
  UserCog,
  ChevronDown,
} from 'lucide-react-native';
import api, { WorkspaceMember } from '@/services/api';

interface Member {
  id: string;
  userId: string;
  role: string;
  isActive?: boolean;
  joinedAt?: string;
  createdAt?: string;
  // Flat structure from API
  name?: string;
  email?: string;
  picture?: string;
  // Nested structure (legacy support)
  user?: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
}

// Helper to get member display info (handles both flat and nested structures)
const getMemberName = (member: Member): string => {
  return member.name || member.user?.name || 'Unknown User';
};

const getMemberEmail = (member: Member): string => {
  return member.email || member.user?.email || member.userId;
};

const getMemberAvatar = (member: Member): string | undefined => {
  return member.picture || member.user?.avatar;
};

const roleConfig: Record<string, { label: string; color: string; bgColor: string; description: string }> = {
  owner: {
    label: 'Owner',
    color: '#9333EA',
    bgColor: '#F3E8FF',
    description: 'Full control of the project',
  },
  admin: {
    label: 'Admin',
    color: '#2563EB',
    bgColor: '#DBEAFE',
    description: 'Can manage members and settings',
  },
  member: {
    label: 'Member',
    color: '#4B5563',
    bgColor: '#F3F4F6',
    description: 'Can edit tasks and content',
  },
  viewer: {
    label: 'Viewer',
    color: '#059669',
    bgColor: '#D1FAE5',
    description: 'Read-only access',
  },
};

export default function ProjectMembersScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const { projectId } = useLocalSearchParams();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [addingMember, setAddingMember] = useState(false);
  const [newMemberRole, setNewMemberRole] = useState('member');
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [loadingWorkspaceMembers, setLoadingWorkspaceMembers] = useState(false);
  const [selectedWorkspaceMember, setSelectedWorkspaceMember] = useState<WorkspaceMember | null>(null);

  const loadMembers = useCallback(async () => {
    if (!projectId) return;

    try {
      setLoading(true);
      const response = await api.getProjectMembers(projectId as string);
      if (response.success && response.data) {
        // Handle both array and paginated response structures
        const memberItems = Array.isArray(response.data)
          ? response.data
          : (response.data as any).items || [];
        setMembers(memberItems);
      } else {
        toast.error(response.error || 'Failed to load members');
        setMembers([]);
      }
    } catch (error) {
      console.error('Error loading members:', error);
      toast.error('Failed to load members');
      setMembers([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadMembers();
  };

  const getInitials = (name?: string) => {
    if (!name) return '??';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const filteredMembers = members.filter((member) => {
    const name = getMemberName(member).toLowerCase();
    const email = getMemberEmail(member).toLowerCase();
    const query = searchQuery.toLowerCase();
    return name.includes(query) || email.includes(query);
  });

  // Load workspace members when add modal opens
  const loadWorkspaceMembers = useCallback(async () => {
    try {
      setLoadingWorkspaceMembers(true);
      const response = await api.getWorkspaceMembers();
      if (response.success && response.data) {
        // Handle both array and paginated response
        const memberItems = Array.isArray(response.data)
          ? response.data
          : (response.data as any).items || [];
        // Filter out members already in the project
        const existingUserIds = new Set(members.map(m => m.userId));
        const availableMembers = memberItems.filter(
          (m: WorkspaceMember) => !existingUserIds.has(m.userId)
        );
        setWorkspaceMembers(availableMembers);
      }
    } catch (error) {
      console.error('Error loading workspace members:', error);
    } finally {
      setLoadingWorkspaceMembers(false);
    }
  }, [members]);

  const openAddModal = () => {
    setShowAddModal(true);
    setSelectedWorkspaceMember(null);
    setNewMemberRole('member');
    loadWorkspaceMembers();
  };

  const handleAddMember = async () => {
    if (!selectedWorkspaceMember) {
      toast.error('Please select a member');
      return;
    }
    const userId = selectedWorkspaceMember.userId;

    try {
      setAddingMember(true);
      const response = await api.addProjectMember(projectId as string, {
        userId,
        role: newMemberRole,
      });

      if (response.success) {
        toast.success('Member added successfully');
        setShowAddModal(false);
        setNewMemberRole('member');
        setSelectedWorkspaceMember(null);
        loadMembers();
      } else {
        toast.error(response.error || 'Failed to add member');
      }
    } catch (error) {
      console.error('Error adding member:', error);
      toast.error('Failed to add member');
    } finally {
      setAddingMember(false);
    }
  };

  const handleRemoveMember = (member: Member) => {
    if (member.role === 'owner') {
      toast.error('Cannot remove the project owner');
      return;
    }

    Alert.alert(
      'Remove Member',
      `Are you sure you want to remove ${getMemberName(member)} from the project?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await api.removeProjectMember(projectId as string, member.userId);
              if (response.success) {
                toast.success('Member removed');
                loadMembers();
              } else {
                toast.error(response.error || 'Failed to remove member');
              }
            } catch (error) {
              toast.error('Failed to remove member');
            }
          },
        },
      ]
    );
  };

  const handleChangeRole = async (member: Member, newRole: string) => {
    if (member.role === 'owner') {
      toast.error('Cannot change the owner\'s role');
      return;
    }

    try {
      const response = await api.updateProjectMemberRole(projectId as string, member.userId, newRole);
      if (response.success) {
        toast.success('Role updated');
        setShowRoleModal(false);
        setSelectedMember(null);
        loadMembers();
      } else {
        toast.error(response.error || 'Failed to update role');
      }
    } catch (error) {
      toast.error('Failed to update role');
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const openRoleModal = (member: Member) => {
    if (member.role === 'owner') return;
    setSelectedMember(member);
    setShowRoleModal(true);
  };

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading members...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Team Members</Text>
        <Text style={[styles.memberCount, { color: colors.muted }]}>
          {members.length} member{members.length !== 1 ? 's' : ''}
        </Text>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <View style={[styles.searchContainer, { backgroundColor: colors.card }]}>
          <Search size={18} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search members..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
        <TouchableOpacity
          style={styles.addButton}
          onPress={openAddModal}
        >
          <Plus size={18} color="#FFFFFF" strokeWidth={2} />
          <Text style={styles.addButtonText}>Add</Text>
        </TouchableOpacity>
      </View>

      {/* Member List */}
      <ScrollView
        style={styles.memberList}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      >
        {filteredMembers.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>
              {searchQuery ? 'No members found' : 'No team members yet'}
            </Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              {searchQuery ? 'Try adjusting your search' : 'Add team members to collaborate on this project'}
            </Text>
          </View>
        ) : (
          filteredMembers.map((member) => {
            const role = roleConfig[member.role] || roleConfig.member;

            return (
              <View
                key={member.id}
                style={[
                  styles.memberCard,
                  { backgroundColor: colors.card, borderColor: colors.divider },
                ]}
              >
                <View style={styles.memberInfo}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>
                      {getInitials(getMemberName(member))}
                    </Text>
                  </View>
                  <View style={styles.memberDetails}>
                    <Text style={[styles.memberName, { color: colors.text }]}>
                      {getMemberName(member)}
                    </Text>
                    <Text style={[styles.memberEmail, { color: colors.muted }]} numberOfLines={1}>
                      {getMemberEmail(member)}
                    </Text>
                    <View style={styles.memberMeta}>
                      <TouchableOpacity
                        style={[styles.roleBadge, { backgroundColor: role.bgColor }]}
                        onPress={() => openRoleModal(member)}
                        disabled={member.role === 'owner'}
                      >
                        <Text style={[styles.roleText, { color: role.color }]}>
                          {role.label}
                        </Text>
                        {member.role !== 'owner' && (
                          <ChevronDown size={12} color={role.color} strokeWidth={2} />
                        )}
                      </TouchableOpacity>
                      {(member.joinedAt || member.createdAt) && (
                        <Text style={[styles.joinedDate, { color: colors.muted }]}>
                          Joined {formatDate(member.joinedAt || member.createdAt)}
                        </Text>
                      )}
                    </View>
                  </View>
                </View>
                <View style={styles.memberActions}>
                  {getMemberEmail(member) && getMemberEmail(member) !== member.userId && (
                    <TouchableOpacity style={styles.actionButton}>
                      <Mail size={18} color={colors.muted} strokeWidth={2} />
                    </TouchableOpacity>
                  )}
                  {member.role !== 'owner' && (
                    <TouchableOpacity
                      style={styles.actionButton}
                      onPress={() => handleRemoveMember(member)}
                    >
                      <Trash2 size={18} color="#EF4444" strokeWidth={2} />
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          })
        )}
        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Add Member Modal */}
      <Modal
        visible={showAddModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowAddModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={() => setShowAddModal(false)}
          />
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Add Team Member</Text>
              <TouchableOpacity onPress={() => setShowAddModal(false)}>
                <X size={20} color="#6b7280" strokeWidth={2} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Select Member</Text>
              {loadingWorkspaceMembers ? (
                <View style={styles.loadingMembersContainer}>
                  <ActivityIndicator size="small" color="#6b7280" />
                  <Text style={styles.loadingMembersText}>Loading members...</Text>
                </View>
              ) : workspaceMembers.length > 0 ? (
                <ScrollView style={styles.memberPickerList} nestedScrollEnabled>
                  {workspaceMembers.map((wsMember) => {
                    const isSelected = selectedWorkspaceMember?.userId === wsMember.userId;
                    return (
                      <TouchableOpacity
                        key={wsMember.userId}
                        style={[
                          styles.memberPickerItem,
                          isSelected && styles.memberPickerItemSelected,
                        ]}
                        onPress={() => setSelectedWorkspaceMember(wsMember)}
                      >
                        <View style={styles.memberPickerAvatar}>
                          <Text style={styles.memberPickerAvatarText}>
                            {getInitials(wsMember.name)}
                          </Text>
                        </View>
                        <View style={styles.memberPickerInfo}>
                          <Text style={styles.memberPickerName}>{wsMember.name}</Text>
                          <Text style={styles.memberPickerEmail}>{wsMember.email || wsMember.userId}</Text>
                        </View>
                        {isSelected && (
                          <View style={styles.memberPickerCheck}>
                            <Text style={styles.memberPickerCheckText}>✓</Text>
                          </View>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              ) : (
                <View style={styles.noMembersContainer}>
                  <Text style={styles.noMembersText}>All workspace members are already in this project</Text>
                </View>
              )}

            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Role</Text>
              <View style={styles.roleOptions}>
                {['admin', 'member', 'viewer'].map((roleKey) => {
                  const role = roleConfig[roleKey];
                  const isSelected = newMemberRole === roleKey;

                  return (
                    <TouchableOpacity
                      key={roleKey}
                      style={[
                        styles.roleOption,
                        isSelected && { borderColor: role.color, backgroundColor: role.bgColor },
                      ]}
                      onPress={() => setNewMemberRole(roleKey)}
                    >
                      <View style={styles.roleOptionHeader}>
                        {roleKey === 'admin' && <Shield size={16} color={role.color} strokeWidth={2} />}
                        {roleKey === 'member' && <UserCog size={16} color={role.color} strokeWidth={2} />}
                        {roleKey === 'viewer' && <Search size={16} color={role.color} strokeWidth={2} />}
                        <Text style={[styles.roleOptionLabel, { color: role.color }]}>
                          {role.label}
                        </Text>
                      </View>
                      <Text style={styles.roleOptionDesc}>{role.description}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setShowAddModal(false)}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.confirmButton,
                  (!selectedWorkspaceMember || addingMember) && styles.confirmButtonDisabled,
                ]}
                onPress={handleAddMember}
                disabled={!selectedWorkspaceMember || addingMember}
              >
                {addingMember ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.confirmButtonText}>Add Member</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Role Selection Modal */}
      <Modal
        visible={showRoleModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowRoleModal(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setShowRoleModal(false)}
        >
          <View style={styles.roleModalContent}>
            <Text style={styles.roleModalTitle}>Change Role</Text>
            <Text style={styles.roleModalSubtitle}>
              {selectedMember ? getMemberName(selectedMember) : 'Member'}
            </Text>

            {['admin', 'member', 'viewer'].map((roleKey) => {
              const role = roleConfig[roleKey];
              const isSelected = selectedMember?.role === roleKey;

              return (
                <TouchableOpacity
                  key={roleKey}
                  style={[
                    styles.roleSelectOption,
                    isSelected && { backgroundColor: role.bgColor },
                  ]}
                  onPress={() => selectedMember && handleChangeRole(selectedMember, roleKey)}
                >
                  <View style={[styles.roleSelectDot, { backgroundColor: role.color }]} />
                  <View style={styles.roleSelectInfo}>
                    <Text style={[styles.roleSelectLabel, { color: colors.text }]}>
                      {role.label}
                    </Text>
                    <Text style={[styles.roleSelectDesc, { color: colors.muted }]}>
                      {role.description}
                    </Text>
                  </View>
                  {isSelected && (
                    <View style={[styles.roleSelectCheck, { backgroundColor: role.color }]}>
                      <Text style={styles.roleSelectCheckText}>✓</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  header: {
    padding: 16,
    paddingBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
  },
  memberCount: {
    fontSize: 14,
    marginTop: 4,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 12,
  },
  searchContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#111827',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  memberList: {
    flex: 1,
    paddingHorizontal: 16,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
  memberCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
  },
  memberInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E5E7EB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
  },
  memberDetails: {
    flex: 1,
  },
  memberName: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  memberEmail: {
    fontSize: 13,
    marginBottom: 6,
  },
  memberMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  roleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  roleText: {
    fontSize: 12,
    fontWeight: '600',
  },
  joinedDate: {
    fontSize: 11,
  },
  memberActions: {
    flexDirection: 'row',
    gap: 4,
  },
  actionButton: {
    padding: 8,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContent: {
    width: 400,
    maxWidth: '90%',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
  },
  inputGroup: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 8,
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#111827',
  },
  roleOptions: {
    gap: 10,
  },
  roleOption: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    padding: 12,
  },
  roleOptionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  roleOptionLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  roleOptionDesc: {
    fontSize: 12,
    color: '#6B7280',
    marginLeft: 24,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  confirmButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#111827',
    alignItems: 'center',
  },
  confirmButtonDisabled: {
    opacity: 0.5,
  },
  confirmButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  // Role selection modal
  roleModalContent: {
    width: 320,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 10,
  },
  roleModalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 4,
  },
  roleModalSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    marginBottom: 16,
  },
  roleSelectOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    marginBottom: 8,
  },
  roleSelectDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 12,
  },
  roleSelectInfo: {
    flex: 1,
  },
  roleSelectLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  roleSelectDesc: {
    fontSize: 12,
  },
  roleSelectCheck: {
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  roleSelectCheckText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  // Member picker styles
  loadingMembersContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    gap: 8,
  },
  loadingMembersText: {
    fontSize: 14,
    color: '#6B7280',
  },
  memberPickerList: {
    maxHeight: 180,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
  },
  memberPickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  memberPickerItemSelected: {
    backgroundColor: '#EBF5FF',
  },
  memberPickerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#E5E7EB',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  memberPickerAvatarText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
  },
  memberPickerInfo: {
    flex: 1,
  },
  memberPickerName: {
    fontSize: 14,
    fontWeight: '500',
    color: '#111827',
  },
  memberPickerEmail: {
    fontSize: 12,
    color: '#6B7280',
  },
  memberPickerCheck: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#3B82F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  memberPickerCheckText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  noMembersContainer: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  noMembersText: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
  },
});
