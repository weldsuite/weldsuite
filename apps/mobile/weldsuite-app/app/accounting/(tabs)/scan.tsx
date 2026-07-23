import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Modal,
  ScrollView,
  ActivityIndicator,
  Image,
  Platform,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { router } from 'expo-router';
import { Camera, CameraView } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import api from '@/services/api';

// DocumentScanner is not available in Expo Go - use conditional loading
let DocumentScanner: any = null;
let isDocumentScannerAvailable = false;

try {
  DocumentScanner = require('react-native-document-scanner-plugin').default;
  isDocumentScannerAvailable = true;
} catch (error) {
  isDocumentScannerAvailable = false;
}

interface ScannedDocument {
  uri: string;
  width?: number;
  height?: number;
  type: 'receipt' | 'invoice' | 'document';
}

export default function ScanScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [processing, setProcessing] = useState(false);
  const [scannedDocument, setScannedDocument] = useState<ScannedDocument | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  const handleNativeScan = async () => {
    if (hasPermission === false) {
      toast.warning('Please enable camera access in your device settings to scan documents.');
      return;
    }

    // Check if DocumentScanner is available (not in Expo Go)
    if (!isDocumentScannerAvailable || !DocumentScanner) {
      toast.info('Smart scan not available in Expo Go. Using camera instead.');
      handleCameraCapture();
      return;
    }

    try {
      // Use the native document scanner plugin
      const result = await DocumentScanner.scanDocument({
        croppedImageQuality: 100,
        maxNumDocuments: 1,
        letUserAdjustCrop: true,
        responseType: 'imageFilePath',
      });

      if (result.scannedImages && result.scannedImages.length > 0) {
        const imageUri = result.scannedImages[0];
        setScannedDocument({
          uri: Platform.OS === 'android' ? `file://${imageUri}` : imageUri,
          type: 'document',
        });
        setShowPreviewModal(true);
      }
    } catch (error: any) {
      // User cancelled or scanner not available
      if (error.message?.includes('cancel')) {
        // User cancelled - do nothing
      } else {
        console.error('Document scanner error:', error);
        toast.error('Document scanner not available. Try using the camera or gallery.');
        // Fallback to regular camera
        handleCameraCapture();
      }
    }
  };

  const handleCameraCapture = async () => {
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
      allowsEditing: true,
    });

    if (!result.canceled && result.assets[0]) {
      setScannedDocument({
        uri: result.assets[0].uri,
        width: result.assets[0].width,
        height: result.assets[0].height,
        type: 'document',
      });
      setShowPreviewModal(true);
    }
  };

  const handleGalleryPick = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
      allowsEditing: true,
    });

    if (!result.canceled && result.assets[0]) {
      setScannedDocument({
        uri: result.assets[0].uri,
        width: result.assets[0].width,
        height: result.assets[0].height,
        type: 'document',
      });
      setShowPreviewModal(true);
    }
  };

  const handleDocumentPick = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/*'],
        copyToCacheDirectory: true,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        const asset = result.assets[0];
        setScannedDocument({
          uri: asset.uri,
          type: 'document',
        });
        setShowPreviewModal(true);
      }
    } catch (err) {
      console.error('Document picker error:', err);
      toast.error('Failed to pick document');
    }
  };

  const handleSaveAsExpense = async () => {
    if (!scannedDocument) return;

    setUploading(true);
    try {
      // Upload the document first
      const formData = new FormData();
      formData.append('file', {
        uri: scannedDocument.uri,
        type: 'image/jpeg',
        name: `expense_${Date.now()}.jpg`,
      } as any);
      formData.append('entityType', 'expense');

      const uploadResult = await api.uploadDocument(formData);

      setShowPreviewModal(false);

      // Navigate to expense creation with the document attached
      router.push({
        pathname: '/accounting/expense/new',
        params: {
          documentId: uploadResult.data?.id,
          documentUri: scannedDocument.uri,
        },
      } as any);
    } catch (error) {
      console.error('Upload error:', error);
      // Still navigate but without upload (offline mode)
      setShowPreviewModal(false);
      router.push({
        pathname: '/accounting/expense/new',
        params: {
          documentUri: scannedDocument.uri,
        },
      } as any);
    } finally {
      setUploading(false);
    }
  };

  const handleSaveAsInvoice = async () => {
    if (!scannedDocument) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: scannedDocument.uri,
        type: 'image/jpeg',
        name: `invoice_${Date.now()}.jpg`,
      } as any);
      formData.append('entityType', 'invoice');

      const uploadResult = await api.uploadDocument(formData);

      setShowPreviewModal(false);

      router.push({
        pathname: '/accounting/invoice/new',
        params: {
          documentId: uploadResult.data?.id,
          documentUri: scannedDocument.uri,
        },
      } as any);
    } catch (error) {
      console.error('Upload error:', error);
      setShowPreviewModal(false);
      router.push({
        pathname: '/accounting/invoice/new',
        params: {
          documentUri: scannedDocument.uri,
        },
      } as any);
    } finally {
      setUploading(false);
    }
  };

  const handleSaveAsBill = async () => {
    if (!scannedDocument) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: scannedDocument.uri,
        type: 'image/jpeg',
        name: `bill_${Date.now()}.jpg`,
      } as any);
      formData.append('entityType', 'bill');

      const uploadResult = await api.uploadDocument(formData);

      setShowPreviewModal(false);

      router.push({
        pathname: '/accounting/bills/new',
        params: {
          documentId: uploadResult.data?.id,
          documentUri: scannedDocument.uri,
        },
      } as any);
    } catch (error) {
      console.error('Upload error:', error);
      setShowPreviewModal(false);
      router.push({
        pathname: '/accounting/bills/new',
        params: {
          documentUri: scannedDocument.uri,
        },
      } as any);
    } finally {
      setUploading(false);
    }
  };

  const handleRetake = () => {
    setScannedDocument(null);
    setShowPreviewModal(false);
    handleNativeScan();
  };

  if (processing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.processingText, { color: colors.muted }]}>
          Processing document...
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Scan Document</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Main Scan Options */}
        <View style={styles.scanOptions}>
          <TouchableOpacity
            style={[styles.scanOption, styles.primaryOption, { backgroundColor: '#10B98110', borderColor: '#10B981' }]}
            onPress={handleNativeScan}
          >
            <View style={[styles.iconCircle, { backgroundColor: '#10B98120' }]}>
              <Ionicons name="scan" size={36} color="#10B981" />
            </View>
            <Text style={[styles.optionTitle, { color: colors.text }]}>Smart Document Scan</Text>
            <Text style={[styles.optionDescription, { color: colors.muted }]}>
              Auto-detect edges and straighten documents
            </Text>
            <View style={styles.recommendedBadge}>
              <Text style={styles.recommendedText}>Recommended</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.scanOption, { backgroundColor: colors.background, borderColor: colors.divider }]}
            onPress={handleCameraCapture}
          >
            <View style={[styles.iconCircle, { backgroundColor: '#3B82F620' }]}>
              <Ionicons name="camera" size={32} color="#3B82F6" />
            </View>
            <Text style={[styles.optionTitle, { color: colors.text }]}>Take Photo</Text>
            <Text style={[styles.optionDescription, { color: colors.muted }]}>
              Simple camera capture without auto-crop
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.scanOption, { backgroundColor: colors.background, borderColor: colors.divider }]}
            onPress={handleGalleryPick}
          >
            <View style={[styles.iconCircle, { backgroundColor: '#8B5CF620' }]}>
              <Ionicons name="images" size={32} color="#8B5CF6" />
            </View>
            <Text style={[styles.optionTitle, { color: colors.text }]}>Choose from Gallery</Text>
            <Text style={[styles.optionDescription, { color: colors.muted }]}>
              Select existing photos from your device
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.scanOption, { backgroundColor: colors.background, borderColor: colors.divider }]}
            onPress={handleDocumentPick}
          >
            <View style={[styles.iconCircle, { backgroundColor: '#F59E0B20' }]}>
              <Ionicons name="document" size={32} color="#F59E0B" />
            </View>
            <Text style={[styles.optionTitle, { color: colors.text }]}>Upload File</Text>
            <Text style={[styles.optionDescription, { color: colors.muted }]}>
              Upload PDF documents or image files
            </Text>
          </TouchableOpacity>
        </View>

        {/* Quick Actions */}
        <View style={styles.quickActions}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Quick Actions</Text>
          <View style={styles.actionGrid}>
            <TouchableOpacity
              style={[styles.actionCard, { backgroundColor: colors.background, borderColor: colors.divider }]}
              onPress={() => router.push('/accounting/expense/new' as any)}
            >
              <Ionicons name="receipt-outline" size={24} color="#EF4444" />
              <Text style={[styles.actionText, { color: colors.text }]}>New Expense</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionCard, { backgroundColor: colors.background, borderColor: colors.divider }]}
              onPress={() => router.push('/accounting/invoice/new' as any)}
            >
              <Ionicons name="document-text-outline" size={24} color="#3B82F6" />
              <Text style={[styles.actionText, { color: colors.text }]}>New Invoice</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Tips */}
        <View style={[styles.tipsSection, { backgroundColor: '#3B82F610' }]}>
          <Text style={[styles.tipsTitle, { color: colors.text }]}>Scanning Tips</Text>
          <View style={styles.tip}>
            <Ionicons name="checkmark-circle" size={16} color="#3B82F6" />
            <Text style={[styles.tipText, { color: colors.muted }]}>
              Place document on a contrasting background
            </Text>
          </View>
          <View style={styles.tip}>
            <Ionicons name="checkmark-circle" size={16} color="#3B82F6" />
            <Text style={[styles.tipText, { color: colors.muted }]}>
              Ensure good lighting without shadows
            </Text>
          </View>
          <View style={styles.tip}>
            <Ionicons name="checkmark-circle" size={16} color="#3B82F6" />
            <Text style={[styles.tipText, { color: colors.muted }]}>
              Keep document flat and capture full content
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* Preview Modal */}
      <Modal
        visible={showPreviewModal}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowPreviewModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Document Preview</Text>
              <TouchableOpacity onPress={() => setShowPreviewModal(false)}>
                <Ionicons name="close" size={24} color={colors.text} />
              </TouchableOpacity>
            </View>

            {scannedDocument && (
              <View style={styles.previewContainer}>
                <Image
                  source={{ uri: scannedDocument.uri }}
                  style={styles.previewImage}
                  resizeMode="contain"
                />
              </View>
            )}

            <Text style={[styles.saveAsLabel, { color: colors.muted }]}>Save as:</Text>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.saveButton, { backgroundColor: '#EF4444' }]}
                onPress={handleSaveAsExpense}
                disabled={uploading}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <>
                    <Ionicons name="receipt" size={18} color="#FFFFFF" />
                    <Text style={styles.saveButtonText}>Expense</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.saveButton, { backgroundColor: '#3B82F6' }]}
                onPress={handleSaveAsInvoice}
                disabled={uploading}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <>
                    <Ionicons name="document-text" size={18} color="#FFFFFF" />
                    <Text style={styles.saveButtonText}>Invoice</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.saveButton, { backgroundColor: '#8B5CF6' }]}
                onPress={handleSaveAsBill}
                disabled={uploading}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <>
                    <Ionicons name="card" size={18} color="#FFFFFF" />
                    <Text style={styles.saveButtonText}>Bill</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

            <View style={styles.modalSecondaryActions}>
              <TouchableOpacity
                style={[styles.secondaryButton, { borderColor: colors.divider }]}
                onPress={handleRetake}
              >
                <Ionicons name="refresh" size={18} color={colors.text} />
                <Text style={[styles.secondaryButtonText, { color: colors.text }]}>Retake</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.secondaryButton, { borderColor: colors.divider }]}
                onPress={() => setShowPreviewModal(false)}
              >
                <Ionicons name="close" size={18} color={colors.text} />
                <Text style={[styles.secondaryButtonText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
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
    padding: 20,
  },
  processingText: {
    marginTop: 16,
    fontSize: 16,
    fontWeight: '600',
  },
  header: {
    padding: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  content: {
    padding: 16,
  },
  scanOptions: {
    gap: 12,
    marginBottom: 24,
  },
  scanOption: {
    padding: 20,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  primaryOption: {
    borderWidth: 2,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  optionDescription: {
    fontSize: 12,
    textAlign: 'center',
  },
  recommendedBadge: {
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#10B981',
    borderRadius: 12,
  },
  recommendedText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  quickActions: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  actionGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  actionCard: {
    flex: 1,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    gap: 8,
  },
  actionText: {
    fontSize: 12,
    fontWeight: '500',
  },
  tipsSection: {
    padding: 16,
    borderRadius: 8,
  },
  tipsTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  tip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  tipText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '90%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  previewContainer: {
    height: 300,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 16,
    backgroundColor: '#F3F4F6',
  },
  previewImage: {
    flex: 1,
    width: '100%',
  },
  saveAsLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  saveButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 14,
    borderRadius: 10,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  modalSecondaryActions: {
    flexDirection: 'row',
    gap: 12,
  },
  secondaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
