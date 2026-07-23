import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  View,
  Text,
  TextInput,
  ScrollView,
  Modal,
  StatusBar,
  TouchableWithoutFeedback,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';
import { Building2, User, X, Plus } from 'lucide-react-native';

interface Note {
  id: string;
  title: string;
  content: string;
  linkedTo?: {
    type: 'company' | 'contact';
    id: string;
    name: string;
    color?: string;
  };
  category: 'general' | 'meeting' | 'follow-up' | 'idea';
  createdAt: string;
  updatedAt: string;
}

const NOTE_CATEGORY_CONFIG = {
  general: {
    label: 'General',
    color: '#374151',
    backgroundColor: '#F3F4F6',
  },
  meeting: {
    label: 'Meeting',
    color: '#1E40AF',
    backgroundColor: '#DBEAFE',
  },
  'follow-up': {
    label: 'Follow-up',
    color: '#B45309',
    backgroundColor: '#FEF3C7',
  },
  idea: {
    label: 'Idea',
    color: '#7C3AED',
    backgroundColor: '#EDE9FE',
  },
};

export default function NotesScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [notes, setNotes] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [filteredNotes, setFilteredNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreateModalVisible, setIsCreateModalVisible] = useState(false);
  const [isViewModalVisible, setIsViewModalVisible] = useState(false);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [newNoteTitle, setNewNoteTitle] = useState('');
  const [newNoteContent, setNewNoteContent] = useState('');
  const [editNoteTitle, setEditNoteTitle] = useState('');
  const [editNoteContent, setEditNoteContent] = useState('');

  useEffect(() => {
    loadNotes();
  }, [selectedCategory]);

  useEffect(() => {
    filterNotes();
  }, [searchQuery, notes]);

  const handleSearch = () => {
    loadNotes();
  };

  const loadNotes = async () => {
    try {
      setLoading(true);
      const response = await api.getCrmNotes({
        category: selectedCategory || undefined,
        search: searchQuery || undefined,
      });

      if (response.success && response.data) {
        setNotes(response.data.items as Note[]);
        setTotal(response.data.meta.total);
      }
    } catch (error) {
      console.error('Error loading notes:', error);
      toast.error('Failed to load notes');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const filterNotes = () => {
    let filtered = [...notes];

    if (selectedCategory) {
      filtered = filtered.filter((note) => note.category === selectedCategory);
    }

    if (searchQuery) {
      filtered = filtered.filter((note) =>
        note.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        note.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
        note.linkedTo?.name.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    setFilteredNotes(filtered);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadNotes();
  };

  const handleNotePress = (note: Note) => {
    setSelectedNote(note);
    setEditNoteTitle(note.title);
    setEditNoteContent(note.content);
    setIsViewModalVisible(true);
  };

  const handleSaveNote = async () => {
    if (!selectedNote) return;

    // Only save if there are changes
    if (editNoteTitle === selectedNote.title && editNoteContent === selectedNote.content) {
      return;
    }

    // Optimistic update
    const updatedNote = {
      ...selectedNote,
      title: editNoteTitle || 'Untitled',
      content: editNoteContent,
      updatedAt: new Date().toISOString(),
    };

    setNotes(prevNotes =>
      prevNotes.map(note =>
        note.id === selectedNote.id ? updatedNote : note
      )
    );

    try {
      await api.updateCrmNote(selectedNote.id, {
        title: editNoteTitle || 'Untitled',
        content: editNoteContent,
      });
    } catch (error) {
      console.error('Error updating note:', error);
      // Revert on error
      setNotes(prevNotes =>
        prevNotes.map(note =>
          note.id === selectedNote.id ? selectedNote : note
        )
      );
      toast.error('Failed to save note');
    }
  };

  const handleCreateNote = async () => {
    if (!newNoteTitle.trim()) return;

    try {
      const response = await api.createCrmNote({
        title: newNoteTitle,
        content: newNoteContent,
      });

      if (response.success && response.data) {
        setNotes([response.data as Note, ...notes]);
        toast.success('Note created successfully');
      }
    } catch (error) {
      console.error('Error creating note:', error);
      toast.error('Failed to create note');
    }

    setNewNoteTitle('');
    setNewNoteContent('');
    setIsCreateModalVisible(false);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  };

  const renderCategoryFilter = () => {
    const categoryOptions = [
      { key: null, label: 'All Notes', count: notes.length },
      { key: 'meeting', label: 'Meeting', count: notes.filter(n => n.category === 'meeting').length },
      { key: 'follow-up', label: 'Follow-up', count: notes.filter(n => n.category === 'follow-up').length },
      { key: 'idea', label: 'Idea', count: notes.filter(n => n.category === 'idea').length },
      { key: 'general', label: 'General', count: notes.filter(n => n.category === 'general').length },
    ];

    return (
      <View style={[styles.filterContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          {categoryOptions.map((item) => (
            <TouchableOpacity
              key={item.key || 'all'}
              style={[
                styles.filterButton,
                {
                  backgroundColor: selectedCategory === item.key ? colors.text : colors.background,
                  borderColor: selectedCategory === item.key ? colors.text : colors.buttonBorder,
                }
              ]}
              onPress={() => setSelectedCategory(item.key)}
            >
              <Text
                style={[
                  styles.filterButtonText,
                  { color: selectedCategory === item.key ? colors.background : colors.text }
                ]}
              >
                {item.label}
              </Text>
              <Text
                style={[
                  styles.filterButtonCount,
                  { color: selectedCategory === item.key ? colors.background : colors.muted }
                ]}
              >
                ({item.count})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const renderNote = ({ item }: { item: Note }) => {
    return (
      <TouchableOpacity
        style={[styles.noteItem, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}
        onPress={() => handleNotePress(item)}
        activeOpacity={0.7}
      >
        <View style={styles.noteContent}>
          <View style={styles.noteLeft}>
            <Text style={[styles.noteTitle, { color: colors.text }]}>{item.title}</Text>
            <Text style={[styles.notePreview, { color: colors.muted }]} numberOfLines={2}>
              {item.content}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
              {item.linkedTo && (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {item.linkedTo.type === 'company' ? (
                      <Building2 size={10} color={colors.muted} strokeWidth={2} />
                    ) : (
                      <User size={10} color={colors.muted} strokeWidth={2} />
                    )}
                    <Text style={[styles.noteDate, { color: colors.muted }]}>
                      {item.linkedTo.name}
                    </Text>
                  </View>
                </>
              )}
            </View>
          </View>
          <View style={styles.noteRight}>
            <Text style={[styles.noteTime, { color: colors.muted }]}>
              {formatDate(item.updatedAt)}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyText, { color: colors.muted }]}>No notes found</Text>
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading notes...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Notes ({filteredNotes.length})</Text>
        <TouchableOpacity
          style={[styles.addButton, { backgroundColor: colors.background, borderColor: colors.buttonBorder }]}
          onPress={() => setIsCreateModalVisible(true)}
        >
          <Plus size={16} color={colors.text} strokeWidth={2} />
          <Text style={[styles.addButtonText, { color: colors.text }]}>Add</Text>
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search notes..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
          />
        </View>
      </View>

      {renderCategoryFilter()}

      <FlatList
        data={filteredNotes}
        renderItem={renderNote}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />

      {/* View/Edit Note Modal */}
      <Modal
        visible={isViewModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          handleSaveNote();
          setIsViewModalVisible(false);
        }}
      >
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            {selectedNote?.linkedTo && (
              <View style={styles.headerInfo}>
                {/* Avatar */}
                <View
                  style={[
                    styles.headerAvatar,
                    {
                      backgroundColor: selectedNote.linkedTo.color || '#8B5CF6',
                    },
                  ]}
                >
                  {selectedNote.linkedTo.type === 'company' ? (
                    <Building2 size={12} color="#FFFFFF" strokeWidth={2} />
                  ) : (
                    <User size={12} color="#FFFFFF" strokeWidth={2} />
                  )}
                </View>
                {/* Name */}
                <Text style={[styles.headerName, { color: colors.text }]}>
                  {selectedNote.linkedTo.name}
                </Text>
                {/* Separator */}
                <View style={[styles.headerDot, { backgroundColor: colors.muted, opacity: 0.4 }]} />
                {/* Time */}
                <Text style={[styles.headerTime, { color: colors.muted }]}>
                  Updated {formatDate(selectedNote.updatedAt)}
                </Text>
              </View>
            )}
            <View style={{ flex: 1 }} />
            <TouchableOpacity
              onPress={() => {
                handleSaveNote();
                setIsViewModalVisible(false);
              }}
              style={styles.closeButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="never"
            contentContainerStyle={{ flexGrow: 1 }}
          >
            <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
              <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 }}>
                {selectedNote && (
                  <>
                    {/* Note Title - Notion style */}
                    <TextInput
                      style={[styles.notionTitle, { color: colors.text }]}
                      placeholder="Untitled"
                      placeholderTextColor={colors.muted}
                      value={editNoteTitle}
                      onChangeText={setEditNoteTitle}
                      multiline
                      scrollEnabled={false}
                    />

                    {/* Note Content - Notion style */}
                    <TextInput
                      style={[styles.notionContent, { color: colors.text }]}
                      placeholder="Start writing..."
                      placeholderTextColor={colors.muted}
                      value={editNoteContent}
                      onChangeText={setEditNoteContent}
                      multiline
                      textAlignVertical="top"
                      scrollEnabled={false}
                    />
                  </>
                )}
              </View>
            </TouchableWithoutFeedback>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Create Note Modal */}
      <Modal
        visible={isCreateModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIsCreateModalVisible(false)}
      >
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>New Note</Text>
            <TouchableOpacity
              onPress={() => setIsCreateModalVisible(false)}
              style={styles.closeButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            <View style={{ paddingHorizontal: 20, paddingVertical: 20 }}>
              <View style={styles.modalSection}>
                <Text style={[styles.modalLabel, { color: '#374151' }]}>Title</Text>
                <TextInput
                  style={[styles.modalInput, { color: colors.text }]}
                  placeholder="Enter note title"
                  placeholderTextColor={colors.muted}
                  value={newNoteTitle}
                  onChangeText={setNewNoteTitle}
                />
              </View>

              <View style={styles.modalSection}>
                <Text style={[styles.modalLabel, { color: '#374151' }]}>Content</Text>
                <TextInput
                  style={[styles.modalTextArea, { color: colors.text }]}
                  placeholder="Enter note content"
                  placeholderTextColor={colors.muted}
                  value={newNoteContent}
                  onChangeText={setNewNoteContent}
                  multiline
                  numberOfLines={8}
                  textAlignVertical="top"
                />
              </View>
            </View>
          </ScrollView>

          <View style={[styles.createButtonContainer, { backgroundColor: colors.background }]}>
            <TouchableOpacity
              style={[styles.createButton, { backgroundColor: '#000000' }]}
              onPress={handleCreateNote}
            >
              <Text style={styles.createButtonText}>Create Note</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
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
    marginTop: 16,
    fontSize: 12,
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  filterContainer: {
    paddingTop: 4,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
  },
  filterList: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  filterButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  filterButtonCount: {
    fontSize: 13,
    fontWeight: '400',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  addButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  listContainer: {
    paddingHorizontal: 0,
  },
  noteItem: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
  },
  noteContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  noteLeft: {
    flex: 1,
    gap: 2,
  },
  noteRight: {
    alignItems: 'flex-end',
    marginLeft: 12,
  },
  noteTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  notePreview: {
    fontSize: 14,
    fontWeight: '400',
  },
  noteDate: {
    fontSize: 12,
  },
  noteTime: {
    fontSize: 12,
    fontWeight: '400',
  },
  categoryBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  categoryText: {
    fontSize: 10,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyText: {
    fontSize: 12,
  },
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingTop: 16,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  headerInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerAvatar: {
    width: 24,
    height: 24,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerName: {
    fontSize: 15,
    fontWeight: '600',
  },
  headerDot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    marginHorizontal: 0,
  },
  headerTime: {
    fontSize: 13,
    fontWeight: '400',
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginLeft: 16,
  },
  closeButton: {
    padding: 4,
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  viewNoteTitle: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
  },
  viewNoteMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
    flexWrap: 'wrap',
  },
  viewNoteDate: {
    fontSize: 13,
  },
  viewLinkedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  viewLinkedText: {
    fontSize: 12,
    fontWeight: '500',
  },
  viewNoteContent: {
    fontSize: 15,
    lineHeight: 22,
  },
  modalSection: {
    marginBottom: 24,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
  },
  modalInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  modalTextArea: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 150,
  },
  createButtonContainer: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  createButton: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  notionTitle: {
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 4,
    paddingVertical: 8,
  },
  notionContent: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400',
    minHeight: 200,
  },
});
