import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  View,
  Text,
  RefreshControl,
  Linking,
  Modal,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';
import type { ShipmentDto, TrackingEventDto } from '@/types/wms';
import {
  getShipmentStatusColor,
  formatDate,
  formatMoney,
  formatAddress,
} from '@/utils/wms-helpers';
import {
  ChevronLeft,
  Truck,
  Package,
  MapPin,
  ExternalLink,
  Calendar,
  DollarSign,
  Clock,
  CheckCircle2,
  AlertCircle,
  Box,
  ScanBarcode,
  Send,
} from 'lucide-react-native';
import { Camera, CameraView, BarcodeScanningResult } from 'expo-camera';

export default function ShipmentDetailScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const toast = useToast();

  const [shipment, setShipment] = useState<ShipmentDto | null>(null);
  const [trackingEvents, setTrackingEvents] = useState<TrackingEventDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingTracking, setLoadingTracking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [scannerVisible, setScannerVisible] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scannedCode, setScannedCode] = useState('');

  useEffect(() => {
    if (id) {
      loadShipment();
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  const loadShipment = async () => {
    try {
      setLoading(true);
      const response = await api.getShipment(id);

      if (response.success && response.data) {
        setShipment(response.data);
        // Load tracking if tracking number exists
        if (response.data.trackingNumber) {
          await loadTracking(response.data.trackingNumber);
        }
      } else {
        throw new Error(response.error || 'Failed to load shipment');
      }
    } catch (error) {
      console.error('Error loading shipment:', error);
      toast.error('Failed to load shipment details');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadTracking = async (trackingNumber: string) => {
    try {
      setLoadingTracking(true);
      const response = await api.trackShipment(trackingNumber);

      if (response.success && response.data) {
        setTrackingEvents(response.data.events || []);
      }
    } catch (error) {
      console.error('Error loading tracking:', error);
    } finally {
      setLoadingTracking(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadShipment();
  };

  const handleTrackOnline = () => {
    if (!shipment?.trackingUrl) {
      toast.error('Tracking URL not available');
      return;
    }

    Linking.openURL(shipment.trackingUrl).catch((err) => {
      console.error('Error opening tracking URL:', err);
      toast.error('Unable to open tracking URL');
    });
  };

  const handleBarCodeScanned = (result: BarcodeScanningResult) => {
    const data = result.data;
    setScannedCode(data);
    setScannerVisible(false);

    // Verify scanned code matches tracking number
    if (shipment && data === shipment.trackingNumber) {
      toast.success('Package verified!');
    } else {
      toast.error('Scanned code does not match tracking number');
    }
  };

  const handleGenerateLabel = async () => {
    if (!shipment) return;

    try {
      setUpdating(true);
      const response = await api.generateShippingLabel(shipment.id);

      if (response.success && response.data) {
        toast.success('Shipping label generated');
        await loadShipment();
      } else {
        throw new Error(response.error || 'Failed to generate label');
      }
    } catch (error) {
      console.error('Error generating label:', error);
      toast.error('Failed to generate shipping label');
    } finally {
      setUpdating(false);
    }
  };

  const handleMarkAsShipped = async () => {
    if (!shipment) return;

    try {
      setUpdating(true);
      const response = await api.updateShipmentStatus(shipment.id, {
        status: 'shipped',
        timestamp: new Date().toISOString(),
      });

      if (response.success) {
        toast.success('Shipment marked as shipped');
        await loadShipment();
      } else {
        throw new Error(response.error || 'Failed to update status');
      }
    } catch (error) {
      console.error('Error updating status:', error);
      toast.error('Failed to mark shipment as shipped');
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading shipment...</Text>
      </View>
    );
  }

  if (!shipment) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.muted }]}>Shipment not found</Text>
      </View>
    );
  }

  const statusColor = getShipmentStatusColor(shipment.status);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <Text style={[styles.trackingNumber, { color: colors.text }]}>
            {shipment.trackingNumber || 'No Tracking'}
          </Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>
              {shipment.status.replace(/_/g, ' ')}
            </Text>
          </View>
        </View>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.tint} />
        }
      >
        {/* Carrier Info Card */}
        {shipment.carrierName && (
          <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.cardHeader}>
              <Truck size={20} color={colors.text} />
              <Text style={[styles.cardTitle, { color: colors.text }]}>Carrier Information</Text>
            </View>

            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Carrier</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>
                {shipment.carrierName}
              </Text>
            </View>

            {shipment.serviceName && (
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: colors.muted }]}>Service</Text>
                <Text style={[styles.infoValue, { color: colors.text }]}>
                  {shipment.serviceName}
                </Text>
              </View>
            )}

            {shipment.trackingUrl && (
              <TouchableOpacity style={styles.trackButton} onPress={handleTrackOnline}>
                <ExternalLink size={16} color={colors.text} />
                <Text style={[styles.trackButtonText, { color: colors.text }]}>
                  Track on carrier website
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Shipment Details Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <Package size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>Shipment Details</Text>
          </View>

          {shipment.orderNumber && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Order</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>
                {shipment.orderNumber}
              </Text>
            </View>
          )}

          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Shipped Date</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {formatDate(shipment.shipmentDate)}
            </Text>
          </View>

          {shipment.estimatedDeliveryDate && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Est. Delivery</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>
                {formatDate(shipment.estimatedDeliveryDate)}
              </Text>
            </View>
          )}

          {shipment.actualDeliveryDate && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Actual Delivery</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>
                {formatDate(shipment.actualDeliveryDate)}
              </Text>
            </View>
          )}

          {shipment.shippingCost && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Shipping Cost</Text>
              <Text style={[styles.infoValue, styles.costValue, { color: colors.text }]}>
                {formatMoney(shipment.shippingCost.amount, shipment.shippingCost.currency)}
              </Text>
            </View>
          )}
        </View>

        {/* Shipping Address Card */}
        {shipment.shippingAddress && (
          <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.cardHeader}>
              <MapPin size={20} color={colors.text} />
              <Text style={[styles.cardTitle, { color: colors.text }]}>Shipping Address</Text>
            </View>

            <Text style={[styles.addressText, { color: colors.text }]}>
              {formatAddress(shipment.shippingAddress)}
            </Text>
          </View>
        )}

        {/* Package Details Card */}
        {(shipment.weight || shipment.dimensions) && (
          <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.cardHeader}>
              <Box size={20} color={colors.text} />
              <Text style={[styles.cardTitle, { color: colors.text }]}>Package Details</Text>
            </View>

            {shipment.weight && (
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: colors.muted }]}>Weight</Text>
                <Text style={[styles.infoValue, { color: colors.text }]}>
                  {shipment.weight.value} {shipment.weight.unit}
                </Text>
              </View>
            )}

            {shipment.dimensions && (
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: colors.muted }]}>Dimensions</Text>
                <Text style={[styles.infoValue, { color: colors.text }]}>
                  {shipment.dimensions.length} × {shipment.dimensions.width} × {shipment.dimensions.height} {shipment.dimensions.unit}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Tracking Events */}
        {trackingEvents.length > 0 && (
          <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.cardHeader}>
              <Clock size={20} color={colors.text} />
              <Text style={[styles.cardTitle, { color: colors.text }]}>Tracking History</Text>
            </View>

            {loadingTracking ? (
              <View style={styles.trackingLoading}>
                <ActivityIndicator size="small" color={colors.muted} />
              </View>
            ) : (
              <View style={styles.trackingTimeline}>
                {trackingEvents.map((event, index) => (
                  <View key={index} style={styles.trackingEvent}>
                    <View style={styles.timelineIconContainer}>
                      <View style={[styles.timelineDot, { backgroundColor: statusColor }]} />
                      {index !== trackingEvents.length - 1 && (
                        <View style={[styles.timelineLine, { backgroundColor: colors.divider }]} />
                      )}
                    </View>
                    <View style={styles.eventContent}>
                      <Text style={[styles.eventDescription, { color: colors.text }]}>
                        {event.description}
                      </Text>
                      <Text style={[styles.eventTimestamp, { color: colors.muted }]}>
                        {formatDate(event.timestamp)}
                      </Text>
                      {event.location && (
                        <Text style={[styles.eventLocation, { color: colors.muted }]}>
                          {event.location}
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Scan Package */}
        {hasPermission && (shipment.status === 'pending' || shipment.status === 'labeled') && (
          <TouchableOpacity
            style={[styles.scanPackageButton, { backgroundColor: colors.divider, borderColor: colors.border }]}
            onPress={() => setScannerVisible(true)}
          >
            <ScanBarcode size={20} color={colors.text} />
            <Text style={[styles.scanPackageText, { color: colors.text }]}>
              {scannedCode ? `Scanned: ${scannedCode}` : 'Scan Package Barcode'}
            </Text>
          </TouchableOpacity>
        )}

        {/* Actions */}
        {shipment.status === 'pending' && (
          <View style={styles.actionsCard}>
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: colors.text }]}
              onPress={handleGenerateLabel}
              disabled={updating}
            >
              {updating ? (
                <ActivityIndicator size="small" color={colors.background} />
              ) : (
                <Text style={[styles.actionButtonText, { color: colors.background }]}>
                  Generate Shipping Label
                </Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        {shipment.status === 'labeled' && (
          <View style={styles.actionsCard}>
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: '#10B981' }]}
              onPress={handleMarkAsShipped}
              disabled={updating}
            >
              {updating ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <>
                  <Send size={18} color="#FFFFFF" style={{ marginRight: 8 }} />
                  <Text style={[styles.actionButtonText, { color: '#FFFFFF' }]}>
                    Mark as Shipped
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Barcode Scanner Modal */}
      <Modal
        animationType="slide"
        transparent={false}
        visible={scannerVisible}
        onRequestClose={() => setScannerVisible(false)}
      >
        <View style={styles.scannerContainer}>
          {hasPermission === null ? (
            <Text style={{ color: '#FFFFFF' }}>Requesting camera permission...</Text>
          ) : hasPermission === false ? (
            <Text style={{ color: '#FFFFFF' }}>No camera permission</Text>
          ) : (
            <>
              <CameraView
                style={StyleSheet.absoluteFillObject}
                facing="back"
                barcodeScannerSettings={{
                  barcodeTypes: ['qr', 'ean13', 'ean8', 'code128', 'code39', 'upc_a', 'upc_e'],
                }}
                onBarcodeScanned={handleBarCodeScanned}
              />
              <View style={styles.scannerOverlay}>
                <View style={styles.scannerTopBar}>
                  <TouchableOpacity
                    style={styles.scannerCloseButton}
                    onPress={() => setScannerVisible(false)}
                  >
                    <Text style={styles.scannerCloseText}>Close</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.scannerFrame}>
                  <View style={styles.scannerFrameCorner} />
                </View>
                <Text style={styles.scannerInstruction}>
                  Align package barcode within the frame
                </Text>
              </View>
            </>
          )}
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
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  emptyText: {
    fontSize: 16,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 60,
    paddingBottom: 16,
    borderBottomWidth: 0.5,
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
    marginBottom: 12,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  trackingNumber: {
    fontSize: 24,
    fontWeight: '700',
    flex: 1,
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    marginLeft: 12,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
  },
  card: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  infoLabel: {
    fontSize: 14,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'right',
    flex: 1,
    marginLeft: 16,
  },
  costValue: {
    fontSize: 16,
    fontWeight: '700',
  },
  trackButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
    marginTop: 8,
    justifyContent: 'center',
  },
  trackButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  addressText: {
    fontSize: 14,
    lineHeight: 20,
  },
  trackingLoading: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  trackingTimeline: {
    gap: 0,
  },
  trackingEvent: {
    flexDirection: 'row',
    gap: 12,
  },
  timelineIconContainer: {
    alignItems: 'center',
    width: 20,
  },
  timelineDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginTop: 4,
  },
  timelineLine: {
    width: 2,
    flex: 1,
    marginTop: 4,
    marginBottom: 4,
  },
  eventContent: {
    flex: 1,
    paddingBottom: 20,
  },
  eventDescription: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 4,
  },
  eventTimestamp: {
    fontSize: 12,
    marginBottom: 2,
  },
  eventLocation: {
    fontSize: 12,
  },
  actionsCard: {
    marginBottom: 32,
  },
  actionButton: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
  },
  actionButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  scanPackageButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 16,
  },
  scanPackageText: {
    fontSize: 15,
    fontWeight: '500',
  },
  scannerContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  scannerOverlay: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  scannerTopBar: {
    width: '100%',
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 20,
  },
  scannerCloseButton: {
    alignSelf: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 8,
  },
  scannerCloseText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  scannerFrame: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    borderRadius: 12,
    position: 'relative',
  },
  scannerFrameCorner: {
    position: 'absolute',
    top: -2,
    left: -2,
    width: 40,
    height: 40,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderColor: '#10B981',
    borderTopLeftRadius: 12,
  },
  scannerInstruction: {
    color: '#FFFFFF',
    fontSize: 16,
    marginBottom: 100,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
});
