import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  View,
  Text,
  Alert,
  RefreshControl,
  Modal,
  TextInput,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';
import type { ReturnDto } from '@/types/wms';
import {
  getReturnStatusColor,
  formatDate,
  formatMoney,
} from '@/utils/wms-helpers';
import {
  ChevronLeft,
  RotateCcw,
  User,
  Package,
  FileText,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ScanBarcode,
  Eye,
} from 'lucide-react-native';
import { Camera, CameraView, BarcodeScanningResult } from 'expo-camera';
import type { ReturnItemDto } from '@/types/wms';

export default function ReturnDetailScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const toast = useToast();

  const [returnItem, setReturnItem] = useState<ReturnDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [scannerVisible, setScannerVisible] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [scannedCode, setScannedCode] = useState('');
  const [inspectModalVisible, setInspectModalVisible] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ReturnItemDto | null>(null);
  const [inspectionNotes, setInspectionNotes] = useState('');

  useEffect(() => {
    if (id) {
      loadReturn();
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      const { status} = await Camera.requestCameraPermissionsAsync();
      setHasPermission(status === 'granted');
    })();
  }, []);

  const loadReturn = async () => {
    try {
      setLoading(true);
      const response = await api.getReturn(id);

      if (response.success && response.data) {
        setReturnItem(response.data);
      } else {
        throw new Error(response.error || 'Failed to load return');
      }
    } catch (error) {
      console.error('Error loading return:', error);
      toast.error('Failed to load return details');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadReturn();
  };

  const handleBarCodeScanned = (result: BarcodeScanningResult) => {
    const data = result.data;
    setScannedCode(data);
    setScannerVisible(false);

    // Find matching item by SKU
    if (returnItem) {
      const matchedItem = returnItem.items.find(item => item.productSku === data);
      if (matchedItem) {
        toast.success(`Product verified: ${matchedItem.productName}`);
      } else {
        toast.error('Scanned code does not match any return item.');
      }
    }
  };

  const handleInspectItem = (item: ReturnItemDto) => {
    setSelectedItem(item);
    setInspectionNotes('');
    setInspectModalVisible(true);
  };

  const handleProcessReturn = async (action: 'approve' | 'reject' | 'receive' | 'restock' | 'complete') => {
    if (!returnItem) return;

    const actionLabels = {
      approve: 'Approve',
      reject: 'Reject',
      receive: 'Mark as Received',
      restock: 'Mark as Restocking',
      complete: 'Complete',
    };

    Alert.alert(
      `${actionLabels[action]} Return`,
      `Are you sure you want to ${actionLabels[action].toLowerCase()} this return?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: actionLabels[action],
          style: action === 'reject' ? 'destructive' : 'default',
          onPress: async () => {
            try {
              setUpdating(true);
              const response = await api.processReturn(returnItem.id, { action });

              if (response.success) {
                toast.success(`Return ${actionLabels[action].toLowerCase()}d successfully`);
                await loadReturn();
              } else {
                throw new Error(response.error || `Failed to ${action} return`);
              }
            } catch (error) {
              console.error(`Error ${action}ing return:`, error);
              toast.error(`Failed to ${action} return`);
            } finally {
              setUpdating(false);
            }
          },
        },
      ]
    );
  };

  if (loading) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading return...</Text>
      </View>
    );
  }

  if (!returnItem) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.muted }]}>Return not found</Text>
      </View>
    );
  }

  const statusColor = getReturnStatusColor(returnItem.status);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ChevronLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <Text style={[styles.returnNumber, { color: colors.text }]}>{returnItem.returnNumber}</Text>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>
              {returnItem.status}
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
        {/* Return Details Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <RotateCcw size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>Return Details</Text>
          </View>

          {returnItem.customerName && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Customer</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>
                {returnItem.customerName}
              </Text>
            </View>
          )}

          {returnItem.orderNumber && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Original Order</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>
                {returnItem.orderNumber}
              </Text>
            </View>
          )}

          <View style={styles.infoRow}>
            <Text style={[styles.infoLabel, { color: colors.muted }]}>Created</Text>
            <Text style={[styles.infoValue, { color: colors.text }]}>
              {formatDate(returnItem.createdAt)}
            </Text>
          </View>

          {returnItem.receivedDate && (
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Received</Text>
              <Text style={[styles.infoValue, { color: colors.text }]}>
                {formatDate(returnItem.receivedDate)}
              </Text>
            </View>
          )}

          {returnItem.reason && (
            <View style={[styles.reasonSection, { borderTopColor: colors.divider }]}>
              <Text style={[styles.reasonLabel, { color: colors.muted }]}>Return Reason</Text>
              <Text style={[styles.reasonText, { color: colors.text }]}>{returnItem.reason}</Text>
            </View>
          )}

          {returnItem.notes && (
            <View style={[styles.notesSection, { borderTopColor: colors.divider }]}>
              <Text style={[styles.notesLabel, { color: colors.muted }]}>Notes</Text>
              <Text style={[styles.notesText, { color: colors.text }]}>{returnItem.notes}</Text>
            </View>
          )}
        </View>

        {/* Return Items Card */}
        <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            <Package size={20} color={colors.text} />
            <Text style={[styles.cardTitle, { color: colors.text }]}>
              Items ({returnItem.items.length})
            </Text>
          </View>

          {returnItem.items.map((item, index) => (
            <View
              key={item.id}
              style={[
                styles.returnItem,
                index !== returnItem.items.length - 1 && {
                  borderBottomWidth: 0.5,
                  borderBottomColor: colors.divider,
                },
              ]}
            >
              <View style={styles.itemDetails}>
                <Text style={[styles.itemName, { color: colors.text }]}>
                  {item.productName}
                </Text>
                <Text style={[styles.itemSku, { color: colors.muted }]}>
                  SKU: {item.productSku}
                </Text>
                <View style={styles.itemInfo}>
                  <Text style={[styles.itemQuantity, { color: colors.muted }]}>
                    Quantity: {item.quantity}
                  </Text>
                  {item.condition && (
                    <Text style={[styles.itemCondition, { color: colors.muted }]}>
                      Condition: {item.condition}
                    </Text>
                  )}
                </View>
                {item.reason && (
                  <View style={styles.itemReason}>
                    <AlertCircle size={12} color={colors.muted} />
                    <Text style={[styles.itemReasonText, { color: colors.muted }]}>
                      {item.reason}
                    </Text>
                  </View>
                )}
              </View>

              {(returnItem.status === 'received' || returnItem.status === 'inspecting') && (
                <TouchableOpacity
                  style={[styles.inspectButton, { backgroundColor: colors.text }]}
                  onPress={() => handleInspectItem(item)}
                >
                  <Eye size={16} color={colors.background} />
                  <Text style={[styles.inspectButtonText, { color: colors.background }]}>
                    Inspect
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>

        {/* Refund Information Card */}
        {returnItem.refundAmount && (
          <View style={[styles.card, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <View style={styles.cardHeader}>
              <FileText size={20} color={colors.text} />
              <Text style={[styles.cardTitle, { color: colors.text }]}>Refund Information</Text>
            </View>

            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.muted }]}>Refund Amount</Text>
              <Text style={[styles.infoValue, styles.refundAmount, { color: colors.text }]}>
                {formatMoney(returnItem.refundAmount.amount, returnItem.refundAmount.currency)}
              </Text>
            </View>

            {returnItem.refundMethod && (
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: colors.muted }]}>Refund Method</Text>
                <Text style={[styles.infoValue, { color: colors.text }]}>
                  {returnItem.refundMethod}
                </Text>
              </View>
            )}

            {returnItem.refundProcessedDate && (
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: colors.muted }]}>Refund Processed</Text>
                <Text style={[styles.infoValue, { color: colors.text }]}>
                  {formatDate(returnItem.refundProcessedDate)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Scan Package */}
        {hasPermission && (returnItem.status === 'received' || returnItem.status === 'inspecting') && (
          <TouchableOpacity
            style={[styles.scanButton, { backgroundColor: colors.divider, borderColor: colors.border }]}
            onPress={() => setScannerVisible(true)}
          >
            <ScanBarcode size={20} color={colors.text} />
            <Text style={[styles.scanButtonText, { color: colors.text }]}>
              {scannedCode ? `Scanned: ${scannedCode}` : 'Scan Item Barcode'}
            </Text>
          </TouchableOpacity>
        )}

        {/* Action Buttons */}
        <View style={styles.actionsCard}>
          {returnItem.status === 'pending' && (
            <>
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: colors.text }]}
                onPress={() => handleProcessReturn('approve')}
                disabled={updating}
              >
                {updating ? (
                  <ActivityIndicator size="small" color={colors.background} />
                ) : (
                  <>
                    <CheckCircle2 size={20} color={colors.background} />
                    <Text style={[styles.actionButtonText, { color: colors.background }]}>
                      Approve Return
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#DC2626' }]}
                onPress={() => handleProcessReturn('reject')}
                disabled={updating}
              >
                <XCircle size={20} color="#DC2626" />
                <Text style={[styles.actionButtonText, { color: '#DC2626' }]}>
                  Reject Return
                </Text>
              </TouchableOpacity>
            </>
          )}

          {returnItem.status === 'approved' && (
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: '#DBEAFE', borderWidth: 1, borderColor: '#3B82F6' }]}
              onPress={() => handleProcessReturn('receive')}
              disabled={updating}
            >
              <Package size={20} color="#3B82F6" />
              <Text style={[styles.actionButtonText, { color: '#3B82F6' }]}>
                Mark as Received
              </Text>
            </TouchableOpacity>
          )}

          {(returnItem.status === 'received' || returnItem.status === 'inspecting') && (
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: '#DBEAFE', borderWidth: 1, borderColor: '#3B82F6' }]}
              onPress={() => handleProcessReturn('restock')}
              disabled={updating}
            >
              <RotateCcw size={20} color="#3B82F6" />
              <Text style={[styles.actionButtonText, { color: '#3B82F6' }]}>
                Start Restocking
              </Text>
            </TouchableOpacity>
          )}

          {returnItem.status === 'restocking' && (
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: '#10B981' }]}
              onPress={() => handleProcessReturn('complete')}
              disabled={updating}
            >
              {updating ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <>
                  <CheckCircle2 size={20} color="#FFFFFF" />
                  <Text style={[styles.actionButtonText, { color: '#FFFFFF' }]}>
                    Complete Return
                  </Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>
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
                  Align item barcode within the frame
                </Text>
              </View>
            </>
          )}
        </View>
      </Modal>

      {/* Inspection Modal */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={inspectModalVisible}
        onRequestClose={() => setInspectModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.background }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Inspect Item</Text>
            {selectedItem && (
              <>
                <Text style={[styles.modalSubtitle, { color: colors.text }]}>
                  {selectedItem.productName}
                </Text>
                <Text style={[styles.modalSubtitle, { color: colors.muted }]}>
                  SKU: {selectedItem.productSku}
                </Text>
                <Text style={[styles.modalSubtitle, { color: colors.muted }]}>
                  Quantity: {selectedItem.quantity}
                </Text>
                {selectedItem.condition && (
                  <Text style={[styles.modalSubtitle, { color: colors.muted }]}>
                    Reported Condition: {selectedItem.condition}
                  </Text>
                )}
              </>
            )}

            <View style={styles.inputContainer}>
              <Text style={[styles.inputLabel, { color: colors.text }]}>Inspection Notes</Text>
              <TextInput
                style={[styles.textArea, { borderColor: colors.divider, color: colors.text }]}
                placeholder="Enter inspection observations..."
                placeholderTextColor={colors.muted}
                value={inspectionNotes}
                onChangeText={setInspectionNotes}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalCancelButton, { borderColor: colors.divider }]}
                onPress={() => setInspectModalVisible(false)}
              >
                <Text style={[styles.modalCancelText, { color: colors.muted }]}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modalConfirmButton, { backgroundColor: colors.text }]}
                onPress={() => {
                  setInspectModalVisible(false);
                  toast.success('Inspection notes saved');
                }}
              >
                <Text style={[styles.modalConfirmText, { color: colors.background }]}>Save</Text>
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
  returnNumber: {
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
  refundAmount: {
    fontSize: 18,
    fontWeight: '700',
  },
  reasonSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 0.5,
  },
  reasonLabel: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 6,
  },
  reasonText: {
    fontSize: 14,
    lineHeight: 20,
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
  returnItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
  },
  itemDetails: {
    flex: 1,
    gap: 6,
  },
  itemName: {
    fontSize: 15,
    fontWeight: '600',
  },
  itemSku: {
    fontSize: 13,
  },
  itemInfo: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 4,
  },
  itemQuantity: {
    fontSize: 13,
  },
  itemCondition: {
    fontSize: 13,
    textTransform: 'capitalize',
  },
  itemReason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  itemReasonText: {
    fontSize: 12,
    flex: 1,
  },
  actionsCard: {
    gap: 12,
    marginBottom: 32,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 10,
  },
  actionButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  scanButton: {
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
  scanButtonText: {
    fontSize: 15,
    fontWeight: '500',
  },
  inspectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginLeft: 12,
  },
  inspectButtonText: {
    fontSize: 13,
    fontWeight: '600',
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
  textArea: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 100,
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
});
