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
  Alert,
  Linking,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useLocalSearchParams } from 'expo-router';
import {
  Search,
  Upload,
  FileText,
  Image,
  Video,
  Music,
  Archive,
  Code,
  File,
  Trash2,
  Download,
  MoreVertical,
  FolderOpen,
} from 'lucide-react-native';
import * as DocumentPicker from 'expo-document-picker';
import api from '@/services/api';

interface ProjectFile {
  id: string;
  name: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  url: string;
  thumbnailUrl?: string;
  uploadedBy?: string;
  uploadedByName?: string;
  createdAt?: string;
}

const getFileIcon = (mimeType?: string) => {
  if (!mimeType) return File;

  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.startsWith('video/')) return Video;
  if (mimeType.startsWith('audio/')) return Music;
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('gz')) return Archive;
  if (mimeType.includes('javascript') || mimeType.includes('typescript') || mimeType.includes('json') || mimeType.includes('html') || mimeType.includes('css') || mimeType.includes('xml')) return Code;
  if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('word') || mimeType.includes('text')) return FileText;

  return File;
};

const getFileColor = (mimeType?: string): string => {
  if (!mimeType) return '#6B7280';

  if (mimeType.startsWith('image/')) return '#EC4899';
  if (mimeType.startsWith('video/')) return '#8B5CF6';
  if (mimeType.startsWith('audio/')) return '#F59E0B';
  if (mimeType.includes('zip') || mimeType.includes('rar')) return '#6B7280';
  if (mimeType.includes('javascript') || mimeType.includes('json')) return '#FBBF24';
  if (mimeType.includes('pdf')) return '#EF4444';
  if (mimeType.includes('document') || mimeType.includes('word')) return '#3B82F6';

  return '#6B7280';
};

const formatFileSize = (bytes?: number): string => {
  if (!bytes || bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let size = bytes;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
};

const formatDate = (dateString?: string): string => {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

export default function ProjectFilesScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const { projectId } = useLocalSearchParams();
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [uploading, setUploading] = useState(false);

  const loadFiles = useCallback(async () => {
    if (!projectId) return;

    try {
      setLoading(true);
      const response = await api.getProjectFiles(projectId as string);
      if (response.success && response.data) {
        // Handle both array and paginated response structures
        const fileItems = Array.isArray(response.data)
          ? response.data
          : (response.data as any).items || [];
        setFiles(fileItems);
      } else {
        toast.error(response.error || 'Failed to load files');
        setFiles([]);
      }
    } catch (error) {
      console.error('Error loading files:', error);
      toast.error('Failed to load files');
      setFiles([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadFiles();
  };

  const filteredFiles = files.filter((file) => {
    const name = file.name?.toLowerCase() || '';
    const filename = file.filename?.toLowerCase() || '';
    const query = searchQuery.toLowerCase();
    return name.includes(query) || filename.includes(query);
  });

  const handleUpload = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (result.canceled) return;

      const file = result.assets[0];
      if (!file) return;

      setUploading(true);

      // Upload file to R2 storage via the API
      const response = await api.uploadProjectFile(projectId as string, {
        uri: file.uri,
        name: file.name,
        type: file.mimeType || 'application/octet-stream',
      });

      if (response.success) {
        toast.success('File uploaded successfully');
        loadFiles();
      } else {
        const errorMsg = typeof response.error === 'object'
          ? (response.error as any)?.message || JSON.stringify(response.error)
          : response.error || 'Failed to upload file';
        console.error('[Files] Upload error:', errorMsg);
        toast.error(errorMsg);
      }
    } catch (error) {
      console.error('[Files] Error uploading file:', error);
      toast.error('Failed to upload file');
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (file: ProjectFile) => {
    try {
      if (file.url) {
        await Linking.openURL(file.url);
      } else {
        toast.error('File URL not available');
      }
    } catch (error) {
      toast.error('Failed to open file');
    }
  };

  const handleDelete = (file: ProjectFile) => {
    Alert.alert(
      'Delete File',
      `Are you sure you want to delete "${file.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const response = await api.deleteProjectFile(projectId as string, file.id);
              if (response.success) {
                toast.success('File deleted');
                loadFiles();
              } else {
                toast.error(response.error || 'Failed to delete file');
              }
            } catch (error) {
              toast.error('Failed to delete file');
            }
          },
        },
      ]
    );
  };

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading files...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Files</Text>
        <Text style={[styles.fileCount, { color: colors.muted }]}>
          {files.length} file{files.length !== 1 ? 's' : ''}
        </Text>
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <View style={[styles.searchContainer, { backgroundColor: colors.card }]}>
          <Search size={18} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search files..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
        <TouchableOpacity
          style={[styles.uploadButton, uploading && styles.uploadButtonDisabled]}
          onPress={handleUpload}
          disabled={uploading}
        >
          {uploading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <Upload size={18} color="#FFFFFF" strokeWidth={2} />
              <Text style={styles.uploadButtonText}>Upload</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* File List */}
      <ScrollView
        style={styles.fileList}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      >
        {filteredFiles.length === 0 ? (
          <View style={styles.emptyState}>
            <FolderOpen size={48} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>
              {searchQuery ? 'No files found' : 'No files yet'}
            </Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              {searchQuery ? 'Try adjusting your search' : 'Upload files to share with your team'}
            </Text>
            {!searchQuery && (
              <TouchableOpacity
                style={styles.emptyUploadButton}
                onPress={handleUpload}
              >
                <Upload size={16} color="#3B82F6" strokeWidth={2} />
                <Text style={styles.emptyUploadText}>Upload a file</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          filteredFiles.map((file) => {
            const FileIcon = getFileIcon(file.mimeType);
            const iconColor = getFileColor(file.mimeType);

            return (
              <TouchableOpacity
                key={file.id}
                style={[
                  styles.fileCard,
                  { backgroundColor: colors.card, borderColor: colors.divider },
                ]}
                onPress={() => handleDownload(file)}
                activeOpacity={0.7}
              >
                <View style={[styles.fileIconContainer, { backgroundColor: iconColor + '15' }]}>
                  <FileIcon size={24} color={iconColor} strokeWidth={1.5} />
                </View>
                <View style={styles.fileInfo}>
                  <Text style={[styles.fileName, { color: colors.text }]} numberOfLines={1}>
                    {file.name}
                  </Text>
                  <View style={styles.fileMeta}>
                    <Text style={[styles.fileSize, { color: colors.muted }]}>
                      {formatFileSize(file.size)}
                    </Text>
                    {file.createdAt && (
                      <>
                        <Text style={[styles.fileDot, { color: colors.muted }]}>•</Text>
                        <Text style={[styles.fileDate, { color: colors.muted }]}>
                          {formatDate(file.createdAt)}
                        </Text>
                      </>
                    )}
                    {file.uploadedByName && (
                      <>
                        <Text style={[styles.fileDot, { color: colors.muted }]}>•</Text>
                        <Text style={[styles.fileUploader, { color: colors.muted }]} numberOfLines={1}>
                          {file.uploadedByName}
                        </Text>
                      </>
                    )}
                  </View>
                </View>
                <View style={styles.fileActions}>
                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={() => handleDownload(file)}
                  >
                    <Download size={18} color={colors.muted} strokeWidth={2} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.actionButton}
                    onPress={() => handleDelete(file)}
                  >
                    <Trash2 size={18} color="#EF4444" strokeWidth={2} />
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            );
          })
        )}
        <View style={{ height: 100 }} />
      </ScrollView>
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
  fileCount: {
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
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#3B82F6',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  uploadButtonDisabled: {
    opacity: 0.7,
  },
  uploadButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  fileList: {
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
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 20,
  },
  emptyUploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#EFF6FF',
    borderRadius: 10,
  },
  emptyUploadText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#3B82F6',
  },
  fileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
  },
  fileIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  fileMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  fileSize: {
    fontSize: 12,
  },
  fileDot: {
    fontSize: 12,
    marginHorizontal: 6,
  },
  fileDate: {
    fontSize: 12,
  },
  fileUploader: {
    fontSize: 12,
    maxWidth: 100,
  },
  fileActions: {
    flexDirection: 'row',
    gap: 4,
  },
  actionButton: {
    padding: 8,
  },
});
