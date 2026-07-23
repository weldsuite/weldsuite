import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Users,
  Kanban,
  FileText,
  CheckSquare,
  PanelLeftClose,
  Phone,
  Plus,
  X,
  User,
} from 'lucide-react-native';
import { router, usePathname } from 'expo-router';

interface SidebarItem {
  id: string;
  label: string;
  icon: any;
  route: string;
}

interface MenuSection {
  title: string;
  items: SidebarItem[];
  addRoute?: string;
}

const menuSections: MenuSection[] = [
  {
    title: 'Dashboard',
    items: [
      {
        id: 'tasks',
        label: 'My Tasks',
        icon: CheckSquare,
        route: '/crm/tasks',
      },
      {
        id: 'calls',
        label: 'Calls',
        icon: Phone,
        route: '/crm/calls',
      },
      {
        id: 'pipeline',
        label: 'Pipeline',
        icon: Kanban,
        route: '/crm',
      },
      {
        id: 'notes',
        label: 'Notes',
        icon: FileText,
        route: '/crm/notes',
      },
    ],
  },
  {
    title: 'Customers',
    addRoute: '/crm/customers/new',
    items: [
      {
        id: 'customers',
        label: 'All Customers',
        icon: Users,
        route: '/crm/leads',
      },
    ],
  },
  {
    title: 'Pipelines',
    addRoute: '/crm/pipelines/new',
    items: [],
  },
];

interface CrmPagesSidebarProps {
  onCollapse?: () => void;
}

interface CustomPage {
  id: string;
  name: string;
  route: string;
}

export default function CrmPagesSidebar({ onCollapse }: CrmPagesSidebarProps) {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  const [isModalVisible, setIsModalVisible] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [modalType, setModalType] = useState<'customer' | 'pipeline'>('customer');
  const [customCustomers, setCustomCustomers] = useState<CustomPage[]>([]);
  const [customPipelines, setCustomPipelines] = useState<CustomPage[]>([]);

  const openAddModal = (type: 'customer' | 'pipeline') => {
    setModalType(type);
    setNewItemName('');
    setIsModalVisible(true);
  };

  const handleCreate = () => {
    if (!newItemName.trim()) return;

    const id = Date.now().toString();
    const name = newItemName.trim();

    if (modalType === 'customer') {
      const newPage: CustomPage = {
        id,
        name,
        route: `/crm/customers/${id}?name=${encodeURIComponent(name)}`,
      };
      setCustomCustomers(prev => [...prev, newPage]);
      router.push(newPage.route as any);
    } else {
      const newPage: CustomPage = {
        id,
        name,
        route: `/crm/pipelines/${id}?name=${encodeURIComponent(name)}`,
      };
      setCustomPipelines(prev => [...prev, newPage]);
      router.push(newPage.route as any);
    }

    setIsModalVisible(false);
    setNewItemName('');
  };

  const isActive = (route: string) => {
    if (route === '/crm') {
      return pathname === '/crm' || pathname === '/crm/';
    }
    return pathname === route || pathname.startsWith(route + '/');
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.headerTitle}>CRM</Text>
        {onCollapse && (
          <TouchableOpacity style={styles.collapseButton} onPress={onCollapse}>
            <PanelLeftClose size={20} color="#6B7280" strokeWidth={2} />
          </TouchableOpacity>
        )}
      </View>

      {/* Menu Items */}
      <ScrollView style={styles.menuContainer} showsVerticalScrollIndicator={false}>
        {menuSections.map((section) => (
          <View key={section.title} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              {section.addRoute && (
                <TouchableOpacity
                  style={styles.addButton}
                  onPress={() => openAddModal(section.title === 'Customers' ? 'customer' : 'pipeline')}
                >
                  <Plus size={14} color="#9CA3AF" strokeWidth={2} />
                </TouchableOpacity>
              )}
            </View>
            {section.items.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.route);

              return (
                <TouchableOpacity
                  key={item.id}
                  style={[
                    styles.menuItem,
                    active && { backgroundColor: '#f7f7f7' }
                  ]}
                  onPress={() => router.push(item.route as any)}
                >
                  <View style={styles.menuItemContent}>
                    <Icon
                      size={20}
                      color={active ? '#252525' : '#343434'}
                      strokeWidth={2}
                    />
                    <Text
                      style={[
                        styles.menuItemText,
                        { color: active ? '#252525' : '#343434' }
                      ]}
                    >
                      {item.label}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
            {/* Custom customer pages */}
            {section.title === 'Customers' && customCustomers.map((page) => {
              const active = isActive(page.route);
              return (
                <TouchableOpacity
                  key={page.id}
                  style={[
                    styles.menuItem,
                    active && { backgroundColor: '#f7f7f7' }
                  ]}
                  onPress={() => router.push(page.route as any)}
                >
                  <View style={styles.menuItemContent}>
                    <User
                      size={20}
                      color={active ? '#252525' : '#343434'}
                      strokeWidth={2}
                    />
                    <Text
                      style={[
                        styles.menuItemText,
                        { color: active ? '#252525' : '#343434' }
                      ]}
                    >
                      {page.name}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
            {/* Custom pipeline pages */}
            {section.title === 'Pipelines' && customPipelines.map((page) => {
              const active = isActive(page.route);
              return (
                <TouchableOpacity
                  key={page.id}
                  style={[
                    styles.menuItem,
                    active && { backgroundColor: '#f7f7f7' }
                  ]}
                  onPress={() => router.push(page.route as any)}
                >
                  <View style={styles.menuItemContent}>
                    <Kanban
                      size={20}
                      color={active ? '#252525' : '#343434'}
                      strokeWidth={2}
                    />
                    <Text
                      style={[
                        styles.menuItemText,
                        { color: active ? '#252525' : '#343434' }
                      ]}
                    >
                      {page.name}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </ScrollView>

      {/* Add New Modal */}
      <Modal
        visible={isModalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setIsModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? -100 : 0}
          style={styles.modalOverlay}
        >
          <View style={styles.modalCard}>
            {/* Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                New {modalType === 'customer' ? 'Customer' : 'Pipeline'}
              </Text>
              <TouchableOpacity onPress={() => setIsModalVisible(false)}>
                <X size={18} color="#9CA3AF" strokeWidth={2} />
              </TouchableOpacity>
            </View>

            {/* Content */}
            <View style={styles.modalContent}>
              <Text style={styles.fieldLabel}>Name</Text>
              <TextInput
                style={styles.input}
                placeholder={modalType === 'customer' ? 'e.g., Acme Corp' : 'e.g., Sales Pipeline'}
                placeholderTextColor="#A1A1AA"
                value={newItemName}
                onChangeText={setNewItemName}
                autoFocus
              />
            </View>

            {/* Footer */}
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={styles.btnOutline}
                onPress={() => setIsModalVisible(false)}
              >
                <Text style={styles.btnOutlineText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnPrimary, !newItemName.trim() && styles.btnDisabled]}
                onPress={handleCreate}
                disabled={!newItemName.trim()}
              >
                <Text style={styles.btnPrimaryText}>Create</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 240,
    height: '100%',
    backgroundColor: '#fbfbfb',
    borderRightWidth: 1,
    borderRightColor: '#ebebeb',
  },
  header: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#ebebeb',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  collapseButton: {
    padding: 4,
  },
  menuContainer: {
    flex: 1,
    paddingTop: 16,
    paddingBottom: 8,
  },
  section: {
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  addButton: {
    width: 20,
    height: 20,
    borderRadius: 4,
    backgroundColor: '#F4F4F5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 8,
    marginVertical: 1,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  menuItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E4E4E7',
  },
  modalTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#18181B',
  },
  modalContent: {
    padding: 16,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: '#3F3F46',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#E4E4E7',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    backgroundColor: '#FAFAFA',
    color: '#18181B',
  },
  modalFooter: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#E4E4E7',
  },
  btnOutline: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E4E4E7',
    backgroundColor: '#FFFFFF',
  },
  btnOutlineText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#3F3F46',
  },
  btnPrimary: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
    backgroundColor: '#18181B',
  },
  btnPrimaryText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#FFFFFF',
  },
  btnDisabled: {
    backgroundColor: '#A1A1AA',
  },
});
