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
import type { PurchaseOrderDto, PurchaseOrderItemDto } from '@/types/wms';
import {
  getPurchaseOrderStatusColor,
  formatDate,
  formatMoney,
} from '@/utils/wms-helpers';
import {
  ChevronLeft,
  FileText,
  User,
  Package,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  MapPin,
  ScanBarcode,
} from 'lucide-react-native';
import { Camera, CameraView, BarcodeScanningResult } from 'expo-camera';

export default function PurchaseOrderDetailScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const toast = useToast();

  const [purchaseOrder, setPurchaseOrder] = useState<PurchaseOrderDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [receiveModalVisible, setReceiveModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState<PurchaseOrderItemDto | null>(null);
  const [receiveQuantity, setReceiveQuantity] = useState('');
  const [location, setLocation] = useState('');
  const [scannerVisible, setScannerVisible] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scannedCode, setScannedCode] = useState('');

  useEffect(() => {
    if (id) {
      loadPurchaseOrder();
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  const loadPurchaseOrder = async () => {
    try {
      setLoading(true);
      const response = await api.getPurchaseOrder(id);

      if (response.success && response.data) {
        setPurchaseOrder(response.data);
      } else {
        throw new Error(response.error || 'Failed to load purchase order');
      }
    } catch (error) {
      console.error('Error loading purchase order:', error);
      toast.error('Failed to load purchase order details');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadPurchaseOrder();
  };

  const handleApprovePO = async () => {
    if (!purchaseOrder) return;

    try {
      setUpdating(true);
      const response = await api.approvePurchaseOrder(purchaseOrder.id);

      if (response.success) {
        toast.success('Purchase order approved');
        await loadPurchaseOrder();
      } else {
        throw new Error(response.error || 'Failed to approve PO');
      }
    } catch (error) {
      console.error('Error approving PO:', error);
      toast.error('Failed to approve purchase order');
    } finally {
      setUpdating(false);
    }
  };

  const handleReceiveItem = (item: PurchaseOrderItemDto) => {
    setSelectedItem(item);
    const remainingQty = item.quantity - item.receivedQuantity;
    setReceiveQuantity(remainingQty.toString());
    setLocation('');
    setScannedCode('');
    setReceiveModalVisible(true);
  };

  const handleBarCodeScanned = (result: BarcodeScanningResult) => {
    const data = result.data;
    setScannedCode(data);
    setScannerVisible(false);

    // Verify scanned code matches product SKU or barcode
    if (selectedItem && (data === selectedItem.productSku || data === selectedItem.productSku)) {
      toast.success('Product verified!');
    } else {
      toast.error('Scanned code does not match expected product. Continue anyway?');
    }
  };

  const confirmReceiveItem = async () => {
    if (!purchaseOrder || !selectedItem || !receiveQuantity) {
      toast.error('Please enter a quantity');
      return;
    }

    const quantity = parseInt(receiveQuantity);
    const remainingQty = selectedItem.quantity - selectedItem.receivedQuantity;

    if (isNaN(quantity) || quantity <= 0 || quantity > remainingQty) {
      toast.error('Please enter a valid quantity');
      return;
    }

    try {
      setUpdating(true);
      const response = await api.receivePurchaseOrder(purchaseOrder.id, {
        items: [
          {
            purchaseOrderItemId: selectedItem.id,
            receivedQuantity: quantity,
            locationId: location || undefined,
          },
        ],
      });

      if (response.success) {
        setReceiveModalVisible(false);
        setSelectedItem(null);
        await loadPurchaseOrder();
      } else {
        throw new Error(response.error || 'Failed to receive item');
      }
    } catch (error) {
      console.error('Error receiving item:', error);
      toast.error('Failed to receive item');
    } finally {
      setUpdating(false);
    }
  };

  const handleReceiveAll = async () => {
    if (!purchaseOrder) return;

    const unreceived = purchaseOrder.items.filter(
      (item) => item.receivedQuantity < item.quantity
    );

    if (unreceived.length === 0) {
      toast.error('All items have already been received');
      return;
    }

    try {
      setUpdating(true);
      const response = await api.receivePurchaseOrder(purchaseOrder.id, {
        items: unreceived.map((item) => ({
          purchaseOrderItemId: item.id,
          receivedQuantity: item.quantity - item.receivedQuantity,
        })),
      });

      if (response.success) {
        toast.success('All items received');
        await loadPurchaseOrder();
      } else {
        throw new Error(response.error || 'Failed to receive items');
      }
    } catch (error) {
      console.error('Error receiving items:', error);
      toast.error('Failed to receive items');
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading purchase order...</Text>
      </View>
    );
  }

  if (!purchaseOrder) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.muted }]}>Purchase order not found</Text>
      </View>
    );
  }

  const statusColor = getPurchaseOrderStatusColor(purchaseOrder.status);
  const totalReceived = purchaseOrder.items.reduce((sum, item) => sum + item.receivedQuantity, 0);
  const totalOrdered = purchaseOrder.items.reduce((sum, item) => sum + item.quantity, 0);
  const receivingProgress = totalOrdered > 0 ? (totalReceived / totalOrdered) * 100 : 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <Text style={[styles.poNumber, { color: colors.text }]}>{purchaseOrder.poNumber}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>
              {purchaseOrder.status.replace(/_/g, ' ')}
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
        {/* Receiving Progress Card */}
        {purchaseOrder.status !== 'draft' && purchaseOrder.status !== 'cancelled' && (
          <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.progressSection}>
              <View style={styles.progressHeader}>
                <Text style={[styles.progressTitle, { color: colors.text }]}>Receiving Progress</Text>
                <Text style={[styles.progressPercentage, { color: colors.text }]}>
                  {receivingProgress.toFixed(0)}%
                </Text>
              </View>
              <View style={styles.progressBar}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${receivingProgress}%`, backgroundColor: statusColor },
                  ]}
                />
              </View>
              <Text style={[styles.progressText, { color: colors.muted }]}>
                {totalReceived} of {totalOrdered} items received
              </Text>
            </View>
          </View>
        )}

        {/* PO Details Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <FileText size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>Purchase Order Details</Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Supplier</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {purchaseOrder.supplierName}
            </Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Created</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {formatDate(purchaseOrder.createdAt)}
            </Text>
          </View>

          {purchaseOrder.expectedDeliveryDate && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Expected Delivery</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>
                {formatDate(purchaseOrder.expectedDeliveryDate)}
              </Text>
            </View>
          )}

          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Total Amount</Text>
            <Text style={[styles.infoValue, styles.totalAmount, { color: colors.text }]}>
              {formatMoney(purchaseOrder.total.amount, purchaseOrder.total.currency)}
            </Text>
          </View>

          {purchaseOrder.notes && (
            <View style={[styles.notesSection, { borderTopColor: colors.divider }]}>
              <Text style={[styles.notesLabel, { color: colors.muted }]}>Notes</Text>
              <Text style={[styles.notesText, { color: colors.text }]}>{purchaseOrder.notes}</Text>
            </View>
          )}
        </View>

        {/* PO Items Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <Package size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              Items ({purchaseOrder.items.length})
            </Text>
          </View>

          {purchaseOrder.items.map((item, index) => {
            const isFullyReceived = item.receivedQuantity >= item.quantity;
            const isPartiallyReceived = item.receivedQuantity > 0 && item.receivedQuantity < item.quantity;

            return (
              <View
                key={item.id}
                style={[
                  styles.poItem,
                  index !== purchaseOrder.items.length - 1 && {
                    borderBottomWidth: 0.5,
                    borderBottomColor: colors.divider,
                  },
                ]}
              >
                <View style={styles.poItemLeft}>
                  <View style={styles.poItemHeader}>
                    <Text style={[styles.poItemName, { color: colors.text }]}>
                      {item.productName}
                    </Text>
                    {isFullyReceived ? (
                      <CheckCircle2 size={20} color="#10B981" />
                    ) : isPartiallyReceived ? (
                      <AlertTriangle size={20} color="#F59E0B" />
                    ) : null}
                  </View>
                  <Text style={[styles.poItemSku, { color: colors.muted }]}>
                    SKU: {item.productSku}
                  </Text>
                  <View style={styles.poItemQuantities}>
                    <Text style={[styles.quantityText, { color: colors.muted }]}>
                      Ordered: {item.quantity}
                    </Text>
                    <Text
                      style={[
                        styles.quantityText,
                        { color: isFullyReceived ? '#10B981' : colors.text },
                      ]}
                    >
                      Received: {item.receivedQuantity}
                    </Text>
                  </View>
                  <Text style={[styles.itemCost, { color: colors.muted }]}>
                    {formatMoney(item.unitCost.amount, item.unitCost.currency)} per unit
                  </Text>
                </View>

                {!isFullyReceived &&
                  (purchaseOrder.status === 'approved' ||
                   purchaseOrder.status === 'ordered' ||
                   purchaseOrder.status === 'partially_received') && (
                  <TouchableOpacity
                    style={[styles.receiveButton, { backgroundColor: colors.text }]}
                    onPress={() => handleReceiveItem(item)}
                  >
                    <Text style={[styles.receiveButtonText, { color: colors.background }]}>
                      Receive
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>

        {/* Action Buttons */}
        {purchaseOrder.status === 'pending' && (
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.text }]}
            onPress={handleApprovePO}
            disabled={updating}
          >
            {updating ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={[styles.actionButtonText, { color: colors.background }]}>
                Approve Purchase Order
              </Text>
            )}
          </TouchableOpacity>
        )}

        {(purchaseOrder.status === 'approved' ||
          purchaseOrder.status === 'ordered' ||
          purchaseOrder.status === 'partially_received') && (
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: '#10B981' }]}
            onPress={handleReceiveAll}
            disabled={updating}
          >
            {updating ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={[styles.actionButtonText, { color: '#FFFFFF' }]}>
                Receive All Items
              </Text>
            )}
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Receive Item Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={receiveModalVisible}
        onRequestClose={() => setReceiveModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Receive Item</Text>
            {selectedItem && (
              <>
                <Text style={[styles.modalSubtitle, { color: colors.text }]}>
                  {selectedItem.productName}
                </Text>
                <Text style={[styles.modalSubtitle, { color: colors.muted }]}>
                  SKU: {selectedItem.productSku}
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
              <Text style={[styles.inputLabel, { color: colors.text }]}>Quantity to Receive</Text>
              {selectedItem && (
                <Text style={[styles.inputHint, { color: colors.muted }]}>
                  Remaining: {selectedItem.quantity - selectedItem.receivedQuantity} units
                </Text>
              )}

              <View style={styles.quantityPicker}>
                <TouchableOpacity
                  style={[styles.quantityButton, { borderColor: colors.divider }]}
                  onPress={() => {
                    const currentQty = parseInt(receiveQuantity) || 0;
                    if (currentQty > 0) {
                      setReceiveQuantity((currentQty - 1).toString());
                    }
                  }}
                >
                  <Text style={[styles.quantityButtonText, { color: colors.text }]}>-</Text>
                </TouchableOpacity>

                <TextInput
                  style={[styles.quantityInput, { borderColor: colors.divider, color: colors.text }]}
                  placeholder="Enter quantity"
                  placeholderTextColor={colors.muted}
                  value={receiveQuantity}
                  onChangeText={setReceiveQuantity}
                  keyboardType="numeric"
                  selectTextOnFocus
                />

                <TouchableOpacity
                  style={[styles.quantityButton, { borderColor: colors.divider }]}
                  onPress={() => {
                    const currentQty = parseInt(receiveQuantity) || 0;
                    const remaining = selectedItem ? selectedItem.quantity - selectedItem.receivedQuantity : 0;
                    if (currentQty < remaining) {
                      setReceiveQuantity((currentQty + 1).toString());
                    }
                  }}
                >
                  <Text style={[styles.quantityButtonText, { color: colors.text }]}>+</Text>
                </TouchableOpacity>
              </View>

              {selectedItem && (selectedItem.quantity - selectedItem.receivedQuantity) > 1 && (
                <TouchableOpacity
                  style={[styles.receiveAllButton, { backgroundColor: colors.divider }]}
                  onPress={() => {
                    const remaining = selectedItem.quantity - selectedItem.receivedQuantity;
                    setReceiveQuantity(remaining.toString());
                  }}
                >
                  <Text style={[styles.receiveAllText, { color: colors.text }]}>
                    Receive All ({selectedItem.quantity - selectedItem.receivedQuantity})
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.inputContainer}>
              <Text style={[styles.inputLabel, { color: colors.text }]}>Location (Optional)</Text>
              <TextInput
                style={[styles.textInput, { borderColor: colors.divider, color: colors.text }]}
                placeholder="Enter location"
                placeholderTextColor={colors.muted}
                value={location}
                onChangeText={setLocation}
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalCancelButton, { borderColor: colors.divider }]}
                onPress={() => setReceiveModalVisible(false)}
                disabled={updating}
              >
                <Text style={[styles.modalCancelText, { color: colors.muted }]}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modalConfirmButton, { backgroundColor: colors.text }]}
                onPress={confirmReceiveItem}
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
  poNumber: {
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
  totalAmount: {
    fontSize: 18,
    fontWeight: '700',
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
  poItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
  },
  poItemLeft: {
    flex: 1,
    gap: 6,
  },
  poItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  poItemName: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  poItemSku: {
    fontSize: 13,
  },
  poItemQuantities: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 4,
  },
  quantityText: {
    fontSize: 13,
    fontWeight: '500',
  },
  itemCost: {
    fontSize: 12,
    marginTop: 2,
  },
  receiveButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    marginLeft: 12,
  },
  receiveButtonText: {
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
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  inputHint: {
    fontSize: 12,
    marginTop: 4,
    marginBottom: 12,
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
  receiveAllButton: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  receiveAllText: {
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
