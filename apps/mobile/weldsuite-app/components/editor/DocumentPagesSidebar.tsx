import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Modal,
  Alert,
} from 'react-native';
import {
  FileText,
  Plus,
  MoreHorizontal,
  Trash2,
  X,
} from 'lucide-react-native';

export interface DocumentPage {
  id: string;
  title: string;
  content: string;
  coverImage?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DocumentPagesSidebarProps {
  pages: DocumentPage[];
  activePageId: string;
  onPageSelect: (pageId: string) => void;
  onAddPage: () => void;
  onDeletePage: (pageId: string) => void;
  visible: boolean;
  onClose: () => void;
  canWrite?: boolean;
}

export function DocumentPagesSidebar({
  pages,
  activePageId,
  onPageSelect,
  onAddPage,
  onDeletePage,
  visible,
  onClose,
  canWrite = true,
}: DocumentPagesSidebarProps) {
  const [menuPageId, setMenuPageId] = useState<string | null>(null);

  const handleDeletePress = (pageId: string) => {
    if (pages.length <= 1) {
      Alert.alert('Cannot Delete', 'You cannot delete the last page of a document.');
      return;
    }

    Alert.alert(
      'Delete Page',
      'Are you sure you want to delete this page?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            onDeletePage(pageId);
            setMenuPageId(null);
          },
        },
      ]
    );
  };

  const handlePageSelect = (pageId: string) => {
    onPageSelect(pageId);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <X size={20} color="#6B7280" strokeWidth={2} />
            </TouchableOpacity>
            <Text style={styles.title}>Pages</Text>
            {canWrite && (
              <TouchableOpacity style={styles.addButton} onPress={onAddPage}>
                <Plus size={20} color="#6B7280" strokeWidth={2} />
              </TouchableOpacity>
            )}
          </View>

          {/* Pages List */}
          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
          >
            {pages.map((page) => (
              <View key={page.id} style={styles.pageItemWrapper}>
                <TouchableOpacity
                  style={[
                    styles.pageItem,
                    activePageId === page.id && styles.pageItemActive,
                  ]}
                  onPress={() => handlePageSelect(page.id)}
                  activeOpacity={0.7}
                >
                  <FileText
                    size={16}
                    color={activePageId === page.id ? '#111827' : '#6B7280'}
                    strokeWidth={1.5}
                  />
                  <Text
                    style={[
                      styles.pageTitle,
                      activePageId === page.id && styles.pageTitleActive,
                      !page.title && styles.pageTitleEmpty,
                    ]}
                    numberOfLines={1}
                  >
                    {page.title || 'Untitled'}
                  </Text>
                </TouchableOpacity>

                {canWrite && (
                  <TouchableOpacity
                    style={styles.menuButton}
                    onPress={() => setMenuPageId(menuPageId === page.id ? null : page.id)}
                  >
                    <MoreHorizontal size={16} color="#9CA3AF" strokeWidth={2} />
                  </TouchableOpacity>
                )}

                {/* Page Menu */}
                {menuPageId === page.id && canWrite && (
                  <View style={styles.pageMenu}>
                    <TouchableOpacity
                      style={styles.pageMenuItem}
                      onPress={() => handleDeletePress(page.id)}
                    >
                      <Trash2 size={14} color="#EF4444" strokeWidth={2} />
                      <Text style={styles.pageMenuItemTextDanger}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  container: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '60%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 5,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111827',
    flex: 1,
    textAlign: 'center',
  },
  closeButton: {
    padding: 4,
    width: 40,
  },
  addButton: {
    padding: 4,
    width: 40,
    alignItems: 'flex-end',
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 8,
    gap: 4,
  },
  pageItemWrapper: {
    position: 'relative',
  },
  pageItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 10,
  },
  pageItemActive: {
    backgroundColor: '#F3F4F6',
  },
  pageTitle: {
    flex: 1,
    fontSize: 14,
    color: '#374151',
  },
  pageTitleActive: {
    color: '#111827',
    fontWeight: '500',
  },
  pageTitleEmpty: {
    color: '#9CA3AF',
    fontStyle: 'italic',
  },
  menuButton: {
    position: 'absolute',
    right: 12,
    top: 12,
    padding: 4,
  },
  pageMenu: {
    position: 'absolute',
    right: 40,
    top: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 5,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    zIndex: 10,
  },
  pageMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  pageMenuItemTextDanger: {
    fontSize: 13,
    color: '#EF4444',
  },
});
