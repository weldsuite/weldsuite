import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Modal,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api } from '@/services/api';
import {
  useEditorBridge,
  RichText,
  TenTapStartKit,
  useBridgeState,
} from '@10play/tentap-editor';
import {
  FileText,
  Plus,
  Search,
  Trash2,
  X,
  BookOpen,
  ChevronLeft,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  Link,
  Image,
  Type,
  Highlighter,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  Code,
  Minus,
  CheckSquare,
  Table,
  Undo,
  Redo,
  Subscript,
  Superscript,
} from 'lucide-react-native';

// Light mode colors - consistent with other pages
const colors = {
  background: '#FFFFFF',
  card: '#FFFFFF',
  text: '#18181B',
  muted: '#71717A',
  border: '#E4E4E7',
  subtle: '#F4F4F5',
  primary: '#3B82F6',
  divider: '#E4E4E7',
};

interface ProjectDocument {
  id: string;
  title: string;
  content?: string;
  contentType: string;
  coverImage?: string;
  icon?: string;
  isPublished: boolean;
  publishedAt?: string;
  lastEditedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

type ViewMode = 'list' | 'view' | 'edit';

export default function ProjectDocumentsScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();

  // State
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedDocument, setSelectedDocument] = useState<ProjectDocument | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit state
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');

  // Rich text editor
  const editor = useEditorBridge({
    autofocus: false,
    avoidIosKeyboard: true,
    initialContent: '',
    bridgeExtensions: TenTapStartKit,
  });

  const editorState = useBridgeState(editor);

  // Update editor content when opening a document for editing
  useEffect(() => {
    if (viewMode === 'edit' && editContent) {
      editor.setContent(editContent);
    }
  }, [viewMode]);

  // Load documents
  const loadDocuments = useCallback(async () => {
    if (!projectId) return;
    try {
      const response = await api.getProjectDocuments(projectId);
      if (response.success && response.data) {
        setDocuments(response.data);
      }
    } catch (error) {
      console.error('Failed to load documents:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadDocuments();
  }, [loadDocuments]);

  // Filter documents
  const filteredDocuments = useMemo(() => {
    if (!searchQuery) return documents;
    const query = searchQuery.toLowerCase();
    return documents.filter(doc =>
      doc.title.toLowerCase().includes(query) ||
      (doc.content && doc.content.toLowerCase().includes(query))
    );
  }, [documents, searchQuery]);

  // Create new document
  const handleCreateDocument = async () => {
    if (!projectId) return;
    setSaving(true);
    try {
      const response = await api.saveProjectDocument(projectId, {
        title: 'Untitled Document',
        content: '',
        contentType: 'html',
      });
      if (response.success && response.data) {
        setDocuments(prev => [response.data!, ...prev]);
        // Open the new document for editing
        setSelectedDocument(response.data);
        setEditTitle(response.data.title);
        setEditContent(response.data.content || '');
        setViewMode('edit');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to create document');
    } finally {
      setSaving(false);
    }
  };

  // Save document
  const handleSaveDocument = async () => {
    if (!projectId || !selectedDocument) return;
    setSaving(true);
    try {
      // Get HTML content from the rich text editor
      const htmlContent = await editor.getHTML();
      const response = await api.saveProjectDocument(projectId, {
        title: editTitle,
        content: htmlContent,
        contentType: 'html',
      });
      if (response.success && response.data) {
        setDocuments(prev => prev.map(d =>
          d.id === selectedDocument.id ? response.data! : d
        ));
        setSelectedDocument(response.data);
        setEditContent(htmlContent);
        setViewMode('view');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to save document');
    } finally {
      setSaving(false);
    }
  };

  // Delete document
  const handleDeleteDocument = async () => {
    if (!projectId || !selectedDocument) return;
    try {
      const response = await api.deleteProjectDocument(projectId, selectedDocument.id);
      if (response.success) {
        setDocuments(prev => prev.filter(d => d.id !== selectedDocument.id));
        setShowDeleteConfirm(false);
        setSelectedDocument(null);
        setViewMode('list');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to delete document');
    }
  };

  // Open document
  const handleOpenDocument = (doc: ProjectDocument) => {
    setSelectedDocument(doc);
    setEditTitle(doc.title);
    setEditContent(doc.content || '');
    setViewMode('view');
  };

  // Format date
  const formatDate = (dateString?: string) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  // Render document detail view/edit
  const renderDocumentDetail = () => {
    if (!selectedDocument) return null;

    const isEditing = viewMode === 'edit';

    return (
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.detailHeader}>
          {!isEditing ? (
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => {
                setViewMode('list');
                setSelectedDocument(null);
              }}
            >
              <ChevronLeft size={24} color={colors.text} />
            </TouchableOpacity>
          ) : (
            /* Editing Toolbar - inline with header */
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.editToolbarContent}
              style={styles.editToolbarInline}
            >
              {/* Undo/Redo */}
              <TouchableOpacity style={styles.toolbarButton} onPress={() => editor.undo()}>
                <Undo size={18} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarButton} onPress={() => editor.redo()}>
                <Redo size={18} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <View style={styles.toolbarDivider} />

              {/* Text Style */}
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isBoldActive && styles.toolbarButtonActive]}
                onPress={() => editor.toggleBold()}
              >
                <Bold size={18} color={editorState.isBoldActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isItalicActive && styles.toolbarButtonActive]}
                onPress={() => editor.toggleItalic()}
              >
                <Italic size={18} color={editorState.isItalicActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isUnderlineActive && styles.toolbarButtonActive]}
                onPress={() => editor.toggleUnderline()}
              >
                <Underline size={18} color={editorState.isUnderlineActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isStrikeActive && styles.toolbarButtonActive]}
                onPress={() => editor.toggleStrike()}
              >
                <Strikethrough size={18} color={editorState.isStrikeActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <View style={styles.toolbarDivider} />

              {/* Text Color & Highlight */}
              <TouchableOpacity style={styles.toolbarButton} onPress={() => editor.setColor('#EF4444')}>
                <View style={styles.textColorButton}>
                  <Type size={16} color={colors.text} strokeWidth={2} />
                  <View style={[styles.colorIndicator, { backgroundColor: '#EF4444' }]} />
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarButton} onPress={() => editor.setHighlight('#FDE047')}>
                <View style={styles.textColorButton}>
                  <Highlighter size={16} color={colors.text} strokeWidth={2} />
                  <View style={[styles.colorIndicator, { backgroundColor: '#FDE047' }]} />
                </View>
              </TouchableOpacity>
              <View style={styles.toolbarDivider} />

              {/* Headings */}
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.headingLevel === 1 && styles.toolbarButtonActive]}
                onPress={() => editor.toggleHeading(1)}
              >
                <Heading1 size={18} color={editorState.headingLevel === 1 ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.headingLevel === 2 && styles.toolbarButtonActive]}
                onPress={() => editor.toggleHeading(2)}
              >
                <Heading2 size={18} color={editorState.headingLevel === 2 ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.headingLevel === 3 && styles.toolbarButtonActive]}
                onPress={() => editor.toggleHeading(3)}
              >
                <Heading3 size={18} color={editorState.headingLevel === 3 ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <View style={styles.toolbarDivider} />

              {/* Alignment */}
              <TouchableOpacity style={styles.toolbarButton} onPress={() => editor.setTextAlign('left')}>
                <AlignLeft size={18} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarButton} onPress={() => editor.setTextAlign('center')}>
                <AlignCenter size={18} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarButton} onPress={() => editor.setTextAlign('right')}>
                <AlignRight size={18} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarButton} onPress={() => editor.setTextAlign('justify')}>
                <AlignJustify size={18} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <View style={styles.toolbarDivider} />

              {/* Lists */}
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isBulletListActive && styles.toolbarButtonActive]}
                onPress={() => editor.toggleBulletList()}
              >
                <List size={18} color={editorState.isBulletListActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isOrderedListActive && styles.toolbarButtonActive]}
                onPress={() => editor.toggleOrderedList()}
              >
                <ListOrdered size={18} color={editorState.isOrderedListActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isTaskListActive && styles.toolbarButtonActive]}
                onPress={() => editor.toggleTaskList()}
              >
                <CheckSquare size={18} color={editorState.isTaskListActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <View style={styles.toolbarDivider} />

              {/* Blocks */}
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isBlockquoteActive && styles.toolbarButtonActive]}
                onPress={() => editor.toggleBlockquote()}
              >
                <Quote size={18} color={editorState.isBlockquoteActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isCodeActive && styles.toolbarButtonActive]}
                onPress={() => editor.toggleCode()}
              >
                <Code size={18} color={editorState.isCodeActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarButton} onPress={() => editor.setHorizontalRule()}>
                <Minus size={18} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <View style={styles.toolbarDivider} />

              {/* Script */}
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isSubscriptActive && styles.toolbarButtonActive]}
                onPress={() => editor.toggleSubscript()}
              >
                <Subscript size={18} color={editorState.isSubscriptActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isSuperscriptActive && styles.toolbarButtonActive]}
                onPress={() => editor.toggleSuperscript()}
              >
                <Superscript size={18} color={editorState.isSuperscriptActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <View style={styles.toolbarDivider} />

              {/* Insert */}
              <TouchableOpacity
                style={[styles.toolbarButton, editorState.isLinkActive && styles.toolbarButtonActive]}
                onPress={() => {
                  Alert.prompt('Insert Link', 'Enter URL:', (url) => {
                    if (url) editor.setLink(url);
                  });
                }}
              >
                <Link size={18} color={editorState.isLinkActive ? colors.primary : colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.toolbarButton}
                onPress={() => {
                  Alert.prompt('Insert Image', 'Enter image URL:', (url) => {
                    if (url) editor.setImage(url);
                  });
                }}
              >
                <Image size={18} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.toolbarButton}>
                <Table size={18} color={colors.muted} strokeWidth={2} />
              </TouchableOpacity>
            </ScrollView>
          )}

          <View style={styles.detailHeaderActions}>
            {isEditing ? (
              <TouchableOpacity
                style={styles.saveButton}
                onPress={handleSaveDocument}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.saveButtonText}>Save</Text>
                )}
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity
                  style={styles.editButton}
                  onPress={() => setViewMode('edit')}
                >
                  <Text style={styles.editButtonText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.deleteHeaderButton}
                  onPress={() => setShowDeleteConfirm(true)}
                >
                  <Text style={styles.deleteHeaderButtonText}>Delete</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>

        {/* Content */}
        {isEditing ? (
          <KeyboardAvoidingView
            style={styles.detailContent}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <View style={styles.editorContainer}>
              <TextInput
                style={styles.titleInput}
                value={editTitle}
                onChangeText={setEditTitle}
                placeholder="Document title"
                placeholderTextColor={colors.muted}
              />
              <RichText editor={editor} style={styles.richTextEditor} />
            </View>
          </KeyboardAvoidingView>
        ) : (
          <ScrollView
            style={styles.detailContent}
            contentContainerStyle={styles.detailContentContainer}
          >
            <View style={styles.documentPage}>
              <Text style={styles.viewTitle}>
                {selectedDocument.title}
              </Text>
              <Text style={styles.viewContent}>
                {selectedDocument.content || 'No content yet. Tap edit to add content.'}
              </Text>
            </View>
          </ScrollView>
        )}

        {/* Delete confirmation modal */}
        <Modal
          visible={showDeleteConfirm}
          transparent
          animationType="fade"
          onRequestClose={() => setShowDeleteConfirm(false)}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.confirmModal}>
              <Text style={styles.confirmTitle}>
                Delete Document?
              </Text>
              <Text style={styles.confirmMessage}>
                Are you sure you want to delete "{selectedDocument?.title}"? This action cannot be undone.
              </Text>
              <View style={styles.confirmActions}>
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={() => setShowDeleteConfirm(false)}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.deleteButton}
                  onPress={handleDeleteDocument}
                >
                  <Text style={styles.deleteButtonText}>Delete</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    );
  };

  // Render list view
  const renderListView = () => (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Documents</Text>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <View style={styles.searchContainer}>
          <Search size={18} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search documents..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery ? (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <X size={18} color={colors.muted} />
            </TouchableOpacity>
          ) : null}
        </View>
        <TouchableOpacity
          style={styles.addButton}
          onPress={handleCreateDocument}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <Plus size={18} color="#FFFFFF" strokeWidth={2} />
              <Text style={styles.addButtonText}>Add</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Document list */}
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={styles.loadingText}>Loading documents...</Text>
        </View>
      ) : filteredDocuments.length === 0 && !searchQuery ? (
        <View style={styles.emptyContainer}>
          <BookOpen size={64} color={colors.muted} strokeWidth={1} />
          <Text style={styles.emptyTitle}>No documents yet</Text>
          <Text style={styles.emptySubtitle}>
            Create your first document to start building your project wiki
          </Text>
          <TouchableOpacity
            style={styles.emptyButton}
            onPress={handleCreateDocument}
          >
            <Plus size={18} color="#FFFFFF" strokeWidth={2} />
            <Text style={styles.emptyButtonText}>Create Document</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.text}
            />
          }
        >
          <View style={styles.tableContainer}>
            <View style={styles.tableWrapper}>
              {/* Table Header */}
              <View style={styles.tableHeader}>
                <View style={[styles.tableHeaderCell, styles.titleColumn]}>
                  <Text style={styles.tableHeaderText}>TITLE</Text>
                </View>
                <View style={[styles.tableHeaderCell, styles.dateColumn]}>
                  <Text style={styles.tableHeaderText}>UPDATED</Text>
                </View>
                <View style={[styles.tableHeaderCell, styles.actionsColumn]}>
                  <Text style={styles.tableHeaderText}></Text>
                </View>
              </View>

              {/* Table Content */}
              {filteredDocuments.length === 0 ? (
                <View style={styles.noResults}>
                  <Search size={48} color={colors.muted} strokeWidth={1} />
                  <Text style={styles.noResultsText}>
                    No documents matching "{searchQuery}"
                  </Text>
                </View>
              ) : (
                filteredDocuments.map((doc, index) => (
                  <TouchableOpacity
                    key={`${doc.id}-${index}`}
                    style={[
                      styles.tableRow,
                      index === filteredDocuments.length - 1 && styles.tableRowLast,
                    ]}
                    onPress={() => handleOpenDocument(doc)}
                    activeOpacity={0.7}
                  >
                    {/* Title cell */}
                    <View style={[styles.tableCell, styles.titleColumn]}>
                      <View style={styles.documentIcon}>
                        {doc.icon ? (
                          <Text style={styles.documentIconEmoji}>{doc.icon}</Text>
                        ) : (
                          <FileText size={18} color={colors.primary} strokeWidth={1.5} />
                        )}
                      </View>
                      <Text style={styles.documentTitle} numberOfLines={1}>
                        {doc.title}
                      </Text>
                    </View>

                    {/* Date cell */}
                    <View style={[styles.tableCell, styles.dateColumn]}>
                      <Text style={styles.dateText}>
                        {formatDate(doc.updatedAt)}
                      </Text>
                    </View>

                    {/* Actions cell */}
                    <View style={[styles.tableCell, styles.actionsColumn]}>
                      <TouchableOpacity
                        style={styles.rowActionButton}
                        onPress={() => {
                          setSelectedDocument(doc);
                          setShowDeleteConfirm(true);
                        }}
                      >
                        <Trash2 size={16} color={colors.muted} strokeWidth={2} />
                      </TouchableOpacity>
                    </View>
                  </TouchableOpacity>
                ))
              )}
            </View>
          </View>
        </ScrollView>
      )}

      {/* Delete confirmation modal */}
      <Modal
        visible={showDeleteConfirm && viewMode === 'list'}
        transparent
        animationType="fade"
        onRequestClose={() => setShowDeleteConfirm(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.confirmModal}>
            <Text style={styles.confirmTitle}>
              Delete Document?
            </Text>
            <Text style={styles.confirmMessage}>
              Are you sure you want to delete "{selectedDocument?.title}"? This action cannot be undone.
            </Text>
            <View style={styles.confirmActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => {
                  setShowDeleteConfirm(false);
                  setSelectedDocument(null);
                }}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={handleDeleteDocument}
              >
                <Text style={styles.deleteButtonText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );

  // Render based on view mode
  if (viewMode === 'view' || viewMode === 'edit') return renderDocumentDetail();
  return renderListView();
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  // Header
  header: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
  },
  // Controls
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  searchContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    height: 40,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: colors.text,
    padding: 0,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.text,
    paddingHorizontal: 14,
    height: 40,
    borderRadius: 8,
    gap: 6,
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
  // Table
  scrollView: {
    flex: 1,
  },
  tableContainer: {
    paddingHorizontal: 16,
  },
  tableWrapper: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.subtle,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  tableHeaderCell: {
    justifyContent: 'center',
  },
  tableHeaderText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.muted,
    letterSpacing: 0.5,
  },
  titleColumn: {
    flex: 1,
    minWidth: 150,
  },
  dateColumn: {
    width: 100,
    alignItems: 'flex-start',
  },
  actionsColumn: {
    width: 44,
    alignItems: 'center',
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  tableRowLast: {
    borderBottomWidth: 0,
  },
  tableCell: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Document cell content
  documentIcon: {
    width: 32,
    height: 32,
    borderRadius: 6,
    backgroundColor: colors.subtle,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  documentIconEmoji: {
    fontSize: 16,
  },
  documentTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
  },
  // Date
  dateText: {
    fontSize: 13,
    color: colors.muted,
  },
  // Row action
  rowActionButton: {
    padding: 8,
  },
  // Loading
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    color: colors.muted,
  },
  // Empty state
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: 24,
    maxWidth: 280,
  },
  emptyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.text,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
  },
  emptyButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  // No results
  noResults: {
    alignItems: 'center',
    paddingVertical: 48,
  },
  noResultsText: {
    fontSize: 14,
    color: colors.muted,
    marginTop: 16,
    textAlign: 'center',
  },
  // Detail view styles
  editToolbarInline: {
    flex: 1,
  },
  editToolbarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    gap: 2,
  },
  toolbarButton: {
    width: 32,
    height: 32,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  toolbarButtonActive: {
    backgroundColor: colors.subtle,
  },
  toolbarDivider: {
    width: 1,
    height: 18,
    backgroundColor: colors.border,
    marginHorizontal: 6,
  },
  textColorButton: {
    alignItems: 'center',
  },
  colorIndicator: {
    width: 14,
    height: 3,
    borderRadius: 1,
    marginTop: 2,
  },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    backgroundColor: colors.background,
  },
  backButton: {
    padding: 4,
  },
  detailHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIconButton: {
    padding: 8,
  },
  editButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  editButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text,
  },
  deleteHeaderButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
  },
  deleteHeaderButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#EF4444',
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
    backgroundColor: colors.text,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  detailContent: {
    flex: 1,
    backgroundColor: colors.background,
  },
  detailContentContainer: {
    alignItems: 'center',
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  editorContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  richTextEditor: {
    flex: 1,
    backgroundColor: colors.background,
  },
  documentPage: {
    width: '100%',
    maxWidth: 680,
    backgroundColor: colors.background,
    borderRadius: 2,
    padding: 40,
    paddingTop: 32,
    minHeight: 500,
  },
  titleInput: {
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 24,
    padding: 0,
    color: colors.text,
  },
  contentInput: {
    flex: 1,
    fontSize: 16,
    lineHeight: 26,
    minHeight: 400,
    padding: 0,
    color: colors.text,
    backgroundColor: 'transparent',
  },
  viewTitle: {
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 24,
    color: colors.text,
  },
  viewContent: {
    fontSize: 16,
    lineHeight: 26,
    color: colors.text,
  },
  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  confirmModal: {
    width: '100%',
    maxWidth: 340,
    borderRadius: 16,
    padding: 24,
    backgroundColor: colors.background,
  },
  confirmTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    color: colors.text,
  },
  confirmMessage: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 24,
    color: colors.muted,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: colors.subtle,
  },
  cancelButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
  },
  deleteButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#EF4444',
  },
  deleteButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
