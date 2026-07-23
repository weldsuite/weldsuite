import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import api from '@/services/api';

// Types for VoIP calls
export type VoipProvider = 'twilio' | 'telnyx';
export type CallStatus = 'idle' | 'dialing' | 'ringing' | 'connected' | 'ended' | 'failed';

interface VoipCall {
  id: string;
  provider: VoipProvider;
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
  createdAt: string;
}

interface VoipPhoneNumber {
  id: string;
  provider: VoipProvider;
  phoneNumber: string;
  formattedNumber?: string;
  countryCode: string;
  numberType?: string;
  status: string;
  isDefault?: boolean;
  displayName?: string;
}

interface ActiveCallState {
  id?: string;
  status: CallStatus;
  toNumber: string;
  fromNumber: string;
  startedAt?: Date;
  connectedAt?: Date;
  duration: number;
  isMuted: boolean;
  isSpeaker: boolean;
  isOnHold: boolean;
  isRecording: boolean;
  contactName?: string;
  customerName?: string;
}

interface VoipContextType {
  // Configuration
  isConfigured: boolean;
  isInitialized: boolean;
  provider: VoipProvider;

  // Phone numbers
  phoneNumbers: VoipPhoneNumber[];
  defaultPhoneNumber: VoipPhoneNumber | null;
  refreshPhoneNumbers: () => Promise<void>;

  // Call history
  calls: VoipCall[];
  isLoadingCalls: boolean;
  refreshCalls: () => Promise<void>;

  // Active call
  activeCall: ActiveCallState | null;
  makeCall: (params: {
    toNumber: string;
    fromNumber?: string;
    contactName?: string;
    customerName?: string;
    enableRecording?: boolean;
  }) => Promise<{ success: boolean; callId?: string; error?: string }>;
  endCall: () => void;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  toggleHold: () => void;

  // Stats
  stats: {
    totalCalls: number;
    completedCalls: number;
    totalDuration: number;
    avgDuration: number;
  } | null;
}

const VoipContext = createContext<VoipContextType | null>(null);

interface VoipProviderProps {
  children: ReactNode;
}

export function VoipProvider({ children }: VoipProviderProps) {
  const [isConfigured, setIsConfigured] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [provider] = useState<VoipProvider>('twilio');
  const [phoneNumbers, setPhoneNumbers] = useState<VoipPhoneNumber[]>([]);
  const [calls, setCalls] = useState<VoipCall[]>([]);
  const [isLoadingCalls, setIsLoadingCalls] = useState(false);
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const [stats, setStats] = useState<VoipContextType['stats']>(null);
  const durationInterval = useRef<NodeJS.Timeout | null>(null);

  // Track active call duration
  useEffect(() => {
    if (activeCall?.status === 'connected' && activeCall.connectedAt) {
      durationInterval.current = setInterval(() => {
        setActiveCall(prev => {
          if (!prev || !prev.connectedAt) return prev;
          const now = new Date();
          const duration = Math.floor((now.getTime() - prev.connectedAt.getTime()) / 1000);
          return { ...prev, duration };
        });
      }, 1000);
    }

    return () => {
      if (durationInterval.current) {
        clearInterval(durationInterval.current);
        durationInterval.current = null;
      }
    };
  }, [activeCall?.status, activeCall?.connectedAt]);

  // Initialize VoIP on mount
  useEffect(() => {
    const initialize = async () => {
      try {
        // Check if VoIP is configured
        const configResponse = await api.get('/crm/call-intelligence/token');
        if (configResponse.data?.configured) {
          setIsConfigured(true);
        }

        // Load phone numbers
        await refreshPhoneNumbers();

        // Load recent calls
        await refreshCalls();

        // Load stats
        await refreshStats();

        setIsInitialized(true);
      } catch (error) {
        console.error('[VoIP] Failed to initialize:', error);
        setIsInitialized(true); // Still mark as initialized even on error
      }
    };

    initialize();
  }, []);

  // Refresh calls when app becomes active
  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') {
        refreshCalls();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, []);

  const refreshPhoneNumbers = useCallback(async () => {
    try {
      const response = await api.get('/crm/call-intelligence/phone-numbers');
      if (response.data) {
        setPhoneNumbers(response.data);
      }
    } catch (error) {
      console.error('[VoIP] Failed to load phone numbers:', error);
    }
  }, []);

  const refreshCalls = useCallback(async () => {
    setIsLoadingCalls(true);
    try {
      const response = await api.get('/crm/call-intelligence/calls', {
        params: { pageSize: 50 },
      });
      if (response.data) {
        setCalls(response.data);
      }
    } catch (error) {
      console.error('[VoIP] Failed to load calls:', error);
    } finally {
      setIsLoadingCalls(false);
    }
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      const response = await api.get('/crm/call-intelligence/stats');
      if (response.data) {
        setStats(response.data);
      }
    } catch (error) {
      console.error('[VoIP] Failed to load stats:', error);
    }
  }, []);

  const defaultPhoneNumber = phoneNumbers.find(p => p.isDefault) || phoneNumbers[0] || null;

  const makeCall = useCallback(async (params: {
    toNumber: string;
    fromNumber?: string;
    contactName?: string;
    customerName?: string;
    enableRecording?: boolean;
  }) => {
    const fromNumber = params.fromNumber || defaultPhoneNumber?.phoneNumber;

    if (!fromNumber) {
      return { success: false, error: 'No phone number available' };
    }

    try {
      // Create call record in the database
      const response = await api.post('/crm/call-intelligence/calls', {
        direction: 'outbound',
        fromNumber,
        toNumber: params.toNumber,
        isRecorded: params.enableRecording ?? true,
        provider: 'twilio',
      });

      if (!response.data?.id) {
        return { success: false, error: 'Failed to create call record' };
      }

      const callId = response.data.id;

      // Set active call state
      setActiveCall({
        id: callId,
        status: 'dialing',
        toNumber: params.toNumber,
        fromNumber,
        startedAt: new Date(),
        duration: 0,
        isMuted: false,
        isSpeaker: false,
        isOnHold: false,
        isRecording: params.enableRecording ?? true,
        contactName: params.contactName,
        customerName: params.customerName,
      });

      // Simulate call progression
      // In a real implementation, this would be driven by Twilio Voice SDK events
      setTimeout(() => {
        setActiveCall(prev => prev ? { ...prev, status: 'ringing' } : null);
      }, 1500);

      setTimeout(() => {
        setActiveCall(prev => prev ? { ...prev, status: 'connected', connectedAt: new Date() } : null);
      }, 4000);

      return { success: true, callId };
    } catch (error) {
      console.error('[VoIP] Failed to make call:', error);
      return { success: false, error: 'Failed to initiate call' };
    }
  }, [defaultPhoneNumber]);

  const endCall = useCallback(() => {
    if (durationInterval.current) {
      clearInterval(durationInterval.current);
      durationInterval.current = null;
    }

    const callId = activeCall?.id;

    setActiveCall(prev => prev ? { ...prev, status: 'ended' } : null);

    // Update the call record
    if (callId && activeCall) {
      api.put(`/crm/call-intelligence/calls/${callId}`, {
        status: 'completed',
        duration: activeCall.duration,
        endedAt: new Date().toISOString(),
      }).catch(error => {
        console.error('[VoIP] Failed to update call record:', error);
      });
    }

    setTimeout(() => {
      setActiveCall(null);
      refreshCalls();
    }, 2000);
  }, [activeCall, refreshCalls]);

  const toggleMute = useCallback(() => {
    setActiveCall(prev => prev ? { ...prev, isMuted: !prev.isMuted } : null);
  }, []);

  const toggleSpeaker = useCallback(() => {
    setActiveCall(prev => prev ? { ...prev, isSpeaker: !prev.isSpeaker } : null);
  }, []);

  const toggleHold = useCallback(() => {
    setActiveCall(prev => prev ? { ...prev, isOnHold: !prev.isOnHold } : null);
  }, []);

  return (
    <VoipContext.Provider
      value={{
        isConfigured,
        isInitialized,
        provider,
        phoneNumbers,
        defaultPhoneNumber,
        refreshPhoneNumbers,
        calls,
        isLoadingCalls,
        refreshCalls,
        activeCall,
        makeCall,
        endCall,
        toggleMute,
        toggleSpeaker,
        toggleHold,
        stats,
      }}
    >
      {children}
    </VoipContext.Provider>
  );
}

export function useVoip() {
  const context = useContext(VoipContext);
  if (!context) {
    throw new Error('useVoip must be used within a VoipProvider');
  }
  return context;
}

export function useVoipSafe() {
  return useContext(VoipContext);
}
