import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  View,
  Text,
  RefreshControl,
  TextInput,
  Modal,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';
import type { CycleCountDto, CycleCountItemDto } from '@/types/wms';
import {
  getCycleCountStatusColor,
  formatDate,
  calculatePickingProgress,
} from '@/utils/wms-helpers';
import {
  ChevronLeft,
  Clipboard,
  User,
  Package,
  CheckCircle2,
  AlertTriangle,
  MapPin,
  ScanBarcode,
} from 'lucide-react-native';
import { Camera, CameraView, BarcodeScanningResult } from 'expo-camera';

export default function CycleCountDetailScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const toast = useToast();

  const [cycleCount, setCycleCount] = useState<CycleCountDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [countModalVisible, setCountModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState<CycleCountItemDto | null>(null);
  const [countedQuantity, setCountedQuantity] = useState('');
  const [scannerVisible, setScannerVisible] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scannedCode, setScannedCode] = useState('');

  useEffect(() => {
    if (id) {
      loadCycleCount();
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  const loadCycleCount = async () => {
    try {
      setLoading(true);
      const response = await api.getCycleCount(id);

      if (response.success && response.data) {
        setCycleCount(response.data);
      } else {
        throw new Error(response.error || 'Failed to load cycle count');
      }
    } catch (error) {
      console.error('Error loading cycle count:', error);
      toast.error('Failed to load cycle count details');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadCycleCount();
  };

  const handleStartCounting = async () => {
    if (!cycleCount) return;

    try {
      setUpdating(true);
      const response = await api.startCycleCount(cycleCount.id);

      if (response.success) {
        toast.success('Cycle count started');
        await loadCycleCount();
      } else {
        throw new Error(response.error || 'Failed to start cycle count');
      }
    } catch (error) {
      console.error('Error starting cycle count:', error);
      toast.error('Failed to start cycle count');
    } finally {
      setUpdating(false);
    }
  };

  const handleCountItem = (item: CycleCountItemDto) => {
    setSelectedItem(item);
    setCountedQuantity(item.countedQuantity?.toString() || item.expectedQuantity.toString());
    setScannedCode('');
    setCountModalVisible(true);
  };

  const handleBarCodeScanned = (result: BarcodeScanningResult) => {
    const data = result.data;
    setScannedCode(data);
    setScannerVisible(false);

    // Verify scanned code matches product SKU or barcode
    if (selectedItem && (data === selectedItem.productSku || data === selectedItem.productSku)) {
      toast.success('Product verified!');
    } else {
      toast.error('Scanned code does not match expected product');
    }
  };

  const confirmCountItem = async () => {
    if (!cycleCount || !selectedItem || !countedQuantity) {
      toast.error('Please enter a quantity');
      return;
    }

    const quantity = parseInt(countedQuantity);
    if (isNaN(quantity) || quantity < 0) {
      toast.error('Please enter a valid quantity');
      return;
    }

    try {
      setUpdating(true);
      const response = await api.countCycleCountItem(cycleCount.id, selectedItem.id, {
        countedQuantity: quantity,
      });

      if (response.success) {
        setCountModalVisible(false);
        setSelectedItem(null);
        await loadCycleCount();
      } else {
        throw new Error(response.error || 'Failed to count item');
      }
    } catch (error) {
      console.error('Error counting item:', error);
      toast.error('Failed to count item');
    } finally {
      setUpdating(false);
    }
  };

  const handleCompleteCycleCount = async () => {
    if (!cycleCount) return;

    const uncounted = cycleCount.items.filter((item) => item.countedQuantity === null);

    if (uncounted.length > 0) {
      toast.error(`There are ${uncounted.length} items not counted. Please count all items before completing.`);
      return;
    }

    await completeCycleCount();
  };

  const completeCycleCount = async () => {
    if (!cycleCount) return;

    try {
      setUpdating(true);
      const response = await api.completeCycleCount(cycleCount.id, { applyAdjustments: true });

      if (response.success) {
        toast.success('Cycle count completed');
        router.back();
      } else {
        throw new Error(response.error || 'Failed to complete cycle count');
      }
    } catch (error) {
      console.error('Error completing cycle count:', error);
      toast.error('Failed to complete cycle count');
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading cycle count...</Text>
      </View>
    );
  }

  if (!cycleCount) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.muted }]}>Cycle count not found</Text>
      </View>
    );
  }

  const statusColor = getCycleCountStatusColor(cycleCount.status);
  const progress = calculatePickingProgress(
    cycleCount.items.filter((i) => i.countedQuantity !== null).length,
    cycleCount.items.length
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <Text style={[styles.countNumber, { color: colors.text }]}>{cycleCount.countNumber}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>
              {cycleCount.status.replace(/_/g, ' ')}
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
        {/* Progress Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.progressSection}>
            <View style={styles.progressHeader}>
              <Text style={[styles.progressTitle, { color: colors.text }]}>Counting Progress</Text>
              <Text style={[styles.progressPercentage, { color: colors.text }]}>
                {progress.percentage}%
              </Text>
            </View>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${progress.percentage}%`, backgroundColor: statusColor },
                ]}
              />
            </View>
            <Text style={[styles.progressText, { color: colors.muted }]}>
              {progress.completed} of {progress.total} items counted
            </Text>
          </View>
        </View>

        {/* Cycle Count Info Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <Clipboard size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>Cycle Count Details</Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Created</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {formatDate(cycleCount.createdAt)}
            </Text>
          </View>

          {cycleCount.scheduledDate && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Scheduled</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>
                {formatDate(cycleCount.scheduledDate)}
              </Text>
            </View>
          )}

          {cycleCount.assignedToName && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Assigned To</Text>
              <View style={styles.assignedTo}>
                <User size={14} color={colors.text} />
                <Text style={[styles.infoValue, { color: colors.text }]}>
                  {cycleCount.assignedToName}
                </Text>
              </View>
            </View>
          )}

          {cycleCount.notes && (
            <View style={[styles.notesSection, { borderTopColor: colors.divider }]}>
              <Text style={[styles.notesLabel, { color: colors.muted }]}>Notes</Text>
              <Text style={[styles.notesText, { color: colors.text }]}>{cycleCount.notes}</Text>
            </View>
          )}
        </View>

        {/* Count Items Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <Package size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              Items ({cycleCount.items.length})
            </Text>
          </View>

          {cycleCount.items.map((item, index) => {
            const isCounted = item.countedQuantity !== null;
            const hasVariance =
              isCounted && item.countedQuantity !== item.expectedQuantity;

            return (
              <View
                key={item.id}
                style={[
                  styles.countItem,
                  index !== cycleCount.items.length - 1 && {
                    borderBottomWidth: 0.5,
                    borderBottomColor: colors.divider,
                  },
                ]}
              >
                <View style={styles.countItemLeft}>
                  <View style={styles.countItemHeader}>
                    <Text style={[styles.countItemName, { color: colors.text }]}>
                      {item.productName}
                    </Text>
                    {isCounted ? (
                      hasVariance ? (
                        <AlertTriangle size={20} color="#F59E0B" />
                      ) : (
                        <CheckCircle2 size={20} color="#10B981" />
                      )
                    ) : null}
                  </View>
                  <Text style={[styles.countItemSku, { color: colors.muted }]}>
                    SKU: {item.productSku}
                  </Text>
                  {item.locationName && (
                    <View style={styles.countItemLocation}>
                      <MapPin size={12} color={colors.muted} />
                      <Text style={[styles.locationText, { color: colors.muted }]}>
                        {item.locationName}
                      </Text>
                    </View>
                  )}
                  <View style={styles.countItemQuantities}>
                    <Text style={[styles.quantityText, { color: colors.muted }]}>
                      Expected: {item.expectedQuantity}
                    </Text>
                    {isCounted && (
                      <Text
                        style={[
                          styles.quantityText,
                          {
                            color: hasVariance ? '#F59E0B' : '#10B981',
                            fontWeight: '600',
                          },
                        ]}
                      >
                        Counted: {item.countedQuantity}
                        {hasVariance &&
                          ` (${item.countedQuantity! > item.expectedQuantity ? '+' : ''}${
                            item.countedQuantity! - item.expectedQuantity
                          })`}
                      </Text>
                    )}
                  </View>
                </View>

                {cycleCount.status === 'in_progress' && (
                  <TouchableOpacity
                    style={[styles.countButton, { backgroundColor: colors.text }]}
                    onPress={() => handleCountItem(item)}
                  >
                    <Text style={[styles.countButtonText, { color: colors.background }]}>
                      {isCounted ? 'Recount' : 'Count'}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>

        {/* Action Buttons */}
        {cycleCount.status === 'planned' && (
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.text }]}
            onPress={handleStartCounting}
            disabled={updating}
          >
            {updating ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={[styles.actionButtonText, { color: colors.background }]}>
                Start Counting
              </Text>
            )}
          </TouchableOpacity>
        )}

        {cycleCount.status === 'in_progress' && (
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: '#10B981' }]}
            onPress={handleCompleteCycleCount}
            disabled={updating}
          >
            {updating ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={[styles.actionButtonText, { color: '#FFFFFF' }]}>
                Complete Cycle Count
              </Text>
            )}
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Count Item Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={countModalVisible}
        onRequestClose={() => setCountModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Count Item</Text>
            {selectedItem && (
              <>
                <Text style={[styles.modalSubtitle, { color: colors.text }]}>
                  {selectedItem.productName}
                </Text>
                <Text style={[styles.modalSubtitle, { color: colors.muted }]}>
                  SKU: {selectedItem.productSku}
                </Text>
                <Text style={[styles.modalSubtitle, { color: colors.muted }]}>
                  Expected: {selectedItem.expectedQuantity} units
                </Text>
              </>
            )}

            {/* Scan Button */}
            {hasPermission && (
              <TouchableOpacity
                style={[styles.scanButton, { backgroundColor: colors.divider }]}
                onPress={() => setScannerVisible(true)}
              >
                <ScanBarcode size={20} color={colors.text} />
                <Text style={[styles.scanButtonText, { color: colors.text }]}>
                  {scannedCode ? 'Scanned: ' + scannedCode : 'Scan Barcode to Verify'}
                </Text>
              </TouchableOpacity>
            )}

            <View style={styles.inputContainer}>
              <Text style={[styles.inputLabel, { color: colors.text }]}>Counted Quantity</Text>
              {selectedItem && (
                <Text style={[styles.inputHint, { color: colors.muted }]}>
                  Expected: {selectedItem.expectedQuantity} units
                </Text>
              )}

              <View style={styles.quantityPicker}>
                <TouchableOpacity
                  style={[styles.quantityButton, { borderColor: colors.divider }]}
                  onPress={() => {
                    const currentQty = parseInt(countedQuantity) || 0;
                    if (currentQty > 0) {
                      setCountedQuantity((currentQty - 1).toString());
                    }
                  }}
                >
                  <Text style={[styles.quantityButtonText, { color: colors.text }]}>-</Text>
                </TouchableOpacity>

                <TextInput
                  style={[styles.quantityInput, { borderColor: colors.divider, color: colors.text }]}
                  placeholder="Enter quantity"
                  placeholderTextColor={colors.muted}
                  value={countedQuantity}
                  onChangeText={setCountedQuantity}
                  keyboardType="numeric"
                  selectTextOnFocus
                />

                <TouchableOpacity
                  style={[styles.quantityButton, { borderColor: colors.divider }]}
                  onPress={() => {
                    const currentQty = parseInt(countedQuantity) || 0;
                    setCountedQuantity((currentQty + 1).toString());
                  }}
                >
                  <Text style={[styles.quantityButtonText, { color: colors.text }]}>+</Text>
                </TouchableOpacity>
              </View>

              {selectedItem && (
                <TouchableOpacity
                  style={[styles.matchExpectedButton, { backgroundColor: colors.divider }]}
                  onPress={() => setCountedQuantity(selectedItem.expectedQuantity.toString())}
                >
                  <Text style={[styles.matchExpectedText, { color: colors.text }]}>
                    Match Expected ({selectedItem.expectedQuantity})
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalCancelButton, { borderColor: colors.divider }]}
                onPress={() => setCountModalVisible(false)}
                disabled={updating}
              >
                <Text style={[styles.modalCancelText, { color: colors.muted }]}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modalConfirmButton, { backgroundColor: colors.text }]}
                onPress={confirmCountItem}
                disabled={updating}
              >
                {updating ? (
                  <ActivityIndicator size="small" color={colors.background} />
                ) : (
                  <Text style={[styles.modalConfirmText, { color: colors.background }]}>Confirm</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

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
                  Align barcode within the frame
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
  countNumber: {
    fontSize: 24,
    fontWeight: '700',
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
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
  progressSection: {
    gap: 8,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  progressTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  progressPercentage: {
    fontSize: 20,
    fontWeight: '700',
  },
  progressBar: {
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
  progressText: {
    fontSize: 13,
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
  assignedTo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    justifyContent: 'flex-end',
  },
  notesSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 0.5,
  },
  notesLabel: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 6,
  },
  notesText: {
    fontSize: 14,
    lineHeight: 20,
  },
  countItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
  },
  countItemLeft: {
    flex: 1,
    gap: 6,
  },
  countItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  countItemName: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  countItemSku: {
    fontSize: 13,
  },
  countItemLocation: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  locationText: {
    fontSize: 12,
  },
  countItemQuantities: {
    gap: 4,
    marginTop: 4,
  },
  quantityText: {
    fontSize: 13,
  },
  countButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    marginLeft: 12,
  },
  countButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  actionButton: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
    alignItems: 'center',
    marginBottom: 32,
  },
  actionButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  modalSubtitle: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 8,
  },
  inputContainer: {
    marginTop: 20,
    marginBottom: 8,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  inputHint: {
    fontSize: 12,
    marginTop: 4,
    marginBottom: 12,
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  quantityPicker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  quantityButton: {
    width: 48,
    height: 48,
    borderWidth: 1,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quantityButtonText: {
    fontSize: 24,
    fontWeight: '600',
  },
  quantityInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  matchExpectedButton: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  matchExpectedText: {
    fontSize: 14,
    fontWeight: '600',
  },
  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  scanButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 20,
  },
  modalCancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  modalCancelText: {
    fontSize: 14,
    fontWeight: '500',
  },
  modalConfirmButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalConfirmText: {
    fontSize: 14,
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
