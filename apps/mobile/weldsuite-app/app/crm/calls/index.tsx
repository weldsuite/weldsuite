import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Modal,
  StatusBar,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  Phone,
  Clock,
  Calendar,
  User,
  Search,
  Plus,
  PhoneOutgoing,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  X,
  Building2,
  Mic,
  MicOff,
  Volume2,
  Pause,
  Play,
} from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useVoipSafe } from '@/contexts/VoipContext';
import api from '@/services/api';

interface Call {
  id: string;
  provider?: string;
  providerCallId?: string;
  direction: 'inbound' | 'outbound';
  status: string;
  fromNumber: string;
  toNumber: string;
  fromNumberFormatted?: string;
  toNumberFormatted?: string;
  initiatedAt: string;
  answeredAt?: string;
  endedAt?: string;
  duration?: number;
  isRecorded?: boolean;
  customerId?: string;
  contactId?: string;
  notes?: string;
  // Display fields (from CRM linking)
  contactName?: string;
  linkedCompany?: {
    id: string;
    name: string;
    color?: string;
  };
}

export default function CallsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const voip = useVoipSafe();
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCall, setSelectedCall] = useState<Call | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [isDialerOpen, setIsDialerOpen] = useState(false);
  const [dialNumber, setDialNumber] = useState('');

  // Load calls from API
  const loadCalls = useCallback(async () => {
    try {
      setLoading(true);
      // Call intelligence API not yet available on mobile — use VoIP calls if available
      setCalls([]);
    } catch (error) {
      // Fail silently — API not yet implemented
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadCalls();
  }, [loadCalls]);

  // Use VoIP context calls if available
  useEffect(() => {
    if (voip?.calls && voip.calls.length > 0) {
      const transformedCalls: Call[] = voip.calls.map((call: any) => ({
        ...call,
        contactName: call.toNumberFormatted || call.toNumber,
      }));
      setCalls(transformedCalls);
    }
  }, [voip?.calls]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    if (voip) {
      voip.refreshCalls().finally(() => setRefreshing(false));
    } else {
      loadCalls();
    }
  }, [voip, loadCalls]);

  const parseDate = (dateString?: string): Date | null => {
    if (!dateString) return null;
    return new Date(dateString);
  };

  const isToday = (date: Date) => {
    const today = new Date();
    return date.toDateString() === today.toDateString();
  };

  const isYesterday = (date: Date) => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return date.toDateString() === yesterday.toDateString();
  };

  const formatDate = (date: Date) => {
    if (isToday(date)) return 'Today';
    if (isYesterday(date)) return 'Yesterday';

    const month = date.toLocaleString('default', { month: 'short' });
    const day = date.getDate();
    return `${month} ${day}`;
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };

  // Map API status to display status
  const mapStatus = (status: string): 'completed' | 'scheduled' | 'missed' | 'cancelled' | 'failed' => {
    switch (status) {
      case 'completed':
      case 'bridged':
      case 'answered':
        return 'completed';
      case 'initiated':
      case 'ringing':
        return 'scheduled';
      case 'no_answer':
        return 'missed';
      case 'canceled':
        return 'cancelled';
      case 'failed':
      case 'busy':
        return 'failed';
      default:
        return 'completed';
    }
  };

  // Filter calls
  const filteredCalls = calls.filter(call => {
    const displayNumber = call.direction === 'outbound' ? call.toNumber : call.fromNumber;
    const matchesSearch =
      displayNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      call.contactName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      call.notes?.toLowerCase().includes(searchTerm.toLowerCase());

    const mappedStatus = mapStatus(call.status);
    const matchesStatus = selectedStatus === null || mappedStatus === selectedStatus;

    return matchesSearch && matchesStatus;
  });

  // Group calls by date
  const todayCalls = filteredCalls.filter(c => {
    const date = parseDate(c.initiatedAt);
    return date && isToday(date);
  });
  const yesterdayCalls = filteredCalls.filter(c => {
    const date = parseDate(c.initiatedAt);
    return date && isYesterday(date);
  });
  const olderCalls = filteredCalls.filter(c => {
    const date = parseDate(c.initiatedAt);
    return date && !isToday(date) && !isYesterday(date);
  });

  const handleCallClick = (call: Call) => {
    setSelectedCall(call);
    setIsModalVisible(true);
  };

  const handleMakeCall = async () => {
    if (!dialNumber.trim()) {
      toast.error('Please enter a phone number');
      return;
    }

    if (!voip) {
      toast.error('VoIP is not initialized');
      return;
    }

    const result = await voip.makeCall({
      toNumber: dialNumber,
      enableRecording: true,
    });

    if (result.success) {
      toast.success('Call initiated');
      setIsDialerOpen(false);
      setDialNumber('');
    } else {
      toast.error(result.error || 'Failed to make call');
    }
  };

  const getCallTypeIcon = (direction: string, status: string) => {
    const mappedStatus = mapStatus(status);
    if (mappedStatus === 'missed' || mappedStatus === 'failed') return PhoneMissed;
    if (direction === 'inbound') return PhoneIncoming;
    return PhoneOutgoing;
  };

  const getCallTypeColor = (direction: string, status: string) => {
    const mappedStatus = mapStatus(status);
    if (mappedStatus === 'missed' || mappedStatus === 'failed') return '#EF4444';
    if (direction === 'inbound') return '#10B981';
    return '#3B82F6';
  };

  const getStatusConfig = (status: string) => {
    const mappedStatus = mapStatus(status);
    switch (mappedStatus) {
      case 'completed':
        return { label: 'Completed', color: '#10B981', bgColor: '#D1FAE5' };
      case 'scheduled':
        return { label: 'In Progress', color: '#3B82F6', bgColor: '#DBEAFE' };
      case 'missed':
        return { label: 'Missed', color: '#EF4444', bgColor: '#FEE2E2' };
      case 'cancelled':
        return { label: 'Cancelled', color: '#6B7280', bgColor: '#F3F4F6' };
      case 'failed':
        return { label: 'Failed', color: '#EF4444', bgColor: '#FEE2E2' };
      default:
        return null;
    }
  };

  const renderStatusFilter = () => {
    const completedCount = calls.filter(c => mapStatus(c.status) === 'completed').length;
    const missedCount = calls.filter(c => mapStatus(c.status) === 'missed' || mapStatus(c.status) === 'failed').length;
    const inProgressCount = calls.filter(c => mapStatus(c.status) === 'scheduled').length;

    const statusOptions = [
      { key: null, label: 'All Calls', count: calls.length },
      { key: 'scheduled', label: 'In Progress', count: inProgressCount },
      { key: 'completed', label: 'Completed', count: completedCount },
      { key: 'missed', label: 'Missed', count: missedCount },
    ];

    return (
      <View style={[styles.filterContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          {statusOptions.map((item) => (
            <TouchableOpacity
              key={item.key || 'all'}
              style={[
                styles.filterButton,
                {
                  backgroundColor: selectedStatus === item.key ? colors.text : colors.background,
                  borderColor: selectedStatus === item.key ? colors.text : colors.buttonBorder,
                }
              ]}
              onPress={() => setSelectedStatus(item.key)}
            >
              <Text
                style={[
                  styles.filterButtonText,
                  { color: selectedStatus === item.key ? colors.background : colors.text }
                ]}
              >
                {item.label}
              </Text>
              <Text
                style={[
                  styles.filterButtonCount,
                  { color: selectedStatus === item.key ? colors.background : colors.muted }
                ]}
              >
                ({item.count})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const CallItem = ({ call }: { call: Call }) => {
    const displayNumber = call.direction === 'outbound' ? call.toNumber : call.fromNumber;
    const formattedNumber = call.direction === 'outbound' ? call.toNumberFormatted : call.fromNumberFormatted;
    const CallIcon = getCallTypeIcon(call.direction, call.status);
    const iconColor = getCallTypeColor(call.direction, call.status);
    const statusConfig = getStatusConfig(call.status);
    const callDate = parseDate(call.initiatedAt);

    return (
      <TouchableOpacity
        style={[styles.callItem, { backgroundColor: colors.background }]}
        activeOpacity={0.7}
        onPress={() => handleCallClick(call)}
      >
        <View style={styles.callRow}>
          <View style={[styles.callIconContainer, { backgroundColor: `${iconColor}15` }]}>
            <CallIcon size={18} color={iconColor} strokeWidth={2} />
          </View>

          <View style={styles.callContent}>
            <Text style={[styles.callName, { color: colors.text }]} numberOfLines={1}>
              {formattedNumber || displayNumber}
            </Text>

            <View style={styles.callMeta}>
              {statusConfig && (
                <View style={[styles.statusBadge, { backgroundColor: statusConfig.bgColor }]}>
                  <Text style={[styles.statusText, { color: statusConfig.color }]}>
                    {statusConfig.label}
                  </Text>
                </View>
              )}

              {call.duration && call.duration > 0 && (
                <View style={styles.durationBadge}>
                  <Clock size={11} color={colors.muted} strokeWidth={2} />
                  <Text style={[styles.durationText, { color: colors.muted }]}>
                    {formatDuration(call.duration)}
                  </Text>
                </View>
              )}

              {callDate && (
                <View style={styles.dateBadge}>
                  <Calendar size={11} color={colors.muted} strokeWidth={2} />
                  <Text style={[styles.dateText, { color: colors.muted }]}>
                    {formatDate(callDate)}
                  </Text>
                </View>
              )}

              {call.isRecorded && (
                <View style={[styles.recordBadge, { backgroundColor: '#FEE2E2' }]}>
                  <View style={[styles.recordDot, { backgroundColor: '#EF4444' }]} />
                  <Text style={[styles.recordText, { color: '#EF4444' }]}>Rec</Text>
                </View>
              )}
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const CallSection = ({ title, calls }: { title: string; calls: Call[] }) => {
    if (calls.length === 0) return null;

    return (
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>
            {title}
          </Text>
          <View style={[styles.countBadge, { backgroundColor: '#F3F4F6' }]}>
            <Text style={[styles.countText, { color: '#6B7280' }]}>
              {calls.length}
            </Text>
          </View>
        </View>

        <View style={styles.callList}>
          {calls.map(call => (
            <CallItem key={call.id} call={call} />
          ))}
        </View>
      </View>
    );
  };

  // Active call UI overlay
  const ActiveCallOverlay = () => {
    if (!voip?.activeCall) return null;

    const { activeCall, endCall, toggleMute, toggleSpeaker, toggleHold } = voip;

    return (
      <Modal visible={true} animationType="slide" presentationStyle="fullScreen">
        <SafeAreaView style={[styles.activeCallContainer, { backgroundColor: '#1F2937' }]}>
          <View style={styles.activeCallContent}>
            <Text style={styles.activeCallStatus}>
              {activeCall.status === 'dialing' ? 'Calling...' :
               activeCall.status === 'ringing' ? 'Ringing...' :
               activeCall.status === 'connected' ? 'Connected' :
               activeCall.status === 'ended' ? 'Call Ended' : ''}
            </Text>

            <Text style={styles.activeCallNumber}>
              {activeCall.contactName || activeCall.toNumber}
            </Text>

            {activeCall.status === 'connected' && (
              <Text style={styles.activeCallDuration}>
                {formatDuration(activeCall.duration)}
              </Text>
            )}
          </View>

          <View style={styles.activeCallControls}>
            <TouchableOpacity
              style={[styles.callControlButton, activeCall.isMuted && styles.callControlButtonActive]}
              onPress={toggleMute}
            >
              {activeCall.isMuted ? (
                <MicOff size={24} color="#fff" />
              ) : (
                <Mic size={24} color="#fff" />
              )}
              <Text style={styles.callControlLabel}>Mute</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.callControlButton, activeCall.isSpeaker && styles.callControlButtonActive]}
              onPress={toggleSpeaker}
            >
              <Volume2 size={24} color="#fff" />
              <Text style={styles.callControlLabel}>Speaker</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.callControlButton, activeCall.isOnHold && styles.callControlButtonActive]}
              onPress={toggleHold}
            >
              {activeCall.isOnHold ? (
                <Play size={24} color="#fff" />
              ) : (
                <Pause size={24} color="#fff" />
              )}
              <Text style={styles.callControlLabel}>Hold</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.endCallButton} onPress={endCall}>
            <PhoneOff size={28} color="#fff" />
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    );
  };

  if (loading && !refreshing) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading calls...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ActiveCallOverlay />

      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Calls ({filteredCalls.length})</Text>
        <TouchableOpacity
          style={[styles.addButton, { backgroundColor: colors.background, borderColor: colors.buttonBorder }]}
          onPress={() => setIsDialerOpen(true)}
        >
          <Plus size={16} color={colors.text} strokeWidth={2} />
          <Text style={[styles.addButtonText, { color: colors.text }]}>Call</Text>
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchBarContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search calls..."
            placeholderTextColor={colors.muted}
            value={searchTerm}
            onChangeText={setSearchTerm}
            returnKeyType="search"
          />
        </View>
      </View>

      {renderStatusFilter()}

      {/* Call List */}
      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      >
        {todayCalls.length > 0 && <CallSection title="Today" calls={todayCalls} />}
        {yesterdayCalls.length > 0 && <CallSection title="Yesterday" calls={yesterdayCalls} />}
        {olderCalls.length > 0 && <CallSection title="Earlier" calls={olderCalls} />}

        {filteredCalls.length === 0 && (
          <View style={styles.emptyState}>
            <View style={[styles.emptyIcon, { backgroundColor: '#F3F4F6' }]}>
              <Phone size={32} color={colors.muted} strokeWidth={1.5} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>
              No calls found
            </Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              Make a call to get started
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Call Details Modal */}
      <Modal
        visible={isModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIsModalVisible(false)}
      >
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          {/* Modal Header */}
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Call Details</Text>
            <TouchableOpacity
              onPress={() => setIsModalVisible(false)}
              style={styles.closeButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          {/* Modal Content */}
          {selectedCall && (
            <ScrollView style={styles.modalContent} showsVerticalScrollIndicator={false}>
              <View style={styles.modalSection}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Phone Number</Text>
                <Text style={[styles.modalCallName, { color: colors.text }]}>
                  {selectedCall.direction === 'outbound'
                    ? (selectedCall.toNumberFormatted || selectedCall.toNumber)
                    : (selectedCall.fromNumberFormatted || selectedCall.fromNumber)}
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Direction</Text>
                <Text style={[styles.modalText, { color: colors.text }]}>
                  {selectedCall.direction === 'outbound' ? 'Outbound' : 'Inbound'}
                </Text>
              </View>

              <View style={styles.modalSection}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Status</Text>
                <View style={styles.modalRow}>
                  {(() => {
                    const statusConfig = getStatusConfig(selectedCall.status);
                    return statusConfig ? (
                      <View style={[styles.statusBadge, { backgroundColor: statusConfig.bgColor }]}>
                        <Text style={[styles.statusText, { color: statusConfig.color }]}>
                          {statusConfig.label}
                        </Text>
                      </View>
                    ) : null;
                  })()}
                </View>
              </View>

              {selectedCall.duration && selectedCall.duration > 0 && (
                <View style={styles.modalSection}>
                  <Text style={[styles.modalLabel, { color: colors.muted }]}>Duration</Text>
                  <View style={styles.modalRow}>
                    <Clock size={16} color={colors.text} strokeWidth={2} />
                    <Text style={[styles.modalText, { color: colors.text }]}>
                      {formatDuration(selectedCall.duration)}
                    </Text>
                  </View>
                </View>
              )}

              {selectedCall.notes && (
                <View style={styles.modalSection}>
                  <Text style={[styles.modalLabel, { color: colors.muted }]}>Notes</Text>
                  <Text style={[styles.modalText, { color: colors.text }]}>
                    {selectedCall.notes}
                  </Text>
                </View>
              )}

              <View style={styles.modalSection}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Date</Text>
                <View style={styles.modalRow}>
                  <Calendar size={16} color={colors.text} strokeWidth={2} />
                  <Text style={[styles.modalText, { color: colors.text }]}>
                    {new Date(selectedCall.initiatedAt).toLocaleDateString('en-US', {
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                    })} at {formatTime(selectedCall.initiatedAt)}
                  </Text>
                </View>
              </View>
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* Dialer Modal */}
      <Modal
        visible={isDialerOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIsDialerOpen(false)}
      >
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>New Call</Text>
            <TouchableOpacity
              onPress={() => setIsDialerOpen(false)}
              style={styles.closeButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          <View style={styles.dialerContent}>
            <TextInput
              style={[styles.dialInput, { color: colors.text, borderColor: colors.divider }]}
              placeholder="Enter phone number"
              placeholderTextColor={colors.muted}
              value={dialNumber}
              onChangeText={setDialNumber}
              keyboardType="phone-pad"
              autoFocus
            />

            <TouchableOpacity
              style={[styles.dialButton, { backgroundColor: '#10B981' }]}
              onPress={handleMakeCall}
            >
              <Phone size={24} color="#fff" />
              <Text style={styles.dialButtonText}>Call</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  searchBarContainer: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  filterContainer: {
    paddingTop: 4,
    paddingBottom: 12,
  },
  filterList: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  filterButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  filterButtonCount: {
    fontSize: 13,
    fontWeight: '400',
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  addButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 20,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  countBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  countText: {
    fontSize: 9,
    fontWeight: '600',
  },
  callList: {
    gap: 2,
  },
  callItem: {
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 0,
  },
  callRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  callIconContainer: {
    width: 36,
    height: 36,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  callContent: {
    flex: 1,
    gap: 6,
  },
  callName: {
    fontSize: 14,
    fontWeight: '500',
  },
  callMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '600',
  },
  durationBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  durationText: {
    fontSize: 11,
  },
  dateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  dateText: {
    fontSize: 11,
  },
  recordBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  recordDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  recordText: {
    fontSize: 10,
    fontWeight: '600',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
    paddingHorizontal: 40,
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 13,
    textAlign: 'center',
  },
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingTop: 16,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginLeft: 16,
  },
  closeButton: {
    padding: 4,
    marginRight: 16,
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  modalSection: {
    marginBottom: 24,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
  },
  modalCallName: {
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 24,
  },
  modalText: {
    fontSize: 15,
    lineHeight: 22,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dialerContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 40,
    alignItems: 'center',
  },
  dialInput: {
    width: '100%',
    fontSize: 24,
    fontWeight: '500',
    textAlign: 'center',
    paddingVertical: 16,
    borderBottomWidth: 2,
    marginBottom: 40,
  },
  dialButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 32,
    paddingVertical: 16,
    borderRadius: 12,
  },
  dialButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  activeCallContainer: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 40,
  },
  activeCallContent: {
    alignItems: 'center',
    paddingTop: 60,
  },
  activeCallStatus: {
    color: '#9CA3AF',
    fontSize: 16,
    marginBottom: 8,
  },
  activeCallNumber: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '600',
    marginBottom: 16,
  },
  activeCallDuration: {
    color: '#10B981',
    fontSize: 20,
    fontWeight: '500',
  },
  activeCallControls: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 32,
  },
  callControlButton: {
    alignItems: 'center',
    gap: 8,
    padding: 16,
    borderRadius: 12,
  },
  callControlButtonActive: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  callControlLabel: {
    color: '#fff',
    fontSize: 12,
  },
  endCallButton: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#EF4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
