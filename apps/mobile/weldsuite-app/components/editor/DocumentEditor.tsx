import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { useEditorBridge, RichText } from '@10play/tentap-editor';
import { FileText, Save, Link as LinkIcon, X } from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';

import { EditorToolbar } from './EditorToolbar';
import { SlashCommandMenu } from './SlashCommandMenu';
import { DocumentPagesSidebar, type DocumentPage } from './DocumentPagesSidebar';
import { CoverImagePicker } from './CoverImagePicker';

interface DocumentEditorProps {
  projectId: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  initialTitle?: string;
  initialContent?: string;
  initialCoverImage?: string;
  initialPages?: DocumentPage[];
  initialActivePageId?: string;
  canWrite?: boolean;
  onSave: (data: {
    title: string;
    content: string;
    coverImage?: string;
    pages: DocumentPage[];
    activePageId: string;
  }) => Promise<boolean>;
  onUploadImage: (imageUri: string) => Promise<string | undefined>;
}

export function DocumentEditor({
  projectId,
  userId,
  userName,
  userAvatar,
  initialTitle = '',
  initialContent = '',
  initialCoverImage,
  initialPages,
  initialActivePageId,
  canWrite = true,
  onSave,
  onUploadImage,
}: DocumentEditorProps) {
  const { colors } = useTheme();
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<string>(initialContent);

  // Initialize pages
  const getInitialPages = (): DocumentPage[] => {
    if (initialPages && initialPages.length > 0) {
      return initialPages;
    }
    return [{
      id: 'main',
      title: initialTitle,
      content: initialContent,
      coverImage: initialCoverImage,
      createdAt: new Date(),
      updatedAt: new Date(),
    }];
  };

  const getInitialActivePageId = (): string => {
    if (initialActivePageId && initialPages?.some(p => p.id === initialActivePageId)) {
      return initialActivePageId;
    }
    if (initialPages && initialPages.length > 0) {
      return initialPages[0].id;
    }
    return 'main';
  };

  // State
  const [pages, setPages] = useState<DocumentPage[]>(getInitialPages);
  const [activePageId, setActivePageId] = useState(getInitialActivePageId);
  const [title, setTitle] = useState(getInitialPages().find(p => p.id === getInitialActivePageId())?.title || '');
  const [coverImage, setCoverImage] = useState<string | undefined>(
    getInitialPages().find(p => p.id === getInitialActivePageId())?.coverImage
  );
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [showPagesSidebar, setShowPagesSidebar] = useState(false);
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  // Last saved content for change detection
  const lastSavedContentRef = useRef({ title, content: initialContent, pagesCount: pages.length });

  // Initialize editor bridge
  const editor = useEditorBridge({
    autofocus: false,
    avoidIosKeyboard: true,
    initialContent: getInitialPages().find(p => p.id === getInitialActivePageId())?.content || '',
    editable: canWrite,
    onChange: async () => {
      const content = await editor.getHTML();
      contentRef.current = content;
      handleEditorChange(content);
    },
  });

  // Debounced auto-save
  useEffect(() => {
    const currentContent = contentRef.current;
    const hasChanges =
      title !== lastSavedContentRef.current.title ||
      currentContent !== lastSavedContentRef.current.content ||
      pages.length !== lastSavedContentRef.current.pagesCount;

    if (!hasChanges || !canWrite) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      await handleSave(true);
    }, 1500);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [title, pages.length]);

  // Handle editor content change
  const handleEditorChange = useCallback((content: string) => {
    // Update current page content
    setPages(prev => prev.map(page =>
      page.id === activePageId
        ? { ...page, content, updatedAt: new Date() }
        : page
    ));
  }, [activePageId]);

  // Handle title change
  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
    setPages(prev => prev.map(page =>
      page.id === activePageId
        ? { ...page, title: newTitle, updatedAt: new Date() }
        : page
    ));
  };

  // Handle save
  const handleSave = async (isAutoSave = false) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }

    setIsSaving(true);

    const currentContent = contentRef.current;
    const updatedPages = pages.map(page =>
      page.id === activePageId
        ? { ...page, title, content: currentContent, coverImage, updatedAt: new Date() }
        : page
    );

    try {
      const success = await onSave({
        title: updatedPages[0]?.title || title,
        content: updatedPages[0]?.content || currentContent,
        coverImage: updatedPages[0]?.coverImage || coverImage,
        pages: updatedPages,
        activePageId,
      });

      if (success) {
        setLastSaved(new Date());
        setPages(updatedPages);
        lastSavedContentRef.current = { title, content: currentContent, pagesCount: updatedPages.length };
      }
    } catch (error) {
      if (!isAutoSave) {
        Alert.alert('Error', 'Failed to save document');
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Switch to different page
  const switchToPage = async (pageId: string) => {
    // Save current page state
    const currentContent = contentRef.current;
    setPages(prev => prev.map(page =>
      page.id === activePageId
        ? { ...page, title, content: currentContent, coverImage, updatedAt: new Date() }
        : page
    ));

    // Switch to new page
    const newPage = pages.find(p => p.id === pageId);
    if (newPage) {
      setActivePageId(pageId);
      setTitle(newPage.title);
      setCoverImage(newPage.coverImage);
      editor.setContent(newPage.content);
      contentRef.current = newPage.content;
    }
  };

  // Add new page
  const addNewPage = () => {
    const newPage: DocumentPage = {
      id: `page_${Date.now()}`,
      title: '',
      content: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Save current page first
    const currentContent = contentRef.current;
    setPages(prev => [
      ...prev.map(page =>
        page.id === activePageId
          ? { ...page, title, content: currentContent, coverImage, updatedAt: new Date() }
          : page
      ),
      newPage,
    ]);

    // Switch to new page
    setActivePageId(newPage.id);
    setTitle('');
    setCoverImage(undefined);
    editor.setContent('');
    contentRef.current = '';

    setShowPagesSidebar(false);
  };

  // Delete page
  const deletePage = (pageId: string) => {
    if (pages.length <= 1) return;

    const pageIndex = pages.findIndex(p => p.id === pageId);
    const newPages = pages.filter(p => p.id !== pageId);

    setPages(newPages);

    // If deleting active page, switch to another
    if (pageId === activePageId) {
      const newActiveIndex = Math.min(pageIndex, newPages.length - 1);
      const newActivePage = newPages[newActiveIndex];
      setActivePageId(newActivePage.id);
      setTitle(newActivePage.title);
      setCoverImage(newActivePage.coverImage);
      editor.setContent(newActivePage.content);
      contentRef.current = newActivePage.content;
    }

  };

  // Insert link
  const insertLink = () => {
    if (!linkUrl) return;

    editor.setLink(linkUrl);
    setShowLinkDialog(false);
    setLinkUrl('');
  };

  // Format last saved time
  const formatLastSaved = () => {
    if (!lastSaved) return '';
    const now = new Date();
    const diff = now.getTime() - lastSaved.getTime();
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'Saved just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `Saved ${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `Saved ${hours}h ago`;
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={styles.pagesButton}
          onPress={() => setShowPagesSidebar(true)}
        >
          <FileText size={18} color="#6B7280" strokeWidth={2} />
          <Text style={styles.pagesButtonText}>Pages</Text>
        </TouchableOpacity>

        <View style={styles.headerRight}>
          {canWrite && (
            <TouchableOpacity
              style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
              onPress={() => handleSave(false)}
              disabled={isSaving}
            >
              {isSaving ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <>
                  <Save size={16} color="#FFFFFF" strokeWidth={2} />
                  <Text style={styles.saveButtonText}>Save</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Toolbar */}
      {canWrite && (
        <EditorToolbar
          editor={editor}
          onLinkPress={() => setShowLinkDialog(true)}
        />
      )}

      {/* Content */}
      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        keyboardShouldPersistTaps="handled"
      >
        {/* Cover Image */}
        <CoverImagePicker
          coverImage={coverImage}
          onImageChange={setCoverImage}
          onUpload={onUploadImage}
          canWrite={canWrite}
        />

        {/* Title */}
        <TextInput
          style={[styles.titleInput, { color: colors.text }]}
          value={title}
          onChangeText={handleTitleChange}
          placeholder="Untitled"
          placeholderTextColor="#9CA3AF"
          editable={canWrite}
          multiline
        />

        {/* Editor */}
        <View style={styles.editorContainer}>
          <RichText editor={editor} />
        </View>

        {/* Last saved indicator */}
        {lastSaved && (
          <Text style={styles.lastSaved}>{formatLastSaved()}</Text>
        )}
      </ScrollView>

      {/* Slash Command Menu */}
      <SlashCommandMenu
        editor={editor}
        visible={showSlashMenu}
        onClose={() => setShowSlashMenu(false)}
        onLinkPress={() => {
          setShowSlashMenu(false);
          setShowLinkDialog(true);
        }}
      />

      {/* Pages Sidebar */}
      <DocumentPagesSidebar
        pages={pages}
        activePageId={activePageId}
        onPageSelect={switchToPage}
        onAddPage={addNewPage}
        onDeletePage={deletePage}
        visible={showPagesSidebar}
        onClose={() => setShowPagesSidebar(false)}
        canWrite={canWrite}
      />

      {/* Link Dialog */}
      <Modal
        visible={showLinkDialog}
        transparent
        animationType="fade"
        onRequestClose={() => setShowLinkDialog(false)}
      >
        <View style={styles.linkDialogOverlay}>
          <View style={styles.linkDialog}>
            <View style={styles.linkDialogHeader}>
              <Text style={styles.linkDialogTitle}>Insert Link</Text>
              <TouchableOpacity
                style={styles.linkDialogClose}
                onPress={() => {
                  setShowLinkDialog(false);
                  setLinkUrl('');
                }}
              >
                <X size={20} color="#6B7280" strokeWidth={2} />
              </TouchableOpacity>
            </View>

            <View style={styles.linkDialogContent}>
              <Text style={styles.linkInputLabel}>URL</Text>
              <TextInput
                style={styles.linkInput}
                value={linkUrl}
                onChangeText={setLinkUrl}
                placeholder="https://example.com"
                placeholderTextColor="#9CA3AF"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                autoFocus
              />
            </View>

            <View style={styles.linkDialogActions}>
              <TouchableOpacity
                style={styles.linkCancelButton}
                onPress={() => {
                  setShowLinkDialog(false);
                  setLinkUrl('');
                }}
              >
                <Text style={styles.linkCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.linkInsertButton, !linkUrl && styles.linkInsertDisabled]}
                onPress={insertLink}
                disabled={!linkUrl}
              >
                <Text style={styles.linkInsertText}>Insert</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  pagesButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#F3F4F6',
    borderRadius: 8,
    gap: 6,
  },
  pagesButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#111827',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  saveButtonDisabled: {
    opacity: 0.7,
  },
  saveButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 20,
    paddingVertical: 20,
  },
  titleInput: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 16,
    padding: 0,
  },
  editorContainer: {
    flex: 1,
    minHeight: 400,
  },
  lastSaved: {
    fontSize: 12,
    color: '#9CA3AF',
    textAlign: 'center',
    marginTop: 16,
  },
  // Link Dialog
  linkDialogOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  linkDialog: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
  },
  linkDialogHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  linkDialogTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111827',
  },
  linkDialogClose: {
    padding: 4,
  },
  linkDialogContent: {
    padding: 20,
  },
  linkInputLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 8,
  },
  linkInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#111827',
  },
  linkDialogActions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  linkCancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
  },
  linkCancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  linkInsertButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#111827',
    alignItems: 'center',
  },
  linkInsertDisabled: {
    opacity: 0.5,
  },
  linkInsertText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
