/**
 * Receipt scanner.
 *
 * Captures (or picks) an image, uploads it to R2 through app-api's storage
 * broker and registers an accounting document, then hands the resulting
 * `documentId` to the bill or expense form so the receipt stays attached.
 *
 * Automatic field extraction is NOT available: `processDocumentOcr` in app-api
 * has been a no-op since the AI teardown, so this flow deliberately goes to
 * manual entry rather than pretending to read the receipt.
 */

import { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { X, Zap, Images, Receipt, FileText } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';

import api from '@/services/api';
import { BRAND } from '@/lib/brand';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';

type Phase = 'camera' | 'review';

export default function ScanScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const { isOnline, addToQueue } = useOfflineQueue();

  const [phase, setPhase] = useState<Phase>('camera');
  const [flashEnabled, setFlashEnabled] = useState(false);
  const [capturedUri, setCapturedUri] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  /**
   * Uploads in the background so the user can start typing immediately. A
   * failure is non-fatal — the record is still creatable, just without the
   * image attached.
   */
  const upload = useCallback(
    async (uri: string) => {
      const fileName = `receipt-${Date.now()}.jpg`;

      if (!isOnline) {
        await addToQueue({ type: 'document', data: { fileName, type: 'receipt' } });
        toast.info('Offline — the receipt will upload when you reconnect');
        return;
      }

      setUploading(true);
      try {
        const doc = await api.uploadScannedDocument(uri, fileName);
        setDocumentId(doc.id);
      } catch (err) {
        console.error('Failed to upload scan:', err);
        toast.error('Could not upload the image — you can still enter the details');
      } finally {
        setUploading(false);
      }
    },
    [isOnline, addToQueue, toast],
  );

  const processImage = useCallback(
    (uri: string) => {
      setCapturedUri(uri);
      setDocumentId(null);
      setPhase('review');
      void upload(uri);
    },
    [upload],
  );

  const handleCapture = useCallback(async () => {
    if (!cameraRef.current) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
      if (photo?.uri) processImage(photo.uri);
    } catch {
      toast.error('Failed to capture the photo');
    }
  }, [processImage, toast]);

  const handlePickFromGallery = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) processImage(result.assets[0].uri);
  }, [processImage]);

  const handleClose = useCallback(() => router.back(), [router]);

  const goTo = useCallback(
    (path: '/bill/new' | '/expense/quick') => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.replace({ pathname: path, params: documentId ? { documentId } : {} } as never);
    },
    [router, documentId],
  );

  if (!permission) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={BRAND} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={styles.permission}>
          <Receipt size={40} color={colors.mutedForeground} />
          <Text style={[styles.permissionTitle, { color: colors.text }]}>
            Camera access needed
          </Text>
          <Text style={[styles.permissionText, { color: colors.mutedForeground }]}>
            WeldBooks uses the camera to scan receipts and invoices.
          </Text>
          <Button title="Grant permission" onPress={requestPermission} style={styles.permissionCta} />
          <Button title="Pick from gallery" variant="ghost" onPress={handlePickFromGallery} />
          <Button title="Go back" variant="ghost" onPress={handleClose} />
        </View>
      </SafeAreaView>
    );
  }

  if (phase === 'camera') {
    return (
      <View style={styles.cameraRoot}>
        <StatusBar style="light" />
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
          enableTorch={flashEnabled}
        />
        <View style={styles.overlay} pointerEvents="box-none">
          <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
            <TouchableOpacity
              style={styles.topButton}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close scanner"
            >
              <X size={22} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.topTitle}>Scan receipt</Text>
            <TouchableOpacity
              style={[styles.topButton, flashEnabled && styles.topButtonActive]}
              onPress={() => setFlashEnabled((on) => !on)}
              accessibilityRole="button"
              accessibilityLabel={flashEnabled ? 'Turn flash off' : 'Turn flash on'}
            >
              <Zap size={20} color={flashEnabled ? '#000' : '#fff'} />
            </TouchableOpacity>
          </View>

          <View style={styles.frameArea} pointerEvents="none">
            <View style={styles.frame}>
              <View style={[styles.corner, styles.cornerTL]} />
              <View style={[styles.corner, styles.cornerTR]} />
              <View style={[styles.corner, styles.cornerBL]} />
              <View style={[styles.corner, styles.cornerBR]} />
            </View>
            <Text style={styles.frameHint}>Align the receipt within the frame</Text>
          </View>

          <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <TouchableOpacity
              style={styles.sideButton}
              onPress={handlePickFromGallery}
              accessibilityRole="button"
              accessibilityLabel="Pick from gallery"
            >
              <Images size={22} color="#fff" />
              <Text style={styles.sideLabel}>Gallery</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.shutter}
              onPress={handleCapture}
              accessibilityRole="button"
              accessibilityLabel="Take photo"
            >
              <View style={styles.shutterInner} />
            </TouchableOpacity>

            <View style={styles.sideButton} />
          </View>
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={styles.reviewHeader}>
        <TouchableOpacity
          onPress={() => {
            setCapturedUri(null);
            setDocumentId(null);
            setPhase('camera');
          }}
          accessibilityRole="button"
        >
          <Text style={[styles.reviewAction, { color: BRAND }]}>Retake</Text>
        </TouchableOpacity>
        <Text style={[styles.reviewTitle, { color: colors.text }]}>Receipt</Text>
        <TouchableOpacity onPress={handleClose} accessibilityRole="button">
          <Text style={[styles.reviewAction, { color: colors.mutedForeground }]}>Close</Text>
        </TouchableOpacity>
      </View>

      {capturedUri ? (
        <View style={styles.previewWrap}>
          <Image source={{ uri: capturedUri }} style={styles.preview} resizeMode="contain" />
        </View>
      ) : null}

      <View style={styles.reviewBody}>
        {uploading ? (
          <Banner variant="info" style={styles.banner}>
            Uploading the image…
          </Banner>
        ) : documentId ? (
          <Banner variant="success" style={styles.banner}>
            Receipt attached. Enter the amounts to book it.
          </Banner>
        ) : (
          <Banner variant="info" style={styles.banner}>
            Automatic extraction isn&apos;t available. Enter the details to book this receipt.
          </Banner>
        )}

        <Button
          title="Quick expense"
          leftIcon={<Receipt size={18} color={colors.primaryForeground} />}
          onPress={() => goTo('/expense/quick')}
          fullWidth
        />
        <Button
          title="Create bill"
          variant="outline"
          leftIcon={<FileText size={18} color={colors.text} />}
          onPress={() => goTo('/bill/new')}
          fullWidth
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cameraRoot: { flex: 1, backgroundColor: '#000' },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  topButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topButtonActive: { backgroundColor: '#FBBF24' },
  topTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  frameArea: { alignItems: 'center', gap: 16 },
  frame: { width: '78%', aspectRatio: 0.72 },
  corner: { position: 'absolute', width: 32, height: 32, borderColor: '#fff' },
  cornerTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 8 },
  cornerTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 8 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 8 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 8 },
  frameHint: { color: 'rgba(255,255,255,0.85)', fontSize: 13 },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
    paddingBottom: 16,
  },
  sideButton: { width: 64, alignItems: 'center', gap: 4 },
  sideLabel: { color: '#fff', fontSize: 11 },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff' },
  permission: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
  permissionTitle: { fontSize: 17, fontWeight: '600', marginTop: 12 },
  permissionText: { fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 12 },
  permissionCta: { minWidth: 200 },
  reviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  reviewTitle: { fontSize: 16, fontWeight: '600' },
  reviewAction: { fontSize: 15, fontWeight: '600' },
  previewWrap: { flex: 1, margin: 16, borderRadius: 12, overflow: 'hidden' },
  preview: { flex: 1 },
  reviewBody: { padding: 16, gap: 8 },
  banner: { marginBottom: 4 },
});
