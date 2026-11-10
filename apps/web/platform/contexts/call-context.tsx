
import { createContext, useContext, useState, ReactNode, useCallback, useRef, useEffect, useMemo } from 'react';

// Telnyx WebRTC types (dynamically imported)
/** The call a notification carries: the SDK's call object, of which only the parts read here are typed. */
type TelnyxNotificationCall = Partial<TelnyxCall> & { id: string };

interface TelnyxNotification {
  type?: string;
  call?: TelnyxNotificationCall;
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
  /** 'inbound' for a call that rings this browser. */
  direction?: string;
  /** Answers a ringing inbound call. */
  answer?: (params?: { audio?: boolean; video?: boolean }) => unknown;
  remoteCallerNumber?: string;
  remoteCallerName?: string;
  localStream?: MediaStream;
  remoteStream?: MediaStream;
};

/** An inbound call that can be answered or declined (the SDK's call object has both). */
function isAnswerable(call: TelnyxNotificationCall): call is TelnyxCall {
  return typeof call.answer === 'function' && typeof call.hangup === 'function';
}

/** The live call's audio, for level meters; both are null until the call has media. */
interface CallStreams {
  local: MediaStream | null;
  remote: MediaStream | null;
}

const NO_STREAMS: CallStreams = { local: null, remote: null };

type CallStatus = 'idle' | 'dialing' | 'ringing' | 'connecting' | 'connected' | 'ended' | 'failed';

/** Whose login the shared softphone client is signed in with. */
export type VoipCredential = 'shared' | 'member';

/** The client's link to Telnyx, finer than `isVoipReady` so a caller can tell a drop from "not started". */
export type VoipConnectionState = 'idle' | 'connecting' | 'ready' | 'closed' | 'error';

/** An inbound call ringing this browser, before it is answered. */
export interface IncomingCallState {
  /** The Telnyx call id (not the WeldCall call row). */
  id: string;
  fromNumber: string;
  callerName: string | null;
  receivedAt: Date;
}

/** What the platform knows about an inbound caller, kept on the call once it is answered. */
export interface InboundCallDetails {
  /** The WeldCall call row. */
  callId?: string | null;
  conversationId?: string | null;
  customerName?: string | null;
  callerName?: string | null;
  departmentId?: string | null;
  waitingSince?: string | null;
}

interface CallState {
  id?: string;
  status: CallStatus;
  direction?: 'inbound' | 'outbound';
  /** For an inbound call: who is calling and the WeldDesk conversation it belongs to. */
  inbound?: InboundCallDetails;
  /** The other party's number (the caller, for an inbound call). */
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
  callStreams: CallStreams;
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
  /**
   * Signs the client in. A client that is already connecting or ready is kept
   * (not torn down and rebuilt), except that the member's own credential
   * replaces a shared one when nothing is ringing or live.
   */
  initializeVoip: (token: string, options?: { credential?: VoipCredential }) => Promise<void>;
  resetVoip: () => void;
  isVoipReady: boolean;
  /** Which login the client has, null while there is no client. */
  voipCredential: VoipCredential | null;
  voipConnection: VoipConnectionState;
  /** Resolves true once the client is ready, false when `timeoutMs` passes first. */
  waitForVoipReady: (timeoutMs?: number) => Promise<boolean>;
  /** A call ringing this browser; null when there is none. */
  incomingCall: IncomingCallState | null;
  acceptIncomingCall: (details?: InboundCallDetails) => Promise<{ success: boolean; error?: string }>;
  declineIncomingCall: () => void;
  initialDialerNumber: string;
  setInitialDialerNumber: (number: string) => void;
}

const CallContext = createContext<CallContextType | null>(null);

/** Maps a getUserMedia failure to a user-facing message. */
function getMicrophoneErrorMessage(error: Error): string {
  switch (error.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Microphone access denied. Please allow microphone permissions in your browser settings and reload the page.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone found. Please connect a microphone and try again.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Microphone is in use by another application. Please close other apps using the microphone.';
    default:
      return `Microphone error: ${error.message}`;
  }
}

export function CallProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [isDialerOpen, setIsDialerOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [callState, setCallState] = useState<CallState | null>(null);
  const [callStreams, setCallStreams] = useState<CallStreams>(NO_STREAMS);
  const [phoneNumbers, setPhoneNumbers] = useState<{ id: string; phoneNumber: string; formattedNumber?: string; displayName?: string; isDefault?: boolean }[]>([]);
  const [voipConfigured, setVoipConfigured] = useState(false);
  const [voiceToken, setVoiceToken] = useState<string | null>(null);
  const [isVoipReady, setIsVoipReady] = useState(false);
  const [voipCredential, setVoipCredential] = useState<VoipCredential | null>(null);
  const [voipConnection, setVoipConnection] = useState<VoipConnectionState>('idle');
  const [incomingCall, setIncomingCall] = useState<IncomingCallState | null>(null);
  const [initialDialerNumber, setInitialDialerNumber] = useState('');
  const durationInterval = useRef<NodeJS.Timeout | null>(null);
  const telnyxClient = useRef<TelnyxClient | null>(null);
  const activeCall = useRef<TelnyxCall | null>(null);
  const incomingRef = useRef<TelnyxCall | null>(null);
  const isMutedRef = useRef(false);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  // Refs mirror the connection so callbacks that outlive a render read the live value.
  const connectionRef = useRef<VoipConnectionState>('idle');
  const credentialRef = useRef<VoipCredential | null>(null);
  // Bumped for every client (and on reset): a replaced client's late events are ignored.
  const generationRef = useRef(0);
  const readyWaiters = useRef(new Set<(ready: boolean) => void>());
  // Sign-ins run one at a time, so two callers never build two clients.
  const initChain = useRef<Promise<void>>(Promise.resolve());

  const setConnection = useCallback((state: VoipConnectionState) => {
    connectionRef.current = state;
    setVoipConnection(state);
    setIsVoipReady(state === 'ready');
    if (state === 'ready') {
      for (const resolve of readyWaiters.current) resolve(true);
      readyWaiters.current.clear();
    }
  }, []);

  // Update duration while call is connected
  useEffect(() => {
    if (callState?.status === 'connected' && callState.connectedAt) {
      durationInterval.current = setInterval(() => {
        setCallState(prev => {
          if (!prev?.connectedAt) return prev;
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
      generationRef.current += 1;
      if (telnyxClient.current) {
        telnyxClient.current.disconnect();
        telnyxClient.current = null;
      }
    };
  }, []);

  const resolveReadyWaiters = useCallback((ready: boolean) => {
    for (const resolve of readyWaiters.current) resolve(ready);
    readyWaiters.current.clear();
  }, []);

  const resetVoip = useCallback(() => {
    generationRef.current += 1;
    if (telnyxClient.current) {
      telnyxClient.current.disconnect();
      telnyxClient.current = null;
    }
    credentialRef.current = null;
    setVoipCredential(null);
    setConnection('idle');
    setVoiceToken(null);
    resolveReadyWaiters(false);
  }, [setConnection, resolveReadyWaiters]);

  /** The caller's ring is over (answered, declined, hung up, taken elsewhere): drop it. */
  const clearIncoming = useCallback((callId?: string) => {
    if (callId && incomingRef.current?.id !== callId) return;
    incomingRef.current = null;
    setIncomingCall(null);
  }, []);

  /** A call rings this browser: surface it, or turn it away when this member is already on the phone. */
  const handleIncomingCall = useCallback((call: TelnyxCall) => {
    if (incomingRef.current?.id === call.id) return;
    if (activeCall.current || incomingRef.current) {
      // Busy: hanging up this leg lets the server ring the next agent.
      try {
        call.hangup();
      } catch (error) {
        console.error('[Telnyx] Could not turn away a second call:', error);
      }
      return;
    }
    incomingRef.current = call;
    setIncomingCall({
      id: call.id,
      fromNumber: call.remoteCallerNumber ?? '',
      callerName: call.remoteCallerName?.trim() || null,
      receivedAt: new Date(),
    });
  }, []);

  const runInitializeVoip = useCallback(async (token: string, credential: VoipCredential) => {
    const live = connectionRef.current === 'ready' || connectionRef.current === 'connecting';
    if (telnyxClient.current && live) {
      // Already signed in. A shared login never replaces a live client, and the
      // member's own login is not rebuilt; a call in progress is never cut off.
      const upgrade = credential === 'member' && credentialRef.current !== 'member';
      if (!upgrade || activeCall.current || incomingRef.current) return;
    }

    try {
      // Dynamically import Telnyx WebRTC SDK
      const { TelnyxRTC } = await import('@telnyx/webrtc');

      // Disconnect existing client if any; its late events are ignored from here on.
      const generation = ++generationRef.current;
      if (telnyxClient.current) {
        telnyxClient.current.disconnect();
        telnyxClient.current = null;
      }
      credentialRef.current = credential;
      setVoipCredential(credential);
      setConnection('connecting');

      // Create new client with login token
      const client = new TelnyxRTC({
        login_token: token,
      });
      const current = () => generation === generationRef.current;

      // Register client event handlers
      client.on('telnyx.ready', () => {
        if (current()) setConnection('ready');
      });

      client.on('telnyx.error', (error: unknown) => {
        console.error('[Telnyx] Client error:', error);
        // A refused login shows before the client is ready; once ready, an error is about a call.
        if (current() && connectionRef.current !== 'ready') setConnection('error');
      });

      client.on('telnyx.socket.close', () => {
        if (current()) setConnection('closed');
      });

      client.on('telnyx.notification', (notification: TelnyxNotification) => {
        if (!current()) return;
        const call = notification.call;
        if (!call || notification.type !== 'callUpdate') return;

        if (call.direction === 'inbound' && call.state === 'ringing' && isAnswerable(call)) {
          handleIncomingCall(call);
          return;
        }
        // The caller hung up, or another agent took the call, before this browser answered.
        if (call.state === 'hangup' || call.state === 'destroy' || call.state === 'purge') {
          clearIncoming(call.id);
        }
      });

      // Connect the client
      await client.connect();
      if (!current()) {
        client.disconnect();
        return;
      }
      telnyxClient.current = client as unknown as TelnyxClient;
      setVoiceToken(token);
    } catch (error) {
      console.error('[Telnyx] Failed to initialize:', error);
      setConnection('error');
      throw error;
    }
  }, [setConnection, handleIncomingCall, clearIncoming]);

  const initializeVoip = useCallback((token: string, options?: { credential?: VoipCredential }) => {
    const run = initChain.current.then(() => runInitializeVoip(token, options?.credential ?? 'shared'));
    // A failed sign-in must not block the next one.
    initChain.current = run.catch(() => undefined);
    return run;
  }, [runInitializeVoip]);

  const waitForVoipReady = useCallback((timeoutMs = 8000) => {
    if (telnyxClient.current && connectionRef.current === 'ready') return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter = (ready: boolean) => {
        clearTimeout(timer);
        resolve(ready);
      };
      const timer = setTimeout(() => {
        readyWaiters.current.delete(waiter);
        resolve(false);
      }, timeoutMs);
      readyWaiters.current.add(waiter);
    });
  }, []);

  /**
   * Follows one call (dialed or answered) through its states: remote audio,
   * status, duration and the hang-up. An inbound call is already ringing, so
   * the ringing states do not move it back.
   */
  const trackCall = useCallback((call: TelnyxCall, inbound: boolean) => {
    const handleNotification = (notification: TelnyxNotification) => {
      if (notification.call?.id !== call.id) return;
      const state = notification.call?.state;

      // Attach remote audio stream when available
      const remoteStream = notification.call?.remoteStream ?? call.remoteStream;
      if (remoteStream && remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
        remoteAudioRef.current.play().catch(() => {});
      }
      if (remoteStream) {
        const local = call.localStream ?? null;
        setCallStreams(prev =>
          prev.remote === remoteStream && prev.local === local ? prev : { local, remote: remoteStream }
        );
      }

      switch (state) {
        case 'trying':
        case 'requesting':
          if (!inbound) setCallState(prev => prev ? { ...prev, status: 'dialing' } : null);
          break;
        case 'answering':
          setCallState(prev => prev ? { ...prev, status: 'connecting' } : null);
          break;
        case 'ringing':
        case 'early':
          if (!inbound) setCallState(prev => prev ? { ...prev, status: 'ringing' } : null);
          break;
        case 'active':
          setCallState(prev => prev ? {
            ...prev,
            status: 'connected',
            connectedAt: prev.connectedAt ?? new Date(),
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
          setCallStreams(NO_STREAMS);
          if (activeCall.current?.id === call.id) activeCall.current = null;
          telnyxClient.current?.off('telnyx.notification', handleNotification);
          setTimeout(() => {
            setCallState(null);
            setIsMinimized(false);
          }, 2000);
          break;
      }
    };

    telnyxClient.current?.on('telnyx.notification', handleNotification);
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
    if (telnyxClient.current && connectionRef.current === 'ready') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
      } catch (e) {
        const error = e as Error;
        console.error('[Telnyx] Microphone access failed:', error.name, error.message);

        return { success: false, error: getMicrophoneErrorMessage(error) };
      }
    }

    // Set initial call state
    setCallState({
      id: params.callId,
      status: 'dialing',
      direction: 'outbound',
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
    if (telnyxClient.current && connectionRef.current === 'ready') {
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

        trackCall(call, false);

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
  }, [trackCall]);

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

    setCallStreams(NO_STREAMS);
    setCallState(prev => prev ? { ...prev, status: 'ended' } : null);
    setTimeout(() => {
      setCallState(null);
      setIsMinimized(false);
    }, 2000);
  }, []);

  const dismissCall = useCallback(() => {
    setCallStreams(NO_STREAMS);
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

  const declineIncomingCall = useCallback(() => {
    const call = incomingRef.current;
    if (!call) return;
    clearIncoming();
    try {
      call.hangup();
    } catch (error) {
      console.error('[Telnyx] Could not decline the call:', error);
    }
  }, [clearIncoming]);

  const acceptIncomingCall = useCallback(async (details?: InboundCallDetails): Promise<{ success: boolean; error?: string }> => {
    const call = incomingRef.current;
    if (!call) return { success: false, error: 'The call is no longer ringing' };

    // Answering needs the microphone: check before the caller is picked up.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
    } catch (e) {
      const error = e as Error;
      console.error('[Telnyx] Microphone access failed:', error.name, error.message);
      return { success: false, error: getMicrophoneErrorMessage(error) };
    }
    // The ring can end while the browser asks for the microphone.
    if (incomingRef.current !== call) return { success: false, error: 'The call is no longer ringing' };

    clearIncoming();
    activeCall.current = call;
    isMutedRef.current = false;
    setCallState({
      status: 'connecting',
      direction: 'inbound',
      inbound: details,
      id: details?.callId ?? undefined,
      toNumber: call.remoteCallerNumber ?? '',
      fromNumber: '',
      startedAt: new Date(),
      duration: 0,
      isRecording: false,
      isMuted: false,
      isOnHold: false,
      contactName: details?.callerName ?? details?.customerName ?? call.remoteCallerName ?? undefined,
      customerName: details?.customerName ?? undefined,
      providerCallId: call.id,
    });
    setIsMinimized(false);
    trackCall(call, true);

    try {
      await call.answer?.({ audio: true, video: false });
      return { success: true };
    } catch (error) {
      const message = (error as { message?: string } | null)?.message || 'Failed to answer the call';
      console.error('[Telnyx] Failed to answer:', message, error);
      activeCall.current = null;
      setCallState(prev => prev ? { ...prev, status: 'failed' } : null);
      setTimeout(() => {
        setCallState(null);
        setIsMinimized(false);
      }, 5000);
      return { success: false, error: message };
    }
  }, [clearIncoming, trackCall]);

  const value = useMemo(
    () => ({
      isDialerOpen,
      setIsDialerOpen,
      callState,
      callStreams,
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
      voipCredential,
      voipConnection,
      waitForVoipReady,
      incomingCall,
      acceptIncomingCall,
      declineIncomingCall,
      initialDialerNumber,
      setInitialDialerNumber,
    }),
    [
      isDialerOpen, setIsDialerOpen, callState, callStreams, startCall, endCall, dismissCall, toggleMute,
      toggleHold, sendDigits, isMinimized, setIsMinimized, phoneNumbers, setPhoneNumbers,
      voipConfigured, setVoipConfigured, voiceToken, setVoiceToken, initializeVoip, resetVoip,
      isVoipReady, voipCredential, voipConnection, waitForVoipReady, incomingCall, acceptIncomingCall,
      declineIncomingCall, initialDialerNumber, setInitialDialerNumber,
    ]
  );

  return (
    <CallContext.Provider
      value={value}
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
