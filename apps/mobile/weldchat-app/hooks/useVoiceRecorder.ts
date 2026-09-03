import { useCallback } from 'react';
import { Platform } from 'react-native';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  setAudioModeAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';

export interface RecordingResult {
  uri: string;
  mimeType: string;
  name: string;
}

export function useVoiceRecorder() {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const recorderState = useAudioRecorderState(recorder, 80);

  const startRecording = useCallback(async (): Promise<boolean> => {
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) return false;

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await recorder.prepareToRecordAsync();
      recorder.record();
      return true;
    } catch {
      return false;
    }
  }, [recorder]);

  const stopRecording = useCallback(async (): Promise<RecordingResult | null> => {
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
      const uri = recorder.uri;
      if (!uri) return null;

      const isIOS = Platform.OS === 'ios';
      const mimeType = isIOS ? 'audio/m4a' : 'audio/3gpp';
      const ext = isIOS ? 'm4a' : '3gp';
      return { uri, mimeType, name: `voice_${Date.now()}.${ext}` };
    } catch {
      return null;
    }
  }, [recorder]);

  const cancelRecording = useCallback(async () => {
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false });
    } catch {
      // best-effort
    }
  }, [recorder]);

  return {
    isRecording: recorderState.isRecording,
    durationMs: recorderState.durationMillis,
    meteringDb: recorderState.metering ?? -160,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
