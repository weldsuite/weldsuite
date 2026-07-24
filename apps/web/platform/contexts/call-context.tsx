
import { createContext, useContext, useState, ReactNode, useCallback, useRef, useEffect } from 'react';

// Telnyx WebRTC types (dynamically imported)
interface TelnyxNotification {
  type?: string;
  call?: {
    id: string;
    state?: string;
    remoteStream?: MediaStream;
  };
}

type TelnyxClient = {
  on: (event: string, callback: (notification: TelnyxNotification) => void) => void;
  off: (event: string, callback: (notification: TelnyxNotification) => void) => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  newCall: (options: {
    destinationNumber: string;
    callerNumber: string;
    callerName?: string;
    clientState?: string;
    audio?: boolean;
    video?: boolean;
  }) => TelnyxCall;
};

type TelnyxCall = {
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  hangup: () => void;
  muteAudio: () => void;
  unmuteAudio: () => void;
  hold: () => Promise<void>;
  unhold: () => Promise<void>;
  dtmf: (digits: string) => void;
  state: string;
  id: string;
};

type CallStatus = 'idle' | 'dialing' | 'ringing' | 'connected' | 'ended' | 'failed';

interface CallState {
  id?: string;
  status: CallStatus;
  toNumber: string;
  fromNumber: string;
  startedAt?: Date;
  connectedAt?: Date;
  duration: number;
  isRecording: boolean;
  isMuted: boolean;
  isOnHold: boolean;
  contactName?: string;
  customerName?: string;
  providerCallId?: string;
  workspaceId?: string;
}

interface CallContextType {
  isDialerOpen: boolean;
  setIsDialerOpen: (open: boolean) => void;
  callState: CallState | null;
  startCall: (params: {
    toNumber: string;
    fromNumber: string;
    isRecording?: boolean;
    contactName?: string;
    customerName?: string;
    callId?: string;
    workspaceId?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  endCall: () => void;
  dismissCall: () => void;
  toggleMute: () => void;
  toggleHold: () => void;
  sendDigits: (digits: string) => void;
  isMinimized: boolean;
  setIsMinimized: (minimized: boolean) => void;
  phoneNumbers: { id: string; phoneNumber: string; formattedNumber?: string; displayName?: string; isDefault?: boolean }[];
  setPhoneNumbers: (numbers: { id: string; phoneNumber: string; formattedNumber?: string; displayName?: string; isDefault?: boolean }[]) => void;
  voipConfigured: boolean;
  setVoipConfigured: (configured: boolean) => void;
  voiceToken: string | null;
  setVoiceToken: (token: string | null) => void;
  initializeVoip: (token: string) => Promise<void>;
  resetVoip: () => void;
  isVoipReady: boolean;
  initialDialerNumber: string;
  setInitialDialerNumber: (number: string) => void;
}

const CallContext = createContext<CallContextType | null>(null);

export function CallProvider({ children }: { children: ReactNode }) {
  const [isDialerOpen, setIsDialerOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [callState, setCallState] = useState<CallState | null>(null);
  const [phoneNumbers, setPhoneNumbers] = useState<{ id: string; phoneNumber: string; formattedNumber?: string; displayName?: string; isDefault?: boolean }[]>([]);
  const [voipConfigured, setVoipConfigured] = useState(false);
  const [voiceToken, setVoiceToken] = useState<string | null>(null);
  const [isVoipReady, setIsVoipReady] = useState(false);
  const [initialDialerNumber, setInitialDialerNumber] = useState('');
  const durationInterval = useRef<NodeJS.Timeout | null>(null);
  const telnyxClient = useRef<TelnyxClient | null>(null);
  const activeCall = useRef<TelnyxCall | null>(null);
  const isMutedRef = useRef(false);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  // Update duration while call is connected
  useEffect(() => {
    if (callState?.status === 'connected' && callState.connectedAt) {
      durationInterval.current = setInterval(() => {
        setCallState(prev => {
          if (!prev || !prev.connectedAt) return prev;
          const now = new Date();
          const duration = Math.floor((now.getTime() - prev.connectedAt!.getTime()) / 1000);
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
  }, [callState?.status, callState?.connectedAt]);

  // Create persistent audio element for remote audio playback
  useEffect(() => {
    const audio = document.createElement('audio');
    audio.id = 'telnyx-remote-audio';
    audio.autoplay = true;
    document.body.appendChild(audio);
    remoteAudioRef.current = audio;

    return () => {
      audio.remove();
      remoteAudioRef.current = null;
    };
  }, []);

  // Cleanup Telnyx client on unmount
  useEffect(() => {
    return () => {
      if (telnyxClient.current) {
        telnyxClient.current.disconnect();
        telnyxClient.current = null;
      }
    };
  }, []);

  const resetVoip = useCallback(() => {
    if (telnyxClient.current) {
      telnyxClient.current.disconnect();
      telnyxClient.current = null;
    }
    setIsVoipReady(false);
    setVoiceToken(null);
  }, []);

  const initializeVoip = useCallback(async (token: string) => {
    try {
      // Dynamically import Telnyx WebRTC SDK
      const { TelnyxRTC } = await import('@telnyx/webrtc');

      // Disconnect existing client if any
      if (telnyxClient.current) {
        telnyxClient.current.disconnect();
      }

      // Create new client with login token
      const client = new TelnyxRTC({
        login_token: token,
      });

      // Register client event handlers
      client.on('telnyx.ready', () => {
        setIsVoipReady(true);
      });

      client.on('telnyx.error', (error: unknown) => {
        console.error('[Telnyx] Client error:', error);
        setIsVoipReady(false);
      });

      client.on('telnyx.socket.close', () => {
        setIsVoipReady(false);
      });

      client.on('telnyx.notification', (notification: TelnyxNotification) => {
        const call = notification.call;
        if (!call) return;

        // Handle incoming call notifications
        if (notification.type === 'callUpdate') {
          const state = call.state;
          if (state === 'ringing' && !activeCall.current) {
            // Incoming call — auto-accept for now
            // In production, show UI to accept/reject
          }
        }
      });

      // Connect the client
      await client.connect();
      telnyxClient.current = client as unknown as TelnyxClient;
      setVoiceToken(token);
    } catch (error) {
      console.error('[Telnyx] Failed to initialize:', error);
      setIsVoipReady(false);
      throw error;
    }
  }, []);

  const startCall = useCallback(async (params: {
    toNumber: string;
    fromNumber: string;
    isRecording?: boolean;
    contactName?: string;
    customerName?: string;
    callId?: string;
    workspaceId?: string;
  }): Promise<{ success: boolean; error?: string }> => {
    // Check microphone access first
    if (telnyxClient.current && isVoipReady) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
      } catch (e) {
        const error = e as Error;
        console.error('[Telnyx] Microphone access failed:', error.name, error.message);

        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          return {
            success: false,
            error: 'Microphone access denied. Please allow microphone permissions in your browser settings and reload the page.',
          };
        } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
          return {
            success: false,
            error: 'No microphone found. Please connect a microphone and try again.',
          };
        } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
          return {
            success: false,
            error: 'Microphone is in use by another application. Please close other apps using the microphone.',
          };
        } else {
          return {
            success: false,
            error: `Microphone error: ${error.message}`,
          };
        }
      }
    }

    // Set initial call state
    setCallState({
      id: params.callId,
      status: 'dialing',
      toNumber: params.toNumber,
      fromNumber: params.fromNumber,
      startedAt: new Date(),
      duration: 0,
      isRecording: params.isRecording ?? true,
      isMuted: false,
      isOnHold: false,
      contactName: params.contactName,
      customerName: params.customerName,
      workspaceId: params.workspaceId,
    });
    setIsMinimized(true);

    // If Telnyx client is ready, make a real call
    if (telnyxClient.current && isVoipReady) {
      try {
        // Encode call context as client_state for webhook identification
        const clientState = btoa(JSON.stringify({
          callId: params.callId || '',
          workspaceId: params.workspaceId || '',
          record: params.isRecording ? 'true' : 'false',
        }));

        const call = telnyxClient.current.newCall({
          destinationNumber: params.toNumber,
          callerNumber: params.fromNumber,
          clientState,
          audio: true,
          video: false,
        });

        activeCall.current = call;
        isMutedRef.current = false;

        // Handle call state changes via notifications on the client
        const handleNotification = (notification: TelnyxNotification) => {
          if (notification.call?.id !== call.id) return;
          const state = notification.call?.state;

          // Attach remote audio stream when available
          const remoteStream = notification.call?.remoteStream;
          if (remoteStream && remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = remoteStream;
            remoteAudioRef.current.play().catch(() => {});
          }

          switch (state) {
            case 'trying':
            case 'requesting':
              setCallState(prev => prev ? { ...prev, status: 'dialing' } : null);
              break;
            case 'ringing':
            case 'early':
              setCallState(prev => prev ? { ...prev, status: 'ringing' } : null);
              break;
            case 'active':
              setCallState(prev => prev ? {
                ...prev,
                status: 'connected',
                connectedAt: new Date(),
                providerCallId: call.id,
              } : null);
              break;
            case 'hangup':
            case 'destroy':
              if (durationInterval.current) {
                clearInterval(durationInterval.current);
                durationInterval.current = null;
              }
              setCallState(prev => prev ? { ...prev, status: 'ended' } : null);
              activeCall.current = null;
              telnyxClient.current?.off('telnyx.notification', handleNotification);
              setTimeout(() => {
                setCallState(null);
                setIsMinimized(false);
              }, 2000);
              break;
          }
        };

        telnyxClient.current.on('telnyx.notification', handleNotification);

        return { success: true };
      } catch (error) {
        const errorObj = error as { message?: string };
        const errorMessage = errorObj?.message || 'Failed to connect call';
        console.error('[Telnyx] Failed to start call:', errorMessage, error);
        setCallState(prev => prev ? { ...prev, status: 'failed' } : null);
        setTimeout(() => {
          setCallState(null);
          setIsMinimized(false);
        }, 5000);
        return { success: false, error: errorMessage };
      }
    }

    // Fallback to simulated call if Telnyx not ready
    setTimeout(() => {
      setCallState(prev => prev ? { ...prev, status: 'ringing' } : null);
    }, 1500);

    setTimeout(() => {
      setCallState(prev => prev ? { ...prev, status: 'connected', connectedAt: new Date() } : null);
    }, 4000);

    return { success: true };
  }, [isVoipReady]);

  const endCall = useCallback(() => {
    if (durationInterval.current) {
      clearInterval(durationInterval.current);
      durationInterval.current = null;
    }

    // Hangup Telnyx call if active
    if (activeCall.current) {
      activeCall.current.hangup();
      activeCall.current = null;
    }

    setCallState(prev => prev ? { ...prev, status: 'ended' } : null);
    setTimeout(() => {
      setCallState(null);
      setIsMinimized(false);
    }, 2000);
  }, []);

  const dismissCall = useCallback(() => {
    setCallState(null);
    setIsMinimized(false);
  }, []);

  const toggleMute = useCallback(() => {
    if (activeCall.current) {
      if (isMutedRef.current) {
        activeCall.current.unmuteAudio();
        isMutedRef.current = false;
      } else {
        activeCall.current.muteAudio();
        isMutedRef.current = true;
      }
      setCallState(prev => prev ? { ...prev, isMuted: isMutedRef.current } : null);
    } else {
      setCallState(prev => prev ? { ...prev, isMuted: !prev.isMuted } : null);
    }
  }, []);

  const toggleHold = useCallback(() => {
    const newHoldState = !(callState?.isOnHold ?? false);
    if (activeCall.current) {
      if (newHoldState) {
        activeCall.current.hold();
      } else {
        activeCall.current.unhold();
      }
    }
    setCallState(prev => prev ? { ...prev, isOnHold: newHoldState } : null);
  }, [callState?.isOnHold]);

  const sendDigits = useCallback((digits: string) => {
    if (activeCall.current) {
      activeCall.current.dtmf(digits);
    }
  }, []);

  return (
    <CallContext.Provider
      value={{
        isDialerOpen,
        setIsDialerOpen,
        callState,
        startCall,
        endCall,
        dismissCall,
        toggleMute,
        toggleHold,
        sendDigits,
        isMinimized,
        setIsMinimized,
        phoneNumbers,
        setPhoneNumbers,
        voipConfigured,
        setVoipConfigured,
        voiceToken,
        setVoiceToken,
        initializeVoip,
        resetVoip,
        isVoipReady,
        initialDialerNumber,
        setInitialDialerNumber,
      }}
    >
      {children}
    </CallContext.Provider>
  );
}

export function useCall() {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error('useCall must be used within a CallProvider');
  }
  return context;
}

export function useCallSafe() {
  return useContext(CallContext);
}
