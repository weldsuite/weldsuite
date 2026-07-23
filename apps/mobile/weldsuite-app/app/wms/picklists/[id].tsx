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
import { useClerkAuth } from '@/contexts/ClerkAuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';
import type { PickListDto, PickListItemDto } from '@/types/wms';
import {
  getPickListStatusColor,
  getPriorityColor,
  formatDate,
  calculatePickingProgress,
} from '@/utils/wms-helpers';
import {
  ChevronLeft,
  ClipboardList,
  User,
  Package,
  MapPin,
  CheckCircle2,
  Clock,
  ScanBarcode,
} from 'lucide-react-native';
import { Camera, CameraView, BarcodeScanningResult } from 'expo-camera';

export default function PickListDetailScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const toast = useToast();
  const { user } = useClerkAuth();

  const [pickList, setPickList] = useState<PickListDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [pickModalVisible, setPickModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState<PickListItemDto | null>(null);
  const [pickQuantity, setPickQuantity] = useState('');
  const [scannerVisible, setScannerVisible] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scannedCode, setScannedCode] = useState('');

  useEffect(() => {
    if (id) {
      loadPickList();
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      const { status } = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  const loadPickList = async () => {
    try {
      setLoading(true);
      const response = await api.getPickList(id);

      if (response.success && response.data) {
        setPickList(response.data);
      } else {
        throw new Error(response.error || 'Failed to load pick list');
      }
    } catch (error) {
      console.error('Error loading pick list:', error);
      toast.error('Failed to load pick list details');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadPickList();
  };

  const handleAssignToMe = async () => {
    if (!pickList || !user?.id) return;

    try {
      setUpdating(true);
      const response = await api.assignPickList(pickList.id, user.id);

      if (response.success) {
        toast.success('Pick list assigned to you');
        await loadPickList();
      } else {
        throw new Error(response.error || 'Failed to assign pick list');
      }
    } catch (error) {
      console.error('Error assigning pick list:', error);
      toast.error('Failed to assign pick list');
    } finally {
      setUpdating(false);
    }
  };

  const handleStartPicking = async () => {
    if (!pickList) return;

    try {
      setUpdating(true);
      const response = await api.startPickList(pickList.id);

      if (response.success) {
        toast.success('Pick list started');
        await loadPickList();
      } else {
        throw new Error(response.error || 'Failed to start pick list');
      }
    } catch (error) {
      console.error('Error starting pick list:', error);
      toast.error('Failed to start pick list');
    } finally {
      setUpdating(false);
    }
  };

  const handlePickItem = (item: PickListItemDto) => {
    setSelectedItem(item);
    const remaining = item.requestedQuantity - item.pickedQuantity;
    setPickQuantity(remaining.toString());
    setPickModalVisible(true);
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

  const confirmPickItem = async () => {
    if (!pickList || !selectedItem || !pickQuantity) {
      toast.error('Please enter a quantity');
      return;
    }

    const quantity = parseInt(pickQuantity);
    if (isNaN(quantity) || quantity <= 0 || quantity > selectedItem.requestedQuantity - selectedItem.pickedQuantity) {
      toast.error('Please enter a valid quantity');
      return;
    }

    try {
      setUpdating(true);
      const response = await api.pickItem(pickList.id, selectedItem.id, {
        quantity,
        locationCode: selectedItem.location || undefined,
      });

      if (response.success) {
        setPickModalVisible(false);
        setSelectedItem(null);

        // Reload pick list to get updated data
        const updatedPickListResponse = await api.getPickList(pickList.id);
        if (updatedPickListResponse.success && updatedPickListResponse.data) {
          const updatedPickList = updatedPickListResponse.data;
          setPickList(updatedPickList);

          // Check if all items are now fully picked
          const allItemsPicked = updatedPickList.items.every(
            (item) => item.pickedQuantity >= item.requestedQuantity
          );

          if (allItemsPicked) {
            // Auto-complete the pick list
            const completeResponse = await api.completePickList(pickList.id);
            if (completeResponse.success) {
              toast.success('All items picked! Pick list completed.');
              router.back();
            }
          }
        }
      } else {
        throw new Error(response.error || 'Failed to pick item');
      }
    } catch (error) {
      console.error('Error picking item:', error);
      toast.error('Failed to pick item');
    } finally {
      setUpdating(false);
    }
  };

  const handleCompletePicking = async () => {
    if (!pickList) return;

    const unpickedItems = pickList.items.filter((item) => item.pickedQuantity < item.requestedQuantity);

    if (unpickedItems.length > 0) {
      toast.error(`There are ${unpickedItems.length} items not fully picked`);
      return;
    }

    await completePickList();
  };

  const completePickList = async () => {
    if (!pickList) return;

    try {
      setUpdating(true);
      const response = await api.completePickList(pickList.id);

      if (response.success) {
        toast.success('Pick list completed');
        router.back();
      } else {
        throw new Error(response.error || 'Failed to complete pick list');
      }
    } catch (error) {
      console.error('Error completing pick list:', error);
      toast.error('Failed to complete pick list');
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading pick list...</Text>
      </View>
    );
  }

  if (!pickList) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.muted }]}>Pick list not found</Text>
      </View>
    );
  }

  const statusColor = getPickListStatusColor(pickList.status);
  const priorityColor = getPriorityColor(pickList.priority);
  const progress = calculatePickingProgress(
    pickList.items.filter((i) => i.pickedQuantity > 0).length,
    pickList.items.length
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <Text style={[styles.pickListNumber, { color: colors.text }]}>{pickList.pickListNumber}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>
              {pickList.status.replace(/_/g, ' ')}
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
              <Text style={[styles.progressTitle, { color: colors.text }]}>Picking Progress</Text>
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
              {progress.completed} of {progress.total} items picked
            </Text>
          </View>
        </View>

        {/* Pick List Info Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <ClipboardList size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>Pick List Details</Text>
          </View>

          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Created</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {formatDate(pickList.createdAt)}
            </Text>
          </View>

          {pickList.dueDate && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Due Date</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>
                {formatDate(pickList.dueDate)}
              </Text>
            </View>
          )}

          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Priority</Text>
            <View style={[styles.priorityBadge, { backgroundColor: priorityColor + '20' }]}>
              <Text style={[styles.priorityText, { color: priorityColor }]}>
                {pickList.priority}
              </Text>
            </View>
          </View>

          {pickList.pickerName && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Assigned To</Text>
              <View style={styles.assignedTo}>
                <User size={14} color={colors.text} />
                <Text style={[styles.infoValue, { color: colors.text }]}>
                  {pickList.pickerName}
                </Text>
              </View>
            </View>
          )}
        </View>

        {/* Pick List Items */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <Package size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              Items ({pickList.items.length})
            </Text>
          </View>

          {pickList.items.map((item, index) => {
            const isPicked = item.pickedQuantity >= item.requestedQuantity;
            const isPartiallyPicked = item.pickedQuantity > 0 && item.pickedQuantity < item.requestedQuantity;

            return (
              <View
                key={item.id}
                style={[
                  styles.pickItem,
                  index !== pickList.items.length - 1 && {
                    borderBottomWidth: 0.5,
                    borderBottomColor: colors.divider,
                  },
                ]}
              >
                <View style={styles.pickItemLeft}>
                  <View style={styles.pickItemHeader}>
                    <Text style={[styles.pickItemName, { color: colors.text }]}>
                      {item.productName}
                    </Text>
                    {isPicked ? (
                      <CheckCircle2 size={20} color="#10B981" />
                    ) : isPartiallyPicked ? (
                      <Clock size={20} color="#F59E0B" />
                    ) : null}
                  </View>
                  <Text style={[styles.pickItemSku, { color: colors.muted }]}>
                    SKU: {item.productSku}
                  </Text>
                  {item.location && (
                    <View style={styles.pickItemLocation}>
                      <MapPin size={12} color={colors.muted} />
                      <Text style={[styles.locationText, { color: colors.muted }]}>
                        {item.location}
                      </Text>
                    </View>
                  )}
                  <View style={styles.pickItemQuantities}>
                    <Text
                      style={[
                        styles.quantityText,
                        { color: isPicked ? '#10B981' : colors.text },
                      ]}
                    >
                      {item.pickedQuantity} / {item.requestedQuantity} picked
                    </Text>
                  </View>
                </View>

                {!isPicked && pickList.status === 'in_progress' && (
                  <TouchableOpacity
                    style={[styles.pickButton, { backgroundColor: colors.text }]}
                    onPress={() => handlePickItem(item)}
                  >
                    <Text style={[styles.pickButtonText, { color: colors.background }]}>
                      Pick
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>

        {/* Action Buttons */}
        {(pickList.status === 'pending' || pickList.status === 'unassigned') && (
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.tint }]}
            onPress={handleAssignToMe}
            disabled={updating}
          >
            {updating ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={[styles.actionButtonText, { color: '#FFFFFF' }]}>
                Assign to Me
              </Text>
            )}
          </TouchableOpacity>
        )}

        {pickList.status === 'assigned' && (
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: colors.text }]}
            onPress={handleStartPicking}
            disabled={updating}
          >
            {updating ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={[styles.actionButtonText, { color: colors.background }]}>
                Start Picking
              </Text>
            )}
          </TouchableOpacity>
        )}

        {pickList.status === 'in_progress' && (
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: '#10B981' }]}
            onPress={handleCompletePicking}
            disabled={updating}
          >
            {updating ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={[styles.actionButtonText, { color: '#FFFFFF' }]}>
                Complete Pick List
              </Text>
            )}
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Pick Item Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={pickModalVisible}
        onRequestClose={() => setPickModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Pick Item</Text>
            {selectedItem && (
              <>
                <Text style={[styles.modalSubtitle, { color: colors.text }]}>
                  {selectedItem.productName}
                </Text>
                <Text style={[styles.modalSubtitle, { color: colors.muted }]}>
                  SKU: {selectedItem.productSku}
                </Text>
                <Text style={[styles.modalSubtitle, { color: colors.muted }]}>
                  Location: {selectedItem.location || 'Not assigned'}
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
              <Text style={[styles.inputLabel, { color: colors.text }]}>Quantity to Pick</Text>
              {selectedItem && (
                <Text style={[styles.inputHint, { color: colors.muted }]}>
                  Remaining: {selectedItem.requestedQuantity - selectedItem.pickedQuantity} units
                </Text>
              )}

              <View style={styles.quantityPicker}>
                <TouchableOpacity
                  style={[styles.quantityButton, { borderColor: colors.divider }]}
                  onPress={() => {
                    const currentQty = parseInt(pickQuantity) || 0;
                    if (currentQty > 1) {
                      setPickQuantity((currentQty - 1).toString());
                    }
                  }}
                >
                  <Text style={[styles.quantityButtonText, { color: colors.text }]}>-</Text>
                </TouchableOpacity>

                <TextInput
                  style={[styles.quantityInput, { borderColor: colors.divider, color: colors.text }]}
                  value={pickQuantity}
                  onChangeText={setPickQuantity}
                  keyboardType="numeric"
                  selectTextOnFocus
                />

                <TouchableOpacity
                  style={[styles.quantityButton, { borderColor: colors.divider }]}
                  onPress={() => {
                    const currentQty = parseInt(pickQuantity) || 0;
                    const remaining = selectedItem ? selectedItem.requestedQuantity - selectedItem.pickedQuantity : 0;
                    if (currentQty < remaining) {
                      setPickQuantity((currentQty + 1).toString());
                    }
                  }}
                >
                  <Text style={[styles.quantityButtonText, { color: colors.text }]}>+</Text>
                </TouchableOpacity>
              </View>

              {selectedItem && (selectedItem.requestedQuantity - selectedItem.pickedQuantity) > 1 && (
                <TouchableOpacity
                  style={[styles.pickAllButton, { backgroundColor: colors.divider }]}
                  onPress={() => {
                    const remaining = selectedItem.requestedQuantity - selectedItem.pickedQuantity;
                    setPickQuantity(remaining.toString());
                  }}
                >
                  <Text style={[styles.pickAllText, { color: colors.text }]}>
                    Pick All ({selectedItem.requestedQuantity - selectedItem.pickedQuantity})
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalCancelButton, { borderColor: colors.divider }]}
                onPress={() => setPickModalVisible(false)}
                disabled={updating}
              >
                <Text style={[styles.modalCancelText, { color: colors.muted }]}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modalConfirmButton, { backgroundColor: colors.text }]}
                onPress={confirmPickItem}
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
  pickListNumber: {
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
  },
  assignedTo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  priorityBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  priorityText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  pickItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
  },
  pickItemLeft: {
    flex: 1,
    gap: 6,
  },
  pickItemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pickItemName: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  pickItemSku: {
    fontSize: 13,
  },
  pickItemLocation: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  locationText: {
    fontSize: 12,
  },
  pickItemQuantities: {
    marginTop: 4,
  },
  quantityText: {
    fontSize: 13,
    fontWeight: '600',
  },
  pickButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    marginLeft: 12,
  },
  pickButtonText: {
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
  pickAllButton: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  pickAllText: {
    fontSize: 14,
    fontWeight: '600',
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
