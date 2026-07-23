import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Modal,
  PanResponder,
  Animated,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { ChevronLeft, Package, Truck, MapPin, Clock, User, Building, Phone, Mail, DollarSign, Box, AlertCircle, CheckCircle, Copy, MoreVertical, Printer, RefreshCw, Edit, AlertTriangle, MessageCircle, Trash2, X } from 'lucide-react-native';

interface ParcelEvent {
  id: string;
  status: string;
  location: string;
  description: string;
  timestamp: string;
}

interface ParcelDetails {
  id: string;
  trackingNumber: string;
  recipient: string;
  recipientEmail: string;
  recipientPhone: string;
  sender: string;
  senderEmail: string;
  senderPhone: string;
  status: 'pending' | 'in-transit' | 'out-for-delivery' | 'delivered' | 'delayed' | 'returned';
  weight: string;
  dimensions: string;
  value: string;
  description: string;
  location: string;
  estimatedDelivery: string;
  actualDelivery?: string;
  shippingAddress: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  pickupAddress: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
  };
  serviceType: string;
  requiresSignature: boolean;
  insurance: boolean;
  fragile: boolean;
  trackingHistory: ParcelEvent[];
  createdAt: string;
  updatedAt: string;
}

const PARCEL_STATUS_CONFIG = {
  pending: {
    label: 'Pending',
    color: '#F59E0B',
    backgroundColor: '#FEF3C7',
    icon: Clock,
  },
  'in-transit': {
    label: 'In Transit',
    color: '#3B82F6',
    backgroundColor: '#EFF6FF',
    icon: Truck,
  },
  'out-for-delivery': {
    label: 'Out for Delivery',
    color: '#8B5CF6',
    backgroundColor: '#F3E8FF',
    icon: Truck,
  },
  delivered: {
    label: 'Delivered',
    color: '#10B981',
    backgroundColor: '#ECFDF5',
    icon: CheckCircle,
  },
  delayed: {
    label: 'Delayed',
    color: '#EF4444',
    backgroundColor: '#FEF2F2',
    icon: AlertCircle,
  },
  returned: {
    label: 'Returned',
    color: '#6B7280',
    backgroundColor: '#F9FAFB',
    icon: Package,
  },
};

export default function ParcelDetailScreen() {
  const { colors } = useTheme();
  const { id } = useLocalSearchParams();
  const toast = useToast();
  const [parcel, setParcel] = useState<ParcelDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [moreMenuVisible, setMoreMenuVisible] = useState(false);
  
  // Pan gesture for modal
  const translateY = useRef(new Animated.Value(0)).current;
  const modalOpacity = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_, gestureState) => {
        if (gestureState.dy > 0) {
          translateY.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy > 100 || gestureState.vy > 0.5) {
          // Close modal if dragged down enough or with enough velocity
          Animated.parallel([
            Animated.timing(translateY, {
              toValue: 400,
              duration: 200,
              useNativeDriver: true,
            }),
            Animated.timing(modalOpacity, {
              toValue: 0,
              duration: 200,
              useNativeDriver: true,
            })
          ]).start(() => {
            setMoreMenuVisible(false);
            translateY.setValue(0);
            modalOpacity.setValue(0);
          });
        } else {
          // Snap back to original position
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
          }).start();
        }
      },
    })
  ).current;

  useEffect(() => {
    loadParcelDetails();
  }, [id]);

  const loadParcelDetails = async () => {
    try {
      setLoading(true);
      // Mock data - replace with actual API call
      await new Promise(resolve => setTimeout(resolve, 1000));

      const mockParcel: ParcelDetails = {
        id: id as string,
        trackingNumber: 'PKG2024001234',
        recipient: 'John Doe',
        recipientEmail: 'john.doe@example.com',
        recipientPhone: '+31 6 12345678',
        sender: 'Electronics Store',
        senderEmail: 'info@electronicsstore.com',
        senderPhone: '+31 20 1234567',
        status: 'in-transit',
        weight: '2.5 kg',
        dimensions: '30x20x15 cm',
        value: '€250.00',
        description: 'Electronic equipment - Handle with care',
        location: 'Amsterdam Distribution Center',
        estimatedDelivery: 'Today, 2-4 PM',
        shippingAddress: {
          street: '123 Main St',
          city: 'Amsterdam',
          state: 'NH',
          zipCode: '1012 AB',
          country: 'Netherlands',
        },
        pickupAddress: {
          street: '456 Commerce Ave',
          city: 'Rotterdam',
          state: 'ZH',
          zipCode: '3011 XY',
          country: 'Netherlands',
        },
        serviceType: 'Express',
        requiresSignature: true,
        insurance: true,
        fragile: false,
        trackingHistory: [
          {
            id: '1',
            status: 'Package in transit',
            location: 'Amsterdam Distribution Center',
            description: 'Package arrived at distribution center',
            timestamp: '2024-03-20 14:30',
          },
          {
            id: '2',
            status: 'Out for delivery',
            location: 'Amsterdam',
            description: 'Package loaded on delivery vehicle',
            timestamp: '2024-03-20 09:15',
          },
          {
            id: '3',
            status: 'Sorting complete',
            location: 'Rotterdam Hub',
            description: 'Package sorted and ready for dispatch',
            timestamp: '2024-03-19 18:45',
          },
          {
            id: '4',
            status: 'Arrived at facility',
            location: 'Rotterdam Hub',
            description: 'Package received at sorting facility',
            timestamp: '2024-03-19 16:20',
          },
          {
            id: '5',
            status: 'Pickup completed',
            location: 'Rotterdam',
            description: 'Package picked up from sender',
            timestamp: '2024-03-19 10:00',
          },
        ],
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      };

      setParcel(mockParcel);
    } catch (error) {
      console.error('Error loading parcel details:', error);
      toast.error('Failed to load parcel details');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadParcelDetails();
  };

  const handleCopyTracking = () => {
    toast.success('Tracking number copied to clipboard');
  };

  const handleMore = () => {
    translateY.setValue(0); // Reset position when opening
    modalOpacity.setValue(0); // Reset opacity
    setMoreMenuVisible(true);
    // Animate modal in
    Animated.timing(modalOpacity, {
      toValue: 1,
      duration: 200,
      useNativeDriver: true,
    }).start();
  };
  
  const closeModal = () => {
    Animated.parallel([
      Animated.timing(modalOpacity, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      })
    ]).start(() => {
      setMoreMenuVisible(false);
      translateY.setValue(0);
      modalOpacity.setValue(0);
    });
  };

  const handleUpdateStatus = () => {
    closeModal();
    setTimeout(() => {
      toast.warning('Update parcel status functionality');
    }, 200);
  };

  const handleEditParcel = () => {
    closeModal();
    setTimeout(() => {
      toast.warning('Edit parcel details functionality');
    }, 200);
  };

  const handleDeleteParcel = () => {
    closeModal();
    setTimeout(() => {
      toast.success('Parcel has been deleted');
      router.back();
    }, 200);
  };

  const handleReportIssue = () => {
    closeModal();
    setTimeout(() => {
      toast.warning('Report an issue with this parcel');
    }, 200);
  };

  const handleContactSupport = () => {
    closeModal();
    setTimeout(() => {
      toast.warning('Contact customer support');
    }, 200);
  };

  const handlePrintLabel = () => {
    closeModal();
    setTimeout(() => {
      toast.warning('Print label functionality');
    }, 200);
  };

  if (loading) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  if (!parcel) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.text }]}>Parcel not found</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={{ color: colors.text }}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const statusConfig = PARCEL_STATUS_CONFIG[parcel.status];
  const StatusIcon = statusConfig.icon;

  return (
    <View style={[styles.container, { backgroundColor: '#FFFFFF' }]}>
      {/* Minimal Header */}
      <View style={[styles.header, { backgroundColor: colors.background }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton}>
          <ChevronLeft size={20} color={colors.text} strokeWidth={2} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Parcel Details</Text>
        <TouchableOpacity onPress={handleMore} style={styles.headerButton}>
          <MoreVertical size={20} color={colors.text} strokeWidth={2} />
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        contentContainerStyle={styles.scrollContent}
      >
        {/* Main Section - Status & Tracking */}
        <View style={styles.section}>
          {/* Tracking Number with Actions */}
          <View style={styles.trackingHeader}>
            <View>
              <Text style={[styles.trackingLabel, { color: colors.muted }]}>Tracking Number</Text>
              <Text style={[styles.trackingNumber, { color: colors.text }]}>{parcel.trackingNumber}</Text>
            </View>
            <View style={styles.trackingActions}>
              <TouchableOpacity onPress={handleCopyTracking} style={styles.iconButton}>
                <Copy size={18} color={colors.muted} strokeWidth={2} />
              </TouchableOpacity>
            </View>
          </View>

          <View style={[styles.separator, { marginVertical: 20 }]} />
          {/* Current Status */}
          <View style={styles.statusSection}>
            <View style={[styles.statusIconContainer, { backgroundColor: statusConfig.backgroundColor }]}>
              <StatusIcon size={24} color={statusConfig.color} strokeWidth={2} />
            </View>
            <View style={styles.statusContent}>
              <Text style={[styles.statusText, { color: statusConfig.color }]}>{statusConfig.label}</Text>
              <Text style={[styles.locationText, { color: colors.text }]}>{parcel.location}</Text>
              <Text style={[styles.deliveryText, { color: colors.muted }]}>
                Expected: {parcel.estimatedDelivery}
              </Text>
            </View>
          </View>
        </View>

        {/* Vertical Separator */}
        <View style={styles.verticalSeparator} />

        {/* Timeline Section */}
        <View style={styles.section}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Delivery Timeline</Text>
          <View style={styles.timeline}>
            {parcel.trackingHistory.map((event, index) => (
              <View key={event.id} style={[
                styles.timelineItem,
                index === parcel.trackingHistory.length - 1 && { marginBottom: 0 }
              ]}>
                <View style={styles.timelineLeft}>
                  <Text style={[styles.timelineTime, { color: colors.muted }]}>
                    {event.timestamp.split(' ')[1]}
                  </Text>
                  <Text style={[styles.timelineDate, { color: colors.muted }]}>
                    {event.timestamp.split(' ')[0]}
                  </Text>
                </View>
                
                <View style={styles.timelineDot}>
                  <View style={[
                    styles.dot,
                    {
                      backgroundColor: index === 0 ? statusConfig.color : '#E5E7EB',
                    }
                  ]} />
                  {index < parcel.trackingHistory.length - 1 && (
                    <View style={styles.timelineLine} />
                  )}
                </View>
                
                <View style={styles.timelineContent}>
                  <Text style={[styles.timelineTitle, { color: colors.text }]}>
                    {event.status}
                  </Text>
                  <Text style={[styles.timelineSubtitle, { color: colors.muted }]}>
                    {event.location}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* Vertical Separator */}
        <View style={styles.verticalSeparator} />

        {/* Delivery Information */}
        <View style={styles.section}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Delivery Information</Text>
          
          <View style={styles.infoRow}>
            <View style={styles.infoItem}>
              <User size={16} color={colors.muted} strokeWidth={2} />
              <View style={styles.infoContent}>
                <Text style={[styles.infoLabel, { color: colors.muted }]}>Recipient</Text>
                <Text style={[styles.infoValue, { color: colors.text }]}>{parcel.recipient}</Text>
                <Text style={[styles.infoSubvalue, { color: colors.muted }]}>{parcel.recipientPhone}</Text>
              </View>
            </View>
          </View>

          <View style={[styles.infoRow, { marginBottom: 0 }]}>
            <View style={styles.infoItem}>
              <MapPin size={16} color={colors.muted} strokeWidth={2} />
              <View style={styles.infoContent}>
                <Text style={[styles.infoLabel, { color: colors.muted }]}>Delivery Address</Text>
                <Text style={[styles.infoValue, { color: colors.text }]}>{parcel.shippingAddress.street}</Text>
                <Text style={[styles.infoSubvalue, { color: colors.muted }]}>
                  {parcel.shippingAddress.city}, {parcel.shippingAddress.zipCode}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.separator} />
          <View style={styles.infoRow}>
            <View style={styles.infoItem}>
              <Building size={16} color={colors.muted} strokeWidth={2} />
              <View style={styles.infoContent}>
                <Text style={[styles.infoLabel, { color: colors.muted }]}>Sender</Text>
                <Text style={[styles.infoValue, { color: colors.text }]}>{parcel.sender}</Text>
                <Text style={[styles.infoSubvalue, { color: colors.muted }]}>{parcel.senderPhone}</Text>
              </View>
            </View>
          </View>

          <View style={[styles.infoRow, { marginBottom: 0 }]}>
            <View style={styles.infoItem}>
              <MapPin size={16} color={colors.muted} strokeWidth={2} />
              <View style={styles.infoContent}>
                <Text style={[styles.infoLabel, { color: colors.muted }]}>Pickup Address</Text>
                <Text style={[styles.infoValue, { color: colors.text }]}>{parcel.pickupAddress.street}</Text>
                <Text style={[styles.infoSubvalue, { color: colors.muted }]}>
                  {parcel.pickupAddress.city}, {parcel.pickupAddress.zipCode}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* Vertical Separator */}
        <View style={styles.verticalSeparator} />

        {/* Package Details */}
        <View style={styles.section}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Package Details</Text>
          
          <View style={styles.detailsGrid}>
            <View style={styles.detailItem}>
              <Text style={[styles.detailLabel, { color: colors.muted }]}>Weight</Text>
              <Text style={[styles.detailValue, { color: colors.text }]}>{parcel.weight}</Text>
            </View>
            <View style={styles.detailItem}>
              <Text style={[styles.detailLabel, { color: colors.muted }]}>Dimensions</Text>
              <Text style={[styles.detailValue, { color: colors.text }]}>{parcel.dimensions}</Text>
            </View>
            <View style={[styles.detailItem, { marginBottom: 0 }]}>
              <Text style={[styles.detailLabel, { color: colors.muted }]}>Value</Text>
              <Text style={[styles.detailValue, { color: colors.text }]}>{parcel.value}</Text>
            </View>
            <View style={[styles.detailItem, { marginBottom: 0 }]}>
              <Text style={[styles.detailLabel, { color: colors.muted }]}>Service</Text>
              <Text style={[styles.detailValue, { color: colors.text }]}>{parcel.serviceType}</Text>
            </View>
          </View>

          <View style={styles.optionsRow}>
            <View style={styles.optionItem}>
              <View style={[styles.optionIcon, { 
                backgroundColor: parcel.requiresSignature ? '#ECFDF5' : '#F9FAFB' 
              }]}>
                <Ionicons 
                  name={parcel.requiresSignature ? "checkmark-circle" : "close-circle"} 
                  size={16} 
                  color={parcel.requiresSignature ? "#10B981" : "#9CA3AF"} 
                />
              </View>
              <Text style={[styles.optionText, { color: colors.text }]}>Signature Required</Text>
            </View>
            
            <View style={styles.optionItem}>
              <View style={[styles.optionIcon, { 
                backgroundColor: parcel.insurance ? '#ECFDF5' : '#F9FAFB' 
              }]}>
                <Ionicons 
                  name={parcel.insurance ? "shield-checkmark" : "shield-outline"} 
                  size={16} 
                  color={parcel.insurance ? "#10B981" : "#9CA3AF"} 
                />
              </View>
              <Text style={[styles.optionText, { color: colors.text }]}>Insurance</Text>
            </View>
          </View>
        </View>

      </ScrollView>

      {/* More Options Modal - shadcn style */}
      <Modal
        animationType="none"
        transparent={true}
        visible={moreMenuVisible}
        onRequestClose={closeModal}
      >
        <Animated.View 
          style={[styles.modalOverlay, { opacity: modalOpacity }]}
        >
          <TouchableOpacity 
            style={{ flex: 1 }}
            activeOpacity={1} 
            onPress={closeModal}
          />
          <Animated.View 
            style={[
              styles.modalContent, 
              { 
                backgroundColor: colors.background,
                transform: [{ translateY }]
              }
            ]}
          >
            <View 
              style={styles.modalHandleContainer}
              {...panResponder.panHandlers}
            >
              <View style={styles.modalHandle} />
            </View>
            
            <View style={styles.modalBody}>
              <TouchableOpacity
                style={styles.modalOption}
                onPress={handleUpdateStatus}
              >
                <RefreshCw size={18} color={colors.text} strokeWidth={2} />
                <Text style={[styles.modalOptionText, { color: colors.text }]}>Update Status</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalOption}
                onPress={handleEditParcel}
              >
                <Edit size={18} color={colors.text} strokeWidth={2} />
                <Text style={[styles.modalOptionText, { color: colors.text }]}>Edit Parcel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalOption}
                onPress={handleReportIssue}
              >
                <AlertTriangle size={18} color={colors.text} strokeWidth={2} />
                <Text style={[styles.modalOptionText, { color: colors.text }]}>Report Issue</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalOption}
                onPress={handleContactSupport}
              >
                <MessageCircle size={18} color={colors.text} strokeWidth={2} />
                <Text style={[styles.modalOptionText, { color: colors.text }]}>Contact Support</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalOption}
                onPress={handlePrintLabel}
              >
                <Printer size={18} color={colors.text} strokeWidth={2} />
                <Text style={[styles.modalOptionText, { color: colors.text }]}>Print Label</Text>
              </TouchableOpacity>

              <View style={[styles.modalDivider, { backgroundColor: colors.divider }]} />

              <TouchableOpacity
                style={styles.modalOption}
                onPress={handleDeleteParcel}
              >
                <Trash2 size={18} color="#DC2626" strokeWidth={2} />
                <Text style={[styles.modalOptionText, { color: '#DC2626' }]}>Delete Parcel</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </Animated.View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    fontSize: 16,
    marginBottom: 20,
  },
  backButton: {
    padding: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 16,
  },
  headerButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '500',
  },
  scrollContent: {
    paddingTop: 32,
    paddingBottom: 32,
  },
  section: {
    paddingHorizontal: 20,
  },
  verticalSeparator: {
    height: 1,
    backgroundColor: '#E5E7EB',
    marginHorizontal: 20,
    marginVertical: 32,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 32,
  },
  trackingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  trackingLabel: {
    fontSize: 12,
    marginBottom: 4,
  },
  trackingNumber: {
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  trackingActions: {
    flexDirection: 'row',
    gap: 8,
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F9FAFB',
  },
  separator: {
    height: 1,
    backgroundColor: '#F3F4F6',
    marginVertical: 32,
  },
  statusSection: {
    flexDirection: 'row',
    gap: 16,
  },
  statusIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusContent: {
    flex: 1,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  locationText: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 2,
  },
  deliveryText: {
    fontSize: 12,
  },
  timeline: {
  },
  timelineItem: {
    flexDirection: 'row',
    marginBottom: 32,
  },
  timelineLeft: {
    width: 50,
    alignItems: 'flex-end',
    paddingRight: 16,
  },
  timelineTime: {
    fontSize: 12,
    fontWeight: '500',
  },
  timelineDate: {
    fontSize: 10,
    marginTop: 2,
  },
  timelineDot: {
    width: 24,
    alignItems: 'center',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  timelineLine: {
    position: 'absolute',
    top: 8,
    width: 1,
    height: 48,
    backgroundColor: '#E5E7EB',
  },
  timelineContent: {
    flex: 1,
    paddingLeft: 16,
  },
  timelineTitle: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 2,
  },
  timelineSubtitle: {
    fontSize: 12,
  },
  infoRow: {
    marginBottom: 32,
  },
  infoItem: {
    flexDirection: 'row',
    gap: 12,
  },
  infoContent: {
    flex: 1,
  },
  infoLabel: {
    fontSize: 11,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 2,
  },
  infoSubvalue: {
    fontSize: 12,
  },
  detailsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -8,
  },
  detailItem: {
    width: '50%',
    paddingHorizontal: 8,
    marginBottom: 32,
  },
  detailLabel: {
    fontSize: 11,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  optionsRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 32,
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  optionIcon: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionText: {
    fontSize: 13,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 10,
  },
  modalHandleContainer: {
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 60,
  },
  modalHandle: {
    width: 36,
    height: 4,
    backgroundColor: '#D1D5DB',
    borderRadius: 2,
  },
  modalBody: {
    paddingTop: 8,
    paddingBottom: 24,
  },
  modalOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 20,
    gap: 12,
  },
  modalOptionText: {
    fontSize: 15,
    fontWeight: '400',
    letterSpacing: -0.2,
  },
  modalDivider: {
    height: 1,
    marginVertical: 8,
    marginHorizontal: 20,
  },
});