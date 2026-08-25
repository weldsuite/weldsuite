/**
 * Receipt scanner.
 *
 * Captures (or picks) an image, uploads it to R2, runs vision OCR, then hands
 * the `documentId` to the bill or expense form so vendor, dates and amounts
 * are already filled. If OCR fails the image still attaches and the user
 * enters the figures by hand.
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
import { useI18n, useLocaleFormatters } from '@/lib/i18n';
import { useOfflineQueue } from '@/contexts/OfflineQueueContext';
import type { BillPrefill } from '@/types/accounting';

type Phase = 'camera' | 'review';
type ScanStatus = 'uploading' | 'reading' | 'ready' | 'failed' | 'offline';

export default function ScanScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const cameraRef = useRef<CameraView>(null);
  const requestIdRef = useRef(0);
  const [permission, requestPermission] = useCameraPermissions();
  const { isOnline, addToQueue } = useOfflineQueue();
  const { t, format } = useI18n();
  const { formatCurrency } = useLocaleFormatters();

  const [phase, setPhase] = useState<Phase>('camera');
  const [flashEnabled, setFlashEnabled] = useState(false);
  const [capturedUri, setCapturedUri] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<BillPrefill | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus>('uploading');

  const busy = scanStatus === 'uploading' || scanStatus === 'reading';

  const summarisePrefill = useCallback(
    (pf: BillPrefill): string => {
      const currency = pf.currency || 'EUR';
      const parts: string[] = [];
      if (pf.contactName) parts.push(pf.contactName);
      if (pf.total != null) parts.push(formatCurrency(pf.total, currency));
      else if (pf.subtotal != null) parts.push(formatCurrency(pf.subtotal, currency));
      if (parts.length === 0) return t.scan.extracted;
      return format(t.scan.found, { summary: parts.join(' · ') });
    },
    [t, format, formatCurrency],
  );

  /**
   * Upload, then OCR. A later retake increments `requestIdRef` so a stale
   * response cannot overwrite the current review.
   */
  const upload = useCallback(
    async (uri: string) => {
      const requestId = ++requestIdRef.current;
      const stillCurrent = () => requestId === requestIdRef.current;
      const fileName = `receipt-${Date.now()}.jpg`;

      if (!isOnline) {
        await addToQueue({ type: 'document', data: { fileName, type: 'receipt' } });
        if (!stillCurrent()) return;
        setScanStatus('offline');
        toast.info(t.scan.offlineQueued);
        return;
      }

      setScanStatus('uploading');
      let uploadedId: string | null = null;
      try {
        const doc = await api.uploadScannedDocument(uri, fileName);
        uploadedId = doc.id;
        if (!stillCurrent()) return;
        setDocumentId(doc.id);
        setScanStatus('reading');

        await api.processDocument(doc.id);
        const extracted = await api.getBillFromDocument(doc.id);
        if (!stillCurrent()) return;
        setPrefill(extracted);
        setScanStatus('ready');
      } catch (err) {
        console.error('Failed to scan receipt:', err);
        if (!stillCurrent()) return;
        setScanStatus('failed');
        if (!uploadedId) {
          toast.error(t.scan.uploadFailed);
        }
      }
    },
    [isOnline, addToQueue, toast, t],
  );

  const processImage = useCallback(
    (uri: string) => {
      setCapturedUri(uri);
      setDocumentId(null);
      setPrefill(null);
      setScanStatus('uploading');
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
      toast.error(t.scan.captureFailed);
    }
  }, [processImage, toast, t]);

  const handlePickFromGallery = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) processImage(result.assets[0].uri);
  }, [processImage]);

  const handleClose = useCallback(() => router.back(), [router]);

  const handleRetake = useCallback(() => {
    requestIdRef.current += 1;
    setCapturedUri(null);
    setDocumentId(null);
    setPrefill(null);
    setPhase('camera');
  }, []);

  const goTo = useCallback(
    (path: '/bill/new' | '/expense/quick') => {
      if (busy) return;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.replace({ pathname: path, params: documentId ? { documentId } : {} } as never);
    },
    [router, documentId, busy],
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
            {t.scan.cameraNeeded}
          </Text>
          <Text style={[styles.permissionText, { color: colors.mutedForeground }]}>
            {t.scan.cameraDescription}
          </Text>
          <Button title={t.scan.grantPermission} onPress={requestPermission} style={styles.permissionCta} />
          <Button title={t.scan.pickFromGallery} variant="ghost" onPress={handlePickFromGallery} />
          <Button title={t.scan.goBack} variant="ghost" onPress={handleClose} />
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
              accessibilityLabel={t.scan.closeScanner}
            >
              <X size={22} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.topTitle}>{t.scan.scanReceipt}</Text>
            <TouchableOpacity
              style={[styles.topButton, flashEnabled && styles.topButtonActive]}
              onPress={() => setFlashEnabled((on) => !on)}
              accessibilityRole="button"
              accessibilityLabel={flashEnabled ? t.scan.flashOn : t.scan.flashOff}
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
            <Text style={styles.frameHint}>{t.scan.alignHint}</Text>
          </View>

          <View style={[styles.bottomBar, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <TouchableOpacity
              style={styles.sideButton}
              onPress={handlePickFromGallery}
              accessibilityRole="button"
              accessibilityLabel={t.scan.pickFromGallery}
            >
              <Images size={22} color="#fff" />
              <Text style={styles.sideLabel}>{t.scan.pickFromGallery}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.shutter}
              onPress={handleCapture}
              accessibilityRole="button"
              accessibilityLabel={t.scan.takePhoto}
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
        <TouchableOpacity onPress={handleRetake} accessibilityRole="button">
          <Text style={[styles.reviewAction, { color: BRAND }]}>{t.scan.retake}</Text>
        </TouchableOpacity>
        <Text style={[styles.reviewTitle, { color: colors.text }]}>{t.scan.receipt}</Text>
        <TouchableOpacity onPress={handleClose} accessibilityRole="button">
          <Text style={[styles.reviewAction, { color: colors.mutedForeground }]}>{t.scan.close}</Text>
        </TouchableOpacity>
      </View>

      {capturedUri ? (
        <View style={styles.previewWrap}>
          <Image source={{ uri: capturedUri }} style={styles.preview} resizeMode="contain" />
        </View>
      ) : null}

      <View style={styles.reviewBody}>
        {scanStatus === 'uploading' ? (
          <Banner variant="info" style={styles.banner}>
            {t.scan.uploading}
          </Banner>
        ) : null}
        {scanStatus === 'reading' ? (
          <Banner variant="info" style={styles.banner}>
            {t.scan.reading}
          </Banner>
        ) : null}
        {scanStatus === 'ready' ? (
          <Banner variant="success" style={styles.banner}>
            {prefill ? summarisePrefill(prefill) : t.scan.attached}
          </Banner>
        ) : null}
        {scanStatus === 'failed' ? (
          <Banner variant="warning" style={styles.banner}>
            {t.scan.ocrFailed}
          </Banner>
        ) : null}
        {scanStatus === 'offline' ? (
          <Banner variant="info" style={styles.banner}>
            {t.scan.offlineBanner}
          </Banner>
        ) : null}

        <Button
          title={t.scan.quickExpense}
          leftIcon={<Receipt size={18} color={colors.primaryForeground} />}
          onPress={() => goTo('/expense/quick')}
          disabled={busy}
          fullWidth
        />
        <Button
          title={t.scan.createBill}
          variant="outline"
          leftIcon={<FileText size={18} color={colors.text} />}
          onPress={() => goTo('/bill/new')}
          disabled={busy}
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
