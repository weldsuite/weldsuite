import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  SafeAreaView,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

// AI-powered document scanning (auto-upload + OCR extraction) has been
// removed along with the AI backend. The camera capture flow is kept so the
// screen stays navigable, but it now hands off to manual entry instead of
// calling the (removed) `/weldbooks/documents/ocr` endpoints.
type ScanPhase = 'camera' | 'unavailable';

export default function ScanScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();

  const [phase, setPhase] = useState<ScanPhase>('camera');
  const [flashEnabled, setFlashEnabled] = useState(false);
  const [capturedUri, setCapturedUri] = useState<string | null>(null);

  const processImage = useCallback((uri: string) => {
    setCapturedUri(uri);
    setPhase('unavailable');
  }, []);

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (photo?.uri) {
        processImage(photo.uri);
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to capture photo');
    }
  }, [processImage]);

  const handlePickFromGallery = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]) {
      processImage(result.assets[0].uri);
    }
  }, [processImage]);

  const handlePickDocument = useCallback(async () => {
    // Use image picker with camera roll as a simple document source
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]) {
      processImage(result.assets[0].uri);
    }
  }, [processImage]);

  // No OCR data to prefill anymore — hand off to the manual entry forms.
  const handleCreateBill = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({ pathname: '/bill/new', params: {} });
  }, [router]);

  const handleQuickExpense = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({ pathname: '/expense/quick', params: {} });
  }, [router]);

  const handleRetake = useCallback(() => {
    setCapturedUri(null);
    setPhase('camera');
  }, []);

  const handleClose = useCallback(() => {
    router.back();
  }, [router]);

  // Permission not yet determined
  if (!permission) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color="#10B981" />
      </View>
    );
  }

  // Permission denied
  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.permissionContainer}>
          <Text style={[styles.permissionTitle, { color: colors.text }]}>
            Camera Permission Required
          </Text>
          <Text style={[styles.permissionText, { color: colors.muted }]}>
            WeldBooks needs camera access to scan documents, receipts, and invoices.
          </Text>
          <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
            <Text style={styles.permissionButtonText}>Grant Permission</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.closeTextButton} onPress={handleClose}>
            <Text style={[styles.closeTextButtonLabel, { color: colors.muted }]}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Camera phase
  if (phase === 'camera') {
    return (
      <View style={styles.container}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing="back"
          enableTorch={flashEnabled}
        >
          {/* Overlay frame */}
          <View style={styles.overlay}>
            <SafeAreaView style={styles.topBar}>
              <TouchableOpacity style={styles.topBarButton} onPress={handleClose}>
                <Text style={styles.topBarButtonText}>✕</Text>
              </TouchableOpacity>
              <Text style={styles.topBarTitle}>Scan Document</Text>
              <TouchableOpacity
                style={styles.topBarButton}
                onPress={() => setFlashEnabled(!flashEnabled)}
              >
                <Text style={styles.topBarButtonText}>{flashEnabled ? '⚡' : '⚡'}</Text>
                {flashEnabled && <View style={styles.flashIndicator} />}
              </TouchableOpacity>
            </SafeAreaView>

            {/* Document frame */}
            <View style={styles.frameContainer}>
              <View style={styles.documentFrame}>
                <View style={[styles.corner, styles.cornerTL]} />
                <View style={[styles.corner, styles.cornerTR]} />
                <View style={[styles.corner, styles.cornerBL]} />
                <View style={[styles.corner, styles.cornerBR]} />
              </View>
              <Text style={styles.frameHint}>Align document within the frame</Text>
            </View>

            {/* Bottom bar */}
            <SafeAreaView style={styles.bottomBar}>
              <TouchableOpacity style={styles.bottomBarSideButton} onPress={handlePickFromGallery}>
                <View style={styles.galleryIcon}>
                  <Text style={styles.galleryIconText}>🖼</Text>
                </View>
                <Text style={styles.bottomBarLabel}>Gallery</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.captureButton} onPress={handleCapture}>
                <View style={styles.captureButtonInner} />
              </TouchableOpacity>

              <TouchableOpacity style={styles.bottomBarSideButton} onPress={handlePickDocument}>
                <View style={styles.galleryIcon}>
                  <Text style={styles.galleryIconText}>📄</Text>
                </View>
                <Text style={styles.bottomBarLabel}>Files</Text>
              </TouchableOpacity>
            </SafeAreaView>
          </View>
        </CameraView>
      </View>
    );
  }

  // Preview / unavailable phase — auto-extraction (OCR) is no longer
  // available, so we just show the captured photo and hand off to manual entry.
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={styles.previewHeader}>
        <TouchableOpacity onPress={handleRetake}>
          <Text style={styles.retakeText}>Retake</Text>
        </TouchableOpacity>
        <Text style={[styles.previewTitle, { color: colors.text }]}>Scan Document</Text>
        <TouchableOpacity onPress={handleClose}>
          <Text style={[styles.closeText, { color: colors.muted }]}>Close</Text>
        </TouchableOpacity>
      </View>

      {/* Image preview */}
      {capturedUri && (
        <View style={styles.imagePreviewContainer}>
          <Image source={{ uri: capturedUri }} style={styles.imagePreview} resizeMode="contain" />
        </View>
      )}

      {/* AI unavailable message */}
      <View style={styles.errorContainer}>
        <Text style={[styles.errorText, { color: colors.muted }]}>
          AI is currently unavailable. Automatic data extraction from this photo
          isn't possible right now — you can still add the expense or bill manually.
        </Text>
      </View>

      <View style={styles.resultsContainer}>
        <View style={styles.actionButtons}>
          <TouchableOpacity style={styles.createBillButton} onPress={handleCreateBill}>
            <Text style={styles.createBillButtonText}>Create Bill</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.quickExpenseButton, { borderColor: '#10B981' }]}
            onPress={handleQuickExpense}
          >
            <Text style={styles.quickExpenseButtonText}>Quick Expense</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  overlay: {
    flex: 1,
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  topBarButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  topBarButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  topBarTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  flashIndicator: {
    position: 'absolute',
    bottom: 4,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#10B981',
  },
  frameContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  documentFrame: {
    width: 300,
    height: 400,
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderColor: '#10B981',
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 8,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 8,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 8,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 8,
  },
  frameHint: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    marginTop: 16,
  },
  bottomBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 32,
    paddingBottom: 16,
  },
  bottomBarSideButton: {
    alignItems: 'center',
    gap: 4,
  },
  galleryIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  galleryIconText: {
    fontSize: 20,
  },
  bottomBarLabel: {
    color: '#fff',
    fontSize: 11,
  },
  captureButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  captureButtonInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#fff',
  },
  // Preview / Results styles
  previewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  retakeText: {
    color: '#10B981',
    fontSize: 16,
    fontWeight: '500',
  },
  previewTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  closeText: {
    fontSize: 16,
  },
  imagePreviewContainer: {
    height: 240,
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  imagePreview: {
    width: '100%',
    height: '100%',
  },
  errorContainer: {
    marginHorizontal: 16,
    marginTop: 16,
    padding: 16,
    backgroundColor: 'rgba(107,114,128,0.1)',
    borderRadius: 12,
    alignItems: 'center',
    gap: 8,
  },
  errorText: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  resultsContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  resultCard: {
    borderRadius: 12,
    padding: 16,
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  resultLabel: {
    fontSize: 14,
  },
  resultValue: {
    fontSize: 15,
    fontWeight: '600',
  },
  resultDivider: {
    height: StyleSheet.hairlineWidth,
  },
  actionButtons: {
    marginTop: 24,
    gap: 12,
  },
  createBillButton: {
    backgroundColor: '#10B981',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  createBillButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  quickExpenseButton: {
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1.5,
  },
  quickExpenseButtonText: {
    color: '#10B981',
    fontSize: 16,
    fontWeight: '600',
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  permissionTitle: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  permissionText: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  permissionButton: {
    marginTop: 12,
    backgroundColor: '#10B981',
    borderRadius: 12,
    paddingHorizontal: 32,
    paddingVertical: 14,
  },
  permissionButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  closeTextButton: {
    marginTop: 8,
    padding: 8,
  },
  closeTextButtonLabel: {
    fontSize: 15,
  },
});
