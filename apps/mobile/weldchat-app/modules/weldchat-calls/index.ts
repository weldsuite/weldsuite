/**
 * Native incoming-call ring (local Expo module `weldchat-calls`).
 *
 *   - iOS: PushKit receives the server's VoIP ring and CallKit shows it as a
 *     real phone call (lock screen, ringtone, Recents).
 *   - Android: the call push's background task posts a full-screen call
 *     notification that keeps ringing, with Answer / Decline.
 *
 * Decline works without the app running: the native side posts the ring's
 * signed token to chat-api (`configure({ declineUrl })`). Answer, Decline,
 * a tap on the notification and the CallKit hang-up / mute buttons reach JS
 * as `onCallAction` events, or wait in `takePendingActions()` until JS runs.
 *
 * `isNativeCallsAvailable` is false in Expo Go and in binaries built before
 * this module existed (an OTA update can ship this JS to them): every call is
 * then a no-op and the app keeps its in-app ring screen.
 */

import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

interface EventSubscription {
  remove(): void;
}

export type NativeCallActionType = 'accept' | 'decline' | 'open' | 'end' | 'mute';

/** String fields of the ring: callId, channelId, callType, callerName, callerAvatar, declineToken, expiresAt. */
export type NativeCallPayload = Record<string, string>;

export interface NativeCallAction {
  action: NativeCallActionType;
  /** The ring's payload, plus `handledNatively` (decline) or `muted` (mute). */
  payload: NativeCallPayload;
}

/** Strings for the Android notification and its channel (JS owns the copy). */
export interface NativeRingLabels {
  incomingVoice: string;
  incomingVideo: string;
  unknownCaller: string;
  channelName: string;
  channelDescription: string;
}

interface WeldChatCallsNative {
  configure(declineUrl: string | null): void;
  getVoipToken(): string | null;
  /** Absent in binaries built before the China gate (they always use CallKit). */
  isCallKitAvailable?(): boolean;
  reportIncomingCall(payload: NativeCallPayload): void;
  showIncomingCall(payload: NativeCallPayload, labels: NativeRingLabels): boolean;
  endCall(callId: string): void;
  takePendingActions(): NativeCallAction[];
  isAppInForeground(): boolean;
  canUseFullScreenIntent(): boolean;
  openFullScreenIntentSettings(): void;
  releaseLockScreen(): Promise<void>;
  addListener(event: 'onCallAction', listener: (event: NativeCallAction) => void): EventSubscription;
  addListener(event: 'onVoipToken', listener: (event: { token: string }) => void): EventSubscription;
}

const native = requireOptionalNativeModule<WeldChatCallsNative>('WeldChatCalls');

export const isNativeCallsAvailable = native != null;

export function configureNativeCalls(declineUrl: string | null): void {
  native?.configure(declineUrl);
}

/** iOS PushKit token (hex), once iOS issued it. Null on Android. */
export function getVoipToken(): string | null {
  return native?.getVoipToken() ?? null;
}

/**
 * iOS: whether CallKit may ring. False in mainland China, where MIIT does not
 * allow it (App Review guideline 5): no VoIP token, and calls ring in-app.
 * False on Android and without the native module.
 */
export function isCallKitAvailable(): boolean {
  if (Platform.OS !== 'ios' || !native) return false;
  return native.isCallKitAvailable?.() ?? true;
}

export function addVoipTokenListener(listener: (token: string) => void): () => void {
  const sub = native?.addListener('onVoipToken', (e) => listener(e.token));
  return () => sub?.remove();
}

/** iOS: ring through CallKit (no-op when CallKit already shows this call). */
export function reportIncomingCall(payload: NativeCallPayload): void {
  native?.reportIncomingCall(payload);
}

/** Android: post the ringing full-screen call notification. */
export function showIncomingCallNotification(payload: NativeCallPayload, labels: NativeRingLabels): boolean {
  return native?.showIncomingCall(payload, labels) ?? false;
}

/** Take the native ring / call down without reporting back to JS. */
export function endNativeCall(callId: string): void {
  native?.endCall(callId);
}

export function takePendingCallActions(): NativeCallAction[] {
  return native?.takePendingActions() ?? [];
}

export function addCallActionListener(listener: (action: NativeCallAction) => void): () => void {
  const sub = native?.addListener('onCallAction', listener);
  return () => sub?.remove();
}

/** Android: whether the app's activity is on screen. */
export function isAppInForeground(): boolean {
  return native?.isAppInForeground() ?? false;
}

/** Android 14+: whether the ring may cover the lock screen (else it is a heads-up). */
export function canUseFullScreenIntent(): boolean {
  return native?.canUseFullScreenIntent() ?? true;
}

export function openFullScreenIntentSettings(): void {
  native?.openFullScreenIntentSettings();
}

/** Android: stop showing the app over the lock screen once the call is over. */
export function releaseLockScreen(): void {
  void native?.releaseLockScreen().catch(() => {});
}
