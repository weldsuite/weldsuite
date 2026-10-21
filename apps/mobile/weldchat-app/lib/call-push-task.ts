/**
 * Android background task for the native call pushes. Imported by the entry
 * file (`index.ts`) before the router: when a call rings on a closed app,
 * Android starts the JS bundle headless (no UI) just to run this task, so it
 * must be defined in module scope of a file the entry loads.
 *
 * iOS needs nothing here: its call pushes are VoIP pushes, handled natively.
 */

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import {
  endNativeCall,
  isAppInForeground,
  isNativeCallsAvailable,
  showIncomingCallNotification,
  type NativeRingLabels,
} from '@/modules/weldchat-calls';
import { callPushData, incomingFromNativePayload, parseCallPush, type CallPush } from './call-push';
import { dismissIncomingCallFromPush, presentIncomingCallFromPush } from './incoming-call-bridge';

export const CALL_PUSH_TASK = 'weldchat-call-push';

const RING_LABELS: NativeRingLabels = {
  incomingVoice: 'Incoming voice call',
  incomingVideo: 'Incoming video call',
  unknownCaller: 'Incoming call',
  channelName: 'Ringing calls',
  channelDescription: 'Rings for incoming WeldChat voice and video calls',
};

export function handleCallPush(push: CallPush): void {
  if (push.kind === 'cancel') {
    endNativeCall(push.callId);
    dismissIncomingCallFromPush(push.callId);
    return;
  }
  // App on screen: its own ring screen takes the call.
  if (isAppInForeground()) {
    const incoming = incomingFromNativePayload(push.payload);
    if (incoming) presentIncomingCallFromPush(incoming);
    return;
  }
  // The notification rings now; drop an in-app ring the socket may have
  // started before the app went to the background, so they do not both ring.
  if (showIncomingCallNotification(push.payload, RING_LABELS)) {
    dismissIncomingCallFromPush(push.payload.callId ?? '');
  }
}

if (Platform.OS === 'android' && isNativeCallsAvailable) {
  TaskManager.defineTask(CALL_PUSH_TASK, async ({ data }) => {
    const push = parseCallPush(callPushData(data));
    if (push) handleCallPush(push);
  });
  Notifications.registerTaskAsync(CALL_PUSH_TASK).catch((err: unknown) => {
    console.warn('[WeldChat:Call] Could not register the call push task:', err);
  });
}
