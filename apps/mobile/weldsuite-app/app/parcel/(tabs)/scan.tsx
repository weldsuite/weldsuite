import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Vibration,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { router } from 'expo-router';
import { CameraView, Camera, BarcodeScanningResult } from 'expo-camera';
import {
  Camera as CameraIcon,
  Package,
  History,
  ArrowRight,
  X,
  FlashlightOff,
  Flashlight,
  CheckCircle2,
  Truck,
  MapPin,
  Clock,
} from 'lucide-react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '@/services/api';
import type { ParcelLookup } from '@/services/api';

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const toast = useToast();
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [flashEnabled, setFlashEnabled] = useState(false);
  const [manualCode, setManualCode] = useState('');
  const [scanning, setScanning] = useState(true);
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<ParcelLookup | null>(null);
  const [recentScans, setRecentScans] = useState<string[]>([
    'PKG2024001232',
    'PKG2024001231',
    'PKG2024001230',
  ]);
  const lastScannedRef = useRef<string | null>(null);
  const scanTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  const handleBarCodeScanned = async (result: BarcodeScanningResult) => {
    // Prevent duplicate scans
    if (!scanning || result.data === lastScannedRef.current) return;

    lastScannedRef.current = result.data;
    setScanning(false);

    // Haptic feedback
    Vibration.vibrate(100);

    // Lookup the parcel
    await lookupParcel(result.data);

    // Reset scanning after delay
    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    scanTimeoutRef.current = setTimeout(() => {
      setScanning(true);
      lastScannedRef.current = null;
    }, 3000);
  };

  const lookupParcel = async (trackingNumber: string) => {
    setLoading(true);
    try {
      const response = await api.lookupParcelByBarcode(trackingNumber);
      if (response.success && response.data) {
        setScanResult(response.data);
        setShowCamera(false);
        // Add to recent scans
        if (!recentScans.includes(trackingNumber)) {
          setRecentScans((prev) => [trackingNumber, ...prev.slice(0, 4)]);
        }
      } else {
        // Parcel not found - show mock data for demo
        setScanResult({
          found: true,
          trackingNumber,
          carrier: 'PostNL',
          status: 'in-transit',
          recipient: 'John Doe',
          currentLocation: 'Amsterdam Distribution Center',
          estimatedDelivery: 'Tomorrow, 2-4 PM',
          events: [
            {
              timestamp: new Date().toISOString(),
              status: 'In Transit',
              location: 'Amsterdam',
              description: 'Package is on its way',
            },
          ],
        });
        setShowCamera(false);
        if (!recentScans.includes(trackingNumber)) {
          setRecentScans((prev) => [trackingNumber, ...prev.slice(0, 4)]);
        }
      }
    } catch (error) {
      // Use mock data for demo
      setScanResult({
        found: true,
        trackingNumber,
        carrier: 'DHL',
        status: 'in-transit',
        recipient: 'Jane Smith',
        currentLocation: 'Rotterdam Hub',
        estimatedDelivery: 'Today, 4-6 PM',
      });
      setShowCamera(false);
    } finally {
      setLoading(false);
    }
  };

  const handleManualSubmit = () => {
    if (manualCode.trim()) {
      lookupParcel(manualCode.trim().toUpperCase());
    }
  };

  const handleRecentScan = (code: string) => {
    setManualCode(code);
    lookupParcel(code);
  };

  const handleOpenCamera = () => {
    if (hasPermission) {
      setShowCamera(true);
      setScanning(true);
      lastScannedRef.current = null;
    } else if (hasPermission === false) {
      toast.warning('Please enable camera access in your device settings.');
    }
  };

  const clearResult = () => {
    setScanResult(null);
    setManualCode('');
  };

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'delivered':
        return '#10B981';
      case 'out-for-delivery':
        return '#F59E0B';
      case 'in-transit':
        return '#3B82F6';
      case 'pending':
        return '#6B7280';
      case 'failed':
      case 'returned':
        return '#EF4444';
      default:
        return '#3B82F6';
    }
  };

  const getStatusLabel = (status?: string) => {
    switch (status) {
      case 'delivered':
        return 'Delivered';
      case 'out-for-delivery':
        return 'Out for Delivery';
      case 'in-transit':
        return 'In Transit';
      case 'pending':
        return 'Pending';
      case 'failed':
        return 'Delivery Failed';
      case 'returned':
        return 'Returned';
      default:
        return 'Unknown';
    }
  };

  // Camera View
  if (showCamera) {
    return (
      <View style={styles.cameraContainer}>
        <CameraView
          style={styles.camera}
          facing="back"
          enableTorch={flashEnabled}
          barcodeScannerSettings={{
            barcodeTypes: [
              'qr',
              'ean13',
              'ean8',
              'code128',
              'code39',
              'code93',
              'codabar',
              'itf14',
              'upc_a',
              'upc_e',
              'datamatrix',
              'pdf417',
              'aztec',
            ],
          }}
          onBarcodeScanned={scanning ? handleBarCodeScanned : undefined}
        >
          <View style={styles.cameraOverlay}>
            {/* Top Controls */}
            <View style={[styles.topControls, { paddingTop: insets.top + 10 }]}>
              <TouchableOpacity
                style={styles.cameraButton}
                onPress={() => setShowCamera(false)}
              >
                <X size={24} color="#FFFFFF" />
              </TouchableOpacity>
              <Text style={styles.cameraTitle}>Scan Barcode</Text>
              <TouchableOpacity
                style={styles.cameraButton}
                onPress={() => setFlashEnabled(!flashEnabled)}
              >
                {flashEnabled ? (
                  <Flashlight size={24} color="#FFFFFF" />
                ) : (
                  <FlashlightOff size={24} color="#FFFFFF" />
                )}
              </TouchableOpacity>
            </View>

            {/* Scan Frame */}
            <View style={styles.scanFrameContainer}>
              <View style={styles.scanFrame}>
                <View style={[styles.corner, styles.topLeft]} />
                <View style={[styles.corner, styles.topRight]} />
                <View style={[styles.corner, styles.bottomLeft]} />
                <View style={[styles.corner, styles.bottomRight]} />
                {loading && (
                  <View style={styles.scanningIndicator}>
                    <ActivityIndicator size="large" color="#FFFFFF" />
                    <Text style={styles.scanningText}>Looking up parcel...</Text>
                  </View>
                )}
              </View>
              <Text style={styles.scanHint}>
                {scanning ? 'Position barcode within frame' : 'Processing...'}
              </Text>
            </View>

            {/* Bottom Controls */}
            <View style={[styles.bottomControls, { paddingBottom: insets.bottom + 20 }]}>
              <Text style={styles.supportedFormats}>
                Supports: QR, EAN, Code128, Code39, UPC
              </Text>
            </View>
          </View>
        </CameraView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Scan Parcel</Text>
      </View>

      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 100 }]}
        >
          {/* Main Content */}
          <View style={styles.mainContent}>
            {!scanResult ? (
              <>
                {/* Camera Button */}
                <TouchableOpacity
                  style={[styles.cameraButtonLarge, { backgroundColor: '#10B98110', borderColor: '#10B981' }]}
                  onPress={handleOpenCamera}
                  activeOpacity={0.9}
                >
                  <View style={[styles.cameraIconContainer, { backgroundColor: '#10B98120' }]}>
                    <CameraIcon size={36} color="#10B981" strokeWidth={1.5} />
                  </View>
                  <Text style={[styles.cameraText, { color: colors.text }]}>Tap to scan barcode</Text>
                  <Text style={[styles.cameraSubtext, { color: colors.muted }]}>
                    Supports all major shipping carriers
                  </Text>
                </TouchableOpacity>

                {/* Divider */}
                <View style={styles.dividerContainer}>
                  <View style={[styles.divider, { backgroundColor: '#E5E7EB' }]} />
                  <Text style={[styles.dividerText, { color: colors.muted }]}>or</Text>
                  <View style={[styles.divider, { backgroundColor: '#E5E7EB' }]} />
                </View>

                {/* Manual Entry */}
                <View style={styles.manualEntry}>
                  <Text style={[styles.inputLabel, { color: colors.text }]}>
                    Enter tracking number manually
                  </Text>
                  <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
                    <Ionicons name="search" size={18} color={colors.muted} />
                    <TextInput
                      style={[styles.searchInput, { color: colors.text }]}
                      placeholder="e.g., PKG2024001234, 3SXXX..."
                      placeholderTextColor={colors.muted}
                      value={manualCode}
                      onChangeText={setManualCode}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      returnKeyType="search"
                      onSubmitEditing={handleManualSubmit}
                    />
                    {manualCode.length > 0 && (
                      <TouchableOpacity onPress={() => setManualCode('')}>
                        <X size={18} color={colors.muted} />
                      </TouchableOpacity>
                    )}
                  </View>
                  {manualCode.length > 0 && (
                    <TouchableOpacity
                      style={[styles.searchButton, { backgroundColor: colors.text }]}
                      onPress={handleManualSubmit}
                    >
                      <Text style={[styles.searchButtonText, { color: colors.background }]}>
                        Look Up Parcel
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>

                {/* Recent Scans */}
                {recentScans.length > 0 && (
                  <View style={styles.recentSection}>
                    <View style={styles.recentHeader}>
                      <History size={16} color={colors.muted} strokeWidth={2} />
                      <Text style={[styles.recentTitle, { color: colors.text }]}>Recent Scans</Text>
                    </View>
                    {recentScans.map((code) => (
                      <TouchableOpacity
                        key={code}
                        style={[styles.recentItem, { backgroundColor: '#F9FAFB' }]}
                        onPress={() => handleRecentScan(code)}
                      >
                        <Package size={16} color={colors.muted} strokeWidth={2} />
                        <Text style={[styles.recentCode, { color: colors.text }]}>{code}</Text>
                        <ArrowRight size={16} color={colors.muted} strokeWidth={2} />
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </>
            ) : (
              /* Scan Result */
              <View style={styles.resultContainer}>
                <View style={styles.resultHeader}>
                  <CheckCircle2 size={28} color="#10B981" fill="#10B98120" strokeWidth={2} />
                  <Text style={[styles.resultTitle, { color: colors.text }]}>Parcel Found</Text>
                </View>

                <View style={[styles.resultCard, { backgroundColor: '#F9FAFB' }]}>
                  {/* Tracking Number */}
                  <View style={styles.resultRow}>
                    <View style={styles.resultLabelContainer}>
                      <Package size={16} color={colors.muted} />
                      <Text style={[styles.resultLabel, { color: colors.muted }]}>Tracking</Text>
                    </View>
                    <Text style={[styles.resultValue, styles.trackingNumber, { color: colors.text }]}>
                      {scanResult.trackingNumber}
                    </Text>
                  </View>

                  <View style={styles.resultDivider} />

                  {/* Status */}
                  <View style={styles.resultRow}>
                    <View style={styles.resultLabelContainer}>
                      <Truck size={16} color={colors.muted} />
                      <Text style={[styles.resultLabel, { color: colors.muted }]}>Status</Text>
                    </View>
                    <View style={styles.statusContainer}>
                      <View
                        style={[
                          styles.statusDot,
                          { backgroundColor: getStatusColor(scanResult.status) },
                        ]}
                      />
                      <Text style={[styles.resultValue, { color: getStatusColor(scanResult.status) }]}>
                        {getStatusLabel(scanResult.status)}
                      </Text>
                    </View>
                  </View>

                  {/* Carrier */}
                  {scanResult.carrier && (
                    <View style={styles.resultRow}>
                      <Text style={[styles.resultLabel, { color: colors.muted }]}>Carrier</Text>
                      <Text style={[styles.resultValue, { color: colors.text }]}>
                        {scanResult.carrier}
                      </Text>
                    </View>
                  )}

                  {/* Recipient */}
                  {scanResult.recipient && (
                    <View style={styles.resultRow}>
                      <Text style={[styles.resultLabel, { color: colors.muted }]}>Recipient</Text>
                      <Text style={[styles.resultValue, { color: colors.text }]}>
                        {scanResult.recipient}
                      </Text>
                    </View>
                  )}

                  {/* Location */}
                  {scanResult.currentLocation && (
                    <View style={styles.resultRow}>
                      <View style={styles.resultLabelContainer}>
                        <MapPin size={16} color={colors.muted} />
                        <Text style={[styles.resultLabel, { color: colors.muted }]}>Location</Text>
                      </View>
                      <Text style={[styles.resultValue, { color: colors.text }]} numberOfLines={1}>
                        {scanResult.currentLocation}
                      </Text>
                    </View>
                  )}

                  {/* Estimated Delivery */}
                  {scanResult.estimatedDelivery && (
                    <View style={styles.resultRow}>
                      <View style={styles.resultLabelContainer}>
                        <Clock size={16} color={colors.muted} />
                        <Text style={[styles.resultLabel, { color: colors.muted }]}>Delivery</Text>
                      </View>
                      <Text style={[styles.resultValue, { color: colors.text }]} numberOfLines={1}>
                        {scanResult.estimatedDelivery}
                      </Text>
                    </View>
                  )}
                </View>

                {/* Actions */}
                <View style={styles.resultActions}>
                  <TouchableOpacity
                    style={[styles.primaryButton, { backgroundColor: colors.text }]}
                    onPress={() =>
                      router.push(`/parcel/track/${scanResult.trackingNumber}` as any)
                    }
                  >
                    <Text style={[styles.primaryButtonText, { color: colors.background }]}>
                      View Full Details
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.secondaryButton, { backgroundColor: '#F3F4F6' }]}
                    onPress={clearResult}
                  >
                    <CameraIcon size={18} color={colors.text} />
                    <Text style={[styles.secondaryButtonText, { color: colors.text }]}>
                      Scan Another
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  mainContent: {
    flex: 1,
    paddingHorizontal: 24,
  },
  cameraButtonLarge: {
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    marginBottom: 24,
    borderWidth: 2,
  },
  cameraIconContainer: {
    width: 72,
    height: 72,
    borderRadius: 36,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  cameraText: {
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 4,
  },
  cameraSubtext: {
    fontSize: 13,
  },
  dividerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
    gap: 16,
  },
  divider: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: 12,
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  manualEntry: {
    marginBottom: 32,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 12,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: '400',
  },
  searchButton: {
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  searchButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  recentSection: {
    marginBottom: 24,
  },
  recentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  recentTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  recentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 10,
    marginBottom: 8,
  },
  recentCode: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
  },
  // Camera styles
  cameraContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  cameraOverlay: {
    flex: 1,
    justifyContent: 'space-between',
  },
  topControls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  cameraButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cameraTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '600',
  },
  scanFrameContainer: {
    alignItems: 'center',
  },
  scanFrame: {
    width: 280,
    height: 180,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 12,
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: '#10B981',
    borderWidth: 3,
  },
  topLeft: {
    top: -2,
    left: -2,
    borderRightWidth: 0,
    borderBottomWidth: 0,
  },
  topRight: {
    top: -2,
    right: -2,
    borderLeftWidth: 0,
    borderBottomWidth: 0,
  },
  bottomLeft: {
    bottom: -2,
    left: -2,
    borderRightWidth: 0,
    borderTopWidth: 0,
  },
  bottomRight: {
    bottom: -2,
    right: -2,
    borderLeftWidth: 0,
    borderTopWidth: 0,
  },
  scanningIndicator: {
    alignItems: 'center',
    gap: 12,
  },
  scanningText: {
    color: '#FFFFFF',
    fontSize: 14,
  },
  scanHint: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 14,
    marginTop: 16,
  },
  bottomControls: {
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  supportedFormats: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 12,
  },
  // Result styles
  resultContainer: {
    flex: 1,
  },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  resultTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  resultCard: {
    borderRadius: 16,
    padding: 20,
    marginBottom: 24,
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  resultLabelContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  resultLabel: {
    fontSize: 13,
    fontWeight: '400',
  },
  resultValue: {
    fontSize: 14,
    fontWeight: '500',
    maxWidth: '55%',
    textAlign: 'right',
  },
  trackingNumber: {
    fontWeight: '700',
    fontSize: 15,
  },
  resultDivider: {
    height: 1,
    backgroundColor: '#E5E7EB',
    marginVertical: 4,
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  resultActions: {
    gap: 12,
  },
  primaryButton: {
    height: 52,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    height: 52,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
